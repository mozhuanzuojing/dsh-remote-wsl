/* panel-map.mjs —— 为"拆 chunk"做**结构图 + 括号净差**分析（只读，不写任何东西）。
 *
 * 为什么要先做这个：前 owner 两轮失败都死在**切片边界**（带进未闭合的 `{`、漏掉一行导致 `{}` 净差 −1）。
 *   ⇒ 选边界前必须能算出"任意 [起,止] 区间的 {} () [] 净差是否为 0"。
 *
 * 用法：
 *   node panel-map.mjs map            # 结构图（锚点行号 + 每个区间的括号净差）
 *   node panel-map.mjs balance <a> <b># 只看 [a,b] 区间的净差（1-based，含端点）
 *   node panel-map.mjs balance-all    # 每个"顶层块"区间的净差
 */
import fs from 'node:fs';

const FILE = process.argv[2] === 'balance' || process.argv[2] === 'balance-all'
  ? 'D:/project/dsh1/vendor/dsh-remote-wsl/client/client.panel.js'
  : (process.env.PANEL || 'D:/project/dsh1/vendor/dsh-remote-wsl/client/client.panel.js');
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');

/** 逐字符扫描，求每行的 {} () [] 净差；跳过注释/字符串/模板（模板里 ${} 仍计入表达式部分） */
const scan = () => {
  const perLine = [];
  let depth = { '{': 0, '(': 0, '[': 0 };
  let i = 0, line = 0;
  let inBlockComment = false, inLineComment = false, inSingle = false, inDouble = false, inTemplate = false;
  let tmplExprDepth = 0;
  const push = () => perLine.push({ open: { ...depth }, net: 0 });
  let curNet = 0;
  const bump = (ch) => {
    if (ch === '{' || ch === '(' || ch === '[') { depth[ch]++; if (tmplExprDepth > 0 || !inTemplate) curNet++; }
    else if (ch === '}' || ch === ')' || ch === ']') { const o = { '}': '{', ')': '(', ']': '[' }[ch]; depth[o]--; if (tmplExprDepth > 0 || !inTemplate) curNet--; }
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') { perLine.push({ net: curNet }); curNet = 0; line++; i++; continue; }
    if (inLineComment) { i++; continue; }
    if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i += 2; continue; } i++; continue; }
    if (inSingle) { if (c === '\\') { i += 2; continue; } if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) { if (c === '\\') { i += 2; continue; } if (c === '"') inDouble = false; i++; continue; }
    if (inTemplate) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`' && tmplExprDepth === 0) { inTemplate = false; i++; continue; }
      if (c === '$' && n === '{') { tmplExprDepth++; bump('{'); i += 2; continue; }
      if (c === '}' && tmplExprDepth > 0) { tmplExprDepth--; bump('}'); i++; continue; }
      i++; continue;
    }
    if (c === '/' && n === '/') { inLineComment = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlockComment = true; i += 2; continue; }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === '`') { inTemplate = true; i++; continue; }
    bump(c);
    i++;
  }
  perLine.push({ net: curNet });
  return perLine;
};

const perLine = scan();
const totalNet = perLine.reduce((a, p) => a + p.net, 0);
const prefix = [0];
for (const p of perLine) prefix.push(prefix[prefix.length - 1] + p.net);
/** [a,b] 1-based 闭区间的净差 */
const rangeNet = (a, b) => prefix[b] - prefix[a - 1];

const cmd = process.argv[2] || 'map';
if (cmd === 'balance') {
  const a = Number(process.argv[3]), b = Number(process.argv[4]);
  console.log(JSON.stringify({ a, b, net: rangeNet(a, b), lines: b - a + 1 }, null, 1));
} else if (cmd === 'balance-all') {
  console.log('全文件净差 =', totalNet, '（0 表示扫描器可信）');
} else {
  console.log(`# ${FILE}`);
  console.log(`# 行数=${lines.length}  全文件括号净差=${totalNet}（应为 0）`);
  const pats = [
    ['factory/loader', '^\\s*(window\\.__ModuleLoader__\\.load|factory:|var module|var exports|Object\\.defineProperty|\\s*const React =)'],
    ['函数/工厂', '^\\s*(function \\w+|const \\w+ = \\(|const \\w+ = function|const \\w+ = React\\.use|return function \\w+)'],
    ['hooks', 'React\\.use(State|Ref|Effect|Callback|Memo|Reducer)'],
    ['body 相关', '(const body = |body\\.push|browserSlot)'],
    ['渲染', 'return React\\.createElement|React\\.createElement\\('],
    ['注释横幅', '^\\s*//\\s*(====|----|——|──)'],
    ['导出/收尾', '^\\s*(exports\\.|return module\\.exports|\\}\\)|\\}\\);)']
  ];
  for (const [name, re] of pats) {
    const rx = new RegExp(re);
    const hits = [];
    lines.forEach((l, i) => { if (rx.test(l)) hits.push(`${i + 1}:${l.trim().slice(0, 92)}`); });
    console.log(`\n## ${name}（${hits.length}）`);
    hits.slice(0, 60).forEach((h) => console.log('  ' + h));
  }
  // 顶层行（缩进 0/1 且非空、非注释）
  console.log('\n## 缩进 ≤1 的非空行（骨架）');
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('*') || t.startsWith('/*')) return;
    const ind = l.length - l.replace(/^\s*/, '').length;
    if (ind <= 1) console.log(`  ${String(i + 1).padStart(5)}| net=${String(perLine[i].net).padStart(2)} | ${t.slice(0, 100)}`);
  });
}
