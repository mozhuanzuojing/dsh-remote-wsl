import React from 'react';

		// 官方 UI 原语（经 dsh.client.inject 注入）；不可用时回退本地实现
		let UI = (typeof window !== "undefined" && window.__dshRwUI) ? window.__dshRwUI : null;
		if (UI === null) { try { UI = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { UI = null; } }


function renderTail(props) {
			const {
	HIDE_UPDATED_PX, NARROW_PX, RECENT_KEY, RECENT_MAX,
	React, StatusDot, action, actionAbort,
	actionFailure, actionFailureText, activeDistro, addWorkspaceErrorText,
	addWorkspaceNote, api, asArray, body,
	breadcrumbOf, browse, browseAbort, browseSeq,
	cancelRef, clock, closeMenu, collapsed,
	ctx, cwd, cwdDiffersFromTarget, daemon,
	chosenDistro, daemonKnown, daemonNote, daemonPill, daemonSlot, distros,
	drift, driftKnown, errorText, factsVisible, onDistroChange,
	focusIndex, forceLocale, headerButtons, hiddenCount,
	hideUpdated, homePathOf, icon, isRecord,
	joinWslPath, jumpTo, keys, keysKnown,
	lastRun, listPath, load, menuOpen,
	menuRef, moreRef, mounts, mountsCache,
	mountsProbed, narrow, newAbortController, normalizeWslPath,
	onMenuKey, onSetDefault, openSessionNote, others, pathError,
	// F-39：键盘/可访问性原语来自 client.panel.a11y.js（menu 键盘模型 / alertdialog 焦点陷阱 / details 开合）
	trapTab, menuKeyNav, closeChipMenu,
	pathInput, pending, pendingFrom, primaryBusyKey,
	primaryIsSession, proxyBadge, pushRecent, readAbort, readRecent,
	readSeq, recent, recentOk, rootRef,
	run, runDaemon, setAction, setBrowse,
	setCollapsed, setFocusIndex, setMenuOpen, setMounts,
	setPathError, setPathInput, setPending, setRecent,
	setRecentOk, setShowHidden, setSlow, setState,
	setWidth, showHidden, signalOf, slow,
	snapshot, splitFirstSentence, splitHumanText, state,
	submitPath, t, target, visibleEntries,
	width,
			} = props;
			/** 诊断文本的统一脱敏出口（F-37）：优先用 api.redactSecrets；缺省退化为原样（老 api stub 也能渲染）。 */
			const redact = (text) => (typeof api.redactSecrets === "function" ? api.redactSecrets(text) : String(text === null || text === undefined ? "" : text));
			/** 状态点：官方 StateDot 可用则用之（映射本面板 kind），否则回退 StatusDot。 */
			const Dot = (UI !== null && UI.StateDot != null)
				? function (dp) { const k = dp && dp.kind; return React.createElement(UI.StateDot, { state: k === "running" ? "done" : k === "error" ? "error" : "idle" }); }
				: StatusDot;


				// —— 折叠区：高级 / 诊断（默认收起；收起时内部完全不渲染 ⇒ 不可 Tab 到达） ——
				if (factsVisible && snapshot !== null) {
					const open = collapsed.advanced === true;
					const proxy = snapshot !== null && snapshot.proxy !== null && typeof snapshot.proxy === "object" ? snapshot.proxy : null;
					const children = [];
					if (open) {
						if (others.length > 0) {
							children.push(
								React.createElement(
									"div",
									{ key: "others", className: "dsh-rw-readonly" },
									React.createElement("div", { className: "dsh-rw-readonly-head" }, icon("lock"), t("others.title")),
									others.map((row, index) =>
										React.createElement(
											"div",
											{ key: `other:${row.slot === undefined || row.slot === null ? index : row.slot}`, className: "dsh-rw-other" },
											icon("lock"),
											t("others.item", { slot: row.slot === undefined || row.slot === null ? "?" : row.slot, state: t("others.stateRunning") }),
										),
									),
								),
							);
						}
						children.push(
							React.createElement(
								"div",
								{ key: "facts", className: "dsh-rw-readonly" },
								React.createElement("div", { className: "dsh-rw-readonly-head" }, t("advanced.title")),
								React.createElement("div", { className: "dsh-rw-hint" }, t("advanced.distro", { distro: activeDistro === null ? "?" : activeDistro })),
								React.createElement("div", { className: "dsh-rw-hint" }, t("advanced.daemon", { slot: daemonSlot === null ? "?" : daemonSlot, pid: daemon !== null && typeof daemon.pid === "number" ? daemon.pid : "?", version: daemon !== null && typeof daemon.version === "string" && daemon.version.length ? daemon.version : "?" })),
								proxy === null
									? null
									: React.createElement("div", { className: "dsh-rw-hint" }, t("advanced.proxy", {
											host: proxy.host === null || proxy.host === undefined ? "?" : proxy.host,
											port: proxy.port === null || proxy.port === undefined ? "?" : proxy.port,
											state:
												proxy.reachable === true
													? t("advanced.proxyUp")
													: proxy.reachable === false
														? t("advanced.proxyDown")
														: t("advanced.proxyUnknown"),
										})),
								driftKnown && drift.drifted === true ? React.createElement("div", { className: "dsh-rw-hint" }, t("advanced.drift")) : null,
							),
						);
						// ★ F-37：渲染出口也脱敏（host 已脱敏一次；这里保证任何来源的 URL 字段都不会把 token 带进 DOM）
						children.push(React.createElement("pre", { key: "raw", className: "dsh-rw-pre" }, redact(JSON.stringify(snapshot, null, 2))));
					}
					body.push(
						React.createElement(
							"details",
							{ key: "advanced", className: "dsh-rw-fold", open, onToggle: (event) => { const open = event.currentTarget.open === true; setCollapsed((prev) => ({ ...prev, advanced: open })); } },
							React.createElement("summary", null, icon(open ? "chevronUp" : "chevronRight"), t("raw.summary")),
							open ? React.createElement("div", { className: "dsh-rw-foldbody" }, children) : null,
						),
					);
				}

				// —— 二次确认（内联在 body 内；破坏性动作只从 ⋯ 菜单进） ——
				if (pending !== null) {
					const isStop = pending.action === "stop";
					const confirmTitle = isStop ? t("confirm.stopTitle") : t("confirm.restartTitle");
					const confirmBody = t("confirm.body", {
						distro: typeof pending.distro === "string" && pending.distro.length > 0 ? pending.distro : activeDistro === null ? "?" : activeDistro,
						count: typeof pending.distro === "string" && pending.distro.length > 0 && pending.distro !== activeDistro ? "?" : pending.sessions,
						consequence: isStop ? t("confirm.stopConsequence") : t("confirm.restartConsequence"),
					});
					const CBtn = (UI !== null && UI.Button != null) ? UI.Button : null;
					const cancelBtn = CBtn !== null ? React.createElement(CBtn, { variant: "outline", "aria-label": t("confirm.cancelAria", { verb: isStop ? t("confirm.verbStop") : t("confirm.verbRestart") }), onClick: () => { setPending(null); if (pendingFrom.current !== null) pendingFrom.current.focus(); } }, t("confirm.cancel")) : React.createElement("button", { ref: cancelRef, type: "button", "aria-label": t("confirm.cancelAria", { verb: isStop ? t("confirm.verbStop") : t("confirm.verbRestart") }), className: "dsh-rw-btn", onClick: () => { setPending(null); if (pendingFrom.current !== null) pendingFrom.current.focus(); } }, t("confirm.cancel"));
					const okBtn = CBtn !== null ? React.createElement(CBtn, { variant: "primary", "aria-label": t("confirm.okAria", { verb: isStop ? t("confirm.verbStop") : t("confirm.verbRestart") }), onClick: () => { const asked = pending; setPending(null); run(`daemon:${asked.action}`, (signal) => api.daemon(Object.assign({ action: asked.action, slot: asked.slot }, typeof asked.distro === "string" && asked.distro.length > 0 ? { distro: asked.distro } : {}), signal), { describe: (result) => daemonNote(t, isStop ? t("daemon.stopped") : t("daemon.restarted"), result), refresh: true, failKey: isStop ? "note.failStop" : "note.failRestart" }); } }, isStop ? t("confirm.okStop") : t("confirm.okRestart")) : React.createElement("button", { type: "button", className: "dsh-rw-btn dsh-rw-btn--danger", "aria-label": t("confirm.okAria", { verb: isStop ? t("confirm.verbStop") : t("confirm.verbRestart") }), onClick: () => { const asked = pending; setPending(null); run(`daemon:${asked.action}`, (signal) => api.daemon(Object.assign({ action: asked.action, slot: asked.slot }, typeof asked.distro === "string" && asked.distro.length > 0 ? { distro: asked.distro } : {}), signal), { describe: (result) => daemonNote(t, isStop ? t("daemon.stopped") : t("daemon.restarted"), result), refresh: true, failKey: isStop ? "note.failStop" : "note.failRestart" }); } }, isStop ? t("confirm.okStop") : t("confirm.okRestart"));
					if (UI !== null && UI.Modal != null) {
						body.push(React.createElement(UI.Modal, {
							key: "confirm", open: true, tone: "warning", title: confirmTitle, closeLabel: t("confirm.cancel"),
							onClose: () => { setPending(null); if (pendingFrom.current !== null) pendingFrom.current.focus(); },
							footer: React.createElement(React.Fragment, null, cancelBtn, okBtn),
						}, React.createElement("p", { className: "dsh-rw-confirm-body", id: "dsh-rw-confirm-body" }, confirmBody)));
					} else {
						body.push(React.createElement("div", { key: "confirm", className: "dsh-rw-confirm", role: "alertdialog", "aria-label": t("confirm.dialogAria", { verb: isStop ? t("confirm.verbStop") : t("confirm.verbRestart") }), "aria-describedby": "dsh-rw-confirm-body", onKeyDown: trapTab },
							React.createElement("div", { className: "dsh-rw-confirm-title" }, icon("error"), confirmTitle),
							React.createElement("div", { className: "dsh-rw-confirm-body", id: "dsh-rw-confirm-body" }, confirmBody),
							React.createElement("div", { className: "dsh-rw-confirm-actions" }, cancelBtn, okBtn),
						));
					}
				}

				// —— 底栏（一行） ——
				const stateKind = state.status === "error" ? "error" : !daemonKnown || !factsVisible ? "unknown" : daemon.running === true ? "running" : "stopped";
				const statusWord =
					state.status === "error"
						? t("error.title")
						: !factsVisible || !daemonKnown
							? t("status.stateUnknown")
							: daemon.running === true
								? t("status.daemonRunning")
								: t("status.daemonOff");
				const extra = !factsVisible ? t("status.readingExtra") : keysKnown ? t("status.sessions", { count: keys.length }) : "";
				const conflict = others.some((row) => row.slot !== undefined && row.slot !== null && row.slot === daemonSlot);
				const drifted = driftKnown && drift.drifted === true;
				const updated = state.lastSuccessAt === null ? null : t("status.updated", { time: clock(state.lastSuccessAt) });
				let relUpdated = null;
				if (updated !== null && state.lastSuccessAt !== null && UI !== null && typeof UI.relativeTime === "function") {
					const rt = UI.relativeTime(state.lastSuccessAt, Date.now());
					const relKey = rt.unit === "now" ? "status.relNow" : rt.unit === "minutes" ? "status.relMinutes" : rt.unit === "hours" ? "status.relHours" : rt.unit === "days" ? "status.relDays" : rt.unit === "months" ? "status.relMonths" : "status.relYears";
					relUpdated = t(relKey, { n: rt.n });
				}

				const groups = [];
				// T42/N1：`narrow`（<420）时「添加为 WSL 工作区」原本**头部与 ⋯ 菜单双入口**：
				// 头部主按钮在 `!primaryIsSession`（cwd == 目标 cwd）时本身就是该动作 ⇒ 菜单再给一份即重复。
				// 互斥条件：菜单组**只在头部没有提供该动作时**才出现 = `primaryIsSession`（主按钮是"在此目录新建会话"，
				// 而头部那个次按钮被 `!narrow` 挡住了）⇒ 同一动作在主视线永远只出现 1 处。
				if (narrow && primaryIsSession) {
					groups.push({
						key: "workspace",
						label: t("menu.group.workspace"),
						items: [
							{
								key: "addws",
								label: t("action.addWorkspace"),
								iconName: "plus",
								disabled: cwd === null || action.busy !== null,
								onSelect: () => {
									if (cwd === null) return;
									setMenuOpen(false);
									run(`a1:${cwd}`, (signal) => api.addWorkspace({ path: cwd }, signal), {
										describe: (result) => addWorkspaceNote(t, result),
										describeError: (error) => addWorkspaceErrorText(t, error),
										refresh: true,
									});
								},
							},
						],
					});
				}
				groups.push({
					key: "daemon",
					label: t("menu.group.daemon"),
					items: [
						{ key: "restart", label: t("menu.restart"), iconName: "warn", iconClass: "dsh-rw-menuicon--warn", disabled: daemonSlot === null || action.busy !== null, onSelect: (event) => runDaemon("restart", event.currentTarget) },
						{ key: "stop", label: t("menu.stop"), iconName: "error", iconClass: "dsh-rw-menuicon--error", disabled: daemonSlot === null || action.busy !== null, onSelect: (event) => runDaemon("stop", event.currentTarget) },
						// T32/RED-2：底栏在 `factsVisible && 未运行` 时常显「启动守护」；
						// 菜单里**只在底栏不显示时**才补这一项（`!factsVisible`）⇒ 两者互斥，
						// 同一动作在主视线永远只出现 1 处。
						daemonKnown && daemon.running !== true && !factsVisible
							? { key: "start", label: t("status.start"), iconName: "check", disabled: action.busy !== null, onSelect: () => runDaemon("ensure") }
							: null,
					].filter((item) => item !== null),
				});
				groups.push({
					key: "diagnostics",
					label: t("menu.group.diagnostics"),
					items: [
						{
							key: "view",
							label: t("menu.diagnostics"),
							iconName: "file",
							onSelect: () => {
								setMenuOpen(false);
								setCollapsed((prev) => ({ ...prev, advanced: true }));
							},
						},
						{
							key: "copy",
							label: t("menu.copyDiagnostics"),
							iconName: "copy",
							onSelect: () => {
								setMenuOpen(false);
								run(
									"copyDiag",
									() =>
										typeof navigator !== "undefined" && navigator.clipboard
											? navigator.clipboard.writeText(redact(JSON.stringify(state.snapshot === null ? {} : state.snapshot, null, 2)))
											: Promise.reject(new Error(t("row.copyNoClipboard"))),
									{ describe: () => t("menu.copied") },
								);
							},
						},
					],
				});

				return React.createElement(
					"section",
					// 2026-10-22 B2：窄态语义类（面板实宽 <420）。CSS 只在窄态做三处**分档**：
					// 路径行折成两行（否则「显示隐藏」开关被推出卡片、被 overflow:hidden 裁掉）、
					// 目标行允许换行（多发行版徽标把行挤爆）、头部元信息行折行（守护药丸 + 代理徽标）。
					// 为什么不纯靠 @media：面板宽度 ≠ 视口宽度（rail 占 56px），媒体查询量不到面板实宽。
					{ className: "dsh-rw-root" + (narrow ? " dsh-rw-root--narrow" : ""), "data-dsh-remote-wsl": "panel", ref: rootRef, "aria-label": t("panel.title") },
					React.createElement(
						"header",
						{ className: "dsh-rw-header" },
						React.createElement(
							"div",
							{ className: "dsh-rw-header-text" },
							React.createElement("span", { className: "dsh-rw-title" }, t("panel.title")),
							React.createElement(
								"span",
								{ className: "dsh-rw-subtitle", dir: "ltr", title: factsVisible && typeof target.distro === "string" && target.distro ? t("header.target", { distro: target.distro, cwd: typeof target.cwd === "string" ? target.cwd : "" }) : undefined },
								factsVisible && typeof target.distro === "string" && target.distro
									? t("header.target", { distro: target.distro, cwd: typeof target.cwd === "string" && target.cwd ? ` · ${target.cwd}` : "" })
									: state.status === "error"
										? t("header.targetUnknown")
										: t("header.targetPending"),
							),
						),
						React.createElement("div", { className: "dsh-rw-header-actions" }, headerButtons),
					),
					React.createElement(
						"div",
						{ className: "dsh-rw-body" },
						conflict ? React.createElement("div", { className: "dsh-rw-conflict", role: "status" }, icon("warn"), t("others.conflictBanner", { slot: daemonSlot === null ? "?" : daemonSlot })) : null,
						body,
					),
					React.createElement(
						"footer",
						{ className: "dsh-rw-status" },
						/** 底栏「WSL: 发行版」chip：对位 VS Code 的状态栏远程指示器（点开 = 同一组目标动作）。 */
					React.createElement(
						"details",
						{ className: "dsh-rw-tchip" },
						React.createElement(
							"summary",
							{
								className: "dsh-rw-tchip-summary",
								title: t("targets.chipTitle"),
								// 2026-10-22 B2：窄态可见文案缩成「WSL」（3 字母），完整「WSL: 发行版」仍挂在
								// aria-label/title 上 —— 264px 面板里底栏实测差 127px（见 out-render-before.json）。
								"aria-label": t("targets.chip", { distro: activeDistro === null ? "?" : activeDistro }),
							},
							React.createElement(Dot, { kind: stateKind }),
							narrow ? t("targets.chipShort") : t("targets.chip", { distro: activeDistro === null ? "?" : activeDistro }),
						),
						React.createElement(
							"div",
							// ★ F-39：此前这个菜单 only-mouse（role=menu 却没有键盘模型）；Esc 收起并回焦 summary
							{ className: "dsh-rw-menu dsh-rw-menu--up", role: "menu", "aria-label": t("targets.title"), onKeyDown: (event) => (event.key === "Escape" ? (event.preventDefault(), closeChipMenu(event.currentTarget)) : menuKeyNav(event, event.currentTarget)) },
							React.createElement("button", { type: "button", role: "menuitem", className: "dsh-rw-menuitem", onClick: (event) => { closeChipMenu(event.currentTarget); runDaemon("ensure", undefined, { distro: activeDistro }); } }, t("status.start")),
							React.createElement("button", { type: "button", role: "menuitem", className: "dsh-rw-menuitem", onClick: (event) => { closeChipMenu(event.currentTarget); runDaemon("stop", undefined, { distro: activeDistro }); } }, t("targets.stop")),
							React.createElement("button", { type: "button", role: "menuitem", className: "dsh-rw-menuitem", onClick: (event) => { closeChipMenu(event.currentTarget); onSetDefault(activeDistro); } }, t("targets.setDefault")),
						),
					),
					React.createElement(Dot, { kind: stateKind }),
						React.createElement("span", { className: "dsh-rw-statusword", role: "status", "aria-live": "polite" }, statusWord),
						// 2026-10-22 B2：漂移提示在窄态只留 ⚠ 图标（16px，title/aria-label 带「配置已漂移」）——
						// 「配置已漂移」65px + 图标 16px 在 264px 面板里放不进底栏；文字版在宽态保持原样。
						drifted
							? narrow
								? React.createElement("span", { className: "dsh-rw-driftmark", title: t("status.drifted"), "aria-label": t("status.drifted"), role: "img" }, icon("warn", "dsh-rw-drift"))
								: React.createElement(React.Fragment, null, icon("warn", "dsh-rw-drift"), React.createElement("span", { className: "dsh-rw-statusword" }, t("status.drifted")))
							: null,
						extra.length > 0 ? React.createElement("span", { className: "dsh-rw-extra" + (narrow ? " dsh-rw-extra--hidden" : "") }, " · ", extra) : null,
						factsVisible ? React.createElement("span", { className: "dsh-rw-statusitem" }, proxyBadge) : null,
						React.createElement("span", { className: "dsh-rw-spacer" }),
						updated !== null && !hideUpdated ? React.createElement("span", { className: "dsh-rw-updated", title: updated }, relUpdated !== null ? relUpdated : updated) : null,
						React.createElement(
							"button",
							{
								ref: moreRef,
								type: "button",
								className: "dsh-rw-iconbtn",
								"aria-label": t("menu.more"),
								title: t("menu.more"),
								"aria-haspopup": "menu",
								"aria-expanded": String(menuOpen),
								onClick: () => setMenuOpen((prev) => !prev),
							},
							icon("more"),
						),
						menuOpen
							? React.createElement(
									"div",
									{ className: "dsh-rw-menu", role: "menu", "aria-label": t("menu.more"), ref: menuRef, onKeyDown: onMenuKey },
									groups.map((group, groupIndex) => {
										const labelId = `dsh-rw-menu-${group.key}`;
										return React.createElement(
											React.Fragment,
											{ key: group.key },
											groupIndex > 0 ? React.createElement("div", { className: "dsh-rw-menusep", "aria-hidden": "true" }) : null,
											React.createElement(
												"div",
												{ role: "group", "aria-labelledby": labelId, className: "dsh-rw-group" },
												// T53/N4：三组**统一** `aria-labelledby` + 可见组标题（同一个 map 循环，无分组特例）。
												// 标题是普通 `<div id>`：**不加** `role="presentation"` —— 它带了 `tabIndex={-1}`（可聚焦），
												// 按 WAI-ARIA 的 presentational-role 冲突解决规则该 role 会被**忽略**，属误导性 no-op；
												// 且 `docs/panel-visual-spec.md` §7.2.4 明确要求它是普通 `<div id>`。
												// `tabIndex={-1}` 保留：**不进 Tab 序列**（T53 要求"组标题不可聚焦/不进 Tab"）。
												React.createElement("div", { id: labelId, className: "dsh-rw-grouplabel", tabIndex: -1 }, group.label),
												group.items.map((item) =>
													React.createElement(
														"button",
														{
															key: item.key,
															type: "button",
															role: "menuitem",
															className: "dsh-rw-menuitem",
															disabled: item.disabled === true,
															onClick: item.onSelect,
														},
														icon(item.iconName, item.iconClass),
														item.label,
													),
												),
											),
										);
									}),
								)
							: null,
					),
				);
}

		export { renderTail };
