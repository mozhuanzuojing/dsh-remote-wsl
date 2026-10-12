/**
 * dsh-remote-wsl —— client 半入口（**手写的 lazy-CJS loader bundle**，零构建）。
 *
 * 为什么长这样（都有出处，不是猜的）：
 * - 静态 `dsh.client` 半没有 ESM、没有 JSX 转换、**没有** `host.call`/`styles.insert`
 *   （那两个是动态包 cordis_define/run 的 closure 内建：
 *   @deepseek-ai/dsh-cordis-client-runner/lib/client.js:54,157）。
 * - bundle 的固定形状 = `window.__ModuleLoader__.load({ id, factory })`，factory 收到一个
 *   只有平台种子表能解析的 `require`（react 等），Cordis 插件面靠 `exports.apply/inject`
 *   （官方 ui-sidebar/lib/client.js:1-10,530-533 同形）。
 * - 一个包只有**一个**被 serve 的入口（`exports["./client"]`）；要拆文件只能走包内 chunk：
 *   `require.async("./client.<name>.js")` → 路由 `/plugins/<pkg>/client.<name>.js`
 *   （CLIENT_CHUNK 正则见 dsh-client-modules/lib/index.js:169；文件位置 = 入口同目录，
 *   见 lib/index.js:938；chunk 注册用 `{ id, chunk: "<fileName>", factory }`，
 *   见 lib/client.js:571-580）。所以拆出来的文件名**只能**是 `client.<name>.js`。
 * - 取数：同源 `fetch("/remote-wsl/api")`（host 半 src/explorer.ts 的精确路由），
 *   封在 client.api.js 里；面板/图标/入口都不直接对 URL 说话。
 *
 * 槽位（docs/remote-explorer-design.md §3）：
 *   sidebar.panellist（list）{ id:'remote-wsl', order:20, label:()=>'远程资源管理器' }
 *   main            （keyed）{ key:'remote-wsl' } —— key 与 id 必须同名
 * 两者都由父 entry 声明，所以注册统一包在 `ctx.slots.inject(key, …)` 里等声明出现
 * （renderer/lib/client.js:1343-1402）。
 *
 * 挂载/卸载只读快照，**不杀守护**；唯一会动守护的是用户点状态条上的按钮。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		const PANEL_ID = "remote-wsl";
		const PANEL_ORDER = 20;
		const PANEL_LABEL = "远程资源管理器";

		/** 包内 chunk（入口同目录；名字被平台的 CLIENT_CHUNK 正则钉死）。 */
		const CHUNK_API = "client.api.js";
		const CHUNK_PANEL = "client.panel.js";
		const CHUNK_ICON = "client.icon.js";

		const CSS = [
			".dsh-rw-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}",
			".dsh-rw-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}",
			".dsh-rw-header-text{display:flex;flex-direction:column;min-width:0}",
			".dsh-rw-title{font-weight:600}",
			".dsh-rw-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-rw-header-actions{display:flex;align-items:center;gap:8px;flex:none}",
			".dsh-rw-field{display:flex;align-items:center;gap:6px}",
			".dsh-rw-field-label{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsh-rw-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:3px 6px;font:inherit;max-width:200px}",
			".dsh-rw-btn{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:3px 10px;cursor:pointer;font:inherit}",
			".dsh-rw-btn:hover:enabled{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
			".dsh-rw-btn:disabled{opacity:.55;cursor:default}",
			".dsh-rw-body{flex:1;min-height:0;overflow:auto;padding:8px 6px}",
			".dsh-rw-tree{display:flex;flex-direction:column;gap:2px}",
			".dsh-rw-distro{display:flex;flex-direction:column}",
			".dsh-rw-distro-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;color:inherit;font:inherit;padding:5px 8px;border-radius:4px;cursor:pointer}",
			".dsh-rw-distro-row:hover{background:var(--dsw-alias-bg-layer-2)}",
			".dsh-rw-caret{width:12px;color:var(--dsw-alias-label-secondary);flex:none}",
			".dsh-rw-distro-name{font-weight:600;flex:none}",
			".dsh-rw-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none}",
			".dsh-rw-badge--brand{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
			".dsh-rw-workspaces{display:flex;flex-direction:column;margin-left:20px;border-left:1px solid var(--dsw-alias-border-l1);padding-left:8px}",
			".dsh-rw-workspace{display:flex;align-items:center;gap:10px;padding:4px 6px;border-radius:4px}",
			".dsh-rw-workspace:hover{background:var(--dsw-alias-bg-layer-2)}",
			".dsh-rw-workspace-label{flex:none;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			// F35：路径必须显式 LTR。之前这里写 `direction:rtl`（本意是让长路径露出尾部），
			// 结果 `/home/g/project/dsh1` 被渲染成 `home/g/project/dsh1/`（DOM 文本没问题，是方向错）。
			".dsh-rw-workspace-path{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;unicode-bidi:plaintext;text-align:left}",
			// F35 自查：其它会内嵌 WSL 路径 / 命令 / JSON 的文本容器一律显式 LTR（CJK 不受影响）
			".dsh-rw-pre,.dsh-rw-note,.dsh-rw-error-body,.dsh-rw-confirm-body,.dsh-rw-hint,.dsh-rw-other-note{direction:ltr;unicode-bidi:plaintext}",
			".dsh-rw-workspace-actions{display:flex;gap:8px;flex:none}",
			".dsh-rw-link{background:none;border:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0}",
			".dsh-rw-link:hover:enabled{text-decoration:underline}",
			".dsh-rw-link:disabled{opacity:.55;cursor:default}",
			".dsh-rw-link--danger{color:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-hint{color:var(--dsw-alias-label-secondary);padding:6px 8px;font-size:12px}",
			".dsh-rw-empty{color:var(--dsw-alias-label-secondary);padding:14px;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;margin:8px}",
			".dsh-rw-error{margin:8px;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px;align-items:flex-start}",
			".dsh-rw-error-title{color:var(--dsw-alias-state-error-primary);font-weight:600}",
			".dsh-rw-error-body{white-space:pre-wrap;word-break:break-word}",
			".dsh-rw-error-meta{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsh-rw-note{margin:8px;padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);white-space:pre-wrap}",
			".dsh-rw-note--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-confirm{margin:8px;padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:6px;align-items:flex-start}",
			".dsh-rw-confirm-title{color:var(--dsw-alias-state-warn-primary);font-weight:600}",
			".dsh-rw-confirm-body{white-space:pre-wrap;word-break:break-word}",
			".dsh-rw-confirm-actions{display:flex;gap:8px}",
			".dsh-rw-others{margin:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:4px}",
			".dsh-rw-others-title{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsh-rw-other{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
			".dsh-rw-other-main{font-weight:600}",
			".dsh-rw-other-note{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsh-rw-btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-btn--danger:hover:enabled{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-1)}",
			".dsh-rw-raw{margin:8px;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-pre{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;max-height:260px;overflow:auto;font-size:12px;color:var(--dsw-alias-label-primary)}",
			".dsh-rw-status{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);flex:none;font-size:12px}",
			".dsh-rw-status-left,.dsh-rw-status-right{display:flex;align-items:center;gap:8px;min-width:0}",
			".dsh-rw-status-actions{display:flex;gap:8px}",
			".dsh-rw-status-text{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-rw-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}",
			".dsh-rw-dot--on{background:var(--dsw-alias-state-success-primary)}",
			".dsh-rw-dot--off{background:var(--dsw-alias-state-idle-primary)}",
			".dsh-rw-drift{color:var(--dsw-alias-state-warn-primary);display:flex;align-items:center;gap:4px;flex:none}",
			".dsh-rw-webhosts{display:flex;gap:4px}",
			".dsh-rw-icon{display:block}",
			".dsh-rw-icon--active{color:var(--dsw-alias-brand-primary)}",
		].join("\n");

		// 静态 bundle 的样式注入：手写 <style data-plugin-css>，卸载时由 module system 的
		// owned-style 清理按 data-plugin 回收（官方 ui-sidebar/lib/client.js:12-21 同形）。
		// 注意：`styles.insert(css)` 是动态包专属，静态半没有。
		const CSS_TAG_ID = "dsh-remote-wsl/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-remote-wsl";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const chunkCache = new Map();
		function loadChunk(fileName) {
			let pending = chunkCache.get(fileName);
			if (pending === undefined) {
				pending = Promise.resolve().then(() => require.async("./" + fileName));
				chunkCache.set(fileName, pending);
			}
			return pending;
		}

		/**
		 * 入口只做「注册 + 等 chunk」：先取传输层，再取组件实现。
		 * chunk 拿不到也不静默——错误会显示在图标位/面板体里。
		 */
		function bootChunks(ctx) {
			return loadChunk(CHUNK_API).then((apiModule) => {
				const createExplorerApi = apiModule && apiModule.createExplorerApi;
				if (typeof createExplorerApi !== "function") {
					throw new Error(CHUNK_API + " 未导出 createExplorerApi()");
				}
				const api = createExplorerApi();
				return Promise.all([loadChunk(CHUNK_PANEL), loadChunk(CHUNK_ICON)]).then(([panelModule, iconModule]) => {
					const createPanel = panelModule && panelModule.createPanel;
					const createIcon = iconModule && iconModule.createIcon;
					if (typeof createPanel !== "function") throw new Error(CHUNK_PANEL + " 未导出 createPanel()");
					if (typeof createIcon !== "function") throw new Error(CHUNK_ICON + " 未导出 createIcon()");
					return { api, Panel: createPanel(ctx, api), Icon: createIcon(ctx) };
				});
			});
		}

		/**
		 * Cordis 插件面。
		 * @param ctx - client 受限 cordis 上下文（`slots` 服务由 ui-renderer 提供）。
		 */
		function apply(ctx) {
			const boot = { ready: false, error: null, Panel: null, Icon: null };
			const listeners = new Set();
			const settle = () => {
				for (const listener of [...listeners]) listener();
				listeners.clear();
			};
			bootChunks(ctx).then(
				(product) => {
					boot.api = product.api;
					boot.Panel = product.Panel;
					boot.Icon = product.Icon;
					boot.ready = true;
				},
				(error) => {
					boot.error = error instanceof Error ? error : new Error(String(error));
					if (typeof console !== "undefined" && console.error) {
						console.error("[dsh-remote-wsl] client chunk 加载失败", error);
					}
				},
			).then(settle, settle);

			// chunk 就绪前先渲染占位，就绪后重渲染（组件身份稳定，不违反 hooks 规则）。
			function useBoot() {
				const [, force] = React.useReducer((n) => n + 1, 0);
				React.useEffect(() => {
					if (boot.ready || boot.error !== null) return undefined;
					listeners.add(force);
					return () => {
						listeners.delete(force);
					};
				}, []);
				return boot;
			}

			function IconSlot(props) {
				const current = useBoot();
				if (current.error !== null) {
					return React.createElement("span", {
						className: "dsh-rw-icon",
						style: { width: props.size || 20, height: props.size || 20, color: "var(--dsw-alias-state-error-primary)" },
						title: "dsh-remote-wsl client chunk 加载失败：" + current.error.message,
					});
				}
				if (current.Icon === null) return null;
				return React.createElement(current.Icon, props);
			}

			function PanelSlot() {
				const current = useBoot();
				if (current.error !== null) {
					return React.createElement(
						"section",
						{ className: "dsh-rw-root", "data-dsh-remote-wsl": "panel" },
						React.createElement(
							"div",
							{ className: "dsh-rw-error", role: "alert" },
							React.createElement("div", { className: "dsh-rw-error-title" }, "面板模块加载失败"),
							React.createElement("div", { className: "dsh-rw-error-body" }, current.error.message),
						),
					);
				}
				if (current.Panel === null) {
					return React.createElement(
						"section",
						{ className: "dsh-rw-root", "data-dsh-remote-wsl": "panel" },
						React.createElement("div", { className: "dsh-rw-hint" }, "正在加载面板…"),
					);
				}
				return React.createElement(current.Panel, {});
			}

			// 每个槽都要等父 entry 的 children 表声明它（否则 register 会 throw）。
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: PANEL_ORDER,
						label: () => PANEL_LABEL,
					},
					IconSlot,
				),
			);
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
					},
					PanelSlot,
				),
			);
		}

		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
