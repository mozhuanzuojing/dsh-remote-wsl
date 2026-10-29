/**
 * dsh-remote-wsl / fs-unc-bridge —— 把 **standard preset 的 UNC 文件工具** 接到 WSL 侧原生 fs。
 *
 * ## 它解决什么（2026-10-29 用户截图 + 会话日志）
 * `dsh-fs-local` 在 Windows 上替换已有文件时，会复制目标文件的 DACL
 * （`GetFileSecurityW` / `SetFileSecurityW`）再用 `ReplaceFileW` 发布。`\\wsl.localhost\…`
 * 是 9P 共享，不支持 Windows 安全描述符 API ⇒ 编辑已有文件直接报
 * `GetFileSecurityW EIO (Win32 1)`。
 *
 * 更隐蔽的一条是 WSL 的 /mnt 路径：WSL 里的 symlink（例如 `sac-fe -> /mnt/d/...`）从 Windows
 * 侧看是 `\\wsl.localhost\<distro>\mnt\d\…`。Windows `realpath` / `stat` / `readFile` 经 9P
 * 访问 DrvFs 会报 `EPERM`，即使文件在 WSL 里完全可读。实测：`read` 工具对同一路径报
 * `EPERM: operation not permitted, realpath`，而 `wsl_exec ls` 能看到文件。
 *
 * 本插件的 `wsl` preset 通过 isolate realm 换掉了 `ctx.fs`，但 **standard preset 的会话**
 * （用户在普通 UNC 工作区里直接新建的会话）仍使用宿主的 `fs-sandbox -> fs-local`。
 *
 * 本桥包装宿主 `fs` 服务实例：
 *   · 普通 UNC：保留原本的 9P 实现；`writeText` / `editText` 走 WSL fs-rpc（绕开 DACL）。
 *   · `/mnt` 路径：`resolve` / `lstat` / `stat` / `readText` / `streamText` / `readBytes` /
 *     `readByteRange` / `listDir` / `writeText` / `editText` 全部走 WSL fs-rpc（DrvFs 由 WSL
 *     原生 node:fs 访问）。
 *   · 其它路径原样交给原方法，行为不变。
 *
 * ## 版本语义
 * 普通 UNC 的宿主 `fs-local` 版本令牌是 `dev=0`、纳秒级 mtime 可能与 ext4 差几十纳秒；WSL
 * `fs-rpc` 的令牌来自 ext4，二者不能逐字比较。因此普通 UNC 写路径仍用宿主 stat 校验并回取
 * 宿主版本。`/mnt` 路径从第一次 `stat` 就由 WSL 提供版本，读写/edit 的 observation-policy
 * 版本基线统一为 WSL 令牌。
 *
 * @module dsh-remote-wsl/fs-unc-bridge
 */
import { createWslFileSystem, parseUnc, uncPath } from './fs-provider.ts';

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

function isMntLinuxPath(path: string): boolean {
  return path === '/mnt' || path.startsWith('/mnt/');
}

/** target 是否落在 WSL 的 /mnt（DrvFs）下——Windows 9P 访问这里会 EPERM。 */
function isMntTarget(target: any, distro: string): boolean {
  const unc = parseUnc(String(target?.targetKey ?? ''));
  return unc !== null && unc.distro.toLowerCase() === distro.toLowerCase() && isMntLinuxPath(unc.linuxPath);
}

/** UNC target → WSL 侧 Linux target。 */
function toWslTarget(target: any): { targetKey: string; displayPath: string } {
  const unc = parseUnc(String(target?.targetKey ?? ''));
  return {
    targetKey: unc?.linuxPath ?? '/',
    displayPath: String(target?.displayPath ?? target?.targetKey ?? ''),
  };
}

function isUncForDistro(value: any, distro: string): boolean {
  const unc = parseUnc(String(value ?? ''));
  return unc !== null && unc.distro.toLowerCase() === distro.toLowerCase();
}

/** 输入是否是明确的 POSIX 绝对路径（不是 Windows 盘符、不是 UNC）。 */
function isPosixAbsolute(input: any): boolean {
  const raw = String(input ?? '');
  return raw.startsWith('/') && !raw.startsWith('//');
}

/** 输入是否明确落在 /mnt（WSL DrvFs）。 */
function isMntInput(input: any, opts: any, distro: string): boolean {
  const raw = String(input ?? '');
  if (isUncForDistro(raw, distro)) {
    const unc = parseUnc(raw)!;
    return isMntLinuxPath(unc.linuxPath);
  }
  if (isPosixAbsolute(raw)) return isMntLinuxPath(raw);
  if (isUncForDistro(opts?.cwd, distro)) {
    const cwd = parseUnc(String(opts.cwd))!;
    return isMntLinuxPath(cwd.linuxPath);
  }
  return false;
}

/** 输入是否属于本发行版的 WSL 路径：
 *  · 本发行版 UNC；
 *  · POSIX 绝对路径（仅 /mnt 或 UNC 会话 cwd 下）；
 *  · UNC cwd 下不含反斜杠的相对路径。
 *  Windows 盘符（D:\…）、含反斜杠的相对路径、其它发行版 UNC 必须交回原 host resolve。
 */
function isBridgeInput(input: any, opts: any, distro: string): boolean {
  const raw = String(input ?? '');
  const unc = parseUnc(raw);
  if (unc !== null) return unc.distro.toLowerCase() === distro.toLowerCase();
  if (/^[A-Za-z]:[\\/]/.test(raw)) return false;
  // cwd 落在 /mnt 时，相对路径即使写成 `sub\file`（Windows 习惯）也应是 WSL 的 DrvFs 路径。
  if (isUncForDistro(opts?.cwd, distro)) {
    const cwdUnc = parseUnc(String(opts.cwd))!;
    if (isMntLinuxPath(cwdUnc.linuxPath) && !raw.startsWith('\\\\')) return true;
  }
  if (raw.includes('\\')) return false;
  if (isPosixAbsolute(raw)) {
    return isUncForDistro(opts?.cwd, distro) || isMntLinuxPath(raw);
  }
  // 纯相对路径只有 cwd 是本发行版 UNC 时才交给 WSL；Windows cwd 保持原行为。
  return isUncForDistro(opts?.cwd, distro);
}

/** `/mnt` cwd 下 Windows 习惯的反斜杠相对路径要先归一为 POSIX，否则 path.posix 会把它当普通字符。 */
function normalizeBridgeInput(input: any, opts: any, distro: string): string {
  const raw = String(input ?? '');
  if (isUncForDistro(opts?.cwd, distro)) {
    const cwdUnc = parseUnc(String(opts.cwd))!;
    if (isMntLinuxPath(cwdUnc.linuxPath) && !raw.startsWith('\\\\') && !/^[A-Za-z]:[\\/]/.test(raw)) {
      return raw.replace(/\\/g, '/');
    }
  }
  return raw;
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

/** 不带 WSL 类型依赖的 stat（fake 测试只需提供这个方法）；缺方法给稳定 FS_IO_ERROR。 */
async function wslStat(wslFs: any, target: any, signal: any): Promise<any> {
  if (typeof wslFs?.stat !== 'function') throw fsError('remote-wsl: WSL fs 缺少 stat()', 'FS_IO_ERROR');
  return wslFs.stat(target, signal);
}

/**
 * 把桥挂在 `fs` 服务实例上。导出是为了让离线测试用假 fs / 假 WSL fs 验证，不启动守护。
 *
 * @param fsService - 宿主 `ctx.fs` 服务实例（通常是 `SandboxedFileSystem`）
 * @param options - `{distro, wslFs}`；`wslFs` 应提供 writeText / editText / stat / resolve /
 *   lstat / readText / streamText / readBytes / readByteRange / listDir（缺失的读方法由桥返回稳定
 *   `FS_IO_ERROR`，不会泄漏裸 TypeError）
 * @returns cleanup（恢复原方法；重复调用返回同一个 cleanup）
 */
export function attachUncBridge(fsService: any, options: { distro: string; wslFs: any }): () => void {
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
  const originalResolve = fsService.resolve;
  const originalLstat = fsService.lstat;
  const originalReadText = fsService.readText;
  const originalStreamText = fsService.streamText;
  const originalReadBytes = fsService.readBytes;
  const originalReadByteRange = fsService.readByteRange;
  const originalListDir = fsService.listDir;

  /** 调用 WSL fs 方法；缺方法时给稳定 FS_IO_ERROR，而不是 undefined.call 的裸 TypeError。 */
  const callWsl = (method: string, ...args: any[]) => {
    const fn = wslFs?.[method];
    if (typeof fn !== 'function') throw fsError(`remote-wsl: WSL fs 缺少 ${method}()`, 'FS_IO_ERROR');
    return fn.apply(wslFs, args);
  };

  const resolveViaWsl = async (input: any, opts: any) => {
    const wslInput = normalizeBridgeInput(input, opts, distro);
    const target = await callWsl('resolve', wslInput, opts);
    const raw = String(input ?? '');
    let displayPath: string;
    if (isUncForDistro(raw, distro)) {
      // 绝对 UNC 输入保留用户看到的 \\wsl.localhost\… 形式。
      displayPath = raw;
    } else if (isUncForDistro(opts?.cwd, distro) && !isPosixAbsolute(raw)) {
      // 相对路径基于 UNC cwd 时，保留 UNC 展示形式，避免 read 的 <path> 变成 Linux 路径。
      displayPath = `${String(opts.cwd).replace(/[\\/]+$/, '')}\\${raw.replace(/\//g, '\\')}`;
    } else {
      displayPath = String(target.displayPath ?? target.targetKey);
    }
    return { targetKey: uncPath(distro, target.targetKey), displayPath };
  };

  /**
   * 用宿主/ WSL stat 校验 observation-policy 的意图，并把版本翻译成 WSL 侧版本（供 fs-rpc 原子 CAS）。
   * `edit` 的 intent 是 `{version}`（没有 kind）；`write` 可能是 `createIfAbsent` / `replaceIfVersion`。
   */
  const assertExpected = async (target: any, expected: any, signal: any, native: boolean): Promise<any> => {
    if (!expected) return null;
    const live = native
      ? await wslStat(wslFs, toWslTarget(target), signal)
      : await originalStat.call(fsService, target, signal);
    if (expected.kind === 'createIfAbsent') {
      if (live) {
        throw fsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED');
      }
      return { kind: 'createIfAbsent' };
    }
    if (expected.kind !== 'replaceIfVersion' && expected.version === undefined) return null;
    if (!live) throw fsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION');
    if (expected.version !== undefined && live.version !== expected.version) {
      throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
    }
    if (native) return { kind: 'replaceIfVersion', version: live.version };
    const wslLive = await wslStat(wslFs, toWslTarget(target), signal);
    if (!wslLive || !versionsEquivalent(live.version, wslLive.version)) {
      throw fsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
    }
    return { kind: 'replaceIfVersion', version: wslLive.version };
  };

  /** 普通 UNC 写后从宿主侧取版本；/mnt 写后从 WSL 侧取版本。 */
  const versionAfter = async (target: any, signal: any, native: boolean): Promise<string> => {
    if (native) {
      const live = await wslStat(wslFs, toWslTarget(target), signal);
      return live?.version ?? `missing:${String(target?.targetKey ?? '')}`;
    }
    const live = await originalStat.call(fsService, target, signal);
    return live?.version ?? `missing:${String(target?.targetKey ?? '')}`;
  };

  const bridgedResolve = async function (input: any, opts: any = {}) {
    if (!isBridgeInput(input, opts, distro)) return originalResolve.call(fsService, input, opts);
    // /mnt 与 POSIX 路径在 Windows 9P 上没有可靠 realpath；直接以 WSL 原生解析为准。
    if (isMntInput(input, opts, distro) || isPosixAbsolute(input)) return resolveViaWsl(input, opts);
    // 普通 UNC 先保留宿主 9P 语义；host stat 看不到（典型：symlink → /mnt/d 被 fs-local
    // 词法化成不存在的 leaf）时，再用 WSL realpath + WSL stat 确认是否真实存在。
    let hostResult;
    try {
      hostResult = await originalResolve.call(fsService, input, opts);
    } catch (error: any) {
      // 9P 对某些 symlink/DrvFs 组合会直接抛 EPERM/EACCES；这类错误回退 WSL，
      // 其它错误保持原有失败语义。
      if (!['EPERM', 'EACCES', 'ENOENT', 'EISDIR'].includes(String(error?.code))) throw error;
      return resolveViaWsl(input, opts);
    }
    let hostLive;
    try {
      hostLive = await originalStat.call(fsService, hostResult, opts?.signal);
    } catch (error: any) {
      // fs-local 的 probe 通常把 ENOENT 吞成 undefined；某些 9P 权限/链接错误会直接抛。
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'ENOENT') throw error;
      hostLive = undefined;
    }
    if (hostLive !== undefined) return hostResult;
    try {
      const wslResult = await resolveViaWsl(input, opts);
      // symlink→/mnt 下的新文件：WSL stat 也返回 undefined，但目标身份已经是 /mnt，
      // 必须采用 WSL targetKey，后续 write 才会走 native /mnt 分支。
      if (isMntTarget(wslResult, distro)) return wslResult;
      if (await wslStat(wslFs, toWslTarget(wslResult), opts?.signal)) return wslResult;
    } catch (error) {
      // WSL 解析/读取失败不能被静默改写成宿主词法路径（否则 symlink→/mnt 会伪报 not found）。
      throw error;
    }
    return hostResult;
  };

  const bridgedLstat = async function (input: any, opts: any = {}, signal: any) {
    if (!isBridgeInput(input, opts, distro)) return originalLstat.call(fsService, input, opts, signal);
    if (isMntInput(input, opts, distro) || isPosixAbsolute(input)) {
      return callWsl('lstat', normalizeBridgeInput(input, opts, distro), opts, signal);
    }
    let hostResult;
    try {
      hostResult = await originalLstat.call(fsService, input, opts, signal);
    } catch (error: any) {
      // Windows 对 symlink 目录本身可能报 EISDIR；9P 可能报 EPERM。仅这些可回退，
      // 真正的权限拒绝（其它 EACCES）保持原样。
      if (!['EPERM', 'EACCES', 'EISDIR', 'ENOENT'].includes(String(error?.code))) throw error;
      hostResult = undefined;
    }
    if (hostResult !== undefined) return hostResult;
    try {
      return await callWsl('lstat', normalizeBridgeInput(input, opts, distro), opts, signal);
    } catch (error) {
      throw error;
    }
  };

  const bridgedStat = async function (target: any, signal: any) {
    if (!isMntTarget(target, distro)) return originalStat.call(fsService, target, signal);
    return callWsl('stat', toWslTarget(target), signal);
  };

  const bridgedReadText = async function (target: any, signal: any) {
    if (!isMntTarget(target, distro)) return originalReadText.call(fsService, target, signal);
    return callWsl('readText', toWslTarget(target), signal);
  };

  const bridgedStreamText = function (target: any, signal: any) {
    if (!isMntTarget(target, distro)) return originalStreamText.call(fsService, target, signal);
    return callWsl('streamText', toWslTarget(target), signal);
  };

  const bridgedReadBytes = async function (target: any, signal: any, maxBytes: any) {
    if (!isMntTarget(target, distro)) return originalReadBytes.call(fsService, target, signal, maxBytes);
    return callWsl('readBytes', toWslTarget(target), signal, maxBytes);
  };

  const bridgedReadByteRange = async function (target: any, range: any, signal: any) {
    if (!isMntTarget(target, distro)) return originalReadByteRange.call(fsService, target, range, signal);
    return callWsl('readByteRange', toWslTarget(target), range, signal);
  };

  const bridgedListDir = async function (target: any, signal: any) {
    if (!isMntTarget(target, distro)) return originalListDir.call(fsService, target, signal);
    const entries = await callWsl('listDir', toWslTarget(target), signal);
    const parentDisplay = String(target?.displayPath ?? '');
    return entries.map((entry: any) => ({
      ...entry,
      target: {
        ...entry.target,
        targetKey: uncPath(distro, entry.target.targetKey),
        // WSL listDir 用 path.posix.join 拼 displayPath；父路径是 UNC 时会得到 `\mnt\d/child`
        // 这种混合分隔符。父路径为 UNC 时按 Windows 分隔符补全。
        displayPath: parentDisplay.startsWith('\\\\')
          ? `${parentDisplay.replace(/[\\/]+$/, '')}\\${String(entry?.name ?? '')}`
          : entry.target.displayPath,
      },
    }));
  };

  const bridgedWrite = async function (target: any, content: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return originalWrite.call(fsService, target, content, expected, signal, sandboxPolicy);
    // 不经过 SandboxedFileSystem.checkedTarget 时仍要拿到会话默认策略；tool-fs 会显式传，
    // 其它调用方没传时用 fs-sandbox 的默认 resolve()，不能静默变成无围栏。
    const policy = sandboxPolicy ?? fsService?.ctx?.sandboxPolicy?.resolve?.();
    const native = isMntTarget(target, distro);
    const wslExpected = await assertExpected(target, expected, signal, native);
    const outcome = await callWsl('writeText', toWslTarget(target), content, wslExpected, signal, policy);
    return { ...outcome, version: await versionAfter(target, signal, native) };
  };

  const bridgedEdit = async function (target: any, edit: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return originalEdit.call(fsService, target, edit, expected, signal, sandboxPolicy);
    const policy = sandboxPolicy ?? fsService?.ctx?.sandboxPolicy?.resolve?.();
    const native = isMntTarget(target, distro);
    const wslExpected = await assertExpected(target, expected, signal, native);
    // edit 的 expected 是 `{version}`（fs-rpc 只读 version）；把 WSL 版本交给它做原子 CAS。
    const editExpected = wslExpected?.version !== undefined ? { version: wslExpected.version } : null;
    const outcome = await callWsl('editText', toWslTarget(target), edit, editExpected, signal, policy);
    return { ...outcome, version: await versionAfter(target, signal, native) };
  };

  const patched: Array<{ name: string; original: any; wrapper: any }> = [];
  const patch = (name: string, wrapper: any) => {
    const original = fsService[name];
    if (typeof original !== 'function') return;
    patched.push({ name, original, wrapper });
    fsService[name] = wrapper;
  };
  patch('writeText', bridgedWrite);
  patch('editText', bridgedEdit);
  patch('resolve', bridgedResolve);
  patch('lstat', bridgedLstat);
  patch('stat', bridgedStat);
  patch('readText', bridgedReadText);
  patch('streamText', bridgedStreamText);
  patch('readBytes', bridgedReadBytes);
  patch('readByteRange', bridgedReadByteRange);
  patch('listDir', bridgedListDir);

  const cleanup = () => {
    for (const { name, original, wrapper } of patched) {
      if (fsService[name] === wrapper) fsService[name] = original;
    }
    if (fsService[BRIDGE_KEY]?.cleanup === cleanup) delete fsService[BRIDGE_KEY];
  };
  fsService[BRIDGE_KEY] = { cleanup };
  return cleanup;
}

/** 旧名兼容：0.3.9 的调用方/测试仍可用 attachUncWriteBridge。 */
export const attachUncWriteBridge = attachUncBridge;

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
    const cleanup = attachUncBridge(fsService, { distro, wslFs });
    if (typeof child.effect === 'function') {
      child.effect(() => () => cleanup());
    }
    if (process.env.DSH_REMOTE_WSL_DIAG === '1') {
      process.stderr.write(`remote-wsl: UNC 写桥已挂载（distro=${distro}）\n`);
    }
  });
}
