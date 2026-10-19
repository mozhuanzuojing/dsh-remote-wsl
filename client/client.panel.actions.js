/**
 * client.panel.actions.js —— 面板动作层：load/run/listPath/jumpTo/submitPath/键盘与文档事件/菜单/守护动作（自定义 hook，无渲染）
 *
 * T41 机械拆分（生成器 `arch-t6/tools/gen-split2.mjs`，从拆分前备份整块切片）：
 * 被搬动的代码体**逐字不变**；只在本函数开头把上游名字解构回同名局部（显式清单，非正则猜）。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.actions.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");


/**
 * `/mnt` 盘符探测缓存：**chunk 模块作用域**（切面板不重复探测）。
 *
 * ★ 2026-10-19 修缺陷：原实现把缓存放在 helpers 的 `exports.mountsCache`（值拷贝，永远是 null），
 * 又在 hook 里对它赋值 ⇒ `TypeError: Assignment to constant variable`（解构出来是 const）。
 * 异常发生在 promise 的 then 里 ⇒ 被吞成 unhandled rejection，表现是 `/mnt` 下的盘符 chip 永远不出现
 * （实测：`window.__harness.errors` 抓到 actions.js:222）。改为模块级 `let`，赋值合法且跨挂载仍缓存。
 */
let mountsCache = null;

/**
 * 自动刷新：**只**在窗口重新可见/获得焦点时做一次（不轮询、不后台常驻计时器）。
 * 上次成功超过 60s 才刷 ⇒ 切回来看到的是新状态，又不会每次切窗口都打 host（snapshot 有 ~7 次 wsl.exe）。
 */
const AUTO_REFRESH_STALE_MS = 60000;

/** 只在组件内调用（自定义 hook）。自由变量从 props 解构回同名局部 ⇒ 代码体逐字不变。 */
function usePanelActions(props) {
			const {
	HIDE_UPDATED_PX, NARROW_PX, RECENT_KEY, RECENT_MAX,
	React, StatusDot, action, actionAbort,
	actionFailure, actionFailureText, addWorkspaceErrorText, addWorkspaceNote,
	api, asArray, breadcrumbOf, browse,
	browseAbort, browseSeq, cancelRef, clock,
	collapsed, ctx, daemonNote, errorText,
	focusIndex, forceLocale, homePathOf, i18nSubscribe,
	icon, isRecord, joinWslPath, lastRun,
	menuOpen, menuRef, moreRef, mounts,
	mountsProbed, newAbortController, normalizeWslPath, dirCache, filterEntries, sortEntries, search, setSearch,
	openSessionNote, pathError, pathInput, pending,
	pendingFrom, pushRecent, readAbort, readRecent,
	readSeq, recent, recentOk, rootRef,
	setAction, setBrowse, setCollapsed, setFocusIndex,
	setMenuOpen, setMounts, setPathError, setPathInput,
	setPending, setRecent, setRecentOk, setShowHidden,
	setSlow, setState, setWidth, showHidden,
	signalOf, slow, splitFirstSentence, splitHumanText,
	state, t, width,
	listPath, jumpTo, submitPath, clearSearch, prefetchDir, cancelPrefetch, navSeq,
			} = props;

				const load = React.useCallback(
					(options) => {
						const mySeq = readSeq.current + 1;
						readSeq.current = mySeq;
						if (readAbort.current !== null) {
							readAbort.current.abort();
							readAbort.current = null;
						}
						const controller = newAbortController();
						readAbort.current = controller;
						const navAtStart = navSeq.current; // 本次刷新发起时的导航代次（见 F2：延迟到达的刷新不得覆盖更新的导航）
						setState((prev) => ({ ...prev, status: "loading", error: null }));
						setSlow(false);
						const slowTimer = setTimeout(() => setSlow(true), 3000);
						// M8：刷新同时刷"远端信息"和"当前目录列表"，两者都成功才更新戳记
						const wanted = options && typeof options.path === "string" ? normalizeWslPath(options.path) : null;
						const alsoList =
							options && options.alsoList === true && wanted !== null ? api.listDir({ path: wanted }, signalOf(controller)) : Promise.resolve(null);
						// 快照与"目录复核"**分开结算**：远端快照成功、只是列目录失败时，
						// 不该把整块事实撤成错误页（那会让用户丢掉正在看的目录）⇒ 保留列表并标 stale。
						Promise.allSettled([api.snapshot(signalOf(controller)), alsoList]).then(
							(results) => {
								if (mySeq !== readSeq.current) return;
								clearTimeout(slowTimer);
								const [snapResult, listResult] = results;
								if (snapResult.status === "rejected") {
									const error = snapResult.reason;
									if (error && error.kind === "aborted") return;
									setAction((prev) => (prev.note === null ? prev : { ...prev, note: null, detail: null }));
									setState((prev) => ({ ...prev, status: "error", error, lastFailureAt: new Date() }));
									return;
								}
								const snapshot = snapResult.value;
								setState({ status: "ready", snapshot, error: null, lastSuccessAt: new Date(), lastFailureAt: null });
								if (listResult.status === "fulfilled" && listResult.value !== null && listResult.value !== undefined) {
									const entries = asArray(listResult.value && listResult.value.entries).filter((entry) => isRecord(entry) && typeof entry.name === "string");
									// 刷新结果同样进缓存：刷新后"返回上一目录"仍是瞬时回显
									if (wanted !== null) dirCache.set(wanted, entries);
									// ★ F2：只在此后没有发生新导航时写列表。缓存命中路径是同步 setBrowse、不会再有 promise 纠正，
									// 若这里无条件覆盖，会把用户刚点进去的目录换回旧目录（实测 3s 后仍不自愈）。
									if (navSeq.current === navAtStart) setBrowse({ status: "ready", cwd: wanted, entries, error: null, stale: false });
									return;
								}
								if (listResult.status === "rejected" && wanted !== null) {
									const error = listResult.reason;
									if (error && error.kind === "aborted") return;
									if (navSeq.current === navAtStart) setBrowse((prev) => {
										if (prev.cwd === wanted && prev.entries.length > 0) return { status: "ready", cwd: wanted, entries: prev.entries, error, stale: true };
										return { status: "error", cwd: wanted, entries: [], error, stale: false };
									});
								}
							},
						);
					},
					[],
				);

				React.useEffect(() => {
					load();
					return () => {
						readSeq.current += 1;
						if (readAbort.current !== null) readAbort.current.abort();
						if (actionAbort.current !== null) actionAbort.current.abort();
						if (browseAbort.current !== null) browseAbort.current.abort();
					};
				}, []);

				const run = React.useCallback(
					(busyKey, operation, options) => {
						lastRun.current = { busyKey, operation, options };
						if (actionAbort.current !== null) actionAbort.current.abort();
						const controller = newAbortController();
						actionAbort.current = controller;
						setAction({ busy: busyKey, note: null, detail: null, error: null });
						return Promise.resolve()
							.then(() => operation(signalOf(controller)))
							.then(
								(result) => {
									if (controller !== null && controller.signal.aborted) return null;
									if (isRecord(result) && result.ok === false) {
										const failure = actionFailure(t, result, options && options.failKey);
										setAction({ busy: null, note: null, detail: failure.detail, error: { message: failure.text } });
										if (options && options.refresh) load({ alsoList: true });
										return result;
									}
									const described = options && options.describe ? options.describe(result) : t("note.done");
									const text = typeof described === "string" ? described : described && typeof described.text === "string" ? described.text : t("note.done");
									const detail = typeof described === "object" && described !== null && typeof described.detail === "string" ? described.detail : null;
									setAction({ busy: null, note: text, detail, error: null });
									if (options && options.refresh) load({ alsoList: true });
									return result;
								},
								(error) => {
									if (controller !== null && controller.signal.aborted) return null;
									if (error && error.kind === "aborted") return null;
									const message = options && options.describeError ? options.describeError(error) : errorText(error);
									setAction({ busy: null, note: null, detail: null, error: { message } });
									return null;
								},
							);
					},
					[load, t],
				);

				const snapshot = state.snapshot;
				const factsVisible = state.status === "ready" || (state.status === "loading" && snapshot !== null && state.lastFailureAt === null);
				const distros = asArray(snapshot && snapshot.distros);
				const target = isRecord(snapshot && snapshot.target) ? snapshot.target : {};
				const daemonKnown = isRecord(snapshot && snapshot.daemon);
				const daemon = daemonKnown ? snapshot.daemon : null;
				const keysKnown = daemonKnown && Array.isArray(daemon.keys);
				const keys = keysKnown ? daemon.keys : [];
				const daemonSlot = daemonKnown && typeof daemon.slot === "number" ? daemon.slot : null;
				const others = daemonKnown && Array.isArray(daemon.others) ? daemon.others.filter((row) => isRecord(row)) : [];
				const driftKnown = isRecord(snapshot && snapshot.drift);
				const drift = driftKnown ? snapshot.drift : null;
				const activeDistro =
					(distros.find((row) => isRecord(row) && row.name === (typeof target.distro === "string" ? target.distro : "")) || {}).name ||
					(distros.find((row) => isRecord(row) && row.default === true) || {}).name ||
					(distros[0] && distros[0].name) ||
					null;

				const narrow = width < NARROW_PX;
				const hideUpdated = width < HIDE_UPDATED_PX;
				const cwd = browse.cwd;
				const cwdDiffersFromTarget = cwd !== null && typeof target.cwd === "string" && cwd !== normalizeWslPath(target.cwd);

				React.useEffect(() => {
					if (state.status !== "ready" || browse.cwd !== null) return;
					const fromTarget = typeof target.distro === "string" && typeof target.cwd === "string" && target.cwd.startsWith("/") ? target.cwd : null;
					const initial = fromTarget === null ? homePathOf(target, null) : normalizeWslPath(fromTarget);
					setPathInput(initial);
					listPath(initial);
					setRecent(pushRecent(initial));
				}, [state.status, browse.cwd, target.cwd, target.distro, listPath]);

				React.useEffect(() => {
					if (state.status !== "ready" || mountsProbed.current) return undefined;
					mountsProbed.current = true;
					if (mountsCache !== null) {
						setMounts(mountsCache);
						return undefined;
					}
					const controller = newAbortController();
					api.listDir({ path: "/mnt" }, signalOf(controller)).then(
						(result) => {
							const letters = asArray(result && result.entries)
								.filter((entry) => isRecord(entry) && entry.kind === "dir" && /^[a-z]$/.test(String(entry.name)))
								.map((entry) => `/mnt/${entry.name}`)
								.sort();
							mountsCache = letters;
							setMounts(letters);
						},
						() => {
							mountsCache = [];
						},
					);
					return () => {
						if (controller !== null) controller.abort();
					};
				}, [state.status]);

				// 自动刷新：窗口重新可见/获得焦点时，若上次成功已超过 60s 则刷一次（只读，不碰守护）。
				// ★ F3：visibilitychange 与 focus 会在同一次切回时**连着**触发 ⇒ 用 ref 立刻写入节流时间戳，
				// 否则两个事件都会通过判断、同一次切回打两遍 snapshot（每次 ~7 次 wsl.exe）。
				const autoRefreshAt = React.useRef(0);
				React.useEffect(() => {
					if (typeof document === "undefined" || typeof window === "undefined") return undefined;
					const maybeRefresh = () => {
						if (document.visibilityState !== "visible") return;
						if (state.status === "loading") return;
						if (Date.now() - autoRefreshAt.current < AUTO_REFRESH_STALE_MS) return;
						const last = state.lastSuccessAt;
						if (last !== null && Date.now() - last.getTime() < AUTO_REFRESH_STALE_MS) return;
						autoRefreshAt.current = Date.now();
						load();
					};
					document.addEventListener("visibilitychange", maybeRefresh);
					window.addEventListener("focus", maybeRefresh);
					return () => {
						document.removeEventListener("visibilitychange", maybeRefresh);
						window.removeEventListener("focus", maybeRefresh);
					};
				}, [state.status, state.lastSuccessAt, load]);

				// 确认层：焦点进"取消"（更安全的默认），Esc 取消并把焦点还原给触发元素
				React.useEffect(() => {
					if (pending === null) return undefined;
					if (cancelRef.current !== null) cancelRef.current.focus();
					const onKey = (event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							setPending(null);
							if (pendingFrom.current !== null) pendingFrom.current.focus();
						}
					};
					const node = rootRef.current;
					if (node !== null) node.addEventListener("keydown", onKey);
					return () => {
						if (node !== null) node.removeEventListener("keydown", onKey);
					};
				}, [pending]);

				const closeMenu = React.useCallback((viaEscape) => {
					setMenuOpen(false);
					if (viaEscape === true && moreRef.current !== null) moreRef.current.focus();
				}, []);

				React.useEffect(() => {
					if (!menuOpen) return undefined;
					const onDoc = (event) => {
						if (rootRef.current !== null && !rootRef.current.contains(event.target)) setMenuOpen(false);
					};
					document.addEventListener("click", onDoc, true);
					// ★ F5：菜单打开后焦点必须进第一项，否则 Esc 的 keydown 落在触发按钮上、菜单关不掉
					const raf = window.requestAnimationFrame(() => {
						const node = menuRef.current === null ? null : menuRef.current.querySelector('[role="menuitem"]:not([disabled])');
						if (node !== null) node.focus();
					});
					const onKey = (event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							closeMenu(true);
						}
					};
					document.addEventListener("keydown", onKey, true);
					return () => {
						window.cancelAnimationFrame(raf);
						document.removeEventListener("click", onDoc, true);
						document.removeEventListener("keydown", onKey, true);
					};
				}, [menuOpen]);

				// 排序（目录优先 + 名称升序）与过滤都在客户端做：host 一次返回全部条目 ⇒ 敲字即时、不重发请求
				const orderedEntries = sortEntries(browse.entries);
				const visibleEntries = filterEntries(orderedEntries, showHidden, search);
				const totalEntries = orderedEntries.length;
				const hiddenCount = orderedEntries.filter((entry) => entry.hidden === true).length;
				const searching = String(search).trim().length > 0;
				/** 筛选变化：重置键盘游标（旧 index 在新列表里已无意义）。 */
				const searchChange = React.useCallback(
					(value) => {
						setSearch(typeof value === "string" ? value : String(value));
						setFocusIndex(-1);
					},
					[setSearch],
				);

				const onMenuKey = (event) => {
					const items = [...(menuRef.current === null ? [] : menuRef.current.querySelectorAll('[role="menuitem"]:not([disabled])'))];
					if (items.length === 0) return;
					if (event.key === "Escape") {
						event.preventDefault();
						closeMenu(true);
						return;
					}
					if (event.key === "Tab") {
						setMenuOpen(false);
						return;
					}
					if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
						event.preventDefault();
						const current = items.indexOf(document.activeElement);
						let next;
						if (event.key === "Home") next = 0;
						else if (event.key === "End") next = items.length - 1;
						else next = (current < 0 ? 0 : current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
						items[next].focus();
					}
				};

				const runDaemon = (kind, fromElement) => {
					setMenuOpen(false);
					if (kind === "stop" || kind === "restart") {
						pendingFrom.current = fromElement === undefined ? null : fromElement;
						setPending({ action: kind, slot: daemonSlot, sessions: keysKnown ? keys.length : "?" });
						return;
					}
					run("daemon:ensure", (signal) => api.daemon({ action: "ensure" }, signal), { describe: (result) => daemonNote(t, t("daemon.started"), result), refresh: true, failKey: "note.failStart" });
				};

			return {
	activeDistro, closeMenu, cwd, cwdDiffersFromTarget,
	daemon, daemonKnown, daemonSlot, distros,
	drift, driftKnown, factsVisible, hiddenCount,
	hideUpdated, jumpTo, keys, keysKnown,
	listPath, load, narrow, onMenuKey,
	others, run, runDaemon, snapshot,
	submitPath, target, totalEntries, visibleEntries, searching,
	cancelPrefetch, prefetchDir, searchChange,
			};
}

		exports.usePanelActions = usePanelActions;

		return module.exports;
	},
});