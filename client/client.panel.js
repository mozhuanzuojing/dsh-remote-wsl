/**
 * client.panel.js —— 「远程资源管理器」中央面板（`main` 槽 key: 'remote-wsl'）。
 *
 * 文件名约束见 client.api.js 头部说明（chunk 名被平台的 CLIENT_CHUNK 正则钉死）。
 * 线框见 docs/remote-explorer-design.md §2：标题行 + 树 + 底部状态条 + 空态/错误态。
 *
 * 纪律（设计稿 §8）：
 * - 零构建：只 `React.createElement`，无 JSX、无 bundler、无依赖；
 * - 配色只用主题 token（light/dark 双份由基础样式表提供），不写死颜色；
 * - UI 里**没有**会连带他人的动作：daemon 动作只作用于快照里那一个 slot，没有 all/bulk；
 * - 挂载/卸载只读快照，**不杀守护**（唯一会动守护的是用户点按钮）；
 * - 界面上的每个数字都来自 host 半的 explorer.snapshot（= wsl_status 同一真相源），
 *   底部还给了「原始 snapshot」折叠区（**展开时才序列化**），便于与 wsl_status 逐项对账。
 *
 * ★ 三态纪律（lead 2026-10-12 的 FMEA 裁决，已验证的缺陷形态）：
 *   读**失败**时**绝不**渲染任何"事实性"断言 —— 不许出现"daemon 未运行"这种把
 *   "读不到"说成"已知为假"的文案，也不许让上一次的快照时间戳继续冒充当前值。
 *   三态：`ready`（读成功，渲染事实）/ `error`（读失败，只渲染失败+原因+重试，
 *   事实全部撤下，旧时间戳降级成"最后一次成功 HH:MM:SS"的提示）/ `未取过`。
 *   同一条纪律对每个**段**都生效：distros / workspaces / daemon / drift 缺段时
 *   只写"缺段/未知"，不写成"空/没有/未运行"。
 *
 * ★ 并发纪律（lead 2026-10-12 第二条）：
 *   ① 每次读取带**自增序号**，只有最新序号的响应允许写状态（旧响应到达即丢弃）；
 *   ② 发起新读取时 abort 上一次在飞读取；**卸载时 abort 在飞请求**（读与动作都取消）
 *      —— 否则"切走再切回"会被旧响应写回，与三态问题同源；
 *   ③ 请求超时由 client.api.js 的 AbortController + 9s 定时器兜住，UI 不会永久 loading。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		function asArray(value) {
			return Array.isArray(value) ? value : [];
		}

		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}

		function errorText(error) {
			if (error === null || error === undefined) return "";
			if (typeof error.message === "string" && error.message.length) return error.message;
			return String(error);
		}

		function clock(date) {
			if (!(date instanceof Date)) return "?";
			return date.toLocaleTimeString();
		}

		function newAbortController() {
			return typeof AbortController === "function" ? new AbortController() : null;
		}

		function signalOf(controller) {
			return controller === null ? undefined : { signal: controller.signal };
		}

		/** 一次 explorer 调用的人话结论。openSession 的"没预热"语义在这里如实落字。 */
		function openSessionNote(result) {
			if (result === null || typeof result !== "object") return "host 未返回会话信息。";
			const cwd = typeof result.cwd === "string" ? result.cwd : "";
			if (typeof result.sessionId === "string" && result.sessionId.length) {
				const how = result.reused === true ? "已复用现有会话" : result.created === true ? "已建立会话" : "已附到会话";
				return `${how} ${result.sessionId}${cwd ? `（cwd=${cwd}）` : ""}`;
			}
			const suffix = cwd ? `（目标 cwd=${cwd}）` : "";
			return `远端会话尚未建立${suffix}：首次向该会话发消息（wsl_agent 轮次）时才会物化。${typeof result.note === "string" ? " " + result.note : ""}`;
		}

		/**
		 * 造面板组件。
		 * @param ctx - client 受限 cordis 上下文（当前只用于留出扩展位）。
		 * @param api - client.api.js 的 createExplorerApi() 句柄：面板不对 URL/JSON 说话。
		 * @returns `main` 槽的 React 组件。
		 */
		function createPanel(ctx, api) {
			return function RemoteWslPanel() {
				// status: 'loading' | 'ready' | 'error'；snapshot 只在**成功**时写入，
				// lastSuccessAt/lastFailureAt 决定"能不能把这些数字当事实渲染"。
				const [state, setState] = React.useState({
					status: "loading",
					snapshot: null,
					error: null,
					lastSuccessAt: null,
					lastFailureAt: null,
				});
				const [selectedDistro, setSelectedDistro] = React.useState(null);
				const [collapsed, setCollapsed] = React.useState({});
				const [action, setAction] = React.useState({ busy: null, note: null, error: null });
				const [rawOpen, setRawOpen] = React.useState(false);
				// 危险动作（停止/重启守护）的二次确认：null = 没有待确认项。
				// 不可逆、会中断正在跑的会话，所以**不**靠一次点击直接执行。
				const [pending, setPending] = React.useState(null);

				const readSeq = React.useRef(0); // 读取序号：只有最新一次允许写状态（防乱序覆盖）
				const readAbort = React.useRef(null); // 最新一次读取的 AbortController
				const actionAbort = React.useRef(null); // 最新一次动作的 AbortController

				const load = React.useCallback(() => {
					const mySeq = readSeq.current + 1;
					readSeq.current = mySeq;
					// 取消上一次仍在飞的读取：既防乱序覆盖，也防"切走再切回被旧响应写回"。
					if (readAbort.current !== null) {
						readAbort.current.abort();
						readAbort.current = null;
					}
					const controller = newAbortController();
					readAbort.current = controller;
					// 一次新的读取会作废上一条动作结论：宁可没有，也不要留一条陈旧的事实。
					setAction({ busy: null, note: null, error: null });
					setState((prev) => ({ ...prev, status: "loading", error: null }));
					api.snapshot(signalOf(controller)).then(
						(snapshot) => {
							if (mySeq !== readSeq.current) return; // 旧响应：丢弃
							setState({ status: "ready", snapshot, error: null, lastSuccessAt: new Date(), lastFailureAt: null });
						},
						(error) => {
							if (mySeq !== readSeq.current) return; // 旧响应：丢弃
							if (error && error.kind === "aborted") return; // 卸载/被新读取取代：不写状态
							// 失败时保留 lastSuccessAt 作为"陈旧"提示，但 status='error'
							// 会让所有事实渲染分支整体撤下（见 factsVisible）。
							setState((prev) => ({ ...prev, status: "error", error, lastFailureAt: new Date() }));
						},
					);
				}, []);

				// 挂载时拉一次快照；卸载作废序号并 abort 在飞请求，**不触碰守护**。
				React.useEffect(() => {
					load();
					return () => {
						readSeq.current += 1;
						if (readAbort.current !== null) {
							readAbort.current.abort();
							readAbort.current = null;
						}
						if (actionAbort.current !== null) {
							actionAbort.current.abort();
							actionAbort.current = null;
						}
					};
				}, [load]);

				const run = React.useCallback((busyKey, operation, options) => {
					if (actionAbort.current !== null) {
						actionAbort.current.abort();
						actionAbort.current = null;
					}
					const controller = newAbortController();
					actionAbort.current = controller;
					setAction({ busy: busyKey, note: null, error: null });
					return Promise.resolve()
						.then(() => operation(signalOf(controller)))
						.then(
							(result) => {
								if (controller !== null && controller.signal.aborted) return null; // 已卸载/被取代
								setAction({ busy: null, note: options && options.describe ? options.describe(result) : "完成。", error: null });
								if (options && options.refresh) load();
								return result;
							},
							(error) => {
								if (controller !== null && controller.signal.aborted) return null;
								if (error && error.kind === "aborted") return null;
								setAction({ busy: null, note: null, error });
								return null;
							},
						);
				}, [load]);

				const snapshot = state.snapshot;
				// ★ 事实只在这两种情况下渲染：读成功；或刷新中且**从未失败过**（旧数据仍是真实读数）。
				const factsVisible =
					state.status === "ready" || (state.status === "loading" && snapshot !== null && state.lastFailureAt === null);

				const distros = asArray(snapshot && snapshot.distros);
				const distrosKnown = isRecord(snapshot) && Array.isArray(snapshot.distros);
				const workspacesKnown = isRecord(snapshot) && Array.isArray(snapshot.workspaces);
				const workspaces = asArray(snapshot && snapshot.workspaces);
				const webHosts = asArray(snapshot && snapshot.webHosts);
				const target = isRecord(snapshot && snapshot.target) ? snapshot.target : {};
				const daemonKnown = isRecord(snapshot && snapshot.daemon);
				const daemon = daemonKnown ? snapshot.daemon : null;
				const keysKnown = daemonKnown && Array.isArray(daemon.keys);
				const keys = keysKnown ? daemon.keys : [];
				const driftKnown = isRecord(snapshot && snapshot.drift);
				const drift = driftKnown ? snapshot.drift : null;

				const defaultDistro = distros.find((row) => isRecord(row) && row.default === true);
				const activeDistro =
					selectedDistro !== null && distros.some((row) => isRecord(row) && row.name === selectedDistro)
						? selectedDistro
						: (typeof target.distro === "string" && target.distro) || (defaultDistro && defaultDistro.name) || (distros[0] && distros[0].name) || null;
				const activeWorkspaces = workspaces.filter((row) => isRecord(row) && row.distro === activeDistro);
				const otherWorkspaces = workspaces.filter((row) => isRecord(row) && row.distro !== activeDistro);

				const toggle = (name) => setCollapsed((prev) => ({ ...prev, [name]: !(prev[name] === true) }));

				const body = [];

				// —— 加载态（还没取到过任何数据）——
				if (state.status === "loading" && snapshot === null) {
					body.push(React.createElement("div", { key: "loading", className: "dsh-rw-hint" }, `正在读取 explorer.snapshot（${api.route}，超时 ${api.timeoutMs}ms）…`));
				}

				// —— 错误态：只讲"读失败"，事实一律撤下 ——
				if (state.status === "error") {
					body.push(
						React.createElement(
							"div",
							{ key: "error", className: "dsh-rw-error", role: "alert" },
							React.createElement("div", { className: "dsh-rw-error-title" }, `读取远程资源失败（当前没有可用数据${state.error && state.error.kind === "timeout" ? "：请求超时" : ""}）`),
							React.createElement("div", { className: "dsh-rw-error-body" }, errorText(state.error)),
							React.createElement("div", { className: "dsh-rw-error-meta" }, `出口：${api.route}　类型：${(state.error && state.error.kind) || "unknown"}`),
							React.createElement("button", { type: "button", className: "dsh-rw-btn", onClick: () => load(), "aria-label": "重试读取 explorer.snapshot", title: "重试读取 explorer.snapshot" }, "重试"),
						),
					);
					if (state.lastSuccessAt !== null) {
						body.push(
							React.createElement(
								"div",
								{ key: "stale", className: "dsh-rw-hint" },
								`面板上的数字已全部撤下：最后一次成功读取是 ${clock(state.lastSuccessAt)}，那之后的数据无法确认（可能陈旧）。`,
							),
						);
					} else {
						body.push(React.createElement("div", { key: "stale", className: "dsh-rw-hint" }, "尚未成功读取过任何快照。"));
					}
				}

				// —— 空态 / 缺段态（只在有事实可依时下结论）——
				if (factsVisible && snapshot !== null) {
					if (!distrosKnown) {
						body.push(
							React.createElement("div", { key: "nofield", className: "dsh-rw-empty" }, "快照缺少 distros 段（host 侧 explorer.snapshot 与客户端版本不匹配？），不在此断定“没有发行版”。"),
						);
					} else if (distros.length === 0) {
						body.push(React.createElement("div", { key: "empty", className: "dsh-rw-empty" }, "wsl.exe -l -v 没有返回任何发行版（WSL 未安装，或没有已安装的发行版）。"));
					}
				}

				// —— 树 ——
				if (factsVisible && distrosKnown && distros.length > 0) {
					const rows = [];
					for (const distro of distros) {
						if (!isRecord(distro) || typeof distro.name !== "string") continue;
						const isActive = distro.name === activeDistro;
						const isCollapsed = collapsed[distro.name] === true && !isActive;
						const count = workspaces.filter((row) => isRecord(row) && row.distro === distro.name).length;
						rows.push(
							React.createElement(
								"div",
								{ key: `d:${distro.name}`, className: "dsh-rw-distro" },
								React.createElement(
									"button",
									{
										type: "button",
										className: "dsh-rw-distro-row",
										onClick: () => {
											setSelectedDistro(distro.name);
											toggle(distro.name);
										},
										"aria-expanded": String(!isCollapsed),
										"aria-label": `发行版 ${distro.name}（${distro.reachable === true ? "运行中" : distro.reachable === false ? "已停止" : "状态未知"}${workspacesKnown ? `，${count} 路径` : ""}）`,
										title: "点击切换筛选并展开/折叠",
									},
									React.createElement("span", { className: "dsh-rw-caret" }, isCollapsed ? "▸" : "▾"),
									React.createElement("span", { className: "dsh-rw-distro-name" }, distro.name),
									distro.default === true ? React.createElement("span", { className: "dsh-rw-badge" }, "默认发行版") : null,
									React.createElement(
										"span",
										{ className: "dsh-rw-badge dsh-rw-badge--muted" },
										// reachable 的定义是「此刻 STATE=Running」，不是"探活成功"，文案照实写"运行中"。
										`${distro.reachable === true ? "运行中" : distro.reachable === false ? "已停止" : "状态未知"}${workspacesKnown ? ` · ${count} 路径` : ""}`,
									),
									distro.name === target.distro ? React.createElement("span", { className: "dsh-rw-badge dsh-rw-badge--brand" }, "当前目标") : null,
								),
								isCollapsed
									? null
									: React.createElement(
										"div",
										{ className: "dsh-rw-workspaces" },
										!workspacesKnown
											? React.createElement("div", { className: "dsh-rw-hint" }, "快照缺少 workspaces 段，无法判断该发行版下有没有收藏路径。")
											: count === 0
												? React.createElement("div", { className: "dsh-rw-hint" }, "该发行版下还没有收藏路径。")
												: workspaces
													.filter((row) => isRecord(row) && row.distro === distro.name)
													.map((row) =>
														React.createElement(
															"div",
															{ key: `w:${row.distro}:${row.path}`, className: "dsh-rw-workspace" },
															React.createElement("span", { className: "dsh-rw-workspace-label", title: row.path }, `${row.kind === "code-workspace" ? "🧩" : "📁"} ${row.label || row.path}`),
															React.createElement("span", { className: "dsh-rw-workspace-path", title: row.path }, row.path),
															React.createElement(
																"span",
																{ className: "dsh-rw-workspace-actions" },
																React.createElement(
																	"button",
																	{
																		type: "button",
																		className: "dsh-rw-link",
																		disabled: action.busy !== null,
																		"aria-label": `在远端会话中打开 ${row.path}（首次发消息时才物化会话）`,
																		title: `在新会话中打开 ${row.path}（不预热：首次发消息时才建立远端会话）`,
																		onClick: () => run(`open:${row.path}`, (signal) => api.openSession({ distro: row.distro, path: row.path }, signal), { describe: openSessionNote, refresh: true }),
																	},
																	action.busy === `open:${row.path}` ? "打开中…" : "在新会话中打开",
																),
																React.createElement(
																	"button",
																	{
																		type: "button",
																		className: "dsh-rw-link",
																		"aria-label": `复制 WSL 路径 ${row.path}`,
																		title: `复制 WSL 路径 ${row.path}`,
																		onClick: () =>
																			run(
																				`copy:${row.path}`,
																				() =>
																					typeof navigator !== "undefined" && navigator.clipboard
																						? navigator.clipboard.writeText(row.path)
																						: Promise.reject(new Error("此环境没有 navigator.clipboard")),
																				{ describe: () => `已复制 WSL 路径：${row.path}` },
																			),
																	},
																	action.busy === `copy:${row.path}` ? "复制中…" : "复制路径",
																),
															),
														),
													),
									),
							),
						);
					}
					if (otherWorkspaces.length > 0) {
						rows.push(React.createElement("div", { key: "others", className: "dsh-rw-hint" }, `另有 ${otherWorkspaces.length} 条收藏路径属于其它发行版（切换上方筛选查看）。`));
					}
					body.push(React.createElement("div", { key: "tree", className: "dsh-rw-tree" }, rows));
				}

				// —— 危险动作的二次确认（停止/重启守护）：写清后果 + 影响哪个 slot + 当前 keys 数 ——
				if (pending !== null) {
					const verb = pending.action === "stop" ? "停止" : "重启";
					const consequence =
						pending.action === "stop"
							? "该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。"
							: "该槽位上的守护会换一个新进程回来，正在跑的会话全部中断、上下文丢失，且不会自动恢复。";
					body.push(
						React.createElement(
							"div",
							{ key: "confirm", className: "dsh-rw-confirm", role: "alertdialog", "aria-label": `${verb}守护确认` },
							React.createElement("div", { className: "dsh-rw-confirm-title" }, `确认${verb}守护？slot ${pending.slot}（本插件自有槽位，不存在 all 选项）`),
							React.createElement(
								"div",
								{ className: "dsh-rw-confirm-body" },
								`后果：${consequence}　当前该槽位 keys/session = ${pending.keys}。`,
							),
							React.createElement(
								"div",
								{ className: "dsh-rw-confirm-actions" },
								React.createElement(
									"button",
									{
										type: "button",
										className: "dsh-rw-btn dsh-rw-btn--danger",
										"aria-label": `确认${verb}守护 slot ${pending.slot}`,
										onClick: () => {
											const target = pending;
											setPending(null);
											run(
												`daemon:${target.action}`,
												(signal) => api.daemon({ action: target.action, slot: target.slot }, signal),
												{ describe: () => `已请求${verb}守护 slot ${target.slot}。`, refresh: true },
											);
										},
									},
									`确认${verb}`,
								),
								React.createElement("button", { type: "button", className: "dsh-rw-btn", "aria-label": `取消${verb}守护`, onClick: () => setPending(null) }, "取消"),
							),
						),
					);
				}

				// —— 动作结果条（只由最近一次动作决定，读失败时会随 load() 清空）——
				if (action.note !== null || action.error !== null) {
					body.push(
						React.createElement(
							"div",
							{ key: "action", className: "dsh-rw-note" + (action.error !== null ? " dsh-rw-note--error" : ""), role: action.error !== null ? "alert" : "status" },
							action.error !== null ? `失败：${errorText(action.error)}` : action.note,
						),
					);
				}

				// —— 同源对账用的《原始 snapshot》折叠区：**展开时才 JSON.stringify**（
				//    折叠状态下不物化 <pre>，避免每次 render 都白算一遍大字符串）——
				if (factsVisible && snapshot !== null) {
					body.push(
						React.createElement(
							"details",
							{ key: "raw", className: "dsh-rw-raw", onToggle: (event) => setRawOpen(event.currentTarget.open === true) },
							React.createElement("summary", null, "原始 snapshot（与 wsl_status 同源）"),
							rawOpen ? React.createElement("pre", { className: "dsh-rw-pre" }, JSON.stringify(snapshot, null, 2)) : null,
						),
					);
				}

				// —— 状态条：读失败时**不**给任何 daemon 事实，只给"数据不可确认" ——
				const daemonSlot = daemonKnown && typeof daemon.slot === "number" ? daemon.slot : null;
				const statusLeft = [];
				if (!factsVisible) {
					statusLeft.push(React.createElement("span", { key: "nodata", className: "dsh-rw-status-text" }, "数据不可用：读取失败后已撤下，不显示守护/漂移状态。"));
				} else if (!daemonKnown) {
					statusLeft.push(React.createElement("span", { key: "nodaemon", className: "dsh-rw-status-text" }, "快照缺少 daemon 段，守护状态未知（不断言“未运行”）。"));
				} else if (daemon.running !== true) {
					statusLeft.push(
						React.createElement("span", { key: "dotoff", className: "dsh-rw-dot dsh-rw-dot--off", title: "守护未运行（快照 running=false）" }),
						React.createElement("span", { key: "offtext", className: "dsh-rw-status-text" }, `daemon 未运行${typeof daemon.orphans === "number" && daemon.orphans > 0 ? ` · orphans ${daemon.orphans}` : ""}`),
						React.createElement(
							"button",
							{
								type: "button",
								className: "dsh-rw-link",
								disabled: action.busy !== null,
								"aria-label": "启动守护（幂等；不会停止任何已有守护）",
								title: "启动守护（幂等；不会停止任何已有守护）",
								onClick: () => run("daemon:ensure", (signal) => api.daemon({ action: "ensure" }, signal), { describe: () => "已请求启动守护。", refresh: true }),
							},
							action.busy === "daemon:ensure" ? "启动中…" : "启动守护",
						),
					);
				} else {
					statusLeft.push(
						React.createElement("span", { key: "doton", className: "dsh-rw-dot dsh-rw-dot--on", title: "守护运行中" }),
						React.createElement(
							"span",
							{ key: "ontext", className: "dsh-rw-status-text" },
							`daemon${daemonSlot === null ? "（slot 未知）" : ` slot ${daemonSlot}`}${typeof daemon.port === "number" ? ` · :${daemon.port}` : ""}${typeof daemon.pid === "number" ? ` · pid ${daemon.pid}` : ""}${typeof daemon.version === "string" ? ` · ${daemon.version}` : ""} · keys ${keysKnown ? keys.length : "?"}${typeof daemon.orphans === "number" && daemon.orphans > 0 ? ` · orphans ${daemon.orphans}` : ""}`,
						),
						React.createElement(
							"span",
							{ key: "acts", className: "dsh-rw-status-actions" },
							daemonSlot === null
								? React.createElement("span", { key: "noslot", className: "dsh-rw-status-text", title: "快照没给出 slot，无法界定停止/重启的作用范围，故不提供这两个动作" }, "slot 未知：不提供停止/重启")
								: [
									React.createElement(
										"button",
										{
											key: "restart",
											type: "button",
											className: "dsh-rw-link",
											disabled: action.busy !== null,
											"aria-label": `重启守护 slot ${daemonSlot}（需二次确认）`,
											title: `重启守护 slot ${daemonSlot}（会中断正在跑的会话，需二次确认）`,
											onClick: () => setPending({ action: "restart", slot: daemonSlot, keys: keysKnown ? keys.length : "?" }),
										},
										action.busy === "daemon:restart" ? "重启中…" : "重启…",
									),
									React.createElement(
										"button",
										{
											key: "stop",
											type: "button",
											className: "dsh-rw-link dsh-rw-link--danger",
											disabled: action.busy !== null,
											"aria-label": `停止守护 slot ${daemonSlot}（需二次确认，仅此槽位，没有 all）`,
											title: `只停止 slot ${daemonSlot}（本插件自有槽位）；没有 stop all；需二次确认`,
											onClick: () => setPending({ action: "stop", slot: daemonSlot, keys: keysKnown ? keys.length : "?" }),
										},
										action.busy === "daemon:stop" ? "停止中…" : `停止 slot ${daemonSlot}…`,
									),
								],
						),
					);
				}
				if (factsVisible && driftKnown && drift.drifted === true) {
					statusLeft.push(
						React.createElement(
							"span",
							{ key: "drift", className: "dsh-rw-drift", title: `desktop=${drift.desktop || "?"} pin=${drift.pin || "?"}` },
							"drift ⚠ ",
							React.createElement(
								"button",
								{
									type: "button",
									className: "dsh-rw-link",
									disabled: action.busy !== null,
									"aria-label": "修复 version pin（只写 pin，不重启也不杀守护）",
									title: "修复 version pin（只写 pin，不重启也不杀守护）",
									onClick: () => run("fixPin", (signal) => api.fixPin(signal), { describe: () => "已请求修复 version pin（不自动杀守护）。", refresh: true }),
								},
								action.busy === "fixPin" ? "修复中…" : "修 pin",
							),
						),
					);
				} else if (factsVisible && !driftKnown) {
					statusLeft.push(React.createElement("span", { key: "driftunknown", className: "dsh-rw-badge dsh-rw-badge--muted" }, "drift 未知"));
				}

				const stamp =
					state.status === "ready" && state.lastSuccessAt !== null
						? `快照 ${clock(state.lastSuccessAt)}`
						: state.status === "loading" && state.lastSuccessAt !== null
							? `上次成功 ${clock(state.lastSuccessAt)} · 刷新中…`
							: state.lastSuccessAt !== null
								? `读取失败 · 最后一次成功 ${clock(state.lastSuccessAt)}`
								: "尚未取得快照";

				return React.createElement(
					"section",
					{ className: "dsh-rw-root", "data-dsh-remote-wsl": "panel" },
					React.createElement(
						"header",
						{ className: "dsh-rw-header" },
						React.createElement(
							"div",
							{ className: "dsh-rw-header-text" },
							React.createElement("span", { className: "dsh-rw-title" }, "远程资源管理器"),
							React.createElement(
								"span",
								{ className: "dsh-rw-subtitle" },
								factsVisible && typeof target.distro === "string" && target.distro
									? `目标 ${target.distro}${typeof target.cwd === "string" && target.cwd ? ` · ${target.cwd}` : ""}`
									: state.status === "error"
										? "目标未知（读取失败）"
										: "尚未取得目标发行版",
							),
						),
						React.createElement(
							"div",
							{ className: "dsh-rw-header-actions" },
							React.createElement(
								"label",
								{ className: "dsh-rw-field", title: "仅筛选视图；P0 契约里没有 explorer.selectDistro，切换不写 host 配置" },
								React.createElement("span", { className: "dsh-rw-field-label" }, "WSL 目标"),
								React.createElement(
									"select",
									{
										className: "dsh-rw-select",
										value: activeDistro === null ? "" : activeDistro,
										onChange: (event) => setSelectedDistro(event.target.value),
										disabled: !factsVisible || distros.length === 0,
									},
									distros.map((row) => React.createElement("option", { key: `o:${row.name}`, value: row.name }, `${row.name}${row.default === true ? "（默认）" : ""}${row.reachable === true ? "" : " · 已停止"}`)),
								),
							),
							React.createElement(
								"button",
								{ type: "button", className: "dsh-rw-btn", onClick: () => load(), disabled: state.status === "loading", "aria-label": "重新读取 explorer.snapshot", title: "重新读取 explorer.snapshot" },
								state.status === "loading" ? "刷新中…" : "刷新",
							),
						),
					),
					React.createElement("div", { className: "dsh-rw-body" }, body),
					React.createElement(
						"footer",
						{ className: "dsh-rw-status" },
						React.createElement("div", { className: "dsh-rw-status-left" }, statusLeft),
						React.createElement(
							"div",
							{ className: "dsh-rw-status-right" },
							factsVisible && webHosts.length > 0
								? React.createElement(
									"span",
									{ className: "dsh-rw-webhosts" },
									webHosts.map((host) => React.createElement("span", { key: `h:${host.port}`, className: "dsh-rw-badge dsh-rw-badge--muted" }, `web ${host.port}`)),
								)
								: null,
							React.createElement("span", { className: "dsh-rw-badge dsh-rw-badge--muted" }, stamp),
						),
					),
				);
			};
		}

		exports.createPanel = createPanel;
		exports.openSessionNote = openSessionNote;
		return module.exports;
	},
});
