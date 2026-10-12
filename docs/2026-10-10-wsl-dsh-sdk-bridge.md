> **来源**：本文原为本机工作流文档（`D:\project\net1\docs\`），2026-10-12 随本仓收录，作为 README 开篇「为什么不是『让桌面壳连远端 host』」一节的取证。**原文除本段外未改动。**
> **勘误（2026-10-12）**：文中 `dsh-sdk-bridge.mjs` 现已迁移为零构建 TypeScript —— `C:\Users\l\.agents\scripts\dsh-sdk-bridge.ts`（27,965 B，Node ≥26.10 直跑，无 tsc/dist）；下文出现的 `.mjs` 路径请按 `.ts` 读。另：文中提到的版本 pin 与 WSL 侧隔离，如今由插件本体（`src/`）承担，本文保留当时的桥路线判定作为历史取证。
# Windows DSH ↔ WSL dsh：SDK 桥路线（架构判定 + 落地 + 验证）

- **日期**：2026-10-10
- **背景**：用户诉求原话「dsh desktop windows 如果需要管理 wsl 里面的项目，就调用 wsl 里的 dsh sdk；包括 dsh 所需的 mcp、skill 以及产出都在 wsl 中隔离，就像 vscode-wsl 插件一样，vscode 只展示和交互，实际执行的是 wsl 里的程序。同时每次 wsl 里面的版本要保持和 dsh desktop 一致，同步更新」
- **本文件结论**：目标形态**部分原生可达、部分不可达**；选定落地路线 = **路线 B：SDK 桥**（`dsh --profile sdk`，stdio JSON-RPC 2.0），版本一致性由桥自己强制。
- **交付物**：
  - `C:\Users\l\.agents\scripts\dsh-sdk-bridge.mjs`（新，Windows 侧驱动 WSL 里的 dsh SDK）
  - `C:\Users\l\.agents\scripts\invoke-wsl-dsh.ps1`（**修**：代理改为「先探测再使用」）
  - 版本 pin：WSL `~/.dsh/.desktop-version-pin`

---

## 1. 可行性判定（三条硬结论，均有实测/代码证据）

### 1.1 ❌ 桌面 Electron 壳**不能**指向 WSL 里的 host

`DeepSeek Harness.exe` 主进程命令行实测：

```
--expose-internals "...\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js" \
   <dsh dir> C:\Users\l\.dsh\profiles\desktop <primary-runtime> <pnpm.mjs> <bin>
```

- host 是**从本机打包运行时 spawn 的本地文件**（`lib/main.js`：`join(runtimeDir,"node_modules","@deepseek-ai","dsh-desktop-host","lib","index.js")`）；
- `hostUrl = ready.url`（由**本地** host 的 ready 事件给出），并配 `hostCookie` 代理；`ws://127.0.0.1/*` 是硬过滤；
- 打包态要求主窗口 origin 为 HTTPS（loopback HTTP 仅 "unpackaged/test" 放行）;
- `lib/main.js` 里**没有任何 `DSH_*` 环境变量或 flag 用于指定远端 host**，也**没有一行 WSL 逻辑**（`wsl` 命中全是 `windowsLanguage` 假阳性）；
- `dsh web --host 0.0.0.0` 被 CLI **明确拒绝**（原文）：`--host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead`（本人独立复现）。

⇒ 「桌面 UI ↔ WSL host」这个组合在上游**没有**支撑点。

### 1.2 ✅ 但「WSL 跑 host、Windows 看 UI」是上游**设计过**的形态，且 WSL2 下零配置可用

- 上游语义：`dsh-web-app/cordis.patch.yml` 的 `connection` 行原文——"Owns both ends of the web transport: node half binds the gateway to the webserver under /api; **browser half is the fetch/SSE client**"；`directory-picker-auto` 注释原文——"Resolve bind host, **SSH launch**, and display once at boot"；且 `dsh-web-app` 内有 `launchedThroughSsh(...)` 判断。⇒ **谁 serve 页面，client 就连谁**，跨机是设计内场景（SSH 语义）。
- 实测（Windows → WSL，WSL 侧 `dsh web --port 3082 --no-open`，默认 **loopback** 绑定）：

| 探测 | 结果 | 含义 |
|---|---|---|
| `http://localhost:3082/` 无 token | **401** | WSL2 localhost 转发生效 ⇒ **loopback 即可跨 OS 到达**，不需要 `--host 0.0.0.0` |
| `?token=<launch token>` | **303 + `Set-Cookie: dsh-auth-<authority-hash>-…`** | launch token → authority 绑定签名 cookie |
| 复用 cookie `GET /` | **200 / 36,411 B，含 `__DSH_BOOT__` + `assets/index`** | 真 DSH Web 前端可在 Windows 侧渲染 |
| 带 cookie 打 `/api*` | 404（非 401/403） | 已过 browser-trust 围栏与鉴权（只是端点名猜错） |

⇒ 等价于 VS Code Remote-WSL 的形态**今天可用**，差别只在 **UI 载体是浏览器/应用窗口，不是 DSH 桌面壳**。

### 1.3 ✅ 「调用 WSL 里的 dsh SDK」字面成立

- `dsh --profile sdk`（或 `sdk-minimal`）= 常驻 **newline-delimited JSON-RPC 2.0 over stdio**；
- 方法仅三个：`initialize` / `session/prompt` / `shutdown`；通知四个：`session.event` / `session.status` / `subagent.started` / `subagent.finished`（正本：`dsh-sdk-protocol/lib/types/types.d.ts`）；
- 另有 `dsh --profile acp` = 标准 **ACP v1 agent 服务端**（可被 Zed 类编辑器接入）；
- 工具执行 / MCP（stdio 子进程）/ skills / 文件写入**全部发生在 host 进程所在 OS** ⇒ host 在 WSL 就全在 WSL。

---

## 2. 选定路线与交付

**路线 B：SDK 桥**（用户选定）。`dsh-sdk-bridge.mjs` 从 Windows 侧：

1. 读**桌面版本**真相源 → 决定 WSL 侧 `pnpm dlx @deepseek-ai/dsh@<版本>`；
2. 把启动脚本写成 **WSL 侧文件**（`\\wsl.localhost\…\tmp\*.sh`）再用 `wsl -- bash <file>` 执行 —— bash 从文件读脚本，**stdin 完整留给 JSON-RPC 协议**（这点是 base64 内联写法做不到的）；
3. 起 `dsh --profile sdk`，发 `initialize{cwd,provider,model}` → `session/prompt{sessionId,contentBlocks:[{type:'text',text}]}`；
4. 从 `session.event` 折叠出 assistant 正文；`--prompt` 可追加轮次（**同进程多轮**）；
5. 收尾时 `shutdown` 让运行时停稳再退出。

用法：

```powershell
$node = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node C:\Users\l\.agents\scripts\dsh-sdk-bridge.mjs '任务文本' `
    --cwd /home/g/project/xxx --prompt '第二轮' --json --timeout-sec 600
```

参数：`--cwd`（默认 `/home/g`）、`--prompt`（可重复）、`--session`、`--provider`（默认 `deepseek-official`）、`--model`（默认 `deepseek-flash`）、`--profile`（`sdk`/`sdk-minimal`）、`--distro`、`--timeout-sec`、`--quiet-ms`（默认 3000）、`--grace-ms`（默认 20000）、`--json`、`--debug`、`--no-pin`、`--dsh-version`。

**退出码**：`0` 成功；`2` cwd 不存在（launcher 原样传播）；`64` 参数非法；`3` 事件流与持久化日志都取不到正文。

---

## 3. 过程中定位并修掉的三个根因（都带证据）

### 3.1 代理被硬 export ⇒ 所有模型调用 `TRANSPORT` 失败

- 现象：`assistant/attempt` 的 finish 为 `{kind:'error',failure:{message:'DeepSeek Messages transport failed',code:'TRANSPORT'}}`，随后 `llm/retry` 连续 retry 5 次，轮次永不结束。
- 根因（实测）：WSL 直连 `api.deepseek.com` → **HTTP 401（可达，0.23s）**；而**走代理 `172.30.176.1:9910` → 连接被立即拒绝**（`http=000, 0.0003s`）。启动器却**无条件** `export HTTPS_PROXY`。
- 修复：**先探测再使用**（`timeout 3 bash -c "exec 3<>/dev/tcp/$GATEWAY/9910"`），失败即直连并把判定打到 stderr。
- **同一缺陷存在于 L1 脚本 `invoke-wsl-dsh.ps1`（已一并修）**；这条也解释了本会话早前 shadow 记忆报 `llm-finish-error (TRANSPORT)` 的同一环境病。

### 3.2 尾帧没有换行结尾 ⇒ 完成信号永远不到达

- 现象：事件流停在 `assistant/message`，`step/end`/`turn/end` 从不出现，桥挂到超时；而**持久化 session 日志里有 `step/end`+`turn/end(completed)`**（判别实验：日志=真值，流=缺尾）。
- 根因：读取端按 `\n` 分帧，而**最后一帧（或数帧）未被换行结尾**，缓冲区永远等不到分隔符。
- 修复：静止窗口触发时先 `flushPartial()`（把残余缓冲当一帧解析），再判完成。
- 效果：修前 8 次里 1–2 次丢完成信号、需 20s 宽限；**修后 8/8 全部 `completedBy=turn/end`，5.7–7.2s**。

### 3.3 Windows 侧 node 24 只能解 zstd **首帧** ⇒ 日志兜底失效

- 日志是多帧 zstd（每轮 flush 一帧）。实测同一文件：WSL node 26 解出 20 行；Windows 自带 node **24.21.0** 的 `zstdDecompressSync` 只得到 **165 字符**（session 头）。
- 修复：兜底读取改由 **WSL 侧 node** 执行（脚本内嵌路径 + 整体 base64，零引号风险）；本机快路径仍先试。

> 附带一条上游事实：`dsh-sdk-jsonrpc-server` README 明确写「**无 per-prompt 结果** …… 客户端必须自己定义并观察活动区间」⇒ 完成判定本来就该由客户端做（本桥即如此）。

---

## 4. 版本一致性（用户明确要求；桥自己强制）

**为什么必须自己强制**：跨宿主**协议层没有版本协商**（SDK 的 `serverInfo.version` 硬编码 `"0.0.1"` 且客户端不校验；ACP 忽略客户端请求版本、无条件回 1）；而**包层**由 `dsh-app-boot` 按每个插件的 `dsh-*` peerDependencies 对 runtime 版本严格求值，**不匹配只会静默禁用/跳过条目**，不报错。桌面自身还有 `hostProtocolVersion: 4` 与「`@deepseek-ai/dsh` 与 `dsh-desktop-host` 版本必须 == release.version」的自校验。

**机制**：

| 环节 | 实现 |
|---|---|
| 真相源（轻） | `…\resources\runtime\primary-runtime\runtime.json` → `desktopVersion`（可直接读，实测 `0.2.0-rc.2`） |
| 真相源（严，未纳入桥） | `app.asar` 内 `dsh/desktop-runtime.json` → `release.version` + `release.hostProtocolVersion` + **287 个 sharedPackages** + 12411 文件 sha256（解析器已在本次会话写好，可随时接） |
| pin | WSL `~/.dsh/.desktop-version-pin` |
| 行为 | 不一致 ⇒ stderr 告警 + **按桌面版本运行** + 改写 pin；`--json` 里回带 `drift` |
| 实测 | 伪造 pin=`0.1.7-alpha.2` → 告警输出、按 `0.2.0-rc.2` 运行、pin 自动改回 ✅ |

> 历史佐证：WSL 那份启动器 `dshw` 里版本是**硬编码** `@deepseek-ai/dsh@0.2.0-rc.2`，更早的备份脚本 pin 的是 `0.1.7-alpha.2` —— 版本漂移真实发生过。另注：桌面 runtime 用 node 24.18.1/24.21.0 + pnpm 11.7.0，而 WSL 用 node 26.10.0 + pnpm 12.6.0，**node/pnpm 也漂移**（未纳入本机制，列为待决）。

---

## 5. 隔离性核对

host 进程在 WSL ⇒ `DSH_HOME=/home/g/.dsh`、MCP 是 WSL 内 stdio 子进程（`dsh-mcp-client`，`command` 必须绝对路径）、skills 取 WSL 那份、产出落 WSL 项目目录、工具执行在 WSL 内（`subprocess-local` / `terminal-bash` / `fs-*` / `sandbox-policy{workspaceRoot: process.cwd()}`）。与 Windows 侧维持既有**两份独立副本、不跨侧复制**政策（245 vs 93 skills 是**故意的**）。

跨 OS 的"宿主侧 UI 动作"也有既有通道：`dsh-native-command` 自带 `isWsl()`，在 WSL 下用 `wslpath -w` + `explorer.exe` 委派回 Windows。

---

## 6. 能力边界与未验证项（诚实清单）

**已实测的边界**：

- **无 cancel、无 session-close**：放弃一轮 = 关掉运行时进程（协议本身如此）；
- **无 per-prompt 结果**：`session/prompt` 只回 `{messageId}`（入队回执）；完成判定必须客户端自定（本桥=静止窗口 + 尾帧处理）；
- **跨进程复用同一 session id 被拒**：`JSON-RPC -32603: session "<id>" already exists`（实测）⇒ 跨进程续接要靠上层编排（一会话一长驻运行时），不能"重开进程 + 同 id"；**同进程多轮已验通过**（记住 7 → 追问 → 答 7）；
- **SDK 协议层无版本协商**（见 §4）；
- 事件流**偶发丢尾帧**（已由 `flushPartial` + 日志兜底覆盖，但性质上仍是上游行为，不是本桥能根除的）。

**未验证/未做**：

- `app.asar` 的 `hostProtocolVersion` / 287 sharedPackages 漂移比对未接入桥（真相源已可读，实现待做）；
- node/pnpm 版本一致性未管；
- WSL 上**目录选择器**走哪条分支（linux `zenity/kdialog` 还是 browser）未实测；
- 「WSL host + Windows 应用窗口」这条 UI 路线只验到 401/303/200 + 前端资源，**未做交互级验证**；
- 常驻 host 的长稳性未测（本会话只做过短期探测，且**已清理**）。

---

## 7. 验证矩阵（本会话实测）

| 项 | 方法 | 结果 |
|---|---|---|
| 通道可用 | `Reply with exactly: SDK-BRIDGE-OK` | `SDK-BRIDGE-OK` / exit 0 |
| **同进程多轮上下文** | 轮1「记住 7」→ 轮2「刚才的数字？」 | `7` / exit 0 / `turn/end` / 8.6s |
| **工具在 WSL 真执行** | 数 `dsh-shadow/adr` 的 `.md` | `122`（与 UNC 直读 **122** 独立一致）；事件含 `tool/call`+`tool/result`（glob、bash） |
| 稳定性 | 同任务连跑 8 次 | **8/8 成功**，全部 `turn/end`，5.7–7.2s |
| 边界：cwd 不存在 | `--cwd /no/such/dir` | exit **2** |
| 边界：cwd 非法 | `--cwd '/home/g/my dir'` | exit **64** |
| 版本漂移 | 伪造 pin | 告警 + 按桌面版本运行 + pin 自动改回 ✅ |
| L1 回归（我改过它） | `invoke-wsl-dsh.ps1 'Reply with exactly: L1-REGRESSION-OK'` | `L1-REGRESSION-OK` / exit 0 / 3.0s |
| 跨进程续接 | 两次进程同 `--session` | ❌ `session "…" already exists`（**记录为边界**，非缺陷） |

---

## 8. 回滚

- 新文件：`dsh-sdk-bridge.mjs`（删掉即回滚）；
- 改文件：`invoke-wsl-dsh.ps1`（改动仅"代理判定"一段，`git`/备份可复原）；
- 新增 WSL 侧状态：`~/.dsh/.desktop-version-pin`（删掉即回到"每次告警"的初始态）；
- 本会话在 WSL 侧产生的 `sdk-bridge-*` session 目录属于**正常会话记录**，无需清理。
