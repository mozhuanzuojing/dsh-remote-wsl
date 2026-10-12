# dsh-remote-wsl

把 **WSL 发行版**当作「远端执行宿主」的 DeepSeek Harness 插件——VS Code Remote-WSL 的 DSH 对应物，
但**形状是诚实的**。

## 为什么不是"让桌面壳连远端 host"

VS Code Remote-WSL：Windows 只跑 UI，`vscode-server` 跑在 WSL，客户端连过去。

DSH **没有**这一步（2026-10-10 实测；取证全文在本仓 `docs/2026-10-10-wsl-dsh-sdk-bridge.md`）：
桌面 Electron 壳的 host 是它从**本机打包运行时** spawn 的本地进程（`dsh-desktop-host/lib/index.js`），
`hostUrl = ready.url`、`ws://127.0.0.1/*` 是硬过滤，没有任何 `DSH_*`/flag 能指向远端；
`dsh web --host 0.0.0.0` 被 CLI 明确拒绝（`it would expose remote code execution to the network`）。

所以本插件做的是**同一件事的可用形态**：从 Windows 宿主侧驱动 WSL 那份 dsh，并把隔离与版本一致性一起管起来。

## 30 秒上手

1. **装**：profile 的 `package.json` 里把本仓以 `link:` 加进 `dependencies`，并把 `"dsh-remote-wsl"` 加进 `dsh.profile.bundles`；再建一个 junction 到 `~/.dsh/profiles/<profile>/node_modules/dsh-remote-wsl`（**pnpm 对 `link:` 依赖不装依赖**）。完整命令见下面「安装（link 进 profile）」。
2. **验**：`dsh --profile <profile> --dump-config | Select-String 'remote-wsl'` 应出现本插件的层；**重启 profile** 后工具才出现。
3. **用**：先 `wsl_status`（只读、廉价的诊断入口）→ 再按需 `wsl_exec`（一次性命令）或 `wsl_agent`（常驻远端 agent，**关客户端 ≠ 会话结束**）。
4. **收**：`wsl_daemon action=stop` 显式结束会话；不显式停则由 `daemonIdleMs`（默认 30 分钟）回收 ⇒ **上下文丢失**。

前置：WSL 侧要有 `dsh`（插件按 pin 版本自己 `pnpm dlx` 拉）；凭据走 WSL 的 `~/.dsh/.credentials.yaml` seam —— **不要复制任何 key**。

```powershell
# 跨宿主重连（本插件的分水岭能力）：第二条命令由**另一个宿主进程**发出，上下文仍在
dsh --profile <profile> '调 wsl_agent，key=rc1，task="记住数字 77，只回 ACK"'
dsh --profile <profile> '调 wsl_agent，key=rc1，task="刚才让你记的数字？只回数字"'
#   ⇒ 77 · 同一 sessionId / runtimePid · turns=2
```

## 七个工具（对应 VS Code 侧的概念）

| 工具 | 对应概念 | 做什么 |
|---|---|---|
| `wsl_status` | 连接状态 | 发行版列表 / 桌面 dsh 版本 / WSL pin / 漂移 / **守护 pid·端口·version·keys** / 版本报警 |
| `wsl_exec` | 远端终端 | 在 WSL 里跑 bash（cwd 是 Linux 路径），回 exit+stdout+stderr |
| `wsl_agent` | 远端 agent | 把任务交给 WSL 里的 dsh（`--profile sdk`，stdio JSON-RPC）；运行时由**WSL 侧常驻守护**持有 ⇒ **关客户端 ≠ 会话结束**，跨宿主进程续同一 `key` 仍保上下文 |
| `wsl_daemon` | 远端会话生命周期 | `status` / `start`（幂等）/ `stop`（显式结束会话）/ `restart`（对齐新版本） |
| `wsl_open_ui` | 远端 UI 窗口 | WSL 里跑 `dsh web`，Windows 开应用窗口（浏览器 client 能连远端 origin，桌面壳不能） |
| `wsl_sync_version` | server 供给 | 读桌面版本 → 比对 WSL pin → 可选预热该版本 → 修复 pin |
| `wsl_path` | 路径映射 | 包一层发行版自带的 `wslpath`：`D:\project\net1` ⇄ `/mnt/d/project/net1`（`direction` 默认 `both`）。只读、无副作用、不要求路径存在；路径**走 argv 位置参数**（不拼 shell 串），含空格/引号/`$(…)` 也当字面量。与 `dsh-wsl-tool` 的 `wsl-path` 是**同类能力**（那边用连字符），本插件沿用自己既有的 `snake_case` 命名 |

> `wsl_path` 只做字符串转换：它**不会**创建目录、**不会**改文件，`wslpath` 对不存在的路径同样给出映射（已实测）。
> 同形态输入（拿 Windows 路径问 `to-windows`）不是恒等变换 —— `wslpath` 会把反斜杠当转义 ⇒ 这种**无意义的方向不回显值**，只说明原因。

## 兼容性声明（`dsh.compatibility.dshReleases`）

`package.json` 里声明了 `dsh.compatibility.dshReleases = { "0.2.0-rc.2": "compatible" }`：

- **含义**：我们**在这个 DSH 版本上跑过并通过了验收**。仅此而已。
- **只写实测过的版本**：目前**只有 `0.2.0-rc.2`**（P0/P1 全部验收的基线）。没实测过的版本**一律不写** —— 宁可缺项，也不把"没测过"写成 `compatible`。
- ⚠️ **该字段是声明性的，宿主不校验**：本构建（`0.2.0-rc.2`）的 `resources/**` 与 `--dump-config-schema` 里 **`dshReleases`/`dsh.compatibility` 均 0 命中** ⇒ 写它**不会**让宿主做任何检查，也不会改变加载行为（与生态先例 `dsh-wsl-workspace` 的形状对齐）。它的价值在**人/工具读清单时**，不在运行时。
- 版本约束仍然以 `engines.dsh`（`>=0.2.0-rc.2`）为准；**更高版本未验证、不承诺**。

## 常驻守护（默认后端）：关客户端 ≠ 会话结束

**这是本插件与"每个宿主进程自己 spawn 一个运行时"的分水岭。** 上游事实（spike + 独立验证双重复现）：
`sessionId` 由客户端指定，服务端用它判重并且**落盘占用** —— 另一个进程（哪怕原持有者已正常退出、
运行时已消失）再用同一 id 一定收到 `JSON-RPC -32603: session "…" already exists`。
所以**上下文只可能活在"那个还活着的运行时进程"里**；`-32603` 这条路彻底堵死了"重启运行时再拿旧 id 接回来"。

于是运行时改由 **WSL 侧常驻守护**持有，Windows 侧退化成"连上去发一条 prompt 的瘦客户端"：

```
Windows 宿主（可来可走，退出不影响会话）
  └─ lib(daemon-client) ── TCP 127.0.0.1:<port>, NDJSON, 先 hello+token ──▶ WSL 守护（daemon.ts）
                                                                              ├─ key=k1 → SdkRuntime(session A)
                                                                              └─ key=k2 → SdkRuntime(session B)
```

**会话只在三种情况结束**（工具描述与本节都说清楚，不让用户以为是永久）：

1. 显式停止：`wsl_daemon action=stop`；
2. **空闲超时**：`daemonIdleMs`（默认 **1800000 = 30 分钟**）到期，守护回收运行时 ⇒ **上下文丢失**；
3. 守护或运行时死亡（崩溃 / `kill` / `wsl --shutdown`）⇒ 下一次调用自动恢复，但**明确告知上下文已重置**。

### 协议（NDJSON，一行一条；连接建立后第一条必须是 `hello`）

| 方向 | 帧 |
|---|---|
| → | `{"op":"hello","token":"<64位十六进制>","client":"win-pid-1234"}` |
| ← | `{"ok":true,"op":"hello","daemonPid":N,"version":"0.2.0-rc.2","port":8731,…}` |
| → | `{"op":"prompt","id":1,"key":"k1","text":"…"}` / `{"op":"status","id":2}` / `{"op":"shutdown","id":3}` |
| ← | `{"ok":true,"answer":"…","sessionId":"…","turns":2,"runtimePid":N,"completedBy":"turn/end"}` / `{"ok":false,"error":"…","retryable":true}` |

token 不符 ⇒ `{"ok":false,"error":"unauthorized"}` 并断开（本机任意进程都不能偷 prompt/shutdown）。

### 三条硬要求（来自独立验证 task-2 的真缺陷）

1. **就绪判据由 Windows 侧确认（缺陷 #11）**。WSL 与 Windows 是**不同的网络命名空间**：Windows 侧先占了
   端口时，WSL 守护照样 `bind` 成功、日志照打 `listening`、进程不退，而 Windows 客户端连到的是**别的属主**
   （实测挂死 6s；默认 300s 就是 5 分钟假死）。所以 ready = 客户端 `hello`+token 拿到**符合本守护身份**的应答；
   握手默认 **3s** 超时。身份不符/超时 ⇒ 清掉那个"影子守护"（WSL 侧 bind 成功但 Windows 侧不可达）并**换端口**
   （`daemonPort` +1，最多 `daemonPortTries` 次）；全占则给**可读报错**并让用户释放端口。
2. **不落 `/tmp`（缺陷 #12）**。守护的元数据 / token / 启动脚本 / 日志全部在
   `~/.dsh/remote-wsl/`（目录 0700、文件 0600），且**按槽位分文件**：`daemon.<slot>.json`
   （pid/port/version/keys，**不含 token**）、`daemon.<slot>.token`、`launch.<slot>.sh`（守护起来后自删）、
   `daemon.log`（有界，256KB 截断）。**不是**单个 `daemon.json` / `launch.sh` —— 那样两个守护并存会**互相覆盖**
   （见下面「并发隔离与过渡期兼容」；`wsl_status` 现在直接打印 `daemon state dir (WSL): …` 一行说明这一点）。
   守护**绝不创建** `/tmp/dsh-rwsl-*`；退出时清理**自己槽位**的 `daemon.<slot>.json` / `.token` / `launch.<slot>.sh`（只留 `daemon.log`）。
3. **不自动杀守护（语义 #5）**。`status` 带守护持有的 dsh `version`；与桌面版本或 WSL pin 不一致 ⇒
   `wsl_status` 出**报警行**（`daemon drift: ⚠️ …`）但**不自动重启**（那会无声中断用户正在进行的会话），
   换版本走显式 `wsl_daemon action=restart`。

### 其它语义（Lead 定，已实现）

- **同一 key 并发**：守护内 **FIFO 串行**，等待位上限 `daemonQueueLimit`（默认 4），超出**明确拒绝**
  （`queueFull:true` + 可读错误）——上游无 cancel，静默排队会变成长尾延迟。
- **没有正文时不换运行时（原 spike §7.10 的兜底对齐）**：守护形态**禁止**沿用"停稳运行时 + 读 zstd 日志换新
  sessionId"的老兜底（那会毁上下文）；改为 `ok:false` + `retryable:true`，运行时保持不动。
  （老兜底只保留在 `backend:'in-host'` 的逃生舱里。）
- **环境注入只做一次**：`shellPreamble`（PATH + 代理探测）与 `useShellEnvironment`（登录 shell 环境）在
  **守护启动时各做一次**，之后每个运行时复用同一份 env —— 不再每 key 付一次登录 shell 启动成本。
- **per-call `cwd` 真的生效（P1）**：`wsl_agent({cwd})` 通过协议传给守护，守护按 **(key, cwd)** 分运行时条目
  —— 不同 cwd ⇒ 各自独立运行时与 `sessionId`；**同 key 同 cwd 仍复用同一个**（跨宿主重连不受影响）。
  每次返回都带 `cwd=<生效值>`；万一与请求不一致会以 `⚠️ 请求的 cwd=… 未生效` 开头明确告知（绝不静默）。
  远端 `/proc/<runtimePid>/cwd` 可独立复核（实测 `requested=/tmp → /proc/<pid>/cwd=/tmp`、默认 `→ /home/g`）。
- **客户端健壮性**：`ECONNREFUSED` ⇒ 自动起守护 + **重试一次**；若因此换了 sessionId，返回文本**以
  `⚠️ 远端会话已重置…` 开头**，并在元数据里带 `contextReset=yes`（绝不静默）。
- **单实例幂等**：已有守护就复用（读元数据 + 握手判活），任何一次调用都不会起第二个守护。

### 并发隔离与过渡期兼容（元数据按槽位分文件）

- 元数据/token 是 **`daemon.<槽位>.json` / `daemon.<槽位>.token`**（0600），槽位 = 启动时请求的端口
  （`--meta-port`，默认 = `--port`）。**不是单个 `daemon.json`** —— 那样两个守护并存时会**互相覆盖**。  实测：槽位 8731 与 8771 两个守护并存，`daemon.8731.json`（pid 148688 / port 8731）与
  `daemon.8771.json`（pid 148759 / port 8771）各读各的，两次 `status` 分别命中自己的守护。
- **启动脚本也按槽位**：`launch.<槽位>.sh`（0600，守护起来后自删）。曾经的全局单文件 `launch.sh`
  会让两个槽位互相覆盖 —— task-4 复现为"A 要 8759 却握手到 8760、真正的 8759 守护完全没有元数据、
  终态 3 个守护"，根因还有一层：**包装层的 spawn 路径必须与写入路径同一个槽位**
  （写 `launch.8752.sh` 却跑 `launch.8751.sh` ⇒ 回退槽位永远起不来 + 脚本泄漏）。
- WSL 侧端口被占时守护 `+1` 迁移，**文件仍按请求槽位命名**（真实端口写在 `port` 字段）⇒ 迁移不会覆盖
  别的槽位；`--state-dir` 是另一个维度的完全隔离（两个人的测试可以各用一份状态目录）。
- 清理只清**自己那一个槽位**的文件（`cleanupFiles` / `removeMetaFiles` 都按槽位），绝不动别人的。
- 过渡期兼容：旧的单文件 `daemon.json` / `daemon.token` 仍被识别（读得到就认；死了则按 pid **验身份后**
  清理 —— 判据是 `/proc/<pid>/cmdline` 命中 `daemon.ts`，避免 pid 复用误杀）。不认它的话，
  升级后那个旧守护会变成**不可见的孤儿**（继续占端口与运行时）。

### 复用 / 停止的边界（task-9 追加 A–D）

| 行为 | 规则 | 为什么 |
|---|---|---|
| 复用 | **只复用调用方自己槽位（`config.daemonPort`）的守护**；别的槽位只报告、不打扰 | 以前"复用同状态目录里任意活守护"会**静默忽略**调用方配的端口/idle（D） |
| 请求槽位已被自家守护占 | 有元数据的活守护 ⇒ **复用**；无元数据/失联的孤儿 ⇒ **先收掉再在同槽位起** | "3 守护/2 请求""slot≠actualPort""孤儿占端口"的同族根因（A/B） |
| 配置不相容 | `cwd`/`profile` 不同 ⇒ **明确报错**（复用会让会话跑错工作目录）；`idleMs`/`queueLimit`/`lingerMs` 不同 ⇒ 复用但**显式回报**，要应用新值用 `wsl_daemon action=restart` | 不许静默忽略（D）；版本不一致仍只报警（语义 #5） |
| `stop` 不带 slot | **只停自己槽位**；自己槽位没有守护就如实回报，**绝不去停别人的槽位** | 危险脚枪（C）；要停全部/含孤儿必须显式 `all=true` |
| 孤儿发现/回收 | 按 `/proc/<pid>/cmdline` **身份扫描**（命中本插件守护脚本 **且** `--state-dir` 是本插件的），不只看元数据里的单个 pid | 元数据缺失、或**同一 state-dir 下有两份相同 cmdline 的守护**时会漏（B） |
| 请求槽位就绪失败 | 先收掉该槽位上**本插件自己的**守护（含无元数据的），再换下一个候选端口 | 不留孤儿（验收要求 `ss -ltn` 与 `/proc` 扫描前后对照） |

`wsl_daemon` 每条返回都带一行**稳定机器可读行**；四种动作（start / restart / status / stop / stop --all）
**字段完全一致**，缺项统一为 `-`（未运行时 `slot=- pid=- port=- version=-`）。解析用这把尺子：

```
^machine: slot=(\S+) pid=(\S+) port=(\S+) version=(\S+)( .*)?$
```

> 注意：这是 **F3 之后的新格式**（旧格式 `daemon=<pid>@<port>` 已废弃，外部解析需按上式改）。
> 动作特有信息都在第 5 组之后：`keys=` / `orphans=` / `reused=` / `reaped=` / `stopped=` / `killed=`。

### 两条 `wsl.exe` 调用纪律（实测，写代码必须守）

1. **不要用 `wsl.exe … -- bash -c "<script>"`**：那不是 argv-exec，命令串会先经过发行版的**默认登录 shell**
   （本机 zsh）展开一次 ⇒ `$var` 被外层吃掉、glob 先被外层展开。实测：`bash -c 'i=5; echo "i=$i"'` 打出 `i=`；
   `for d in /proc/[0-9]*; do echo "$d"; done` 打出空。**要跑脚本就写文件跑 `bash <file>`，或 base64 管道进 bash**
   （本插件一次性路径用前者，守护/扫描探针用后者）。这也是"`/tmp` 计数假 0"的机制来源：glob 未匹配时
   外层 shell 先报错、`wc -l` 再吞掉退出码 —— 所以计数一律用 `find … -print | wc -l` 而不是裸 glob。
2. **包装层的失败不能吞**：`spawn(..., {stdio:'ignore'})` 会把"包装层根本没起来"变成静默失败。
   现在包装层 stderr 落 `~/.dsh/remote-wsl/launch-stderr.log`，非 0 退出也记一行。

### 源码形态（2026-10-10 约定变更）

源码是 **TypeScript（`src/*.ts`）**，走 Node **原生 type stripping**（零构建）：只用可擦除语法
（type/interface/`as`/泛型/类型注解），**不用 enum / namespace / 构造器参数属性**；相对导入**带显式 `.ts`**
（`./shell-env.ts` …），这样"原生跑 TS"与"tsc 编译"两条路都走得通。
`package.json`：`main`/`exports` → `./src/index.ts`，`files` → `src`，`engines.node` → `>=26.10`。
实测：桌面侧 node 与 WSL 侧 node **26.10.0** 都能直接跑这些 `.ts`
（守护本身就是 WSL 里 `node /mnt/d/…/src/daemon.ts` 起的，导入 `./shell-env.ts`、`./sdk-runtime.ts`）。
**Node 版本口径（如实说明，别把两者混起来）**：`primary-runtime/runtime.json` 里声明的 node 是 **24.21.0**
（那是随包 runtime 的声明值）；而**宿主进程实测跑的是 24.18.1**（独立探针证据：`TS-PLUGIN-LOADED-OK node=v24.18.1`）。
本插件的原生 TS 路径在**两者上都实测可用**，所以 `engines.node` 写的是 Node **26.10**（WSL 侧守护的运行时口径）。
**若某个宿主 loader 不吃 `.ts` 入口**：用 `tsc` 编译到 `dist/` 并把 `main` 改成 `./dist/index.js`（本 README
所记的验收是在"loader 直接吃 `.ts`"的原生路径下完成的）。`lib/` 过渡副本**已删除**（TS 迁移完成；回滚点 `_backup/index.js.bak-auditfix-20261010_141716` 是**本地**回滚点 —— 已 gitignore，**不随仓发布**）。

## 版本 / 兼容性 / 冻结 revision

| 项 | 值 |
|---|---|
| 插件版本 | `0.1.0`（`package.json` 里 `private: true` ⇒ 不发布 npm，走 git / `link:` 安装） |
| `engines.node` | `>=26.10`（**WSL 侧守护**的运行时口径；宿主侧实测 24.18.1 也能加载，见上节） |
| `engines.dsh` | `>=0.2.0-rc.2` —— **验证基线**：本轮全部验收都在 dsh `0.2.0-rc.2` + node 26.10 上完成；更高版本**未验证、不承诺** |
| 许可 | MIT（见 `LICENSE`） |

**冻结 revision —— P0（2026-10-12，**13 个锚点** = `src/**` 8 + `client/**` 4 + `package.json`）**：复验必须以此做**首尾双断言**（开工取哈希 → 收尾复算，不同即判「验证无效」）。独立验证者 `p0-verify` 已于 **15:44 冻结 / 16:05 复算 13/13 一致** ⇒ P0 验收有效（报告：`spike/verify/explorer-20261012/REPORT-explorer.md`）。

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `src/daemon-client.ts` | 36,596 | `366498843ca1c7b68647625dda3d21c66419743182c82e4f67734adfa95fa395` |
| `src/daemon.ts` | 23,299 | `1c5284e56a7affdbe3578148e31dcb98252ad6d286ba8d978efd023905967d96` |
| `src/explorer.ts` | 29,545 | `86f29d83fa055393fa3c086ede4feb8830a8b97c671189fa44f47fbc2ab42ad5` |
| `src/index.ts` | 76,751 | `c87b7bde74280a2a1078cb3c0813f1693a30826516c933bdd472a217b34694ee` |
| `src/sdk-runtime.ts` | 11,433 | `74853c0539fe5fa14507c6e71dcacc2385e0b03c56e062a41fdb4dc1c837c52e` |
| `src/selftest.ts` | 21,772 | `1aaa5d1b938543d8d8d163af57df9e123851639123fba4e8c6ef65a90e845d94` |
| `src/shell-env.ts` | 12,480 | `9a9f6e5592c197f54686e177bf6d85aaa646b9d2b61c02bd4414fd3f37ae54b1` |
| `src/version.ts` | 14,386 | `ae5612fa22d80672a4c1d36acdfd34f1a0c792cbb1472b0525579541f41de275` |
| `client/index.js` | 13,859 | `a0c9656809759c8ba23235376e5f8f3e37f52d6ff86ce5ca5eeccc6e6b9d4a9b` |
| `client/client.api.js` | 10,661 | `4f98663dd203c52eb00a22133dca2985c052868946141932571fea2c67990fc3` |
| `client/client.icon.js` | 2,209 | `e9a824f50e45e5d4840a8604d511dbc2b87cc4bb30a6512aefe505dc11b7d431` |
| `client/client.panel.js` | 29,111 | `8f5ce575f50f182fa94f584a47b8a9401e7f580c5206c5bd2e3483867957439e` |
| `package.json` | 1,452 | `36f70175f9fe4ea2f9b04712fea09687b25778fdae31e2be7f30462e66ac4492` |

> **0.1.0 原冻结集**（历史对照）：当时只有 `src/` 7 个 —— 其中 **6 个与上表逐字相同**（P0 未碰），`index.ts` 当时是 **75,545 / `773d0aac…`**（P0 加注册与注释后变 76,751 / `c87b7bde…`）；`explorer.ts` / `client/**` / `package.json` 当时都不存在。P0 之前那轮（改用注释补 `wsl_daemon`）的重跑证据仍在：夹具回归 `test.ts` exit 0、`adversarial` **PASS 32 / FAIL 0**、守护直控 smoke 全 exit 0。

**冻结 revision —— P0.1（2026-10-12 P1 修复轮，**当前**，13 个锚点）**：与 P0 表比**恰好 4 个变**（`src/explorer.ts`、`src/daemon-client.ts`、`client/client.panel.js`、`client/index.js`），其余 9 个逐字相同。独立验证者 `p0-verify` **16:31 冻结 / 17:0x 复算 13/13 一致** ⇒ 本次验证有效（报告：`spike/verify/explorer-20261012/REPORT-fix-p1.md`）。

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `src/daemon-client.ts` | 37,581 | `184f6b87ef2ebc78b53b57bb13ebcecc28c546ccf1aee029c21daca19280098f` |
| `src/daemon.ts` | 23,299 | `1c5284e56a7affdbe3578148e31dcb98252ad6d286ba8d978efd023905967d96` |
| `src/explorer.ts` | 34,016 | `a2c6b8b9a19a215316625053bdef5eabf76769cb2d2aeea84bb9c1ce209fba8c` |
| `src/index.ts` | 76,751 | `c87b7bde74280a2a1078cb3c0813f1693a30826516c933bdd472a217b34694ee` |
| `src/sdk-runtime.ts` | 11,433 | `74853c0539fe5fa14507c6e71dcacc2385e0b03c56e062a41fdb4dc1c837c52e` |
| `src/selftest.ts` | 21,772 | `1aaa5d1b938543d8d8d163af57df9e123851639123fba4e8c6ef65a90e845d94` |
| `src/shell-env.ts` | 12,480 | `9a9f6e5592c197f54686e177bf6d85aaa646b9d2b61c02bd4414fd3f37ae54b1` |
| `src/version.ts` | 14,386 | `ae5612fa22d80672a4c1d36acdfd34f1a0c792cbb1472b0525579541f41de275` |
| `client/client.api.js` | 10,661 | `4f98663dd203c52eb00a22133dca2985c052868946141932571fea2c67990fc3` |
| `client/client.icon.js` | 2,209 | `e9a824f50e45e5d4840a8604d511dbc2b87cc4bb30a6512aefe505dc11b7d431` |
| `client/client.panel.js` | 34,915 | `bb0a24babcf581d40cc00921b468b072e4abfa0e903f3d3c076c7ff7a3e52abf` |
| `client/index.js` | 14,841 | `62ab2f0c799d33541a645e607d5fcf9e8d6bd3036bdb44f371c82f6212501264` |
| `package.json` | 1,452 | `36f70175f9fe4ea2f9b04712fea09687b25778fdae31e2be7f30462e66ac4492` |

**这一轮修掉并独立复验通过的 9 条**（P0 验收里记为 P1 的 + 可用性/稳定性新报的）：**F32** 路由残留（inject 二次触发后 `dispose` 计数 **0**，改前为 1）｜**F33** 跨槽位串台（**显示层 + 动作面 + 渲染层三层**：snapshot 只报配置槽位、别槽进只读 `others[]`、非配置槽位动作 **400/E_ARG 且无副作用**）｜**F15** `webServer` 永不就绪时的降级日志｜**F14b** 500 → **503** 统一｜**F31** `launch-stderr.log` **0600**（根因：UNC/9p 上 `chmod` **静默失败** ⇒ 改由 WSL 侧 launcher `chmod 600`）｜**F34** 首挂载不再误报"读取失败后已撤下"｜**F25** 动作失败按 `ok===false` 渲染失败 + 重试｜**F35** 路径不再按 RTL 渲染（`direction:ltr` + `unicode-bidi:plaintext`）｜**F36** 主行动的可见反馈不再被它自己触发的刷新清空。**故意红 3 条全部按预期变红**；A 组回归 ①②③⑤ 全 PASS（③ 正常场景 strong=11 逐项 MATCH）。

**仍余（不装成已解决）**：① **两条文案瑕**（结果条透传 host `note` 里的实现者词汇如 `上游 daemon`/`本方法`；加载期戳记把"尚未取得快照"渲染两次）；② **`wsl_status` 字段改名 `discoveredDaemon`** 属 **P2**（要动 6 个工具 + `selftest`，"同源 + 明确选择器"的定义本轮已写进设计稿 §8.6 与本文）；③ **P2 性能**：12,000 行树 → 72,445 节点、树首帧 237–310ms（虚拟滚动未做；本轮未使其变差）；④ **未复核项**：`keys>0` 形态、`webHosts` 非空、desktop(Electron) 宿主、`fixPin` 真实失败渲染（桩级已验）、F14b 的自然故障路径（用端口占用逼出）、`client.<name>.js` 的 served URL 形态、`order/id` 的 served 验证、像素截图未落盘。⑤ **回退深度与名义 `daemonPortTries=3` 不一致**（Windows 侧试 3 个、WSL 侧扫到 +10 才 FATAL）—— 实测现象，属实现行为，记为未复核。

## 安装（link 进 profile）

```powershell
# 1) 在目标 profile 的 package.json 里加依赖 + bundle
#    "dependencies": { "dsh-remote-wsl": "link:D:/project/dsh1/vendor/dsh-remote-wsl" }
#    "dsh": { "profile": { "bundles": [ ..., "dsh-remote-wsl" ] } }
# 2) 建软链接（pnpm 对 link: 依赖不会装依赖，DSH 从宿主树解析其余包）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-remote-wsl" `
         -Target 'D:\project\dsh1\vendor\dsh-remote-wsl'
# 3) 校验
dsh --profile <profile> --dump-config | Select-String 'remote-wsl'
```

配置键（都在 bundle 的 `cordis.patch.yml` 里给默认值，可在 profile 的 `cordis.patch.yml` 覆盖）：
`distro` `wslHome` `cwd` `provider` `model` `profile` `dshVersion`（空=跟随桌面）`webPort`
`idleTimeoutMs` `timeoutMs` `desktopRuntimeJson` `proxyPort`，以及守护形态的这些：

| 键 | 默认 | 作用 |
|---|---|---|
| `backend` | `'daemon'` | `'daemon'`=运行时由 WSL 常驻守护持有（默认）；`'in-host'`=旧形态逃生舱（本宿主进程持有，关客户端即丢会话，保留日志兜底） |
| `daemonPort` | `8731` | 守护监听端口（WSL 侧被占则 +1；Windows 侧被占则由客户端换端口） |
| `daemonPortTries` | `3` | Windows 命名空间被占时的端口回退次数（全占 ⇒ 可读报错，不等 300s） |
| `daemonIdleMs` | `1800000` | 空闲回收。**到期即回收运行时 ⇒ 上下文丢失** |
| `daemonLingerMs` | `600000` | **寿命闸门**：无 key 且无客户端持续这么久 ⇒ 守护自退（0=关）。有会话时绝不触发 |
| `daemonQueueLimit` | `4` | 同 key 并发 prompt 的**等待位上限**，超出明确拒绝 |
| `daemonHandshakeTimeoutMs` | `3000` | Windows 侧握手判据超时（身份不符必须快速失败，绝不等 `timeoutMs`） |
| `daemonStartTimeoutMs` | `20000` | 起守护后等"Windows 侧握手确认就绪"的上限 |

## 亲眼看到面板（P0，测试实例）

> ⚠️ **先记这一条，它坑过我们全队**：应用 CLI 的用法是 `dsh [--profile] <name> [options] [app-args...]` ——
> **`dsh web` 里的 `web` 就是 profile 名**。所以 `dsh --profile X web --port N` 会被判"多余位置参数"：
> `error: too many arguments. Expected 0 arguments but got 1: web.`
> **起自定义 profile 的正确写法不带 `web` token。**

```powershell
$dsh = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

# 1) 起测试实例（不带 web；--patch 可叠加自己的覆盖层，例如换 daemonPort）
& $dsh --profile remote-wsl-test --port 3096 --no-open

# 2) 实例日志里会打印带 token 的 URL —— 必须用它打开，裸 http://127.0.0.1:3096/ 只会得到 401
#    GET /            ⇒ 401
#    GET /?token=…    ⇒ 303 + Set-Cookie ⇒ 200（含 __DSH_BOOT__）
```

打开后：**左侧栏 rail 会多出一个「远程资源管理器」图标**（与「插件」「定时」并排），点它切到中央面板 ——
distro 选择器 + 收藏路径树 + 底部守护状态条（pid/端口/version/keys/drift），行内动作「在新会话中打开」等。
面板数据面是 `POST /remote-wsl/api`（方法表：`explorer.snapshot|openSession|daemon|fixPin`；同源 + 硬白名单）。

> `wsl_open_ui` 开的是**另一件事**：WSL 里那份 dsh 的 Web UI（浏览器应用窗口）；本节的实例是**宿主自己的 Web 前端**，面板属于宿主 UI。

## 与现有 DSH WSL 插件的关系（2026-10-12 先例调研）

同域在 npm 上**已有一批真插件在跑**（`dsh-wsl-workspace`、`dsh-plugin-wsl-env`、`dsh-wsl-workspace-picker`、`dsh-wsl-tool`、`dsh-wsl-projects`、`dsh-wsl-desktop`、`dsh-wsl-tray`/`dsh-web-tray`/`dsh-wsl-launcher`、`dsh-wsl-expose`、`dsh-network-settings`…）。完整清单、官方约定（`directoryFlow` 槽、`ctx.workspaces.*`、`dsh.client.inject`、`dsh.compatibility.dshReleases`）与我们的采纳/分歧清单见 **[docs/prior-art-dsh-wsl.md](docs/prior-art-dsh-wsl.md)**。三条与使用者直接相关：

1. **⚠️ 沙箱边界（务必先读）**：`wsl_exec` / `wsl_agent` 跑在 **WSL 侧**，因此**位于 DSH 的沙箱层与文件策略之下** —— 宿主的文件策略**约束不到**这两条路径里的命令（同类插件 `dsh-wsl-tool` 也明写这一点）。要隔离请用 WSL 侧手段（对照 `dsh-plugin-wsl-env` 的 **bubblewrap、fail-closed、绝不 unconfined** 立场）。本插件**不内置沙箱**：它的语义就是"在**你自己**的 WSL 里跑一条命令"。
2. **与 `dsh-wsl-tool` 并存时的分工**：那套工具叫 `wsl` / `wsl-path` / `wsl-env` / `wsl-doctor` / `wsl-bootstrap` / `wsl-term`（**连字符**，一次性命令 + 体检为主）；我们是 `wsl_status` / `wsl_exec` / `wsl_agent` / `wsl_daemon` / `wsl_open_ui` / `wsl_sync_version` / `wsl_path`（**snake_case**，**常驻守护 + 跨宿主会话**为主）。两套可同时安装、名字不冲突，但**模型可能选错** —— 一句话分工：**要"关客户端 ≠ 会话结束"的持久会话，用我们；要发行版体检/按配方补装/侧栏终端，用它们。**（路径转换两边都有：我们的 `wsl_path` 对位它的 `wsl-path`。）
3. **路线差异（不是对错）**：`dsh-wsl-workspace` / `dsh-plugin-wsl-env` 把 WSL 当**工作区/会话执行环境**（文件工具、终端、目录选择器都在发行版内）—— 好处是路径语义天然正确、没有 `/mnt` 的性能与语义坑；我们把 WSL 当**远端运行时宿主**（守护持有 runtime），换来的是会话持久性、跨宿主重连与显式生命周期。两者**互补而非互斥**；想要"发行版内文件工具"，请用它们（或等我们的 A1：走官方工作区路线）。

## 设计要点（都是踩出来的，不是猜的）

1. **零运行时 `@deepseek-ai/*` 依赖**：`link:` 装的插件拿不到依赖，裸包名会 `failed to import`
   （本插件第一版就这么挂的）。所有服务经 `ctx.get` / `ctx.inject(['tools'], …)` 读取，内部只用 Node 内置模块。
   （同 `dsh-shadow` 的约定：其 dist 里一个裸 `@deepseek-ai/*` 都没有。）
2. **脚本写成 WSL 侧文件再执行**：`pwsh → wsl.exe → bash` 三层会吃引号；base64 内联又会占 stdin
   （SDK 协议要读 stdin）。写文件两者都躲开。**守护形态把启动脚本写进 `~/.dsh/remote-wsl/launch.sh`（0600，
   守护起来后自删）；`/tmp/dsh-rwsl-*` 只属于一次性/逃生舱路径**（见"三条硬要求"第 2 条）。
   （另：`Start-Process` **不会**给参数加引号 —— 内联 `bash -c "… | … | …"` 会被拆成多个参数而**静默不起**
   守护；所以走"落地脚本 + `bash <file>`"。）
3. **代理先探测再使用**：主机代理会停/重启，硬 export 会让模型调用全 `TRANSPORT` 失败。
4. **尾帧可能没有换行结尾**：静止窗口触发时先 flush 残余缓冲，否则 `turn/end` 永不到达、调用挂死。
5. **完成判定三级兜底**：`turn/end` → `session.status:idle` → 静止窗口；正文若仍缺，守护形态**如实回报
   `ok:false, retryable:true` 并保持运行时不动**（语义见上）；只有 `backend:'in-host'` 的逃生舱才沿用
   "停稳运行时 + 由 WSL 侧 node 读多帧 zstd 日志"的老兜底。
6. **PID 回收**：`child.kill()` 只杀 `wsl.exe` 包装层，Linux 侧会变孤儿（实测有人跑了 1 小时）。
   启动脚本落 `.pid`，回收时 `pkill -P` + `kill` 一起上。

## 已知边界（上游事实，插件不假装有）

- SDK **无 cancel / 无 session-close**：放弃一轮 = 关掉运行时（守护形态下 = 该 key 的运行时被回收 ⇒ 上下文丢失，
  所以同 key 并发是 FIFO 串行 + 上限拒绝，而不是"静默排队"）；
- **无 per-prompt 结果**，完成判定必须客户端自定（见上）；
- **跨进程复用同一 sessionId 被拒**（`-32603 session already exists`），而且**落盘占用**：原持有者已正常退出、
  运行时已消失，另一个进程再拿同一 id 仍被拒（spike + 独立验证双重复现）⇒ 一个运行时一个 id，
  多轮只在同一常驻运行时内成立。**这正是"运行时必须由守护持有"的全部理由**；
- 桌面壳依旧**不能**连远端 host——`wsl_open_ui` 是补位，不是等价替换；
- `wsl_agent` 用 WSL 的 `~/.dsh` 与 `~/.agents` 那一份（与 Windows 侧是**两份独立副本**，政策如此）。

## 验证（2026-10-10）

| 项 | 结果 |
|---|---|
| 单元/集成（桩 ctx，直调当时注册的全部工具） | 全过；`wsl_agent` 两轮 → `7` / `turn/end` / turns=2 |
| 真实 DSH agent（临时 profile，headless） | 13.5s 内成功调用 `wsl_status`+`wsl_exec`；17.7s 内成功调用 `wsl_open_ui`+`wsl_sync_version` |
| `warm` 修正后 | `warm 0.2.0-rc.2: ok` |
| 回收 | 调用后 WSL 侧无 3082 监听、无 `profile sdk` 进程、`/tmp` 无 `dsh-rwsl-*` 残留 |

## 验证（task-3：守护形态，2026-10-10，全部原始输出）

环境：Windows 桌面侧 node（随包 runtime.json 声明 **24.21.0**，宿主进程实测 **24.18.1**）/ WSL node **26.10.0** / dsh `0.2.0-rc.2`。
真实宿主 = `dsh --profile remote-wsl-test`（headless，`link:` 装的本插件，loader **直接吃 `src/index.ts`**）；
确定性脚手架 = `src/selftest.ts`。下表各行来自同一天的连续几次运行，pid/端口随运行而变
（`rc1` 是跨宿主重连 + 后续 kill/恢复用的会话，`rc2` 是最终冻结版上的复测会话）。

| 验收项 | 原始输出要点 |
|---|---|
| 真实宿主加载 `.ts` 入口 | 宿主退出时打印 `remote-wsl: 宿主退出；WSL 侧守护保持运行（关客户端 ≠ 会话结束）`（该行只存在于新代码 ⇒ 插件确实是从 `src/index.ts` 装载的） |
| **跨宿主重连** | 宿主 A：`session=remote-wsl-rc2-636204c7-e9a3-4c80-91ad-3bb7809d9fd6 completedBy=turn/end turns=1 runtimePid=149743 daemon=149686@127.0.0.1:8731`；**另一个宿主进程 B**：`77`（模型原样粘贴工具返回）`session` 与 `runtimePid` **完全相同**、`turns=2` |
| 幂等（只有一份守护） | A / B 两次调用的元数据行里 `daemon=149686@127.0.0.1:8731` 一致；`wsl_daemon action=status` 只列 1 个守护 |
| **并发隔离（元数据按槽位）** | 槽位 8731 与 8771 两个守护**并存**：`status --port 8731` → `daemonPid=148688 port=8731`；`status --port 8771` → `daemonPid=148759 port=8771`；状态目录里 `daemon.8731.json/.token` 与 `daemon.8771.json/.token` 各自独立，`stop --port 8731` 只清自己那一个槽位 |
| **`/tmp` 不增长（缺陷 #12）** | 我的基线 `tmp_dsh_baseline=0` → 起两个守护并跑完 → `tmp_dsh_during=0` → 全部停止后 `tmp_dsh_after=0`；`tmp_files_referencing_my_daemons=0`；状态目录运行期只有 `daemon.<槽位>.json/.token` + `daemon.log`（`launch.sh` 起来后自删），停止后只剩 `daemon.log` |
| 可见性 | `wsl_status`：`daemon: running pid=140442 port=8731 version=0.2.0-rc.2 uptime=75s keys=1 [rc1(turn 2,pid140497)]` |
| 漂移报警 | 伪造 `pin=9.9.9` ⇒ `daemon drift: ⚠️ 守护持有的 dsh@0.2.0-rc.2 与 wsl pin 9.9.9 不一致 —— 不自动重启（避免无声中断正在进行的会话）…`；pin 已随即还原为 `0.2.0-rc.2` |
| **kill 守护后恢复 + 明确重置告知** | `kill -9 140442` 后一次 `wsl_agent`：`daemon reuse failed on 8731: 连接被拒（守护已死，元数据是陈的）` + `⚠️ 远端会话已重置…（新 sessionId=remote-wsl-rc1-30280602-…）` + `contextReset=yes`；新守护 `143062`、`turns=1` |
| 并发（同 key 6 个，默认 queueLimit=4） | 5 个 `ok=true`，`at=3325/4630/6499/10940/12403ms` **单调递增**、`turns=1..5` 同一 session；第 6 个 **9ms** 内 `ok=false queueFull=true error=queue full for key "…" (limit 4 waiting): 上游 SDK 无 cancel…`。⚠️ **身份是 `(key, cwd)` ⇒ `queueLimit` 是"每 `(key,cwd)` 的上限"**：同一 key 在不同 cwd 下各有独立队列、独立运行时与会话。 |
| **端口静默冲突（缺陷 #11）** | Windows 先占 8751 ⇒ 首次握手 `timeout（3009ms）` 判死 → 清影子守护 → 换 8752 由 Windows 侧握手确认（**4ms**），总 **5021ms**；占满 8761/8762/8763 ⇒ **11062ms** 后给可读报错（`试过端口 8761, 8762, 8763 …请释放其中一个端口`），**不是 5 分钟** |
| `/tmp` 生命周期（缺陷 #12） | 守护运行中：`state_dir_files=daemon.json daemon.log daemon.token`、`tmp_files_referencing_daemon_pid=0`；停止后 `state_dir_after=daemon.log`、`listen_8771=0` |
| 空闲回收（语义 #2） | `--idle-ms 15000` + 等 21s ⇒ `"keys": []`（运行时被回收 ⇒ 上下文丢失；已在工具描述与配置表写明） |
| 显式停止（语义 #1/#4） | `wsl_daemon action=stop` ⇒ `{"ok":true,"port":8731,"reaped":[{"key":"rc1",…,"turns":1,"idleForMs":23222}],"transport":"shutdown"}` |
| 收尾（我方足迹） | `stop --all` 回收 `rc2`（`reaped:[{key:"rc2",turns:2,runtimePid:149743}]`）后：`daemon.ts` 进程 **0**（`pgrep -af 'daemon\.t[s]'` 只剩**别的 teammate** 的 `spike/daemon.ts --port 8741`）、孤儿（ppid=1）`--profile sdk` **0**、`/tmp/dsh-rwsl-*` **0**、8731/8732/8751/8752/8753/8761/8762/8763/8771 全部无监听、状态目录只剩 `daemon.log` |

复现：

```powershell
node src/selftest.ts status | ensure --port 8731 | ensure --port 8771 --isolated | prompt <key> <文本>
node src/selftest.ts queue 6 | collision 8751 1 | collision 8761 3 | stop --port 8731 | stop --all
dsh --profile remote-wsl-test '请调用 wsl_agent 工具（参数 key="rc2"，task="记住数字 77，只回 ACK"），把返回原文贴出来'
dsh --profile remote-wsl-test '请调用 wsl_agent 工具（参数 key="rc2"，task="刚才让你记的数字是多少？只回数字"），把返回原文贴出来'
```

**未跑**：验证者的 `%TEMP%\rwsl-test\{test,adversarial}.ts` 回归夹具 —— 它们正在被并发迁移/运行
（同一时刻在同一份 WSL 状态上跑会互相干扰），且按约定"`src/*.ts` 复制进 `rwsl-test\lib\` 并把 import 指向
`index.ts`"由验证者执行。本插件的回归证据是上面的**真实宿主 e2e**（两个独立宿主进程 + 6 个工具调用）。

## 验证（task-9：槽位竞态 / 孤儿 / 寿命闸门 / 漂移 / 端口显示，2026-10-10）

| 验收项 | 原始输出要点 |
|---|---|
| **槽位竞态（A）** | `race 8759 8760`：两个独立进程同时起两槽位 ⇒ `metadata slots=[8759,8760]`、`daemon processes=[{pid:310603,port:8759,metaPort:8759},{pid:310614,port:8760,metaPort:8760}]`、两槽 `windowsHandshake=ok(3ms/8ms)`、**恰好 2 个守护**（2 请求 = 2 守护；修复前是 3 个） |
| **请求槽位孤儿（A/B）** | `reclaim 8795`：BEFORE 孤儿 `pid=313809` 占着 8795（元数据已删）⇒ AFTER `ok slot=8795 port=8795 pid=314218`，note 明确写"上发现**无元数据/失联**的本插件守护 pid=313809 ⇒ 先收掉再起"，判据 `port===slot OK / 孤儿已收掉 OK / 该槽位恰好 1 个守护 OK` |
| **#11 冲突不留孤儿** | Windows 先占 8751 ⇒ `timeout（3016ms）` 判死 → 收掉该槽位影子守护 → 8752 由 Windows 侧握手确认（6ms），总 6690ms；AFTER `/proc` 扫描 `=[{pid:309352,port:8752}]`、`占位端口=0 回退端口=1` |
| **漂移（显式 dshVersion，③）** | `dshVersion='0.1.0-fake'` ⇒ `daemon drift: ⚠️ 守护持有的 dsh@0.2.0-rc.2 与 显式 config.dshVersion 0.1.0-fake 不一致…`（alarm=true）；`'0.2.0-rc.2'` ⇒ 无报警行（alarm=false） |
| **实际端口显示（④）** | `daemon: pid=315546 actualPort=8731 slot=8731 version=0.2.0-rc.2` + `daemon ports: configured=8792(+3 回退) actual=8792 slot=8792` |
| **文本更正（⑤）/ 机器行（⑥）** | `state (WSL): …/daemon.<slot>.json（0600）、daemon.<slot>.token（0600），slot=8731`；`machine: daemon=315546@8731 version=0.2.0-rc.2 keys=2 orphans=0`；stop 机器行 `machine: daemon=all version=- reaped=2 orphans_killed=0 orphans_left=0` |
| **`stop` 不越界（C）** | 自己槽位 8731 没有守护 ⇒ `{"ok":true,"alreadyStopped":true,"slot":8731,"note":"自己槽位 8731 没有守护（未去停别的槽位）"}`，而 8801/8802 两个守护仍活；`stop --port 8801` 只停 8801（8802 存活） |
| **配置不相容（D）** | soft：`注意：守护参数与本次配置不同（idleMs 300000≠1800000）—— 已复用，未静默忽略；要应用新值请 wsl_daemon action=restart`；hard：`远端守护（槽位 8803 / 端口 8803）与本次配置**结构性不兼容**：cwd /home/g≠/tmp…` |
| **寿命闸门（②）** | `linger 8000 --idle-ms 600000` ⇒ `起守护 pid=282345 lingerMs=8000` → `守护已自退，耗时 8681ms` → `残留进程=[] 残留元数据=[]` |
| **孤儿可见 + `stop --all`（②）** | 删元数据后 `status.orphans=[{pid:311741,port:8795}]`；`stop --all` ⇒ `{"ok":true,"stopped":[],"killed":[{"pid":311741,"port":8795}],"remaining":[]}`；再查 `orphans=[]`、`ss -ltn` 该端口 0 |
| **回归** | `test.ts` exit 0（T3 两轮 `7`/`turns=2`、T5 `wsl_open_ui` 起停）；`adversarial.ts` **PASS 30 / FAIL 0**；真实宿主 `rc4`：宿主 A `ACK` → **另一个宿主进程** `123`，`session`/`runtimePid` 完全相同、`turns=2` |
| 收尾（我方足迹） | `daemon_procs=0`、`launch.*.sh=0`、`/tmp/dsh-rwsl-*=0`、8731/8751-8753/8759/8760/8791/8792/8795 全无监听、state dir 只剩 `daemon.log` + `launch-stderr.log` |

## 验证（task-12：F1 误报孤儿 / F3 机器行 / F4 内联 bash，2026-10-10）

| 项 | 原始输出 |
|---|---|
| **F1 改前（缺陷）** | A=8862 健康、B=8863 健康；对 B 不带 slot `stop` ⇒ `machine: daemon=8863@8863 version=- reaped=0 orphans_left=1` + `Orphans: ⚠️ 仍有 1 个守护在跑但无元数据（pid352735@8862）—— 用 action=stop all=true`。**误报**，照建议执行会杀掉另一个 DSH 宿主的守护 |
| **F1 改后（修复）** | 同场景 ⇒ `machine: slot=8863 pid=360191 port=8863 version=0.2.0-rc.2 reaped=0 orphans_left=0`，**无 Orphans 行**；同一时刻 A 的 `status` 给出 `machine: slot=8862 pid=360114 port=8862 version=0.2.0-rc.2 keys=0 orphans=0` ⇒ `stop`/`status` 口径一致（都走 `daemonSnapshot`） |
| **F1 真孤儿仍可发现** | 8866 健康 + 8865 **真孤儿**（元数据已删）⇒ `status`：`orphans=1` + `Orphans: 1 个守护在跑但无元数据（pid365531@8865）`；`stop`(8866) ⇒ `orphans_left=1`；`stop all=true` ⇒ `killedOrphans=1（pid365531@8865）remainingOrphans=0` |
| **F3 五条机器行同字段** | status(有)：`slot=8862 pid=360114 port=8862 version=0.2.0-rc.2 keys=0 orphans=0`；start：`slot=8862 pid=361904 port=8862 version=0.2.0-rc.2 reused=false`；stop：`slot=8862 pid=361904 port=8862 version=0.2.0-rc.2 reaped=0 orphans_left=0`；stop --all：`slot=all pid=- port=- version=- stopped=0 killed=0 orphans_left=0 reaped=0`；status(无)：`slot=- pid=- port=- version=- orphans=0` |
| **F4 整改 + 计数仍正确** | `/tmp/dsh-rwsl-*.pid` 计数改走 `runWsl`（落文件 + `bash <file>`）+ `find … -print \| wc -l`；`wsl_status` 输出 `pid files in WSL /tmp: 2`（非"假 0"） |
| 回归 | `test.ts` exit 0；`adversarial.ts` **PASS 32 / FAIL 0**（含 Z4/Z5 自作用域 `/tmp` 归零）；真实宿主（`--patch daemonPort=8801`，专属段）：宿主 A `ACK` → **另一个宿主进程** `555`，同 `session` / `runtimePid=377150`、`turns=2` |

### F4：内联 `bash -c/-lc` 全仓清单（`src/` 已整改；`spike/` 仅报告，按约定不改）

| 位置 | 形态 | 处置 |
|---|---|---|
| `src/index.ts`（原 `/tmp` 计数） | `wsl.exe … bash -lc "ls … \| wc -l"` — **高危**（串先经发行版默认登录 shell 展开） | **已整改**：`runWsl`（落文件 + `bash <file>`）+ `find … -print \| wc -l` |
| `src/daemon-client.ts` (`wslRunScript`) | `wsl.exe … bash -c "echo <b64> \| base64 -d \| bash"` | **保留**：串里只有 base64（无 `$`/glob），外层 shell 无法失真 —— 推荐的探针形态 |
| `src/sdk-runtime.ts` / `src/daemon.ts` | `spawn('/bin/bash', ['-c', script])` —— **在 WSL 内** | **保留**：真正的 argv-exec，不经 `wsl.exe` 边界 |
| `src/shell-env.ts`（生成脚本内）、`src/index.ts` `shellPreamble` | 脚本**文件内**的 `timeout 5 bash -lc 'export -p'`、`timeout 3 bash -c "exec 3<>/dev/tcp/…"` | **保留**：脚本已由 bash 以文件执行，内层是 argv-exec；前者故意要登录 shell |
| `src/index.ts` `listDistros` | `spawnSync('wsl.exe', ['-l','-q'])` | **无 bash**，安全 |
| `spike/run-spike.ps1:79` | `wsl.exe … bash -c $bash` —— **高危形态** | 报告（`spike/` 是证据目录，按约定不改） |
| `spike/verify/*.ps1` | 多数为 `bash -c "echo <b64> \| base64 -d \| bash"`（安全）；`verify-shellenv.ps1` 故意用 `bash -lc` 探测 shell 身份 | 报告（安全 / 故意），不改 |

## 验证（task-15：P1 per-call cwd / P2 活宿主陈旧文件，2026-10-10）

| 项 | 原始输出 |
|---|---|
| **P1 确定性证据** | `cwdcheck p1key /tmp`：`requested=/tmp daemonReportedCwd=/tmp /proc/426647/cwd=/tmp session=remote-wsl-p1key-63f5… turns=1`；`default daemonReportedCwd=/home/g /proc/426708/cwd=/home/g session=remote-wsl-p1key-def-6646… turns=1` ⇒ 两个 cwd 各自独立运行时/会话，`/proc` 独立复核通过 |
| **P1 工具级** | daemon 后端 `wsl_agent({key:p1t, cwd:/tmp, task:运行 pwd})` ⇒ 远端输出 **`/tmp`** + `[remote-wsl: backend=daemon … cwd=/tmp … runtimePid=426941]`；**in-host 对照**同样 `cwd:/tmp` ⇒ **`/tmp`** + `backend=in-host … cwd=/tmp`（行为一致，未回归） |
| **P1 未破坏跨宿主重连** | 宿主 A（key=rc7, cwd=/tmp）`ACK`、`session=remote-wsl-rc7-373bede9… cwd=/tmp turns=1`；**另一个宿主进程** B 同 key 同 cwd ⇒ **`777`**、同 `session`/`runtimePid=427750`、`turns=2` |
| **P2 三步计数 + 反例** | ① 写文件后 `own=2 foreign=1`（own winpid=18940；foreign winpid=47280，**活着**）→ 一次普通变更型调用（`wsl_exec true`）→ ② `own=0 foreign=1`（自己的陈旧文件已收敛、**他人文件未被删**）→ ③ 只清自造对照文件 ⇒ `0/0` |
| 回归 | `test.ts` exit 0（P0 副本闸门 **7/7 MATCH**）；`adversarial.ts` **PASS 32 / FAIL 0** |
| 机器行文档 | README + 工具描述都补了 `^machine: slot=(\S+) pid=(\S+) port=(\S+) version=(\S+)( .*)?$` 与"未运行时各字段为 `-`"，并注明旧格式 `daemon=<pid>@<port>` 已废弃 |

> 边界说明（P2 的"绝不碰他人"）：**属主活着的他人 winpid 文件一律不动**；属主**已死**的他人文件仍按原判据回收
> （那是宿主崩溃后的孤儿清理，属于既有设计，与此条纪律不冲突）。
> **补充（task-16 复核）**：对**属主已死**的他人残留，sweep **不只手删文件 —— 同时 TERM 其 `.pid` 指向的 linux 运行时进程**（否则那个孤儿运行时仍占着 WSL 资源）；**属主活着**的他人文件与其运行时都**一律不动**。

---

## 用起来会踩的事实（补录，2026-10-10）

上面几节讲"为什么是这个形状"。这一节讲**用起来会踩的地方**——都是审计（`GAP-AUDIT.md` §8/§9）
暴露、而此前 README 没写的。

### 用 CLI / 脚本驱动守护时的两个实测坑（2026-10-12）

1. **不要用「赋值捕获」的方式跑 `selftest.ts ensure`**：`$o = & node src/selftest.ts ensure --port 8895 --isolated 2>&1`
   实测**会挂住 >10 分钟**（本机复现，作业被人工 kill）；换成**文件重定向**就**秒回** ——
   `Start-Process … -RedirectStandardOutput <file>` + `WaitForExit` 下 `ensure` 报
   `isolated daemon ok slot=8895 port=8895 pid=…（Windows 侧握手 5ms）`，`status`/`stop` 同样秒回。
   ⚠️ **根因未坐实**：现象与"长命守护持有的句柄让调用方的管道等不到 EOF"一致，但 `daemon-client.ts` 的 spawn
   已是 `stdio:['ignore','ignore', stderrFd ?? 'ignore'] + detached + unref` ⇒ 不能据此宣称根因，只记现象+可用做法。
   **结论**：用 CLI/脚本起守护时**别捕获输出**，或显式重定向到文件。
2. **槽位被自家孤儿占用会 `+1` 迁移，陈元数据可能留下**：实测某 slot 的 `daemon.<slot>.json` 里
   `metaPort: 8895` 而 `port: 8896`（=迁移后的实际端口；文件名仍按**请求槽位**）；那个实例死后**元数据仍在**，
   随后 `selftest status --port 8895` 会照它去连 8896 并报 `refused`（exit 1）。
   处置：确认该 slot 无活守护后，删 `daemon.<slot>.json` / `.token`（`status` 的 `orphans` 面也会报）。
   与「§9 第 13 条 槽位迁移」同源 —— 这里补的是**收尾**那半边。
3. **起进程不要弹可见窗口（用户明确要求过）**：用 PowerShell 起 `wsl.exe` / `dsh.cmd` / `node` 时，**必须** `Start-Process -WindowStyle Hidden`，或者干脆留在后台脚本里执行并把 stdout/stderr **重定向到文件**（不要前台流式打印）。**不要**用 `Start-Process wsl.exe -- bash launch.<slot>.sh` 这类会创建控制台的写法 —— 实测它会弹出一个标题为 `C:\Program Files\WSL\wsl.exe` 的窗口，把守护日志刷满屏，**干扰用户正在做的事**。起守护请走插件自己的路径（`detached + stdio ignore/文件`，不开窗）。收尾自查：`Get-Process | Where-Object { $_.MainWindowTitle }` 里不该出现 `wsl` / `cmd` / `conhost` 相关标题。

### 新增/即将新增的配置键（照 VS Code 对位）

| 键 | 默认 | 作用 | VS Code 对位 |
|---|---|---|---|
| `useShellEnvironment` | `true` | 把 WSL **登录 shell** 的环境注入**常驻运行时**（`wsl_agent` 那条 SDK 通道） | `remote.WSL.useShellEnvironment`（其实现为 `!1!==get(...)` ⇒ 同为默认 true） |
| `backgroundWarm` | `true` | 检测到**版本漂移**（桌面 dsh 版本 ≠ WSL pin）时，**后台**预热 pin 对应的版本，不阻塞当前这次调用 | `downloadInBackground`（VS Code 那边是"为下一个更新预下载 server commit"） |

两条的**代价**要一起看，否则默认值会显得没道理：

- **为什么只有常驻运行时注入**：登录 shell 注入要付一次 `bash -l` 的启动成本。常驻运行时**复用很多轮**，
  这份成本被摊薄了；`wsl_exec` 是**一次性**的，每条命令都背一次登录 shell 启动不划算——
  所以**一次性 `wsl_exec` 不注入**，仍按 `shellPreamble` 的**硬编码补 PATH**（`~/.local/bin`、
  `mise/shims`，`src/index.ts` 的登录 shell 注入段）——同属"不背登录 shell 成本"的取舍。
- **关掉 `useShellEnvironment` 的时机**：你的 WSL 登录 shell 初始化很慢，或**会往 stdout 打印**
  （问候语 / 版本管理器 banner 之类）。后者会污染运行时启动——SDK 通道读的是 stdio 上的 JSON-RPC，
  正文里混进非协议行就是事故。真踩了先查 `~/.bashrc` / `~/.profile` 里的 `echo`。
- **`backgroundWarm` 的边界**：它只是把"预热"挪到后台，**仍受网络与代理影响**（warm 走 `pnpm dlx`，
  冷启 ~5–7s，见 §7 复核第 ③ 条）；代理不可用时后台预热会静默不成功——
  以 `wsl_status` 的 pin / drift 与后续调用实际用时为准。

### 尖锐边：`exit 141`

脚本 preamble 第一行是 `set -uo pipefail`，所以**管道上游被 SIGPIPE 杀掉**会如实变成退出码 `141`
（`128+13`，13 = SIGPIPE）：

```bash
yes | head -1      # ⇒ exit 141
```

本机实测（WSL 侧直跑）：

```
pipefail-on: exit=141
pipefail-off: exit=0
```

**这是 bash 语义，不是插件 bug**——同一行在真实的 `set -o pipefail` 脚本里也是 141。
`yes` 写到 `head` 关闭管道为止，被 SIGPIPE 收掉；`pipefail` 让"管道里任一环失败"成为管道整体的状态，
于是 bash 如实报了 141。换句话说：**你的脚本本来就该预期看到 141**。

想要旧行为（只看最后一个命令的退出码），改法：

| 做法 | 写法 | 代价 |
|---|---|---|
| 单条命令显式吞掉 | `yes \| head -1 \|\| true` | 实测 `exit=0`；但**真实的失败也会被一起吞掉** |
| 临时关掉 pipefail | `set +o pipefail`（本命令内自己加一行） | 实测 `exit=0`；该命令后续任何一环失败都不再被反映 |
| 只关心上游自己的退出码 | 用 `${PIPESTATUS[0]}` 取值 | 实测 `yes \| head -1` 下 `PIPESTATUS[0]=0`——即 141 是 pipefail 对 SIGPIPE 的整体判定，**不在上游的退出码里** |

上面第 3 行是这节的要点：141 **不代表上游命令"失败返回 141"**，而是"管道里有人被信号收掉"。
要看上游自己的状态就取 `PIPESTATUS`（实测 `false | true` ⇒ `PIPESTATUS[0]=1`，能如实反映上游失败）。

选哪种取决于你要区分的是"上游被 SIGPIPE"还是"上游真失败了"——想区分就用 `PIPESTATUS`。

### UNC 工作区：读可以走 UNC，执行必须走 WSL

Windows 侧**可以**经 `\\wsl.localhost\<distro>\...` **读** WSL 文件。本机实测：

```powershell
Get-ChildItem '\\wsl.localhost\debian-u8-1\home\g' -Force   # 目录可列
Get-Content   '\\wsl.localhost\debian-u8-1\tmp\<file>'      # 文件可读（实测读到 hello-from-wsl）
```

但**禁止在 UNC 路径上跑 Windows 的写型工具**（`git` / `npm` / `pnpm` / 任何会改文件属主或权限的）：

> 那份文件在 WSL 里是 **ext4**，Windows 侧经 9p 访问。Windows 进程**不按 POSIX 语义**写属主与权限位，
> 一次 `git checkout` / `pnpm install` 就足以把**同一份仓库**的属主/权限写坏——而 WSL 侧还要继续用它。
> 这不是"慢"或"可能有问题"，是**会写坏同一份仓库**（§7 复核里被专门标为硬风险）。

**规矩一句话**：

| 你要做的事 | 走哪条路 |
|---|---|
| 看内容（读文件、列目录、读日志/配置） | 可以走 UNC（`\\wsl.localhost\…`） |
| 跑工具、改文件、`git` / 包管理、执行任何东西 | **必须**走 `wsl_exec` / `wsl_agent`，或 `wsl_open_ui` 里的终端 |

（本插件自己只在 `/tmp` 写一次性 `.sh`/`.mjs` 启动脚本，用完就删，见"设计要点"第 2 条；
那是一次性文件、不碰你的仓库内容，与上面这条禁令不冲突。）

### 文件系统事件：不做监听，改动一律在 WSL 侧发生

跨 OS 的文件事件**不可靠**——WSL2 的文件在 ext4，Windows 侧经 9p/UNC 看过去；`inotify` 的语义过不了这层边界。

VS Code 的应对是**明写轮询**：配置键 `remote.WSL.fileWatcher.polling`（+ `.pollingInterval`，
见 `GAP-AUDIT.md` §8 第 6 项）。

本插件的选择更简单：**不做文件监听、也不做失效检测**。代价与边界：

- Windows 侧的文件监听器**看不到 WSL 侧 ext4 的改动**——别假定"改完会收到通知"；
- 反过来，**改动一律在 WSL 侧发生**（`wsl_exec` / `wsl_agent` / `wsl_open_ui` 起的 WSL host），
  所以本插件的场景下这个缺口的实际影响**小于编辑器场景**（§9 第 6 项：🟡）；
- 要感知 WSL 侧的变化，就**显式去查**：跑一条 `wsl_exec`（例如 `git -C <repo> status --porcelain`），
  或让 `wsl_agent` 在任务结束时自己报告——**不要等事件**。

### 诊断面：`wsl_status` 报告什么

`wsl_status` 是只读、廉价的入口——**在怪远端之前先调它**。**下表是 2026-10-12 从真实输出逐行核对的形态**（字段名以 `src/index.ts` 实际输出为准）：

| 输出行 | 内容 |
|---|---|
| `distros:` | `wsl -l -q` 列出的发行版 |
| `target:` | 当前 `distro` / `wslHome` / `cwd` |
| `wsl ip:` | WSL 内 `hostname -I` —— **只是 WSL 内网 IP，不能证明 Windows `localhost` 可达** |
| `shell env injection (useShellEnvironment):` | 登录 shell 环境注入的开关与**作用范围**（只注入常驻运行时 `wsl_agent`/`wsl_open_ui`；`wsl_exec` 的一次性路径不注入） |
| `localhost forwarding:` | 从 `.wslconfig` 读到的 `localhostForwarding`（NAT 模式下它才是「Windows→WSL `127.0.0.1` 可达」的依据；`networkingMode=mirrored` 时该键被忽略） |
| `desktop dsh version:` | 桌面 dsh 版本 + 来源路径（`<-` 后面那段；来源按分层解析） |
| `version this plugin uses:` | 本插件这次实际用的版本 |
| `wsl pin:` / `drift:` | WSL 侧 pin；不一致时 `drift: YES (desktop x / pin y)` |
| `dlx dsh versions in WSL:` | WSL 里**已装（缓存）**的 dsh 版本（此前只知道"插件要用哪个版本"） |
| `backend:` | `daemon`（默认：运行时由 WSL 侧常驻守护持有）或 `in-host`（逃生舱） |
| `daemon:` | `running pid=… actualPort=… slot=… version=… uptime=… idleMs=… lingerMs=… keys=N [(key(turn N,pid P)), …]`；没守护时是 `not running …` |
| `daemon idle/linger/queue:` | 三个闸门**当前生效值** + 各自后果（空闲回收 / 自退 / 并发上限） |
| `daemon ports:` | `configured=<port>(+N 回退) actual=<port> slot=<slot>` —— **配置值与实际值分开报**，不一致时一眼可见 |
| `daemon state dir (WSL):` | 状态目录 + 「元数据**按槽位** `daemon.<slot>.json` / `.token`（0600）」的说明（本插件不把守护的东西落 `/tmp`） |
| `resident runtimes (in-host backend only):` | **仅 `in-host` 后端**持有的常驻运行时；`daemon` 后端下恒为 `(none)`（运行时在守护里） |
| `web hosts:` | `wsl_open_ui` 起的 host（按端口） |
| `pid files in WSL /tmp:` | 孤儿运行时计数（只数不杀；首次有副作用的调用会清） |

`wsl_daemon action=status` 另外给：`daemon:`（同上）、**`machine:` 机器行**（`slot= pid= port= version= keys= orphans=`）、`uptime/idleMs/lingerMs/queueLimit` 续行、`keys (N): …`、以及 **`ready 判据:`** 一行（明写"本次调用由 Windows 侧 hello+token 握手核实，不是守护自己的 listening 日志"）。

> **历史样本与规范形态**：下面各节验证表里 `daemon: pid=… port=…` 与 `daemon: pid=… actualPort=…` 两种写法并存 —— 那是不同 revision 的原始输出，**按「原文保留」不改**；**规范形态以上表为准**。（漂移清单见 `spike/verify/explorer-20261012/DOC-DRIFT.md`。）

**关于"计划补进"**：本节此前列过三项（shell-env 注入状态 / `localhostForwarding` 探测结果 / WSL 里已装的 dlx 版本）—— 2026-10-12 核对发现**三项都已实现**，已并入上表；本处不再保留"待补"清单（当前没有新的待补诊断项）。

---

## 先例对齐轮（P0.2）：冻结 revision 与结果

**动机**：用户要求"参考现有 DSH WSL 插件设计"。调研（npm registry 经代理 + 3 份 README）发现同域已有 10+ 个真插件，其**官方约定**与**成熟解法**见 [docs/prior-art-dsh-wsl.md](docs/prior-art-dsh-wsl.md)（含 T11 的只读实测与三处事实更正）。

**冻结 revision —— P0.2（2026-10-12，13 个锚点）**：与 P0.1 比变 **6 个**（`src/explorer.ts`、`src/index.ts`、`client/client.panel.js`、`client/index.js`、`client/client.api.js`、`package.json`），其余 7 个逐字相同。独立验证者 `p0-verify` **17:49 冻结 / 18:0x 复算 13/13 一致 ⇒ 验证有效**（报告：`spike/verify/explorer-20261012/REPORT-prior-art-adoptions.md`）。

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `src/daemon-client.ts` | 37,581 | `184f6b87ef2ebc78b53b57bb13ebcecc28c546ccf1aee029c21daca19280098f` |
| `src/daemon.ts` | 23,299 | `1c5284e56a7affdbe3578148e31dcb98252ad6d286ba8d978efd023905967d96` |
| `src/explorer.ts` | 39,787 | `6c414cb375e3b77ffd1c742f676ebeed831a2657232eb8ffed7594974b1b12a0` |
| `src/index.ts` | 84,949 | `4c8946d16a66de0b9a691a9f69ddc2c1f484f916538974e09c8186ed8d72d334` |
| `src/sdk-runtime.ts` | 11,433 | `74853c0539fe5fa14507c6e71dcacc2385e0b03c56e062a41fdb4dc1c837c52e` |
| `src/selftest.ts` | 21,772 | `1aaa5d1b938543d8d8d163af57df9e123851639123fba4e8c6ef65a90e845d94` |
| `src/shell-env.ts` | 12,480 | `9a9f6e5592c197f54686e177bf6d85aaa646b9d2b61c02bd4414fd3f37ae54b1` |
| `src/version.ts` | 14,386 | `ae5612fa22d80672a4c1d36acdfd34f1a0c792cbb1472b0525579541f41de275` |
| `client/client.api.js` | 11,234 | `4ca5c7ba1a9523632dcdd40a0a4a00eb3dfd2817fa2eae014375203e01c53901` |
| `client/client.icon.js` | 2,209 | `e9a824f50e45e5d4840a8604d511dbc2b87cc4bb30a6512aefe505dc11b7d431` |
| `client/client.panel.js` | 50,840 | `86f24076d6cd6a0dcde1017734e8e7b2a811b5246c28de2093ec3f4e6775907e` |
| `client/index.js` | 17,685 | `0588b3d32ded5fd4b80e3a96970c9740ae18a1607eb9ff3a6f6d29b92353b416` |
| `package.json` | 1,548 | `ce486eced7bc36df696b51d2dd6646576ab3065efe46995c34a1ef4f4d20a087` |

**本轮采纳（全部独立复验通过）**
- **A2 `dsh.compatibility.dshReleases`** = `{"0.2.0-rc.2":"compatible"}` —— **只声明我们真跑过的版本**。诚实标注：**该字段是声明性的，本构建既不读也不校验**（`--dump-config-schema` 与 121MB asar 原始字节扫描里 `compatibility`/`dshReleases` **0 命中**），所以它**不代表宿主校验通过**，含义只是"我们在这个版本上做过验收"。没实测过的版本**一个都没写**（也不写 `unknown`：拿不到允许枚举就不发明值）。改完 `--dump-config` 与改前**逐行相同**（exit 0 / 0 `Error:` / 7 工具照常）。
- **A6 新工具 `wsl_path`**（**第 7 个工具**）：Windows↔WSL 路径互转（`wslpath`）。**安全关键**：路径一律**位置参数**传递（`-e bash -c '<脚本>' _ <path>`），**绝不做 shell 拼接**。验证：4 条功能 + **8 类注入负例全部当字面量、零执行痕迹**；独立复验的**故意红**把实现换成双引号拼接后，注入用例**真的创建了 `/tmp/t14-pwned-a`**（而现版零痕迹）⇒ 证明防护承重。失败面可读（空路径/NUL/非法 `direction`/发行版不存在），且**不启动任何发行版**。
- **A3 目录浏览器对齐先例**（`dsh-wsl-workspace-picker`）：**快捷 chips**（Home / `/` / `/mnt` / 探测到的 `/mnt/<盘符>`）、**常显路径输入**（回车跳转、非法给可读错误）、**从 `/` 起的完整面包屑**（不折叠）、**隐藏文件开关**（默认关，**纯前端过滤** `listCallsDelta=0`）。为此新增 host 只读方法 **`explorer.listDir`**（全量返回含隐藏；`..`/NUL/空/相对/反斜杠 ⇒ 400 `E_ARG`；不存在 ⇒ **404 `E_NOTFOUND`**；发行版不存在/未运行 ⇒ 503 且**不启动发行版**；name 升序；复用 `unc()`）。
  - **实现中打到的真缺陷**：`/mnt/c`、`/mnt/d` **经 UNC 列不出来**（9p 不暴露 drvfs 挂载根）⇒ 盘符 chip 本来是死路；修法是 `windowsDriveForMount()` 把 `/mnt/<单字母>`（及其后代）映射到 `C:\…`（同卷、只读）。`/mnt/wslg` 等仍走 UNC。
- 回归全绿：F34 首挂载只有读取态｜F35 的 LTR 覆盖**全部新增路径文本**｜`others[]` 只读**零按钮**｜停止/重启仍二次确认｜aria/title 齐全｜light/dark 双份｜③ 差集 exit 0（strong=11）。

**刻意**未采纳（理由见 prior-art §4）：`dsh.client.inject` **保持 `[]`**（实测：`@deepseek-ai/dsh-client-runtime` 在 0.2.0-rc.2 **根本不存在**，先例的 inject 值不可照抄）；`immediately` **不用**（对照运行显示同 batch 下无可观测差异）；**不抢** `directoryFlow` 两个槽（我们不是目录选择器）。

**下一步（已具备落地条件，尚未做）**：**A1**「添加为 WSL 工作区」—— 实测 WSL 路径**能**成为工作区，但**只能用 UNC**（`\\wsl.localhost\<distro>\<path>`；发行版内路径 `/home/g` 被拒 `Workspace path is not fully qualified`；路径必须已存在；`workspaceRegistry.create()` **不经被禁的 picker 能力**）⇒ 落地时必须并列写明"工作区路径是 UNC ⇒ 文件工具读写走 **9P**"。**A4** i18n —— `ctx.get('locale')` 实测可用（`document.documentElement.lang === "zh-CN"`），**不必改 `inject`**。**A7** `wsl-doctor` 式工具链体检：按成本再定。

**未复核（不许当通过）**：`keys>0`/多 key｜`webHosts` 非空｜desktop(Electron) 宿主｜**"发行版未运行"分支**（用兄弟分支覆盖，未真构造）｜`/mnt/*` 上 Windows 隐藏属性不参与 `hidden` 判定（刻意取舍）｜`wsl_path` 超长输入（4KB+）｜注入负例的"字面量保留"判据偏粗（决定性证据是标记/进程零痕迹 + 实现自报 argv）｜像素截图未落盘｜UNC 工作区**真开会话**的 9P 写入路径｜客户端热更是否需 `dev:web`。
