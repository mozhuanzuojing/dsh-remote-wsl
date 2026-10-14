# REPORT-escapehatch-coldstart.md —— T56：宿主逃生舱 5 个失败分支 + initialize 冷/热启动判定

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-14 ｜ **任务**：`task-56`
- **写域**：仅 `spike/verify/explorer-20261012/arch-t56/`（`git status` = `?? arch-t56/`；**`src/**` 零改动**）
- **手法**：所有变异都在 `%TEMP%\t56-src-<branch>` 副本上；每条分支一个独立副本目录（避开 Node 模块缓存）；
  **每 5 分钟量级都真调**；一轮收尾后复核"无进程/无临时文件/无端口/宿主未碰"。
- **工具**：`tools/escape-hatch.ts`（①五分支）· `tools/coldstart.ts`（②冷热）· `tools/red-swallow.ts`（③故意红）

## 1. 结论

**逃生舱的 5 个失败分支全部构造成功并逐条给出读数**：A 启动脚本失败 → `writeScript` 的**友好报错**；B 起进程失败 → 只报 **`remote-wsl: initialize 超时`**（ENOENT 被掩盖）且**泄漏 `/tmp` 启动脚本**；C initialize 超时 → 真超时 + **同 key 重取拿回同一个坏运行时**；D 非零退出 → 同样**只报超时**（`exitCode=2` 不上行）；E1 空正文 → `noText` 兜底（**先 close + 读日志**，语义与文档一致）；E2 RPC error → 原样抛 `JSON-RPC -32603`（运行时仍 alive）。
**冷/热判定：冷启动是真成本、量级 70×** —— 热态 **864/870/891 ms**（3 次，中位 870），**冷态首次 60,552 ms**（隔离空缓存 0 → **543 MB** 物化），冷态第二次即回落 **848 ms**。
⇒ **冷启动可直接解释 T1 的现象量级**（120 s 预算对冷启动只有 ~2× 余量），但**"那次 >120 s"我没能复现**（我的冷态 60.6 s 是**通过**的）⇒ 只能写"**冷启动是主导成本、代码无回归证据、>120 s 未被排除**"，不能写"已排除回归"。

## 2. ① 五分支总表（原始输出见 `out-03-escape-hatch-v3.*`）

| 分支 | 触发方式（是否变异） | 观察到的错误/降级 | 资源泄漏 |
|---|---|---|---|
| **A 启动脚本失败** | 零变异：`distro='__t56_no_such_distro__'` ⇒ `writeScript` 的 UNC 写入失败 | `Error: remote-wsl: 无法写入发行版 "…" 的 /tmp（UNC \\wsl.localhost\… 不可用）。用 \`wsl -l -v\` 确认发行版名…`（**可诊断**） | 无（未写脚本、未起进程、无端口） |
| **A2 同 key 重取**（A 的后续） | 零变异：失败后 `getRuntime('k-A')` 再取一次 | **`reacquired: true, sameInstance: true`**（池把从未起来的 rt 原样交回）⇒ 随后 `prompt()` 抛 **`TypeError: Cannot read properties of undefined (reading 'stdin')`**；`close()` 正常 resolve | 无 |
| **B 起进程失败** | 变异 1 处：`spawn('wsl.exe'…)` → `spawn('wsl.exe__t56_nope__'…)`（仍照常 `writeScript`） | **只报 `Error: remote-wsl: initialize 超时`**（真实原因 ENOENT 不上行）；`closed=true`、`alive=false` | **⚠️ 泄漏**：`/tmp/dsh-rwsl-<winpid>-*.sh` **留下不删**（本轮收尾残留就是它） |
| **C initialize 超时** | 变异 1 处：脚本里 `sleep 8`（与缓存冷热**无关**的确定性构造）+ `timeoutMs=2000` | `Error: remote-wsl: initialize 超时`；**同 key 重取 `sameInstance=true, closed=false, alive=true`**；`wslRuntimesAtObservation=119714(2s)`（关闭前 WSL 侧进程仍在跑）；`close()` 后 `closed=true`、**`exitCode: null`**（未确认退出） | 关闭前有活进程（close 后为零）；`/tmp` 由 closeHook 清掉 ✓ |
| **D 非零退出** | 零变异：`cwd='/no/such/dir/t56'` ⇒ 脚本自带 `cd … \|\| exit 2` | **只报 `initialize 超时`**；对象内可见 `exitCode=2`，stderrTail 含真实原因 `remote-wsl: cwd 不存在: /no/such/dir/t56`（**但都不上行**） | 无残留进程；脚本由 close 清掉 ✓ |
| **E1 空正文** | 变异 1 处：`spawnRuntime` → 内联 **JSON-RPC 桩**（只回 reasoning + `turn/end`） | `Error: remote-wsl: 事件流与持久化日志都没有 assistant 正文；请重试（运行时已重启、id 会换新）`；`closed=true` ⇒ 兜底路径 = **close + 读持久化日志**，与文档一致 ✓ | 无（closeHook 跑了） |
| **E2 prompt 形状异常** | 同上，桩对 `session/prompt` 回 JSON-RPC error | `Error: JSON-RPC -32603: stub boom`（原样上行） | **`closed=false, alive=true`** ⇒ 运行时留在原地（调用方不 close 就留着） |

> 桩法说明：分支 E 用**确定性 JSON-RPC 桩**代替真运行时（只变异 `spawnRuntime` 一处）⇒ 不烧模型配额、结果可重复；E1/E2 的耗时 18.5 s / 3.6 s。

## 3. 四个发现（只报不改；`src/**` 未动）

- **F56-1（B，资源泄漏 + 诊断差）**：`spawn` 失败时子进程的 `'error'` 事件已把 `this.closed = true`，而 `SdkRuntime.close()` 第一句就是 `if (this.closed) return …` ⇒ **closeHook（`reapWsl` + `removeScript`）从不执行** ⇒ `writeScript` 写下的 `/tmp/dsh-rwsl-<winpid>-*.sh` **永久残留**（本轮两次运行都复现，同一文件 3562 B）。同时真实原因（ENOENT）被 `initialize 超时` 掩盖。
  **建议**：① `start()` 里把 spawn 的 `'error'` 存下来，`initialize` 失败时优先回抛它；② `close()` 的 early-return 不能跳过"清理已写的脚本"——把 closeHook 提到 early-return 之前（或在 `start()` 失败路径上直接 `removeScript`）。
- **F56-2（D，非零退出不可见）**：`start()` 只 `await request('initialize')`，**没有 race `this.exited`** ⇒ 进程立刻 `exit 2` 也要等满 `initTimeoutMs` 才失败，且失败文案与"真超时"**无法区分**。**建议**：initialize 等待期 race 退出事件，退出即抛带 `exitCode` + `stderrTail` 尾部的错误。
- **F56-3（池不驱逐坏运行时）**：`createInHostPool.getRuntime` 先 `runtimes.set(key, rt)` 再 `await rt.start()`；**start 抛错后池里仍留着该 key**，且 `closed` 为假时后续同 key 调用会**原样交回**它（C 实测 `sameInstance=true`）。在 A 情形下这颗"从未起来"的运行时被交回后，`prompt()` 抛裸 `TypeError: … undefined (reading 'stdin')`（宿主形态 `guardStdinWrite:false`，写 stdin 无保护）。**建议**：start 失败即从池中移除该 key（或置 `closed=true`），并把"没有 child"的情况换成可诊断文案。
- **F56-4（E2，RPC 失败后状态）**：`session/prompt` 收到 JSON-RPC error 时 `prompt()` 抛错但**运行时保持 alive/`closed=false`**（不自愈、也不自动回收）；结合 C 的 `close()` 报 `exitCode: null`（3 s 内未确认子进程退出），说明"关停确认"这条链偏弱。**建议**：错误路径也走一次"停稳 + 回收"（或至少把 `exitCode: null` 如实标成"未确认"）。

## 4. ② 冷/热启动判定（原始输出 `out-04-coldstart.*`）

**构造法（不碰共享缓存）**：`~/.cache/pnpm/dlx` 现在 **802 MB（热）**，不能删（会波及他人守护）⇒ 在副本的启动脚本最前面插入
`export XDG_CACHE_HOME=/tmp/t56-cold/cache PNPM_HOME=/tmp/t56-cold/home npm_config_store_dir=/tmp/t56-cold/store`，把物化落到**隔离空目录**。

| 态 | 运行 | 耗时 | 结果 |
|---|---|---|---|
| **热**（共享缓存） | #1 / #2 / #3 | **891 / 870 / 864 ms** | 3/3 成功；中位 **870 ms** |
| **冷**（隔离空缓存） | #1（真空） | **60,552 ms** | 成功（**未**触发 120 s 超时） |
| **冷→半热**（同隔离目录） | #2 | **848 ms** | 成功 |

**物化证据**：隔离目录 `不存在 → 543 MB`（= 真的重新物化了整包，不是我误判"冷"）。
**残留**：`/tmp/dsh-rwsl-<winpid>-*` = 0（成功路径不泄漏）。

**判定（能确认什么 / 不能确认什么）**
- ✅ **确认**：冷启动是**真实、可复现的成本**，量级 **60.6 s vs 0.87 s ≈ 70×**；且它**能**解释 T1 那种"首次 smoke 超时"的现象类别。
- ⚠️ **未确认/不可复现**：**"那次超过 120 s"我没复现**（我的冷态 60.6 s **通过**）。因此**不能写"已排除回归"**，只能写"**冷启动是主导成本；120 s 预算对冷启动只剩 ~2× 余量；>120 s 的成因未被复现**"。
- 📌 **我的 60.6 s 是下界**：本次只隔离了 pnpm 的 dlx 缓存，`mise`/`node` 早已装好；一台**全新**机器还要付 mise 装 node/pnpm 的下载 ⇒ 冷启动总成本会**更高**，这使"virgin 机器上超 120 s"仍然合理。
- **代码回归证据**：同一份代码热态 **3/3 稳定 0.85 s**（无抖动、无失败）⇒ 无回归迹象。

## 5. ③ 故意红 / ④ 验收

**③ 故意红（`out-05-red-swallow.*`）**：副本把 `createInHostPool` 里的 `await rt.start();` 改成 `try { await rt.start(); } catch { /* 静默吞错 */ }`
```
[mutated]  sha=a9d46d624518  断言看到抛错=false ⇒ 符合预期 ✓   未抛错（拿到 runtime，alive=false，child=undefined）
[restored] sha=e53ac2a889df  断言看到抛错=true  ⇒ 符合预期 ✓   Error: remote-wsl: 无法写入发行版 "…" 的 /tmp（UNC … 不可用）…
还原后副本 sha == 真实现 sha : true（真实现 e53ac2a889df）
结果：PASS —— 吞错版让断言失效（红），还原版断言恢复（绿）⇒ 断言确实在测这条分支
```
⇒ 断言**不是恒绿**：把错误吞掉它变红，字节还原后复绿，且还原后副本 sha 与 `src/in-host-runtime.ts` **完全相同**。

**④ `--dump-config`**：`exit=0 ｜ 1291 行 ｜ Error 命中=0`（`out-06-dumpconfig.txt`）。

## 6. 收尾（原始输出见本轮终端记录）

| 项 | 结果 |
|---|---|
| `src/**` | **零改动**（`git status --porcelain -- src/` 为空）；所有变异都在副本 |
| WSL 隔离冷缓存 | `/tmp/t56-cold` **543 MB 已删**（删前打印体积） |
| 我的 `/tmp` 脚本 | `/tmp/dsh-rwsl-*` 总数 **0** |
| WSL 侧运行时 | `dsh/lib/bin.js` / `@deepseek-ai/dsh@` **无残留** |
| Windows 包装层 | 父进程 = 我的 `wsl.exe` 残留 **0** |
| systemd | `is-system-running=running`、**failed_count=0**；`systemctl reset-failed` 返回 rc=1（"无失败单元可重置"，如实记录） |
| 状态目录 | 仅 `daemon.log` / `launch-stderr.log`（无 `daemon.*.json`） |
| 端口 | 8911/8912/8913 **free** |
| 宿主 | `19387` = pid **33688**（全程未碰；窗口 pid 33176 亦为用户会话） |
| **全局存储** | `C:\Users\l\.dsh\storages\workspace.json` sha256 **前后一致** = `A764A306…F303A9`（隔离 DSH_HOME 纪律成立） |
| **可见窗口** | 10 个，全部为用户应用（chrome×2 10:04/10:08、Code 11:00、Cursor 9:21、DeepSeek Harness 9:21、explorer 10:40、msedge 10:48、QQ 9:20、TextInputHost 9:17、Weixin 9:20）⇒ **我方可见窗口 = 0**（启动一律 `windowsHide:true` / `-WindowStyle Hidden`） |

## 7. 我自己的两次事故（自证，不留坑）

1. **模块缓存把变异吃掉**：v1 每轮把 `src` 复制到**同一个** `%TEMP%\t56-src` 再 `import` 同一路径 ⇒ Node 按 URL 缓存模块 ⇒ **分支 B/E 的变异根本没生效**（E1/E2 实际真起了运行时、留下两组孤儿）。**修法**：每个分支一个独立副本目录，并在变异前断言锚点命中。
2. **收尾顺序错**：v1 先 `rm -f /tmp/dsh-rwsl-<pid>-*`（含 `.pid`）再收运行时 ⇒ `reapWsl` 失去句柄 ⇒ **留下两个孤儿 dsh 运行时**。已按 **cgroup `0::/non-systemd`（= 非 systemd 守护）+ 启动时刻 11:29:47/49（我的窗口）+ 父链**确认归属后清除（复查 `@deepseek-ai/dsh@0.2.0-rc.2` 进程为空）。**修法**：先 `close()` 再验残留，不再预先删 `.pid`。
   ⇒ 这次事故本身**印证了 F56-1 的机制**：`reapWsl` 完全依赖 `.pid` 文件，句柄一丢就成孤儿。

## 8. 两栏

**【一旦错了就得返工】**
1. **冷/热的结论强度**：冷启动**已确证**（0→543 MB 物化、60.6 s vs 0.87 s）；但 **T1 那次 >120 s 未复现** ⇒ 任何"已排除回归"的写法都是过头话。当前唯一站得住的写法：**冷启动是主导成本、120 s 余量偏薄、代码热态 3/3 稳定**。
2. **F56-1 的 `/tmp` 泄漏**是可复现的（同一文件两次）；要修得同时动 `start()` 的错误回抛与 `close()` 的 early-return（`closed` 被 spawn error 置真）——**不是一行小改**，别当顺手活做。
3. **F56-3 的池不驱逐**会让"一次失败"污染后续同 key 调用（拿回死运行时 / 裸 `TypeError`）；这是**语义级**决定（要不要让同 key 重试重起），需要 owner 拍板。

**【其余的】**
4. **A / D / E1 的错误文案是好的**（`writeScript` 的 UNC 诊断、`cwd 不存在`、`noText` 兜底），**不用改**；E1 的"close + 读日志 + 换新 id"与文档一致 ✓。
5. 五分支的**确定性**：A/D 零变异；B/C/E 各变异 1 处且**只变异副本**；`src/**` 零改动（git 证据）。
6. 工具留在 `arch-t56/tools/`（五分支 + 冷热 + 红测），可复跑；E 的 JSON-RPC 桩内联在 `escape-hatch.ts` 里，不依赖真模型。

## 9. 未复核：6 条

1. **未构造"virgin 机器冷启动"**：`mise`/`node` 早已装好 ⇒ **60.6 s 是下界**，全冷（含 mise 装 node/pnpm）未测。
2. 冷态只隔离了 pnpm 的 dlx 缓存 + `PNPM_HOME`/store —— **未隔离 npm registry 缓存与代理**，故 60.6 s 受当日网络影响；不同网络下分布会变。
3. B 的"起进程失败"用**不存在的 exe 名**模拟（ENOENT）；**未构造"exe 存在但不可执行"（EACCES）**形态。
4. **未测 `reapWsl` 在 `.pid` 缺失时的行为**（我只观测到它按 pid 收进程；"缺失 ⇒ 孤儿"是我自己误删导致的旁证，不是受控实验）。
5. **未做全端口快照 diff**：in-host 不监听端口，我只核对了 8911–8913 free（"无新增监听"的间接证据）。
6. **未覆盖 WebHost 路径**（`wsl_open_ui` 的 `WebHost.start`）——它不在本任务的 5 个分支里；`allowBuildFlags` 那类"漏 import"缺陷另属 T47 域。
