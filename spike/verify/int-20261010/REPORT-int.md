# task-4 独立复验报告 — 守护接入插件本体（spike-verify）

写作用域：`spike\verify\int-20261010\`（4 个新文件）。被验对象 `src\*.ts` **零改动**（mtime 14:19–15:55，早于本次 16:03 开工）；`rwsl-test\lib\*.ts` 与 `src\*.ts` **7/7 SHA256 逐字节相同**，故回归夹具确实在验交付物。

## 结论（≤450 字）

**task-3 的 9 条语义我全部独立复现通过；同时抓到一个必须修的槽位并发竞态与三处小缺陷。**

1. **跨宿主重连（真宿主）**：两个独立 `dsh --profile remote-wsl-test` 进程（13.5s / 14.4s）。host1 答 `ACK`，`session=remote-wsl-rv-int-1-6758a2c8… runtimePid=171038 turns=1 daemon=170873@127.0.0.1:8755`；host1 退出后守护仍在；**host2 答 `41`，session/runtimePid/turns=2/daemon 完全相同**；全程 `daemon_ts=1`、`listen8755=1`。与 Lead 亲验一致（我用自己的 key/数字/端口）。
2. **#11 已修**：Windows 先占 8756 → **3008ms** 判定 timeout → 自动 +1 到 8757 成功，notes 明写"WSL 侧 bind 成功不代表 Windows 侧能连上"；三端口全占 → **11.26s** 可读报错（三端口+原因+处置+日志尾部），绝非 300s 假死；每次失败的 WSL 守护都被 SIGTERM 清掉，无残留。
3. **幂等**：3 个独立进程连续 `action=start` ⇒ 同一 `pid=158529 reused=true`（握手 4–5ms）。
4. **可见性**：`wsl_daemon status` / `wsl_status` 均给出 pid/port/version/uptime/keys[key session turns runtimePid idleForMs]。
5. **漂移报警**：伪造 `pin=9.9.9-fake`（已还原 `0.2.0-rc.2`）⇒ `drift: YES` + `daemon drift: ⚠️ 守护持有的 dsh@0.2.0-rc.2 与 wsl pin 9.9.9-fake 不一致…不自动重启`。
6. **恢复**：kill -TERM（同进程）与 kill -KILL（新进程）后都自动重建守护并**明确告知**"⚠️ 远端会话已重置…（新 sessionId=…）"，meta 带 `contextReset=yes`。不静默。
7. **并发**：同 key 6 并发 ⇒ 前 5 个 FIFO 串行（2267/2952/3584/4285/5137ms，turns 1→5，同 session/runtimePid），第 6 个 **9ms** 被拒 `queue full for key "ckey-1" (limit 4 waiting)`。
8. **回归**：`test.ts` exit 0（6 工具、答 `7`、`warm ok`）；`adversarial.ts` exit 0 / 34.7s（A 可读诊断、B 截断 120039/exit141、C 2.3s、E 4.1s 快速失败）。
9. **收尾**：`profile_sdk=[]`、`daemon.ts=[]`、8755–8768 无监听（WSL+Windows）、`/tmp/dsh-rwsl-*=0`、state 只剩 `daemon.log`(0700)、pin 已还原。

**与 Lead 亲验/实现者报告的不一致**：①`wsl_status` 漂移报警**只比 desktop/pin，不比 `version this plugin uses`** ⇒ 配 `dshVersion:'0.1.0-fake'` 时守护 0.2.0-rc.2、插件要用 fake，**完全没有报警**（实测 out-07）；②`adversarial.ts` case D **不再测空闲回收**（见下）。

## 新发现（最小可复现）

**①【必须修】槽位并发竞态：`launch.sh` 是全局单文件。** 两个槽位同时启动（8759/8760）：A 写 `launch.sh(8759)`、B 写 `launch.sh(8760)`，互相覆盖 ⇒ A 的 `bash launch.sh` 跑到了对方的脚本。实测：A 报 `ok port=8760 pid=178076`（`daemon.8759.json` 里 `port:8760`），而真正监听 8759 的守护**没有任何元数据**；B 的 8760 槽"元数据文件未出现"→ 回退 8761。终态 **3 个守护而只请求 2 个**（`--port 8759`×2 + `--port 8761`），`wsl_daemon stop` 两个槽位后**孤儿仍占着 8759 活着**（工具无法发现/回收），只能按 pid 人工杀。证据：`out-14b/14c/15a/15b`；复现脚本 `verify-port-conflict.ps1` 同目录思路 + `probe.ts --mode daemon --action start --port 8759|8760` 并发。
**②【小】工具文本与磁盘不符**：`wsl_daemon`/`wsl_status` 三处写"元数据 …/daemon.json（0600）"，实际是按槽位 `daemon.<slot>.json` / `daemon.<slot>.token`（实测目录里从未出现 `daemon.json`）——单文件命名是 spike/旧版假设，漏改。另有 `wsl_status` 的 `port=8731(+3 回退)` 显示的是**配置值**而非实际运行端口（实际 8755 在上一条 daemon 行里）。
**③【小】夹具 D 已失效**：`adversarial.ts` case D 用 `idleTimeoutMs:15000` 期待"空闲换新 id"，但默认 `backend=daemon` 下该键不起作用（守护用 `daemonIdleMs=30min`）⇒ 实测 `换了新 id=false` 且**不 assert**、退出码仍 0 ⇒ 空闲回收（丢上下文）在新形态下**无回归覆盖**；同处打印的 `profile sdk 进程数` 是全局计数（实测 11，混入他人运行时），正是 task-7 要改的全局断言。
**④【小】/tmp 残留**：`wsl_open_ui` 周期后留 `dsh-rwsl-<winpid>-*.sh/.pid`（本次 2 个，属主 20976 已死）；设计的 `ensureSwept` 会在**下一次有副作用的调用**时清掉（实测一次 `wsl_exec` 后 → 0），但"跑完即 0"不成立。

## 独立判断（item 10）

- **过度复杂度**：slot 元数据 + **全局单份** `launch.sh` 是自相矛盾的组合，竞态正来自此 ⇒ 建议 `launch.<slot>.sh`。报警只报不杀 + 显式 `restart` 是合理取舍（避免无声中断用户会话），不算过度设计。
- **dispose 不杀守护 × 资源不回收**：三种会话结束方式在 README/工具描述里讲清了，但缺"守护寿命闸门"；当前只有 30min idle 与显式 stop 两条回收路径，孤儿（①）会长期占端口/进程 ⇒ 建议加"无 key 且无客户端 N 分钟后自退"或 `wsl_daemon stop --all`。
- **`wsl_daemon stop` 返回文本而非 JSON**：**算缺陷（低危）**——工具契约是纯文本，脚本化只能正则；建议至少补一行稳定前缀（`daemon=pid@port version=… reaped=N`）。

## 证据清单（`spike\verify\int-20261010\`）

| # | 项 | 原始输出要点 | 文件 |
|---|---|---|---|
| 1 | 真宿主跨宿主 | host1 `session=…6758a2c8… runtimePid=171038 turns=1`；host2 `41` + 同 session/runtimePid/turns=2；`daemon_ts=1 listen8755=1` | `out-12-realhost.log`，`out-12b/12c/12d/12e` |
| 2 | 幂等 | 三个独立进程 `pid=158529 reused=true` | `out-02a/03a/03b` |
| 3 | 可见性 | `keys (1): int-key-1 session=… turns=1 runtimePid=161640 idleForMs=4447` | `out-05/05b` |
| 4 | 漂移报警 | pin 伪造 → `drift: YES` + `daemon drift: ⚠️…`；还原 `[0.2.0-rc.2]` | `out-08` |
| 5 | 报警漏判 | `dshVersion=0.1.0-fake` vs 守护 0.2.0-rc.2 ⇒ **无** `daemon drift` 行 | `out-07` |
| 6 | 恢复 | 同进程/新进程均"⚠️ 远端会话已重置…新 sessionId=…" + `contextReset=yes` | `out-10-recovery.txt`，`out-10a/10b*` |
| 7 | 并发/上限 | 2267/2952/3584/4285/5137ms turns 1→5；第 6 个 9ms `queue full for key "ckey-1" (limit 4 waiting)` | `out-09` |
| 8 | 端口冲突 | 单占：`timeout（3008ms）`→换 8757 成功；全占：`11.26s` 可读报错 + 日志尾部 | `out-11-port-conflict.txt`，`out-11d` |
| 9 | 槽位竞态 | A 要 8759 实得 8760；`daemon.8759.json port:8760`；终态 3 守护；stop 后孤儿占 8759 | `out-14b/14c/15a/15b` |
| 10 | 回归 | `test.ts` exit0 答 7 + `warm ok`；`adversarial.ts` exit0/34.7s，D 打印 `换了新 id=false` | `out-13a`，`out-13b` |
| 11 | 收尾 | `profile_sdk=[] daemon.ts=[] 8755-8768 无监听 tmp=0 state=[daemon.log] pin=0.2.0-rc.2` | 本报告上文；`out-16-sweep.txt` |

**纪律核对**：全程未用全局 `pkill`（只按 `/proc/<pid>/cmdline` 验身份后杀我自己的 slot 8759/8760/8761/8755）；未删任何非我创建的 `/tmp/dsh-rwsl-*`（本次 2 个经属主 winpid 20976 + 脚本内含 `web --port 3082` 判定为**我的** adversarial 运行所留，由设计的 sweep 清除）；并发中的 `ts-migrate-spike`（8741）未受影响。报告不含任何密钥。
