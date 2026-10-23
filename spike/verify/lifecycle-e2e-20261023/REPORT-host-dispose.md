# REPORT —— 宿主退出 e2e（2026-10-23）

> 目录：`spike/verify/lifecycle-e2e-20261023/`
> 关联：`docs/handoff-2026-10-22.md` §5.10 / §6.6；会话级交接 `D:\project\dsh1\HANDOFF.md` §Next Steps 2
> 结论一句话：**真宿主走完了 dispose，settle 没有伪超时、没有残留、退出码与耗时都对**；顺带用真 wsl.exe child
> 把「宽限 → kill → 确认退出」压了一遍，并抓到一个**伪成功缺陷**（已修）。

## 1. 为什么要做

`docs/handoff-2026-10-22.md` §5.10 一直挂着一条："宿主的真实退出流程仍未端到端观测 —— settle 的宽限/幂等/晚订阅
只有假 child 探针 + 源码级断言"。这条之所以重要：关停屏障是"客户端退出后 WSL 侧不留孤儿"的唯一保证，
而假 child 证明不了三件事：

1. 真宿主 dispose 时 `settle` 到底看到几个 child、会不会误判 `timedOut`（index.ts 会据此打「关停超时」）；
2. `/tmp/dsh-rwsl-<winpid>-*` 与 wsl.exe 子进程在真退出后是否真的清零；
3. 真 wsl.exe 包装层被 `settle` kill 时，调用方拿到的是什么（这一条抓到了缺陷，见 §5）。

## 2. 环境与隔离

| 项 | 值 |
|---|---|
| 隔离 home | `%TEMP%\rwlife-1023-home`（`profiles\rwlife1023`，跑完删除） |
| 插件来源 | `node_modules\dsh-remote-wsl` = junction → `D:\project\dsh1\dsh-remote-wsl`（量的是**工作区当前字节**） |
| 组合 | `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-remote-wsl`（**不碰** desktop profile） |
| 端口 | 实例 8917、CDP 9555（都不在插件守护号段 8911–8990 内） |
| 发行版 | `debian-u8-1`（Running，NAT） |
| 额外 env | `DSH_REMOTE_WSL_DIAG=1`（打开 disposer 的「关停结算」诊断行）、`DSH_TELEMETRY_DISABLED=1` |

纪律：**没起替代 GUI 服务器**（用户 61491 的桌面 GUI 全程未动，探针里还专门断言它仍在听）；跑完 8917/9555 无监听。

## 3. 触发方式：为什么是 CDP 而不是 Ctrl+C

`dsh` 的优雅退出路径是 `process.on('SIGINT')`（`profile-boot` 的 `createProcessShutdown`）。
桌面壳 CLI 在 Windows 上通过 koffi 注册 `SetConsoleCtrlHandler`，把 `CTRL_C_EVENT` 转成
`process.emit("SIGINT")`（`@deepseek-ai/dsh-desktop-host/lib/cli.js` 的 `installWindowsCliSignals`）。

本来想"真送一个控制台事件"，三条路线**本机实测全部失败**（`out-host-dispose.json` 的 `notes.ctrlC`）：

| 路线 | 结果 |
|---|---|
| 私有隐藏控制台（`FreeConsole`→`AllocConsole`→`ShowWindow(SW_HIDE)`）+ 子进程继承 + `GenerateConsoleCtrlEvent(CTRL_C,0)` | `GetConsoleProcessList` 证明 cmd/ping 子进程**确实挂在该控制台**、`GenerateConsoleCtrlEvent` 返回 **TRUE**，但子进程一个都不退 |
| 同一路线换 cmd/ping、换 stdin/stdout/stderr 重定向组合 | 同上 |
| 改投 `CTRL_BREAK` | 反而把**发送方自己**打断了（`SetConsoleCtrlHandler(NULL,TRUE)` 只忽略 `CTRL_C`） |

所以本探针改用 **CDP（`--inspect`）**：`Runtime.evaluate("process.emit('SIGINT')")`。
这与 cli.js 控制台处理器调用的是**同一句**，下游（`profile-boot` → `shutdown` → `fiber.dispose` → 本插件
disposer → `settle`）完全一致；差别只在"谁先收到控制台事件"。**本报告不把它说成按了 Ctrl+C**，
JSON 里 `trigger.kind = "cdp-inspect"` 也如实标注。

## 4. 判据与结果

### 4.1 `probe-host-dispose.ts` —— 27/27

| 组 | 判据 | 实测 |
|---|---|---|
| A0–A2 | 端口空闲、隔离 profile 建立、junction 指向工作区 | 通过 |
| A3–A5 | launch URL、HTTP ready、插件在真宿主里 apply（数据面注册行） | readyMs≈1.9s，HTTP **303**（首页跳转） |
| B1–B3 | GET 方法清单 7 个、`explorer.snapshot`、`explorer.listDir /home/g` 真跑通 | 通过（真 WSL 数据面） |
| C2 | CDP 触发 SIGINT，`process.emit` 返回 true（有监听者） | 通过 |
| C3–C5 | 9s 内退出、exit code **130**、关停 **157ms**（< 5s forceExit 预算） | 通过 |
| D1–D8 | 「关停结算」诊断行可解析；`timedOut=false`、`remaining=0`、`waitedMs∈[0,5000]`；有「宿主退出」；**无**「关停超时」；无「认领旧关停屏障失败」；tracked 与观测自洽 | `tracked=0 waitedMs=0 killed=0 remaining=0 timedOut=false forced=false` |
| E1–E6 | `/tmp/dsh-rwsl-<hostpid>-*` 清零、WSL 侧无该 pid 脚本进程、无 wsl.exe 子进程、宿主 pid 不在、8917/9555 释放、用户桌面 GUI（61491）未受影响 | 全部通过 |

### 4.2 `probe-real-child-settle.ts` —— 15/15

用**真** `runWsl('sleep 5')` ×2（真 wsl.exe + 真 `/tmp` 脚本）+ **真** `createLifecycle()` + **真** `settle(5000)`：

| 判据 | 实测 |
|---|---|
| 起两个真 child（/tmp 2 个脚本、2 个 wsl.exe 子进程）、settle 前 `size=2` | 通过 |
| `forced=true`（5s 脚本不可能在 300ms 宽限内自退）、`killed=2`、`remaining=0`、`timedOut=false` | `waitedMs=315` |
| 关停态 `runWsl` 返回 `127 + E_SHUTDOWN`（不再新建运行时） | 通过 |
| 两个 promise 都结算、被 kill 的包装层 `exitCode=1`（修完后的语义） | `codes=1,1` |
| 关停后本 pid 的 `/tmp` 脚本清零、`sweepOwnTempFiles` 不抛 | 通过 |
| Linux 侧残留（观测值，不当通过条件） | `rightAfterSettle=0 after6s=0` |

## 5. 本轮抓到的真缺陷（已修）

**现象**：`probe-real-child-settle` 第一轮 13/14，失败项是「被 kill 的包装层 exitCode 非 0」，实测 `codes=0,0`。

**根因**：Windows 上 `child.kill()` 之后 Node 给的是 `code=null + signal='SIGTERM'`（独立小实验实测），
而 `runWsl` 的 `finish(code)` 写的是 `exitCode: code ?? 0` ⇒ 被关停杀掉的 `wsl.exe` 被记成 **成功 + 空输出**。
这是典型的**伪成功**：关停瞬间在飞的 `wsl_exec` 会拿到"成功但没输出"，而不是"被中断"。

**修复**：`src/wsl-io.ts` 改为 `exitCode: code ?? (child.signalCode ? 1 : 0)`，按失败记 1；由 `B5c` 钉住。
影响面：只有"被信号结束"这一种情形从 0 变 1；正常退出/超时(124)/abort(130)/spawn 失败(1) 全部不变，
既有 10 个探针复跑全绿（见 §7）。

## 6. 仍未覆盖（如实）

1. **真宿主 + 在途登记 child 的组合**：本轮 e2e 的 `tracked` 恒 0 —— 面板数据面（distro facts / 代理探测 / 守护扫描）
   全部走 `execFile` / `spawnSync`，**不登记 lifecycle**。要在真宿主里造在途 `runWsl`，只能调工具（花模型额度）
   或起守护（占 WSL 资源、还可能和用户槽位打架）⇒ 本轮不做，已在两条探针的头部与 README 写明。
   settle 的宽限/kill 分支由 `probe-real-child-settle`（真 child、无宿主 ctx）与 `probe-lifecycle-grace`（假 child，34/34）覆盖。
2. **桌面 Electron 窗口的真实关窗**：本轮走的是 CLI 的 SIGINT；桌面壳的 quit 流程（Electron `before-quit` → host dispose）
   未单独观测，且重启桌面会打断用户会话，需人工验收。
3. **mirrored 网络**：本机 NAT，loopback 分支仍只有注入式断言。
4. **daemon 代理 env 真 prompt**：未跑（会消耗模型额度，需用户同意）。

## 7. 复跑

```powershell
$node='C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd D:\project\dsh1\dsh-remote-wsl
& $node spike/verify/lifecycle-e2e-20261023/probe-host-dispose.ts        # 27/27（约 12s）
& $node spike/verify/lifecycle-e2e-20261023/probe-real-child-settle.ts  # 15/15（约 15s，含 5s sleep）
```

回归（改动 `src/index.ts`、`src/wsl-io.ts` 后本轮已跑一遍，全绿）：
`panel-smoke 18/18`、`probe-layout 25/25`、`probe-host-distro 21/21`、`probe-wsl-proxy 33/33`、
`probe-lifecycle-grace 34/34`、`probe-wsl-io-lifecycle 24/24`、`probe-daemon-gateway 33/33`、
`probe-badge 63/63`、`probe-narrow 37/37`、`probe-origin-matrix 12/12`、`check-client-rev PASS`、
`count-i18n-keys paired(259/259)`。

## 8. 产物

| 文件 | 说明 |
|---|---|
| `probe-host-dispose.ts` / `out-host-dispose.json` | 真宿主退出 e2e（27 条判据 + `notes.ctrlC` 的控制台事件失败记录） |
| `probe-real-child-settle.ts` / `out-real-child-settle.json` | 真 wsl.exe child 的 settle 分支（15 条判据） |
| `out-instance-redacted.log` | 隔离实例的打码日志（**真 token 只在 `%TEMP%` 原始日志里**） |
