/**
 * client.panel.js —— 「远程资源管理器」中央面板（`main` 槽 key: 'remote-wsl'）。
 *
 * T30 重设计（按 `docs/panel-ux-redesign.md` + `docs/panel-visual-spec.md` 两份冻结规格）：
 *   头部（标题 + 唯一主按钮 + 次按钮 + 刷新图标）｜主体（**唯一**目录概念：chips + 面包屑 +
 *   常显路径输入 + 条目列表）｜折叠区（最近目录 / 高级·诊断）｜底栏（**一行**：状态点 + 状态词 +
 *   附加信息 + 更新于 + `⋯`）。
 *
 * 规格硬约束（实现自证；判据见规格 §7-M1..M17 / §5.5-N1..N5）：
 * - **M1**：旧树删掉 —— 面板内同一路径只出现一次（没有第二次"工作区树"）。
 * - **M5**：主视线不得出现 `slot/daemonPort/pid/keys/explorer.snapshot/snapshot/systemd-run/unit/版本号`。
 * - **N4**：行内动作不用 `display:none`，用 `visibility` + 常占位（hover 前后几何不变）。
 * - **N5 / §4.2.1**：每个状态 = ①文字状态词 + ②形状/图标，颜色只是第三冗余。
 * - **§3.4**：面板内**零 emoji**，全部内联 SVG（16×16，viewBox 24，stroke 1.5，currentColor）。
 * - **§3.7**：内嵌路径文本一律 `direction:ltr;unicode-bidi:isolate`。
 * - **M12**：最近目录 = `localStorage['dsh-remote-wsl.recent']`，只存路径字符串 ≤8 条，不可用即静默降级。
 * - 文案**全部**来自 `client.i18n.js`（本文件不得出现中文字符串字面量，`console.*`/注释除外）。
 *
 * 保留不回退：三态渲染 / F34 首挂载只显示读取中 / F35 路径 LTR / `others[]` 只读零按钮 /
 * 停止·重启二次确认 / rail 名「远程资源管理器」。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** 最近目录（M12）：命名空间键 + 只存路径字符串。 */
		const RECENT_KEY = "dsh-remote-wsl.recent";
		const RECENT_MAX = 8;
		/** 窄宽度断点（§7.3）：<420 时"添加为工作区"进 ⋯ 菜单。 */
		const NARROW_PX = 420;
		/** 更新时间在 <360 时整体隐藏（§7.2.3）。 */
		const HIDE_UPDATED_PX = 360;

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

		function normalizeWslPath(path) {
			let value = String(path).trim().replace(/\/{2,}/g, "/");
			if (value.length > 1 && value.endsWith("/")) value = value.replace(/\/+$/, "");
			return value.length === 0 ? "/" : value;
		}

		function joinWslPath(parent, name) {
			const base = normalizeWslPath(parent);
			return base === "/" ? `/${name}` : `${base}/${name}`;
		}

		/** 从 `/` 起的完整面包屑（面包屑的作用是"哪一层都能点"，所以不折叠家目录）。 */
		function breadcrumbOf(path) {
			const full = normalizeWslPath(path);
			const crumbs = [{ label: "/", path: "/" }];
			if (full === "/") return crumbs;
			let acc = "";
			for (const segment of full.split("/").filter((s) => s.length > 0)) {
				acc = `${acc}/${segment}`;
				crumbs.push({ label: segment, path: acc });
			}
			return crumbs;
		}

		function homePathOf(target, cwd) {
			if (isRecord(target) && typeof target.wslHome === "string" && target.wslHome.startsWith("/")) {
				return normalizeWslPath(target.wslHome);
			}
			const match = typeof cwd === "string" ? /^(\/home\/[^/]+)/.exec(cwd) : null;
			return match === null ? "/home" : match[1];
		}

		/** 最近目录读取（M12）：**任何**异常都静默降级成 []。 */
		function readRecent() {
			try {
				const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(RECENT_KEY);
				if (typeof raw !== "string" || raw.length === 0) return [];
				const parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				return parsed.filter((item) => typeof item === "string" && item.startsWith("/")).slice(0, RECENT_MAX);
			} catch {
				return [];
			}
		}

		function pushRecent(path) {
			try {
				const value = normalizeWslPath(path);
				const next = [value].concat(readRecent().filter((item) => item !== value)).slice(0, RECENT_MAX);
				if (typeof localStorage !== "undefined") localStorage.setItem(RECENT_KEY, JSON.stringify(next));
				return next;
			} catch {
				return [];
			}
		}

		/** `/mnt` 盘符探测缓存（模块作用域：切面板不重复探测）。 */
		let mountsCache = null;

		/** 首句人话 + 其余技术细节（T5 的瑕：结果条不再原样透传 host 文案）。 */
		function splitHumanText(text) {
			const value = typeof text === "string" ? text.trim() : "";
			if (value.length === 0) return { text: "", detail: null };
			const match = /^([\s\S]*?[。！？!?；;])([\s\S]*)$/.exec(value);
			if (match === null) return { text: value, detail: null };
			const head = match[1].trim();
			const rest = match[2].trim();
			return { text: head, detail: rest.length > 0 ? rest : null };
		}

		function openSessionNote(t, result) {
			if (result === null || typeof result !== "object") return { text: t("session.noInfo"), detail: null };
			const cwd = typeof result.cwd === "string" ? result.cwd : "";
			if (typeof result.sessionId === "string" && result.sessionId.length) {
				const how = result.reused === true ? t("session.reused") : result.created === true ? t("session.created") : t("session.attached");
				return { text: `${how} ${result.sessionId}${cwd ? t("session.cwdInline", { cwd }) : ""}`, detail: null };
			}
			const head = t("session.pending", { cwd: cwd ? t("session.cwdSuffix", { cwd }) : "" });
			const host = splitHumanText(typeof result.note === "string" ? result.note : "");
			const detail = host.text.length > 0 && host.text !== head ? host.text : null;
			return { text: head, detail };
		}

		function addWorkspaceNote(t, result) {
			const title = typeof result.title === "string" && result.title.length ? result.title : "?";
			const id = result.id === undefined || result.id === null ? "?" : String(result.id);
			const text = result.alreadyExisted === true ? t("action.addWorkspaceExisted", { title, id }) : t("action.addWorkspaceDone", { title, id });
			const unc = typeof result.uncPath === "string" && result.uncPath.length ? `UNC ${result.uncPath}` : null;
			return { text, detail: unc };
		}

		function addWorkspaceErrorText(t, error) {
			const detail = error && error.detail;
			const code = detail && typeof detail.code === "string" ? detail.code : null;
			const key =
				code === "E_ARG"
					? "action.addWorkspaceErrorInvalid"
					: code === "E_NOTFOUND"
						? "action.addWorkspaceErrorNotFound"
						: code === "E_UNAVAILABLE"
							? "action.addWorkspaceErrorUnavailable"
							: "action.addWorkspaceErrorOther";
			return t(key, { msg: errorText(error) });
		}

		/**
		 * host 以 200 回 `ok:false` 时的失败文案。
		 * T32/缺陷③：host 把原因放在 **`result.notes[]`**（数组，首项是人话整句），
		 * 这里过去只读 `result.error` / `result.note`，两者都没有时就落到
		 * `note.hostNoReason`（"没有给出原因"）——等于把 host 已经给出的原因丢掉。
		 * 现在按 `notes[0]` → 其余 `notes[1..]` 进 detail（沿用 {text,detail} 约定）；
		 * 并且首项只把**首句**放在正文，其余（含第二句起的补充说明）进 detail（折叠）。
		 * @returns {{text: string, detail: string|null}}
		 */
		function splitFirstSentence(value) {
			const text = String(value);
			// 中英两套句末：`。`/`！`/`？` 或 `. `/`! `/`? `（后面还有内容才算句子边界）
			const zh = text.search(/[。！？]/);
			if (zh >= 0 && zh < text.length - 1) return { head: text.slice(0, zh + 1), rest: text.slice(zh + 1).trim() };
			const en = text.search(/[.!?]\s/);
			if (en >= 0 && en < text.length - 2) return { head: text.slice(0, en + 1), rest: text.slice(en + 2).trim() };
			return { head: text, rest: "" };
		}

		function actionFailure(t, result, failKey) {
			const notes = Array.isArray(result && result.notes)
				? result.notes.filter((line) => typeof line === "string" && line.length > 0)
				: [];
			const hostReason =
				typeof result.error === "string" && result.error.length
					? result.error
					: notes.length > 0
						? notes[0]
						: typeof result.note === "string" && result.note.length
							? result.note
							: null;
			const wrote = result.wrote === false ? t("note.unwrote") : "";
			if (failKey) {
				// T36 裁决：**主句必须是用户语言**，host 原文（含 `pid`/`slot`/`keys`/版本号）
				// 一律只进 detail（折叠/tooltip）—— 否则 M5 在 stop 失败态失效。
				// `note.failStop` 只在"守护进程仍在"（`pid` 非空）时才贴切，否则退到通用句。
				const key = failKey === "note.failStop" && (result.pid === null || result.pid === undefined) ? "note.failGeneric" : failKey;
				const detailLines = [hostReason, ...notes.slice(1)].filter((line) => typeof line === "string" && line.length > 0);
				return { text: `${t(key)}${wrote}`, detail: detailLines.length > 0 ? detailLines.join("\n") : null };
			}
			// 没有给 failKey 的调用方（addWorkspace/openSession/…）沿用"host 首句进正文"，
			// 它们本来就有自己的用户语言 describeError，且这些原文不含实现者术语。
			if (hostReason === null) return { text: `${t("note.hostNoReason")}${wrote}`, detail: null };
			const split = splitFirstSentence(hostReason);
			const restLines = [...(split.rest ? [split.rest] : []), ...notes.slice(1)];
			return { text: `${split.head}${wrote}`, detail: restLines.length > 0 ? restLines.join("\n") : null };
		}

		/** 兼容旧调用：只要文本。 */
		function actionFailureText(t, result) {
			return actionFailure(t, result).text;
		}

		/** 守护动作：主句人话 + host `notes[]`（systemd/unit/握手）进折叠区。 */
		function daemonNote(t, phrase, result) {
			if (!isRecord(result)) return { text: phrase, detail: null };
			const notes = Array.isArray(result.notes) && result.notes.length ? result.notes.join("\n") : null;
			return { text: phrase, detail: notes };
		}

		/** 内联 SVG 图标（§3.4：16×16 / viewBox 24 / stroke 1.5 / currentColor；面板内零 emoji）。 */
		function icon(name, extraClass) {
			const paths = {
				folder: "M3 7a2 2 0 0 1 2-2h3.6l1.8 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
				file: "M7 3h7l5 5v13H7zM14 3v5h5",
				home: "M4 11l8-7 8 7v9H4zM10 20v-6h4v6",
				refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4",
				more: "M6 12h.01M12 12h.01M18 12h.01",
				chevronRight: "M9 6l6 6-6 6",
				chevronUp: "M6 14l6-6 6 6",
				arrowLeft: "M11 5l-7 7 7 7M4 12h16",
				lock: "M7 10V8a5 5 0 0 1 10 0v2M5 10h14v10H5z",
				warn: "M12 4l9 16H3zM12 10v4M12 17h.01",
				error: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6",
				check: "M4 12l5 5L20 6",
				copy: "M9 9h10v10H9zM5 15V5h10",
				clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
				plus: "M12 5v14M5 12h14",
			};
			return React.createElement(
				"svg",
				{
					className: `dsh-rw-icon${extraClass ? ` ${extraClass}` : ""}`,
					viewBox: "0 0 24 24",
					width: 16,
					height: 16,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					focusable: "false",
				},
				React.createElement("path", { d: paths[name] || paths.file }),
			);
		}

		/** 状态形状（§4.1：形状是第一编码）：running=实心圆 / stopped=空心圆 / unknown / error。 */
		function StatusDot({ kind }) {
			return React.createElement("span", { className: `dsh-rw-dot dsh-rw-dot--${kind}`, "aria-hidden": "true" });
		}

		function createPanel(ctx, api, i18n) {
			const t = i18n && typeof i18n.t === "function" ? i18n.t : (key) => key;
			const i18nSubscribe = i18n && typeof i18n.subscribe === "function" ? i18n.subscribe : null;

			return function RemoteWslPanel() {
				const [state, setState] = React.useState({ status: "loading", snapshot: null, error: null, lastSuccessAt: null, lastFailureAt: null });
				const [collapsed, setCollapsed] = React.useState({});
				const [action, setAction] = React.useState({ busy: null, note: null, detail: null, error: null });
				const [pending, setPending] = React.useState(null);
				const [menuOpen, setMenuOpen] = React.useState(false);
				const [browse, setBrowse] = React.useState({ cwd: null, status: "idle", entries: [], error: null });
				const [showHidden, setShowHidden] = React.useState(false);
				const [pathInput, setPathInput] = React.useState("");
				const [pathError, setPathError] = React.useState(null);
				const [mounts, setMounts] = React.useState([]);
				const [recent, setRecent] = React.useState([]);
				const [recentOk, setRecentOk] = React.useState(true);
				const [slow, setSlow] = React.useState(false);
				const [width, setWidth] = React.useState(1280);
				const [focusIndex, setFocusIndex] = React.useState(-1);
				const [, forceLocale] = React.useReducer((n) => n + 1, 0);

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

				React.useEffect(() => {
					if (i18nSubscribe === null) return undefined;
					return i18nSubscribe(() => forceLocale());
				}, []);

				React.useEffect(() => {
					const items = readRecent();
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
						action.busy === primaryBusyKey ? (primaryIsSession ? t("row.openBusy") : t("action.addWorkspaceBusy")) : t(primaryIsSession ? "browser.openHere" : "action.addWorkspace"),
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

				const body = [];

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

				// —— 主体：唯一目录概念 ——
				if (factsVisible && snapshot !== null) {
					const crumbs = cwd === null ? [] : breadcrumbOf(cwd);
					const homePath = homePathOf(target, cwd);
					const distroLabel = typeof target.distro === "string" && target.distro.length ? target.distro : "?";
					const chip = (labelText, path, ariaKey, current) =>
						React.createElement(
							"button",
							{
								key: `chip:${path}`,
								type: "button",
								className: "dsh-rw-chip" + (current ? " dsh-rw-chip--on dsh-rw-current" : ""),
								"aria-label": t(ariaKey, { path }),
								title: t(ariaKey, { path }),
								"aria-current": current ? "true" : undefined,
								onClick: () => jumpTo(path),
							},
							labelText,
						);

					const rows = visibleEntries.map((entry, index) => {
						const childPath = cwd === null ? entry.name : joinWslPath(cwd, entry.name);
						const isDir = entry.kind === "dir";
						const isCurrent = isDir && cwd !== null && normalizeWslPath(childPath) === cwd;
						return React.createElement(
							"div",
							{
								key: `entry:${entry.name}`,
								className: "dsh-rw-row" + (isDir ? " dsh-rw-row--dir" : "") + (isCurrent ? " dsh-rw-row--current dsh-rw-current" : "") + (focusIndex === index ? " dsh-rw-row--focus" : ""),
								tabIndex: -1,
								"data-index": index,
								"data-path": childPath,
								"aria-current": isCurrent ? "true" : undefined,
							},
							icon(isDir ? "folder" : "file"),
							React.createElement("span", { className: "dsh-rw-rowname", title: childPath, dir: "ltr" }, entry.name),
							entry.hidden === true ? React.createElement("span", { className: "dsh-rw-badge" }, t("browser.hiddenBadge")) : null,
							React.createElement(
								"span",
								{ className: "dsh-rw-rowacts" },
								isDir
									? React.createElement(
											"button",
											{
												type: "button",
												className: "dsh-rw-link",
												"aria-label": t("browser.enterDir", { path: childPath }),
												title: t("browser.enterDirTitle", { path: childPath }),
												onClick: () => jumpTo(childPath),
											},
											t("browser.enter"),
										)
									: React.createElement(
											"button",
											{
												type: "button",
												className: "dsh-rw-link",
												"aria-label": t("browser.copyPath"),
												title: t("browser.copyPath"),
												onClick: () =>
													run(
														`copy:${childPath}`,
														() =>
															typeof navigator !== "undefined" && navigator.clipboard
																? navigator.clipboard.writeText(childPath)
																: Promise.reject(new Error(t("row.copyNoClipboard"))),
														{ describe: () => t("browser.copied", { path: childPath }) },
													),
											},
											t("row.copy"),
										),
							),
						);
					});

					const onListKey = (event) => {
						if (visibleEntries.length === 0) return;
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							const delta = event.key === "ArrowDown" ? 1 : -1;
							const base = focusIndex < 0 ? (delta > 0 ? -1 : 0) : focusIndex;
							const next = Math.min(visibleEntries.length - 1, Math.max(0, base + delta));
							setFocusIndex(next);
							const node = rootRef.current === null ? null : rootRef.current.querySelector(`[data-index="${next}"]`);
							if (node !== null) node.scrollIntoView({ block: "nearest" });
							return;
						}
						if (event.key === "Enter" && focusIndex >= 0) {
							const entry = visibleEntries[focusIndex];
							if (entry && entry.kind === "dir") {
								event.preventDefault();
								jumpTo(joinWslPath(cwd, entry.name));
							}
							return;
						}
						if (event.key === "Backspace" && cwd !== null && cwd !== "/") {
							event.preventDefault();
							jumpTo(cwd.replace(/\/[^/]+$/, "") || "/");
						}
					};

					body.push(
						React.createElement(
							"section",
							{ key: "browser", className: "dsh-rw-card", "aria-label": t("browser.aria", { distro: distroLabel }) },
							React.createElement(
								"div",
								{ className: "dsh-rw-cardhead" },
								React.createElement("span", { className: "dsh-rw-grouptitle" }, t("browser.groupTitle")),
								React.createElement("span", { className: "dsh-rw-spacer" }),
								React.createElement(
									"button",
									{
										type: "button",
										className: "dsh-rw-chip" + (showHidden ? " dsh-rw-chip--on" : ""),
										"aria-pressed": String(showHidden),
										"aria-label": showHidden ? t("browser.hiddenHideAria") : t("browser.hiddenShowAria"),
										title: showHidden ? t("browser.hiddenHideTitle") : t("browser.hiddenShowTitle"),
										onClick: () => setShowHidden((prev) => !prev),
									},
									showHidden ? t("browser.hiddenOn", { count: hiddenCount }) : t("browser.hiddenOff"),
								),
							),
							React.createElement(
								"div",
								{ className: "dsh-rw-toolbar", role: "group", "aria-label": t("browser.chipsAria") },
								[
									chip(t("browser.chipHome"), homePath, "browser.chipHomeAria", cwd === homePath),
									chip("/", "/", "browser.chipRootAria", cwd === "/"),
									chip("/mnt", "/mnt", "browser.chipMntAria", cwd === "/mnt"),
								].concat(mounts.map((mount) => chip(mount, mount, "browser.chipDriveAria", cwd === mount))),
							),
							React.createElement(
								"nav",
								{ className: "dsh-rw-crumbs", "aria-label": t("browser.crumbsAria") },
								cwd === null
									? React.createElement("span", { className: "dsh-rw-hint" }, t("browser.notBrowsing"))
									: crumbs.map((crumb, index) =>
											React.createElement(
												React.Fragment,
												{ key: `crumb:${crumb.path}` },
												index > 1 ? React.createElement("span", { className: "dsh-rw-crumb-sep", "aria-hidden": "true" }, "/") : null,
												index === crumbs.length - 1
													? React.createElement("span", { className: "dsh-rw-crumb dsh-rw-crumb--current dsh-rw-current", "aria-current": "true" }, crumb.label)
													: React.createElement(
															"button",
															{
																type: "button",
																className: "dsh-rw-crumb",
																"aria-label": t("browser.crumbJump", { path: crumb.path }),
																title: t("browser.crumbJump", { path: crumb.path }),
																onClick: () => jumpTo(crumb.path),
															},
															crumb.label,
														),
											),
										),
							),
							React.createElement(
								"form",
								{
									className: "dsh-rw-form",
									onSubmit: (event) => {
										event.preventDefault();
										submitPath();
									},
								},
								React.createElement("input", {
									type: "text",
									className: "dsh-rw-path-input",
									value: pathInput,
									placeholder: t("browser.pathPlaceholder"),
									"aria-label": t("browser.pathAria"),
									title: t("browser.pathTitle"),
									spellCheck: false,
									autoComplete: "off",
									onChange: (event) => {
										setPathInput(event.target.value);
										setPathError(null);
									},
								}),
								React.createElement("button", { type: "submit", className: "dsh-rw-btn", "aria-label": t("browser.jumpAria"), title: t("browser.jumpAria") }, t("browser.jump")),
								React.createElement(
									"button",
									{
										type: "button",
										className: "dsh-rw-btn",
										disabled: cwd === null || cwd === "/",
										"aria-label": t("browser.up"),
										title: t("browser.up"),
										onClick: () => {
											if (cwd === null) return;
											jumpTo(cwd.replace(/\/[^/]+$/, "") || "/");
										},
									},
									icon("arrowLeft"),
									t("browser.up"),
								),
							),
							pathError === null ? null : React.createElement("div", { className: "dsh-rw-note dsh-rw-note--error", role: "alert" }, pathError),
							React.createElement(
								"div",
								{ className: "dsh-rw-entries", role: "list", tabIndex: 0, onKeyDown: onListKey, "aria-label": t("browser.entriesAria", { path: cwd === null ? "" : cwd }) },
								browse.status === "loading"
									? React.createElement("div", { className: "dsh-rw-hint" }, t("browser.listing", { path: cwd === null ? "" : cwd }))
									: browse.status === "error"
										? React.createElement(
												"div",
												{ className: "dsh-rw-error", role: "alert" },
												React.createElement("div", { className: "dsh-rw-error-title" }, icon("error"), t("browser.listError", { path: cwd === null ? "?" : cwd })),
												React.createElement("div", { className: "dsh-rw-error-body" }, errorText(browse.error)),
												React.createElement(
													"button",
													{ type: "button", className: "dsh-rw-btn", onClick: () => cwd !== null && listPath(cwd), "aria-label": t("browser.listRetry"), title: t("browser.listRetry") },
													t("error.retry"),
												),
											)
										: browse.status === "ready" && rows.length === 0
											? React.createElement(
													"div",
													{ className: "dsh-rw-empty" },
													React.createElement(
														"div",
														{ className: "dsh-rw-hint" },
														showHidden ? t("browser.emptyAll") : t("browser.emptyVisible", { hidden: hiddenCount > 0 ? t("browser.emptyHiddenHint", { count: hiddenCount }) : "" }),
													),
													React.createElement("div", { className: "dsh-rw-hint" }, t("empty.nextStep")),
													React.createElement(
														"button",
														{ type: "button", className: "dsh-rw-btn", onClick: () => jumpTo(homePath), "aria-label": t("empty.home"), title: t("empty.home") },
														icon("home"),
														t("empty.home"),
													),
												)
											: rows,
							),
						),
					);
				}

				// —— 折叠区：最近目录（M12；localStorage 不可用 ⇒ 整块不渲染） ——
				if (factsVisible && snapshot !== null && recentOk) {
					const open = collapsed.recent === true;
					body.push(
						React.createElement(
							"details",
							{ key: "recent", className: "dsh-rw-fold", open, onToggle: (event) => setCollapsed((prev) => ({ ...prev, recent: event.currentTarget.open === true })) },
							React.createElement("summary", null, icon(open ? "chevronUp" : "chevronRight"), t("recent.title")),
							open
								? React.createElement(
										"div",
										{ className: "dsh-rw-foldbody" },
										recent.length === 0
											? React.createElement("div", { className: "dsh-rw-hint" }, t("recent.empty"))
											: recent.map((path) =>
													React.createElement(
														"button",
														{ key: `recent:${path}`, type: "button", className: "dsh-rw-recent-row", "aria-label": t("browser.crumbJump", { path }), title: path, onClick: () => jumpTo(path) },
														icon("clock"),
														React.createElement("span", { className: "dsh-rw-rowname", dir: "ltr" }, path),
													),
												),
									)
								: null,
						),
					);
				}

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
											t("others.item", { slot: row.slot === undefined || row.slot === null ? "?" : row.slot, state: t("tree.running") }),
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
				if (narrow) {
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
										React.createElement("span", { className: "dsh-rw-hint" }, t("header.distroScope")),
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
						extra.length > 0 ? React.createElement("span", { className: "dsh-rw-extra" }, " · ", extra) : null,
						React.createElement("span", { className: "dsh-rw-spacer" }),
						factsVisible && daemonKnown && daemon.running !== true
							? React.createElement(
									"button",
									{ type: "button", className: "dsh-rw-btn", disabled: action.busy !== null, onClick: () => runDaemon("ensure"), "aria-label": t("status.startAria"), title: t("status.startAria") },
									action.busy === "daemon:ensure" ? t("status.startBusy") : t("status.start"),
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
												React.createElement("div", { id: labelId, className: "dsh-rw-grouplabel", role: "presentation", tabIndex: -1 }, group.label),
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
			};
		}

		exports.createPanel = createPanel;
		exports.openSessionNote = openSessionNote;
		exports.addWorkspaceNote = addWorkspaceNote;
		exports.addWorkspaceErrorText = addWorkspaceErrorText;
		exports.splitHumanText = splitHumanText;
		exports.daemonNote = daemonNote;
		exports.RECENT_KEY = RECENT_KEY;
		return module.exports;
	},
});
