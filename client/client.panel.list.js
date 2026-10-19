/**
 * client.panel.list.js —— 条目列表（窗口化 + 行渲染 + 键盘 + 滚动记忆；第 7 个 chunk，2026-10-19）。
 *
 * 为什么单独拆：browser.js 加入筛选/窗口化/点击/键盘后超过 panel-smoke-node 的 400 行纪律线；
 * 列表自带完整边界（滚动容器、窗口、行、键盘），与卡片外壳分开最干净。
 * 行为：
 * · 大目录（> VIRTUAL_MIN_ROWS）只渲染视口内 + overscan，上下用占位 div 撑住滚动高度；
 * · 行点击（目录）= 进入；行内「进入 / 复制路径」按钮 stopPropagation，绝不导航两次；
 * · roving tabindex：只有 focusIndex 那行 tabIndex=0，键盘移动的是**真实 DOM 焦点**；
 * · 滚动位置按目录记忆（回到上一目录停在原处）；
 * · 加载骨架 / 列表错误（技术细节折叠）/ 空目录 / 筛选无匹配 四态。
 */
window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.list.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		/** 每个目录的滚动位置（模块级：面板重挂/回退都能回到原处）。 */
		const scrollMemory = new Map();
		/** 窗口化几何：行高 32 + gap 2；overscan 4 行。 */
		const ROW_BLOCK = 34, OVERSCAN = 4;
		/**
		 * 找到滚动体（SPEC §7.2.2：列表自己就是滚动体）。判据只用 overflowY，不能要求"此刻
		 * scrollHeight > clientHeight" —— 刚挂载时只有十几行，容器还不可滚动；按旧判据会退化成
		 * 监听 window，虚拟列表撑高后永远收不到 scroll（实测卡在 index 0..23）。
		 */
		function findScrollParent(node) {
			let current = node === null ? null : node;
			while (current !== null && current !== document.body) {
				const style = window.getComputedStyle(current);
				if (/(auto|scroll|overlay)/.test(style.overflowY)) return current;
				current = current.parentElement;
			}
			return null;
		}
		/** 视口窗口（只渲染 start..end）；滚动/尺寸变化用 rAF 合并。小目录不启用，几何与旧实现一致。 */
		function useListWindow(count, listRef, enabled) {
			const [win, setWin] = React.useState(function () {
				return enabled ? { start: 0, end: Math.min(count, OVERSCAN * 4), padTop: 0, padBottom: 0 } : { start: 0, end: count, padTop: 0, padBottom: 0 };
			});
			React.useEffect(
				function () {
					const list = listRef.current;
					if (enabled !== true || list === null || count === 0) {
						setWin({ start: 0, end: enabled === true ? Math.min(count, OVERSCAN * 4) : count, padTop: 0, padBottom: 0 });
						return undefined;
					}
					const scroller = findScrollParent(list);
					let raf = 0;
					const compute = function () {
						raf = 0;
						const listRect = list.getBoundingClientRect();
						const scRect = scroller === null ? null : scroller.getBoundingClientRect();
						const self = scroller === list;
						// ① 列表自己滚（SPEC 常态）⇒ 偏移 = scrollTop；② 列表是外层容器子元素 ⇒ 用视口顶差。
						const viewTop = scroller === null ? -listRect.top : self ? list.scrollTop : scRect.top - listRect.top;
						const height = scroller === null ? window.innerHeight : scroller.clientHeight;
						const first = Math.max(0, Math.floor(viewTop / ROW_BLOCK) - OVERSCAN);
						const last = Math.min(count, Math.ceil((viewTop + height) / ROW_BLOCK) + OVERSCAN);
						const start = Math.min(first, Math.max(0, count - 1));
						const end = Math.max(start, last);
						setWin(function (prev) {
							if (prev.start === start && prev.end === end) return prev;
							return { start, end, padTop: start * ROW_BLOCK, padBottom: Math.max(0, (count - end) * ROW_BLOCK) };
						});
					};
					const schedule = function () {
						if (raf !== 0) return;
						raf = window.requestAnimationFrame(compute);
					};
					compute();
					if (scroller === null) window.addEventListener("scroll", schedule, { passive: true });
					else scroller.addEventListener("scroll", schedule, { passive: true });
					window.addEventListener("resize", schedule);
					let observer = null;
					if (typeof ResizeObserver === "function") {
						observer = new ResizeObserver(schedule);
						observer.observe(list);
						if (scroller !== null) observer.observe(scroller);
					}
					return function () {
						if (raf !== 0) window.cancelAnimationFrame(raf);
						if (scroller === null) window.removeEventListener("scroll", schedule);
						else scroller.removeEventListener("scroll", schedule);
						window.removeEventListener("resize", schedule);
						if (observer !== null) observer.disconnect();
					};
				},
				[count, enabled],
			);
			return win;
		}
		function renderEntries(props) {
			const {
				React, browse, cwd, visibleEntries, searching, search,
				focusIndex, setFocusIndex, jumpTo, joinWslPath, normalizeWslPath,
				icon, t, errorText, listPath, showHidden, hiddenCount, homePathOf,
				VIRTUAL_MIN_ROWS, prefetchDir, cancelPrefetch, run, clearSearch, searchRef,
			} = props;
			// 大目录窗口化：只有条目数超过阈值才启用（hook 必须无条件调用）
			const listRef = React.useRef(null);
			const virtual = VIRTUAL_MIN_ROWS !== undefined && visibleEntries.length > VIRTUAL_MIN_ROWS;
			const win = useListWindow(visibleEntries.length, listRef, virtual);
			/**
			 * 目录滚动位置记忆：持续记录当前目录的 scrollTop，回到该目录时恢复。
			 * 恢复必须等列表真正有内容（ready）再设，否则会被 clamp 到 0（虚拟化占位还没撑起来）。
			 */
			const restoredFor = React.useRef(null);
			React.useEffect(
				function () {
					const list = listRef.current;
					if (list === null) return undefined;
					const scroller = findScrollParent(list);
					if (scroller === null) return undefined;
					const key = cwd === null ? "/" : cwd;
					const onScroll = function () {
						scrollMemory.set(key, scroller.scrollTop);
					};
					scroller.addEventListener("scroll", onScroll, { passive: true });
					if (browse.status === "ready" && restoredFor.current !== key) {
						restoredFor.current = key;
						const target = scrollMemory.get(key);
						window.requestAnimationFrame(function () {
							scroller.scrollTop = typeof target === "number" && target > 0 ? target : 0;
						});
					}
					return function () {
						scroller.removeEventListener("scroll", onScroll);
					};
				},
				[cwd, browse.status, visibleEntries.length],
			);
			/** 把某个 index 的行滚进视口并聚焦（虚拟化下未渲染的行要先滚动再聚焦）。 */
			const focusRowAt = function (index) {
				const list = listRef.current;
				if (list === null) return;
				const scroller = findScrollParent(list);
				const listRect = list.getBoundingClientRect();
				const scRect = scroller === null ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
				const top = index * ROW_BLOCK;
				const self = scroller === list;
				const viewTop = scroller === null ? -listRect.top : self ? list.scrollTop : scRect.top - listRect.top;
				const viewBottom = viewTop + (scroller === null ? window.innerHeight : scroller.clientHeight);
				if (top < viewTop || top + 32 > viewBottom) {
					const delta = top + 32 > viewBottom ? top + 32 - viewBottom + 8 : top - viewTop - 8;
					if (scroller === null) window.scrollBy(0, delta);
					else scroller.scrollTop += delta;
				}
				window.requestAnimationFrame(function () {
					const node = list.querySelector('[data-index="' + index + '"]');
					if (node !== null) node.focus();
				});
			};
			const copyPath = function (childPath) {
				return run(
					'copy:' + childPath,
					() =>
						typeof navigator !== "undefined" && navigator.clipboard
							? navigator.clipboard.writeText(childPath)
							: Promise.reject(new Error(t("row.copyNoClipboard"))),
					{ describe: () => t("browser.copied", { path: childPath }) },
				);
			};
			const slice = virtual ? visibleEntries.slice(win.start, win.end) : visibleEntries;
			const rows = slice.map(function (entry, offset) {
				const index = (virtual ? win.start : 0) + offset;
				const childPath = cwd === null ? entry.name : joinWslPath(cwd, entry.name);
				const isDir = entry.kind === "dir";
				const isCurrent = isDir && cwd !== null && normalizeWslPath(childPath) === cwd;
				const focused = focusIndex === index;
				return React.createElement(
					"div",
					{
						key: 'entry:' + entry.name,
						className:
							"dsh-rw-row" +
							(isDir ? " dsh-rw-row--dir" : "") +
							(isCurrent ? " dsh-rw-row--current dsh-rw-current" : "") +
							(focused ? " dsh-rw-row--focus" : ""),
						tabIndex: focused ? 0 : -1,
						role: "listitem",
						"aria-label": t(isDir ? "browser.rowAriaDir" : "browser.rowAriaFile", { name: entry.name }),
						"aria-current": isCurrent ? "true" : undefined,
						"aria-setsize": visibleEntries.length,
						"aria-posinset": index + 1,
						"data-index": index,
						"data-path": childPath,
						onFocus: function () {
							if (focusIndex !== index) setFocusIndex(index);
						},
						onClick: isDir
							? function (event) {
									if (event.defaultPrevented) return;
									event.preventDefault();
									jumpTo(childPath);
								}
							: undefined,
						onKeyDown: function (event) {
							onListKey(event, index);
						},
						onMouseEnter: isDir ? function () { prefetchDir(childPath); } : undefined,
						onMouseLeave: isDir ? cancelPrefetch : undefined,
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
										onClick: function (event) {
											// 行本身点击即进入 ⇒ 按钮必须阻止冒泡，否则会导航两次
											event.stopPropagation();
											jumpTo(childPath);
										},
									},
									t("browser.enter"),
								)
							: null,
						React.createElement(
							"button",
							{
								type: "button",
								className: "dsh-rw-link",
								"aria-label": t("browser.copyPath"),
								title: t("browser.copyPath"),
								onClick: function (event) {
									event.stopPropagation();
									copyPath(childPath);
								},
							},
							t("row.copy"),
						),
					),
				);
			});
			/**
			 * 键盘：容器与行共用一套语义。
			 * @param event - keydown。
			 * @param explicitIndex - 行上触发时传该行 index；容器触发时省略（用 focusIndex）。
			 */
			const onListKey = function (event, explicitIndex) {
				const count = visibleEntries.length;
				if (count === 0) {
					if (event.key === "/" && searchRef !== null && searchRef.current !== null) {
						event.preventDefault();
						searchRef.current.focus();
					}
					return;
				}
				const current = typeof explicitIndex === "number" ? explicitIndex : focusIndex;
				const page = 8;
				const go = function (next) {
					const clamped = Math.min(count - 1, Math.max(0, next));
					event.preventDefault();
					setFocusIndex(clamped);
					focusRowAt(clamped);
				};
				if (event.key === "ArrowDown") return go(current < 0 ? 0 : current + 1);
				if (event.key === "ArrowUp") return go(current < 0 ? count - 1 : current - 1);
				if (event.key === "Home") return go(0);
				if (event.key === "End") return go(count - 1);
				if (event.key === "PageDown") return go((current < 0 ? 0 : current) + page);
				if (event.key === "PageUp") return go((current < 0 ? 0 : current) - page);
				if (event.key === "Enter") {
					const targetIndex = current < 0 ? 0 : current;
					const entry = visibleEntries[targetIndex];
					if (entry === undefined) return;
					event.preventDefault();
					if (entry.kind === "dir") jumpTo(joinWslPath(cwd, entry.name));
					else copyPath(joinWslPath(cwd, entry.name));
					return;
				}
				if (event.key === "Backspace" && cwd !== null && cwd !== "/") {
					event.preventDefault();
					jumpTo(cwd.replace(/\/[^/]+$/, "") || "/");
					return;
				}
				if (event.key === "/") {
					event.preventDefault();
					if (searchRef !== null && searchRef.current !== null) searchRef.current.focus();
					return;
				}
				if (event.key === "Escape" && searching === true) {
					event.preventDefault();
					clearSearch();
				}
			};
			const homePath = homePathOf(props.target, cwd);
			let content;
			if (browse.status === "loading" && browse.entries.length === 0) {
				const skeletonWidths = [120, 90, 160, 110, 140];
				content = React.createElement(
					"div",
					{ className: "dsh-rw-skeleton", role: "status", "aria-label": t("browser.loadingAria") },
					skeletonWidths.map((width, i) =>
						React.createElement(
							"div",
							{ key: 'sk:' + i, className: "dsh-rw-skeleton-row", "aria-hidden": "true" },
							React.createElement("span", { className: "dsh-rw-skeleton-icon" }),
							React.createElement("span", { className: "dsh-rw-skeleton-bar", style: { width } }),
						),
					),
					React.createElement("span", { className: "dsh-rw-hint" }, t("browser.listing", { path: cwd === null ? "" : cwd })),
				);
			} else if (browse.status === "error") {
				content = React.createElement(
					"div",
					{ className: "dsh-rw-error", role: "alert" },
					React.createElement("div", { className: "dsh-rw-error-title" }, icon("error"), t("browser.listError", { path: cwd === null ? "?" : cwd })),
					React.createElement(
						"details",
						{ className: "dsh-rw-note-details" },
						React.createElement("summary", null, t("note.detailSummary")),
						React.createElement("pre", { className: "dsh-rw-note-detail" }, errorText(browse.error)),
					),
					React.createElement(
						"button",
						{ type: "button", className: "dsh-rw-btn", onClick: () => cwd !== null && listPath(cwd, { force: true }), "aria-label": t("browser.listRetry"), title: t("browser.listRetry") },
						t("error.retry"),
					),
				);
			} else if (browse.status === "ready" && rows.length === 0) {
				content =
					searching === true
						? React.createElement(
								"div",
								{ className: "dsh-rw-empty" },
								React.createElement("div", { className: "dsh-rw-hint" }, t("browser.searchNoMatch", { query: String(search).trim() })),
								React.createElement(
									"button",
									{ type: "button", className: "dsh-rw-btn", onClick: () => { clearSearch(); if (searchRef !== null && searchRef.current !== null) searchRef.current.focus(); }, "aria-label": t("browser.searchClear"), title: t("browser.searchClear") },
									t("browser.searchClear"),
								),
							)
						: React.createElement(
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
							);
			} else {
				content = React.createElement(
					React.Fragment,
					null,
					virtual ? React.createElement("div", { className: "dsh-rw-vpad", style: { height: win.padTop }, "aria-hidden": "true" }) : null,
					rows,
					virtual ? React.createElement("div", { className: "dsh-rw-vpad", style: { height: win.padBottom }, "aria-hidden": "true" }) : null,
				);
			}
			return React.createElement(
				"div",
				{
					ref: listRef,
					className: "dsh-rw-entries",
					role: "list",
					tabIndex: 0,
					onKeyDown: function (event) {
						onListKey(event);
					},
					"aria-label": t("browser.entriesAria", { path: cwd === null ? "" : cwd }),
					"aria-busy": browse.status === "loading" ? "true" : undefined,
				},
				content,
			);
		}
		/**
		 * 作为**真正的组件**挂载（不是父组件里直接调用）：
		 * 列表内部有 useState/useEffect；若在 renderBrowser 的条件分支里直接调用，
		 * 首帧（快照未到）不调用、后续帧调用 ⇒ hooks 数量变化 ⇒ React error 310。
		 */
		function Entries(props) {
			return renderEntries(props);
		}
		exports.Entries = Entries;
		exports.renderEntries = renderEntries;
		return module.exports;
	},
});