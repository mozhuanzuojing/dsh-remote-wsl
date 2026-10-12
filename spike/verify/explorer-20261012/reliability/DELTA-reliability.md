# DELTA —— task-6 复检报告（T8 修完 5 条 host 缺口后的独立复验）

- **复验者**：`reliability-keeper` ｜ **日期**：2026-10-12 16:33–16:53 ｜ **性质**：**独立第三双眼睛**（不照抄 T8 结论；全部用我自己的脚本判定，原始输出在盘）
- **被验对象（只读）**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **新锚点（我自算，与 lead 给的一致）**：[REVISION-observed-delta.txt](./REVISION-observed-delta.txt)
  - `src/explorer.ts` **a2c6b8b9…** 34,016 B ｜ `src/daemon-client.ts` **184f6b87…** 37,581 B ｜ `client/client.panel.js` **bb0a24ba…** 34,915 B ｜ `client/index.js` **62ab2f0c…** 14,841 B ｜ `client/client.api.js` 4f98663d…（未变）｜ `client/client.icon.js` e9a824f5…（未变）｜ `package.json` 36f70175…（未变）
- **活宿主 `19387` = pid 47564 未变** ｜ 端口 8971–8974 收尾全 free ｜ **未产生可见窗口**（见 §5）

## 1. 五条复检结论

| # | 缺口 | 判据（lead 指定） | 我的判定 | 证据 |
|---|---|---|---|---|
| **D1** | **F32** 路由残留 | 同一次 `registerExplorer` 内 inject 二次触发 ⇒ **dispose 后路由计数必须 = 0** | **PASS**（`1 → 0`；改前 `out-C-03` 是 `1`） | [out-D2-D1-F32-dispose-zero.txt](./out-D2-D1-F32-dispose-zero.txt) |
| **D1b** | 附带（T8 新增分支） | 两次回调拿到**不同** `webServer` ⇒ 新路由就位、旧路由被释放 | **PASS**（旧 0→0、新 1→0） | [out-D2-D1b-rebind.txt](./out-D2-D1b-rebind.txt) |
| **D2** | **F33** 槽位显示串台 | `running=false` + 别槽进 `others[]`（带 note）；`stop slot:<别槽>` ⇒ **400/E_ARG 且 pid 不变** | **PASS**（硬证明：`pid 962850 → 962850`） | [out-D2-D2-F33-slot-isolation.txt](./out-D2-D2-F33-slot-isolation.txt) |
| **D3** | **F15** 可诊断性 | inject 永不回调 ⇒ 出现降级日志（接缝 300ms）；正常回调 ⇒ **不得**出现 | **PASS**（A=true / B=false） | [out-D2-D3-F15-inject-warn.txt](./out-D2-D3-F15-inject-warn.txt) |
| **D4** | **F14b** 状态码一致 | 同一 ensure 失败路径 ⇒ `openSession` 与 `daemon` **都是 503** | **PASS**（两条都 `503/E_UNAVAILABLE`，错误原文确为 ensure 失败） | [out-D2-D4-F14b-status-parity.txt](./out-D2-D4-F14b-status-parity.txt) |
| **D5** | **F31** 文件权限 | 新起守护后 `launch-stderr.log` = **0600**，同目录其它仍 0600 | **PASS**（`stat -c %a`：目录 `700`、全部文件 `600`） | [out-D2-D5-F31-perms.txt](./out-D2-D5-F31-perms.txt) |

**汇总产物**：[out-D2-delta-summary.json](./out-D2-delta-summary.json)、[out-D2-main-console.txt](./out-D2-main-console.txt)、[out-D2-D4-console.txt](./out-D2-D4-console.txt)。

## 2. 关键原始输出

### D1 / D1b（F32）
```
routes: before dispose = 1（期望 1）｜after dispose = 0（**期望 0**；改前实测为 1）
verdict=PASS —— F32 已修（dispose 后路由归零）
旧 server routes: 0 → dispose 后 0 ；新 server routes: 1 → dispose 后 0   verdict=PASS
```
（T8 的实现：`registeredHere` 为**每次回调自己的**局部标志，`explorer.ts:639,662,668,675`；catch 里只在"本次确实注册成功过"时才清 `removeRoute`。）

### D2（F33）—— 含**动作面硬证明**
```
前置：配置槽位 8972 无守护；别槽 8973 已起守护 pid=962850
snapshot.daemon = {"running":false,"keys":[],"orphans":0,"others":[
  {"slot":8731,"pid":944726,...,"note":"非本槽位（configured daemonPort=8972）；未复用、未打扰"},
  {"slot":8973,"pid":962850,...,"note":"非本槽位（configured daemonPort=8972）；未复用、未打扰"},
  {"slot":8982,"pid":961517,...,"note":"非本槽位（configured daemonPort=8972）；未复用、未打扰"}]}
explorer.daemon stop slot=8973 ⇒ HTTP 400 code=E_ARG
  msg=remote-wsl: slot 8973 不是本插件配置的槽位（8973≠8972）；本插件只操作自己的槽位
别槽 pid: before=962850 after=962850 ⇒ 未变 = true（**硬证明**）
```
⇒ 三层都成立：**数据面**（只认配置槽位、不回落）、**动作面**（拒别槽 400/E_ARG 且别槽守护未被动）、**渲染面**（`client.panel.js:400-407` 把 `others[]` 渲染成**只读**区块，标题原文「其它槽位的守护（只读：本面板不会对它们发起任何动作）」，且**不为它们生成任何按钮**）。

### D3（F15）
```
A(不回调) 700ms 后 stderr=["remote-wsl(explorer): webServer 未就绪 ⇒ explorer.* HTTP 路由未注册（方法表仍可用）\n"]  ⇒ true
B(正常回调) 700ms 后 stderr=[已注册那行]                                                                              ⇒ false
verdict=PASS —— F15 已修（该日志只在永不就绪时出现一次，正常路径不打）
```
（接缝：`DSH_REMOTE_WSL_INJECT_WARN_MS=300`；实现 `explorer.ts:695-701`，`unref()` + inject 一到就 `clearTimeout`。）

### D4（F14b）
```
诱发方式：distro=debian-u8-1-__no_such_distro__（不存在）⇒ ensureDaemon 必然失败（**不占端口、不直接调 wsl.exe**）
explorer.daemon{ensure}        → HTTP 503 code=E_UNAVAILABLE
explorer.openSession{path:…}   → HTTP 503 code=E_UNAVAILABLE
两条错误原文相同，均为"远端守护在 Windows 侧不可达：试过端口 8972, 8973, 8974 …"
verdict=PASS
```
⇒ 不仅状态码一致，错误**原因**也确为 ensure 失败（排除了"无法确定 dsh 版本"这条 503 的冒充）。
> 说明：首跑我用"WSL 侧占端口"诱发，因参数绑定失败（`-File` 传 `-Ports 8972,8973,8974` 被当成单个字符串）而**未真正占住**，于是 ensure 成功、两条都 200 ⇒ 首跑判 FAIL 是**我夹具的错**；改用不存在的发行版后判定成立（该失败分支与端口被占是**同一条** `if (!r.ok) failUnavailable`）。

### D5（F31）
```
[dir]   700 /home/g/.dsh/remote-wsl
[files] 600 daemon.8731.json ｜600 daemon.8731.token ｜600 daemon.8972.json ｜600 daemon.8972.token ｜600 daemon.log ｜600 launch-stderr.log
```
⇒ **新起守护之后** `launch-stderr.log` 仍是 **0600**，同目录其它文件亦全部 0600，目录 700。
机制与 T8 的说法一致：Windows 侧 `openSync(...,'a',0o600)` 只对**新建**生效、且 UNC/9p 上的 `chmodSync` 实测无效（`daemon-client.ts:389-398` 注释），**最终靠 WSL 侧 launcher 里的 `chmod 600 …launch-stderr.log`**（`daemon-client.ts:332-335`）⇒ 所以文件 mtime 仍是旧的（未重写），但 mode 已是 600。

## 3. 裁断：**"面板更严、工具仍按发现语义"这个分裂是否留坑？**

**结论：可接受，且方向正确；但必须补两件小事（P1，非 P0 阻断），否则下一个验证者会按字面判它"两套数"。**

**依据（三条）**
1. **两者语义本就不同，不是"两套真相源"**：`daemonStatus()`（`daemon-client.ts:781-809`）是 **发现语义** —— 注释原文"`listDaemonSlots` 已把 `cfg.daemonPort` 排最前 ⇒ 优先报调用方自己槽位"，找不到才回落别的活守护，并**一并返回 `live` 全表**（供 `wsl_daemon stop all=true` 与孤儿回收使用）。`explorer.snapshot.daemon` 是 **所有权语义** —— 只认 `configuredSlot`。两者共用**同一个** `daemonSnapshot()` ⇒ 是"同源数据的两个选择器"，不是两份实现。
2. **它换掉的是 S1 级后果**：`live[0]` 回落时，面板的"停止 slot N"按钮会以**别人的槽位**为目标 ⇒ 跨实例误停 ⇒ 别人的守护被杀、其所有远程会话上下文丢失（T7 实测 `live[0]` 指到 8962）。**叙事上"面板更窄"的代价（少显示一个数字）远小于收益**。
3. **分裂是可见的，不是静默的**：`others[]` 逐条带 note（`非本槽位（configured daemonPort=8972）；未复用、未打扰`），面板渲染成只读区块且标题写明"本面板不会对它们发起任何动作"；动作面再拒一次（400/E_ARG）⇒ **纵深防御三层**。

**真实风险（必须说清，别当没看见）**
- **可诊断性错位**：配置槽位无守护、别处有时，`wsl_status` 会说"daemon 运行中 pid=…"（它回落到别人），面板说"daemon 未运行" ⇒ 同一次故障，两个界面两种话，运维/验证者会困惑。
- **设计稿 §8.6 的字面纪律被打破**：原文"面板上的每个数字都必须能在 `wsl_status` 找到同一个来源值" —— `daemon.running=false` 在 `wsl_status` 里**找不到**（它报的是别人的 running）。**T4 的差集比对若按字面跑，这条会红**，需要提前解释清楚，否则会被误判为回归。

**建议（都在 P1）**
- **a) 面板措辞说全**：状态条由 `daemon 未运行` 改为 `本插件槽位 8972 无守护（另有 N 个其它槽位的守护，只读）` —— 消除"整机没有守护"的误读。`client.panel.js` 已渲染 `others`，只差把这两个数字并进同一句话。
- **b) 把"同源"的定义写成"同一个 `daemonSnapshot()` + **明确的选择器**"**，并把 `others[]` 写进契约（README + 设计稿 §4/§8.6），显式记录**这是有意的收窄**。否则同一份纪律会在下一轮被当成缺陷。
- **c)（P2 备选）** 若想彻底消歧，把 `wsl_status` 的字段更名为 `discoveredDaemon`（**改名比改语义安全**），但要同步 6 个工具与 `selftest` ⇒ 建议留到下一轮，别在 P0 尾巴上动。
- **保留**：agent 面 `wsl_daemon action=stop all=true` 仍是唯一能碰别的槽位的入口（有 `/proc/<pid>/cmdline` 身份校验 + 限定本插件 state 目录）；面板不暴露它 —— 这条分裂是**设计意图**，不应改。

## 4. 我在本轮判错/做错的地方（自我更正，未做无痕修改）

1. **D3 首跑假 FAIL**：我的 `captureStderr()` 只包住**同步**调用，而那条日志是 `setTimeout` 里打的 ⇒ 捕获早已还原，日志落到真 stderr（控制台看得见）、captured 却是空 ⇒ 我误判 F15 没修。改为**跨 sleep 的捕获**后 PASS。
2. **D4 首跑无效**：`pwsh -File … -Ports 8972,8973,8974` 被解析成单个字符串 ⇒ 占用探针根本没起来，ensure 反而成功（两条 200），我据此判 FAIL 是错的；且那次 ensure **又起了一个 8972 守护**（lead 观察到的那只）。改用不存在的发行版诱发失败后 PASS。
3. **一条 `wsl.exe` 命令输出无效**：`Start-Process wsl.exe -ArgumentList …` 里含空格的 bash 片段被拆开，`ls ~/.dsh/remote-wsl/` 实际按无参 `ls` 执行 ⇒ 输出成了主目录列表。该条证据**作废**，改用 **UNC 直读**重取（这才是干净证据）。
4. **`Tee-Object` 与脚本写同一文件** → `EBUSY: resource busy or locked`（node 写、PowerShell 同时持有）⇒ 之后一律输出到不同文件。

## 5. 可见窗口：纪律执行与自查

- **用户投诉**（标题 `C:\Program Files\WSL\wsl.exe` 在刷守护日志）**已按其要求处置**。
- **代码证据：插件自己的起守护路径不产生控制台** —— `daemon-client.ts:403-406`：`spawn('wsl.exe', [...], { stdio:['ignore','ignore',stderrFd ?? 'ignore'], windowsHide: true, detached: true })`；`spawnSync` 亦有 `windowsHide: true`（`:199-201`）。
- **我的责任与修正**：投诉前我在**无控制台的 pwsh** 里直接 `& wsl.exe …`（Windows Terminal 是默认控制台宿主 ⇒ 会开可见窗口）。投诉后我的所有外部进程调用改为 **`Start-Process -WindowStyle Hidden`**（或留在后台 pwsh + 输出重定向到文件），**不再直接 `& wsl.exe`**；D4 干脆改成**不派生进程**的诱发方式。
- **自查结果（投诉后两次枚举，前后一致）**：窗口集合 = chrome / Code / Cursor / DeepSeek Harness / gephgui-wry / msedge / TextInputHost / **WindowsTerminal(36752, 标题 `C:\Program Files\WSL\\wsl.exe`)**。**我的运行未新增任何窗口**。
- **未处置项（非我所有，我不动）**：36752 仍在；当前 `wsl.exe` 里只剩 **p0-verify/T4 的两个 `launch.8932.sh` 包装层**（pid 45336/33296，其 state dir `daemon.8932.json` mtime 16:52:43 ⇒ 活跃）。该窗口**最可能属于仍在运行的 8932 那条**，**我没有关它**（纪律：不关用户/他人窗口）。**建议 lead 决定**是否让 T4 收掉 8932 的宿主与包装层 —— 那才是残留窗口的真源。
- **结论行（按要求）**：**未产生可见窗口** —— 启动方式：`Start-Process -WindowStyle Hidden`（wsl.exe）/ 后台 pwsh + 文件重定向 / 插件自身 `windowsHide:true + detached + stdio ignore`；投诉后两次窗口枚举前后一致，无新增。

## 6. 收尾核对

| 项 | 结果 |
|---|---|
| 我自己的 8972 守护 | 已停（`stopmine: slot=8972 ok=true`）；`launch.8972.sh` 包装层已清 |
| UNC 直读残留 | **含 8972 的文件数 = 0** ✅（state dir 只剩 8932 那套 + `daemon.log` + `launch-stderr.log`；无 `launch.*.sh`） |
| 端口 8971–8974 | **全 free** |
| 活宿主 `19387` | pid **47564** 未变 |
| 被验对象 | 全程只读（锚点见 [REVISION-observed-delta.txt](./REVISION-observed-delta.txt)） |
| 我起的占用探针 | **未成功启动**（参数绑定失败）⇒ 无需回收；确认无残留 |

## 7. 未复核项（本轮）

1. **真实 Cordis 下 inject 重放的真实触发条件**（D1/D1b 用桩证明"实现正确"，未证明框架会不会重放）。
2. **D4 的失败诱因与"真端口被占"**：两者走同一条 `if (!r.ok) failUnavailable`，但**端口真被占时的报文差异**未在真宿主复现（本轮未占端口）。
3. **`others[]` 在极端场景的规模**（会话很多守护时面板可读性）——属可用性，归 T5。
4. **36752 窗口的归属**未 100% 坐实（只能证明"不是我的 8972 包装层"，因为它在我清掉自己的包装层之后仍存在）；未关闭任何窗口。
