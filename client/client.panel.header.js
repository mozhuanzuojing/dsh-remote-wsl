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
									run(`openbrowse:${cwd}`, async (signal) => {
// 先登记 UNC 工作区，再用客户端工作区导航开一个新会话（与侧栏「新会话」同一条路径；
// 它会真正切到主视图）。uiWorkspace 取不到时回落到 host 的 explorer.newSession。
// 2026-10-22 实测（web profile 实例 + CDP，见 spike/verify/uiworkspace-20261022/）：
//   · apply() 期 ctx.get("uiWorkspace") 还是 undefined（provider fiber 未 ACTIVE）；
//     等 chunk 就绪、用户真能点按钮时它一定可用（startSession/openSession/listDirectory 都是函数）；
//   · startSession(workspaceId) **同步**返回 undefined，且自己吞掉失败（console.warn + 平台 toast）。
//     所以这里不靠返回值判断成败；只按 thenable 兜一层，将来它若改成返回 Promise 也不会丢错误。
const ws = await api.addWorkspace({ path: cwd }, signal);
const nav = ctx && typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
if (ws && ws.ok === true && ws.id && nav && typeof nav.startSession === "function") {
const opening = nav.startSession(ws.id);
if (opening && typeof opening.then === "function") await opening;
return { ok: true, workspaceId: ws.id, cwd: ws.uncPath };
}
return api.newSession({ path: cwd }, signal);
}, { describe: (result) => result && result.workspaceId ? t("session.opened", { cwd: String(result.cwd || cwd) }) : t("session.dshCreated", { id: String(result && result.sessionId ? result.sessionId : "?"), cwd: String(result && result.cwd ? result.cwd : cwd) }), refresh: true });
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
								{ className: "dsh-rw-note-text" + (action.error === null ? " dsh-rw-note-text--clamp" : ""), title: action.error === null ? action.note : undefined },
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

				// 首挂载/未取到：只能说"还在读"（F34）。2026-10-19：加载态给 3 条骨架行，
				// 让"正在读"有可感知的结构与稳定高度（不是一行字忽然变成一整块内容）。
				// ★ F-38（task-8，P2）：加载态与错误态必须**互斥**（错误优先）。
				// 改前是两个并列 if，读失败时"脉冲骨架 + 正在读取…"与错误卡**同屏** ⇒ 伪加载态、
				// 骨架动画永不停，用户拿不到"已经失败了"这个结论。
				const readFailed = state.status === "error";
				if (!factsVisible && !readFailed) {
					body.push(
						React.createElement(
							"div",
							{ key: "loading", className: "dsh-rw-card", role: "status", "aria-label": t("browser.loadingAria") },
							React.createElement(
								"div",
								{ className: "dsh-rw-skeleton" },
								[120, 90, 160, 110, 140].map((width, i) =>
									React.createElement(
										"div",
										{ key: "sk:" + i, className: "dsh-rw-skeleton-row", "aria-hidden": "true" },
										React.createElement("span", { className: "dsh-rw-skeleton-icon" }),
										React.createElement("span", { className: "dsh-rw-skeleton-bar", style: { width } }),
									),
								),
							),
							React.createElement("div", { className: "dsh-rw-hint" }, slow ? t("load.readingSlow") : t("load.reading")),
						),
					);
				}

				// 读失败：事实全部撤下（M6）
				if (readFailed) {
					body.push(
						React.createElement(
							"div",
							{ key: "error", className: "dsh-rw-error", role: "alert" },
							// ★ F-39：把三条**本来已经能算出来**的文案从死键变成真渲染 ——
							//   ① 超时（error.kind === "timeout"）用专门的标题，别让用户以为路由坏了；
							//   ② 曾经成功过 ⇒ 说清"最后一次成功是什么时候"（数字已撤下，别让人以为一直没数据）；
							//   ③ 从没成功过 ⇒ 明说"尚未成功读取过任何快照"。
							React.createElement("div", { className: "dsh-rw-error-title" }, icon("error"), t(state.error && state.error.kind === "timeout" ? "error.titleTimeout" : "error.title")),
							React.createElement("div", { className: "dsh-rw-error-body" }, errorText(state.error)),
							React.createElement("div", { className: "dsh-rw-hint" }, state.lastSuccessAt === null ? t("error.never") : t("error.stale", { time: clock(state.lastSuccessAt) })),
							React.createElement(
								"button",
								{ type: "button", className: "dsh-rw-btn", onClick: () => load({ alsoList: true, path: cwd }), "aria-label": t("error.retryAria"), title: t("error.retryAria") },
								t("error.retry"),
							),
						),
					);
				}

			/** 守护状态药丸：未运行时可一键启动；运行中只报状态（破坏性动作仍只在 ⋯ 菜单里）。 */
			const daemonPill = factsVisible && daemonKnown
				? React.createElement(
					"button",
					{
						type: "button",
						className: "dsh-rw-daemon " + (daemon.running === true ? "dsh-rw-daemon--on" : "dsh-rw-daemon--off"),
						"aria-label": daemon.running === true ? t("status.daemonRunning") : t("status.daemonOff"),
						title:
							daemon.running === true
								? t("status.daemonPillOn", { slot: daemonSlot === null ? "?" : daemonSlot, pid: typeof daemon.pid === "number" ? daemon.pid : "?", version: typeof daemon.version === "string" && daemon.version.length ? daemon.version : "?" })
								: t("status.daemonPillOff"),
						onClick: () => {
							if (daemon.running !== true && action.busy === null) runDaemon("ensure");
						},
					},
					React.createElement(StatusDot, { kind: daemon.running === true ? "running" : "stopped" }),
					// 2026-10-22 B2：窄态（面板 <420，最窄 264）换成 5 字短文案「守护未运行」——
					// 完整文案「远端守护未运行」实测 115px，而 264px 面板的头部文字列只有 109px
					// ⇒ 元信息行横向溢出 6px（实测见 spike/verify/ui-20261022/out-render-before.json）。
					// 短文案 89px 放得下；完整名与「点击启动」说明仍在 aria-label / title 里。
					t(daemon.running === true ? (narrow ? "status.daemonPillShortOn" : "status.daemonRunning") : narrow ? "status.daemonPillShortOff" : "status.daemonOff"),
				)
				: null;
			/**
			 * 代理状态徽标（2026-10-22 B1）：`snapshot.proxy = { host, port, reachable, cached }`，
			 * 只对**运行中**的发行版探测 ⇒ `reachable` 是三态：true / false / null（未探测）。
			 * 约束（任务书原文）：
			 *   · 三态各有**文字**（颜色只是第三冗余，不许"只画红点"），配色取宿主
			 *     `--dsw-alias-state-*`，与 StatusDot 同族；
			 *   · 带 `title` 与 `aria-label`；**不可达时给出代理地址 + 一句可操作提示**；
			 *   · 窄态换极短词，靠 CSS `white-space:nowrap` 保证徽标自身不折行，靠元信息行
			 *     `flex-wrap` 保证它不挤压标题（标题列宽由 CSS 决定，与徽标无关）。
			 */
			const proxy = isRecord(snapshot) && isRecord(snapshot.proxy) ? snapshot.proxy : null;
			const proxyState = proxy === null ? null : proxy.reachable === true ? "up" : proxy.reachable === false ? "down" : "unknown";
			const proxyEndpoint =
				proxy === null || proxy.host === null || proxy.host === undefined
					? "?"
					: String(proxy.host) + ":" + (proxy.port === null || proxy.port === undefined ? "?" : String(proxy.port));
			const proxyAria =
				proxyState === "up"
					? t("proxy.ariaUp", { endpoint: proxyEndpoint })
					: proxyState === "down"
						? t("proxy.ariaDown", { endpoint: proxyEndpoint })
						: proxyState === "unknown"
							? t("proxy.ariaUnknown", { endpoint: proxyEndpoint })
							: null;
			const proxyLabel =
				proxyState === "up"
					? t(narrow ? "proxy.upShort" : "proxy.up")
					: proxyState === "down"
						? narrow
							? t("proxy.downShort")
							: t("proxy.downAt", { endpoint: proxyEndpoint })
						: proxyState === "unknown"
							? t(narrow ? "proxy.unknownShort" : "proxy.unknown")
							: null;
			const proxyBadge =
				factsVisible && proxyState !== null
					? React.createElement(
							"span",
							{
								className: "dsh-rw-proxy dsh-rw-proxy--" + proxyState,
								role: "img",
								"data-proxy-state": proxyState,
								"aria-label": proxyAria,
								title: proxyAria,
							},
							React.createElement(StatusDot, { kind: proxyState === "up" ? "running" : proxyState === "down" ? "warn" : "unknown" }),
							React.createElement("span", { className: "dsh-rw-proxy-text" }, proxyLabel),
						)
					: null;
			return {
	headerButtons, primaryBusyKey, primaryIsSession, daemonPill, proxyBadge,
			};
}

		exports.renderHeader = renderHeader;

		return module.exports;
	},
});