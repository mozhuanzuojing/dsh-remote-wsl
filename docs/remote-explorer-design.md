# 设计：DSH 版「远程资源管理器」（Remote Explorer for dsh-remote-wsl）

- **日期**：2026-10-12（**2026-10-13 刷新状态**）｜ **状态**：**P0 已实现**（侧栏面板 / `POST /remote-wsl/api` / 守护路径均已落地；本文保留为设计稿与决策记录）
- **目标**：把现在"只能靠对话调工具"的用法，包成一个**侧栏面板**，观感与操作对位 VS Code 的「远程资源管理器」（Remote Explorer）。
- **结论先说**：要"侧栏图标 + 中央树面板"，**必须给本插件加一个 client 半**（不是新工具、不是新 profile）。好消息是 **client 半可以零构建**（`React.createElement`，无 JSX），与本插件现有的"零构建 TypeScript"约定一致。

> **权威指针（2026-10-13）**：本文是**设计稿 / 历史决策记录**；**实现以 `src/explorer.ts`（方法表 `EXPLORER_METHODS`，6 个）+ `docs/client-contract.md`（client 契约）为准**。文内早期出现的 `host.call` 形态**已被证伪并废弃**（见 §1 表内那一行、§3 的 `settings.section` 行、§4 的两处标注）。

---

## 1. 为什么"包一层界面"必须走 client 半（实测依据，不是推测）

本次用 DSH 自己的 Inspect 探针在**活宿主**上实测（2026-10-12）：

| 事实 | 实测来源 | 含义 |
|---|---|---|
| 有 `sidebar.panellist` 槽：*"Global panel icons. **Each list id addresses the matching main panel**"* | `client/Slots.listSubTree("sidebar.panellist")` | 侧栏图标 + 中央面板是**一对**：注册一个 `id`，同时注册 `main` 的同名 key |
| 该槽现有 occupant：`plugins`(order 0)、`schedules`(order 10)，都来自 `mf` | 同上 | 槽是**加法**的：用**自己的新 id** 就并排加一个图标，不会顶掉 shipped UI |
| 图标组件的 props：`SidebarPanelIconOwnerProps { size: number; active: boolean }` | 同上（`ownerProps`） | 图标是**一个 React 组件**，不是图片路径 |
| `main` 槽是 keyed：*"Central panel selected by sidebar entry id"*，已占用 key = `conversation` | `client/Slots.listSubTree()` 根树 | 我们的面板 = `main` 槽 `key: 'remote-wsl'` |
| client 半的声明：**`dsh.client`**，由 host 侧 `clientModules` 扫描（*"incremental `dsh.client` scan + wire composition + bundle route + index injection rows"*） | `host/Service.listService` → `clientModules` | 打包形态确定：包内声明 `dsh.client`，host 把它编成 bundle route 注入页面 |
| client 半可用的内建：`ctx`（受限 Cordis）、`React`（**无 JSX 转换**，只能 `createElement`）、`styles.insert(css)`、`console` | `client/Builtin.listBuiltins` | ⇒ **零构建可行**：纯 ESM + `createElement`，不需要 bundler/JSX |
| ⚠️ **`host.call` 对静态 client 半不成立**（2026-10-12 由 teammate `host-explorer` 证伪，Lead 采纳）：`host.call(method,args)` 是**动态包**浏览器半的内建（`dsh-cordis-client-runner` README 原文），而动态包只能渲染进自己那张工具卡 ⇒ **进不了侧栏**；静态 `dsh.client` 半**没有**这个内建 | 官方 README + `client/Builtin.listBuiltins` | **P0 数据面因此改为同源 HTTP**（见 §4） |
| P0 数据通道（裁决）：host 侧 `ctx.inject(['webServer'], c => c.get('webServer').register({kind:'exact', path, handler}))` + 浏览器侧**同源 fetch** | 官方 WebRoute 契约 + `dsh-wechat` 0.8.0 生产先例（运行时零 `@deepseek-ai` 导入） | 零构建 link 插件**唯一有生产先例**的通道 |
| 主题 token 现成：`--dsw-alias-bg-base/-layer-1/-layer-2/-overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-label-primary/secondary`、`--dsw-alias-state-*`、`--dsw-specific-sidebar-fill`（均要求 light+dark 双份） | `client/Theme.listTokens` | 观感不用自己造色，跟着主题走 |
| client 服务面：`layout.selectPanel(panelId)` / `toggleSidebar()`、`uiWorkspace.{pickDirectory,listDirectory,startSession,openSession}`、`workspaces.{create,rename,delete}`、`sessions.*`、`slots.register`、`locale.register`、`theme.*` | `client/Service.listService` | 面板要的"导航/开会话/打开目录"原语都在（**注意**：这些只在**当前会话上下文**里可用；跨包取数仍走 §4 的 HTTP 方法表） |
| host 侧 RPC 桥：`typertGateway.{invoke,stream,hasLiveClient}` + 各服务上的 `@Remote(...)` 方法 | `host/Service.listService` | ⚠️ 浏览器→host 的 Remote 端点由 typertGateway 认领，是**构建期生成**的（`@Remote` + schema 生成）；**link 装的零构建插件没有生成物** ⇒ 这条对 P0 **不可用**（将来若引入构建再评估） |

> ⚠️ **动态包（`cordis_define`/`cordis_run`）不是替代方案**：动态包的 client 半只能渲染进**自己那张工具卡的卡片里**（`tool.view.cordis`，且 key 只接受 `self`），**进不了侧栏**。所以"远程资源管理器"这个形态**只能靠 client 半**。

---

## 2. 目标形态（线框）

```
┌─ 侧栏 rail ─┐┌──────────────── 中央面板（main key: remote-wsl）────────────────┐
│  …          ││  远程资源管理器            [ WSL 目标 ▾ ]   ＋   ⟳   ⋯        │
│  📄 会话     ││ ─────────────────────────────────────────────────────────── │
│  🔌[插件]    ││  ▾ 🖥 debian-u8-1   默认发行版   ● daemon 8895·v0.2.0-rc.2  │
│  ⏰[定时]    ││      📁 dsh1                /home/g/project/dsh1            │
│  🐧[WSL] ◀── 新增（本设计）                                                        │
│             ││      📁 u8-workspace.code-workspace  /home/g/project/u8-…    │
│             ││      📁 OpenAPI-Gateway     /home/g/project/OpenAPI-Gateway  │
│             ││      📁 pi-cc               /home/g/project/mypi/pi-cc        │
│             ││  ▸ 🖥 Ubuntu-22.04（未连接）                                  │
│             ││ ─────────────────────────────────────────────────────────── │
│             ││  daemon 8895 · v0.2.0-rc.2 · keys 2 · drift ⚠ desktop≠pin     │
└─────────────┘└───────────────────────────────────────────────────────────────┘
```

每行 hover 动作：**在新会话中打开** · **在终端中打开** · **复制 WSL 路径** · **从列表移除**。
底部状态条：守护 pid/端口/version、活跃 key 数、drift 徽标（点击 → 修 pin）。

---

## 3. 挂点清单（照实测的槽契约写）

| 槽 | 注册 | 内容 | 备注 |
|---|---|---|---|
| `sidebar.panellist` | `{ id: 'remote-wsl', order: 20, label: () => t('远程资源管理器') }` | 图标组件 `({size, active}) => ReactElement` | 用**自己的新 id** ⇒ 与 `plugins`/`schedules` 并排 |
| `main` | `{ key: 'remote-wsl' }` | 面板：标题行 + 树 + 状态条 | key 与上面 id **必须同名**（契约写明"list id addresses the matching main panel"） |
| `settings.section` | `{ id: 'remote-wsl', order: 20, label: 'Remote WSL' }` | 配置页：`distro` / `cwd` / `webPort` / `daemonIdleMs` / `autoWarm` | ⚠️ **本行两处已过期（2026-10-13）**：① `host.call` 对静态 client 半**不成立**（见 §1 那一行）；② `settings.section` 本插件**尚未实现**（P1）。取数形态见 §4 的"传输"段 |
| `conversation.input.left` | `{ id: 'remote-wsl-daemon', order: 20 }` | 一个小状态点（守护活着/漂移） | 可选，P1 |
| `sidebar.workspaces.session.menu.item` | `{ id: 'remote-wsl-reopen', order: 20 }` | 会话菜单里的「在 WSL 中重开」（= `reopenInWSL` 等价物） | 可选，P2 |

进入方式：点图标 → `ctx.get('layout').selectPanel('remote-wsl')`；面板挂载时拉一次快照。

---

## 4. 数据面：client 半只调**一个**聚合方法

```ts
// ⚠️ 已废弃（2026-10-12 证伪）：静态 client 半**没有** `host.call` —— 那是**动态包**浏览器半的内建。
// 实现态见本节下方「传输」段：host 侧 webServer.register 的精确路由 + 浏览器**同源 fetch**；
// client 侧唯一网络出口是 `client/client.api.js` 的 `createExplorerApi()`（面板不直接拼 URL/JSON）。
```

```ts
// host 半（新增，内部复用现有真相源，不重写逻辑）
interface ExplorerSnapshot {
  distros: { name: string; default: boolean; reachable: boolean }[]
  target: { distro: string; wslHome: string; cwd: string }
  daemon: { running: boolean; slot?: number; pid?: number; version?: string; keys: string[]; orphans: number }
  drift: { drifted: boolean; desktop?: string; pin?: string }
  workspaces: { distro: string; path: string; label: string; kind: 'folder' | 'code-workspace' }[]
  webHosts: { port: number; url: string }[]
}
```

- **单一真相源**：`daemon` 段必须来自既有的 `daemon-client.ts:daemonSnapshot()`，**不新开一条扫描路径**（README 已把这条写成纪律：孤儿判定只能有一处真相源）。
- **传输（2026-10-12 裁决，替换原先的 `@Remote` 设想）**：方法表实现成**普通函数表**，经 **host 侧 `webServer.register` 的 HTTP 路由**暴露；**不用** `@Remote`（那是构建期生成的，零构建插件没有生成物）。
  ```
  POST /remote-wsl/api   body: { "method": "explorer.snapshot", "args": {...} }
  GET  /remote-wsl/api   → 方法清单（调试用）
  body.args 可选 `distro`（缺省 = 配置里的发行版；多发行版机器上面板切换目标就靠它）
  method ∈ explorer.snapshot | explorer.openSession | explorer.daemon | explorer.fixPin | explorer.listDir | explorer.addWorkspace | explorer.newSession
  （**7 个**。权威：`src/explorer.ts` 的 `EXPLORER_METHODS`；client 侧副本 `client/client.api.js`。后两个 `listDir`/`addWorkspace` 是 A3/A1 落地时新增）
  ```
  **安全硬要求（T4 会实测"同源 200 / 伪造 Origin 403"）**：
  a) **只接受可信来源**：`Sec-Fetch-Site` 若存在必须 `same-origin`；`Origin` 若存在必须与请求 `Host` 同源；
     **两者都缺失 ⇒ 放行**（2026-10-21 修正桌面壳误杀）：DSH Desktop（Electron 壳）把页面 `dsh-app://app`
     的 fetch 交给 **Node fetch** 重放，并**主动删掉** `origin`/`host`/`cookie`/`sec-fetch-site`
     （`app.asar/lib/main.js` 的 `forwardWebRequest`，2026-10-21 平台版本实测）⇒ 到达路由时**没有 Origin**；
     旧实现要求"Origin 必须存在"，会让桌面端面板的全部数据与动作 403（错误文案「跨站请求被拒（Origin/Host 不同源）」）。
     浏览器对**每一个 POST** 都带 `Origin`、对每个非导航请求都带 `Sec-Fetch-Site`，两个头都缺失只可能来自非浏览器
     客户端（桌面壳 / curl）；本机进程本来就能伪造 `Origin` ⇒ 放行不扩大 CSRF 面。官方 `dsh-client-connection` 的
     `admit()` 是同策略（`sec-fetch-site === 'cross-site'` 拒、`origin === undefined` 放行）。
     Host 缺失 / 非 `same-origin` / 异源 `Origin` → **403，且不得执行任何方法**；
  b) `method` 走**硬编码白名单**，未知 → 400（不许把字符串反射成任意函数）；
  c) 只接受 `POST` + `content-type: application/json`；其它动词 → 405；
  d) **不得**暴露 `all=true` 式会波及其他人的能力；`explorer.daemon` 只作用于本插件自己的槽位；
  e) 响应与错误**不回传** token/凭据。
- **`explorer.openSession` 的 P0 语义（降级，明示不静默副作用）**：默认**不烧模型调用** —— 幂等 ensure 守护后，从 daemon 元数据取该 `(key,cwd)` **已物化**的 sessionId；没有则返回 `{sessionId:null, created:false, note:'首次 wsl_agent 轮次才会物化'}`。**UI 必须把这个状态显示出来**（"远端会话将在首次发消息时建立"），不许让用户以为已经开好。`warm:true`（真起一轮）保留在实现里，但 **P0 的 UI 不暴露**，留 P1 的显式动作。
- **不新增 agent 工具**：现有 **7 个**工具（`wsl_status`/`wsl_exec`/`wsl_agent`/`wsl_daemon`/`wsl_open_ui`/`wsl_sync_version`/`wsl_path`）继续是 **agent 面**；面板是 **人面**，两者共用同一套 host 实现。（工具名权威：`src/index.ts` 的 `name: 'wsl_*'` 共 **7** 处；`wsl_path` 是 A6 新增的第 7 个。）

---

## 5. 交互 → 用什么原语

| 用户动作 | 走什么 | 说明 |
|---|---|---|
| 切 distro | **所有方法都可带可选的 `{distro}`**（snapshot / listDir / openSession / daemon / fixPin / addWorkspace） | **2026-10-21 落地**：按请求生效、**不写插件配置**（因此不需要 `explorer.selectDistro`）；host 用 `wsl -l -q` 校验名字，未知 ⇒ 400 `E_ARG`；面板按 VS Code Remote Explorer 的 **WSL TARGETS** 形态渲染「WSL 目标」列表（多发行版才出现，点行切换） |
| 点文件夹「在新会话中打开」 | `{method:'explorer.openSession'}` → **附到已物化的会话** | **P0 语义是"附到/提示"而不是"真起一轮"**（见 §4 末条）。不是把 WSL 目录当本地工作区（见 §7） |
| 点「在终端中打开」 | host 半起 `wsl.exe -d <distro> --cd <path> -- bash`，并让会话认领它 | 或复用 `terminalController` 的宿主终端 + `wsl.exe` 包装 |
| 「＋」添加收藏路径 | host 半在 WSL 里列目录（复用 `wsl_exec` 同一套落文件+`bash <file>` 纪律）→ 存 `explorer.json` | **不要**用 DSH 的 `uiWorkspace.pickDirectory`（那是 **Windows 本机**目录，不是 WSL） |
| 起 / 停 / 重启守护 | `explorer.daemon({action})` → 复用 `daemon-client.ts` 的 ensure/stop | 与 `wsl_daemon` 工具**同一实现** |
| drift 「修」 | `explorer.fixPin()` → 复用 `wsl_sync_version` 的 warm + pin 逻辑 | 默认只告警，点击才动手（保持现有语义：不自动杀守护） |
| 打开 Web UI 窗口 | `explorer.openUi({port})` → 复用 `wsl_open_ui` 的 `WebHost` + 浏览器 app 窗口 | — |

---

## 6. 分期与验收

### P0 —— "看得见、点得动"（1 天量级）
- `dsh.client` + `client/` 目录（零构建 ESM），挂 `sidebar.panellist` + `main`；
- host 半新增 `explorer.snapshot` / `explorer.openSession`（复用手臂，不写新逻辑）；
- 树：distro → 收藏路径；顶部 distro 选择器 + 刷新；底部守护状态条；空态与错误态（WSL 不可达、无守护）。
- **验收**：① 侧栏出现我们的面板图标（**加法**：与 `plugins`/`schedules` 并排），点击切到面板；② 树上显示 `debian-u8-1` 与配置路径，与 `wsl_status` 输出**逐项一致**（同源，不许出现两套数）；③ 点「在新会话中打开」按**新语义**：已有物化会话 ⇒ 附上并回报 sessionId；没有 ⇒ `{sessionId:null, created:false}` **且界面显式提示**"远端会话将在首次发消息时建立"，**全程不烧模型调用**；④ 主题切 light/dark 都正常（token 双份、`getPropertyValue` 实测非空）；⑤ 关面板/切面板**不杀守护**（pid/port/version/keys 前后一致）；⑥ **传输安全**：同源 → 200；伪造/缺失 `Origin` → **403 且方法未被执行**；未知 `method` → 400；非 POST → 405；响应与错误**不含凭据**。

### P1 —— 运维闭环
- 起/停/restart 守护（幂等）、drift 修复按钮、`＋/－` 收藏路径、`settings.section` 配置页、composer 状态点。

### P2 —— 逼近 Remote-WSL
- **工作区根映射**（见 §7 的 UNC 约定）→ 让"打开文件夹"变成真工作区；
- 会话菜单「在 WSL 中重开」；
- PWA / 固定图标（token 每次重启变 ⇒ 必须经 `wsl_open_ui` 取最新 URL，二者是依赖关系）。

---

## 7. 与 VS Code 的差距：这个面板能关掉哪些、关不掉哪些

| VS Code Remote-WSL | 本设计 | 定性 |
|---|---|---|
| 侧栏「远程资源管理器」图标 + 面板 | `sidebar.panellist` + `main` | ✅ **本次关掉** |
| WSL 目标下拉（distro 选择器） | 面板标题行下拉（host 半枚举 `wsl -l -v`） | ✅ 关掉 |
| 树下钻/右键/打开文件夹 | 树 + hover 动作 + 「在新会话中打开」 | 🟡 **语义近似**：打开的是"WSL 里的会话"，不是"把远端根变成工作区" |
| 状态栏 "WSL: Debian" / 连接状态 | 面板底部状态条 + composer 状态点 | 🟡 面板内有，全局状态栏无（要动 shell chrome） |
| `reopenInWSL` / 工作区根映射 | P2 的会话菜单项 + UNC 约定 | 🔴 真等价仍需上游 fs provider（GAP-AUDIT #11） |
| UI 载体 = 原生远端窗口 | 本面板是**原生 DSH 面板**（比 `wsl_open_ui` 的浏览器窗口更"原生"），但仍不是"桌面壳连远端 host" | 🟡 面板补位，桌面壳限制不变（GAP-AUDIT #2） |
| 远端扩展/skill 管理 UI | 不做（WSL 自带 `~/.agents`，见 GAP-AUDIT #4） | ❌ 不做 |

**UNC 硬风险（写进设计以免重犯）**：若要让 WSL 目录成为"工作区根"，路径只能写成 `\\wsl.localhost\<distro>\home\g\...`；**在 UNC 上跑写型 Windows 工具（git/npm）会写坏同一份 ext4 的属主/权限**（GAP-AUDIT §7 复核结论）。⇒ 约定必须是"**经 UNC 读、经 `wsl_exec` 执行**"，并在 AGENTS.md 里禁掉 UNC 上的写型 Windows 工具。

---

## 8. 工程与纪律约束（落地前必须守住）

1. **零构建**：client 半只用 `React.createElement` + 纯 ESM，**不引 bundler / 不写 JSX**；这样与本插件"零构建 TS"的约定一致（若某天必须用 JSX，再评估引入构建，届时文档要写清）。
2. **冻结集（P0 起）**：`src/**/*.ts`（现有 **8** 个，含新增 `explorer.ts`）+ `client/**`（入口固定 `client/index.js`）+ `package.json`。原「7 个文件」的历史表保留为 *0.1.0 原冻结集*；P0 冻结表上线时在 README 与 handoff §6 各更新一张（新增文件一并入表）。复验纪律不变：**首尾双断言**，漂移即判「验证无效」。
3. **热更与落地顺序**：client 半改动需要 profile 重启（手头记录：client 改动要 `pnpm run dev:web` 在跑才热更；否则重启宿主）。⚠️ **落地顺序锁死**：T1 契约 → T3 的 `client/**` 真存在 → **T2 最后**才把 `dsh.client` 写进 `package.json` → 立刻 `--dump-config` 复验。理由：官方明确 *"missing bundle fails activation loudly"* —— 先声明 `dsh.client` 而 `client/` 不存在，会让插件在 profile 里**加载失败**。
4. **安全边界**：P0 经**同源 HTTP 路由**取数（不是开放 RPC、也不是跨源 API）⇒ 必须按 §4 的五条硬要求实现（同源校验 / 方法白名单 / 仅 POST+JSON / 无 `all=` 类能力 / 不回传凭据）；面板动作继续走既有鉴权与身份校验路径（token、`/proc` 身份扫描、只回收自有资源）。
5. **不做全局副作用**：面板的"清理"只作用于自己的槽位/自有资源；**禁止** `stop all=true` 这类会连带他人守护的动作进 UI（或必须二次确认并写明后果）。
6. **同源（2026-10-12 精确定义，F33 修复后）**：两者必须来自**同一个 `daemonSnapshot()`**，但**允许不同的选择器** —— `daemonStatus`（`wsl_status`）是**发现语义**（任何槽位；优先自己槽位、缺失则回落 `live[0]`），`explorer.snapshot` 是**所有权语义**（只报 `cfg.daemonPort`）。**当且仅当「配置槽位无守护、别处有守护」时两者允许不同**（面板 `running:false` + 别槽进**只读** `others[]`）—— 这是**有意的收窄**，目的是**杜绝跨实例误停**（`live[0]` 回落会让面板「停止 slot N」对准别人的守护，实测发生过），**不是回归**；其余场景一律逐项一致。原纪律保留如下。
   原纪律：面板上的每个数字都必须能在 `wsl_status` 找到同一个来源值（避免"界面显示一套、工具说另一套"）。

---

## 9. 工作量与风险

| 项 | 估计 | 风险 |
|---|---|---|
| client 半骨架（`dsh.client` + 两个槽 + 主题 token） | 0.5 天 | `dsh.client` 的**确切字段形状**需先探一次（见下） |
| `explorer.snapshot` + `openSession`（复用现有） | 0.5 天 | 低（复用为主） |
| 树/状态条/空错态打磨 | 0.5 天 | 中（主题双份、rail 折叠态） |
| P1 运维闭环 | 1 天 | 中（与现有 daemon 动作对齐） |
| P2 UNC 工作区 | 2–3 天 | **高**（属 GAP-AUDIT #11，有数据损坏风险） |

**落地前的第一个探针（15 分钟）**：在有 client 半的官方包里读 `package.json` 的 `dsh.client` 形状（`clientModules` 是它的消费者），并验证"新 id 注册 `sidebar.panellist` + `main` 同名 key"能真的出现在侧栏。做完这一条，P0 的其余部分就都是常规前端活了。

**该探针的第一次收益（2026-10-12，已发生）**：它**一次就否掉了本设计稿原来的两条设想** —— ① `host.call` 不属静态 client 半（属动态包，进不了侧栏）；② `@Remote` 端点是构建期生成的（零构建 link 插件没有生成物）。两者都会让 P0 写出一层**运行时才发现不存在**的传输。⇒ 结论：**这类"契约类未知数必须先探再写**，不要按最自然的直觉先落代码（本次靠 teammate 先探，省掉了一轮返工）。

---

## 10. 不做的事（明确划界）

- **不做**"桌面壳连远端 host"（上游限制，改了会被桌面更新覆盖）。
- **不做**远端 skill/MCP 管理 UI（WSL 自带 `~/.agents`，且两侧是故意两份）。
- **不做**状态栏/标题栏等 shell chrome 的替换（那是 `shadows-shipped-ui` 风险面）。
- **不做**把面板当第二个真相源（所有数字必须来自 host 半的既有实现）。
