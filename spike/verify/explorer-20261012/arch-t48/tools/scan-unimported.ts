/**
 * scan-unimported.ts —— **"被调用但未声明/未 import 的标识符"**扫描器（T48 A② 的独立复现工具）。
 *
 * 为什么要它：本仓是"零构建 TS + 相对 `.ts`"，**漏 import 不在语法期报错**，只在真调到那一行时
 * `ReferenceError`。这类缺陷在同型上已经出现三次（T3 `spawn`、T5 `wsl-io.ts` `spawn`、T47
 * `register-tools.ts` `allowBuildFlags`）⇒ 必须有一支**能红的量具**，而不是靠人眼。
 *
 * 与 T47 那支的差异（刻意独立）：本工具**只**把"**调用位置**的标识符"（`name(` / `new name(`）当作
 * 命中，且把**文件内一切绑定**（import / 形参 / 解构 / catch / 循环变量 / 对象方法简写 / 局部
 * const|let|var|function|class）都算作"已声明" —— 所以：
 *   · 误报低（类型名从不出现在调用位；方法简写被登记为绑定）；
 *   · 漏报也低（只要整个文件里从没出现过这个绑定，就会被抓）。
 *
 * 用法：node --experimental-strip-types scan-unimported.ts [--root <repoRoot>] [--out <json>] [--verbose]
 * 退出码：0 = 无 HIGH 命中；1 = 有 HIGH 命中（列出文件:行:标识符）
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const OUT = arg('out', '');
const VERBOSE = process.argv.includes('--verbose');

/** 已知全局 / 关键字 / TS 类型名（出现在调用位也不算"未声明"）。 */
const GLOBALS = new Set(`process Buffer console Math JSON Number String Boolean Array Object Promise Set Map WeakMap WeakSet Date RegExp Error TypeError RangeError SyntaxError ReferenceError Symbol BigInt Proxy Reflect Intl globalThis
setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone fetch atob btoa
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent eval Function
AbortController AbortSignal URL URLSearchParams TextEncoder TextDecoder FormData Headers Request Response Blob File Event EventTarget CustomEvent
require module exports __filename __dirname arguments $ _
Record Partial Readonly Required Omit Pick Exclude Extract NonNullable ReturnType Parameters Awaited Iterable Iterator AsyncIterable ArrayLike PromiseLike
if else for while do return function async await try catch finally throw new typeof instanceof in of delete void yield class extends super this null undefined true false
let const var import export from default switch case break continue static get set as
string number boolean any void unknown never object symbol bigint`.split(/\s+/).filter(Boolean));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 把源码里的**注释与字面量内容**挖空，但：
 *   · **保留换行**（否则行号错位 —— v1 的坑）；
 *   · **保留引号/反引号定界符**（否则 `from './x.ts'` 解析不出来 —— v2 的坑，175 条误报）；
 *   · **保留模板 `${…}` 插值里的代码**（否则会**漏报**目标缺陷 —— v3 的坑：
 *     `allowBuildFlags()` 恰恰写在 `` `… ${allowBuildFlags()} …` `` 里，被整段挖空后扫不到）。
 * ⇒ 必须用状态机（也顺便支持**嵌套模板**，正则做不到）。
 */
function stripLiterals(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;
  /** 上一个"真正的代码字符"（空格/挖空不算）——用来判断 `/` 是除号还是正则字面量开始。 */
  let lastSig = '';
  const push = (s: string) => { out.push(s); if (s !== ' ' && s !== '\n' && s !== '') lastSig = s[s.length - 1]; };
  const blankPush = (c: string) => { out.push(c === '\n' ? '\n' : ' '); };
  while (i < n) {
    const ch = code[i];
    // 行注释
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    // 块注释
    if (ch === '/' && code[i + 1] === '*') {
      i += 2; out.push('  ');
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { blankPush(code[i]); i++; }
      if (i < n) { out.push('  '); i += 2; }
      continue;
    }
    // 正则字面量：`/` 前面是"需要值"的位置（( , = : [ ! & | ? { } ; 等）⇒ 当正则处理。
    // ⚠️ v4 的坑：不识别正则时，`/["\\]/g` 里的引号会被当成字符串起始 ⇒ **后续整段被挖空**，
    //    于是 `shell-env.ts:168` 那个真实存在的本地函数被判成"未声明"（假命中）。
    if (ch === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(lastSig)) {
      out.push('/'); i++;
      let inClass = false;
      while (i < n) {
        const c = code[i];
        if (c === '\\') { out.push('  '); i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { out.push('/'); i++; break; }
        else if (c === '\n') break;                                  // 正则不跨行：异常输入就地收手
        blankPush(c); i++;
      }
      while (i < n && /[a-z]/i.test(code[i])) { out.push(' '); i++; } // flags
      lastSig = '/';
      continue;
    }
    // 字面量
    if (ch === '`' || ch === "'" || ch === '"') {
      const quote = ch;
      out.push(quote); i++;
      while (i < n) {
        const c = code[i];
        if (c === '\\') { out.push('  '); i += 2; continue; }
        if (c === quote) { out.push(quote); i++; break; }
        if (quote === '`' && c === '$' && code[i + 1] === '{') {       // 插值：内容按代码处理（可嵌套）
          let depth = 1; const start = i + 2; i = start; out.push('${');
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) break; }
            i++;
          }
          const inner = code.slice(start, i);
          out.push(stripLiterals(inner));
          if (i < n) { out.push('}'); i++; }
          lastSig = '}';
          continue;
        }
        blankPush(c); i++;
      }
      continue;
    }
    push(ch); i++;
  }
  return out.join('');
}
const strip = stripLiterals;

/** 收集该文件里**全部绑定名**（超集；宁可多算，不误报）。 */
function bindings(code: string): Set<string> {
  const b = new Set<string>();
  // import 子句：`import a, { b as c, d } from '…'` / `import * as ns from '…'`
  for (const m of code.matchAll(/import\s+([^;'"]+?)\s+from\s+['"]/g)) {
    const clause = m[1];
    for (const part of clause.split(/[{},]/)) {
      const t = part.trim();
      if (!t) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
      if (as) { b.add(as[1]); continue; }
      if (/^[A-Za-z_$][\w$]*$/.test(t)) b.add(t);
    }
  }
  // 声明关键字
  for (const m of code.matchAll(/\b(?:function|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g)) b.add(m[1]);
  // 形参（含解构/默认值/类型注解）：function f(...) / (...) => / 方法简写 name(...)
  for (const m of code.matchAll(/(?:function\s*[A-Za-z_$]*|(?:get|set|async|static|\*)?\s*[A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*(?::\s*[^={;]+)?\s*[{=]/g)) addParams(m[1], b);
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?::\s*[^=;{]+)?\s*=>/g)) addParams(m[1], b);
  for (const m of code.matchAll(/(?:^|[\s,;[(])([A-Za-z_$][\w$]*)\s*=>/g)) b.add(m[1]);
  // 对象方法简写 / 类方法 / getter·setter / 私有方法（防"方法名被当成调用"的误报）
  // ⚠️ 前导 `{` 要排除 `${`（模板插值）：`${allowBuildFlags()}` 会被误当成"方法简写声明"，
  //    从而把**真缺陷**登记成"已绑定" ⇒ 红测漏报（v4 的坑）。
  for (const m of code.matchAll(/(?:^|[,\n;]|(?<!\$)\{)\s*(?:(?:async|static|get|set)\s+|\*\s*)*(#?[A-Za-z_$][\w$]*)\s*\(/g)) b.add(m[1].replace(/^#/, ''));
  // catch / for-of / 解构赋值
  for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) b.add(m[1]);
  for (const m of code.matchAll(/for\s*\(\s*(?:const|let|var)\s*([A-Za-z_$][\w$]*)/g)) b.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/g)) addParams(m[1], b);
  return b;
}
function addParams(text: string, out: Set<string>): void {
  // 先处理**解构改名**：`{ readFileSync: read = null }` ⇒ 绑定名是 `read`（v3 的坑：`read` 被漏掉）
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g)) out.add(m[2]);
  const noTypes = text.replace(/:\s*[A-Za-z_$][\w$.<>\[\]|,\s]*(?=[,)}=]|$)/g, '');
  for (const seg of noTypes.split(/[,{}()[\]]+/)) {
    const head = seg.split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(head)) out.add(head);
  }
}

const SRC = join(ROOT, 'src');
if (!existsSync(SRC)) { console.error(`✗ 找不到 ${SRC}`); process.exit(2); }
const files = walk(SRC).sort();
const hits: Array<{ file: string; line: number; id: string; text: string }> = [];
const stats: Array<{ file: string; bindings: number; calls: number; high: number }> = [];

for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const code = strip(raw);
  const bound = bindings(code);
  const lines = code.split('\n');
  const rawLines = raw.split('\n');
  let calls = 0, high = 0;
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/(?<![.\w$#])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const id = m[1];
      calls++;
      if (bound.has(id) || GLOBALS.has(id)) continue;
      high++;
      hits.push({ file: f.slice(ROOT.length + 1).replace(/\\/g, '/'), line: i + 1, id, text: (rawLines[i] ?? '').trim().slice(0, 140) });
    }
  }
  stats.push({ file: f.slice(SRC.length + 1).replace(/\\/g, '/'), bindings: bound.size, calls, high });
}

console.log(`扫描根：${SRC}  ｜ 文件 ${files.length} 个  ｜ 判据：调用位标识符 ∉ 文件内绑定 ∪ 已知全局`);
for (const s of stats) console.log(`  ${s.high ? 'HIGH' : 'ok  '} ${s.file.padEnd(24)} 绑定=${String(s.bindings).padStart(4)} 调用=${String(s.calls).padStart(4)} 未声明=${s.high}`);
if (hits.length) {
  console.log(`\nHIGH 命中（${hits.length}）—— 真调到这些行会 ReferenceError：`);
  for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.id}()\n      ${h.text}`);
} else {
  console.log('\nHIGH 命中：0 —— 没有"被调用但未绑定"的标识符 ✓');
}
if (VERBOSE) console.log(`\n（verbose）各文件绑定集合已收集；如需逐文件明细可扩展本工具的 --dump-bindings。`);
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), root: ROOT, files: files.length, stats, hits }, null, 2), 'utf8');
console.log(hits.length ? `\n结果：FAIL(${hits.length})` : '\n结果：PASS');
process.exit(hits.length ? 1 : 0);
