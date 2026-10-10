# task-16 独立复验报告 — P1（per-call cwd）/ P2（活宿主 /tmp 收敛）+ 冻结纪律

- **revision**：开工与收尾两次对 `src/*.ts` 取 SHA256，**7/7 与 task-15 冻结清单逐一相同**（`REVISION.txt`；收尾断言 `FINAL_ALL_MATCH=True`）⇒ **所有结论基于同一 revision**。
- 夹具副本身份：开工时 `rwsl-test\lib\*.ts` 与 `src` **7/7 逐字节相同**；P0 闸门在跑前打印 7 行 MATCH（见 §4）。
- 写作用域 `spike\verify\fix3-20261010\`；被验文件零改动；端口只用 8841–8870（+ 跨宿主用例走 profile 默认 8731，收尾已停）；WSL 命令全走 base64→bash / 落文件+bash，**无内联**；未用全局 `pkill`；未删他人 `/tmp` 文件。

## 结论：P1/P2 + 竞态修复 + P0 闸门**全部独立通过**；lead 额外要的 (key,cwd) 语义判定为**显式可见且非破坏性**

### 1. P1 已修（确定性证据，不靠模型自述）
| 用例 | 原始输出 |
|---|---|
| 协议层 `cwd=/tmp` | `requested_cwd=/tmp daemonReportedCwd=/tmp session=remote-wsl-p1-e28e3386… turns=2 runtimePid=442810` ＋ **`/proc/442810/cwd=/tmp`** |
| 不传 cwd | `requested_cwd=(absent→守护 --cwd) daemonReportedCwd=/home/g` ＋ **`/proc/442885/cwd=/home/g`** |
| 守护元数据 | `keys` 里同一 key 出现两条：`{"key":"p1","cwd":"/tmp","session":"…e28e3386…","turns":2,"runtimePid":442810}` 与 `{"key":"p1","cwd":"/home/g","session":"…5cb5db4c…","turns":2,"runtimePid":442885}` ⇒ 身份确为 **(key,cwd)** |
| 工具层 `wsl_agent({cwd:'/tmp'})` | 远端 `pwd` 输出 **`/tmp`**，尾注 `cwd=/tmp … turns=1 runtimePid=443670` |
| **in-host 对照（未变）** | 返回 `backend=in-host cwd=/tmp`，且**新增**运行时进程 `pid=444261 /proc/444261/cwd=/tmp`、`pid=444295 /proc/444295/cwd=/tmp` |

### 2. P1 反例 — 跨宿主重连未被破坏（两个**真实** dsh 进程，同 key 同 cwd）
- 宿主#1（13.5→26.3s）：`backend=daemon session=remote-wsl-rh-1-d4af2eed-08e3-406a-9d2b-5a15d696a5c7 cwd=/home/g turns=1 runtimePid=448118 daemon=447887@127.0.0.1:8731`
- 宿主#2（另一个独立进程，34.1s）：正文 **`888`**，尾注 **同 sessionId / 同 runtimePid / turns=2 / cwd=/home/g** ⇒ 跨宿主重连仍然成立。

### 3. Lead 额外要求：(key,cwd) 语义必须**显式可见**
同一个 key `semk`，三次调用（三次都是独立进程）：
```
[1] cwd=/home/g  1 轮 ⇒ session=c4d83fb7… turns=1 runtimePid=443794 答 ACK（记住了 555）
[2] cwd=/tmp          ⇒ session=b1f59ca2… turns=1 runtimePid=443870 答「这次会话里没有更早的对话记录…我不能编一个给你」
[3] cwd=/home/g       ⇒ session=c4d83fb7… turns=2 runtimePid=443794 答 555
```
判定：**不是静默**。判据有三层：① sessionId 不同且尾注**每次都带 `cwd=`**；② 新会话 `turns` 从 **1** 起（旧的没串过来）；③ 换回原 cwd **恢复原会话**（同 sessionId、turns=2、仍记得 555）⇒ 切换**非破坏性**、旧上下文没丢。`semk` 两条目在 `keys` 里并存。
**UX 小意见（非缺陷）**：这个"换 cwd = 另一个会话"目前只在尾注字段里呈现，正文没有一句"⚠️ 你换到了新的工作目录，这是新会话"的叙述（实现里那句 ⚠️ 只在"请求的 cwd 与生效 cwd 不一致"时出现，而该情形现在不可能发生）。建议在 `cwd` 与 `(key,cwd)` 已在册时不额外提示，但在**首次为新 (key,cwd) 建条目**时给一句轻量说明。

### 4. P2 已修（三步计数 + 他人文件不动）
`own=2 对(winpid=35472) / foreign-alive=1 对(winpid=38652，本 pwsh 活着) / foreign-dead=1 对(999998)`：
- 第①步：10 个文件全在
- 第②步（**一次普通变更型调用** `wsl_exec echo` 之后）：`[dsh-rwsl-38652-foreignAlive.pid .sh]` ⇒ **own（linux pid 已死）已收敛、foreign-alive 原样保留、foreign-dead 被回收**
- 第③步：我自造对照文件全清 ⇒ 0
边界复核：**属主已死的他人文件会被回收**（我实测 999998 被清），这与 README:308 的记载一致（"属主活着的他人 winpid 文件一律不动；属主已死的他人文件仍按原判据回收"）——判为**合理且已文档化**：宿主已死 ⇒ 其会话按 §8 结构性结论**无法被任何宿主接管**，那个 linux 运行时就是占资源的孤儿；`sweepStaleRuntimes` 同时 `pkill -TERM -P`/`kill -TERM` 它并删文件，方向正确。**风险提示（既有设计，不是本轮回归）**：若"他人宿主已死但其 linux 运行时仍在为用户干活"，该调用会把它 TERM 掉——这是"孤儿 GC"的定义，但建议在 README 把"会被 TERM 的是运行时进程本身"写明（现在只说文件）。

### 5. 起停竞态已消失
连续 **5** 轮 `ensureDaemon → stopDaemon`：每轮 `stop.transport=shutdown ok=true`（7–8ms），**`transport=closed` 次数 = 0**（修复前偶发 `connection closed before reply`）⇒ `reapAllAndExit` 延后 250ms 关服务器/退出的修法有效。

### 6. P0 闸门"副作用前红"
故意给 `rwsl-test\lib\index.ts` 追加一行注释（污染后 75,593B）⇒ `test.ts` **exit=1 / 639ms**，打印
`[fixture] 副本比对 index.ts lib=1ccb232dfb864644 src=773d0aac8ec34f46 MISMATCH` ＋ `FAIL P0 前置：rwsl-test\lib\*.ts 必须与 vendor src\*.ts 逐字节一致（不一致：index.ts）`；
**现场计数改动前后完全相同**（`tmp=0 own_daemons=2`）⇒ 在任何 WSL 副作用之前就红了。随后恢复副本（SHA256 与 src 相同 = True）。

### 7. 回归
`test.ts` exit 0 / 9.1s（7/7 MATCH、6 工具、两轮答 7、warm ok）；`adversarial.ts` exit 0 / 78.6s（**32 PASS / 0 FAIL**，`Z4 … 第①步=6 第②步=6 第③步=0`）；真宿主 e2e exit 0 / 21.3s（导入错误 0）；`ADV_FORCE_FAIL=1` ⇒ exit 1。

### 8. 追加小项（机器行文档）
README `:124` 给出 `^machine: slot=(\S+) pid=(\S+) port=(\S+) version=(\S+)( .*)?$`，`:127` 注明"旧格式 `daemon=<pid>@<port>` 已废弃"；工具描述 `index.ts:1270-1272` 同款并附英文说明；P1 语义在 `index.ts:1145` 有描述。

### 9. 收尾
只做**逐槽位** `stop`（8841 回收 5 个运行时、8731 回收 1 个；**刻意不用 `all=true`**）；最终：无守护进程、8841–8870 无监听、`profile_sdk=[]`、`/tmp/dsh-rwsl-*` 空、state dir 只剩 `daemon.log launch-stderr.log`、pin 未变。观察项（如实记录）：两次 scoped stop 的机器行都报 `orphans_left=1`（存在一个无元数据守护），我按纪律**没有**用 `all=true` 去强收，最终现场为 0 个守护 ⇒ 该瞬时孤儿非我留下的足迹、也未被我强杀。
**收尾哈希断言 `FINAL_ALL_MATCH=True`** ⇒ 验证有效、同一 revision。

## 独立判断

- **P1 是"真支持"而不是"显式拒绝"**：`/proc/<runtimePid>/cwd` 双向证明 cwd 真生效（`/tmp` 与 `/home/g`），守护按 `entryId = key\0cwd` 分条目，返回值与元数据都带生效 cwd。代价是 key 空间多一维：**同 key 不同 cwd 各有一个队列**（`queueLimit` 是按条目的）——语义自洽，但"同 key 并发上限"实际是"每 cwd 上限"，文档宜点明。
- **没有新的自相矛盾**：跨宿主复用按 (key,cwd) 匹配 ⇒ 同 key 同 cwd 仍复用（我用两个真实宿主验证过）；`priorSessionFor(key,cwd)` 也按同一身份，所以"另一个 cwd 的会话"不会被误当成自己的（这正是 cwd 维度引入后必须同步改的地方，实现改到了）。
- **P2 判据不会误删他人的活文件**（我造了 foreign-alive 对照组，实测保留）；它**会**回收"属主已死的他人"文件与运行时，这符合既有孤儿 GC 语义且 README 已记载——建议把"连运行时一起 TERM"这点写进 README。
- 与 task-15 报告**无不一致**。唯一补充是上面那条"正文没有换 cwd 的叙述提示"的 UX 意见（尾注已足够判定，不构成静默）。

## 证据清单（`spike\verify\fix3-20261010\`）

| # | 项 | 文件 |
|---|---|---|
| 0 | 冻结 revision（开工/收尾 7/7 MATCH） | `REVISION.txt` |
| 1 | P1 确定性 cwd + 元数据两条目 + 工具层 pwd + (key,cwd) 语义（`RUN-P1: ALL CHECKS PASSED`） | `out-01-p1.txt`、`out-p1-a..g-*.txt` |
| 2 | in-host 对照 + P2 三步 + 起停 5 轮（`RUN-P2-RACE: ALL CHECKS PASSED`） | `out-02-p2-race.txt`、`out-p2-a..c-*.txt` |
| 3 | 跨宿主重连（两真实宿主，888 / turns=2） | `out-03a-host1.txt`、`out-03b-host2.txt` |
| 4 | P0 闸门副作用前红 + 恢复 + 回归四项（`RUN-REG3: ALL CHECKS PASSED`） | `out-04-regression.txt`、`out-04a..e-*.txt` |
| 5 | 收尾哈希断言 `FINAL_ALL_MATCH=True` | 本报告 §9 ＋ 终端记录 |

**无密钥外泄。**
