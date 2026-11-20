/**
 * dsh-remote-wsl / native-mount —— `/mnt/<drive>` 的**原生盘符快路径**（全量：读/写/stat/list/watch）。
 *
 * ## 为什么
 * WSL2 的 `/mnt/d` 是 drvfs（本质 9P）。WSL 里读它、或从 Windows 经 `\\wsl.localhost\…\mnt\d`
 * 读它，都要跨 9P 往返，实测比 Windows 原生 `D:\` 慢约 10×。`/mnt/d` 与 `D:\` **本就是同一卷**——
 * 所以对 `/mnt/<letter>` 的操作，直接在 Windows 宿主用原生 `node:fs` 操作 `X:\…`，与 9P 无关。
 *
 * ## 做法（关键）：复用 fs-rpc 的**已测语义**，只换路径平面
 * 原子写 / CAS / 行尾(CRLF)/字面量编辑 / hunks 补丁 / 移动改写 / listDir 链接语义 / 版本令牌
 * 全部在 `fs-rpc.ts` 里、且只依赖 `node:fs`。本模块**不重写这些逻辑**，而是把同一批 op 放在
 * **宿主进程**里、用 Windows 路径 `X:\…` 执行（`fs-rpc` 已改成平台自适应），再把结果里的 Windows
 * 路径换回 Linux `/mnt/…` 身份。这样"原生"与"经 WSL"是**同一套语义**，只是不再跨 9P。
 *
 * ## 版本令牌（必须全平面）
 * `/mnt` 的 stat/listDir/watch/写 CAS 全部用宿主原生 `fs.stat({bigint:true})` 的令牌
 * `dev:ino:size:mtimeNs:ctimeNs`。**不能**与 WSL drvfs 令牌混用（同文件 dev/ino 不同，实测
 * 72 vs 740756532）——所以本项目对 `/mnt` 一次性把读+stat+写都切到原生平面。
 *
 * ## 安全边界（fail-closed）
 * 1) 非 Windows（WSL/CI 的 linux 进程）一律不启用（`isNativeMountPath` 恒 false）。
 * 2) `/mnt/<letter>` 必须被证明真是 `<LETTER>:\`（`/proc/mounts` source==盘符 + fstype 9p/drvfs +
 *    盘符存在 + automount root==/mnt），TTL 缓存；不满足→回落 RPC。
 * 3) 段级校验：拒 `..`/`.`/空段、`\ : * ? " < > |`、控制字符、尾点/尾空格、保留设备名。
 * 4) 写仍走 fs-provider 既有的 `writablePath`(RPC realpath 围栏) → 拿 canonical linux 路径 → 再
 *    映射成 Windows 路径写入（围栏身份与写入目标同源）。
 *
 * @module dsh-remote-wsl/native-mount
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import {
  statOp,
  realpathOp,
  readTextOp,
  readBytesOp,
  readRangeOp,
  readChunkOp,
  listDirOp,
  statManyOp,
  writeTextOp,
  editTextOp,
  patchTextOp,
  deleteFileOp,
  moveFileOp,
} from './fs-rpc.ts';

const WINDOWS = process.platform === 'win32';

/** 带 code 的 Fs 风格错误（tool-fs 只读 code/消息）。 */
function fsError(message: string, code: string): Error {
  const e = new Error(message) as Error & { code: string; fsCode: string };
  e.code = code;
  e.fsCode = code;
  return e;
}

/** `/mnt/<letter>[/rest]` → `{ letter:'D', rest:'a/b' }`；不是 `/mnt/<单字母>` 返回 null。 */
export function windowsDriveForMount(linuxPath: any): { letter: string; rest: string } | null {
  const m = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(String(linuxPath ?? ''));
  if (!m) return null;
  return { letter: m[1].toUpperCase(), rest: m[2] ?? '' };
}

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/** rest（`a/b/c`）段级校验 → Windows 可安全拼接的相对段；任一不安全返回 null。 */
export function safeRestSegments(rest: string): string[] | null {
  if (rest === '') return [];
  const segs = String(rest).split('/');
  for (const seg of segs) {
    if (seg === '') return null;
    if (seg === '.' || seg === '..') return null;
    if (/[\\:*?"<>|]/.test(seg)) return null;
    if (/[\x00-\x1f]/.test(seg)) return null;
    if (/[. ]$/.test(seg)) return null;
    if (RESERVED.test(seg)) return null;
  }
  return segs;
}

/** `/mnt/<letter>/...` → `X:\...`；不安全或非 `/mnt/<单字母>` 返回 null（调用方回落 RPC）。 */
export function toWindowsPath(linuxPath: any): string | null {
  const m = windowsDriveForMount(linuxPath);
  if (m === null) return null;
  const segs = safeRestSegments(m.rest);
  if (segs === null) return null;
  return `${m.letter}:\\${segs.join('\\')}`;
}

/**
 * 一个 Linux 绝对路径是否可被 Windows 路径**无歧义地**表示（逐段：无 `\ : * ? " < > |`、无控制字符、
 * 无尾点/尾空格、非保留设备名）。用于 fail-open 回退宿主 9P 前的安全检查——不可表示就 fail-closed，
 * 绝不把 ext4 合法名塞进 Windows 语义后读到"另一个对象"（ADS/尾点/保留名）。
 */
export function isWindowsRepresentable(linuxPath: any): boolean {
  const segs = String(linuxPath ?? '').split('/').filter((s) => s.length > 0);
  for (const seg of segs) {
    if (/[\\:*?"<>|]/.test(seg)) return false;
    if (/[\x00-\x1f]/.test(seg)) return false;
    if (/[. ]$/.test(seg)) return false;
    if (RESERVED.test(seg)) return false;
  }
  return true;
}

/** `X:\a\b` → `/mnt/x/a/b`；无法映射（UNC/相对/`\\?\` 异常）返回 null。 */
export function winToLinux(win: any): string | null {
  let p = String(win ?? '');
  if (p.startsWith('\\\\?\\')) p = p.slice(4); // 去掉 \\?\ 长路径前缀（不处理 \\?\UNC\）
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(p);
  if (!m) return null;
  const rest = (m[2] ?? '').replace(/\\/g, '/');
  return rest ? `/mnt/${m[1].toLowerCase()}/${rest}` : `/mnt/${m[1].toLowerCase()}`;
}

// ── 挂载真实性校验（fail-closed；确认为真后低频复核，失败短缓存） ─────────────
let mountProbe: ((letter: string, distro: string) => Promise<boolean>) | null = null;
const mountCache = new Map<string, { ok: boolean; at: number }>();
/** 已确认为真后的复核间隔（缩小"运行期重映射仍按原生盘符"的窗口；1min 最多一次 wsl.exe）。 */
const MOUNT_RECHECK_MS = 60_000;
/** in-flight 去重：同一 `letter|distro` 并发探测只跑一次 wsl.exe（防 watchTick 并发抖动）。 */
const mountInflight = new Map<string, Promise<boolean | null>>();

export function _setMountProbe(fn: ((letter: string, distro: string) => Promise<boolean>) | null): void {
  mountProbe = fn;
  mountCache.clear();
  mountInflight.clear();
}
export function _resetMountCache(): void {
  mountCache.clear();
  mountInflight.clear();
}

function runWslCat(distro: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wsl.exe', ['-d', distro, '--exec', 'cat', file], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

async function defaultMountProbe(letter: string, distro: string): Promise<boolean> {
  if (!WINDOWS || !distro) return false;
  if (!fs.existsSync(`${letter}:\\`)) return false;
  let mounts: string;
  try {
    mounts = await runWslCat(distro, '/proc/mounts');
  } catch {
    return false;
  }
  const L = letter.toLowerCase();
  for (const line of mounts.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [source, mountpoint, fstype] = parts;
    if (mountpoint !== `/mnt/${L}`) continue;
    if (fstype !== '9p' && fstype !== 'drvfs') continue;
    // /proc/mounts 把反斜杠转义成八进制 `\134`：`D:\` 显示为 `D:\134`，先解码再比盘符。
    const src = String(source).replace(/\\134/g, '\\');
    const sm = /^([A-Za-z]):\\?$/.exec(src);
    if (sm && sm[1].toLowerCase() === L) return true;
  }
  return false;
}

export async function verifyMount(letter: string, distro: string): Promise<boolean> {
  if (!WINDOWS || !distro) return false;
  const key = `${letter}|${distro}`;
  const now = Date.now();
  const hit = mountCache.get(key);
  // 已确认为真：5min 内直接粘滞（避免令牌平面 原生↔WSL 翻转 → 误报 stale / watch 抖动）；到期复核一次。
  if (hit && hit.ok && now - hit.at < MOUNT_RECHECK_MS) return true;
  // 明确失败：5s 短缓存，尽快重试（不长期停用原生）。
  if (hit && !hit.ok && now - hit.at < 5000) return false;
  const res = await probeMount(letter, distro); // true / false / null(=探测异常)
  if (res === true) {
    mountCache.set(key, { ok: true, at: now });
    return true;
  }
  if (res === false) {
    mountCache.set(key, { ok: false, at: now });
    return false;
  }
  // 复核时探测异常：若此前已确认为真则保持（不因瞬时抖动切平面）；否则短期停用。
  if (hit && hit.ok) return true;
  mountCache.set(key, { ok: false, at: now });
  return false;
}

/** 探测一次挂载（并发去重）；异常返回 null，以便与"明确不匹配(false)"区分。 */
function probeMount(letter: string, distro: string): Promise<boolean | null> {
  const key = `${letter}|${distro}`;
  const existing = mountInflight.get(key);
  if (existing) return existing;
  const p = (async (): Promise<boolean | null> => {
    try {
      return await (mountProbe ?? defaultMountProbe)(letter, distro);
    } catch {
      return null;
    }
  })().finally(() => {
    mountInflight.delete(key);
  });
  mountInflight.set(key, p);
  return p;
}

/** `/mnt/<letter>/...` 是否走原生（非 Windows / 非盘映射 / 不安全段 / 挂载不符 → false）。 */
export async function isNativeMountPath(linuxPath: any, distro: string): Promise<boolean> {
  if (!WINDOWS) return false;
  const m = windowsDriveForMount(linuxPath);
  if (m === null) return false;
  if (safeRestSegments(m.rest) === null) return false;
  return verifyMount(m.letter, distro);
}

// ── 原生引擎（在宿主复用 fs-rpc op，换路径平面） ─────────────────────────────
function winOf(linuxPath: any): string {
  const win = toWindowsPath(linuxPath);
  if (win === null) throw fsError(`cannot map "${String(linuxPath)}" to a native Windows path`, 'FS_IO_ERROR');
  return win;
}

/** 原生 realpath（最近存在祖先 + 拼接缺失后缀，与 fs-provider.resolveIdentity 同义）；无法映射回 /mnt 返回 null。 */
export async function nativeRealpath(linuxPath: any, signal?: any): Promise<string | null> {
  let cur = String(linuxPath ?? '/').replace(/\/+$/, '') || '/';
  const missing: string[] = [];
  for (let i = 0; i < 128; i++) {
    signal?.throwIfAborted?.();
    const win = toWindowsPath(cur);
    if (win === null) return null;
    // realpathOp: ENOENT → {realpath:null}（继续上溯）；非 ENOENT（ENOTDIR/EACCES/ELOOP…）→ 抛出，
    // 与 fs-provider.resolveDeepestAncestor 对齐（fail-closed），不吞错上溯造成错误围栏身份。
    const r = await realpathOp({ path: win });
    if (r && r.realpath) {
      const base = winToLinux(r.realpath);
      if (base === null) return null;
      return missing.length ? `${base.replace(/\/$/, '')}/${missing.join('/')}` : base;
    }
    const idx = cur.lastIndexOf('/');
    if (idx <= 0) return null;
    missing.unshift(cur.slice(idx + 1));
    cur = cur.slice(0, idx) || '/';
  }
  return null;
}

export const nativeFs = {
  async stat(linuxPath: any, follow = true, signal?: any) {
    signal?.throwIfAborted?.();
    const r = await statOp({ path: winOf(linuxPath) }, { follow });
    return r && r.exists ? { version: r.version, type: r.type, size: r.size } : undefined;
  },

  async realpath(linuxPath: any, signal?: any) {
    return nativeRealpath(linuxPath, signal);
  },

  async readText(linuxPath: any, maxBytes: number) {
    const r = await readTextOp({ path: winOf(linuxPath), maxBytes });
    return r.text;
  },

  async readBytes(linuxPath: any, maxBytes: any) {
    const r = await readBytesOp({ path: winOf(linuxPath), maxBytes });
    return Buffer.from(r.base64, 'base64');
  },

  async readByteRange(linuxPath: any, range: any) {
    const r = await readRangeOp({ path: winOf(linuxPath), offset: range?.offset, length: range?.length });
    return Buffer.from(r.base64, 'base64');
  },

  async *streamText(linuxPath: any, signal: any, displayPath: any): AsyncGenerator<string> {
    const win = winOf(linuxPath);
    const where = String(displayPath ?? linuxPath);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted?.();
      const r = await readChunkOp({ path: win, offset, maxBytes: 1024 * 1024 });
      const bytes = Number(r?.bytes) || 0;
      if (bytes === 0) break;
      const buf = Buffer.from(String(r?.base64 ?? ''), 'base64');
      if (buf.length === 0) break;
      if (buf.includes(0)) throw fsError(`binary file (NUL byte): ${where}`, 'FS_BINARY');
      let text: string;
      try {
        text = decoder.decode(buf, { stream: true });
      } catch {
        throw fsError(`binary file (invalid UTF-8): ${where}`, 'FS_BINARY');
      }
      if (text.length > 0) yield text;
      offset += buf.length;
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  },

  /** listDir：返回 fs-provider.listDir 同形结构（targetKey 为 Linux 身份、含原生 version）；子项无法映射回 /mnt → null（整目录回落 RPC）。 */
  async listDir(target: any): Promise<any[] | null> {
    const parentKey = String(target?.targetKey ?? '/');
    const parentDisplay = String(target?.displayPath ?? parentKey);
    const r = await listDirOp({ path: winOf(parentKey) });
    const out: any[] = [];
    for (const e of r.entries ?? []) {
      // 子项解析到"映射不回 /mnt 盘符"的目标（如 junction→UNC/网络）→ 不用词法键冒充真实身份（F-25），
      // 整目录回落 RPC（罕见，正确优先）。
      const lin = winToLinux(e.targetKey);
      if (lin === null) return null;
      out.push({
        name: e.name,
        type: e.type,
        target: { targetKey: lin, displayPath: posix.join(parentDisplay, e.name) },
        ...(e.version !== undefined ? { version: e.version } : {}),
        ...(e.size !== undefined ? { size: e.size } : {}),
      });
    }
    return out;
  },

  async statMany(linuxPaths: string[]) {
    const r = await statManyOp({ paths: linuxPaths.map((p) => winOf(p)) });
    return (r?.items ?? []).map((it: any) => ({
      path: winToLinux(it.path) ?? it.path,
      exists: it.exists,
      ...(it.version !== undefined ? { version: it.version } : {}),
      ...(it.type !== undefined ? { type: it.type } : {}),
      ...(it.error !== undefined ? { error: it.error } : {}),
    }));
  },

  async writeText(linuxPath: any, content: any, expected: any) {
    const r = await writeTextOp({ path: winOf(linuxPath), content, expected });
    return { operation: r.operation, version: r.version, before: null, after: String(content) };
  },

  async editText(linuxPath: any, edit: any, expectedVersion: any) {
    const r = await editTextOp({
      path: winOf(linuxPath),
      oldString: edit?.oldString,
      newString: edit?.newString,
      replaceAll: edit?.replaceAll === true,
      expectedVersion,
    });
    return { version: r.version, before: r.before, after: r.after };
  },

  async patchText(linuxPath: any, hunks: any, expectedVersion: any) {
    const r = await patchTextOp({ path: winOf(linuxPath), hunks: Array.isArray(hunks) ? hunks : [], expectedVersion });
    return { version: r.version, before: r.before, after: r.after };
  },

  async deleteFile(linuxPath: any, expectedVersion: any) {
    const r = await deleteFileOp({ path: winOf(linuxPath), expectedVersion });
    return { before: r?.before ?? null };
  },

  async moveFile(sourceLinux: any, destLinux: any, options: any) {
    const r = await moveFileOp({
      sourcePath: winOf(sourceLinux),
      destinationPath: winOf(destLinux),
      hunks: Array.isArray(options?.hunks) ? options.hunks : null,
      expectedSourceVersion: options?.expectedSource?.version ?? null,
      expectedDestination: options?.expectedDestination ?? null,
    });
    return {
      sourceBefore: r?.sourceBefore ?? null,
      destination: {
        operation: r?.destination?.operation,
        version: r?.destination?.version,
        before: r?.destination?.before ?? null,
        after: r?.destination?.after,
      },
      sourceDeleted: r?.sourceDeleted === true,
      ...(r?.sourceFailure ? { sourceFailure: r.sourceFailure } : {}),
    };
  },
};
