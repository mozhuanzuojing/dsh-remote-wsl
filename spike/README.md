# spike: 跨进程重连 / 多客户端共享一个远端运行时

> 目标：证明 **"关掉客户端再打开，继续同一会话（上下文保留）"** 在不改上游、不改插件的前提下可实现
> —— 这是 GAP-AUDIT 里与 VS Code Remote-WSL 差距 #8/#9 的**唯一自研出路**。
> 本目录是独立 spike，**没有改动** `lib/`、`README.md`、`GAP-AUDIT.md`、`package.json`、`cordis.patch.yml`、`~/.dsh/profiles/*`。

## 0. 结论（一句话）

把运行时从"Windows 宿主进程的子进程"改成"**WSL 侧常驻守护进程持有的资源**"，Windows 侧退化成
"连上去发一条 prompt 的瘦客户端"后，**跨进程上下文保留成立**：客户端进程退出 → 新进程连上 →
守护把同一条 prompt 交给**同一个还在活的运行时** → 第 2 轮答出第 1 轮让它记的数字 `7`，
`sessionId` 与 `runtimePid` 全程未变。

反证同时成立：不走守护、两个独立进程各自起 `dsh --profile sdk` 复用同一 `sessionId`
⇒ 上游拒绝 `JSON-RPC -32603: session "…" already exists`。
**并且**（本次新发现，见 §3.3）：A 进程已经 `shutdown`、运行时消失之后，B 复用同一 id **依然**被拒
⇒ 冲突来自**落盘的 session 记录**，不是"活着的持有者"的锁
⇒ "运行时死了就重启一个、沿用旧 id 把上下文接回来"这条路**彻底堵死**
⇒ 上下文只能活在"那个还活着的运行时进程"里，守护不是优化而是**唯一解**。

## 1. 交付物与本机复现

| 文件 | 跑在哪 | 作用 |
| --- | --- | --- |
| `daemon.ts` | WSL（node 26.10） | 常驻守护：按 key 持有运行时，监听 `127.0.0.1:<port>`（TCP + NDJSON） |
| `client.ts` | Windows（node 26.10） | 瘦客户端：连一次、发一条、打印原始 JSON 响应、退出 |
| `protocol.ts` | 两端共用 | **纯类型模块**：NDJSON 帧形状（请求/响应/status 视图/就绪行）的唯一权威定义 |
| `run-spike.ps1` | Windows（pwsh 7） | 一键演出全链路 + 逐步断言 + 收尾核对（含反证实验） |
| `sdk-runtime.ts` | WSL | `SdkRuntime`（从 `lib/index.js` 抽出的运行时腿），被 daemon 与 repro 共用 |
| `repro-conflict.ts` | WSL | 反证实验：两个独立进程复用同一 sessionId |
| `package.json` | — | `"type":"module"` + `engines.node: ">=26.10"`（顶层 await 与 .ts 解析都靠它） |
| `EVIDENCE-run-spike.txt` | — | 迁移前（.mjs 时代）完整跑通的证据行（PASS/FAIL + 每步原始 JSON + `-32603` 原文） |

**零构建（.mjs → .ts 迁移后的硬约定）**：源码是 `.ts`，但**没有 tsc、没有 dist、没有构建步骤** ——
靠 Node 原生 type stripping（23.6 起默认开启，本机基线 **26.10.0**）直接 `node xxx.ts`。
因此只允许**可擦除语法**：`type` / `interface` / 类型注解 / `as` / `!` / 泛型；
**禁止** `enum`、`namespace`、构造函数参数属性、`import x = require()`、实验性装饰器。
相对导入必须写 `.ts` 扩展名（Node 的解析规则）。
Windows 侧用 `C:\Users\l\AppData\Local\mise\shims\node.exe`（v26.10.0）；WSL 侧用 `mise exec -- node`。

```powershell
# 全量（含反证 + stale 对照 + 空闲回收）：约 3 分钟，14 步，全 PASS 时 exit 0
pwsh -NoProfile -File D:\project\dsh1\vendor\dsh-remote-wsl\spike\run-spike.ps1 -WithStale -WithIdle

# 反证实验单独跑
wsl -d debian-u8-1 -u g -- bash -c 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; cd /mnt/d/project/dsh1/vendor/dsh-remote-wsl/spike; mise exec -- node repro-conflict.ts --mode alive'

# 手工起守护 / 手工发一条（Windows 侧 node 26.10 直跑 .ts）
wsl -d debian-u8-1 -u g -- bash -c 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; exec mise exec -- node /mnt/d/project/dsh1/vendor/dsh-remote-wsl/spike/daemon.ts --port 8731'
node client.ts --port 8731 --key k1 --text "记住数字 7，只回 ACK"
node client.ts --port 8731 --status
node client.ts --port 8731 --shutdown
```

## 2. 协议契约（已按 Lead 定义实现，未改）

TCP `127.0.0.1:<port>`，NDJSON：一行一条请求、一行一条响应。

| op | 请求 | 响应 |
| --- | --- | --- |
| `prompt` | `{"id":1,"op":"prompt","key":"k1","text":"..."}` | `{"id":1,"ok":true,"answer":"…","sessionId":"…","turns":2,"runtimePid":1234,"completedBy":"turn/end","eventCount":19}` |
| `status` | `{"id":2,"op":"status"}` | `{"id":2,"ok":true,"daemonPid":N,"daemonStartedAt":…,"uptimeMs":…,"port":8731,"version":"0.2.0-rc.2","cwd":"/home/g","idleMs":1800000,"keys":[{"key":"k1","sessionId":"…","turns":2,"runtimePid":N,"startedAt":…,"idleForMs":60}]}` |
| `shutdown` | `{"id":3,"op":"shutdown"}` | `{"id":3,"ok":true,"reaped":[…同上 keys 快照…]}`，随后守护退出、端口释放 |
| 失败 | — | `{"id":1,"ok":false,"error":"…"}`（含 `sessionId`/`turns`/`runtimePid`/`completedBy` 便于归因） |

语义（验收点）：
* **客户端断开不杀运行时**：`socket.on('end')` 只记日志；运行时只在 `shutdown` 或空闲超时时 `close()`。
* **同 key 后续连接继续同一 `sessionId`**（上下文保留）；`sessionId` 由守护生成一次、由客户端在协议里指定给 SDK
  （实测 `initialize` 的回包只有 `serverInfo`，**不含** sessionId —— 这是"id 由谁定"的关键事实）。
* **不同 key ⇒ 各自独立运行时 + 独立 sessionId**（实测两个 key 的 `runtimePid` 不同）。
* `runtimePid` = 运行时进程链的**根 PID**（`bash -c` 里 `exec mise exec -- pnpm dlx …`，exec 后这个 pid 就是那层）。
  它不是 SDK 那个 node 的 pid，但同一运行时内**稳定**（两次 `status` 未变）。
* 单 key 的并发 prompt 在守护内**串行化**（`SdkRuntime.prompt` 内部队列），失败不阻塞后续轮。

## 3. 实测结果

### 3.1 主链路（`run-spike.ps1`，全 PASS）

| # | 步骤 | 关键原始输出 | 结论 |
| --- | --- | --- | --- |
| 1 | 前置清点 | `dsh_rwsl_tmp=0 port_listeners=0 profile_sdk_procs=0` | 结论不是被既有残留污染的 |
| 2 | 起守护 | `{"ok":true,"event":"listening","port":8731,"pid":135303,"version":"0.2.0-rc.2"}` | WSL 内绑 127.0.0.1，Windows 侧首次尝试即连上 |
| 3 | 第 1 轮（客户端进程 A） | `{"ok":true,"answer":"ACK","sessionId":"remote-wsl-k1-2a8b…","turns":1,"runtimePid":135324,"completedBy":"turn/end"}` | 客户端 exit=0，进程消失 |
| 4 | `--status #1` | `keys:[{key:"k1",sessionId:"…2a8b…",turns:1,runtimePid:135324}]` | **客户端退出后运行时仍活着** |
| 5 | 第 2 轮（**另一个进程 B**） | `{"ok":true,"answer":"7","sessionId":"…2a8b…","turns":2,"runtimePid":135324}` | **跨进程上下文保留 = 重连成立** |
| 6 | `--status #2` | `sessionId:"…2a8b…" runtimePid:135324 daemonPid:135303 turns:2` | sessionId / runtimePid / daemonPid 三者均未变 |
| 7 | key2 + 回到 key1 | k2 `answer:"SECOND" runtimePid:135371`；回 k1 仍 `answer:"7" runtimePid:135324` | 两 key 互不干扰，k1 上下文不被 k2 打断 |
| 8 | **负向对照**（此时 2 个运行时活着） | `dsh_rwsl_tmp=0 port_listeners=1 profile_sdk_procs=4` | 探针**确实能**查出活运行时/监听端口 ⇒ 后面的 0 不是假 0（2 个运行时 = 4 个匹配进程 ⇒ `kill(-pid)` 必须收全树） |
| 9 | `--shutdown` | `{"ok":true,"reaped":[k1,k2]}` | 唯二回收入口之一 |
| 10 | 收尾核对 | `--status` → `ECONNREFUSED`(exit 2)；`profile_sdk_procs=0`；`/tmp/dsh-rwsl-*=0`；`port_listeners=0` | 无残留 |
| 11 | 反证（alive） | 见 §3.3 | 上游拒绝复用 id |
| 12 | 反证对照（stale） | 见 §3.3 | 冲突是落盘占用，不是活锁 |
| 13 | 再清点 | 同上三项全 0 | 反证实验无残留 |
| 14 | 空闲回收（`--idle-ms 15000`，端口 8732） | 回收前 `keys=1 (runtimePid 135704)` → 21s 后 `keys:[]`，`ps -p 135704` = 0；同 key 再 prompt ⇒ `sessionId` **换新**、`turns:1` | 空闲回收生效；代价是上下文丢失（**已知缺陷**） |

### 3.2 完成判定（三级兜底，逐轮命中）

`session/prompt` 只回 `{messageId}`，**无 per-prompt 结果** ⇒ 守护自己判完成：
`turn/end` →（本次全部 6 个 prompt 轮都命中 `"completedBy":"turn/end"`）→ 兜底 `session.status:idle` → 兜底 3s 静止窗口
（静止时**先 `flushPartial()` 再判完成**，否则尾帧无换行会丢帧）；事件实测形状：
`{"method":"session.event","params":{"sessionId":…,"event":{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"7"}]}}}}}`，
完成帧 `{type:"turn/end",data:{turn:1,reason:{kind:"completed"}}}`。正文只取 `content[].type==="text"`（丢弃 `reasoning`，否则答案会混思维链）。

### 3.3 反证：为什么必须有守护

`repro-conflict.ts` 起两个**互不共享父进程/内存**的进程，各自 spawn 一份 `dsh --profile sdk`：

```
# mode=alive（A 先建会话并保持存活，B 用同一 sessionId）
[A] FRAME {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
[A] turn1 answer="ACK" completedBy=turn/end runtimePid=134235 session=remote-wsl-conflict-1118a5d2-…
[B] FRAME {"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"session \"remote-wsl-conflict-1118a5d2-817a-4029-9269-f74c224a8093\" already exists"}}
[B] ERROR JSON-RPC -32603: session "remote-wsl-conflict-1118a5d2-817a-4029-9269-f74c224a8093" already exists
# VERDICT {"mode":"alive","crossProcessConflictObserved":true,…}

# mode=stale（A 已正常 shutdown，运行时已消失，B 仍用同一 id）
[A] close -> {"exitCode":0}
[B] FRAME {"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"session \"remote-wsl-conflict-9359304b-…\" already exists"}}
# VERDICT {"mode":"stale","crossProcessConflictObserved":true,…}
```

两点结论：
1. 报错发生在 `session/prompt`（`id:2`），`initialize`（`id:1`）照样成功 —— 冲突点是 **session 的创建**，不是连接；
2. **`stale` 模式同样被拒** ⇒ 冲突源是**落盘的 session 记录**，会话一旦创建就再也无法被另一个运行时接管。
   所以任何"客户端侧持有运行时"的形态（现状 lib/index.js 的 `SdkRuntime`）都**在结构上无法**做 reconnect。

## 4. 设计取舍（为什么是这个形状）

* **为什么 TCP `127.0.0.1` 而不是 Unix socket**：WSL2 的 localhost 转发实测可用（本 spike 就是 WSL 绑 127.0.0.1、
  Windows 直接 `localhost` 命中）。TCP 让两端各用各的 node 运行时（Windows 桌面 node 24 / WSL mise node 26）而无需共享文件系统语义；
  Unix socket 则要求 Windows 侧有能读它的客户端（本机没有现成的）。
* **为什么运行时由守护持有**：§3.3 —— 上下文只存在于活着的运行时进程内，`sessionId` 不能跨运行时复用。
  把"持有者"从客户端生命周期里摘出来，是让"客户端可来可走"成立的充要动作。
* **一个 key 一个运行时**：`sessionId` 在一个运行时内唯一且天然多轮；不同 key 用一个运行时会让工具/MCP/工作目录互相污染
  （对照 `lib/index.js` 的 `wsl_agent` 语义），故 key ⇒ runtime 一对一。
* **回收走进程组**：守护用 `spawn(..., {detached:true})` 让运行时自成进程组，`close()` 里 `kill(-pid)`
  连 `mise/pnpm/node` 全树一起收 —— 这正好解掉 `lib/index.js` 记录过的坑（"`child.kill()` 只杀 Windows 侧 wsl.exe 包装层，
  Linux 侧进程变孤儿继续跑、还抢模型配额"）。实测：2 个运行时活着时 `pgrep -f 'profile sd[k]'` = **4** 个进程、
  `ss` 有 1 个监听；`--shutdown` 之后全部归 0（负向对照在 `run-spike.ps1` STEP 8，用来排除"假 0"）。
* **凭据**：守护进程在 WSL 里读 `~/.dsh/.credentials.yaml`（credentials seam），**没有任何 key 进 env 或进本目录**；
  代理仍是"先探测再使用"（`net.connect` 3s 探 `172.30.176.1:9910`，实测不可用 ⇒ 直连，模型调用正常）。

## 5. 失败模式与已知缺陷

1. **空闲回收 = 上下文丢失**（实测）：`--idle-ms` 到期回收后，同 key 再 prompt 会拿到**新 sessionId**、`turns` 从 1 开始。
   语义上正确（省资源），但产品上要选：默认 `idle-ms` 是 30 分钟（本 spike 默认）还是"永不回收 / 跟随客户端最后断开时间"。
2. **运行时意外死亡 ⇒ 上下文必然丢失**：守护检测到 `exitCode !== undefined` 会丢弃该 key、下次 prompt 重建新运行时
   （新 sessionId）。这是 §3.3 的必然后果，**无法弥补**，只能在 UI 上如实告知"会话已重置"。此路径**未实测**（只走了代码路径）。
3. **完成判定是启发式**：无 per-prompt 结果。若上游事件流缺 `assistant/message` 正文，守护返回
   `ok:false, error:"runtime produced no assistant text (completedBy=…)"`，**不伪造空答案**；调用方需自行重试。
   （`lib/index.js` 此处会走"停稳运行时 + 读持久化 zstd 日志"兜底，守护版本**没做**，见 §7。）
4. **守护是单点**：守护被杀/发行版重启（`wsl --shutdown`、重启）⇒ 所有 key 的上下文一起丢，且**无法重放**
   （sessionId 不可复用 ⇒ 没有"从磁盘恢复会话"的可行路径）。Windows 侧必须能"发现守护不在 → 重启它"，
   本次**未验证**该恢复路径（只验证了 `ECONNREFUSED` 这一现象）。
5. **无鉴权**：绑 127.0.0.1，但 WSL2 localhost 转发意味着 **Windows 上任何本机进程都能连**
   （包括别的用户会话里的进程）。要接进插件必须加握手 token（见 §7）。
6. **无单实例锁**：第二个守护在同一端口会 `listen` 失败并 `exit 2`（非静默），但没有"发现已有守护就复用"的逻辑；
   端口被占时也没有回退/发现机制。
7. **未压测**：只验证了 2 个 key、单 key 串行；>10 key 的并发、单 key 长任务中的第二个 prompt 排队行为未测。
8. **`status` 的 `idleMs` 只能看不能改**：运行时无法在运行中延长/缩短空闲窗口（契约未要求）。
9. **守护 stdout 协议**：只有一行启动 JSON；运行时/客户端的详细诊断都在 **stderr**。若插件要结构化日志，需要另加 `--log-json`。

## 6. 环境坑（3 个已知 + 4 个本次新踩）

已知并已按事实实现：① PATH 补 `~/.local/bin` + mise shims；② 尾帧无换行 ⇒ `flushPartial()`；
③ 代理先探测再使用（不可用则直连，不 `export`）。

本次新增（都写进了脚本，否则会静默失败）：
4. ~~**本发行版的 `bash -lc` 会落到 zsh**（`SHELL=/usr/bin/zsh`）~~ —— **本条已被 task-2 独立验证证伪**
   （勘误，2026-10-10，见 `verify/REPORT-verify.md` 第 4 条：`bash -lc` 里 `BASH_VERSION=5.2.37`、`ZSH_VERSION` 未设、
   `export -p` = 22 行 `declare -x` / 0 行 `typeset -x`；`SHELL=/usr/bin/zsh` 只是**继承来的环境变量**，
   `~/.profile`/`~/.bashrc` 里没有 zsh 跳转）。
   **真实机制**是 bash 下 `ls <未匹配 glob>` 返回 rc=2、被管道里的 `wc -l` 吞掉 ⇒ 计数**假 0**。
   **结论不变（照做）**：收尾核对不要用裸 glob，用 `find /tmp -maxdepth 1 -name 'dsh-rwsl-*'`。
5. **`Start-Process` 不给参数加引号**：内联 `bash -c "echo <b64> | base64 -d | bash"` 被拆成多个参数，守护**静默不启动**
   （第一版 run-spike 就这么失败：daemon stdout 为空）。改成"把启动脚本落地成文件 + `bash <file>`"，
   pwsh→wsl.exe→bash 三层引号问题一次性消失。（`base64` 内联仍是插件里 `writeScript` 之外的可选方案，但它占用 stdin 且过不了 Start-Process 的参数拼接。）
6. **`pgrep -f 'profile sdk'` 会匹配检查命令自身**（检查命令的 cmdline 里含该字面串）⇒ 用自避正则 `pgrep -f -- 'profile sd[k]'`。
7. **PowerShell 里 `param` 不能叫 `$args`**（自动变量）：`@args` splat 会变空数组 ⇒ node 收不到任何参数。
   我踩了：守护明明在 listen，客户端却连续 61 次全失败（症状像"连不上"，其实只是没带 `--status`）。
8. **多行内联脚本经 `pwsh → wsl.exe --` 会被"逐行拆成独立命令"执行**（与 §6.4 的 glob 假 0 是**两个不同的坑**；
   本条是 .mjs→.ts 迁移时为了写"自作用域残留探针"才量出来的，2026-10-10）：

   ```powershell
   # ✗ 多行：每一行都在**全新 shell** 里跑 ⇒ A 在第二行是空的
   Invoke-Wsl @'
   A=hello
   echo "A=$A"
   '@                       # 输出：A=
   # ✗ 同理，export PATH=… / cd … 都带不到下一行；实测 $0 = /usr/bin/zsh
   # ✓ 单行用 `;` 串联 = 同一个 shell
   Invoke-Wsl 'A=hello; echo "A=$A"'      # 输出：A=hello
   # ✓ 或者写成脚本文件再 `bash <file>`（run-spike.ps1 的 Start-SpikeDaemon 就是这么做的）
   # ✓ 或者 `bash -c "echo <b64> | base64 -d | bash"`（verify-shellenv.ps1 的做法）
   ```
   危害是**静默**的：探针里的多行 `for p in …; do … done` 会因为 `$p` 恒为空而"永远查不到东西"，
   于是"收尾零残留"变成**假绿**。规矩：**多行内联只允许放"每行自足"的 `echo "KEY=$(单行管道)"`**；
   任何需要 `export`/`cd`/循环/变量的逻辑，一律压成单行 `;` 串联，或落地成文件跑。

   > **Lead 实测勘误（2026-10-10，脚本内容统一为 `A=hello` / `echo "A=[$A]"` / `cd /tmp` / `pwd`）**
   > 结论**不改变该做的动作**，但**两处成因/推荐需要更正**，且**真因仍记为未定**：
   > | 形态 | 实测输出 |
   > |---|---|
   > | `wsl -- bash -c <多行字符串>` | `A=[]` 且 `/tmp` ⇒ **变量丢失，但 `cd` 生效** |
   > | `wsl -- bash -c 'A=hello; echo "A=[$A]"; cd /tmp; pwd'`（单行 `;` 串联） | **`A=[]`**（与上方"✓ 单行是同一个 shell"不符） |
   > | `wsl -- bash -lc 'bash -c "$(cat /tmp/d.sh)"'`（**全在 WSL 内**，不经 pwsh 传参） | `A=[]`；`bash -x` 显示**内层 bash 收到的已经是 `echo 'A=[]'`** ⇒ `$A` 在到达内层 bash **之前**已被展开 |
   > | `wsl -- bash -lc 'bash /tmp/d.sh'`（**落文件**） | **`A=[hello]` ✅ 唯一正确** |
   > - 文件字节用 `sed -n l` + `xxd` 确认**完好**（字面 `$A`），排除"文件被写坏"。
   > - **"每一行都在全新 shell 里跑"不成立**：同一脚本中 `cd /tmp` 是**生效**的（`pwd`=`/tmp`），若每行新 shell 则不可能。
   > - ✅ **机制已定案（2026-10-10 17:1x，Lead 亲测 + 实现者独立侧证）**：`wsl.exe … -- bash -c "<内联脚本>"` **不是 argv-exec** —— 内联串会先由**发行版默认登录 shell**（本机 **zsh**）执行，所以 `bash -c` 里的 `$VAR` 与 glob 都在到达 bash **之前**就被 zsh 处理掉了。三条实测（同一脚本 `i=5; echo "i=$i"`）：① `wsl -- bash -c '…'` ⇒ **`i=`**；② 落文件 `bash <file>` ⇒ **`i=5`**；③ `bash -c 'echo "$0 $ZSH_VERSION $BASH_VERSION"'` ⇒ **`$0=/usr/bin/zsh`、`ZSH_VERSION=5.9`、`BASH_VERSION` 空**（跑的根本不是 bash）。`for d in /proc/[0-9]*` 同理：内联 **空计数**、落文件 **72** —— 统一解释了"glob 假 0"与整类内联假绿。
   > - **稳定可用的两种形态**：① 写文件 + `bash <file>`（本文件 §6.5 与插件 `writeScript` 的做法）；② `bash -c "echo <b64> | base64 -d | bash"`（payload 走 stdin，不经 argv 展开，`verify-shellenv.ps1` 的做法）。**其余内联形态（含单行 `;`）都可能失真**。
   > - **纪律**：内联跑任何带 `$` 的探针前，先证明 payload 原样到达（例如 `sed -n l` 或回显长度）；一旦某探针"干净得可疑"，先怀疑传参而不是先庆祝。
   > - 附带：本发行版 PATH 上 **`od` 被别的工具占用**（`od -c` 报 `unknown option: -c`）⇒ 看字节用 `sed -n l` / `xxd`。

## 7. 要把它接进插件，需要改哪些点（**只分析，未改动任何插件文件**）

1. **`lib/index.js` 的 `SdkRuntime` 拆成"宿主无关的运行时客户端 + 两种宿主"**：
   `daemon-client`（新默认，连 127.0.0.1）与 `in-host`（现状，保留作 fallback）。`WslAgent` 对外的
   `prompt(key, text)` 签名不变，但 `sessionId` 不再由插件 `randomUUID()` 生成（改由守护/status 提供）。
2. **新增守护入口（建议 `lib/daemon.ts`，即 `spike/daemon.ts` 的收敛版）与启动器**：
   探测（连端口 → `status`）→ 不在则 `wsl.exe -d <distro> -u <user> -- bash <启动脚本文件>` 起 → 轮询就绪 → 记 pid/端口。
   复用现有 `writeScript()` / `unc()` / `reapWsl()` 模式；**注意别再犯"内联拼接命令行"**（§6.4/6.5）。
3. **端口与发现**：默认端口要与 `webPort`(3082) 错开；需要"写端口/pid 到 WSL 侧固定文件（如 `~/.dsh/remote-wsl/daemon.json`）→ 客户端读它发现端口"，
   以及占用时的回退（否则第二个宿主/第二个守护会互相抢）。
4. **单实例 + 幂等**：已有守护则复用（不能每次调用都起一个），并用 `status.daemonPid` 做存活判据。
5. **版本一致性（对应现有 `wsl_sync_version` / pin）**：守护持有的运行时是**某个** `@deepseek-ai/dsh@<version>`。
   桌面版本漂移时要么重启守护，要么按版本多实例；`status` 需带 `version` 并与 `~/.dsh/.desktop-version-pin` 比对报警
   —— 否则会出现"守护跑的是旧版本"的静默漂移。
6. **安全**：加 per-daemon token（握手行 `{"op":"hello","token":…}`，token 只存 WSL 侧 0600 文件），
   或至少校验来源；本 spike 故意不做以最小化变量。
7. **生命周期**：插件 `dispose`（宿主退出/停用）**不应**杀守护，否则跨宿主复用又没了；
   但需要显式的"停止守护"工具/按钮（对应 `wsl_status` 暴露 pid/端口/keys），否则用户没法收回资源。
8. **环境注入位置**：`shellPreamble()`（PATH + 代理探测）应只在**守护启动时**注入一次；
   `shellEnvSnippet`（登录 shell 环境）同理——从"每个运行时一次"变成"每个守护一次"，能省掉每 key 一次登录 shell 的开销。
9. **客户端健壮性**：Windows 侧必须处理 `ECONNREFUSED`（守护不在/挂了/发行版重启）→ 自动起守护 + **重试一次**；
   以及 `ok:false`（§5.3 无正文）时的重试语义。
10. **完成判定的兜底要对齐**：`lib/index.js` 现有"停稳运行时 + 读持久化 zstd 日志"的兜底在守护形态下**不能照搬**
    （读日志要换新 sessionId ⇒ 必然丢上下文）。建议改为：本轮 `ok:false` 时**保持运行时不动**，只回报错误。
11. **`status` 语义进工具**：`wsl_status` 需要显示守护 pid/端口/`keys[]`（key/sessionId/turns/runtimePid/idleForMs），
    这样"关掉客户端再回来仍记得"对用户是**可见**的，而不是口头承诺。
12. **多客户端共享**：本 spike 已验证两个客户端进程顺序共享一个 key；但**并发**（两个客户端同时 prompt 同一 key）
    只是守护内串行排队，语义（谁先谁后、是否要拒绝第二个）需产品定义。

## 8. 未验证项（不要把未验证说成已验证）

* 守护被 kill / `wsl --shutdown` 后 Windows 侧的自动恢复（§5.4）——只测到 `ECONNREFUSED` 现象。
* 运行时 OOM/被杀后守护重建新 sessionId 的路径（§5.2）——只审了代码路径，没有构造该故障。
* 事件流缺正文时的兜底（§5.3）——本次 5 轮全部命中 `turn/end`，没触发。
* >2 个 key 的并发、单 key 并发 prompt 的排队语义、长任务（工具调用多轮 step）的完成判定。
* 桌面版本漂移下的守护行为（§7.5）。
