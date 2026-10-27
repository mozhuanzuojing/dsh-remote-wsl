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
			// 2026-10-22 B2：元信息行允许折行（`row-gap:4px`）——264px 面板的头部文字列只有 109px，
			// 守护药丸 + 代理徽标两枚放不下一行；折行只发生在放不下时，宽态仍是一行（几何不变）。
			".dsh-rw-header-meta{display:flex;flex-wrap:wrap;align-items:center;column-gap:6px;row-gap:4px;min-width:0}",
			// T63：窄态（面板实宽 <420 时最窄只有 264px）下不许出现"文字折行"⇒ 头部三块各**固定 1 行**
			// （title/hint 超宽走 `…`，subtitle 本来就有）；按钮**永不折行**（`white-space:nowrap` + `flex:none`：
			// 默认 `flex-shrink:1` 会把按钮压到比内容还窄，「启动守护」被压到 48.8px 就折成两行）。
			// 配合 chunk 侧"窄态换更短文案"（见 client-panel/REPORT-narrow320-fix.md），不是靠压缩命中盒。
			".dsh-rw-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-rw-subtitle{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;unicode-bidi:isolate;text-align:left}",
			".dsh-rw-header-actions{display:flex;align-items:center;gap:8px;flex:none}",
			// 2026-10-21「多发行版」：目标发行版选择器（只有多个发行版时才渲染；单发行版是静态徽标）
			".dsh-rw-targets{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:4px;flex:none}",
			".dsh-rw-target{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;min-height:28px;padding:4px 8px;border-radius:6px;border:none;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;}",
			// F-35（task-8）：行内**主操作**现在是原生 <button>（鼠标可点、Tab 可达、Enter/Space 原生激活）。
			// 它必须"看起来仍是行的一部分"：清掉 UA 的按钮外观，吃满行内剩余宽度，故不设背景/边框/内边距；
			// 焦点环不覆盖（走平台 :focus-visible，视觉规格 §5.2 要求不得 outline:none 而不给替代）。
			".dsh-rw-targetmain{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:0;border:none;background:none;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;box-shadow:none}",
			".dsh-rw-targetmain:disabled{cursor:default}",
			".dsh-rw-target:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-rw-target--on{background:var(--dsw-alias-interactive-bg-active)}",
			".dsh-rw-target--unsupported{opacity:0.55}",
			".dsh-rw-badge--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}",
			".dsh-rw-targetname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;direction:ltr;unicode-bidi:isolate}",
			".dsh-rw-targetstate{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-tchip{position:relative;flex:none}",
			".dsh-rw-tchip>summary{list-style:none;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);cursor:pointer;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-tchip>summary::-webkit-details-marker{display:none}",
			".dsh-rw-tchip[open]>summary{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-rw-tchip .dsh-rw-menu{width:200px}",
			".dsh-rw-sessions{padding-bottom:8px}",
			// F-26 收口（task-8）：会话卡元信息（轮次 · 空闲）原来用 `label-tertiary` —— 该 token
			// **不在面板 17 token 闭集里**，且 spec §1.0/§1.1 实测 light 底上只有 **3.71:1 < 4.5**并明确
			// 「不能承担信息文本」。按 spec 的 T2 档（元信息/计数/时间戳）改用 `label-secondary`
			// —— 这同时让 C2（token 闭集）从 FAIL 变 PASS；`label-tertiary` 全仓 client 现在零引用。
			// （此处不复述具体色值：C1 门禁把注释里的字面色也计入，复述会给门禁添假红。）
			".dsh-rw-sessionmeta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}",
			".dsh-rw-copied{color:var(--dsw-alias-state-success-primary)}",
			".dsh-rw-session{display:flex;align-items:center;gap:8px;min-height:28px;padding:4px 10px}",
			".dsh-rw-sessionpath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;unicode-bidi:isolate}",
			".dsh-rw-folders{display:flex;flex-direction:column;gap:1px;padding:0 8px 6px 26px}",
			".dsh-rw-folder{display:flex;align-items:center;gap:6px;height:24px;padding:0 6px;border:none;background:none;border-radius:4px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer;min-width:0}",
			".dsh-rw-folder:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-rw-folder-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;unicode-bidi:isolate}",
			".dsh-rw-targetacts{display:flex;align-items:center;gap:2px;flex:none;visibility:hidden}",
			".dsh-rw-target:hover .dsh-rw-targetacts,.dsh-rw-target:focus-within .dsh-rw-targetacts{visibility:visible}",
			".dsh-rw-link--danger{color:var(--dsw-alias-state-error-primary)}",
			".dsh-rw-badge--on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
			".dsh-rw-places{display:flex;align-items:center;gap:6px;overflow-x:auto;overflow-y:hidden;padding:8px 10px 0;flex:none;min-width:0;scrollbar-width:none;-ms-overflow-style:none}",
			".dsh-rw-places::-webkit-scrollbar{height:0}",
			".dsh-rw-navrow{display:flex;align-items:center;gap:4px;padding:2px 10px 0;min-width:0}",
			".dsh-rw-formrow{display:flex;align-items:center;gap:8px;padding:6px 10px 8px;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dsh-rw-pathform{display:flex;align-items:center;gap:6px;flex:1;min-width:0}",
			".dsh-rw-up{flex:none}",
			".dsh-rw-toggle{display:inline-flex;align-items:center;gap:4px;flex:none;height:24px;padding:0 8px;border-radius:999px;border:1px solid transparent;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap}",
			".dsh-rw-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-rw-toggle--on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
			".dsh-rw-toggle-label{min-width:0;overflow:hidden;text-overflow:ellipsis}",
			".dsh-rw-count{flex:none;min-width:16px;height:16px;box-sizing:border-box;padding:0 4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}",
			".dsh-rw-btn--quiet{border-color:transparent;background:none;color:var(--dsw-alias-label-secondary)}",
			".dsh-rw-btn--quiet:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-rw-daemon{display:inline-flex;align-items:center;gap:5px;flex:none;height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap}",
			".dsh-rw-daemon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			// 2026-10-23 review ①：状态 token 只用于**边框/圆点**，文字一律用 `label-primary`。
			// 原因（实测对比度，白底）：success 2.28:1、warn 2.15:1、error 4.50:1 ——
			// 前两个连 3:1（图形/大字）都不到，更别说 4.5:1（正文）。状态语义由圆点形状 + 边框 + 文字共同承载。
			// task-8：这里原写成色函数形式（如 success 的绿色 = 2.28:1）记录实测值，会被
			// css-token-audit 的 C1（硬编码色 = 0）当命中 ⇒ 注释里的实测值改记成纯比值（数值不变，门禁不再假红）。
			".dsh-rw-daemon--on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".dsh-rw-daemon--off{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-warn-primary)}",
			// 2026-10-22 B1：头部「代理状态」徽标（三态）。与守护药丸同形（h22 / 12px / 圆角 999），
			// 状态色放在**圆点与边框**上（与 StatusDot 同族）：可达=success、不可达=warn、
			// 未探测=次级文字色 + border-l2。**文字始终存在**（颜色只是第三冗余，不许"只画红点"）；
			// `white-space:nowrap` 钉死"徽标自身不折行"，元信息行的 `flex-wrap` 负责不让它挤压标题。
			// 2026-10-22 review 修：不可达原先用 error（红）——但 `proxyPort` 默认 9910，不用代理的用户会
			// 常驻一个"故障红"；直连本身是正常状态（诊断区也写"不可达（直连）"）⇒ 降为 warn（琥珀色）。
			// 2026-10-23 review ①：文字色一律 `label-primary`（琥珀/绿在白底只有 2.1–2.3:1，不过 WCAG AA），
			// 状态色只留在圆点与边框上。
			".dsh-rw-proxy{display:inline-flex;align-items:center;gap:5px;flex:none;box-sizing:border-box;height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;white-space:nowrap}",
			".dsh-rw-proxy--up{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-success-primary)}",
			".dsh-rw-proxy--down{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-warn-primary)}",
			".dsh-rw-proxy--unknown{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}",
			".dsh-rw-proxy-text{white-space:nowrap}",
			// 2026-10-22 B2：窄态漂移提示只留 ⚠（title/aria-label 承载文字）。
			// 2026-10-23 review ①：warn 在浅底只有 2.15:1，非文本图形也要 3:1 ⇒ 改 `label-primary`，
			// 语义靠 ⚠ 形状 + aria/title 承载。
			".dsh-rw-driftmark{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-primary)}",
			".dsh-rw-body{flex:1;min-height:0;overflow:hidden;padding:10px 10px 6px;display:flex;flex-direction:column;gap:8px}",
			".dsh-rw-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:0;box-shadow:none;display:flex;flex-direction:column;min-height:0;flex:1;overflow:hidden}",
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
			".dsh-rw-search{display:flex;align-items:center;gap:6px;min-width:120px;flex:0 1 280px}",
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
			".dsh-rw-entries{display:flex;flex-direction:column;gap:2px;min-width:0;padding:2px 6px 8px;flex:1;min-height:0;overflow:auto;outline-offset:2px;scrollbar-gutter:stable}",
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
			// 2026-10-26 窄态快捷目录（places）实测：360/320 档 chips 被 flex 默认 `0 1 auto`
			// 压到 min-content，`Home` 渲染成 `Hon`、`/mnt` 渲染成 `/mn`，且右侧被卡片 overflow
			// 裁掉。chips 必须 `flex:none` + 单行不换行，让 `.dsh-rw-places` 自己横向滚动；
			// 滚动条已在上面隐藏（places::-webkit-scrollbar + scrollbar-width:none）。
			".dsh-rw-chip{display:inline-flex;align-items:center;gap:2px;min-width:24px;height:24px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;direction:ltr;unicode-bidi:isolate;box-shadow:none;flex:none;white-space:nowrap}",
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
			".dsh-rw-note-text--clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}",
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
			// 2026-10-22 B2：底栏改成**允许折行**（`flex-wrap` + `row-gap:6px` + `height:auto`）。
			// 原因（实测，见 spike/verify/ui-20261022/out-render-before.json）：服务卡加进「WSL: 发行版」
			// chip / 漂移提示 / 更新时间后，底栏内容在面板 264–500 区间比面板还宽 —— 264px 时 391>264、
			// 304px 时 391>304、424px 时 490>424（溢出被面板裁掉 ⇒ 状态词/⋯ 按钮看不见）。
			// 宽态（≥~560）内容一行放得下 ⇒ 几何与原来一致（min-height 仍 47）。
			// 2026-10-22 review 修：`row-gap:6px` 必须写在 `gap:8px` **之后** —— 简写 `gap` 会重置行间距，
			// 原先顺序写反导致注释称 6px、实际生效 8px（review 发现）。
			".dsh-rw-status{display:flex;flex-wrap:wrap;align-items:center;gap:8px;row-gap:6px;box-sizing:border-box;min-height:47px;height:auto;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);flex:none;font-size:12px;line-height:16px;position:relative;box-shadow:none}",
			// 同一个 `box-sizing` 根因第 2 处：`--stopped/--unknown` 带 1.5px 边框，
			// 内容盒语义下外径 11 ≠ 实心态 8 ⇒ 加 `box-sizing:border-box` 后两态恒 8×8。
			".dsh-rw-dot{box-sizing:border-box;width:8px;height:8px;border-radius:50%;flex:none}",
			".dsh-rw-dot--running{background:var(--dsw-alias-state-success-primary)}",
			".dsh-rw-dot--stopped{background:var(--dsw-alias-bg-base);border:1.5px solid var(--dsw-alias-border-l2)}",
			".dsh-rw-dot--unknown{background:var(--dsw-alias-state-idle-primary);border:1.5px solid var(--dsw-alias-border-l2)}",
			".dsh-rw-dot--error{background:var(--dsw-alias-state-error-primary)}",
			// 2026-10-22 review 修：代理「不可达」改用 warn 圆点（与 `.dsh-rw-proxy--down` 的琥珀色一致）。
			".dsh-rw-dot--warn{background:var(--dsw-alias-state-warn-primary)}",
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
			// ── 2026-10-22 B2：窄态（面板实宽 <420，tail 在根节点挂 `.dsh-rw-root--narrow`）三处**分档** ──
			// 为什么用 JS 语义类而不是 `@media`：面板宽度 ≠ 视口宽度（侧栏 rail 占 56px），媒体查询量的是
			// 视口，量不到面板实宽；`narrow` 来自 ResizeObserver 的 contentRect。
			// ① 目录路径行：`.dsh-rw-formrow` 放不下「上一级 + 路径输入 + 显示隐藏开关 + 筛选框」⇒ 实测
			//    在 320/360 档把「显示隐藏」推出卡片右边界（right=432 vs 面板右 320）并被卡片 overflow:hidden
			//    裁掉 ⇒ 折成两行：第一行路径（占满），第二行筛选（占满）。
			".dsh-rw-root--narrow .dsh-rw-formrow{flex-wrap:wrap;row-gap:6px}",
			".dsh-rw-root--narrow .dsh-rw-pathform{flex:1 1 100%}",
			".dsh-rw-root--narrow .dsh-rw-search{flex:1 1 100%;min-width:0}",
			// ② 目标行：多发行版徽标（WSL 2 / 默认 / 当前）+ 状态词 + 行内动作在 264px 档把行挤到 323px
			//    （超出面板 320）⇒ 允许换行（宽态内容本来就放得下，不会换）。
			//    2026-10-26 补：`.dsh-rw-targetname` 的 `flex:1` 等价 `1 1 0%`，换行前先被压成
			//    0 宽 —— 实拍 360 档发行版名只剩 `d.`。窄态改 `flex:1 1 auto`，让名称先占内容宽，
			//    徽标/状态在需要时换到下一行。
			".dsh-rw-root--narrow .dsh-rw-target{flex-wrap:wrap;row-gap:2px}",
			".dsh-rw-root--narrow .dsh-rw-targetname{flex:1 1 auto}",
			// ③ 窄态底栏：折行后各段自己成行，不再靠压缩命中盒/裁字来"塞进一行"。
			".dsh-rw-root--narrow .dsh-rw-updated{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}",
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

// 2026-10-21「多发行版」：client/** 全量改动（api.setDistro、panel 目标选择器、i18n、CSS），
// 按 docs/client-contract.md §11 由本入口刷新 chunk rev。

// 2026-10-21 UI 重做：header/browser/tail/CSS/i18n 全量改动（布局三层、列表吃满高度、守护药丸），
// 按 docs/client-contract.md §11 由本入口刷新 chunk rev。

// 2026-10-22 formatIdle 由 data hook 注入 scope（不再从 helpers 解构）；刷新入口 rev。

// 2026-10-22 formatIdle 移到 data chunk（helpers 触到 400 行门禁）；刷新入口 rev。

// 2026-10-22 会话卡属性兜底后再刷新入口 rev。

// 2026-10-22 会话卡：轮次/空闲元信息 + 复制 sessionId；刷新入口 rev。

// 2026-10-22 重新扫描走 refresh（绕过 host 的 TTL 缓存）；刷新入口 rev。

// 2026-10-22 诊断区显示宿主代理（proxy 段来自 snapshot）；刷新入口 rev。

// 2026-10-22 路径框接受 UNC（data chunk + i18n）；刷新入口 rev。

// 2026-10-22 新会话改走 uiWorkspace.startSession（先登记 UNC 工作区）；刷新入口 rev。

// 2026-10-22 仅支持 WSL2：WSL1 行标灰 + 无动作；刷新入口 rev。

// 2026-10-22 i18n 修正后再次刷新入口 rev。

// 2026-10-22 「在此目录新建会话」改走 sessionController（真 DSH 会话）；API 方法表 7 个。

// 2026-10-22 守护版本进药丸 title 与诊断行；未运行提示补生命周期说明。

// 2026-10-22 结果条收敛、开会话后刷新、最近文件夹显示全路径；刷新入口 rev。

// 2026-10-21 目标切换入口 + 远端会话卡（browser/actions/i18n/CSS）；刷新入口 rev。

// 2026-10-21 最近文件夹按发行版分组（helpers/panel/actions/data/browser/CSS）；刷新入口 rev。

// 2026-10-21 目标行显示 WSL 版本（wsl -l -v 的 VERSION 列）；刷新入口 rev。

// 2026-10-21 目标列表始终显示本机清单 + 数量 + 重新扫描；刷新入口 rev。

// 2026-10-21 目标行去掉「打开」（不再点击即切目标+拉快照）；设为默认不切换。

// 2026-10-21 确认框按目标发行版走：tail 改动，刷新入口 rev。

// 2026-10-21 目标动作：行内打开/默认/停止 + 底栏 WSL chip；刷新入口 rev。

// 2026-10-21 目标列表对齐 VS Code WSL TARGETS：browser/tail/i18n/CSS 改动，刷新入口 rev。

// 2026-10-21 修折叠区崩溃：onToggle 先取 open 再进 updater（currentTarget 会被 React 置空）。

// 2026-10-22 uiWorkspace 端到端验证（web 实例 + CDP）：header chunk 里 startSession 改为按 thenable
// 兜底（当前实现同步返回 undefined）；刷新入口 rev。
// 2026-10-22 B1/B2（spike/verify/ui-20261022）：头部加三态「代理可达/不可达/未探测」徽标（header 返回
// proxyBadge，tail 放进 header-meta；aria/title 带端点与不可达提示；i18n 新增 13 键 zh/en 配对）；
// 窄态 320/360 修布局（底栏允许折行 + 窄态 chip/漂移/守护短文案 + 根节点 .dsh-rw-root--narrow
// 让路径行/目标行折行）；CSS 全部在本文件 ⇒ 本轮由本入口刷新 chunk rev。
// 2026-10-22 review 修：底栏 `row-gap:6px` 挪到 `gap:8px` 之后（原先被简写重置成 8px）；
// 代理「不可达」从 error 红降为 warn 琥珀（proxyPort 默认 9910，不用代理的用户不该看到故障红）；
// 新增 `.dsh-rw-dot--warn`（header chunk 的 StatusDot kind 同步改 warn）⇒ 刷新入口 rev。
// 2026-10-23 清小债（README「仍余」①）：删掉 i18n 里已无引用的 5 组键（stamp.snapshot /
// stamp.lastSuccessRefreshing / stamp.failedLastSuccess / stamp.none / status.loading）—— 它们对应的
// 「加载期把『尚未取得快照』渲染两次」与「结果条透传 host note」两条文案瑕早已在 T 系列修掉，
// 只剩死键误导读者；当前加载期只渲染「远端守护状态未知 + 状态读取中…」一处。改的是 chunk ⇒ 刷新入口 rev。
// 2026-10-27（task-8 客户端轮，F-34/35/36/37/38/39/40）：
//   · F-34 切发行版状态机：dirCache 键含 distro、changeDistro bump browseSeq + abort 在飞 listDir、
//     browseAbort 真正赋值并把 signal 传给 listDir（data chunk / helpers chunk / 本入口的接线）；
//   · F-35 发行版行可键盘激活：行内主操作改成原生 <button>（aria-pressed / Enter / Space），
//     删掉藏在 visibility:hidden 容器里的「切换」按钮与残留 stopPropagation；CSS 新增 .dsh-rw-targetmain；
//   · F-36 ensure/restart 的 HTTP 失败也映射到 failKey（主句用户语言，host 原文进 detail 折叠）；
//   · F-37 诊断区凭据脱敏：host snapshot.webHosts[].url 打码 token，client 的 <pre> 与"复制诊断"
//     两个出口再过一遍 api.redactSecrets；
//   · F-38 加载骨架与错误卡互斥（错误优先）；F-39 根 section 补 aria-label、alertdialog 焦点陷阱、
//     chip 菜单补键盘模型、footer 的 role=status 不再包可聚焦控件、死键 53→0、硬编码中文 2 处转 i18n；
//   · F-40 slow/prefetch/copy 定时器在卸载与被取代路径全部清理；
//   · 新增第 8 个 panel chunk `client.panel.a11y.js`（menu 键盘模型 / alertdialog 焦点陷阱 / details 开合），
//     因为 actions chunk 已贴 400 行纪律线；客户端 chunk 全量改动 ⇒ 按 docs/client-contract.md §11 刷新入口 rev。
//   · 顺带 F-26 收口：`.dsh-rw-sessionmeta` 由 label-tertiary 改 label-secondary（该 token 不在 17 token
//     闭集且实测 3.71:1 < 4.5）；并把注释里的实测对比度改成比值记法 ⇒ css-token-audit C1/C2 全 PASS。