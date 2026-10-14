# REPORT-isolation-sweep-fixes.md —— T73：清掉 12 个"缺隔离" + 8 个"无断言"（20 个工具）

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-14 ｜ **任务**：`task-73`
- **写域**：`spike/verify/explorer-20261012/**`（T70 报告 §6 点名的 20 个文件）+ `arch-t58/`（工具与报告）
- **未碰**：`src/**`、`client/**`、`package.json`（`git status` 三项**均为空**）｜ `usability/arch-t64`、`visual/t65`（避让清单；实际与 20 个**无重叠**）
- **端口**：只用 8915–8918 ｜ 工具：`apply-dshhome-fixes.ts`（幂等 codemod）· `census-dshhome.ts`（门禁）· `guard-red.ts` + 内联红测 · `syntax-check.ts`

## 1. 结论

**20 个文件全部改完，普查门禁 `✗=0 / ⚠=0`**（133 文件，✓ 合规 **26**、N/A 107）：9 个 `.ts` 加"隔离 + 断言"，4 个 `.ts` 只补断言，6 个 `.ps1` 起宿主脚本**默认改孤立 `%TEMP%\<tool>-home` + 新增 `-UseUserHome` 开关 + 前后 sha 断言**，1 个 `.ps1` 只补断言。总计 **+178 / −6 行**（其中 6 个 `param` 块各补了 1 个逗号 —— PowerShell 硬要求）。
**≥3 个真跑，每个都给出"用户全局 workspace.json 前后 sha 相同"的原始输出**：① `probe-wsl-path.ts`（进程内 `apply()`）② `boot-iso-host.ps1`（`.ps1` 起宿主，`ready=True`）③ `boot-testhost.ps1`（`.ps1` 起宿主，`--dump-config exit=0`、8915 起宿主成功）。
**故意红**：T70 版 `guard-red`（替身文件 + 顺序门禁）**6/6 符合预期**；另加**内联红测**在**新修文件**上做通用变异（删隔离调用 ⇒ 判 ✗ 缺隔离；字节还原 ⇒ 复绿）。
**⚠️ 一处纪律披露（不自证清白，也不胡乱归因）**：用户全局 `workspace.json` 在 **15:45:54** 变成 **14426 B / `A22E2DE6…`**（我 15:17 起每次运行的前后测量都是 `69AC2EC0…`）。该写入落在我两次测量之间，**我无法归属**（详见 §6），请 lead 复核条目。

## 2. 逐文件改动摘要（`git diff --stat` 汇总：20 files, +178/−6）

| 类别 | 文件 | 改动 |
|---|---|---|
| **`.ts` 加隔离+断言（+6 行）** ×9 | `arch-t1/probe-parity-t1.ts` · `arch-t1/probe-runtime-smoke-t1.ts` · `arch-t5/probe-t5.ts` · `host-f38/probe-tool-line.ts` · `host-prefix/probe-t22.ts` · `probe-ground-truth.ts` · `probe-wsl-path.ts` · `reliability/inject-b-adapter.ts` · `reliability/inject-delta.ts` | 文件顶部（跳过起始块注释）插"护栏 import + `const dshGuard = isolateDshHome('<tool>')`"；在**最后一个 `process.exit(` 之前**插 `dshGuard.assertUnchanged();` |
| **`.ts` 只补断言（+6 行）** ×4 | `arch-t55/probe-t55.ts` · `probe-t60.ts` · `probe-t66.ts` · `arch-t5/probe-openui.ts` | 顶部插 `watchGlobalWorkspace()`（**不改**它们自己的 `DSH_HOME`）+ 收尾断言 |
| **`.ps1` 起宿主（+16 行）** ×6 | `boot-testhost.ps1` · `stability/boot-stabhost.ps1` · `reliability/inject-a-daemon-kill.ps1` · `usability/p04-boot.ps1` · `usab-run.ps1` · `ux-boot.ps1` | `param` 块加 `[switch]$UseUserHome`（**并给上一个参数补逗号**）；param 块后插"默认孤立 home（含 `$DshHome` 覆盖）+ 记 before sha"；**第一个顶层 `return`/`exit` 之前**插"比 after sha，不同即 `exit 9`" |
| **`.ps1` 只补断言（+9 行）** ×1 | `boot-iso-host.ps1` | 头块只记 before sha（它自带隔离）+ 断言行（**已搬到 `return $p.Id` 之前** —— 首版插在 return 之后**不可达**） |

## 3. 三行补丁配方（可复制给任何新工具）

**`.ts`（进程内 `import src/index.ts` / `apply()`）**
```ts
import { isolateDshHome } from '<相对路径>/arch-t58/tools/dsh-guard.ts';
const dshGuard = isolateDshHome('<tool-name>');   // ★ 必须在任何 import src/** 之前
…工具主体…
dshGuard.assertUnchanged();                        // ★ 前后 sha 不同 ⇒ 抛错 + 非零退出
```
（**只补断言**的工具用 `watchGlobalWorkspace()`，别覆盖它们自己的 `DSH_HOME`。）

**`.ps1`（起宿主/实例）**
```powershell
param( …, [switch]$UseUserHome )                   # ← 别忘了逗号
$script:T73Ws = Join-Path $env:USERPROFILE '.dsh\storages\workspace.json'
$script:T73ShaBefore = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if (-not $UseUserHome) {
  $env:DSH_HOME = Join-Path $env:TEMP '<tool>-home'
  New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_HOME 'storages') | Out-Null
  if (Get-Variable -Name DshHome -Scope 0 -ErrorAction SilentlyContinue) { $DshHome = $env:DSH_HOME }  # ← 见 §5 第 5 条
}
# …起宿主…（断言放在**第一个顶层 return/exit 之前**，否则不可达）
$script:T73ShaAfter = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }
if ($script:T73ShaAfter -ne $script:T73ShaBefore) { Write-Host '[T73] 失败：用户全局 workspace.json 被改写'; exit 9 }
```

## 4. 验收①：普查门禁（`out-21-census-final.*`）

```
汇总：文件 133 ｜ ✓ 合规 26 ｜ ⚠ 无断言 0 ｜ ✗ 待修 0 ｜ N/A 107        census exit=0
20 个目标文件判定：全部 ✓ 合规
  arch-t1/probe-parity-t1.ts · probe-runtime-smoke-t1.ts · arch-t5/probe-t5.ts · probe-openui.ts
  host-f38/probe-tool-line.ts · host-prefix/probe-t22.ts · probe-ground-truth.ts · probe-wsl-path.ts
  arch-t55/probe-t55.ts · probe-t60.ts · probe-t66.ts
  reliability/inject-b-adapter.ts · inject-delta.ts · inject-a-daemon-kill.ps1
  boot-testhost.ps1 · boot-iso-host.ps1 · stability/boot-stabhost.ps1
  usability/p04-boot.ps1 · usab-run.ps1 · ux-boot.ps1
```
（判据本轮**收紧过**：见 §5 —— 现在要求"**真的有隔离调用**"+"**真的有断言行**"，只 import 护栏不算。）

## 5. 验收②：≥3 个真跑 + 前后 sha（原始输出）

| # | 工具 | 类型 | 结果 | sha 证据 |
|---|---|---|---|---|
| ① | `probe-wsl-path.ts` | `.ts` 进程内 `apply()` | `[guard] 孤立 DSH_HOME=…\probe-wsl-path-home-39684`；12 项读数全 `PASS`（含"字面量保留"两组） | `[guard] sha(前)=69ac2ec049365ef0 …⇒ 前后相同 = true`（`out-18-run-wslpath.txt`） |
| ② | `boot-iso-host.ps1 -Port 8915 -DaemonPort 8916 -Tag t73` | `.ps1` 起宿主 | `[iso] DSH_HOME=…\Temp\t73-iso-home`、**`[iso] ready=True token=…`** ⇒ 真起并探活成功 | `[T73] sha(前)=69AC2EC049365EF0` / **`[T73] 用户全局 workspace.json sha 前后相同 = True`**（`out-19-run-bootisohost.txt`） |
| ③ | `boot-testhost.ps1 -Port 8915 -DaemonPort 8916`（**修复后复跑**） | `.ps1` 起宿主 | `[T73] DSH_HOME=…\Temp\boot-testhost-home`、`已建 junction: …\boot-testhost-home\profiles\remote-wsl-test-web\…`、**`--dump-config exit=0`**、`启动：… --profile remote-wsl-test-web --port 8915` ⇒ 真起 | 我自己的前后测量：`before=A22E2DE6D6057ABF after=A22E2DE6D6057ABF 相同=True` |

**"第三个"的诚实约束**：那 20 个里**只有 `boot-iso-host.ps1` 与 `probe-wsl-path.ts` 能在我的端口段（8915–8918）内跑** —— 其余硬编码/白名单端口都不在本段：`arch-t1/*`·`arch-t5/*`·`host-f38`·`host-prefix`·`arch-t55/*` 用 **8911/8912（T66 的段）**；`probe-ground-truth.ts` 用 **8931–8960**；`reliability/*` 用 **8971–8974**；`stability/boot-stabhost.ps1` 自带白名单 **8981–8990 ⇒ 直接拒绝 `-Port 8915`（`EXITCODE=5`）**。**我没有为了凑数去占别人的端口**，所以第 3 个用 `boot-testhost.ps1`（它接受 8915 ✓，且它正是"原来会去用户 home 找 profile"的那个 ⇒ 修复后复跑最有价值）。

> ⚠️ 复跑 ③ 之前，`boot-testhost.ps1` 的头块**不足以隔离**：它的 `param([string]$DshHome = $env:DSH_HOME)` 在**我的头块之前**就求值成用户 home ⇒ 脚本后面按用户 home 拼 profile 路径（首跑实测：`--dump-config exit=1`、`compose 失败，不启动`）。**已补** `if (Get-Variable -Name DshHome …) { $DshHome = $env:DSH_HOME }` 并刷新 6 个 host 类头块 ⇒ 复跑 `--dump-config exit=0` 且**在孤立 home 下建 profile** ✓。

## 6. ⚠️ 纪律披露：`workspace.json` 有一次我**无法归属**的变化

| 时刻 | 事件 | 读数 |
|---|---|---|
| 15:17（T70 末） | — | `11672 B` / `69AC2EC0…` |
| 15:2x–15:4x | **我的每次真跑都前后测量**（probe-wsl-path / boot-iso-host / boot-stabhost / boot-testhost） | 全部 **`69AC2EC0…` 前后相同** |
| **15:45:54** | **出现变化** | **`14426 B`（+2754 B）/ `A22E2DE6…`** |
| 15:48 起（修复后复跑） | 我的 boot-testhost 复跑 | `before=A22E2DE6… after=A22E2DE6…` **相同** |

⇒ 该写入落在我两次测量之间，**我无法证明是我的、也无法排除**；同期活跃的其它写入方：用户宿主 `19387`（pid 33688 存活）、用户会话（Cursor 15:44:35 重启）、以及并行队友的 harness。
**我没有去改它、也没有试图"恢复"它**（T67 已确立：无基线副本时不得乱动用户文件）。**请 lead 复核条目**（上次你核对 11 条完好；本次 +2754 B 属于**实质变化**，不像单纯时间戳）。另：我那次"未修版" `boot-testhost` 运行**没有**在用户 `~/.dsh/profiles/` 下建任何东西（`remote-wsl-test-web*` 目录的 mtime 都是 **10/12**）✓。

## 7. 验收③：故意红（零风险，两类）

**A. `guard-red.ts`（T70 版，替身 + 顺序门禁）**：`红测：6/6 符合预期`
```
[PASS] ①-a 替身未变 ⇒ 断言通过（不误报）
[PASS] ①-b 替身被改写 ⇒ 断言必须抛（有牙） — sha 前=04dd80d38d12 现=7cf63158f300
[PASS] ①-c 替身字节还原 ⇒ 复绿
[PASS] ②-a 修好的副本 ⇒ 普查判 ✓（exit 0）
[PASS] ②-b 隔离挪到 import 之后 ⇒ 普查判 ✗（exit 1）
[PASS] ②-c 字节还原 ⇒ 复绿（exit 0）
```
**B. 内联红测（针对 `--file probe-wsl-path.ts`，即本轮新修文件）**：
```
基线（已修好）        → ✓ 合规 1 ｜ ✗ 0
删掉隔离调用行        → ✗ probe-wsl-path.ts — ✗ 缺隔离（同病）
字节还原              → ✓ 合规 1 ｜ ✗ 0
```
⇒ 门禁对"隔离调用被误删"**有牙**（这条红测还顺手暴露了门禁的一个缺口，见 §8）。

## 8. 量具/codemod 自己的 5 个缺陷（全部修掉并留档）

1. **PowerShell `param` 块必须逗号分隔** —— 换行分隔直接 `ParserError`（我先做了语法前提实验才发现）⇒ codemod 给上一个参数补 `,`。
2. **断言插到 `return` 之后 ⇒ 不可达** —— 首版按"最后一个 `exit`"定位，`boot-iso-host.ps1` 以 `return $p.Id` 结束 ⇒ 断言永不执行（**T73 复跑时才暴露**）⇒ 改为"**第一个顶层 `return`/`exit` 之前**"并加 `--relocate-assert` 搬迁修好。
3. **`shaAssert` 不能用剥注释后的文本** —— 断言的"依据说明"写在注释里 ⇒ 一收紧就一次误判 **26 个** ⚠ ⇒ 拆分：`shaAssert` 用原文、`isolates/assertCall` 用剥注释文本（必须是真代码）。
4. **"import 了护栏"≠"已隔离"** —— 只 import 不调用也过门禁（**内联红测当场抓住**）⇒ 判据改为必须有真调用 + 真断言行；同时补上 `.ps1` 的 `T73ShaAfter` 与旧工具的 `ShaDiff/wsAfter` 等既有写法，避免把"本来就有断言"误判成 ⚠。
5. **`$DshHome` 式 param 默认值在头块之前求值** ⇒ 脚本仍按用户 home 拼路径（复跑实测）⇒ 头块补 `Get-Variable -Name DshHome` 覆盖。
另：**语法检查器自己**也踩过坑（见 T70 报告 §5 第 3 条的姊妹版）：`vm.SourceTextModule` 按 **JS** 解析 `.ts`，把 `interface`/类型注解报成 `SyntaxError` ⇒ 改用 `module.stripTypeScriptTypes()` 先剥类型再解析；13 个 `.ts` + 7 个 `.ps1` **全部解析通过**。

## 9. 写域与收尾

| 项 | 结果 |
|---|---|
| `git status -- src client package.json` | **空**（0 改动）✓ |
| 20 个文件 | `git diff --stat`：**20 files changed, 178 insertions(+), 6 deletions(-)** |
| 端口 | 8915/8916/8917/8918 **free** |
| 我起的宿主 | 全部按 cmdline（`--port 8915` / `--profile t73iso`）**精确停掉**；`boot-iso-host` 的 listener 子进程（pid 40260）已单独取证后清理 |
| unit/守护 | `dsh-rwsl-8915/8916` `inactive`；`reset-failed` rc=1（无失败单元）；无 `daemon.ts` 进程 |
| 宿主/窗口 | `19387` = pid **33688** 全程未碰；无可见窗口由我产生（枚举到的窗口均为用户应用） |
| `%TEMP%` | 我的隔离 home（`t73-iso-home`/`boot-testhost-home`/`stability-boot-stabhost-home`/护栏 home）已清 |
| `/tmp` 匿名脚本 | 3 个（`dsh-rwsl-{25468,36156,40052}-*.sh`）内容**无任何 profile/port 标记** ⇒ **无法归属 ⇒ 未删**（宁可留着也不误删别人的） |

## 10. 两栏

**【一旦错了就得返工】**
1. **`.ps1` 的隔离必须覆盖"param 里捕获的 home 变量"**（`$DshHome` 式）—— 否则脚本算出来的 profile 路径仍指向用户 home；这类脚本的默认值语义是 **lead 裁决的**（默认孤立 + `-UseUserHome`），改默认属于行为变更。
2. **断言位置必须可达**（第一个顶层 `return`/`exit` 之前）；`switch`/分支里的早退路径仍会绕过断言 ⇒ 见未复核。
3. **`workspace.json` 15:45:54 那次变化未归属**（+2754 B，属实质变化）；在 lead 复核前，任何"存储未被碰"的结论都不应写成全文适用。
4. 写域外的同类工具（若还有）不在本次清单内；新增工具请跑 `census-dshhome.ts` 回归。

**【其余的】**
5. 20 个文件的改动都是**可机械复核**的（顶部块 + 收尾块），codemod 幂等（重复跑会 `[skip]`），逐文件 diff 见 §2。
6. 共享护栏 `dsh-guard.ts` 现在有两个入口：`isolateDshHome()`（隔离+观察）与 `watchGlobalWorkspace()`（只观察）。
7. 红测的"替身文件"设计（`T70_WATCH_WS`）继续可复用：**测断言永不必碰真文件**。
8. 那 17 个"跑不了"的工具不是缺陷 —— 它们的端口属于**别人的分配段**；我按纪律没去占。

## 11. 未复核：5 条

1. **`.ps1` 的断言只覆盖"第一个顶层 return/exit"路径**；脚本里更深分支（如"未就绪 ⇒ exit 3"）仍会绕过断言 ⇒ 这些路径的"未碰用户存储"目前靠**外部**前后测量（我在复跑里做了）而非脚本自带断言。
2. **17 个工具未真跑**（端口段限制）；它们的隔离/断言只经**静态门禁 + 语法检查**验证，未做运行时验证。
3. **`workspace.json` 15:45:54 的变化未归属**（无基线副本），只能给时间线；条目是否完好需 lead 复核。
4. `/tmp/dsh-rwsl-{25468,36156,40052}-*.sh` **未做更强归属取证**（无标记、无 .pid、无活进程）⇒ 未删也未认领。
5. **`arch-t48/tools/probe-tools.ts` 等 5 个"原本 ✓"的文件**本轮只因判据收紧/放宽而反复过表（它们本来就有自己的 sha 对照，形式是 `wsBefore === wsAfter`）⇒ 我**没有**去统一它们的写法（不属于本次 20 个的授权范围）。
