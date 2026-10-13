/**
 * client.panel.helpers.js —— 常量 + 纯函数 + 文案格式化 + 内联 SVG 图标 + StatusDot
 *
 * T41 机械拆分（生成器 `arch-t6/tools/gen-split2.mjs`，从拆分前备份整块切片）：
 * 被搬动的代码体**逐字不变**；只在本函数开头把上游名字解构回同名局部（显式清单，非正则猜）。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.helpers.js",
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

		exports.HIDE_UPDATED_PX = HIDE_UPDATED_PX;
		exports.NARROW_PX = NARROW_PX;
		exports.RECENT_KEY = RECENT_KEY;
		exports.RECENT_MAX = RECENT_MAX;
		exports.StatusDot = StatusDot;
		exports.actionFailure = actionFailure;
		exports.actionFailureText = actionFailureText;
		exports.addWorkspaceErrorText = addWorkspaceErrorText;
		exports.addWorkspaceNote = addWorkspaceNote;
		exports.asArray = asArray;
		exports.breadcrumbOf = breadcrumbOf;
		exports.clock = clock;
		exports.daemonNote = daemonNote;
		exports.errorText = errorText;
		exports.homePathOf = homePathOf;
		exports.icon = icon;
		exports.isRecord = isRecord;
		exports.joinWslPath = joinWslPath;
		exports.mountsCache = mountsCache;
		exports.newAbortController = newAbortController;
		exports.normalizeWslPath = normalizeWslPath;
		exports.openSessionNote = openSessionNote;
		exports.pushRecent = pushRecent;
		exports.readRecent = readRecent;
		exports.signalOf = signalOf;
		exports.splitFirstSentence = splitFirstSentence;
		exports.splitHumanText = splitHumanText;

		return module.exports;
	},
});
