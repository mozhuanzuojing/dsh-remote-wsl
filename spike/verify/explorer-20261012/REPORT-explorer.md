# REPORT-explorer.md —— task-4 P0 独立验证

- **验证者**：`p0-verify`（独立于 task-1/2/3 实现者）｜**日期**：2026-10-12
- **被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`，冻结 revision 见 `REVISION.txt`（13 个锚点 = `src/**/*.ts` 8 + `client/**` 4 + `package.json`）
- **revision 结论**：开工冻结（15:44）与收尾复算（16:02）**锚点一致 = True** ⇒ 本次验证**有效**；advisory 仅 `README.md` 变动（47603→49137，Lead 按 `DOC-DRIFT.md` 更新），不影响锚点
- **环境**：测试宿主 8931（带插件）/ 8934（无插件基线）/ 8935（R6 缺件副本）；守护槽位 8932；活宿主 `127.0.0.1:19387` pid **47564** 全程未变

## 结论（≤450 字）

**A 组功能 5 条：①pass ②pass ③pass ④pass ⑤pass。**
① 侧栏出现我们的条目（DOM：`插件`→`远程资源管理器`，选中态 `aria-current=page`），且基线实例（无插件）**entry 命中 0** ⇒ 加法成立。② 点击切到 `main:remote-wsl` 且树渲染（▾ debian-u8-1 / 📁 g /home/g）。③ 面板数字与 `wsl_status` **逐项一致**（比较器 exit 0，strong=8，mismatch=0），并与 route JSON 三方面同值（pid 899039·port 8932·v0.2.0-rc.2·keys 0）。④ light/dark 双模式可区分，9/9 token 双份非空且值不同。⑤ 切走→切回前后守护 pid/端口/version/keys/pgrep/监听**全部不变**（exit 0）。
**B 组传输安全：a pass、b pass、c pass、d pass(含差异)、e pass。** a 同源 200（GET 无 Origin 403/带 Origin 200）；b 伪造 Origin 403 **且未执行**（阴性对照干净 + 阳性对照成功起守护，证明有区分力），`Sec-Fetch-Site: cross-site` 亦 403；c 未知/原型链/空 method 均 400；d PUT/DELETE/PATCH→405，POST `text/plain`→**415**（任务文本写 405，**记差异**；安全性质成立）；e 以真实 197 字符 `daemon.token` 为针 0 命中。
**⑥ `openSession` 不烧模型：pass（带保留）** —— 返回 `{sessionId:null,created:false,warm:false,+note}`、调用前后守护事实全同、UI 明示"首次发消息时才物化会话/不预热"且无 warm 控件。
**6 条强制红全部按预期变红**（R1 0/1/1/3+映射完整性；R2 基线 entry=0；R3 扰动 distro→exit 1，还原→0；R4 钉背景→断言失效；R5 停守护→exit 1，起回→0；R6 缺 `client/index.js`→exit 1+ENOENT+client-hmr waiting）。
**未复核项见文末**（desktop 现场、`order`/id 的 served 验证、drift 段、keys>0、⑥ 阳性对照、webHosts、`fixPin`、Inspect 探针）。

## A 组证据

| # | 判据 | 结论 | 原始输出 |
|---|---|---|---|
| ① | 侧栏出现我们的面板条目；相对无插件基线为加法 | **pass** | `out-06-rail-plugin.json`（DOM）、`out-04-boot-graph.json`（entry `dsh-remote-wsl rev=cc5a610f9149`）、`out-05-artifact-slots.txt`、`out-14-R2-base-bootgraph.txt`（基线命中 0） |
| ② | 点图标切到 `main:remote-wsl`，树渲染 | **pass** | `out-07-panel-extract-light.json`（`panelTitle=远程资源管理器`、`activeRailItem=[远程资源管理器]`、`aria-current=page`、树行 distro+workspace）；视觉确认在会话内完成但**未落盘**（见 §未复核项 10） |
| ③ | 树上数字与 `wsl_status` 逐项一致（差集比对） | **pass** | `out-10-diff-panel-vs-status.json/.txt`（exit 0）、`out-09-status-before.txt`、`out-25-snapshot-http.json`（第三方 route JSON） |
| ④ | light/dark 两模式正常，token 双份 | **pass** | `out-08-theme-light.json`、`out-08-theme-dark.json`（`tokensMissing` 双空；`--dsw-alias-bg-base` #fff↔#151517） |
| ⑤ | 关/切面板不杀守护（前后 pid/端口/keys） | **pass** | `out-11-daemon-before.json`、`out-11-daemon-after.json`、`out-11-daemon-invariance.json/.txt`（exit 0） |

- ① 的 `order=20` / `id='remote-wsl'` 只在**磁盘静态**源码命中（`client/index.js`），served bundle 里同名指标同时出现在**注释**中 ⇒ 见未复核项 2。
- ⑤ 的"关闭"在本实例没有独立关闭钮，等价动作 = 切到 `插件`（面板**卸载**，`ourPanelPresent=false`）再切回（**重挂**并重新取数）。

## B 组证据（`probe-transport.ps1`）

| 条 | 判据 | 实测 | 结论 |
|---|---|---|---|
| a | 同源请求 → 200 | POST snapshot=200；GET 无 Origin=403；GET 带同源 Origin=200 `{methods:[snapshot,openSession,daemon,fixPin]}` | pass |
| b | 伪造/缺失 Origin → 403 **且方法未执行** | 伪造 Origin=403、缺 Origin=403、`Sec-Fetch-Site: cross-site`=403；用 `daemon ensure`（有副作用）试：伪造后 `pids=[] listen=0`（与前置相同）；**阳性对照**同源 ensure=200 且守护真的起来（`listen=1 pids=[899039]`） | pass |
| c | 未知 method → 400 | `explorer.__nope__`=400、原型链 `constructor`=400、空 method=400 | pass |
| d | 非 POST / 非 JSON → 405 | PUT/DELETE/PATCH=405 ✓；POST `text/plain`=**415**、POST 非法 JSON=400、合法 method+非法 action=400(E_ARG) | **pass（差异）**：`415` 比任务文本的 `405` 更符合语义；未解析 body、未执行方法 |
| e | 响应/错误不含凭据 | 以**真实** `daemon.<slot>.token`（197 字符）与前缀为针，响应体命中 **0**；`token/Bearer/Authorization/apiKey/password/secret/cookie` 字样均 0 | pass |

原始输出：`out-23-transport-probe.txt/.json`

## ⑥ `openSession` 默认不烧模型调用

- 返回：`{"sessionId":null,"cwd":"/home/g","created":false,"reused":false,"warm":false,"note":"守护已就绪，但该 cwd 尚无远端会话：上游 daemon 只在收到一轮 prompt 时才物化 runtime+sessionId…"}`（`out-30-opensession-return.json`）
- **无副作用**：调用前后 `daemon-invariance -Mode Compare` = exit 0（pid/port/slot/version/keys/pgrep/监听全 MATCH）（`out-30-opensession-nosideeffect.json`）
- **UI 明示**（`out-31-opensession-ui.txt`）：aria-label `在远端会话中打开 /home/g（首次发消息时才物化会话）`、title `在新会话中打开 /home/g（不预热：首次发消息时才建立远端会话）`；DOM 全文本扫描**无 warm/预热 控件**（唯一命中就是这条"不预热"文案）
- 保留：未做"模型调用计数"的**阳性对照**（真跑一轮 `wsl_agent` 看 keys/runtime 增加）⇒ 见未复核项 5。`openSession({})` 空 args → 400。

## 强制红（区分力证明）

| 编号 | 手法（不改被验对象） | 结果 | 原始输出 |
|---|---|---|---|
| R1 | 比较器自测：一致/换 distro/改 pid/面板抽不到 + 映射完整性 | **0/1/1/3 + E PASS** | `out-00-selftest-diff.txt`、`out-00-selftest-daemon.txt` |
| R2 | 无插件基线实例（8934）跑同一断言 | boot graph **命中 entry=0** ⇒ ① 断言正确变红 | `out-14-R2-base-bootgraph.txt`、`out-14-R2-verdict.txt` |
| R3 | 页面内 fetch 包装把 snapshot 的 distros 换成 `PERTURBED-XX` | 面板渲染出 PERTURBED-XX ⇒ 比较器 **exit 1**；还原后 **exit 0** | `out-12-forced-red-panel-extract.json`、`out-12-forced-red-diff.json`、`out-07b-panel-extract-restored.json` |
| R4 | 把断言读取的信号（面板根背景色）在两模式钉成同值 | `distinguishable=false` ⇒ ④ 断言正确变红（还原后恢复） | 见 `out-08-theme-*.json` 与本文 §R4 附注 |
| R5 | 主动 `route stop` 我方 8932 守护 | 比较器 **exit 1**（alive/pgrep/listener 红；probe 值因失去槽位作用域自动降为 unknown）→ `ensure` 起回后 **exit 0** | `out-13-forced-red-*`、`out-13-restored-*` |
| R6 | 插件包副本删 `client/index.js` 后启动 | host **exit=1**；`ENOENT: … stat '…\client\index.js'`（`captureArtifactBaseline`）+ `Plugins waiting for services: client-hmr(Missing clientModules)` ⇒ **响亮失败** | `out-40-r6-noclient-host.log.err`、`out-40-r6-verdict.txt` |

- **R4 附注（诚实记录）**：第一次注入（在 `<html>` 上内联 `--dsw-alias-bg-base`）**未生效** —— 该变量在面板祖先链上被更近的作用域定义，面板解析值仍是主题色。据此改用"钉面板根背景色"这一定点扰动，断言才正确变红。R4-a 的失败注入点本身也留档。
- **R6 附注（与契约的差异）**：契约 §1.3 预言的固定串 `client bundles not found` / `ClientPackageCompositionError` 在本机**未出现**，出现的是**等原因 ENOENT** + waiting 表。"响亮"成立；消息形状不完全一致 ⇒ 记差异，不判红。

## 未复核项（**不许当通过**）

1. **desktop profile 现场**：真实桌面 GUI 的侧栏并排（`plugins`/`schedules`+我们）无法在"不重启用户宿主"前提下复现；只能用 web 测试实例 ⇒ 未复核。
2. **① 的 id/order 服务端验证**：`order=20`/`id='remote-wsl'` 仅在**磁盘源码**确认；served entry 里这些字面量来自**注释**，未在 served 产物中定位到可执行注册语句 ⇒ 未复核（DOM 只提供顺序与 label）。chunk 按 `/plugins/??dsh-remote-wsl/client.<name>.js&rev=` 取为 404 ⇒ 真实 chunk URL 形态未探明。
3. **drift 段**：本次 `drift=no`，面板未渲染 drift 明细（比较器记 unknown）⇒ 面板漂移显示逻辑未复核。
4. **keys>0 与多 key 形态**：本次守护 `keys=0`，`daemon.keys` 维度只有空集弱证据 ⇒ 未复核。
5. **⑥ 的阳性对照**：未真跑一轮 `wsl_agent`（会烧模型/建 runtime）来对照"keys/runtime 会变" ⇒ "不烧模型"缺强阳性对照。
6. **webHosts 段**：面板与 `wsl_status` 皆空 ⇒ 未复核。
7. **`explorer.fixPin`**：会改 pin（有副作用），本次未调用 ⇒ 未复核。
8. **Inspect client 探针**（`Slots.listSubTree` 投影）：本会话 4 个 client provider 均超时；`docs/client-contract.md` §7 也记为环境限制。替代取证（DOM + 服务端 bundle）**不等价** ⇒ occupant 的权威投影未取。
9. **R3 的服务端形态**：扰动在**页面内** fetch 层完成（证明"面板跟随数据"）；"服务端两套数"的场景未构造。
10. **像素级截图未落盘**：驱动（chrome-devtools-mcp）的 `filePath` 只允许写它自己的 workspace root（`D:\project\net1`），我**拒绝**把验证产物写到本目录之外，故未持久化 PNG。视觉证据以 DOM 抽取（`out-06-rail-plugin.json`、`out-07-panel-extract-light.json`）与计算样式（`out-08-theme-*.json`）为准 —— 二者比截图更可判、更可复核。

## 现场与清理

- 我起的：测试宿主 8931/8934、R6 宿主 8935（一次性）、守护 8932 —— **全部收尾停掉并核对端口无监听**（`out-99-cleanup.txt`）；`%TEMP%\rwsl-verify-noclient` 与 profile `remote-wsl-test-web-noclient` 已删除。
- 我保留的 profile：`remote-wsl-test-web` / `remote-wsl-test-web-base`（junction + 3 个配置文件），供复核；需要删除请指示。
- 同发行版另有 **slot 8972** 的守护（同队其它测试实例，属主未确认）—— 未纳入比对、未打扰。
- 未跑任何 `npm/pnpm install`；只写自己的 `spike/verify/explorer-20261012/` 根目录（`reliability/`/`stability/`/`usability/` 属 T6/T7/T5，未动）。
- 附带产出：`DOC-DRIFT.md`（README 漂移清单，Lead 已据以更新 README）、`out-18-f1-netmode.txt`（F-1 独立复核：`wslinfo --networking-mode`=**nat**）。
