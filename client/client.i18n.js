/**
 * client.i18n.js —— dsh-remote-wsl client 半的文案字典 + 翻译器（A4）。
 *
 * 文件名约束见 client.api.js 头部（chunk 名被平台的 CLIENT_CHUNK 正则钉死）。
 *
 * 两条路（T11 实测）：
 *  ① **优先官方 locale 服务**：`ctx.get('locale')` 在 client 侧可用，原型方法含
 *     `register / bind / translate / lookup / getLocale / getSnapshot / subscribe / setLocale`
 *     （@deepseek-ai/dsh-client-locale/lib/client.js:1228-1435）。我们把本包字典 register 进
 *     自己的 ns，再用 `translate(ns, key, params)`（自带 fallback chain 与 `{name}` 插值）。
 *  ② **取不到就回退**：`document.documentElement.lang` + 本文件的**内置字典**。
 *     官方服务缺席、或它没有本 ns 的键（`translate` 会原样回 key）时都走这里 —— **绝不崩、绝不空**。
 *
 * 语言判定：`locale.getSnapshot().active`（实测 `zh-CN`）→ 前缀匹配；否则 `documentElement.lang`；
 * 再否则用 `zh`（本插件的默认语言）。
 */

window.__ModuleLoader__.load({
	id: "dsh-remote-wsl",
	chunk: "client.i18n.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 本包在官方 locale 里的命名空间。 */
		const NS = "dsh-remote-wsl";

		/** 中文（= 现有文案，保持现状）。 */
		const ZH = {
			"panel.title": "远程资源管理器",
			"status.daemonRunning": "远端守护运行中",
			"status.drifted": "配置已漂移",
			"browser.enter": "进入",
			"menu.copied": "已复制诊断摘要",
			"advanced.distro": "发行版：{distro}",
			"advanced.daemon": "守护：槽位 {slot} · 进程 {pid} · 版本 {version}",
			"advanced.proxy": "代理：{host}:{port} {state}",
			"advanced.proxyUp": "可达",
			"advanced.proxyDown": "不可达（直连）",
			"advanced.proxyUnknown": "未探测（发行版未运行或探测失败）",
			"advanced.drift": "配置漂移：desktop 与 pin 不一致",
			"confirm.body": "{consequence}（影响：「{distro}」上正在运行的 {count} 个会话）",

			// —— 2026-10-22 B1/B2：头部代理状态徽标（三态）+ 窄态短文案（zh/en 逐键配对）——
			// 徽标可见文字：宽态给完整词（不可达时还带地址），窄态（面板 <420）换极短词；
			// aria-label/title 始终是整句（含端点，不可达时带一句可操作提示）。
			"proxy.up": "代理可达",
			"proxy.upShort": "可达",
			"proxy.downShort": "不可达",
			"proxy.downAt": "不可达 {endpoint}",
			"proxy.unknown": "代理未探测",
			"proxy.unknownShort": "未探测",
			"proxy.ariaUp": "代理可达：{endpoint}（WSL 侧流量可以走它）",
			"proxy.ariaDown": "代理不可达：{endpoint} —— 请确认本机代理已启动；若你本来就不使用代理，可忽略此提示",
			"proxy.ariaUnknown": "代理未探测：{endpoint} —— 目标发行版未运行或本次探测失败，启动发行版后点刷新即可",
			"status.daemonPillShortOn": "守护运行中",
			"status.daemonPillShortOff": "守护未运行",
			"targets.chipShort": "WSL",

			// —— T30 重设计新增（UX 规格 §3.2；zh/en 逐键配对）——
			"status.sessions": "会话 {count} 个",
			"status.stateUnknown": "远端守护状态未知",
			// T42/N5：这行原为 `· 状态读取中…`，而底栏 JSX 自己会插 `" · "` 分隔符 ⇒ 加载态出现**双分隔符**。
			// 这里去掉行内的前导 `· `（分隔符只由 JSX 提供一处）。
			"status.readingExtra": "状态读取中…",
			"status.updated": "更新于 {time}",
			"status.daemonPillOn": "守护运行中 · 版本 {version} · slot {slot} · pid {pid}",
			"status.daemonPillOff": "守护未运行 —— 点击启动（按需拉起；无会话且无客户端 10 分钟后自动退出）",
			"load.readingSlow": "网络较慢，仍在读取…",
			// T63 窄态（面板 <420）短文案：见 usability/p07-narrow/REPORT-narrow320-fix.md
			"others.item": "实例 #{slot} · {state}",
			"others.conflictBanner": "检测到另一个实例正在使用同一槽位（{slot}）",
			"menu.more": "更多操作",
			"menu.restart": "重启远端守护…",
			"menu.stop": "停止远端守护…",
			"menu.diagnostics": "查看诊断信息",
			"menu.copyDiagnostics": "复制诊断摘要",
			"menu.group.workspace": "工作区",
			"menu.group.daemon": "守护",
			"menu.group.diagnostics": "诊断",
			"recent.title": "最近目录",
			"recent.empty": "还没有最近目录",
			"advanced.title": "高级 / 诊断",
			"browser.up": "上一级",
			"browser.copyPath": "复制此路径",
			"browser.copied": "已复制：{path}",
			"empty.nextStep": "换一个目录，或回到 Home 重新开始。",
			"empty.home": "回到 Home",


			"header.target": "目标 {distro}{cwd}",
			"header.targetUnknown": "目标未知（读取失败）",
			"header.targetPending": "尚未取得目标发行版",
			"header.refreshAria": "重新读取 explorer.snapshot",

			"load.reading": "正在读取远端信息…",

			"error.title": "读取远程资源失败（当前没有可用数据）",
			"error.titleTimeout": "读取远程资源失败（当前没有可用数据：请求超时）",
			"error.retry": "重试",
			"error.retryAria": "重试读取 explorer.snapshot",
			"error.stale": "面板上的数字已全部撤下：最后一次成功读取是 {time}，那之后的数据无法确认（可能陈旧）。",
			"error.never": "尚未成功读取过任何快照。",

			"empty.noDistrosField": "快照缺少 distros 段（host 侧 explorer.snapshot 与客户端版本不匹配？），不在此断定“没有发行版”。",
			"empty.noDistros": "wsl.exe -l -v 没有返回任何发行版（WSL 未安装，或没有已安装的发行版）。",


			"row.openBusy": "打开中…",
			"row.copy": "复制路径",
			"row.copyNoClipboard": "此环境没有 navigator.clipboard",

			"browser.aria": "WSL 目录浏览（发行版 {distro}）",
			"browser.hiddenShort": "隐藏文件",
			"browser.upTitle": "回到上一级",
			"browser.hiddenShowAria": "显示 . 开头的隐藏条目（当前：隐藏）",
			"browser.hiddenHideAria": "隐藏 . 开头的条目（当前：显示）",
			"browser.hiddenShowTitle": "点击显示 . 开头的隐藏条目（默认关）",
			"browser.hiddenHideTitle": "点击改为隐藏 . 开头的条目",
			"browser.chipsAria": "快捷目录",
			"targets.title": "WSL 目标",
			"targets.current": "当前",
			"targets.default": "默认",
			"targets.running": "运行中",
			"targets.stopped": "未运行",
			"targets.currentAria": "当前目标：{distro}",
			"targets.switchAria": "切换到 {distro}",
			"targets.currentTitle": "当前正在浏览这个发行版",
			"targets.switchTitle": "切换到 {distro}（只影响本面板，不改插件配置）",
			"targets.setDefault": "设为默认",
			"targets.stop": "停止",
			"targets.defaultSaved": "已把 {distro} 记为面板默认目标",
			"targets.chip": "WSL: {distro}",
			"targets.chipTitle": "目标与守护动作",
			"targets.count": "本机 {count} 个",
			"sessions.title": "远端会话",
			"sessions.count": "{count} 个",
			"sessions.meta": "{turns} 轮 · 空闲 {idle}",
			"sessions.copy": "复制 ID",
			"sessions.copyTitle": "复制完整 sessionId",
			"sessions.copied": "已复制",
			"sessions.id": "会话 {id}",
			"sessions.open": "打开",
			"targets.wslVersion": "WSL {version}",
			"targets.wsl1Only": "仅支持 WSL2",
			"targets.rescan": "重新扫描",
			"targets.rescanTitle": "重新读取本机 WSL 发行版清单（wsl -l -v），不切换目标",
			"browser.chipHome": "Home",
			"browser.chipHomeAria": "家目录：跳转到 {path}",
			"browser.chipRootAria": "根目录：跳转到 {path}",
			"browser.chipMntAria": "Windows 盘符挂载点：跳转到 {path}",
			"browser.chipDriveAria": "Windows 盘符：跳转到 {path}",
			"browser.crumbsAria": "当前路径（从 / 起，可点跳转）",
			"browser.crumbJump": "跳转到 {path}",
			"browser.notBrowsing": "（尚未浏览）",
			"browser.pathPlaceholder": "/home/g/project",
			"browser.pathAria": "WSL 绝对路径（回车跳转）",
			"browser.pathTitle": "输入 WSL 绝对路径，回车跳转（例如 /home/g 或 /mnt/d/project）",
			"browser.jump": "跳转",
			"browser.jumpAria": "跳转到输入的路径",
			"browser.openHere": "在此目录新建会话",
			"browser.openHereShort": "新建会话",
			"browser.openHereAria": "在 {path} 打开新的远端会话",
			"browser.openHereAriaNone": "在浏览的目录打开远端会话（尚未选定目录）",
			"browser.openHereTitle": "在当前目录建一个 DSH 会话（cwd 为该 WSL 路径的 UNC；会话会出现在左侧列表）",
			"browser.pathRequired": "请输入 WSL 绝对路径（例如 /home/g/project）。",
			"browser.pathNotAbsolute": "必须是 WSL 绝对路径（以 / 开头）；收到 \"{raw}\"。Windows 盘符路径请写成 /mnt/c/... 形式。",
			"browser.pathOtherDistro": "这个 UNC 属于发行版 {distro}，当前目标是 {current}；请先在「WSL 目标」里切换",
			"browser.listing": "正在列目录 {path}…",
			"browser.listError": "列目录失败（{path}）",
			"browser.listRetry": "重试列目录",
			"browser.emptyAll": "该目录为空。",
			"browser.emptyVisible": "该目录没有非隐藏条目{hidden}。",
			"browser.emptyHiddenHint": "（还有 {count} 个隐藏条目，可打开「隐藏文件」查看）",
			"browser.entriesAria": "{path} 的条目",
			"browser.enterDir": "进入目录 {path}",
			"browser.enterDirTitle": "进入 {path}",
			"browser.hiddenBadge": "隐藏",
			// —— 2026-10-19 UI/UX 轮新增（筛选 / 缓存提示 / 行语义）——
			"browser.searchPlaceholder": "筛选当前目录",
			"browser.searchTitle": "按名称筛选当前目录（按 / 聚焦，Esc 清空）",
			"browser.searchAria": "筛选 {path} 的条目",
			"browser.searchClear": "清除筛选",
			"browser.searchCount": "{shown}/{total} 项",
			"browser.searchTotal": "共 {total} 项",
			"browser.searchNoMatch": "没有匹配「{query}」的条目",
			"browser.staleNote": "显示的是上次缓存；刷新失败，内容可能已过期",
			"browser.loadingAria": "正在读取目录",
			"browser.rowAriaDir": "目录 {name}",
			"browser.rowAriaFile": "文件 {name}",

			"action.addWorkspace": "添加为 WSL 工作区",
			"action.addWorkspaceShort": "添加工作区",
			"action.addWorkspaceBusy": "登记中…",
			"action.addWorkspaceAria": "把 {path} 登记为 WSL 工作区（路径是 UNC ⇒ 文件工具经 9P；与“远端会话”是两条路）",
			"action.addWorkspaceTitle": "登记为工作区：host 在 WSL 侧登记该目录并返回 UNC 路径 ⇒ 文件工具走 9P。这与上方“在新会话中打开”的远端会话是两条路，互不替代。",
			"action.addWorkspaceNeedPath": "先在浏览区选定一个目录，再添加为工作区。",
			"action.addWorkspaceDone": "已登记为工作区：{title}（id={id}）",
			"action.addWorkspaceExisted": "已存在，未重复创建：{title}（id={id}）",
			"action.addWorkspaceErrorInvalid": "路径不合法，未登记（host 说：{msg}）",
			"action.addWorkspaceErrorNotFound": "该路径在 WSL 里不存在，未登记（host 说：{msg}）",
			"action.addWorkspaceErrorUnavailable": "宿主此刻不可用（发行版/权限/状态目录），未登记（host 说：{msg}）",
			"action.addWorkspaceErrorOther": "登记失败（host 说：{msg}）",

			"others.stateRunning": "运行中",
			"others.title": "其它槽位的守护（只读：本面板不会对它们发起任何动作）",

			"confirm.stopTitle": "停止远端守护？",
			"confirm.restartTitle": "重启远端守护？",
			"confirm.stopConsequence": "该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。",
			"confirm.restartConsequence": "该槽位上的守护会换一个新进程回来，正在跑的会话全部中断、上下文丢失，且不会自动恢复。",
			"confirm.okStop": "确认停止",
			"confirm.okRestart": "确认重启",
			"confirm.verbStop": "停止",
			"confirm.verbRestart": "重启",
			"confirm.okAria": "确认{verb}远端守护",
			"confirm.cancel": "取消",
			"confirm.cancelAria": "取消{verb}守护",
			"confirm.dialogAria": "{verb}守护确认",

			"note.failure": "失败：{msg}",
			"note.detailSummary": "技术细节（host 原文）",
			"note.retry": "重试",
			"note.retryAria": "重试上一个失败的动作",
			"note.done": "完成。",
			"note.unwrote": "（未写入）",
			"note.hostNoReason": "host 用 200 回了 ok:false，但没有给出原因",
			// T36 裁决：失败态的**主句必须是用户语言**；host 原文（含 pid/slot/keys/版本）只进 detail。
			"note.failStop": "远端守护仍在运行，停止未完成",
			"note.failRestart": "远端守护没有按要求收尾（重启未完成）",
			"note.failStart": "远端守护没有启动起来",
			"note.failGeneric": "远端守护没有按要求收尾",

			"session.reused": "已复用现有会话",
			"session.created": "已建立会话",
			"session.attached": "已附到会话",
			"session.pending": "会话尚未建立{cwd}；首次发消息时才物化。",
			"session.dshCreated": "已创建 DSH 会话 {id}（在左侧会话列表打开；cwd={cwd}）",
			"session.opened": "已在新会话中打开（cwd={cwd}）",
			"session.noInfo": "host 未返回会话信息。",
			"session.cwdSuffix": "（目标 cwd={cwd}）",
			"session.cwdInline": "（cwd={cwd}）",

			"daemon.started": "已启动守护",
			"daemon.restarted": "已重启守护",
			"daemon.stopped": "已停止守护",

			"status.daemonOff": "远端守护未运行",
			"status.start": "启动守护",

			"raw.summary": "诊断信息（与 wsl_status 同源）",

			"api.timeout": "explorer 请求超时：{ms}ms 内 {route} 没有响应（路由被挂住，或网关卡住）。",
			"api.aborted": "{route} 的调用已被取消（面板卸载或已有更新的读取）。",
			"api.abortedBeforeStart": "{route} 的调用在发起前已被取消。",
			"api.transport": "无法连接 host 侧 explorer 路由 {route}：{detail}",
			"api.protocol": "{route} 返回了非 JSON 响应（HTTP {status}）：{text}",
			"api.hostFailed": "explorer 调用失败（HTTP {status}）",
			"api.argument": "explorer 调用缺少必填字段 {field}",
			"api.daemonAction": "explorer.daemon 不接受动作 {action}（只允许 {allowed}）",

			"chunk.loadFailed": "dsh-remote-wsl client chunk 加载失败",
			"chunk.loadFailedTitle": "dsh-remote-wsl client chunk 加载失败：{msg}",
			"chunk.panelFailed": "面板模块加载失败",
			"chunk.panelLoading": "正在加载面板…",
			"chunk.notExported": "{file} 未导出 {fn}()",
		};

		/** English. */
		const EN = {
			"panel.title": "Remote Explorer",
			"status.daemonRunning": "Remote daemon running",
			"status.drifted": "Configuration drifted",
			"browser.enter": "Open",
			"menu.copied": "Diagnostics copied",
			"advanced.distro": "Distro: {distro}",
			"advanced.daemon": "Daemon: slot {slot} · process {pid} · version {version}",
			"advanced.proxy": "Proxy: {host}:{port} {state}",
			"advanced.proxyUp": "reachable",
			"advanced.proxyDown": "unreachable (direct)",
			"advanced.proxyUnknown": "not probed (distro stopped or probe failed)",
			"advanced.drift": "Drift: desktop and pin disagree",
			"confirm.body": "{consequence} (Affects: {count} running sessions on “{distro}”)",

			// —— 2026-10-22 B1/B2: header proxy badge (3 states) + narrow short labels (paired with ZH) ——
			"proxy.up": "Proxy reachable",
			"proxy.upShort": "Up",
			"proxy.downShort": "Down",
			"proxy.downAt": "Unreachable {endpoint}",
			"proxy.unknown": "Proxy not probed",
			"proxy.unknownShort": "N/A",
			"proxy.ariaUp": "Proxy reachable: {endpoint} (WSL-side traffic can use it)",
			"proxy.ariaDown": "Proxy unreachable: {endpoint} — make sure the host proxy is running; ignore this if you do not use a proxy",
			"proxy.ariaUnknown": "Proxy not probed: {endpoint} — the target distro is not running or the probe failed; start it and hit refresh",
			"status.daemonPillShortOn": "Daemon on",
			"status.daemonPillShortOff": "Daemon off",
			"targets.chipShort": "WSL",

			// —— T30 redesign additions (UX spec §3.2) ——
			"status.sessions": "{count} sessions",
			"status.stateUnknown": "Remote daemon state unknown",
			"status.readingExtra": "reading state…",
			"status.updated": "Updated {time}",
			"status.daemonPillOn": "Daemon running · version {version} · slot {slot} · pid {pid}",
			"status.daemonPillOff": "Daemon stopped — click to start (lazy; exits 10 min after the last session/client)",
			"load.readingSlow": "Still loading…",
			"others.item": "Instance #{slot} · {state}",
			"others.conflictBanner": "Another instance uses slot {slot}",
			"menu.more": "More actions",
			"menu.restart": "Restart remote daemon…",
			"menu.stop": "Stop remote daemon…",
			"menu.diagnostics": "View diagnostics",
			"menu.copyDiagnostics": "Copy diagnostics",
			"menu.group.workspace": "Workspace",
			"menu.group.daemon": "Daemon",
			"menu.group.diagnostics": "Diagnostics",
			"recent.title": "Recent folders",
			"recent.empty": "No recent folders yet",
			"advanced.title": "Advanced / Diagnostics",
			"browser.up": "Up one level",
			"browser.copyPath": "Copy this path",
			"browser.copied": "Copied: {path}",
			"empty.nextStep": "Pick another folder, or start again from Home.",
			"empty.home": "Back to Home",


			"header.target": "Target {distro}{cwd}",
			"header.targetUnknown": "Target unknown (read failed)",
			"header.targetPending": "Target distro not loaded yet",
			"header.refreshAria": "Re-read explorer.snapshot",

			"load.reading": "Loading remote info…",

			"error.title": "Failed to read remote resources (no usable data)",
			"error.titleTimeout": "Failed to read remote resources (no usable data: request timed out)",
			"error.retry": "Retry",
			"error.retryAria": "Retry reading explorer.snapshot",
			"error.stale": "All figures are withdrawn: the last successful read was {time}, and data after that cannot be confirmed (possibly stale).",
			"error.never": "No snapshot has been read successfully yet.",

			"empty.noDistrosField": "The snapshot has no distros section (host explorer.snapshot / client version mismatch?). This panel does not claim “no distros”.",
			"empty.noDistros": "wsl.exe -l -v returned no distros (WSL not installed, or no distro installed).",


			"row.openBusy": "Opening…",
			"row.copy": "Copy path",
			"row.copyNoClipboard": "navigator.clipboard is unavailable in this environment",

			"browser.aria": "WSL directory browser (distro {distro})",
			"browser.hiddenShort": "Hidden files",
			"browser.upTitle": "Go to parent folder",
			"browser.hiddenShowAria": "Show entries starting with a dot (currently hidden)",
			"browser.hiddenHideAria": "Hide entries starting with a dot (currently shown)",
			"browser.hiddenShowTitle": "Click to show dot-prefixed hidden entries (off by default)",
			"browser.hiddenHideTitle": "Click to hide dot-prefixed entries",
			"browser.chipsAria": "Shortcut directories",
			"targets.title": "WSL Targets",
			"targets.current": "Current",
			"targets.default": "Default",
			"targets.running": "Running",
			"targets.stopped": "Stopped",
			"targets.currentAria": "Current target: {distro}",
			"targets.switchAria": "Switch to {distro}",
			"targets.currentTitle": "This distro is the current target",
			"targets.switchTitle": "Switch to {distro} (this panel only; plugin config is unchanged)",
			"targets.setDefault": "Set default",
			"targets.stop": "Stop",
			"targets.defaultSaved": "{distro} is now the panel default target",
			"targets.chip": "WSL: {distro}",
			"targets.chipTitle": "Target and daemon actions",
			"targets.count": "{count} local",
			"sessions.title": "Remote sessions",
			"sessions.count": "{count}",
			"sessions.meta": "{turns} turns · idle {idle}",
			"sessions.copy": "Copy ID",
			"sessions.copyTitle": "Copy the full sessionId",
			"sessions.copied": "Copied",
			"sessions.id": "Session {id}",
			"sessions.open": "Open",
			"targets.wslVersion": "WSL {version}",
			"targets.wsl1Only": "WSL2 only",
			"targets.rescan": "Rescan",
			"targets.rescanTitle": "Re-read the local WSL distro list (wsl -l -v) without switching targets",
			"browser.chipHome": "Home",
			"browser.chipHomeAria": "Home directory: jump to {path}",
			"browser.chipRootAria": "Root directory: jump to {path}",
			"browser.chipMntAria": "Windows drive mount point: jump to {path}",
			"browser.chipDriveAria": "Windows drive: jump to {path}",
			"browser.crumbsAria": "Current path (from /, each segment is clickable)",
			"browser.crumbJump": "Jump to {path}",
			"browser.notBrowsing": "(not browsing yet)",
			"browser.pathPlaceholder": "/home/g/project",
			"browser.pathAria": "WSL absolute path (press Enter to jump)",
			"browser.pathTitle": "Type a WSL absolute path and press Enter (for example /home/g or /mnt/d/project)",
			"browser.jump": "Go",
			"browser.jumpAria": "Jump to the typed path",
			"browser.openHere": "New session in this folder",
			"browser.openHereShort": "New session",
			"browser.openHereAria": "Open a new remote session in {path}",
			"browser.openHereAriaNone": "Open a remote session in the browsed directory (no directory selected yet)",
			"browser.openHereTitle": "Create a DSH session rooted at this folder (cwd = the WSL path's UNC; it appears in the session list)",
			"browser.pathRequired": "Enter a WSL absolute path (for example /home/g/project).",
			"browser.pathNotAbsolute": "Must be a WSL absolute path (starting with /); got \"{raw}\". Windows drive paths should be written as /mnt/c/...",
			"browser.pathOtherDistro": "This UNC belongs to {distro}; the current target is {current}. Switch the WSL target first.",
			"browser.listing": "Listing {path}…",
			"browser.listError": "Failed to list ({path})",
			"browser.listRetry": "Retry listing",
			"browser.emptyAll": "This directory is empty.",
			"browser.emptyVisible": "No non-hidden entries here{hidden}.",
			"browser.emptyHiddenHint": " ({count} hidden entries exist; turn on “Hidden files” to see them)",
			"browser.entriesAria": "Entries of {path}",
			"browser.enterDir": "Enter directory {path}",
			"browser.enterDirTitle": "Enter {path}",
			"browser.hiddenBadge": "hidden",
			// —— 2026-10-19 UI/UX round (filter / stale note / row semantics) ——
			"browser.searchPlaceholder": "Filter this folder",
			"browser.searchTitle": "Filter this folder by name (/ to focus, Esc to clear)",
			"browser.searchAria": "Filter entries in {path}",
			"browser.searchClear": "Clear filter",
			"browser.searchCount": "{shown}/{total} items",
			"browser.searchTotal": "{total} items",
			"browser.searchNoMatch": "No entries match “{query}”",
			"browser.staleNote": "Showing the last cached listing; refresh failed, so it may be out of date",
			"browser.loadingAria": "Loading folder",
			"browser.rowAriaDir": "Folder {name}",
			"browser.rowAriaFile": "File {name}",

			"action.addWorkspace": "Add as WSL workspace",
			"action.addWorkspaceShort": "Add workspace",
			"action.addWorkspaceBusy": "Registering…",
			"action.addWorkspaceAria": "Register {path} as a WSL workspace (UNC path ⇒ file tools go through 9P; a different path from “remote session”)",
			"action.addWorkspaceTitle": "Register as a workspace: the host registers the directory inside WSL and returns a UNC path ⇒ file tools use 9P. This is a different path from “Open in new session” above; neither replaces the other.",
			"action.addWorkspaceNeedPath": "Browse to a directory first, then add it as a workspace.",
			"action.addWorkspaceDone": "Registered as workspace: {title} (id={id})",
			"action.addWorkspaceExisted": "Already existed — not created again: {title} (id={id})",
			"action.addWorkspaceErrorInvalid": "Invalid path, not registered (host says: {msg})",
			"action.addWorkspaceErrorNotFound": "That path does not exist in WSL, not registered (host says: {msg})",
			"action.addWorkspaceErrorUnavailable": "The host is unavailable right now (distro/permission/state dir), not registered (host says: {msg})",
			"action.addWorkspaceErrorOther": "Registration failed (host says: {msg})",

			"others.stateRunning": "Running",
			"others.title": "Daemons in other slots (read-only: this panel never acts on them)",

			"confirm.stopTitle": "Stop the remote daemon?",
			"confirm.restartTitle": "Restart the remote daemon?",
			"confirm.stopConsequence": "the daemon on that slot is stopped, every running session is interrupted and its context is lost; you must “Start daemon” again afterwards.",
			"confirm.restartConsequence": "the daemon on that slot comes back as a new process, every running session is interrupted and its context is lost, and it will not resume automatically.",
			"confirm.okStop": "Confirm stop",
			"confirm.okRestart": "Confirm restart",
			"confirm.verbStop": "stop",
			"confirm.verbRestart": "restart",
			"confirm.okAria": "Confirm {verb} remote daemon",
			"confirm.cancel": "Cancel",
			"confirm.cancelAria": "Cancel {verb} daemon",
			"confirm.dialogAria": "{verb} daemon confirmation",

			"note.failure": "Failed: {msg}",
			"note.detailSummary": "Technical details (host text)",
			"note.retry": "Retry",
			"note.retryAria": "Retry the last failed action",
			"note.done": "Done.",
			"note.unwrote": " (not written)",
			"note.hostNoReason": "the host answered ok:false with HTTP 200 but gave no reason",
			"note.failStop": "the remote daemon is still running; it was not stopped",
			"note.failRestart": "the remote daemon did not finish restarting",
			"note.failStart": "the remote daemon did not start",
			"note.failGeneric": "the remote daemon did not finish as requested",

			"session.reused": "Reused the existing session",
			"session.created": "Session created",
			"session.attached": "Attached to session",
			"session.pending": "No session yet{cwd}; it materializes on the first message.",
			"session.dshCreated": "DSH session created: {id} (open it in the session list; cwd={cwd})",
			"session.opened": "Opened in a new session (cwd={cwd})",
			"session.noInfo": "The host returned no session information.",
			"session.cwdSuffix": " (target cwd={cwd})",
			"session.cwdInline": " (cwd={cwd})",

			"daemon.started": "Daemon started",
			"daemon.restarted": "Daemon restarted",
			"daemon.stopped": "Daemon stopped",

			"status.daemonOff": "Remote daemon is not running",
			"status.start": "Start daemon",

			"raw.summary": "Diagnostics (same source as wsl_status)",

			"api.timeout": "explorer request timed out: no response from {route} within {ms}ms (the route or the gateway is stuck).",
			"api.aborted": "The call to {route} was cancelled (panel unmounted or superseded by a newer read).",
			"api.abortedBeforeStart": "The call to {route} was already cancelled before it started.",
			"api.transport": "Cannot reach the host explorer route {route}: {detail}",
			"api.protocol": "{route} returned a non-JSON response (HTTP {status}): {text}",
			"api.hostFailed": "explorer call failed (HTTP {status})",
			"api.argument": "explorer call is missing the required field {field}",
			"api.daemonAction": "explorer.daemon does not accept action {action} (allowed: {allowed})",

			"chunk.loadFailed": "dsh-remote-wsl client chunk failed to load",
			"chunk.loadFailedTitle": "dsh-remote-wsl client chunk failed to load: {msg}",
			"chunk.panelFailed": "Panel module failed to load",
			"chunk.panelLoading": "Loading panel…",
			"chunk.notExported": "{file} does not export {fn}()",
		};

		/** zh/en 的内置字典（回退用；也是 register 给官方 locale 的那一份）。 */
		const DICTS = { zh: ZH, en: EN };

		/** `{name}` 插值（官方 translate 也做同样的事；这里是回退路径的实现）。 */
		function interpolate(template, params) {
			if (typeof template !== "string") return "";
			if (params === undefined || params === null) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}

		/** 把任意 locale 标签/语言码归一成内置字典的键：`en*` ⇒ en，其余 ⇒ zh。 */
		function normalizeLanguage(value) {
			const text = typeof value === "string" ? value.trim().toLowerCase() : "";
			return text.startsWith("en") ? "en" : "zh";
		}

		/**
		 * 解析当前语言：官方 locale 快照优先，其次 `documentElement.lang`，最后 `zh`。
		 * @param localeService 官方 `ctx.get('locale')`（可能为 undefined）
		 * @param doc document（可注入，便于单测）
		 */
		function resolveLanguage(localeService, doc) {
			try {
				if (localeService && typeof localeService.getSnapshot === "function") {
					const snap = localeService.getSnapshot();
					if (snap && typeof snap.active === "string" && snap.active.length) return normalizeLanguage(snap.active);
				}
				if (localeService && typeof localeService.getLocale === "function") {
					const snap = localeService.getLocale();
					if (snap && typeof snap.active === "string" && snap.active.length) return normalizeLanguage(snap.active);
				}
			} catch {
				/* 官方服务坏掉也不许崩 —— 继续走回退 */
			}
			try {
				const element = doc === undefined ? (typeof document === "undefined" ? null : document) : doc;
				if (element && element.documentElement && typeof element.documentElement.lang === "string") {
					return normalizeLanguage(element.documentElement.lang);
				}
			} catch {
				/* ignore */
			}
			return "zh";
		}

		/**
		 * 造一个 `t(key, params)`：
		 * ① 官方 locale 的 `translate(ns, key, params)`（它有 fallback chain 与插值）；
		 * ② 内置字典（按 resolveLanguage 选 zh/en，再退 zh）；
		 * ③ 都没有 ⇒ 原样回 key（**绝不返回 undefined/空占位**）。
		 */
		function createTranslator(localeService, doc) {
			const t = (key, params) => {
				try {
					if (localeService && typeof localeService.translate === "function") {
						const viaOfficial = localeService.translate(NS, key, params);
						// 官方缺键时会原样回 key（见 client-locale:1425）⇒ 视为"没取到"
						if (typeof viaOfficial === "string" && viaOfficial.length && viaOfficial !== key) return viaOfficial;
					}
				} catch {
					/* 官方路径抛错 ⇒ 回退，不许崩 */
				}
				// 回退字典**每次调用都重算语言**：语言切换（官方 setLocale 或 <html lang> 变更）后
				// 立即跟上，不会停在创建时的语言上。
				const lang = resolveLanguage(localeService, doc);
				const dict = DICTS[lang] || DICTS.zh;
				const template = dict[key] !== undefined ? dict[key] : DICTS.zh[key];
				if (template === undefined) return key;
				return interpolate(template, params);
			};
			t.language = resolveLanguage(localeService, doc);
			t.dicts = DICTS;
			return t;
		}

		exports.NS = NS;
		exports.DICTS = DICTS;
		exports.normalizeLanguage = normalizeLanguage;
		exports.resolveLanguage = resolveLanguage;
		exports.interpolate = interpolate;
		exports.createTranslator = createTranslator;
		return module.exports;
	},
});