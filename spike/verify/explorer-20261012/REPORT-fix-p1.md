# REPORT-fix-p1.md —— task-10 P1 修复的聚焦复验

- **验证者**：`p0-verify`（独立于 T8/T9 实现者）｜**日期**：2026-10-12｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：开工冻结（16:31）→ 收尾复算（17:0x）**锚点一致 = True（13/13）** ⇒ 本次验证**有效**；advisory 仅 `README.md`（47603→50068B）
- 新锚点集 13 个：`src/**/*.ts` 8 + `client/**` 4 + `package.json`。与 T4 冻结逐文件对比，**恰好 4 个变**：
  `src/explorer.ts` 29545→34016B、`src/daemon-client.ts` 36596→37581B、`client/client.panel.js` 29111→34915B、`client/index.js` 13859→14841B；
  `src/index.ts`、`src/daemon.ts`、`src/sdk-runtime.ts`、`src/selftest.ts`、`src/shell-env.ts`、`src/version.ts`、`package.json`、`client/client.api.js`、`client/client.icon.js` **未变**。
  lead 给的两个已知前缀 **2/2 MATCH**（`explorer.ts` A2C6B8B9A19A…、`daemon-client.ts` 184F6B87EF2E…）。

## 结论（≤450 字）

**7 条缺陷断言 + F35/F36：全部 PASS；A 组回归 ①②③⑤：全部 PASS；故意红 3 条全部按预期变红。**
F32 双次 inject 后 `dispose` 路由计数 **0**（旧缺陷形态对照残留 1 ⇒ 断言有区分力）｜F33 配置槽无守护时 `snapshot.daemon` 报 `running:false` + 别槽进 `others[]`（带 note），面板只显示「daemon 未运行」并单列只读「其它槽位的守护」，非配置槽位动作 **400/E_ARG 且无副作用**｜F15 `webServer` 永不就绪时出现降级日志（经 `DSH_REMOTE_WSL_INJECT_WARN_MS=300` 接缝，不等 30s）｜F14b `ensure` 失败 → **503 E_UNAVAILABLE**（阳性对照释放后 200）｜F31 `launch-stderr.log` 644→起守护→**600**｜F34 首挂载只有「正在读取…」、无「已撤下/失败」｜F25 `fixPin ok:false` → `role=alert`「失败：… 重试」｜F35 路径 `direction:ltr`+`unicode-bidi:plaintext`｜F36 主行动有可见反馈且**不被自己触发的刷新清空**。
③ 两种场景都跑：**F33 差异场景 exit 0**（strong=6）、**正常场景 exit 0**（strong=11，含 pid/port/version 逐项 MATCH）。
**未产生可见窗口**（启动方式：`Start-Process -WindowStyle Hidden`／inline 重定向）。**未复核项见文末。**

## ③ 差集口径（lead 要求显式写清）

**同一个 `daemonSnapshot()` + 两个选择器**：`daemonStatus`（`wsl_status`）是**发现语义**（任何槽位），`explorer.snapshot` 是**所有权语义**（只报 `cfg.daemonPort`）。
⇒ 当且仅当「**配置槽位无守护、别处有守护**」时两者**允许不同**：`snapshot.daemon.running=false` + 别槽进 `others[]`，面板显示 `running:false` 并把别槽列进只读区。
**这是有意的收窄（F33 目的：避免跨实例误停），不是回归。** 其余场景一律逐项一致（已按此实现 `Test-F33Scope()` 并在两场景各跑一次）。

## 逐条证据

| 条目 | 结论 | 证据（原始输出） |
|---|---|---|
| **F32** 路由残留 | **PASS** | `out-51-f32-f15.txt`：`afterFirstInject=1`、`afterSecondInject=1`（第二次 duplicate 未冒出：`secondInjectEscaped=null`）、**`afterDispose=0`**；对照（复刻改前 `catch` 无条件下 `removeRoute=null`）**`control_oldBug_afterDispose=1`** ⇒ 有区分力 |
| **F33** 只报配置槽位 | **PASS** | `out-52-snapshot-f33.json`（`running:false` + `others=[8731,8962,8972]` 各带 `非本槽位（configured daemonPort=8932）；未复用、未打扰`）、`out-52-status-f33.txt`（同一刻 `wsl_status` 报 `slot=8731` = **允许的差异**）、面板 DOM（`daemon 未运行` + 只读区「其它槽位的守护」）、`out-56-diff-f33.json`（③ exit 0, strong=6） |
| **F33** 动作面非配置槽位 | **PASS** | `out-53-f33-action.txt`：`ensure/stop slot=8962` → **400** `{"ok":false,"error":"…slot 8962 不是本插件配置的槽位（8962≠8932）；本插件只操作自己的槽位","code":"E_ARG"}`；`ensure slot=8940` → 400；**无副作用**：8962 队友守护 pid 不变、8940 WSL 侧无监听 |
| 错误码矩阵 | **PASS** | `out-53-f33-action.txt`：`action=__bogus__`→400 E_ARG；未知/`constructor`/空 method→400；非法 JSON→400 |
| **F15** inject 永不就绪 | **PASS** | `out-51-f32-f15.err` 原文：`remote-wsl(explorer): webServer 未就绪 ⇒ explorer.* HTTP 路由未注册（方法表仍可用）`（`DSH_REMOTE_WSL_INJECT_WARN_MS=300`） |
| **F14b** ensure 失败→503 | **PASS** | `out-63-f14b-verdict.txt`：WSL 侧占住 8932–8948 ⇒ `openSession` → **503 `E_UNAVAILABLE`**（body 含 `试过端口 8932, 8933, 8934 …` + daemon.log 尾部 `FATAL: WSL 侧 8934..8943 全被占用`）；释放后阳性对照 → **200** |
| **F31** launch-stderr 0600 | **PASS** | `out-54-f31-verdict.txt`：起始 600（队友已生效一次）→ 故意 `chmod 644` → 经 route `ensure` 起守护 → **600** |
| **F34** 首挂载不误报 | **PASS** | 注入采样器（`navigate_page` initScript，80ms 粒度）记下首挂载 2 帧：① `正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…` ② 数据就绪；**无**「已撤下/失败」帧 |
| **F25** fixPin `ok:false` | **PASS** | 注入桩（snapshot 报 `drift.drifted=true` ⇒ 面板渲染 `drift ⚠ 修 pin`；fixPin 返回 `{ok:false}`）⇒ 点击后 note **`role=alert`**：`失败：注入桩：fix pin 失败（F25 用）` + **`重试`** 按钮，12 次采样持续存在 |
| **F35** 路径 LTR | **PASS** | `.dsh-rw-workspace-path`：`direction=ltr`、`unicode-bidi=plaintext`（原始 `.dsh-rw-raw` 是 `ltr`/`normal`） |
| **F36** 主行动反馈 | **PASS** | `刷新`：按钮文案 `刷新→刷新中…→刷新`（反馈可见）；`在新会话中打开`：note `role=status` 出现并**跨 14 次采样（约 2.5s）持续存在**，其间自触发的 `刷新中…` 未清空它 |
| ① 侧栏出现（加法） | **PASS** | rail `[插件, 远程资源管理器]`（选中 `aria-current=page`）；无插件基线 8934 boot graph 命中 **0**（`out-55-additivity-t10.txt`） |
| ② 点图标切面板+树 | **PASS** | `.dsh-rw-root` 出现、`panelTitle=远程资源管理器`、树 `▾ debian-u8-1 … 📁 g /home/g`（`out-60-panel-extract-normal.json`） |
| ③ 正常场景 | **PASS** | `out-61-diff-normal.json`：**exit 0, strong=11**，`distros/daemon.pid/daemon.port/daemon.version/status.internal.*/f33.snapshot-scope` 全 MATCH |
| ⑤ 切走/切回不杀守护 | **PASS** | DOM：切走 → 面板**卸载**（`ourPanel=false`），切回 → **重挂**且状态条 `pid 979116`；`out-62-daemon-invariance.json`：pid/端口/version/keys/pgrepMine/监听全 MATCH ⇒ **exit 0** |

## 故意红（3 条，均未改被验对象）

| # | 手法 | 期望 | 实测 |
|---|---|---|---|
| R-T10-a | 把 route 快照里的 `others[]` 掏空（封装文件内改） | `f33.snapshot-scope` 变红 | **exit 1**（`f33.snapshot-scope MISMATCH: snapshot running=False others=[]`）`out-57-*` |
| R-T10-b | 让 `snapshot.daemon` 把别槽当自己（`running=true slot=8731`） | 变红 | **exit 1**（`f33.snapshot-scope MISMATCH` + 槽位闸 MISMATCH）`out-58-*` |
| R-T10-c | F32「改前形态」对照（`catch` 内无条件清 `removeRoute`） | 残留 1 | `control_oldBug_afterDispose=1`（修好的实现为 0）`out-51-f32-f15.txt` |

另有自测矩阵作为常规区分力护栏：`diff-panel-vs-status -SelfTest` **A–G = 0/1/1/3/0/1 + E/E2 完整性全 PASS**；`daemon-invariance -SelfTest` 0/1 + 解析器 7/7。

## 我方自查抓到的 4 个 harness 缺陷（都已修，并留档）

1. **F15 断言正则写错**：实现文案是「webServer 未就绪 ⇒ …」，我第一版按「inject 未触发/降级」判 ⇒ **把已修好的行为判成 RED**；已按实际文案修正后 PASS。
2. **③ 只认 route 原始响应**、不认我自己的封装 `{bodyJson:…}` ⇒ F33 被判「形状不符 ⇒ unknown」；已兼容两种形状。
3. **F33 分支漏了 `-not $slotOk`** ⇒ 正常场景里 `daemon.pid/port/version` 被**静默跳过**（③ 核心比对丢项）；已修，并新增自测 **E2**（F33 正常场景必须含这三项）防回归。
4. **F14b 三轮才构造成**：#1 8932 仍被上一轮 `openSession` 起的守护占用（python EADDRINUSE）；#2 只占 3 个 ⇒ 插件逃到 8935；#3 占 5 个 ⇒ 逃到 8937；#4 占 8992–8948（17 个）才压住。**过程中的错误结论文件已如实重写**，不保留假结论。

## 可见窗口自查（lead 硬规矩，用户投诉后）

**未产生可见窗口。** 启动方式：
- 宿主/外部进程：`Start-Process -WindowStyle Hidden`（`boot-testhost.ps1:114`、`daemon-invariance.ps1:62`；原先无 `-WindowStyle`／`-NoNewWindow` 的写法已全部改掉，`Get-ChildItem *.ps1 | Select-String Start-Process` 现在只剩这 2 处且都带 Hidden）；
- `wsl.exe`/`node` 探针：留在**当前后台 pwsh** inline 执行 + stdout/stderr 重定向到文件；
- 守护一律走插件自身路径（`explorer.daemon{ensure}`），不用 `Start-Process wsl.exe` 起 `launch.sh`。

**处置**：16:27 那次未带 Hidden 起的宿主（pid 23188/30756）已用 `taskkill /T /F` **只针对我记录的 pid** 连子树收掉；`out-59-no-visible-window.txt` 与收尾枚举均确认：现存可见窗口中**没有任何属于我的 `wsl.exe`/`cmd`/`conhost` 标题**（剩余的 `WindowsTerminal pid 36752` 是**用户自己的**终端，标题已变为 `D:\U8\…\U8Cloud-Server`；另有 VS Code/Cursor/Chrome/Edge/DeepSeek 等用户程序）。**未关任何用户窗口。**

## 收尾清理（前后对照）

- 停：8932 守护（route stop）、宿主 8931/8934（pid 记录 + 子树）；WSL 侧终检：`daemon.ts --port 8932` **无**、`launch.8932.sh` 包装层 **无**、`t10-occupy` 残留 **无**、`/tmp/t10-occupy*` **无**、`daemon.8932.json` 元数据 **无**。
- 端口终检：8931/8932/8933/8934/8935/8936/8937 **全部 = 0**。
- 现场其他槽位守护（8731/8962/8972 等）**未纳入比对、未打扰**；活宿主 `19387` pid **47564** 全程未变。
- 未跑任何 `npm/pnpm install`；未碰 `reliability/`/`stability/`/`usability/` 子目录。

## 未复核项（不许当通过）

1. **`keys > 0` / 多 key 形态**：本次守护 `keys=0`（空集弱证据）⇒ key 明细渲染未复核。
2. **`webHosts` 非空**：面板与 `wsl_status` 皆空 ⇒ 未复核。
3. **desktop（Electron）宿主**：只在 `dsh web` 实例验证；Electron 壳的同源 fetch/IPC 差异未复核。
4. **F33 面板 `others[]` 与快照的同时刻一致性**：面板那一帧只列了 `8731/8972`，而我 16:38 的 route 快照有 3 个（含 `8962`）——两者是**不同时刻**的取样，未做同时刻对照；不作为缺陷，但**未复核**。
5. **F25 是桩级注入**（`ok:false` 由 fetch 桩返回），非真实远端失败路径；真实 `fixPin` 失败（E_UNAVAILABLE）的渲染未复核（真实调用会改 pin，故未跑）。
6. **F14b 用端口占用逼出 ensure 失败**，非自然故障（如 WSL 侧 dsh 缺失）；且观察到「Windows 侧试 8932/8933/8934、WSL 侧扫到 8943」的回退深度与 `daemonPortTries=3` 的名义值不一致 ⇒ 该回退语义**未复核**（属实现行为，不是本次修复项）。
7. **F35 只验了路径那一个元素**（`.dsh-rw-workspace-path`）；面板其它含路径/半角串的元素未逐个验。
8. **F34 的采样粒度 80ms**：不能排除存在更短命的中间帧；只证明「未观察到已撤下/失败帧」。
9. **像素级截图未落盘**（chrome-devtools-mcp 的 `filePath` 只能写它自己的 workspace root，我拒绝把产物写到本目录外）⇒ 视觉证据用 DOM 抽取 + 计算样式替代。
10. **`client.<name>.js` chunk 的服务端 URL 形态**仍未探明（`/plugins/??dsh-remote-wsl/client.<name>.js&rev=` 为 404）；① 的 `order`/`id` 仍只在磁盘静态源码确认（沿用 T4 未复核项 2）。
