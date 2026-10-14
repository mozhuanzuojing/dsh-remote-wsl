# REPORT-t46-refactor-verify.md —— T46 终验（架构债 T1–T6 + UX 二轮）

- **验证者**：`p0-verify`｜**日期**：2026-10-13｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **开工基线**：工作树 **porcelain = 0 行（干净）**，HEAD **`c3297dd`**（引用对齐一笔）；跑门禁过程中我自己的证据文件（`out-16x…`）落进仓库 ⇒ 收尾 `precommit` 的 "git 干净" 项变 FAIL，**经分类：8 条改动全在 `spike/verify/explorer-20261012/`（7 条我的 out-*、1 条他人报告编辑），`src/`、`client/`、`package.json`、`docs/`、`README` 全未被改** ⇒ 插件本体干净。
- **P0.5 冻结**：新 `REVISION.txt` = **25 锚点（src=14 + client=10 + package.json=1）**，preflight 4 项 OK；收尾 `-Mode Check`：**锚点一致 = True**（advisory 仅 README/docs ⇒ exit 3）。旧档归档 `REVISION-t33-frozen.txt`；写盘日志 `out-176-t46-revision-write.txt`。

## 结论（≤450 字）

**A 段硬门禁基本全绿，但"逐工具真调"抓到一个 P0 级真缺陷：`wsl_open_ui` 调用即崩。** `register-tools.ts:35/37` 用了 `allowBuildFlags()` 而**从未 import 它**（该符号只在 `in-host-runtime.ts:14` 被导入）⇒ `WebHost.start` 抛 `ReferenceError: allowBuildFlags is not defined`（`register-tools.ts:35:86` ← `:648:32` ← `driveTool`）。这是 T1"去重"落在 `sdk-runtime.ts` 后，WebHost 那条脚本模板没跟着补 import 的**回归**；"注册面对照"永远看不到它（注册成功、调用才炸）—— 正是 lead 要求真调的理由。
**已复算**：`export-matrix.ts` **31 符号全 OK / PASS**；`check-docs-methods.ts` **13 断言 PASS**；行数 `src/index.ts` **266**、`daemon-client.ts` **56（薄 re-export）**、`client.panel*.js` 六个 **202/205/291/317/332/339 全 <400**；`--dump-config` **exit 0 / Error 0 / 1266 行**，与基线差 **7 行**经分类**全是我孤立 profile 的 patch 块**（`patched by …t46iso\cordis.patch.yml` + distro/dshVersion/daemonPort），**同 profile 两次 dump diff = 0**；HTTP 路由 E2E **403/403/415/槽位 400 E_ARG/6 方法/无 token 回显**全绿；`css-token-audit` **10 个 client 文件全 exit 0**（C1=0、C2⊆17、S1 OK）、`box-sizing-audit` **真陷阱 0**、`panel-smoke-node` **16/16**、`check-client-rev` **exit 0（rev=afc26d1a2793，9 chunk，自洽）**。
**构造项**：T3 **compat 回退**（`=off`）实测 `mode=compat-detached` + 完整 warning，**窗口 产 1 / 收尾 0**（新窗口 `WindowsTerminal` pid 45116，start 18:21:37）；`daemonPrompt` **成功路径**由 `wsl_agent` 真调取证（返回 `t46`、session `completedBy=turn/end turns=1`）；`<420px`（380）**三层菜单**= 工作区/守护/诊断、组标题全 `tabindex=-1`、不遮状态词；**dark** 下 V1 **16/16 无违规**、`footerH` **47**、组标题对比度 **5.55:1**、面板内 `box-shadow` **0**；M1=1、M5=0、M14 91==91、M15 2px/600、M16 单 `⋯`。**故意红 3/3**（C1 硬编码色 / CJK 中文字面量 / 行数≥400 —— 全部副本制、字节还原）。
**未复核**：T1 冷启动 timeout 与逃生舱 5 分支、`stopAllDaemons` 语义、V3 八宽度（只测宽+380）、V7 hover 两主题、M6/M7/M10/M11/M12④/M17、像素截图。

## A. 硬门禁逐条复跑

| # | 门禁 | 读数 |
|---|---|---|
| A1 | `arch-t3/tools/export-matrix.ts` | **exit 0**，`OK` 行 **31 个**，`结果：PASS`（含 `configCompat/ensureDaemon/stopDaemon/stopAllDaemons/daemonSnapshot/daemonStatus` …） |
| A2 | `arch-t2/tools/check-docs-methods.ts` | **exit 0**，`结果：PASS ｜ 断言 13 条` |
| A3 | 行数 | `src/index.ts` **266**（<400 ✓）｜`src/daemon-client.ts` **56 行**（薄 re-export ✓）｜`client.panel.js` **205**、`.header` **202**、`.helpers` **291**、`.actions` **317**、`.browser` **332**、`.tail` **339** —— **全 <400** ✓（另记：`client/index.js` 419 行，不在该门禁的清单内） |
| A4 | `--dump-config` | **exit 0**、`Error:` **0**、1266 行；vs `out-03-dumpconfig-base.txt` 差 **7 行**、vs arch 轮基线差 33 行 —— **差集逐行核对 = 我的孤立 profile patch 块**（`# == dsh-remote-wsl, patched by …\t46iso\cordis.patch.yml`、`- id: remote-wsl`、`config:`、`distro/dshVersion/daemonPort: 8932`）⇒ **无源码级配置回归**；**同 profile 连跑两次 diff = 0**（确定性 ✓） |
| A5 | **7 工具逐工具真调** | `selftest.ts tool <name>`：`wsl_status` **exit 0**（distros/target/wsl ip/shell env）｜`wsl_exec` **0**（`true` 空输出）｜`wsl_agent` **0**（真 task ⇒ 返回 `t46`，`backend=daemon session=…completedBy=turn/end turns=1`，走 systemd unit `dsh-rwsl-8731.service`）｜`wsl_daemon` **0**（`daemon: not running` + machine 行 + state dir）｜**`wsl_open_ui` exit 1 ⇒ 见 §B**｜`wsl_sync_version` **0**（desktop 0.2.0-rc.2 ↔ wsl pin，drift=no）｜`wsl_path` **0**（`/home/g` → `\\wsl.localhost\debian-u8-1\home\g`） |
| A6 | HTTP 路由 E2E（孤立家） | 缺 Origin **403**｜伪造 Origin **403**｜`text/plain` **415**｜槽位守卫 `ensure slot=8977` **400 `E_ARG`**｜方法白名单 **6 个**（`explorer.snapshot/openSession/daemon/fixPin/listDir/addWorkspace`）｜响应不含 token |

## B. ★ P0 缺陷：`wsl_open_ui` 调用即崩（T1 去重回归）

**症状（真调原始输出）**
```
file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/register-tools.ts:35
    const script = `${shellPreamble(this.cfg, { withShellEnv: true })}cd "${this.cfg.wslHome}" || exit 2
                                                                                     ^
ReferenceError: allowBuildFlags is not defined
    at WebHost.start (register-tools.ts:35:86)
    at Object.execute (register-tools.ts:648:32)
```
**根因**：`register-tools.ts` 的 import 段（L10–L20）**没有** `allowBuildFlags`；全文件该符号只出现 **1 次**（L37 的 `${allowBuildFlags()}`），**import 行含它 = False**。唯一正确导入在 `in-host-runtime.ts:14`（`import { SdkRuntime, allowBuildFlags, runtimeAdapter } from './sdk-runtime.ts'`）。⇒ T1 把 `ALLOW_BUILDS/allowBuildFlags` 收进 `sdk-runtime.ts` 时，`register-tools.ts` 里 **WebHost 那条启动脚本模板**（`wsl_open_ui` 的主路径）漏补 import。
**影响面**：`wsl_open_ui`（默认 `open:true` 的启动路径）**100% 不可用**；`wsl_open_ui {stop:true}` 不受影响（不走 `shellPreamble`）；`wsl_agent` **不受影响**（走 `in-host-runtime.ts` 的 SdkRuntime 适配器，已真调成功）。
**为什么门禁没抓到**：`export-matrix`（31 符号 typeof/arity）、注册面清单、`check-docs-methods` 都只看**导出/注册**，不执行 `execute()`；只有"真调"才触发。**这正是 lead 要求逐工具真调的原因** —— 该门禁**有效**。
**修复（1 行）**：在 `src/register-tools.ts` 的 import 段补 `allowBuildFlags`（来自 `./sdk-runtime.ts`）。**我没有改**（vendor 只读；且本轮我的职责是复算）。

## C. 构造所有累积"未复核"

| 项 | 读数 | 判定 |
|---|---|---|
| **T3-① compat 回退**（`DSH_REMOTE_WSL_SYSTEMD=off`） | ensure ⇒ HTTP 200、**`mode=compat-detached`**、`pid=1956809`、warning 全文（"未能由 systemd 托管…已回退到兼容启动…可能弹出一个可见控制台窗口"）；**窗口前 9(WT0) → 后 10(WT1)，Δ=1**；新增窗口 `WindowsTerminal pid=45116`（`isWT=True`，start 18:21:37，落在我这轮 ensure 的时刻）；该槽位 unit = **0**（off ⇒ 不试 systemd）；stop 后 **收尾窗口 9 ⇒ 残留 0**，8942 进程 0 | **PASS（两个数都记了）** |
| **T3-② `daemonPrompt` 成功路径** | 由 A5 的 `wsl_agent` 真调取证：输出 `t46`、`backend=daemon`、`session=remote-wsl-default-…`、`completedBy=turn/end`、`turns=1`、`runtimePid` 存在 | **PASS（真调取证）** |
| **T3-③ `stopAllDaemons`** | 只验到 `typeof=function arity=1`（A1）；语义测试需**改 WSL 侧 state 目录**（`${wslHome}/.dsh/remote-wsl`）才能不误停他人 ⇒ **未复核**（并已把我真调产生的 `dsh-rwsl-8731` 显式 stop+reset-failed 清掉） | **未复核** |
| **T41/T42 dark 逐项** | `emulate colorScheme=dark`：V1 **16/16 无违规**；`footerH` **47**（border-box）；组标题 `守护` 色 `rgb(249,250,251)` / 菜单底 `rgb(97,102,107)` ⇒ **比值 5.55:1（≥4.5 ✓）**，启用项同 5.55；禁用项 `rgb(67,69,74)`（dimmed 域，S1）；渲染三背景 = panel `rgb(35,35,36)` / chip `rgb(21,21,23)` / body `rgb(21,21,23)`，当前项底透明（走 2px 竖条）；**面板内 `box-shadow` 元素 = 0** | **PASS（读数齐）** |
| **M1 / M5 / M14–M17**（T42 owner 明说没跑） | M1 可见 `dsh1` **1**；M5 主视线术语 **0 命中**；M14 宽 91==91 / 380 态 91==91（`nowrap`）；M15 `border-left:2px` + `font-weight:600`；M16 单 `⋯`（aria 唯一 `更多操作`）、宽 2 组 / 380 3 组、组标题 `tabindex=-1`、浮层不遮状态词；M17 见 V7 | **PASS（V7/M17 部分）** |
| **N3 折叠展开态** | 面板内 `details` 折叠区在展开后能读到 host 原文（T33 已验：`技术细节（host 原文）` 展开含 `pid`）；本轮 stop 失败面未重造（见未复核） | **部分** |
| **`<420px` 三层菜单** | 380px + `cwd≠目标` ⇒ 菜单 **3 组**：`工作区[添加为 WSL 工作区] / 守护[重启…, 停止…] / 诊断[查看诊断信息, 复制诊断摘要]`，`hasWorkspaceGroup=true`、组标题全 `tabindex=-1`、`role=menu`、**不压状态词**；头部 1 个主按钮（在此目录新建会话）、无同名重复 | **PASS** |
| **T42 两处超范围改动的副作用** | ① `.dsh-rw-crumb` 命中盒：V1 全量扫描（light+dark，16 个交互元素）**含面包屑，0 违规** ⇒ 未引入 <24×24；② `client.panel.js` 中文串改 ASCII：本轮所有面板可见文案实测仍为中文（`添加为 WSL 工作区`/`在此目录新建会话`/`隐藏文件：不显示`/`跳转`/`上一级`/`启动守护`/`更多操作`/`守护`/`诊断`…），CJK 门禁（剥注释）**0** ⇒ **未发现用户可见文案被 ASCII 化** | **未见副作用** |

## D. 量具与门禁复跑

| 工具 | 读数 |
|---|---|
| `css-token-audit.mjs`（10 个 client 文件逐个） | **全 exit 0**；`C1 hardcoded colors = 0`、`C2 token set ⊆ allow = PASS`、`S1 = OK`；`ALLOW_DEFAULT` **17 条**（已列出，含 5 个 `dsw-specific-*`/`interactive-*`） |
| `box-sizing-audit.mjs <client/index.js>` | **exit 0**，**真陷阱 = 0**，候选（表单控件）= 2；工具自带反推说明：`.dsh-rw-btn` 渲染 28（预测 38）、`.dsh-rw-chip` 渲染 24（预测 26）⇒ `<button>` 吃 UA border-box；`.dsh-rw-status` 渲染 55（预测 36）⇒ 该 `<footer>` 是显式 border-box |
| `arch-t6/tools/panel-smoke-node.mjs` | **16/16 PASS**，exit 0（行数项 6 个全 PASS） |
| `tools/check-client-rev.mjs` | **exit 0 PASS（模式=git）**，`当前 rev : afc26d1a2793 [mtime=…10:00:30.724Z ctime=… size=28342]`，`chunks : 9 个`（api 5a192b93 … tail c946a6c8），依据"自入口最后一次内容变更（d6815996e09d）以来没有任何 chunk 变化 ⇒ rev 与内容自洽" |
| `tools/precommit-check.ps1` | **PASS=11 / WARN=1 / FAIL=1**；FAIL = `git status 干净`（**8 条未提交改动，经分类全部是我/他人的 spike 证据文件**，插件本体未改）；WARN = 可见窗口归属交人判；其余 11 项（README 冻结表 vs REVISION、交接双份一致、流水不变量、端口 8911–8990 无监听、WSL 守护残留、`launch.*.sh`、`dsh-rwsl*` unit、failed unit=0、活宿主 19387 pid=47564、远端 origin == 本地 HEAD、client rev）**全 PASS** |
| `revision.ps1 -Mode Check` | **锚点一致 = True**（25 锚点），advisory 漂移 ⇒ exit 3 |

## E. 故意红（3 条成立；2 条未构造成功）

| # | 副本改法 | 红态读数 | 判定 |
|---|---|---|---|
| 1 | `client.panel.tail.js` 副本追加 `color:#ff0000; background:rgb(1,2,3)` | `C1 hardcoded colors = 2 <== FAIL`，**exit 1**（绿 0） | **RED 成立** |
| 2 | 副本追加 `.dsh-rw-chip{box-sizing:content-box;width:100%;padding:0 12px}` | 试了两种类（自定义 + 已知类），"真陷阱"仍 **0**、exit 0 | **未构造成功**（该判据**红能力弱**：工具按已知类/标签映射取样，追加覆盖不触发；⇒ 其"真陷阱=0"的绿**区分力有限**，建议补测） |
| 3 | 副本根（`client/` + `package.json`）把 `client.panel.tail.js` 加到 **759 行**，`panel-smoke-node.mjs <副本根>` | `FAIL 行数 <400 —— client.panel.tail.js = 759 行`，**15/16 PASS、exit 1**（绿 16/16、exit 0） | **RED 成立** |
| 4 | `client.panel.js` 副本注入中文字面量 | 剥注释后中文字面量 **7**（绿 0） | **RED 成立** |
| 5 | 副本把 chunk mtime 推到入口之后，`check-client-rev.mjs` | 我用 `node … <dir>` 传根，工具需要 `--root <插件根>` ⇒ 实际跑的是 vendor ⇒ PASS | **未构造成功（调用形式错）** |

复原：5 个副本目录/文件全部删除；vendor 5 个改动点前后 `Get-Item.Length`/`Contains` 复核"未改"；`REVISION.txt` 收尾 `锚点一致=True`。

## F. 三档分类

**已实现且已验证**：A1 export-matrix 31 符号｜A2 docs-methods 13 断言｜A3 行数门禁（含薄 re-export）｜A4 dump-config（exit/Error/同 profile 0 diff/异 profile 差集全为 patch 块）｜A5 中 5 个工具真调成功 + `wsl_agent`/`wsl_exec`/`wsl_status`/`wsl_daemon`/`wsl_sync_version`/`wsl_path`｜A6 HTTP 路由 E2E 五项｜T3 compat 回退（mode + 窗口两数）｜`daemonPrompt` 成功路径｜`<420` 三层菜单｜dark（V1/footerH/组标题 5.55:1/无面板内阴影）｜M1/M5/M14/M15/M16｜T42 两处超范围改动无副作用（命中盒 + 无 ASCII 化）｜量具四件（css-token-audit / box-sizing / smoke 16-16 / client-rev）｜故意红 3 条。
**已实现未自证**：N3 折叠展开态（只有 T33 的间接证据）｜V7 hover/当前项在**两主题下的逐项**读数（只测了渲染三背景 + 当前项形状通道，未做真实 hover）｜V3 的**八个**宽度（只测了宽 + 380）｜M17 的三背景 hover（同 V7）｜`box-sizing-audit` 的"真陷阱"判据（红能力弱，见 E2）。
**未实现或判红**：**`wsl_open_ui` 调用即崩（P0，§B）** —— 这是本轮唯一被判红的项；`allowBuildFlags` 未导入 `register-tools.ts`。

## G. 未复核项（不许当通过）

1. **T1-① `initialize timeout 120000ms` 是否环境冷启动**：未构造"冷/热两态对照"（需要可控地制造冷启动），⇒ **未复核**。
2. **T1-② 宿主逃生舱 5 个失败分支**：本轮**未逐条构造**（只读了码），⇒ **未复核**。
3. **`stopAllDaemons` 语义**（真守护上、孤立 state 目录）：无法在不改 WSL 侧 state 目录的前提下隔离 ⇒ **未复核**（只验 arity）。
4. **V3 的 420/719/720/1280 等其余宽度**：`resize_page` 不改 `innerWidth`，我用 `emulate` 只做了 **380** 与默认宽（+ T33 的 320）⇒ 其余 **未复核**。
5. **V7/M17 的真实 hover 两主题读数**：未用 CDP `Input.dispatchMouseEvent` 悬停取样 ⇒ **未复核**（只给了渲染态三背景 + token 存在性）。
6. **M6/M7/M10/M11/M12④**：未构造对应夹具 ⇒ **未复核**。
7. **stop 失败面（真守护+SIGSTOP）本轮**：T33 已验（用户语言主句 + host 原文在折叠区）；**本轮未重造**（T46 的重点是重构门禁）⇒ 沿用 T33 读数，本轮**未复核**。
8. **像素截图**：未交。
9. **`--dump-config` "与基线 0 diff"** 的**严格**口径：我给出"差异逐行分类 = profile patch 块" + "同 profile 两次 0 diff"，但**没有**拿到"与基线 profile 完全同构"的基线文件（arch 轮基线用的是别的 profile）⇒ 严格 0 diff **未复核**（结论为"无源码级配置回归"）。

## H. 纪律与环境（含自查缝隙）

- **端口**：全程 8731（`wsl_agent` 真调用了插件默认槽位）/8931/8932/8942/8955/8956；收尾**全部 0**。
- **unit**：`dsh-rwsl-*` = **0**、failed user unit = **0**、`is-system-running=running`；`dsh-rwsl-8731.service`（A5 真调产生）已 `stop` + `reset-failed`。
- **包装层/副本/临时家**：`launch.*.sh` = NONE；`/home/g/.dsh/remote-wsl/` 只剩 `daemon.log`/`launch-stderr.log`（无元数据/pid）；`%TEMP%` 下 `t46*`/`rwsl-t46*` 全清。
- **窗口归属**：收尾可见窗口 **9，mine=0，WT=0**（T3 compat 那一个 WT 窗口已随 stop 消失）。**归属证据**：compat 新增窗口 = `WindowsTerminal pid=45116`，`isWT=True`、start **18:21:37**（正是我 `=off` ensure 的时刻）⇒ 判为**我本轮产生**；注意我的 ledger 判据（父进程链）对它是 `mine=False`，**归属靠"时间窗 + WT + 我这轮的动作"**，不靠标题。
- **用户全局 `~/.dsh/storages/workspace.json`（阴性对照）**：起手 `71bf06bb53cc`/**1 条** ⇒ 终态 `692b52659859`/**1 条**（mtime 18:25:47）。**条目数未变（未增未删）**，但**内容哈希变了** ⇒ **必须报告**：**缝隙在于 A5 的 7 工具真调继承了插件默认配置（`DSH_HOME=C:\Users\l\.dsh`，非孤立）**，`wsl_agent` 真调在那个 DSH_HOME 下产生了 session/工作区元数据 ⇒ 该文件很可能被我这一轮 touch 过（1 条不变 ⇒ 更像元数据更新而非增删）。**建议下一轮把 A5 也放进孤立 `DSH_HOME`**（或由 lead 决定是否需要在报告里对用户说明）。
- **用户宿主 19387（pid 47564）/ 用户窗口 47604**：未触碰。
- **我自己的仪器/判据失误（留档）**：① E2 的红没构造成功（追加覆盖不触发该工具取样）⇒ 我把"box-sizing 真陷阱=0"的绿降级为"区分力有限"；② E5 传参形式错（应为 `--root`）；③ 一开始把 precommit 的 `git 干净` FAIL 当成真实失败，分类后才确认是"我的证据文件落库"；④ `wsl_agent` 真调用了默认 DSH_HOME（见上，纪律缝隙）。
