/**
 * dsh-remote-wsl / search-rpc —— **WSL 内**搜索（grep / glob），给 `src/search-tool.ts` 的 daemon RPC 用。
 *
 * 为什么要这一层：DSH 自带的 `tool-fs-search` 驱动的是打包的 **Windows** ripgrep，而模型给的路径是
 * Linux 路径；宿主侧那份在 WSL 世界里搜索结果不可信。这里把搜索本身放进发行版：
 *   · `grep` = ripgrep → ugrep → 发行版自带 GNU grep（自动挑可用的后端）；
 *   · `glob` = fd/fdfind → `find` 列文件 + 在插件侧按 glob 匹配（`*` 不跨分隔符、`**` 跨、`?`、`[...]`）。
 * 只依赖 `node:` 内置（daemon 是独立脚本，不得 import 宿主模块）。
 *
 * 2026-10-27 搜索层修复：
 *   · F-13：三个后端的正则方言不一致（GNU grep -E 不认识 `\d`、`(?i)`，只往 stderr 打 warning 后
 *     返回 rc=1 ⇒ 模型看到"no matches"的**假阴性**）。这里把 `\d/\D/\w/\W/\s/\S` 与**前置**内联
 *     flag `(?i)/(?-i)` 归一成 POSIX ERE 能表达的等价形式，三个后端语义一致；归一不掉的东西
 *     （lookaround、`(?:`、反向引用…）**原样保留**，但把后端 stderr 当 `warnings` 回给调用方，绝不静默。
 *   · F-29：`--null`（文件名后接 NUL）后再解析，路径里带 `:` 也不会错位；输出被字节上限截断时
 *     **丢掉最后半行**，不把半行当匹配；后端 stderr 一并回传（`warnings`）。
 *   · F-23：rg/fd 显式 `--no-ignore`，与 GNU grep/find 的"不信 .gitignore"语义对齐，结果集不再漂移。
 *   · F-24/F-26：`[...]` 字符类（含 `[!...]`/`[^...]` 取反）不再被转义成字面量；`**` 作为完整
 *     路径段时归一成"可选的多层目录前缀"，不再把 `a/xb` 当成 `a/b` 的匹配。
 *   · F-22 附带项：`hasCommand` 的缓存加 TTL，二进制装好后不会永远"看不见"。
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

/**
 * 跑一条命令，收 stdout/stderr（带上限）；`okCodes` 之外的退出码按失败处理。
 * 返回里带 `stderr` 与 `code`：rc=1（无匹配）也可能同时有 stderr 警告，调用方必须能看见（F-13）。
 * @param opts.signal - 可选 AbortSignal：取消时 SIGKILL 子进程
 */
function run(command, args, { timeoutMs = 30000, maxBytes = 2 * 1024 * 1024, okCodes = [0], signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(searchError(`${command} aborted by caller`));
      return;
    }
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
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    };
    const onAbort = () => kill();
    const settle = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        /* ignore */
      }
      fn(value);
    };
    const timer = setTimeout(() => {
      kill();
      settle(reject, searchError(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch {
      /* ignore */
    }
    child.stdout.on('data', (c) => {
      if (outBytes >= maxBytes) return;
      out.push(c);
      outBytes += c.length;
    });
    child.stderr.on('data', (c) => {
      if (err.length < 200) err.push(c);
    });
    child.on('error', (e) => settle(reject, searchError(`cannot run ${command}: ${e?.message ?? String(e)}`)));
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== null && !okCodes.includes(code)) {
        settle(reject, searchError(`${command} exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      settle(resolve, { stdout: Buffer.concat(out).toString('utf8'), stderr, truncated: outBytes >= maxBytes, code });
    });
  });
}

/** `command -v` 结果缓存时长：装完二进制后最多 30s 就能被看见（旧缓存永不失效，F-22 附带项）。 */
const WHICH_TTL_MS = 30_000;
const whichCache = new Map(); // bin -> {ok, at}
function hasCommand(bin) {
  const hit = whichCache.get(bin);
  if (hit && Date.now() - hit.at < WHICH_TTL_MS) return hit.ok;
  let ok = false;
  try {
    execFileSync('bash', ['-c', `command -v ${bin} >/dev/null 2>&1`], { timeout: 5000, stdio: 'ignore' });
    ok = true;
  } catch {
    ok = false;
  }
  whichCache.set(bin, { ok, at: Date.now() });
  return ok;
}

/** 清空 `hasCommand` 缓存（测试/诊断；生产不需要）。 */
export function resetSearchCommandCache() {
  whichCache.clear();
}

const isMissingBinary = (e) => /ENOENT|cannot run/.test(String(e?.message ?? e));
/** 老/精简发行版的 grep 可能不认 `--null`：这种"不认识这个选项"的错误应当继续试下一个候选，而不是整体失败。 */
const isUnsupportedFlag = (e) => /invalid option|unrecognized option|unknown option|illegal option/i.test(String(e?.message ?? e));

/** 由 daemon 在每次 search 前注入（自动安装出来的绝对路径；null = 用 PATH 上的名字）。 */
let installedPaths = { rg: null, fd: null };
export function setSearchToolPaths(paths) {
  installedPaths = { rg: paths?.rg ?? null, fd: paths?.fd ?? null };
}

/* ------------------------------------------------------------------ *
 * grep：正则归一化 + 后端选择 + 输出解析
 * ------------------------------------------------------------------ */

/** `\d` 等简写 → POSIX ERE 等价写法（字符类外）。 */
const SHORTHAND_OUTSIDE = {
  d: '[0-9]',
  D: '[^0-9]',
  w: '[A-Za-z0-9_]',
  W: '[^A-Za-z0-9_]',
  s: '[[:space:]]',
  S: '[^[:space:]]',
};
/** 字符类**内**只能用不包外层括号的形式（`[\d]` → `[0-9]`）。 */
const SHORTHAND_INSIDE = { d: '0-9', w: 'A-Za-z0-9_', s: '[:space:]' };

/**
 * 把一个"PCRE 口味"的模式归一成三个后端（ripgrep / ugrep / GNU grep -E）语义一致的写法。
 *
 * 为什么必须做：GNU grep 的 ERE 不认识 `\d`（会被当成字面量 `d`）也不认识 `(?i)`；它只在
 * stderr 打一句 warning 然后按 rc=1 返回，模型看到的是 **no matches**——静默假阴性（F-13）。
 * 归一后 `\d` → `[0-9]`、前置 `(?i)` → `-i` 参数，任何后端都一致。
 *
 * 归一不掉的结构（lookaround、`(?:`、`\1`、`\p{...}`）不丢：原样保留 + 记 `warnings`，
 * 由调用方连同后端 stderr 一起回给模型（"明确报错/警告"而不是假装无匹配）。
 *
 * @returns `{pattern, ignoreCase, warnings}`
 */
export function normalizeGrepPattern(pattern, { ignoreCase = false } = {}) {
  let p = String(pattern ?? '');
  const warnings = [];
  let ic = ignoreCase === true;
  // 前置内联 flag：`(?i)` / `(?-i)` / `(?ii)`。GNU grep 会警告后 rc=1 ⇒ 必须摘掉换成 -i。
  for (;;) {
    const m = /^\(\?(-?i+)\)/.exec(p);
    if (!m) break;
    ic = !m[1].startsWith('-');
    p = p.slice(m[0].length);
  }
  let out = '';
  let inClass = false;
  let classJustOpened = false;
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '\\') {
      const next = p[i + 1];
      if (next === undefined) {
        out += '\\\\';
        i += 1;
        continue;
      }
      if (inClass && SHORTHAND_INSIDE[next]) {
        out += SHORTHAND_INSIDE[next];
        i += 2;
        continue;
      }
      if (!inClass && SHORTHAND_OUTSIDE[next]) {
        out += SHORTHAND_OUTSIDE[next];
        i += 2;
        continue;
      }
      if (inClass && (next === 'D' || next === 'W' || next === 'S')) {
        warnings.push(`\\${next} 在 [...] 里无法归一成 POSIX ERE；已原样传给后端（结果可能不一致）`);
      } else if (/[1-9]/.test(next)) {
        warnings.push(`反向引用 \\${next} 不是 POSIX ERE；GNU grep 后端可能按字面量处理（结果可能不一致）`);
      } else if (next === 'p' || next === 'P') {
        warnings.push(`Unicode 属性类 \\${next}{...} 不是 POSIX ERE；GNU grep 后端不支持（结果可能不一致）`);
      }
      // `\b`/`\B`/其它：三个后端都支持或按转义处理，原样保留。
      out += `\\${next}`;
      i += 2;
      continue;
    }
    if (ch === '[' && !inClass) {
      inClass = true;
      classJustOpened = true;
      out += ch;
      i += 1;
      continue;
    }
    if (inClass && ch === ']' && !classJustOpened) {
      inClass = false;
      out += ch;
      i += 1;
      continue;
    }
    if (inClass) classJustOpened = false;
    out += ch;
    i += 1;
  }
  if (out.includes('(?')) {
    warnings.push('模式里有 PCRE 专有结构（如 (?= / (?: / (?<）；GNU grep 后端会忽略它并返回 rc=1，结果可能不完整');
  }
  return { pattern: out, ignoreCase: ic, warnings };
}

/** grep 后端候选：ripgrep（最快）→ ugrep（grep 旗标兼容）→ GNU grep。 */
function grepBackends(args, root, pattern) {
  const fixed = args?.fixedString === true;
  const ignoreCase = args?.ignoreCase === true;
  const common = [
    '--exclude-dir=.git',
    '--exclude-dir=node_modules',
    '--exclude-dir=.svn',
    fixed ? '-F' : '-E',
    ...(ignoreCase ? ['-i'] : []),
  ];
  const list = [];
  // rg 候选：自动装的绝对路径优先；它失效（被删）时再退回 PATH 上的 rg。
  const rgCandidates = [];
  if (installedPaths.rg) rgCandidates.push(installedPaths.rg);
  if (hasCommand('rg') && !rgCandidates.includes('rg')) rgCandidates.push('rg');
  for (const rgPath of rgCandidates) {
    list.push({
      name: 'ripgrep',
      command: rgPath,
      args: [
        '-n', '--no-heading', '--color', 'never', '--with-filename', '--hidden', '--no-ignore', '--null',
        // 注意用 `**/.git/**` 而不是 `.git/**`：搜索根是绝对路径，rg 的 glob 会对整条路径匹配，
        // 少了前导 `**/` 就排除不掉（实测 2026-10-27）。
        '--glob', '!**/.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/.svn/**',
        ...(fixed ? ['-F'] : []),
        ...(ignoreCase ? ['-i'] : []),
        '-e', pattern, '--', root,
      ],
    });
  }
  // ugrep / GNU grep 都给两个候选：先带 `--null`（F-29 稳健解析），不认这个选项时退回旧格式
  // （解析器两种都能读；老 ugrep/busybox grep 因此不会把整个搜索搞挂）。
  for (const [name, command] of [['ugrep', 'ugrep'], ['gnu grep', 'grep']]) {
    if (command !== 'grep' && !hasCommand(command)) continue;
    list.push({
      name,
      command,
      args: ['-r', '-n', '-I', '-H', '--null', ...common, '-e', pattern, '--', root],
    });
    list.push({
      name,
      command,
      args: ['-r', '-n', '-I', '-H', ...common, '-e', pattern, '--', root],
    });
  }
  return list;
}

/**
 * 解析 grep 输出：`--null` 格式是 `path\0line:text`（路径里带 ':' 也不会错位，F-29）。
 * 如果后端不认 `--null`（老 ugrep 等），回退到"前两个 ':' 切分"的旧格式（路径含 ':' 属已知限制）。
 */
export function parseGrepOutput(stdout, { truncated = false, limit = GREP_MAX_MATCHES } = {}) {
  let text = String(stdout ?? '');
  if (truncated) {
    // 字节上限截断时最后一"行"可能只有半截：整行丢掉，绝不把半行当匹配（F-29）。
    const cut = text.lastIndexOf('\n');
    text = cut >= 0 ? text.slice(0, cut + 1) : '';
  }
  const matches = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const parsed = parseGrepLine(raw);
    if (!parsed) continue;
    matches.push(parsed);
    if (matches.length >= limit) return { matches, truncated: true };
  }
  return { matches, truncated: truncated === true };
}

function parseGrepLine(raw) {
  const nul = raw.indexOf('\0');
  if (nul > 0) {
    const file = raw.slice(0, nul);
    const rest = raw.slice(nul + 1);
    const colon = rest.indexOf(':');
    if (colon <= 0) return null;
    const lineNo = Number(rest.slice(0, colon));
    if (!Number.isInteger(lineNo) || lineNo <= 0) return null;
    return { path: file, line: lineNo, text: rest.slice(colon + 1) };
  }
  const m = /^(.*?):(\d+):(.*)$/.exec(raw);
  if (!m) return null;
  const lineNo = Number(m[2]);
  if (!Number.isFinite(lineNo) || lineNo <= 0) return null;
  return { path: m[1], line: lineNo, text: m[3] };
}

/**
 * 在发行版内 grep（自动挑后端：ripgrep → ugrep → GNU grep）。
 * 返回的 `warnings` 汇总两类信息：模式归一化时发现的不一致风险 + 后端 stderr（F-13）。
 * @param args `{pattern, path, ignoreCase?, fixedString?, maxMatches?, signal?}`
 * @returns `{matches:[{path,line,text}], truncated, total, tool:'grep', backend, warnings}`
 */
export async function grepOp(args) {
  const root = String(args?.path ?? '/');
  assertLinuxAbsolute(root);
  const rawPattern = String(args?.pattern ?? '');
  if (rawPattern.length === 0) throw searchError('grep requires a non-empty pattern', 'E_ARG');
  const fixed = args?.fixedString === true;
  const norm = fixed
    ? { pattern: rawPattern, ignoreCase: args?.ignoreCase === true, warnings: [] }
    : normalizeGrepPattern(rawPattern, { ignoreCase: args?.ignoreCase === true });
  // 只写了 `(?i)` 之类、归一后变空：直接报错，绝不能让空模式变成"匹配所有行"。
  if (norm.pattern.length === 0) throw searchError('grep pattern is empty after removing inline flags; add the actual expression', 'E_ARG');
  const warnings = [...norm.warnings];
  const effective = { ...(args ?? {}), pattern: norm.pattern, ignoreCase: norm.ignoreCase === true };
  let lastMissing = null;
  for (const backend of grepBackends(effective, root, norm.pattern)) {
    let r;
    try {
      r = await run(backend.command, backend.args, {
        timeoutMs: 60000,
        maxBytes: GREP_MAX_BYTES,
        okCodes: [0, 1],
        signal: args?.signal ?? null,
      });
    } catch (e) {
      if (isMissingBinary(e)) {
        lastMissing = e;
        continue;
      }
      if (isUnsupportedFlag(e)) continue; // 不认 --null：下一候选是去掉 --null 的同一后端
      throw e;
    }
    if (r.error) throw searchError(`${backend.command} ${r.error}`, 'E_CANCELLED');
    const stderrText = String(r.stderr ?? '').trim();
    if (stderrText) warnings.push(`${backend.name}: ${stderrText.slice(0, 300)}`);
    const limit = Math.max(1, Math.min(Number(args?.maxMatches) || GREP_MAX_MATCHES, GREP_MAX_MATCHES));
    const parsed = parseGrepOutput(r.stdout, { truncated: r.truncated, limit });
    return {
      matches: parsed.matches,
      truncated: parsed.truncated,
      total: parsed.matches.length,
      tool: 'grep',
      backend: backend.name,
      warnings,
      // 归一化改写过模式时回传最终模式，方便调用方/模型理解行为差异（F-13）。
      normalized: norm.pattern === rawPattern ? null : norm.pattern,
    };
  }
  throw searchError(`no usable grep backend in the distribution（最后错误：${lastMissing?.message ?? 'unknown'}）`, 'E_UNAVAILABLE');
}

/* ------------------------------------------------------------------ *
 * glob
 * ------------------------------------------------------------------ */

/**
 * 读一个 glob 字符类 `[...]`（含取反 `[!...]`/`[^...]`）。
 * 返回 `{src, next}`；`src` 是可直接塞进 RegExp 的字符类；不是合法字符类（没闭合/空）时返回 null，
 * 调用方按字面量 `[` 处理（不会抛错，也不会吞掉后面的模式）。
 */
function readGlobCharClass(glob, start) {
  let i = start + 1;
  if (i >= glob.length) return null;
  let negated = false;
  if (glob[i] === '!' || glob[i] === '^') {
    negated = true;
    i += 1;
    if (i >= glob.length) return null;
  }
  const raw = [];
  let first = true;
  for (; i < glob.length; i++) {
    const c = glob[i];
    if (c === ']' && !first) break;
    first = false;
    raw.push(c);
  }
  if (i >= glob.length) return null; // 没闭合 ⇒ 当作字面量 '['
  if (raw.length === 0) return null;
  let body = '';
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (c === '\\') body += '\\\\';
    else if (c === ']') body += '\\]';
    else if (c === '^') body += '\\^';
    else if (c === '[') body += '\\[';
    else if (c === '-' && (k === 0 || k === raw.length - 1)) body += '\\-';
    else body += c;
  }
  return { src: `[${negated ? '^' : ''}${body}]`, next: i + 1 };
}

/**
 * glob → 正则（F-24 / F-26）。
 *   · `*` 不跨 `/`；`?` = 一个非 `/` 字符；`[...]` 是**字符类**（旧实现把 `[]` 也转义了，
 *     `[abc].ts` 变成字面量，永远匹配不到）；
 *   · `**` 作为**完整路径段**时跨目录：`a` 与 `b` 之间放 `**` 时 → 可选的任意层目录，
 *     既匹配 `a/b` 也匹配 `a/x/y/b`，但**不**匹配 `a/xb`（旧实现把 `**` 直接翻成 `.*`，吞掉分隔符语义）；
 *     非完整段（`a**b`）仍按"任意字符"处理；
 *   · 其余正则元字符转义。
 * @returns {RegExp} 锚定的正则
 */
export function globToRegExp(glob) {
  const g = String(glob ?? '');
  let out = '';
  let i = 0;
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const atSegStart = i === 0 || g[i - 1] === '/';
        let j = i + 2;
        const atSegEnd = j >= g.length || g[j] === '/';
        if (atSegStart && atSegEnd) {
          if (j < g.length) {
            // '**/'：零层或多层目录。前面的 '/' 已经在 out 里，后面的 '/' 被吞掉。
            out += '(?:.*/)?';
            i = j + 1;
          } else {
            // 结尾的 '**'：'a/**' → 'a/.*'；单独的 '**' → '.*'
            out += '.*';
            i = j;
          }
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const cls = readGlobCharClass(g, i);
      if (cls) {
        out += cls.src;
        i = cls.next;
        continue;
      }
      out += '\\[';
      i += 1;
      continue;
    }
    if ('\\^$.|+()}]'.includes(ch)) out += `\\${ch}`;
    else out += ch;
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/**
 * 在发行版内 glob（自动挑枚举后端：fd/fdfind → find）。
 * F-23：fd 也加 `--no-ignore`，与 find 的"不信 .gitignore"语义对齐（否则装没装 fd 结果集不同）。
 * @param args `{pattern, path, maxResults?}`
 * @returns `{files:string[], truncated, scanned, tool:'glob', backend, warnings}`
 */
export async function globOp(args) {
  const root = String(args?.path ?? '/');
  assertLinuxAbsolute(root);
  const pattern = String(args?.pattern ?? '').trim();
  if (pattern.length === 0) throw searchError('glob requires a non-empty pattern', 'E_ARG');
  // 枚举后端：fd 并行；没有就退回 find。自动装的绝对路径优先，失效时再退回 PATH 上的 fd/fdfind。
  const enumerators = [];
  const fdCandidates = [];
  if (installedPaths.fd) fdCandidates.push(installedPaths.fd);
  for (const fdBin of ['fd', 'fdfind']) {
    if (hasCommand(fdBin) && !fdCandidates.includes(fdBin)) fdCandidates.push(fdBin);
  }
  for (const fdBin of fdCandidates) {
    enumerators.push({
      name: 'fd',
      command: fdBin,
      args: ['--type', 'f', '--hidden', '--no-ignore', '--exclude', '.git', '--exclude', 'node_modules', '.', root],
    });
  }
  enumerators.push({
    name: 'find',
    command: 'find',
    args: [root, '-path', '*/node_modules', '-prune', '-o', '-path', '*/.git', '-prune', '-o', '-type', 'f', '-print'],
  });
  let stdout = '';
  let truncated = false;
  let backend = null;
  const warnings = [];
  let lastMissing = null;
  for (const candidate of enumerators) {
    try {
      const r = await run(candidate.command, candidate.args, {
        timeoutMs: 60000,
        maxBytes: 8 * 1024 * 1024,
        okCodes: [0, 1],
        signal: args?.signal ?? null,
      });
      stdout = r.stdout;
      truncated = r.truncated;
      backend = candidate.name;
      if (r.error) throw searchError(`${candidate.command} ${r.error}`, 'E_CANCELLED');
      const stderrText = String(r.stderr ?? '').trim();
      if (stderrText) warnings.push(`${candidate.name}: ${stderrText.slice(0, 300)}`);
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
  let listing = stdout;
  if (truncated) {
    // 截断时最后一行可能是半截路径（F-29 同类问题）：丢掉。
    const cut = listing.lastIndexOf('\n');
    listing = cut >= 0 ? listing.slice(0, cut + 1) : '';
  }
  const re = globToRegExp(pattern);
  const limit = Math.max(1, Math.min(Number(args?.maxResults) || GLOB_MAX_RESULTS, GLOB_MAX_RESULTS));
  const files = [];
  let scanned = 0;
  for (const abs of listing.split('\n')) {
    if (abs.length === 0) continue;
    if (++scanned > GLOB_MAX_SCAN) {
      return { files, truncated: true, scanned, tool: 'glob', backend, warnings };
    }
    const rel = path.posix.relative(root, abs);
    const subject = pattern.includes('/') ? rel : path.posix.basename(rel);
    if (!re.test(subject)) continue;
    files.push(abs);
    if (files.length >= limit) return { files, truncated: true, scanned, tool: 'glob', backend, warnings };
  }
  files.sort();
  return { files, truncated: truncated || false, scanned, tool: 'glob', backend, warnings };
}

/** 统一入口：`{op:'search', method, args}`。 */
export async function handleSearchOp(req) {
  const method = String(req?.method ?? '');
  if (method === 'grep') return grepOp(req?.args ?? {});
  if (method === 'glob') return globOp(req?.args ?? {});
  throw searchError(`unknown search method: ${method}`);
}
