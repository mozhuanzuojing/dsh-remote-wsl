/**
 * dsh-remote-wsl / fs-rpc —— **WSL 侧文件操作**（给宿主 `ctx.fs` provider 用的 RPC 实现体）。
 *
 * 为什么要这一层（2026-10-23 用户报障：DSH 的 `write` 在 `\\wsl.localhost\…` 上
 * `GetFileSecurityW EIO`）：DSH 的文件工具只认 `ctx.fs`；宿主侧 provider 走 Windows 的 9P
 * 共享，原子写要复制 DACL/用硬链接发布，9P 上直接失败。把**操作本身**放到 WSL 里执行
 * （node:fs 直接吃 ext4），就没有 9P 这一层。
 *
 * 本文件**同时**被两处使用：
 *   1. `src/daemon.ts`（WSL 侧常驻守护）—— 真正执行文件操作；
 *   2. 探针 —— 直接调同一批函数做「真 WSL」验证。
 * 只依赖 `node:` 内置，**不得** import 宿主模块（daemon 是独立脚本，import 宿主模块会崩）。
 *
 * 语义对齐 `@deepseek-ai/dsh-fs-local`（本机 app.asar 0.2.1-rc.2 的 LocalFileSystem）：
 *   · `stat` 跟随符号链接；`lstat` 不跟随；
 *   · 版本 = `${mtimeNs}:${size}`（同一文件被改写后必然变化）；
 *   · 写：同目录临时文件 + rename（原子），保留已有文件的 mode；
 *   · `expected.kind === "replaceIfVersion"`：版本不符 ⇒ FS_STALE_VERSION；
 *     `createIfAbsent`：已存在 ⇒ FS_NOT_OBSERVED；
 *   · `readText` 拒绝二进制（NUL 或非法 UTF-8）与超限；`readBytes/readRange` 走 base64。
 *
 * @module dsh-remote-wsl/fs-rpc
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 单次 readText/readBytes 的上限（与宿主 8MB 输出上限同量级）。 */
export const FS_MAX_READ_BYTES = 8 * 1024 * 1024;

const codeOf = (e) => (e && typeof e.code === 'string' ? e.code : null);

/** 把 node 的 fs 错误映射到 DSH 的 FsError 码（工具层按码渲染）。 */
function mapFsError(e, displayPath) {
  const code = codeOf(e);
  const message = e && e.message ? e.message : String(e);
  if (code === 'ENOENT' || code === 'ENOTDIR') return fsError(`no such file or directory: ${displayPath}`, 'FS_NOT_FOUND');
  if (code === 'EACCES' || code === 'EPERM') return fsError(`permission denied: ${displayPath}`, 'FS_IO_ERROR');
  if (code === 'EISDIR') return fsError(`is a directory: ${displayPath}`, 'FS_NOT_REGULAR_FILE');
  return fsError(message, 'FS_IO_ERROR');
}

/** 带 `code` 的错误（与 `@deepseek-ai/dsh-fs` 的 FsError 同形，宿主侧只读 `code`）。 */
export function fsError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.fsCode = code;
  return error;
}

/** 版本号：mtimeNs + size；比 mtimeMs 细，秒内连续改写也能区分。 */
export async function versionOf(absPath, info) {
  const st = info ?? (await fs.promises.stat(absPath, { bigint: true }));
  return `${st.mtimeNs}:${st.size}`;
}

function typeOf(info) {
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return 'other';
}

/** 断言是绝对 Linux 路径（拒绝 UNC / 盘符 / 相对路径 —— 调用方必须先 resolve）。 */
export function assertLinuxAbsolute(p) {
  if (typeof p !== 'string' || p.length === 0) throw fsError('path must be a non-empty string', 'FS_NOT_FOUND');
  if (!p.startsWith('/')) throw fsError(`path must be absolute inside the distribution: ${p}`, 'FS_IO_ERROR');
  if (p.startsWith('//')) throw fsError(`UNC path is not an in-distribution path: ${p}`, 'FS_IO_ERROR');
}

/** 读一段文本：拒绝二进制（NUL / 非法 UTF-8）与超限。 */
export async function readTextOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const maxBytes = Math.min(Number(args?.maxBytes ?? FS_MAX_READ_BYTES) || FS_MAX_READ_BYTES, FS_MAX_READ_BYTES);
  const st = await fs.promises.stat(abs).catch((e) => {
    throw mapFsError(e, abs);
  });
  if (!st.isFile()) throw fsError(`not a regular file: ${abs}`, 'FS_NOT_REGULAR_FILE');
  if (st.size > maxBytes) throw fsError(`${st.size} bytes exceeds the ${maxBytes}-byte limit: ${abs}`, 'FS_TOO_LARGE');
  const buf = await fs.promises.readFile(abs);
  if (buf.includes(0)) throw fsError(`binary file (NUL byte): ${abs}`, 'FS_BINARY');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw fsError(`binary file (invalid UTF-8): ${abs}`, 'FS_BINARY');
  }
  return { text, size: st.size, version: await versionOf(abs, undefined) };
}

export async function readBytesOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const maxBytes = Math.min(Number(args?.maxBytes ?? FS_MAX_READ_BYTES) || FS_MAX_READ_BYTES, FS_MAX_READ_BYTES);
  const st = await fs.promises.stat(abs).catch((e) => {
    throw mapFsError(e, abs);
  });
  if (!st.isFile()) throw fsError(`not a regular file: ${abs}`, 'FS_NOT_REGULAR_FILE');
  if (st.size > maxBytes) throw fsError(`${st.size} bytes exceeds the ${maxBytes}-byte limit: ${abs}`, 'FS_TOO_LARGE');
  const buf = await fs.promises.readFile(abs);
  return { base64: buf.toString('base64'), size: st.size, version: await versionOf(abs, undefined) };
}

export async function readRangeOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const offset = Math.max(Number(args?.offset ?? 0) || 0, 0);
  const length = Math.max(Math.min(Number(args?.length ?? 0) || 0, FS_MAX_READ_BYTES), 0);
  const st = await fs.promises.stat(abs).catch((e) => {
    throw mapFsError(e, abs);
  });
  if (!st.isFile()) throw fsError(`not a regular file: ${abs}`, 'FS_NOT_REGULAR_FILE');
  if (offset > st.size) return { base64: '', size: 0, version: await versionOf(abs, undefined) };
  const handle = await fs.promises.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(length, Math.max(st.size - offset, 0)));
    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
    return { base64: buf.subarray(0, bytesRead).toString('base64'), size: bytesRead, version: await versionOf(abs, undefined) };
  } finally {
    await handle.close();
  }
}

/** 规范化真实路径（解析符号链接与 `..`）：沙箱围栏比较前必须用它，否则链接可以逃出工作区。 */
export async function realpathOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  try {
    return { realpath: await fs.promises.realpath(abs) };
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return { realpath: null };
    throw mapFsError(e, abs);
  }
}

export async function statOp(args, { follow = true } = {}) {  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const st = await (follow ? fs.promises.stat(abs) : fs.promises.lstat(abs)).catch((e) => {
    if (codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR') return null;
    throw mapFsError(e, abs);
  });
  if (st === null) return { exists: false };
  return {
    exists: true,
    type: typeOf(st),
    size: Number(st.size),
    version: await versionOf(abs, undefined),
    mode: Number(st.mode) & 0o7777,
    mtimeMs: Number(st.mtimeMs),
    symlink: follow ? st.isSymbolicLink?.() === true : st.isSymbolicLink(),
  };
}

export async function listDirOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const st = await fs.promises.stat(abs).catch((e) => {
    throw mapFsError(e, abs);
  });
  if (!st.isDirectory()) throw fsError(`not a directory: ${abs}`, 'FS_NOT_REGULAR_FILE');
  const entries = await fs.promises.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const child = path.posix.join(abs, entry.name);
    let info = null;
    try {
      // 与宿主 dsh-fs-local 的 listDirectory 对齐：用 lstat，不跟随符号链接
      // （符号链接一律报 other，不把「链接到目录」显示成 directory）。
      info = await fs.promises.lstat(child);
    } catch {
      /* 悬空链接 / 权限：按 other 报，不丢条目 */
    }
    const row = { name: entry.name, type: info === null ? 'other' : typeOf(info) };
    if (info !== null && info.isFile()) row.size = Number(info.size);
    if (info !== null) row.version = `${info.mtimeNs ?? ''}:${info.size}`;
    out.push(row);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: out, version: await versionOf(abs, undefined) };
}

/** 原子写：同目录临时文件 → rename；保留既有文件的 mode。 */
export async function writeTextOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const content = String(args?.content ?? '');
  const expected = args?.expected ?? null;
  const dir = path.posix.dirname(abs);
  await fs.promises.mkdir(dir, { recursive: true });
  let existing = null;
  try {
    existing = await fs.promises.stat(abs);
  } catch (e) {
    if (codeOf(e) !== 'ENOENT') throw mapFsError(e, abs);
  }
  if (existing !== null && !existing.isFile()) throw fsError(`cannot write "${abs}": not a regular file`, 'FS_NOT_REGULAR_FILE');
  if (expected && expected.kind === 'replaceIfVersion') {
    if (existing === null) throw fsError(`cannot write "${abs}": file no longer exists`, 'FS_STALE_VERSION');
    const v = await versionOf(abs);
    if (String(expected.version) !== v) throw fsError(`cannot write "${abs}": file changed since it was read`, 'FS_STALE_VERSION');
  } else if (expected && expected.kind === 'createIfAbsent' && existing !== null) {
    throw fsError(`cannot overwrite existing "${abs}" without reading it first`, 'FS_NOT_OBSERVED');
  }
  const tmp = path.posix.join(dir, `.${path.posix.basename(abs)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode: existing === null ? 0o666 : Number(existing.mode) & 0o7777 });
    await fs.promises.rename(tmp, abs);
  } catch (e) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* 已消失 */
    }
    throw mapFsError(e, abs);
  }
  return { operation: existing === null ? 'create' : 'update', version: await versionOf(abs) };
}

/** 字面量编辑（与 dsh-fs-local 的 applyLiteralEdit 同语义：唯一匹配 / replaceAll）。 */
export async function editTextOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const oldString = String(args?.oldString ?? '');
  const newString = String(args?.newString ?? '');
  const replaceAll = args?.replaceAll === true;
  const expectedVersion = args?.expectedVersion == null ? null : String(args.expectedVersion);
  const st = await fs.promises.stat(abs).catch((e) => {
    throw mapFsError(e, abs);
  });
  if (!st.isFile()) throw fsError(`cannot edit "${abs}": not a regular file`, 'FS_NOT_REGULAR_FILE');
  if (expectedVersion !== null) {
    const v = await versionOf(abs);
    if (v !== expectedVersion) throw fsError(`cannot edit "${abs}": file changed since it was read`, 'FS_STALE_VERSION');
  }
  if (oldString.length === 0) throw fsError('oldString must be a non-empty string', 'FS_IO_ERROR');
  const buf = await fs.promises.readFile(abs);
  if (buf.includes(0)) throw fsError(`binary file (NUL byte): ${abs}`, 'FS_BINARY');
  const text = buf.toString('utf8');
  const count = text.split(oldString).length - 1;
  if (count === 0) throw fsError(`oldString not found in "${abs}"`, 'FS_NOT_FOUND');
  if (count > 1 && !replaceAll) {
    throw fsError(`oldString is not unique in "${abs}" (${count} matches); pass replaceAll to replace every occurrence`, 'FS_IO_ERROR');
  }
  const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
  await writeTextOp({ path: abs, content: next, expected: { kind: 'replaceIfVersion', version: await versionOf(abs) } });
  return { version: await versionOf(abs), before: text, after: next };
}

/** 统一入口：`{op:'fs', method, args}` → `{result}`（抛错由 daemon 的 handle 包成错误帧）。 */
export async function handleFsOp(req) {
  const method = String(req?.method ?? '');
  const args = req?.args ?? {};
  switch (method) {
    case 'stat':
      return statOp(args, { follow: true });
    case 'realpath':
      return realpathOp(args);
    case 'lstat':
      return statOp(args, { follow: false });
    case 'readText':
      return readTextOp(args);
    case 'readBytes':
      return readBytesOp(args);
    case 'readRange':
      return readRangeOp(args);
    case 'listDir':
      return listDirOp(args);
    case 'writeText':
      return writeTextOp(args);
    case 'editText':
      return editTextOp(args);
    default:
      throw fsError(`unknown fs method: ${method}`, 'FS_IO_ERROR');
  }
}
