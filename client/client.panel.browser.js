/**
 * client.panel.browser.js —— 唯一目录概念的外壳：常去位置 + 面包屑 + 路径输入 + 筛选 + 条目列表容器。
 *
 * 2026-10-21 UI 重做（交互目标：一屏内完成"看清在哪 → 换地方 → 找东西 → 打开"）：
 * · 三行结构压成两层：**常去位置条**（单行横向滚动，不再换行占三行）+ **导航行**（上一级 + 面包屑）
 *   + **输入行**（路径框 + 筛选框同排）。卡片不再有"浏览目录"标题占位。
 * · 列表**吃满剩余高度**（body 不再整页滚动，滚动体是列表自己）——修掉"72 项只显示 6 行、下面一大片空白"。
 * · 隐藏文件开关从卡片头挪到位置条右端，和"位置"同类（视图开关），不再单占一行。
 *
 * 行为由 list.js 承担（窗口化 / 行内动作 / 键盘 / 滚动记忆）；本文件只搭外壳。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.browser.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		function renderBrowser(props) {
			const {
				React, body, breadcrumbOf, browse, clearSearch, collapsed, cwd,
				errorText, factsVisible, hiddenCount, homePathOf, icon, jumpTo, listPath,
				mounts, pathError, pathInput, recent, recentOk,
				Entries, search, searchChange, searchRef, searching,
				setCollapsed, setPathError, setPathInput, setShowHidden, showHidden,
				snapshot, submitPath, t, target, totalEntries, visibleEntries,
			} = props;

			if (factsVisible && snapshot !== null) {
				const crumbs = cwd === null ? [] : breadcrumbOf(cwd);
				const homePath = homePathOf(target, cwd);
				const distroLabel = typeof target.distro === "string" && target.distro.length ? target.distro : "?";

				/** 常去位置：胶囊按钮（单行横向滚动；当前目录高亮）。 */
				const chip = (labelText, path, ariaKey, current) =>
					React.createElement(
						"button",
						{
							key: "chip:" + path,
							type: "button",
							className: "dsh-rw-chip" + (current ? " dsh-rw-chip--on dsh-rw-current" : ""),
							"aria-label": t(ariaKey, { path }),
							title: t(ariaKey, { path }),
							"aria-current": current ? "true" : undefined,
							onClick: () => jumpTo(path),
						},
						labelText,
					);

				const places = React.createElement(
					"div",
					{ className: "dsh-rw-places", role: "group", "aria-label": t("browser.chipsAria") },
					[
						chip(t("browser.chipHome"), homePath, "browser.chipHomeAria", cwd === homePath),
						chip("/", "/", "browser.chipRootAria", cwd === "/"),
						chip("/mnt", "/mnt", "browser.chipMntAria", cwd === "/mnt"),
					]
						.concat(mounts.map((mount) => chip(mount, mount, "browser.chipDriveAria", cwd === mount)))
						.concat([
							React.createElement("span", { key: "spacer", className: "dsh-rw-spacer" }),
							React.createElement(
								"button",
								{
									key: "hidden",
									type: "button",
									className: "dsh-rw-toggle" + (showHidden ? " dsh-rw-toggle--on" : ""),
									"aria-pressed": String(showHidden),
									"aria-label": showHidden ? t("browser.hiddenHideAria") : t("browser.hiddenShowAria"),
									title: showHidden ? t("browser.hiddenHideTitle") : t("browser.hiddenShowTitle"),
									onClick: () => setShowHidden((prev) => !prev),
								},
								icon(showHidden ? "eye" : "eyeOff"),
								React.createElement("span", { className: "dsh-rw-toggle-label" }, t("browser.hiddenShort")),
								hiddenCount > 0 ? React.createElement("span", { className: "dsh-rw-count" }, String(hiddenCount)) : null,
							),
						]),
				);

				const upButton = React.createElement(
					"button",
					{
						type: "button",
						className: "dsh-rw-iconbtn dsh-rw-up",
						disabled: cwd === null || cwd === "/",
						"aria-label": t("browser.up"),
						title: t("browser.upTitle"),
						onClick: function () {
							if (cwd === null || cwd === "/") return;
							jumpTo(cwd.replace(/\/[^/]+$/, "") || "/");
						},
					},
					icon("arrowLeft"),
				);

				const crumbNav = React.createElement(
					"nav",
					{ className: "dsh-rw-crumbs", "aria-label": t("browser.crumbsAria") },
					cwd === null
						? React.createElement("span", { className: "dsh-rw-hint" }, t("browser.notBrowsing"))
						: crumbs.map((crumb, index) =>
								React.createElement(
									React.Fragment,
									{ key: "crumb:" + crumb.path },
									index > 1 ? React.createElement("span", { className: "dsh-rw-crumb-sep", "aria-hidden": "true" }, "/") : null,
									index === crumbs.length - 1
										? React.createElement("span", { className: "dsh-rw-crumb dsh-rw-crumb--current dsh-rw-current" }, crumb.label)
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
				);

				const pathForm = React.createElement(
					"form",
					{
						className: "dsh-rw-pathform",
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
					React.createElement("button", { type: "submit", className: "dsh-rw-btn dsh-rw-btn--quiet", "aria-label": t("browser.jumpAria"), title: t("browser.jumpAria") }, t("browser.jump")),
				);

				const searchBar = React.createElement(
					"div",
					{ className: "dsh-rw-search" },
					React.createElement("span", { className: "dsh-rw-search-icon", "aria-hidden": "true" }, icon("search")),
					React.createElement("input", {
						type: "search",
						ref: searchRef,
						className: "dsh-rw-search-input",
						value: search,
						placeholder: t("browser.searchPlaceholder"),
						"aria-label": t("browser.searchAria", { path: cwd === null ? "" : cwd }),
						title: t("browser.searchTitle"),
						spellCheck: false,
						autoComplete: "off",
						onChange: function (event) {
							searchChange(event.target.value);
						},
						onKeyDown: function (event) {
							if (event.key === "Escape") {
								event.stopPropagation();
								if (searching === true) searchChange("");
								return;
							}
							if (event.key === "ArrowDown") {
								event.preventDefault();
								const first = document.querySelector('.dsh-rw-entries [data-index="0"]');
								if (first !== null) first.focus();
							}
						},
					}),
					React.createElement(
						"span",
						{ className: "dsh-rw-search-count" },
						searching === true ? t("browser.searchCount", { shown: visibleEntries.length, total: totalEntries }) : t("browser.searchTotal", { total: totalEntries }),
					),
					searching === true
						? React.createElement(
								"button",
								{
									type: "button",
									className: "dsh-rw-iconbtn",
									"aria-label": t("browser.searchClear"),
									title: t("browser.searchClear"),
									onClick: function () {
										clearSearch();
										if (searchRef !== null && searchRef.current !== null) searchRef.current.focus();
									},
								},
								icon("close"),
							)
						: null,
				);

				body.push(
					React.createElement(
						"section",
						{ key: "browser", className: "dsh-rw-card", "aria-label": t("browser.aria", { distro: distroLabel }) },
						places,
						React.createElement("div", { className: "dsh-rw-navrow" }, upButton, crumbNav),
						React.createElement("div", { className: "dsh-rw-formrow" }, pathForm, searchBar),
						pathError === null ? null : React.createElement("div", { className: "dsh-rw-note dsh-rw-note--error", role: "alert" }, pathError),
						browse.stale === true
							? React.createElement(
									"div",
									{ className: "dsh-rw-conflict", role: "status" },
									icon("warn", "dsh-rw-drift"),
									React.createElement("span", { className: "dsh-rw-hint", title: errorText(browse.error) }, t("browser.staleNote")),
									React.createElement("span", { className: "dsh-rw-spacer" }),
									React.createElement(
										"button",
										{ type: "button", className: "dsh-rw-link", "aria-label": t("browser.listRetry"), title: t("browser.listRetry"), onClick: () => cwd !== null && listPath(cwd, { force: true }) },
										t("error.retry"),
									),
								)
							: null,
						React.createElement(Entries, props),
					),
				);
			}

			// —— 折叠区：最近目录（M12；localStorage 不可用 ⇒ 整块不渲染） ——
			if (factsVisible && snapshot !== null && recentOk) {
				const open = collapsed.recent === true;
				body.push(
					React.createElement(
						"details",
						{ key: "recent", className: "dsh-rw-fold", open, onToggle: (event) => { const open = event.currentTarget.open === true; setCollapsed((prev) => ({ ...prev, recent: open })); } },
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
													{ key: "recent:" + path, type: "button", className: "dsh-rw-recent-row", "aria-label": t("browser.crumbJump", { path }), title: path, onClick: () => jumpTo(path) },
													icon("clock"),
													React.createElement("span", { className: "dsh-rw-rowname", dir: "ltr" }, path),
												),
											),
								)
							: null,
					),
				);
			}
		}

		exports.renderBrowser = renderBrowser;

		return module.exports;
	},
});
