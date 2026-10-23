# task-1 验收：吸收 ZCode 的释放/探测纪律（host 侧）

> **2026-10-22 review 后追加（同轮提交）**：本轮代码在 review 后被改过三处，本报告的数字是**修后**的
> （`probe-daemon-gateway` 33/33、`probe-wsl-proxy` 29/29、`probe-wsl-io-lifecycle` 24/24、
> `probe-lifecycle-grace` 26/26）：
> 1. `daemon.ts` 的网关**来源戳**改成与取值同一条命令（`GW_SRC=route|resolv`），不再事后 `ip route … | grep -q .`
>    猜（那条猜法遇到 `default dev eth0` 无 via 时会把 resolv 的候选误标成 route，绕过私有/链路本地校验）；
> 2. 校验（loopback 拒、resolv 只收私有/链路本地）从 `parseGatewayOutput`（生产路径没人调用）**下沉进 shell 片段**，
>    宿主 `shellPreamble` 与 daemon 共用同一段；探针在**真 bash** 里跑了 6 组候选；
> 3. 宿主 shell 的代理导出改成**先试 127.0.0.1 再退网关**（mirrored 网络下以前会判"网关不可达"而白直连）。
> 另：`decodeWslOutput` 的两份实现已合并到 `src/wsl-output.ts`（`wsl-io` / `explorer` 都从它取）。

- **日期**：2026-10-22 ｜ **仓库**：`D:\project\dsh1\dsh-remote-wsl` ｜ **起点 HEAD**：`323a695`（工作区干净）
- **写域**：`src/lifecycle.ts`、`src/wsl-io.ts`、`src/daemon.ts`、新建 `spike/verify/zcode-20261022/**`
  （另按 Lead 指示改了 1 条既有探针断言，见 §5）
- **参考实现**：zai-org/ZCode `packages/server/src/remote/wsl-backend.ts`（427-507 disposeAndWait /
  459-507 trackOwnedChild / 643-669 execWslForBuffer）、`wslProxy.ts`（网关候选与私有/链路本地判据）、
  `closeEvent.ts`（晚订阅补发）
- **未提交**：按 Lead 要求不做 `git add` / `git commit`

## 1. 改动清单

| 文件 | 改动 | 一句话 |
|---|---|---|
| `src/lifecycle.ts` | +179/−51 | settle 改成 ZCode 的两段式释放：先 `stdin.end()` → 宽限 300ms → 只 kill 归属表里仍在的 → kill 后等 250ms；settle 幂等（in-flight promise）；归属表改 Map 且 `exit`/`error`/`close` 三事件结算；`timedOut`（总预算耗尽）与 `forced`（真走 kill 分支）语义分离；导出 `activeLifecycle()` 供 wsl-io 取"当前关停屏障" |
| `src/wsl-io.ts` | +89/−15 | `runWsl` 的短命 wsl.exe 全部 `lifecycle.track()`；spawn 前问一次关停屏障（关停态返回 127 + E_SHUTDOWN 文案，`allowDuringShutdown` 只给 reap/清扫等收尾路径）；输出改"收 Buffer → NUL 判码 → 去 NUL/BOM/CR"；`wslPathConvert` 在 `spawnSync` 前 `assertAlive` 且用 buffer + 8MB 上限；导出 `decodeWslOutput/normalizeWslOutput/readWslOutput/WSL_EXEC_MAX_BUFFER` |
| `src/daemon.ts` | +112/−13 | 守护自己的网关/代理探测统一：**先试 `127.0.0.1:<port>`**（mirrored 网络照样用 loopback）→ 否则 `ip route default via` → `/etc/resolv.conf` nameserver 回落（私有/链路本地才算）→ 探活 3s 改 1s；片段从 `wsl-proxy.ts` 逐字复制并以源码级探针防漂移；IPv6 地址放进 URL 加方括号；删掉上一版实现的残尾（`gw` 变量 + 第二处 `NODE_USE_ENV_PROXY`） |
| `spike/verify/wsl-parity-20261022/probe-lifecycle.ts` | +10/−1 | **按 Lead 要求**把 1 条断言从 `timedOut` 改为 `forced`（理由见 §5） |

## 2. 新增探针与产物（`spike/verify/zcode-20261022/`）

| 探针 | 断言数 | 覆盖 |
|---|---|---|
| `probe-lifecycle-grace.ts` | 26 | 优雅优先（stdin.end）；宽限到点才 kill 且 kill 后等退出；kill **只**作用于登记 child；总预算 5s 内（300+250≈550ms）；settle 幂等（同一 promise、只 kill 一次）；**晚订阅竞态**（child 先退出、20ms 后才 settle ⇒ 立即返回而不是白等）；`exit`/`error`/`close` 三事件结算；ambient 指向最新实例；E_SHUTDOWN / track(null) / 已退出不登记 不回退 |
| `probe-wsl-io-lifecycle.ts` | 24 | 真实 WSL：`runWsl` spawn 后立即进归属表、settle 等到自然退出、宽限后 kill 掉短命子进程；关停态拒绝 spawn（127 + E_SHUTDOWN，0ms）且归属不增；`allowDuringShutdown` 收尾仍能跑；`wslPathConvert` 关停后抛 E_SHUTDOWN；解码（CR/NUL/BOM、UTF-16LE 判码、中文 UTF-8、与 `explorer.decodeWslOutput` 一致、裸 NUL 边界钉住）；超时仍 124；源码级接线 6 条 |
| `probe-daemon-gateway.ts` | 32 | 源码级逐字比对（发现片段 = `buildGatewayShellLines()`、`parseGatewayOutput`/`isLoopback`/`isPrivateOrLinkLocal` 与 wsl-proxy 逐字相同、探活 1000ms）；10+ 组候选输入行为逐条一致；探活命中本地监听 = true、不可达地址 1s 超时 = false；**用假的 `net.connect`/`execFileSync` 跑 `resolveProxyHost` 五条分支**（loopback 通/仅网关通/都不通/无网关/端口 0）；真实 WSL：daemon 发现脚本产出 `route=172.30.176.1` 且与 wsl-proxy 片段同一个网关；daemon.ts 由 WSL 侧 node 起得来并自退；`node --experimental-strip-types --check` 通过 |

产物：`out-lifecycle-grace.json`、`out-wsl-io-lifecycle.json`、`out-daemon-gateway.json`。

## 3. 命令 + 退出码 + 关键输出

node：`C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24.21.0）
WSL：`debian-u8-1`（NAT 模式；WSL 侧 node v26.10.0）

```
node spike/verify/zcode-20261022/probe-lifecycle-grace.ts            exit=0  26/26 PASS
node spike/verify/zcode-20261022/probe-wsl-io-lifecycle.ts           exit=0  24/24 PASS
node spike/verify/zcode-20261022/probe-daemon-gateway.ts             exit=0  32/32 PASS
```

关键单条输出（原样）：

```
PASS 超过宽限但 kill 后干净退出 ⇒ forced=true 且 timedOut=false
     —— {"waitedMs":341,"killed":1,"remaining":0,"timedOut":false,"forced":true}
PASS 真的关不干净 ⇒ timedOut=true 且 remaining>0
     —— {"waitedMs":552,"killed":1,"remaining":1,"timedOut":true,"forced":true}
PASS 晚订阅：settle 在已退出的 child 上立刻返回（不白等）
     —— elapsed=0 report={"waitedMs":0,"killed":0,"remaining":0,"timedOut":false,"forced":false}
PASS runWsl spawn 后立刻进归属表  —— size=1
PASS settle 宽限后 kill 掉短命子进程（forced=true，kill 后干净退出 ⇒ timedOut=false）
     —— elapsed=169 {"waitedMs":169,"killed":1,"remaining":0,"timedOut":false,"forced":true}
PASS 关停后 runWsl 拒绝并返回 E_SHUTDOWN  —— exit=127 ms=0
PASS 收尾路径 allowDuringShutdown 仍能执行  —— {"exitCode":0,"stdout":"cleanup-ok",...}
PASS wslPathConvert：关停后抛 E_SHUTDOWN  —— E_SHUTDOWN
PASS 网关发现片段与 wsl-proxy.buildGatewayShellLines() 逐字一致
PASS 探活超时 3s ⇒ 1s  —— 1000ms vs wsl-proxy 1s
PASS 探活：不可达地址按 1s 超时返回 false（不再是 3s）  —— elapsed=1013ms
PASS 分支①loopback 通 ⇒ 用 loopback 且不退回网关  —— {"host":"127.0.0.1","source":"loopback"} calls=["127.0.0.1:9910"]
PASS 分支②loopback 不通但网关通 ⇒ 用网关  —— {"host":"172.30.176.1","source":"route"} calls=["127.0.0.1:9910","172.30.176.1:9910"]
PASS 真实 WSL：daemon 发现脚本产出带来源标注的候选  —— route=172.30.176.1 ⇒ {"host":"172.30.176.1","source":"route"}
PASS 真实 WSL：daemon 与 wsl-proxy 发现同一个网关  —— daemon="172.30.176.1" proxy="172.30.176.1"
PASS 真实 WSL：daemon.ts 由 WSL 侧 node 起得来  —— exit=0 listening 127.0.0.1:9101 … 
     "无 key 且无客户端 1ms ⇒ 守护按寿命闸门自退"（--linger-ms 1，非长期服务；端口 9101 避开 8911-8990）
PASS daemon.ts 没有残留的 gw 变量
PASS buildRuntimeEnv 只有一处设置代理环境变量  —— x1
```

静态检查（Lead 要求的第 1 步）：

```
node --experimental-strip-types --check src/daemon.ts   exit=0
node --check src/daemon.ts                              exit=0
Select-String -Path src\daemon.ts -Pattern '\bgw\b'     ⇒ 无命中
Select-String -Path src\daemon.ts -Pattern 'NODE_USE_ENV_PROXY' ⇒ 1 处（第 284 行附近）
量具红能力自检：对含残留 `} else {` 的临时 .ts 跑 --check ⇒ exit=1 SyntaxError（证明该门禁真的能红）
```

## 4. 既有门禁复跑（改动前 → 改动后，数字只升不降）

| 门禁 | 改动前 | 改动后 |
|---|---|---|
| `probe-lifecycle` | 9/9 | **9/9**（1 条断言判据改 `forced`，见 §5） |
| `probe-webhost-lifecycle` | 5/5 | **5/5** |
| `probe-wsl-proxy` | 18/18 | **18/18**（真实 WSL：`GATEWAY=172.30.176.1`） |
| `probe-host-distro` | 21/21 | **21/21**（proxy 段仍 `172.30.176.1:9910 reachable`） |
| `probe-wsl-detect` | 11/11 | **11/11** |

既有门禁的 `out-*.json` 因复跑被刷新（generatedAt / 实测值），属预期。

## 5. 判据变更（如实记录，不为了凑绿）

Lead 复核指出：`settle()` 返回的 `timedOut` 若定义为"宽限期没等到"，则**任何超过 300ms 才退的子进程**都会让
`index.ts:286` 打出「关停超时」——而它随后在 250ms 内干净退出，属于**误导性日志**。已改为：

- `timedOut` = **总预算耗尽**（settle 返回时仍有登记未退出，`remaining > 0`）——`index.ts` 的日志按它判，干净关停不再误报；
- `forced` = **真的走了 kill 分支**（宽限期没等到）。

对既有 `probe-lifecycle` 的影响：第 5 条用例（`settle(80)` + FakeChild 一 kill 就退出）在新语义下
`timedOut=false`。据此把该条断言改为 `report.forced === true && report.timedOut === false && report.killed === 1 && child.killed === true`
——**不是放宽**：既钉住"确实走了 kill 分支"，又额外钉住"干净关停时 timedOut 必须为 false"（防止日志误报回潮）。
断言数仍 9。

## 6. 未验证 / 已知边界 / 风险

1. **mirrored 网络下的 loopback 分支未在本机真跑**：本机 `wslinfo --networking-mode = nat`，WSL 内
   `127.0.0.1:9910` 实测 unreachable ⇒ 真机走的是网关分支。loopback 先行分支只由"注入假 `net.connect`"的
   行为断言覆盖（源码顺序 + 分支结果），**未在 mirrored 实例上端到端验证**。
2. **daemon 的代理 env 注入未真跑一次 prompt**：`buildRuntimeEnv()` 是懒加载（首次 prompt 才执行）；
   守护启动检查只覆盖 listening/自退/语法，网关分支由注入假依赖的行为断言覆盖。真实"起了守护 + 跑一轮
   prompt + 看 `NODE_USE_ENV_PROXY` 生效"未验证。
3. **宿主进程里的 dispose 全流程未端到端跑**：settle 的宽限/幂等/晚订阅只在探针（假 child）+ 源码级验证；
   未在真实 DSH 宿主退出/窗口关闭时观测"干净关停不误报日志"。
4. **已知边界（与 ZCode 同一启发式）**：UTF-8 流里出现裸 NUL 会被判成 UTF-16LE 而解坏。我们的 WSL 命令
   输出不含裸 NUL；该边界已用断言钉住（`probe-wsl-io-lifecycle.ts`）。
5. **ambient lifecycle 是进程级单例**（`createLifecycle()` 自动成为 `activeLifecycle()`）：同进程并存多个
   插件实例时，只有最新的那份收到 `runWsl` 短命子进程登记。真实宿主是单实例，无影响；探针里显式 set。
   之所以用单例：`runWsl` 的调用点散布在 `register-tools/index/daemon-*`（本轮写域之外），无法逐点补形参。
6. **`wslPathConvert` 用 `spawnSync`**（Node 不暴露 child 句柄）⇒ 只能做 spawn 前 `assertAlive`，
   **无法**登记进 settle；其最长 20s，属一次性只读转换。
7. 未做（本轮明确不做）：窗口级池化、守护侧 gateway 结果的进程内缓存、IPv6 网关的 URL 化以外的兼容验证。
8. 端口：8911–8990 段内**没有**本任务起的监听；实测 8917 被 `DeepSeek Harness`（PID 46268，16:18:50 启动）占用
   ——非本任务所起，未触碰。WSL 侧无遗留 `/tmp/dsh-probe-daemon-*`、无 910x 监听、无孤儿 `sleep`。
9. 工作区里另有 `spike/verify/ui-20261022/`（未跟踪）**不是本任务产物**，未触碰。

## 7. diff 规模

```
src/daemon.ts                      +112 −13
src/lifecycle.ts                   +179 −51
src/wsl-io.ts                       +89 −15
spike/verify/wsl-parity-20261022/probe-lifecycle.ts  +10 −1   （判据调整，Lead 指示）
spike/verify/zcode-20261022/       新增 3 探针 + 3 out + 本报告
```

---

## 2026-10-23 review ⑤/⑥：网关字符集白名单 + 热重载认领

- **⑤ 字符集白名单**：`GATEWAY` 最终会进 `bash -c "…/dev/tcp/$GATEWAY/9910"`（双引号里仍会展开 `$(…)`），
  而 `route` 来源此前只挡 loopback、不过字符集。现加一条 `case "$GATEWAY" in *[!0-9a-fA-F:.]*) GATEWAY= ;; esac`
  （daemon 片段逐字同步），挡掉 shell 元字符与 IPv4-mapped 之类非规范形状。`probe-wsl-proxy` 29→**33**
  （新增 `zzz` 两例拒绝、`fe80::1` / `fd00::1` 保留）。
- **⑥ 热重载认领**：`ambientLifecycle` 是进程级单例，插件重新 apply 时旧实例 spawn 的包装层没人等。
  新增 `adoptPreviousLifecycle(previous)`：`beginShutdown()` + `settle(1000)`，幂等，只结算旧实例自己登记的
  子进程；`index.ts` 在建新屏障前调用。`probe-lifecycle-grace` 26→**34**（新增 8 条：返回 promise、进入关停态、
  子进程被结算、二次认领返回 null、null/非法参数安全）。
