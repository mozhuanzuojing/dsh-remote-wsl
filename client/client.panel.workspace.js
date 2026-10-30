/**
 * client.panel.workspace.js —— 「添加 WSL 工作区」弹窗。
 *
 * 参考 dsh-wsl-workspace 的 AddWslWorkspace 交互（MIT）：聚焦的 workspace picker，
 * 路径输入 + 快捷位置 + breadcrumb + 目录列表 + 清晰的 Create/Open 主操作。
 * 这里只复用本插件已有的 explorer API（snapshot/listDir/addWorkspace/newSession），
 * 不新增 host 协议，也不把活动目录状态泄漏到面板。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.workspace.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		function joinPath(base, name) {
			if (base === "/") return "/" + name;
			return base.replace(/\/+$/, "") + "/" + name;
		}
		function pathParts(path) {
			return String(path || "/").split("/").filter(Boolean);
		}
		function humanError(error) {
			return error && error.message ? String(error.message) : String(error || "unknown error");
		}
		function fmtSize(size) {
			if (typeof size !== "number" || !Number.isFinite(size)) return "";
			if (size < 1024) return size + " B";
			if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
			if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
			return (size / 1024 / 1024 / 1024).toFixed(1) + " GB";
		}
		function fmtMtime(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
			const d = new Date(ms);
			if (Number.isNaN(d.getTime())) return "";
			return d.toISOString().slice(0, 16).replace("T", " ");
		}

		function WorkspaceDialog({ api, ctx, t, onClose }) {
			const [openReady, setOpenReady] = React.useState(false);
			const [distros, setDistros] = React.useState([]);
			const [distro, setDistroState] = React.useState("");
			const [path, setPathState] = React.useState("/home");
			const [input, setInput] = React.useState("/home/");
			const [listing, setListing] = React.useState(null);
			const [busy, setBusy] = React.useState("");
			const [error, setError] = React.useState(null);
			const seq = React.useRef(0);
			const previousDistro = React.useRef(null);

			const setDistro = (next) => {
				setDistroState(next || "");
				try { api.setDistro(next || null); } catch { /* old host */ }
			};
			const load = async (targetDistro, targetPath) => {
				const mine = ++seq.current;
				setBusy("list");
				setError(null);
				try {
					setDistro(targetDistro);
					const value = await api.listDir({ path: targetPath });
					if (mine !== seq.current) return;
					setListing(value);
					setPathState(targetPath);
					setInput(targetPath);
					setOpenReady(true);
				} catch (e) {
					if (mine !== seq.current) return;
					setListing(null);
					setError(humanError(e));
				} finally {
					if (mine === seq.current) setBusy("");
				}
			};

			React.useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const snap = await api.snapshot(undefined, { refresh: true });
						if (cancelled) return;
						const names = Array.isArray(snap && snap.distros) ? snap.distros.filter((x) => typeof x === "string") : [];
						const target = snap && snap.target && typeof snap.target.distro === "string" ? snap.target.distro : (names[0] || "");
						setDistros(names);
						previousDistro.current = typeof api.getDistro === "function" ? api.getDistro() : null;
						setDistro(target);
						const home = snap && snap.target && typeof snap.target.wslHome === "string" ? snap.target.wslHome : "/home";
						await load(target, home || "/home");
					} catch (e) {
						if (!cancelled) {
							setOpenReady(true);
							setError(humanError(e));
						}
					}
				})();
				return () => { cancelled = true; };
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			const restoreDistro = () => {
				try { api.setDistro(previousDistro.current || null); } catch { /* old host */ }
			};
			const close = () => {
				restoreDistro();
				if (typeof onClose === "function") onClose();
			};
			const create = async () => {
				const target = path || input.trim();
				if (!target) { setError(t("workspace.needPath")); return; }
				setBusy("create");
				setError(null);
				try {
					setDistro(distro);
					const ws = await api.addWorkspace({ path: target });
					if (!ws || ws.ok !== true) throw new Error(t("workspace.addFailed"));
					let created = null;
					try {
						created = await api.newSession({ path: target, workspaceId: ws.id });
					} catch (e) {
						throw new Error(t("workspace.newSessionFailed", { msg: humanError(e) }));
					}
					const nav = ctx && typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
					if (nav && typeof nav.openSession === "function" && created && created.sessionId) {
						try { await nav.openSession(created.sessionId); } catch { /* 已创建，左侧可打开 */ }
					}
					restoreDistro();
					if (typeof onClose === "function") onClose();
				} catch (e) {
					setError(humanError(e));
				} finally {
					setBusy("");
				}
			};

			const entries = listing && Array.isArray(listing.entries) ? listing.entries : [];
			const chips = ["/", "/home", "/mnt"].filter((p, i, arr) => arr.indexOf(p) === i);
			const crumbs = pathParts(path);
			const pathLabel = path === "/" ? "/" : "/" + crumbs.join("/");
			const row = (entry) => {
				const isDir = entry.kind === "dir";
				const child = joinPath(path, entry.name);
				return React.createElement(
					"button",
					{
						key: "e:" + entry.name,
						type: "button",
						className: "dsh-rw-wdialog-row" + (isDir ? " dsh-rw-wdialog-row--dir" : ""),
						onClick: () => { if (isDir) void load(distro, child); },
						title: child,
					},
					React.createElement("span", { className: "dsh-rw-wdialog-name", dir: "ltr" }, entry.name),
					React.createElement("span", { className: "dsh-rw-wdialog-meta" }, isDir ? "" : fmtSize(entry.size)),
					React.createElement("span", { className: "dsh-rw-wdialog-arrow", "aria-hidden": "true" }, isDir ? "›" : ""),
				);
			};

			return React.createElement(
				"div",
				{ className: "dsh-rw-wdialog-overlay", role: "presentation", onMouseDown: (event) => { if (event.target === event.currentTarget) close(); } },
				React.createElement(
					"section",
					{ className: "dsh-rw-wdialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "dsh-rw-wdialog-title" },
					React.createElement(
						"header",
						{ className: "dsh-rw-wdialog-head" },
						React.createElement("div", null,
							React.createElement("div", { id: "dsh-rw-wdialog-title", className: "dsh-rw-wdialog-title" }, t("workspace.title")),
							React.createElement("div", { className: "dsh-rw-hint" }, t("workspace.subtitle")),
						),
						React.createElement("button", { type: "button", className: "dsh-rw-iconbtn", onClick: close, "aria-label": t("workspace.close"), title: t("workspace.close") }, "×"),
					),
					React.createElement("div", { className: "dsh-rw-wdialog-distro" },
						React.createElement("label", { className: "dsh-rw-hint", htmlFor: "dsh-rw-wdialog-distro-select" }, t("workspace.distro")),
						React.createElement("select", {
							id: "dsh-rw-wdialog-distro-select",
							className: "dsh-rw-path-input",
							value: distro,
							onChange: (event) => { const next = event.target.value; setDistro(next); void load(next, path || "/home"); },
						}, distros.map((name) => React.createElement("option", { key: name, value: name }, name))),
					),
					React.createElement("div", { className: "dsh-rw-wdialog-chips" },
						chips.map((p) => React.createElement("button", {
							key: "chip:" + p,
							type: "button",
							className: "dsh-rw-chip" + (path === p ? " dsh-rw-chip--on dsh-rw-current" : ""),
							onClick: () => void load(distro, p),
							title: p,
						}, p)),
					),
					React.createElement("form", { className: "dsh-rw-wdialog-path", onSubmit: (event) => { event.preventDefault(); void load(distro, input.trim() || "/"); } },
						React.createElement("input", {
							className: "dsh-rw-path-input",
							value: input,
							onChange: (event) => setInput(event.target.value),
							placeholder: "/home/you/project",
							"aria-label": t("workspace.pathAria"),
							spellCheck: false,
							autoComplete: "off",
						}),
						React.createElement("button", { type: "submit", className: "dsh-rw-btn" }, t("workspace.go")),
					),
					React.createElement("div", { className: "dsh-rw-wdialog-crumbs", "aria-label": t("workspace.crumbs") },
						React.createElement("button", { type: "button", className: "dsh-rw-crumb", onClick: () => void load(distro, "/") }, "/"),
						crumbs.map((part, index) => {
							const target = "/" + crumbs.slice(0, index + 1).join("/");
							return React.createElement(React.Fragment, { key: "crumb:" + target },
								React.createElement("span", { className: "dsh-rw-crumb-sep", "aria-hidden": "true" }, "/"),
								React.createElement("button", { type: "button", className: "dsh-rw-crumb" + (index === crumbs.length - 1 ? " dsh-rw-crumb--current" : ""), onClick: () => void load(distro, target), title: target }, part),
							);
						}),
						React.createElement("span", { className: "dsh-rw-hint" }, " " + pathLabel),
					),
					React.createElement("div", { className: "dsh-rw-wdialog-list", role: "list", "aria-busy": busy === "list" ? "true" : "false" },
						busy === "list"
							? React.createElement("div", { className: "dsh-rw-wdialog-state" }, t("workspace.loading"))
							: error
								? React.createElement("div", { className: "dsh-rw-wdialog-state dsh-rw-wdialog-state--error", role: "alert" }, error)
								: entries.length === 0
									? React.createElement("div", { className: "dsh-rw-wdialog-state" }, t("workspace.empty"))
									: entries.map(row),
					),
					React.createElement("footer", { className: "dsh-rw-wdialog-foot" },
						React.createElement("span", { className: "dsh-rw-hint" }, t("workspace.hint")),
						React.createElement("span", { className: "dsh-rw-spacer" }),
						React.createElement("button", { type: "button", className: "dsh-rw-btn", onClick: close, disabled: busy !== "" }, t("workspace.cancel")),
						React.createElement("button", { type: "button", className: "dsh-rw-btn dsh-rw-btn--primary", onClick: create, disabled: busy !== "" || !openReady }, busy === "create" ? t("workspace.creating") : t("workspace.create")),
					),
				),
			);
		}

		exports.WorkspaceDialog = WorkspaceDialog;
		return module.exports;
	},
});
