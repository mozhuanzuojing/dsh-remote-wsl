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
 * **不做的**：`watch`（明确报不支持，不假装）；`sandboxMode` 为 undefined（本 provider 不做
 * Windows ACL 围栏，WSL 自身是边界 —— 与 README 的安全边界一致）。
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
 * 造一个 WSL 执行世界的 FileSystem 实现（**普通对象**：不 import `@deepseek-ai/dsh-fs`，
 * 因为本插件以 `link:` 安装，拿不到宿主包的解析路径 —— 见 README「零运行时依赖」）。
 *
 * @param rawConfig - `distro` / `daemonPort` / `wslHome` / `cwd`（缺省同插件默认）
 * @returns 与 `FileSystem` 同形的方法集合（tool-fs 只按方法名调用）
 */
export function createWslFileSystem(rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const distro = String(config.distro || DEFAULTS.distro);

  /** 懒起守护：第一次文件操作时确保 WSL 侧守护在跑（失败要明确报，不许假装成功）。 */
  let daemonReady = null;
  const ensure = async () => {
    if (daemonReady === null) {
      const version = resolveVersion(config);
      if (!version.version) throw fsErr('remote-wsl fs: 无法确定 dsh 版本（desktop runtime.json 不可读且未配 dshVersion）', 'FS_IO_ERROR');
      daemonReady = ensureDaemon(config, { version: version.version, log: () => {} }).catch((e) => {
        daemonReady = null;
        throw fsErr(`remote-wsl fs: 启动 WSL 守护失败：${e?.message ?? String(e)}`, 'FS_IO_ERROR');
      });
    }
    return daemonReady;
  };

  const call = async (method, args, signal) => {
    signal?.throwIfAborted?.();
    await ensure();
    const rec = readDaemonRecord(config);
    if (!rec || !rec.token) throw fsErr('remote-wsl fs: 守护元数据缺失（WSL 侧守护不在）', 'FS_IO_ERROR');
    const r = await callDaemon(config, {
      port: rec.meta?.port ?? rec.slot,
      token: rec.token,
      req: { op: 'fs', id: 1, method, args },
      timeoutMs: Number(config.timeoutMs) || 60000,
    });
    signal?.throwIfAborted?.();
    if (!r?.msg) throw fsErr(`remote-wsl fs: 守护调用失败（${r?.kind ?? 'unknown'}）：${r?.error ?? '没有回包'}`, 'FS_IO_ERROR');
    if (r.msg.ok !== true) {
      const error = fsErr(String(r.msg.error ?? 'fs operation failed'), String(r.msg.code ?? 'FS_IO_ERROR'));
      throw error;
    }
    return r.msg.result;
  };

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

  const impl = {
    /** 不围栏：WSL 自身是隔离边界（与插件 README 的安全边界一致）。 */
    sandboxMode: undefined,

    async watch() {
      throw fsErr('Filesystem watching is not supported by the WSL provider.', 'FS_IO_ERROR');
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

    async writeText(target, content, expected, signal) {
      const r = await call(
        'writeText',
        { path: target.targetKey, content, expected: expected ? { kind: expected.kind, version: expected.version } : null },
        signal,
      );
      return { operation: r.operation, version: r.version, before: null, after: String(content) };
    },

    async editText(target, edit, expected, signal) {
      const r = await call(
        'editText',
        {
          path: target.targetKey,
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
