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
 * · `stat` 跟随符号链接、`lstat` 不跟随；版本 = `mtimeNs:size`；
 * · 写是"同目录临时文件 + rename"（原子），保留既有 mode；
 * · `expected.kind` 支持 `replaceIfVersion` / `createIfAbsent`；
 * · `readText` 拒绝二进制与超限，`readBytes`/`readByteRange` 走 base64。
 * **不做的**：`watch` 用 500ms 轮询近似（没有 inotify 桥）；`sandboxMode` 报 `workspace-write`，
 * 并按 host 传来的 `sandboxPolicy` 做**真实路径**围栏（`FS_SANDBOX_DENIED`），根 = 工作区（UNC→发行版内）
 * + 发行版 `/tmp`；多发行版仍只服务配置的那一个。
 *
 * @module dsh-remote-wsl/fs-provider
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDaemon } from './daemon-client.ts';
import { callDaemon, readDaemonRecord } from './daemon-protocol.ts';
import { resolveVersion } from './wsl-io.ts';

export const name = 'dsh-remote-wsl-fs';
export const inject = [];

/** 与 index.ts 的 DEFAULTS 同形（只取 fs provider 需要的）。 */
const DEFAULTS = {
  distro: 'debian-u8-1',
  wslHome: '/home/g',
  cwd: '/home/g',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  dshVersion: '',
  daemonPort: 8731,
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonLingerMs: 600000,
  daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  timeoutMs: 60000,
};

const fsErr = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const uncPath = (distro, linuxPath) =>
  `\\\\wsl.localhost\\${distro}${linuxPath.endsWith('/') ? linuxPath.slice(0, -1) : linuxPath}`.replace(/\//g, '\\');

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
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const distro = String(config.distro || DEFAULTS.distro);

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
      timeoutMs: Number(config.timeoutMs) || 60000,
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
    const cut = current.lastIndexOf('/');
    if (cut <= 0) return null; // 连 `/` 都解析不出来 ⇒ 围栏无法验证，调用方必须失败（绝不静默放行）
    suffix.unshift(current.slice(cut + 1));
    current = cut === 0 ? '/' : current.slice(0, cut);
  }
}

/**
 * 造一个 WSL 执行世界的 FileSystem 实现（**普通对象**：不 import `@deepseek-ai/dsh-fs`，
 * 因为本插件以 `link:` 安装，拿不到宿主包的解析路径 —— 见 README「零运行时依赖」）。
 *
 * @param rawConfig - `distro` / `daemonPort` / `wslHome` / `cwd`（缺省同插件默认）
 * @returns 与 `FileSystem` 同形的方法集合（tool-fs 只按方法名调用）
 */
export function createWslFileSystem(rawConfig = {}) {
  const rpc = createWslRpc(rawConfig);
  const { config, distro } = rpc;
  const call = (method, args, signal) => rpc.call('fs', method, args, signal);

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
    throw fsErr(`remote-wsl fs: 解析相对路径 "${raw}" 需要 WSL cwd（当前 cwd=${String(base)}）`, 'FS_IO_ERROR');
  };

  const targetOf = (input, cwd) => {
    const { linuxPath } = translate(input, cwd);
    return { targetKey: linuxPath, displayPath: linuxPath };
  };

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
    const resolved = await resolveDeepestAncestor(linuxPath, async (p) => {
      const r = await call('realpath', { path: p });
      return r?.realpath ?? null; // ENOENT（realpathOp 已映射成 realpath:null）⇒ 继续向父目录找
    });
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
    const roots = [];
    if (typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0) {
      const unc = parseUnc(policy.workspaceRoot);
      if (unc !== null && unc.distro === distro) roots.push(unc.linuxPath);
      else if (policy.workspaceRoot.startsWith('/')) roots.push(policy.workspaceRoot);
    }
    roots.push('/tmp'); // workspace-write 的语义包含平台临时区（dsh-sandbox 的 writableRoots 同义）
    const realTarget = await canonical(targetKey);
    for (const root of roots) {
      const realRoot = await canonical(root);
      if (realTarget === realRoot || realTarget.startsWith(realRoot.endsWith('/') ? realRoot : `${realRoot}/`)) return realTarget;
    }
    throw fsErr(`cannot write "${targetKey}": outside the writable workspace roots`, 'FS_SANDBOX_DENIED');
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
     * `mtimeNs:size`；变化才回调。多个 watcher 共享同一条轮询（statMany 批量化）。
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

    async resolve(input, opts = {}) {
      opts.signal?.throwIfAborted?.();
      return targetOf(input, opts.cwd);
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
      const r = await call('readText', { path: target.targetKey, maxBytes: 8 * 1024 * 1024 }, signal);
      return r.text;
    },

    streamText(target, signal) {
      return this.readText(target, signal);
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
