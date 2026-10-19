/**
 * client.panel.browser.js —— 唯一目录概念的外壳：chips + 面包屑 + 路径输入 + 筛选 + 条目列表容器。
 *
 * 2026-10-19 UI/UX/性能轮（在原地增量，不回退冻结规格）：
 * · 新增筛选框（客户端过滤、即时；"/" 聚焦、Esc 清空）与结果计数；
 * · 条目列表整块拆到 client.panel.list.js（窗口化 >200 条、行点击即进入、真实焦点键盘、滚动记忆）；
 * · 缓存复核失败时保留列表并明确标 stale（可重试），不再把好好的列表撤成错误页。
 *
 * 本文件只负责"卡片外壳与工具栏"，列表行为见 list.js（拆分原因：400 行纪律线，见 panel-smoke-node）。
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
				mounts, normalizeWslPath, pathError, pathInput, recent, recentOk,
				Entries, search, searchChange, searchRef, searching,
				setCollapsed, setPathError, setPathInput, setShowHidden, showHidden,
				snapshot, submitPath, t, target, totalEntries, visibleEntries,
			} = props;

			if (factsVisible && snapshot !== null) {
				const crumbs = cwd === null ? [] : breadcrumbOf(cwd);
				const homePath = homePathOf(target, cwd);
				const distroLabel = typeof target.distro === "string" && target.distro.length ? target.distro : "?";
				const chip = (labelText, path, ariaKey, current) =>
					React.createElement(
						"button",
						{
							key: 'chip:' + path,
							type: "button",
							className: "dsh-rw-chip" + (current ? " dsh-rw-chip--on dsh-rw-current" : ""),
							"aria-label": t(ariaKey, { path }),
							title: t(ariaKey, { path }),
							"aria-current": current ? "true" : undefined,
							onClick: () => jumpTo(path),
						},
						labelText,
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
								const target0 = document.querySelector('.dsh-rw-entries [data-index="0"]');
								if (target0 !== null) target0.focus();
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
											{ key: 'crumb:' + crumb.path },
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
						searchBar,
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
													{ key: 'recent:' + path, type: "button", className: "dsh-rw-recent-row", "aria-label": t("browser.crumbJump", { path }), title: path, onClick: () => jumpTo(path) },
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