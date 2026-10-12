# task-7 稳定性矩阵 —— client 半长跑 / 竞态 / 状态漂移 / 边界

- **日期**：2026-10-12 ｜ **作者**：`stability-engineer`（独立于 task-2/task-3 的实现者）
- **被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl` 的 **client 半**（`client/**`）＋ 其数据面（`src/explorer.ts` 的 `POST /remote-wsl/api`）
- **写边界**：`spike/verify/explorer-20261012/stability/**` 是**唯一**写入面（本目录）。被验对象 `src/`、`client/`、`package.json`、`docs/` 一律**只读**。
  - 与 `p0-verify`（task-4）的边界是**父子目录重叠**（advisory）：它声明整棵 `explorer-20261012/`，我声明其下的 `stability/`。双方文件名前缀不同（它 `out-*`/`shot-*` 平铺在本层，我 `out-*` 全在 `stability/` 内），无同名冲突。**我不改它任何文件**。
- **状态**：**准备完成，未开工**（task-7 仍被 task-3 阻塞；且 client 半尚未被 host 编成 bundle，见 §1）

---

## 0. 纪律（先写死，避免事后解释）

| # | 纪律 | 落实方式 |
|---|---|---|
| D1 | **绝不**重启/停止用户正在用的宿主 `127.0.0.1:19387` | `boot-stabhost.ps1` 每步复算该端口 pid；开工基线 **pid=47564**（2026-10-12 11:26 实测），收工必须同值且存活 |
| D2 | 端口只用 **8981–8990** | 开工前逐一 `Get-NetTCPConnection -State Listen` 复验（11:26 实测：8981–8990 全 free；8931 亦 free） |
| D3 | **禁止**全局 `pkill`/`taskkill`、禁止删他人文件 | 只停自己记录在 `<outdir>\out-00-pids.txt` 的 pid；只删自己建的 profile 目录与 `stability/**` |
| D4 | 被验对象只读 | `hash-anchor.ps1 -Mode Write/Check` 前后 SHA256 必须相等；不等 ⇒ 报告判「**稳定性结论无效**」 |
| D5 | 判定必须可复算 | 每个结论 = 原始读数文件 + `analyze-growth.ps1`（或等价脚本）重放；不给"看起来正常" |
| D6 | 不为了造红而改被验对象 | 强制红只允许：页面内注入（init script / fetch 包装）、analyzer 合成序列自测、停**自己** 8982 槽位的守护 |

---

## 1. 就绪条件（gate）——现在的实测状态：**未就绪**

| # | 条件 | 怎样算就绪 | 2026-10-12 11:26 实测 |
|---|---|---|---|
| G1 | `client/**` 非空 | 至少 `index.js` + chunk 文件存在 | ✅ 已有 4 个文件（`index.js` 13178 / `client.panel.js` 18222 / `client.api.js` 7089 / `client.icon.js` 2209 字节） |
| G2 | `package.json` 声明 `dsh.client`（或 T1 钉死的等价字段） | **解析 JSON** 看 `dsh.client` 非空 + `exports["./client"]` 指向真实文件 | ✅ **已就绪**（11:47 我自测）：`dsh.client={platform:'web',inject:[]}`、`exports["./client"]='./client/index.js'` 且文件存在 ⇒ gate pass=True。⚠️ 11:26 我误判为"未就绪"——**是我自己的 grep 口径错**（见 §9.3 S4），不是实现的问题 |
| G3 | 测试宿主 boot 后能取到 bundle 与 chunk | `GET /plugins/dsh-remote-wsl/client.panel.js` → 200 | ⏳ 未测（开工 S3/S4 才有实例） |
| G4 | 面板可达（侧栏图标可点、`main` key 切到 `remote-wsl`） | 页面上能出现 `[data-dsh-remote-wsl="panel"]` | ⏳ 未测 |
| G5 | `docs/client-contract.md`（task-1）能复核 chunk 名/槽位形状 | 文件存在 | ✅ 已落地（11:47 实测存在）；开工时按它复核注册字面量 |

> **G2 是我能不能开工的**硬**闸门**（设计 §8.3 把「声明 `dsh.client`」排在 `client/**` 落地**之后**）。
> ★ 2026-10-12 11:40 lead 更正 + 11:47 我复核：G2 **已通过**（此前是我口径错，见 S4）。开工前会**再复核一次**（`ConvertFrom-Json` 读 `dsh.client`/`platform`/`inject` + `exports["./client"]` 文件存在），不过就停在 S0 报 lead。
> ★ 另一个**必须最先回**的前置问题（见 §7-U1，lead 已背书我的两种口径）：切走再切回**是否真的卸载**面板？若 keep-alive（节点留驻、只 `display:none`/`hidden`），则「挂载/卸载 ≥20 次」这个动作**根本不存在**，测项①必须改口径为「切换 N 次」并**在报告里明说"这不是挂载/卸载测试"**（绝不许把恒定读数写成"无泄漏"）。`probe-mount-cycle.js` 第 1 步就是回答它（不预设结论），并同时记「面板子树是消失还是隐藏」与图标 active 切换前后的节点数。

---

## 2. 四组测项矩阵

> 判据三态：**pass** / **red** / **unknown**。`unknown` 一律**不写成通过**（进报告「未复核项」）。
> 每项给出：触发 → 原始读数 → **预登记判据**（开工前定，不是看数后编）→ 假绿风险 → 反制。

### ① 挂载/卸载 ≥20 次：DOM 节点数 / 监听器数 / 定时器数是否有净增长

| 项 | 内容 |
|---|---|
| 触发 | `probe-mount-cycle.js`：`start({cycles:20, warmup:2})`。每轮 = 点我们的 rail 图标 → 等 `[data-dsh-remote-wsl="panel"]` 出现 → 采样 → 切到另一个（shipped）rail 项 → 等面板节点消失 → 静默 150ms → 采样。每轮记录 6 个读数 |
| 读数 | 每轮 6 项：`domAll`（`document.getElementsByTagName('*').length`）、`panelNodes`（面板子树节点数）、`listenersOutstanding`（add−remove，按 `targetKind|type` 汇总）、`timersOutstanding`（未 clear 的 `setTimeout/setInterval/rAF`）、`apiInFlight`（未决 `fetch` 数，含 `/remote-wsl/api` 序号）、`heapUsed`（`performance.memory.usedJSHeapSize`，**advisory**） |
| **预登记判据** | **预热后**（第 2 轮起）在 2..20 轮上：**(a)** 净增长 `末值−首值` = 0（DOM / 监听器 / 定时器 / 在飞请求各自）；**(b)** 最小二乘斜率 `\|slope\| ≤ 0.5 /轮` 且斜率 95% CI **含 0**；**(c)** 卸载后 300ms 仍在飞的 `/remote-wsl/api` 请求 = 0；**(d)** 区分力前提：`analyze-growth -SelfTest` 必须把「+1/轮 人造泄漏」判为 leak，否则**本次全部结论降级为 unknown**（量具没校准） |
| 假绿风险 | ① **首轮不算**：首轮必然高（chunk 首次加载 + `<style>` 注入 + React 首次渲染），把它算进去会得到"负增长"假绿 → 强制 warmup 且报告**同时**给出「首轮值 vs 第2轮值」；② **keep-alive 假绿**：若切走没卸载，节点数恒定 ⇒ 看起来"零泄漏"，实则**根本没测挂载/卸载** → 必须先定性（§7-U1），keep-alive 时改测「切换 N 次」并**明说测的不是卸载**；③ **读数被仪表自己污染**：instrument 的日志数组若无上限，它自己就会长期增长 → 所有 instrument 数组**硬上限**（fetch/log ≤500 条、堆栈采样 ≤100 条）并在读数里回显 `instrumentCap`；④ `heapUsed` 无强制 GC（浏览器不给 `window.gc`）⇒ 它是 advisory，**不得**单独据此判 leak/无 leak |
| 反制 | `analyze-growth.ps1` 从原始 JSON 复算（净增长 + 斜率 + CI），带 `-SelfTest`（3 组合成序列：平坦→no-leak、+1/轮→leak、锯齿→no-leak）作为量具校准；**阴性对照**：instrument 只装不循环（cycles=0）也必须判 no-leak。人造泄漏强制红 A2（见 §3）证明"能抓到" |
| 产物 | `out-10-cycle-samples.json`（每轮原始读数）、`out-11-growth-analysis.json/.txt` |

### ② 连续快照 ≥20 次：请求堆积 / 竞态（旧响应覆盖新响应）/ loading 卡死

| 项 | 内容 |
|---|---|
| 触发（三条独立路径，**逐个记录是否真触发到 2 个并发**） | **T2a 同 tick 双触发**：在 `刷新` 按钮上**同一任务内**连发两次 `click()`（复现"用户双击"/程序化并发），配合 `fixtures` 的响应闸门让 **seq#1 晚到、seq#2 早到**；**T2b 动作+刷新交叠**：触发 `在新会话中打开`（`refresh:true`）与 `刷新` 交叠；**T2c 快速切换堆积**：连点 rail 图标切走/切回 20 次，每次请求延迟 800ms，量在飞并发峰值 |
| 读数 | instrument 的每次 `/remote-wsl/api` 记录（seq / startedAt / deliveredAt / 闸门延迟）、**最终 DOM 的 marker 归属**（fixture 把 `target.cwd='FIXTURE-SEQ-<n>'`、`daemon.version='fx-<n>'` 写进每条响应，DOM 的 `.dsh-rw-subtitle` 与 `.dsh-rw-status-text` 必须显示**最后发出**的那个 n）、`apiInFlight` 峰值与卸载后残余 |
| **预登记判据** | **(a)** 陈旧覆盖次数 = **0**（DOM marker == 最后**发出**请求的 marker；若等于最后**到达**的更早请求 ⇒ 判 **red：旧响应覆盖新响应**）；**(b)** 卸载后 300ms 在飞 `/remote-wsl/api` = 0（>0 ⇒ red：无 `AbortController`，卸载不取消请求，堆积）；**(c)** 连续 20 次刷新的在飞峰值 ≤ 1（>1 记 red/观察）；**(d)** **卡死**：闸门设 `never`（响应永不返回）→ 点击刷新后 **30s** 内若 `status` 恒为 loading、刷新按钮恒 disabled 且无超时/取消出口 ⇒ 判 **red：loading 态可永久卡死** |
| 假绿风险 | ① 只发一次请求却判"没竞态"（没触发到并发）→ 必须回显**实际发出的 seq 数**，<2 的路径判 unknown 并换路径；② 用"DOM 有内容"当通过（内容可能是旧的那份）→ 必须做 **marker 归属**断言，不是"非空"断言；③ 闸门没生效（fixture 未装/URL 不含 `/remote-wsl/api`）→ fixture 安装必须回显 `enabled + hits`，hits=0 即判 unknown |
| 反制 | `probe-race.js` 分步：`arm(plan)` → `run()` → `status()`；强制红 A3：闸门倒序（seq1 迟、seq2 早）必须判 **STALE-OVERWRITE**；阴性对照 A4：闸门正序必须判 no-stale |
| **代码层预判（待实测，不是结论）** | `client.panel.js:62-79` 的 `load()` 只用一个**每次调用新建**的局部 `alive` 防"卸载后 setState"，**不防并发乱序**；`load()` 的返回值（清理函数）在 `onClick:()=>load()`（L353）与 `run(...,{refresh:true})`（L96）处**被丢弃**，故 `alive` 永远不会被置 false，两个并发响应都会 `setState({status:'ready',snapshot})`（L68）——**谁后到谁赢**。另：无 `AbortController`、无超时、无轮询（`client/**` 全文无 `setInterval`/`setTimeout`）。⇒ 假设 H2a：T2a 可复现陈旧覆盖；H2b：闸门 `never` 可复现永久卡死。 |
| 产物 | `out-20-race-{t2a,t2b,t2c}.json`、`out-21-stuck-loading.json`、`out-22-race-verdict.json` |

### ③ 状态漂移：守护 idle 回收 / kill / 重启后，界面是否停在陈旧值、多久自愈

| 项 | 内容 |
|---|---|
| 触发 | `probe-stale.js`：面板打开并稳定后 → 每 5s 采样一次（`panelText` / `.dsh-rw-status-text` / `快照 hh:mm:ss` / 同源 `POST /remote-wsl/api` 的 daemon 段 / 宿主侧 `wsl_status`）→ 中途由 **PowerShell 侧**对我自己的 8982 槽位依次做：**idle 回收（等 linger 或停）+ kill 守护 pid + 重启守护** → 观察面板文本何时（是否）跟上 |
| 读数 | 时间线 `[{t, panelDaemonLine, panelSnapshotAt, apiDaemon, groundTruthDaemon}]`；`T_stale` = 守护状态变化 → 面板文本变化的间隔；`T_selfheal` = 无人工干预下自愈耗时；`T_refresh` = 点一次 `刷新` → 面板文本变化的耗时 |
| **预登记判据** | **(a)** 若 `T_selfheal = ∞`（采样窗 ≥120s 内面板不变）⇒ 判 **red：无自愈**；**(b)** `T_refresh ≤ 2000ms` 且刷新后面板 daemon 段与 ground truth **逐项相等**（pid/port/version/keys 计数）；**(c)** 刷新后仍与 ground truth 不等 ⇒ 判 **red：host 侧也陈旧（比界面陈旧更严重）**；**(d)** 面板必须至少给出**年龄线索**（`快照 hh:mm:ss`），否则用户无法察觉陈旧 ⇒ 记 design-gap |
| 假绿风险 | ① "面板显示 daemon 未运行" + "守护确实没运行" ⇒ 空集假绿（`not running == not running`）→ **前置**：本条必须在守护**确实在跑**（pid 非空）时开始，并记录该 pid；② 只比"面板变了/没变"，不比**变了之后是否等于真相**→ 必须三层对照（面板 DOM / POST API / `wsl_status`）；③ 停错槽位（停到别人的守护）→ 只允许 `explorer.daemon`/`wsl_daemon` 指向 **8982**，并在每条命令里回显 slot/pid；④ 把 `慢` 当 `不漂移`（采样窗太短）→ 采样窗 ≥120s，且 idle 回收本身可能 >120s（`lingerMs=600000`）⇒ 若靠 idle 回收太慢，改用**直接 kill 我自己的守护 pid**（等价事件：状态从 running→not running，不依赖 linger 时长），并在报告写明"idle 回收路径未实测，用 kill 代替" |
| 产物 | `out-30-stale-timeline.json`、`out-31-stale-verdict.json`、`out-32-daemon-facts-{before,after}.txt` |
| **代码层预判（待实测）** | 面板只在**挂载时** `load()` 一次（`client.panel.js:82`），无轮询、无 `interval`、无事件订阅 ⇒ 假设 H3：`T_selfheal = ∞`，只能手动刷新。这属 P0「看得见」范围内的设计取舍，但**必须在报告里量化**（用户看到的陈旧窗口 = 无限） |

### ④ 边界：≥200 行树 / 极长路径名 的首屏渲染耗时与 DOM 规模

| 项 | 内容 |
|---|---|
| 触发 | `probe-boundary.js` 用 fixture 直接给 `explorer.snapshot` 喂合成数据（**不改被验对象**，只包 `window.fetch`），三组夹具：**A** 1 distro×200 路径（60 字符路径）、**B** 同上但路径 300 字符（近 WSL 半径）、**C** 60 distro×200 路径（查 `client.panel.js:171` 的 `workspaces.filter(...)` 在每 distro 上重跑的 O(n²) 风险）。每组：切走→切回强制重挂载，或点刷新 |
| 读数 | `t_mount`（点击 → `.dsh-rw-tree` 首次变异，MutationObserver + `performance.now()`）、`domAll`/`panelNodes`/`rowCount`、`longtask` 总时长与最长单项（`PerformanceObserver('longtask')` buffered）、**折叠切换重渲染耗时**（点 active distro 行）、**`.dsh-rw-pre` 文本长度**（原始 snapshot `<pre>` 的字节数）、滚动 20 帧的帧间隔 |
| **预登记判据** | **(a)** 夹具 A 挂载 ≤ **300ms**，且无 >**100ms** 的长任务；**(b)** 夹具 C 挂载 ≤ **1500ms**；**(c)** 折叠切换重渲染 ≤ **150ms**；**(d)** DOM 节点数随行数**线性**（记录"每行节点数"）；**(e)** 记录 `.dsh-rw-pre` 字节数（这是**每个渲染都物化**的整份 snapshot 文本） |
| **判定分级（lead 2026-10-12 追加口径）** | 每组给 **p50/p95 + 原始逐次读数**，不只给结论。**超阈值 = ⚠️ finding（必须带数）**；**只有"卡死 / 永不 resolve / 断言前提不成立（如 rows 数不对）"才记 ❌ red**。两类**不得混写**。夹具构造耗时与 pretty-print 体积**单列**、明示排除在计时窗之外（见 §9.3 S2），不参与阈值判定 |
| 假绿风险 | ① 只报"能渲染出来"不报耗时/DOM 规模 → 必须落 `performance.now()` 与节点数；② 时间点选错（点击前就开始计时 / 用 `setTimeout(0)` 当"渲染完成"）→ 用 MutationObserver 的首次真实变异 + `requestAnimationFrame` 双确认；③ fixture 只改了文本没改结构（行数没真到 200）→ 断言 `rowCount` 必须 = 200，否则判 unknown；④ 用 devtools 开着/CPU 降速不一致的读数互相比较 → 同一实例、同一标签页、连续跑完三组，记录 `CPU throttling` 状态（本测不开降速） |
| 产物 | `out-40-boundary-{a,b,c}.json`、`out-41-boundary-verdict.json` |
| **代码层预判（待实测）** | `<details>` 里的 `<pre>{JSON.stringify(snapshot,null,2)}`（`client.panel.js:293-302`）**无论折叠与否都会物化成文本节点**（HTML 的 `<details>` 内容照样在 DOM 里）⇒ 假设 H4：夹具 C 下该文本可达数 MB，且**每次 render**（含每次折叠、每次 `快照时间` 更新）都重算 `JSON.stringify`。这条是"边界 + 长跑"交叉点：**大 snapshot × 高频重渲染 = 长任务**。若实测命中，加固建议是折叠时才序列化（`open` 才 `JSON.stringify`）或分块 |

---

## 3. 强制红（区分力证明）—— 不做完这几条，① 的"无泄漏"不算结论

| 编号 | 手法 | 必须变红的断言 | 改被验对象？ |
|---|---|---|---|
| **A1** | `analyze-growth.ps1 -SelfTest`：3 组合成序列（平坦 / +1每轮 / 锯齿） | leak / no-leak / no-leak 判定正确；错任一项 exit≠0 | 否 |
| **A2** | 页面内注入人造泄漏：每轮 `setInterval(()=>{},1000)` + `document.addEventListener('click',fn)` 各 1 个（**只加在注入层**，不进被测代码） | ①的 (a)(b) 必须判 **leak**（监听器/定时器净增长 >0） | 否（页面内注入） |
| **A3** | fixture 闸门**倒序**（seq#1 迟 1200ms、seq#2 早 50ms） | ②的 (a) 必须判 **STALE-OVERWRITE** | 否（仅页面内包装 fetch） |
| **A4** | 阴性对照：闸门与参考数据都"正确"（正序、无并发） | ①②必须判 **no-leak / no-stale**（防"恒红"） | 否 |
| **A5** | `hash-anchor.ps1 -Mode Check` 在人为改一个字节后 | exit≠0（证明锚点有区分力；改的是**我自己的副本**，不碰被验对象） | 否 |

---

## 4. 读数怎么拿（回答 lead 的问题：能否注入脚本量 DOM/定时器）

**结论：能。** 浏览器侧可执行任意 JS，因此四类读数都可注入式采集，无需改被验对象：

| 读数 | 手段 | 局限（必须写进报告） |
|---|---|---|
| DOM 节点数 | `document.getElementsByTagName('*').length` + 面板子树 `[data-dsh-remote-wsl="panel"]` 内计数 | 只看**在树**节点；**detached 但被引用**的节点看不见 ⇒ 需要堆证据补充 |
| 监听器数 | 包装 `EventTarget.prototype.addEventListener/removeEventListener`，按 `targetKind\|type` 记 add−remove 净额 | 装机时机在 bundle 之后时可漏掉**加载期**监听器（恒定偏移，不影响"净增长"判定）；React 的委托监听挂在根上，逐轮 delta 通常为 0，**泄漏主要由 DOM 节点与业务监听器暴露** |
| 定时器数 | 包装 `setTimeout/setInterval/requestAnimationFrame` + clear/cancel，记未决句柄 | 若真无定时器，读数为 0 —— 此时"零增长"是**平凡成立**，报告必须写成"client 半不使用定时器（源码可见），故本项为结构性零，非实测零" |
| 请求堆积/竞态 | 包装 `window.fetch`：逐条记录 seq / 发出 / 到达 / 闸门延迟；在飞集合 | 只能看见 **页面发起**的请求（不覆盖 host 侧排队）；闸门只延迟**交付给调用方**，不改变 host 行为 |
| 卡死 | 闸门 `never` + 状态文本/按钮 disabled 轮询 | —— |
| 保留（detached）证据 | `WeakRef` + `FinalizationRegistry` 观察卸载的面板根；`performance.memory.usedJSHeapSize` | **无强制 GC** ⇒ advisory；若需硬证据，可选 `chrome-devtools-mcp take_heapsnapshot` 前后对比（同一实例、同一操作序列），代价高 ⇒ 仅当 ①(a)(b) 有疑似增长时启用 |
| 注入时机 | **首选** `chrome-devtools-mcp navigate_page` 的 `initScript`（页面加载前装表，完整性最好）；**兜底** `evaluate_script` / `page execute_javascript` 在加载后装表，改用**预热后 delta** 口径 | initScript 路径依赖 chrome-devtools-mcp 可用；两条路径都要在报告里写明**实际用了哪条**，后者必须标注"加载期偏移未覆盖" |

**浏览器驱动**：优先 `cua_driver_native`（`browser_prepare` + `allow_launch:true` + `profile:{mode:'isolated_new'}`，隔离实例、不抢前台、不碰用户 profile）；兜底 `mcp__chrome-devtools-mcp__*` 的**后台**页面（`new_page background:true`）。**绝不对用户已有页面/窗口做 bring_to_front 或截图**。

**长任务的收集方式**（避免工具调用超时）：所有 ≥10s 的探针都做成**可轮询状态机**——`install()` 返回句柄，`start()` 立即返回，`status()` 取进度与部分原始样本，由 runner 轮询落盘；**不**在一次工具调用里 await 20 轮。

---

## 5. 端口与实例

| 端口 | 用途 | 备注 |
|---|---|---|
| **8981** | 我的测试宿主 web UI（profile `remote-wsl-test-stab`，带插件） | `--no-open`；11:26 实测 free |
| **8982** | 我的守护槽位（`daemonPort` 覆盖） | 只允许对它 ensure/stop/restart；③ 的 kill/重启只动它 |
| **8983** | 备用：第二宿主（基线无插件 / 故障注入） | 需要时用 |
| **8984** | 备用：端口冲突/抢占实验 | 需要时用 |
| **8985–8990** | 备用 | 需要时用 |
| **19387** | **用户正在用的宿主（只读观察，绝不重启）** | 开工基线 pid=**47564** |
| 8931–8960 | p0-verify（task-4）的段 | **不占** |

profile：新建 `C:\Users\l\.dsh\profiles\remote-wsl-test-stab`（`package.json` + `cordis.yml` + `cordis.patch.yml` + `node_modules\dsh-remote-wsl` junction → vendor）。**不动**任何既有 profile（`desktop`/`web`/`headless`/`acp`/`remote-wsl-test`/`remote-wsl-test-web`/`rwsl-client-probe` 一律只读）。收工删除我自建的 profile 目录（删除前打印绝对路径核对）。

---

## 6. 原始输出命名

`out-NN-<主题>.<ext>`，NN 用十位段区分测项：`00`=前置/pid/selftest、`10–19`=①、`20–29`=②、`30–39`=③、`40–49`=④、`90–99`=revision/清理。截图 `shot-NN-*.png`。所有 PowerShell 脚本同时落 `.err`。报告 `REPORT-stability.md`（结论 ≤450 字 + 每项复现命令 + 原始读数 + 判定 + **未复核项**）。

## 7. 待 lead 裁决 / 前置未知

| # | 问题 | 影响 |
|---|---|---|
| **U1** | 切走再切回，`main` 槽的面板是**卸载重建**还是 keep-alive（仅隐藏）？ | 决定测项①的动作是否成立；keep-alive 时改测「切换 N 次」并在报告改口径 |
| **U2** | `package.json` 声明 `dsh.client` 由谁落、什么字段名（`dsh.client` vs T1 契约的等价字段）？ | G2 闸门；字段名错会导致 bundle 不注入，我的全部测项无从开始 |
| **U3** | task-1 的 `docs/client-contract.md` 何时落地？chunk 名/槽位形状以它为准复核 | 复核面 |
| **U4** | ③ 的"idle 回收"路径是否必须在采样窗内实测（`lingerMs=600000` 等不起）？本准备按「用 kill 守护 pid 代替 idle 回收，并在报告标注该路径未实测」处理 | 判据口径 |
| **U5** | 我自建 profile 目录 `remote-wsl-test-stab` 属**写作用域外**的必然副作用（与 p0-verify 建 `remote-wsl-test-web` 同例），是否允许？默认按允许处理并在报告声明、收工删除 | 纪律边界 |
| **U6** | ④ 的预登记阈值（200 行 ≤300ms / 60×200 ≤1500ms）是我定的工程带，是否由 lead 调成更严/更松？ | 判定口径 |

## 8. 本准备工作产出的工具（都已做语法/自测校核，见 `out-00-*`）

| 文件 | 作用 |
|---|---|
| `boot-stabhost.ps1` | 起/停我的测试宿主（8981/8982），含 DSH_* 清理、活宿主 pid 不变检查、`-RequireClient` gate |
| `hash-anchor.ps1` | 被验对象 revision 锚点（`client/**` + `src/*.ts` + `package.json`），Preview/Write/Check |
| `analyze-growth.ps1` | 从原始读数复算净增长/斜率/CI 并判 leak/no-leak/unknown；`-SelfTest` 三组校准（强制红 A1） |
| `browser/instrument.js` | 仪表层（监听器/定时器/请求/DOM/挂载观察/堆），幂等、带上限 |
| `browser/fixtures.js` | `explorer.snapshot` 合成夹具 + 响应闸门（不改被验对象） |
| `browser/probe-mount-cycle.js` | ① 的状态机（含 U1 定性） |
| `browser/probe-race.js` | ② 的 T2a/T2b/T2c 与卡死探针 |
| `browser/probe-stale.js` | ③ 的时间线采样与刷新时延 |
| `browser/probe-boundary.js` | ④ 的三组夹具渲染测量 |

---

## 9. 准备期实测（2026-10-12 11:26–11:40，本回合；开工前必须知道）

### 9.1 环境事实（实测，不是推断）

| 事实 | 读数 | 出处 |
|---|---|---|
| 用户活宿主 | `127.0.0.1:19387` → **pid 47564**（`DeepSeek Harness`，启动于 2026-10-10 12:25:54） | `out-00-*` 系列记录；与 p0-verify 的基线一致 |
| 我的端口段 | **8981–8990 全 free**（8931 亦 free ⇒ 未与 p0-verify 撞） | 逐端口 `Get-NetTCPConnection -State Listen` |
| node | `C:\Users\l\AppData\Local\mise\shims\node.exe` → **v26.10.0** | 实测 |
| dsh CLI | `C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（存在） | `Test-Path`=True |
| WSL | `debian-u8-1` **Running**（WSL 2） | `wsl.exe -l -v` |
| 既有 profile | `acp` / `desktop` / `headless` / `remote-wsl-test` / `remote-wsl-test-web`（p0-verify 的）/ `rwsl-client-probe` / `web` —— **一律只读** | 目录列举 |
| gate 现状 | **已通过**（11:47 复核）：`dsh.client={platform:'web',inject:[]}`、`exports["./client"]='./client/index.js'`（文件存在）；`client/**` = 4 文件；`docs/client-contract.md` 已落地 | `hash-anchor.ps1 -Mode Preview` 头部：`gate(G2): dsh.client=True platform=web entry=./client/index.js 入口存在=True ⇒ pass=True` |
| 被验对象锚点（预览） | 13 条：`client/**` 4 + `src/*.ts` 8 + `package.json`(advisory) 1 | `out-00-anchor-preview.txt` |
| ⚠️ 被验对象仍在动 | `package.json` LastWriteTime **11:42:21**（我 11:26 读到的是旧状态）⇒ 开工必须**重新**落锚点，收工必须复算；`package.json` 属 advisory（它会因 T2 收尾而变） | `Get-Item package.json` |

### 9.2 量具自检（都做了，留读数）

| 检查 | 结果 | 产物 |
|---|---|---|
| 全部浏览器脚本 `node --check` | 6/6 OK（修掉 2 处 `await` 落在非 async 箭头里的语法错） | 本回合命令输出 |
| 全部 PowerShell 脚本 AST 解析 | 3/3 OK，0 错误 | 同上 |
| `analyze-growth -SelfTest`（强制红 A1） | **3/3 PASS**（flat→no-leak / +1每轮→leak / 锯齿→no-leak）；exit 0 | `out-00-selftest-analyze.txt` |
| 合成输入端到端 | 泄漏样本 → `VERDICT=LEAK` **exit 1**；干净样本 → `VERDICT=NO-LEAK` **exit 0** | `fixture-synthetic-{leak,clean}.json` + `.analysis.{json,txt}` |
| 落盘被占用时判定完整性 | `<Out>.txt` 被占用 → 打印警告，判定仍为 `NO-LEAK` **exit 0**（不再被写盘失败改写） | 同上命令输出 |
| **仪表层单元自检（Node + DOM shim，35 用例）** | **35/35 PASS**：安装幂等、监听器净额（+3/−1=+2）、按 `targetKind\|type` 分桶、定时器未决与 clear 抵扣、`rawDelay` 不污染读数、fetch seq/闸门延迟 200ms 实测 ≥180ms、闸门 never 保持未决、夹具集成（marker/source='fixture'）、夹具 A/B/C 行数与路径长度（60/300/12000）、pretty-print 体积、仪表上限 | `out-00-selftest-instrument.txt`、`harness/instrument.selftest.mjs` |
| 仪表不健康时的判定 | 伪造 `instrumentHealth.listeners=false` → `listenersOutstanding`/`domAll` 判 **unknown**、`VERDICT=UNRESOLVED exit 2`（**不判 no-leak**） | `fixture-synthetic-unhealthy.{json}` + `.analysis.txt` |
| gate 区分力 | 真仓 → `pass=True`；把 `exports["./client"]` 指向不存在的文件（**临时副本**，不动被验对象）→ `pass=False` 且打印原因 | 同上命令输出；临时目录已删 |
| 落地副作用复核 | 用户宿主仍 `19387 pid=47564`；未创建任何 profile；未起任何进程；8981–8990 仍全 free | 本回合命令输出 |

### 9.3 准备期自查抓到的 **5 个自身**缺陷（都已修 + 回归；记下来避免重犯）

| # | 缺陷 | 后果（如果不修） | 修法 |
|---|---|---|---|
| **S1** | `analyze-growth.ps1` 在 `$ErrorActionPreference='Stop'` 下先写 `<Out>.txt` 再 `switch→exit`；调用方若用 `*>` 占住同名 `.txt`，`Set-Content` **终止脚本** | 一个 `overall=NO-LEAK` 的运行会返回 **exit 1 = "LEAK"** ⇒ 量具能反转自己的判定 | 先算 `$code`，落盘包 `try/catch`（失败只警告）；并额外打印 `VERDICT=...` 行让 runner 不依赖退出码；已用"锁住 .txt"用例回归 |
| **S2** | 夹具原设计在**每次响应里现造**大数组（夹具 C = 60×200 = 12000 行）+ `JSON.stringify`，这段开销落在 fetch 包装层 ⇒ 被 ④ 的计时窗**算成面板渲染成本** | ④ 的耗时读数系统性偏高，且规模越大偏得越多（会误判 ⚠️/red） | `fixtures.warm()` 预建并缓存大数组，`respond()` 只做浅层 patch；`warm()` 单独测出「夹具构造耗时」与「pretty-print 体积」，两者**明示排除**在计时窗之外 |
| **S3** | ④ 的 `expectRows` 按 `workspaces` 总数算（夹具 C 写成 12000），但 `client.panel.js` 只渲染**当前 active distro** 的行 | `rowsAsserted=false` ⇒ 每组夹具都判 unknown（或反向：把 200 当 12000 硬断言成 red） | 改为 `expectRows = spec.rows`（=200），并在结果里写清"12000 条里只有 200 条进 DOM" |
| **S4** | `hash-anchor.ps1` / `boot-stabhost.ps1` 的 G2 闸门用**文本 grep** 找字面量 `dsh.client`，而真实声明是**嵌套 JSON**（`"dsh":{"client":{...}}`），字面量根本不出现 | 闸门**假红**：明明已就绪却报"未就绪"（我 11:26/11:37 两次都误判；lead 11:40 更正） | 改为 `ConvertFrom-Json` 读 `dsh.client` 路径 + 校验 `exports["./client"]` 指向真实文件；并用"入口指向不存在文件"的临时副本证明它有区分力 |
| **S5** | `instrument.js` 里监听器包装若抛错（例如环境无 `window.EventTarget`），异常被 `try/catch` 吞掉，读数仍是**全零** ⇒ 与"无泄漏"完全同形 | ① 会给出**假绿**："监听器零增长"其实什么都没量到。这个缺陷是**harness 第一版跑出来的**（31/34，3 个监听器用例全 0） | 新增 `wrapErrors` + `snapshot().health`（listeners/timers/fetch 三类健康位）；探针 `status()` 透出 `instrumentHealth`；analyzer 遇到 `health=false` 的指标**强制 unknown**（新增 `VERDICT=UNRESOLVED exit 2` 用例回归）；harness 增加"健康位必须为 true"的前置断言 |

> 另记：探针的等待一律用 `instrument.origTimers` / `rawDelay()`（未包装的原生定时器），
> 否则探针自己的 `setTimeout` 会污染"定时器净增长"读数 —— 这属于 S2 同类的**仪表自污染**风险，
> 已在 `instrument.js` 里用 `origTimers` + `rawDelay` 结构性排除。

### 9.4 端口与协作（收到 peer 通告后更新）

| 段 | 归属 | 状态 |
|---|---|---|
| 8931–8960 | `p0-verify`（task-4） | 已通告 |
| **8961–8970** | `usability-engineer`（task-5） | 2026-10-12 11:39 收到通告（8961 宿主 / 8962 守护 / 8963 无插件基线 / 8964–8970 备用）；已回执确认无冲突 |
| **8981–8990** | **我**（task-7） | 全 free（实测）；与上两段无重叠 |
| 19387 | 用户活宿主 pid 47564 | **禁区：不停不重启** |

> 三段各自独立、无重叠 ⇒ 不需要 lead 再裁决端口；**分段纪律**仍需：任何跨段占用前先通报。

### 9.5 lead 裁决回执（2026-10-12 11:40，已全部落到本矩阵/RUNBOOK）

| 议题 | 裁决 | 我的落实 |
|---|---|---|
| **G2** | lead 更正：`dsh.client` **已在**（附 T1 契约 §1/§2）；责任人 T2 已完成；要我自己复核，不过则停 S0 | 已复核 **pass=True**；并抓出我自己的 grep 口径错（S4）⇒ gate 改为 JSON 解析 + 入口文件校验，开工前再复核一次 |
| **U1** | ✅ 按我的方案：先量生命周期；真卸载⇒"挂载/卸载≥20 次"，keep-alive⇒"切换 N 次"并**明说不是挂载/卸载测试**；另记"子树消失还是隐藏"与图标 active 前后节点数 | 已写入 §1 与 §2 ①；`probe-mount-cycle.classify()` 同时记 `disappeared` 与 `mountTransitions` |
| **U4** | ✅ 同意用"kill 自己 8982 槽位守护（running→not running 等价事件）"代替 idle 回收，报告标注 idle 路径未实测；**不许改 `lingerMs` 或任何共享配置** | 已写入 §2 ③ 与 RUNBOOK §3；③ 的 stop 只经 `explorer.daemon`/`wsl_daemon` 指向 8982，并回显 slot/pid |
| **U5** | ✅ 批准自建 `remote-wsl-test-stab`；**收工必须删除并声明**；既有 profile 只读 | 已写入 §5/§7-U5；`boot-stabhost.ps1 -Stop` + 收尾 S15 删除并打印绝对路径核对 |
| **U6** | ✅ 阈值按我的工程带，但：① 给 **p50/p95 + 原始读数**；② 超阈值 = **⚠️ finding（带数）**，**卡死/永不 resolve** 才是 ❌ red；两类不许混 | 已写入 §2 ④ 的"判定分级"行；④ 的产物已含逐次原始读数，分析时补 p50/p95 |
| **H2a** | 照跑，实测出红就红 | 保持 T2a/T2b/T2c 三条路径，逐条回显"是否真发出 ≥2 并发"（<2 判 unknown） |
| **H2b** | **已转给 T3 作为必修**（超时 + AbortController + 卸载 abort）；我复验时"若已修好就按修好后判"，**同时**在报告记录**修前形态**（行号）作过程证据 | §2 ② 保留"修前形态"证据栏（`client.panel.js:62-79/96/353`，`client/**` 无 `setInterval/setTimeout/AbortController`）；复验时以实测到的代码版本为准，记录锚点 SHA |
| **H3** | 属 **P0 可接受取舍**，不要求 T3 加轮询（轮询属 P1）；但必须实测并写清"手动刷新可自愈"或"无自愈" | §2 ③ 判据保持 `T_selfheal`/`T_refresh` 双读数；结论按"设计取舍 + 读数"写，不升级为必修 |
| **H4** | 照量；构造耗时/体积与"计时窗外"口径保持；小 snapshot 无感记 ⚠️，大 snapshot 超阈值记缺陷 | 已由 S2 的修法保证（`warm()` 单列）；§2 ④ 增加 `<pre>` 体积与重渲染耗时的联合读数 |
