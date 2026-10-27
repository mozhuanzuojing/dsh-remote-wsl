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
		/** 大目录窗口化：条目数超过它才启用（小目录保持全量渲染，行为与几何都不变）。 */
		const VIRTUAL_MIN_ROWS = 200;
		/** 行占位 = 32 行高 + 2 gap（窗口化换算常量；改 .dsh-rw-row 高度必须同步这里）。 */
		const ROW_BLOCK = 34;
		/** 目录列表客户端缓存：TTL / 条数上限（为了"返回上一目录瞬时回显"）。 */
		const DIR_CACHE_TTL_MS = 30000;
		const DIR_CACHE_MAX = 80;

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

		/**
		 * 客户端目录缓存 + 单飞请求（跨面板卸载/重挂仍复用同一引用）。
		 * TTL 内命中 ⇒ 0 等待回显；TTL 外命中 ⇒ 先回显再后台复核（stale-while-revalidate）；
		 * 同路径并发 ⇒ 共享一个请求；显式刷新用 listPath(path,{force:true}) 绕缓存。
		 * ★ F-34（P1）：键 = **发行版 + 路径**（{@link dirCache.key}）—— 改前只按路径做键，
		 *   切发行版后 30s 内可能把 A 的目录当成 B 的显示（"添加工作区/新建会话"会指错地方）。
		 *   现在切换后旧键永不再命中；`clear()` 退化为**回收内存**，正确性不依赖它。
		 */
		const dirCache = {
			ttl: DIR_CACHE_TTL_MS,
			max: DIR_CACHE_MAX,
			entries: new Map(),
			inflight: new Map(),
			/** 键：`<distro>\u0000<path>`（distro 为空记 `*`；NUL 分隔 ⇒ WSL 路径里的 `:` 不撞）。 */
			key(distro, path) {
				return `${typeof distro === "string" && distro.length > 0 ? distro : "*"}\u0000${path}`;
			},
			get(key) {
				const hit = this.entries.get(key);
				if (hit === undefined || hit === null) return null;
				if (Date.now() - hit.at > this.ttl) {
					this.entries.delete(key);
					return null;
				}
				return hit;
			},
			fresh(key) {
				const hit = this.entries.get(key);
				return hit !== undefined && hit !== null && Date.now() - hit.at <= this.ttl;
			},
			set(key, entries) {
				this.entries.delete(key);
				this.entries.set(key, { entries, at: Date.now() });
				while (this.entries.size > this.max) {
					const oldest = this.entries.keys().next();
					if (oldest.done === true) break;
					this.entries.delete(oldest.value);
				}
			},
			invalidate(key) {
				this.entries.delete(key);
			},
			/** 切换目标发行版：回收内存（正确性已由键里的 distro 保证，不依赖这次清空）。 */
			clear() {
				this.entries.clear();
				this.inflight.clear();
			},
		};

		/**
		 * 目录优先 + 名称升序（设计稿 §7：host 只保证 name 升序，**dir/file 分组由 client 做**）。
		 * 用与 host 相同的二进制比较（`<`）而不是 localeCompare：跨语言/跨机器排序必须是确定性的。
		 */
		function sortEntries(entries) {
			return entries.slice().sort((a, b) => {
				const ak = a && a.kind === "dir" ? 0 : 1;
				const bk = b && b.kind === "dir" ? 0 : 1;
				if (ak !== bk) return ak - bk;
				const an = String(a && a.name);
				const bn = String(b && b.name);
				return an < bn ? -1 : an > bn ? 1 : 0;
			});
		}

		/**
		 * 目录过滤：隐藏文件开关 + 名称子串（大小写不敏感）。
		 * 过滤在**客户端**做（host 一次返回全部条目）⇒ 敲字即时、不重发请求。
		 */
		function filterEntries(entries, showHidden, query) {
			const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
			return entries.filter((entry) => {
				if (showHidden !== true && entry.hidden === true) return false;
				if (needle.length === 0) return true;
				return String(entry.name).toLowerCase().indexOf(needle) >= 0;
			});
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
		/** 全部最近目录：{ [distro]: string[] }；旧版是裸数组 ⇒ 读成 "*"（未分组），写入时再迁到具体发行版。 */
		function readRecentAll() {
			try {
				const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(RECENT_KEY);
				if (typeof raw !== "string" || raw.length === 0) return {};
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					const legacy = parsed.filter((item) => typeof item === "string" && item.startsWith("/")).slice(0, RECENT_MAX);
					return legacy.length ? { "*": legacy } : {};
				}
				if (parsed === null || typeof parsed !== "object") return {};
				const out = {};
				for (const key of Object.keys(parsed)) {
					const list = Array.isArray(parsed[key]) ? parsed[key].filter((item) => typeof item === "string" && item.startsWith("/")).slice(0, RECENT_MAX) : [];
					if (list.length) out[key] = list;
				}
				return out;
			} catch {
				return {};
			}
		}

		/** 某个发行版的最近目录（未分组的历史作为回退）。 */
		function readRecent(distro) {
			const all = readRecentAll();
			const key = typeof distro === "string" && distro.length > 0 ? distro : "*";
			return all[key] || all["*"] || [];
		}

		/** 记录一次目录访问，返回整张分组表（面板状态直接用）。 */
		function pushRecent(distro, path) {
			try {
				const value = normalizeWslPath(path);
				const all = readRecentAll();
				const key = typeof distro === "string" && distro.length > 0 ? distro : "*";
				const next = [value].concat((all[key] || []).filter((item) => item !== value)).slice(0, RECENT_MAX);
				all[key] = next;
				if (typeof localStorage !== "undefined") localStorage.setItem(RECENT_KEY, JSON.stringify(all));
				return all;
			} catch {
				return {};
			}
		}
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
		exports.DIR_CACHE_MAX = DIR_CACHE_MAX;
		exports.dirCache = dirCache;
		exports.DIR_CACHE_TTL_MS = DIR_CACHE_TTL_MS;
		exports.ROW_BLOCK = ROW_BLOCK;
		exports.VIRTUAL_MIN_ROWS = VIRTUAL_MIN_ROWS;
		exports.filterEntries = filterEntries;
		exports.sortEntries = sortEntries;
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
		exports.newAbortController = newAbortController;
		exports.normalizeWslPath = normalizeWslPath;
		exports.openSessionNote = openSessionNote;
		exports.pushRecent = pushRecent;
		exports.readRecent = readRecent;
		exports.readRecentAll = readRecentAll;
		exports.signalOf = signalOf;
		exports.splitFirstSentence = splitFirstSentence;
		exports.splitHumanText = splitHumanText;

		return module.exports;
	},
});