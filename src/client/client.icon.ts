import React from 'react';


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

		export { createIcon };
