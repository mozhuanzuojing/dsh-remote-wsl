# REPORT-stability —— task-7 稳定性（长跑 / 竞态 / 状态漂移 / 边界）

> ⚠️ **被测量的 revision = P0 冻结集 13 锚点（`client/client.panel.js` = 29,111 B / `8f5ce575…`、`client/client.api.js` = 10,661 B），修复前。**
> lead 已通告：面板即将被改（F34 首挂载渲染条件、F25 动作结果渲染、host 侧 snapshot 的 daemon 段）。本报告的全部结论**只对上述 revision 成立**；修复落地后需按 lead 的 delta 复验指令只复验受影响点（首挂载文案 + 动作结果渲染 + 净增长是否变化）。本报告之后**未再新增测项**（按 lead 指令停手）。**§6 是修复后的 delta 复验（revision 2：`client.panel.js` 34,915 B），与 §1–§5 的 revision 1 读数分列，不可混用。**

- **日期**：2026-10-12 ｜ **执行者**：`stability-engineer`（task-7，owner）
- **被验对象（冻结锚点，13 条）**：`client/**` 4 + `src/**` 8 + `package.json`(advisory)
  - `client/client.panel.js` 29,111 B `8f5ce575…7439e` ｜ `client/client.api.js` 10,661 B `4f98663d…90fc3` ｜ `client/index.js` 13,859 B ｜ `client/client.icon.js` 2,209 B
  - 落盘 `REVISION.txt`（`hash-anchor.ps1 -Mode Write`）；测量期与 16:19 复算均为 **exit 0**，**收尾复算 exit 1（见下条漂移）**
- **环境**：测试宿主 8981（profile `remote-wsl-test-stab`，**收工已删**）／自有守护槽位 8982／夹具服务器 8983／隔离浏览器（chrome-devtools-mcp 自带实例的后台页）
- **纪律核对**：用户宿主 `19387` 全程 **pid=47564**（开工=收工）；端口 8981–8990 收工全 free；只停自己账本里的 pid（`out-00-pids.txt`）；**未改被验对象一个字节**
- **⚠️ 锚点漂移（如实记录，不掩盖）**：测量期落盘锚点并在 16:19 复算 **exit 0**；**收尾复算 exit 1** —— `client/client.panel.js` **29,111 B `8f5ce575…` → 31,828 B `67d785a1…`**（= lead 通告的 F34/F25 修复已落地），`client/client.api.js` **未变**（10,661 B `4f98663d…`）、`index.js`/`client.icon.js` 未变（`out-98-anchor-check.txt`）。
  ⇒ **本报告结论对"测量时的 29,111 B 版"成立**；因**请求路径与挂载/卸载路径未变**，① ② 的读数对该修复**仍适用**；③ ④ 的渲染/文案相关数字**需 delta 复验**（等 lead 指令）。

---

## 结论（≤450 字）

**① 长跑 20 轮（真卸载）**：DOM、面板子树、定时器、在飞请求**四项均无净增长** ⇒ **无泄漏**。但**监听器计数 +10/轮**（判 LEAK）：**8/轮 来自 shipped「插件」面板的 `<img>`、2/轮 来自本面板 `<select>`/`<details>`**，全由平台 React 注册，`client/**` 零 `addEventListener` ⇒ **⚠️ 计数净增长（已归因），非 client 代码泄漏**。

**② 竞态/堆积/卡死**：双击确发 2 并发，旧请求被 abort；**正序与倒序（旧响应后到）都显示最后发出者** ⇒ **无陈旧覆盖**（坏实现必报 STALE ⇒ 有区分力）。快切 20 次峰值/残余**均为 0** ⇒ **无堆积**；闸门永不返回时**自动退出 loading** ⇒ **不卡死**。

**③ 状态漂移**：守护停止后**面板长时间恒显示已死 pid** ⇒ **无自愈**；**手动刷新毫秒级**即一致。**自有槽位缺失时回落他人槽位**（「停止 slot N」也指向它）⇒ **❌ 跨实例误停风险**。

**④ 边界**：200 行**渲染与常规规模一致、无长任务** ⇒ pass；**1.2 万行**时 DOM 规模与**长任务显著上升（约 1.8s）** ⇒ **⚠️ finding**。`<pre>` 仅展开时物化 ⇒ 旧"折叠也重算"已修。

---

## 1. 复现命令与原始读数

> 所有读数：浏览器侧由 `browser/*.js` 探针采集 → `POST http://127.0.0.1:8983/collect` 直落盘到 `collect/`；分析由 `analyze-growth.ps1` 复算（**判定不依赖人眼**）。

### ① 挂载/卸载 ≥20 次（净增长/回归斜率）

```powershell
# 起宿主（自带 G2 gate + 活宿主 pid 不变检查）
pwsh ./boot-stabhost.ps1 -Port 8981 -DaemonPort 8982 -RequireClient
# 浏览器：initScript 注入仪表（加载前装表）→ 探针 start({cycles:20,warmup:2}) 后台跑 → 轮询 status()
#   原始读数 → collect/out-10-cycle-samples.json
pwsh ./analyze-growth.ps1 -Cycles collect/out-10-cycle-samples.json -Out out-11-growth-analysis.json
```

| 指标（每轮**卸载后**读数，n=20） | 序列 | net | slope | CI(95%) | 判定 |
|---|---|---|---|---|---|
| `domAll` | 877 ×20 | 0 | 0 | [0,0] | **无泄漏** |
| `panelNodes` | 0 ×20 | 0 | 0 | — | **无泄漏**（面板真被移除） |
| `timersOutstanding` | 0 ×20 | 0 | 0 | — | `structural-zero`（client 半无定时器，此项**不构成正面证据**） |
| `apiInFlight` | 0 ×20 | 0 | 0 | — | **无泄漏** |
| `listenersOutstanding` | 325,335,…,515 | **+190** | **10** | **[10,10]** | **LEAK（计数）** |
| `heapUsed`（advisory） | 47.3MB→54.7MB →GC→41.2MB→43.5MB→41.9MB | — | −0.4MB | — | **GC 锯齿，非单调** |

分析器原话：`overall=LEAK`、`listenersOutstanding verdict=leak why: slope=10 > 0.5 且 CI 下界 10 > 0`（`out-11-growth-analysis.txt`）。

**U1 生命周期定性**（第一步就量，未预设结论）：

```js
// probe-mount-cycle.js 安装时自动 classify()
{"mode":"mount-unmount","appeared":{"ok":true,"ms":26},"disappeared":{"ok":true,"ms":26,"mountTransitionsDelta":1}}
```

切走 ⇒ `[data-dsh-remote-wsl=panel]` **从 DOM 消失**（不是 `display:none`），切回 ⇒ 重新出现，MutationObserver 每次切换记录 **1 次**卸载转变 ⇒ **真卸载重建**，故按"挂载/卸载 ≥20 次"口径；**不是** keep-alive。

**监听器增长的逐键归因**（3 轮实验，`byKey` 差量 + 独立 spy 栈）：

| 键 | 每轮增量 | 注册帧 |
|---|---|---|
| `img\|load` | +4 | `u2 (assets/index-5SrrfWpU.js:53:32628)` |
| `img\|error` | +4 | 同上 |
| `select\|invalid` | +1 | 同上 |
| `details\|toggle` | +1 | 同上 |
| `AbortSignal\|abort` | +1 **且 −1**（平衡） | `request (plugins/dsh-remote-wsl/client.api.js?rev=cc5a610f9149)` |

`img` 属 shipped「插件」面板（本面板 DOM 无 `<img>`）；`select`/`details` 各 1 个属本面板（发行版选择器 + 原始 snapshot 折叠区）。**client 半自身无任何 `addEventListener`**。

### ② 连续快照（竞态 / 堆积 / 卡死）

```powershell
# 夹具（每响应带 marker = 仪表请求 seq）+ 探针
#   fixtures.js({fixture:'FIXED'}) → probe-race.js
#   t2a forward / t2a inverted / spoofStale=true（A3 强制红）/ t2c / stuck
#   原始读数 → collect/out-20-race.json、collect/out-21-pileup-stuck.json
```

| 用例 | 发出 | 最后发出 seq | DOM 显示 marker | 交付顺序（关键） | 判定 |
|---|---|---|---|---|---|
| forward（正序：先快后慢） | 2 | 3 | **3** | seq2 被 abort、seq3 200 | **no-stale-overwrite** |
| inverted（倒序：先慢后快，旧响应**后到**） | 2 | 5 | **5** | seq4 abort、seq5 先到 200 | **no-stale-overwrite** |
| **A3 强制红**（marker 故意回退一版） | 2 | 7 | 6 | — | **STALE-OVERWRITE（断言有区分力）** |

- 双击**确实**产生 2 个并发（`issued=2`）⇒ 但 `client.panel.js:104-133` 的 `readSeq` + `readAbort.abort()` 双保险把它们收敛为"只有最后发出者能写状态"。
- 原始证据：旧请求记录 `error:"The operation was aborted."`、`gateDelayMs=1200`（真被延迟）而 DOM 仍跟最后发出者。
- **T2c 快速切换 20 次**（每次请求延迟 800ms）：`peakInFlight=0`、`residualAfterUnmount300ms=0`、`residualNotAborted=0` ⇒ **no-pileup**（每次新读取取消上一次，卸载时取消在飞）。
- **卡死**（闸门 never）：t=1013ms 仍 loading（pendingApi=1）→ **t≤9106ms 已退出**：`errorVisible=true, retry=重试, pendingApi=0`，此后恒定 ⇒ **loading-settled**。`client.api.js` 的 9s 超时 + `client.panel.js` 的失败态撤销共同生效。
- **H2b 修前形态（过程证据，未复核读数）**：lead 提供旧版 `client.panel.js` 22,666 B @11:40:55（现 29,111 B）—— 旧版只在挂载时 `load()` 且无 `AbortController`/无超时；**旧版文件已不在盘上，故本人未复算旧版读数**，仅按 lead 转述与新版源码差异记录。

### ③ 状态漂移（kill 自有守护 / 重启）

```powershell
# 前置：必须自有守护在跑（否则 "not running == not running" 空集假绿）
POST /remote-wsl/api {"method":"explorer.daemon","args":{"action":"ensure","slot":8982}}   # → pid 917590
# 探针 start({sampleMs:5000,durationMs:150000}) 后台采样；然后
POST ... {"action":"stop","slot":8982}     # 只停我的槽位（16:17:33）
POST ... {"action":"ensure","slot":8982}   # 16:18:51 → pid 938333
# 原始读数 → collect/out-30-stale-timeline.json（20 样本）
```

| 时刻 | 面板显示 | 地面真相（rawFetch POST /remote-wsl/api） |
|---|---|---|
| 08:17:22–08:17:32（停之前） | slot 8982 · pid **917590** · 快照 16:17:18 | 8982 / 917590 ✔ 一致 |
| 08:17:38–08:18:31（**停之后无人干预，14 个样本**） | slot 8982 · pid **917590** · 快照 **恒 16:17:18** | **8962 / 930015**（已变） |
| 手动刷新（第一次） | **28ms** 后 → slot **8962** · pid 930015 | 8962 / 930015（一致，但是**他人槽位**） |
| 08:18:57 起（我的 8982 已重启） | 仍 slot 8962 · pid 930015（陈旧） | **8982 / 938333**（已变） |
| 手动刷新（第二次） | **27ms** 后 → slot 8982 · pid 938333 | 8982 / 938333 ✔ 一致 |

判定：**(a) 无自愈**：地面真相变了 **69s** 面板不动 ⇒ `T_selfheal=∞`（采样窗内）；面板**有**年龄线索（`快照 hh:mm:ss`）故用户可察觉。**(b) 手动刷新可自愈**：27–28ms，且刷新后与真相**逐项相等**（slot/pid/version/keys）⇒ 符合 lead 的 P0 取舍裁定（不加轮询）。**(c) ❌ 跨实例缺陷**见 §2-F1。

### ④ 边界（≥200 行 / 极长路径）

```powershell
# 夹具 A/B/C 由 fixtures.js 直接喂 explorer.snapshot（不改被验对象）；夹具构造在**计时窗外**预建
#   原始读数 → collect/out-40-boundary-ab.json、collect/out-40-boundary-c.json
```

| 夹具 | 行数（断言） | 面板节点 | 节点/行 | 树首帧 p50/p95 | 长任务 max | 判定 |
|---|---|---|---|---|---|---|
| A（1×200，60 字符） | 200 ✔ | 1,231 | 6.16 | **9 / 10 ms** | **0 ms** | **pass** |
| B（1×200，300 字符） | 200 ✔ | 1,231 | 6.16 | **11 / 15 ms** | **0 ms** | **pass** |
| C（60×200 = 12000） | 12000 ✔ | **72,445**（domAll 73,164） | 6.04 | **348 / 462 ms** | **1781 / 1391 / 321 ms** | **⚠️ finding** |

- 极长路径（B）与常规路径（A）**DOM 规模与耗时相同**（仅 `<pre>` 体积 40,337→90,737 字符）⇒ 长路径本身不劣化渲染（CSS 用 `direction:rtl` + ellipsis 截断）。
- **H4 实测**：折叠态 `.dsh-rw-pre` **不存在**（`preTextLen=null`）⇒ 旧版"折叠也物化整份 JSON"已修；**展开**后文本 **2,370,338 字符**（夹具 C）、耗时 **587ms**、展开态再重渲染 **313ms**。
- 滚动：同步布局代价 **0.9ms**（`scrollTop` 后强制 `scrollHeight`）；**帧间隔未复核**（见 §3-U1）。
- 阈值口径说明（**量具自身瑕疵，如实记**）：我的 `tSettleMs` 含 `measureMount` 内 **400ms 固定等待**（p50=420ms），**不能**直接与 300ms 带比较；本报告用「树首帧」(`tTree`) 作渲染判据，并另列 `tSettle` 供复算。

---

## 2. 发现（按严重度）

| # | 发现 | 证据 | 判定 |
|---|---|---|---|
| **F1** | **跨实例守护显示/误停风险**：自有槽位无守护时，`explorer.snapshot.daemon` 回落到 `live[0]`（**他人槽位**）。我在 8982 停掉后，面板刷新显示 **8962**（usability-engineer 段），而「停止 slot 8962…」按钮以该 slot 为目标，标题却写"本插件自有槽位"（`client.panel.js:418` 取 `daemon.slot`，`:477` 传 slot；host 侧 `daemon-client.ts:772` `listDaemonSlots` 自有槽位优先、缺失即回落 `live[0]`） | 面板/API 三层对照 + `ensure` 回执原话"另有守护在槽位 8962 … 未复用、未打扰" | **❌ 高**（多实例环境下会误停他人守护；有二次确认兜底）。**建议**：snapshot 增 `daemon.foreign=true` 或仅在自有槽位命中时填 `daemon`，否则 `running:false` + `others:[…]`；UI 对非自有 slot **禁用**停止/重启 |
| **F2** | **监听器计数净增长 +10/轮**（其中本面板贡献 +2/轮） | §1① 逐键归因 + 平台栈 `u2` | **⚠️ 中**（非 client 代码引入；不伴随 DOM/堆增长；保留性未证） |
| **F3** | **12000 行树长任务 1781ms**（主线程卡顿 ~1.8s） | §1④ 夹具 C | **⚠️ 中**（首帧仍 348–462ms；建议虚拟化或分页/折叠默认收起非活动发行版） |
| **F4** | 展开「原始 snapshot」物化 2.37MB（587ms） | §1④ | **⚠️ 低**（已只在展开时做；建议超过 N 行时截断/提示） |
| **F5** | **无自愈**：守护状态变化后界面无限期陈旧（仅年龄徽标提示） | §1③ 69s 窗口 | **⚠️ 低（P0 可接受，lead 已裁定）**；P1 可加轮询/失焦重取 |

## 3. 未复核项（不许当通过）

| # | 未复核项 | 原因 / 下一步 |
|---|---|---|
| **U1** | **滚动帧率** | 后台标签页把 `rAF` 节流到 ~1Hz（实测帧间隔 **1006ms**），帧间隔不可用；只测了同步布局 0.9ms。要测需前台标签页（会抢用户焦点，未做）或 `--disable-background-timer-throttling` 的独立实例 |
| **U2** | **监听器"+10/轮"是否真保留内存** | 无强制 GC（未加 `--js-flags=--expose-gc`），堆呈 GC 锯齿只能说明"有回收"。定论需 heap snapshot 前后对比或强制 GC |
| **U3** | **idle 回收路径** | 按 lead 裁决用"kill 自有 8982 守护（running→not running 等价事件）"代替；`lingerMs=600000` 等不起，**idle 回收本身未实测** |
| **U4** | **H2b 修前读数** | 旧版 `client.panel.js`（22,666 B）文件已不在盘上，只记 lead 转述 + 新旧源码差异，**未复算旧版** |
| **U5** | **桌面 profile（用户宿主）现场** | 无法在不重启用户宿主（pid 47564）的前提下加载测试客户端 ⇒ 本报告全部读数来自**独立 web 测试实例** |
| **U6** | **单 distro 夹具的"折叠切换重渲染"** | `isCollapsed = … && !isActive` ⇒ 点击当前唯一发行版是 **no-op**，该路径在 A/B 上不存在；C 上已测（313ms，展开态） |
| **U7** | **点「停止 slot 8962」** | **故意未点**（那是他人守护，纪律不允许）⇒ F1 的破坏性后果由代码路径 + 读数证明，**未做端到端证实** |
| **U8** | S3/A3 强制红只覆盖"旧响应覆盖新响应"与"人造泄漏" | 未构造"面板永不卸载"等其它坏形态的强制红 |

## 4. 量具自身的缺陷与修正（**会影响结论的都必须记**）

执行中我用 Node 单元自检 + 实盘读数反复校准量具，抓到并修掉 **12 个自身缺陷**；其中 5 个**曾产生假结论**，全部在报告前修正：

| # | 缺陷 | 曾导致的错误结论 | 现状 |
|---|---|---|---|
| S1 | `analyze-growth.ps1` 落盘失败会终止在判定之前（`$ErrorActionPreference=Stop`） | `NO-LEAK` 却返回 `exit 1`（量具反转自己的判定） | 先定判定、落盘 try/catch、打印 `VERDICT=`；已回归 |
| S5 | 监听器包装失败被吞 ⇒ 读数全零 | **假绿**"无泄漏"（其实什么都没量到） | 新增 `health` 健康位；analyzer 对 `health=false` 的指标强制 **unknown**；harness 35 用例含前置断言 |
| S6 | `initScript`（document_start）时 `document.documentElement` 为 null ⇒ 观察器静默失效 | 挂载/卸载转变计数全丢（U1 差点只靠轮询） | 退回 `document` 观察 + `mountObserverError` 显式登记；实测每切换 1 次转变 |
| S10 | 闸门延迟里 `restore.timeout(...)` 未绑定接收者 ⇒ `Illegal invocation` | 竞态测试**全部请求失败**（面板进错误态），竞态根本没测到 | 显式 `.call(window, …)`；实测 `gateDelayMs=1200` 生效 |
| S11 | marker 用夹具自身计数器而非仪表请求 seq（两者起点不同） | **假红**：把**正确**的"最后发出者胜出"误判为 `STALE-OVERWRITE`（正序倒序都"命中"） | marker 改用 `rec.seq`；修正后正序/倒序均 no-stale，且 `spoofStale` 强制红仍能报 STALE |
| S12 | 闸门无视 `AbortSignal` | **两个假红**：被 abort 的请求仍算在飞 ⇒ 误报 `PILEUP`（8 峰值/5 残余）；9s 超时 abort 无处生效 ⇒ 误报"**永久卡死**" | 闸门按真请求语义尊重 abort；修正后 `peakInFlight=0/残余 0`、loading ≤9.1s 退出 |
| S2/S3/S4/S7/S8/S9 | 夹具构造污染计时窗；行数断言按总数而非渲染数；G2 gate 用文本 grep（嵌套 JSON ⇒ 假红）；`snapshot().caps` 缺失；`/collect` 无 CORS 预检；analyze 不接受 `/collect` 包装 | 分别会误判耗时/unknown/未就绪/探针崩溃/采集失败/解包失败 | 全部已修（`warm()` 预建、`expectRows=distros×rows`、JSON 解析、`caps` 入 snapshot、OPTIONS 预检、自动解包） |

**量具校准留存**：`out-00-selftest-analyze.txt`（3/3 PASS）、`out-00-selftest-instrument.txt`（**35/35 PASS**）、`fixture-synthetic-{clean,leak,unhealthy}.analysis.txt`（exit 0 / 1 / 2）。

## 5. 生产物清单

| 文件 | 内容 |
|---|---|
| `collect/out-10-cycle-samples.json` | ① 20 轮逐次原始读数（含 warmup、转型计数、仪表健康位） |
| `out-11-growth-analysis.{json,txt}` | ① 净增长/斜率/CI 复算（`overall=LEAK`，归因见 §1①） |
| `collect/out-20-race.json` | ② forward/inverted/A3 + 每条请求的 seq/交付时序/abort |
| `collect/out-21-pileup-stuck.json` | ② T2c 时间线 + 卡死采样时间线 |
| `collect/out-30-stale-timeline.json` | ③ 20 样本三层对照 + 两次手动刷新时延 |
| `collect/out-40-boundary-ab.json` / `-c.json` | ④ A/B/C 逐次原始读数 + 展开态代价 |
| `out-02-bundle-probe.txt`、`out-02-gate.txt` | bundle 路由（`plugins/??dsh-remote-wsl/client.js&rev=…`=200）与 G2 gate |
| `out-98-anchor-check.txt` / `REVISION.txt` | 锚点复算（测量期 exit 0、收尾 exit 1=漂移，见报告头）／冻结锚点 |
| `out-99-cleanup`-相关、`out-00-pids.txt` | 清理对照与自造进程账本 |
| `MATRIX-STABILITY.md` / `RUNBOOK-STABILITY.md` | 预登记矩阵（判据、假绿风险、强制红）与执行顺序 |

---

# 6. Delta 复验（revision 2 = 修复后；2026-10-12 16:33–16:40，按 lead 指令**窄范围**）

> 本节的被测量 revision = **修复后**新锚点（16:33 `-Mode Write` 冻结，收尾 `-Mode Check` = **exit 0「锚点一致」** ⇒ 本节结论有效）：
> `client/client.panel.js` **34,915 B**、`client/index.js` **14,841 B**、`client/client.api.js` **10,661 B（未变）**、`src/explorer.ts` / `src/daemon-client.ts` 已变（见 `REVISION.txt`）。
> 范围：只复验 **③ + ① + ④** 三项；**② 按指令未重跑**（rev 1 结论仍有效，且 `client.api.js` 哈希未变支撑其延续性）。

## 6.1 ③ 状态漂移 / 跨实例误停 —— **❌ 已修复（改前/改后对照）**

| 观察点 | 改前（rev 1，29,111 B） | 改后（rev 2，34,915 B） |
|---|---|---|
| 停自有 8982 → 刷新后的**主 daemon 行** | `daemon slot 8962 · :8962 · pid 930015`（**他人槽位被当成"自己的"**） | **`daemon 未运行`**（圆点 `dsh-rw-dot--off`，title「守护未运行（快照 running=false）」） |
| 主行是否出现外来槽位号 | 是（8962） | **否**（`mainLineMentionsForeign=false`） |
| 别槽位如何呈现 | 无独立区，用户无从分辨 | 独立只读区 **「其它槽位的守护（只读：本面板不会对它们发起任何动作）」**：`8731 / 8962 / 8972` + 各自 note「非本槽位（configured daemonPort=8982）；未复用、未打扰」 |
| 指向**别槽位**的可动作按钮数 | ≥1（「停止 slot 8962…」/重启指向他人 slot，标题却称"本插件自有槽位"） | **0**（`foreignActionButtonCount=0`；按钮全表只剩 刷新 / 启动守护 / 展开折叠 / 打开 / 复制路径） |
| API `explorer.snapshot.daemon` | `{running:true, slot:8962, pid:930015, …}`（**回落 live[0]**） | `{running:false, keys:[], orphans:0, **others:[8731,8962,8972]**}`（**无回落**；`out-33-delta-snapshot-after-stop.json`） |
| 自有守护运行时 | 正常 | 正常（`daemon slot 8982 · :8982 · pid 961517 · 0.2.0-rc.2 · keys 0`，别槽位仍只读） |

**复现命令（③ delta）**：`ensure 8982` → 打开面板 → `explorer.daemon{action:"stop",slot:8982}` → 点「刷新」→ 读 `.dsh-rw-status-text` 与面板按钮表。
**读数**：刷新后 1129ms 采到 `daemon 未运行`。⚠️ 该 1129ms **含我自己 800ms 固定等待**，**不可**与改前 28ms 直接比较（避免造出假回归）。
**判定**：**改前 ❌ → 改后 ✅**。F33 在 **API 与 DOM 两层**均验证通过：自有槽位无守护时如实显示未运行；他人守护仅**只读**可见、**零动作按钮**。

## 6.2 ① 挂载/卸载 ≥20 次 —— **无回归**

`analyze-growth.ps1 -Cycles collect/out-13-delta-cycle-samples.json`（读数 `out-14-delta-growth-analysis.txt`）：

| 指标 | 改前（rev 1） | 改后（rev 2） | 判定 |
|---|---|---|---|
| `domAll`（卸载后） | 877 恒定，net 0、slope 0 | **808 恒定，net 0、slope 0、CI[0,0]** | **无泄漏（无回归）** |
| `panelNodes` | 0 ×20 | **0 ×20** | **无泄漏** |
| `timersOutstanding` | 0 ×20 | **0 ×20** | `structural-zero`（非正面证据） |
| `apiInFlight` | 0 ×20 | **0 ×20** | **无泄漏** |
| `listenersOutstanding` | slope **10.0**、net 190 | slope **9.3188**、CI[9.2741,9.3635]、net 176 | **leak（计数）**，比改前**略降** |
| 挂载/卸载转变 | 1/轮 | **1/轮** | U1 复验：**仍是真卸载**（节点消失 26ms；`observerTarget=document`、`observerError=null`） |

**监听器归因复验（同方法论：独立 spy 栈 + `byKey` 差量，3 轮）**：`img|load +4/轮`、`img|error +4/轮`（shipped「插件」面板）、`select|invalid +1/轮`、`details|toggle +0.67/轮`（本面板）、`abort|AbortSignal` **add/rem 3/3 平衡**；**全部注册帧仍是平台 bundle 的 `u2 @ assets/index-5SrrfWpU.js:53:32628`**，`client/**` 仍零 `addEventListener`。
⇒ 结论不变：**⚠️ 计数净增长，非 client 代码泄漏**。`<details>` 贡献由 1/轮 降到 0.67/轮（该块已改为条件渲染 ⇒ 该计数对"元素是否真的挂载"敏感，故报 **≈9–10/轮** 而非精确常数）。

## 6.3 ④ 边界（12,000 行）—— **没有变差，反而改善**

| 指标（夹具 C = 60 distro × 200 行 = 12,000 行，同口径 3 次） | 改前（rev 1） | 改后（rev 2） |
|---|---|---|
| 行数断言 | 12,000 ✔ | **12,000 ✔** |
| `panelNodes` | 72,445 | **72,445（逐位相同）** |
| 节点/行 | 6.04 | **6.04** |
| 树首帧 | 348 / 384 / 462 ms | **310 / 268 / 237 ms** |
| **长任务 max** | **1781 / 1391 / 321 ms** | **295 / 252 / 222 ms** |
| 折叠态 `.dsh-rw-pre` | 不存在 | **不存在**（`preTextClosed=null`，仍只在展开时物化） |

**判定**：P2（虚拟滚动）需求**仍成立**，但本次修复**未使其变差**：DOM 规模逐位相同，长任务显著下降。读数 `out-43-delta-boundary-c.json`。

## 6.4 delta 未复核项

| # | 未复核 | 说明 |
|---|---|---|
| D1 | 长任务最大值的**分布** | 只跑 3 次、同页同夹具；最大值天然有方差，不构成分布结论（仅同口径对照） |
| D2 | 别槽位「只读」的**行为级**证实 | 只读了 DOM（无动作按钮）+ API 契约；**未**尝试任何程序化方式触碰他人守护（纪律不允许） |
| D3 | ② 竞态/堆积/卡死 | 按指令**未重跑**；rev 1 结论仍有效（`client.api.js` 哈希未变） |
| D4 | 首次挂载文案（F34/F25 直接产物） | 本次只覆盖"刷新/状态行/只读区"；首挂载文案未逐字比对（不属三项复验范围） |

## 6.5 delta 期间的工具修正（量具，非被验对象）

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| S13 | `boot-stabhost.ps1` 就绪判据只认 HTTP 200，而 web UI 需 `?token=`（无 token 返 **401**） | 明明已就绪却报 `ready=False / exit 3`，并误以为启动失败 | 401 视为就绪；并从日志自动提取 token URL 落 `out-02-url.txt` |
| S14 | 同一脚本取基线 pid 时把整份文本的非数字全删 ⇒ 把"记录时间 + 端口段"的数字也拼进来 | `Int32` 溢出 ⇒ 启动直接失败 | 改为正则只取 `19387 pid=(\d+)` |

**delta 收尾核对**：活宿主 `19387` = **47564**（未变）；8981–8990 **全 free**；自建 profile `remote-wsl-test-stab` **已删**；锚点 `-Mode Check` = **exit 0**；`client/client.api.js` 哈希与 rev 1 相同（`4f98663d…`）。
