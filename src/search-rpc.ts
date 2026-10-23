/**
 * dsh-remote-wsl / search-rpc —— **WSL 内**搜索（grep / glob），给 `src/search-tool.ts` 的 daemon RPC 用。
 *
 * 为什么要这一层：DSH 自带的 `tool-fs-search` 驱动的是打包的 **Windows** ripgrep，而模型给的路径是
 * Linux 路径；宿主侧那份在 WSL 世界里搜索结果不可信。这里把搜索本身放进发行版：
 *   · `grep` = 发行版自带 GNU grep（`-rnIEH`，跳过二进制与大目录）；
 *   · `glob` = `find` 列文件 + 在插件侧按 glob 匹配（`*` 不跨分隔符、`**` 跨、`?`、`[...]`）。
 * 只依赖 `node:` 内置（daemon 是独立脚本，不得 import 宿主模块）。
 *
 * @module dsh-remote-wsl/search-rpc
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

export const GREP_MAX_MATCHES = 500;
export const GREP_MAX_BYTES = 512 * 1024;
export const GLOB_MAX_RESULTS = 1000;
export const GLOB_MAX_SCAN = 50000;

const codeOf = (e) => (e && typeof e.code === 'string' ? e.code : null);
export function searchError(message, code = 'FS_IO_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

const assertLinuxAbsolute = (p) => {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) {
    throw searchError(`path must be an absolute path inside the distribution: ${String(p)}`, 'E_ARG');
  }
};

/** 跑一条命令，收 stdout/stderr（带上限）；`okCodes` 之外的退出码按失败处理。 */
function run(command, args, { timeoutMs = 30000, maxBytes = 2 * 1024 * 1024, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(searchError(`cannot spawn ${command}: ${e?.message ?? String(e)}`));
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      reject(searchError(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      if (outBytes >= maxBytes) return;
      out.push(c);
      outBytes += c.length;
    });
    child.stderr.on('data', (c) => {
      if (err.length < 200) err.push(c);
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(searchError(`cannot run ${command}: ${e?.message ?? String(e)}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== null && !okCodes.includes(code)) {
        reject(searchError(`${command} exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 300)}`));
        return;
      }
      resolve({ stdout: Buffer.concat(out).toString('utf8'), truncated: outBytes >= maxBytes, code });
    });
  });
}

/** 命令是否在发行版 PATH 上（缓存；`command -v` 走一次 bash）。 */
const whichCache = new Map();
function hasCommand(bin) {
  if (whichCache.has(bin)) return whichCache.get(bin);
  let ok = false;
  try {
    execFileSync('bash', ['-c', `command -v ${bin} >/dev/null 2>&1`], { timeout: 5000, stdio: 'ignore' });
    ok = true;
  } catch {
    ok = false;
  }
  whichCache.set(bin, ok);
  return ok;
}

const isMissingBinary = (e) => /ENOENT|cannot run/.test(String(e?.message ?? e));

/** grep 后端候选：ripgrep（最快）→ ugrep（grep 旗标兼容）→ GNU grep。 */
function grepBackends(args, root, pattern) {
  const fixed = args?.fixedString === true;
  const ignoreCase = args?.ignoreCase === true;
  const list = [];
  if (hasCommand('rg')) {
    list.push({
      name: 'ripgrep',
      command: 'rg',
      args: [
        '-n', '--no-heading', '--color', 'never', '--with-filename', '--hidden',
        '--glob', '!.git/**', '--glob', '!node_modules/**', '--glob', '!.svn/**',
        ...(fixed ? ['-F'] : []),
        ...(ignoreCase ? ['-i'] : []),
        '-e', pattern, '--', root,
      ],
    });
  }
  if (hasCommand('ugrep')) {
    list.push({
      name: 'ugrep',
      command: 'ugrep',
      args: ['-r', '-n', '-I', '-H', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.svn', fixed ? '-F' : '-E', ...(ignoreCase ? ['-i'] : []), '-e', pattern, '--', root],
    });
  }
  list.push({
    name: 'gnu grep',
    command: 'grep',
    args: ['-r', '-n', '-I', '-H', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.svn', fixed ? '-F' : '-E', ...(ignoreCase ? ['-i'] : []), '-e', pattern, '--', root],
  });
  return list;
}

/**
 * 在发行版内 grep（自动挑后端：ripgrep → ugrep → GNU grep）。
 * @param args `{pattern, path, ignoreCase?, fixedString?, maxMatches?}`
 * @returns `{matches:[{path,line,text}], truncated, total, tool:'grep', backend}`
 */
export async function grepOp(args) {
  const root = String(args?.path ?? '/');
  assertLinuxAbsolute(root);
  const pattern = String(args?.pattern ?? '');
  if (pattern.length === 0) throw searchError('grep requires a non-empty pattern', 'E_ARG');
  let lastMissing = null;
  for (const backend of grepBackends(args, root, pattern)) {
    let stdout = '';
    let truncated = false;
    try {
      const r = await run(backend.command, backend.args, { timeoutMs: 60000, maxBytes: GREP_MAX_BYTES, okCodes: [0, 1] });
      stdout = r.stdout;
      truncated = r.truncated;
    } catch (e) {
      if (isMissingBinary(e)) {
        lastMissing = e;
        continue;
      }
      throw e;
    }
    if (stdout.length === 0) return { matches: [], truncated, total: 0, tool: 'grep', backend: backend.name };
    const limit = Math.max(1, Math.min(Number(args?.maxMatches) || GREP_MAX_MATCHES, GREP_MAX_MATCHES));
    const matches = [];
    for (const line of stdout.split('\n')) {
      if (line.length === 0) continue;
      const first = line.indexOf(':');
      const second = first >= 0 ? line.indexOf(':', first + 1) : -1;
      if (first < 0 || second < 0) continue;
      const lineNo = Number(line.slice(first + 1, second));
      if (!Number.isFinite(lineNo)) continue;
      matches.push({ path: line.slice(0, first), line: lineNo, text: line.slice(second + 1) });
      if (matches.length >= limit) return { matches, truncated: true, total: matches.length, tool: 'grep', backend: backend.name };
    }
    return { matches, truncated, total: matches.length, tool: 'grep', backend: backend.name };
  }
  throw searchError(`no usable grep backend in the distribution（最后错误：${lastMissing?.message ?? 'unknown'}）`, 'E_UNAVAILABLE');
}

/** glob → 正则：`*` 不跨 `/`，`**` 跨，`?` 单字符，`[...]` 透传（转义其余）。 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if ('\\^$.|+()[]{}'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`^${out}$`);
}

/**
 * 在发行版内 glob（自动挑枚举后端：fd/fdfind → find）。
 * @param args `{pattern, path, maxResults?}`
 * @returns `{files:string[], truncated, scanned, tool:'glob', backend}`
 */
export async function globOp(args) {
  const root = String(args?.path ?? '/');
  assertLinuxAbsolute(root);
  const pattern = String(args?.pattern ?? '').trim();
  if (pattern.length === 0) throw searchError('glob requires a non-empty pattern', 'E_ARG');
  // 枚举后端：fd 并行且默认跳过 .git 与 gitignored（与 ripgrep 的语义一致）；没有就退回 find。
  const enumerators = [];
  for (const fdBin of ['fd', 'fdfind']) {
    if (hasCommand(fdBin)) {
      enumerators.push({ name: 'fd', command: fdBin, args: ['--type', 'f', '--hidden', '--exclude', '.git', '--exclude', 'node_modules', '.', root] });
      break;
    }
  }
  enumerators.push({
    name: 'find',
    command: 'find',
    args: [root, '-path', '*/node_modules', '-prune', '-o', '-path', '*/.git', '-prune', '-o', '-type', 'f', '-print'],
  });
  let stdout = '';
  let truncated = false;
  let backend = null;
  let lastMissing = null;
  for (const candidate of enumerators) {
    try {
      const r = await run(candidate.command, candidate.args, { timeoutMs: 60000, maxBytes: 8 * 1024 * 1024, okCodes: [0, 1] });
      stdout = r.stdout;
      truncated = r.truncated;
      backend = candidate.name;
      break;
    } catch (e) {
      if (isMissingBinary(e)) {
        lastMissing = e;
        continue;
      }
      throw e;
    }
  }
  if (backend === null) throw searchError(`no usable glob backend in the distribution（最后错误：${lastMissing?.message ?? 'unknown'}）`, 'E_UNAVAILABLE');
  const re = globToRegExp(pattern);
  const limit = Math.max(1, Math.min(Number(args?.maxResults) || GLOB_MAX_RESULTS, GLOB_MAX_RESULTS));
  const files = [];
  let scanned = 0;
  for (const abs of stdout.split('\n')) {
    if (abs.length === 0) continue;
    if (++scanned > GLOB_MAX_SCAN) {
      return { files, truncated: true, scanned, tool: 'glob', backend };
    }
    const rel = path.posix.relative(root, abs);
    const subject = pattern.includes('/') ? rel : path.posix.basename(rel);
    if (!re.test(subject)) continue;
    files.push(abs);
    if (files.length >= limit) return { files, truncated: true, scanned, tool: 'glob', backend };
  }
  files.sort();
  return { files, truncated: truncated || false, scanned, tool: 'glob', backend };
}

/** 统一入口：`{op:'search', method, args}`。 */
export async function handleSearchOp(req) {
  const method = String(req?.method ?? '');
  if (method === 'grep') return grepOp(req?.args ?? {});
  if (method === 'glob') return globOp(req?.args ?? {});
  throw searchError(`unknown search method: ${method}`);
}
