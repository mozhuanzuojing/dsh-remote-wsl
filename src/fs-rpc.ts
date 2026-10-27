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
 * 语义对齐 `@deepseek-ai/dsh-fs-local`（本机 0.2.1-rc.3 的 LocalFileSystem）：
 *   · `stat` 跟随符号链接；`lstat` 不跟随；
 *   · 版本令牌 = `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`，**bigint 统计**（2026-10-27 审查 F-27：
 *     旧实现只有 `mtimeNs:size`，删除重建 / rsync 保留 mtime / chmod 后令牌不变 ⇒ 陈旧保护漏判）；
 *   · 写：同目录临时文件 + rename（原子），保留已有文件的 mode；`createIfAbsent` 用**硬链接独占发布**
 *     （link(2) 已存在目标时 EEXIST，原子、不覆盖 —— 审查 F-28：先 stat 后 rename 时并发创建会静默互相覆盖）；
 *   · `expected.kind === "replaceIfVersion"`：版本不符 ⇒ FS_STALE_VERSION；
 *     `createIfAbsent`：已存在 ⇒ FS_NOT_OBSERVED；
 *   · `readText` 拒绝二进制（NUL 或非法 UTF-8）；上限可配（默认见 READ_TEXT_DEFAULT_BYTES），且用
 *     **流式硬截断**读（审查 F-29：stat 后文件可增长，`readFile()` 会按增长后的全文吃内存）；
 *   · `readChunk`：`streamText` 的分块读取（每块独立 open/read/close，UTF-8 跨块由宿主侧 TextDecoder 兜）；
 *   · `readBytes/readRange` 走 base64。
 *
 * @module dsh-remote-wsl/fs-rpc
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 单次 readBytes/readRange 的字节上限（base64 JSON 帧的传输上限，不是产品契约）。 */
export const FS_MAX_READ_BYTES = 8 * 1024 * 1024;

/**
 * `readText` 的默认上限 / 允许的请求上限。
 *
 * 为什么不是上游的「无上限」：上游 `readWholeText()` 在**同进程**把字符串交给调用方；本 provider 要把
 * 整段文本塞进**一个 JSON 帧**回传，无上限 ⇒ 守护进程按文件大小吃内存。16MiB 的依据是宿主
 * `dsh-tool-fs` 的分流阈值：`size >= 10MiB` 时改走 `streamText()`（STREAM_MIN_SIZE），所以 readText
 * 只需覆盖 10MiB 以下并留余量；更大的文件由 streamText 分块读（2026-10-27 审查 F-11）。
 */
export const READ_TEXT_DEFAULT_BYTES = 16 * 1024 * 1024;

/** readText 的传输层硬上限：配置误填（比如 4GiB）也不会让单个帧无限大。 */
const READ_TEXT_CEILING_BYTES = 64 * 1024 * 1024;

/**
 * `streamText` 一块的默认字节数。
 * 为什么是 1MiB 而不是上游 createReadStream 的 64KiB：这里的每一块是一次 **TCP RPC**，宿主侧
 * `rpc.call()` 每次还要同步读一次守护元数据（9P ≈ 1.3ms/读，实测）⇒ 块太小会把大文件读放大成
 * 数百次往返（100MiB 按 256KiB = 400 次 ≈ 2s 纯开销）。1MiB 时同样文件 100 次 ≈ 0.5s，
 * 而单帧 base64 ≈ 1.37MB，仍在可接受内存范围内。
 */
export const STREAM_CHUNK_BYTES = 1024 * 1024;

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

/**
 * 版本令牌：`dev:ino:size:mtimeNs:ctimeNs`（与上游 `dsh-fs-local` 的 `versionOf()` 同形）。
 *
 * 为什么必须带 dev/ino/ctime（2026-10-27 审查 F-27）：只比 `mtimeNs:size` 时，「删除后重建、
 * `cp -p`/rsync 恢复（mtime/size 保留）、chmod、rename 覆盖」等改动令牌不变 ⇒ `replaceIfVersion`
 * 会把**别人刚写的版本**当成自己读过的版本覆盖掉。ctime 还会在 chmod 等元数据变更时变化。
 *
 * @param info `fs.promises.stat(..., {bigint:true})` / `lstat(..., {bigint:true})` 的结果。
 *   **必须**是 bigint 统计：Node 的非 bigint Stats 没有 `mtimeNs/ctimeNs`（实测 Node 26）。
 * @returns 不透明版本串（消费者不得解析，只做相等比较）
 */
export function versionOf(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
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

/** 取正整数字节上限；非法/缺省时用 fallback，并夹到 ceiling。 */
function limitOf(value, fallback, ceiling) {
  const n = Number(value);
  const bytes = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.min(bytes, ceiling);
}

/** 按 bigint 统计一个常规文件；不存在/非文件给出明确的 FS 码。 */
async function statRegularFile(abs) {
  let st;
  try {
    st = await fs.promises.stat(abs, { bigint: true });
  } catch (e) {
    throw mapFsError(e, abs);
  }
  if (!st.isFile()) throw fsError(`not a regular file: ${abs}`, 'FS_NOT_REGULAR_FILE');
  return st;
}

/**
 * stat 之后还可能增长的文件读取：**流式 + 硬截断**到 maxBytes。
 *
 * 为什么不能直接 `readFile()`（2026-10-27 审查 F-29）：上限只在 stat 那一刻检查，读的时候文件可能已经
 * 从 1MiB 长到 500MiB，`readFile()` 会把增长后的全文一次性吃进守护进程内存。这里用
 * `createReadStream({end: maxBytes})` 最多读 maxBytes+1 字节 —— 多出的 1 字节只用于**判定超限**，
 * 不会继续累积（上游 `readWholeBytes()` 同法）。
 *
 * @param abs 绝对路径
 * @param maxBytes 允许的字节数
 * @param tooLarge 超限时构造的错误（readText 与 readBytes 的文案要求不同）
 * @returns 完整内容（≤ maxBytes）
 */
async function readCapped(abs, maxBytes, tooLarge) {
  const stream = fs.createReadStream(abs, { end: maxBytes });
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw tooLarge();
      chunks.push(chunk);
    }
  } catch (e) {
    if (e && e.fsCode) throw e; // 我们自己的 FsError 直接透传
    throw mapFsError(e, abs);
  }
  return Buffer.concat(chunks, bytes);
}

/**
 * `readText` 超限的错误。**故意不带字节数**（2026-10-27 审查 F-11）：上限是实现/传输细节，
 * 把 `8388608` 这类数字抛给模型只会误导（它既不是文件大小也不是产品限制）。
 */
const tooLargeText = (abs) => fsError(`cannot read "${abs}": file is too large to read as text`, 'FS_TOO_LARGE');

/** 读一段文本：拒绝二进制（NUL / 非法 UTF-8）与超限。 */
export async function readTextOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const maxBytes = limitOf(args?.maxBytes, READ_TEXT_DEFAULT_BYTES, READ_TEXT_CEILING_BYTES);
  const st = await statRegularFile(abs);
  // 先按 stat 短路（不做内容 I/O）；stat 之后仍可能增长，由 readCapped 再兜一层。
  if (st.size > BigInt(maxBytes)) throw tooLargeText(abs);
  const buf = await readCapped(abs, maxBytes, () => tooLargeText(abs));
  if (buf.includes(0)) throw fsError(`binary file (NUL byte): ${abs}`, 'FS_BINARY');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw fsError(`binary file (invalid UTF-8): ${abs}`, 'FS_BINARY');
  }
  return { text, size: buf.length, version: versionOf(st) };
}

export async function readBytesOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const maxBytes = limitOf(args?.maxBytes, FS_MAX_READ_BYTES, FS_MAX_READ_BYTES);
  const st = await statRegularFile(abs);
  if (st.size > BigInt(maxBytes)) {
    throw fsError(`cannot read "${abs}": ${st.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE');
  }
  // 与 readText 同因同法：stat 后增长不能绕过上限（审查 F-29 的 readBytes 同型问题）。
  const buf = await readCapped(abs, maxBytes, () =>
    fsError(`cannot read "${abs}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE'),
  );
  return { base64: buf.toString('base64'), size: buf.length, version: versionOf(st) };
}

export async function readRangeOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const offset = Math.max(Math.trunc(Number(args?.offset ?? 0)) || 0, 0);
  const length = Math.max(Math.floor(Math.min(Number(args?.length ?? 0) || 0, FS_MAX_READ_BYTES)), 0);
  const st = await statRegularFile(abs);
  if (BigInt(offset) > st.size) return { base64: '', size: 0, version: versionOf(st) };
  const handle = await fs.promises.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(length, Number(st.size - BigInt(offset))));
    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
    return { base64: buf.subarray(0, bytesRead).toString('base64'), size: bytesRead, version: versionOf(st) };
  } finally {
    await handle.close();
  }
}

/**
 * `streamText` 的分块读取（无状态）：按字节偏移读一块，base64 回传。
 *
 * 为什么回 base64 而不是解码后的 text：UTF-8 多字节字符可能**正好跨块**，按块单独 decode 会把字符切坏；
 * 解码必须由宿主用同一个 `TextDecoder('utf-8',{fatal:true})` 连续流式做（上游 `streamWholeText()`
 * 也是这个语义）。无状态设计（每次 open/read/close）保证客户端异常退出时不会留下未关闭的 fd。
 *
 * @param args `{path, offset, maxBytes}`
 * @returns `{base64, bytes}`；`bytes === 0` 表示文件结束
 */
export async function readChunkOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const offset = Math.max(Math.trunc(Number(args?.offset ?? 0)) || 0, 0);
  const maxBytes = limitOf(args?.maxBytes, STREAM_CHUNK_BYTES, FS_MAX_READ_BYTES);
  // 先 stat 判类型再 open：对 FIFO/socket 直接 open('r') 会**阻塞**到有写者为止（读工具不该挂死）。
  // 上游 streamWholeText 也是先 statRegularFile 再 createReadStream。
  const st = await statRegularFile(abs);
  let handle;
  try {
    handle = await fs.promises.open(abs, 'r');
  } catch (e) {
    throw mapFsError(e, abs);
  }
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, offset);
    return { base64: buf.subarray(0, bytesRead).toString('base64'), bytes: bytesRead, size: Number(st.size) };
  } catch (e) {
    throw mapFsError(e, abs);
  } finally {
    await handle.close().catch(() => {});
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

/**
 * 统计路径元数据（bigint 一次完成：version 与 type/size 同源，不再 stat 两次出现不一致窗口）。
 * @param args `{path}`
 * @param follow true = stat（跟随链接）；false = lstat（不跟随）
 */
export async function statOp(args, { follow = true } = {}) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  let st;
  try {
    st = await (follow ? fs.promises.stat(abs, { bigint: true }) : fs.promises.lstat(abs, { bigint: true }));
  } catch (e) {
    if (codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR') return { exists: false };
    throw mapFsError(e, abs);
  }
  return {
    exists: true,
    type: typeOf(st),
    size: Number(st.size),
    version: versionOf(st),
    mode: Number(st.mode & 0o7777n),
    mtimeMs: Number(st.mtimeMs),
    symlink: follow ? false : st.isSymbolicLink(),
  };
}

/**
 * 批量 stat：给 watch 轮询用（一次 RPC 覆盖多个目标，避免 watcher 多时 RPC 线性增长）。
 * @param args `{paths: string[]}`
 * @returns `{items:[{path, exists?, version?, error?}]}`（单条失败不影响其余）
 */
export async function statManyOp(args) {
  const paths = Array.isArray(args?.paths) ? args.paths.map((p) => String(p)) : [];
  const items = await Promise.all(
    paths.map(async (p) => {
      try {
        const st = await fs.promises.stat(p, { bigint: true });
        return { path: p, exists: true, version: versionOf(st), type: typeOf(st) };
      } catch (e) {
        if (codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR') return { path: p, exists: false };
        return { path: p, exists: false, error: String(e?.message ?? e) };
      }
    }),
  );
  return { items };
}

export async function listDirOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const st = await fs.promises.stat(abs, { bigint: true }).catch((e) => {
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
      // 必须 {bigint:true}：非 bigint 的 Stats 没有 mtimeNs ⇒ 旧版本这里产出的版本串是 `":<size>"`（审查 F-27/F-9）。
      info = await fs.promises.lstat(child, { bigint: true });
    } catch {
      /* 悬空链接 / 权限：按 other 报，不丢条目 */
    }
    const row = { name: entry.name, type: info === null ? 'other' : typeOf(info) };
    if (info !== null && info.isFile()) row.size = Number(info.size);
    // entry.version 与 stat() 同源、同一种令牌格式：消费者可以拿它做「是否变化」判断。
    if (info !== null) row.version = versionOf(info);
    out.push(row);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: out, version: versionOf(st) };
}

// ── 写路径的并发纪律 ──────────────────────────────────────────────────────────
//
// 为什么需要 per-target 锁（2026-10-27 审查 F-32 记录、F-28 同源）：守护进程是单进程、但请求是并发处理的。
// 「读版本 → 比较 → rename」这段不是原子的：两个 replaceIfVersion 都读到 v1、都通过检查、后写者静默覆盖
// 先写者（版本令牌再强也拦不住）。上游 `LocalFileSystem.writeText/editText` 都包在 `withLock(targetKey)`
// 里；这里用同义的 Promise 链（FIFO）串行化同一路径的写/编辑。
const writeLocks = new Map();

/** 在 `key` 的串行队列上执行 `op`（同一 key 的调用按到达顺序一个接一个）。 */
async function withPathLock(key, op) {
  const prior = writeLocks.get(key) ?? Promise.resolve();
  const run = prior.then(op, op);
  const tail = run.then(() => undefined, () => undefined);
  writeLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (writeLocks.get(key) === tail) writeLocks.delete(key);
  }
}

/** bigint stat；不存在返回 null（ENOTDIR 等其它错误照常映射抛出）。 */
async function statOrNull(abs) {
  try {
    return await fs.promises.stat(abs, { bigint: true });
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return null;
    throw mapFsError(e, abs);
  }
}

/**
 * 写内核（**调用方已持有 `abs` 的路径锁**）。
 *
 * 原子发布两种语义：
 *   · `createIfAbsent`：临时文件写好后用 `link(2)` 发布。目标已存在时 link 以 `EEXIST` 失败，
 *     所以**并发创建恰好只有一个成功**，另一个报 FS_NOT_OBSERVED（审查 F-28；旧实现先 stat 再 rename，
 *     两个并发请求都看到「不存在」，后者静默覆盖前者）；
 *   · 其它：同目录临时文件 + rename（原子替换，保留既有 mode）。
 */
async function writeTextLocked(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  const content = String(args?.content ?? '');
  const expected = args?.expected ?? null;
  const existing = await statOrNull(abs);
  if (existing !== null && !existing.isFile()) throw fsError(`cannot write "${abs}": not a regular file`, 'FS_NOT_REGULAR_FILE');
  // 合法性判定在 mkdir 之前：被拒绝的写不该在盘上留下新建的父目录（审查 F-32 记录的副作用顺序问题）。
  if (expected && expected.kind === 'replaceIfVersion') {
    if (existing === null) throw fsError(`cannot write "${abs}": file no longer exists`, 'FS_STALE_VERSION');
    if (String(expected.version) !== versionOf(existing)) {
      throw fsError(`cannot write "${abs}": file changed since it was read`, 'FS_STALE_VERSION');
    }
  } else if (expected && expected.kind === 'createIfAbsent' && existing !== null) {
    throw fsError(`cannot overwrite existing "${abs}" without reading it first`, 'FS_NOT_OBSERVED');
  }
  const dir = path.posix.dirname(abs);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.posix.join(dir, `.${path.posix.basename(abs)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = existing === null ? 0o666 : Number(existing.mode & 0o7777n);
  try {
    await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode });
    if (expected && expected.kind === 'createIfAbsent') {
      try {
        await fs.promises.link(tmp, abs);
      } catch (e) {
        if (codeOf(e) === 'EEXIST') {
          throw fsError(`cannot overwrite existing "${abs}" without reading it first`, 'FS_NOT_OBSERVED');
        }
        throw mapFsError(e, abs);
      }
    } else {
      await fs.promises.rename(tmp, abs);
    }
  } catch (e) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* 已消失 / 尚未创建 */
    }
    if (e && e.fsCode) throw e;
    throw mapFsError(e, abs);
  }
  // link 发布后临时文件仍是一个硬链接，必须删掉（rename 已消费它）；清理失败不影响已提交的结果。
  if (expected && expected.kind === 'createIfAbsent') {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* 清理失败不影响写入结果 */
    }
  }
  const after = await statOrNull(abs);
  return {
    operation: existing === null ? 'create' : 'update',
    version: after ? versionOf(after) : `missing:${abs}`,
  };
}

/** 原子写：按 target 串行化（见 withPathLock / writeTextLocked）。 */
export async function writeTextOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  return withPathLock(abs, () => writeTextLocked(args));
}

/**
 * 字面量编辑（与 dsh-fs-local 的 applyLiteralEdit 同语义：唯一匹配 / replaceAll）。
 * 整个「读 → 匹配 → 写」在 target 的路径锁内完成（上游 `editText` 的 critical section 同义）。
 */
export async function editTextOp(args) {
  const abs = String(args?.path ?? '');
  assertLinuxAbsolute(abs);
  return withPathLock(abs, async () => {
    const oldString = String(args?.oldString ?? '');
    const newString = String(args?.newString ?? '');
    const replaceAll = args?.replaceAll === true;
    const expectedVersion = args?.expectedVersion == null ? null : String(args.expectedVersion);
    const st = await fs.promises.stat(abs, { bigint: true }).catch((e) => {
      throw mapFsError(e, abs);
    });
    if (!st.isFile()) throw fsError(`cannot edit "${abs}": not a regular file`, 'FS_NOT_REGULAR_FILE');
    const currentVersion = versionOf(st);
    if (expectedVersion !== null && currentVersion !== expectedVersion) {
      throw fsError(`cannot edit "${abs}": file changed since it was read`, 'FS_STALE_VERSION');
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
    // 用读到的版本做 CAS：读取期间若文件被外部改动，writeTextLocked 的版本比较会拒绝（fail-closed）。
    const written = await writeTextLocked({
      path: abs,
      content: next,
      expected: { kind: 'replaceIfVersion', version: currentVersion },
    });
    return { version: written.version, before: text, after: next };
  });
}

/** 统一入口：`{op:'fs', method, args}` → `{result}`（抛错由 daemon 的 handle 包成错误帧）。 */
export async function handleFsOp(req) {
  const method = String(req?.method ?? '');
  const args = req?.args ?? {};
  switch (method) {
    case 'stat':
      return statOp(args, { follow: true });
    case 'statMany':
      return statManyOp(args);
    case 'realpath':
      return realpathOp(args);
    case 'lstat':
      return statOp(args, { follow: false });
    case 'readText':
      return readTextOp(args);
    case 'readChunk':
      return readChunkOp(args);
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
