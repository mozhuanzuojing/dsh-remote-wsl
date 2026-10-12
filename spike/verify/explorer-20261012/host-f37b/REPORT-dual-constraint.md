# REPORT —— F-37 双约束修复（task-17）：systemd-run 主路径（无窗）+ detached 回退（保活）

- **结论（≤450 字）**：两条约束**同时满足**，且都有原始输出。根因已由 T15/T16 钉死：`detached` 与 `windowsHide` 在"直接 spawn `wsl.exe`"这一条路上互斥（前者给 job breakaway 但用 `DETACHED_PROCESS` ⇒ wsl.exe 申请新控制台 ⇒ Win11+WT 开窗）。修法：**主路径改为在 WSL 侧用 `systemd-run --user` 托管守护** —— Windows 侧只发一条**短命** `wsl.exe` 命令（按 T15 四态矩阵：短命 ⇒ **不开窗**），守护作为 transient unit 归用户 systemd（**与 Windows 侧任何进程生死解耦**）。**回退路径已实现且不静默**：systemd 不可用/失败 ⇒ 回退 `detached:true + windowsHide:true`（保住约束 b，可能牺牲约束 a）⇒ 返回值与 `notes`/日志都带明确告警 + `/etc/wsl.conf` 的 `systemd=true` 建议。验证：7 轮动作（首次/复用/restart/复用/stop/再首次/**硬杀宿主**）**窗口 ∆ 全 0**、**宿主退出后握手仍 ok 且 meta.pid 不变**；两条故意红都真红（改回 detached ⇒ 真出现 `WindowsTerminal`；改回无 detached 的 T15 形态 ⇒ 宿主退出后守护**死**）；回退面用 `DSH_REMOTE_WSL_SYSTEMD=off` 与"真源码上把 systemd-run 换成不存在命令"两种构造证明**识别→回退→告警→守护真活**；`--dump-config` exit 0 且与基线逐行一致。同时修掉一个**回退路径自身**的 bug（先关 fd 再去 spawn ⇒ `EBADF`，被回退面测试抓到）。`daemon.ts` 的 SIGHUP 忽略保留，但**明确它不是存活性依靠**（本机 WSL 会连带回收，见 §6）。

## 1. 改了什么（写作用域 `src/**`，实际只动 1 个文件）

| 文件 | SHA256 | 内容 |
|---|---|---|
| `src/daemon-client.ts` | `43766999F058BDE3F35767BE513B649DF8C73271713E0145D71AF1E60D18B8D3` | 新增 `SYSTEMD_LAUNCH_SCRIPT` / `systemdUnit(port)`；`launchDaemon` 改双路径；`ensureDaemon` 把"启动方式/告警"推进 `notes`；修 `EBADF` |
| `src/daemon.ts` | `E471A5807054F00869B763A7B2F1383412104FAABC4F562AE352BFDF04E5BFFC` | **本轮未动**（T15 的 SIGHUP 忽略保留） |
| 其余 6 个 src | — | **逐字不变**（首尾双断言） |

- **unit 命名确定性**：`dsh-rwsl-<slot>.service`（`systemdUnit(port)`），便于同槽位重入与收尾清理。
- **同槽位重入**：脚本先 `systemctl --user stop` + `reset-failed` 再 `systemd-run --unit=...` ⇒ 不会因 unit 冲突静默失败。
- **`--collect`**：unit 退出后自动清理（不留 failed 残留）。
- **就绪判据不变**：仍由 **Windows 侧 hello+token 握手**确认（不看日志、不看 unit 状态）；`ensureDaemon` 的轮询逻辑一行未改。
- **照旧的全部**：元数据 `daemon.<slot>.json/token`（0600）、`launch-stderr.log` 0600（systemd `append:` + 启动脚本内 `chmod`）、`launch.<slot>.sh` 起来后自删、端口回退（仍跑**同槽位**脚本）、槽位隔离。
- **argv 纪律**：启动脚本路径 / unit 名 / stderr 日志路径**全部走位置参数**（`"$1" "$2" "$3"`），脚本里零字符串拼接（与 `wsl_path` 同规矩）。

## 2. 窗口面（约束 a）

`verify-f37c.ps1`（长驻宿主 + 每轮 before/after 枚举）→ **`T17 DUAL-CONSTRAINT: ALL PASS`**（原始 `out-10-verify-systemd.txt`、`out-verify-dual.json`）：

| 轮 | 动作 | 窗口 ∆ | 启动方式（notes） |
|---|---|---|---|
| 1 | 首次启动 fresh | **0** | `systemd-run --user（unit dsh-rwsl-8912.service…）` |
| 2 | 已有守护复用 | **0** | 复用（无新进程） |
| 3 | restart 对齐 | **0** | systemd-run |
| 4 | restart 后复用 | **0** | 复用 |
| 5 | stop | **0** | — |
| 6 | stop 后再首次启动 | **0** | systemd-run |
| 7 | **硬杀宿主 + 包装层** | **0** | systemd 托管下包装层本就短命 |

**故意红（约束 a）**：把主路径强制走 compat（`detached:true`）spawn ⇒ `out-20/21-red-*.txt`：**窗口 ∆=2，真出现 `WindowsTerminal`（新 pid）** ⇒ 断言能红。
**回退路径的窗口代价（如实）**：`DSH_REMOTE_WSL_SYSTEMD=off` 那轮同样 `窗口∆=2（新 WT）` —— 这正是回退路径的已知代价，且**告警已同步出现在 notes 里**。
**真宿主轮**：对**正在运行的真 dsh web 宿主**（`127.0.0.1:3091`，真实 profile）`POST /remote-wsl/api {explorer.snapshot}` ⇒ **200**，返回结构完整（`distros/target/daemon/drift/workspaces/webHosts`）；该轮窗口 ∆=0。**该实例的写动作（ensure）按纪律未做**：其 profile 配置槽位是 8731（非我的验证段），而 8731 当前无活守护 ⇒ 调用会**新建**一个非验证段守护，故跳过（§6 未复核第 1 条）。

## 3. 存活面（约束 b）

同一套 7 轮里，**每轮都等宿主正常退出后**再握手（`red-check.ps1` 另给紧凑对照）：

| 场景 | 结果 |
|---|---|
| 宿主存活期握手 | ok（pid 记录在案） |
| **宿主正常退出后** | **ok，且 pid 完全不变**（第 1–6 轮逐轮成立） |
| **硬杀宿主 + 杀包装层**（`Stop-Process -Force`） | **ok，pid 不变**；`daemonSnapshot.live` 仍是同一 pid |
| unit ↔ 元数据一致性 | `systemctl --user show -p MainPID` = `daemon.8912.json` 的 `pid`（实测 1097461 = 1097461） |

**故意红（约束 b）**：`out-31-red-b-survival.txt` 同一"短命宿主正常退出"条件下 A/B：
- **T15 形态**（无 detached 的普通 spawn）：daemon pid 1104133 → **+3s `refused`（死了）** ⇒ 断言红；
- **systemd 主路径**：daemon pid 1104559 → **+3s `ok`，pid 不变** ⇒ 绿。

> 附注（一个有意思的边界）：**硬杀**宿主时，非 detached 的包装层**不会**被带走（Windows 不因父进程终止而杀子进程），所以那种杀法下 T15 形态也能活；**正常退出**才会连带致死。T15 当时的对照是"探针进程正常 `exit`"，与 T16 的结论一致。

## 4. 回退面（必须实现 + 不许静默）

| 构造 | 结果（原始输出） |
|---|---|
| `DSH_REMOTE_WSL_SYSTEMD=off`（显式强制回退） | `out-32-forced-fallback.txt`：`RESULT ok=true … pid=1107506` + notes 带 `⚠️ 未能由 systemd 托管守护…已回退到兼容启动…` ⇒ 守护**真活**（后续 pgrep 可见） |
| **auto + systemd 不可用**（真源码上把 `systemd-run` 换成不存在命令） | `out-34-fallback-real.txt`：`⚠️ 未能由 systemd 托管守护（找不到 systemd-run…）` + `RESULT ok=true pid=1113350` ⇒ **识别 → 回退 → 守护真活 → 告警** 四件齐 |
| `DSH_REMOTE_WSL_SYSTEMD=on`（要求 systemd，失败**不许**回退） | `out-35-require-on.txt`：`ok=false`，错误含 `DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败（找不到 systemd-run…）；按显式配置**不**回退` ⇒ 明确拒绝 |

告警文案（同时进 `notes` 与 stderr）：
`⚠️ 未能由 systemd 托管守护（<原因>）⇒ 已回退到**兼容启动**：守护仍可脱离客户端存活（约束 b 保住），但在 Win11 + Windows Terminal 下**可能弹出一个可见控制台窗口**（约束 a 不保证）。建议在发行版 /etc/wsl.conf 里打开 [boot] systemd=true，执行 wsl --shutdown 重启发行版后再用（那样既无窗、又独立）。`

**回退面测试还抓到一个真 bug（已修）**：我原先在 `trySystemd()` 里**先** `closeStderrFd()`，systemd 失败后再走 `spawnCompat` 就把**已关闭的 fd** 交给 `spawn` ⇒ `spawn EBADF`（回退路径自己先崩）。现在改为只在成功/`on` 失败时关 fd，且 `spawnCompat` 对 `EBADF` 做一次 `'ignore'` 重试兜底。

## 5. 回归

- `--dump-config`（remote-wsl-test）：**exit 0 / `Error:` 0 / 导入错误 0**，与 T12 基线 **逐行 diff = 0 行**。
- 每轮卫生检查：`launch.<slot>.sh` **无残留**、`launch-stderr.log` **`-rw-------`**。
- 槽位隔离：unit 名按槽位、`reset-failed`/`stop` 只碰**本槽位** unit；运行期间只出现 `dsh-rwsl-8912.service`；非配置槽位的动作仍由 T8 的 F33 守卫拒绝（该代码本轮未动）。
- 收尾：`units=''`、守护 `pgrep=''`、包装层 `''`、**无 WindowsTerminal**；state 目录回到 `daemon.log + launch-stderr.log`；临时 profile 副本 / overlay / `%TEMP%` 副本 / `/tmp/t17*` **全部删除**；用户宿主 19387 与 47604 **全程未动**。

## 6. 未复核 / 未做（如实）

1. **"真面板点一次「启动守护」"这一轮没做成**（写动作）：曾两次尝试起隔离实例 —— ①复制可用 profile 成 `t17-panel` ⇒ 该副本 `remote-wsl: failed to import`（**profile 副本的 node_modules 链接问题**，非源码问题：直接 `import` 源码 `index.ts`/`daemon-client.ts` 均 OK）；②用 `--patch` overlay 覆盖 `daemonPort: 8912` ⇒ `startup failed: 2 required plugins did not activate`（**overlay 的 patch 形状会顶掉 bundle 行**）。为避免动用户/他人槽位与实例，**改用真宿主只读轮**（§2 末）并在**探针宿主**里完成写动作的全部 7 轮。⇒ 建议 T18 用 `remote-wsl-test` 的实例 + 一个**形状正确**的 overlay（或让 T3 侧加一个仅在测试 profile 生效的 daemonPort 覆写）补这一轮。
2. **`Linger=no`**：本机 user manager 的 linger 关闭；只要发行版在跑，unit 就活（实测宿主退出后仍 `active`）。若用户执行 `wsl --shutdown`，unit 与守护一起结束 —— 那与"发行版本身关了"同义，未做额外验证。
3. **systemd 路径下的 `restart`**：走的是既有"stop 本槽位 + 重新 ensure"逻辑（实测 ok、窗口 ∆=0、pid 变化正确），但**未**单测"unit 尚在 failed 状态时重入"这一分支（`reset-failed` 已写在脚本里，只有构造人工 failed unit 才测得到）。
4. **回退路径弹窗**：按设计"可能弹"，我只测到"确实弹了"（∆=2），**没有**验证"某些 Win10/WT 未启用环境下不弹"。
5. `daemon.ts` 的 SIGHUP 忽略**不是**存活性依靠：本机 WSL 在包装层结束时**连带回收**会话内进程（T15 §5 已实测，SIGHUP 只是第一跳）；systemd 路径之所以活，是因为守护**不再是任何 Windows 进程的子进程**。

## 7. 证据文件（`spike/verify/explorer-20261012/host-f37b/`，脚本与原始输出同名同目录）

`REPORT-dual-constraint.md`（本文）、`out-10-verify-systemd.txt`（7 轮 ALL PASS）、`out-verify-dual.json`、`out-20-red-baseline.txt`、`out-21-red-a.txt`、`out-22-red-b.txt`（+`out-red-*.json`）、`out-23-red-after-reset.txt`、`out-30-fallback-detect.txt`（副本检测）、`out-31-red-b-survival.txt`（约束 b 的 A/B）、`out-32-forced-fallback.txt`、`out-34-fallback-real.txt`（真源码检测→回退）、`out-35-require-on.txt`、`out-41-fallback-survival.txt`、`out-50-frozen-baseline.txt`、`out-40-dumpconfig.txt`、`baseline-sha256.txt`/`final-sha256.txt`；脚本 `verify-f37c.ps1`、`red-check.ps1`、`mut-t17.mjs`、`probe-copy-detect.mjs`。
