# T74 · 补 T71 两条未定：F56-1② 按本进程 winpid 计残留 + F56-5 真 await `shutdown` 的构造

- **日期**：2026-10-14 ｜ **执行**：client-contract ｜ 写域：`spike/verify/explorer-20261012/arch-t74/`（**未改 `src/**`**，两态用 `%TEMP%` 副本）
- **基线（按 T71 的更正）**：F56-1..4 改前 = **`9c5829a^` = `598543c`**；F56-5 改前 = **`815f2c8^`**；"现状" = **HEAD**
- **探针**：自写 `arch-t74/probe-f56-t74.ts`（**独立复现**；不照抄 T71 的 `probe-f56.ts`，也不照抄作者的 `verify-f56.ts`）

---

## 一、F56-1② `/tmp` 残留 —— **按本进程 winpid 精确计数（3 次重复）**

**改法**：`wsl-io.writeScript()` 的命名是 `/tmp/dsh-rwsl-${process.pid}-${ts36}-${uuid8}.sh`
⇒ **winpid 就是调用 `writeScript` 的那个（Windows）Node 进程 pid**。探针打印 `process.pid` 并用
`ls -1 /tmp/dsh-rwsl-<本进程 winpid>-*` 计数 ⇒ **只数自己的**，并发队友的文件不再污染读数。

**构造**：宿主 adapter + **不存在的可执行名**（`__no_such_exe_t74__`）⇒ `spawn` 抛 ENOENT；脚本已由 `writeScript` 落到 `/tmp`（否则"残留"无从谈起）。

| 态 | 启动失败错误 | 耗时 | **属于本进程的残留** | `hookCalls` | `closed` |
|---|---|---|---|---|---|
| **pre4** = `598543c` | `"initialize timeout after 120000ms"`（**伪装成超时**） | 120009–120025ms | **1** 个 `/tmp/dsh-rwsl-<winpid>-*.sh`（3/3 次都是 1） | **0** | true |
| **HEAD** | `"runtime spawn error key=t74-enoent: spawn __no_such_exe_t74__ ENOENT"`（真因） | 14–128ms | **0**（3/3 次都是 0） | **1** | true |

**归因链（改前为什么泄漏）**：改前 `start()` 失败只置 `closed = true`，而 `close()` 见 `closed` 就 early-return
⇒ adapter 的 `closeHook`（宿主形态 = `reapWsl` + `removeScript`）**从不执行** ⇒ 脚本永久留在 `/tmp`。
HEAD 新增 `#abortStart()`，它在 `throw` 之前 `await this.ad.closeHook?.()` ⇒ 残留归零。**实测与代码一致**。

**生产侧是否真的把脚本删掉（不只是"hook 被调了"）**：`src/in-host-runtime.ts:58-60` 的 closeHook 是
```ts
closeHook: async () => { await reapWsl(cfg, state.script); removeScript(cfg.distro, state.script); },
```
**`reapWsl` 是被 await 的** ⇒ 我的独立构造与生产写法一致。⇒ **F56-1② 判定：✅ 已修（独立复现，3/3 稳定）**。

### 1.1 一个必须记下来的量具坑（我第一次的读数就是错的）

第一版探针的 closeHook 里 `reapWsl(...)` **漏了 `await`**：

| 探针版本 | HEAD 残留 | 同一批 pre4 残留 |
|---|---|---|
| 第一版（`reapWsl` 未 await、无插桩） | **1**（单次采样） | 1 |
| 第二版（`await reapWsl` + 插桩 `hookCalls`） | **0（3/3）** | 1（3/3） |

**旁证（物证）**：收尾时 `/tmp` 里恰好剩下 **4 个文件，全部属于我那几次运行** ——
`40052`(第一版 pre4)、`36156`(**第一版 HEAD**)、`33828`/`38880`(f56-5 `--real`，其 closeHook 同样漏 await)；
而第二版跑过的 winpid（`12208`/`39524`/`38112`/`25468`/`40308`/`37632`/`5028`）**一个都没留**。
⇒ 机制：`removeScript` 走 Windows 侧 UNC `unlinkSync`，在"spawn 失败得极快"的路径上**单靠它不够**，
必须把 **WSL 侧那一遍 `reapWsl` 跑完**（即 adapter 的 `closeHook` 要 await）。
**标注**：这条因果（9p/UNC 写-删竞态）是**推断**；我给的证据是"漏 await ⇒ 留文件 1/4，await ⇒ 0/3"，未做隔离实验。

## 二、F56-5 `close()` —— **真正会 await `shutdown` 回包**的桩

**判据的修正**：只看耗时会被骗（改前"快"是因为它**什么都没做**）。本探针直接**截 `child.stdin.write`**，
看 `shutdown` 帧到底有没有写出去 —— 这是"优雅关闭死代码"的直接证据。

**桩（`--stub`）**：`node -e` 的子进程，**答 `initialize`**（否则 `start()` 超时）、**故意不答 `shutdown`**
⇒ 全新的"peer 不回包"夹具；新代码按代码里的 `3000ms` 超时收尾，旧代码则因 `request()` 立刻 reject 而秒过。

| 态 | `close()` 耗时 | **stdin 写出 `shutdown`** | 实际写出的帧 |
|---|---|---|---|
| **pre5** = `815f2c8^` | **3004ms** | **false** | `["initialize"]` |
| **HEAD** | **6009ms** | **true** | `["initialize","shutdown"]` |
| **red5**（HEAD 副本，把 `this.closed = true` 挪回 request 之前） | **3015ms** | **false** | `["initialize"]` |

**真 dsh 对照（`--real`，孤立 WSL home `/home/g/t74-home`）**：

| 态 | start | `close()` | **写出 `shutdown`** |
|---|---|---|---|
| pre5 | 6796ms | 70ms | **false**（`["initialize"]`） |
| HEAD | 1139ms | 54ms | **true**（`["initialize","shutdown"]`） |

⇒ 与 T71 的 43/47ms 同量级；**差别不在耗时，在"帧发没发"**。

**故意红（②）**：`red5` 只在副本里把 `this.closed = true;` 挪到 `await this.request('shutdown', …)` **之前**（1 行插入，
`git diff --no-index` 证明**只有这一行**差别）⇒ `shutdown` 立刻从"发出"回到"从不发出" ⇒
断言 **「HEAD 必须写出 shutdown 帧」在 red5 上必红**。副本已删，真 `src/` 未动（全程只读 HEAD）。

**结论（对 lead 问的 `~7s→ms`）**：
1. **`~7s → ms` 这个"耗时差"在两种构造下都复现不出来**（stub：3004ms→6009ms，**HEAD 反而更慢**；真 dsh：70ms→54ms）。
   ⇒ **用耗时当判据会把结论判反**。
2. **可复现且决定性的是语义**：改前 `shutdown` 帧**从未写出**（`closed` 先置位 ⇒ `request()` 立刻 reject，
   注释里的病根成立）；HEAD **确实写出**，代价是被 `3000ms` 超时有界封住（peer 不回包时 +3s，真 dsh 时 ~50ms）。
3. ⇒ **F56-5 判定：✅ 语义已修（独立复现"发出 shutdown"）**；"~7s"这一说法**不是本修法的表征**，应作废。
   （若某处真出现 ~7s，那是另一条路径，需要单独定位 —— 本任务未找到它的构造。）

## 三、验收③ 冻结复算

```
$ pwsh spike/verify/explorer-20261012/revision.ps1 -Mode Check
结论：锚点未变，但 advisory 输入变了 => 需解释（exit 3）      ← docs/** 正被其他 teammate 并发改写（T72/T63 等）

$ pwsh ... -Mode Check -AllowAdvisoryDrift
锚点一致 = True ｜ advisory 一致 = False
锚点文件数 = 14 src + 10 client + package.json
结论：revision 锚点未变。                                  exit=0
```

⇒ **冻结锚点（`src/**` + `client/**` + `package.json`）未变** = 本轮没有碰任何冻结面；advisory（`docs/**`）的漂移来自他人并发写。

## 四、"独立复现" vs "只读码"

| 结论 | 类别 |
|---|---|
| F56-1②：改前残留 1 / HEAD 残留 0（winpid 精确、3/3 重复） | **独立复现**（自写探针） |
| HEAD `#abortStart` 会 `await closeHook` ⇒ 收尾真的执行 | 读码（`sdk-runtime.ts:249-252/268-278`）+ 被上面实测印证（`hookCalls` 0→1） |
| 生产 adapter 的 `closeHook` **await** `reapWsl` | **只读码**（`in-host-runtime.ts:58-60`）—— 未在真插件生命周期里跑通（见未复核①） |
| F56-5：改前**从不**写出 `shutdown`；HEAD 写出 | **独立复现**（stdin 直采，stub + 真 dsh 两套夹具） |
| `~7s→ms` 的耗时差 | **未复现**（两套夹具都不支持；判为说法作废） |
| 漏 await `reapWsl` ⇒ 文件残留 | **推断**（有 4 个物证 winpid，未做隔离实验） |

---

## 【一旦错了就得返工】

1. **判"泄漏"必须按自己的 winpid 计数**：全局 `ls /tmp/dsh-rwsl-* | wc -l` 在共享机器上会被并发写入者污染
   （T71 就因此判"不可判定"）。`writeScript` 的名字里第一个数字段**就是**调用进程的 winpid，用它做安全边界。
2. **"hook 被调了" ≠ "文件删掉了"**：`removeScript`（Windows UNC unlink）与 `reapWsl`（WSL 侧 rm）是**两道**，
   只做前一道在"快速失败"路径上会留下文件；**必须 await 后一道**（生产 adapter 正是这么写的）。
3. **判"优雅关闭修没修"要看帧、不要看耗时**：改前"快"是因为它压根没发 `shutdown`；HEAD 在 peer 不回包时
   反而**慢 3s**（有界超时）。**用耗时当判据会把结论判反。**

## 【其余的】

- `pre5` 那 3004ms 具体消耗在收尾/杀进程的哪一步，我**没有逐行确认**（与 HEAD 的 3000ms 超时数值巧合相同，
  但不该当成同一原因）——已记入未复核②。
- 两态都是 `%TEMP%` 副本（`pre4`/`pre5`/`head`/`red5` 四棵树），跑完删除；真 `src/` 全程只读。

## 未复核：3 条

1. **生产生命周期里的 F56-1②**：我用的是**自写 adapter**（与 `in-host-runtime.ts` 的 closeHook 同形）。
   真插件路径（`createInHostPool` → `getRuntime` 失败 → 池回收）**未跑通**，未验"池"这一层会不会另行落一份脚本。
2. **`pre5` 3004ms 的构成**：只测到总时长与"没发 shutdown"，未逐段定位那 3s 花在哪。
3. **`~7s` 的原始构造**：T71 与我都没复现；若 lead 手上有当时的命令/日志，**需要它才能定位**（本任务只能给"说法作废"）。

## 五、纪律与收尾

- **双隔离**：Windows `DSH_HOME=%TEMP%\t74-home`；WSL `wslHome=/home/g/t74-home`（跑完已删）。
- **用户全局 `storages/workspace.json` 前后 sha 对照**：
  `69AC2EC0…`(11672 B) → `A22E2DE6…`(14426 B)，mtime **15:45:54**。
  **归属：不是我** —— 文件正文里**没有任何** `t74`/`AppData\Local\Temp` 痕迹，列出的全是用户/队友的真实工程路径
  （`D:\project\dsh1`、`D:\U8\…`、`E:\Users\project\人力综合` …），且我的两次真 dsh 都跑在 WSL 侧。记为**环境噪声（他人/用户写入）**。
- **清理**：我自己那 4 个 `/tmp/dsh-rwsl-<winpid>-*` **已删**（复核 `my files left: 0`、`all /tmp/dsh-rwsl-*: 0`）；
  `/home/g/t74-home` 已删；`%TEMP%\t74`、`%TEMP%\t74-home` 已删；`dsh-rwsl*` unit **0**、`--state=failed` 已 `reset-failed` 归 **0**、
  `daemon.ts` 进程 **0**、`launch.*.sh` **0**、端口 8911–8914 **无监听**。
- **窗口**：枚举 9 个，全为他人/系统进程（chrome×2 / Code / Cursor / 用户宿主 33176 / explorer / geph / TextInputHost / Weixin），
  无 `wsl.exe`、无 WindowsTerminal ⇒ **本任务产生 0 个 dsh 窗口**（按 pid/父 pid/启动时间/命令行判，未凭标题）。
- **19387**：pid **33688**（DeepSeek Harness），只报告未触碰。
- **写域**：`git status` 只多出 `?? spike/verify/explorer-20261012/arch-t74/`。
