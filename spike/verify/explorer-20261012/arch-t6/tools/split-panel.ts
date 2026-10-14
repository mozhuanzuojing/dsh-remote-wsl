/**
 * split-panel.ts —— T41：把 client/client.panel.js（1293 行）机械拆成 6 个 chunk。
 *
 * 原则：**被搬动的代码体逐字不变**（整块切片），只在函数开头把自由变量从 props 解构回同名局部，
 * 末尾按需 return。自由变量由脚本自动推导（标识符 − 本地声明 − JS 关键字/全局），
 * 因此不需要人工列举、也不会有 `with` 那种审查负担。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/project/dsh1/vendor/dsh-remote-wsl";
const SRC = path.join(ROOT, "spike/verify/explorer-20261012/arch-t6/backup/client.panel.js.orig");
const src = fs.readFileSync(SRC, "utf8").split("\n");
/** 1-based 闭区间切片。 */
const cut = (a, b) => src.slice(a - 1, b).join("\n");
const at = (line) => src[line - 1];

const idx = (needle, from = 0) => {
	for (let i = from; i < src.length; i++) if (src[i].trim() === needle) return i;
	return -1;
};
const A = {
	react: idx('const React = require("react");'),
	statusDot: idx("function StatusDot({ kind }) {"),
	createPanel: idx("function createPanel(ctx, api, i18n) {"),
	headerButtons: idx("const headerButtons = [];"),
	body: idx("const body = [];"),
};
A.browserIf = idx("if (factsVisible && snapshot !== null) {", A.body);
A.advanced = idx("// —— 折叠区：高级 / 诊断（默认收起；收起时内部完全不渲染 ⇒ 不可 Tab 到达） ——");
A.confirm = idx("// —— 二次确认（内联在 body 内；破坏性动作只从 ⋯ 菜单进） ——");
A.footer = idx("// —— 底栏（一行） ——");
A.rootReturn = idx("return React.createElement(", A.footer);
A.compEnd = idx("};", A.rootReturn);
for (const [k, v] of Object.entries(A)) if (v < 0) throw new Error("anchor not found: " + k);
/** 1-based 闭区间：cut(a,b) = slice(a-1,b)。b 传 0-based 下标即为"不含该行"。 */
const BOUNDS = {
	helpers: [A.react + 2, A.createPanel],
	state: [A.createPanel + 2, A.headerButtons],
	header: [A.headerButtons + 1, A.body],
	viewHead: [A.body + 1, A.browserIf],
	browser: [A.browserIf + 1, A.advanced],
	viewTail: [A.advanced + 1, A.compEnd],
};
console.log("动态锚点:", JSON.stringify(A));
const KEYWORDS = new Set([
	"const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break",
	"continue", "new", "typeof", "instanceof", "in", "of", "this", "null", "undefined", "true", "false", "try",
	"catch", "finally", "throw", "class", "extends", "super", "yield", "await", "async", "delete", "void", "default",
	"export", "import", "from", "as", "static", "get", "set", "key", "props", "arguments", "NaN", "Infinity",
]);

/** 顶层声明名（本切片内自己声明的，不需要从 props 拿）。 */
function declared(slice, indent) {
	const names = new Set();
	const head = indent === undefined ? "[\\t ]*" : indent;
	for (const m of slice.matchAll(new RegExp("^" + head + "(?:const|let|var|function|class)\\s+([A-Za-z_$][\\w$]*)", "gm"))) names.add(m[1]);
	for (const m of slice.matchAll(new RegExp("^" + head + "(?:const|let)\\s*\\[([^\\]]*)\\]", "gm"))) {
		for (const part of m[1].split(",")) {
			const name = part.trim().replace(/^\\.\\.\\./, "");
			if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
		}
	}
	return names;
}

/** 自由变量候选：出现在切片里、但不是本地声明、不是关键字。 */
function freeVars(slice, indent) {
	const local = indent === undefined ? declared(slice) : new Set([...declared(slice), ...declared(slice, indent)]);
	const out = new Set();
	for (const m of slice.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)/g)) {
		const id = m[1];
		if (local.has(id) || KEYWORDS.has(id)) continue;
		out.add(id);
	}
	return [...out].sort();
}

const MOD_HEAD = (chunk, comment) => `/**
 * ${chunk} —— ${comment}
 *
 * T41 机械拆分：本文件由 \`spike/verify/explorer-20261012/arch-t6/tools/split-panel.ts\` 从
 * 原 \`client/client.panel.js\` 的**整块切片**生成，被搬动的代码体**逐字不变**；
 * 函数开头把自由变量从 props 解构回同名局部变量（自动推导，非人工列举）。
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

const MOD_TAIL = `\t\treturn module.exports;
\t},
});
`;

const files = {};

// —— 1) helpers：纯函数 + 图标 + StatusDot ——
{
	const body = cut(...BOUNDS.helpers);
	const names = [...declared(body)];
	files["client.panel.helpers.js"] =
		MOD_HEAD("client.panel.helpers.js", "常量 + 纯函数 + 文案格式化 + 内联 SVG 图标 + StatusDot（无副作用）") +
		body +
		"\n\n" +
		names.map((n) => `\t\texports.${n} = ${n};`).join("\n") +
		"\n" +
		MOD_TAIL;
}

// —— 2) state：hook（状态机 + effects + 处理器 + 派生值） ——
{
	const body = cut(...BOUNDS.state);
	const free = freeVars(body);
	const names = [...declared(body, "\\t\\t\\t\\t")];
	files["client.panel.state.js"] =
		MOD_HEAD("client.panel.state.js", "面板状态机：useState/useRef/useEffect + 处理器 + 派生值（无渲染）") +
		`
/** 只在组件内调用（自定义 hook）。自由变量从 props 解构回同名局部 ⇒ 代码体逐字不变。 */
function usePanelState(props) {
\tconst { ${free.join(", ")} } = props;
` +
		body +
		`

\treturn { ${names.join(", ")} };
}

` +
		"\t\texports.usePanelState = usePanelState;\n" +
		MOD_TAIL;
}

// —— 3) header：头部按钮组 ——
{
	const body = cut(...BOUNDS.header);
	const free = freeVars(body, "\\t\\t\\t");
	files["client.panel.header.js"] =
		MOD_HEAD("client.panel.header.js", "头部按钮组（主按钮 / 次按钮 / 刷新图标）") +
		`
function renderHeaderButtons(props) {
\tconst { ${free.join(", ")} } = props;
` +
		body +
		`

\treturn headerButtons;
}

` +
		"\t\texports.renderHeaderButtons = renderHeaderButtons;\n" +
		MOD_TAIL;
}

// —— 4) browser：目录浏览卡片 + 最近目录 ——
{
	let body = cut(...BOUNDS.browser);
	// 两处 body.push(React.createElement(...)); ⇒ 改成返回值
	const firstIdx = body.indexOf("body.push(");
	if (firstIdx < 0) throw new Error("browser push not found");
	body = body.slice(0, firstIdx) + "const __browserCard = (" + body.slice(firstIdx + "body.push(".length);
	const lastIdx = body.lastIndexOf("body.push(");
	if (lastIdx < 0) throw new Error("recent push not found");
	body = body.slice(0, lastIdx) + "const __recent = (" + body.slice(lastIdx + "body.push(".length);
	const free = freeVars(body);
	files["client.panel.browser.js"] =
		MOD_HEAD("client.panel.browser.js", "唯一目录概念：chips + 面包屑 + 常显路径输入 + 条目列表；以及最近目录折叠区") +
		`
/** 返回 [目录卡片元素, 最近目录折叠元素|null]，由 view 侧 push 进 body。 */
function renderBrowser(props) {
\tconst { ${free.join(", ")} } = props;
\tconst __browserEls = [];
` +
		body +
		`

\t__browserEls.unshift(typeof __browserCard === "undefined" ? null : __browserCard);
\t__browserEls.push(typeof __recent === "undefined" ? null : __recent);
\treturn __browserEls.filter((el) => el !== null && el !== undefined);
}

` +
		"\t\texports.renderBrowser = renderBrowser;\n" +
		MOD_TAIL;
}

// —— 5) view：body 首尾（结果条/加载/错误/诊断折叠/确认层）+ 根返回 ——
{
	const head = cut(...BOUNDS.viewHead);
	const tail = cut(...BOUNDS.viewTail);
	const body = head + "\n" + "\t\t\t\t// T41：目录浏览器与最近目录由 client.panel.browser.js 渲染（切片位置与拆分前一致）\n\t\t\t\tif (factsVisible && snapshot !== null) body.push(...browserEls);\n" + tail;
	const free = freeVars(body);
	files["client.panel.view.js"] =
		MOD_HEAD("client.panel.view.js", "面板视图：结果条 / 三态 / 诊断折叠区 / 二次确认 / 根元素（含底栏与 ⋯ 菜单）") +
		`
function renderView(props) {
\tconst { ${free.join(", ")} } = props;
` +
		body +
		`

}

` +
		"\t\texports.renderView = renderView;\n" +
		MOD_TAIL;
}

// —— 6) 入口 client.panel.js ——
files["client.panel.js"] = `/**
 * client.panel.js —— 「远程资源管理器」中央面板入口（T41 拆分后的**薄入口**）。
 *
 * 拆分（T41 / 架构债 T6）：原 1293 行单文件拆成 5 个 chunk，全部经
 * \`require.async("./client.panel.<name>.js")\` 装载（平台只认 \`client.*.js\`）：
 *   · client.panel.helpers.js  常量/纯函数/文案格式化/内联 SVG 图标
 *   · client.panel.state.js    状态机（usePanelState：状态 + effects + 处理器 + 派生值）
 *   · client.panel.header.js   头部按钮组
 *   · client.panel.browser.js  目录浏览卡片 + 最近目录
 *   · client.panel.view.js     结果条/三态/诊断/确认层/根元素（底栏 + ⋯ 菜单）
 *
 * 行为零变化：每个 chunk 的代码体都是**逐字切片**，只在函数开头把自由变量从 props 解构回同名局部。
 * 入口额外导出 \`ready\`（子 chunk 装载 Promise），由 \`client/index.js\` 在创建组件前 await。
 */

window.__ModuleLoader__.load({
\tid: "dsh-remote-wsl",
\tchunk: "client.panel.js",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

\t\tconst React = require("react");

\t\tconst CHUNKS = [
\t\t\t"client.panel.helpers.js",
\t\t\t"client.panel.state.js",
\t\t\t"client.panel.header.js",
\t\t\t"client.panel.browser.js",
\t\t\t"client.panel.view.js",
\t\t];

\t\t/** 子 chunk 装载（每个 chunk 都是独立 ModuleLoader 模块）。 */
\t\tconst loaded = Promise.all(CHUNKS.map((name) => require.async("./" + name))).then((mods) => {
\t\t\tconst [helpers, state, header, browser, view] = mods;
\t\t\treturn {
\t\t\t\thelpers,
\t\t\t\tusePanelState: state.usePanelState,
\t\t\t\trenderHeaderButtons: header.renderHeaderButtons,
\t\t\t\trenderBrowser: browser.renderBrowser,
\t\t\t\trenderView: view.renderView,
\t\t\t};
\t\t});

\t\t/** 子 chunk 就绪信号（index.js 会 await 它，再创建组件）。 */
\t\tconst ready = loaded.then(() => undefined);

\t\tfunction createPanel(ctx, api, i18n) {
\t\t\tconst t = i18n && typeof i18n.t === "function" ? i18n.t : (key) => key;
\t\t\tconst i18nSubscribe = i18n && typeof i18n.subscribe === "function" ? i18n.subscribe : null;

\t\t\treturn function RemoteWslPanel() {
\t\t\t\tconst [parts, setParts] = React.useState(null);
\t\t\t\tReact.useEffect(() => {
\t\t\t\t\tlet alive = true;
\t\t\t\t\tloaded.then((mods) => {
\t\t\t\t\t\tif (alive) setParts(mods);
\t\t\t\t\t});
\t\t\t\t\treturn () => {
\t\t\t\t\t\talive = false;
\t\t\t\t\t};
\t\t\t\t}, []);
\t\t\t\tif (parts === null) {
\t\t\t\t\treturn React.createElement(
\t\t\t\t\t\t"section",
\t\t\t\t\t\t{ className: "dsh-rw-root", "data-dsh-remote-wsl": "panel" },
\t\t\t\t\t\tReact.createElement("div", { className: "dsh-rw-header" }, React.createElement("div", { className: "dsh-rw-header-text" }, React.createElement("span", { className: "dsh-rw-title" }, t("panel.title")))),
\t\t\t\t\t\tReact.createElement("footer", { className: "dsh-rw-status", role: "status", "aria-live": "polite" }, React.createElement("span", { className: "dsh-rw-statusword" }, t("load.reading"))),
\t\t\t\t\t);
\t\t\t\t}

\t\t\t\tconst s = parts.usePanelState({
\t\t\t\t\tReact,
\t\t\t\t\tctx,
\t\t\t\t\tapi,
\t\t\t\t\tt,
\t\t\t\t\ti18n,
\t\t\t\t\ti18nSubscribe,
\t\t\t\t\ticon: parts.helpers.icon,
\t\t\t\t\tStatusDot: parts.helpers.StatusDot,
\t\t\t\t\tnormalizeWslPath: parts.helpers.normalizeWslPath,
\t\t\t\t\tjoinWslPath: parts.helpers.joinWslPath,
\t\t\t\t\tbreadcrumbOf: parts.helpers.breadcrumbOf,
\t\t\t\t\thomePathOf: parts.helpers.homePathOf,
\t\t\t\t\treadRecent: parts.helpers.readRecent,
\t\t\t\t\tpushRecent: parts.helpers.pushRecent,
\t\t\t\t\tsplitHumanText: parts.helpers.splitHumanText,
\t\t\t\t\topenSessionNote: parts.helpers.openSessionNote,
\t\t\t\t\taddWorkspaceNote: parts.helpers.addWorkspaceNote,
\t\t\t\t\taddWorkspaceErrorText: parts.helpers.addWorkspaceErrorText,
\t\t\t\t\tactionFailureText: parts.helpers.actionFailureText,
\t\t\t\t\tdaemonNote: parts.helpers.daemonNote,
\t\t\t\t\terrorText: parts.helpers.errorText,
\t\t\t\t\tclock: parts.helpers.clock,
\t\t\t\t\tasArray: parts.helpers.asArray,
\t\t\t\t\tisRecord: parts.helpers.isRecord,
\t\t\t\t\tnewAbortController: parts.helpers.newAbortController,
\t\t\t\t\tsignalOf: parts.helpers.signalOf,
\t\t\t\t\tRECENT_MAX: parts.helpers.RECENT_MAX,
\t\t\t\t\tNARROW_PX: parts.helpers.NARROW_PX,
\t\t\t\t\tHIDE_UPDATED_PX: parts.helpers.HIDE_UPDATED_PX,
\t\t\t\t});

\t\t\t\tconst headerButtons = parts.renderHeaderButtons(Object.assign({ React, t, icon: parts.helpers.icon }, s));
\t\t\t\tconst browserEls = parts.renderBrowser(Object.assign({ React, t, icon: parts.helpers.icon }, s, { browserEls: [] }));

\t\t\t\treturn parts.renderView(Object.assign({ React, t, icon: parts.helpers.icon, StatusDot: parts.helpers.StatusDot, headerButtons, browserEls }, s));
\t\t\t};
\t\t}

\t\texports.createPanel = createPanel;
\t\texports.ready = ready;
\t\treturn module.exports;
\t},
});
`;

for (const [name, text] of Object.entries(files)) {
	fs.writeFileSync(path.join(ROOT, "client", name), text);
	const lines = text.split("\n").length;
	console.log(`${name}: ${lines} 行`);
}
