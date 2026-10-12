# 回答 lead ②：17:44:10 的 `launch.8731.sh` **不是我起的** ＋ 证据与"被证伪的假设"

## 结论

**不是我。**（"我"= 本账号 `p0-verify` 的 T14 运行）

## 证据（4 条，都可复算）

1. **槽位账本**：我所有配置/探针的守护槽位都是 **8932 / 8934 / 8935**，从不使用默认 8731：
   - `boot-testhost.ps1:17` `[int]$DaemonPort = 8932`；`probe-f32-f15.mjs:13 daemonPort: 8932`；`probe-wsl-path.mjs:23 daemonPort: 8932`；
   - T14 副本 profile 显式 `daemonPort: 8934`（RED-a）；T10 基线 `-DaemonPort 8935`（且该 profile 不含插件）；
   - `8731` 在我全部产物里**只作为"别槽位观察"**出现（`otherSlotDaemons` / `others[]`），从未作为我的目标槽位。
2. **我的运行窗口起点**：T14 正式 GO 于 **17:49:33** 到达，我的第一个外部进程在**那之后**才启动（账本 pid 43040/48636/34592，见 `out-82-*.md`）。
   17:44:10 **早于**我的窗口 ⇒ 该包装层与窗口都落在我的窗口之外。
3. **peer pid 对不上**：`daemon.log:2255-2257` 显示拉起/访问 8731 守护的 Windows 侧对端是 **`win-pid-44496`**（17:44:11）。
   对照法证：我 T10 宿主的子进程在对端位置出现的是 `win-pid-51136`、我 T14 宿主出现的是 `win-pid-42216`
   ⇒ 该字段记录的是**发起连接的 Windows 进程（我宿主的子进程）**，而 `44496` **不在我的任何账本里**。
4. **我 17:44 在做什么**：那一轮是 T14 预备（`--dump-config-schema` ×3 + registry 只读抓取 + 字节扫描），**全部是 compose/读文件**，不挂载、不起守护。

## 被证伪的假设（按 CLAUDE.md 要求记录，避免重走弯路）

**假设 H1**："我自己那次 `--dump-config-schema remote-wsl-test`（该 profile **没有** `daemonPort` 覆盖 ⇒ 默认 8731）挂载了插件并触发 `backgroundWarm` 自动 ensure，从而起了 8731 这个守护。"
**证伪证据**：我的三次 schema dump 里，第一个 profile 是 `remote-wsl-test-web`（`daemonPort: 8932`）。
若 schema dump 会触发自动 warm/ensure，**8932 上必然出现一个守护**；而 `daemon.log` 显示：
`pid=993515` 于 `08:58:44Z`(16:58:44) 起、`09:00:49Z`(17:00:49) 收到 shutdown 退出，
**下一个 8932 守护是我 17:53:53 的 route ensure 新建的 `pid=1033761`（fresh，非 adopt）**
⇒ **17:00:49Z–17:53:53Z 之间 8932 上没有任何守护（覆盖整个 17:44 窗口）** ⇒ schema dump 不启动守护 ⇒ H1 不成立。

## 我自己的启动方式（用于"未产生可见窗口"的自查）

- 我起的每个外部进程：`Start-Process -WindowStyle Hidden`（脚本里 `Start-Process` 共 2 处，都带 Hidden）或**留在当前后台 pwsh 里 inline + stdout/stderr 重定向**；
- 守护一律走插件自身路径（route `explorer.daemon{ensure}`），**从不**手工 `Start-Process wsl.exe … launch.<slot>.sh`。
- 插件自身的启动路径**本应无窗口**：`daemon-client.ts:199-201`（`spawnSync('wsl.exe', …, { windowsHide: true })`）、
  `384-406`（`launchDaemon`：`spawn('wsl.exe', …, { stdio:['ignore','ignore',stderrFd], windowsHide:true, detached:true })`）。

## 生产者：已坐实（原判断已被**证伪**，留档）

原文这里写的是"**更可能是某个以带控制台方式启动 `wsl.exe … launch.<slot>.sh` 的操作者**" —— **该假设已被证伪**。

**已坐实结论（2026-10-12 追加更正）**：17:44:10 那个可见窗口的生产者 = **插件自身的 `ensure` 路径（F-37）**。交叉证据：

1. `client-panel` 的追补 `ADDENDUM-T13-window-audit.md` **承认**：17:44:10 那次是它在 T13 回归里**点了面板的「启动守护」**（真 host `explorer.daemon ensure`），**宿主 pid = 44496**；
2. 我从 WSL `daemon.log` 读到的对端正是 **`peer=win-pid-44496`**（`out-83-8731-orphan-forensics.md` 记录了 `daemon.log:2255-2257`）⇒ **逐字吻合**；
3. 它的**全部**启动方式都带 `-WindowStyle Hidden`／后台重定向（4×`Start-Process -WindowStyle Hidden` + 1×后台 job），**没有一次带控制台**；
   而插件自己的 spawn 是 `windowsHide:true, detached:true`（`daemon-client.ts:403-406`）**却仍然开窗**。

⇒ 所以既不是"操作者带控制台起进程"，也不是插件漏了 `windowsHide` 参数，而是
**F-37：Win11 默认终端为 Windows Terminal 时，长驻 `wsl.exe` 的控制台被 WT 接管开窗**（短命 `wsl.exe -l -v` 不会）。
**T15 正在做根因 A/B 与修复，T16 将独立复验 ∆可见窗口 = 0。**

（我原先要求的"`win-pid-44496` 的属主证据"现已到手 = client-panel 的宿主 pid ⇒ 从"未复核"移到"**已坐实**"。）
