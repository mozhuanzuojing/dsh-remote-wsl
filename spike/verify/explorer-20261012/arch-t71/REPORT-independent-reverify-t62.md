# REPORT —— T71：**独立复验** T62（F56-1..5）

> 复验者：`host-explorer`（**未参与 T62**，独立性成立）。写域：`arch-t71/`（**`src/**` 一个字节未改**：`git status --porcelain -- src/` = 0 条）。
> 方法：**自写探针** `probe-f56.ts`（不照抄作者脚本）⇒ 在 **pre-fix 树**上拿"缺陷签名" ⇒ 在 **HEAD** 上用**同一构造**确认 ⇒ 一次人为破坏（红）⇒ 冻结复算。

## 总结（五条结论 + 两处基线更正）

| # | 独立判定 | pre-fix 读数（我复现） | HEAD 读数（同一构造） |
|---|---|---|---|
| **F56-1①** | ✅ **确认修复（强）** | `"initialize timeout after 120000ms"`，**ms=120013** | `"runtime spawn error key=t71-enoent: spawn __no_such_exe_t71__ ENOENT"`，**ms=12** |
| **F56-1②** | ⚠️ **我的构造下不可判定**（不是"证伪"） | `/tmp` 全局增量 **+1** | `/tmp` 全局增量 **+1**；`closeHook 调用次数=1`、`closed=true` |
| **F56-2** | ✅ **确认修复** | `"remote-wsl: initialize 超时"`（真因丢失） | `"runtime exited during initialize (exit=2): <stderr 尾>"` |
| **F56-3** | ⚠️ **缺陷签名未复现**；修复后行为更好（确认） | 第 2 次同 key 拿到对象 → `prompt()` = `"Error: remote-wsl: session/prompt 超时"`（可读，**非**裸 TypeError） | 第 2 次同 key **立刻**给出真因 `runtime exited during initialize (exit=2)` ⇒ 不再复用坏对象 |
| **F56-4** | ✅ **确认修复** | `closed=false alive=false exitCode=null lastTurnError=null`（状态与实际**不一致**） | `closed=true alive=false lastTurnError="session/prompt timeout after 60000ms"`（**一致**） |
| **F56-5** | ⚠️ **调序缺陷读码成立；但 `~7s→ms` 耗时差未复现** | `close()` = **43ms**，frames=1 | `close()` = **47ms**，frames=2 |

**基线更正（重要）**：Lead 给的 pre-fix = `815f2c8^` **只对 F56-5 成立**。实测：
- `815f2c8` 对 `src/sdk-runtime.ts` 只有 **3 增 1 删** = 把 `this.closed = true` 从 `request('shutdown')` **之前**挪到**之后**（+注释）⇒ **F56-5**。
- 但 `815f2c8^` 的该文件里 **已有** `#abortStart` / `exitedDuringInit` / `lastTurnError` / `closeOnPromptError` / `spawnError` ⇒ **F56-1..4 不在这个提交里**。
- 追提交史：F56-1..4 的 **+103/−31** 落在 **`9c5829a`**，而它的提交标题写的是 *"test(T61): probe-copy-detect 根因修复"* —— **标题与内容不符**（运行期语义改动伪装成测试改动）。
- ⇒ 我的 F56-1..4 pre-fix 基线取 **`9c5829a^`**（= `598543c`，`src/sdk-runtime.ts` 438 行），F56-5 取 **`815f2c8^`**（510 行）；两棵 pre 树差 **134 行**，与上面对得上。

## 关键原始读数

**F56-1（spawn ENOENT，构造：宿主 adapter + 不存在的可执行名 `__no_such_exe_t71__`；脚本已由 `writeScript` 落到 `/tmp` 才问得到残留）**
```
[PRE ] F56-1 err="initialize timeout after 120000ms" ms=120013  含 ENOENT=false  伪装成超时=true
[HEAD] F56-1 err="runtime spawn error key=t71-enoent: spawn __no_such_exe_t71__ ENOENT" ms=12
       F56-1 含 ENOENT=true 伪装成超时=false
       F56-1 closeHook 调用次数=1 closed=true
```
⇒ **①确认**：从"等满 120s 后报一个假超时"变成"12ms 报出真因 ENOENT"（快 1 万倍）。
⇒ **②不可判定**：`/tmp` 是**全局计数**（`ls /tmp/dsh-rwsl-* | wc -l`），而本轮 `%TEMP%`/WSL 上**有其他 teammate 在并发写**（同一秒内 before=8→9、9→10）。`closeHook 被调=1` 说明收尾路径**走到了**；我把 hook 内部顺序改成 `removeScript` 先执行并各自 try 之后**增量仍是 +1** ⇒ 这 +1 **无法归到我这个进程**。⇒ 我**不**下"残留未修"的结论，只记"我的构造不可判定"（要按 **`dsh-rwsl-<本进程 winpid>-*`** 计数才能定，本轮没做）。

**F56-2（非零退出：`cwd` 不存在 ⇒ 脚本 `cd … || exit 2`）**
```
[PRE ] F56-2 第1次 err="remote-wsl: initialize 超时"                     含真因=false
[HEAD] F56-2 第1次 err="runtime exited during initialize (exit=2): l\0o\0c\0a\0l\0h\0o\0s\0t\0 …"  含退出=true
```
（我第一版断言用 `/exit 2/` 带空格 ⇒ 显示 false，是**我的正则写错**；读数里 `exit=2` 与真因 stderr 都在，判定不受影响。）

**F56-4（真实运行时被我 kill 后再发一轮）**
```
[PRE ] prompt err="Error: session/prompt timeout after 60000ms"  closed=false alive=false lastTurnError=null  状态一致=false
[HEAD] prompt err="Error: session/prompt timeout after 60000ms"  closed=true  alive=false lastTurnError="session/prompt timeout after 60000ms"  状态一致=true
```
⇒ **确认**：修复后"报错 ⟺ 状态与实际一致"（`closed=true && alive=false` + `lastTurnError` 留痕）。

**F56-5（真实运行时 `close()` 计时 + `onFrame`）**
```
[PRE = 815f2c8^] close() 耗时 = 43ms；frames=1
[HEAD]           close() 耗时 = 47ms；frames=2
```
⇒ **未复现 7s→ms**：两态都已是毫秒级。我的构造里 `close()` 走到 `stdin.end()` 后**子进程立刻退出**（host profile：`wsl.exe` → bash → `dsh`，stdin 关即退），所以"优雅关闭有没有发出去"**不在关键路径上**；能观察到的差别只有 frames 1→2。**调序缺陷本身读码成立**（`request()` 首行见 `closed` 即 reject ⇒ 旧代码那条 `request('shutdown')` 从来没发出去），但这属于"只读码/只信 diff"，**不是**我独立测出来的耗时差。

## 故意破坏（红）—— 自写断言确实敏感

副本把 HEAD 的 `exitedDuringInit` 从 `Promise.race` 里注释掉（`^\s*exitedDuringInit,$` 命中 1 处）：
```
[RED ] F56-2 第1次 err="remote-wsl: initialize 超时"         ⇒ 我的"含真因"断言 = false  → 红 ✅
[HEAD] F56-2 第1次 err="runtime exited during initialize (exit=2): …"  → 绿 ✅（同构造）
```

## 冻结复算 / 隔离 / 收尾

- **`revision.ps1 -Mode Check`（`spike/verify/explorer-20261012/revision.ps1`）exit 3**：`结论：锚点未变，但 advisory 输入变了 => 需解释`。列出的是 `README.md` / `docs/*.md`（panel-ux / panel-visual / client-contract / arch-review …）⇒ **锚点（14 src + 10 client + package.json）未变**，漂的是**advisory 文档**（本轮我零 `src/` 改动，写域只有 `arch-t71/`）。→ **需要你解释/重冻**。
- **双隔离**：Windows `DSH_HOME=%TEMP%\t71-home`；WSL `wslHome=/home/g/t71-home`（收尾已删）。用户全局 `storages/workspace.json`：`before = after = 69AC2EC049365EF032114177613EF50D77EB76A70283DBBD9ABDB51E79469E14` ⇒ **前后完全相同**。
- **收尾**：`is-system-running = running`、`failed 0`、`dsh-rwsl units 0`（含 `reset-failed`）、`daemon.ts 0`、`dsh web 0`、`/tmp dsh-rwsl 0`、`t71-home` 已删、两棵 pre 树与副本已删、**WT 0**、宿主 33688 存活。端口只用 8911–8913。

## 【一旦错了就得返工】

1. **"修复提交"≠"包含全部修复条目"**：`815f2c8` 的标题写着 F56-1..5，实际源码只改 F56-5；F56-1..4 藏在标题为 *test(T61)* 的 `9c5829a` 里。⇒ **复验前必须自己对 diff 定位每条修复落在哪个提交**，否则会在错误的基线上"复现"出假的 pre-fix 行为（我若照抄 Lead 给的基线，F56-1..4 五条都会显示"pre 已经修好"）。
2. **`/tmp` 残留必须按"自己 winpid"计数**：共享机器上全局 `ls | wc -l` 会被并发写入者污染（本轮 +1 就是这样），据此下"残留"结论会误伤。F56-1② 在我这里**不可判定**，不是"未修"。
3. **耗时类断言要贴关键路径**：`close()` 的 `7s→ms` 依赖"子进程不因 stdin 关闭而立刻退出"的构造（如 daemon profile）；host profile 下两态都是 ms ⇒ **该断言在我的构造里无效**，只能读码断言调序缺陷。
4. **裸 TypeError 类签名有前提**：`child === null`（spawn 失败）才会 `this.child.stdin` 炸 TypeError；我用的"spawn 成功→脚本 exit 2"路径 `child` 非空 ⇒ 只得到可读超时。⇒ 复现这类签名要单独构造 spawn 失败 + 池复用。

## 【其余的】

- 我的 F56-1 构造是自写的宿主 adapter（`spawnRuntime` 用不存在的 exe），**不是**照抄作者的 `verify-f56.ts`；F56-4/5 用真 `dsh`（孤立 home，start 1083–2871ms）。
- 两棵 pre 树用 `git archive <rev> | tar -x` **整棵树**抽出（各 14 个 src 文件），不是只取单文件。

## 未复核：5 条

1. **F56-1② 的 `/tmp` 归属**：需按 `dsh-rwsl-<本进程 winpid>-*` 计数（本轮被并发写入者污染 ⇒ 不可判定）。
2. **F56-5 的 `~7s→ms`**：需作者那种构造（例如 daemon profile，或让子进程不因 stdin 关闭即退），本轮 host profile 两态 43/47ms。
3. **F56-3 的裸 `TypeError: … reading 'stdin'`**：需 `child===null` 的构造（spawn 失败 + 池复用）；本轮只做到"spawn 成功后 exit 2"。
4. **F56-4 的 `close()` `exited` 字段**：host profile 的 `closeResult='void'` ⇒ `close()` 返回 `undefined`，该字段不可观测（需 daemon profile 或改 `closeResult`）。
5. **advisory 漂移的来源**：`revision.ps1 -Mode Check` exit 3 列出的是 `docs/*.md`、`README.md` 的变化；是谁在冻结点之后改的文档、是否需要重冻，需你判（本轮我零 `src/` 改动）。

## 证据文件（`spike/verify/explorer-20261012/arch-t71/`）

`REPORT-independent-reverify-t62.md`（本文）、`probe-f56.ts`（自写探针）、`out-PRE-f56-1.txt` / `out-HEAD-f56-1.txt` / `out-HEAD-f56-1b.txt` / `out-HEAD-f56-1c.txt`（F56-1：pre/HEAD/归属/顺序改后）、`out-PRE-f56-2.txt` / `out-HEAD-f56-2.txt` / `out-HEAD-f56-2b.txt`（F56-2）、`out-RED-f56-2.txt`（**红**）、`out-PRE-f56-3.txt` / `out-HEAD-f56-3.txt`、`out-PRE-f56-4.txt` / `out-HEAD-f56-4.txt`、`out-PRE-f56-5.txt` / `out-HEAD-f56-5.txt`、`out-revision.txt`（冻结复算 exit 3）、`sha-before.txt`。
