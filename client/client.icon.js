/**
 * client.icon.js —— 侧栏 rail 里的 WSL 图标（`sidebar.panellist` 的 occupant）。
 *
 * 文件名约束见 client.api.js 头部说明（chunk 名被平台的 CLIENT_CHUNK 正则钉死）。
 *
 * 契约（docs/remote-explorer-design.md §3，实测 `SidebarPanelIconOwnerProps`）：
 *   props = { size: number, active: boolean }
 * 图标是**组件**不是图片路径；只画 `React.createElement`，无 JSX、无第三方图标库。
 * 颜色一律走 currentColor —— rail 由外壳决定非激活态颜色，激活态我们用品牌 token 抬一下。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.icon.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/**
		 * 造图标组件。`ctx` 目前不需要，但保留形参以便将来加"漂移红点"之类的 ctx 依赖。
		 * @param ctx - client 受限 cordis 上下文。
		 * @returns ({ size, active }) => ReactElement
		 */
		function createIcon(ctx) {
			return function RemoteWslIcon(props) {
				const size = typeof props.size === "number" && props.size > 0 ? props.size : 20;
				const active = props.active === true;
				return React.createElement(
					"svg",
					{
						className: "dsh-rw-icon" + (active ? " dsh-rw-icon--active" : ""),
						width: size,
						height: size,
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.6,
						strokeLinecap: "round",
						strokeLinejoin: "round",
						role: "img",
						"aria-hidden": "true",
						focusable: "false",
					},
					// 显示器（本机 Windows 侧）
					React.createElement("rect", { key: "box", x: 2.5, y: 3.5, width: 19, height: 13, rx: 2 }),
					React.createElement("path", { key: "stand", d: "M8.5 20.5h7M12 16.5v4" }),
					// 提示符 + 光标（远端 WSL 侧）
					React.createElement("path", { key: "prompt", d: "M6.5 8.2l2.4 2.3-2.4 2.3" }),
					React.createElement("path", { key: "caret", d: "M11.4 12.8h3.1" }),
				);
			};
		}

		exports.createIcon = createIcon;
		return module.exports;
	},
});
