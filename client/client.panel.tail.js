/**
 * client.panel.tail.js —— 最近目录 + 诊断折叠区 + 二次确认 + 底栏与 ⋯ 菜单 + 根元素（返回根元素）
 *
 * T41 机械拆分（生成器 `arch-t6/tools/gen-split2.mjs`，从拆分前备份整块切片）：
 * 被搬动的代码体**逐字不变**；只在本函数开头把上游名字解构回同名局部（显式清单，非正则猜）。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.tail.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");


function renderTail(props) {
			const {
	HIDE_UPDATED_PX, NARROW_PX, RECENT_KEY, RECENT_MAX,
	React, StatusDot, action, actionAbort,
	actionFailure, actionFailureText, activeDistro, addWorkspaceErrorText,
	addWorkspaceNote, api, asArray, body,
	breadcrumbOf, browse, browseAbort, browseSeq,
	cancelRef, clock, closeMenu, collapsed,
	ctx, cwd, cwdDiffersFromTarget, daemon,
	chosenDistro, daemonKnown, daemonNote, daemonSlot, distros,
	drift, driftKnown, errorText, factsVisible, onDistroChange,
	focusIndex, forceLocale, headerButtons, hiddenCount,
	hideUpdated, homePathOf, icon, isRecord,
	joinWslPath, jumpTo, keys, keysKnown,
	lastRun, listPath, load, menuOpen,
	menuRef, moreRef, mounts, mountsCache,
	mountsProbed, narrow, newAbortController, normalizeWslPath,
	onMenuKey, openSessionNote, others, pathError,
	pathInput, pending, pendingFrom, primaryBusyKey,
	primaryIsSession, pushRecent, readAbort, readRecent,
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

			/** 目标发行版选择器：多发行版才出下拉；单发行版给静态徽标（不摆一个只有一项的死控件）。 */
			const distroRows = distros.filter((row) => isRecord(row) && typeof row.name === "string");
			const multiDistro = distroRows.length > 1;
			const activeDistroValue =
				typeof target.distro === "string" && target.distro.length > 0 ? target.distro : chosenDistro;
			const distroControl = multiDistro
				? React.createElement(
					"select",
					{
						className: "dsh-rw-select",
						value: activeDistroValue === null ? "" : activeDistroValue,
						"aria-label": t("header.distroField"),
						title: t("header.distroSwitchTitle"),
						onChange: (event) => onDistroChange(event.target.value),
					},
					distroRows.map((row) =>
						React.createElement(
							"option",
							{ key: row.name, value: row.name },
							t("header.distroOption", {
								distro: row.name,
								state: row.reachable === true ? t("header.distroRunning") : t("header.distroStopped"),
							}),
						),
					),
				)
				: React.createElement(
					"span",
					{ className: "dsh-rw-hint", title: t("header.distroOnlyTitle") },
					t("header.distroOnly", { distro: activeDistroValue === null ? "?" : activeDistroValue }),
				);

				// —— 折叠区：高级 / 诊断（默认收起；收起时内部完全不渲染 ⇒ 不可 Tab 到达） ——
				if (factsVisible && snapshot !== null) {
					const open = collapsed.advanced === true;
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
								React.createElement("div", { className: "dsh-rw-hint" }, t("advanced.daemon", { slot: daemonSlot === null ? "?" : daemonSlot, pid: typeof daemon.pid === "number" ? daemon.pid : "?" })),
								driftKnown && drift.drifted === true ? React.createElement("div", { className: "dsh-rw-hint" }, t("advanced.drift")) : null,
							),
						);
						children.push(React.createElement("pre", { key: "raw", className: "dsh-rw-pre" }, JSON.stringify(snapshot, null, 2)));
					}
					body.push(
						React.createElement(
							"details",
							{ key: "advanced", className: "dsh-rw-fold", open, onToggle: (event) => setCollapsed((prev) => ({ ...prev, advanced: event.currentTarget.open === true })) },
							React.createElement("summary", null, icon(open ? "chevronUp" : "chevronRight"), t("raw.summary")),
							open ? React.createElement("div", { className: "dsh-rw-foldbody" }, children) : null,
						),
					);
				}

				// —— 二次确认（内联在 body 内；破坏性动作只从 ⋯ 菜单进） ——
				if (pending !== null) {
					const isStop = pending.action === "stop";
					body.push(
						React.createElement(
							"div",
							{ key: "confirm", className: "dsh-rw-confirm", role: "alertdialog", "aria-modal": "true", "aria-label": isStop ? t("confirm.stopTitle") : t("confirm.restartTitle") },
							React.createElement("div", { className: "dsh-rw-confirm-title" }, icon("error"), isStop ? t("confirm.stopTitle") : t("confirm.restartTitle")),
							React.createElement("div", { className: "dsh-rw-confirm-body" }, t("confirm.body", { distro: activeDistro === null ? "?" : activeDistro, count: pending.sessions, consequence: isStop ? t("confirm.stopConsequence") : t("confirm.restartConsequence") })),
							React.createElement(
								"div",
								{ className: "dsh-rw-confirm-actions" },
								React.createElement(
									"button",
									{
										ref: cancelRef,
										type: "button",
										className: "dsh-rw-btn",
										onClick: () => {
											setPending(null);
											if (pendingFrom.current !== null) pendingFrom.current.focus();
										},
									},
									t("confirm.cancel"),
								),
								React.createElement(
									"button",
									{
										type: "button",
										className: "dsh-rw-btn dsh-rw-btn--danger",
										"aria-label": t("confirm.okAria", { verb: isStop ? t("confirm.verbStop") : t("confirm.verbRestart") }),
										onClick: () => {
											const asked = pending;
											setPending(null);
											run(
												`daemon:${asked.action}`,
												(signal) => api.daemon({ action: asked.action, slot: asked.slot }, signal),
												{ describe: (result) => daemonNote(t, isStop ? t("daemon.stopped") : t("daemon.restarted"), result), refresh: true, failKey: isStop ? "note.failStop" : "note.failRestart" },
											);
										},
									},
									isStop ? t("confirm.okStop") : t("confirm.okRestart"),
								),
							),
						),
					);
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
											? navigator.clipboard.writeText(JSON.stringify(state.snapshot === null ? {} : state.snapshot, null, 2))
											: Promise.reject(new Error(t("row.copyNoClipboard"))),
									{ describe: () => t("menu.copied") },
								);
							},
						},
					],
				});

				return React.createElement(
					"section",
					{ className: "dsh-rw-root", "data-dsh-remote-wsl": "panel", ref: rootRef },
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
							factsVisible
								? React.createElement(
										"span",
										{ className: "dsh-rw-header-meta" },
										React.createElement("span", { className: "dsh-rw-badge" }, t("row.notMaterialized")),
										distroControl,
									)
								: null,
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
						{ className: "dsh-rw-status", role: "status", "aria-live": "polite" },
						React.createElement(StatusDot, { kind: stateKind }),
						React.createElement("span", { className: "dsh-rw-statusword" }, statusWord),
						drifted ? React.createElement(React.Fragment, null, icon("warn", "dsh-rw-drift"), React.createElement("span", { className: "dsh-rw-statusword" }, t("status.drifted"))) : null,
						extra.length > 0 ? React.createElement("span", { className: "dsh-rw-extra" + (narrow ? " dsh-rw-extra--hidden" : "") }, " · ", extra) : null,
						React.createElement("span", { className: "dsh-rw-spacer" }),
						factsVisible && daemonKnown && daemon.running !== true
							? React.createElement(
									"button",
									{ type: "button", className: "dsh-rw-btn", disabled: action.busy !== null, onClick: () => runDaemon("ensure"), "aria-label": t("status.startAria"), title: t("status.startAria") },
									// T63：窄态换短文案「启动」（4 个 CJK 需 ~52px > 底栏能给的 49px ⇒ 会折成两行）
									action.busy === "daemon:ensure" ? t("status.startBusy") : narrow ? t("status.startShort") : t("status.start"),
								)
							: null,
						updated !== null && !hideUpdated ? React.createElement("span", { className: "dsh-rw-updated" }, updated) : null,
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

		exports.renderTail = renderTail;

		return module.exports;
	},
});
