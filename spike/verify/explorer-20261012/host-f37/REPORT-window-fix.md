# REPORT —— F-37：起守护会弹出可见控制台窗口（根因 + 修法 + 死磕验证）

- **任务**：task-15（写作用域 `src/**`；实际只动 `src/daemon-client.ts` + `src/daemon.ts`）
- **日期**：2026-10-12 ｜ **端口**：只用 8912（8911–8920 验证段）｜ **未碰用户宿主 19387/47604**
- **结论**：窗口根因 = `spawn(..., { detached: true })`（本插件**自己的**启动参数），**已修**；同一改动**不引入**任何存活回归（A/B 实测两态一致）。
- **§5 请按两个变量读，切勿合并**：**变量 A**（只杀包装层，宿主仍活着）⇒ 实测守护会死，**新旧配置一致**、属**已知限制**（非本修法回归）；**变量 B**（**宿主进程正常退出**后守护是否仍存活）⇒ **本轮无有效证据、留 T16 独立复核**；若红则改用 §5 的 ✅ `systemd-run --user` 路线。

---

## 1. 根因（实测确认，不是推测）

**触发链**：`detached: true` → libuv 用 `DETACHED_PROCESS` 起 `wsl.exe`（**该进程没有控制台**）→ `wsl.exe` 是控制台子系统程序 ⇒ 它**申请一个新控制台** → Windows 11 的默认终端应用是 Windows Terminal ⇒ **WT 接管并开一个可见窗口**（标题 `C:\Program Files\WSL\wsl.exe`）。`windowsHide: true` 对它**无效**（它只对应 `CREATE_NO_WINDOW`，而 `DETACHED_PROCESS` 与之互斥；WT 的 handoff 不认 hidden）。

**A/B 证据（spawn 选项矩阵，长驻 `wsl.exe -d debian-u8-1 -- bash -c 'sleep 8'`，脚本 `run-ab-windows.ps1`，原始 JSON `out-ab-summary.json`）**：

| 形态 | 包装层寿命 | 新增**带窗口**进程 | 新增终端宿主 | 结论 |
|---|---|---|---|---|
| `{ windowsHide: true }` | 8.1s | **0** | 5 conhost（无 WT） | **无窗** |
| `{ detached: true }` | 8.4s | **1（WindowsTerminal）** | 7 | **有窗** |
| `{ windowsHide: true, detached: true }`（**旧配置**） | 8.4s | **1（WindowsTerminal）** | 7 | **有窗** |
| `{}`（都不加） | 8.1s | **0** | 4 conhost | 无窗 |
| `-l -v`（短命，347ms） | 0.35s | 0 | 0 | 无窗 |
| `-e bash -c 'true'`（短命） | — | 0 | 0 | 无窗 |
| `-e` vs `--` 长驻 | 8.4s 两者 | **两者都 1（WT）** | 7 | **与 `-e`/`--` 无关** |
| `detached + stdio 全 'ignore'`（E2） | — | **1（WT，pid 30244）** | — | **与 stdio 无关** |

⇒ **唯一判别变量是 `detached`**；短命进程不开窗是因为握手还没完成进程就退了（也解释了"为什么只有起守护才弹窗"）。

**窗口归属判定（不凭标题猜）**：新 `WindowsTerminal` 的**父进程是 `svchost.exe`(pid 1700)**，不是我们的 `wsl.exe`（Win11 默认终端 handoff 走服务宿主）⇒ 父 pid/标题都不可用。可复算判据 = ①**启动时间同秒**（WT pid=48668 created `18:14:17.069` vs 包装层 spawn `18:14:16.980`）②**A/B 对照**（只有 detached 形态出现）③**消失相关性**（包装层退出时 WT 同批消失，`∆B→C` 列出）。三者在 `out-01-ab-console.txt` 里逐条可查。

## 2. 修法（改了什么、为什么这样改）

**`src/daemon-client.ts`（根因修复，1 行 + 注释）**：`launchDaemon` 的 spawn 去掉 `detached: true`，保留 `windowsHide: true`。
注释里写死了"**这里绝对不能加 detached**"、四态矩阵数据、机理，以及**为什么不能改用 WSL 侧分离**（见 §5 的实测反证）。

**`src/daemon.ts`（存活加固，新增 SIGHUP 处理）**：`kill -HUP <daemon>` 实测**直接杀死守护**（默认动作终止，无任何收尾日志），而守护只挂了 `SIGINT/SIGTERM`。现在 `SIGHUP` 被**忽略并记一行日志**（`nohup(1)` 语义：这是"控制终端消失"，不是"会话结束"）。会话的三种结束方式一个没变：显式 `shutdown` op、`--idle-ms`、`--linger-ms`；`SIGINT/SIGTERM` 仍走原优雅回收路径。

**没有动的语义（逐条核过）**：握手/就绪判据、端口回退（`+1`，每次回退仍跑**同槽位**的 `launch.<slot>.sh`）、槽位隔离、`launch-stderr.log` **0600**、元数据 `daemon.<slot>.json/token` 0600、`launch.<slot>.sh` 起来后**自删**。单一真相源 `daemonSnapshot()` 未动。

## 3. 死磕验证（`verify-f37b.ps1`，原始 `out-20/22-verify-final*.txt`、JSON 同目录）

**每轮都用"长驻宿主"起守护**（贴近真实部署：DSH 宿主是长驻进程），存活期枚举窗口 + 握手 + 卫生检查：

| 轮 | 动作 | 窗口 ∆（带窗口进程+WT） | 握手 | `launch.8912.sh` | `launch-stderr.log` | 判 |
|---|---|---|---|---|---|---|
| 1 | 首次启动 fresh | **0** | ok（pid 1066106） | 无残留 | `-rw-------` | PASS |
| 2 | 已有守护复用 | **0** | ok（1066769） | 无残留 | `-rw-------` | PASS |
| 3 | restart 对齐 | **0** | ok（1067433） | 无残留 | `-rw-------` | PASS |
| 4 | restart 后复用 | **0** | ok（1067709） | 无残留 | `-rw-------` | PASS |
| 5 | stop 停守护 | **0** | 无守护（符合预期） | 无残留 | `-rw-------` | PASS |
| 6 | stop 后再首次启动 | **0** | ok（1068033） | 无残留 | `-rw-------` | PASS |
| 7 | 裸 `kill -HUP` | — | **HUP 后仍 ok、pid 不变** | — | — | PASS |
| 8 | 只杀包装层 | **0** | 见 §5（既有耦合） | — | — | PASS(窗口) |

`F-37 VERIFY: ALL PASS`（exit 0），两轮独立复跑同样 ALL PASS。

**故意红（`detached:true` 加回去，`out-21-verify-red.txt`）**：`F-37 VERIFY: 3 FAILED`，失败轮逐条打印
`⚠ 新 WindowsTerminal pid=12336 ppid=1700` / `pid=25560` / `pid=47584`（`⇒ FAIL`）。字节还原后复跑 **ALL PASS** ⇒ 判据有区分力，且能红。

## 4. 回归

- 首尾双断言：**只 `daemon-client.ts` + `daemon.ts` 变**；其余 6 个 src（`explorer.ts`/`index.ts`/`sdk-runtime.ts`/`selftest.ts`/`shell-env.ts`/`version.ts`）逐字不变。
- `--dump-config`（remote-wsl-test）：**exit 0 / 0 个 `Error:` / 0 导入错误**，且与改前基线**逐行 diff = 0 行** ⇒ 无新告警。
- F31（0600）/ F33（槽位隔离）/ F32（路由）本轮未改其代码路径；F31 在每轮卫生检查里**每轮复查**为 `-rw-------`。
- 收尾：`slots=[]`、无本槽位包装层、**无任何 WindowsTerminal 实例**、可见窗口集合与开工完全一致（8 个，含用户宿主 47604 未动）。

## 5. 重要发现：**两个变量必须严格分开**（lead 2026-10-12 裁决：不加总、不合并结论）

本轮的实测只覆盖**变量 A**；**变量 B 本轮无法判定，留 T16 独立复核**。二者在机理上不同，**不得互相推断**：

| | **变量 A：只杀包装层**（父进程/宿主**仍活着**） | **变量 B：宿主进程正常退出**（浏览器关 ≠ 宿主退，见下） |
|---|---|---|
| 本轮实测 | 旧配置 `detached:true`：refused（守护死）<br>新配置（无 detached）：refused（守护死）<br>⇒ **两态一致** | **未复核（本轮无有效证据）** |
| 机理（待验证的推测，**非结论**） | `wsl.exe` 实例结束 ⇒ WSL 连带回收该会话内进程；SIGHUP 只是第一跳（`daemon.ts` 已忽略，`kill -HUP` 实测存活），紧随其后的回收才是死因 | 宿主退出时包装层是否**跟着退出**，取决于它是否落在宿主的 **Job 对象**（kill-on-close）里；若包装层活着，守护就活着 |
| 影响 | **已知限制**（lead 已接受，不是本修法的回归 —— A/B 两态一致） | **头号卖点的判据**「关客户端 ≠ 会话结束」；**若红** ⇒ 改用下面 ✅ 的 systemd 路线 |
| 归属 | 本机 WSL 既有行为；旧记录"包装层被杀后 Linux 进程活 1 小时"**本机未复现** | 待 T16 |

⚠️ **为什么变量 B 本轮没有有效证据**：我的探针宿主（node）在**退出时会带走自己的子进程**（疑似 harness 的 Job 语义），所以"探针退出后包装层/守护都没了"既可能是被测行为、也可能是**观测环境的假象**；同一现象在 `detached:true` 与无 detached 两态下**完全一样**，因此**不能**据此判定变量 B。要判定 B，必须在**真实 DSH 宿主**（长驻、且与插件同 Job 关系）里退出宿主后检查包装层与守护 —— 这正是 T16 要做的独立复核。另注：**"关客户端"（浏览器页面关闭）≠ "宿主进程退出"**，两者在本插件的语义里是不同事件（前者根本不该影响守护）。

**候选修法（同一节，供 T16 若判红时使用）—— 实测否掉与肯定各在此**：
- ❌ WSL 侧 `&` 分离：`bash <脚本> &`、`setsid`、`setsid nohup` 三种写法，包装层 0.45s 退出而**脚本连第一行都没执行**（tick 文件不存在）；只有**前台**跑（4.46s、10 行 tick）才真跑完（`out-06-kill-semantics.txt`）。
- ❌ 启动脚本改 `exec setsid --fork node`：守护确实起来了（`daemon.log` 有 listening），但 ensure 侧出现**元数据竞态**（`no metadata record`），启动路径变得不稳 ⇒ **不采用**（`out-17-setsid.log`）。
- ✅ **`systemd-run --user`**：实测 `systemd-run --user --unit=t15e3168 --collect bash -c 'sleep 120'` ⇒ unit `active`、进程存活、宿主退出后仍 `active`（`out-escape.txt` 的 E3）⇒ 让守护**真正独立于 Windows 侧**的可行路径（P1 单独立项：`systemd-run --user --unit=dsh-remote-wsl-<slot> --property=StandardOutput=append:<daemon.log>`；需处理**同槽位重入**、**无 systemd 发行版的回退**、`--unit` 命名/清理）。
- 另：`kill -HUP <daemon>` 在**旧配置**下未做对照（新配置已修：STILL_ALIVE + 握手 ok、pid 不变）。

## 6. 未复核 / 建议

1. **【变量 B，最高优先，T16 回归项】宿主进程正常退出后，守护是否仍存活**（头号卖点判据）：本轮**无有效证据**（理由见 §5：探针宿主退出会带走自己的子进程，两态表现一致 ⇒ 观测环境干扰）。**若红 ⇒ 改用 §5 的 ✅ `systemd-run --user` 路线**（lead 已把该项列为 T16 关键回归项；我已被告知"先别撤、等 T16 结论"）。
2. **【变量 A 的机理】包装层被杀 ⇒ 会话回收**：本轮只证明了"两态一致（非本修法回归）"与"SIGHUP 只是第一跳"；`wsl.exe` 实例结束时的回收是 WSL 行为推测，**未定位到 WSL 侧证据**（如 `/proc` 的会话/进程组关系、WSL 日志）。lead 已接受为**已知限制**。
3. **真实桌面宿主（Electron，pid 47604）下的行为**：本次所有实验的父进程都是我起的 node 宿主（Hidden+重定向、无控制台），与桌面宿主的"无控制台"条件一致；但**没有**在真实宿主里点一次面板「启动守护」复验（会动用户会话）。⇒ 建议 T16 在测试实例（`dsh --profile … --port 30xx`）里点一次，按 §1 的三条归属判据复核。
4. **systemd 路径**：已证明 `--user` 可用（单测 E3），但**未实现**、未测**同槽位重入**、未测**无 systemd 发行版的回退**、未定 `--unit` 命名与清理策略（P1 单独立项，本轮不做）。
5. **本报告只覆盖 Windows 侧窗口**；`wsl_open_ui` / `wsl_agent`(in-host) 的两处长驻 spawn 本来就**没有** `detached`（`index.ts:581/797`），按同一矩阵属"无窗"形态，本轮未逐一实测。
6. `kill -HUP <daemon>` 只在新配置下做了验证（旧配置未做对照，不影响结论：SIGHUP 处理是纯增量）。

## 7. 证据文件（`spike/verify/explorer-20261012/host-f37/` 与本轮工作目录 `D:\project\net1\_t15-f37\`）

`out-01-ab-console.txt`（A/B 全量）、`out-ab-summary.json`（机读）、`out-03-survival.txt`、`out-04-detach-forms.txt`、`out-05-detach-diag.txt`、`out-06-kill-semantics.txt`、`out-07-flag-matrix.txt`（四态矩阵）、`out-11-survive-diag.txt`、`out-13-keepalive.log`（宿主存活 + 杀包装层）、`out-15-hup-fixed.log`、`out-17-setsid.log`、`out-escape.txt`（E1/E2/E3）、`out-20-verify-final.txt`、`out-21-verify-red.txt`、`out-22-verify-final2.txt`、`out-30-dumpconfig.txt`、`baseline-sha256.txt` / `final-sha256.txt`；脚本 `run-ab-windows.ps1`、`variant-runner.mjs`、`verify-f37b.ps1`、`probe-f37.ts`、`keepalive-launcher.mjs`、`mut-detached.mjs`。
