# T13 追补：17:44:10 守护拉起与可见窗口的自查（lead 2026-10-12 18:07 问询）

> 结论先说：**那个 17:44:10 的 `wsl.exe -d debian-u8-1 -- bash …/launch.8731.sh` 是我触发的**（不是我手工起的进程，而是我在面板上点了一次「启动守护」⇒ 真 host 的 `explorer.daemon ensure`）。
> **我方进程直接产生的可见窗口 = 0；但由我方动作触发的外部可见窗口 = 1**（`WindowsTerminal` pid 32024，标题 `C:\Program Files\WSL\\wsl.exe`，已被 lead 清理）——所以按"用户可感知"口径，**不是 0**，如实记录。

## 1. 三问的如实回答

**① 实例是怎么起的？——两种写法都用过，没有任何一次 `Start-Process` 漏掉 `-WindowStyle Hidden`**

| 实例 | 起法（原文） | 端口 | 日志文件（创建时间） |
|---|---|---|---|
| 3091（红测） | `Start-Process -FilePath $dsh -ArgumentList '--profile','remote-wsl-test','--port','3091','--no-open' -WindowStyle Hidden -RedirectStandardOutput/…-RedirectStandardError …` | 3091 | `t13-red.out.log` 17:37:00 |
| 3091（绿测） | 同上 | 3091 | `t13-green.out.log` 17:38:22 |
| **3091（/mnt 修复后，即 17:44:10 那次 ensure 的宿主）** | **同上** | 3091 | **`t13-mnt.out.log` 17:41:37**（token `-rdLDt_bVgNdjPpprRoUs2_nr9y58MoKc62duA4JaFk`） |
| 3091（面包屑修复后） | 同上 | 3091 | `t13-final.out.log` 17:45:14 |
| 3092（伪造发行版） | pwsh 工具的 `run_in_background`：`& $dsh --profile remote-wsl-test-bogus --port 3092 --no-open 2>&1`（后台 + 重定向，符合"不许弹可见窗口"的等价写法） | 3092 | job `pwsh-2087` |

**② 有没有走到"默认槽位 8731 起守护"的路径？——有，而且只有一次。**
- 触发点：T13 回归脚本里我点了面板的「启动守护」（= `explorer.daemon ensure`）。这是我这轮**唯一**一次真实守护拉起；面板随后显示 `daemon slot 8731 · :8731 · pid 1026481 · 0.2.0-rc.2 · keys 0`。
- 槽位 8731 是**插件自己的默认 `daemonPort`**（profile 的 patch 里没有 `daemonPort` 覆写，我也**没有**加 `--patch`）——所以"默认槽位"不是我选的，是配置的默认值。
- WSL 侧日志逐字对上（UTC = 本地−8）：
```
[daemon pid=1026481 2026-10-12T09:44:10.920Z] listening 127.0.0.1:8731 pid=1026481 dsh@0.2.0-rc.2 cwd=/home/g idleMs=1800000 queue=4 lingerMs=600000
[daemon pid=1026481 2026-10-12T09:44:10.923Z] 已清理启动脚本 /home/g/.dsh/remote-wsl/launch.8731.sh
[daemon pid=1026481 2026-10-12T09:44:11.447Z] 客户端断开（运行时保持存活）peer=win-pid-44496
```
`09:44:10.920Z` = **本地 17:44:10.920**；`peer=win-pid-44496` = 我 17:41:37 那台 3091 实例（我在 17:45:14 的收尾命令里 stop 了它：`stopped 44496`）。
- 今天 `daemon.log` 里**端口 8731 只有这一次**拉起；其余 8932/8935/8937/8962/8972 的拉起 peer 分别是 51136 / 42216 / 412 / 51100 / 29412，**都不是我的实例**（我的插件宿主今天只有 44496、22604、17112）。其中 **17:53:53 与 18:03:59 各有一条 8932 的拉起（peer 42216 / 51100）在我这轮之后、也不是我触发的**——供你归属时参考。

**③ 有没有手工删过 `daemon.8731.json` / 元数据而没先停守护？——没有。**
我这轮**全部**删除动作（可对照我的命令流水）只有两处，都在 Windows 侧、都是我自己的临时物：
1. `Remove-Item -Recurse -Force D:\project\net1\_tmp\client-panel-20261012`（我自建的空目录）
2. `Remove-Item -Recurse -Force 'C:\Users\l\.dsh\profiles\remote-wsl-test-bogus'`（我自建的一次性 profile，测完删）

我**没有**跑过 `selftest stop`、`wsl_daemon`、`wsl_status` 之外的守护动作，**没有**对 WSL 侧任何文件做删除/移动/chmod，也没有 `Stop-Process` 过 WSL 侧的 pid。另外两条与"文件不见了"有关的机制**不是我**：
- `launch.8731.sh` 消失是**守护自己删的**（上引日志"已清理启动脚本 …launch.8731.sh"；`launch.8932.sh` 每次拉起同样被清理）。
- `daemon.<slot>.json` / `.token` 的消失是 `daemon-client.removeMetaFiles()` 在 **stop 路径**里做的（我 17:33 的 `listDir` 快照显示那目录当时只有 `daemon.log`+`launch-stderr.log` 两个文件，因为当时没有守护在跑）。
⇒ **"17:44:10 那个 8731 守护当时没有元数据"我解释不了**：按实现，守护启动时会自己写 `daemon.8731.json`。要么那次元数据写入没落地，要么在你看之前被某条 stop 路径摘掉了——两条都不是我的动作，但**我无法替你证明**，如实列为未决项。现状：该目录只剩 `daemon.log`(18:06) + `launch-stderr.log`(10-10)，活的守护 0（`ps` 已确认）。

## 2. 可见窗口：可复算的归属判定（替换我 T13 报告里那套"按标题枚举"）

**我 T13 报告用的是** `Get-Process | ? MainWindowTitle -ne ''` 直接列举（只证明"我的宿主进程没有窗口"）——口径**弱于**你这次要求的，**它会漏掉由我方动作触发的外部窗口**（正是本案）。下面是替换后的方法与本轮结果：

```powershell
# 1) 我方进程清单（pid / 启动时间 / 父 pid）
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote-wsl-test' } |
  Select-Object ProcessId,CreationDate,ParentProcessId,CommandLine
# 2) 可见窗口清单 + 归属字段
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)"
  [pscustomobject]@{ pid=$_.Id; name=$_.ProcessName; start=$c.CreationDate; ppid=$c.ParentProcessId; title=$_.MainWindowTitle } }
# 3) 判定规则（两条都要过）：
#    a) start ∈ [我的运行窗口]（本轮 17:22–18:10）
#    b) pid ∈ 我的进程树 ∨ 父链可达我的实例 ∨（外部进程）其父进程是 my-host 且 start 与我的动作同一秒
# 4) 交叉证据：WSL 侧 daemon.log 的 `peer=win-pid-<pid>` 直接指出是哪台宿主触发了守护拉起
```

**本轮结果（18:07 复算）**

| 口径 | 结果 |
|---|---|
| 我方进程直接产生的可见窗口 | **0**（17112/22604 起于 17:45:14，`MainWindowTitle=''`；唯一带标题的 DSH 窗口 PID 47604 起于 10/10 12:25:54、父链到 `explorer.exe`，是**用户宿主**） |
| 由我方**动作**触发的外部可见窗口 | **1** —— `WindowsTerminal` pid 32024，标题 `C:\Program Files\WSL\\wsl.exe`，与 `daemon pid=1026481` 的 17:44:10.920 同一秒；**已由 lead 清理，现在不存在** |
| 复算命令 | 上框 1)–2)；归属表已附在对话里 |

## 3. 机制与（供 owner 参考的）缓解方向

我这次点击走的是既有实现：`explorer.daemon ensure` → `daemon-client.ensureDaemon()` → `spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', launchLinux(cfg, port)], { stdio:['ignore','ignore',stderrFd], windowsHide: true, detached: true })`（`src/daemon-client.ts:403-406`）。

**注意：`windowsHide: true` 已经在了，但仍出现了可见窗口** —— 也就是说"windowsHide 就够了"这个假设在本机不成立：Windows 11 把 **默认终端应用 = Windows Terminal** 时，`wsl.exe` 申请的控制台会被交给 WT，而 WT **照样开窗**（标题就是 `…\WSL\wsl.exe`）。这解释了为什么大量 `wsl.exe -l -v`（`distroFlags()`，同样 `windowsHide:true`）没出窗口，而 `… -- bash <长驻脚本>` 这一次出了：短命命令不产生需要终端宿主的控制台。

供 owner 验证的候选缓解（我**没有**改 `src/daemon-client.ts`——它不在 T13 的作用域，且 T8 冻结过它）：
1. 让 Windows 侧 `wsl.exe` **尽快退出**：把守护真正交给 WSL 内的 `setsid/nohup … </dev/null >log 2>&1 &`，宿主只等握手，不长期持有 `wsl.exe`（观察到的窗口是 wsl.exe 自己那个控制台）；
2. 试 `wsl.exe -d <d> -e bash …`（`-e`/`--exec`）而非 `-- bash …`，看是否避免走默认登录 shell 的控制台分配（需实测）；
3. 环境层面：把"默认终端应用"设为 **Windows 控制台主机**（用户级设置）——不是插件能保证的；
4. 若要在插件内做，可考虑经 `conhost.exe`/`--headless` 之类的宿主层包装，或先探测"当前默认终端"再决定是否告警。

第 1 条最可能有解，但**必须实测**（我可以接着测，只要给我端口段与一次允许的 `ensure` 窗口）。
