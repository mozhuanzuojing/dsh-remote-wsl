# task-2 独立验证报告（verify-* 全部由本人新写；未改任何被验对象）

## 结论（≤450 字）

**task-1 的 4 条核心主张全部独立复现，但 README §6.4 的诊断是错的，并发现 3 个它没测到的失败模式。**

1. **重连成立**：我自己起守护；client A（win PID 32816）第一轮答 `ACK`、sessionId `remote-wsl-k1-e3c6e087…`、runtimePid 136427，A 退出；**另一个进程** client B（PID 45908）追问答 `7`，sessionId/runtimePid/turns=2 全部一致。
2. **没有偷偷重启运行时**：跨 A→B 期间 `pgrep -f 'profile sd[k]'` 的 PID 集合恒为 `[136427,136450]`，status 的 daemonPid=136389 未变；守护日志 3 次 `client disconnected (runtimes kept alive)`。
3. **反证更强地成立**：我用**两个真正的 OS 进程**（不是同进程两个 SdkRuntime）复现 alive 与 stale：stale 下 A 已正常 close（exitCode 0）、运行时 137199 已消失、profile sdk 进程为 0，B（PID 137289、新运行时 137307）**仍**收到 `-32603 session "…" already exists` ⇒ "落盘 session 占用"结论正确，守护是唯一解。
4. **§6.4 误诊**：`bash -lc` 在本机**仍是 bash**（BASH_VERSION=5.2.37、ZSH_VERSION 未设、`$0`=bash、`export -p` 22 行 `declare -x`、0 行 `typeset -x`）；`SHELL=/usr/bin/zsh` 只是继承来的环境变量（~/.profile、~/.bashrc 无 zsh 跳转）。所以对 `lib/shell-env.js` 的影响**不存在**：其片段实测过滤出 21 行并打印"已注入登录 shell 环境"。glob 假 0 的**警惕**是对的，但机制是 bash 下 `ls 未匹配 | wc -l` 吞掉 rc=2，不是 zsh nomatch。
5. **新发现（必须修）**：**Windows 侧占端口是静默失败**。Windows 先占 8735 → WSL 守护照样 bind 成功、打印 `listening`、不退出；Windows 客户端却连到别的属主并挂死（6s 超时；默认 300s 就是 5 分钟假死）。反向（守护先占）Windows 才报 WSAEADDRINUSE。**守护自身无法发现**这种占用。
6. 其它：守护被 kill 后**无自动恢复**（只 ECONNREFUSED）；SIGTERM/SIGKILL **都不留孤儿运行时**（stdin 断开即退，无配额泄漏）。

**接进插件**——必须：①端口发现+**从 Windows 侧探活成功才算就绪**；②单实例复用/dispose 不杀守护/显式 stop+`wsl_status`；③版本对齐（守护 dsh 版本 vs `.desktop-version-pin`）；④token 鉴权（本机任意进程可 prompt/shutdown）；⑤客户端 hello 快速失败（别等 300s）。可选：idle 默认值对齐（守护 30min vs 插件 `idleTimeoutMs` 10min）、key 数量上限、结构化日志、无正文时 ok:false 的重试语义。

## 证据清单（原始输出文件均在 verify/）

| # | 项 | 关键原始数据 | 文件 |
|---|---|---|---|
| 1 | 重连 | A pid 32816 → `answer":"ACK"`, rt 136427；B pid 45908 → `answer":"7"`, 同 sessionId/rt, turns=2 | `out-reconnect.txt` |
| 2 | 无重启 | `before/after pids = [136427,136450,]`；status#1/#2 daemonPid 136389 | `out-reconnect.txt` |
| 3 | 反证(双进程) | alive: B(136726) `JSON-RPC -32603: session "verify-alive-…" already exists`；stale: A(137170) close exitCode 0、rt 137199 消失、pids=[]，B(137289) 仍 `-32603` | `out-conflict.txt` |
| 4 | 失败模式① | `{"ok":false,"error":"transport: ECONNREFUSED connect ECONNREFUSED 127.0.0.1:8739"}` exit 2 / 61ms | `out-failures.txt` |
| 5 | 失败模式② | WSL 侧：`FATAL listen error: listen EADDRINUSE: address already in use 127.0.0.1:8732`，exit 2 | `out-failures.txt` |
| 6 | 失败模式③ | 同 key 并发：两 client 都 ok:true，2458ms / 3527ms，turns=2，答案 AAA/BBB 未互踩 | `out-failures.txt` |
| 7 | 端口静默冲突 | Windows 先占：daemon `listening`（无错、存活），client `transport: timeout after 6000ms`；反向 Windows `WINDOWS_BIND_FAILED` | `out-port-collision.txt` |
| 8 | kill 语义 | `kill -s TERM`→无孤儿；`kill -s KILL`→无孤儿；client `ECONNREFUSED` | `out-kill.txt` |
| 9 | §6.4 复核 | `declare_x_lines=22 typeset_x_lines=0 bash_lc_BASH_VERSION=5.2.37 zsh_VERSION=<unset> snippet_filter_lines=21` + `已注入登录 shell 环境` | `out-shellenv.txt` |
| 10 | 坑5/6/7 | Start-Process：`["one","two","three"]` vs 手工加引号 `["one two","three"]`；`pgrep -f 'profile sdk'`=1（自匹配）vs `'profile sd[k]'`=0；简单函数 `param($args)` 静默得到 0 个参数 | 本报告上文 / 终端记录 |
| 11 | 收尾 | `profile_sdk_procs=0 daemon_procs=0 tmp_dsh=0 listen_873x=0`；Windows 8730-8740 无监听 | 终端记录 |

**与 task-1 报告不一致点**：§6.4 的 "bash -lc 落到 zsh" 及其对 `shell-env.js` 的连带担忧不成立（injection 实测成功）；§8 的"守护被 kill 后"已补测（无自动恢复、但无孤儿泄漏）；§7.3 的端口占用风险已升级为**已复现的静默失败**。

**最小可复现缺陷**：`verify/verify-port-collision.ps1` 情况 1（Windows 先占端口 → 守护"健康"但 Windows 客户端全部超时）。

无任何密钥/凭据被复制或写入；被验文件（daemon.mjs/client.mjs/sdk-runtime.mjs/run-spike.ps1/README.md/lib/）**零改动**。
