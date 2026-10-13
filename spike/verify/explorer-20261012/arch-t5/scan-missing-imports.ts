/**
 * scan-missing-imports.ts（v2，带小型词法分析） —— 穷举同型风险：
 * **"被调用但既未声明也未 import 的标识符"**。
 *
 * 为什么需要 v2：v1 用正则去注释/字符串，噪声巨大（把注释与文档里的英文短语当标识符，如 `path(`/`dir(`），
 * 反而漏了真问题。v2 用一个**状态机**把"代码"与"注释/字符串/模板字面量文本"分开：
 *   · `//` 与 `/* *\/` → 整体抹掉；
 *   · `'…'` / `"…"` → 抹掉；
 *   · `` `…` `` → **文本抹掉，但 `${ … }` 里的表达式按代码保留**（P0 缺陷 `allowBuildFlags()` 正是在 `${}` 里！）
 *
 * 判据（保守）：候选 = 代码区里形如 `name(` 的调用；声明面 = 文件内 `function/class/const/let/var/import`、
 * **函数形参**、`catch (e)`、解构名；白名单 = JS/宿主内建。候选 ∉ 声明面 ∪ 白名单 ⇒ 命中（真调必炸）。
 *
 * 用法：node scan-missing-imports.ts <file.ts> … [--out <txt>]
 * 退出码：0 = 0 命中；1 = 有命中。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : '';
const files = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));

/** 把注释/字符串/模板文本抹成空格，只留代码（`${}` 表达式保留）。递归下降，正确处理模板嵌套。 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  function code(untilBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '}' && untilBrace && depth === 0) { i++; return; }
      if (c === '{') { depth++; out += c; i++; continue; }
      if (c === '}') { depth--; out += c; i++; continue; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
      if (c === '/' && n === '*') { i += 2; out += '  '; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } i += 2; out += '  '; continue; }
      if (c === "'" || c === '"') { const q = c; out += ' '; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += ' '; i++; } out += ' '; i++; } i++; out += ' '; continue; }
      if (c === '`') { out += ' '; i++; tpl(); continue; }
      out += c; i++;
    }
  }
  function tpl() {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '`') { out += ' '; i++; return; }
      if (c === '$' && src[i + 1] === '{') { out += '  '; i += 2; code(true); out += ' '; continue; }
      out += c === '\n' ? '\n' : ' '; i++;
    }
  }
  code(false);
  return out;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'async', 'of', 'in', 'do', 'else', 'case', 'super', 'this', 'void', 'delete', 'yield', 'throw', 'instanceof', 'class', 'extends', 'try', 'finally', 'break', 'continue', 'default', 'export', 'import', 'const', 'let', 'var', 'static', 'get', 'set']);
const GLOBALS = new Set(['process', 'console', 'Buffer', 'globalThis', 'require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'Promise', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Reflect', 'Proxy', 'Intl', 'Function', 'decodeURI', 'encodeURI']);

let total = 0;
const report = [];
for (const f of files) {
  const code = codeOnly(readFileSync(f, 'utf8'));
  const declared = new Set();
  const add = (s) => String(s).split(/[,\s]+/).forEach((x) => { const t = x.replace(/[^A-Za-z0-9_$]/g, ''); if (t && /^[A-Za-z_$]/.test(t)) declared.add(t); });
  for (const m of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^;=\n]+)/g)) add(m[1]);
  // 跨行解构声明（`const {\n  a, b,\n} = deps;` —— T5 的 registerTools 就是这种写法）
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)) add(m[1]);
  // 类方法/对象方法**定义**（`async stop() {`）：不是"被调用"。**必须要求 `) {` 在同一行** ——
  // 否则模板表达式 `${allowBuildFlags()}` 被抹白后正好落在行首，会被误判成"方法定义"（造成假阴性）。
  for (const m of code.matchAll(/(?:^|\n)[ \t]*(?:async\s+)?(?:get\s+|set\s+|static\s+)?([A-Za-z_$][\w$]*)[ \t]*\([^)\n]*\)[ \t]*\{/g)) add(m[1]);
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) add(m[1].replace(/\bas\b/g, ' '));
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) add(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  const called = new Map();
  for (const m of code.matchAll(/(^|[^\w$.[\]])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
    called.set(name, (called.get(name) ?? 0) + 1);
  }
  const list = [...called.entries()].sort((a, b) => b[1] - a[1]);
  total += list.length;
  const line = list.length === 0 ? `  ${f}: 0 命中` : `  ${f}: ${list.length} 命中 ⇒ ${list.map(([n, c]) => `${n}×${c}`).join(', ')}`;
  console.log(line);
  report.push(line);
}
if (outPath) writeFileSync(outPath, report.join('\n') + '\n', 'utf8');
console.log(`\n命中合计 = ${total}（0 = 无同型风险）`);
process.exit(total === 0 ? 0 : 1);
