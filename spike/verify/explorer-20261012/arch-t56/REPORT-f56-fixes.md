# REPORT-f56-fixes.md —— T62：修 F56-1..4（+ 验证中发现的新缺陷 F56-5）

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-14 ｜ **任务**：`task-62`
- **写域**：**仅 `src/sdk-runtime.ts`**（`src/in-host-runtime.ts` 一行未动 —— 不需要动，见 §2 RC-1/RC-3 的说明）
- **未碰**：`client/**`、`in-host-runtime.ts`、`register-tools.ts`、`REVISION.txt`（漂移只报不改）
- **工具**：`arch-t56/tools/verify-f56.ts`（逐条真调断言 + `--mode red` 旧行为对照）
- **⚠️ 取证声明（并发提交）**：F56-1..4 的修复**已被别人的提交 `598543c` 扫进 HEAD**（`fix(host)+chore(tools)…T55/T56/T58/T57 证据`）。
  证据：`git show HEAD:src/sdk-runtime.ts` 里 `spawnFailure` / `startExited` / `#abortStart` / `closeOnPromptError` / `lastTurnError` / `exited:` **六项标记全为 True**；
  因此 `git diff --stat -- src/sdk-runtime.ts` 现在只剩 **3 insertions / 1 deletion**（= 我后来的 F56-5 调序）。**本次是我第三次遇到"工作树被并发提交扫走"**（前两次：`arch-t6` 报告、T45 的注记）。

## 1. 结论

**四条缺陷全部修掉，逐条真调证明**：`real 模式 7/7 PASS`（A1 错误可读 + A2 `/tmp` 增量 0 + A3 `exit=2` 与真因上行 + A4 无裸 `TypeError` + A5 RPC 失败后 `closed=true` + A6/A6b `close()` 显式 `exited` 且优雅关闭真的发出）。
**故意红成立**：副本恢复旧行为 ⇒ 恰好在 **A2** 变红并抓到泄漏文件 `/tmp/dsh-rwsl-26696-mv7kvdly-12145359.sh` ⇒ 断言有牙。
**回归全绿**：守护路径端到端 **19/19**（含 `stopDaemon` 在 SIGSTOP 下 `ok:false` + notes 的语义）、导出矩阵 **31**、文档护栏 **13**、`--dump-config` exit 0 / `Error:` 0。
**验证中新发现并修掉 F56-5**：`close()` 的优雅 `shutdown` **从来没发出去过**（先置 `closed` 再请求 ⇒ `request()` 立刻 reject）—— 已调序修好（`close()` 从 ~7s 降到 **8ms**，桩子进程确认收到并正常退出）。
**冻结漂移如实上报**：`revision.ps1 -Mode Check` ⇒ **锚点一致 = False ｜ 验证无效**，漂移文件两个（`src/register-tools.ts` 属 T47、`src/sdk-runtime.ts` 属我）。**我没改 `REVISION.txt`**，等 lead 重新冻结。

## 2. 根因分组（同根因合并修，不同根因分开改）

### RC-1（一个根因 ⇒ 同时修掉 F56-1 的**泄漏**、F56-3、以及 F56-1 的**一半错误掩盖**）
**根因**：`start()` **失败路径没有收尾、也没有收敛状态**。
- `spawn` 的 `'error'` 事件只把 `this.closed = true`，而 `close()` 见到 `closed` 就 early-return ⇒ **closeHook（宿主形态 = `reapWsl` + `removeScript`）永远不执行** ⇒ `/tmp/dsh-rwsl-*.sh` 永久残留（F56-1）；
- 同一处"`closed` 语义被混用"让**别的失败形态**（写脚本失败 / 超时 / 非零退出）既不置 `closed`、也不收尾 ⇒ 池的复用判据 `!existing.closed` 拦不住 ⇒ 同 key 再取拿回死运行时（F56-3）；
- 真实错误（ENOENT）只写日志、没有出口 ⇒ 调用方只能看到 `initialize 超时`（F56-1 的另一半）。

**改动**（`src/sdk-runtime.ts`）：
1. 新增私有 **`#abortStart()`**：`closed = true`（状态收敛）+ 关 stdin + 杀包装层/进程组 + 跑 `adapter.closeHook`（幂等、绝不抛）；
2. `start()` 用 `try/catch` 包住 spawn→接线→initialize，**失败即 `await this.#abortStart()` 再抛原错**；
3. `'error'` 事件把原始错误存进 `this.spawnError`，并用 `adapter.text.spawnError(key, message)` **回抛**（新增 `spawnFailure` promise 参与 `Promise.race`）。

> `closed = true` 同时**顺带修掉 F56-3 而无需改 `in-host-runtime.ts`**：池的复用判据就是 `existing && !existing.closed`，坏运行时会被自然驱逐、同 key 重取重建；即使被交回，`prompt()/request()` 也走"已关闭"的**友好文案**，不再是裸 `TypeError`。

### RC-2（F56-2，独立根因：**没有把"进程退出"当成 initialize 的失败信号**）
`start()` 只 `await request('initialize')` ⇒ 进程立刻 `exit 2` 也要等满 `initTimeoutMs`，且错误文案与真超时不可区分。
**改动**：新增 `exitedDuringInit = this.exited.then(...)` 参与 `Promise.race`，文案走**新增的** `text.startExited(code, tail)`（带 `exit=` 与 stderr 尾部）。

### RC-3（F56-4，独立根因：**失败的那一轮没有留痕，且宿主形态不收尾**）
**改动**：`#prompt` 把 `session/prompt` 的请求包起来 ⇒ 失败时 ① 记 `this.lastTurnError`；② 若 `adapter.closeOnPromptError` 则 `await this.close()`（状态与实际一致）；③ 原样重抛上游错误。
`closeOnPromptError` 的默认值：**`RUNTIME_PROFILE_DAEMON` = `false`（守护语义 #6 不变）**，**`runtimeAdapter()` = `true`（只被宿主 `in-host-runtime.ts` 使用 ⇒ 不需要改那个文件）**。
`close()` 的三处返回对象新增显式 **`exited: this.exitCode !== undefined`** —— 以前 `exitCode: null` 无法区分"退出码为空"与"3 秒内没等到退出"。

### RC-4（**F56-5，验证中发现的新缺陷**，不属 lead 列的 4 条）
`close()` 里 `this.closed = true` 写在 `request('shutdown')` **之前**，而 `request()` 见 `closed` 立刻 reject ⇒ **优雅关闭是死代码**（每一步都静默走 kill 路径）。这与 F56-4 的"状态与实际一致"同族，且修复成本极低。
**改动**：把 `this.closed = true` 移到 shutdown 请求**之后**（+3/−1）。
**实测**：桩子进程 + 守护形态适配器 ⇒ `close()` 用时 **8ms**（旧行为恒 ≥3s 且桩收不到 `shutdown`）、`{exitCode:0, exited:true}`（A6/A6b）。

## 3. 逐条验收证据（原始输出 `out-07-f56-real.*` / `out-08-f56-red.*`）

```
=== real（期望 7/7）===
[PASS] A1 F56-1 错误可读（不再伪装成超时） — Error: runtime spawn error key=k-B: spawn wsl.exe__t56c_nope__ ENOENT
[PASS] A2 F56-1 /tmp 增量 = 0（启动失败也收尾） — before=0 after=0 []
[PASS] A3 F56-2 真因 + exitCode 上行 — Error: runtime exited during initialize (exit=2): wsl: …（含 cwd 不存在）
[PASS] A4 F56-3 同 key 重取：明确报错或可用（无裸 TypeError） — getRuntime: Error: remote-wsl: 无法写入发行版 "__t56c_no_such_distro__" 的 /tmp（UNC … 不可用）…
[PASS] A5 F56-4 RPC 失败后状态一致 — Error: JSON-RPC -32603: stub boom  closed=true alive=false lastTurnError=JSON-RPC -32603: stub boom
[PASS] A6 F56-4 close() 显式回报 exited=true（真退出） — {"exitCode":0,"exited":true} closeMs=8
[PASS] A6b F56-5 优雅 shutdown 真的发出去了（不再是死代码） — close() 用时 8ms（< 1500ms）
模式 real：7/7 通过        real exit=0

=== red（副本把 start() 失败路径还原成旧行为：不调 #abortStart）===
[FAIL] A2 F56-1 /tmp 增量 = 0（启动失败也收尾） — before=0 after=1 ["/tmp/dsh-rwsl-26696-mv7kvdly-12145359.sh"]
模式 red：6/7 通过；失败：A2 F56-1 /tmp 增量 = 0        red exit=0（= 确认旧行为会被抓住）
```
（红测只对 F56-1 做「旧行为对照」；其余断言在副本里跑同一份**已修**代码，故在 red 模式下仍 PASS —— 这与 lead 的"可只对 F56-1/F56-2 做"一致。）

**回归（`out-09`/`out-10` 与终端原始输出）**
| 项 | 结果 |
|---|---|
| 守护路径端到端冒烟（真守护 slot 8911，arch-t3） | **19/19 PASS**，含 `C1 stopDaemon 在 SIGSTOP 下 ok:false` + `C3 explorer.daemon{stop}` 透传 `ok:false`+`notes[]`（T3 的硬约束未破） |
| `export-matrix.ts`（31 符号 / 严格面） | **PASS** |
| `check-docs-methods.ts`（13 断言） | **PASS** |
| `--dump-config` | **exit 0 ｜ 1291 行 ｜ `Error:` 0** |
| 收尾快照 | `live=[]`、`orphans=0`（守护已停，无残留） |

**冻结锚点校验（`revision.ps1 -Mode Check`，我只报不改）**
```
锚点一致 = False ｜ advisory 一致 = False      结论：**验证无效**（被验对象在验证期间发生变化）  exit=1
  - 22d854b47659312a…  18342  →  + def70698f20ba1f9…  23582  src/sdk-runtime.ts   ← 本次（T62）
  - b00b68ee0d5d91ba…  43546  →  + 5f15ac8d7a9587…  45356  src/register-tools.ts ← 上次（T47，已在 HEAD）
```
⇒ **P0.5.1 冻结已失效，需重新冻结**；`REVISION.txt` 我**未**改动。

## 4. 收尾与纪律

| 项 | 结果 |
|---|---|
| `src/` 改动范围 | **仅 `src/sdk-runtime.ts`**（`git status -- src/` 只列它） |
| `in-host-runtime.ts` | **未改**（F56-3 靠 `closed` 收敛在池的既有判据上解决 ⇒ 不撞 T60） |
| 隔离 DSH_HOME | `out-07/08` 与冒烟全程在 `%TEMP%` / 孤立 `DSH_HOME` 下；**用户全局 `workspace.json` sha 前后一致** `A764A306…F303A9` |
| WSL `/tmp` | 我造的脚本（含红测泄漏那个）**已清零**：`ls /tmp/dsh-rwsl-* | wc -l` = **0** |
| WSL 运行时 | `dsh/lib/bin.js` / `@deepseek-ai/dsh@` 残留 = **无** |
| 守护 / unit | `dsh-rwsl-8911.service` = `inactive`；`--failed` = 0；`systemctl reset-failed` rc=1（无失败单元可重置，如实记录）；状态目录仅 `daemon.log`/`launch-stderr.log` |
| Windows 包装层 | 父进程 = 我 的 `wsl.exe` 残留 = **0** |
| 端口 | 8911 / 8912 **free** |
| 宿主 | `19387` = pid **33688** 全程未碰 |
| **可见窗口** | 10 个（chrome×2 10:04/10:08 · Code 11:00 · Cursor 9:21 · DeepSeek Harness 9:21 · explorer 10:40 · msedge 10:48 · QQ 9:20 · TextInputHost 9:17 · Weixin 9:20）**全为用户应用 ⇒ 我方 0 窗口** |
| `%TEMP%` | 我建的副本/桩/临时项**已清零** |

## 5. 两栏

**【一旦错了就得返工】**
1. **`#abortStart` 改变了"启动失败"的后果**：以前失败后子进程/脚本可能继续存在（宿主形态留下 `/tmp` 脚本 + WSL 侧进程），现在**一律收尾**（`closed=true` + 杀包装层/进程组 + `closeHook`）。若哪个 caller 依赖"start 失败后还能复用同一个 rt 重试"，必须重审 —— 我逐个查过：`daemon.ts` 只在 `start()` 成功后设 `entry.runtime`；宿主池靠 `!closed` 自然重建。**这是本次唯一有行为外延的改动**。
2. **`closeOnPromptError` 的取值就是语义**：宿主 `true` / 守护 `false`。若有人把守护也改成 `true`，等于放弃语义 #6（一次请求失败就丢上下文）—— 必须 owner 明确拍板，别顺手改。
3. **F56-5 调序会让 `shutdown` 真的发出去**：真实 dsh 收到 `shutdown` 后的行为**此前从未被这条路径触发过**（一直是死代码）。若它收到后不退出，`close()` 会多等 3s（超时）——需要观察真实守护的关闭耗时是否变化。
4. **冻结已失效**：`src/sdk-runtime.ts` 与 `src/register-tools.ts` 双双漂移（后者是 T47 的）⇒ 在 lead 重新冻结前，任何"基于旧锚点"的验证都判无效。

**【其余的】**
5. F56-1..4 的修复**已在 HEAD**（被并发提交 `598543c` 扫走）；工作树只剩 F56-5 的 `+3/−1`。我如实记录取证，不重写历史、不重复提交。
6. `exited` 是**新增字段**（不改既有字段）；`daemon.ts` 只读 `runtime.exitCode`（属性）、`index.ts` 用 `Promise.allSettled` ⇒ 兼容风险低。
7. **平台事实**：`process.kill(-pid)` 在 Windows 无效 —— 本仓守护跑在 **WSL/Linux** 故正常；宿主形态走 `killMode:'wrapper'`（`child.kill()`）+ `reapWsl`，不受影响。这不是缺陷，我把它写进断言注释避免后人误判。
8. 红测只覆盖 F56-1（按 lead 允许）；F56-2/3/4 的"可红性"由它们各自的真调读数体现（A3/A4/A5 直接测的就是旧行为的反面）。

## 6. 未复核：5 条

1. **真实 dsh 对 `shutdown` 的响应**未被单独观测：A6/A6b 用的是**桩子进程**；守护冒烟 19/19 虽然覆盖了真实守护的 `stopDaemon`→退出，但**没有单独观测"运行时是否走了优雅关闭"**（守护形态由守护进程自己 close，我这边看不到回包）。
2. `#abortStart` 里杀**进程组**的那条在 **Windows 原生 node** 下无效（平台事实）；我只在 WSL/Linux 守护形态与桩子进程下验证过收尾效果，**未构造 Windows 原生守护**（本仓不存在这种形态）。
3. `closeOnPromptError` 只对宿主生效；**守护形态在 RPC 失败后仍保持 alive 是刻意的**（语义 #6）⇒ 该形态下"状态一致"的判据是"错误已上行 + `lastTurnError` 有值"，不是 `closed=true`。
4. **未跑 `selftest.ts` 全量**（它会在默认端口起真实例、且会 `stop all`）；本轮回归用 arch-t3 的 19 条冒烟替代。
5. A3 的 stderr 尾巴里混着 wsl.exe 的 NAT 提示（噪声）；我断言的是"300 字符窗口内含 `exit=2` 与 `cwd 不存在`"，**更长 stderr 下的截断行为未验**。
