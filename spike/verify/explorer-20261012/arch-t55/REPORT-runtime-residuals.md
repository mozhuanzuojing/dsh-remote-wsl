# REPORT —— T66：运行时三条残余（真 60s 超时 / 清态后 stop / 3+ 次交替状态机）

> **追加**，不覆盖同目录既有报告。**未改 `src/**`**（`git status --porcelain -- src/ client/ package.json` = 0 条）；变异只在 `%TEMP%` 整目录副本上做。端口只用 **8911–8914**。

## 结论

| # | 残余项 | 结果 |
|---|---|---|
| 1 | **真 60s 超时清理** | ✅ 三次都等满（**60412 / 60217 / 60318 ms**），错误可读且含 `未在 60s 内给出 URL`，`/tmp` 脚本+`.pid` **不残留**，槽位**无孤儿/无监听**；另做**窗口面实验**：60s 长命包装层存活期间 **0 个新增 `WindowsTerminal`** |
| 2 | **清态后再 `stop()`** | ✅ 失败（清态）→ stop 不抛错可读 → **重复 stop 幂等**；旁观者（systemd unit `sleep 300`）**仍 active ⇒ 不误杀**；成功态对照同样绿 |
| 3 | **3+ 次失败/成功交替** | ✅ `1:ERR/fail → 2:OK/url → 3:ERR/fail → 4:OK/url`，每步 `{ok,url,residue}` 可读、**失败后与停止后残留恒为 0** |
| — | **故意红** | ✅ 副本让"进程退出"分支静默吞错 ⇒ 逐步断言红（`1:OK/fail → 2:OK/noUrl → …`），同构造复绿 |

## ① 真 60s 超时（`out-01-timeout60.txt` ×2 + `out-10-windowrun.txt`）
构造：副本把 exec 行整行换成 `exec sleep 120`（**不动 60000 定时器**）⇒ `dsh web` 永不启动也永不退出。
```
PATCH: exec mise exec -- … ⇒ exec sleep 120
[①真 60s 超时 第1次] THREW 60412ms :: remote-wsl: web 未在 60s 内给出 URL ⏎ <stderr>
  STATE[第1次超时后] procs=0 listen=0 tmp=0
  ASSERT 可读且含"未在 60s 内给出 URL" = true ／ 无残留 = true ／ 等满 ≥60s = true
[①真 60s 超时 第2次] THREW 60217ms :: 同上；ASSERT 全 true
DURATION 分布: 60412, 60217 ms（n=2）        ← 另一次窗口实验里 60318ms（n=3）
ASSERT 无孤儿 sleep 120 = 0
```
**窗口面（顺手做的归因实验，`out-10-windowrun.txt`）**：探针跑 60s 超时路径期间每 3s 采样一次 ——
`[t+0s…t+60s] WT=0 我的 wsl.exe 包装层=2 node 还在=True`，**实验窗内新增 WT = 0**。
⇒ 结论：**长命的 `windowsHide` 包装层不会开窗**（与 F-37 四态矩阵一致；此前 T66 第一次跑时出现过的 1 个 WT 因进程已退**无法事后归属**，记为"未归属的外来瞬时窗口"，不据此宣称任何结论）。

## ② 失败清态后再 `stop()`（`out-02-stoptail.txt` / `out-03-stoptail-ok.txt`）
**被测（副本必失败）**：
```
[①启动] THREW 380ms :: remote-wsl: web 进程退出（exit 7）
  STATE[①之后] procs=0 listen=0 tmp=0     ← T60 的 #discardFailedAttempt 已把状态清回初始
[②stop] OK 104ms :: stopped web host on port 8912
[③stop（重复）] OK 122ms :: stopped web host on port 8912
  STATE[②③之后] procs=0 listen=0 tmp=0
  ASSERT ②不抛错可读 = true ／ ③幂等可读 = true ／ 不误杀旁观者 = true（is-active=active）
[④stop 之后同端口再试] THREW 264ms（同样是可读失败，没有"半死"歧义）
```
**对照（成功 → stop → 重复 stop → 再起）**：
```
[①启动] OK 4374ms → http://127.0.0.1:8913/?token=…
  STATE[①之后] procs=2 listen=1 tmp=2   ← **活态**（包装层+dsh web+监听+/tmp 脚本），不是残留
[②stop] OK 432ms ／ [③重复 stop] OK 149ms ／ STATE[②③之后] 0/0/0
[④再起] OK 3148ms → 真 URL
```
⇒ `stop()` 在"状态已被清空"时**安静早退**（`if (!this.child) return;`），工具仍给出可读的 `stopped web host on port …`，语义明确；重复 stop 幂等；**旁观者 unit 全程 active**。

## ③ 3+ 次失败/成功交替（`out-04-alt.txt` / `out-06-green-alt.txt`）
副本脚本用计数器：奇数尝试 `exit 7`、偶数尝试真启（`/tmp/t66-count`）。
```
STATE[基线] 0/0/0
[第1次（期望失败）] THREW 429ms …   STATE 0/0/0        ASSERT 形态✓ 无假成功✓ 失败无残留✓
[第2次（期望成功）] OK 3400ms → 真 URL  STATE procs=2 listen=1 tmp=2   ASSERT 形态✓ 活态✓
[  第2次后 stop] OK 417ms          STATE 0/0/0        ASSERT 停止可读✓ 停止后无残留✓
[第3次（期望失败）] THREW 241ms …   STATE 0/0/0        ASSERT 全✓
[第4次（期望成功）] OK 3358ms → 真 URL  STATE 2/1/2     ASSERT 全✓
[  第4次后 stop] OK 452ms          STATE 0/0/0        ASSERT 全✓
SUMMARY 逐步 = 1:ERR/fail → 2:OK/url → 3:ERR/fail → 4:OK/url
```
> **设计说明（为什么中间插 stop）**：一次**成功**之后 `this.url` 有值，下一次调用按设计**复用缓存 URL**（0ms 返回，属于正确行为，也是 T60 修好后保留的快路径）。所以要让"下一次"成为一次**真尝试**，必须在中间显式 `stop`。序列因此写成 `失败→成功→(stop)→失败→成功→(stop)`，逐步读数如上一行。

## 故意红（`out-05-red-alt.txt`）
副本把"进程退出"这条失败分支改成 `resolve('http://127.0.0.1:0/')`（**静默吞错**）：
```
SUMMARY 逐步 = 1:OK/fail → 2:OK/noUrl → 3:OK/fail → 4:OK/url
  ASSERT 第1次 形态符合期望 = false ／ 无静默假成功 = false ／ 失败无残留 = false
  ASSERT 第2次 形态符合期望 = false ／ 活态 = false
```
⇒ 断言**红** ✅（而且露出更糟的连带效应：吞错后 `this.url` 被写成一个**假的** `http://127.0.0.1:0/`，第二次直接 0ms 把它当缓存返回）。
**同构造复绿**（真仓库 + 同一计数器脚本）：`1:ERR/fail → 2:OK/url → 3:ERR/fail → 4:OK/url`，形态断言全 true。

## 护栏 / 隔离 / 收尾
| 检查 | 结果 |
|---|---|
| `arch-t3/tools/export-matrix.ts` | **PASS**（31 符号） |
| `arch-t2/tools/check-docs-methods.ts` | **PASS ｜ 断言 13 条** |
| `--dump-config` | **exit 0 / `Error:` 0 / 与基线 diff 0 行** |
| 收尾 | `daemon.ts 0`、`dsh-rwsl units 0`（含 `reset-failed`）、`failed 0`、`is-system-running = running`、`dsh web 宿主 0`、`8911-8914 监听 0`、`/tmp dsh-rwsl 0`、`t66-home 已删`、`t66-bystander: inactive`、`t66-*` 副本 0、**WT 0**、宿主 33688 存活 |

**⚠️ 隔离阴性对照出现异常（如实报，非我方代码路径）**：用户全局 `~\.dsh\storages\workspace.json`
`before = DCE16CFB4DC6759F65D2A3BF2AAA49A58EBCB0BDEBD4DFE074663A1CE7553323` →
`after = A1B6D08D9C485553D089153DD8A7AE1A9214A291B94E06E9A713236AD1C6D71A`，**并且 mtime 在两次读数间从 15:15:03 走到 15:17:05**（持续被写）。
**归属证据**：① 我的探针里**没有** `addWorkspace` / `workspaceRegistry`（grep = False），且我是**进程内** apply（无 `webServer` ⇒ explorer 路由都没注册）；② 文件内容**全程没有 `wsl.localhost`**（0 命中）⇒ 不是"面板添加 WSL 工作区"这条路；③ `workspaceIds = 11`、`tables.workspaces` 结构正常。
⇒ 结论：**不是我的代码路径**，但这轮会话有**并发写入者**（其他 teammate 在跑 T67/T69/T42…）。我**不宣称**"是我之外的人"，只报"非我方路径 + 行为是持续写入"。**流程教训**：隔离阴性对照应当**存内容快照**（不只存 sha），否则事后无法做条目级 diff —— 我本轮只存了 sha。

## 【一旦错了就得返工】

1. **"成功态"不是"无残留"**：活着的时候 `procs≥1 + listen=1 + tmp=2` 是**正常**的（包装层、`dsh web`、`/tmp` 脚本都是活的）。判据必须是"**失败后**与**stop 后**为 0"，把活态当残留会把这份验证做成假红。
2. **成功后的下一次调用会命中缓存 URL**（设计行为）：想验证"真尝试"必须在中间 `stop`，否则会把"缓存复用"误判成"没重启"。
3. **隔离对照要存内容不只存 sha**（见上）；否则 workspace.json 这类"持续被写"的文件无法定性到条目级。
4. **量具自match**：`pgrep -af "<模式>"` 会匹配到它自己的命令行（我第一版因此得到恒 `procs=1`），而 `sleep 3[0]` 这种宽模式还会把**旁观者的 `sleep 300`** 算进来（第二版因此把"无残留"判成 false）。⇒ 进程量具必须用方括号写法 + 足够窄的模式，并**先跑一次基线**核对。

## 【其余的】

- 四个模式的补丁都是**整行替换 + 命中次数断言**（`exec` 行、退出分支的 `reject`），并打印实际替换内容。
- 真调用一律孤立 `DSH_HOME`（`%TEMP%\t66-home`）**且 WSL 侧也隔离**（`wslHome=/home/g/t66-home/.dsh/remote-wsl`，收尾已删）——这样 `ensureSwept()` 只可能扫到我自己的目录。
- 旁观者用 `systemd-run --user --unit=t66-bystander --collect sleep 300` 起、收尾 `stop` + `reset-failed`；"不误杀"靠它的 `is-active` 断言。

## 未复核：5 条

1. **超时之外的失败态**（起了、给了 URL、随后 `dsh web` 中途崩）未构造 —— 本轮的失败都在 `start()` 等待期。
2. **`start()` 未完成时的并发 `stop()`** 未构造（同一 host 对象上的竞态）。
3. **更长的交替序列**（10+ 步）或"成功中途崩"未测；本轮 4 步交替 + 每步 stop。
4. **旁观者只验了"不被误杀"**（systemd unit 仍 active）；"停自己时是否可能误杀同 state dir 里的无关进程"属 `stopAllDaemons` 范围（T58 已验），本轮未重复。
5. **那个孤立的 `WindowsTerminal`**：本轮窗口实验期间 **0 新增**，但 T66 第一次跑时短暂出现过 1 个 ⇒ 因进程已退**无法归属**，只能记为"未归属"。若后续再出现，建议用"启动时间同秒 + 父进程链"的探针复现（T15 的方法）。

## 证据文件（`spike/verify/explorer-20261012/arch-t55/`，追加）

`REPORT-runtime-residuals.md`（本文）、`out-01-timeout60.txt`（真 60s ×2）、`out-02-stoptail.txt`（失败清态后 stop）、`out-03-stoptail-ok.txt`（成功对照）、`out-04-alt.txt`（交替状态机）、`out-05-red-alt.txt`（红）、`out-06-green-alt.txt`（复绿）、`out-07-matrix.txt`、`out-08-docs.txt`、`out-09-dumpconfig.txt`、`out-10-windowrun.txt`（窗口面实验）、`sha-after.txt`；脚本 `probe-t66.ts`。
