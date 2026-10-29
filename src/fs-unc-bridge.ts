/**
 * dsh-remote-wsl / fs-unc-bridge —— 把 **standard preset 的 UNC 写/编辑** 接到 WSL 侧原生 fs。
 *
 * ## 它解决什么（2026-10-29 用户截图）
 * `dsh-fs-local` 在 Windows 上替换已有文件时，会复制目标文件的 DACL
 * （`GetFileSecurityW` / `SetFileSecurityW`）再用 `ReplaceFileW` 发布。`\\wsl.localhost\…`
 * 是 9P 共享，不支持 Windows 安全描述符 API ⇒ 编辑已有文件直接报
 * `GetFileSecurityW EIO (Win32 1)`。
 *
 * 本插件的 `wsl` preset 通过 isolate realm 换掉了 `ctx.fs`，但 **standard preset 的会话**
 * （用户在普通 UNC 工作区里直接新建的会话）仍使用宿主的 `fs-sandbox -> fs-local`。
 *
 * 本桥只包装宿主 `fs` 服务实例上的 `writeText` / `editText`：
 *   · `target.targetKey` 是本插件配置发行版的 `\\wsl.localhost\<distro>\…` ⇒ 交给
 *     `createWslFileSystem()`（即 `fs-rpc`，WSL 原生 node:fs）执行；
 *   · 其它路径原样交给原方法，行为不变。
 *
 * ## 版本语义
 * 宿主 `fs-local` 在 9P 上读到的版本令牌是 `dev=0`、纳秒级 mtime 也可能与 ext4 相差几纳秒；
 * WSL `fs-rpc` 的令牌来自 ext4，二者不能逐字比较。因此：
 *   1. 写前用 **宿主 stat** 校验 observation-policy 给的 `expected`（版本/创建意图）；
 *   2. WSL 侧执行写/编辑；
 *   3. 写后用 **宿主 stat** 重新取版本返回。这样 `fs/observed` 记录的仍是宿主版本，
 *      后续 `read` / `write` / `edit` 的版本比较继续一致。
 *
 * @module dsh-remote-wsl/fs-unc-bridge
 */
import { createWslFileSystem, parseUnc } from './fs-provider.ts';

/** 已挂载标记（Symbol.for：同一进程内 HMR / 多份配置不会重复包一层）。 */
const BRIDGE_KEY = Symbol.for('dsh-remote-wsl.fs-unc-bridge');

/** 带 code 的 Fs 风格错误（tool-fs 只读 code/消息，不依赖 `instanceof`）。 */
function fsError(message: string, code: string): Error {
  const error = new Error(message) as Error & { code: string; fsCode: string };
  error.code = code;
  error.fsCode = code;
  return error;
}

/** 判断 target 是否是本 provider 服务的发行版 UNC。 */
function isBridgeTarget(target: any, distro: string): boolean {
  const unc = parseUnc(String(target?.targetKey ?? ''));
  return unc !== null && unc.distro.toLowerCase() === distro.toLowerCase();
}

/** UNC target → WSL 侧 Linux target。 */
function toWslTarget(target: any): { targetKey: string; displayPath: string } {
  const unc = parseUnc(String(target?.targetKey ?? ''));
  return {
    targetKey: unc?.linuxPath ?? '/',
    displayPath: String(target?.displayPath ?? target?.targetKey ?? ''),
  };
}

/** 解析 `dev:ino:size:mtimeNs:ctimeNs`；失败返回 null。 */
function parseVersion(version: any): { ino: string; size: string; mtimeNs: bigint } | null {
  const parts = String(version ?? '').split(':');
  if (parts.length !== 5) return null;
  try {
    return { ino: parts[1], size: parts[2], mtimeNs: BigInt(parts[3]) };
  } catch {
    return null;
  }
}

/**
 * 宿主 9P 的版本与 WSL ext4 的版本不能逐字比较：dev 不同（9P 常报 0）、mtime 纳秒可能差几十纳秒。
 * 用 inode + size + mtime（10ms 容差）判断“还是同一份内容”。真正变化（原子替换/写入）会换 inode
 * 或改动 mtime，足以被拒绝。
 */
function versionsEquivalent(hostVersion: any, wslVersion: any): boolean {
  const h = parseVersion(hostVersion);
  const w = parseVersion(wslVersion);
  if (h === null || w === null) return false;
  const delta = h.mtimeNs > w.mtimeNs ? h.mtimeNs - w.mtimeNs : w.mtimeNs - h.mtimeNs;
  return h.ino === w.ino && h.size === w.size && delta <= 10_000_000n;
}

/** 不带 WSL 类型依赖的 stat（fake 测试只需提供这个方法）。 */
async function wslStat(wslFs: any, target: any, signal: any): Promise<any> {
  if (typeof wslFs?.stat !== 'function') return undefined;
  return wslFs.stat(target, signal);
}

/**
 * 把桥挂在 `fs` 服务实例上。导出是为了让离线测试用假 fs / 假 WSL fs 验证，不启动守护。
 *
 * @param fsService - 宿主 `ctx.fs` 服务实例（通常是 `SandboxedFileSystem`）
 * @param options - `{distro, wslFs}`；`wslFs` 至少提供 `writeText` / `editText`
 * @returns cleanup（恢复原方法；重复调用返回同一个 cleanup）
 */
export function attachUncWriteBridge(fsService: any, options: { distro: string; wslFs: any }): () => void {
  const existing = fsService?.[BRIDGE_KEY];
  if (existing) return existing.cleanup;

  const distro = String(options?.distro ?? '');
  const wslFs = options?.wslFs;
  if (!fsService || typeof fsService.writeText !== 'function' || typeof fsService.editText !== 'function' || typeof fsService.stat !== 'function') {
    return () => {};
  }
  if (!wslFs || typeof wslFs.writeText !== 'function' || typeof wslFs.editText !== 'function') {
    throw new Error('remote-wsl: UNC 写桥缺少 WSL fs 实现');
  }

  const originalWrite = fsService.writeText;
  const originalEdit = fsService.editText;
  const originalStat = fsService.stat;

  /**
   * 用宿主 stat 校验 observation-policy 的意图，并把版本翻译成 WSL 侧版本（供 fs-rpc 原子 CAS）。
   * `edit` 的 intent 是 `{version}`（没有 kind）；`write` 可能是 `createIfAbsent` / `replaceIfVersion`。
   *
   * 返回 null 表示无守卫；返回 `{kind:'createIfAbsent'}` 或 `{kind:'replaceIfVersion',version}`
   * 给 WSL 侧 writeText；edit 返回 `{version}`。
   */
  const assertExpected = async (target: any, expected: any, signal: any): Promise<any> => {
    if (!expected) return null;
    const hostLive = await originalStat.call(fsService, target, signal);
    if (expected.kind === 'createIfAbsent') {
      if (hostLive) {
        throw fsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED');
      }
      return { kind: 'createIfAbsent' };
    }
    if (expected.kind !== 'replaceIfVersion' && expected.version === undefined) return null;
    if (!hostLive) throw fsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION');
    if (expected.version !== undefined && hostLive.version !== expected.version) {
      throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
    }
    const wslLive = await wslStat(wslFs, toWslTarget(target), signal);
    if (!wslLive || !versionsEquivalent(hostLive.version, wslLive.version)) {
      throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
    }
    return { kind: 'replaceIfVersion', version: wslLive.version };
  };

  /** 写后重新从宿主侧取版本，保证 observation-policy 的版本基线不变。 */
  const hostVersionAfter = async (target: any, signal: any): Promise<string> => {
    const live = await originalStat.call(fsService, target, signal);
    return live?.version ?? `missing:${String(target?.targetKey ?? '')}`;
  };

  const bridgedWrite = async function (target: any, content: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return originalWrite.call(fsService, target, content, expected, signal, sandboxPolicy);
    const wslExpected = await assertExpected(target, expected, signal);
    const outcome = await wslFs.writeText(toWslTarget(target), content, wslExpected, signal, sandboxPolicy);
    return { ...outcome, version: await hostVersionAfter(target, signal) };
  };

  const bridgedEdit = async function (target: any, edit: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return originalEdit.call(fsService, target, edit, expected, signal, sandboxPolicy);
    const wslExpected = await assertExpected(target, expected, signal);
    // edit 的 expected 是 `{version}`（fs-rpc 只读 version）；把 WSL 版本交给它做原子 CAS。
    const editExpected = wslExpected?.version !== undefined ? { version: wslExpected.version } : null;
    const outcome = await wslFs.editText(toWslTarget(target), edit, editExpected, signal, sandboxPolicy);
    return { ...outcome, version: await hostVersionAfter(target, signal) };
  };

  fsService.writeText = bridgedWrite;
  fsService.editText = bridgedEdit;
  const cleanup = () => {
    if (fsService.writeText === bridgedWrite) fsService.writeText = originalWrite;
    if (fsService.editText === bridgedEdit) fsService.editText = originalEdit;
    if (fsService[BRIDGE_KEY]?.cleanup === cleanup) delete fsService[BRIDGE_KEY];
  };
  fsService[BRIDGE_KEY] = { cleanup };
  return cleanup;
}

/**
 * 插件入口调用：在宿主 `fs` 服务就绪后挂桥。
 *
 * 只挂一次；服务不在（老版本 DSH）时静默跳过，不把插件整体变 broken。
 */
export function installUncWriteBridge(ctx: any, rawConfig: any = {}): void {
  if (typeof ctx?.inject !== 'function') return;
  const distro = String(rawConfig?.distro ?? '');
  if (!distro) return; // 自动探测失败：没有可服务的发行版，桥无从挂起
  const wslFs = createWslFileSystem(rawConfig);
  ctx.inject(['fs'], (child: any) => {
    const fsService = typeof child?.get === 'function' ? child.get('fs') : undefined;
    if (!fsService) return;
    const cleanup = attachUncWriteBridge(fsService, { distro, wslFs });
    if (typeof child.effect === 'function') {
      child.effect(() => () => cleanup());
    }
    if (process.env.DSH_REMOTE_WSL_DIAG === '1') {
      process.stderr.write(`remote-wsl: UNC 写桥已挂载（distro=${distro}）\n`);
    }
  });
}
