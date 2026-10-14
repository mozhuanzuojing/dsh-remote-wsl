/**
 * scan-missing-imports.ts —— **"被调用但既未声明也未 import 的标识符"** 静态扫描（提交前清单第 08 项的判据）。
 *
 * 为什么需要它：本仓是"零构建 TS + 相对 `.ts`"，**漏 import 不在 import 期报错**，只有执行到那一行才
 * `ReferenceError` ⇒ "调用期才炸"。同型已出现**三次**：
 *   · T3 `launchScript`→`daemonScriptWsl`；
 *   · T5 `wsl-io.ts` 漏 `spawn`（真调 `wsl_status` 才炸）；
 *   · T47 `register-tools.ts` 漏 `allowBuildFlags`（`wsl_open_ui` 启动）+ 漏 `reapWsl`（**收尾**才炸）。
 *
 * 判据（保守、可复核）：
 *   ① 候选 = **代码区**里形如 `name(` 的调用（排除 `obj.name(` 属性访问、排除关键字/控制流）；
 *   ② 声明面 = 文件内 `function/class/const|let|var`（含**跨行解构**）、`import {…}`/`import X`、
 *      **函数形参**、箭头函数单参、`catch (e)`、**类/对象方法定义**（`async stop() {`，必须同行 `) {`）；
 *   ③ 白名单 = JS/宿主内建（`process`/`console`/`Math`/`JSON`/`Promise`/`setTimeout`…）。
 *   候选 ∉ 声明面 ∪ 白名单 ⇒ **命中**（真调时必炸），并给出**行号**。
 *
 * 词法分析：用状态机/递归下降把注释、字符串、模板**文本**抹成空格，但**保留 `${ … }` 里的表达式** ——
 *   这一点是关键：T47 的 P0 正藏在模板里的 `${allowBuildFlags()}`。抹白是**等长**的（偏移不变）⇒ 可靠地反查行号。
 *
 * 用法：node scan-missing-imports.ts <file.ts> [<file.ts> …] [--out <txt>]
 * 退出码：0 = 无命中；1 = 有命中（列出 `标识符@行号`）；2 = **无法判定**（没给文件 / 读不了 / 文件不是 .ts）。
 *   ⚠️ 调用方（precommit-check.ps1 第 08 项）必须把 2 记成 **WARN**，绝不记 PASS。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : '';
const files = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));

if (files.length === 0) { console.log('SCAN_UNDECIDABLE: 没有给任何 .ts 文件'); process.exit(2); }

/** 把注释/字符串/模板文本抹成空格（等长），只留代码；`${}` 表达式保留为代码。 */
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
      // 正则字面量（2026-10-14 lead 补）：**没有这一支时，正则里的引号/反引号会把词法器拖进字符串/模板态**，
      //   之后整段被抹白 ⇒ "同文件里明明有声明"却被判成"被调用但未声明"。实测两个假红都由它引起：
      //   `daemon-protocol.ts` L21（`${…replace(/^\//, '').replace(/\//g, '\\')}`）与
      //   `shell-env.ts` L162（`.replace(/^\\([^\n]*?)\\([^\n]*?)\$/…)` 之后 L168 的 `function stripUnquotedComment` 被抹掉。
      if (c === '/' && isRegexStart(out)) {
        out += c; i++;
        let inClass = false;
        while (i < src.length) {
          const d = src[i];
          if (d === '\\') { out += '  '; i += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { out += d; i++; break; }
          else if (d === '\n') { break; } // 未闭合（其实不是正则）⇒ 当普通除号，绝不无限吞
          out += d === '\n' ? '\n' : ' '; i++;
        }
        continue;
      }
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

/** `/` 是正则起始还是除号（标准启发式）：看已输出代码里最后一个非空白字符。 */
function isRegexStart(outSoFar) {
  const s = outSoFar.replace(/[ \t\r\n]+$/, '');
  if (s === '') return true;
  const last = s[s.length - 1];
  if ('([{,;:=!&|?+-*%~^<>'.includes(last)) return true;
  const m = /([A-Za-z_$][\w$]*)$/.exec(s);
  if (m && ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw'].includes(m[1])) return true;
  return false;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'async', 'of', 'in', 'do', 'else', 'case', 'super', 'this', 'void', 'delete', 'yield', 'throw', 'instanceof', 'class', 'extends', 'try', 'finally', 'break', 'continue', 'default', 'export', 'import', 'const', 'let', 'var', 'static', 'get', 'set', 'constructor']);
const GLOBALS = new Set(['process', 'console', 'Buffer', 'globalThis', 'require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone', 'fetch', 'URL', 'URLSearchParams', 'Promise', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Reflect', 'Proxy', 'Intl', 'Function', 'decodeURI', 'encodeURI']);

let total = 0;
let undecidable = 0;
const report = [];
for (const f of files) {
  if (!/\.ts$/.test(f)) { console.log(`SCAN_UNDECIDABLE: 不是 .ts 文件：${f}`); undecidable++; continue; }
  let src;
  try { src = readFileSync(f, 'utf8'); } catch (e) { console.log(`SCAN_UNDECIDABLE: 读不了 ${f}: ${e?.message ?? e}`); undecidable++; continue; }
  const code = codeOnly(src);
  const lineAt = (idx) => 1 + (code.slice(0, idx).match(/\n/g)?.length ?? 0);

  const declared = new Set();
  const add = (s) => String(s).split(/[,\s]+/).forEach((x) => { const t = x.replace(/[^A-Za-z0-9_$]/g, ''); if (t && /^[A-Za-z_$]/.test(t)) declared.add(t); });
  for (const m of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([^;=\n]+)/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([\s\S]*?)\}\s*=/g)) add(m[1]); // 跨行解构
  for (const m of code.matchAll(/(?:^|\n)[ \t]*(?:async\s+)?(?:get\s+|set\s+|static\s+)?([A-Za-z_$][\w$]*)[ \t]*\([^)\n]*\)[ \t]*\{/g)) add(m[1]); // 方法定义（必须同行 `) {`）
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) add(m[1].replace(/\bas\b/g, ' '));
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)) add(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // ↓ 追加形态（2026-10-14 lead 修正）：全量 `src/**` 上先出现 4 个**假红**，逐条读源码定因后补入。
  //   ① 带默认值的形参：`launchDaemon(cfg, port, version, log = () => {})` —— 旧形参规则用 `[^()]*`，
  //      遇到默认值里的 `()` 就整段失配 ⇒ `log` 被判成"被调用但未声明"。
  for (const m of code.matchAll(/[,(]\s*([A-Za-z_$][\w$]*)\s*=\s*[^,)=]/g)) add(m[1]);
  //   ② 显式赋值声明：`export const stateDirLinux = (cfg) => …`（旧规则的 `[^;=\n]+` 在某些行上未命中）。
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) add(m[1]);
  //   ③ 私有方法：`#defaultScript() {`（旧方法规则要求首字符是 `[A-Za-z_$]`，`#` 不匹配）。
  for (const m of code.matchAll(/#([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1]);
  //   ④ 多行构造器：`constructor({ … }) {`（旧方法规则要求 `) {` 同行出现）⇒ 见 KEYWORDS 增补 `constructor`。

  const called = new Map(); // name -> { count, firstLine }
  for (const m of code.matchAll(/(^|[^\w$.[\]])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
    const line = lineAt(m.index + m[1].length);
    const cur = called.get(name);
    if (cur) cur.count++;
    else called.set(name, { count: 1, firstLine: line });
  }
  const list = [...called.entries()].sort((a, b) => a[1].firstLine - b[1].firstLine);
  total += list.length;
  const line = list.length === 0
    ? `  ${f}: 0 命中`
    : `  ${f}: ${list.length} 命中 ⇒ ${list.map(([n, v]) => `${n}@${v.firstLine}(×${v.count})`).join(', ')}`;
  console.log(line);
  report.push(line);
}
if (outPath) writeFileSync(outPath, report.join('\n') + '\n', 'utf8');
console.log(`\n命中合计 = ${total}（0 = 无同型风险）`);
if (undecidable > 0) { console.log(`SCAN_UNDECIDABLE: ${undecidable} 个文件无法判定`); process.exit(2); }
process.exit(total === 0 ? 0 : 1);
