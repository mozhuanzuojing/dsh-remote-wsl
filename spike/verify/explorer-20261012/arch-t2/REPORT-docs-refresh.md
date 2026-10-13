# REPORT-docs-refresh.md —— T2 文档陈旧面刷新（架构债包 §2 的 T2）

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-13 ｜ **任务**：`task-35`（纯文档）
- **写作用域（实际只动这 5 个文件 + 本目录）**：`GAP-AUDIT.md` · `README.md` · `docs/remote-explorer-design.md` · `docs/panel-ux-redesign.md` · `docs/2026-10-13-arch-review-teammates.md`（§6 勾选）
- **未动**：`src/**` · `client/**` · `package.json`（`git status` 见 §5）
- **工具（本目录，可复跑）**：`tools/check-docs-methods.mjs`（核对脚本）· `tools/count-i18n-keys.mjs`（数字复算）

## 1. 结论

**权威面全部对齐、陈旧面全部标注或改写；核对脚本 11/11 PASS，故意红成立。** 三条硬事实（6 方法 / 7 工具 / 守护已闭合跨宿主会话）现在是 README、设计稿、GAP-AUDIT 三处一致；设计稿里两处 `host.call` 与"6 个工具"已改；UX 文档里 4 条"未核实/待办"按 T26/T31 的**已出结论**更新。
**唯一需要 lead 注意的口径更正**：任务书里的"i18n **181** 键"是**历史值**（T26 时刻），**当前实测 215/语言**（差集两侧为空）；我按**实测值**写入，并在原处保留 181 的出处。详见 §3。

## 2. 逐条改动（改前原文 → 改后原文 + 依据）

### 2.1 `GAP-AUDIT.md`（6 处）

| # | 位置 | 改前 | 改后 | 依据 |
|---|---|---|---|---|
| G1 | §2 表 #8 行 | `运行时随宿主进程生死；**跨进程复用同一 sessionId 被上游拒绝**：`JSON-RPC -32603: session "…" already exists` `[实测]`` / 定性 `🔴 **真缺口，卡在上游**` | `**现状（2026-10-13 更新）：守护已闭合跨宿主会话** —— `wsl_daemon` 守护持有运行时，**关客户端 ≠ 会话结束**；实测 `mode=systemd`…` + 真缺口另计 = **桌面壳 attach** / 定性 `🔴 **真缺口 = 桌面壳 attach**（"会话持久"部分已闭合）` | README「P0.3 冻结 revision」节；`REPORT-t21-f38-verify.md`（`mode=systemd`）；lead 任务书 §1 |
| G2 | §2 表 #9 行 | `同宿主内按 `key` 复用运行时；**跨宿主进程不共享** `[代码]` / `🔴 同 #8` | `**现状：已由同一个常驻守护闭合** …**真缺口另计**：真正的"多窗口 attach 远端 host"仍要桌面壳支持（同 #2）` / `🔴 **真缺口 = 桌面壳 attach**` | 同上 |
| G3 | §2 统计行 | `🔴 真缺口 4（#2 #3 #8/#9 #11）+ 1 半缺口（#3）`（#3 被重复计） | `✅ 等价 3 · 🟡 7 · 🔴 **真缺口 2**（#2 · #11）+ 1 半缺口（#3）；**#8/#9 从"真缺口"移出**（残余并入 #2）` | 由 G1/G2 重算；表内 ✅3/🟡7 未动 |
| G4 | §3 表 #8/#9 行 | `**上游**（`-32603 already exists` 是服务端语义，客户端绕不过）` / 代价 `大` | `**已闭合（我方，2026-10-13）**：不需要上游 —— 常驻守护持有运行时，客户端 attach 即可…` / `我方已完成（守护路径）；桌面壳部分仍归**上游**` | 同上 |
| G5 | §5 一句话结论 | `差的是四样：① 真 UI 载体…③ 重连与会话复用（卡在上游服务端语义）④ 工作区根映射` | `差的是三样：① 真 UI 载体 / **桌面壳 attach** ② 版本自动供给 ③ 工作区根映射`（＋注明原第③已由守护闭合） | 同上 |
| G6 | §7 表 #8/#9 行 | `**原审计漏了第三条路**：WSL 侧常驻**代理进程**…**新增候选**：**"远端代理"形态**…列为可选项` | `**已落地（2026-10-13 复核）**：走的就是这条第三条路…` / 状态 `✅ **已实现**（不再是候选）` | 同上 |

### 2.2 `README.md`（1 处 + 1 句指针，**未改结构**）

| # | 位置 | 改前 | 改后 | 依据 |
|---|---|---|---|---|
| R1 | §"打开后"那段（原第 311 行） | ``面板数据面是 `POST /remote-wsl/api`（方法表：`explorer.snapshot|openSession|daemon|fixPin`；同源 + 硬白名单）。`` | ``面板数据面是 `POST /remote-wsl/api`（**方法表 6 个**：`explorer.snapshot` · `explorer.openSession` · `explorer.daemon` · `explorer.fixPin` · `explorer.listDir` · `explorer.addWorkspace`；同源 + 硬白名单）。`` | `src/explorer.ts:60-67`（权威 6 项）；`client/client.api.js:41-48`（副本 6 项）；`REPORT-t26…md` §结论（"6 方法白名单含 `addWorkspace`"） |
| R2 | 同段追加 | （无） | `方法表的**权威**是 `src/explorer.ts` 的 `EXPLORER_METHODS`…契约细节见 `docs/client-contract.md`；面板的视觉/交互现状见 `docs/panel-ux-redesign.md` 与 `docs/panel-visual-spec.md`。` | 任务书 §5（**我判"要加，但只加一句指针"**：数字留在 UX/视觉文档一处维护，避免 README 二次抄写后再次漂移——见 §3 的 181→215） |

> README 的"## 七个工具"小节（第 33 行起）**本来就正确**（含 `wsl_path`），未改。

### 2.3 `docs/remote-explorer-design.md`（5 处）

| # | 位置 | 改前 | 改后 | 依据 |
|---|---|---|---|---|
| D1 | 文首状态行 | `**状态**：设计稿（未实现）` | `**状态**：**P0 已实现**（侧栏面板 / `POST /remote-wsl/api` / 守护路径均已落地；本文保留为设计稿与决策记录）` | 侧栏图标已实测存在（`REPORT-t31-ux-verify.md`）；路由与 6 方法已实测（`REPORT-t26…md` §结论） |
| D2 | 文首 | （无） | 新增一句 **权威指针**：实现以 `src/explorer.ts`（`EXPLORER_METHODS`）+ `docs/client-contract.md` 为准；文内 `host.call` 已废弃 | 任务书 §2.2（"文首指针"）；`docs/client-contract.md:212-217,421-431`（`host.call` 反证留档） |
| D3 | §3 表 `settings.section` 行 | 备注 `走 `host.call` 读实现有插件配置` | `⚠️ **本行两处已过期**：① `host.call` 对静态 client 半不成立；② `settings.section` 本插件**尚未实现**（P1）` | 同上；`src/explorer.ts` 无 `settings.section` 注册 |
| D4 | §4 首个代码块 | ```ts\n// client 半\nconst snap = await host.call('explorer.snapshot') as ExplorerSnapshot``` | 标注 **已废弃** + 指向"传输"段（同源 fetch / `client.api.js` 的 `createExplorerApi()`） | §1 表那一行（2026-10-12 证伪）+ §4 自身的"传输"段 |
| D5 | §4 传输段方法表 | `method ∈ explorer.snapshot \| explorer.openSession \| explorer.daemon \| explorer.fixPin` | `… \| explorer.listDir \| explorer.addWorkspace`（**6 个**，注明权威与 client 副本，并说明后 2 个是 A3/A1 新增） | `src/explorer.ts:60-67`；README 里 `explorer.listDir`（第 653 行）、`explorer.addWorkspace`（第 559-573 行） |
| D6 | §4 末条 | `现有 6 个工具（`wsl_status`/…/`wsl_sync_version`）` | `现有 **7 个**工具（… + `wsl_path`）`（注明权威：`src/index.ts` 的 `name: 'wsl_*'` 共 7 处） | `src/index.ts:1088,1224,1255,1377,1520,1559,1603` |

### 2.4 `docs/panel-ux-redesign.md`（7 处，**未新增章节**）

| # | 位置 | 改前 | 改后 | 依据 |
|---|---|---|---|---|
| P1 | §3.2.1 首句 | ``…（29,317 B），**zh 181 键 / en 181 键逐键一致**（键行 362 = 181×2）。`` | 保留 181 为**该时刻历史值**，并追加**2026-10-13 复算**：文件现 32,772 B、**zh 215 / en 215、差集两侧皆空**、键行 430=215×2 | 我的 `tools/count-i18n-keys.mjs` 输出；交叉核对 `^\s*"key":` 行数 = 430 |
| P2 | §3.2.1 表"17 个新增键"行 | `**0/17 存在**` / `⚠️ 预期之内（**重设计尚未实现**）…必须把这 17 个键补进字典` | `**17/17 已存在（2026-10-13 复算）**` / `✅ **已落地**…按 zh/en 逐键配对补进 `client/client.i18n.js`` | 我的 17 键存在性检查（17/17；键名取自本文件 §3.2 清单第 162-179 行） |
| P3 | §9.4 末"唯一待办" | `**我下一步（唯一待办）**：**等实现轮落地**后给 §9.4/§9.2 末段那 4 项数据 —— ① V1…④ 视觉稿未把 #1–#8 拉回来` | 改为"**该 4 项已由实现轮落地并已独立复验**"，逐项给 T31 的 M14/M16/M15/M1 + **提示该报告另判 2 条新 RED 与 2 条建议**（不在本 4 项内） | `REPORT-t31-ux-verify.md:16-17` |
| P4 | §9.4 末边界声明 | `**边界声明**：`E_UNAVAILABLE` 的**真实触发**在实现侧**尚未被造出**…由 **T26** 在副本里屏蔽 `workspaceRegistry` 真造一次。…**以 T26 的结论为准**` | `**边界已解除（2026-10-13）**：**真实触发已由 T26 造出** —— 副本屏蔽工作区服务 ⇒ **503 + body 文案 + 那行降级日志**；原约定已履行、不再有冲突面` | `REPORT-t26-a1-a4-p1-verify.md:13 ⑤` |
| P5 | §10 表"最近目录"行 | `**已裁决（lead）**：client 侧 `localStorage`…` | `**已裁决并已落地（2026-10-13）**…落地证据：字典含 `recent.title`/`recent.empty`（17/17 在场）；**M12③ PASS**` | 我的 17 键检查；`REPORT-t31-ux-verify.md:16`（M12③） |
| P6 | §10 表"i18n 运行时是否已切"行 | `**未核实**：`7cb3362` 渲染仍全中文、`client.i18n.js` 在**工作区未跟踪**` | `**已核实（2026-10-13）**：…（T26 A4：181 逐键一致 + 官方 locale 缺席回退；T31 独立复现：`client.panel.js` 剥注释后中文字面量 0）；**键数已增长**：当前 215/语言` | `REPORT-t26…md:15`；`REPORT-t31-ux-verify.md:11,26`；我的复算 |
| P7 | §10 表"与 T28 一致性"行 | `**仅剩实现轮**的 4 项数据复验（V1/V3/V7/未拉回 #1–#8）` | `**已落地 + 已独立复验**：…M1/M14/M15/M16 **PASS** ⇒ 本行**关闭**。**另见该报告 2 条新 RED**（已转修复清单）` | `REPORT-t31-ux-verify.md:16` |

### 2.5 `docs/2026-10-13-arch-review-teammates.md`（1 处）

| # | 改前 | 改后 | 依据 |
|---|---|---|---|
| A1 | `- [ ] T2 docs-refresh` | `- [x] T2 docs-refresh ✅ 2026-10-13（\`reliability-keeper\`；报告 \`spike/verify/explorer-20261012/arch-t2/REPORT-docs-refresh.md\`）` | 本报告；**其余 6 行未动**（T1/T3/T4/T5/T6/Lead 终验） |

## 3. 每个数字的出处（含一处口径更正）

| 我写入的数字 | 出处（可复算） |
|---|---|
| explorer 方法 **6**（snapshot/openSession/daemon/fixPin/listDir/addWorkspace） | `src/explorer.ts:60-67`（权威）+ `client/client.api.js:41-48`（副本）+ `tools/check-docs-methods.mjs` 断言 1/2 |
| 工具 **7**（含 `wsl_path`） | `src/index.ts:1088,1224,1255,1377,1520,1559,1603` + 核对脚本断言 3 |
| i18n **zh 215 / en 215**、逐键一致、键行 **430** | `node tools/count-i18n-keys.mjs`（本目录）＋交叉核对 `^\s*"key":` = 430 |
| i18n **181**（历史） | `REPORT-t26-a1-a4-p1-verify.md:15,47`；`docs/panel-ux-redesign.md:194-195`（含命名空间分解 = 181） |
| UX **17** 键（提议 → 已落地 17/17） | 提议：`docs/panel-ux-redesign.md:162-179,200`；落地：我的存在性检查 17/17 |
| token 闭集 **17**；C1 硬编码色 **0**；C2 ⊆ 17 **PASS**；S1 **OK**；两文件 **exit 0** | `node spike/verify/explorer-20261012/visual/tools/css-token-audit.mjs client/client.panel.js`（与 `client/index.js`）实跑输出；`REPORT-t31-ux-verify.md:11,24-25` |
| 旧树已删、可见 `dsh1` **恰 1 次** | `REPORT-t31-ux-verify.md:16`（M1 PASS，且"注入第二处 ⇒ 计数 2 变红"） |
| 唯一底栏 `⋯`（工作区/守护/诊断三组） | `docs/panel-ux-redesign.md:460-461`（Q2 定稿）+ `REPORT-t31-ux-verify.md:16`（M16：宽态 2 组 / 窄态 3 组） |
| `mode=systemd`（守护路径闭合） | `REPORT-t21-f38-verify.md`（README P0.3 节引用）+ `REPORT-t26…md:19`（`is-system-running=running`、failed 0、每次 ensure 读到 `mode=systemd`） |

> **⚠️ 口径更正（必须让 lead 知道）**：任务书写"i18n zh/en **181** 键 + 新增 **17** 键"。**181 是 T26 时刻的历史值**；**当前实测 215**（+34/语言）。我**没有**把 181 当现值写进任何文档，只在 UX 文档里保留其"历史值 + 出处"，现值写 215。
> **未复核**：215−181=34 个增量**未逐键归属到具体轮次**（只有总数与"17/17 已落地"可复算）。

## 4. 故意红（≥1，已成立且归因干净）

```
# 副本构造（不碰被验对象）：复制 src/explorer.ts、src/index.ts、client/client.api.js、README.md、GAP-AUDIT.md、docs/remote-explorer-design.md 到 %TEMP%\rw-docs-red
副本改前含 explorer.addWorkspace 次数 = 3
副本改后含 explorer.addWorkspace 次数 = 0        ← 变异已当场验证生效
FAIL README 列出全部 explorer 方法 — 缺 explorer.addWorkspace
结果：FAIL(1) ｜ 断言 11 条
RED exit=1
```
**同一脚本对真对象的判定**（同一次运行）：`结果：PASS ｜ 断言 11 条 ｜ exit 0`。
⇒ 核对脚本对"方法表缺项"**有区分力**，且红项**恰好归因**到被删的那一项。
> 过程诚实记录：**首版红没真的改到副本**（我用 `-replace` 的转义没命中，副本仍是 6 项 ⇒ 假绿 exit 0）。改用 `String.Replace` 并**当场打印改前/改后出现次数（3→0）**后才成立。另：脚本首跑曾把"列举 6 项、恰好以这 4 项开头"误判成"只有 4 个方法"，已加负向先行断言 `(?!\|)` 修正。

## 5. `git status`（只动写域）

```
$ git status --porcelain -- GAP-AUDIT.md README.md docs/remote-explorer-design.md docs/panel-ux-redesign.md docs/2026-10-13-arch-review-teammates.md
 M GAP-AUDIT.md
 M README.md
 M docs/remote-explorer-design.md
?? docs/2026-10-13-arch-review-teammates.md
?? docs/panel-ux-redesign.md
```
```
$ git diff --stat -- GAP-AUDIT.md README.md docs/remote-explorer-design.md
 GAP-AUDIT.md                   | 14 +++++++-------
 README.md                      | 29 ++++++++++++++++++++++++++++-
 docs/remote-explorer-design.md | 16 ++++++++++------
 3 files changed, 45 insertions(+), 14 deletions(-)
```
- 两个 `??`（`docs/panel-ux-redesign.md`、`docs/2026-10-13-arch-review-teammates.md`）是**未跟踪文件**，所以我的改动不显示为 `M` —— 它们在本轮**只被我改过**（本轮我只对写域内 5 个文件与 `arch-t2/` 发起过写操作）。
- **共享 checkout 声明**：仓库当前**被多个 teammate 并行改**（T32 在 `client/**`、T1 在 `src/**`、`p0-verify` 在 `spike/verify/**`）。全量 `git status` 有 111 条，其中**除上述 5 个文件外的条目都不是我写的**；本报告只用**限定路径**的 status/diff 作为"只动写域"的证据（在共享 checkout 里全局 status 无法归属作者）。

## 6. 收尾清理与窗口自查

| 项 | 结果 |
|---|---|
| 本轮我起的进程/实例 | **0 个**（纯文档；未起宿主、未起守护、未占端口） |
| remote-wsl 包装层（`wsl.exe … launch.*.sh`） | **无**（Windows 侧枚举） |
| WSL 侧守护元数据（UNC 直读，不派生进程） | 只剩 `daemon.log` / `launch-stderr.log`，**无 `daemon.*.json`** ⇒ 无守护在跑 |
| 端口 8961/8962/8963/8971/8972 | 全 **free** |
| **可见窗口** | 8 个，**无一个是 `wsl.exe`/conhost 窗口**；归属：chrome / Code / Cursor / DeepSeek Harness(47604) / gephgui-wry / msedge / TextInputHost / Weixin（全为用户或既有应用）。**我未关任何窗口** |
| **未产生可见窗口**（启动方式） | 本轮**零外部进程启动**；唯一一次 `wsl.exe`（systemd 审计）用 **`Start-Process -WindowStyle Hidden -Wait -RedirectStandardOutput`**，且命令写在 `.sh` 文件里走位置参数（避免 `-ArgumentList` 拆词） |
| 活宿主 | `19387` = pid **47564**（未变）｜`47604` = DeepSeek Harness（用户窗口，未碰） |
| systemd unit | `is-system-running = running`；**failed units = 0**；**无 remote-wsl 相关 unit** ⇒ **无我的 unit 需清、`reset-failed` 无可重置对象**（我**没有**执行 `reset-failed`：在共享 WSL 里它会影响他人诊断证据，而本轮 failed=0 使它是纯 no-op ⇒ 以"审计 + 说明"代替动作） |

## 7. 两栏

**【一旦错了就得返工】**
1. **6 方法 / 7 工具** 三处文档必须与 `src/explorer.ts` + `src/index.ts` 一致 —— 现已一致且**有核对脚本**（`check-docs-methods.mjs`，11/11 PASS，红已成立）。若下一波 T4 改方法表（它要动 `EXPLORER_METHODS`/client METHODS），**必须重跑该脚本**，否则文档立刻过期（脚本就在 `arch-t2/tools/`，**建议进收尾门禁**）。
2. **GAP #8/#9 的"现状 vs 真缺口"必须分开**（守护已闭合跨宿主会话 / 真缺口 = 桌面壳 attach）—— 这是任务书 §1 的硬要求，也是三处（§2 表 + 统计 + §3 表 + §5 结论）**一致性**的锚点。
3. **i18n 键数口径**：文档里凡写 181 处都必须标明是**历史值**；现值以 `count-i18n-keys.mjs` 为准（当前 215）。**若 lead 的清单/门禁仍按 181 判，会误红。**

**【其余的】**
4. 设计稿两处 `host.call` 已标注**废弃**而非删除（保留设计史，符合"假设被证伪必须记录"）。
5. README 只加**一句指针**、未动结构（任务书 §5 的"你自己判断"）。
6. UX 文档 4 条状态更新**全部引用 T26/T31 的既有结论**，并显式带上 T31 的 **2 条新 RED**（避免把"已复验"读成"全绿"）。
7. 两个可复算工具留在 `arch-t2/tools/`（键数 + 文档/实现对齐），后续轮次可直接复用。

## 8. 未复核：6 条

1. **我未自跑浏览器**：`旧树已删 / 可见 dsh1 恰 1 次`、`单 ⋯ 三组` 两条**引用 T31 的 DOM 实测**（`REPORT-t31-ux-verify.md:16`），我未独立重放其浏览器步骤。
2. **`mode=systemd`** 未自跑：引用 `REPORT-t21-f38-verify.md` 与 `REPORT-t26…md:19`。
3. **T31 报告我只逐行引用，未逐条独立复算**（M14/M15/M16/M1 的原始读数在其报告内）。
4. **215−181 = 34 个增量未逐键归属轮次**（只有总数与 17/17 可复算）。
5. 我的核对脚本覆盖 **3 个文档锚点**（README 方法行 / 设计稿 `method ∈` 行 / GAP-AUDIT #8 行）+ client 副本 + 工具数；**README/设计稿里其它隐含旧方法数的表述未做全库扫描**（`rg` 全库会命中大量历史报告，噪音太大）。
6. `docs/client-contract.md` / `docs/panel-visual-spec.md` / `docs/prior-art-dsh-wsl.md` **不在我的写作用域**，本轮未核对它们是否也含过期方法表（contract 已在 `REPORT-t26` 的 6 方法白名单中体现，visual-spec 由 T28 维护）。

> **2026-10-13 追加（不改上文正文）**：本报告 §2/§4 与验收①引用的护栏脚本 **`arch-t2/tools/check-docs-methods.mjs` 已更名为 `arch-t2/tools/check-docs-methods.ts`**（**判据未改**，Node 26 直跑无需构建）；同时该脚本的工具名读法已从"读死 `src/index.ts`"改为**扫 `src/**` 并把权威锚在 `tools.register` 这个语义上** —— 因为 T5 把 7 个工具注册搬到 `src/register-tools.ts` 时旧读法报过 `工具数 = 7 — 实得 0`。**一律以新路径为准。**
