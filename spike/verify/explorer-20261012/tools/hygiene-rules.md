# 卫生规矩（可直接粘进 README / 交接文档）

> 来源：本轮（Agent Team，P0.2/P0.3 + T29）实际踩过的坑与独立复验拦下的问题。
> 用法：整段粘到 README「工程与纪律」一节，或交接文档 §11「安全与纪律」之后。
> 每一条都是**可判定的动作**，不是口号。

## 1. systemd-run 探针 unit 必须收尾 `stop` + `reset-failed`

- 任何 `systemd-run --user --unit=<名> …`（探针、夹具、一次性验证）用完**必须**：
  `systemctl --user stop <名>` **然后** `systemctl --user reset-failed <名>`。
- 只 `stop` 不够：失败的 unit 会以 `failed` 留在 `systemctl --user list-units --state=failed` 里，
  下一轮"残留检查"会红，而且**看起来像是别人留下的**。
- 想要"跑完自动消失"可以用 `systemd-run --user --collect`（失败也回收）；但**故意红实验**不要加
  `--collect`，否则观察不到 failed 态。
- 判据：`systemctl --user list-units --state=failed --no-legend --no-pager` 的行数**必须为 0**。

## 2. 窗口归属**禁凭标题猜**

- 反例：那次的窗口标题与用户自己的终端**一模一样**，凭标题判 ⇒ 误判成"用户的窗口"，漏掉自己的弹窗。
- 允许的归属证据（至少两条交叉）：
  1. 进程树：`pid` + `ParentProcessId`（一路走到我们自己的宿主/守护进程）；
  2. 启动时间：与触发动作**同秒级**（`StartTime`）；
  3. 命令行：`CommandLine` 里出现我们的标记/发行版/槽位（如 `wsl.exe -d <distro>`、`dsh-remote-wsl`）；
  4. 交叉印证：WSL 侧 `daemon.log` 里的 `peer=win-pid-<pid>`。
- 标题只作**展示**，永不作为判据；报告里必须写明"title 仅供参考"。

## 3. 别在守护活着时删元数据（`reclaim` 夹具的坑）

- 守护进程存活时会**重建/回写**元数据与启动脚本；此时删掉它们，夹具会观察到"删了又回来"的假象，
  或者反过来让守护进入半死状态。
- 正确顺序：先 `wsl_daemon stop`（或 unit 未运行）→ 确认进程已退出 → 再删元数据/包装层 → 再验证。
- 同理：`launch.<slot>.sh` 的"残留检查"要在守护确实停下之后做，否则读到的是**在用**而不是**残留**。

## 4. 不许 `npm` / `pnpm install` 到共享目录

- 共享目录包括：`C:\Users\l\node_modules`、任何别人的 profile `node_modules`、全局 prefix。
- 要装只装到**自己的写作用域**或 `%TEMP%`；需要跑 CLI 而本机没有时，**从 `app.asar` 只读解包到 `%TEMP%`** 更安全。
- 教训：一次 `npm install` 因为 cwd 没有 `package.json`，prefix 被解析到 `C:\Users\l`，
  536 个包被**并入**了已存在的 `node_modules`（清理成本远大于收益）。

## 5. 不许弹可见窗口

- `Start-Process` **必须**带 `-WindowStyle Hidden`；否则用后台作业 + 输出重定向。
- 起 dsh 实例一律 `--no-open`；**不要**用 `detached:true` 去"保活"——Windows 上它是
  `DETACHED_PROCESS`（无控制台），控制台程序（`wsl.exe`）会**申请新控制台**而被 Win11 默认终端接管 ⇒ **开窗**
  （这正是 F-37 的根因；`windowsHide` 与它互斥）。要解耦生死请走 WSL 侧 `systemd-run --user`。
- 验收时必须附"窗口面 ∆=0"的证据（动作前后各枚举一次可见窗口）。

## 6. 收尾枚举窗口并给归属证据

- 收尾固定动作：枚举可见窗口（`MainWindowHandle -ne 0`），每个给 `pid / parent / name / StartTime / CommandLine`，
  并标注 `ours?`（命令行含我们的标记）或 `foreign`（否则）。
- `foreign` 不是"免检"，而是"**归属交人判**"：把证据原样贴出，不要替读者下结论，更不要凭标题下结论。
- 已知**不该动**的常驻进程：用户桌面宿主（`19387` 的 owner）、`explorer.exe`、用户的编辑器/IME/聊天工具。
  报告里只写 pid，**绝不重启/杀**。

## 7. 量具自查（本轮新增，血的教训）

- **"判据本身会静默丢项 / 空洞通过"是本项目最高频的假绿来源**：每轮必须自测量具。
- 三个真实例子：`wsl.exe` 自身横幅是 **UTF-16（夹 NUL）** ⇒ 用"标记行精确匹配"切段会**静默失败**，
  把"有 failed unit"报成 PASS 0（本轮 T29 的 `precommit-check.ps1` 第一版就栽在这里）；
  正则漏掉 `**` 造出自假红；`reused` 未 stop-first 让结论无效。
- 落地要求：**任何计数型判据都必须有第二路交叉校验**（例：`list-units --state=failed` 的**实列行数**
  vs `wc -l` 的计数），不一致时**以更保守的一路为准并显式标注"量具不一致"**，不许静默取信一路。

## 8. 交付物一致性

- **冻结表不要手抄**：用 `spike/verify/explorer-20261012/tools/sync-freeze-table.ps1` 从 `REVISION.txt` 投影，
  `-Mode Check` 逐字校验（hash **大小写敏感** + 字节数）。
- **交接文档只追加**：用 `tools/handoff-append.ps1`；**严禁**用"标题当锚点替换"（那个手法一次能吃掉后面所有小节）。
  追加型写入必须自带"原文本是新文本前缀"的断言 + 标题序列"只多不少"的复检。
- 提交前跑 `tools/precommit-check.ps1`（六类检查，每条 PASS/FAIL/WARN + 原始输出）。

## 9. 隔离 profile：**不要直接 `Copy-Item` 目录**（会打断 junction）

- 反例：直接 `Copy-Item -Recurse` 一个 profile 目录，会把 `node_modules\` 下的 **Junction 变成实体目录**（或留空壳），
  宿主启动时报 `remote-wsl: failed to import` —— 这正是 T17 那次失败的真正原因。
- 正确做法：**只拷清单文件，在新目录里重建 Junction**（或先 `git archive` 导出插件树，再指回）：

```powershell
# 1) 只拷 profile 的清单文件，跳过 node_modules
$src = "$HOME\.dsh\profiles\web"; $dst = "$HOME\.dsh\profiles\t29-isolated"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\package.json","$src\cordis.yml","$src\cordis.patch.yml" $dst -Force
# 2) 重建 Junction（不要 Copy-Item 原 node_modules）
$repo = 'D:\project\dsh1\vendor\dsh-remote-wsl'
New-Item -ItemType Directory -Force -Path "$dst\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$dst\node_modules\dsh-remote-wsl" -Target $repo | Out-Null
# 3) 判据（三条都要）
node <dsh-cli>\lib\bin.js --profile t29-isolated --dump-config *> $null; "dump-config exit=$LASTEXITCODE"   # 必须 0
cmd /c "dir /a `"$dst\node_modules`"" | Select-String 'JUNCTION'                                            # 必须仍是 JUNCTION
node <dsh-cli>\lib\bin.js --profile t29-isolated --dump-config | Select-String 'dsh-remote-wsl'             # 插件行在场
```

- **判据**：① `--dump-config` 退出码 0；② 那条链接仍是 `<JUNCTION>`（不是普通目录）；
  ③ dump 里能看到插件的 loader 行。三条不齐 ⇒ 隔离实例不可信。

## 10. "删记录 / 清状态"必须**挂在校验之后**（否则造出不可发现的隐形孤儿）

- 反模式：清理动作**先删元数据/状态**，再去找真实资源。资源若还在，元数据已没了 ⇒ 再也**发现不了**它（隐形孤儿）。T25 的根因就是这个顺序。
- 正确顺序：**先做一次独立的存在性复核**，身份从**资源本身**读、**不从元数据读**
  （本项目用 `scanDaemonProcesses()` 读 `/proc/<pid>/cmdline` 认身份，**有界等待 2s**），确认资源确实消失，**然后**才删记录。
- **判据一句话**：*"删记录前必须有一次**独立的**存在性复核；复核失败（资源仍在 / 身份不确定）时**保留记录**并返回可读错误，不许静默删除。"*
- 自检问法：任何"清理"都要能回答"如果它其实还活着，我会不会发现不了？"——会，就说明顺序错了。
