/* gen-split.mjs —— T41 拆 chunk 生成器（我接手后重写；**不改被搬动的代码体**，只做整块切片 + 显式接线）。
 *
 * 与前 owner 脚本的差别（两轮失败的原因）：
 *   1) 不用"标识符正则猜自由变量"当**判据** —— 接线用**显式、可审阅的名字清单**，正确性由
 *      `panel-smoke-node.mjs`（真装载 + 真渲染）来判；
 *   2) 边界一律取**整语句块**（含 `if (...) {` 与其配对 `}`），因此大括号天然平衡；
 *   3) 先写到 `arch-t6/staging/`，`node --check` + 冒烟全绿**才**拷进 `client/`（绝不半成品）。
 *
 * 用法：node gen-split.mjs --stage 1
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const SRC = path.join(ROOT, 'client/client.panel.js');
const STAGE = path.join(ROOT, 'spike/verify/explorer-20261012/arch-t6/staging');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');           // lines[0] = 第 1 行
const cut = (a, b) => lines.slice(a - 1, b).join('\n');   // 1-based 闭区间

const stage = Number((process.argv.find((a) => a.startsWith('--stage')) ? process.argv[process.argv.indexOf('--stage') + 1] : '1'));
if (stage !== 1) { console.error('目前只实现了 --stage 1'); process.exit(2); }

// ── 边界（1-based，含端点；均经 panel-map.mjs 实测） ──
const BOUND = {
  head: [1, 32],            // loader 头部 + `const React = require("react");` + 空行
  helpers: [33, 274],       // 常量 + 纯函数 + icon + StatusDot（到 StatusDot 的 `}`）
  createPanelDown: [276, lines.length], // createPanel 起到文件末
};

// ── 顶层声明名（用于 exports / 解构）：**只认工厂体那一层（恰好 2 个 tab）** ──
// （第一版用了 `^\t+`，把函数内部的 acc/base/cwd 等局部名也扫进来 ⇒ 生成出 `exports.acc` ⇒ ReferenceError）
const topLevelNames = (text) => {
  const names = new Set();
  for (const m of text.matchAll(/^\t\t(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of text.matchAll(/^\t\t(?:const|let)\s*\{([^}]*)\}\s*=/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return [...names].sort();
};

const helpersBody = cut(...BOUND.helpers);
const helperNames = topLevelNames(helpersBody);
console.log('helpers 顶层声明（' + helperNames.length + '）:', helperNames.join(', '));

const MOD_HEAD = (chunk, comment) => `/**
 * ${chunk} —— ${comment}
 *
 * T41 机械拆分：本文件由 \`arch-t6/tools/gen-split.mjs\` 从原 \`client/client.panel.js\` 的
 * **整块切片**生成（被搬动的代码体逐字不变），接线用显式名字清单。
 */

window.__ModuleLoader__.load({
\tid: "dsh-remote-wsl",
\tchunk: "${chunk}",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

\t\tconst React = require("react");

`;

const MOD_TAIL = `
\t\treturn module.exports;
\t},
});
`;

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'client'), { recursive: true });

// ── 1) helpers chunk ──
const helperFile =
  MOD_HEAD('client.panel.helpers.js', '常量 + 纯函数 + 文案格式化 + 内联 SVG 图标 + StatusDot（无副作用，除 localStorage 的最近目录）') +
  helpersBody +
  '\n\n' +
  helperNames.map((n) => `\t\texports.${n} = ${n};`).join('\n') +
  '\n' +
  MOD_TAIL;
fs.writeFileSync(path.join(STAGE, 'client/client.panel.helpers.js'), helperFile);

// ── 2) 薄入口 client.panel.js ──
// 三段切：createPanel 体 | 模块级 exports（要改写，见下）| 收尾（return module.exports + 闭合）
const returnIdx = lines.findIndex((l) => l.trim() === 'return module.exports;');   // 0-based
const closeIdx = lines.findIndex((l, i) => i > returnIdx && l.trim() === '});');
if (returnIdx < 0 || closeIdx < 0) throw new Error('找不到 return module.exports; / 收尾锚点');
let exportsStart = returnIdx;                     // 往前找连续的 exports.* 行
while (exportsStart > 0 && lines[exportsStart - 1].trim().startsWith('exports.')) exportsStart--;
const oldExports = lines.slice(exportsStart, returnIdx).map((l) => l.trim());
const createPanelBody = lines.slice(275, exportsStart).join('\n');   // 第 276 行 .. exports 之前
console.log('原模块级 exports（将被改写为 getter）:', oldExports.join(' '));

const anchor = '\t\t\tconst i18nSubscribe = i18n && typeof i18n.subscribe === "function" ? i18n.subscribe : null;';
if (!createPanelBody.includes(anchor)) throw new Error('找不到 i18nSubscribe 锚点');
const destructure =
  anchor +
  `

\t\t\t// T41：常量/纯函数/图标搬进了 client.panel.helpers.js（子 chunk）。**先断言就绪再解构**：
\t\t\t// 未就绪就抛（绝不静默降级成"少功能的面板"）。
\t\t\tif (parts === null) throw new Error("client.panel.js: 子 chunk 尚未就绪（client/index.js 必须先 await whenReady()）");
\t\t\t// 名字清单由生成器从切片导出面导出，逐个解构回**同名局部** ⇒ 被搬走的代码体里引用一字未改。
\t\t\tconst {
${helperNames.map((n) => `\t\t\t\t${n},`).join('\n')}
\t\t\t} = parts;`;
const bodyPatched = createPanelBody.replace(anchor, destructure);

const head = cut(...BOUND.head);
const thinEntry = `/**
 * client.panel.js —— 「远程资源管理器」中央面板入口（T41 拆分后**变薄**）。
 *
 * 拆分（T41 / 架构债 T6）：原先 1293 行单文件；本轮先把
 *   · client.panel.helpers.js  常量 / 纯函数 / 文案格式化 / 内联 SVG 图标 / StatusDot
 * 整块搬出去（**代码体逐字不变**），其余仍在本文件。
 *
 * 装载：平台只认包内 \`client.*.js\` 的 chunk（CLIENT_CHUNK 正则），故用 \`require.async("./client.panel.helpers.js")\`；
 * 子 chunk 必须在**首次渲染前**就绪（组件里直接引用那些纯函数），因此：
 *   · 本模块导出 \`whenReady()\`（返回装载 Promise）
 *   · \`client/index.js\` 在调用 \`createPanel()\` 之前 **await whenReady()**
 *   · \`createPanel()\` 开头断言 parts 已就绪（未就绪就抛，绝不静默降级）
 *
 * 行为零变化：被搬走的代码逐字切片，只在 createPanel 开头把导出面解构回同名局部。
 */

${head}

\t\t/** 子 chunk 装载（每个 chunk 是独立 ModuleLoader 模块）。 */
\t\tlet parts = null;
\t\tconst ready = require.async("./client.panel.helpers.js").then((helpers) => {
\t\t\tparts = helpers;
\t\t\treturn helpers;
\t\t});

\t\t/** 子 chunk 就绪信号：client/index.js 必须在 createPanel() 之前 await 它。 */
\t\tfunction whenReady() {
\t\t\treturn ready;
\t\t}

${bodyPatched}

\t\t// 模块级 re-export：原先直接赋值的 7 行里，凡是**搬去 helpers 的名字**改成 getter（否则会变成
\t\t// 模块级 ReferenceError）；其余（createPanel 等）**原样保留**。导出面保持不变。
${oldExports
  .map((e) => {
    const name = (e.match(/^exports\.([A-Za-z_$][\w$]*)/) || [])[1];
    if (name && helperNames.includes(name)) {
      return `\t\tObject.defineProperty(exports, "${name}", { enumerable: true, get: () => (parts === null ? undefined : parts.${name}) });`;
    }
    return '\t\t' + e;
  })
  .join('\n')}

\t\texports.whenReady = whenReady;
\t\treturn module.exports;
\t},
});
`;

fs.writeFileSync(path.join(STAGE, 'client/client.panel.js'), thinEntry);

for (const f of fs.readdirSync(path.join(STAGE, 'client'))) {
  const t = fs.readFileSync(path.join(STAGE, 'client', f), 'utf8');
  console.log(`${f}: ${t.split('\n').length - 1} 行`);
}
console.log('staging =', path.join(STAGE, 'client'));
