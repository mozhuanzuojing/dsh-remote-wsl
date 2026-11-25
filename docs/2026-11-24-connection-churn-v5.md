# 2026-11-24 · 连接 churn 根因 + 协议 v5（长连接复用 / 批量帧）+ 世界路由 + WSL 内搜索逃生口

> 起点症状：聊天里偶发 `remote-wsl: WSL 守护不可用，无法访问 "\\wsl.localhost\…"。原因：守护调用失败 (error): connect EADDRINUSE 127.0.0.1:8731（Windows 侧 3000ms 握手判据）`，而 `wsl_daemon status` 一切正常。

## 1. 事实（本机实测，全部可复现）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `connect EADDRINUSE 127.0.0.1:8731` 里的 **EADDRINUSE 不是"目的端口被占"**，是 Windows 给这条出站连接分配不到**本地临时端口**（WinError 10048） | Node 错误串形如 `<syscall> <code> <address>:<port>`；连接阶段失败 ⇒ 一字节未发。上游同类实践：selenium 里"Rescue and retry EADDRINUSE to work around connect(2) errors on Windows"，注释直指 ephemeral ports / `MaxUserPort` |
| F2 | Windows 动态端口范围 = 49152–65535 = **16384 个**；`TcpTimedWaitDelay` 未设置 ⇒ 默认 **120s** | `netsh int ipv4 show dynamicport tcp`；注册表 `Tcpip\Parameters` |
| F3 | 插件旧实现**每 op 一条 TCP 连接**（`tcpCall`：connect → 收到回包 → `destroy`） | `src/daemon-protocol.ts` `tcpCall` |
| F4 | 一次文件密集回合实测 **1106 次 `op=fs` / 8.3 秒**（峰值 165/s），客户端主动关闭（守护日志每个 RPC 一对 `recv op=fs` + `客户端断开`） | `~/.dsh/remote-wsl/daemon.log` |
| F5 | 1200 次 connect→destroy 后，Windows 侧到 8731 的 **TIME_WAIT = 4058**，全机 TIME_WAIT 5484 | `_tmp/churn.ts` + `Get-NetTCPConnection` |
| F6 | 16384 ÷ 120s ≈ **137 连接/秒** ⇒ 持续 130+/s 两分钟就把池子打光；此后全机新建连接拿 `EADDRINUSE`，两分钟后自愈（= "有时候报错、状态正常"） | F2+F4+F5 算术 |
| F7 | 守护**从未参与**这次失败：status/doctor 只做一次握手（5ms 通过），失败发生在宿主进程的 socket 分配阶段 | `wsl_daemon status`；错误来自 `net.connect` |
| F8 | WSL 世界里的 `grep`/`glob` **已经是"一帧扫一棵树"**（`{op:'search'}` → 守护内 rg/fd） | `src/search-tool.ts`、`src/search-rpc.ts`；单帧实测 grep 整棵树 1936ms / glob 128ms |
| F9 | 但标准 preset 的 UNC 会话里，宿主自带 grep/glob 走 Windows ripgrep + 9P，**守护 RPC 增量 = 0** ⇒ "扫树下推"对这类会话**没接线** | 对该 UNC 路径跑 grep/glob，`daemon.log` 的 `recv op=search` 计数不变 |
| F10 | `op=fs` 的每次调用（读一个 UNC 文件 = 3 条 RPC）才是这条通路的真实成本 | 读一个 149 行文件 → `op=fs` +3 |

## 2. 改动

### 2.1 传输层（协议 v5，`src/daemon-conn.ts` 新增）

- **长连接复用**：一条 TCP 连接承载多条 `fs`/`search`/`status` 请求，按单调递增 `id` 配对回包；
  空闲 45s 关闭；超时/错误即断开重连（**迟到回包绝不错配给新请求**）。
  `prompt` 仍然走一条连接一次（长任务 + 取消语义，不与池混用）。
- **批量帧**：`{op:'fs', method:'batch', args:{calls:[…]}}`，上限 64 条，**逐条独立成败**；
  daemon 侧并发度 8。宿主侧按 `setImmediate` 把同一 tick 内的**只读**调用合并成一帧
  （写操作永不进批：副作用语义不容许被同帧别人的失败牵连）。
- **兼容**：旧守护本来就支持一条连接多帧 ⇒ 池化对旧守护可用；旧守护不认识 `batch` ⇒
  回 `unknown fs method` ⇒ 该连接标记 `batchUnsupported`，逐条退回单发（不重试、不伪造成功）。
- `transportErrorAdvice` 新增 EADDRINUSE/EADDRNOTAVAIL 分支：直接说明"Windows 临时端口不够用，
  等 1–2 分钟或减少大范围扫描"，不再把人引向"WSL 内存/swap"。

### 2.2 世界路由（A，`src/world-route.ts` 新增）

`agent/created`（`source=startup`）时，若会话 cwd 是本发行版 UNC 且 header 里**没有**已提交 preset，
用 `agentPresets.select()` 切到 `wsl-<默认模式>`（其次 `wsl`）。边界：`resume`/`clear`/`compact` 不动；
用户显式选过的 preset 一律尊重；别的发行版不碰；没注册 WSL 预设就明确放过。`worldRoute: false` 可关。

### 2.3 WSL 内搜索逃生口（B，`wsl_grep` / `wsl_glob`）

**没有做"劫持宿主 grep/glob"**，理由是可验证的：那两个工具的 schema、output-retention、spill 落盘与
`presentResult` 卡片全在 `@deepseek-ai/dsh-tool-fs-search` 里；从外部替换其返回值等于把整套语义复制一遍，
否则模型拿到文本、UI 卡片炸。而同名工具在本层注册会被 registry 判为同层重名（scoped 才能遮蔽 global，
scoped 属于**执行世界** —— 那正是 A 的路子，且 A 已经做掉）。

因此在宿主平面提供一个**不同名、按路径选择**的确定性入口：`wsl_grep` / `wsl_glob`（一帧 `{op:'search'}`），
描述里写明"路径在 WSL 里就用我"。路径解析复用 `resolveSearchRoot`（UNC / Linux 绝对 / 相对 cwd，
别的发行版明确拒绝）。

## 3. 验证

- 新增单测 5 个文件 26 条：`test/daemon-conn.test.ts`（单连接/乱序配对/超时重连/断开/批量帧/旧守护降级）、
  `test/fs-batch.test.ts`（同 tick 合帧、批内独立失败、不可用降级单发、写不进批）、
  `test/fs-rpc-batch.test.ts`（daemon 侧逐条成败、空批/嵌套/超限）、
  `test/world-route.test.ts`（7 条边界）、`test/search-root.test.ts`（6 条路径解析）。
- 全量：`node --experimental-strip-types --test test/*.test.ts` ⇒ **351 tests / 342 pass / 0 fail / 9 skipped**（Windows 原生跑：351 / 338 pass / 0 fail / 13 skipped —— 差的 4 条是 bash 相关的启动锁用例，Windows 上按设计跳过）；
  `scripts/check-syntax.ts`、`scripts/check-contract.ts`、`tsc -p tsconfig.json` 全绿。
- **隔离守护实测**（另起 8799 端口，`--no-provision`，Windows 侧客户端）：同样的 300 次 `fs.stat`

  | 路径 | 连接数 | 耗时 | TIME_WAIT 增量 |
  |---|---|---|---|
  | 旧（每 op 一条） | 300 | 622ms | +300 |
  | 池化 | 1 | 127ms | ~0 |
  | 池化 + 批量（60/帧） | 1 | 14ms | ~0 |

  守护日志侧：906 次调用只出现 **303 次**连接建立（旧路径 300 + 池化 1 + 批量 1 + 2 次超限批被拒），
  即"连接数从 O(op) 降到 O(1)"。

## 4. 生效条件与遗留

- **host 半代码在 DSH 启动时加载**（`package.json main = ./src/index.ts`）：A/B/C 的宿主侧改动
  **必须重启 DSH Desktop** 才生效。守护半（`src/daemon.ts`）每次启动都读源码 ⇒ 新守护已带 v5。
- 协议兼容判据：守护协议 > 宿主协议 ⇒ **hard**，宿主明确拒绝复用并提示重启。所以"旧宿主 + 新守护"
  会报一句可操作的话，而不是偷偷用错协议 —— 这是设计，不是新故障。
- 未做（有意）：`prompt` 池化（长任务/取消语义冲突）、`op=fs` 批量里包含写操作（副作用顺序）、
  对宿主自带 grep/glob 的运行时劫持（见 2.3 的理由）。

## 5. 重启后实机验证（2026-11-24 20:33，新宿主进程）

重启 DSH Desktop 后，新宿主加载 `src/` 即生效，验证到的事实：

| 检查 | 结果 |
|---|---|
| 插件版本 | `wsl_status` 报 `plugin: dsh-remote-wsl@0.12.0` |
| 新工具注册 | `wsl_grep` / `wsl_glob` 出现在 Tool 目录里（B 生效） |
| B 端到端 | 调 `wsl_grep` 扫 `/home/g/project/OpenAPI-Gateway`（pattern `class `）⇒ 一帧 `recv op=search`，发行版内 ripgrep 直接出结果（无 9P 遍历） |
| C 连接复用 | 守护日志按 `id` 连续：`recv op=search id=1` → `recv op=fs id=2/3/4`（**同一批 3 个 fs RPC 落在同一条连接上**，旧实现是 3 条）；守护自启动至今只记录 2 次 `客户端断开`（一次就绪握手 + 一次空闲回收），而调用共 4 次 |
| C 自动重连 | 对端回收连接后下一次调用自动重连，`id` 继续单调递增（`Conn.nextId` 不随 socket 重置）⇒ 迟到回包不会错配 |

新守护 `pid=1033906`，`dsh@0.2.2-rc.5`，`protocolVersion=5`；宿主与守护版本一致，未触发 hard 拒绝。

附带修掉一个实测暴露的小缺陷：单行匹配预览原来原样回给模型（压缩过的 `.js` 一行 35KB ⇒ 一次结果被撑成整段泄洪），
现在在 `searchGrep` 里按 500 字符裁剪并标 `…`（行号/路径仍逐条保留）。该改动同样在下次重启生效。
## 6. npm 分发形态（2026-11-24 追加）

### 6.1 事实：源码形态发布出去**装完就是死的**

`npm pack` 出的 tarball 装进隔离目录后，四个入口全部拒绝加载：

```
main / sub:fs-provider / sub:search-tool   FAIL ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
client                                     FAIL window is not defined（正常：浏览器 bundle）
node --experimental-strip-types src/daemon.ts
                                           同一错误（WSL 侧守护也栽在同一处）
```

根因：Node 的类型擦除**明确排除 `node_modules`**。`link:` 安装时文件在工作树里所以能跑，
npm 安装时文件落进 `node_modules/` ⇒ 宿主半（`main=src/index.ts`）与守护半（`daemon.ts`）双双失效。
而仓库既有 351 条测试**全部** import `../src/*.ts`，永远发现不了这件事。

### 6.2 改动

| 项 | 内容 |
|---|---|
| 构建 | 新增 `tsconfig.build.json`（`noEmit:false`、`outDir:lib`、`rootDir:src`、`noCheck:true`、`allowImportingTsExtensions` + **`rewriteRelativeImportExtensions`**）—— 只转译，并把源码里的 `./x.ts` 改写成 `./x.js` |
| 入口 | `main` / `exports` 全部指向 `lib/*.js`；`files` 同时保留 `lib`（运行形态）与 `src`（可读源码） |
| 守护定位 | `daemonScriptWsl()` 改为"与本模块**同目录**的 `daemon.js` 优先，否则 `daemon.ts`"（源码形态 / 安装形态各自成立）；进程身份判据补上 `*daemon.js*` |
| 门禁 | 新增 `scripts/check-pack-loadable.ts`（`npm run check:pack`）：真 `npm pack` → 解包 → **逐个 entry 真 import** → 验证 `daemonScriptWsl()` 解析到 `lib/daemon.js`、`lib/daemon.js` 随包、tarball 不含 `node_modules` |
| 契约 | `check-contract.ts` 加 2 条：`main`/`exports` 必须是**存在的 `.js`**（禁止再指 `.ts`）、`lib/daemon.js` 必须已构建 |
| 开发体验 | 新增 `npm run dev`（`tsc -p tsconfig.build.json --watch`）：`main` 指向 `lib/` 后改 `src/` 必须重建，watch 把这一步找回来 |
| 分发元数据 | 去掉 `private: true`；加 `publishConfig`（registry=npmjs.org、access=public） |

### 6.3 复验（全部在 Windows 上直接跑）

| 检查 | 结果 |
|---|---|
| `node --check` 全部 `lib/*.js`（46 个，含 `daemon.js`） | 0 失败 |
| `npm pack` → 隔离目录 `npm i` → 逐个 `import` | `main` / `fs-provider` / `search-tool` / `shell-provider` / `command-policy` 全 **OK**（`client` 仍只报 `window is not defined`，浏览器侧正常） |
| `node lib/daemon.js --port 8797 …`（从安装后的包启动） | `listening 127.0.0.1:8797` —— 安装形态的守护真的能起 |
| `npm run check:pack` | PASS ｜ 11 条 |
| `npm run check:contract` | PASS ｜ 12 条 |
| `tsc -p tsconfig.json` + `node --test` | exit 0 ｜ 351 tests / **338 pass** / 0 fail / 13 skipped |

### 6.4 还没做的一步

真正 `npm publish`：需要 npmjs.org 的登录态（本机 `npm whoami` = `ENEEDAUTH`，registry 还是 npmmirror 镜像）。
发布命令（登录后）：`npm publish`（`publishConfig` 已把 registry 指到 npmjs.org、access=public；
`prepack` 会先 build）。建议先发 `0.12.0` 之外的 `0.12.1-rc.1` 试水，确认 npm 页与安装都正常再发正式版。