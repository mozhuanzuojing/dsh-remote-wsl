/**
 * client.panel.header.js —— 头部按钮组 + 动作结果/加载/错误三块（把元素 push 进共享的 body 数组）
 *
 * T41 机械拆分（生成器 `arch-t6/tools/gen-split2.mjs`，从拆分前备份整块切片）：
 * 被搬动的代码体**逐字不变**；只在本函数开头把上游名字解构回同名局部（显式清单，非正则猜）。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.header.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");


function renderHeader(props) {
			const {
	HIDE_UPDATED_PX, NARROW_PX, RECENT_KEY, RECENT_MAX,
	React, StatusDot, action, actionAbort,
	actionFailure, actionFailureText, activeDistro, addWorkspaceErrorText,
	addWorkspaceNote, api, asArray, body,
	breadcrumbOf, browse, browseAbort, browseSeq,
	cancelRef, clock, closeMenu, collapsed,
	ctx, cwd, cwdDiffersFromTarget, daemon,
	daemonKnown, daemonNote, daemonSlot, distros,
	drift, driftKnown, errorText, factsVisible,
	focusIndex, forceLocale, hiddenCount, hideUpdated,
	homePathOf, icon, isRecord, joinWslPath,
	jumpTo, keys, keysKnown, lastRun,
	listPath, load, menuOpen, menuRef,
	moreRef, mounts, mountsCache, mountsProbed,
	narrow, newAbortController, normalizeWslPath, onMenuKey,
	openSessionNote, others, pathError, pathInput,
	pending, pendingFrom, pushRecent, readAbort,
	readRecent, readSeq, recent, recentOk,
	rootRef, run, runDaemon, setAction,
	setBrowse, setCollapsed, setFocusIndex, setMenuOpen,
	setMounts, setPathError, setPathInput, setPending,
	setRecent, setRecentOk, setShowHidden, setSlow,
	setState, setWidth, showHidden, signalOf,
	slow, snapshot, splitFirstSentence, splitHumanText,
	state, submitPath, t, target,
	visibleEntries, width,
			} = props;

				const headerButtons = [];
				/** 主按钮身份：cwd ≠ 目标 cwd 时是"在此目录新建会话"，否则是"添加为工作区"。 */
				const primaryIsSession = cwdDiffersFromTarget;
				const primaryBusyKey = primaryIsSession ? `openbrowse:${cwd}` : `a1:${cwd}`;
				// §7.3：≥420 时"添加为工作区"是次按钮；但主按钮在 cwd == 目标 cwd 时**本身就是**
				// 添加为工作区 ⇒ 此时不再渲染次按钮（同一动作在头部只出现一次，N1）。
				// T32/RED-1：条件曾是 `!primaryIsSession`（写反）⇒ cwd == 目标 cwd 时**两个按钮
				// 同名**（[添加为工作区, 添加为工作区(--primary), 刷新]）。正确的是
				// `primaryIsSession`：只有主按钮是"在此目录新建会话"时，才额外给一个"添加为工作区"。
				if (!narrow && primaryIsSession) {
					headerButtons.push(
						React.createElement(
							"button",
							{
								key: "addws",
								type: "button",
								className: "dsh-rw-btn",
								disabled: cwd === null || action.busy !== null,
								"aria-label": cwd === null ? t("action.addWorkspaceNeedPath") : t("action.addWorkspaceAria", { path: cwd }),
								title: cwd === null ? t("action.addWorkspaceNeedPath") : t("action.addWorkspaceTitle"),
								onClick: () => {
									if (cwd === null) return;
									run(`a1:${cwd}`, (signal) => api.addWorkspace({ path: cwd }, signal), {
										describe: (result) => addWorkspaceNote(t, result),
										describeError: (error) => addWorkspaceErrorText(t, error),
										refresh: true,
									});
								},
							},
							icon("plus"),
							action.busy !== null && action.busy.startsWith("a1:") ? t("action.addWorkspaceBusy") : t("action.addWorkspace"),
						),
					);
				}
				headerButtons.push(
					React.createElement(
						"button",
						{
							key: "primary",
							type: "button",
							className: "dsh-rw-btn dsh-rw-btn--primary",
							disabled: cwd === null || action.busy !== null,
							"aria-label": cwd === null
								? t("browser.openHereAriaNone")
								: primaryIsSession
									? t("browser.openHereAria", { path: cwd })
									: t("action.addWorkspaceAria", { path: cwd }),
							title: primaryIsSession ? t("browser.openHereTitle") : t("action.addWorkspaceTitle"),
							onClick: () => {
								if (cwd === null) return;
								if (primaryIsSession) {
									run(`openbrowse:${cwd}`, (signal) => api.openSession({ distro: activeDistro, path: cwd }, signal), { describe: (result) => openSessionNote(t, result) });
									return;
								}
								run(`a1:${cwd}`, (signal) => api.addWorkspace({ path: cwd }, signal), {
									describe: (result) => addWorkspaceNote(t, result),
									describeError: (error) => addWorkspaceErrorText(t, error),
									refresh: true,
								});
							},
						},
						// T63：窄态（面板 <420，最窄 264px）换短文案，把宽度让回给标题/副标题（否则「添加为 WSL 工作区」
						// 占 132px，头部文字列只剩 63.7px ⇒ 标题折 2 行、副标题折 4 行）。完整名仍在 aria-label/title 里。
						action.busy === primaryBusyKey
							? primaryIsSession
								? t("row.openBusy")
								: t("action.addWorkspaceBusy")
							: primaryIsSession
								? t(narrow ? "browser.openHereShort" : "browser.openHere")
								: t(narrow ? "action.addWorkspaceShort" : "action.addWorkspace"),
					),
				);
				headerButtons.push(
					React.createElement(
						"button",
						{
							key: "refresh",
							type: "button",
							className: "dsh-rw-iconbtn",
							onClick: () => load({ alsoList: true, path: cwd }),
							disabled: state.status === "loading",
							"aria-label": t("header.refreshAria"),
							title: t("header.refreshAria"),
						},
						icon(state.status === "loading" ? "clock" : "refresh"),
					),
				);


			// —— 动作结果条 / 加载态 / 错误态（原样顺序，push 进共享 body） ——

				if (action.note !== null || action.error !== null) {
					body.push(
						React.createElement(
							"div",
							{ key: "action", className: "dsh-rw-note" + (action.error !== null ? " dsh-rw-note--error" : ""), role: action.error !== null ? "alert" : "status" },
							React.createElement(
								"div",
								{ className: "dsh-rw-note-text", title: action.detail === null ? undefined : action.detail },
								action.error !== null ? t("note.failure", { msg: errorText(action.error) }) : action.note,
								action.error !== null
									? React.createElement(
											"button",
											{
												type: "button",
												className: "dsh-rw-btn",
												style: { marginInlineStart: 8 },
												"aria-label": t("note.retryAria"),
												title: t("note.retryAria"),
												onClick: () => {
													const last = lastRun.current;
													if (last !== null) run(last.busyKey, last.operation, last.options);
												},
											},
											t("note.retry"),
										)
									: null,
							),
							action.detail === null
								? null
								: React.createElement(
										"details",
										{ className: "dsh-rw-note-details" },
										React.createElement("summary", null, t("note.detailSummary")),
										React.createElement("pre", { className: "dsh-rw-note-detail" }, action.detail),
									),
						),
					);
				}

				// 首挂载/未取到：只能说"还在读"（F34）
				if (!factsVisible) {
					body.push(React.createElement("div", { key: "loading", className: "dsh-rw-card" }, React.createElement("div", { className: "dsh-rw-hint" }, slow ? t("load.readingSlow") : t("load.reading"))));
				}

				// 读失败：事实全部撤下（M6）
				if (state.status === "error") {
					body.push(
						React.createElement(
							"div",
							{ key: "error", className: "dsh-rw-error", role: "alert" },
							React.createElement("div", { className: "dsh-rw-error-title" }, icon("error"), t("error.title")),
							React.createElement("div", { className: "dsh-rw-error-body" }, errorText(state.error)),
							React.createElement(
								"button",
								{ type: "button", className: "dsh-rw-btn", onClick: () => load({ alsoList: true, path: cwd }), "aria-label": t("error.retryAria"), title: t("error.retryAria") },
								t("error.retry"),
							),
						),
					);
				}

			return {
	headerButtons, primaryBusyKey, primaryIsSession,
			};
}

		exports.renderHeader = renderHeader;

		return module.exports;
	},
});
