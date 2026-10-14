# REPORT-dshhome-isolation-sweep.md —— T70：根治"未隔离 `DSH_HOME` 就 `import src/**`/`apply()`"这一类

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-14 ｜ **任务**：`task-70`
- **写域**：`arch-t3/tools/`（修 `smoke-e2e.ts`）· `arch-t58/`（共享护栏 + 普查器 + 红测 + 本报告）· `arch-t56/` **按 lead 指示未动**（其 `probe-tools.ts` 本就合规）
- **端口**：8915–8918 ｜ **未碰** `client/**`、`src/**`、`package.json`、宿主 19387（pid 33688）｜ **未写**真实 `~/.dsh/storages/workspace.json`
- **工具**：`arch-t58/tools/dsh-guard.ts`（共享护栏）· `census-dshhome.ts`（普查+顺序门禁）· `guard-red.ts`（零风险红测）

## 1. 结论

**根因修掉并留了可复跑的护栏**：新增共享护栏 `dsh-guard.ts`（**import 之前**隔离 `DSH_HOME` + 收尾断言"用户全局 `workspace.json` 前后 sha256 相同"），`arch-t3/tools/smoke-e2e.ts` 已接入 ⇒ **真跑 19/19 PASS，且用户全局 `workspace.json` sha 前后完全相同**（`69AC2EC0…` 未变）。
**全仓普查 131 个工具/脚本**：✓ 合规 **8** ｜ ⚠ 有隔离但无前后断言 **8** ｜ ✗ 缺隔离（同病）**12** ｜ N/A **103**。**12 个 ✗ 全在我写域之外**（arch-t1 / arch-t5 / host-f38 / host-prefix / 根目录探针 / reliability / stability / boot-testhost.ps1），我**没有越界改**，报告 §6 给了逐条处置建议与三行补丁配方。
**故意红 6/6 符合预期**（零风险）：替身文件证明"前后 sha 断言有牙"（改了就抛）、顺序门禁证明"隔离必须发生在 import 之前"（挪到后面 ⇒ 普查判 ✗，字节还原复绿）。**之所以不用传统红**：那必须真去写用户的文件，本任务明令禁止 ⇒ 用等价零副作用构造 + 引用 T67 已记录的历史受控实验作为机制实证。

## 2. 定因：这类工具**为什么会悄悄改写用户文件**

链条（每一步都不报错，所以是"悄悄"）：
1. 工具在**自己的进程里** `await import('.../src/index.ts')` 然后 `apply(ctx, cfg)` —— 这只是**注册**（7 个工具 + 1 条 explorer 路由），**本身不写盘**；
2. 一旦工具**驱动**了这些面（`explorer.snapshot` / `explorer.addWorkspace` / `wsl_status` …），DSH 的工作区注册表就会**经由存储根落盘**；
3. 存储根由 **`DSH_HOME`** 决定，而工具**从没覆盖**它 ⇒ 落到默认的 **用户 `~/.dsh`** ⇒ 写的就是**用户的** `storages/workspace.json`；
4. 写入是**原子替换**（实测 `CreationTime == LastWriteTime`，不是原地追加），所以**第 3 次复现**才被 mtime 抓住；
5. 更隐蔽的是：`apply()` 之后**同一进程里再 import `src/**` 的其它模块**都会沿用这个（未隔离的）存储根 ⇒ **隔离必须发生在 import 之前**（模块在 import 期就可能捕获根），这也是为什么我把顺序做成门禁判据。

**实证（T67，历史记录）**：未隔离运行 3 次 ↔ 该文件被改写 3 次（15:10:50 `0AC5208C…`、15:15:03 `A1B6D08D…`、更早 11:56 `DCE16CFB…`）；**同一工具在孤立 `DSH_HOME` 下 sha 前后相同**。lead 已核对条目内容完好（11 条不变）。

## 3. 全仓普查表（`census-dshhome.ts`，131 个 `.ts/.mjs/.ps1`）

判定口径：**需要隔离** = 进程内 import 宿主入口 `src/index.ts` / 调 `apply()` / 起宿主实例（`dsh … --profile … --port …`）；
**合规** = ① 设了 `DSH_HOME`（或接共享护栏）；② 有"用户全局 workspace.json 前后比 sha"的断言；③ **隔离发生在 import 之前**。
（普查器**先剥注释再判** —— 否则注释里的 `dsh web` 会被当成"起实例"；详见 §5。）

| 工具 | import 宿主入口 | apply() | 起实例 | 设 DSH_HOME | 共享护栏 | 前后 sha 断言 | 隔离在 import 前 | 判定 |
|---|---|---|---|---|---|---|---|---|
| `arch-t3/tools/smoke-e2e.ts` | 是 | 是 | 否 | 否 | **是** | **是** | **是** | **✓ 合规（本次已修）** |
| `arch-t48/tools/probe-tools.ts` | 是 | 是 | 否 | 是 | 否 | 是 | 是 | ✓ 合规 |
| `arch-t58/tools/daemon-residuals.ts` | 是 | 是 | 否 | 是 | 否 | 是 | 是 | ✓ 合规（T67 已修） |
| `arch-t58/tools/census-dshhome.ts` | 否 | 否 | 是 | 否 | 是 | 否 | — | ✓ 合规（自带顺序门禁） |
| `usability/p05-boot.ps1` · `p06-final/p06-boot.ps1` · `p07-narrow/p07-boot.ps1` · `visual/t65/t65-boot.ps1` | 否 | 否 | 是 | 是 | 否 | 是 | — | ✓ 合规（4 个） |
| `arch-t55/probe-t55.ts` · `probe-t60.ts` · `probe-t66.ts` | 是 | 否 | 否/是 | 是 | 否 | **否** | 是 | ⚠ 有隔离但**无前后 sha 断言** |
| `arch-t5/probe-openui.ts` | 是 | 是 | 否 | 是 | 否 | **否** | 是 | ⚠ 同上 |
| `boot-iso-host.ps1` | 否 | 否 | 是 | 是 | 否 | **否** | — | ⚠ 同上 |
| `usability/p04-boot.ps1` · `usab-run.ps1` · `ux-boot.ps1` | 否 | 否 | 是 | 是（**默认落回用户 `~/.dsh`**） | 否 | **否** | — | ⚠ 同上 + 默认值危险 |
| `arch-t1/probe-parity-t1.ts` · `probe-runtime-smoke-t1.ts` | 是 | 是 | 否 | **否** | 否 | **否** | 否 | **✗ 缺隔离（同病）** |
| `arch-t5/probe-t5.ts` · `host-f38/probe-tool-line.ts` · `host-prefix/probe-t22.ts` · `probe-ground-truth.ts` · `probe-wsl-path.ts` · `reliability/inject-b-adapter.ts` · `inject-delta.ts` | 是 | 是 | 否 | **否** | 否 | **否** | 否 | **✗ 缺隔离（同病）** |
| `boot-testhost.ps1` · `stability/boot-stabhost.ps1` · `reliability/inject-a-daemon-kill.ps1` | 否 | 否 | 是（**默认继承用户 `DSH_HOME`**） | **否** | 否 | **否** | — | **✗ 缺隔离（同病）** |
| 其余 **103** 个（纯审计/生成/取证脚本：`visual/tools/*`、`client-panel/tools/*`、`tools/*`、`arch-t2/tools/*`、`arch-t6/tools/*` …） | 否 | 否 | 否 | — | — | — | — | N/A（不触 storages） |

```
汇总：文件 131 ｜ ✓ 合规 8 ｜ ⚠ 无断言 8 ｜ ✗ 待修 12 ｜ N/A 103
（完整表与逐行证据见 out-08-census-final.json / .txt；`--evidence` 模式会打出每个命中的**行号与原文**）
```

**我写域内的结论**：`arch-t3/tools/*`（除 smoke-e2e 外全 N/A，已修 1 个）、`arch-t58/*`（全部 ✓/N/A）、`arch-t56/tools/*`（全 N/A；`probe-tools.ts` 属另一个目录且本就 ✓）⇒ **写域内已无同病项**。

## 4. 修法与真跑证据

**共享护栏 `arch-t58/tools/dsh-guard.ts`（3 行接入）**
```ts
import { isolateDshHome } from '../../arch-t58/tools/dsh-guard.ts';
const guard = isolateDshHome('t70-smoke-e2e');   // ★ 必须在任何 import src/** 之前
…跑工具…
guard.assertUnchanged();                          // ★ 前后 sha 不同 ⇒ 抛错 + exit 1
```

**`arch-t3/tools/smoke-e2e.ts` 的改动**（3 处）：① 顶部 import 护栏 + 文件头写清这条纪律；② 参数解析之后、
**任何 `import src/**` 之前**调 `isolateDshHome('t70-smoke-e2e')`；③ 收尾断言 + 把 `guard` 的前后 sha 落进 `--out` JSON、失败时 exit 1。

**真跑（端口 8915，前台看到它自己的输出）**：
```
[guard] 孤立 DSH_HOME = C:\Users\l\AppData\Local\Temp\t70-smoke-e2e-home-36604
[guard] 观察的注册表 = C:\Users\l\.dsh\storages\workspace.json  sha(前) = 69ac2ec049365ef0
…（A1–D2 共 19 条断言全 PASS，含 mode=systemd / wsl_status / explorer.snapshot / listDir / SIGSTOP 失败面 ok:false）…
[guard] sha(后) = 69ac2ec049365ef0 ⇒ 前后相同 = true
冒烟：19/19 PASS；失败：(无)
T70 隔离：用户全局 workspace.json sha 前后相同 = true
smoke exit=0
```
事后复核：`workspace.json` = **11672 B / mtime 15:17:05 / sha256 `69AC2EC049365EF0…469E14`** —— **与我 T70 动手前完全一致**（`LastWriteTime` 也没被推后）。

## 5. 故意红（零风险，6/6 符合预期；原始输出 `out-10-guard-red.txt`）

命令：`node --experimental-strip-types arch-t58/tools/guard-red.ts` ⇒ `红测：6/6 符合预期 ｜ red exit=0`
```
[guard] 观察的注册表 = C:\Users\l\AppData\Local\Temp\t70-decoy-30548.json  sha(前) = 04dd80d38d12a485
[PASS] ①-a 替身未变 ⇒ 断言通过（不误报）
[guard] sha(后) = 7cf63158f3005114 ⇒ 前后相同 = false
       断言抛出的原文：T70 隔离断言失败：…t70-decoy-30548.json 在本次运行中被改写（before=04dd80d38d12a485…）
[PASS] ①-b 替身被改写 ⇒ 断言必须抛（有牙）
[PASS] ①-c 替身字节还原 ⇒ 复绿
[PASS] ②-a 修好的副本 ⇒ 普查判 ✓（exit 0） — 汇总：文件 1 ｜ ✓ 合规 1 ｜ ⚠ 0 ｜ ✗ 0
[PASS] ②-b 隔离挪到 import 之后 ⇒ 普查判 ✗（exit 1） — ✗ arch-t3/tools/smoke-e2e.ts — ✗ 隔离在 import 之后（无效）
[PASS] ②-c 字节还原 ⇒ 复绿（exit 0）
```
**为什么不用"去掉隔离 ⇒ 碰真文件"这种传统红**：本任务明令"绝不再写真实 `~/.dsh/storages/workspace.json`"。替代证据 = ①/② 两条零副作用构造 **+** T67 已记录的受控实验（未隔离 3 次 ↔ 改写 3 次；隔离后前后同 sha）——机制层面已被证明，不需要再牺牲一次用户文件。

**普查器自身踩的三个坑（一并留档，因为它也是量具）**：
1. 不剥注释 ⇒ 注释里的 `dsh web` 被当"起实例"（误报 `splice-t1` / `split-t5*` / `harness-t60` 等）；
2. 行注释正则写成 `(^|[^:])//` ⇒ **`file:///…` 被当注释**，import 行整条被抹 ⇒ `smoke-e2e` 被判 N/A；
3. **顺序**：块注释必须在**行注释之后**剥 —— 否则行注释里的 `` `src/**` `` 会给块注释"开头"，一路吃到后面的 `*/`，把中间的 import/apply 全抹掉（`smoke-e2e` 又被判 N/A 一次）。
⇒ 与 T56/T62 的教训同族：**量具的"白能力"（不误判）和"红能力"都要自测**，而且**判据要能解释它自己**。

## 6. 写域外 12 个 ✗ / 8 个 ⚠ 的处置建议（我**没有**越界改）

**统一补丁配方（3 行，按文件类型二选一）**
- `.ts` 工具：文件最前 `import { isolateDshHome } from '<相对路径>/arch-t58/tools/dsh-guard.ts';`，在**任何 `import src/**` 之前** `const guard = isolateDshHome('<tool-name>');`，收尾 `guard.assertUnchanged();`。
- `.ps1` 起宿主脚本：在 `Start-Process … --profile … --port …` **之前**加
  `$env:DSH_HOME = Join-Path $env:TEMP "<tool>-home"`（并把它写进"用户全局 sha 前后对照"收尾输出）。

**优先级（按"会不会真写用户文件"排）**
1. **`.ps1` 起宿主且默认用户 `DSH_HOME`**（`boot-testhost.ps1`、`stability/boot-stabhost.ps1`、`usability/p04-boot.ps1`、`usab-run.ps1`、`ux-boot.ps1`）—— 起宿主时注册表**必写**，风险最高；建议 owner 改成"默认 `%TEMP%\<tool>-home`"，并把真实 home 作为**显式开关**（`-UseUserHome`）。
2. **`.ts` 进程内 `import src/index.ts` + `apply()` 且无隔离**（`arch-t1/probe-parity-t1.ts`、`probe-runtime-smoke-t1.ts`、`arch-t5/probe-t5.ts`、`host-f38/probe-tool-line.ts`、`host-prefix/probe-t22.ts`、`probe-ground-truth.ts`、`probe-wsl-path.ts`、`reliability/inject-b-adapter.ts`、`reliability/inject-delta.ts`）—— 驱动 explorer 面时才写，风险中但**已被证明发生过**；按上面 3 行配方改。
3. **⚠ 有隔离无断言**（`arch-t55/probe-{t55,t60,t66}.ts`、`arch-t5/probe-openui.ts`、`boot-iso-host.ps1`、`p04-boot.ps1`、`usab-run.ps1`、`ux-boot.ps1`）—— 加"前后 sha 对照 + 不同即判红"即可闭环；否则下次仍无法自证。
   > **例外（可判理由）**：若某个工具**故意**要用真实 `DSH_HOME`（例如验证"用户全局存储"的真实路径），必须在报告里写明理由，并加**显式开关**（如 `--use-user-home`）+ 前后 sha 对照；默认必须是隔离的。

## 7. 纪律与收尾

| 项 | 结果 |
|---|---|
| `git status`（写域） | ` M arch-t3/tools/smoke-e2e.ts` + `?? arch-t58/tools/{dsh-guard,census-dshhome,guard-red}.ts` + `?? arch-t58/out-0[6-9]/out-10` + 本报告；**`src/**`、`client/**` 零改动** |
| **用户全局 `workspace.json`** | 全程未变：`11672 B`、`mtime 2026-10-14 15:17:05`、`sha256 69AC2EC0…469E14`（T70 动手前=动手后） |
| 端口 | 8915–8918（smoke 用 8915）；收尾全 free |
| 我的守护/unit | 冒烟自清（D1/D2 PASS）；`dsh-rwsl-8915.service` `inactive`；`--failed` = 0；`reset-failed` rc=1（无失败单元） |
| 副本/临时 | `%TEMP%\t70-*`（护栏 home、替身、红测树）已删；`/tmp/dsh-rwsl-*` 复核 |
| 宿主/窗口 | 19387 = pid **33688** 全程未碰；启动一律 `windowsHide`/Hidden ⇒ **我方可见窗口 0** |

## 8. 两栏

**【一旦错了就得返工】**
1. **顺序就是语义**：隔离必须在 **import `src/**` 之前**。改到后面（哪怕内容对）等于没隔离 —— 已做成普查器的门禁判据（②-b 证明它抓得住）。
2. **`.ps1` 起宿主的默认值**是这一类的最大风险面（默认用户 `DSH_HOME` ⇒ 必写用户注册表）；改默认值属于行为变更，需 owner 拍板 + 显式开关。
3. **写域外的 12 个 ✗ 一个都不许"顺手"改**（它们属 T1/T5/T22/T38/T69/reliability/stability 等域）；本报告只给配方与优先级。
4. **普查器的判据是启发式的**（注释剥离、`apply(ctx)` 形态、`--profile…--port` 形态）：它能抓住"我们已知的形态"，但换个写法（例如把 import 包成工厂函数）可能漏判 ⇒ 新增工具时**人也要看一眼**。

**【其余的】**
5. 共享护栏刻意做成**零依赖 + 可被 `.ts` 工具相对 import**；红测用 `T70_WATCH_WS` 指替身 ⇒ **测断言不必碰真文件**（这个设计以后可复用到任何"文件不可碰"的场合）。
6. 本次普查顺带产出**全仓工具清单**（131 个），以后新增工具可直接跑 `census-dshhome.ts` 回归。
7. `arch-t56/tools/probe-tools.ts` 本就合规（有孤立 home + 前后对照）⇒ 按 lead 指示**未动** `arch-t56/`。

## 9. 未复核：5 条

1. **写域外 12 个 ✗ 未修**（越界禁止）；我只给了配方与优先级，**未逐个验证**改完能过门禁。
2. 普查器**未覆盖非 `.ts/.mjs/.ps1`**（如 `.cjs`、`.cmd`、`.json` 里内嵌命令），也未覆盖 `spike/` 之外（如 `tools/`、`docs/` 里的脚本片段）。
3. **"DSH_HOME 是在 import 期还是首次写盘时读取"**未做上游源码级确认 —— 我按"保守取 import 之前"处理（②-b 只证明门禁判据有效，不证明"晚设置一定失败"）。
4. **`.ps1` 那一类的"必写"结论**来自代码阅读（`Start-Process … --port` 会起宿主）而非本轮实测；我没有起用户 home 的宿主实例去复现（那正是要避免的事）。
5. `usability/usab-run.ps1`/`ux-boot.ps1`/`p04-boot.ps1` 里的 `if (-not $env:DSH_HOME) { … USERPROFILE\.dsh }` 是否在**所有**调用路径上都会落回用户 home，未逐路径审计（只按"默认值"判定）。
