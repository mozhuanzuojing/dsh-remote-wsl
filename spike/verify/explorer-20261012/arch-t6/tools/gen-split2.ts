/* gen-split2.ts —— T41 完整拆分生成器（从**拆分前备份**切片，一次生成全部 chunk + 薄入口）。
 *
 * 与原脚本的关键差别：
 *   · 边界全部是**整语句块**（含 `if (...) {` 与配对 `}`），括号天然平衡；
 *   · 接线用**显式名字清单**（= helpers 导出面 ∪ hooks 声明 ∪ 上游切片 return 面），**宁多勿缺**；
 *   · 正确性判据 = `panel-smoke-node.ts`（真装载 + 真渲染）+ 与拆分前基线比对渲染树；
 *   · 全部先写 `arch-t6/staging/`，全绿才拷进 `client/`。
 *
 * 用法：node gen-split2.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const SRC = path.join(ROOT, 'spike/verify/explorer-20261012/arch-t6/backup/client.panel.js.pre-split-20261013');
const STAGE = path.join(ROOT, 'spike/verify/explorer-20261012/arch-t6/staging');
const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const cut = (a, b) => lines.slice(a - 1, b).join('\n');

const B = {
  head: [1, 32],
  helpers: [33, 274],
  cpHead: [276, 279],       // function createPanel(...) { / t / i18nSubscribe / 空行
  hooks: [281, 330],        // useState/useRef/useEffect（hook 顺序区）
  actions: [332, 589],      // useCallback 们 + 交错 effects + runDaemon
  header: [591, 670],       // headerButtons 构造
  notePushes: [673, 732],   // action note / loading / error 三块 body.push
  browser: [734, 972],      // 目录卡（含 if (factsVisible…) 行与其配对 }）
  recentFold: [974, 1000],  // 最近目录折叠区（与 browser 同属"目录概念"，并进同一 chunk 保持 push 顺序）
  tail: [1002, 1280],       // 诊断 / 确认 / 底栏+⋯菜单 / 根 return
};

/** 只认该切片**自己那一层**的声明（tab 深度必须给对，否则会把函数内部的局部名扫进来
 *  ⇒ 之前实测后果：`exports.acc` 未定义、`const cwd` 重复声明）。 */
const declNames = (text, tabs) => {
  const head = '^\\t{' + tabs + '}';
  const names = new Set();
  for (const m of text.matchAll(new RegExp(head + '(?:const|let|var|function|class)\\s+([A-Za-z_$][\\w$]*)', 'gm'))) names.add(m[1]);
  for (const m of text.matchAll(new RegExp(head + '(?:const|let)\\s*[\\[{]([^\\]}]*)[\\]}]\\s*=', 'gm'))) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return [...names].sort();
};

const helperNames = declNames(cut(...B.helpers), 2);
const hookNames = declNames(cut(...B.hooks), 4);
const actionNames = declNames(cut(...B.actions), 4);
const headerNames = declNames(cut(...B.header), 4);
const BASE = ['React'];
const IN_ACTIONS = [...new Set([...BASE, 'ctx', 'api', 't', 'i18nSubscribe', ...helperNames, ...hookNames])].sort();
const IN_VIEW = [...new Set([...BASE, 'ctx', 'api', 't', 'icon', 'body', ...helperNames, ...hookNames, ...actionNames])].sort();
const IN_TAIL = [...new Set([...IN_VIEW, ...headerNames])].sort();

const MOD_HEAD = (chunk, comment) => `/**
 * ${chunk} —— ${comment}
 *
 * T41 机械拆分（生成器 \`arch-t6/tools/gen-split2.ts\`，从拆分前备份整块切片）：
 * 被搬动的代码体**逐字不变**；只在本函数开头把上游名字解构回同名局部（显式清单，非正则猜）。
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
/** 名字清单紧凑排版（每行 4 个）：一行一个名字会把每个 chunk 撑大 ~35 行。 */
const wrap4 = (names, tab, prefix) => {
  const rows = [];
  for (let i = 0; i < names.length; i += 4) rows.push('\t' + prefix + names.slice(i, i + 4).join(', ') + ',');
  return rows.join('\n');
};
const propsDecl = (names, tab = '\t\t') => `${tab}\tconst {\n${wrap4(names, tab, '')}\n${tab}\t} = props;`;
const retObj = (names, tab = '\t\t') => `${tab}\treturn {\n${wrap4(names, tab, '')}\n${tab}\t};`;

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'client'), { recursive: true });
const write = (name, text) => { fs.writeFileSync(path.join(STAGE, 'client', name), text); return `${name}: ${text.split('\n').length - 1} 行`; };
const out = [];

// 1) helpers（同 stage 1）
out.push(write('client.panel.helpers.js',
  MOD_HEAD('client.panel.helpers.js', '常量 + 纯函数 + 文案格式化 + 内联 SVG 图标 + StatusDot') +
  cut(...B.helpers) + '\n\n' + helperNames.map((n) => `\t\texports.${n} = ${n};`).join('\n') + '\n' + MOD_TAIL));

// 2) actions：callbacks + 交错 effects + runDaemon ⇒ 自定义 hook
out.push(write('client.panel.actions.js',
  MOD_HEAD('client.panel.actions.js', '面板动作层：load/run/listPath/jumpTo/submitPath/键盘与文档事件/菜单/守护动作（自定义 hook，无渲染）') + `
/** 只在组件内调用（自定义 hook）。自由变量从 props 解构回同名局部 ⇒ 代码体逐字不变。 */
function usePanelActions(props) {
${propsDecl(IN_ACTIONS)}

${cut(...B.actions)}

${retObj(actionNames)}
}

\t\texports.usePanelActions = usePanelActions;
` + MOD_TAIL));

// 3) header：headerButtons + 三块 body.push
out.push(write('client.panel.header.js',
  MOD_HEAD('client.panel.header.js', '头部按钮组 + 动作结果/加载/错误三块（把元素 push 进共享的 body 数组）') + `
function renderHeader(props) {
${propsDecl(IN_VIEW)}

${cut(...B.header)}

\t\t\t// —— 动作结果条 / 加载态 / 错误态（原样顺序，push 进共享 body） ——

${cut(...B.notePushes)}

${retObj(headerNames)}
}

\t\texports.renderHeader = renderHeader;
` + MOD_TAIL));

// 4) browser：目录卡（含 if 行与其配对 }）
out.push(write('client.panel.browser.js',
  MOD_HEAD('client.panel.browser.js', '唯一目录概念：chips + 面包屑 + 常显路径输入 + 条目列表（push 进共享 body）') + `
function renderBrowser(props) {
${propsDecl(IN_VIEW)}

${cut(...B.browser)}

			// —— 折叠区：最近目录（与目录卡同属"目录概念"；push 顺序不变） ——

${cut(...B.recentFold)}
}

\t\texports.renderBrowser = renderBrowser;
` + MOD_TAIL));

// 5) tail：折叠区 / 确认层 / 底栏 + ⋯菜单 / 根 return
out.push(write('client.panel.tail.js',
  MOD_HEAD('client.panel.tail.js', '最近目录 + 诊断折叠区 + 二次确认 + 底栏与 ⋯ 菜单 + 根元素（返回根元素）') + `
function renderTail(props) {
${propsDecl(IN_TAIL)}

${cut(...B.tail)}
}

\t\texports.renderTail = renderTail;
` + MOD_TAIL));

// 6) 薄入口
const returnIdx = lines.findIndex((l) => l.trim() === 'return module.exports;');
let exportsStart = returnIdx;
while (exportsStart > 0 && lines[exportsStart - 1].trim().startsWith('exports.')) exportsStart--;
const oldExports = lines.slice(exportsStart, returnIdx).map((l) => l.trim());

const destructure = `\t\t\t// T41：全部子 chunk 已由 whenReady() 保证就绪，这里把它们的导出面解构回**同名局部**。
\t\t\tif (parts === null) throw new Error("client.panel.js: 子 chunk 尚未就绪（client/index.js 必须先 await whenReady()）");
\t\t\tconst {
${helperNames.map((n) => `\t\t\t\t${n},`).join('\n')}
\t\t\t} = parts.helpers;`;
const hooks = cut(...B.hooks).replace(/^\t\t\t/gm, '\t\t\t');   // 原缩进 3 tab，保持
const main = `/**
 * client.panel.js —— 「远程资源管理器」中央面板入口（T41 拆分后的**接线层**）。
 *
 * 拆分（T41 / 架构债 T6）：原 1293 行单文件 ⇒
 *   · client.panel.helpers.js  常量 / 纯函数 / 文案格式化 / 内联 SVG 图标 / StatusDot
 *   · client.panel.actions.js  usePanelActions：callbacks + 交错的 effects + runDaemon（自定义 hook）
 *   · client.panel.header.js   renderHeader：头部按钮组 + 动作结果/加载/错误三块
 *   · client.panel.browser.js  renderBrowser：目录卡（chips/面包屑/路径输入/条目列表）
 *   · client.panel.tail.js     renderTail：两处折叠区 + 二次确认 + 底栏与 ⋯ 菜单 + 根元素
 *
 * 装载：平台只认包内 \`client.*.js\`；子 chunk 用 \`require.async("./client.panel.<name>.js")\`。
 * 子 chunk 必须在**首次渲染前**就绪（组件直接引用它们）⇒ 本模块导出 \`whenReady()\`，
 * \`client/index.js\` 在 createPanel() 之前 await 它；createPanel 开头再断言一次（未就绪就抛）。
 *
 * 行为零变化：所有被搬动的代码都是**整块切片**（逐字不变），只在本文件里做接线。
 */

${cut(...B.head)}

\t\t/** 子 chunk 装载（各自是独立 ModuleLoader 模块）。 */
\t\tconst CHUNKS = ["client.panel.helpers.js", "client.panel.actions.js", "client.panel.header.js", "client.panel.browser.js", "client.panel.tail.js"];
\t\tlet parts = null;
\t\tconst ready = Promise.all(CHUNKS.map((name) => require.async("./" + name))).then((mods) => {
\t\t\tparts = {
\t\t\t\thelpers: mods[0],
\t\t\t\tusePanelActions: mods[1].usePanelActions,
\t\t\t\trenderHeader: mods[2].renderHeader,
\t\t\t\trenderBrowser: mods[3].renderBrowser,
\t\t\t\trenderTail: mods[4].renderTail,
\t\t\t};
\t\t\treturn parts;
\t\t});

\t\t/** 子 chunk 就绪信号：client/index.js 必须在 createPanel() 之前 await 它。 */
\t\tfunction whenReady() {
\t\t\treturn ready;
\t\t}

${cut(...B.cpHead)}
${destructure}

\t\t\treturn function RemoteWslPanel() {
${hooks}

\t\t\t\t// 共享 body：由本组件创建；header / browser 两个切片 push 进它（顺序与拆分前一致）。
\t\t\t\tconst body = [];
\t\t\t\t// 一个共享 scope 传给四个切片（各自只解构自己需要的名字；多余键无害）——
\t\t\t\t// 这样接线只有一份名单，而不是四处重复。
\t\t\t\tconst scope = {
${wrap4([...new Set([...IN_ACTIONS, 'i18n'])], '\t\t\t\t', '')}
\t\t\t\t\tbody,
\t\t\t\t};
\t\t\t\tconst actions = parts.usePanelActions(scope);
\t\t\t\tObject.assign(scope, actions);\n\t\t\t\tconst headerOut = parts.renderHeader(scope);
\t\t\t\tObject.assign(scope, headerOut);
\t\t\t\tparts.renderBrowser(scope);
\t\t\t\treturn parts.renderTail(scope);
\t\t\t};
\t\t}

\t\t// 模块级 re-export：搬去 helpers 的名字用 getter 保持导出面不变（否则是模块级 ReferenceError）
${oldExports.map((e) => {
  const name = (e.match(/^exports\.([A-Za-z_$][\w$]*)/) || [])[1];
  return name && helperNames.includes(name)
    ? `\t\tObject.defineProperty(exports, "${name}", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.${name}) });`
    : '\t\t' + e;
}).join('\n')}

\t\texports.whenReady = whenReady;
\t\treturn module.exports;
\t},
});
`;
out.push(write('client.panel.js', main));

console.log('切片导出面: helpers=' + helperNames.length + ' hooks=' + hookNames.length + ' actions=' + actionNames.length + ' header=' + headerNames.length);
console.log(out.join('\n'));
console.log('staging =', path.join(STAGE, 'client'));
