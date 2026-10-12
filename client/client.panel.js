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
		 * F25：把一次 `{ok:false,…}` **结果值**变成人话失败原因。
		 * host 半的 `explorer.fixPin` 会在 HTTP 200 里回 `{ok:false,error,pinBefore,pinAfter,wrote:false}`，
		 * 所以不能只看 HTTP 状态，必须看结果里的 ok。
		 */
		function actionFailureText(result) {
			const reason =
				typeof result.error === "string" && result.error.length
					? result.error
					: typeof result.note === "string" && result.note.length
						? result.note
						: "host 用 200 回了 ok:false，但没有给出原因";
			const wrote = result.wrote === false ? "（未写入）" : "";
			const pins =
				typeof result.pinBefore === "string" || typeof result.pinAfter === "string"
					? ` pin: ${result.pinBefore === undefined ? "?" : result.pinBefore === null ? "无" : result.pinBefore} → ${result.pinAfter === undefined ? "?" : result.pinAfter === null ? "无" : result.pinAfter}`
					: "";
			return `${reason}${wrote}${pins}`;
		}

		/** 守护动作的成功结论：带上 slot/port/pid，让"作用在哪个槽位"可见。 */
		function daemonNote(verb, result) {
			if (!isRecord(result)) return `已${verb}守护。`;
			const bits = [];
			if (result.slot !== undefined && result.slot !== null) bits.push(`slot ${result.slot}`);
			if (result.port !== undefined && result.port !== null) bits.push(`:${result.port}`);
			if (result.pid !== undefined && result.pid !== null) bits.push(`pid ${result.pid}`);
			if (result.version !== undefined && result.version !== null) bits.push(String(result.version));
			const extra = result.alreadyStopped === true ? "（本来就没在跑，幂等）" : result.reused === true ? "（复用已有守护）" : "";
			const notes = Array.isArray(result.notes) && result.notes.length ? `：${result.notes.join("；")}` : "";
			return `已${verb}守护${bits.length ? ` ${bits.join(" · ")}` : ""}${extra}${notes}`;
		}

		/**
		 * 归一化一个 WSL 绝对路径（去掉尾斜杠；根保持 `/`）。
		 * 面板只接受 WSL 侧路径；Windows 路径请写成 `/mnt/c/...`。
		 */
		function normalizeWslPath(path) {
			let value = String(path).trim().replace(/\/{2,}/g, "/");
			if (value.length > 1 && value.endsWith("/")) value = value.replace(/\/+$/, "");
			return value.length === 0 ? "/" : value;
		}

		/** 拼一个子条目路径（根目录不产生 `//`）。 */
		function joinWslPath(parent, name) {
			const base = normalizeWslPath(parent);
			return base === "/" ? `/${name}` : `${base}/${name}`;
		}

		/**
		 * 从 `/` 起的**完整**面包屑（刻意不折叠家目录 —— 这正是官方 picker 的可用性死角之一）。
		 * @returns [{ label, path }]，最后一段是当前目录。
		 */
		function breadcrumbOf(path) {
			const full = normalizeWslPath(path);
			const crumbs = [{ label: "/", path: "/" }];
			if (full === "/") return crumbs;
			const segments = full.split("/").filter((segment) => segment.length > 0);
			let acc = "";
			for (const segment of segments) {
				acc = `${acc}/${segment}`;
				crumbs.push({ label: segment, path: acc });
			}
			return crumbs;
		}

		/** 家目录 chip 的目标：优先用快照里的 wslHome，否则从当前目录里认出 /home/<user>。 */
		function homePathOf(target, cwd) {
			if (isRecord(target) && typeof target.wslHome === "string" && target.wslHome.startsWith("/")) {
				return normalizeWslPath(target.wslHome);
			}
			const match = typeof cwd === "string" ? /^(\/home\/[^/]+)/.exec(cwd) : null;
			return match === null ? "/home" : match[1];
		}

		/**
		 * `/mnt` 盘符探测结果**按页面生命周期缓存一次**（模块作用域）：
		 * 反复切面板不该每次都重列 /mnt —— 那是无效流量（T7 会量挂载次数与请求增长）。
		 */
		let mountsCache = null;

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
				// —— A3 目录浏览器（对齐 dsh-wsl-workspace-picker 的成熟解）——
				// 四个能力：快捷 chips / 常显路径输入（回车跳转）/ 从 `/` 起的完整面包屑 / 隐藏文件开关（默认关）。
				const [browse, setBrowse] = React.useState({ cwd: null, status: "idle", entries: [], error: null });
				const [showHidden, setShowHidden] = React.useState(false); // 默认关
				const [pathInput, setPathInput] = React.useState("");
				const [pathError, setPathError] = React.useState(null);
				const [mounts, setMounts] = React.useState([]); // 探测到的 /mnt/<盘符>

				const readSeq = React.useRef(0); // 读取序号：只有最新一次允许写状态（防乱序覆盖）
				const readAbort = React.useRef(null); // 最新一次读取的 AbortController
				const actionAbort = React.useRef(null); // 最新一次动作的 AbortController
				const lastRun = React.useRef(null); // 最近一次动作（失败时给"重试"入口）
				const browseSeq = React.useRef(0); // 列目录序号：同一套乱序/卸载防护
				const browseAbort = React.useRef(null);
				const mountsProbed = React.useRef(false);

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
					// 注意：这里**不**清动作结果条。动作成功后的 `refresh` 会走到这里，
					// 一清就把"已启动守护 slot/port/pid"这类**成功反馈**抹掉（T5 要求的可见反馈）。
					// 成功结论只在新动作开始时、或读取失败时（见下）撤下。
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
							// 同时撤下"成功口吻"的动作结论（读不到了就不能再替它背书）；
							// 动作**失败**结论保留，因为它带着"重试"入口。
							setAction((prev) => (prev.note === null ? prev : { ...prev, note: null }));
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
						if (browseAbort.current !== null) {
							browseAbort.current.abort();
							browseAbort.current = null;
						}
					};
				}, [load]);

				const run = React.useCallback((busyKey, operation, options) => {
					lastRun.current = { busyKey, operation, options };
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
								// ★ F25：host 可能用 **200** 回一个 `{ok:false,…}` 的**结果值**
								//（`explorer.fixPin` 就是这个形状：{ok,error,pinBefore,pinAfter,wrote}）。
								// 一律按 ok 分支渲染：ok:false 必须显式失败并给重试，不许成功口吻。
								// 注意只有**显式 false** 才算失败：`explorer.openSession` 的结果里没有 ok 字段。
								if (isRecord(result) && result.ok === false) {
									setAction({ busy: null, note: null, error: { message: actionFailureText(result), kind: "host-result", detail: result } });
									if (options && options.refresh) load();
									return result;
								}
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

				/**
				 * 列一个 WSL 目录（A3 的核心读操作）。与 `load()` 同一套纪律：
				 * 自增序号（旧响应不许写状态）+ abort 上一次在飞 + 卸载 abort + host 错误原样可读。
				 * host 一次返回**全部**条目（含隐藏）；隐藏与否在 client 侧过滤 ⇒ 开关切换不重发请求。
				 * @param path - WSL 绝对路径。
				 */
				const listPath = React.useCallback((path) => {
					const want = normalizeWslPath(path);
					const mySeq = browseSeq.current + 1;
					browseSeq.current = mySeq;
					if (browseAbort.current !== null) {
						browseAbort.current.abort();
						browseAbort.current = null;
					}
					const controller = newAbortController();
					browseAbort.current = controller;
					// 换目录就清空旧条目：绝不把上一个目录的内容显示成这个目录的（同"撤下未确认事实"纪律）。
					setBrowse((prev) => ({ status: "loading", cwd: want, entries: prev.cwd === want ? prev.entries : [], error: null }));
					api.listDir({ path: want }, signalOf(controller)).then(
						(result) => {
							if (mySeq !== browseSeq.current) return; // 旧响应：丢弃
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

				/** chips / 面包屑 / 目录行的统一跳转入口。 */
				const jumpTo = React.useCallback((path) => {
					const want = normalizeWslPath(path);
					setPathInput(want);
					setPathError(null);
					listPath(want);
				}, [listPath]);

				/** 路径输入框回车（或点「跳转」）：先客户端校验，非法给**可读**错误，不静默。 */
				const submitPath = React.useCallback(() => {
					const raw = String(pathInput).trim();
					if (raw.length === 0) {
						setPathError("请输入 WSL 绝对路径（例如 /home/g/project）。");
						return;
					}
					if (!raw.startsWith("/")) {
						setPathError(`必须是 WSL 绝对路径（以 / 开头）；收到 "${raw}"。Windows 盘符路径请写成 /mnt/c/... 形式。`);
						return;
					}
					setPathError(null);
					listPath(raw);
				}, [listPath, pathInput]);

				/**
				 * 隐藏文件开关：默认关。**只改本地过滤**（host 一次返回全区条目），
				 * 所以切换即时、不重发请求；配合 `showHidden` 与 `visibleEntries` 派生。
				 */
				const toggleHidden = React.useCallback(() => {
					setShowHidden((prev) => !prev);
				}, []);

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
				// T8：`daemon.others[]` 是**只读**的"别的槽位"清单（{slot,pid,port,version,note}）。
				// 它是设计稿字段表的加法，可能缺席 ⇒ 容错成空数组，绝不对它生成任何动作。
				const others = daemonKnown && Array.isArray(daemon.others) ? daemon.others.filter((row) => isRecord(row)) : [];
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

				// —— A3：目录浏览器初始化。快照首次 ready 时把 cwd 定到 target.cwd（否则 wslHome / 家目录）——
				React.useEffect(() => {
					if (state.status !== "ready" || browse.cwd !== null) return;
					const fromTarget = typeof target.distro === "string" && typeof target.cwd === "string" && target.cwd.startsWith("/") ? target.cwd : null;
					const initial = fromTarget === null ? homePathOf(target, null) : normalizeWslPath(fromTarget);
					setPathInput(initial);
					listPath(initial);
				}, [state.status, browse.cwd, target.cwd, target.distro, listPath]);

				// —— A3：探测 `/mnt` 下**真实存在**的盘符（只探测一次，按页面缓存；失败就不显示那些 chip）——
				React.useEffect(() => {
					if (state.status !== "ready" || mountsProbed.current) return;
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
							// 探测不到就**不显示** `/mnt/<盘符>` chips（它们只是快捷方式；这不是错误态）
							mountsCache = [];
						},
					);
					return () => {
						if (controller !== null) controller.abort();
					};
				}, [state.status]);

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

				// —— A3 目录浏览器（四个能力：chips / 常显路径输入 / 从 `/` 起的完整面包屑 / 隐藏开关）——
				if (factsVisible && snapshot !== null) {
					const visibleEntries = browse.entries.filter((entry) => showHidden || entry.hidden !== true);
					const hiddenCount = browse.entries.filter((entry) => entry.hidden === true).length;
					const crumbs = browse.cwd === null ? [] : breadcrumbOf(browse.cwd);
					const homePath = homePathOf(target, browse.cwd);
					const distroLabel = typeof target.distro === "string" && target.distro.length ? target.distro : "?";
					const chip = (label, path, description) =>
						React.createElement(
							"button",
							{
								key: `chip:${path}`,
								type: "button",
								className: "dsh-rw-chip" + (browse.cwd === normalizeWslPath(path) ? " dsh-rw-chip--on" : ""),
								"aria-label": `${description}：跳转到 ${path}`,
								title: `${description}：跳转到 ${path}`,
								onClick: () => jumpTo(path),
							},
							label,
						);

					body.push(
						React.createElement(
							"section",
							{ key: "browser", className: "dsh-rw-browser", "aria-label": `WSL 目录浏览（发行版 ${distroLabel}）` },
							React.createElement(
								"div",
								{ className: "dsh-rw-browser-head" },
								React.createElement("span", { className: "dsh-rw-browser-title" }, `浏览目录（WSL: ${distroLabel}）`),
								React.createElement(
									"button",
									{
										type: "button",
										className: "dsh-rw-chip" + (showHidden ? " dsh-rw-chip--on" : ""),
										"aria-pressed": String(showHidden),
										"aria-label": showHidden ? "隐藏 . 开头的条目（当前：显示）" : "显示 . 开头的隐藏条目（当前：隐藏）",
										title: showHidden ? "点击改为隐藏 . 开头的条目" : "点击显示 . 开头的隐藏条目（默认关）",
										onClick: toggleHidden,
									},
									showHidden ? `隐藏文件：显示（${hiddenCount}）` : "隐藏文件：不显示",
								),
							),
							// ① 快捷 chips（Home / `/` / `/mnt` / 探测到的 `/mnt/<盘符>`）
							React.createElement(
								"div",
								{ className: "dsh-rw-chips", role: "group", "aria-label": "快捷目录" },
								[chip("Home", homePath, "家目录"), chip("/", "/", "根目录"), chip("/mnt", "/mnt", "Windows 盘符挂载点")].concat(
									mounts.map((mount) => chip(mount, mount, "Windows 盘符")),
								),
							),
							// ② 从 `/` 起的**完整**面包屑（不折叠家目录；每层可点）
							React.createElement(
								"nav",
								{ className: "dsh-rw-crumbs", "aria-label": "当前路径（从 / 起，可点跳转）" },
								browse.cwd === null
									? React.createElement("span", { className: "dsh-rw-crumb dsh-rw-crumb--current" }, "（尚未浏览）")
									: crumbs.map((crumb, index) =>
										React.createElement(
											React.Fragment,
											{ key: `crumb:${crumb.path}` },
											// 根 crumb 自己就显示 `/`，所以第一个分隔符要从**第二段**（index 2）才开始，
											// 否则会渲染成 `/ / home / g`。
											index > 1 ? React.createElement("span", { className: "dsh-rw-crumb-sep", "aria-hidden": "true" }, "/") : null,
											React.createElement(
												"button",
												{
													type: "button",
													className: "dsh-rw-crumb" + (index === crumbs.length - 1 ? " dsh-rw-crumb--current" : ""),
													"aria-label": `跳转到 ${crumb.path}`,
													title: `跳转到 ${crumb.path}`,
													"aria-current": index === crumbs.length - 1 ? "true" : undefined,
													onClick: () => jumpTo(crumb.path),
												},
												crumb.label,
											),
										),
									),
							),
							// ③ 常显路径输入（回车即跳转；非法给可读错误）
							React.createElement(
								"form",
								{
									className: "dsh-rw-path-form",
									onSubmit: (event) => {
										event.preventDefault();
										submitPath();
									},
								},
								React.createElement("input", {
									type: "text",
									className: "dsh-rw-path-input",
									value: pathInput,
									placeholder: "/home/g/project",
									"aria-label": "WSL 绝对路径（回车跳转）",
									title: "输入 WSL 绝对路径，回车跳转（例如 /home/g 或 /mnt/d/project）",
									spellCheck: false,
									autoComplete: "off",
									onChange: (event) => {
										setPathInput(event.target.value);
										setPathError(null);
									},
									onKeyDown: (event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											submitPath();
										}
									},
								}),
								React.createElement("button", { type: "submit", className: "dsh-rw-btn", "aria-label": "跳转到输入的路径", title: "跳转到输入的路径" }, "跳转"),
								React.createElement(
									"button",
									{
										type: "button",
										className: "dsh-rw-btn",
										disabled: browse.cwd === null || action.busy !== null,
										"aria-label": browse.cwd === null ? "在浏览的目录打开远端会话（尚未选定目录）" : `在 ${browse.cwd} 打开新的远端会话`,
										title: "在此目录打开新的远端会话（不预热：首次发消息时才建立）",
										onClick: () => {
											if (browse.cwd === null) return;
											run(`openbrowse:${browse.cwd}`, (signal) => api.openSession({ distro: activeDistro, path: browse.cwd }, signal), { describe: openSessionNote });
										},
									},
									"在此目录开会话",
								),
							),
							pathError === null ? null : React.createElement("div", { className: "dsh-rw-note dsh-rw-note--error", role: "alert" }, pathError),
							browse.status === "loading" ? React.createElement("div", { className: "dsh-rw-hint" }, `正在列目录 ${browse.cwd || ""}…`) : null,
							browse.status === "error"
								? React.createElement(
									"div",
									{ className: "dsh-rw-error", role: "alert" },
									React.createElement("div", { className: "dsh-rw-error-title" }, `列目录失败（${browse.cwd || "?"}）`),
									React.createElement("div", { className: "dsh-rw-error-body" }, errorText(browse.error)),
									React.createElement(
										"button",
										{
											type: "button",
											className: "dsh-rw-btn",
											"aria-label": "重试列目录",
											title: "重试列目录",
											onClick: () => {
												if (browse.cwd !== null) listPath(browse.cwd);
											},
										},
										"重试",
									),
								)
								: null,
							browse.status === "ready"
								? visibleEntries.length === 0
									? React.createElement("div", { className: "dsh-rw-hint" }, showHidden ? "该目录为空。" : `该目录没有非隐藏条目${hiddenCount > 0 ? `（还有 ${hiddenCount} 个隐藏条目，可打开「隐藏文件」查看）` : ""}。`)
									: React.createElement(
										"div",
										{ className: "dsh-rw-entries", role: "list", "aria-label": `${browse.cwd || ""} 的条目` },
										visibleEntries.map((entry) => {
											const childPath = browse.cwd === null ? entry.name : joinWslPath(browse.cwd, entry.name);
											return React.createElement(
												"div",
												{ key: `entry:${entry.name}`, className: "dsh-rw-entry", role: "listitem" },
												entry.kind === "dir"
													? React.createElement(
														"button",
														{
															type: "button",
															className: "dsh-rw-entry-nav",
															"aria-label": `进入目录 ${childPath}`,
															title: `进入 ${childPath}`,
															onClick: () => jumpTo(childPath),
														},
														React.createElement("span", { className: "dsh-rw-entry-icon", "aria-hidden": "true" }, "📁"),
														React.createElement("span", { className: "dsh-rw-entry-name" }, entry.name),
													)
													: React.createElement(
														"span",
														{ className: "dsh-rw-entry-inert", title: "文件（此处只浏览目录层级；要用它请在收藏路径行里操作）" },
														React.createElement("span", { className: "dsh-rw-entry-icon", "aria-hidden": "true" }, entry.kind === "file" ? "📄" : "•"),
														React.createElement("span", { className: "dsh-rw-entry-name" }, entry.name),
													),
												entry.hidden === true ? React.createElement("span", { className: "dsh-rw-badge dsh-rw-badge--muted" }, "隐藏") : null,
											);
										}),
									)
								: null,
						),
					);
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

				// —— 别的槽位（T8 的 daemon.others[]）：**只读**展示，一个动作按钮都不生成 ——
				if (factsVisible && others.length > 0) {
					body.push(
						React.createElement(
							"div",
							{ key: "otheraemon", className: "dsh-rw-others" },
							React.createElement("div", { className: "dsh-rw-others-title" }, `其它槽位的守护（只读：本面板不会对它们发起任何动作）`),
							others.map((row, index) =>
								React.createElement(
									"div",
									{ key: `other:${row.slot === undefined || row.slot === null ? index : row.slot}`, className: "dsh-rw-other" },
									React.createElement(
										"span",
										{ className: "dsh-rw-other-main" },
										`slot ${row.slot === undefined || row.slot === null ? "?" : row.slot}${row.port === undefined || row.port === null ? "" : ` · :${row.port}`}${row.pid === undefined || row.pid === null ? "" : ` · pid ${row.pid}`}${row.version === undefined || row.version === null ? "" : ` · ${row.version}`}`,
									),
									React.createElement("span", { className: "dsh-rw-other-note" }, typeof row.note === "string" && row.note.length ? row.note : "非本槽位；未复用、未打扰"),
								),
							),
						),
					);
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
							React.createElement("div", { className: "dsh-rw-confirm-title" }, `确认${verb}守护？slot ${pending.slot}（本插件配置的槽位，不存在 all 选项）`),
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
												{ describe: (result) => daemonNote(verb, result), refresh: true },
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
							action.error !== null
								? React.createElement(
									"span",
									null,
									`失败：${errorText(action.error)}`,
									" ",
									React.createElement(
										"button",
										{
											type: "button",
											className: "dsh-rw-link",
											"aria-label": "重试上一个失败的动作",
											title: "重试上一个失败的动作",
											onClick: () => {
												const last = lastRun.current;
												if (last !== null) run(last.busyKey, last.operation, last.options);
											},
										},
										"重试",
									),
								)
								: action.note,
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
				if (state.status === "error") {
					// ★ F34：只有**真的读失败**才说"已撤下"。首挂载 fetch 未返回时 status='loading'，
					// 走到下面的 loading 分支，绝不允许同屏出现"正在读取…"+"读取失败后已撤下"。
					statusLeft.push(React.createElement("span", { key: "nodata", className: "dsh-rw-status-text" }, "数据不可用：读取失败后已撤下，不显示守护/漂移状态。"));
				} else if (!factsVisible) {
					// 首挂载 / 还没取到过任何快照：只能说"还在读"，不许说"失败"
					statusLeft.push(React.createElement("span", { key: "loadingstatus", className: "dsh-rw-status-text" }, `尚未取得快照：正在读取守护与漂移状态（超时 ${api.timeoutMs}ms）…`));
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
								onClick: () => run("daemon:ensure", (signal) => api.daemon({ action: "ensure" }, signal), { describe: (result) => daemonNote("启动", result), refresh: true }),
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
											title: `只停止 slot ${daemonSlot}（本插件配置的槽位）；没有 stop all；需二次确认`,
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
