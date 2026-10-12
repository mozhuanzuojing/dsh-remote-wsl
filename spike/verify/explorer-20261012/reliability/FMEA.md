# FMEA —— P0 远程资源管理器（数据通道 + 守护）

- **日期**：2026-10-12 ｜ **角色**：`reliability-keeper`（task-6）｜ **状态**：**准备稿**（task-6 仍被 task-2/task-3 阻塞，未开工、未做注入实验）
- **被验对象（只读）**：`D:\project\dsh1\vendor\dsh-remote-wsl`（`src/*.ts` + `client/**`）
- **写边界**：本目录 `spike/verify/explorer-20261012/reliability/`
- **端口段**：**8971–8980**（本报告专用；与 p0-verify 的 8931–8960 不重叠）
- **绝对禁区**：`19387`（用户在用宿主，实测 pid **47564**）、`9910`（proxy）；不重启用户宿主、不全局 `pkill`、不删他人文件

## 0. 判据与来源

**覆盖状态四态**（禁止把 ❓ 写成 ✅）：

| 记号 | 含义 |
|---|---|
| ✅ | 实现里已被覆盖 —— 给 `文件:行` |
| ⚠️ | 部分覆盖（有检测但缺一环：无降级/无提示/靠外部） |
| ❌ | 未覆盖 —— 明确标注 |
| ❓ | **未实测**，准备期只从代码读到，必须由下面某个实验证明后才允许改判 |

**依据来源（准备期实读，非推测）**：

| 来源 | 位置 | 取到的事实 |
|---|---|---|
| 设计稿 | `docs/remote-explorer-design.md` §4(a-e)、§6、§8 | 五条安全硬要求；P0 验收；纪律（同源/不全局副作用/不两套数） |
| host 数据面 | `src/explorer.ts:184-240`（snapshot）、`:255-327`（openSession）、`:337-380`（daemon）、`:387-414`（fixPin） | 面板全部数字的唯一来源；daemon 段来自 `daemonSnapshot()` |
| host 传输层 | `src/explorer.ts:437-452`（`isSameOrigin`）、`:486-544`（adapter）、`:555-586`（`registerExplorer`） | 403/400/405/415/500 的判定顺序与位置 |
| client 传输层 | `client/client.api.js:78-115` | 三类错误 `transport`/`protocol`/`host`；非 JSON 不当崩溃 |
| client 面板 | `client/client.panel.js:62-79`、`:137-156`、`:106-112`、`:366-393`、`:452` | 加载/错误/空态；**状态条不随错误态收起**（见 F22/F23） |
| client 入口 | `client/index.js:127-142`、`:155-168`、`:196-218`、`:221-240` | chunk 加载失败有兜底 UI；两个槽注册 |
| 官方 WebServer | `@deepseek-ai/dsh-host-webserver/lib/index.js:177-184`（重复路由 **throw**）｜`README.md:39,45,49,55` | **"同一张表内重复路径会抛错"**；`host` 仅 `127.0.0.1`/`0.0.0.0`；**服务器自身不携带任何来源策略/鉴权**；**handler 抛错 → 400 或断连，绝不退出进程**；无 fallback 时 404（shipped web 由 SPA 占该席位） |
| 守护端口回退 | `src/daemon.ts:589-601` | `EADDRINUSE` → `+1` 重试 `PORT_TRIES` 次；全占 → `throw` |
| 守护复用/清理 | `src/daemon-client.ts:494-526`、`:635-660` | 槽位被占时复用/提示；`stop` 默认只停自己槽位；`all=true` 只存在于 agent 面工具（`:674`） |
| 默认端口 | `src/index.ts:80-120` | `webPort:3082`、`daemonPort:8731`、`daemonPortTries:3`、`proxyPort:9910` |

**严重度**：`S1` 进程/数据损坏 ｜ `S2` 功能不可用 ｜ `S3` **误导显示**（面板说了不真的事） ｜ `S4` 体验/可诊断性。

---

## 1. FMEA 主表

> 「检测手段」= 出故障时**怎么知道**；「影响半径」= 坏了会连带谁；「缓解/降级」= 现在的行为（不是我希望的行为）。
> **覆盖状态里的行号是准备期读到的位置；标 ❓ 的必须在 INJECTION-PLAN 的实验里实测后才改判。**

| ID | 故障模式 | 触发方式（可注入） | 检测手段 | 影响半径 | 缓解/降级 | 覆盖状态 | S |
|---|---|---|---|---|---|---|---|
| **F1** | 配置里的发行版**不存在**（被卸载/改名） | `config.distro` 指向不存在的名字 | 面板：树里找不到该名字的 distro 行；`snapshot.target.distro` 仍是配置值 | 仅本插件面板；agent 面 `wsl_status` 同样 | 面板显示"当前目标"徽标与收藏路径（来自配置回落）——**不崩**，但**仍断言了一个未验证的目标**（`explorer.ts:142-145,234` 无"该 distro 是否存在"校验） | ⚠️ 无存在性校验（`explorer.ts:142-145`）；`distroFlags()` 对未知名两个标志都留 false（`:122-131`）⇒ 界面不会说"在跑" | S3 |
| **F2** | 发行版存在但**被关**（`Stopped`） | `wsl --terminate debian-u8-1`；或系统重启后未起 | 面板行徽标 `已停止`（`client.panel.js:195`）；`reachable` 定义=此刻 `STATE=Running`（`explorer.ts:112-132,190`） | 收藏路径仍在，但 `openSession`/守护必失败 | **零副作用探活**：不用 `wsl -d <name> -- true`（那会把发行版拉起来，`explorer.ts:104-109` 注释）⇒ 检测准确但要靠用户自己启动 | ✅ 检测已覆盖（`explorer.ts:112-132`）；无"一键启动发行版"降级（设计未要求） | S2 |
| **F3** | **WSL 整体不可用**（`wsl.exe` 缺失 / 功能关闭 / VM 起不来） | 换台没装 WSL 的机器 | `spawnSync` 抛 `ENOENT` → `try/catch` 吞掉 → 空标志（`explorer.ts:115-120`）；`listDistros()` 返回空 → 面板**空态**："没有发现 WSL 发行版（… WSL 未安装）"（`client.panel.js:159-162`） | 面板空态；agent 面 6 个工具独立失败 | 空态文案指名"WSL 未安装"⇒ 可读，不是白屏 | ❓ `distroFlags` 侧已覆盖（`explorer.ts:115-120`）；**但 `daemonSnapshot()` 在无 `wsl.exe` 时是否抛错未实测** ⇒ 若抛，走 F14 的 500 路径 | S2 |
| **F4** | **守护死掉**（被杀/崩溃/`daemonIdleMs`+linger 到期） | `explorer.daemon{action:'stop',slot:8972}`（**只停自己槽位**）或 kill 该 pid | 面板状态条 `daemon 未运行` + 点 `启动守护`；快照 `daemon.running=false`（`explorer.ts:215-219`） | 只影响依赖守护的动作（`openSession`/`wsl_agent`）；**面板读快照仍正常** | 提供 `ensure` 按钮（幂等，`explorer.ts:346-363`）；不自动重启（不产生静默副作用） | ✅ 检测+降级已覆盖（`explorer.ts:198-219`、`client.panel.js:383-393`）；**"界面变化是否可读、是否有陈旧 pid" 由 INJ-A 实测** | S2 |
| **F5** | 守护**失联但元数据还在**（进程没了、`daemon.<slot>.json` 残留） | kill -9 守护进程（不删元数据） | `daemonSnapshot()` 把记录分入 `live`/`dead`，`live` 空 ⇒ 面板 `daemon 未运行`；`orphans` 计数（`explorer.ts:213,218`） | 面板不显示幽灵 pid（只看 `live`） | `live[0]` 口径与 `wsl_status` 一致（`explorer.ts:195-201`）⇒ 不会两套数 | ✅ 覆盖（`daemon-client.ts:743-764` 的 `live/dead/orphans` 分流） | S3 |
| **F6** | **host web 端口被别进程占**（8971） | 先占住 8971 再 `dsh … web --port 8971` | **启动即失败**：`listen` 失败以 bind 诊断 **reject 插件初始化**（官方 README:55） | 整个 Web GUI 起不来（不只本插件） | 无（这是平台层，不是本插件能降级的）——但**失败是响亮的**，不是静默 | ❓ 由 INJ-D 实测"是响亮失败还是半死" | S2 |
| **F7** | **WSL 侧守护槽位端口被占**（8972） | 在 WSL/Windows 占住 8972 后 `ensure`（mirrored 网络命名空间共享） | 守护日志 `端口 8972 在 WSL 侧被占（EADDRINUSE）⇒ 改用 8973`；`wsl_status` 的 `actualPort`/`slot≠port` 可见；`daemon-client` 写 `notes`（`:499`） | 守护仍可用（换端口）；**但 `slot`（8972）与 `actualPort`（8973）不再相等** | 自动 `+1` 重试（`daemon.ts:589-601`）；面板状态条显示 `slot`，`port` 只在快照里（`explorer.ts:205-210` 的加法字段） | ✅ 降级已覆盖（`daemon.ts:589-600`）；⚠️ 面板没把 `slot≠port` 显式说出来（快照有 `port`，状态条只显示 slot —— `client.panel.js:380`） | S4 |
| **F8** | 连续 `daemonPortTries` 个端口**全被占**（8972–8974） | 占住 3 个端口后 `ensure` | 守护 `throw`：`WSL 侧 8972..8974 全被占用`（`daemon.ts:599`）→ `ensureDaemon` 失败 → `explorer.daemon` 抛 → HTTP **500** + message → 面板动作条 `失败：…`（`client.panel.js:276-289`） | 只影响守护动作；快照仍可读（`running:false`） | 动作条可读错误 + 可重试；`ensureDaemon` 的 `r.error` 原话透出（`explorer.ts:350`） | ❓ 代码路径清楚（`explorer.ts:350`→`api` 500→面板 action error），**待 INJ-D 实测**（含"是否把 `notes` 里的被占端口说清楚"） | S2 |
| **F9** | **API 403**（非同源 / `Origin` 缺失 / `Host` 与 `Origin` 不匹配） | (a) 无 `Origin`；(b) `Origin: http://evil.example`；(c) `Sec-Fetch-Site: cross-site`；(d) 经反代/代理后 Host≠Origin | 响应 `403 {"ok":false,"error":"跨站请求被拒（Origin/Host 不同源）"}`（`explorer.ts:494-497`）；面板侧若 403 则错误盒显示 host 原话（`client.panel.js:137-156`） | **只影响 explorer 路由**；6 个 agent 工具不受影响；**且闸门在任何方法执行之前**（`explorer.ts:493`） | 设计意图：这是**唯一**闸门（官方 README:39 明说服务器自身无来源策略） | ✅ 实现已覆盖（`explorer.ts:437-452,494-497`）；❓ **"闸门是否真的拦住了副作用"待 INJ-B 用 stop 探针实测**；**桌面 Electron / 反代场景是否因 `Origin` 缺失而必然 403 —— 未实测（F26/F27）** | S2 |
| **F10** | **API 400**（未知方法 / 非法 JSON / method 为空） | `method:"explorer.nope"`；body 非 JSON | `400 {"ok":false,"error":"未知方法 …","methods":[…]}`（`explorer.ts:527-532`）或"请求体不是合法 JSON"（`:518-525`） | 仅该请求 | 错误里回白名单（便于自诊断）；仅回 message、不回显请求体（(e)） | ✅ 覆盖（白名单 `EXPLORER_METHODS.includes` 而非属性查找） | S4 |
| **F11** | **API 404 / 200-非JSON**（路径写错：`/remote-wsl/api/` 尾斜杠） | `POST /remote-wsl/api/` | 精确表未命中 → 前缀表未命中 → **SPA fallback**（官方 README:45,49）⇒ 很可能 **200 + index.html** | 仅该请求；**这是最容易让人误判"接口通了"的形态** | client 侧 `readBody` 解析失败 → `protocol` 错误 + 附响应正文前 400 字（`client.api.js:96-103`）⇒ 可读，不会把 HTML 当 JSON 用 | ✅ client 侧已覆盖（`client.api.js:96-103`）；❓ **尾斜杠的真实状态码待 INJ-B 实测**（若实为 200-HTML，比 404 更值得写进报告） | S3 |
| **F12** | **API 405**（用 `PUT/DELETE`） | `PUT /remote-wsl/api`（同源） | `405 {"ok":false,"error":"只接受 GET…与 POST…；收到 PUT"}`（`explorer.ts:504-507`） | 仅该请求 | 明确动词提示 | ✅ 覆盖（`explorer.ts:504-507`） | S4 |
| **F13** | **API 415**（`content-type` 不是 JSON） | `POST` + `content-type: text/plain`（同源） | `415`（`explorer.ts:510-514`）——**设计稿 §4(c) 只写了 405，415 是实现的加法** | 仅该请求 | 提示收到的类型 | ✅ 覆盖；**lead 已裁决（2026-10-12）：不算越界，且是更准的实现** —— 设计稿口径已改为「非 POST ⇒ 405；POST 但 `content-type` 非 `application/json` ⇒ 415」，T4 的 B 组验收同步更新 | S4 |
| **F14** | **API 500**（handler 抛错：如 `daemonSnapshot` 在 WSL 不可用时抛、`fixPin` 写失败） | 断掉 WSL 后打 `explorer.snapshot` | `500 {"ok":false,"error":<message>}`（`explorer.ts:534-540`）；官方层还有兜底：handler 抛错→400 或断连、**绝不退出进程**（README:55） | 面板：错误盒（可读）+ **但状态条同时断言"daemon 未运行"（F22）** | 错误只回 message；面板给"重试" | ⚠️ 错误可见性覆盖（`explorer.ts:534-540`）；**误导副作用见 F22/F23（❌）** | S3 |
| **F15** | **`webServer` 未注入**（`ctx.inject(['webServer'])` 条件未触发；headless profile；服务加载顺序） | 在**没有** `dsh-web-app` 的组合里挂本插件 | stderr 一行 `remote-wsl(explorer): webServer 服务不可用 ⇒ explorer.* 的 HTTP 路由未注册（方法表仍可用）`（`explorer.ts:562-565`） | **本插件 6 个 agent 工具与数据面方法表不受影响**；面板侧 fetch 必然失败（走 F21/F9 的读错误） | 明确降级 + 只打日志；`ctx.inject` 本身缺失也有一行（`:574-576`） | ✅ 已覆盖（`explorer.ts:555-586`）；❓ **"插件其余部分是否真的照常激活"待 INJ-C 用 stub 实测**（真实 Cordis 下的时序差异列入未复核） | S2 |
| **F16** | **route 重复注册 throw** —— `(kind,path)` 冲突 | host 内**同一插件被装载两次**（bundle 重复 / 两个 profile 层都加 `dsh-remote-wsl`，id 不同但包名相同） | 官方：`throw new Error('webserver: duplicate exact route "/remote-wsl/api"')`（`lib/index.js:177-184`） | **影响半径不明且可能很大**：throw 发生在 `ctx.inject` 回调内（`explorer.ts:560`）、**无 try/catch**（`:566`）⇒ 可能 reject 该插件的激活 ⇒ **连 6 个 agent 工具一起没了**；且 `removeRoute` 尚未赋值（`:567`）⇒ 一旦 Cordis 视为已清理，**先注册的那条路由不会被释放**（半活状态） | ❌ **实现里没有任何处理**（无 try/catch、无幂等登记、无"已被占则复用"分支） | ❌ **未覆盖**（`explorer.ts:559-573`）；❓ 实际后果（是否整体卸载、路由是否残留）**待 INJ-D 实测** —— 我判这是本次**头号单点故障** | S1 |
| **F17** | **浏览器离线 / 断网**（或 host 进程被收走） | 断网后点刷新/打开面板 | `fetch` reject → `ExplorerApiError(kind='transport')`（`client.api.js:87-95`）→ 错误盒显示"无法连接 host 侧 explorer 路由 …"+`重试`（`client.panel.js:137-156`） | 只影响面板取数 | 可读错误 + 重试按钮；不白屏 | ✅ 覆盖（`client.api.js:87-95` + `client.panel.js:137-156`）；⚠️ 同时暴露 F22/F23 的负事实问题 | S3 |
| **F18** | **浏览器刷新 / 面板重挂载** | F5 刷新页面 | 重新挂载 → `useEffect(load)` 拉一次快照（`client.panel.js:82`）；无本地缓存 ⇒ 不会拿旧值 | 正常 | 刷新即自愈；`lastLoadedAt` 重置（`:452`） | ✅ 覆盖；**但刷新后若失败，落 F22** | S4 |
| **F19** | **两个面板实例并存**（两个标签页 / 面板被挂两次） | 两个浏览器标签都开面板；或 `main` 槽被挂两次 | 各自独立 React state；`slot 快照 <时间>` 可辨（`client.panel.js:452`） | 只读请求 ×2；一侧点 `重启/停止` 后**另一侧显示陈旧值直到刷新** | 无协调机制（也不需要读侧协调）；有"快照时间"作为新鲜度线索 | ⚠️ 读侧可接受；⚠️ **动作侧无"我改过了"广播** ⇒ 陈旧值只能靠手动刷新（`client.panel.js:452` 是唯一线索）；❓ 同一 host 内**双挂载是否触发 slot 注册冲突未实测**（`client/index.js:221-240`） | S3 |
| **F20** | 插件**被加载两次** | 同 F16 的触发 | 同 F16 | 同 F16 | 无 | ❌ 未覆盖（同 F16；两行同一根因，合并处置） | S1 |
| **F21** | **client chunk 加载失败**（`dsh.client` 未声明 / bundle 路由 404 / `exports["./client"]` 坏） | 在 `client/**` 存在前就声明 `dsh.client`（设计 §8.3 明令禁） | 官方：*missing bundle fails activation loudly*；页面侧 chunk reject → `boot.error` → 图标位 title 与面板体"面板模块加载失败"+message（`client/index.js:155-168,183-218`） | 面板整体不可用；**不影响 host 半 6 个工具** | 有兜底 UI（**不是白屏**），但那是"面板内错误"而非"侧栏加载失败" | ✅ 兜底已覆盖（`client/index.js:196-218`）；⚠️ 图标本身是空 span（`:186-190`，只有 title）⇒ 侧栏上看不见"坏了" | S2 |
| **F22** | **读失败时状态条断言"daemon 未运行"**（负事实误导） | 让 `explorer.snapshot` 失败（断网 / 500 / 403） | 面板上半出现"读取远程资源失败"，**同时**底部状态条显示 `daemon 未运行` + `启动守护` 按钮 | 用户会以为守护真的没跑 ⇒ 可能误点"启动守护"（幂等，`ensureDaemon` 会复用，实际害处有限，但**陈述是假的**） | **无**：`state.status==='error'` 时 `snapshot=null`（`client.panel.js:73`），footer 用兜底 `{running:false,keys:[]}`（`:111`）**无条件渲染**（`:366-393`），不受错误态约束 | ❌ **未覆盖** —— 错误态必须"不显示任何未确认的负事实"（应显示"状态未知"）；**待 INJ-D 用页面内 fetch 拦截实测**（`依赖 p0-verify 的 browser/perturb-snapshot.init.js` 手法） | S3 |
| **F23** | **读失败时 `lastLoadedAt` 陈旧**（静默陈旧值） | 同上 | 错误盒旁仍显示 `快照 11:20:33`（上一次成功时间） | 用户可能把上一轮的数字当成当前值 | **无**：错误分支不清 `lastLoadedAt`（`client.panel.js:73` vs `:452`） | ❌ 未覆盖（同上，随 F22 一起实测） | S3 |
| **F24** | **drift**（desktop 版本 ≠ WSL pin） | 桌面升级后 | 状态条 `drift ⚠ desktop=… pin=…` + `修 pin`（`client.panel.js:421-437`）；`explorer.ts:221-223` | 只影响版本一致性；不自动杀守护（§5 语义） | 默认只告警，点击才写 pin；`fixPin` 明确"守护未被动过"（`explorer.ts:410-412`） | ✅ 覆盖（告警 + 显式修复；与 `wsl_sync_version` 同一实现） | S4 |
| **F25** | **state dir / token 不可写**（drvfs 权限、`~/.dsh` 只读） | 把 `~/.dsh/remote-wsl` 设只读 | `explorer.fixPin` 回 `ok:false`+`error`（`explorer.ts:390-397,410-413`）；守护起不来 → `ensure` 失败 → 500 | 守护/收藏路径功能不可用 | `fixPin` **不抛**而是返回 `{ok:false}`（面板 `describe` 会把它当成功文案渲染 —— ⚠️ 见下） | ⚠️ **覆盖不完整**：`run()` 只把 **抛错** 当失败（`client.panel.js:99-102`），`fixPin` 返回 `ok:false` 时面板会显示"已请求修复 version pin"这种**成功语气**（`:432-433`）⇒ 建议 UI 检查 `result.ok` | S3 |
| **F26** | 经**反代/代理**（`proxyPort:9910`）访问 GUI ⇒ `Host` ≠ `Origin` | 走代理访问 | 403（`explorer.ts:451`） | 面板全废（读不到数），且错误停在面板上 | **无**（未识别"经代理"这一情形；错误文案只说"跨站请求被拒"，可能把用户引向错误方向） | ❌ 未覆盖（无探测/无提示）；设计稿 §4(a) 也没考虑代理形态 ⇒ 列入未复核 | S2 |
| **F27** | **桌面 Electron（`file://` + IPC 桥）渲染面** —— 官方 README:12 说它 *"loads dist over `file://` and carries fetch over an IPC bridge"*；但**"桌面壳是否消费 web client 半"本身从未核实** | 在桌面壳里开面板（**本任务不做**） | 无（无可接受取证手段） | **P0 的目标面是 Web 前端**：`dsh.client` 经 `clientModules` 扫描，官方原文 *"The web plugin table service"*；用户当前用的 `127.0.0.1:19387` 就是 Web GUI，**浏览器对 POST 必带 `Origin`** ⇒ 同源闸门成立 | **不适用**；**lead 裁决（2026-10-12）**：未来若真要支持桌面壳，须**另立同源口径**（例如允许 `Origin: null` + 依赖 loopback/token），**不得**为了它直接放宽 web 面闸门 | ❓ **未复核**（禁止重启活宿主取证）；**不在 P0 目标面内** | — |
| **F28** | `复制路径` 在**非 loopback** 访问下失败（`navigator.clipboard` 不可用） | 用 `host: 0.0.0.0` 从另一台机访问 | 动作条可读错误（`client.panel.js:249` 主动 reject） | 仅复制功能 | 显式 reject + 可读错误（不是静默失败） | ✅ 覆盖（`client.panel.js:246-250`） | S4 |
| **F29** | 收藏路径 **UNC 读失败**（`\\wsl.localhost\...` 不可达） | 关掉发行版后读 `explorer.json` | `readFileSync` 抛 → `catch` → **回落到配置 `cwd` 一条**（`explorer.ts:147-151`） | 面板会显示 1 条"默认"路径而不是 0 条 | 有回落（避免空树）——**但这会让人以为收藏还在**；语义已写进代码注释（`:139-140`）并标注"等 lead/客户端确认" | ⚠️ 有降级但**区分不出"读失败"与"真的只有 1 条"**（没有 `warnings` 字段） | S3 |
| **F30** | `snapshot` 的 `daemon.port` 与 `slot` 不一致时面板只显示 slot | 同 F7 | 快照 JSON 两个都在（`explorer.ts:205-210`）；状态条只显示 slot（`client.panel.js:380`） | 用户按 slot 数去连端口会连错 | 底部"原始 snapshot"折叠区可自查（`:293-302`） | ⚠️ 部分覆盖（原始 JSON 可自查） | S4 |
| **F31** | 状态目录内**文件权限不一致**（`launch-stderr.log` **0644**；同目录 `daemon.<slot>.json` / `.token` / `daemon.log` 均 **0600**） | `ls -la ~/.dsh/remote-wsl/`（实测 2026-10-12 11:46:38） | 该文件可被同机其他用户读取；内容为守护启动 stderr | 无（不影响功能） | 无 | ⚠️ 与"元数据/日志 0600"的纪律不一致；**未核实该文件是否可能含 env/路径等敏感串** ⇒ 列入未复核 | S4 |

---

## 2. 单点故障清单（SPOF，逐条给覆盖状态）

| # | 单点 | 一旦失效 | 覆盖状态 |
|---|---|---|---|
| SP1 | **`/remote-wsl/api` 的 `isSameOrigin` 闸门**（唯一闸门，官方层无来源策略） | 面板**全部**数据与动作不可用 | ✅ 实现在（`explorer.ts:437-452`）；❌ **但过严的失败模式（F26/F27）与过宽的风险（未实测绕过）都没验** ⇒ 待 INJ-B |
| SP2 | **`webServer.register` 的幂等性**（F16/F20） | 重复装载 ⇒ 可能**整体卸载插件**（含 6 个 agent 工具）+ 路由残留 | ❌ **未覆盖**（`explorer.ts:559-573` 无 try/catch）—— 头号 |
| SP3 | **`daemonSnapshot()` 是面板 daemon 段的唯一真相源** | 它抛错 ⇒ 整个 `explorer.snapshot` 500 ⇒ 面板连"发行版列表"都看不到（**一个分段的故障拖垮整张面板**） | ⚠️ 无分段容错（`explorer.ts:198` 在 `snapshot()` 主体里 await，无 try/catch；设计稿 §4 要求"单一真相源"但也导致此耦合） |
| SP4 | **client bundle 的加载**（`dsh.client` 声明 ↔ `client/**` 存在性） | 面板全废（host 半仍活） | ✅ 有兜底 UI（`client/index.js:196-218`）；⚠️ 侧栏图标位几乎看不出坏了（`:186-190`） |
| SP5 | **`listDistros()`（`wsl -l -q`）** | 面板树空 ⇒ 空态（可读） | ✅ 空态覆盖（`client.panel.js:159-162`） |
| SP6 | **WSL 网络模式**（原记 mirrored，**实测 = NAT**） | 原判"Windows 侧占端口会连带挡住 WSL 守护"**不成立**：NAT 下两侧网络命名空间独立 | ✅ 守护仍有 `+1` 回退（`daemon.ts:589-601`）；**已实测纠正**：`wslinfo --networking-mode` = **`nat`**，`.wslconfig` 含 `localhostForwarding=true` / `autoProxy=true` / `firewall=false`（见 [out-00-prep-findings.txt](./out-00-prep-findings.txt) F-1）⇒ 占用注入**必须** `-Where wsl`；Windows 侧占用降为**阴性对照** |
| SP7 | **`removeRoute` 的 dispose 链** | 若注册失败则 `dispose()` 是 no-op（`explorer.ts:567,583-585`）⇒ 路由无主 | ❌ 随 SP2 一起（未覆盖） |
| SP8 | **面板状态条不区分"未确认"与"未运行"**（F22） | 用户按假状态行动 | ❌ 未覆盖 |

---

## 3. 准备期预判 → 待实验证明的清单（禁止提前写进结论）

| 预判 | 由哪个实验证明 | 若证明成立 |
|---|---|---|
| F16：重复注册 throw 会导致**插件整体卸载**（6 个工具一起没） | INJ-D（双装载 patch） | 从 ❓ 改 ❌，升级为「发布前必修」 |
| F22/F23：错误态下状态条断言 `daemon 未运行` + 陈旧时间戳 | INJ-D（页面内 fetch 拦截） | 改 ❌（负事实 + 静默陈旧值） |
| F7/F8：被占端口是否**在 UI 上说得清** | INJ-D（占 8972 / 8972-8974） | 决定 S4 是否升 S2 |
| F11：`/remote-wsl/api/` 尾斜杠是否 200-HTML（而非 404） | INJ-B step 9 | 写进报告"最易误判形态" |
| F27：桌面壳是否消费 web client 半 / 其 fetch 是否带 `Origin` | **不设实验**（lead 裁决按未复核处理，禁止重启活宿主） | 即便成立也**不属 P0 目标面**（P0 = Web GUI，浏览器 POST 必带 `Origin`）；将来要支持桌面壳须另立同源口径，**不得**放宽 web 面闸门 |
| F3：`daemonSnapshot()` 在无 `wsl.exe` 时是否抛 | INJ-C 的 stub 变体（或隔离机） | 决定 F3/F14 的严重度 |

---

## 4. 未复核项（准备期就已知的空白，禁止留空/禁止当通过）

1. **桌面壳（Electron / `file://` + IPC 桥）是否消费 web client 半、其 fetch 是否带 `Origin`** ⇒ F27 按 lead 裁决记 ❓未复核、**不设实验**（禁止重启活宿主；且 P0 的目标面是 Web GUI）。
2. **真实 Cordis 下 `ctx.inject` 回调抛错的确切后果**（是否卸载插件、是否只记日志）⇒ INJ-C 用 stub 只能证明"回调内会抛"，证明不了框架行为。
3. **同一 host 内加载两份插件**是否真的可达（bundle 重复是否会被去重 / id 冲突是否更早失败）⇒ INJ-D 用 `--patch` 造，但真实用户场景（profile 手改）未复核。
4. ~~`networkingMode`（mirrored vs NAT）~~ ⇒ **已实测关闭（2026-10-12 11:46:38）：`wslinfo --networking-mode` = `nat`**，`.wslconfig` 含 `localhostForwarding=true`/`autoProxy=true`（见 [out-00-prep-findings.txt](./out-00-prep-findings.txt) F-1）⇒ 占用注入必须 `-Where wsl`；Windows 侧占用降为**阴性对照**。**本轮未做该对照实验**（时间成本）⇒ 对照本身仍记 ❓。
5. `client API 的 fetch 是否带 cookie/凭证` 与 DSH browser-session 的关系（本次不测鉴权，只测同源闸门）。
6. 主题 light/dark 下的错误盒对比度（属可用性，非可靠性）⇒ 留给 task-5。
7. ~~p0-verify 的 `revision.ps1` 锚点是否覆盖 `client/**` 的**全部** chunk 文件~~ ⇒ **已关闭（2026-10-12 **11:42:41** 独立交叉复核：13/13、无遗漏、无幻影条目，见 [out-00-anchor-crosscheck.txt](./out-00-anchor-crosscheck.txt)）**；只引用其 `Preview/Check` 输出、不重复实现锚点逻辑。
8. **新增（交叉复核的副产物）**：准备期末被验对象**仍在漂移**（`src/explorer.ts` 27593→28026 B、`client/client.panel.js` 18285→22666 B）⇒ 本表所有 `文件:行` 引用必须按冻结后的 revision 复核 —— **已在 §6「开工后改判记录」完成**（冻结版 `explorer.ts` **86f29d83…** 29,545 B、`panel.js` **8f5ce575…** 29,111 B）。
9. `GAP-AUDIT.md` / `LICENSE` 既非锚点也非 advisory ⇒ 漂移不会被 `revision.ps1` 察觉。判定：不影响 client 契约，**不建议改脚本**，仅观察。

---

## 5. 维护说明

- 本表在**开工后**按 INJ-A/B/C/D 的原始输出逐条改判；改判必须写"证据文件名"。
- 每条❌/⚠️ 都要在 `REPORT-reliability.md` 的「结论」里按严重度排序出现（S1 优先）。
- 端口只用 8971–8980；任何实验前先复验 `19387` 的 pid 未变（本次基线 **47564**）。

---

## 6. 开工后改判记录（2026-10-12，冻结 revision = `src/explorer.ts` **86f29d83…** 29,545 B / `client/client.panel.js` **8f5ce575…** 29,111 B）

> **§1–§5 的行号与判语基于 11:26–11:36 那版 revision**（`explorer.ts` 26744 B / `panel.js` 18222 B）。
> 写手随后落地了 lead 的两处加固与 T3 的修，**下列行号与结论已按冻结版重算**；未列出的行沿用原文，但**行号一律以本表为准**。
> 证据文件均在 [REPORT-reliability.md](./REPORT-reliability.md) §2；原始输出在 `out-*.json/txt`。

| 行 | 改判后 | 依据（证据文件） |
|---|---|---|
| **F8** | 500 → **503（E_UNAVAILABLE）**；`explorer.ts:502-503,566` 映射、`:373` 抛出 | INJ-B′ `out-B2-summary.json` |
| **F11** | 预判"SPA fallback 200-HTML"**被实测否掉**：尾斜杠 = **405 + 非 JSON** ⇒ 该假绿形态不存在 | `out-B-12-trailing-slash(实测).json` |
| **F14** | 新增错误码映射（E_ARG→400 / E_UNAVAILABLE→503）；**F14b（S4）**：`openSession` 的 ensure 失败仍用裸 `Error`（`explorer.ts:307`）⇒ 走 500，与 `daemon` 的 503 不一致 | INJ-B′ step 13/14 |
| **F15** | **原判错误并更正**：`inject` 永不回调时**没有任何日志**（那行只在"回调触发但服务形状不对"时出现，`explorer.ts:601-604`）⇒ 改判 **❌ 可诊断性缺口** | INJ-C1（`stderr=[]`） |
| **F16/F20/SP2** | ~~❌ 未覆盖~~ → **✅ 加固生效**：`explorer.ts:597-629` try/catch + 降级日志；重复装载不再打倒插件 | INJ-C2 / C5 |
| **F22/F23** | ~~❌ 未覆盖~~ → **✅ 已修**：三态门 `client.panel.js:180-181`、footer `:420-421`、`stamp` `:509-516`、显式"数字已全部撤下" `:225-232` | 冻结版代码 + INJ-A |
| **F25** | **仍 ❌**：`client.panel.js:499` 的 `describe` 忽略 `result` ⇒ `fixPin` 失败也显示成功语气 | 冻结版代码 |
| **F30** | ⚠️ → **✅**：状态条已显示 `:port`（实测 `slot 8972 · :8972`） | `out-A-02-panel-before.json` |
| **SP7** | **❌ 实测命中（F32）** | INJ-C3 |
| **行号迁移** | `distroFlags` 132-152 ｜ `readWorkspaces` 162-186 ｜ `snapshot` 204-260（daemon 218-239）｜ `openSession` 275-349 ｜ `daemonAction` 359-403 ｜ `fixPin` 410-437 ｜ `isSameOrigin` 460-475 ｜ adapter 512-571（403 门 520-523 / GET 526-529 / 405 530-533 / 415 537-540 / 坏 JSON 544-551 / 白名单 553-558 / 错误映射 560-567）｜ `registerExplorer` 582-646（`registerRoute` 597-629） | 冻结版 |

### 6.1 新增故障模式（本轮实测发现，准备期未列）

| ID | 故障模式 | 检测手段 | 影响半径 | 缓解/降级 | 覆盖 | S |
|---|---|---|---|---|---|---|
| **F32** | 同一次 `registerExplorer` 内 inject **二次触发**（HMR / webServer 被重新 provide）⇒ catch 里 `removeRoute = null` 抹掉**先前成功注册**那条路由的 disposer ⇒ **路由残留**（仍持旧闭包） | INJ-C3：`routes before dispose=1`、`after dispose=1` | 卸载/HMR 后路由不被释放；旧闭包继续服务 | **无** | ❌ **未覆盖**（`explorer.ts:608-620`）。建议：catch 里只用**本次**是否注册过来决定清空（局部 `registeredHere` 标志） | S3 |
| **F33** | `snapshot.daemon = live[0]` 报的是"**被发现的**守护"而非"**配置槽位的**守护" ⇒ 配置槽位没起守护时，面板会显示**别人槽位**的 pid/port/version | 实测 `snapshot.daemon={slot:8932,pid:909039}` 而 `configured=8972`；`ensure` 的 `notes` 明说"未复用、未打扰" | **显示层**误导（行为层 daemon-client 已正确隔离） | 无（显示层未区分） | ❌ **显示层未覆盖**（`explorer.ts:218-240`）。**P0 不改**（`src/` 冻结）⇒ P1 候选；验证侧缓解 = INJ-A 的 `configured`+`slot==ExpectedSlot` 前置断言 | S3 |
| **F34** | **初次加载（从未失败）时状态条就宣称「读取失败后已撤下，不显示守护/漂移状态」** | 面板刚打开、fetch 未返回时抽取：同现「正在读取…」与该文案，随后同一请求 200 | 短暂误报（接口慢/偶发超时更明显） | 无 | ❌ **未覆盖**：`client.panel.js:420-421` 的条件 `!factsVisible` 在首挂载（`snapshot===null`）即命中；应收紧为 `status==='error'`。证据 [out-A-01c-initial-load-false-claim.json](./out-A-01c-initial-load-false-claim.json) | S4 |

### 6.2 未复核（不得当通过）

见 [REPORT-reliability.md](./REPORT-reliability.md) §5 的 10 条；其中与 FMEA 直接相关的：**F6**（占 8971 的响亮失败形态）、**F8 全占场景**、**INJ-B step 13**（无 Host ⇒ 连接关闭，UNKNOWN）、**F16/F20 的真实 Cordis 后果**、**F26/F27**、**F31 内容**。
