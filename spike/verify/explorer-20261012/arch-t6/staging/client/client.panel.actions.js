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
	mountsCache, mountsProbed, newAbortController, normalizeWslPath,
	openSessionNote, pathError, pathInput, pending,
	pendingFrom, pushRecent, readAbort, readRecent,
	readSeq, recent, recentOk, rootRef,
	setAction, setBrowse, setCollapsed, setFocusIndex,
	setMenuOpen, setMounts, setPathError, setPathInput,
	setPending, setRecent, setRecentOk, setShowHidden,
	setSlow, setState, setWidth, showHidden,
	signalOf, slow, splitFirstSentence, splitHumanText,
	state, t, width,
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
						setState((prev) => ({ ...prev, status: "loading", error: null }));
						setSlow(false);
						const slowTimer = setTimeout(() => setSlow(true), 3000);
						// M8：刷新同时刷"远端信息"和"当前目录列表"，两者都成功才更新戳记
						const wanted = options && typeof options.path === "string" ? normalizeWslPath(options.path) : null;
						const alsoList =
							options && options.alsoList === true && wanted !== null ? api.listDir({ path: wanted }, signalOf(controller)) : Promise.resolve(null);
						Promise.all([api.snapshot(signalOf(controller)), alsoList]).then(
							([snapshot, listed]) => {
								if (mySeq !== readSeq.current) return;
								clearTimeout(slowTimer);
								setState({ status: "ready", snapshot, error: null, lastSuccessAt: new Date(), lastFailureAt: null });
								if (listed !== null && listed !== undefined) {
									const entries = asArray(listed && listed.entries).filter((entry) => isRecord(entry) && typeof entry.name === "string");
									setBrowse({ status: "ready", cwd: wanted, entries, error: null });
								}
							},
							(error) => {
								if (mySeq !== readSeq.current) return;
								clearTimeout(slowTimer);
								if (error && error.kind === "aborted") return;
								setAction((prev) => (prev.note === null ? prev : { ...prev, note: null, detail: null }));
								setState((prev) => ({ ...prev, status: "error", error, lastFailureAt: new Date() }));
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

				const listPath = React.useCallback((path) => {
					const want = normalizeWslPath(path);
					const mySeq = browseSeq.current + 1;
					browseSeq.current = mySeq;
					if (browseAbort.current !== null) browseAbort.current.abort();
					const controller = newAbortController();
					browseAbort.current = controller;
					setBrowse((prev) => ({ status: "loading", cwd: want, entries: prev.cwd === want ? prev.entries : [], error: null }));
					api.listDir({ path: want }, signalOf(controller)).then(
						(result) => {
							if (mySeq !== browseSeq.current) return;
							const entries = asArray(result && result.entries).filter((entry) => isRecord(entry) && typeof entry.name === "string");
							setBrowse({ status: "ready", cwd: want, entries, error: null });
						},
						(error) => {
							if (mySeq !== browseSeq.current) return;
							if (error && error.kind === "aborted") return;
							setBrowse({ status: "error", cwd: want, entries: [], error });
						},
					);
				}, []);

				const jumpTo = React.useCallback(
					(path) => {
						const want = normalizeWslPath(path);
						setPathInput(want);
						setPathError(null);
						setFocusIndex(-1);
						listPath(want);
						setRecent(pushRecent(want));
					},
					[listPath],
				);

				const submitPath = React.useCallback(() => {
					const raw = String(pathInput).trim();
					if (raw.length === 0) {
						setPathError(t("browser.pathRequired"));
						return;
					}
					if (!raw.startsWith("/")) {
						setPathError(t("browser.pathNotAbsolute", { raw }));
						return;
					}
					jumpTo(raw);
				}, [jumpTo, pathInput, t]);

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
					return () => document.removeEventListener("click", onDoc, true);
				}, [menuOpen]);

				const visibleEntries = browse.entries.filter((entry) => showHidden || entry.hidden !== true);
				const hiddenCount = browse.entries.filter((entry) => entry.hidden === true).length;

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
	submitPath, target, visibleEntries,
			};
}

		exports.usePanelActions = usePanelActions;

		return module.exports;
	},
});
