# RUNBOOK-STABILITY —— task-7 开工后的执行顺序（等 lead 的 go）

> 本文件是**准备产物**。**S3 之后一律不执行**，直到 lead 放行且 §1 的 G2 通过。
> 所有产物落 `spike/verify/explorer-20261012/stability/`；每步同时落 `.err`。

## 1. 前置（开工前逐条复验，不许"应该没问题"）

| # | 前置 | 复验命令 | 不通过怎么办 |
|---|---|---|---|
| P1 | 活宿主仍是 `19387 pid=47564` | `(Get-NetTCPConnection -LocalPort 19387 -State Listen).OwningProcess` | 记下新 pid 作为基线；**绝不重启/停它** |
| P2 | 8981–8990 全 free | `foreach($p in 8981..8990){Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue}` | 换段内空位；全占则报 lead |
| P3 | `package.json` 含 `dsh.client`（或 T1 等价字段） | `Select-String -Path ..\..\..\package.json -Pattern 'dsh\.client'` | **停**：报 lead（G2 未过，任何渲染读数都不可信） |
| P4 | `client/**` 非空 | `Get-ChildItem ..\..\..\client` | 停 |
| P5 | `docs/client-contract.md` 存在（复核 chunk/槽位形状） | `Test-Path ..\..\..\docs\client-contract.md` | 继续，但把"注册面复核"记 unknown |
| P6 | 落 revision 锚点 | `pwsh ./hash-anchor.ps1 -Mode Write` | 若打印 gate 未过 ⇒ 停 |
| P7 | 驱动可用（cua_driver isolated 或 chrome-devtools-mcp 后台页） | `cua_driver_native_check_permissions` / mcp `list_pages` | 用另一条；两条都不可用 ⇒ ①②④ 判 unknown（只能做 ③ 的 HTTP 层对照） |

## 2. 执行顺序

| 步 | 动作 | 命令/工具 | 产物 |
|---|---|---|---|
| S0 | 记活宿主 pid + 端口占用 + 我的 pid 账本 | 见 §1 P1/P2 | `out-00-livehost.txt`、`out-00-ports.txt`、`out-00-pids.txt` |
| S1 | 量具校准（强制红 A1） | `pwsh ./analyze-growth.ps1 -SelfTest` | `out-00-selftest-analyze.txt` |
| S2 | 锚点 | `pwsh ./hash-anchor.ps1 -Mode Write` | `REVISION.txt`、`out-00-anchor-write.txt` |
| S3 | 起测试宿主（**先 compose 校验**） | `pwsh ./boot-stabhost.ps1 -DumpConfigOnly` → `... -Port 8981 -DaemonPort 8982 -RequireClient` | `out-01-dumpconfig.txt`、`out-01-host.log/.err`、`out-01-host.pid` |
| S4 | gate 复验：bundle 与 chunk 可达 | `Invoke-WebRequest http://127.0.0.1:8981/plugins/dsh-remote-wsl/client.panel.js`（及 `client.api.js`/`client.icon.js`） | `out-02-bundle-probe.txt` |
| S5 | 打开隔离浏览器到 8981，装仪表（initScript 首选） | cua `browser_prepare`(isolated_new) → `browser_navigate`；或 mcp `navigate_page -initScript browser/instrument.js` | `out-03-driver.txt`、`shot-03-boot.png` |
| S6 | 打开面板并**定性 U1**（卸载 vs keep-alive） | `browser/probe-mount-cycle.js`（`start({cycles:0})` 只做定性） | `out-04-u1-lifecycle.json` |
| S7 | **③ 前置**：在我的 8982 起真守护并记 pid | `node ../probe-ground-truth.ts --mode daemon --action start --port 8982`（p0-verify 的探针，只读用它） | `out-30-daemon-facts-before.txt` |
| S8 | **③ 时间线**（kill / 重启 / 手动刷新自愈） | `probe-stale.js start({sampleMs:5000,durationMs:120000})`；PS 侧 `explorer.daemon stop` 只对 8982 | `out-30-stale-timeline.json`、`out-31-stale-verdict.json` |
| S9 | **② 竞态/卡死**（T2a/T2b/T2c + 闸门 never） | `fixtures.js` 装载 → `probe-race.js arm/run/status` | `out-20-race-*.json`、`out-21-stuck-loading.json` |
| S10 | **① 挂载/卸载循环**（≥20 次，含 A2 人造泄漏强制红） | `probe-mount-cycle.js start({cycles:20,warmup:2})` → 轮询 `status()` | `out-10-cycle-samples.json`、`out-12-forced-red-a2.json` |
| S11 | ① 复算 | `pwsh ./analyze-growth.ps1 -Cycles out-10-cycle-samples.json` | `out-11-growth-analysis.json/.txt` |
| S12 | **④ 边界**（夹具 A/B/C） | `probe-boundary.js run({fixture:'A'/'B'/'C'})` | `out-40-boundary-{a,b,c}.json`、`out-41-boundary-verdict.json` |
| S13 | 强制红 A3/A4（闸门倒序/正序） | `probe-race.js arm({plan:'inverted'/'forward'})` | `out-22-forced-red-a3.json`、`out-23-negative-a4.json` |
| S14 | 锚点复算 | `pwsh ./hash-anchor.ps1 -Mode Check` | `out-98-anchor-check.txt`（≠0 ⇒ 报告判「结论无效」） |
| S15 | 清理：停我的宿主/守护、关隔离浏览器、删我的 profile、复查活宿主 pid 未变 | `boot-stabhost.ps1 -Stop`、`explorer.daemon stop`（仅 8982）、`cua end_session`、`Remove-Item` 前打印路径核对 | `out-99-cleanup.txt` |
| S16 | 写报告 | — | `REPORT-stability.md`（≤450 字结论 + 每项复现命令 + 原始读数 + 判定 + 未复核项） |

## 3. 注意（开工时最容易踩的）

1. **一次只动一个变量**：④ 的夹具 A/B/C 必须同一实例、同一标签页、连续跑（否则 CPU/缓存状态不同，耗时不具可比性）。
2. **① 与 ④ 不能混跑**：④ 的 fetch fixture 会让快照行数变大，会污染 ① 的 DOM 读数 ⇒ ① 跑之前必须 `fixtures.uninstall()` 并回显 `enabled=false`。
3. **② 的 fixture/闸门用完即卸**：否则 ③ 的 ground truth 对照会读到合成数据（"自欺"）。
4. **③ 的 kill 只针对 8982 的 pid**：命令里回显 slot 与 pid；停到别人的守护 = 事故。
5. **长探针一律轮询**：20 轮循环/120s 采样不要在一次工具调用里 await（会超时并丢样本）。
6. **unknown 不许写成通过**：任何"没触发到/没拿到读数"都必须落到报告「未复核项」。
