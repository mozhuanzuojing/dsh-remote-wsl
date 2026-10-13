# dsh-remote-wsl · 架构债 · Agent Teams 转交包

| | |
|---|---|
| 日期 | 2026-10-13（重写：对齐 `moe-teammate-dispatch`） |
| 仓库 | `D:\project\dsh1\vendor\dsh-remote-wsl` |
| WSL | `/mnt/d/project/dsh1/vendor/dsh-remote-wsl` |
| 执行面 | DSH Desktop · **投影模式** · Agent Teams |
| 纪律真源 | `~/.agents/rules/moe-teammate-dispatch.md` + 投影 persona ①–⑤ |
| 名额 | 会话终身累计，上限 8；本包 **6 teammate + Lead**，留 1 机动 |

**用户已显式要求用 teammate** ⇒ 上游 `team:policy` 硬门已过；仍须过成本判据（复用 ≥2 次 / 大块互不重叠写域）。

术语只说 **Lead / teammate / Agent Teams**。

---

## 1. 为什么派（对 Lead）

审查结论里有六块**互不重叠**的大改，各自要重读不同文件树；塞进 Lead 一个上下文会撑爆，且实现与文档/人面需要分工。故开 Teams。

| 不派（Lead 自做或并入） | 原因 |
|---|---|
| `listDir` 抽 `wsl-fs` | 边界未定，易与 daemon/host 拆分抢文件 |
| `connection.rpc` 升写路径 | 上游契约，非本仓一刀 |
| `selftest` 移出 `files` | Nice；并进文档 teammate 一句 |

---

## 2. 问题板 → 写作用域（独占）

| 任务 | 严重度 | 问题 | teammate 名 | write_scopes |
|---|---|---|---|---|
| **T1** | Critical | `SdkRuntime` / `ALLOW_BUILDS` / `unc` 双份 | `rwsl-runtime-unify` | `src/sdk-runtime.ts` · `src/version.ts` · `src/index.ts`（只去重，不拆 facade） |
| **T2** | Critical | GAP / 设计稿方法表过期 | `rwsl-docs-refresh` | `GAP-AUDIT.md` · `README.md` · `docs/remote-explorer-design.md` · `docs/panel-ux-redesign.md` · 本文件进度勾选 |
| **T3** | Important | `daemon-client.ts` ~1068 行 | `rwsl-daemon-split` | 新建 `daemon-protocol.ts` · `daemon-launch.ts` · `daemon-lifecycle.ts`；`daemon-client.ts` 薄 re-export |
| **T4** | Important | 方法表双份；status/snapshot 选择器未命名 | `rwsl-contract-ssot` | `src/explorer.ts` · `client/client.api.js` · `src/index.ts`（仅字段改名）· 可选 `scripts/` |
| **T5** | Important | `index.ts` ~1667 行 | `rwsl-host-split` | 新建 `wsl-io.ts` · `register-tools.ts` · `in-host-runtime.ts`；`index.ts` 只 wiring |
| **T6** | Important | `client.panel.js` ~1240 行；死 `fixPin`/`tree.*` | `rwsl-panel-split` | `client/client.panel*.js`（拆 chunk）· `client/index.js` · `client/client.i18n.js` |

```text
Wave A  并行：T1 + T2
Wave B  T1 完成后并行：T3 + T4
Wave C  T3+T4 完成后并行：T5 + T6
         T5 blocked_by T1∧T3∧T4
         T6 blocked_by T4
```

名额：A2 + B2 + C2 = **6**。失败创建也占位 ⇒ 派前确认工具表有 `spawn_teammate`。第二次干活只 `send_message` 同名。

---

## 3. Lead 开场白（粘成桌面会话首条用户消息）

```text
你是 Lead。仓库 D:\project\dsh1\vendor\dsh-remote-wsl（零构建 TS；client 零构建 lazy-CJS）。
转交包：docs/2026-10-13-arch-review-teammates.md
纪律：~/.agents/rules/moe-teammate-dispatch.md

1. 只有你 spawn_teammate / interrupt_agent；write_scopes 互不重叠；任务板 list→get→claim(revision)→complete。
2. 一次委派 = 一条自包含消息；同 teammate 往返 ≤2 轮；复用 send_message，勿再 spawn 新名。
3. 零 @deepseek-ai/* runtime import；不改 NDJSON /explorer HTTP 对外语义；dispose 不杀守护。
4. 验收只验「一旦错了就得返工」栏；交付物必须有「未复核：N 条」。
5. 严格按 §2 波次；禁止抢改他人 write_scopes。

先 team_task_create 建齐 T1–T6（subject/description/write_scopes/blocked_by 抄 §2）。
再按 Wave A 用 §5 提示词派出 rwsl-runtime-unify 与 rwsl-docs-refresh。
每波用 §4 门禁通过后再开下一波。
```

---

## 4. Lead 门禁

| 波次 | 必跑（只验返工栏） |
|---|---|
| A | `rg -n "class SdkRuntime" src/` 仅 `sdk-runtime.ts`；`ALLOW_BUILDS`/`unc` 定义各一处；抽读 GAP #8/#9 已改为「守护已闭合跨宿主会话」 |
| B | `daemon-client` 对外导出矩阵未断；client METHODS ⊆ host `EXPLORER_METHODS`；`discoveredDaemon`（或对称名）有 README 一句 |
| C | `wc -l src/index.ts` 期望少于 400；各 `client.panel*.js` 少于 400；`rg class SdkRuntime` 仍一处；冒烟：面板 snapshot→listDir→ensure→openSession；`wsl_status`；守护未被 unload 杀掉 |

终验后勾选 §6，并写「未复核：N 条」。

---

## 5. `spawn_teammate` 首条消息（name 固定；`{{TASK_ID}}` 换成板上 id）

仓规共性（每条已含，此处不重复粘）：零构建 · 相对 `.ts` · 零 `@deepseek-ai/*` · 输出必须两栏【一旦错了就得返工】/【其余的】。

### T1 · `rwsl-runtime-unify`

```text
角色：实现专家（运行时去重）。只做 T1。

仓库：D:\project\dsh1\vendor\dsh-remote-wsl
约定：零构建 TS；零 @deepseek-ai/*；相对 .ts；不改 NDJSON/工具 JSON 形状。

任务：claim {{TASK_ID}}。
1. SdkRuntime 唯一实现 = src/sdk-runtime.ts；index 内嵌 in-host 副本改为 import，删重复 class。
2. ALLOW_BUILDS / allowBuildFlags 单一定义（version.ts 或 sdk-runtime.ts），warmScript 与 sdk-runtime 共用。
3. unc / textOf* 单一定义。
4. 你改过的文件里 lib/index.js 注释改为 src/index.ts。

约束：只动 write_scopes；禁止拆 daemon-client / explorer / client；禁止改协议字段。

验收（贴原文）：
rg -n "class SdkRuntime" src/
rg -n "ALLOW_BUILDS|allowBuildFlags" src/
rg -n "function unc\b|export function unc" src/
期望：定义各一处；index 仍 export name/inject/apply。

输出两栏：【一旦错了就得返工】/【其余的】
```

### T2 · `rwsl-docs-refresh`

```text
角色：文档专家。只做 T2。

仓库：D:\project\dsh1\vendor\dsh-remote-wsl
权威：src/explorer.ts EXPLORER_METHODS、README 七工具、daemon 常驻语义。不要发明未实现能力。

任务：claim {{TASK_ID}}。
1. GAP-AUDIT #8/#9：守护形态已闭合跨宿主续会话；真缺口 = 桌面壳 attach / 工作区根映射；更新统计与一句话结论。
2. README / remote-explorer-design：方法表 = 6 explorer methods + 7 tools；文首指针「实现以 explorer.ts + client-contract.md 为准」；过时 host.call /「四方法」标注废弃。
3. panel-ux-redesign §3.2.1 与现行 client.i18n.js 对齐或标废弃。
4. 本文件 §6 勾选 T2。

约束：不改 src/ 与 client/ 业务代码。

验收：
rg -n "already exists|-32603|四方法|host\.call" GAP-AUDIT.md README.md docs/remote-explorer-design.md docs/panel-ux-redesign.md
人工确认 GAP #8/#9 不再写成未闭合会话缺口。

输出两栏：【一旦错了就得返工】/【其余的】
```

### T3 · `rwsl-daemon-split`

```text
角色：实现专家（守护控制面拆分）。只做 T3。前置：T1 完成。

仓库：D:\project\dsh1\vendor\dsh-remote-wsl

任务：claim {{TASK_ID}}。拆 src/daemon-client.ts：
- daemon-protocol.ts — TCP / hello+token / prompt
- daemon-launch.ts — systemd 主路径 + compat + DSH_REMOTE_WSL_SYSTEMD
- daemon-lifecycle.ts — ensure/stop/snapshot/status/orphan
- daemon-client.ts — 薄 re-export（index/explorer/selftest 的 import 路径不变）

约束：daemonSnapshot = 唯一孤儿真相源；不改 daemon.ts；不改槽位文件布局；告警文案保留。

验收：
rg -n "from '\\./daemon-client" src/
wc -l src/daemon-*.ts
rg -n "export (async )?function" src/daemon-client.ts src/daemon-protocol.ts src/daemon-launch.ts src/daemon-lifecycle.ts
期望：ensureDaemon/stopDaemon/daemonPrompt/daemonStatus/daemonSnapshot/readDaemonMeta/stateDirLinux 仍可从 daemon-client 导入；各实现文件 <450 行，re-export <80。

输出两栏：【一旦错了就得返工】/【其余的】
```

### T4 · `rwsl-contract-ssot`

```text
角色：实现专家（契约单源）。只做 T4。前置：T1 完成。

仓库：D:\project\dsh1\vendor\dsh-remote-wsl

任务：claim {{TASK_ID}}。
1. EXPLORER_METHODS（explorer.ts）为权威；client.api.js METHODS ⊆ host（派生或 scripts/check-explorer-methods.mjs）。
2. wsl_status 发现语义字段改名 discoveredDaemon（或对称名），与 explorer.snapshot 所有权选择器区分；README 一行对照。
3. fixPin 决议写进回报（UI 露出交给 T6 / 或从 client API 撤下）；本任务不改 panel UI。
4. HTTP /remote-wsl/api 与错误 code 映射不变。

约束：不改 panel 视觉。

验收：
方法集一致的证明（脚本或 rg）
rg -n "discoveredDaemon|daemonStatus" src/index.ts src/explorer.ts README.md

输出两栏：【一旦错了就得返工】含 fixPin 决议 /【其余的】
```

### T5 · `rwsl-host-split`

```text
角色：实现专家（Cordis facade）。只做 T5。前置：T1·T3·T4 完成。

仓库：D:\project\dsh1\vendor\dsh-remote-wsl

任务：claim {{TASK_ID}}。
新建 wsl-io.ts / register-tools.ts / in-host-runtime.ts（in-host 必须 import 共享 SdkRuntime）。
index.ts 只留 DEFAULTS + apply wiring + registerExplorer。

约束：七工具名与参数不变；dispose 不杀守护；warmInBackground 不变；不碰 client/；禁止再复制 SdkRuntime。

验收：
wc -l src/index.ts
rg -n "tools\.register|wsl_status|wsl_agent|registerExplorer" src/
rg -n "class SdkRuntime" src/
期望：index <400；SdkRuntime 仍一处。

输出两栏：【一旦错了就得返工】/【其余的】
```

### T6 · `rwsl-panel-split`

```text
角色：实现专家（人面拆分）。只做 T6。前置：T4 完成。

仓库：D:\project\dsh1\vendor\dsh-remote-wsl

任务：claim {{TASK_ID}}。
1. client.panel.js → client.panel-state.js / client.panel-browser.js / client.panel-chrome.js；createPanel 组装。
2. client/index.js bootChunks：i18n → api → panel 子 chunk → icon。
3. 按 T4 的 fixPin 决议露出或删除；清理死 tree.*（或迁 others.*）。
4. 只经 createExplorerApi；无 host.call；卸载不杀守护。

约束：平台只认 client.*.js；零构建；除 react 外不引裸包；CSS 可原样搬，不改视觉大盘。

验收：
wc -l client/client.panel*.js
rg -n "fetch\(|/remote-wsl/api" client/client.panel*.js
rg -n "tree\." client/client.i18n.js client/client.panel*.js
期望：各 panel chunk <400；panel* 内无直接 fetch。

输出两栏：【一旦错了就得返工】/【其余的】
```

---

## 6. 进度

- [ ] T1 runtime-unify
- [x] T2 docs-refresh ✅ 2026-10-13（`reliability-keeper`；报告 `spike/verify/explorer-20261012/arch-t2/REPORT-docs-refresh.md`）
- [ ] T3 daemon-split
- [ ] T4 contract-ssot
- [ ] T5 host-split
- [ ] T6 panel-split
- [ ] Lead 终验 · 未复核：___ 条

---

## 7. 审查锚点（勿整份塞进 teammate 提示词）

- Host：`index.ts` / `daemon-client.ts` 过重；双份 SdkRuntime；GAP #8/#9 过期
- Client：`client.panel.js` 过重；METHODS 双份；`fixPin` 死表面
- 设计：`docs/remote-explorer-design.md` §4/§8.6；`docs/client-contract.md`
