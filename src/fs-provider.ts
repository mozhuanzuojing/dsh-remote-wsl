/**
 * dsh-remote-wsl / fs-provider —— 宿主 `ctx.fs` 的 **WSL 执行世界** provider。
 *
 * ## 它解决什么（2026-10-23 用户报障）
 * DSH 的 `read`/`write`/`edit` 只认 `ctx.fs`。宿主默认 provider 是 `dsh-fs-local`（`fs-sandbox`
 * 子类）：它用 Windows 的 node:fs 直接操作 `\\wsl.localhost\…`（9P 共享）。9P 上"原子写"要
 * 复制 DACL/用硬链接发布，结果是 `GetFileSecurityW EIO`，写不进去。
 *
 * 本 provider 把这些**操作本身**送进 WSL：每个方法都是一次 `{op:'fs', method, args}` RPC，
 * 由 `src/daemon.ts`（WSL 侧常驻守护）里的 `fs-rpc.ts` 用原生 node:fs 执行。宿主只搬运
 * 路径与字节 —— 没有 9P。
 *
 * ## 怎么挂（不能直接在宿主平面 provide）
 * `fs` 是单例服务，cordis 不允许第二个 `provide` 抢名字。它必须挂在 **agent preset 的 isolate
 * realm** 里：`{ name: 'cordis:group', group: true, isolate: { fs: true }, config: [fs-wsl, tool-fs] }`。
 * 这正是 `dsh-wsl-workspace` 用的形态；我们由 `src/preset.ts` 注册 WSL 变体预设。
 *
 * ## 与 dsh-fs-local 的语义对齐（有意保留的部分）
 * · `stat` 跟随符号链接、`lstat` 不跟随；版本令牌 = `dev:ino:size:mtimeNs:ctimeNs`（bigint 统计，
 *   与上游 `versionOf()` 同形：删除重建 / rsync 保留 mtime / chmod 都会被识别为「变了」）；
 * · `resolve` 用 realpath 生成 targetKey（最近存在祖先 + 拼接缺失后缀）⇒ 同一文件只有一把键；
 * · 写是"同目录临时文件 + rename"（原子），保留既有 mode；`createIfAbsent` 用硬链接**独占发布**
 *   （并发创建恰好一个成功，另一个 FS_NOT_OBSERVED）；
 * · `expected.kind` 支持 `replaceIfVersion` / `createIfAbsent`；
 * · `readText` 拒绝二进制与超限（上限可配，默认 16MiB），`streamText` 是**真流式**
 *   （1MiB 分块 RPC + 跨块 UTF-8 解码），`readBytes`/`readByteRange` 走 base64。
 * **不做的**：`watch` 用 500ms 轮询近似（没有 inotify 桥）；`sandboxMode` 报 `workspace-write`，
 * 并按 host 传来的 `sandboxPolicy` 做**真实路径**围栏（`FS_SANDBOX_DENIED`），根 = 工作区
 * （UNC 或 Windows 盘符路径 → 发行版内 `/mnt/<drive>/…`）+ 发行版 `/tmp`；多发行版仍只服务配置的那一个。
 *
 * @module dsh-remote-wsl/fs-provider
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDaemon } from './daemon-client.ts';
import { callDaemon, readDaemonRecord, winToWsl } from './daemon-protocol.ts';
import { resolveVersion } from './wsl-io.ts';

import { normalizeConfig } from './config.ts';
export const name = 'dsh-remote-wsl-fs';
export const inject = [];

/** 与 index.ts 的 DEFAULTS 同形（只取 fs provider 需要的）。 */


const fsErr = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

/**
 * Linux 绝对路径 → Windows UNC。
 *
 * 为什么必须拒绝 `\`（2026-10-27 审查 F-23）：Linux 文件名允许反斜杠，而 Windows 把它当**路径分隔符**；
 * 直接 `replace(/\//g,'\\')` 会把 `/home/g/a\..\..\etc\passwd` 拼成 `\\wsl.localhost\<d>\home\g\a\..\..\etc\passwd`
 * —— Windows 侧解析 `..` 后指向**另一个文件**。UNC 语法没有能表达文件名内 `\` 的转义，所以只能报错
 * （宁可让调用方拿到明确失败，也不给它一条错路径）。
 */
const uncPath = (distro, linuxPath) => {
  const raw = String(linuxPath ?? '/');
  if (raw.includes('\\')) {
    throw fsErr(
      `cannot map "${raw}" to a Windows UNC path: a backslash inside a Linux file name would be parsed as a path separator on Windows`,
      'FS_IO_ERROR',
    );
  }
  const tail = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return `\\\\wsl.localhost\\${distro}${tail}`.replace(/\//g, '\\');
};

const UNC_RE = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i;

/** 反解 UNC：`\\wsl.localhost\<distro>\home\g` → `{distro, linuxPath:'/home/g'}`。 */
export function parseUnc(input) {
  const m = UNC_RE.exec(String(input ?? '').trim());
  if (!m) return null;
  const tail = (m[2] ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  return { distro: m[1], linuxPath: tail ? `/${tail}` : '/' };
}

/**
 * 造一个 WSL 侧 RPC 调用器（文件与搜索共用）：懒起守护 + 元数据鉴权 + 错误码透传。
 *
 * @param rawConfig - `distro` / `daemonPort` / `wslHome` / `cwd`（缺省同插件默认）
 * @returns `{config, distro, ensure, call(op, method, args, signal)}`
 */
export function createWslRpc(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const distro = String(config.distro);

  /** 懒起守护：第一次操作时确保 WSL 侧守护在跑（失败要明确报，不许假装成功）。 */
  let daemonReady = null;
  const ensure = async () => {
    if (daemonReady === null) {
      const version = resolveVersion(config);
      if (!version.version) throw fsErr('remote-wsl: 无法确定 dsh 版本（desktop runtime.json 不可读且未配 dshVersion）', 'FS_IO_ERROR');
      daemonReady = ensureDaemon(config, { version: version.version, log: () => {} }).catch((e) => {
        daemonReady = null;
        throw fsErr(`remote-wsl: 启动 WSL 守护失败：${e?.message ?? String(e)}`, 'FS_IO_ERROR');
      });
    }
    return daemonReady;
  };

  const call = async (op, method, args, signal) => {
    signal?.throwIfAborted?.();
    await ensure();
    const rec = readDaemonRecord(config);
    if (!rec || !rec.token) throw fsErr('remote-wsl: 守护元数据缺失（WSL 侧守护不在）', 'FS_IO_ERROR');
    const r = await callDaemon(config, {
      port: rec.meta?.port ?? rec.slot,
      token: rec.token,
      req: { op, id: 1, method, args },
      timeoutMs: Number(config.fsTimeoutMs) || 60000,
    });
    signal?.throwIfAborted?.();
    if (!r?.msg) throw fsErr(`remote-wsl: 守护调用失败（${r?.kind ?? 'unknown'}）：${r?.error ?? '没有回包'}`, 'FS_IO_ERROR');
    if (r.msg.ok !== true) throw fsErr(String(r.msg.error ?? 'operation failed'), String(r.msg.code ?? 'FS_IO_ERROR'));
    return r.msg.result;
  };

  return { config, distro, ensure, call };
}

/**
 * 把路径解析成真实路径：`realpath` 对**不存在的叶子**会 ENOENT，此时向上找**最近已存在的祖先**
 * 再把缺失的后缀拼回去。
 *
 * 为什么必须这样（P0，2026-10-27 审查 F-01）：沙箱围栏比较的是真实路径，而**新建文件的叶子必然
 * 不存在**。旧实现此刻回退到未解析路径 ⇒ 一个指向工作区外的目录符号链接就能把写入带出围栏。
 * 上游 `dsh-fs-local` 的 `resolveLocalTarget()` 正是「realpath 最近已存在祖先 + 拼接缺失后缀」。
 *
 * @param linuxPath 绝对 Linux 路径（调用方已 normalize）
 * @param realpathOf 返回真实路径；`null` 表示不存在（ENOENT）。其它错误应**抛出**（fail-closed）
 * @returns 真实路径（可能含不存在的后缀）；`null` = 连 `/` 都解析不出（调用方必须按失败处理）
 */
export async function resolveDeepestAncestor(linuxPath, realpathOf) {
  const raw = String(linuxPath ?? '');
  if (!raw.startsWith('/')) return raw;
  const segments = raw.split('/').filter((s) => s.length > 0);
  const suffix = [];
  let current = `/${segments.join('/')}`;
  for (;;) {
    const real = await realpathOf(current);
    if (real) {
      const base = String(real).replace(/\/+$/, '');
      if (!suffix.length) return base || '/';
      return `${base}/${suffix.join('/')}`;
    }
    // 走到 `/` 还解析不出 ⇒ 围栏/身份都无法验证，调用方必须按失败处理（绝不静默放行）。
    // 注意：`/` 本身也要试（上游 resolveLocalTarget() 的最近存在祖先可以就是根；顶层段不存在时
    // 应当返回 `/<缺失后缀>`，而不是失败 —— 2026-10-27 审查 F-25 的 resolve() 依赖这一点）。
    if (current === '/') return null;
    const cut = current.lastIndexOf('/');
    suffix.unshift(current.slice(cut + 1));
    current = cut === 0 ? '/' : current.slice(0, cut);
  }
}

/**
 * workspace-write 策略下的可写根（映射到发行版内路径）。导出以便离线验证（不需要守护）。
 *
 * 为什么要映射（2026-10-27 审查 F-16）：宿主传来的 `workspaceRoot` 有三种形状：
 *   · 同发行版 UNC（`\\wsl.localhost\<d>\home\g\ws`）⇒ 取发行版内路径；
 *   · 发行版内绝对路径（`/home/g/ws`）⇒ 原样；
 *   · **Windows 绝对路径**（`D:\proj\ws`；用 wsl preset 打开 Windows 目录会话时就是它）⇒ 用已有
 *     `winToWsl()` 映成 `/mnt/d/proj/ws`。
 * 旧实现只认前两种 ⇒ roots 只剩 `/tmp`，该工作区内的写全部 FS_SANDBOX_DENIED（错误方向安全，但功能不可用）。
 * 映射不出来的一律**不加**（少给权限，方向安全）；`/tmp` 恒在（与上游 `dsh-sandbox.writableRoots()` 同义）。
 *
 * @param policy 宿主每次写入传的 SandboxExecutionPolicy（这里只用 workspaceRoot）
 * @param distro 本 provider 服务的发行版名
 * @returns 发行版内绝对路径数组
 */
export function writableRootsOf(policy, distro) {
  const roots = [];
  if (policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
    const root = policy.workspaceRoot;
    const unc = parseUnc(root);
    if (unc !== null) {
      // 别的发行版的 UNC 不能当成本 provider 的根（也不去猜映射）⇒ 不加，写会被围栏拒绝。
      if (unc.distro === distro) roots.push(unc.linuxPath);
    } else if (root.startsWith('/') && !root.startsWith('//')) {
      roots.push(root);
    } else if (/^[A-Za-z]:[\\/]/.test(root)) {
      // Windows 盘符绝对路径：只认 winToWsl() 映射出的 /mnt/<drive>/…（`\\?\` 等长路径前缀映射不出来就忽略）。
      const mapped = winToWsl(root);
      if (mapped.startsWith('/mnt/')) roots.push(mapped);
    }
  }
  roots.push('/tmp'); // workspace-write 的语义包含平台临时区（dsh-sandbox 的 writableRoots 同义）
  return roots;
}

/**
 * `streamText` 每块请求的字节数（与 fs-rpc 的默认块一致；跨块 UTF-8 由 TextDecoder 兜住）。
 * 1MiB 的理由见 fs-rpc 同名常量：每块是一次 RPC + 一次守护元数据读取，块太小会放大大文件读取开销。
 */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * 把「按字节偏移取一块（base64）」的读取器变成 UTF-8 文本块异步迭代器。
 *
 * 为什么解码放在宿主这边：UTF-8 多字节字符可能正好跨块，只有用**同一个** `TextDecoder` 连续
 * `decode(chunk, {stream:true})` 才正确（上游 `streamWholeText()` 的 decoder 同语义；按块单独 decode 会切坏字符）。
 * 二进制判定与 readText 一致：出现 NUL 或非法 UTF-8 ⇒ FS_BINARY。
 *
 * 导出是为了能**离线**验证（本函数不碰 RPC：把 readChunk 换成 fs-rpc.readChunkOp 即可对真实文件跑）。
 *
 * @param readChunk `(offset, maxBytes) => Promise<{base64, bytes}>`；`bytes === 0` 表示文件结束
 * @param signal 取消信号（每块之间检查）
 * @param displayPath 报错文案里用的路径
 * @returns 解码后的文本块（块边界无语义；空块被跳过）
 */
export async function* decodeTextChunks(readChunk, signal, displayPath) {
  const where = displayPath ?? '<unknown>';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted?.();
    const r = await readChunk(offset, STREAM_CHUNK_BYTES);
    const bytes = Number(r?.bytes) || 0;
    if (bytes === 0) break;
    const buf = Buffer.from(String(r?.base64 ?? ''), 'base64');
    if (buf.length === 0) break; // 防御：bytes>0 但解码为空（协议异常）时不能原地死循环
    if (buf.includes(0)) throw fsErr(`binary file (NUL byte): ${where}`, 'FS_BINARY');
    let text;
    try {
      text = decoder.decode(buf, { stream: true });
    } catch {
      throw fsErr(`binary file (invalid UTF-8): ${where}`, 'FS_BINARY');
    }
    if (text.length > 0) yield text;
    offset += buf.length;
  }
  // 冲掉解码器里可能残留的不完整序列（文件尾正好截断一个多字节字符 ⇒ 非法 UTF-8，与 readText 同判据）。
  let tail;
  try {
    tail = decoder.decode();
  } catch {
    throw fsErr(`binary file (invalid UTF-8): ${where}`, 'FS_BINARY');
  }
  if (tail.length > 0) yield tail;
}

/**
 * 造一个 WSL 执行世界的 FileSystem 实现（**普通对象**：不 import `@deepseek-ai/dsh-fs`，
 * 因为本插件以 `link:` 安装，拿不到宿主包的解析路径 —— 见 README「零运行时依赖」）。
 *
 * @param rawConfig - `distro` / `daemonPort` / `wslHome` / `cwd` / `readTextMaxBytes`（缺省同插件默认）
 * @param internals - 测试缝（与 `WebHost`/`dsh-fs-local` 的 `internals` 同风格）：`fsCall` 可替换 RPC
 *   调用器，用于**离线**验证 provider 契约（不启动守护、不写 ~/.dsh）。生产路径不传。
 * @returns 与 `FileSystem` 同形的方法集合（tool-fs 只按方法名调用）
 */
export function createWslFileSystem(rawConfig = {}, internals = {}) {
  const rpc = createWslRpc(rawConfig);
  const { config, distro } = rpc;
  const call = typeof internals.fsCall === 'function'
    ? internals.fsCall
    : (method, args, signal) => rpc.call('fs', method, args, signal);

  /** 把一个输入路径解析成 `{distro, linuxPath}`；相对路径用 cwd 兜底。 */
  const translate = (input, cwd) => {
    const raw = String(input ?? '').trim();
    if (raw.length === 0) throw fsErr('file_path must be a non-empty string', 'FS_NOT_FOUND');
    const unc = parseUnc(raw);
    if (unc !== null) {
      if (unc.distro !== distro) {
        throw fsErr(`remote-wsl fs: 路径属于发行版 "${unc.distro}"，本 provider 只服务 "${distro}"`, 'FS_IO_ERROR');
      }
      return { distro, linuxPath: unc.linuxPath };
    }
    if (raw.startsWith('/')) return { distro, linuxPath: path.posix.normalize(raw) };
    const base = cwd ?? config.cwd;
    const baseUnc = parseUnc(base);
    if (baseUnc !== null) {
      if (baseUnc.distro !== distro) throw fsErr(`remote-wsl fs: cwd 属于发行版 "${baseUnc.distro}"，本 provider 只服务 "${distro}"`, 'FS_IO_ERROR');
      return { distro, linuxPath: path.posix.resolve(baseUnc.linuxPath, raw) };
    }
    if (String(base).startsWith('/')) return { distro, linuxPath: path.posix.resolve(String(base), raw) };
    // 宿主把会话 cwd 原样传给 resolve（tool-fs 的 sessionResolveOptions）：用 `wsl` preset 打开一个
    // **Windows 目录**会话时它是 `D:\…`。直接交给 path.posix.resolve 会拼出 `/home/g/D:\…` 这种伪路径，
    // 相对路径全部失败。用已有 winToWsl() 映成 /mnt/<drive>/…（与 assertWritable 的 workspaceRoot
    // 映射同一根因，审查 F-16）。
    const mapped = winToWsl(String(base));
    if (mapped.startsWith('/')) return { distro, linuxPath: path.posix.resolve(mapped, raw) };
    throw fsErr(`remote-wsl fs: 解析相对路径 "${raw}" 需要 WSL cwd（当前 cwd=${String(base)}）`, 'FS_IO_ERROR');
  };

  /**
   * 通过 RPC 解析真实路径：`null` = 不存在（ENOENT）；**其它错误照常抛出**（传输/权限错误不许吞）。
   * 用闭包传 signal：解析期间被取消要能停下。
   */
  const realpathOf = (signal) => async (linuxPath) => {
    const r = await call('realpath', { path: linuxPath }, signal);
    return r?.realpath ?? null; // realpathOp 已把 ENOENT 映射成 realpath:null
  };

  /** 最近存在的祖先 + 拼接缺失后缀（上游 `resolveLocalTarget()` 同义）；`null` = 解析失败，由调用方决定策略。 */
  const resolveIdentity = (linuxPath, signal) => resolveDeepestAncestor(linuxPath, realpathOf(signal));

  /**
   * 沙箱围栏：把 host 的 writable roots 映射到发行版内，再比**真实路径**（防符号链接逃逸）。
   *
   * P0 修复（2026-10-27 审查 F-01）：`realpath` 对**不存在的叶子**必然 ENOENT，旧实现在此刻
   * 回退到**未解析路径** ⇒「工作区内有指向外部的目录符号链接 + 写该链接下的新文件」时词法前缀
   * 通过、实际写到工作区外（fail-open）。现改为「realpath 最近存在的祖先 + 拼接缺失后缀」
   * （与上游 `dsh-fs-local` 的 `resolveLocalTarget()` 同义），并且**不再吞异常**：传输/权限错误
   * 必须让写入失败，不允许静默按词法放行。
   */
  const canonical = async (linuxPath) => {
    const resolved = await resolveIdentity(linuxPath);
    if (resolved === null) {
      // fail-closed：围栏无法验证真实路径时，宁可直接拒绝写，也不按词法放行（P0 F-01）。
      throw fsErr(`cannot resolve "${linuxPath}" against the WSL filesystem: sandbox fence cannot be verified`, 'FS_IO_ERROR');
    }
    return resolved;
  };
  /**
   * 校验可写并返回**应当写入的路径**（解析后的真实路径）；不围栏时返回 `null`（调用方用原始路径）。
   * P0 修复（F-01）：检查的 identity 必须就是被修改的 identity（check-here-write-there 同源）。
   */
  const assertWritable = async (targetKey, policy) => {
    if (!policy || typeof policy.mode !== 'string') return null; // 部署没有策略服务：与宿主一致，不围栏
    if (policy.mode === 'read-only') {
      throw fsErr(`cannot write "${targetKey}": read-only sandbox mode`, 'FS_SANDBOX_DENIED');
    }
    if (policy.mode !== 'workspace-write') return null;
    const roots = writableRootsOf(policy, distro);
    const realTarget = await canonical(targetKey);
    for (const root of roots) {
      const realRoot = await canonical(root);
      if (realTarget === realRoot || realTarget.startsWith(realRoot.endsWith('/') ? realRoot : `${realRoot}/`)) return realTarget;
    }
    // 把实际生效的 roots 写进错误：workspaceRoot 是 Windows/UNC 时，否则用户只看到 "outside the writable
    // workspace roots"，无法判断它被映射到了哪里（审查 F-16 记录的定位成本）。
    throw fsErr(`cannot write "${targetKey}": outside the writable workspace roots (${roots.join(', ')})`, 'FS_SANDBOX_DENIED');
  };

  // ── 共享轮询观察（2026-10-26 perf）：所有 watcher 合并成**一次** `statMany` / 500ms ──
  // 旧实现每个 watcher 各自 setTimeout + 各自 `stat` RPC ⇒ watcher 一多，RPC 数线性增长。
  const WATCH_INTERVAL_MS = 500;
  const watchers = new Map();
  let watchTimer = null;
  const watchTick = async () => {
    if (watchers.size === 0) {
      watchTimer = null;
      return;
    }
    const paths = [...watchers.keys()];
    try {
      const r = await call('statMany', { paths });
      const items = Array.isArray(r?.items) ? r.items : [];
      for (const item of items) {
        const set = watchers.get(item.path);
        if (!set) continue;
        const version = item?.exists ? item.version : 'missing';
        for (const w of [...set]) {
          try {
            if (w.last !== null && version !== w.last) w.changed();
            w.last = version;
          } catch {
            set.delete(w);
          }
        }
      }
    } catch (e) {
      for (const set of [...watchers.values()]) {
        for (const w of [...set]) {
          try {
            w.changed(e);
          } catch {
            set.delete(w);
          }
        }
      }
    }
    if (watchers.size > 0) watchTimer = setTimeout(watchTick, WATCH_INTERVAL_MS);
  };

  const impl = {
    /** 能力事实：本 provider 会按 host 的 workspace-write 策略围栏（见 assertWritable）。 */
    sandboxMode: 'workspace-write',

    /**
     * 轮询式观察：DSH 的文件变化观察会调它。WSL 侧没有 inotify 桥，这里每 500ms 比对一次
     * **版本令牌**（fs-rpc 的 `dev:ino:size:mtimeNs:ctimeNs`，与 stat 同源）；变化才回调。
     * 多个 watcher 共享同一条轮询（statMany 批量化）。
     */
    async watch(target, changed, signal) {
      signal?.throwIfAborted?.();
      const key = target.targetKey;
      let set = watchers.get(key);
      if (!set) {
        set = new Set();
        watchers.set(key, set);
      }
      const entry = { changed, last: null };
      set.add(entry);
      if (watchTimer === null) watchTimer = setTimeout(watchTick, WATCH_INTERVAL_MS);
      return () => {
        set.delete(entry);
        if (set.size === 0) watchers.delete(key);
        if (watchers.size === 0 && watchTimer !== null) {
          clearTimeout(watchTimer);
          watchTimer = null;
        }
      };
    },

    /**
     * 契约（`@deepseek-ai/dsh-fs` 的 `resolve`）：**同一文件必须得到同一个 targetKey**。
     *
     * 2026-10-27 审查 F-25：旧实现直接把 `path.posix.normalize/resolve` 的字符串当键 ⇒ 同一个文件经
     * 符号链接/别名得到两把键：observation-policy 会误判「没读过」（假 FS_NOT_OBSERVED、写被拒）、
     * `contains()` 把「工作区内链接指向外部」判成 contained、版本基线跨别名不可复用。
     * 现与上游 `resolveLocalTarget()` 同义：realpath 最近存在的祖先 + 拼接缺失后缀
     * （复用 resolveDeepestAncestor；新建文件的叶子不存在时也能得到稳定身份）。
     * displayPath 保留用户给的形式（上游同样用未 realpath 的 resolve(cwd,path) 做显示）。
     */
    async resolve(input, opts = {}) {
      opts.signal?.throwIfAborted?.();
      const { linuxPath } = translate(input, opts.cwd);
      const targetKey = await resolveIdentity(linuxPath, opts.signal);
      if (targetKey === null) {
        // 连 `/` 都解析不出：宿主守护/发行版层面出了问题。明确失败，不退回未解析路径（fail-closed）。
        throw fsErr(`cannot resolve "${linuxPath}" against the WSL filesystem`, 'FS_IO_ERROR');
      }
      return { targetKey, displayPath: linuxPath };
    },

    processPath(target) {
      return uncPath(distro, String(target?.targetKey ?? '/'));
    },

    processPathFromHostPath(hostPath) {
      const unc = parseUnc(hostPath);
      if (unc !== null && unc.distro === distro) return unc.linuxPath;
      return undefined;
    },

    fileUrl(target) {
      return pathToFileURL(this.processPath(target)).href;
    },

    contains(parent, child) {
      const p = String(parent?.targetKey ?? '');
      const c = String(child?.targetKey ?? '');
      return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
    },

    async stat(target, signal) {
      const r = await call('stat', { path: target.targetKey }, signal);
      return r?.exists ? { version: r.version, type: r.type, size: r.size } : undefined;
    },

    async lstat(input, opts = {}, signal) {
      const { linuxPath } = translate(input, opts?.cwd);
      const r = await call('lstat', { path: linuxPath }, signal);
      return r?.exists ? { version: r.version, type: r.type, size: r.size } : undefined;
    },

    async readText(target, signal) {
      // 上限可配（默认 16MiB，见 config.ts 的 readTextMaxBytes）：宿主 readText 的区间是 <10MiB
      // （≥10MiB 走 streamText），所以 16MiB 覆盖该区间；超限报 FS_TOO_LARGE 且不暴露实现字节数。
      const maxBytes = Math.max(config.readTextMaxBytes, 1);
      const r = await call('readText', { path: target.targetKey, maxBytes }, signal);
      return r.text;
    },

    /**
     * 真流式（2026-10-27 审查 F-11）：契约要求 `Promise<AsyncIterable<string>>`。
     * 旧实现 `return this.readText(...)` 返回的是 **string** —— host 侧 `for await` 逐字符迭代
     * 「恰好不崩」，把类型违约掩盖了；同时 ≥8MiB 文件一律 FS_TOO_LARGE。
     * 现在按 1MiB 分块向 WSL 要数据（`readChunk` RPC），宿主侧用同一个 TextDecoder 跨块解码，
     * 内存占用与文件大小解耦（消费方可以只取前几块，例如 dsh-tool-fs 的 read 窗口）。
     * RPC 发生在**迭代时**（与上游 async generator 一致），所以守护不可用不会在调用时同步抛错。
     */
    streamText(target, signal) {
      const targetKey = target.targetKey;
      const displayPath = target.displayPath;
      // 旧守护兼容（2026-10-27 换角度评审第 1 条）：v0.1.1 之前起的守护不认识 `readChunk`。
      // 守护是 detached 的 —— 宿主升级后旧守护还会继续活着，所以"协议换了一版"不能变成"大文件读不出来"。
      // 第一次拿到 unknown method/op 就退回整段 `readText`（单块），牺牲流式但保持可读。
      let useReadText = false;
      const readChunk = async (offset, maxBytes) => {
        if (!useReadText) {
          try {
            return await call('readChunk', { path: targetKey, offset, maxBytes }, signal);
          } catch (e) {
            if (!/unknown (method|op)/i.test(String(e?.message ?? e))) throw e;
            useReadText = true;
          }
        }
        if (offset > 0) return { base64: '', bytes: 0 };
        const maxBytesForText = Math.max(config.readTextMaxBytes, 1);
        const r = await call('readText', { path: targetKey, maxBytes: maxBytesForText }, signal);
        const text = String(r?.text ?? '');
        return { base64: Buffer.from(text, 'utf8').toString('base64'), bytes: Buffer.byteLength(text, 'utf8') };
      };
      return Promise.resolve(decodeTextChunks(readChunk, signal, displayPath));
    },

    async readBytes(target, signal, maxBytes) {
      const r = await call('readBytes', { path: target.targetKey, maxBytes: Math.min(Number(maxBytes) || 8 * 1024 * 1024, 8 * 1024 * 1024) }, signal);
      return Buffer.from(r.base64, 'base64');
    },

    async readByteRange(target, range, signal) {
      const r = await call(
        'readRange',
        { path: target.targetKey, offset: Number(range?.offset) || 0, length: Number(range?.length) || 0 },
        signal,
      );
      return Buffer.from(r.base64, 'base64');
    },

    async listDir(target, signal) {
      const r = await call('listDir', { path: target.targetKey }, signal);
      return (r?.entries ?? []).map((entry) => ({
        name: entry.name,
        type: entry.type,
        target: { targetKey: path.posix.join(target.targetKey, entry.name), displayPath: path.posix.join(target.targetKey, entry.name) },
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
      }));
    },

    async writeText(target, content, expected, signal, sandboxPolicy) {
      // P0（F-01）：围栏检查与写入使用**同一个**解析后路径（别名/符号链接不再有机会换目标）。
      const writePath = (await assertWritable(target.targetKey, sandboxPolicy)) ?? target.targetKey;
      const r = await call(
        'writeText',
        { path: writePath, content, expected: expected ? { kind: expected.kind, version: expected.version } : null },
        signal,
      );
      return { operation: r.operation, version: r.version, before: null, after: String(content) };
    },

    async editText(target, edit, expected, signal, sandboxPolicy) {
      const writePath = (await assertWritable(target.targetKey, sandboxPolicy)) ?? target.targetKey;
      const r = await call(
        'editText',
        {
          path: writePath,
          oldString: edit?.oldString,
          newString: edit?.newString,
          replaceAll: edit?.replaceAll === true,
          expectedVersion: expected?.version ?? null,
        },
        signal,
      );
      return { version: r.version, before: r.before, after: r.after };
    },

    versionAfterWrite(after, target) {
      return after?.version ?? `missing:${target?.targetKey ?? ''}`;
    },
  };
  return impl;
}

/**
 * Cordis 插件入口（preset 里以绝对路径挂载）。
 * `ctx.provide('fs', impl)` —— 服务归属当前 fiber，卸载自动注销（cordis 的 provide 语义）。
 */
export function apply(ctx, rawConfig = {}) {
  const impl = createWslFileSystem(rawConfig);
  ctx.provide('fs', impl);
}
