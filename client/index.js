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
 *
 * ── 入口 bump 记录（改 chunk 必须动入口，见 docs/client-contract.md §11）──────────────
 * T52：`.dsh-rw-menu` 的 CSS 就在**本文件**的 CSS 数组里 ⇒ 那次改动本身就是入口变更。
 * T53：`client.panel.tail.js` 的菜单组标题去掉误导性 `role="presentation"`（N4 对账，
 *      见 spike/verify/explorer-20261012/client-panel/REPORT-n4-grouplabel.md）⇒ 由此处 bump 入口。
 * T63：窄态（面板 <420）换短文案 + 头部/按钮禁止折行的 CSS（见
 *      spike/verify/explorer-20261012/usability/p07-narrow/REPORT-narrow320-fix.md）。
 *      本轮同时改了 3 个 chunk（i18n / header / tail）⇒ **最后一次编辑必须落在入口**，
 *      否则 `check-client-rev.ts` 会判 FAIL（入口的 mtime/内容不再是最新）。
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
		const PANEL_LABEL_FALLBACK = "远程资源管理器";

		/** 包内 chunk（入口同目录；名字被平台的 CLIENT_CHUNK 正则钉死）。 */
		// ⚠ T32 实测的坑：chunk 的 URL 形如 `/plugins/dsh-remote-wsl/client.<name>.js?rev=<rev>`，
		// 而这个 **rev 取自"入口行"（本文件 index.js）的 mtime/ctime/size**，不是 chunk 自己的
		// （`dsh-client-modules/lib/client.js` 里 chunkUrl 用 owner 的 rev）；路由又带
		// `Cache-Control: public, max-age=31536000, immutable`（同包 IMMUTABLE_CACHE）。
		// ⇒ **只改 client.panel.js / client.i18n.js 时 URL 不变，浏览器会一直用旧 chunk**
		//   （实测：改完 chunk、重启宿主并新开页面，面板仍渲染旧文案）。
		//   改 chunk 后要看到效果：**同时改本文件**（哪怕一次注释改动）刷新 owner rev，
		//   或用 HMR / `pnpm run dev:web`，或让用户硬刷新。
		//   （T36 同样靠"动一下本文件"才让 chunk 变更生效 —— 独立复核见 T37。）
		//   ↑ 上面这行本身就是 T36 的 rev 刷新锚点；再改 chunk 就再动一行。
		//   T39 又动了 client.api.js（方法表加权威指针 + METHOD_NAMES 派生）⇒ 这里再刷一次 rev。
		const CHUNK_I18N = "client.i18n.js";
		const CHUNK_API = "client.api.js";
		const CHUNK_PANEL = "client.panel.js";
		const CHUNK_ICON = "client.icon.js";

		const CSS = [
			".dsh-rw-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:none}",
			".dsh-rw-header{display:flex;align-items:flex-start;gap:8px;padding:10px 14px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);box-shadow:none}",
			".dsh-rw-header-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
			".dsh-rw-header-meta{display:flex;align-items:center;gap:6px;min-width:0}",
			// T63：窄态（面板实宽 <420 时最窄只有 264px）下不许出现"文字折行"⇒ 头部三块各**固定 1 行**
			// （title/hint 超宽走 `…`，subtitle 本来就有）；按钮**永不折行**（`white-space:nowrap` + `flex:none`：
			// 默认 `flex-shrink:1` 会把按钮压到比内容还窄，「启动守护」被压到 48.8px 就折成两行）。
			// 配合 chunk 侧"窄态换更短文案"（见 client-panel/REPORT-narrow320-fix.md），不是靠压缩命中盒。
			".dsh-rw-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-rw-subtitle{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-header-actions{display:flex;align-items:center;gap:8px;flex:none}",
			".dsh-rw-body{flex:1;min-height:0;overflow:auto;padding:8px 8px 4px;display:flex;flex-direction:column;gap:8px}",
			".dsh-rw-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;box-shadow:none;display:flex;flex-direction:column;gap:6px;min-height:0}",
			".dsh-rw-cardhead{display:flex;align-items:center;gap:8px;min-width:0}",
			".dsh-rw-grouptitle{font-size:12px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}",
			".dsh-rw-crumbs{display:flex;align-items:center;gap:2px;overflow-x:auto;padding:0;min-height:24px}",
			".dsh-rw-crumb{display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;box-sizing:border-box;background:none;border:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;padding:2px 4px;border-radius:3px;cursor:pointer;flex:none;direction:ltr;unicode-bidi:isolate}",
			".dsh-rw-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-rw-crumb--current{color:var(--dsw-alias-label-primary);font-weight:600;cursor:default}",
			".dsh-rw-crumb-sep{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsh-rw-current{border-left:2px solid var(--dsw-alias-brand-primary);font-weight:600}",
			".dsh-rw-form{display:flex;align-items:center;gap:6px;min-width:0}",
			".dsh-rw-path-input{flex:1;min-width:0;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;padding:4px 6px;direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-path-input::placeholder{color:var(--dsw-alias-label-dimmed)}",
			// 2026-10-19：目录筛选（客户端过滤；24×24 清除按钮复用 .dsh-rw-iconbtn）
			".dsh-rw-search{display:flex;align-items:center;gap:6px;min-width:0;flex:none}",
			".dsh-rw-search-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-search-input{flex:1;min-width:0;box-sizing:border-box;height:24px;padding:2px 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-search-input::placeholder{color:var(--dsw-alias-label-dimmed)}",
			// 自带 × 与我们的「清除筛选」重复 ⇒ 去掉 UA 那个（不影响 type=search 语义/键盘行为）
			".dsh-rw-search-input::-webkit-search-cancel-button{display:none}",
			".dsh-rw-search-count{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}",
			// SPEC §6.3 骨架：5 行 × 32px，行内 [16×16 圆角块] + 宽度阶梯 120/90/160/110/140、8px 高圆角条，gap 8
			// 呼吸只动 opacity（0.6→1.0，1.2s）；token 填充；reduced-motion 下静止
			".dsh-rw-skeleton{display:flex;flex-direction:column;gap:2px;padding:0;min-width:0}",
			".dsh-rw-skeleton-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:32px;padding:6px 8px;animation:dsh-rw-skeleton-pulse 1200ms ease-in-out infinite}",
			".dsh-rw-skeleton-icon{flex:none;width:16px;height:16px;border-radius:3px;background:var(--dsw-alias-interactive-bg-active)}",
			".dsh-rw-skeleton-bar{flex:none;height:8px;border-radius:4px;background:var(--dsw-alias-interactive-bg-active)}",
			"@keyframes dsh-rw-skeleton-pulse{0%{opacity:0.6}50%{opacity:1}100%{opacity:0.6}}",
			"@media (prefers-reduced-motion: reduce){.dsh-rw-skeleton-row{animation:none}}",
			// 窗口化的上下占位（不是可交互元素；只负责撑住滚动高度）
			".dsh-rw-vpad{flex:none;width:100%}",
			// 行现在可获得真实焦点（roving tabindex）：只允许平台焦点环 + 允许的 offset，不覆盖 outline
			".dsh-rw-row:focus-visible{outline-offset:-2px}",
			// SPEC `7.2.2 / R1：列表区是面板里**唯一**允许生长的区域，且它自己就是滚动体
			// (`flex:1;min-height:96px;overflow:auto`)。缺 min-height/overflow 时，卡片在固定高 body 里
			// 被 flex-shrink 压到 672px 而列表内容 3398px ⇒ 行会画到"最近目录/诊断"上面（F4，A/B 都复现）。
			".dsh-rw-entries{display:flex;flex-direction:column;gap:2px;min-width:0;padding:0;flex:1;min-height:96px;overflow:auto;outline-offset:2px}",
			".dsh-rw-row{display:flex;align-items:center;gap:6px;height:32px;padding:6px 8px;border-radius:4px;width:100%;box-sizing:border-box;background:none;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left}",
			".dsh-rw-row--dir{cursor:pointer}",
			".dsh-rw-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-rw-row:active{background:var(--dsw-alias-interactive-bg-active)}",
			".dsh-rw-row--focus{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-rw-row--current{border-left:2px solid var(--dsw-alias-brand-primary);font-weight:600}",
			".dsh-rw-rowname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-rowacts{display:flex;align-items:center;gap:8px;flex:none;visibility:hidden}",
			".dsh-rw-row:hover .dsh-rw-rowacts,.dsh-rw-row:focus-within .dsh-rw-rowacts{visibility:visible}",
			".dsh-rw-badge{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px}",
			".dsh-rw-icon{flex:none;width:16px;height:16px;color:currentColor}",
			".dsh-rw-drift{color:var(--dsw-alias-state-warn-primary)}",
			".dsh-rw-menuicon--warn{color:var(--dsw-alias-state-warn-primary)}",
			".dsh-rw-menuicon--error{color:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-btn{display:inline-flex;align-items:center;gap:4px;flex:none;white-space:nowrap;height:28px;padding:4px 10px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;box-shadow:none}",
			".dsh-rw-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-rw-btn:active:enabled{background:var(--dsw-alias-interactive-bg-active)}",
			".dsh-rw-btn:disabled{color:var(--dsw-alias-label-dimmed);border-color:var(--dsw-alias-border-l1);cursor:default}",
			".dsh-rw-btn--primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary)}",
			".dsh-rw-btn--danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-state-error-primary)}",
			// T42/V1：`⋯` 与刷新是 flex 子项，**缺 `flex:none` 会被压到 SVG 的 16px 最小宽**
			//（T40 实测 320→16 / 359/360→21）⇒ 钉 `flex:none` 保证命中区恒 24×24。
			".dsh-rw-iconbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;border-radius:4px;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;box-shadow:none}",
			".dsh-rw-iconbtn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-rw-iconbtn:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".dsh-rw-chip{display:inline-flex;align-items:center;gap:2px;min-width:24px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;direction:ltr;unicode-bidi:isolate;box-shadow:none}",
			".dsh-rw-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-rw-chip--on{color:var(--dsw-alias-label-primary)}",
			// M15 形状通道：任何带 `dsh-rw-current` 的元素都必须**不靠填充**可辨。
			// 单靠上方 `.dsh-rw-current` 会被同为 (0,1,0) 且更晚出现的 `.dsh-rw-chip` 的
			// `border:1px solid …` 简写覆盖（实测 border-left 变 1px、font-weight 400 ⇒
			// 只剩 `--on` 填充，正是规格里的"只靠填充即红"）⇒ 这里用 (0,2,0) 钉死。
			".dsh-rw-chip.dsh-rw-current{border-left-width:2px;border-left-color:var(--dsw-alias-brand-primary);font-weight:600}",
			// T42/V1：行内动作「进入」原来是裸 `padding:0`（16×16 < WCAG 2.2 SC 2.5.8 的 24×24）⇒ 补命中盒。
			".dsh-rw-link{display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;box-sizing:border-box;background:none;border:none;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;padding:0 4px}",
			".dsh-rw-link:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-rw-link:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".dsh-rw-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-rw-note{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;box-shadow:none}",
			".dsh-rw-note--error{border-color:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-note-text{white-space:pre-wrap;word-break:break-word;direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-note-details{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-note-detail{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-error{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;box-shadow:none}",
			".dsh-rw-error-title{display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-error-body{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:8px 0}",
			".dsh-rw-conflict{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:6px 8px}",
			".dsh-rw-fold{border-top:1px solid var(--dsw-alias-border-l1);padding:6px 4px}",
			".dsh-rw-fold>summary{cursor:pointer;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);list-style:none;display:flex;align-items:center;gap:4px;min-height:24px}",
			".dsh-rw-fold[open]>summary{font-weight:600}",
			".dsh-rw-foldbody{padding-left:16px;padding-top:6px;display:flex;flex-direction:column;gap:6px}",
			".dsh-rw-readonly{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:6px 8px;display:flex;flex-direction:column;gap:4px}",
			".dsh-rw-readonly-head{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-other{display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
			".dsh-rw-pre{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;max-height:260px;overflow:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;direction:ltr;unicode-bidi:isolate;text-align:left;margin:0}",
			".dsh-rw-recent-row{display:flex;align-items:center;gap:6px;height:32px;padding:6px 8px;border-radius:4px;border:none;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left;width:100%;box-sizing:border-box}",
			".dsh-rw-recent-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			// T42/R1：宿主没有全局 `box-sizing` 重置，而 `<footer>` 自身也没有兜底 ⇒
			// 旧写法 `height:36 + padding 9×2 + border-top 1` 实际量到 **55**（内容盒语义）。
			// 定稿：`box-sizing:border-box;height:47px`（= 28 内容 + 9×2 padding + 1 border）。
			// **不用 `min-height`**：那会让守护起停（多一行 extra）时 47↔43 抖 4px。
			".dsh-rw-status{display:flex;align-items:center;gap:8px;box-sizing:border-box;height:47px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);flex:none;font-size:12px;line-height:16px;position:relative;box-shadow:none}",
			// 同一个 `box-sizing` 根因第 2 处：`--stopped/--unknown` 带 1.5px 边框，
			// 内容盒语义下外径 11 ≠ 实心态 8 ⇒ 加 `box-sizing:border-box` 后两态恒 8×8。
			".dsh-rw-dot{box-sizing:border-box;width:8px;height:8px;border-radius:50%;flex:none}",
			".dsh-rw-dot--running{background:var(--dsw-alias-state-success-primary)}",
			".dsh-rw-dot--stopped{background:var(--dsw-alias-bg-base);border:1.5px solid var(--dsw-alias-border-l2)}",
			".dsh-rw-dot--unknown{background:var(--dsw-alias-state-idle-primary);border:1.5px solid var(--dsw-alias-border-l2)}",
			".dsh-rw-dot--error{background:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-statusword{flex:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:nowrap}",
			".dsh-rw-extra{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
			// T63：窄态（<420）会话数改由**菜单/诊断**承载 ⇒ 底栏只留状态词 + 主按钮，避免"会话 N 个"被挤成省略号
			".dsh-rw-extra--hidden{display:none}",
			".dsh-rw-spacer{flex:1;min-width:0}",
			".dsh-rw-updated{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}",
			// T52：规格 §7.2.4 的「宽 240 固定」指**外框**。宿主无全局 box-sizing 重置 ⇒ 不写 border-box 时
			// `width:240 + padding:4×2 + border:1×2` 按内容盒渲染成 **250**（真实 Chromium 实测，见
			// client-panel/REPORT-menu-boxsizing.md ①）。与同族 7 条（row/recent-row/menuitem/status/dot/crumb/link）一致。
			".dsh-rw-menu{position:absolute;bottom:calc(100% + 4px);right:0;box-sizing:border-box;width:240px;z-index:30;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px;display:flex;flex-direction:column;gap:0;box-shadow:0 4px 12px rgba(0,0,0,.08)}",
			".dsh-rw-group{display:flex;flex-direction:column;gap:0}",
			// T42/R3：组标题取色 `label-secondary` 在 dark 只有 3.85:1（<4.5）⇒ 改 `label-primary`
			//（实测 15.97 / 5.55 ✓✓；17 token 闭集内没有第三个选项，`brand-primary` 与它 RGB 相同）。
			// 层级**不再靠颜色**传达：11px 字号 / 不进 Tab（`role=presentation` + `tabIndex:-1`）/ 不响应 hover / 无填充。
			".dsh-rw-grouplabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-primary);padding:4px 8px 2px}",
			".dsh-rw-menuitem{display:flex;align-items:center;gap:8px;height:28px;padding:4px 8px;border-radius:4px;border:none;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left;width:100%;box-sizing:border-box;box-shadow:none}",
			".dsh-rw-menuitem:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-rw-menuitem:focus-visible{outline-offset:-2px;box-shadow:inset 0 0 0 1px var(--dsw-alias-bg-layer-1)}",
			".dsh-rw-menuitem:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".dsh-rw-menusep{height:1px;background:var(--dsw-alias-border-l1);margin:4px 0}",
			".dsh-rw-confirm{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:12px;width:min(360px,100% - 16px);align-self:flex-end;z-index:30;box-shadow:0 8px 24px rgba(0,0,0,.16);display:flex;flex-direction:column;gap:8px}",
			".dsh-rw-confirm-title{display:flex;align-items:center;gap:6px;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".dsh-rw-confirm-body{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-confirm-actions{display:flex;justify-content:flex-end;gap:8px}",
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
		 * A4 i18n：**优先官方 locale 服务**（T11 实测 `ctx.get('locale')` 可用：register/bind/
		 * translate/lookup/getSnapshot/subscribe），**取不到就回退**到内置字典 + `documentElement.lang`。
		 * 两条路都不许崩 —— 拿不到官方服务时面板照常渲染，只是语言只能靠 `<html lang>`。
		 *
		 * 返回 `{ t, subscribe, language, source }`：`t` 直接给面板/标签用；`subscribe` 让面板在
		 * 语言变化时重渲染（官方 `locale.subscribe`；否则退回观察 `<html lang>` 的 MutationObserver）。
		 */
		function createI18n(ctx, i18nModule) {
			const NS = i18nModule.NS;
			const DICTS = i18nModule.DICTS;
			let locale = null;
			try {
				locale = typeof ctx.get === "function" ? ctx.get("locale") : null;
			} catch {
				locale = null;
			}
			let source = "builtin";
			if (locale && typeof locale.register === "function" && typeof locale.translate === "function") {
				try {
					// 官方服务里注册本包字典（供 translate/其它消费者用）；重复注册会 throw ⇒ 视为已有
					ctx.effect(() => locale.register(NS, { zh: DICTS.zh, en: DICTS.en }), "dsh-remote-wsl: locale dictionaries");
					source = "locale";
				} catch {
					source = "locale+builtin";
				}
			}
			const doc = typeof document === "undefined" ? undefined : document;
			const t = i18nModule.createTranslator(locale && typeof locale.translate === "function" ? locale : null, doc);
			const listeners = new Set();
			const notify = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						/* 订阅者自己的错不该影响别人 */
					}
				}
			};
			if (locale && typeof locale.subscribe === "function") {
				ctx.effect(() => locale.subscribe(notify), "dsh-remote-wsl: locale subscription");
			}
			// 官方订阅之外的兜底：<html lang> 变了也能跟上（验收就是改 lang + 触发重渲染）
			if (typeof MutationObserver === "function" && doc && doc.documentElement) {
				ctx.effect(() => {
					const observer = new MutationObserver(notify);
					observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["lang"] });
					return () => observer.disconnect();
				}, "dsh-remote-wsl: html lang observer");
			}
			return {
				t,
				language: i18nModule.resolveLanguage(locale, doc),
				source,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
		}

		/**
		 * 入口只做「注册 + 等 chunk」：先取字典，再取传输层，最后取组件实现。
		 * chunk 拿不到也不静默——错误会显示在图标位/面板体里。
		 */
		function bootChunks(ctx) {
			return loadChunk(CHUNK_I18N).then((i18nModule) => {
				if (typeof (i18nModule && i18nModule.createTranslator) !== "function") {
					throw new Error(i18n.t("chunk.notExported", { file: CHUNK_I18N, fn: "createTranslator" }));
				}
				const i18n = createI18n(ctx, i18nModule);
				return loadChunk(CHUNK_API).then((apiModule) => {
					const createExplorerApi = apiModule && apiModule.createExplorerApi;
					if (typeof createExplorerApi !== "function") {
						throw new Error(i18n.t("chunk.notExported", { file: CHUNK_API, fn: "createExplorerApi" }));
					}
					const api = createExplorerApi(i18n);
					return Promise.all([loadChunk(CHUNK_PANEL), loadChunk(CHUNK_ICON)]).then(([panelModule, iconModule]) => {
						const createPanel = panelModule && panelModule.createPanel;
						const createIcon = iconModule && iconModule.createIcon;
						if (typeof createPanel !== "function") throw new Error(i18n.t("chunk.notExported", { file: CHUNK_PANEL, fn: "createPanel" }));
						if (typeof createIcon !== "function") throw new Error(i18n.t("chunk.notExported", { file: CHUNK_ICON, fn: "createIcon" }));
						// T41：面板自己被拆成了子 chunk（client.panel.helpers.js 等）。组件在**首次渲染**里直接
						// 引用那些纯函数，所以必须在 createPanel() 之前 await 面板的 whenReady()；
						// 否则 createPanel 内部的就绪断言会抛（宁可显式失败，也不做一个"少功能的面板"）。
						const whenReady = panelModule && typeof panelModule.whenReady === "function" ? panelModule.whenReady : null;
						return Promise.resolve(whenReady === null ? undefined : whenReady()).then(() => ({
							api,
							i18n,
							Panel: createPanel(ctx, api, i18n),
							Icon: createIcon(ctx),
						}));
					});
				});
			});
		}

		/**
		 * Cordis 插件面。
		 * @param ctx - client 受限 cordis 上下文（`slots` 服务由 ui-renderer 提供）。
		 */
		function apply(ctx) {
			const boot = { ready: false, error: null, Panel: null, Icon: null, i18n: null };
			/**
			 * 字典就绪前/未就绪时的翻译：**绝不把键名当文案显示**。
			 * 只有 rail 名需要提前可用（侧栏可能在 chunk 就绪前就请求标签）。
			 */
			const fallbackText = (key) => (key === "panel.title" ? PANEL_LABEL_FALLBACK : key);
			const tr = (key, params) => (boot.i18n === null ? fallbackText(key) : boot.i18n.t(key, params));
			const listeners = new Set();
			const settle = () => {
				for (const listener of [...listeners]) listener();
				listeners.clear();
			};
			const bootSettled = bootChunks(ctx).then(
				(product) => {
					boot.api = product.api;
					boot.i18n = product.i18n;
					boot.Panel = product.Panel;
					boot.Icon = product.Icon;
					boot.ready = true;
				},
				(error) => {
					boot.error = error instanceof Error ? error : new Error(String(error));
					if (typeof console !== "undefined" && console.error) {
						console.error("[dsh-remote-wsl] " + tr("chunk.loadFailed"), error);
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
						title: tr("chunk.loadFailedTitle", { msg: current.error.message }),
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
							React.createElement("div", { className: "dsh-rw-error-title" }, tr("chunk.panelFailed")),
							React.createElement("div", { className: "dsh-rw-error-body" }, current.error.message),
						),
					);
				}
				if (current.Panel === null) {
					return React.createElement(
						"section",
						{ className: "dsh-rw-root", "data-dsh-remote-wsl": "panel" },
						React.createElement("div", { className: "dsh-rw-hint" }, tr("chunk.panelLoading")),
					);
				}
				return React.createElement(current.Panel, {});
			}

			// 每个槽都要等父 entry 的 children 表声明它（否则 register 会 throw）。
			// ★ rail 名**必须等字典就绪后再注册**：实测冷加载时侧栏请求 label 的时机早于
			//   chunk 就绪 ⇒ 拿到 fallback 语言并一直留着（英文界面里 rail 名仍是中文的缺陷）。
			//   注册幂等，所以成功/失败两条路径都在这之后注册一次。
			let listRegistered = false;
			const registerList = () => {
				if (listRegistered) return;
				listRegistered = true;
				ctx.slots.inject("sidebar.panellist", () =>
					ctx.slots.register(
						{
							name: "sidebar.panellist",
							id: PANEL_ID,
							order: PANEL_ORDER,
							label: () => tr("panel.title"),
						},
						IconSlot,
					),
				);
			};
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
					},
					PanelSlot,
				),
			);
			bootSettled.then(registerList, registerList);
		}

		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
// T41: 死键清理（client.i18n.js）后触碰入口，按 docs/client-contract.md §11 换 chunk rev

// T41（2026-10-13）：client.panel.js 拆成 5 个子 chunk（helpers / actions / header / browser / tail）。
// 按 docs/client-contract.md §11：改了 client/** 就必须 bump 入口（rev 取自入口元数据）⇒ 本次同时改本行。

// T42: V1 hit-box also for .dsh-rw-crumb + zero CJK in client.panel.js (bump entry rev, docs/client-contract.md §11).
//
// 2026-10-19 UI/UX/性能轮（chunks 全量改动，按 §11 由**本入口**刷新 rev）：
//   · 新增 2 个 chunk：client.panel.data.js（目录数据层：缓存/单飞/预取/导航）、
//     client.panel.list.js（窗口化列表：大目录只渲染视口 + 行点击/真实焦点键盘/滚动记忆）；
//   · 修缺陷：/mnt 盘符 chips 因 const 赋值 TypeError 永不渲染；
//   · 新增筛选框、目录优先排序、加载骨架、stale-while-revalidate、切换窗口自动刷新；
//   · 本行是入口 rev 锚点：chunk 有改动就必须动这里（否则 immutable 缓存继续供旧字节）。
//   · F1–F5 复核修复（2026-10-19 16:2x）：列表改为自身滚动体（SPEC §7.2.2）、刷新/导航竞态守卫、
//     自动刷新单次节流、菜单打开即聚焦首项且 Esc 关闭、骨架按 §6.3（5 行 + 宽度阶梯）重做。

// 2026-10-21 桌面壳来源闸门修正：client.api.js 注释随 host 判据更新（Origin 缺失 = 桌面壳
// `dsh-app://app` 转发 ⇒ 放行），按 docs/client-contract.md §11 触碰本入口刷新 chunk rev。