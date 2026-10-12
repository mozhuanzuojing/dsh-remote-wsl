# RUNBOOK —— task-4 开工后的执行顺序（等 lead 放行）

> 本文件是**准备产物**；开工前不得执行 §2 之后的步骤。执行时每一步的原始输出按 MATRIX.md §4 命名落盘。

## 1. 前置条件（等 lead / 各 owner 确认）

| # | 前置 | 为什么堵着我 | 确认方式 |
|---|---|---|---|
| P1 | task-2（host 半）完成：`explorer.snapshot` 可用、`wsl_status` 仍是同一真相源 | ③⑤ 没有数据面可对 | lead 通知 + `probe-ground-truth.ts --mode status/services` |
| P2 | task-3（client 半）完成：`client/**` 落地、`package.json` 声明 `dsh.client`（或 T1 钉死的等价字段） | ①②④ 没有渲染面可验 | `revision.ps1 -Mode Write` 能通过（client/** 非空） |
| P3 | task-1 的 `docs/client-contract.md`（`dsh.client` 确字段形状 + 最小可注册证明） | 用来复核 bundle 注册字面量与「新 id 进侧栏」的权威形状 | 文件存在 |
| P4 | 是否有**权威**的侧栏 occupant 期望值（desktop 现场 vs web 实例的差异） | ① 的「第 3 个图标」是相对量；web 实例基线可能不同 | lead 说明 |
| P5 | 设计 §6-③「点'打开'起 `cwd=` WSL 路径的会话」是否纳入我的 P0 范围 | lead 下发的 5 条**不含**它 | lead 明确（默认：不纳入，列入未复核） |
| P6 | 端口 8931–8960 归我；`19387`（desktop 宿主）绝不动 | 纪律 | 已知 |

**已确认的环境事实（准备期实测 + lead 2026-10-12 F-1 更正）**：`debian-u8-1` 在跑；WSL 侧当前**无守护**（`daemon_ts=0`、无 `daemon.json`、无 8932 监听）→ ⑤ 必须先起自己的守护；**网络模式 = `nat`（不是 mirrored）** —— 依据 `wslinfo --networking-mode` = `nat`，`.wslconfig` 只有 `localhostForwarding=true`/`autoProxy=true`/`firewall=false` ⇒ **Windows→WSL 的 `127.0.0.1` 由 localhost 转发提供，而不是"共享网络命名空间"**；两侧命名空间独立 ⇒ **Windows 侧占端口不会挡住 WSL 侧 bind**（真占用必须在 WSL 里占）。本会话 `cordis_inspect_query(client)` **超时**，host 侧正常。

## 2. 开工顺序（每步都落原始输出）

| 步 | 动作 | 命令/工具 | 产物 |
|---|---|---|---|
| S0 | 记录活宿主 pid（19387），全程不得变 | `boot-testhost.ps1` 自动记录 | `out-01-livehost-baseline.txt` |
| S1 | **冻结 revision** | `pwsh ./revision.ps1 -Mode Write`（client/** 为空会 exit 2） | `REVISION.txt`、`out-02-revision-write.txt` |
| S2 | 比较器自测（强制红 R1） | `pwsh ./diff-panel-vs-status.ps1 -SelfTest`、`pwsh ./daemon-invariance.ps1 -SelfTest` | `out-00-selftest-diff.txt`、`out-00-selftest-daemon.txt` |
| S3 | 起**带插件**测试宿主 8931 | `pwsh ./boot-testhost.ps1 -Port 8931 -DaemonPort 8932`（先 `-DumpConfigOnly` 校验 compose） | `out-03-*.log/.pid`、`out-03-dumpconfig.txt` |
| S4 | 起**基线**宿主 8934（无插件，强制红 R2） | `pwsh ./boot-testhost.ps1 -Port 8934 -DaemonPort 8935 -NoPlugin` | `out-03-*-base.log` |
| S5 | 注册面：boot graph + bundle 字面量（①②） | `pwsh ./capture-boot-graph.ps1 -Port 8931 -ExpectPlugin`、`... -Port 8934`（基线） | `out-04-*`、`out-05-artifact-slots*.txt` |
| S6 | 起自己的守护（⑤ 前置） | `node probe-ground-truth.ts --mode daemon --action start --port 8932` | `out-09-daemon-start.txt` |
| S7 | 地面真相（③⑤）：`wsl_status` before | `node probe-ground-truth.ts --mode status --port 8932` | `out-09-status-before.txt` |
| S8 | ⑤ 守护事实 before | `pwsh ./daemon-invariance.ps1 -Mode Capture -Port 8932 -Out out-11-daemon-before.json` | `out-11-daemon-before.json` |
| S9 | 浏览器：8931 打开 → rail 抽取（①） | 驱动见 §3；`browser/extract-panel.js` | `out-06-rail-plugin.json`、`shot-06-rail-*.png` |
| S10 | 点我们的图标 → 切到 `main:remote-wsl` → 面板抽取（②③） | `browser/click-rail-icon.js` + `extract-panel.js` + `take_screenshot` | `out-06-panel-open.json`、`out-06-panel-open.png`、`out-07-panel-extract-light.json`、`out-06-console.txt` |
| S11 | ③ 差集比对 | `pwsh ./diff-panel-vs-status.ps1 -Panel out-07-panel-extract-light.json -Status out-09-status-before.txt` | `out-10-diff-panel-vs-status.{json,txt}` |
| S12 | ④ 主题 light/dark | `browser/theme-probe.js` + 两模式截图 | `out-08-theme-{light,dark}.json`、`shot-08-*.png` |
| S13 | ⑤ 关面板/切走/切回 → after | 同 S8 + `out-11-mid-close.json` | `out-11-daemon-after.json` |
| S14 | ⑤ 比对 | `pwsh ./daemon-invariance.ps1 -Mode Compare -Before out-11-daemon-before.json -After out-11-daemon-after.json` | `out-11-daemon-invariance.{json,txt}` |
| S15 | 强制红 R2：基线宿主 8934 上跑同一套断言 | 同 S9/S10，指向 8934 | `out-06-rail-base.json`、`out-12-forced-red-base.txt` |
| S16 | 强制红 R3/R4/R5（见 MATRIX §2） | 注入 init script / 注入样式 / 停自己 8932 守护 | `out-12-forced-red-*.{json,txt}` |
| S17 | 收尾复算 revision | `pwsh ./revision.ps1 -Mode Check`；≠0 即判「验证无效」 | `out-98-revision-check.txt` |
| S18 | 收工清理（只停自己起的 pid/守护） | `boot-testhost.ps1 -Stop`、`wsl_daemon stop`（只在 8932/8935 槽位） | `out-99-cleanup.txt` |
| S19 | 写报告 | — | `REPORT-explorer.md`（结论 ≤450 字 + 逐条证据 + **未复核项**） |

## 3. 浏览器驱动（二选一，优先不碰用户浏览器）

1. **首选** `cua_driver_native`：`browser_prepare` 带 `allow_launch: true` + `profile: {mode:'isolated_new'}`（驱动自有的隔离 Chromium/Edge，不动用户 profile、不抢前台）→ `browser_navigate` 到 `http://127.0.0.1:<port>` → `get_browser_state` 拿 ref/screenshot → 用 `browser_click`（可信输入）/`browser_type`。JS 用 `page execute_javascript`，IIFE 形式 `(${文件内容})()`。
2. **兜底** `mcp__chrome-devtools-mcp__*`：新建**后台**页面（`new_page background:true`）→ `take_snapshot` → `click`；JS 用 `evaluate_script`（把 `browser/*.js` 的箭头函数原样粘进 `function`，`filePath` 落盘）。

**禁忌**：不 bring_to_front 用户已有的页面/窗口；截图/抽取只针对 `127.0.0.1:8931`（或 8934 基线）。

## 4. 已知风险与降级

| 风险 | 降级 |
|---|---|
| `cordis_inspect_query(client)` 超时 | 已按「boot graph + bundle 字面量 + DOM」三条取证落地；Inspect 可用时作为追加证据 |
| `window.__DSH_BOOT__` 注入形状与我的正则不符 | `capture-boot-graph.ps1` 会把 index.html 全量落盘并打印 `_parse: FAILED`，据实现重取；此时 ① 的注册面证据退化为「DOM rail + bundle 字面量」 |
| client 半不使用 `role=treeitem` 等通用角色 | `extract-panel.js` 落 `domHints` + `rawText`；据实细化抽取器后**重跑同一套断言**（记录细化前后两次原始输出） |
| 面板状态条在 DOM 里是图标/分片而非单行文本 | 同上；③ 的未命中项一律 unknown，绝不当通过 |
| 起不来 web 测试 profile（缺 LLM/model 配置） | 从用户 `web` profile 的 `cordis.patch.yml` **只拷贝**必要的 llm/model 条目到我的测试 profile（用户的 profile 只读），并在报告里写明拷了什么 |
| 派生 `--port` 参数不被接受 | 先 `dsh --profile <p> --help` 确认 app 参数形式，再按实际用 |

## 5. 收尾必须给出

- `REPORT-explorer.md`：结论 ≤450 字；**6 条**（①–⑥）逐条 pass/red/unknown + 原始输出文件名；强制红 R1–R6 记录；**未复核项**清单（不许把 unknown 写成通过）；被验对象 revision（`REVISION.txt`：8 src + 4 client + package.json）；活宿主 pid 未变的记录；**同队其它槽位守护清单（属主未确认，未纳入比对）**。
- revision `Check` 非 0 ⇒ 报告开头写「**验证无效**（被验对象变化）」并非 0 退出。

## 6. 表格增补（lead 2026-10-12 Q4/Q1 裁决后）

| 步 | 动作 | 命令/工具 | 产物 |
|---|---|---|---|
| S6b | ⑥ 前置：确保我方守护在跑（后台起 + 轮询就绪） | 见 §7 教训 2；`ss -ltn \| grep ':8932 '` | `out-20-daemon-start2.txt` |
| S12b | ⑥ 无副作用 + UI 状态 | before→点"在新会话中打开"→after；`extract-panel.js` 取 rawText | `out-30-*`、`out-31-*`、`shot-31-*.png` |
| S16b | 强制红 R6（缺 `client/index.js` 的副本包） | 见 MATRIX §10 | `out-40-*` |
| S1' | 冻结必须带 `-ConfirmFreeze` | `revision.ps1 -Mode Write -ConfirmFreeze` | `REVISION.txt` |

| S8b | ③ 第三条真相面：探明并直接取 host 的 webServer route | `capture-snapshot-http.ps1 -Probe`（先探路径）→ `-Path <实测路径> -Action snapshot` | `out-25-snapshot-http.json`、`out-25-route-probe.txt` |
| S10b | 抽取前**等就绪**（fetch 后树才渲染） | 轮询 distro 名/`[role=treeitem]` ≤10s（MATRIX §15） | `out-07-*.rawtext.txt` |

## 7. 准备期实战教训（照抄，别重犯）

1. **槽位作用域**：`wsl_status`/`wsl_daemon status` 报的是"被发现的守护"。我停掉自己 8932 后 probe 立刻改报 8912（后又 8731）⇒ 不加闸会**假绿**（其它槽位守护顶替我家 pid，两侧"一致"）。**归属**：8912 ∈ T2 端口段 8911–8920、8731 是插件默认口 ⇒ 是**同队其它槽位（属主未确认）**，报告里**不许**写成环境污染。**所有守护事实必须过槽位闸**：存活用按槽位 `pgrep --port 8932`、监听用 `ss :8932`、probe 的 pid/port/version 仅当 `slot==8932` 才采信。两个脚本已实现（`scopedToSlot` / `-ExpectedSlot`）。
2. **`wsl_daemon action=start` 的调用不返回**（长命守护持有调用方 stdout 管道）。**两次独立复现**：Lead 的 `selftest.ts ensure` 赋值捕获挂起（>10 min，人工 kill）+ 我的 `wsl_daemon start` 不返回（`pwsh-1093`）。**共同形态 = 调用方持有的 stdout 管道因长命守护不 EOF；根因未坐实** —— 只写现象+可用做法。正确姿势：
   ```powershell
   $proc = Start-Process -FilePath $node -ArgumentList ('"'+$probe+'" --mode daemon --action start --port 8932') -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
   for ($i=0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; if ((Wsl ss :8932) -eq 1) { break } }   # 轮询就绪
   # 之后：状态一律**另起一次** `--mode daemon --action status` 取；最后 Stop-Process $proc.Id（只杀 Windows 侧 probe，不碰 WSL 守护）
   ```
3. **比较器三态 + 映射完整性**：光有"红/绿"会把"抽不到"判成绿。已修：`As-Arr()` 区分「不可用」与「真空集」；`-SelfTest` 增加 **E 映射完整性**（缺一项就 FAIL）——准备期正是靠它发现 `daemon ports:` 正则没命中（映射被静默丢弃）。
4. **解析器只认实测格式**：`wsl_status` 的 `daemon:` 行是 `running pid=… actualPort=… slot=… version=… uptime=… idleMs=… lingerMs=… keys=N [...]`，与 2026-10-10 旧样本 `daemon: pid=… port=… version=…` **不同**。开工时若实现又变格式，先用 `--mode status --out` 落一份干净样本再校验（不能拿旧样本硬套）。
5. **冻结防误触**：`revision.ps1 -Mode Write` 需 `-ConfirmFreeze`；准备期我因 client 半刚好落地而误冻结过一次，已删除 `REVISION.txt`（当前只有 `REVISION.preview.txt`）。
6. **状态条/DOM 契约未定**：`client/**` 已在准备期末落地（`index.js`/`client.api.js`/`client.icon.js`/`client.panel.js`），但仍在校验中的 `extract-panel.js` 只输出通用信号 + `rawText`；实盘若结构不同就细化抽取器并**重跑同一套断言**。
