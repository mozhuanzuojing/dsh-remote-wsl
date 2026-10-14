# T59 · 工具链统一为 `.ts`

- **日期**：2026-10-14 ｜ **执行**：client-contract
- **写域**：`spike/verify/explorer-20261012/**`（含 `tools/precommit-check.ps1`、`host-f37*/`、`visual/`、`arch-*/`）
- **未碰**：`client/**`、`src/**`、`package.json`（`git status` 见 §6）
- **纪律**：未起实例；未装包；未弹窗；宿主 19387（pid **33688**）只读未触碰

---

## 一、清点表（旧名 → 新名 → 引用方）

全仓 **50 个 `.mjs`**，其中**真正的可执行引用只有 5 个文件 6 处**；其余 45 个只被历史报告正文提到（按名）。

| 旧名 | 新名 | 可执行引用方（改前） | 备注 |
|---|---|---|---|
| `tools/check-client-rev.mjs` | `tools/check-client-rev.ts` | `tools/precommit-check.ps1`（第 **271** 行 `Join-Path $PSScriptRoot`，+ 266 注释、293 标签）；`usability/p05-verify.ts:3`（注释） | 门禁第 **07** 项 |
| `host-f37/keepalive-launcher.mjs` | `host-f37/keepalive-launcher.ts` | `host-f37/verify-f37b.ps1:12`（`Join-Path $Root`）；`host-f37b/red-check.ps1:10` + `host-f37b/verify-f37c.ps1:11`（**硬编码到仓外** `D:\project\net1\_t15-f37\`） | 后两处一并改**位置无关** |
| `host-f37/variant-runner.mjs` | `host-f37/variant-runner.ts` | `host-f37/run-ab-windows.ps1:36`（`Start-Process -ArgumentList`） | |
| `arch-t6/tools/panel-map.mjs` | `arch-t6/tools/panel-map.ts` | `gen-split.mjs:24`（注释）；`gen-split2.mjs`（注释） | 非可执行 |
| `arch-t6/tools/panel-smoke-node.mjs` | `arch-t6/tools/panel-smoke-node.ts` | `gen-split.mjs:5`、`gen-split2.mjs:6`（注释） | 非可执行 |
| 其余 **45 个**（`probe-*` / `mut-*` / `visual/tools/*` / `arch-2 tools` / `usability/ux-shot` / `reliability/inject-b-*` / `stability/instrument.selftest` / `client-panel/tools/*` / `arch-t6/gen-split*` …） | 同名 `.ts` | **无** `.ps1`/`.ts`/`.mjs` 可执行引用（只在 `*.md` 历史报告正文里按名出现） | 见 §5 |

**关键事实**：改前 `rg '^\s*import .*\.mjs'`（扫 `.mjs`/`.ts`）**命中 0** ⇒ 本仓**没有**工具之间的 `.mjs` 真实 import（那些"引用"全是脚本头部 usage 注释/报告散文）⇒ 改名不会连带打断模块解析。

## 二、执行顺序（**先位置无关，再改名**）

| 步 | 动作 | 证据 |
|---|---|---|
| 1 | 清点 + 引用方清单 | §一 |
| 2 | **改引用为位置无关**（7 处：precommit 07 的路径/注释/标签；`verify-f37b.ps1`；`run-ab-windows.ps1`；`red-check.ps1`/`verify-f37c.ps1` 的仓外硬编码 → `Split-Path $PSScriptRoot -Parent` 推导） | `git diff --stat` = **4 文件 6 插入 6 删除**；随后补 `run-ab-windows.ps1` 1 行 |
| 3 | `git mv` 改名 **50 个**（0 失败；改名后 `*.mjs` 残留 = **0**） | `git mv = 50 / 普通改名 0 / 失败 0`；`剩余 .mjs 文件数 = 0` |
| 4 | 同步 `precommit-check.ps1` 第 **07** 项路径（08 项本来就是 `.ts`） | 见 §三 |
| 5 | **逐个对齐工具自身 usage/头部里的旧名**（49 个文件；跨工具引用如 `gen-split.ts` 里提 `panel-smoke-node.mjs` 一并改新） | §四 |

## 三、门禁：正/负各一次

**正跑（真仓库，`-SkipNetwork`）**：

```
[PASS] client chunk rev 门禁   07  client-rev 门禁：PASS（模式=git）
[PASS] 漏 import 扫描          08  14 文件 / 命中合计 = 0（0 = 无同型风险）
PASS=10  WARN=3  FAIL=1        （唯一 FAIL = 第 01 项"git status 干净"：75 条未提交改动，属提交前正常态）
exit=1
```

**负跑（副本制）**：

| 负向 | 做法 | 结果 |
|---|---|---|
| ① 第 07 项必须能红 | `%TEMP%\t59-neg` 只放 `client/` + `package.json`，把 `client.api.js` 的 mtime 拨到入口之后（模拟"chunk 变了、入口没 bump"，无 `.git` ⇒ 退 mtime 模式），用 `-PluginRepo <副本>` 跑 | **`[FAIL] client chunk rev 门禁 07 — FAIL（模式=mtime）`** ✅（真仓库同项 PASS） |
| ② 第 08 项灵敏度对照 | `precommit -WithControls`（脚本内建：副本里抽掉 `allowBuildFlags` import） | **`[PASS] 漏 import 对照（灵敏度）08c — 抽掉 allowBuildFlags import ⇒ 扫描器命中（夹具真灵）`** ✅ |
| ③ 工具自带自测 | `node tools/check-client-rev.ts --self-test`（自建副本断言"改 chunk 不动入口 ⇒ FAIL / 改入口 ⇒ PASS"） | **`SELFTEST PASSED（副本目录已清理）`，exit=0** ✅ |

## 四、每个改名后的工具都真跑一次（前台，见其自身输出）

做法：`Start-Process -WindowStyle Hidden` + 12s 有界等待（超时即杀），逐个记 exit 与 stderr 是否含 `SyntaxError`/`ERR_MODULE_NOT_FOUND`。

| 类别 | 数量 | 说明 |
|---|---|---|
| **PASS（真跑 exit 0）** | **14** | `check-client-rev.ts` · `panel-smoke-node.ts`（16/16）· `count-i18n-keys.ts` · `panel-map.ts` · `instrument.selftest.ts` · `menu-grouplabel-audit.ts` · `probe-escape.ts` · `probe-survival.ts` · `probe-p1.ts` · `probe-f38.ts` · `probe-slot-guard.ts` · `probe-tool-line.ts` · `probe-t22.ts` · `probe-a1-degrade.ts` |
| **装载 OK（退出码 1/2 = 缺参数或夹具）** | **19** | 例如 `css-token-audit.ts`/`box-sizing-audit.ts`/`asar-read.ts`/`extract-css.ts`（打印 usage 后 exit 2）、`contrast-check.ts`/`token-descriptors.ts`/`usage-of-token.ts`/`overlay-on-surfaces.ts`（需 `asar` 参数，exit 1）、`mut-*.ts`（需目标文件参数）——**均无语法/模块错误** |
| **超时（按设计长跑，已杀）** | **5** | `probe-detach-diag.ts` / `probe-detach-forms.ts` / `probe-kill-semantics.ts` / `probe-kill-semantics2.ts` / `probe-survive2.ts` —— 它们本来就在等 WSL 侧后台进程，**装载成功**后被我 12s 超时终止 |
| **不裸跑（有副作用，只做解析检查）** | **10** | `gen-split.ts` / `gen-split2.ts` / `split-panel.ts`（**会写 `client/**`**）· `serve-t42.ts`（起服务器）· `keepalive-launcher.ts` / `variant-runner.ts` / `inject-b-api-gate.ts` / `probe-f32-f15.ts` / `probe-wsl-path.ts` / `ux-shot.ts`（起实例/守护/浏览器） |
| **非改名所致的既有失败** | **2** | 见 §4.1 |
| 合计 | **50** | = 改名总数 |

**解析检查**：50/50 通过 `node --check`（这些文件是纯 JS 改扩展名，无可擦除类型，故 `--check` 直接可判）。

### 4.1 两个"非改名所致"的失败（**重要发现，但不是 T59 的锅**）

| 工具 | 现象 | 根因（已定位） |
|---|---|---|
| `host-a1/probe-a1.ts` | 断言块红（`ECONNREFUSED 127.0.0.1:3093`） | 它需要**真 host 实例**（孤立 DSH_HOME、端口 3093）作为夹具；本次裸跑没起 ⇒ 断言按设计红。**装载与执行正常**。 |
| `host-f37b/probe-copy-detect.ts` | `ERR_MODULE_NOT_FOUND: …\t17-sysd-copy\daemon-protocol.ts imported from …\daemon-client.ts` | 它把 `src/` 拷进 `%TEMP%` 副本时用的是**拆分前的文件清单**；T3 把 `daemon-client.ts` 拆出 `daemon-protocol.ts` 等新文件后，该清单不再完整 ⇒ 副本里缺文件。**与 `.mjs→.ts` 无关**（改名只动 `spike/verify/**` 的扩展名）。**建议交 T3 owner 或 lead 单开一行修**（补 `daemon-protocol.ts` 等新文件进拷贝清单）。 |

## 五、旧名残留扫描（"活跃引用 = 0"）

扫描范围：`spike/verify/**` 的 `*.ts` / `*.ps1`。

**可执行引用残留 = 0**（所有 `Join-Path` / `Start-Process` / `console.error usage` / 头部 `用法：` 中的旧名均已改为 `.ts`，共对齐 **49 个文件**）。

剩余 `.mjs` 字面量 **13 处，逐处理由**：

| 位置 | 为什么不改 |
|---|---|
| `arch-t2/tools/check-docs-methods.ts:4,15` | 正文在**叙述更名历史本身**（"2026-10-13 由 `.mjs` 改名 `.ts`"）——改掉会让历史失真 |
| `arch-t4/tools/check-explorer-methods.ts:7,17` | 同上（叙述更名 + 解释"为什么新脚本用 `.ts`"） |
| `arch-t5/run-patched-gate.ts:4,11,17` | 同上（描述旧路径失效的历史） |
| `arch-t5/index.orig.ts:177,181,566,717` | 这是**冻结的旧版原文**（证据文件）；且此处的 `.mjs` 是**生成启动脚本的扩展名**，与工具链无关 |
| `tools/precommit-check.ps1:266` | 我写的注记"…`.ts`（2026-10-14 由 `.mjs` 更名，判据未改）"——**正是要求的指针** |
| `spike/verify/one-runtime.ts:14`、`probe-shellenv.ts:6`（**explorer-20261012 之外**） | 历史迁移说明散文 |

另：`src/wsl-io.ts` / `src/register-tools.ts` / `src/daemon-protocol.ts` 里的 `.mjs` 是**插件在 WSL 里生成的启动脚本扩展名**（`writeScript(..., '.mjs')`），与工具链无关，且 `src/**` 不在本任务写域 ⇒ 不动。

## 六、写域与纪律证据

- `git status --porcelain` 共 **75 条**：其中 **59 条**是我的（49 个工具对齐 + `precommit-check.ps1` + `host-f37*/verify-f37b.ps1`/`run-ab-windows.ps1`/`red-check.ps1`/`verify-f37c.ps1` + …）；其余是**其它 teammate 的在飞产物**（`arch-t55/`、`arch-t56/`、`client-panel/out-4*`、`n4-readings-*.json`、`check-n4-menugroups.ts` 等）。**未碰 `client/**`、`src/**`、`package.json`**。
- 收尾：`dsh-rwsl*` unit **0** · `--state=failed` 已 `reset-failed` 归 **0** · `daemon.ts` 进程 **0** · `launch.*.sh` **0** · 我这次探针跑出的 `%TEMP%\t17-sysd-copy` 已删 · 副本 `%TEMP%\t59-neg` 已删。
- 期间 precommit 第 05b 项曾报"4 条 dsh 进程"（`pnpm dlx @deepseek-ai/dsh --profile sdk`，父进程已消失的孤儿）；我按纪律**未擅自 kill**（无法确证是不是 T55/T56 的在飞测试），最终复查它们已自行退出，末次 precommit 该项 **PASS**。
- 可见窗口枚举无 `wsl.exe`/WindowsTerminal 子节点 ⇒ 本任务**产生 0 个窗口**。

---

## 【一旦错了就得返工】

1. **改名必须晚于引用位置无关化**——否则就是 T45 那轮的复现（`.mjs` 调用方失效）。本次 07 项在改名前会因路径指向 `.mjs` 而找不到脚本 ⇒ 先改路径再 `git mv`。
2. **`node --check` 不能判 `.ts`**（`checkSyntax` 不做类型擦除）：`node --check x.ts` 对**含类型标注**的文件会误报 `SyntaxError`。本仓这 50 个是纯 JS 改扩展名，故可用；**新写含类型的 .ts 工具不能用它做门禁**（要跑 `node <file>` 或 `--experimental-strip-types` 的等价手段）。这条已写进报告，避免下次误判。
3. **旧名不是一个字符串**：真正会失效的是"路径拼接/`Start-Process` 参数/usage 里的 `console.error`"，而注释与历史散文**允许保留**（lead 已裁决）。判据必须区分这两类，否则会把历史文本改成假话。

## 【其余的】

- 顺手修掉一处**真错名**：`visual/tools/scan-asar-tokens.ts` 的 usage 原写 `node scan-asar.mjs`（文件根本不叫这名）⇒ 已改为自身名。
- `-WithControls` 现在能一次性给出 08 项的灵敏度对照（+18 秒成本），建议保留在提交前清单的**可选**路径上。

## 未复核：3 条

1. **10 个"有副作用"工具改名后未做功能级复跑**（`gen-split*.ts`/`split-panel.ts` 会写 `client/**`、`serve-t42.ts` 起服务器、`keepalive-launcher.ts`/`variant-runner.ts`/`inject-b-api-gate.ts`/`probe-f32-f15.ts`/`probe-wsl-path.ts`/`ux-shot.ts` 需要实例/守护/浏览器）—— 只做了**解析检查通过**。它们的 `.ts` 装载能力已证（`node --check` + 与 `.mjs` 同字节内容），**功能级**未验。
2. **5 个超时工具**（`probe-detach-*`/`probe-kill-semantics*`/`probe-survive2`）只证"装载成功 + 按设计长跑"，其**断言结论**未取（它们等 WSL 后台进程，需按各自用法喂参数）。
3. `host-f37b/probe-copy-detect.ts` 的**既有缺陷**（拷贝清单缺 T3 拆分出的新文件）我只定位未修 —— 修复属 T3 域。
