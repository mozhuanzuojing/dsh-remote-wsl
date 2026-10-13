# REPORT —— T47 P0：`wsl_open_ui` 调用即崩（缺 import）· 修复 + 同型穷举扫描

> **本文是追加**，不覆盖同目录的 `REPORT-host-split.md`（T5 的交付）。

## 结论

**修了什么**：`src/register-tools.ts` **补 2 行 import**（逻辑一行未改）——
① `allowBuildFlags`（`WebHost.start()` 用）、② **`reapWsl`（`WebHost.stop()` 用）**。
**任务书写的是"补 1 行"，实际是 2 行**：`reapWsl` 只在"**已经真起过一个 web host 之后**再 `{stop:true}`"时才被触达 ——
我先按任务书补了 ① 并真调，**启动路径通过**，但收尾 stop 立刻抛 `ReferenceError: reapWsl is not defined`（同一根因、同一文件）。
这正是"必须真调"的意义所在。

**怎么发现的（证据链）**：① 静态确认 —— `register-tools.ts` 里 `allowBuildFlags` 只出现 1 次、`import` 行不含它；
② **修复前真调** ⇒ `[②b 真正启动] THREW 107ms :: ReferenceError: allowBuildFlags is not defined`（`{stop:true}` 当时反而"正常"，
因为那时没有 WebHost 实例）；③ 补 ① 后真调 ⇒ 启动 OK 但 `[②c 收尾 stop] THREW :: ReferenceError: reapWsl is not defined`；
④ 补 ② 后真调 ⇒ **三态全 OK**。

**根因链**：T1 把 `ALLOW_BUILDS`/`allowBuildFlags` 唯一化到 `src/sdk-runtime.ts` ⇒ T5 把「七个工具的注册面」从 `index.ts`
拆到 `register-tools.ts` 时**漏了这一行 import**；同理 `WebHost.stop()` 的 `reapWsl` 也漏了。零构建 TS + 相对 `.ts` 的形态下
**import 期不报错**，只有执行到那一行才 `ReferenceError` —— 这是同型**第三次**（T3 `launchScript`→`daemonScriptWsl`、T5 自己的 `wsl-io.ts` 漏 `spawn`）。

**验证**：真调三态 + **穷举静态扫描 0 命中**（带两个灵敏度对照）+ `export-matrix` PASS(31) + `check-docs-methods` PASS(13) + `--dump-config` 0/0/0 + **用户全局存储 sha 前后完全相同**。**遗留**见文末「未复核：5 条」。

## ① 修复（只 `src/register-tools.ts`，写域内）

```diff
 import { withModulePrefix } from './explorer.ts';
+// T47（P0 修复，只加 import，逻辑一行未改）：WebHost.start() 的脚本用 allowBuildFlags()
+import { allowBuildFlags } from './sdk-runtime.ts';
-import { runWsl, wslPathConvert, …, removeScript, sleep, renderText, … } from './wsl-io.ts';
+// T47：reapWsl 是 WebHost.stop() 用的（杀包装层后必须收回 WSL 侧的 dsh web）
+import { runWsl, wslPathConvert, …, removeScript, reapWsl, sleep, renderText, … } from './wsl-io.ts';
```
`git status --porcelain -- src/` ⇒ **只有 ` M src/register-tools.ts`**；`register-tools.ts` 新 SHA
`B00B68EE0D5D91BAEFDDECD07B7334D4538CF67EAD4D9FDF93EAEECA22895EA1`。其余 `src/**` 未动。

## ② 真调证明（`probe-openui.ts`，孤立 `DSH_HOME`）

**修复前**（`out-01-before.txt`）：
```
DSH_HOME(孤立)=C:\Users\l\AppData\Local\Temp\t47-home  port=8915
[②a stop:true（无害态）]      OK 113ms :: stopped web host on port 8915
[②b 真正启动（open:false）]   THREW 107ms :: ReferenceError: allowBuildFlags is not defined   ← P0 复现
```
**修复后**（`out-02-after.txt`，`exit=0`）：
```
[②a stop:true（无害态）]      OK 127ms :: stopped web host on port 8915
[②b 真正启动（open:false）]   OK 2587ms :: http://127.0.0.1:8915/?token=… | (opened: not-opened)
[②c 收尾 stop:true]          OK 362ms :: stopped web host on port 8915      ← 补 reapWsl 后才通过
窗口：可见窗口 10 → 10；新增 WindowsTerminal = 0
```
**窗口两数**：本轮 `wsl.exe` 包装层是 `windowsHide`（**无 `detached`**，F-37 四态矩阵里是"无窗"那一格）⇒ **产生过 0 个可见窗口、收尾后 0 个**；`open:false` ⇒ 未调 `openAppWindow`。
**收尾自证**：`/tmp dsh-rwsl-*` 残留 **0**、8915 上 `dsh web` **0**、state 目录只剩 `daemon.log`+`launch-stderr.log`（`WebHost.stop()` 的 `reapWsl`+`removeScript`+`sweepOwnTempFiles` 三件都真的生效了）。

## ③ 同型穷举扫描（命令 + 输出 + 两个灵敏度对照）

命令：`node scan-missing-imports.ts src/register-tools.ts src/wsl-io.ts src/in-host-runtime.ts src/index.ts`
（判据：代码区里形如 `name(` 的调用 ∉ 声明面 ∪ 内建白名单 ⇒ 命中；带**小型词法分析**把注释/字符串/模板文本抹白，
但**保留 `${}` 里的表达式** —— P0 缺陷正是在 `${allowBuildFlags()}` 里）
```
src\register-tools.ts: 0 命中
src\wsl-io.ts: 0 命中
src\in-host-runtime.ts: 0 命中
src\index.ts: 0 命中
命中合计 = 0（0 = 无同型风险）        exit=0
```
**对照（证明夹具真的灵）**：把 import 逐个抽掉再扫 ——
```
ctrl-no-allowbuildflags.ts: 1 命中 ⇒ allowBuildFlags×1     （期望 1 ✓）
ctrl-no-reapwsl.ts:         1 命中 ⇒ reapWsl×1             （期望 1 ✓）
```
**夹具自身修过的 3 个 bug（否则会假阴性/假阳性，如实记）**：
1. 无 `--out` 时 `outIdx+1 = 0` 把**第一个文件整个丢掉**（v1/v2 都因此漏掉 `register-tools.ts`）；
2. 模板字面量**嵌套**（进入 `${}` 后没回到模板文本态）⇒ 把 bash 片段里的 `$(` 当代码，噪声 50 条；
3. "方法定义"判据过宽 ⇒ `${allowBuildFlags()}` 被抹白后落在行首、被误判成方法定义 ⇒ **假阴性**（对照组因此先报 0，收紧成"必须同行 `) {`"后才报 1）。
**同类补充检查（另一种"运行时才炸"）**：`registerTools` 解构的 16 个 deps 键 vs `index.ts` 传入的键 ⇒ **16/16，缺失 0、多余 0**。

## ④ 跨任务护栏与回归

| 检查 | 结果 |
|---|---|
| `arch-t3/tools/export-matrix.ts` | **PASS**（31 符号 typeof/arity 全 OK） |
| `arch-t2/tools/check-docs-methods.ts` | **PASS ｜ 断言 13 条**（T5 轮我报的那条"权威路径写死 index.ts"已被 owner 迁移为 `.ts` 并修好 —— 现在原版即 PASS） |
| `--dump-config`（`remote-wsl-test`） | **exit 0 / `Error:` 0 / 与 T12 基线逐行 diff 0 行** |

**隔离阴性对照（lead 点名的硬纪律）**：全程 `DSH_HOME=%TEMP%\t47-home`（孤立）。
用户全局 `~\.dsh\storages\workspace.json`：`before = 692B5265985936377C63AB347E22BD247DE44B9FA78DD03B8F62F11442DCF25E`，
`after = 692B5265985936377C63AB347E22BD247DE44B9FA78DD03B8F62F11442DCF25E` ⇒ **完全相同**（条目数 3，未增未删未 touch）。

## 【一旦错了就得返工】

1. **"补 1 行"其实不够**：只补 `allowBuildFlags` 时，**启动能过、收尾必炸**，且 `WebHost.stop()` 崩在 `reapWsl` 那行 ⇒
   **WSL 侧的 `dsh web` 会变孤儿继续占端口**（`child.kill()` 只杀 Windows 包装层）+ `/tmp` 脚本残留。
   ⇒ 判据必须覆盖**"起了再停"**这条时序，而不是只测启动。
2. **扫描器的可信度依赖它自己的词法分析**：三个 bug 都造成过假阴性（尤其第 3 个恰好会把本次 P0 判成 0 命中）。
   ⇒ 扫描结论只有在**两个灵敏度对照都命中**时才可用；若将来改扫描器，必须先跑对照。
3. **隔离只是"本轮做法"**：`probe-openui.ts` 里靠 `process.env.DSH_HOME = <孤立>` 生效。若有人改用**真宿主**驱动工具
   （继承默认配置 `DSH_HOME=C:\Users\l\.dsh`），用户全局存储会再次被 touch（A5 那次就是）。
4. **同型缺陷已有三次**（T3/T5/T47）⇒ 建议把"真调 + 静态扫描（带对照）"固化成拆分后的**必跑门禁**；只做 `rg`/逐符号存在性检查抓不到这类问题。

## 【其余的】

- 修复面严格限制在 `src/register-tools.ts`（写域内），未碰 `wsl-io.ts`（任务书允许但确不需要）、`index.ts`、`client/**`、`docs/**`、`package.json`。
- 收尾：`is-system-running = running`、failed 0、`dsh-rwsl-*` 单元 **0**（含 `reset-failed`）、守护 0、`dsh web` 宿主 0、
  `launch.*` 残留 0、`/tmp dsh-rwsl-*` 残留 0（清掉我上一轮 stop 崩掉留下的 1 组 `.sh`/`.pid`）、**无 WindowsTerminal**；
  孤立 `DSH_HOME` 与对照组文件已删；端口只用 8915；未跑 npm/pnpm install；未碰 19387/47604。

## 未复核：5 条

1. **`open:true` 分支**（`openAppWindow(url)` 真给 Windows 开应用窗口）**未测** —— 按纪律全程 `open:false`，所以"应用窗口会不会弹"本轮没有读数；只验了 `wsl.exe` 包装层不产生可见窗口。
2. **`WebHost.start()` 的失败路径**未构造：`dsh web` 起不来 / 60s 内没给出 URL / 非零退出时 tool 的报错与清理（`this.child` 半开状态）。
3. **其余 6 个工具**本轮未再真调（T46 做过逐工具真调；本轮只真调 `wsl_open_ui` 三态；`wsl_status`/explorer 四动作是 T5 轮的读数）。
4. **静态扫描只覆盖"标识符不可解析"**：抓不到"deps 键传了但运行时值为 `undefined`"（键名覆盖已用 16/16 对照补上，值的层面仍未覆盖）。
5. **与 `WebHost` 无关的路径**（`stopAllDaemons` / `sweepStaleRuntimes` / in-host 逃生舱）本轮未复跑。

## 证据文件（`spike/verify/explorer-20261012/arch-t5/`，追加）

`REPORT-openui-p0.md`（本文）、`out-01-before.txt`（修复前真调，含 P0 原文）、`out-02-after.txt`（修复后三态）、
`out-03-scan-fixed.txt` / `out-05-scan-final.txt`（穷举扫描 0 命中）、`out-06-control-allowbuildflags.txt` / `out-06b-control-reapwsl.txt`（两个灵敏度对照）、
`out-07-matrix.txt`（export-matrix PASS）、`out-08-docs.txt`（check-docs-methods PASS 13 条）、`out-09-dumpconfig.txt`、
`user-workspace-sha-before.txt`（隔离阴性对照的 before；after 见文内）；脚本 `probe-openui.ts`、`scan-missing-imports.ts`。
