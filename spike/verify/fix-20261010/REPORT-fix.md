# task-11 独立复验报告 — task-9/10 的修复（spike-verify）

写作用域：`spike\verify\fix-20261010\`（probe2.ts / run-concurrency.ps1 / out-01..10）。被验 `src\*.ts` 零改动；`rwsl-test\lib\*.ts` 与 src **7/7 SHA256 相同**（夹具确实在验交付物）。

**工具协议（重要，已自查）**：`wsl.exe … -- bash -c "<内联>"` 实测被发行版登录 shell 接管 —— 内联 `i=5; echo i=$i` 打出 `i=`、`for d in /proc/[0-9]*` 打出空计数（假绿）。我全程用 **base64→bash** 或 **落文件+bash file**（probe2 的 `wslRunScript`/`--script-b64`），无一处内联。同时确认 `pgrep -f "--port N "` 恒空（pattern 以 `-` 开头），身份一律用 `--state-dir /home/g/.dsh/remote-wsl` 判据。

## 结论（≤450 字）

**task-9 的两个根因修复与 task-10 的四条产品级缺陷，我逐条独立复现，全部通过；另发现 1 个真缺陷 + 2 个小问题。**

1. **槽位竞态已修**：两个独立进程并发起 8861/8862 ⇒ **恰好 2 个守护**（pid 329311/329300），各自 `--launcher launch.<slot>.sh`；元数据 `daemon.8861.json port=8861`、`daemon.8862.json port=8862`，实际监听恰为 `:8861 :8862`；**无无元数据守护**。`stop all=true` 后 procs/listen/元数据全空 = **零孤儿**。
2. **寿命闸门有效**：`linger-ms=9000`、无 key 无客户端 ⇒ 守护 **9308ms 自退**，procs/slots 均空。**孤儿回收**：删掉 8864 的元数据造孤儿（pid 333955 仍占端口）⇒ ensure 先收孤儿、**仍在请求槽位 8864** 起新守护（`port==slot=true orphanGone=true exactlyOne=true`）。`stop all=true` 对 8865 孤儿：`killedOrphans=1 remainingOrphans=0`。
3. **漂移报警**：`dshVersion:'0.1.0-fake'` + 守护 0.2.0-rc.2 ⇒ `daemon drift: ⚠️ … 与 **显式 config.dshVersion** 0.1.0-fake 不一致`；默认配置无此行。
4. **实际端口**：正常 `actualPort=8864 slot=8864`；回退场景（Windows 占 8867）⇒ `configured=8867(+3 回退) actual=8868 slot=8868`，且日志证明**回退槽位自己的 launch.8870/8871.sh 真的被执行**（spawn 路径与写入路径已一致）；三端口全占 ⇒ **14.3s** 可读报错、无残留守护/无 launcher 残留。
5. **文本/机器行**：全部输出中**不再出现裸 `daemon.json`**（改为 `daemon.<slot>.json`）；`machine:` 行在 start/status/stop/stop-all 四种动作下都有，正则可解析（但字段语义随动作变化，见 F3）。
6. **`wsl_open_ui` 的 /tmp**：open+stop 一轮后 `/tmp/dsh-rwsl-*`=0；造一个属主 winpid=999999（已死）的残留 ⇒ 下一次有副作用的 `wsl_exec` 后 =0（声明的 sweep 语义成立）。
7. **回归**：`test.ts` exit 0；`adversarial.ts` **30 PASS / 0 FAIL**（77s），其中 D1 用 `daemonIdleMs=15000` + 私有 state-dir/端口，断言 keys→0、**runtimePid 被回收**、新 sessionId、并检查"必须明确告知重置"；D2 覆盖 in-host 旧语义。**故障注入 `ADV_FORCE_FAIL=1` ⇒ exit 1 / 4 FAIL**（证明断言非假绿）。真实宿主 e2e exit 0，模型原样贴出 `daemon: pid=340100 actualPort=8731 slot=8731 version=0.2.0-rc.2` + `machine: daemon=340100@8731 version=0.2.0-rc.2 keys=1 orphans=0`。
8. **task-10 ③④**：不带 slot 的 `stop` **只停自己槽位**（8862 的守护活着，未被误杀）；soft `idleMs` 不一致 ⇒ `reused=true` + `configSoftMismatch=["idleMs 1800000≠1923456"]` + "未静默忽略"提示；hard `cwd` 不一致 ⇒ `ok=false` + 结构性不兼容报错（含两个值）。
9. **收尾**：`profile_sdk=[]`、`daemon.ts=[]`、87xx/88xx 无监听、`/tmp/dsh-rwsl-*`=0、state=`[daemon.log launch-stderr.log]`（= 基线）、pin=`0.2.0-rc.2` ⇒ **基线差值 0**。

## 发现（最小可复现）

**F1【真缺陷·小】不带 slot 的 `stop` 把"别的槽位**健康**守护"误报成"无元数据孤儿"。**
`index.ts:1289` 用 `scanDaemonProcesses(config)`（**未**按 livePid 过滤），而 `daemon-client.ts:752` 用的是正确式 `filter(p => !livePids.has(p.pid))`。实测：8861/8862 两守护都在、`daemon.8862.json` 存在且握手 4ms 正常，执行 `wsl_daemon action=stop`（无 all）后输出
`Orphans: ⚠️ 仍有 1 个守护在跑但无元数据（pid329300@8862）—— 用 action=stop all=true`。
危害：用户照此建议执行 `stop all=true` 会**杀掉另一个宿主正在用的守护**（上下文丢失），且诊断本身不成立。修法：该行改用 livePid 过滤（与 daemonStatus 对齐）。证据 `out-01-concurrency.txt`。

**F2【小】`adversarial.ts` 的 Z3 标签大于其实际检查范围。**
Z3 文案"夹具私有状态目录已清理（/tmp 无自建残留）"（`adversarial.ts:569`），实际只检查 `/tmp/rwsl-adv-<pid>*`；它自己的 D2 in-host 运行时与 E 的 WebHost 会留下 `/tmp/dsh-rwsl-<winpid>-*.sh/.pid`（我跑两轮后实测 4 个，属主 winpid 9840 已死；由产品的 sweep 清掉）。⇒ 夹具自述的"零 /tmp 残留"不成立，且该残留只能靠产品 sweep 收敛。

**F3【小】`machine:` 行字段语义随动作变化。** start/status 用 `daemon=<pid>@<port>`，而不带 slot 的 stop 用 `daemon=<slot>@<port>`；且 stop 的 `version=-` 恒为空。正则可解析，但同一 key 含义不同会让调用方误读；建议 stop 也写 pid（或统一为 `slot=… pid=… port=…`）。

**F4【观察·非缺陷】`wsl_status` 的 "pid files in WSL /tmp" 仍走内联 `bash -lc`（`index.ts:942`）。** 该命令恰好对 zsh/bash 都给出同一结果（未匹配 glob + `2>/dev/null` + `wc -l`），所以**没有**假数；但它是本次实测"内联被登录 shell 接管"的高危形态，建议统一改走落文件。

## 独立判断（item 9）

- **两个根因都修在正确层面**：按槽位分文件 + spawn 与写入同 port + stderr 落文件 + 失败路径删自己 launcher；起之前按 `/proc` **身份**扫占位者，有元数据则复用、无元数据则先收再在同槽位起。**没有"只改文本不改行为"**：①port==slot ②无影子 ③stop 隔离 ④soft/hard 兼容四条我都拿到了行为级证据；漂移报警也确实从"只比 desktop/pin"改成"含显式 dshVersion"（我上次正是拿 `dshVersion` 证伪的）。
- **新增复杂度可接受**：槽位键文件 + 兼容矩阵 + 孤儿回收各自对应一个已复现故障；上一轮我指出的"槽位元数据 × 全局单份 launch.sh"自相矛盾已消除。唯一新引入的自相矛盾是 F1（同一"孤儿"定义在 stop 文本里未复用 daemonStatus 的正确算法）。
- **寿命闸门默认 600000（10 min）合理**：闸门前提是 `keys==0`（我实测无 key 才自退）⇒ 不会静默丢活跃会话；与 `daemonIdleMs`(30 min) 的组合是"先回收运行时、再退守护"，逻辑自洽。**但**仍有缺口：某个槽位的孤儿若再也没被任何宿主定位到，只能靠 `stop all=true` 显式回收（status/wsl_status 会报警，但无自动 GC）。
- **残余风险**：`stop all=true` 会连带杀掉**其他宿主**正在使用的守护（设计如此，但工具描述需更醒目；F1 又会误导用户去用它）。

## 证据清单

| # | 项 | 关键原文 | 文件 |
|---|---|---|---|
| 1 | 并发两槽位 | 2 进程 ⇒ pid 329311@8861 / 329300@8862，`metaPorts={8861:8861,8862:8862}`，listen=`:8861 :8862`，各自 launcher | `out-01-concurrency.txt` |
| 2 | stop all ⇒ 0 孤儿 | `machine: daemon=all … orphans_killed=1 orphans_left=0`；procs/listen/meta 全空 | `out-01-concurrency.txt`、`out-04c/04d` |
| 3 | 寿命闸门 | `gone=true elapsed=9308ms`（lingerMs=9000），procs=[] slots=[] | `out-02a-linger.txt` |
| 4 | 孤儿回收（同槽位） | 孤儿 333955 ⇒ 新守护 334384；`port==slot=true orphanGone=true exactlyOne=true` | `out-02b-reclaim.txt` |
| 5 | 漂移报警 | `daemon drift: ⚠️ … 与 显式 config.dshVersion 0.1.0-fake 不一致` | `out-03-drift.txt` |
| 6 | 实际端口/回退 | `configured=8867(+3 回退) actual=8868 slot=8868`；8870/8871 各自 launcher 被清理 | `out-05a/05b/05c` |
| 7 | 文本/机器行 | 全部输出无裸 `daemon.json`；`machine:` 4 种形态 | 全目录 grep |
| 8 | /tmp 语义 | openui 后 0；fake 999999 残留 ⇒ sweep 后 0 | `out-06a..06f` |
| 9 | 回归 | test.ts exit0；adversarial **30 PASS/0 FAIL**；FORCE_FAIL ⇒ exit1/4 FAIL；真宿主 e2e `actualPort=8731 slot=8731 … orphans=0` | `out-07a..07d` |
| 10 | 兼容性 | soft `configSoftMismatch=["idleMs 1800000≠1923456"]`；hard cwd ⇒ ok=false + 结构化报错 | `out-08-compat.txt` |
| 11 | 收尾 | `profile_sdk=[] daemons=[] listeners=[] tmp=0 state=[daemon.log launch-stderr.log] pin=0.2.0-rc.2` | `out-09b-final.txt` |

**基线（我开工时采样）**：`profile_sdk=[]`、`listeners_88xx=[]`、`state=[daemon.log launch-stderr.log]`、`tmp=0`、`pin=0.2.0-rc.2` ⇒ 收尾与之**逐项相等**。纪律：未用全局 `pkill`（一律 `/proc/<pid>/cmdline` 验身份）；未删非我创建的 /tmp 文件（实测 4 个属我 adversarial 运行、属主已死，交产品 sweep 清理，前后计数已给）；报告无密钥。
