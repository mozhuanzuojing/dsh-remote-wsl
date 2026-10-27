/**
 * client.panel.data.js —— 目录数据层（T41 之后新增的第 6 个 chunk；2026-10-19 UI/UX/性能轮）。
 *
 * 为什么单独拆出来：client.panel.actions.js 已到 400 行纪律线（panel-smoke-node 的"行数 <400"门禁），
 * 而本轮的缓存/单飞/预取逻辑是**与渲染无关**的一段纯数据行为，整块搬走最干净。
 *
 * 语义（与拆分前逐字一致）：
 * · listPath：缓存优先 + 单飞 + stale-while-revalidate（TTL 内 0 等待；过期先回显再复核；
 *   复核失败保留内容并标 stale；同路径并发共享一个请求）；
 * · prefetchDir/cancelPrefetch：悬停/聚焦目录行停 140ms 预取下一层，只写缓存不触发渲染；
 * · jumpTo/submitPath/clearSearch：导航与筛选的入口（换目录即清筛选）。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.data.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** 空闲时长的人类可读形式（会话卡用）：<1m 记 '<1m'，其余 m/h/d。 */
		function formatIdle(ms) {
			const value = Number(ms);
			if (!Number.isFinite(value) || value < 0) return "?";
			if (value < 60000) return "<1m";
			if (value < 3600000) return Math.floor(value / 60000) + "m";
			if (value < 86400000) return Math.floor(value / 3600000) + "h";
			return Math.floor(value / 86400000) + "d";
		}

		function useDirectoryNavigation(props) {
			const {
				React, api, asArray, isRecord, normalizeWslPath,
				dirCache, browseSeq, navSeq, pathInput, pushRecent, t,
				setBrowse, setFocusIndex, setPathError, setPathInput, setRecent, setSearch,
				browseAbort, newAbortController, signalOf,
			} = props;

			/** 当前目标发行版（`null` = host 配置缺省）；缓存键必须带上它（F-34）。 */
			const distroNow = () => (typeof api.getDistro === "function" ? api.getDistro() : null);

			/**
			 * 列目录：**缓存优先 + 单飞 + 后台复核**（stale-while-revalidate）。
			 *
			 * 行为变化（相对旧实现，全部是"更快"而不是"更假"）：
			 * · TTL 内命中：**立即**回显（0 等待）；不再发请求 ⇒ 返回上一目录/在目录间来回点没有网络往返。
			 * · TTL 外命中：**立即**回显旧内容，同时后台发一次请求复核；结果不同则替换。
			 * · 复核失败：**保留**已显示内容并标记 \`stale\`（UI 明确提示"显示的是缓存内容"），
			 *   不把好好的列表变成空错误页 —— 但错误对象仍带着，供"重试"用。
			 * · 同路径并发（悬停预取 / 快速连点）：共享同一个请求（dirCache.inflight），不重复打 host。
			 *
			 * ★ F-34（task-8，P1）：三处一起改，缺一不可 ——
			 *   ① 缓存键 = 发行版 + 路径（`dirCache.key`）⇒ 切发行版后旧键永不再命中；
			 *   ② `browseAbort` 真正**赋值**并把 `signal` 传给 `listDir`（改前是"只读不写"的死引用，
			 *      请求根本不可取消）；被取代时 abort 上一个在飞请求；
			 *   ③ 回包写入前仍比对 `browseSeq` —— `changeDistro` 会 bump 它，旧回包一律丢弃。
			 * @param path - WSL 绝对路径。
			 * @param options - \`{ force: true }\` 绕过缓存（刷新按钮/显式重试用）。
			 */
			const listPath = React.useCallback((path, options) => {
				const want = normalizeWslPath(path);
				// 导航代次：任何一次导航都自增；actions.load 用它拒绝"迟到的刷新覆盖新目录"（F2）
				if (navSeq !== undefined && navSeq !== null) navSeq.current += 1;
				const force = options !== undefined && options !== null && options.force === true;
				const mySeq = browseSeq.current + 1;
				browseSeq.current = mySeq;
				const key = dirCache.key(distroNow(), want);
				setFocusIndex(-1);
				const hit = force ? null : dirCache.get(key);
				if (hit !== null) {
					setBrowse({ status: "ready", cwd: want, entries: hit.entries, error: null, stale: false });
					// 新鲜命中：不发请求（这就是"0 等待返回上一目录"）
					if (!force && dirCache.fresh(key)) return;
				} else {
					setBrowse((prev) => ({ status: "loading", cwd: want, entries: prev.cwd === want ? prev.entries : [], error: null, stale: false }));
				}
				let pending = dirCache.inflight.get(key);
				if (pending === undefined) {
					if (browseAbort.current !== null) browseAbort.current.abort();
					const controller = newAbortController();
					browseAbort.current = controller;
					pending = api.listDir({ path: want }, signalOf(controller)).then((result) => {
						const entries = asArray(result && result.entries).filter((entry) => isRecord(entry) && typeof entry.name === "string");
						dirCache.set(key, entries);
						return entries;
					}).finally(() => {
						// 只摘掉**自己**这一条：同键可能已有更新的请求（F-34/F-40 的清理竞态）
						if (dirCache.inflight.get(key) === pending) dirCache.inflight.delete(key);
						if (browseAbort.current === controller) browseAbort.current = null;
					});
					dirCache.inflight.set(key, pending);
				}
				pending.then(
					(entries) => {
						if (mySeq !== browseSeq.current) return;
						setBrowse({ status: "ready", cwd: want, entries, error: null, stale: false });
					},
					(error) => {
						if (mySeq !== browseSeq.current) return;
						if (error && error.kind === "aborted") return;
						setBrowse((prev) => {
							if (prev.cwd === want && prev.entries.length > 0) {
								// 有缓存内容：保留内容 + 明确标记 stale（不把列表整块撤成错误页）
								return { status: "ready", cwd: want, entries: prev.entries, error, stale: true };
							}
							return { status: "error", cwd: want, entries: [], error, stale: false };
						});
					},
				);
			}, []);

			/**
			 * 悬停/聚焦目录行时的**预取**：停 140ms 才发（避免划过就狂打 host）；
			 * 已缓存/已有在飞请求则直接跳过。结果只进缓存，不触发渲染。
			 */
			const prefetchTimer = React.useRef(null);
			const prefetchTarget = React.useRef(null);
			/** ★ F-40：预取的在飞请求也要能被取消（切发行版 / 卸载 / 换目标）。 */
			const prefetchAbort = React.useRef(null);
			const prefetchDir = React.useCallback((path) => {
				const want = normalizeWslPath(path);
				const key = dirCache.key(distroNow(), want);
				if (dirCache.fresh(key) || dirCache.inflight.has(key)) return;
				prefetchTarget.current = want;
				if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current);
				prefetchTimer.current = setTimeout(() => {
					prefetchTimer.current = null;
					if (prefetchTarget.current !== want) return;
					if (dirCache.fresh(key) || dirCache.inflight.has(key)) return;
					const controller = newAbortController();
					prefetchAbort.current = controller;
					const pending = api.listDir({ path: want }, signalOf(controller)).then((result) => {
						const entries = asArray(result && result.entries).filter((entry) => isRecord(entry) && typeof entry.name === "string");
						dirCache.set(key, entries);
						return entries;
					}, () => null).finally(() => {
						if (dirCache.inflight.get(key) === pending) dirCache.inflight.delete(key);
						if (prefetchAbort.current === controller) prefetchAbort.current = null;
					});
					dirCache.inflight.set(key, pending);
				}, 140);
			}, []);
			const cancelPrefetch = React.useCallback(() => {
				prefetchTarget.current = null;
				if (prefetchTimer.current !== null) {
					clearTimeout(prefetchTimer.current);
					prefetchTimer.current = null;
				}
				// ★ F-40：已发出的预取也要停（否则卸载后仍打 host、回包仍写缓存）
				if (prefetchAbort.current !== null) {
					prefetchAbort.current.abort();
					prefetchAbort.current = null;
				}
			}, []);

			// ★ F-40：卸载时清掉本 hook 拥有的全部定时器/在飞请求（改前只有 onMouseLeave 清预取）
			React.useEffect(
				() => () => {
					cancelPrefetch();
					if (browseAbort.current !== null) {
						browseAbort.current.abort();
						browseAbort.current = null;
					}
				},
				[],
			);

			const jumpTo = React.useCallback(
				(path) => {
					const want = normalizeWslPath(path);
					setPathInput(want);
					setPathError(null);
					// 筛选是"针对当前目录"的瞬时状态：换目录即清空（否则进入新目录可能被旧筛选隐藏成"空目录"）
					setSearch("");
					setFocusIndex(-1);
					listPath(want);
					setRecent(pushRecent(typeof api.getDistro === "function" ? api.getDistro() : null, want));
				},
				[listPath, setSearch],
			);
			/** 清空筛选（Esc / 清除按钮）：焦点回到筛选框，列表恢复全量。 */
			const clearSearch = React.useCallback(() => {
				setSearch("");
				setFocusIndex(-1);
			}, [setSearch]);

			/** UNC 路径 → { distro, linuxPath }；不是 WSL UNC 时返回 null（与 host 的 unc-path 同一规则）。 */
			const parseWslUncInput = (value) => {
				const text = String(value ?? "").trim().split("\\").join("/");
				if (!text.startsWith("//")) return null;
				const parts = text.slice(2).split("/");
				const server = (parts.shift() ?? "").toLowerCase();
				if (server !== "wsl.localhost" && server !== "wsl$") return null;
				const distro = (parts.shift() ?? "").trim();
				if (!distro) return null;
				const tail = parts.join("/");
				return { distro, linuxPath: tail ? "/" + tail : "/" };
			};

			const submitPath = React.useCallback(() => {
				const raw = String(pathInput).trim();
				if (raw.length === 0) {
					setPathError(t("browser.pathRequired"));
					return;
				}
				const unc = parseWslUncInput(raw);
				if (unc !== null) {
					const current = typeof api.getDistro === "function" ? api.getDistro() : null;
					if (current && unc.distro !== current) {
						setPathError(t("browser.pathOtherDistro", { distro: unc.distro, current }));
						return;
					}
					jumpTo(unc.linuxPath);
					return;
				}
				if (!raw.startsWith("/")) {
					setPathError(t("browser.pathNotAbsolute", { raw }));
					return;
				}
				jumpTo(raw);
			}, [jumpTo, pathInput, t]);

			return { listPath, jumpTo, submitPath, clearSearch, prefetchDir, cancelPrefetch, formatIdle };
		}

		exports.useDirectoryNavigation = useDirectoryNavigation;
		return module.exports;
	},
});