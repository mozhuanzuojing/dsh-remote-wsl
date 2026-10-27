/**
 * client.panel.a11y.js —— 面板的**键盘 / 可访问性交互原语**（第 7 个 chunk；F-39 收口）。
 *
 * 为什么单独一个 chunk：`client.panel.actions.js` 已贴 400 行纪律线（panel-smoke-node 的
 * "行数 <400" 门禁），而这三段是**与数据/副作用无关的纯交互函数**，且要被多处复用
 * （⋯ 菜单、底栏 chip 菜单、确认层），整块搬出来最干净、也让它们能被单独断言。
 *
 * 三条规矩：
 * · **只碰 DOM 焦点/开合**，不 setState、不发请求 ⇒ 纯函数，可在任何地方调用；
 * · 不假设 `document` 一定有 `querySelectorAll`（测试 stub 可能给空），取不到就当"没有可聚焦项"；
 * · 一律 `preventDefault()` 只针对自己真正消费的按键，其余按键继续冒泡（Esc 归各调用方）。
 *
 * WAI-ARIA 依据：menu 键盘模型（↑/↓/Home/End + Esc）、alertdialog 焦点陷阱（Tab 环绕）。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.panel.a11y.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 容器内当前**可聚焦**的菜单项（跳过 disabled；没有 role=menuitem 时退回按钮）。 */
		function menuItems(container) {
			if (container === null || container === undefined || typeof container.querySelectorAll !== "function") return [];
			const tagged = [...container.querySelectorAll('[role="menuitem"]:not([disabled])')];
			return tagged.length > 0 ? tagged : [...container.querySelectorAll("button:not([disabled])")];
		}

		/**
		 * WAI-ARIA menu 的键盘模型：↑/↓ 循环、Home 首项、End 末项。
		 * @param event keydown 事件（会被 `preventDefault`，仅当真的处理了方向键）
		 * @param container `role="menu"` 容器（可为 null ⇒ 不处理）
		 * @returns {boolean} 是否消费了该按键
		 */
		function menuKeyNav(event, container) {
			const items = menuItems(container);
			if (items.length === 0) return false;
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return false;
			event.preventDefault();
			const active = typeof document === "undefined" ? null : document.activeElement;
			const current = items.indexOf(active);
			let next;
			if (event.key === "Home") next = 0;
			else if (event.key === "End") next = items.length - 1;
			else next = (current < 0 ? 0 : current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
			items[next].focus();
			return true;
		}

		/**
		 * alertdialog 的**焦点陷阱**：Tab / Shift+Tab 在对话框内可聚焦控件之间环绕。
		 *
		 * 为什么需要：`aria-modal="true"` 要求焦点不离开对话框；改前确认层只做了
		 * "焦点进取消 + Esc 取消"，Tab 会一路跑到下面的面板控件上（误导屏幕阅读器用户）。
		 * 只接管 Tab，其它按键照常冒泡（Esc 由确认层的 keydown 处理）。
		 * @param event keydown 事件（`event.currentTarget` = 对话框元素）
		 */
		function trapTab(event) {
			if (event.key !== "Tab") return;
			const node = event.currentTarget;
			if (node === null || node === undefined || typeof node.querySelectorAll !== "function") return;
			const items = [...node.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1']):not([disabled])")];
			if (items.length < 2) return;
			const first = items[0];
			const last = items[items.length - 1];
			const active = typeof document === "undefined" ? null : document.activeElement;
			if (event.shiftKey === true && active === first) {
				event.preventDefault();
				last.focus();
			} else if (event.shiftKey !== true && active === last) {
				event.preventDefault();
				first.focus();
			}
		}

		/**
		 * 关闭某个 `<details>` 菜单（底栏「WSL: 发行版」chip）并把焦点送回它的 `<summary>`。
		 * 原生 details 只保证"点 summary 可开合"，键盘进入菜单项后没有"收起并回焦"的路径 ⇒ 补上。
		 * @param node 菜单内任一节点（通常是事件里的 `currentTarget`）
		 */
		function closeChipMenu(node) {
			if (node === null || node === undefined || typeof node.closest !== "function") return;
			const box = node.closest("details");
			if (box === null) return;
			box.open = false;
			const summary = typeof box.querySelector === "function" ? box.querySelector("summary") : null;
			if (summary !== null && typeof summary.focus === "function") summary.focus();
		}

		exports.menuKeyNav = menuKeyNav;
		exports.trapTab = trapTab;
		exports.closeChipMenu = closeChipMenu;
		return module.exports;
	},
});
