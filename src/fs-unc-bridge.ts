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
 *   · 普通 UNC：保留原本的 9P 实现；`writeText` / `editText` / `patchText` / `deleteFile` /
 *     `moveFile` 走 WSL fs-rpc（绕开 DACL，且 0.2.2 的 apply_patch 三个新 op 同样不能在 9P 上跑）。
 *   · `/mnt` 路径：`resolve` / `lstat` / `stat` / `readText` / `streamText` / `readBytes` /
 *     `readByteRange` / `listDir` / `writeText` / `editText` / `patchText` / `deleteFile` / `moveFile`
 *     全部走 WSL fs-rpc（DrvFs 由 WSL 原生 node:fs 访问）。
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
import { createWslFileSystem, parseUnc, uncPath, DAEMON_DOWN_CODE } from './fs-provider.ts';
import { diag } from './diag.ts';

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
  const originalPatch = fsService.patchText;
  const originalDelete = fsService.deleteFile;
  const originalMove = fsService.moveFile;
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
   * 写前用 WSL stat 校验 observation-policy 的意图（本发行版 UNC 统一 WSL 平面，不再做宿主↔WSL 令牌翻译）。
   * `edit` 的 intent 是 `{version}`（没有 kind）；`write` 可能是 `createIfAbsent` / `replaceIfVersion`。
   */
  const assertExpected = async (target: any, expected: any, signal: any): Promise<any> => {
    if (!expected) return null;
    const live = await wslStat(wslFs, toWslTarget(target), signal);
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
    return { kind: 'replaceIfVersion', version: live.version };
  };

  /** 写后版本：统一回取 WSL stat 版本（本发行版 UNC 始终在同一平面）。 */
  const versionAfter = async (target: any, signal: any): Promise<string> => {
    const live = await wslStat(wslFs, toWslTarget(target), signal);
    return live?.version ?? `missing:${String(target?.targetKey ?? '')}`;
  };

  const bridgedResolve = async function (input: any, opts: any = {}) {
    if (!isBridgeInput(input, opts, distro)) return originalResolve.call(fsService, input, opts);
    // 统一 WSL 平面（决策 A：守护不可用 → 明确失败，不回退宿主 9P）。
    return guardPlane({ displayPath: String(input ?? '') }, () => resolveViaWsl(input, opts));
  };

  const bridgedLstat = async function (input: any, opts: any = {}, signal: any) {
    if (!isBridgeInput(input, opts, distro)) return originalLstat.call(fsService, input, opts, signal);
    return guardPlane({ displayPath: String(input ?? '') }, () => callWsl('lstat', normalizeBridgeInput(input, opts, distro), opts, signal));
  };

  const bridgedStat = async function (target: any, signal: any) {
    if (!isBridgeTarget(target, distro)) return originalStat.call(fsService, target, signal);
    return guardPlane(target, () => callWsl('stat', toWslTarget(target), signal));
  };

  const isDaemonDown = (e: any) => !!e && (e.code === DAEMON_DOWN_CODE || e.fsCode === DAEMON_DOWN_CODE);
  /**
   * 决策 A：本发行版 UNC 统一 **WSL 平面**；守护不可用 → **确定性失败**（附可执行修复），
   * **不回退宿主 9P**（避免同一路径出现"两个真相源"/混平面令牌）。
   */
  const daemonDownError = (what: any, cause?: any) =>
    fsError(
      `remote-wsl: WSL 守护不可用，无法访问 "${String((what && (what.displayPath ?? what.targetKey)) ?? '')}"。` +
        `${cause && cause.message ? `原因：${String(cause.message)} ` : ''}` +
        `ext4 路径依赖守护（不回退宿主 9P）；先 wsl_daemon action=status 看状态，必要时 action=restart，` +
        `或 wsl_doctor 诊断（WSL 内存/swap 紧张也会导致瞬断）。`,
      DAEMON_DOWN_CODE,
    );
  const guardPlane = async (what: any, thunk: () => any) => {
    try {
      return await thunk();
    } catch (e) {
      if (isDaemonDown(e)) throw daemonDownError(what, e);
      throw e;
    }
  };

  const bridgedReadText = async function (target: any, signal: any) {
    if (!isBridgeTarget(target, distro)) return originalReadText.call(fsService, target, signal);
    return guardPlane(target, () => callWsl('readText', toWslTarget(target), signal));
  };

  const bridgedStreamText = function (target: any, signal: any) {
    if (!isBridgeTarget(target, distro)) return originalStreamText.call(fsService, target, signal);
    diag('fs-route', 'streamText ' + String(target && target.targetKey));
    return (async function* () {
      try {
        const iterable = await callWsl('streamText', toWslTarget(target), signal);
        for await (const chunk of iterable) yield chunk;
      } catch (e) {
        if (isDaemonDown(e)) throw daemonDownError(target, e);
        throw e;
      }
    })();
  };

  const bridgedReadBytes = async function (target: any, signal: any, maxBytes: any) {
    if (!isBridgeTarget(target, distro)) return originalReadBytes.call(fsService, target, signal, maxBytes);
    return guardPlane(target, () => callWsl('readBytes', toWslTarget(target), signal, maxBytes));
  };

  const bridgedReadByteRange = async function (target: any, range: any, signal: any) {
    if (!isBridgeTarget(target, distro)) return originalReadByteRange.call(fsService, target, range, signal);
    return guardPlane(target, () => callWsl('readByteRange', toWslTarget(target), range, signal));
  };

  const bridgedListDir = async function (target: any, signal: any) {
    if (!isBridgeTarget(target, distro)) return originalListDir.call(fsService, target, signal);
    diag('fs-route', 'listDir ' + String(target && target.targetKey));
    const entries: any[] = await guardPlane(target, () => callWsl('listDir', toWslTarget(target), signal));
    const parentDisplay = String(target && target.displayPath !== undefined ? target.displayPath : '');
    // 只透传 name/type/target/size；**丢弃 entry.version（WSL 令牌）**——否则与写/stat 的 host 版本基线混用会 FS_STALE_VERSION。
    return entries.map((entry: any) => ({
      name: entry && entry.name,
      type: entry && entry.type,
      target: {
        targetKey: uncPath(distro, entry.target.targetKey),
        displayPath: parentDisplay.startsWith('\\\\')
          ? `${parentDisplay.replace(/[\\/]+$/, '')}\\${String(entry && entry.name !== undefined ? entry.name : '')}`
          : entry.target.displayPath,
      },
      ...(entry && entry.size !== undefined ? { size: entry.size } : {}),
    }));
  };

  const callOriginal = (name: string, original: any, args: any[]) => {
    if (typeof original !== 'function') throw fsError(`remote-wsl: 宿主 fs 不支持 ${name}()`, 'FS_IO_ERROR');
    return original.apply(fsService, args);
  };

  /** 一次桥接写操作共用的前置：策略 + WSL 平面 expected 校验。 */
  const bridgeContext = async (target: any, expected: any, signal: any, sandboxPolicy: any) => {
    const policy = sandboxPolicy ?? fsService?.ctx?.sandboxPolicy?.resolve?.();
    const wslExpected = await assertExpected(target, expected, signal);
    return { policy, wslExpected };
  };

  const withBridgeVersion = async (target: any, signal: any, outcome: any) => ({
    ...outcome,
    version: await versionAfter(target, signal),
  });

  const bridgedWrite = async function (target: any, content: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return callOriginal('writeText', originalWrite, [target, content, expected, signal, sandboxPolicy]);
    diag('fs-route', 'writeText ' + String(target && target.targetKey));
    // 不经过 SandboxedFileSystem.checkedTarget 时仍要拿到会话默认策略；tool-fs 会显式传，
    // 其它调用方没传时用 fs-sandbox 的默认 resolve()，不能静默变成无围栏。
    const { policy, wslExpected } = await bridgeContext(target, expected, signal, sandboxPolicy);
    const outcome = await callWsl('writeText', toWslTarget(target), content, wslExpected, signal, policy);
    return withBridgeVersion(target, signal, outcome);
  };

  const bridgedEdit = async function (target: any, edit: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return callOriginal('editText', originalEdit, [target, edit, expected, signal, sandboxPolicy]);
    diag('fs-route', 'editText ' + String(target && target.targetKey));
    const { policy, wslExpected } = await bridgeContext(target, expected, signal, sandboxPolicy);
    // edit 的 expected 是 `{version}`（fs-rpc 只读 version）；把 WSL 版本交给它做原子 CAS。
    const editExpected = wslExpected?.version !== undefined ? { version: wslExpected.version } : null;
    const outcome = await callWsl('editText', toWslTarget(target), edit, editExpected, signal, policy);
    return withBridgeVersion(target, signal, outcome);
  };

  const bridgedPatch = async function (target: any, hunks: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return callOriginal('patchText', originalPatch, [target, hunks, expected, signal, sandboxPolicy]);
    diag('fs-route', 'patchText ' + String(target && target.targetKey));
    const { policy, wslExpected } = await bridgeContext(target, expected, signal, sandboxPolicy);
    const outcome = await callWsl('patchText', toWslTarget(target), hunks, wslExpected, signal, policy);
    return withBridgeVersion(target, signal, outcome);
  };

  const bridgedDelete = async function (target: any, expected: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(target, distro)) return callOriginal('deleteFile', originalDelete, [target, expected, signal, sandboxPolicy]);
    diag('fs-route', 'deleteFile ' + String(target && target.targetKey));
    const { policy, wslExpected } = await bridgeContext(target, expected, signal, sandboxPolicy);
    return callWsl('deleteFile', toWslTarget(target), wslExpected, signal, policy);
  };

  const bridgedMove = async function (source: any, destination: any, options: any, signal: any, sandboxPolicy: any) {
    if (!isBridgeTarget(source, distro) || !isBridgeTarget(destination, distro)) {
      return callOriginal('moveFile', originalMove, [source, destination, options, signal, sandboxPolicy]);
    }
    diag('fs-route', 'moveFile ' + String(source && source.targetKey));
    const policy = sandboxPolicy ?? fsService?.ctx?.sandboxPolicy?.resolve?.();
    const sourceExpected = await assertExpected(source, options?.expectedSource, signal);
    const destinationExpected = await assertExpected(destination, options?.expectedDestination, signal);
    const outcome = await callWsl('moveFile', toWslTarget(source), toWslTarget(destination), {
      ...(options?.hunks === undefined ? {} : { hunks: options.hunks }),
      ...(sourceExpected === null ? {} : { expectedSource: sourceExpected }),
      ...(destinationExpected === null ? {} : { expectedDestination: destinationExpected }),
    }, signal, policy);
    return {
      ...outcome,
      destination: {
        ...outcome?.destination,
        version: await versionAfter(destination, signal),
      },
    };
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
  patch('patchText', bridgedPatch);
  patch('deleteFile', bridgedDelete);
  patch('moveFile', bridgedMove);
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
