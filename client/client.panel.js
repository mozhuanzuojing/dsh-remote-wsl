/**
 * client.panel.js —— 「远程资源管理器」中央面板入口（T41 拆分后的**接线层**）。
 *
 * 拆分（T41 / 架构债 T6）：原 1293 行单文件 ⇒
 *   · client.panel.helpers.js  常量 / 纯函数 / 文案格式化 / 内联 SVG 图标 / StatusDot
 *   · client.panel.actions.js  usePanelActions：callbacks + 交错的 effects + runDaemon（自定义 hook）
 *   · client.panel.header.js   renderHeader：头部按钮组 + 动作结果/加载/错误三块
 *   · client.panel.browser.js  renderBrowser：目录卡（chips/面包屑/路径输入/条目列表）
 *   · client.panel.tail.js     renderTail：两处折叠区 + 二次确认 + 底栏与 ⋯ 菜单 + 根元素
 *
 * 装载：平台只认包内 `client.*.js`；子 chunk 用 `require.async("./client.panel.<name>.js")`。
 * 子 chunk 必须在**首次渲染前**就绪（组件直接引用它们）⇒ 本模块导出 `whenReady()`，
 * `client/index.js` 在 createPanel() 之前 await 它；createPanel 开头再断言一次（未就绪就抛）。
 *
 * 行为零变化：所有被搬动的代码都是**整块切片**（逐字不变），只在本文件里做接线。
 */

/**
 * client.panel.js —— 「远程资源管理器」中央面板（`main` 槽 key: 'remote-wsl'）。
 *
 * T30 重设计（按 `docs/panel-ux-redesign.md` + `docs/panel-visual-spec.md` 两份冻结规格）：
 *   头部（标题 + 唯一主按钮 + 次按钮 + 刷新图标）｜主体（**唯一**目录概念：chips + 面包屑 +
 *   常显路径输入 + 条目列表）｜折叠区（最近目录 / 高级·诊断）｜底栏（**一行**：状态点 + 状态词 +
 *   附加信息 + 更新于 + `⋯`）。
 *
 * 规格硬约束（实现自证；判据见规格 §7-M1..M17 / §5.5-N1..N5）：
 * - **M1**：旧树删掉 —— 面板内同一路径只出现一次（没有第二次"工作区树"）。
 * - **M5**：主视线不得出现 `slot/daemonPort/pid/keys/explorer.snapshot/snapshot/systemd-run/unit/版本号`。
 * - **N4**：行内动作不用 `display:none`，用 `visibility` + 常占位（hover 前后几何不变）。
 * - **N5 / §4.2.1**：每个状态 = ①文字状态词 + ②形状/图标，颜色只是第三冗余。
 * - **§3.4**：面板内**零 emoji**，全部内联 SVG（16×16，viewBox 24，stroke 1.5，currentColor）。
 * - **§3.7**：内嵌路径文本一律 `direction:ltr;unicode-bidi:isolate`。
 * - **M12**：最近目录 = `localStorage['dsh-remote-wsl.recent']`，只存路径字符串 ≤8 条，不可用即静默降级。
 * - 文案**全部**来自 `client.i18n.js`（本文件不得出现中文字符串字面量，`console.*`/注释除外）。
 *
 * 保留不回退：三态渲染 / F34 首挂载只显示读取中 / F35 路径 LTR / `others[]` 只读零按钮 /
 * 停止·重启二次确认 / rail 名「远程资源管理器」。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");


		/** 子 chunk 装载（各自是独立 ModuleLoader 模块）。 */
		const CHUNKS = ["client.panel.helpers.js", "client.panel.data.js", "client.panel.actions.js", "client.panel.header.js", "client.panel.list.js", "client.panel.browser.js", "client.panel.tail.js"];
		let parts = null;
		const ready = Promise.all(CHUNKS.map((name) => require.async("./" + name))).then((mods) => {
			parts = {
				helpers: mods[0],
				useDirectoryNavigation: mods[1].useDirectoryNavigation,
				usePanelActions: mods[2].usePanelActions,
				renderHeader: mods[3].renderHeader,
				Entries: mods[4].Entries,
				renderBrowser: mods[5].renderBrowser,
				renderTail: mods[6].renderTail,
			};
			return parts;
		});

		/** 子 chunk 就绪信号：client/index.js 必须在 createPanel() 之前 await 它。 */
		function whenReady() {
			return ready;
		}

		function createPanel(ctx, api, i18n) {
			const t = i18n && typeof i18n.t === "function" ? i18n.t : (key) => key;
			/** 目标发行版（多发行版切换）的本地记忆；只影响本面板的请求，不写插件配置。 */
			const DISTRO_KEY = "dsh-remote-wsl.distro";
			const readStoredDistro = () => {
				try {
					const v = typeof localStorage === "undefined" ? null : localStorage.getItem(DISTRO_KEY);
					return typeof v === "string" && v.length > 0 ? v : null;
				} catch {
					return null;
				}
			};
			api.setDistro(readStoredDistro());
			const i18nSubscribe = i18n && typeof i18n.subscribe === "function" ? i18n.subscribe : null;

			// T41：全部子 chunk 已由 whenReady() 保证就绪，这里把它们的导出面解构回**同名局部**。
			if (parts === null) throw new Error("client.panel.js: sub-chunks are not ready yet (client/index.js must await whenReady() first)");
			const {
				HIDE_UPDATED_PX,
				NARROW_PX,
				RECENT_KEY,
				RECENT_MAX,
				StatusDot,
				actionFailure,
				actionFailureText,
				addWorkspaceErrorText,
				addWorkspaceNote,
				asArray,
				breadcrumbOf,
				clock,
				daemonNote,
				errorText,
				homePathOf,
				icon,
				isRecord,
				joinWslPath,
				newAbortController,
				normalizeWslPath,
				openSessionNote,
				pushRecent,
				readRecent,
				signalOf,
				splitFirstSentence,
				splitHumanText,
				dirCache,
				filterEntries,
				sortEntries,
				VIRTUAL_MIN_ROWS,
			} = parts.helpers;

			return function RemoteWslPanel() {
				const [state, setState] = React.useState({ status: "loading", snapshot: null, error: null, lastSuccessAt: null, lastFailureAt: null });
				const [collapsed, setCollapsed] = React.useState({});
				const [action, setAction] = React.useState({ busy: null, note: null, detail: null, error: null });
				const [pending, setPending] = React.useState(null);
				const [menuOpen, setMenuOpen] = React.useState(false);
				const [browse, setBrowse] = React.useState({ cwd: null, status: "idle", entries: [], error: null });
				const [showHidden, setShowHidden] = React.useState(false);
				const [chosenDistro, setChosenDistro] = React.useState(() => readStoredDistro());
				const [pathInput, setPathInput] = React.useState("");
				const [pathError, setPathError] = React.useState(null);
				const [mounts, setMounts] = React.useState([]);
				const [recent, setRecent] = React.useState([]);
				const [recentOk, setRecentOk] = React.useState(true);
				const [slow, setSlow] = React.useState(false);
				const [width, setWidth] = React.useState(1280);
				const [focusIndex, setFocusIndex] = React.useState(-1);
				const [search, setSearch] = React.useState("");
				const [, forceLocale] = React.useReducer((n) => n + 1, 0);

				const readSeq = React.useRef(0);
				const readAbort = React.useRef(null);
				const actionAbort = React.useRef(null);
				const lastRun = React.useRef(null);
				const browseSeq = React.useRef(0);
				const browseAbort = React.useRef(null);
				const mountsProbed = React.useRef(false);
				const rootRef = React.useRef(null);
				const moreRef = React.useRef(null);
				const menuRef = React.useRef(null);
				const pendingFrom = React.useRef(null);
				const cancelRef = React.useRef(null);
				const searchRef = React.useRef(null);
				/** 导航代次：listPath 自增；actions 的刷新结果据此判断"是否还能写当前列表"（F2 竞态）。 */
				const navSeq = React.useRef(0);

				React.useEffect(() => {
					if (i18nSubscribe === null) return undefined;
					return i18nSubscribe(() => forceLocale());
				}, []);

				React.useEffect(() => {
					const items = readRecent();
					setRecent(items);
					setRecentOk(typeof localStorage !== "undefined");
				}, []);

				React.useEffect(() => {
					if (typeof ResizeObserver !== "function" || rootRef.current === null) return undefined;
					const observer = new ResizeObserver((records) => {
						const w = records[0] && records[0].contentRect ? records[0].contentRect.width : 0;
						if (w > 0) setWidth(w);
					});
					observer.observe(rootRef.current);
					return () => observer.disconnect();
				}, []);

				// 共享 body：由本组件创建；header / browser 两个切片 push 进它（顺序与拆分前一致）。
				const body = [];
				// 一个共享 scope 传给四个切片（各自只解构自己需要的名字；多余键无害）——
				// 这样接线只有一份名单，而不是四处重复。
				const scope = {
	HIDE_UPDATED_PX, NARROW_PX, RECENT_KEY, RECENT_MAX,
	React, StatusDot, action, actionAbort,
	actionFailure, actionFailureText, addWorkspaceErrorText, addWorkspaceNote,
	api, asArray, breadcrumbOf, browse,
	browseAbort, browseSeq, cancelRef, clock,
	collapsed, ctx, daemonNote, errorText,
	focusIndex, forceLocale, homePathOf, i18nSubscribe,
	icon, isRecord, joinWslPath, lastRun,
	menuOpen, menuRef, moreRef, mounts,
	mountsProbed, newAbortController, normalizeWslPath,
	openSessionNote, pathError, pathInput, pending,
	pendingFrom, pushRecent, readAbort, readRecent,
	readSeq, recent, recentOk, rootRef,
	setAction, setBrowse, setCollapsed, setFocusIndex,
	setMenuOpen, setMounts, setPathError, setPathInput,
	setPending, setRecent, setRecentOk, setShowHidden,
	setSlow, setState, setWidth, showHidden,
	signalOf, slow, splitFirstSentence, splitHumanText,
	state, t, width, i18n,
	search, setSearch, searchRef, navSeq,
	dirCache, filterEntries, sortEntries, VIRTUAL_MIN_ROWS,
					body,
				};
				// 目录数据层（缓存/单飞/预取/导航）先接上：actions 与 list 都依赖它
				Object.assign(scope, parts.useDirectoryNavigation(scope));
				// 列表组件（窗口化/行/键盘）注入 scope，供 browser 外壳以 React.createElement 挂载
				scope.Entries = parts.Entries;
				const actions = parts.usePanelActions(scope);
				Object.assign(scope, actions);
				/** 切换目标发行版：只改后续请求带的 distro（api.setDistro）+ 清缓存 + 重新拉快照。 */
				const changeDistro = (name) => {
					const next = typeof name === "string" && name.length > 0 ? name : null;
					try {
						if (typeof localStorage !== "undefined") {
							if (next === null) localStorage.removeItem(DISTRO_KEY);
							else localStorage.setItem(DISTRO_KEY, next);
						}
					} catch {}
					api.setDistro(next);
					dirCache.clear();
					setChosenDistro(next);
					setBrowse({ cwd: null, status: "idle", entries: [], error: null });
					setPathError(null);
					setPathInput("");
					setSearch("");
					actions.load();
				};
				scope.chosenDistro = chosenDistro;
				scope.onDistroChange = changeDistro;
				/** 记住的发行版被删/改名时：host 回"未知发行版" ⇒ 退回缺省目标重试一次（不循环）。 */
				const distroResetRef = React.useRef(false);
				React.useEffect(() => {
					if (state.status !== "error" || chosenDistro === null || distroResetRef.current) return;
					const message = state.error && typeof state.error.message === "string" ? state.error.message : "";
					if (message.indexOf("未知发行版") < 0) return;
					distroResetRef.current = true;
					changeDistro(null);
				}, [state.status, state.error, chosenDistro]);
				const headerOut = parts.renderHeader(scope);
				Object.assign(scope, headerOut);
				parts.renderBrowser(scope);
				return parts.renderTail(scope);
			};
		}

		// 模块级 re-export：搬去 helpers 的名字用 getter 保持导出面不变（否则是模块级 ReferenceError）
		exports.createPanel = createPanel;
		Object.defineProperty(exports, "openSessionNote", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.openSessionNote) });
		Object.defineProperty(exports, "addWorkspaceNote", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.addWorkspaceNote) });
		Object.defineProperty(exports, "addWorkspaceErrorText", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.addWorkspaceErrorText) });
		Object.defineProperty(exports, "splitHumanText", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.splitHumanText) });
		Object.defineProperty(exports, "daemonNote", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.daemonNote) });
		Object.defineProperty(exports, "RECENT_KEY", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.RECENT_KEY) });

		exports.whenReady = whenReady;
		return module.exports;
	},
});