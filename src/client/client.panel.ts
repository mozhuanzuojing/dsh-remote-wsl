import React from 'react';
import * as __helpers from './client.panel.helpers.ts'
import * as __data from './client.panel.data.ts'
import * as __actions from './client.panel.actions.ts'
import * as __header from './client.panel.header.ts'
import * as __list from './client.panel.list.ts'
import * as __browser from './client.panel.browser.ts'
import * as __tail from './client.panel.tail.ts'
import * as __a11y from './client.panel.a11y.ts'



		/** 子 chunk 装载（各自是独立 ModuleLoader 模块）。 */
		const __mods: any[] = [__helpers, __data, __actions, __header, __list, __browser, __tail, __a11y];
		let parts = null;
		parts = {
			helpers: __mods[0],
			useDirectoryNavigation: __mods[1].useDirectoryNavigation,
			usePanelActions: __mods[2].usePanelActions,
			renderHeader: __mods[3].renderHeader,
			Entries: __mods[4].Entries,
			renderBrowser: __mods[5].renderBrowser,
			renderTail: __mods[6].renderTail,
			a11y: __mods[7],
		};
		const ready = Promise.resolve(parts);

		/** 子 chunk 就绪信号：client/index.js 必须在 createPanel() 之前 await 它。 */
		function whenReady() {
			return ready;
		}

		/**
		 * 「在此目录新建会话」的结果条（2026-10-29，P2）。为什么放**接线层**而不是 helpers：
		 * helpers chunk 已贴 400 行门禁（docs/handoff-2026-10-22.md §3「单 chunk < 400 行（门禁）」），
		 * 而这条文案要读的是 header chunk 组装出来的**事实对象**（preset 应用了没 / 主视图切了没）。
		 *
		 * 三条事实口径（不许写伪成功）：
		 *   1. `presetApplied === true` 才说"WSL preset 已应用"；false ⇒ 如实说"未应用"（旧宿主静默丢
		 *      `agentPreset` 字段时就是 false）；`null` = 兜底路径（宿主没有 sessionController，走了
		 *      `uiWorkspace.startSession`，它返回 void、成败不可观测）⇒ 只说"已请求"；
		 *   2. `opened === true` 才说"已切到主视图"；false 说明会话已建好但 openSession 没成功 ⇒ 提示可
		 *      从左侧会话列表打开 + 原因进 detail；
		 *   3. `presetError` / `openError` 是宿主/平台原文，一律进 detail（折叠），不进主句。
		 * @param t i18n 取词函数
		 * @param result header chunk 的返回体
		 * @returns {{text: string, detail: string|null}}
		 */
		function newSessionNote(t, result) {
			if (result === null || typeof result !== "object" || result.ok !== true) return { text: t("session.noInfo"), detail: null };
			const id = typeof result.sessionId === "string" && result.sessionId.length > 0 ? result.sessionId : "?";
			const cwdText = typeof result.cwd === "string" && result.cwd.length > 0 ? result.cwd : "?";
			if (result.presetApplied === null) return { text: t("session.requestedWsl", { cwd: cwdText }), detail: null };
			const details = [];
			if (result.presetDegraded === true) details.push(t("session.presetDegradedDetail"));
			if (typeof result.presetError === "string" && result.presetError.length > 0) details.push(result.presetError);
			if (result.opened === false) {
				details.push(t("session.notOpenedDetail"));
				if (typeof result.openError === "string" && result.openError.length > 0) details.push(result.openError);
			}
			const detail = details.length > 0 ? details.join("\n") : null;
			if (result.presetApplied !== true) return { text: t("session.presetNotApplied", { id, cwd: cwdText }), detail };
			return { text: t(result.opened === true ? "session.openedWsl" : "session.createdWsl", { id, cwd: cwdText }), detail };
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
			if (parts === null) throw new Error("client.panel.ts: sub-chunks not assembled (build misconfigured)");
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
				readRecentAll,
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
				const [collapsed, setCollapsed] = React.useState({ recent: true });
				const [action, setAction] = React.useState({ busy: null, note: null, detail: null, error: null });
				const [pending, setPending] = React.useState(null);
				const [menuOpen, setMenuOpen] = React.useState(false);
				const [browse, setBrowse] = React.useState({ cwd: null, status: "idle", entries: [], error: null });
				const [showHidden, setShowHidden] = React.useState(false);
				const [chosenDistro, setChosenDistro] = React.useState(() => readStoredDistro());
				const [pathInput, setPathInput] = React.useState("");
				const [pathError, setPathError] = React.useState(null);
				const [mounts, setMounts] = React.useState([]);
				const [recent, setRecent] = React.useState({});
				const [recentOk, setRecentOk] = React.useState(true);
				const [slow, setSlow] = React.useState(false);
				const [width, setWidth] = React.useState(1280);
				const [focusIndex, setFocusIndex] = React.useState(-1);
				const [search, setSearch] = React.useState("");
const [copyNote, setCopyNote] = React.useState(null);
// 复制 sessionId（面板会话卡）：成功后短暂显示「已复制」，失败静默（不打断浏览）
// ★ F-40：定时器存在 ref 里 ⇒ 卸载时清掉；重复复制时先清上一个（改前 setTimeout 无 id 无清理，
//   卸载后仍会 setCopyNote ⇒ 对已卸载组件 setState）。
const copyTimer = React.useRef(null);
const copySession = React.useCallback((id) => {
  const done = () => {
    setCopyNote(id);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopyNote((cur) => (cur === id ? null : cur));
    }, 1500);
  };
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
  if (clip && typeof clip.writeText === "function") clip.writeText(id).then(done, () => {});
}, []);
React.useEffect(() => () => { if (copyTimer.current !== null) { clearTimeout(copyTimer.current); copyTimer.current = null; } }, []);
				const [, forceLocale] = React.useReducer((n) => n + 1, 0);
				// 相对时间每 30s 重渲染一次（面板静止时"刚刚更新"也会跳），卸载时清理。
				React.useEffect(() => { const __t = setInterval(() => forceLocale(), 30000); return () => clearInterval(__t); }, []);

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
					const items = readRecentAll();
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
				const scope: any = {
	HIDE_UPDATED_PX, NARROW_PX, RECENT_KEY, RECENT_MAX,
	React, StatusDot, action, actionAbort,
	actionFailure, actionFailureText, addWorkspaceErrorText, addWorkspaceNote,
	api, asArray, breadcrumbOf, browse,
	browseAbort, browseSeq, cancelRef, clock,
	collapsed, ctx, daemonNote, errorText,
	focusIndex, forceLocale, homePathOf, i18nSubscribe,
	icon, isRecord, joinWslPath, lastRun,
	menuOpen, menuRef, moreRef, mounts,
	mountsProbed, newAbortController, newSessionNote, normalizeWslPath,
	openSessionNote, pathError, pathInput, pending,
	pendingFrom, pushRecent, readAbort, readRecent,
	readSeq, recent, recentOk, rootRef,
	setAction, setBrowse, setCollapsed, setFocusIndex,
	setMenuOpen, setMounts, setPathError, setPathInput,
	setPending, setRecent, setRecentOk, setShowHidden,
	setSlow, setState, setWidth, showHidden,
	signalOf, slow, splitFirstSentence, splitHumanText,
	state, t, width, i18n, copyNote, onCopySession: copySession,
	search, setSearch, searchRef, navSeq,
	dirCache, filterEntries, sortEntries, VIRTUAL_MIN_ROWS,
	// 键盘/可访问性原语（F-39）：两个 role=menu 与确认层共用同一套模型
	menuKeyNav: parts.a11y.menuKeyNav, trapTab: parts.a11y.trapTab, closeChipMenu: parts.a11y.closeChipMenu,
					body,
				};
				// 目录数据层（缓存/单飞/预取/导航）先接上：actions 与 list 都依赖它
				Object.assign(scope, parts.useDirectoryNavigation(scope));
				// 列表组件（窗口化/行/键盘）注入 scope，供 browser 外壳以 React.createElement 挂载
				scope.Entries = parts.Entries;
				const actions = parts.usePanelActions(scope);
				Object.assign(scope, actions);
				/**
				 * 切换目标发行版：改后续请求带的 distro（api.setDistro）+ 作废在飞请求 + 清缓存 + 重拉快照。
				 *
				 * ★ F-34（task-8，P1）：必须**三件事一起做**，否则切发行版后 30s 内会显示另一个发行版的目录：
				 *   ① bump `browseSeq` ⇒ 旧 listDir 的回包在 `mySeq !== browseSeq.current` 处被丢弃；
				 *   ② abort 在飞的 browse/prefetch 请求（`browseAbort` 现在真的被赋值了，见 data.js）；
				 *   ③ `dirCache` 的键本身含 distro ⇒ 旧缓存条目永不再命中（clear 只是回收内存）。
				 */
				const changeDistro = (name) => {
					const next = typeof name === "string" && name.length > 0 ? name : null;
					try {
						if (typeof localStorage !== "undefined") {
							if (next === null) localStorage.removeItem(DISTRO_KEY);
							else localStorage.setItem(DISTRO_KEY, next);
						}
					} catch {}
					api.setDistro(next);
					browseSeq.current += 1;
					if (browseAbort.current !== null) {
						browseAbort.current.abort();
						browseAbort.current = null;
					}
					if (typeof scope.cancelPrefetch === "function") scope.cancelPrefetch();
					dirCache.clear();
					setChosenDistro(next);
					setBrowse({ cwd: null, status: "idle", entries: [], error: null });
					setPathError(null);
					setPathInput("");
					setSearch("");
					actions.load();
				};
				scope.chosenDistro = chosenDistro;
				/** 把某个目标记为默认（只写本面板的 localStorage，不动插件配置）。 */
				const setDefaultDistro = (name) => {
					try {
						if (typeof localStorage !== "undefined") localStorage.setItem(DISTRO_KEY, name);
					} catch {}
					setAction({ busy: null, note: t("targets.defaultSaved", { distro: name }), detail: null, error: null });
				};
				/** 停掉某个目标的守护（destructive ⇒ 走 runDaemon 的二次确认）。 */
				const stopTarget = (name) => {
					actions.runDaemon("stop", undefined, { distro: name });
				};
				scope.onSetDefault = setDefaultDistro;
				scope.onStopTarget = stopTarget;
				/** 「重新扫描本机发行版」= 只重拉快照，不切换目标。 */
				scope.onRescan = () => actions.load({ refresh: true });

				scope.onDistroChange = changeDistro;
				/**
				 * 记住的发行版被删/改名时：host 回"未知发行版" ⇒ 退回缺省目标重试一次（不循环）。
				 *
				 * ★ F-39（task-8）：判据从**中文子串匹配**（`message.indexOf("未知发行版")`）改成
				 * 错误体里的机器可读 `reason`（host explorer.ts 的 `failArg(..., 'unknown-distro')`）。
				 * 旧写法有两个问题：英文界面/文案改动即失效；且把"文案"当契约（docs/client-contract 的漂移源）。
				 */
				const distroResetRef = React.useRef(false);
				React.useEffect(() => {
					if (state.status !== "error" || chosenDistro === null || distroResetRef.current) return;
					const body = state.error && state.error.detail;
					if (!body || body.reason !== "unknown-distro") return;
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
		export { createPanel };
		Object.defineProperty(exports, "openSessionNote", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.openSessionNote) });
		Object.defineProperty(exports, "addWorkspaceNote", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.addWorkspaceNote) });
		Object.defineProperty(exports, "addWorkspaceErrorText", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.addWorkspaceErrorText) });
		Object.defineProperty(exports, "splitHumanText", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.splitHumanText) });
		Object.defineProperty(exports, "daemonNote", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.daemonNote) });
		Object.defineProperty(exports, "RECENT_KEY", { enumerable: true, get: () => (parts === null ? undefined : parts.helpers.RECENT_KEY) });

		export { whenReady };
