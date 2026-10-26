# REPORT —— WSL 执行世界：`ctx.fs` 的 WSL provider（2026-10-23，阶段一 + 二）

> 目录：`spike/verify/fs-wsl-20261023/`
> 起因：DSH 的 `write` 在 `\\wsl.localhost\debian-u8-1\…` 上失败（`GetFileSecurityW EIO`）——
> Windows 侧 9P 共享不支持 `dsh-fs-local` 的原子写（复制 DACL / 硬链接发布）。
> 结论：**文件操作已经可以真的在 WSL 里执行**（26/26 探针，独立复核），**`wsl` preset 已在隔离实例里
> 注册并激活**（`plugins=21`），并且 **headless agent 用 `write`/`read`/`edit` 工具真跑通**（`--json`
> 事件 + `wsl.exe` 内独立复核）。

## 1. 方案（为什么不是照抄 dsh-wsl-workspace）

| 做法 | 文件读写在哪儿 | 证据 |
|---|---|---|
| `dsh-wsl-workspace` 0.7.9 | Windows 9P（`WslFileSystem` 继承 `LocalFileSystem`，override 掉 DACL/硬链接） | 其 README 第 46 行："文件工具经 Windows 侧的 WSL 9P 共享访问" |
| ZCode | Windows 9P（`wsl-backend.ts` 里 `readFile/copyFile/access` 全走 UNC） | 源码 `toWslUncCandidates` |
| VS Code Remote-WSL | WSL 内 `vscode-server`（文件、搜索、扩展全在远端） | `~/.vscode-server/bin/<commit>/` |
| **本实现** | **WSL 内 node:fs**（宿主只发 RPC，不读 UNC） | `probe-fs-wsl` 26/26 |

DSH 的缝是 `ctx.fs` 服务定义：`dsh-tool-fs` 只调 `ctx.fs.resolve/stat/readText/writeText/editText/…`。
`fs` 是单例，不能在宿主平面再 `provide` 一次；必须挂在 **agent preset 的 isolate realm**
（`isolate: { fs: true }`）里 —— 这正是阶段二要补的入口。

## 2. 已实现

| 文件 | 作用 |
|---|---|
| `src/fs-rpc.ts` | WSL 侧文件操作实现（node:fs）。版本 = `mtimeNs:size`；原子写 = 同目录 temp + rename；`replaceIfVersion`/`createIfAbsent`；`readText` 拒二进制/超限；`readBytes`/`readRange` 走 base64 |
| `src/daemon.ts` | 新增 `{op:'fs', method, args}`：调用 `fs-rpc.handleFsOp`，错误带 `FS_*` 码 |
| `src/fs-provider.ts` | 宿主 provider：`resolve` 认 Linux 路径 / UNC / 相对 cwd；方法全部转发 daemon；`ctx.provide('fs', impl)` |

关键语义：错误码与 `dsh-fs-local` 对齐（`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_NOT_REGULAR_FILE`、
`FS_BINARY`、`FS_TOO_LARGE`、`FS_NOT_FOUND`），工具层可以照常渲染。

## 3. 证据（probe-fs-wsl 26/26，真 WSL）

- 解析：Linux 路径 / `\\wsl.localhost\…` / UNC cwd 下的相对路径；`processPath` 回 UNC。
- 读写：create/update、`replaceIfVersion` 成功与过期（`FS_STALE_VERSION`）、`createIfAbsent` 撞已有
  （`FS_NOT_OBSERVED`）、版本随写入变化、失败写入不污染内容。
- 编辑：唯一替换、非唯一拒绝、`replaceAll` 全替换。
- 字节：二进制 `readBytes` 往返一致；`readText` 拒绝二进制（`FS_BINARY`）。
- 目录/链接：`listDir` 类型正确；`stat` 跟随符号链接、`lstat` 不跟随。
- **独立复核**（不是同一进程自证）：`wsl.exe … cat` 读到的字节一致；`stat -c '%a:%U'` 看到
  mode 600 与属主；`stat -c %d` 证明落在 ext4 而不是 `/mnt/d`。
- 架构断言：provider 源码不 import `node:fs`，只发 `{op:'fs'}` RPC。

回归（`daemon.ts` 改了）：`probe-daemon-gateway` 33/33、`probe-wsl-io-lifecycle` 24/24、
`probe-lifecycle-grace` 34/34 全绿。

## 4. 阶段二：preset 接入（已注册并激活）

`src/preset.ts` 在插件 apply 时调用 `agentPresets.register({id:'wsl', …})`，子插件列表是标准 preset 的
静态拷贝，只把 `tool-fs`/`tool-fs-search` 换成 `wsl-world` 组：

```yaml
- id: wsl-world
  name: cordis:group
  group: true
  isolate: { fs: true }
  config:
    - id: fs-wsl            # src/fs-provider.ts（绝对路径）
    - id: tool-fs           # @deepseek-ai/dsh-tool-fs
```

**证据**（隔离实例 `rwui1022`，`boot.ps1 -Mode Start` 的真实 stderr，已存
`out-preset-registration.log`）：

```
remote-wsl: WSL preset 已注册（id=wsl，plugins=21）
remote-wsl(explorer): 面板数据面已注册: /remote-wsl/api（…）
```

`register()` 是**急切激活**：它 resolve 说明整个 preset 子树（含 `fs-wsl` 的 `ctx.provide('fs')` 与
`tool-fs`）已经挂载成功；失败会 reject 并打「注册失败」。实例随后正常退出（`boot.ps1 -Mode Stop`，
8917/9333 无残留）。

## 5. 端到端：headless agent 真调 `write` / `read` / `edit`

preset 注册只证明"树挂上了"；工具是否真的走 provider，用 **headless agent** 串起来验：

- 隔离 profile `e2e`（从 shipped `headless` 模板造），patch 里 **关掉宿主 `fs-sandbox`**、把
  `src/fs-provider.ts` 作为**唯一**的 `fs` 服务挂上；
- 真实模型（`auto/deepseek-v4.1-flash`，经 magpie）用 `write` 写 `/tmp/…/e2e.txt`、`read` 读回、
  `edit` 改内容、再 `read`；
- `--json` 事件里能看到 `tool_call` 的 `write` / `read` / `edit` 且 `status=completed`，**没有 shell 调用**；
- 之后用 `wsl.exe` 独立复核：内容 `hello-edited`，`mode:owner:dev = 664:g:75`，而 `/mnt/d` 的设备号是 `72`
  ⇒ 文件真的在 ext4 上，不在 drvfs。

产物：`out-e2e-write-read.jsonl`、`out-e2e-edit.jsonl`、`out-e2e-agent.json`；
可复跑脚本 `run-e2e.ps1`（会真实消耗模型额度；跑完删掉隔离 home 里复制的凭据副本）。

### 5.1 preset 形态端到端（2026-10-26）

上面的 E2E 是宿主级替换，preset 形态一直只验证到"注册/挂载"。这次用隔离 **web** profile 打通：

- profile：`base` + `web-app` + `dsh-remote-wsl`（junction 到仓库）+ magpie 模型；`--from-default-profile web` 造；
- 在 GUI 里选「WSL（远程执行世界）」后发一轮任务（也可直接 `session/create {request:{agentPreset:'wsl'}}`）；
- 模型 1 轮 3 步、**10 秒**完成：`wsl_tools list` → `grep`（/home/g/.dsh/remote-wsl）→ `write`；
- `write` 落盘 `/tmp/preset-e2e.txt`，WSL 内复核 `preset-ok`、`664:g:74`（`/mnt/d` 是 `72`）⇒ 真在 ext4；
- session projection 记录 `agentPreset: "wsl"`、`steps: 3`。

证据：`out-preset-e2e.json`、`out-preset-e2e-session.json`、`out-preset-e2e-dom.txt`。
意义：preset 不只是“能注册”，而是**选中后文件与工具真的在 WSL 里执行**。

## 6. Review（2026-10-23）与修复

复核按「契约 / 安全 / 失败面 / 边界」四个角度看实现与 DSH 的调用方式（`dsh-tool-fs` 的
`writeText(target, content, intent, signal, sandboxPolicy)` 与 `editText(..., sandboxPolicy)`）：

| # | 发现 | 级别 | 处置 |
|---|---|---|---|
| F1 | `writeText`/`editText` 忽略第 5 个参数 `sandboxPolicy`：DSH 的 `read-only`/`workspace-write` 围栏被绕过 | **P0 安全** | 已修：`assertWritable()` 把 host 的 workspaceRoot（UNC→发行版内）+ `/tmp` 当根，先 `realpath` 再比，拒绝 `FS_SANDBOX_DENIED`；`sandboxMode` 报 `workspace-write` |
| F2 | `watch` 直接抛「不支持」，DSH 的文件观察策略只能退化 | P1 | 已修：500ms 轮询 `mtimeNs:size`，变化才回调（不是 inotify，语义上写明"近似"） |
| F3 | 没有 WSL 内搜索：`tool-fs-search` 未挂，agent 无法 grep/glob | P1 | ✅ 已做：`search-tool.ts` 注册 `grep`/`glob`，daemon 在发行版里执行（ripgrep/fd 优先） |
| F4 | `listDir` 用 `stat`（跟随符号链接），符号链接目录会显示成 directory | P2 | ✅ 已修：改用 `lstat`（与宿主 `listDirectory` 对齐），符号链接一律报 `other` |
| F5 | 只服务配置的一个发行版 | P2 | 未做（多守护/多槽位映射需要单独设计） |
| F6 | preset 子插件列表是标准 preset 的静态拷贝 | P2 | 未做（上游增删行不会自动跟随） |
| F7 | `writeText` 没有内容大小上限（工具层有上限，直连 daemon 的调用方没有） | P3 | 未做 |
| F8 | preset 行名用**绝对文件路径**：preset 的 EntryTree 按裸模块说明符 import，绝对路径解析失败 ⇒ 两行 `never started` ⇒ preset 永久 `broken`，UI 下拉里**看不到**（2026-10-24 用 `/api/agentPresets/list` 实测抓到的真实原因） | **P0 功能** | ✅ 已修：行名改包内子路径 `dsh-remote-wsl/fs-provider` / `dsh-remote-wsl/search-tool`（`package.json` 增补对应 `exports`），并让启动日志把 `broken` 一起写出来 |

**F8 补充**：此前"preset 已注册"只看 `register()` resolve，而 registry 的 mount 失败不抛错、只写进
`list()` 的 `broken` 字段；隔离实例的 `/api/agentPresets/list` 显示 `fs-wsl … never started` /
`search-wsl … never started`。改成包内子路径后同一接口返回的 `wsl` 行不再有 `broken`，UI 下拉也
出现了「WSL（远程执行世界）」。

修复后的验证：`probe-fs-wsl` **30/30**（新增 S1–S3 围栏、W1 轮询观察）；E2E 重跑
（`run-e2e.ps1`）仍通过：`write/read/edit` 工具事件齐全，内容 `hello-edited`，ext4 设备号 75。

## 7. 搜索（grep / glob）：在发行版里跑，优先用更快的后端

`src/search-tool.ts` 注册两个模型面工具（形状照抄本插件已有工具，不 import `@deepseek-ai/dsh-tools`）：

| 工具 | 执行体 | 后端优先级（自动探测 PATH） |
|---|---|---|
| `grep` | `src/search-rpc.ts` → daemon `{op:'search', method:'grep'}` | **ripgrep**（`rg -n --no-heading --hidden`，跳过 `.git`/`node_modules`）→ `ugrep` → GNU `grep` |
| `glob` | 同上 | **fd**（`fd --type f --hidden --exclude .git --exclude node_modules`）→ `find` |

设计要点：

- 搜索**在发行版里跑**，模型给的是 Linux 路径；宿主侧 Windows ripgrep 的路径语义问题从根上消失。
- 后端自动探测（`command -v` 缓存一次），工具结果里带 `via ripgrep` / `via fd`，不是"黑箱更快"。
- `grep` 默认 POSIX ERE（rg 的 Rust regex 支持 `\d`/`\w`/`\b`/`(?i)`，不支持环视/反向引用）；
  `fixed_string` 走字面量；`ignore_case` 生效。
- `glob` 的匹配在插件侧做（`*` 不跨 `/`、`**` 跨、`?`、`[...]`），后端只负责枚举，避免
  `find -name` 与 `fd --glob` 语义漂移；`fd` 默认尊重 gitignore（与 ripgrep 同源），`find` 回落时
  会列全部文件 —— 这条差异写在这里。
- 输出有条数上限（grep 500 命中 / glob 1000 条 / 扫描 50000 条），超限明确标 `truncated`。

**证据**：`probe-search-wsl` **10/10**（真 WSL）：`backend=ripgrep`、`backend=fd`、ignoreCase、
fixedString、无命中、`*.txt` 单层、`**/*.md` 跨目录、无斜杠按 basename；E2E `out-e2e-search.jsonl`
里模型看到的工具结果直接带 `via ripgrep` / `via fd`。

### 7.1 缺工具时自动安装（`src/search-provision.ts`）

用户要求"不怕没有，也不怕装"：搜索优先 ripgrep/fd，缺了**自动装**，装不上**明确提示**，绝不静默降级。

- 装什么：ripgrep 14.1.1、fd v10.2.0 的**静态 musl 二进制**，从 GitHub Releases 下载；
- 装到哪：默认 `~/.local/bin`（**不用 sudo、不写系统目录**）；探针用 /tmp 临时目录验证；
- 网络：daemon 用 `resolveProxyHost()` 自动取宿主代理网关（NAT 下 GitHub 直连超时），curl 带
  `--retry 3 --retry-delay 2`；
- 时机：daemon 启动 1.5s 后在**后台**预热（首次搜索通常已就绪），搜索前再 `ensureSearchTools()` 兜底；
- 失败：`notes[]` 里带失败原因 + 手动安装命令（`sudo apt install ripgrep` / `fd-find`），工具结果里
  以 `[search tools] …` 追加给模型/用户看；搜索仍用回落后端并标注 `via gnu grep` / `via find`；
- 开关：工具 config `searchAutoInstall: false` 可关（关了就只提示不下载）。

**证据**：`probe-search-provision` **7/7**（真实下载到 /tmp、`rg --version`/`fd --version` 可跑、
`autoInstall:false` 只提示、坏代理 ⇒ `source:failed` + 原因不抛）。本机 WSL 原本已有 `rg`/`fdfind`，
所以自动安装只在探针的"忽略 PATH"模式下验证，**没有**动用户的系统目录。
### 7.2 Rust CLI 工具目录（18 个）与可用性

用户要求“能用到都加上”。目录在 `src/search-provision.ts` 的 `TOOLS` 里，共 18 个，全部走同一套
“GitHub API 解析资产 → 下载 → 解压 → 装到 `~/.local/bin`”的路径：

| 类别 | 工具 |
|---|---|
| 搜索 | `rg`（ripgrep）、`fd`、`rga`（全格式，PDF/压缩包）、`ast-grep`（`sg` 结构化搜索/替换） |
| 文本处理 | `sd`（查找替换）、`bat`（高亮预览）、`hexyl`（十六进制）、`taplo`（TOML 格式化/校验）、`typos`（拼写） |
| 代码/数据 | `tokei`（代码统计）、`difft`（结构化 diff）、`delta`（git diff 美化）、`qsv`（CSV） |
| 系统/网络 | `dust`（磁盘占用）、`procs`（进程）、`xh`（HTTP）、`just`（任务运行器）、`hyperfine`（基准） |

实现要点：

- **API 优先**：`https://api.github.com/repos/<repo>/releases/latest` 解析资产名（不写死版本/后缀），
  按 linux/本机 arch/静态优先打分选包，支持 `.tar.gz`、`.zip`、单文件 `.gz`；
- **限流兜底**：未认证 API 是 60 次/小时、多人共享代理 IP 时经常 403。此时用**固定下载地址表**
  （`FALLBACK_X86_64`，18 个 URL 都逐个用 `curl -r 0-0` 验过）；API 恢复后仍走最新版；
- **预热**：daemon 启动 1.5s 后后台装 `CORE_TOOLS`（rg/fd/ast-grep/sd/bat/tokei/dust/procs）；
- **按需**：`wsl_tools` 工具（`action: list|install`）可列出/安装任意目录里的工具，结果含 source/path；
- **失败透明**：装不上时 `notes[]` 带原因 + 手动安装命令，工具结果里以 `[search tools] …` 展示。

**证据**：`probe-search-provision` **8/8**：18/18 资产可解析（API 或兜底）、ast-grep（zip）与 sd
（tar.gz）真装到临时目录且 `--version` 可跑、`list` 不下载（0 文件）、`autoInstall:false` 只提示、
坏代理 `failed` 不抛。实际安装后 `~/.local/bin` 里出现 `sd`/`tokei`/`dust`，而 `rg`/`fdfind`/`batcat`/
`procs`/`sg` 本机 PATH 已有（`source=path`，不重复装）。
## 8. 尚未完成（阶段二之后）

1. **真实桌面会话里的 preset 形态**：E2E 用的是 headless + 宿主级替换；`wsl` preset 只验证了挂载/激活，
   还没在桌面会话里用它调过 `write`/`grep`。
2. **多发行版**：provider 只服务配置的一个发行版（`distro`），UNC 指向别的发行版会明确报错。
3. **标准 preset 漂移**：`preset.ts` 的子插件列表是静态拷贝，上游增删行不会自动跟随（已写进代码注释）。
4. **fd/find 的 ignore 语义差**：`fd` 尊重 gitignore、`find` 不尊重（见 §7）。
5. **写入大小上限**：工具层有上限，直连 daemon 的调用方没有。

## 9. 复跑

```powershell
$node='C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd D:\project\dsh1\dsh-remote-wsl
& $node spike/verify/fs-wsl-20261023/probe-fs-wsl.ts   # 26/26（真 WSL，约 10s）
```
