/**
 * client.panel.browser.js —— 唯一目录概念：chips + 面包屑 + 常显路径输入 + 条目列表（push 进共享 body）
 *
 * T41 机械拆分（生成器 `arch-t6/tools/gen-split2.mjs`，从拆分前备份整块切片）：
 * 被搬动的代码体**逐字不变**；只在本函数开头把上游名字解构回同名局部（显式清单，非正则猜）。
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
	openSessionNote, others, pathError, pathInput,
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
												// T42/N3：主句保持人话（上面的 `browser.listError`），**host 原文**（`\\wsl.localhost\…`、
												// 重复 ENOENT）收进折叠「技术细节」—— 与 T36 给 stop 失败定的同一模式（同一个 i18n 键、
												// 同一对 class），因此不需要新增文案键。
												React.createElement(
													"details",
													{ className: "dsh-rw-note-details" },
													React.createElement("summary", null, t("note.detailSummary")),
													React.createElement("pre", { className: "dsh-rw-note-detail" }, errorText(browse.error)),
												),
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

			// —— 折叠区：最近目录（与目录卡同属"目录概念"；push 顺序不变） ——

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
}

		exports.renderBrowser = renderBrowser;

		return module.exports;
	},
});
