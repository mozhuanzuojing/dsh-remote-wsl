# T68 · precommit 第 05f 项：可见窗口归属改为**机器可判**

- **日期**：2026-10-14 ｜ **执行**：client-contract
- **写域**：`spike/verify/explorer-20261012/tools/precommit-check.ps1`（**只改这一个文件**）
- **未碰**：`client/**`、`src/**`、`package.json`（`git status` 见 §6）
- **纪律**：除验收②那次"自己开自己关"外未弹窗；宿主 19387（pid **33688**）只读未触碰

---

## 一、改了什么

05f 原来是**唯一一个"交人判"的 WARN**（脚本刻意"禁凭标题猜"，于是把 9–11 个窗口全甩给人）。现在按
**启动时间窗 + 父链**机器判定：

| 判据 | 结论 |
|---|---|
| 窗口进程 **`StartTime ≥ WindowSince`（落在本次运行窗内）** ∧ 父链里出现**我方工具链**名字 | **FAIL**（我方产生了可见窗口），并指名 pid |
| 进程启动**早于**运行窗（⇒ 不可能是本次动作造的）或父链是**用户应用** | **PASS（归属他人）**，逐窗列出 pid/名/启动时间/父 pid/父链 |
| 取不到 `StartTime` **或** 取不到父链 | **WARN（绝不记 PASS）** |

**为什么"启动时间"是主判据**：同机上有用户的 VS Code / 浏览器 / 用户宿主在跑，它们的**标题与命令行都可能与我们高度相似**
（F-37 第一次就是被标题误导过）⇒ 只认**时间 + 进程树**。

实现要点：
- 新增参数：`-WindowSince <DateTime>`（缺省 = 脚本启动时刻往前 `-WindowSlackMinutes` 分钟，默认 **15**）、
  `-WindowSlackMinutes`、`-WindowProbeUndecidable`（复现"不可判定"用的注入开关，见 §四③）。
- 脚本开头记 `$RunStartedAt = Get-Date`（**早于** 01–04/05a–05e 的 git/wsl 探测，窗口起点才准）。
- 新增 `Get-ProcChain`（沿 `Win32_Process.ParentProcessId` 上溯，最多 8 层）与 `Test-ChainIsOurs`：
  - **我方**：`pwsh/powershell/cmd/conhost/node/dsh/bash/wsl/wslhost/wslrelay/windowsterminal/wt/python`；
  - **明确不算我方**（先于我方名判定）：`explorer / deepseek harness / code / cursor / chrome / msedge / firefox / qq / weixin / textinputhost / gephgui-wry`
    —— **用户宿主与桌面壳绝不能被算成"我们"**。
- 证据行含 `chain=`、`inWindow=`、`chainIsOurs=`、`verdict=`，并在末尾给 `归属汇总：ours/foreign/undecidable` 与窗口起点。

## 二、验收① 正跑 ⇒ **PASS**（逐窗归属证据）

```
[PASS] 可见窗口（归属机器判定）  05f  10 个可见窗口全部归属他人（均早于本次运行窗或父链为用户应用）；逐窗证据见原始输出
归属汇总：ours=0 foreign=10 undecidable=0

pid=2828 chrome.exe  start=2026-10-14 10:04:50  parent=14356  verdict=foreign
    chain= chrome.exe#2828 <- explorer.exe#14356
    inWindow=False  chainIsOurs=False
    title(仅供参考,禁作为归属依据)= Open Design Cloud - Google Chrome      ← **标题只打印、不参与判定**
pid=15212 chrome.exe  start=2026-10-14 10:08:01  parent=15228  verdict=foreign
    chain= chrome.exe#15212 <- jira-keepalive.exe#15228 <- local-workbench-service.exe#21168
    inWindow=False  chainIsOurs=False
窗口起点 WindowSince = 2026-10-14 15:1x:xx（脚本启动 …，抖动 15 分钟）
```

## 三、验收② 故意红 ⇒ **FAIL 并指名 pid**（自己开自己关）

**第一次尝试用了 `Start-Process notepad` —— 它造不出顶层窗口**：Win11 的 notepad 是打包应用
（`MainWindowHandle` 轮询 8 秒仍为 0，窗口归属给别的进程/单实例代理）⇒ 窗口数 10→10 没变。
**改用必然有控制台窗口的子进程**：`Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 90'`
（不加 `-WindowStyle Hidden`）。

```
窗口数：基线 10 → 起了子进程后 11
[FAIL] 可见窗口（归属机器判定）  05f  11 个可见窗口；**可归属我方 pid = 28524**（启动时间落在窗内 ∧ 父链含我方工具链）
归属汇总：ours=1 foreign=10 undecidable=0

--- OURS 证据块（原文）---
pid=28524 WindowsTerminal.exe  start=2026-10-14 15:13:13  parent=1828  verdict=OURS
    chain= WindowsTerminal.exe#28524 <- svchost.exe#1828 <- services.exe#1636 <- wininit.exe#1512 <- Weixin.exe#1156 <- Weixin.exe#16432 <- explorer.exe#14356
    inWindow=True  chainIsOurs=True
    title(仅供参考,禁作为归属依据)= C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.7.0_x64__8wekyb3d8bbwe\pwsh.exe

--- 自己关掉 ---
关闭后可见窗口数 = 10（基线 10）⇒ 回到基线 = True
```

**归属为何落在 `WindowsTerminal.exe` 而不是我起的 pwsh**：Win11 默认终端宿主是 Windows Terminal，
控制台窗口由它持有（`-Embedding`）⇒ 窗口的**拥有进程**就是 WT。判定取"窗口自身进程名 + 启动时间"这一最强信号，
WT 在"我方工具链"名单里 ⇒ OURS。

> **诚实标注（见未复核②）**：这一例里 CIM 给出的父链（`WindowsTerminal ← svchost ← services ← wininit ← Weixin ← explorer`）
> **不是**一条可信的 spawn 链 —— `Test-ChainIsOurs` 按"从窗口进程往上、**先命中的名字说了算**"短路，所以是 **WT 这个名字**
> 定的性，而不是父链。结论正确，但**父链在这类"终端宿主托管"场景下不能当唯一依据**。

## 四、验收③④⑤

**③ 不可判定 ⇒ WARN**（`-WindowProbeUndecidable` 注入一个不存在的 pid，证明 `3` 不落成 PASS）：

```
[WARN] 可见窗口（归属机器判定）  05f  11 个可见窗口中 1 个**取不到启动时间/父链** ⇒ 无法判定（pid=999999）；**绝不记 PASS**
归属汇总：ours=0 foreign=10 undecidable=1
```

**④ `pwsh` AST 解析**：`AST 错误数 = 0`（`Parser::ParseFile`）。

**⑤ 全套 precommit（`-SkipNetwork`）**：

```
PASS=11  WARN=2  FAIL=1
唯一 FAIL = 第 01 项「git status 干净」（26 条未提交改动 = 提交前正常态）
05f = PASS   ｜  07 = PASS（client chunk rev）  ｜  08 = PASS（漏 import 扫描）
```

## 五、过程中踩到并修掉的一个真坑（写成定因，别让下一个人再踩）

**首跑 10 个窗口全部 `verdict=UNDECIDABLE`、item 直接 WARN。** 根因：我把 `Get-ProcChain` 的参数命名成 **`[int] $Pid`** ——
PowerShell 的 **`$PID` 是只读自动变量（大小写不敏感）**，参数绑定失败 ⇒ 函数恒返空链 ⇒ 全部误判"不可判定"。
修法：参数改名 `$TargetPid`；并**把失败原因记进 `$script:ChainLastError` 打到证据行**
（`chain= (取不到父链：<原因>)`）—— 这正是"错误不静默吞掉"：如果当初就打印原因，这个坑一眼可见。

## 【一旦错了就得返工】

1. **参数不要用 `$Pid`/`$PID`**（只读自动变量）；同类还有 `$Host`、`$Args`、`$Input`、`$Error`。
2. **"不可判定"必须走 WARN 而不是 PASS**：否则一个取不到信息的环境会拿到"全绿"，等于把门禁关掉。
3. **用户宿主与桌面壳必须先判"绝不我方"**：`DeepSeek Harness.exe` 出现在**我自己的祖先链上**（实测：本会话 pwsh 的父链是
   `… <- 33688(DeepSeek Harness) <- 33176 <- 14356(explorer)`）⇒ 若把它算成"我方"，用户宿主窗口会被自己人判红。
4. **`Start-Process notepad` 造不出可见窗口**（Win11 打包应用），负向夹具要用**控制台窗口**（`pwsh`/`cmd`）。

## 【其余的】

- 05a（端口）仍是"交人判"的 WARN —— **不在本任务范围**（任务只点名 05f），但同一套"时间窗+父链"手法可以直接搬过去。
- `-WindowProbeUndecidable` 是**显式测试开关**，默认关，不影响正常跑。

## 未复核：3 条

1. **05a（端口）未改**：仍是 WARN 交人判；本任务只做 05f。
2. **父链在"终端宿主托管"场景下不可信**（§三的诚实标注）：本次结论由"窗口自身进程名 + 启动时间"定；若把 WT 从名单里拿掉，
   这一例会退化成 `foreign`（假阴性）。**"链 vs 自身进程名"哪个该优先，需要一次专门裁定**，本轮按"自身进程名优先"实现。
3. **边界未构造**：① 窗口进程启动早于 `WindowSince`、但其**父进程**启动在窗内（长命 pwsh 里 `Start-Process` 弹窗）——
   按现判据会判 `foreign`（**可能假阴性**）；② 父链超过 8 层；③ 跨用户/无权限进程的 `Win32_Process` 查询失败路径只验了"注入假 pid"这一种。

## 六、写域与收尾

- **我的改动**：`git status --porcelain -- …/tools/ client/ src/ package.json` ⇒ 只有
  `M spike/verify/explorer-20261012/tools/precommit-check.ps1`。
  另一条 `M …/tools/m1-visible-count.ts` 是 **T57 owner** 的（写域重叠已由 lead 知悉），**非我所改**。
- **收尾**：可见窗口 **10**（= 基线，红测的 11 已回到 10）；红测子进程**残留 0**（用"短命令行 + 拼接签名 + 排除自身祖先链"精确判定 ——
  第一次自匹配把当前 shell 也数进去了，已纠正）；`dsh-rwsl*` unit **0** · `--state=failed` 已 `reset-failed` 归 **0** ·
  `daemon.ts` 进程 **0** · `launch.*.sh` **0**；`~/.dsh/remote-wsl/` 无新残留。
- **19387**：pid **33688**（DeepSeek Harness），只报告未触碰。
