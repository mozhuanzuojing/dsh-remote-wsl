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
	openSessionNote, newSessionNote, others, pathError, pathInput,
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
// 2026-10-29（P2）：「在此目录新建会话」默认落 **WSL preset**（agentPreset:'wsl'）。
// 顺序：① addWorkspace 把 UNC 登记为 host 工作区；② **host** explorer.newSession 建会话（带 preset，
// 返回 presetApplied / agentPreset / presetError 这些**事实**）；③ uiWorkspace.openSession(sessionId) 切主视图。
// 为什么不直接 uiWorkspace.startSession(workspaceId, { agentPreset:'wsl' })（该 options 真实存在，不是臆造：
// dsh-client-ui-workspace/lib/client.js:1500-1502 解构 agentPreset、:1525 透传给 connectBlank）：
//   · startSession 返回 void，失败被吞成 console.warn（:1525 的 .catch）⇒ 面板拿不到"preset 到底应用没应用"，
//     也拿不到"会话到底建没建"；宿主 newSession 会回事实字段，满足失败透明；
//   · WSL preset 没注册时宿主抛 agent-preset/not-found：我们这边会**降级重试**并报 presetApplied:false，
//     而 startSession 那条路直接不建会话、只弹平台 toast。
// 所以 startSession 只作兜底：宿主没有 sessionController 服务（非 Web profile ⇒ E_UNAVAILABLE）时，回到
// 上游唯一可用的路径，并把 agentPreset 显式传进去。
const ws = await api.addWorkspace({ path: cwd }, signal);
const nav = ctx && typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
const canStart = !!(nav && typeof nav.startSession === "function");
let created = null;
try {
created = await api.newSession({ path: cwd, workspaceId: ws && ws.ok === true && ws.id ? ws.id : undefined }, signal);
} catch (error) {
const apiCode = error && error.detail && typeof error.detail.code === "string" ? error.detail.code : null;
// 只有「宿主没有 sessionController」（E_NO_SESSION）才回落 startSession；宿主建会话失败也是 503，
// 但那是 E_UNAVAILABLE —— 回落会把真实错误吞掉并谎报成功（2026-10-29 review 修正）。
if (canStart && apiCode === "E_NO_SESSION") {
const workspaceId = ws && ws.ok === true && ws.id ? ws.id : undefined;
const opening = workspaceId === undefined ? nav.startSession() : nav.startSession(workspaceId, { agentPreset: "wsl" });
if (opening && typeof opening.then === "function") await opening;
return { ok: true, workspaceId: workspaceId ?? null, cwd: ws && ws.uncPath ? ws.uncPath : cwd, presetRequested: "wsl", presetApplied: null };
}
throw error;
}
// 切主视图：openSession(target) = replaceMain(..., "reveal")（同文件 :1471-1473），但它要求该 id 已在
// 客户端会话表里（否则 sessions.retain 抛 unknown session：dsh-api-session-controller/lib/client.js:3846
// → lib/types/client/sessions/manager.js:70）。新增行是经 api-session/added **推送**到达的，与我们的 HTTP
// 返回存在竞态 ⇒ 短暂重试；仍失败就如实报 opened:false（会话已建好，可从左侧会话列表打开），不假装切过去。
let opened = false;
let openError = null;
if (nav && typeof nav.openSession === "function" && typeof created.sessionId === "string" && created.sessionId.length > 0) {
for (let attempt = 0; attempt < 4 && !opened; attempt += 1) {
try {
await nav.openSession(created.sessionId);
opened = true;
} catch (openFailure) {
openError = openFailure;
if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
}
}
}
return {
ok: true,
sessionId: created.sessionId,
workspaceId: typeof created.workspaceId === "string" ? created.workspaceId : ws && ws.id ? ws.id : null,
cwd: typeof created.cwd === "string" && created.cwd.length ? created.cwd : ws && ws.uncPath ? ws.uncPath : cwd,
agentPreset: typeof created.agentPreset === "string" ? created.agentPreset : null,
presetRequested: typeof created.presetRequested === "string" ? created.presetRequested : "wsl",
presetApplied: created.presetApplied === true,
presetDegraded: created.presetDegraded === true,
presetError: typeof created.presetError === "string" ? created.presetError : null,
opened,
openError: openError === null ? null : String(openError && openError.message ? openError.message : openError),
};
}, { describe: (result) => newSessionNote(t, result), refresh: true });
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

			// —— F-50（client 侧接线，2026-10-27 第四轮）：`/proc` 扫描失败 ⇒ 孤儿数**未核实**，不是「0 个孤儿」——
			// 宿主 `src/explorer.ts` 已把机器可读证据 `daemon.scan = { ok, error? }` 与 `daemon.orphansVerified`
			// 透进快照；但面板此前从未消费这两个字段 ⇒ 读者只能从原始 JSON 的 `"orphans": 0` 得出「确认没有孤儿」
			// 的错误结论（F-50 要消灭的「失败当空」语义）。这里在事实区顶部给一条**常显、不折叠**的告警。
			//   · 未知态：`daemon` 缺失 ⇒ `daemonKnown === false` ⇒ **不渲染** —— 既不声称"已核实"也不声称"未核实"
			//     （面板没有证据时不许编造，沿用既有 daemonKnown 口径）；
			//   · 文案/配色：文字只走 `label-primary`，warn 只落在**边框与圆点**（琥珀/绿在白底约 2.1–2.3:1，
			//     不过 WCAG AA —— 见 index.js 2026-10-23 review 注释）；`role="status"` 与同区 conflict banner 同形。
			const scanRecord = daemonKnown && isRecord(daemon.scan) ? daemon.scan : null;
			const orphansUnverified = daemonKnown && (daemon.orphansVerified === false || (scanRecord !== null && scanRecord.ok === false));
			if (factsVisible && orphansUnverified) {
				const scanReason = scanRecord !== null && typeof scanRecord.error === "string" && scanRecord.error.length > 0 ? scanRecord.error : t("orphans.errorUnknown");
				body.push(
					React.createElement(
						"div",
						{ key: "orphanscan", className: "dsh-rw-scanwarn", role: "status", "data-scan-state": "unverified" },
						React.createElement(StatusDot, { kind: "warn" }),
						React.createElement("span", { className: "dsh-rw-scanwarn-text" }, t("orphans.unverified", { error: scanReason })),
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