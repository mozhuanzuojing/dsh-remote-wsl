# 差距核实：`dsh-remote-wsl` vs VS Code Remote-WSL

- **日期**：2026-10-10
- **方法**：**两边都取一手证据**。VS Code 侧的机制在用户这台 WSL 里有实物（`~/.vscode-server`），逐项核对；插件侧逐行查代码 + 跑测试。
- **标注约定**：`[实测]` = 本次在本机跑出来的；`[背景]` = VS Code 侧已知行为但本次未在本机验证；`[代码]` = 直接来自 `src/index.ts`（TS 迁移前为 `lib/index.js`）。

---

## 0. 先立"对位关系"

| VS Code | dsh-remote-wsl |
|---|---|
| VS Code UI（Windows） | Windows 宿主里的 **DSH agent + 浏览器应用窗口**（桌面壳不能连远端） |
| `vscode-server`（WSL） | WSL 里的 **dsh**（`--profile sdk` 常驻运行时 / `web` host） |
| 远端扩展（`~/.vscode-server/extensions`） | WSL 自有 `~/.agents`（93 skills）+ `~/.dsh/profiles/*` |
| 远端设置（`data/Machine/settings.json`） | WSL `~/.dsh/profiles/*/cordis.patch.yml` 等 |
| 客户端 commit ↔ server commit | 桌面 `desktopVersion` ↔ WSL `.desktop-version-pin` |

---

## 1. VS Code 侧实测到的事实（本机）

| 编号 | 证据 | 说明 |
|---|---|---|
| V1 `[实测]` | `~/.vscode-server/bin/**2a59476c9bfcb90b3ddc372c36762471b7dfad1c**/`，与 `code --version` 第二行（commit）**逐字相同**（版本 1.141.0）；`bin/` 下**只有这一个** commit 目录 | **server 按客户端 commit 自动供给，并清掉旧版** |
| V2 `[实测]` | `~/.vscode-server/extensions/` 内含 codegeex / editorconfig / xmltodo / git-graph / 中文语言包 等 | 远端扩展**独立安装**（linux-x64 本地包） |
| V3 `[实测]` | `~/.vscode-server/data/Machine/settings.json`（2917 B） | 远端**独立设置层** |
| V4 `[实测]` | `~/.vscode-server/data` 权限 `drwx------` | 远端数据与本地分离 |

---

## 2. 逐维度差距表

| # | 维度 | VS Code Remote-WSL | dsh-remote-wsl | 定性 |
|---|---|---|---|---|
| 1 | 连接模型 | 客户端主动连远端 server（可跨任意机器，含 SSH 远端） | Windows 宿主 spawn `wsl.exe` 起 WSL 进程 `[代码]` | 🟡 等效（限本机 WSL；**不能连非本机远端**） |
| 2 | **UI 载体** | 原生窗口 = 远端工作区窗口 | **Windows 开浏览器应用窗口指向 WSL host**；桌面壳仍连不了远端 | 🔴 **真缺口**（上游限制；补位已实测到 HTTP 层） |
| 3 | **版本供给** | 自动下载 + 强绑定客户端 commit + 清理旧版（V1） | 读桌面版本 → pin → **按需** warm（`warm 0.2.0-rc.2: ok` `[实测]`）；**不自动下载、不清旧 dlx** | 🔴 半缺口（**可关**：drift 自动 warm + 旧版清理） |
| 4 | 远端扩展/skill 管理 | UI 里装/卸远端扩展（V2） | WSL 自有 `~/.agents`（93 skills `[实测]`）+ profile bundles；**无管理 UI** | 🟡 能力在、管理面缺 |
| 5 | 远端设置层 | `data/Machine/settings.json` + UI 分区 Remote/Local（V3） | WSL 侧 `cordis.patch.yml` 等；**无 UI 分区** | 🟡 同上 |
| 6 | 终端 | 集成终端：多路、持久、PTY | `wsl_exec` = **一次性命令**（无 PTY/无持久）`[代码]`；但 `wsl_open_ui` 起的 WSL Web UI **自带终端侧栏**（host 侧 `dsh-terminal-bash`） | 🟡 组合起来有；单看 `wsl_exec` 较弱 |
| 7 | 端口转发 | 自动发现 + 面板 + 转发鉴权 `[背景]` | **无转发面板**；但 WSL2 localhost 转发让任意 WSL 端口**天然可达**：`python3 -m http.server 8099 --bind 127.0.0.1` → Windows `localhost:8099` **200** `[实测]` | 🟡 **可达性 OS 白送**，缺"发现/UI/鉴权" |
| 8 | **重连 / 会话持久** | 关窗后 server 常驻，重开即续 `[背景]` | **现状（2026-10-13 更新）：守护已闭合跨宿主会话** —— `wsl_daemon` 守护持有运行时，**关客户端 ≠ 会话结束**；实测 `mode=systemd`（报告 `spike/verify/explorer-20261012/REPORT-t21-f38-verify.md`、README「P0.3 冻结 revision」节）。**真缺口另计**：**桌面壳 attach**（桌面壳仍连不上远端 host，见 #2）；`-32603 already exists` 仍只约束**无守护的 in-host 路径** | 🔴 **真缺口 = 桌面壳 attach**（"会话持久"部分已闭合，不再算缺口） |
| 9 | 多窗口共享一个 server | 1 server ↔ N 窗口 `[背景]` | **现状：已由同一个常驻守护闭合** —— 多个客户端 attach 到同一守护、按 `key` 复用运行时（同宿主内原本就按 `key` 复用；跨宿主进程经守护代理）。**真缺口另计**：真正的"多窗口 attach 远端 host"仍要桌面壳支持（同 #2） | 🔴 **真缺口 = 桌面壳 attach**（与 #8 同一根因） |
| 10 | 原生 UI 回代（对话框/开文件/剪贴板/通知） | 正式 remote-UI 协议 `[背景]` | 插件**不代理**；但 WSL host 自带 `dsh-native-command`（`isWsl()` → `wslpath -w` + `explorer.exe`），WSL Web UI 的目录选择也在 host 侧 | 🟡 由 WSL host 自带，插件层没有 |
| 11 | **工作区根映射** | 远端文件夹即工作区根（资源管理器/搜索/git 全在远端） | `cwd` 只在 **WSL 侧会话**内生效 `[实测]`（`cwd=/tmp → /tmp`、默认 `→ /home/g`）；**Windows 侧 agent 的 fs 工具不重映射**（能读 `\\wsl.localhost\…`，但那是路径约定不是 provider） | 🔴 **真缺口**（要 fs provider 级支持） |
| 12 | 状态/发现 UX | 状态栏 "WSL: Debian"、distro 选择器、Reopen in WSL `[背景]` | `wsl_status` 按需调用；**无 UI 元素**（DSH 有 client UI slot 可加） | 🟡 原语在、UI 缺 |
| 13 | 鉴权 | 连接票据/令牌 `[背景]` | 沿用 DSH web 的 launch token → 签名 cookie + loopback-only：`401`（无 token）→ `303 + Set-Cookie` → `200`（含 `__DSH_BOOT__`）`[实测]` | ✅ 等价 |
| 14 | 隔离性 | 远端扩展/设置在远端 | WSL 独立 `~/.dsh` + `~/.agents`（93 skills，与 Windows 245 **故意两份**）`[实测]` | ✅ 等价（更彻底） |
| 15 | 程序化接入 | 无对等物 | `wsl_agent` = 常驻 SDK（stdio JSON-RPC）；DSH 另有 `--profile acp`（编辑器接入） | ✅ **插件更强** |

**统计（2026-10-13 重算）**：✅ 等价 3 · 🟡 等效/部分 7 · 🔴 **真缺口 2**（#2 桌面壳 attach · #11 工作区根映射）+ 1 半缺口（#3 版本供给）。**#8/#9 从"真缺口"移出**：其"会话持久/多窗口共享"已由常驻守护闭合（`mode=systemd` 实测），残余诉求（桌面壳 attach）并入 #2 计数，不再重复计。

---

## 3. 四条真缺口：各自的关闭路径与代价

| 缺口 | 关闭路径 | 谁来做 | 代价 |
|---|---|---|---|
| **#2 UI 载体** | 上游给桌面壳加 `--connect <url>`（允许连远端 host，并放宽"打包态必须 HTTPS + 只信 loopback"的策略）；否则维持"浏览器应用窗口"形态 | **上游**（绕开需改 asar，桌面每次更新覆盖） | 上游改 shell；我们侧可先把开窗做默认并处理 token 轮换 |
| **#3 版本供给** | drift 时**自动 warm**、清理旧 dlx、启动期做一次检查 | **我方**（纯工程） | 首次调用变慢（~6s 冷启）或宿主启动变慢 |
| **#8/#9 重连 / 多窗口共享** | **已闭合（我方，2026-10-13）**：不需要上游 —— 常驻守护持有运行时，客户端 attach 即可（`wsl_daemon`，实测 `mode=systemd`；见 `spike/verify/explorer-20261012/REPORT-t21-f38-verify.md`）。**剩余真缺口另立**：桌面壳 attach（= #2，卡在上游桌面壳） | **我方已完成（守护路径）**；桌面壳部分仍归**上游** | 守护路径：已付（P0/P0.3 轮）；桌面壳：上游改 shell |
| **#11 工作区根映射** | 上游 fs provider 支持"远端根"；或我方落地"UNC 工作区约定"（把远端根映射成 `\\wsl.localhost\…` 供 Windows 侧 fs 工具用） | 上游（真等价）/ 我方（约定级近似） | 约定级：小；真等价：大 |

---

## 4. 本次审计暴露的**我方**问题（不是与 VS Code 的差，是我的缺陷）

| 问题 | 状态 | 证据 |
|---|---|---|
| `wsl_agent` 声明了 `cwd` 参数但实现里被忽略（用 `this.cfg.cwd`） | **已修** | 修前 `[代码]` L747 声明 / L347·L369·L500 忽略；修后 `[实测]` `cwd=/tmp → /tmp`、默认 `→ /home/g` |
| `wsl_open_ui({open:true})` 的开窗**未做视觉验证** | 待验 | 仅机制证据：`msedge.exe`/`chrome.exe` 在 App Paths 注册表有记录（不在 PATH）`[实测]` |
| 错误路径未系统覆盖（WSL host 起不来、端口被占、distro 名错） | 待验 | 只跑过 happy path + cwd 边界 |
| `wsl_exec` 无 PTY/持久 shell（与 VS Code 集成终端有实质差距） | 设计取舍 | `[代码]`：一次性 `bash <file>` |

---

## 5. 一句话结论

> **协议与隔离这两层，插件已经和 Remote-WSL 对得上（鉴权/隔离/程序化接入甚至更强）；差的是三样：① 真 UI 载体 / **桌面壳 attach**（卡在上游桌面壳）② 版本自动供给（我们能补）③ 工作区根映射（要 provider 级支持）。**（**2026-10-13 更新**：原第③"重连与会话复用"**已由常驻守护闭合** —— 关客户端 ≠ 会话结束，实测 `mode=systemd`；见 §2 的 #8/#9 与 §3。）

按"能自己补"排序，性价比最高的是 **#3 自动供给**（纯工程、收益立刻可见），其次是 **#12 状态栏/发现 UX**（DSH 有 client UI slot；**P0 已落地为侧栏「远程资源管理器」面板**）。**#2（含桌面壳 attach）与 #11 需要上游**；**#8/#9 已由我方常驻守护闭合，不再依赖上游**。

---

## 6. 对抗性审核（2026-10-10，实测）

方法：造 5 组对抗场景（负路径 / 大输出 / 并发 / 空闲回收 / 端口被占）直调工具，跑完查 WSL 侧结束态。

| 项 | 场景 | 修前 | 修后 |
|---|---|---|---|
| A | `distro` 名写错 | 裸 Node errno（`UNKNOWN: unknown error, open '\\\\wsl.localhost\no-such-distro\tmp\…'`）**完全不可诊断**；且在回收/日志兜底路径上会变成未捕获异常 | `exit 127` + `remote-wsl: 无法写入发行版 "X" 的 /tmp（UNC … 不可用）。用 \`wsl -l -v\` 确认发行版名…` |
| B | 200KB 输出 | — | 截断生效（120,039 字）；**尖锐边**：preamble 的 `set -o pipefail` 会把 `yes\|head` 的 SIGPIPE 反映成 `exit 141`（与真实 bash 语义一致，但要在 tool 描述里说明） |
| C | 两个 `key` 并行 | 曾报"事件流与持久化日志都没有 assistant 正文" | **干净环境下双成功 2.4s**（先前失败归因于**孤儿运行时**仍在后台重试抢配额，不是并发缺陷） |
| D | `idleTimeoutMs=15s` 后回收 | — | 20s 后**换新 sessionId**（`69a90d68`→`74647132`），符合"跨进程不得复用 id"的设计 |
| E | `webPort` 被占 | — | **4.6s 快速失败**，回带 dsh 原文（`dsh: startup failed: 2 required plugins did n…`），不挂到 60s 超时 |
| — | 回归 | — | 完整单元测试全过；**真实宿主 e2e 复跑通过**（14.4s，可见插件自己的代理判定行） |

**本轮审核新修的两个真缺陷**

1. **错误可诊断性**：`writeScript` 包装成可操作错误；`runWsl` 不再抛异常（返回 `exit 127` + 诊断）；`reapWsl` 吞错（发行版被关掉时不能影响主流程）。
2. **孤儿运行时泄漏**（我先前"退出后零残留"的结论**只在优雅退出下成立**）：宿主异常退出时 disposer 不跑，WSL 侧 `--profile sdk` 进程会留下并继续重试、抢模型配额（实测一次崩溃后残留 5 个）。
   修法 `sweepStaleRuntimes`：pid 文件名里带 **Windows 宿主 PID**（`dsh-rwsl-<winpid>-<ts>-<rand>.pid`），用 `process.kill(pid, 0)` 判活，**只杀宿主已死的**（不碰其它 DSH 窗口正在用的运行时），懒触发一次。
   验收：`wsl_status` 报 `pid files: 4` → 一次 `wsl_exec` 后 `0`，且 WSL 侧无残留进程。

---

## 7. 方案审核（对 §3 关闭方案的批判性复核）

| 原方案 | 复核发现 | 修正后的方案 |
|---|---|---|
| **#3 自动供给**：drift 自动 warm + 清旧 dlx + 启动期检查 | ① **硬编码了用户路径** `C:\Users\l\…`，不可移植；② warm 依赖网络/代理（本机代理常停），dlx 冷启 ~5-7s；③ 清旧 dlx 有破坏性（可能删掉正在跑的版本） | ① 版本源改为**分层**：`DSH_DESKTOP_PRIMARY_RUNTIME_DIR` → **从 `process.execPath` 推导安装根**（桌面 host 的 execPath 就是 `DeepSeek Harness.exe`）→ 默认路径；② **默认不 warm**（只告警 + 给建议），warm 保持显式动作；③ 清旧 dlx 只在"既非在用、也无存活运行时"时做，且默认关闭 |
| **#12 状态/发现 UX** | DSH 确有 client UI slot，但写 client 半是**另一个工程**（`dsh.client` 双面包 + 前端构建；且 client 改动要 `dev:web` 在跑才热更） | 先做**读侧状态**（`wsl_status` + AGENTS.md 约定），UI 留到确有需要 |
| **#11 工作区根（UNC 约定）** | 原方案漏掉一个**硬风险**：在 UNC 上跑 Windows 侧 `git`/`npm` 会写坏同一份 ext4 仓库的属主/权限 | 约定必须写死为"**经 UNC 读、经 `wsl_exec` 执行**"，并在 AGENTS.md 里明确禁止在 UNC 上跑写型 Windows 工具 |
| **#2 UI 载体（浏览器应用窗口）** | 可再升级为 **Edge/Chrome 的 PWA 安装**（独立图标+窗口，观感更近 Remote-WSL）；但**launch token 每次进程重启都变** ⇒ 固定快捷方式会失效 | PWA/快捷方式必须配"**先取最新 token URL 再开**"的启动器（`wsl_open_ui` 正是这个），二者是依赖关系，不是二选一 |
| **#8/#9 重连 / 多窗口共享**（我原判断：只能等上游） | **已落地（2026-10-13 复核）**：走的就是这条第三条路 —— WSL 侧**常驻守护**（`wsl_daemon`，持有运行时 + 元数据按槽位）+ Windows 侧薄客户端接入 ⇒ 关窗重连 = 重连到守护，绕开 `-32603 already exists`（运行时始终由守护持有）。实测 `mode=systemd`：报告 `spike/verify/explorer-20261012/REPORT-t21-f38-verify.md` | ✅ **已实现**（不再是候选）。残余诉求"桌面壳 attach 到远端 host"归 #2，仍卡上游 |

**结论**：五条里有 **三条可以自己关**（#3 修正版、#11 约定版、#12 读侧版），**一条要配依赖**（#2），**一条我原先判死、其实另有出路**（#8/#9 远端代理）。

---

## 8. 方法升级：从 VS Code **自己的产物**反推核查清单（"查什么"）

上一轮 §2 的 15 个维度**是我凭记忆列的**——方法上不牢。正确做法是拿本机实物反推：

**证据源**
- `C:\Users\l\.vscode\extensions\ms-vscode-remote.remote-wsl-0.104.3\package.json`（`contributes` = 权威功能面）
- 同目录 `dist/node/extension.js`（415 KB，机制实现）
- WSL 侧 `~/.vscode-server/`（落盘形态）

**manifest 给出的功能面**：`extensionKind:["ui"]`（扩展跑客户端侧）、激活事件 `onResolveRemoteAuthority:wsl`、**23 个命令**（连接类 6 / WSL 视图类 10 / 诊断反馈类 5 / reveal 1）、**8 个配置键**、**1 个视图 `targetsWsl`**、其余 `contributes`：`resourceLabelFormatters`、`menus`、`keybindings`、`viewsWelcome`、`remoteHelp`、`walkthroughs`。

**由此得出的核查清单（"查什么"）**

| # | 查什么 | 证据源 / 判据 |
|---|---|---|
| 1 | 连接抽象 | `onResolveRemoteAuthority:wsl` + `registerRemoteAuthorityResolver("wsl", …)` |
| 2 | 连接通道实现 | bundle：`connectionMethod="wslExeProxy"`、`acquire_cli`/`serve({socket_id,connection_token,compress})` |
| 3 | 目标发现与管理 | `wsl.exe --list --verbose` 解析；`targetsWsl` 视图；add/delete/setDefault/refresh |
| 4 | 窗口与工作区语义 | `openFolder`/`reopenInWSL`/`reopenInWindows`（`with({authority})` + `OpenMode`）；`resourceLabelFormatters` |
| 5 | 版本供给 | 下载 URL `${…}/commit:${clientCommit}/server-${quality}/…`、归档 `vscode-server-<commit>-<quality>.tar.gz`、"Found … Skipping download."；`downloadInBackgroundCommit` |
| 6 | 文件系统语义 | 配置键 `remote.WSL.fileWatcher.polling` / `.pollingInterval`（跨 OS 事件不可靠 ⇒ 轮询） |
| 7 | 环境注入 | `remote.WSL.useShellEnvironment`，实现 `!1!==get(...)` ⇒ **默认 true** |
| 8 | 网络前提 | bundle 读 `WslConfigs.localhostForwarding` 并传入 resolver ⇒ **转发由 WSL 自身提供，扩展只是遵从设置** |
| 9 | 诊断/可观测 | `showLog`/`getHelp`/`getStarted`(walkthrough)/`reportIssue`/`provideFeedback` |
| 10 | 启动路径 | `experimental.scriptLessStartup`；`experimental.serverPort`；`server.connectThroughLocalhost` |
| 11 | 信任与能力声明 | `capabilities.virtualWorkspaces/untrustedWorkspaces`、`workspace trust` |
| 12 | 端口转发/端口面板 | **不在本扩展**（无任何 port 命令/设置）⇒ 属 VS Code 核心 + 远端协议 |

## 9. 机制级 diff（"差什么"）

| # | 维度 | VS Code（实测机制） | dsh-remote-wsl | 差 |
|---|---|---|---|---|
| 1 | 连接抽象 | 注册 **remote authority 解析器**（`"wsl"`），上层（窗口/工作区）只认 authority | 直接 `spawn wsl.exe`，**无 authority/连接抽象** | 🔴 无法被其它 UI 复用；也接不上未来 DSH 的 remote 概念 |
| 2 | 连接通道 | 一条 **wsl.exe 代理通道**上跑 `acquire_cli`/`serve`，**多路复用 socket + connection token + 压缩** | 每次工具调用 spawn 一个新 `wsl.exe`；SDK 运行时各一条 stdio | 🟡 能力够用；缺多路复用/压缩/token 握手 |
| 3 | 目标管理 | `targetsWsl` 视图 + 增删/设默认/revealInExplorer | `distro` 配置 + `wsl_status` 列表 | 🟡 管理面 + UI |
| 4 | 窗口/工作区 | `reopenInWSL`/`reopenInWindows` **双向** + `resourceLabelFormatters`（路径显示成 `WSL: distro`） | 无窗口概念；只有 `wsl_exec({cwd})`/`wsl_agent({cwd})` | 🔴 "打开 WSL 项目"不是工作区语义 |
| 5 | **版本供给** | 按**客户端 commit** 下载 server 归档（命中即跳过）；`downloadInBackground` = **为下一个更新预下载**（读 `downloadInBackgroundCommit`/`_update.state`） | 桌面 `desktopVersion` → pin → **显式** warm（默认关） | 🔴 缺"自动 + 后台 + 预供给下一个版本" |
| 6 | **文件系统事件** | 明写轮询（`fileWatcher.polling` + 间隔），因跨 OS 事件不可靠 | **无任何监听/失效检测**；Windows 侧读 9p/UNC、WSL 侧读 ext4 | 🟡 执行在 WSL 侧，影响小于编辑器场景；但**这是上一轮完全没查的项** |
| 7 | **环境注入** | `useShellEnvironment` **默认 true**：把登录 shell 环境注入远端进程 | preamble 只**硬编码补 PATH** + 代理探测 | 🔴 用户 shell 里的自定义 env 不会进运行时（**上一轮没查**） |
| 8 | 网络前提 | 读 `localhostForwarding` 设置再决定连接方式 | 直接用 `localhost`（WSL2 默认转发） | 🟡 若用户关了转发，我会静默失败（无检查） |
| 9 | 诊断 | `showLog`/walkthrough/`reportIssue`（UI 面板 + 引导） | `wsl_status` + `--debug` 文本 | 🟡 可观测面弱 |
| 10 | 启动路径 | `scriptLessStartup`（免脚本）、`serverPort`、`connectThroughLocalhost` 可配 | 写 `.sh` 再 `bash <file>`（传统脚本）；端口/连接方式不在此层 | 🟡 多一次 UNC 写文件；但**换来 stdin 干净**（SDK 需要） |
| 11 | 信任模型 | `virtualWorkspaces` / `untrustedWorkspaces` 能力声明 + workspace trust | 无声明（由 DSH 的 permission preset 承担） | 🟡 边界声明缺 |
| 12 | 端口转发 | **不由扩展提供**（VS Code 核心）；可达性由 WSL 转发（实测 8099 通） | 无面板；可达性同样免费 | 🟡 与 VS Code 的差距只在"发现/UI/鉴权" |

**两处对我上一轮结论的更正**

1. **端口转发归类错了**：它不是 Remote-WSL 扩展的能力（manifest 里一个 port 命令/设置都没有），而属 VS Code 核心；`localhostForwarding` 只是被扩展**读取**。
2. **`downloadInBackground` 语义比我想的更强**：不是"随便预下载"，而是**为下一个 VS Code 更新预下载对应 commit 的 server**（读 `downloadInBackgroundCommit` / `_update.state`）。

---

## 10. 本轮修复清单（2026-10-10，全部已实测）

对上表 §9 中"能自己关"的三条 + 一条文档项，已落地并验证：

| §9 项 | 改动 | 证据（命令 → 观察） | 状态 |
|---|---|---|---|
| #7 环境注入 | 新增 `src/shell-env.ts`（迁移前为 `lib/shell-env.js`）：`shellEnvSnippet()`（就地 `eval "$(bash -lc 'export -p')"`，带超时/过滤/失败静默，**不落盘任何 env**）+ `parseLocalhostForwarding()` 纯函数；接进 `SdkRuntime.start()` 与 `WebHost.start()`，**在 PATH 补丁与代理探测之前**；一次性 `wsl_exec` 刻意不注入 | 对抗 E 的 stderr 出现 `remote-wsl: 已注入登录 shell 环境`；`wsl_status` 报 `shell env injection (useShellEnvironment): on…` | ✅ |
| #5 版本供给 | 新增 `src/version.ts`（迁移前为 `lib/version.js`）：`desktopRuntimeCandidates()` 分层推导（configured → `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` → **由 `process.execPath` 推导** → 兜底）+ `pickDesktopVersion()`（容错）+ `warmScript()`（**必带 --profile**）+ `dlxInventoryScript()`；`backgroundWarm` 改为**后台非阻塞预热** | `wsl_status` 报 `desktop dsh version: 0.2.0-rc.2 <- C:\…\primary-runtime\runtime.json`、`dlx dsh versions in WSL: 0.2.0-rc.2`；`grep` 确认 `lib/` 无裸 `@deepseek-ai` 导入 | ✅ |
| #8 网络前提 | `localhostForwarding` 探测（读 `.wslconfig` 与 `/etc/wsl.conf` 原文 → 纯函数判定） | `wsl_status`：`localhost forwarding: true  <- wslconfig（networkingMode=mirrored 时该键被忽略）` | ✅ |
| #9 诊断面 | `wsl_status` 新增三行（shell env / localhostForwarding / dlx 版本） | 真实宿主 e2e：agent 原样引用三行 | ✅ |
| 文档 | README 增：两个新配置键、`exit 141`（pipefail/SIGPIPE）说明、**UNC 禁令**（读可走 UNC，写型 Windows 工具必须走 `wsl_exec`/`wsl_agent`）、文件事件说明 | README 4905 → 12621 B | ✅ |

**已验证**：回归 `test.mjs` 全过（`wsl_agent` 两轮答 `7`、`warm ok`）；对抗 A–E 全过（distro 错=可读诊断、截断、并发双成功、空闲换新 id、端口占用 4.2s 快速失败）；**真实宿主 e2e 13.9s**；孤儿清理 `4 → 0`；最终 `/tmp` 残留 0、`sdk` 进程 0、3082 无监听。

**仍未闭合**：`#1` 连接抽象 / `#4` 窗口-工作区语义（**上游级**）；`#8/#9` 重连·多窗口（唯一自研出路 = **WSL 侧常驻代理 spike**，进行中）；`#11` 能力/信任声明（DSH 无对应概念，**不适用**）。

**编排教训（记下来别再犯）**：本轮用 workflow 铺了 3 相位 6 个 subagent 做"一个文件上 4 个小修复 + 验证"，**开销远大于收益**（P3 验证相独占约 33 分钟/整轮约 45 分钟：相位屏障 + 每个 subagent 重建上下文 + 同一套全矩阵被跑了多遍 + 每次 `wsl_agent` 都要 `wsl.exe`+`pnpm dlx` 冷启 5–9s）；且 workflow 的 `return` 里直接返回了 schema 校验产生**非 plain object**，序列化失败把报告全丢（文件写入是真的）。**结论**：宽扇出才用 team；单文件集成与最终验证留主线；每个 agent 只做一个聚焦证明；`return` 前先 `JSON.parse(JSON.stringify(…))`。



