# REPORT-f37-verify.md —— T16：F-37 窗口修复的独立复验

- **验证者**：`p0-verify`（独立于 T15 实现者）｜**日期**：2026-10-12｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：开工冻结（18:4x）→ 收尾复算 **锚点一致 = True（13/13）⇒ 验证有效**；advisory 仅 README.md。
  lead 给的两个锚点 **2/2 MATCH**（`src/daemon-client.ts` `384C239358BB…`、`src/daemon.ts` `E471A5807054…`）；本轮变化面 = `daemon-client.ts` + `daemon.ts` + README.md，`client/**`/`package.json`/`explorer.ts`/`index.ts` 全未变。

## 结论（≤450 字）

**窗口半边是好的：`Δ可见窗口 = 0`（6 轮，含真面板「启动守护」）且故意红成立（副本加回 `detached:true` ⇒ 真出现 `WindowsTerminal`）。**
**但这条修复引入了 P0 级回归：去掉 `detached` 之后，"关客户端 ≠ 会话结束"（本插件头号卖点）不成立了 —— 已第一时间报 lead。**
A/B（同一手法：只杀宿主 harness，不动控制台/包装层）：**NEW（无 detached）⇒ 包装层死、守护死**（meta.pid 残留但 pgrep 空、监听 0；随后 ensure 报"复用失败：连接被拒（**守护已死**，元数据是陈的）"并新建 pid）；**OLD（副本加回 `detached:true`）⇒ 包装层仍活、守护仍活（pid/pid 不变）**。隔离实验：只杀宿主**控制台(conhost)** ⇒ 包装层与守护**都活** ⇒ 触发点是**宿主进程死亡**本身，与保留 `detached` 时显然不同（`detached` 在 Windows 上给的是 libuv 的 DETACHED_PROCESS + job breakaway，即"父退出仍存活"）。⇒ **该修法不能按现状发布**；建议走 T15 §4 `systemd-run --user --unit=…`，或取"存活语义 + 不开新控制台"的组合（见 §5，**未实测**）。
其余语义未退化：握手 3–4ms、`daemon.<slot>.json` pid=port 一致、元数据/token/`daemon.log`/`launch-stderr.log` 全 **0600**、`launch.<slot>.sh` **无残留**、端口回退 OK（占 8932/8933 ⇒ 落 **8934** 并给出迁移说明）、槽位隔离 OK（`slot=8962` ⇒ **400 E_ARG** 且不打扰）。
**只杀包装层 ⇒ 守护 1s 内死（NEW 实测；与 T15 报的"3s 量级"一致）⇒ 这条与 `detached` **无关**的既有事实要写进 README。**

## 1. 窗口归属方法（可复算；本轮核心）

- **账本** `out-90-ledger.tsv`：我启动的每个外部进程 `(pid, 启动时间, 父 pid, 用途)` —— 本轮共 6 条：
  `39400 / 50328 / 17056 / 45676 / 35328 / 44272`（各宿主 cmd 与 harness）。
- **枚举** `win-audit.ps1 → Get-WinSnap`：每个可见窗口 `(pid, 进程名, 标题, 启动时间, 父 pid, 父链)`；**归属** = 父链是否可达账本 pid（`mine`）。
- **交叉印证**：WSL `daemon.log` 的 `peer=win-pid-<pid>`。实测 **`peer=win-pid-22156` = `DeepSeek Harness.exe`，其 ppid = 39400 = 我的宿主** ⇒ 客户端侧对端与我的账本**逐字闭合**。
- **仪器正向对照**（必须有）：`Test-WinInstrument` 要求本机可见窗口 ≥1，否则判 `INSTRUMENT-FAIL`，**不得当绿也不得当红**（本机稳定 7 个：Code/Cursor/DeepSeek/Geph/Edge/TextInputHost/Weixin）。

## 2. `Δ可见窗口 = 0`：逐轮 before/after

| 轮次 | 动作 | before | after | Δ | before/after 里的 WT |
|---|---|---|---|---|---|
| R1 | 首次启动（stop 后 `ensure`） | 7 | 7 | **0** | 0 / 0 |
| R2 | 复用已有守护（`ensure`） | 7 | 7 | **0** | 0 / 0 |
| R3 | `restart` | 7 | 7 | **0** | 0 / 0 |
| R4 | 复用（`ensure`） | 7 | 7 | **0** | 0 / 0 |
| R5 | stop + 再起 | 7 | 7 | **0** | 0 / 0 |
| **R6** | **真面板点「启动守护」**（用户路径） | 7 | 7 | **0** | 0 / 0 |
- 六轮 **全部 valid**（两次枚举都非空），**累计 Δ = 0**；原始：`out-91-rounds-route.json`、`out-93-rounds-all.json`、`out-93-panel-round-{before,after}.json`。
- R6 证据：面板 `daemon 未运行` → 按钮「启动守护」→ 点击后 note `已启动守护 slot 8932 · :8932 · pid 1088149 · 0.2.0-rc.2：槽位 8932 由 Windows 侧握手确认就绪（实际端口 8932，3ms）`。
- **收尾枚举**：可见窗口 7 个、**可归我方 = 0**、**WT = 0**。

## 3. 故意红（≥1，副本做、vendor 只读）

`%TEMP%\rwsl-t16-red` 副本把 `detached: true` 加回（`daemon-client.ts` 的 spawn 选项）⇒ profile `remote-wsl-t16-red`（daemonPort 8935）起在 8933：
- ensure 后 **Δ=1 且新增 `WindowsTerminal#6680`，start=19:00:47，title=`C:\Program Files\WSL\\wsl.exe`，WT=True** ⇒ **窗口断言确实有区分力（能红）**。
- 复绿：杀该 WT（我方产物）、删副本与 profile ⇒ 可见窗口回 7、WT=0；**vendor 真代码行 `detached: true` = 0 处**（注释里出现不算）。

## 4. ★ 回归：关客户端 ⇒ 守护随之死（P0，必须改）

| 配置 | 手法（同一手法、各起守护后测一次） | 包装层 | 守护（meta.pid / pgrep / 监听） | 结论 |
|---|---|---|---|---|
| **NEW**（T15 去 `detached`） | `taskkill /F /PID <harness>` | **死** | pid 残留 1092235，**pgrep 空、监听 0** | **RED：守护随宿主消失** |
| **OLD**（副本加 `detached:true`，槽位 8935） | 同上 | **仍活** | **1094111 / [1094111] / 保持** | 旧行为正确 |

- NEW 侧握手复验：新宿主 `ensure` 返回 notes `自己槽位 8932 复用失败：连接被拒（守护已死，元数据是陈的）` + `…握手确认就绪（实际端口 8932，4ms）`，**新 pid 1093593 ≠ 原 1092235** ⇒ 守护确实死了 110。
- **隔离实验（NEW）**：只杀宿主**控制台 conhost**（不动 harness/cmd/包装层）⇒ **harness 仍活、包装层仍活、守护仍活**（meta.pid 1093593 不变）⇒ **触发点是"宿主进程死亡"本身**，不是控制台被毁；也就是说去掉 `detached` 后包装层失去了"父退出仍存活"的能力。
- **机理**：`detached` 在 Windows 上正是 libuv 用来让子进程在父退出后继续跑（DETACHED_PROCESS + 作业逃逸/新进程组）的开关；去掉它 ⇒ 宿主一死包装层跟着死 ⇒ WSL 侧 relay 会话被回收 ⇒ 守护死（`daemon.ts` 忽略 SIGHUP 救不回来，因为整个会话没了 —— 与 T15 注释里"本机 WSL 会回收 `wsl.exe` 会话里的后台进程"一致）。
- **机理（两条约束为何互斥 —— lead 要求写明）**：`detached` 在 Windows 上同时给了**两样**东西：
  **① job breakaway**（父退出后子进程仍存活）—— 这是 **(b) 存活**的来源；
  **② `DETACHED_PROCESS`**（不继承父控制台、也不分配控制台）—— 而 `wsl.exe` 是**控制台子系统程序**，拿到"没有控制台"的进程身份后它会**申请一个新控制台**，
  Win11 默认终端应用是 **Windows Terminal** ⇒ WT 接管并开**可见窗口** —— 这是 **(a) 开窗**的来源。
  另一侧 `windowsHide:true` 在 libuv 里走的是 **`CREATE_NO_WINDOW`**，其语义要求"新进程**没有**控制台"，与 `DETACHED_PROCESS` **互斥/相互抵消**
  ⇒ 所以"`detached:true + windowsHide:true`"两个都加**仍然开窗**（T15 的 spawn 选项矩阵实测，我这次用副本 A/B 复现：Δ=1、真出 `WindowsTerminal`）。
  ⇒ 想**同时**满足 (a)(b)，必须换一种方式拿"存活"：**Ⅰ** 把长驻进程挪到 WSL 侧（`systemd-run --user --unit=…`：Windows 包装层短命 ⇒ 无窗；守护与 Windows 侧生死解耦 ⇒ 存活）；
  **Ⅱ** 在 Windows 侧拿"存活语义但不开新控制台"的组合（方向：`CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW`，即只要 breakaway、不要 `DETACHED_PROCESS`）—— **Ⅱ 我只给机理方向，未实测**，T15/T17 若采用必须先做 A/B。
- ⇒ **该修法不能按现状发布**。可选路线：**① T15 §4 `systemd-run --user --unit=…`**（WSL 侧真独立、无 Windows 包装层、天然无窗）；**② 保留"父退出仍存活"但不要 DETACHED_PROCESS 的新控制台**（方向：拿到 job breakaway + `CREATE_NO_WINDOW` 的组合）—— **②我只给机理方向，未实测**，T15 若要采用必须先做 A/B。

## 5. 守护语义（未退化项）

| 项 | 结果 | 原始 |
|---|---|---|
| 握手 | OK（3–4ms，Windows 侧确认） | ensure notes / `out-93-*` |
| `status`/`wsl_status` | OK（`daemon: running pid=… actualPort=8932 slot=8932 version=0.2.0-rc.2`） | `out-92-status-after-rounds.txt` |
| 元数据 | `daemon.8932.json`（254B，**0600**）与 `daemon.8932.token`（65B，0600），`pid=port=8932` | UNC 读取 + `ls -la` |
| `launch-stderr.log` | **0600**（28–31KB，0600） | `ls -la` |
| `launch.<slot>.sh` 自清理 | **无残留**（守护起来自删） | `ls launch.*.sh` → NONE |
| 端口回退 | 占住 8932+8933 ⇒ 落 **8934**，notes 含 `WSL 侧端口 8932 已被占（占用者 pid=1095038）⇒ 守护实际监听 8934` | 本轮原始输出 |
| 槽位隔离 | `ensure slot=8962` ⇒ **400** `slot 8962 不是本插件配置的槽位（8962≠8932）；本插件只操作自己的槽位`，未打扰 | 本轮原始输出 |
| **只杀包装层** | **守护 1s 内死**（NEW 实测；T15 报 3s 量级，同量级）⇒ 与 `detached` 无关的**既有事实** | 本轮原始输出 |

**⇒ 给文档的明确结论（不许含糊）**：
1. **README 的"守护脱离包装层存活"在本机当前 WSL 上不成立** —— 杀包装层 ⇒ 守护 1s 内死（NEW 实测；OLD 配置未测，但 T15 报"新旧一致"）。
2. **"关客户端 ≠ 会话结束"在 T15 改后不成立**（NEW：宿主机退出 ⇒ 守护死；OLD：守护活）⇒ 若维持本修法，README 必须改写为"关客户端即会话结束"；若要保住卖点，须改走 §4 路线。

## 6. 我自己的仪器/脚本缺陷（留档，避免下一位重走）

1. **假绿**：`win-audit.ps1` v1 `Get-WinSnap` 抛 `Argument types do not match` 并**静默返回空集** ⇒ `before=0/after=0` 看起来像"Δ=0 绿"。**已加正向对照**（枚举必须 ≥1，否则 `INSTRUMENT-FAIL`）。
2. **假红**：v2 用 `return , $res.ToArray()` ⇒ 多一层嵌套 ⇒ 7 个窗口被算成 `Count=1` ⇒ **假 `Δ=5` 红**。已改为纯 `$rows += [pscustomobject]@{…}` + `return $rows`。
3. **假 `alive=False`**：WSL 侧 `pgrep/ss` 输出被 `wsl.exe` 告警噪声污染、我又用了 `^\s*<pid>\s` 锚定 ⇒ 把活守护判成死。已改为"只认以数字开头的行" + 元数据走 **UNC 读 JSON**（不经 `wsl.exe`，无噪声）。
4. 另有 2 次 **PowerShell 解析错**（hashtable 里用逗号分隔、`@() .Count` 空格）—— 都**整体未执行**（无副作用），已改。

## 7. 未复核项（不许当通过）

1. **"只杀包装层 ⇒ 守护 3s 死"的 OLD 配置 A/B 我没测**（副本那一轮用于第 4 节的 harness A/B）⇒ 该项**未复核**（T15 报"新旧一致"，我只有 NEW 侧 1s 的实测）。
2. **"宿主正常退出"是用 `taskkill /F` 强杀 harness 近似的**，不是真·优雅退出（本机没有把 web 宿主优雅关掉的通道）⇒ 优雅退出路径**未复核**（若优雅退出会先关连接/等子进程，结论可能不同）。
3. **建议路线 ②（job breakaway + CREATE_NO_WINDOW）未实测**，只给机理方向。
4. **R6 面板回合的"点击"由我在页面里触发**（真 DOM 点击、真 host route），但**未**用像素级鼠标事件（`cua` 的 trusted click）；DOM 点击已足以触发同一条 `explorer.daemon{ensure}` 路径。
5. keys>0 / webHosts 非空 / desktop 宿主：沿用历轮**未复核**（本轮为空集/未涉及）。
6. 像素截图未落盘（chrome-devtools-mcp 的 `filePath` 只能写它的 workspace root）⇒ 视觉结论用 DOM + 计算样式/窗口枚举替代。
