# REPORT-daemon-residuals.md —— T67：daemon 域残余三条（legacy / remaining / 连续两次 --all）

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-14 ｜ **任务**：`task-67`
- **写域**：`spike/verify/explorer-20261012/arch-t58/`（**追加**：`tools/daemon-residuals.ts` + `out-0[1-5]-residuals-*` + 本报告）；**未改 `src/**`**；T58 既有产物一个没动
- **端口**：按 lead 修正只用 **8915–8918**（T66 用 8911–8914、T69 用 8919–8922）
- **隔离原理**：`stateDirLinux(cfg) = ${cfg.wslHome}/.dsh/remote-wsl`，且 `scanDaemonProcesses` 只认 cmdline 里带 `--state-dir <该目录>` 的进程 ⇒ 把 `wslHome` 指到 `/tmp/t67-*` 就另开一个世界，**真实 `~/.dsh` 里别人的守护既不会被停、也不会被算进 `remaining`**。

## 1. 结论

**三条全部构造成功、逐条有原始读数**：① **legacy 单文件记录**被识别（`legacy=true`、`port=8915`）→ 被 `stop --all` 停掉 → `daemon.json`/`daemon.token` 被清 → 身份扫描为空；② **`remaining>0 ⇒ ok:false`** 用 SIGSTOP 造出（兜底 `killWslPid` **只发 TERM**）⇒ `ok:false` + `remaining:[{pid,port,metaPort}]` + `stopped[].error` 可读（含 `alivePids`）+ `explorer.daemon{stop}` **透传** `ok:false` 与 `notes`；③ **连续两次 `--all`**：第二次是空集且 `{ok:true, stopped:0, killed:0, remaining:0}`（无副作用），并**重建两个最小 iso 目录**（各一守护）各收干净 + 第二轮循环可重复。
**最终一轮 21/21 PASS**（孤立 `DSH_HOME` 下）。**故意红成立**：副本把 `stopAllDaemons` 的 `ok` 硬编码 `true` ⇒ 2.1 变红；副本与真实现**逐字节相同**（`4f8db039…`）时 8/8 复绿。`--dump-config` exit 0。
**⚠️ 我在本任务里踩了一次纪律缝并自证**：分支 2 的 `idx.apply()` **没先隔离 `DSH_HOME`** ⇒ 改写了用户全局 `~/.dsh/storages/workspace.json`（详见 §5，含三次改写与我的三次运行 1:1 对应、以及"隔离后不再变"的对照）。

## 2. 分支 1：legacy 单文件记录（`daemon.json` / `daemon.token`）

种法：在孤立世界 `/tmp/t67-legacy` 里真起一个守护（port **8915**），再把**槽位记录降级**成 legacy 单文件记录
（`cp daemon.8915.json daemon.json && cp daemon.8915.token daemon.token && rm -f daemon.8915.*`）—— 等价于"老版本留下的单文件记录 + 进程还在"。

```
[PASS] 1.1 孤立世界里起了真守护 — {"ok":true,"slot":8915,"pid":406956,"mode":"systemd"}
[PASS] 1.2 legacy 记录被识别 — {"legacy":true,"slot":8915,"port":8915,"hasToken":true}
[PASS] 1.3 元数据在 + 进程在（身份扫描看得见）— [{"pid":406956,"port":8915,"metaPort":8915}]
  种 legacy 前：槽位文件 daemon.8915.json=253B、daemon.8915.token=64B
  种 legacy 后：daemon.json=253B、daemon.token=65B（槽位文件已删）
  (stop) daemon shutdown on slot 8915 (port 8915): ok=true
[PASS] 1.4 stop --all 认出并停掉了 legacy 守护 — {"ok":true,"stopped":[{"ok":true,"slot":8915,"port":8915}],"remaining":0}
[PASS] 1.5 legacy 文件被清 — after=[60 .. | 676 daemon.log | 676 launch-stderr.log | 80 .]   ← daemon.json / daemon.token 都不在了
[PASS] 1.6 进程真的没了（身份扫描为空）— []
```
⇒ 清理路径 `removeMetaFiles(cfg, rec.slot, rec.legacy)` 对 `legacy` **确实**走的是单文件那两个（`daemon.json`/`daemon.token`），且**先复核再删**（P1 规矩）：`waited → survivors 空 → 才 removeMetaFiles`。

## 3. 分支 2：`remaining>0 ⇒ ok:false`（SIGSTOP 造"杀不死"）

构造依据（实现事实）：哨兵 `stopDaemon` 的兜底 `killWslPid` **只发 `kill -TERM`**，而 **SIGSTOP 的进程不会处理 TERM** ⇒ `waitForSlotGone` 超时 ⇒ 幸存者留下 ⇒ `scanDaemonProcesses` 仍看得见 ⇒ `stopAllDaemons` 的 `remaining` 非空。

```
SIGSTOP 后进程状态：PID 408595 Tsl      ← T = stopped
(stop) daemon shutdown on slot 8916 (port 8916): ok=false 守护调用失败(timeout): no reply within 5000ms
(stop) stop 未完成：槽位 8916（端口 8916）仍有本方守护 pid=408595 ⇒ 按 P1 保留元数据（不制造隐形孤儿）
[PASS] 2.1 SIGSTOP 后 stop --all 判 ok:false — ok=false
[PASS] 2.2 remaining 非空且带 pid/port — [{"pid":408595,"port":8916,"metaPort":8916}]
[PASS] 2.3 可读原因 — alivePids=[408595]
        reason=remote-wsl: stop 未完成：槽位 8916（端口 8916）的本方守护进程仍在（pid 408595）。已按 P1 规矩**保留元数据** daemon.8916.json ⇒ 它仍是**可发现**的（wsl_status / snapshot.daemon 会报出来，也可再次 stop）；没有变成"元数据已删、进程还在"的隐形孤儿。
```
**完整 JSON（`stopAllDaemons` 返回）**：
```json
{"ok":false,
 "stopped":[{"ok":false,"port":8916,"slot":8916,"pid":408595,"version":"0.2.0-rc.2","reaped":[],
             "transport":"timeout","alivePids":[408595],"error":"remote-wsl: stop 未完成：槽位 8916（端口 8916）的本方守护进程仍在（pid 408595）。…"}],
 "killed":[{"pid":408595,"port":8916,"metaPort":8916}],
 "remaining":[{"pid":408595,"port":8916,"metaPort":8916}]}
```
**调用方透传（`explorer.daemon{action:'stop', slot:8916}`，HTTP 200）**：
```json
{"action":"stop","ok":false,"idempotent":true,"alreadyStopped":false,"slot":8916,"port":8916,
 "pid":408595,"version":"0.2.0-rc.2","reaped":0,
 "notes":["remote-wsl: stop 未完成：槽位 8916（端口 8916）的本方守护进程仍在（pid 408595）。…（P1 保留元数据…）"]}
```
```
[PASS] 2.5 解除 STOP（CONT + KILL）后 stop --all 收干净 — {"ok":true,"remaining":0,"stopped":1}
```
⇒ 失败面**没有**回退到 T26/T30 前的"硬编码 ok:true / 只取 note"（`explorer.ts` 的 `ok: r.ok !== false` + `notes:[note,error]` 正确生效）。

## 4. 分支 3：连续两次 `--all` + 重建最小 iso 目录（可重复性）

```
[PASS] 3.1 第二次 --all 是空集且 ok:true — {"first":{"ok":true,"stopped":0},
                                          "second":{"ok":true,"stopped":0,"killed":0,"remaining":0}}
[PASS] 3.2 /tmp/t67-iso-a 起守护（port 8917）— {"ok":true,"pid":413988,"slot":8917}
[PASS] 3.2 /tmp/t67-iso-b 起守护（port 8918）— {"ok":true,"pid":414482,"slot":8918}
[PASS] 3.3 /tmp/t67-iso-a stop --all 收干净 — {"ok":true,"remaining":0}
[PASS] 3.3 /tmp/t67-iso-b stop --all 收干净 — {"ok":true,"remaining":0}
[PASS] 3.4 第二轮循环可重复（重建 → 停 成功）— {"ensureOk":true,"stopOk":true}
```
⇒ **重建 + 连续调用可重复**；第二次 `--all` 无副作用（`stopped`/`killed`/`remaining` 三项皆空）。

## 5. ⚠️ 纪律事件（自证）：我用**未隔离的 `DSH_HOME`** 碰了用户全局 workspace.json

**事实链（不接受"我可能没碰"的自我安慰）**
| 时间 | 事件 | 读数 |
|---|---|---|
| 15:08（任务开始） | 基线 sha | `DCE16CFB…` |
| **15:10:50** | **我的 T67 首轮 real 运行**（分支 2 调 `idx.apply()`，**未设 `DSH_HOME`**） | sha → `0AC5208C…`，**CreationTime == LastWriteTime == 15:10:50** ⇒ 文件被**重建**（非原地追加） |
| **15:15:03** | **我的红/绿两轮**（同样未设 `DSH_HOME`） | sha → `A1B6D08D…`，size `11614 → 11672`（+58 B），条目数两次都是 **3** |
| 受控实验 | 孤立 `DSH_HOME` 下跑 `apply()` + `explorer.snapshot` | sha **前后完全相同** ✓ |
| **15:2x 最终轮（已修）** | `ISO-3` 断言：孤立 `DSH_HOME` + 前后比 sha | `before=a1b6d08d… after=a1b6d08d…` ✓ **未变** |

⇒ **三次改写与我的三次"未隔离"运行 1:1 对应，隔离后不再变** ⇒ 成因确定是我的 harness，不是别人。
**影响**：条目数未变（3），但 size +58 B ⇒ **内容确有变化（很可能只是每条目的时间戳字段被刷新），但我没有基线副本，无法证明条目级等价** —— 按纪律必须如实标为"无法证明等价"。
**已修（在写域内）**：`arch-t58/tools/daemon-residuals.ts` 现在在**任何 `import src/**` 之前**就把 `DSH_HOME` 指到 `%TEMP%\t67-dsh-home-<pid>`，并把"用户全局 workspace.json 前后 sha 相同"作为 **ISO-3 断言**（最终轮 21/21 已含此项）。
**未修（不在我写域，需 lead 派单或授权）**：**`spike/verify/explorer-20261012/arch-t3/tools/smoke-e2e.ts` 有同样的缝** —— 它 `import src/index.ts` + `apply()` 而**从不设 `DSH_HOME`**；T62 我拿它做守护路径回归时（≈11:56）很可能就是 `A764A306… → DCE16CFB…` 那次改写的原因。**在修好之前不要复用它。**

## 6. 故意红 / 复绿 / `--dump-config`

```
[红测] 副本变异：stopAllDaemons 返回行 ok 硬编码 true
[sha] 红测（应变） 副本=94da960ca0dfb279 真实现=4f8db0399af0f567 ⇒ 逐字节相同 = false
[FAIL] 2.1 SIGSTOP 后 stop --all 判 ok:false — ok=true        ← 断言有牙
模式 red：7/8 通过；失败：2.1        red exit=0（= 已确认能红）

[sha] real（应还原一致） 副本=4f8db0399af0f567 真实现=4f8db0399af0f567 ⇒ 逐字节相同 = true
模式 real：8/8 通过        green exit=0
```
`--dump-config`：**exit=0 ｜ 1291 行 ｜ `Error:` 0**。
> **为什么红的形态选"`ok` 硬编码 true"而不是"放宽只停自己 state 目录"**：后者会去读 `~/.dsh` 并**停掉别人的守护**（`listDaemonSlots` 会列出真实世界的槽位），违反本任务的最高纪律。⇒ 我改用**等价但零副作用**的旧缺陷形态（`ok:true` 硬编码），并用 **ISO-1/ISO-2** 正向断言把"只停自己 state 目录"这条性质钉住（真实目录前后一致 + 真实世界 scan 前后都是 `[]`）。

## 7. 隔离核对与收尾

| 项 | 结果 |
|---|---|
| **真实 `~/.dsh/remote-wsl`** | 前后一致：`98892 daemon.log ｜ 107975 launch-stderr.log`（**无 `daemon.*.json`** ⇒ 当时没有他人守护在跑） |
| **真实世界身份扫描** | before `[]` / after `[]` ⇒ **没碰任何他人守护** |
| T60 的目录 | `/tmp/t60-once-8916` **原样未动** |
| 孤立世界 | `/tmp/t67-legacy｜remaining｜iso-a｜iso-b` 全部删除；`%TEMP%\t67-*` = 0 |
| 我的 unit | `dsh-rwsl-8915/8916/8917/8918` 全 `inactive`；`reset-failed` rc=1（**无失败单元**）；`--failed` = 0 |
| 我的守护进程 | `daemon.ts … --state-dir /tmp/t67*` = **none** |
| 端口 | 8915 / 8916 / 8917 / 8918 **free** |
| 宿主 | `19387` = pid **33688** 全程未碰；Windows 侧"父进程 = 我"的 `wsl.exe` 残留 = **0** |
| **可见窗口** | 9–10 个，全为用户应用（chrome×2 10:04/10:08 · Code 11:00 · Cursor 9:21 · DeepSeek Harness 9:21 · gephgui 13:33 · QQ 9:20 · TextInputHost 9:17 · Weixin 9:20）⇒ **我方 0 窗口** |
| `/tmp/dsh-rwsl-*` 残留 | **1 个不是我的**：`dsh-rwsl-43544-mv7s0xld-e2ab027a.sh`（无 `t67` 标记；`.pid`=445564 正跑 `sleep 120`）⇒ **未删**（不能凭"像我们家的脚本"就删别人的） |

## 8. 两栏

**【一旦错了就得返工】**
1. **纪律**：凡在进程内 `import src/index.ts` / `apply()`，**必须**先设孤立 `DSH_HOME` 并**前后比 sha**。我这次没设，碰了用户全局 `workspace.json`；**`arch-t3/tools/smoke-e2e.ts` 同病且未修**（不在我写域）⇒ 修好前别复用。这是本任务唯一的真实副作用。
2. **分支 2 的构造依赖一条实现事实**：兜底 `killWslPid` **只发 TERM**。若将来它改成 TERM+KILL，"SIGSTOP 造 remaining" 就失效，该分支只能改靠"身份闸拒杀"来构造。
3. **`remaining` 是身份扫描结果**（`/proc` + `--state-dir <本 state 目录>`）⇒ 隔离性完全取决于 `wslHome`。**别把 `wslHome` 配成与别人相同的目录**，否则两边会互相"看见"并互相停。
4. **用户全局 `workspace.json` 的条目级等价性我无法证明**（无基线副本）；只能给 sha 时间线 + size/条目数。请 owner 确认那 3 个条目是否仍是期望值。

**【其余的】**
5. legacy 分支用"槽位记录降级"来种，等价于真 legacy 安装；实测清理走单文件那两个 ✓。
6. `explorer.daemon{stop}` 的失败面透传**没有回退**（`ok: r.ok !== false` + `notes:[note,error]`）。
7. T58 既有产物（`probe-t58.ts`、`REPORT-stopall-semantics.md`、`out-0x-*`）**一个没动**，本次只追加。
8. 红测形态刻意选零副作用的那种（见 §6 末注），并保留"只停自己 state 目录"的正向断言（ISO-1/ISO-2）。

## 9. 未复核：5 条

1. **用户全局 `workspace.json` 条目级等价性**未证（无基线副本）；只能给 size `11614→11672`、条目数 3、以及三次改写的时间相关性。
2. **未构造"真·不可杀"**（如 D 状态 / SIGKILL 也无效）：SIGSTOP 只证明"TERM 无效"这一条路径，不等于 KILL 无效。
3. **未跑 `wsl_daemon action=stop all=true` 的工具面**（只验了 `explorer.daemon{stop}` 的透传；工具面在 `register-tools.ts`，属他人域）。
4. **legacy 记录是我"手工降级"造的**，未用真实老版本 daemon 写出的 legacy 文件（字段可能有差异，例如缺 `metaPort`）。
5. `/tmp/dsh-rwsl-43544-*` 的归属只靠"无 `t67` 标记 + `.pid` 指向 `sleep 120`"推断 ⇒ **未做更强归属取证**（cgroup / 父链），所以**没删**它。
