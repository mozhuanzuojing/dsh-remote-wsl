# REPORT-t18-dual-constraint-verify.md —— T18：T17 双约束修法的独立复验

- **验证者**：`p0-verify`（独立于 T17 实现者）｜**日期**：2026-10-12｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：开工冻结 → 收尾复算 **锚点一致 = True（13/13）⇒ 验证有效**；advisory 仅 README.md。
  lead 给的锚点 **2/2 MATCH**（`daemon-client.ts` `43766999F058…`、`daemon.ts` `E471A5807054…`）；本轮变化面 = `daemon-client.ts` + README.md，其余 6 个 src（`explorer.ts`/`index.ts`/`selftest.ts`/`sdk-runtime.ts`/`shell-env.ts`/`version.ts`）与 `client/**`、`package.json` **逐字未变**。

## 结论（≤450 字）

**双约束成立：窗口面 Δ=0 与存活面同时为绿；回退面三条都按判据走；两条故意红都真变红。**
**窗口**：6 轮 `Δ可见窗口 = 0`（R1 首次 / R2 复用 / R3 restart / R4 复用 / R5 stop+再起 / **R6 真面板点「启动守护」**），逐轮 `before=8 after=8 WT=0`，全部 valid；归属用账本 + `win-audit.ps1` + `daemon.log` 的 `peer=win-pid-…` 交叉，**不凭标题猜**。
**存活**：① 宿主**优雅退出**（`taskkill` 无 `/F` = WM_CLOSE）后 **pid 不变**（1129920）且 unit 仍 active、握手复用 `reused=True`；② **硬杀**宿主后仍活；③ `systemctl --user show -p MainPID` == 元数据 pid（1127031/1129920 两次都相等）；④ **只杀包装层**这条风险**消失**（systemd 路径无长驻包装层，实测此刻查不到 `wsl.exe … launch.8932.sh`）。
**回退**：`=off` ⇒ 走 compat（notes 明写"兼容 spawn（detached:true + windowsHide:true）"+ ⚠️ 告警全文）且守护真活；`auto` + 真 systemd 不可用（副本把 `systemd-run` 换成不存在命令）⇒ 识别 `找不到 systemd-run…` → 回退 → 守护真活（握手 2ms）→ 告警可见；`=on` + 不可用 ⇒ **503 且明确"按显式配置**不**回退"**、未起守护。T17 修的 **EBADF** 未见复现（回退路径正常起守护）。
**故意红**：① `=off`（compat 路径）⇒ 真出现 `WindowsTerminal`（Δ=1, WT=1）⇒ 窗口断言有区分力；② 副本把 compat 的 `detached:true→false` ⇒ **客户端死后守护随之中止** ⇒ 存活断言有区分力（与 T16 的回归同源）。两条均已字节还原（副本/profile 已删、vendor 真代码行 `detached: true` 为 0 处）。
**一条回归面 RED（需 T17 处理）**：`=on` 失败路径会**留下 `launch.<slot>.sh` 残留**（8936/8937，且 mode **0644**）—— 违反 lead 判据「`launch.<slot>.sh` 无残留」（正常路径无残留）。其余回归面全绿（白名单/同源门/仅 POST+JSON/无凭据回传/槽位隔离 400 E_ARG/`launch-stderr.log` 0600/元数据 0600 且 pid=port）。

## 1. 窗口面（方法 + 逐轮数据）

- **方法**：账本 `out-90-ledger.tsv`（每个外部进程 `(pid, 启动时间, 父 pid, 用途)`）；`win-audit.ps1 → Get-WinSnap` 枚举 `(pid,名,标题,启动时间,父pid,父链)`；`mine` = 父链可达账本 pid；**仪器正向对照**要求枚举 ≥1（本机稳定 8 个，含用户 19:22 自己开的 `QQ`）。
- **peer 交叉**：`daemon.log` 的 `peer=win-pid-<pid>` 与宿主子进程对应（T16 已闭合：`win-pid-22156` = `DeepSeek Harness.exe`，ppid = 我的宿主 cmd）。

| 轮次 | 动作 | before | after | Δ | WT |
|---|---|---|---|---|---|
| R1 | 首次启动（stop 后 `ensure`） | 8 | 8 | **0** | 0/0 |
| R2 | 复用（`ensure`） | 8 | 8 | **0** | 0/0 |
| R3 | `restart`（systemd 重入：MainPID 换新=1129370，unit active） | 8 | 8 | **0** | 0/0 |
| R4 | 复用（`ensure`） | 8 | 8 | **0** | 0/0 |
| R5 | stop + 再起 | 8 | 8 | **0** | 0/0 |
| **R6** | **真面板点「启动守护」** | 8 | 8 | **0** | 0/0 |
- R6 证据（真 DOM 点击、真 host route）：面板 `daemon 未运行` → 按钮「启动守护」→ note：
  `已启动守护 slot 8932 · :8932 · pid 1129920 · 0.2.0-rc.2：启动方式: systemd-run --user（unit dsh-rwsl-8932.service；包装层短命 ⇒ 无窗口，且与 Windows 侧生死解耦）；槽位 8932 由 Windows 侧握手确认就绪（实际端口 8932，4ms）`
  ⇒ **启动方式在 UI 里可见（不静默）**。原始：`out-101-rounds-route-t18.json`、`out-102-panel-before.json`。
- **隔离实例构造**（T17 曾两次失败）：我用的是既有 profile **`remote-wsl-test-web`**（与 `remote-wsl-test` **同 bundles**，仅在其 profile 层把 `remote-wsl` 的 `daemonPort` 钉为 **8932**）——即"只在测试 profile 生效的 daemonPort 覆写"，未动任何用户/他人槽位，无需 overlay。这一条可直接交给 T17 复用。

## 2. 存活面（约束 b）

| # | 手法 | 结果 | 判定 |
|---|---|---|---|
| ① | 宿主**优雅退出**：`taskkill /PID <cmd>`（**不带 `/F`** ⇒ WM_CLOSE/控制台关闭） | cmd 退出；守护 pgrep=[1129920] **pid 不变**、unit **active**；随后新宿主 `ensure` ⇒ `同一 pid=True, reused=True`（"复用自己槽位 8932 的守护：握手 3ms 通过"） | **PASS** |
| ② | **硬杀**宿主（`taskkill /F` harness） | 守护仍活（pgrep=[1129920]，unit active） | **PASS** |
| ③ | `systemctl --user show -p MainPID` vs 元数据 pid | 1127031==1127031；1129920==1129920 | **PASS** |
| ④ | **只杀包装层** | systemd 路径**无长驻包装层**（`wsl.exe … launch.8932.sh` 查不到）⇒ 该风险消失；对比 T16：旧配置下杀包装层 ⇒ 守护 1s 内死 | **PASS（改善成立）** |
- **T17 报的"硬杀不带走 / 正常退出才带走"这个区别**：在 systemd 路径下**两条都不带走**（① ② 都绿）⇒ 因为我用的是 WM_CLOSE 关 cmd 外壳、而 systemd unit 与 Windows 侧完全解耦，所以"带走"的机制不再存在。**注**：我**没有**构造出 harness（服务器进程）自身的优雅退出通道（Ctrl+C 投递失败，见 §6）⇒ ① 的语义是"客户端侧 cmd 外壳优雅退出"。
- 单元态：`dsh-rwsl-8932.service loaded active running [systemd-run] /usr/bin/bash /home/g/.dsh/remote-wsl/launch.8932.sh`。

## 3. 回退面（判据先写死后跑）

| 场景 | 期望 | 实测 | 判定 |
|---|---|---|---|
| **A** `DSH_REMOTE_WSL_SYSTEMD=off` | mode/warning 出现 + 守护真活 | notes：`启动方式: 兼容 spawn（detached:true + windowsHide:true）—— 见上面那条告警` + 完整 ⚠️ 告警（含 `/etc/wsl.conf` 建议）；守护真活（pgrep=[1136367]，握手 4ms） | **PASS** |
| **B** `auto` + **真** systemd 不可用（副本把 `command -v systemd-run` 换成 `systemd-run-t18-nope`） | 识别 `SYSTEMD_FAIL` → 回退 → 守护真活 → 告警 | notes：`⚠️ 未能由 systemd 托管守护（找不到 systemd-run（发行版可能未启用 systemd））⇒ 已回退到**兼容启动**…`；**真活**（握手 2ms，pod 8935） | **PASS** |
| **C** `on` + 不可用 | `ok=false` 且**不回退** | **HTTP 503**，error 含 `DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败（找不到 systemd-run…）；按显式配置**不**回退`；**无**"兼容 spawn"note；**未起守护**（pgrep 空） | **PASS** |
- **`mode`/`warning` 的可见位置（与判据措辞的差异，供 T17 参考）**：route 响应 `result` 里**没有**独立的 `mode`/`warning` 字段；两者都体现在 **`notes[]`**（第一行给启动方式、第二行给 ⚠️ 告警全文）。⇒ 若希望"三处可见"里的机器可读字段，需要把 `mode`/`warning` 也放进响应；我按"notes 可见"判 PASS，并把差异记录在此。
- **EBADF**：B/A 两条回退路径都**正常起守护**、未见 `spawn EBADF` 自崩（T17 的 `tryOpenStderr`/`'ignore'` 兜底生效）。

## 4. 故意红（2 条，均已字节还原复绿）

| # | 手法 | 期望 | 实测 |
|---|---|---|---|
| ① | **`DSH_REMOTE_WSL_SYSTEMD=off`**（走 compat 路径，即 detached spawn；**同一份 vendor 代码**，无需副本） | 窗口断言红 | **Δ=1，新增 `WindowsTerminal#29064`**（title `C:\Program Files\WSL\\wsl.exe`）⇒ RED 成立；随后按我方产物关窗、复绿（窗口回 8/WT 0） |
| ② | 副本把 compat 的 `detached: true` → `false`（=T15 形态）+ 真 systemd 不可用 ⇒ 走"无 detached 普通 spawn" | 存活断言红 | `ensure` 起守护 8935（1138479）；**硬杀客户端 harness 后 pgrep=[]** ⇒ **RED 成立**（与 T16 回归同源）；删副本/profile 后 vendor 复绿 |
- 还原核对：副本目录与 `remote-wsl-t18-c1` profile **已删**；`vendor/src/daemon-client.ts` 真代码行 `detached: true` = **0 处**（注释里出现不算）。

## 5. 回归面

| 项 | 结果 |
|---|---|
| 旧 4 方法/白名单 | `GET methods = explorer.snapshot, explorer.openSession, explorer.daemon, explorer.fixPin, explorer.listDir`（与 T14/T16 一致） |
| 同源门 | 缺 Origin → **403**；伪造 Origin(`http://evil.example`) → **403** |
| 仅 POST+JSON | `text/plain` + POST → **415** |
| 无凭据回传 | 响应体不含 `token` |
| 槽位隔离 | `ensure slot=8962` → **400** `slot 8962 不是本插件配置的槽位（8962≠8932）；本插件只操作自己的槽位`（未打扰） |
| `launch-stderr.log` | **0600** ✓ |
| 元数据 | `daemon.<slot>.json` 0600 且 `pid == port`；token 0600 ✓ |
| `--dump-config` | **exit 0**、1266 行、`Error:` **0** ✓（与 T12 的**逐行 diff 未复核**：本目录只归档了**无插件**基线 `out-03-dumpconfig-base.txt`，没有 T12 时代的**带插件** dump 可比） |
| **`launch.<slot>.sh` 无残留** | **正常路径无残留 ✓**；但 **`=on` 失败路径有残留 ⇒ RED**（见下） |

**新发现（回归面 RED，需 T17 修）**：`DSH_REMOTE_WSL_SYSTEMD=on` + **systemd 托管失败**时，端口回退尝试为 **8936/8937** 各写了一个启动脚本且**未回收**，而且 mode 是 **0644**（其余文件都是 0600）。
**构造手段与触发条件分开说清**：我是在**副本**（仅把 `command -v systemd-run` 换成不存在的命令）+ `=on` + `daemonPort=8935` 的场景里复现的；**触发条件是"systemd 托管失败 + 发生了端口回退尝试"本身**，与"把命令名换掉"这个构造手段无关 —— 真实的对应场景是**发行版未启用 systemd / PID1 不是 systemd**（即 T17 想覆盖的那类环境）。
```
-rw-r--r--  1 g g   506 Oct 12 20:04 launch.8936.sh
-rw-r--r--  1 g g   506 Oct 12 20:04 launch.8937.sh
```
归属：这两个是 `ensure` 为 +1/+2 回退端口写的脚本（正常槽位 8935 的脚本已被清理）；守护从未起来 ⇒ 自删不会发生；`on` 分支直接返回错误，没有走"没起来的启动脚本别 leak"的兜底清理。原始：`out-104-launch-residue-finding.txt`（已按我的产物清理，现 `launch.*.sh` = NONE）。**vendor 代码未改**（副本已删）。

## 6. 我自己的仪器/步骤缺陷（留档）

1. **`=off` 用例第一版无效**：上一轮的旧宿主仍占着 8931，我的新宿主起不来 ⇒ `ensure` 实际打到了**默认 env 的旧宿主**（还是 systemd 路径）。已改为"先按端口监听者 + 命令行认领并清掉我的宿主，再**验证服务者确实属于新宿主**才判分"。
2. **回退面 C 第一版无效**：我在 B 之后没停守护 ⇒ `on` 的 `ensure` 直接**复用**了 B 起在 8935 的守护（200 + reused），根本没触发 systemd 尝试。已改为"先 stop 再 ensure"。
3. **`send-ctrlc.ps1` 的 `FreeConsole` 副作用**：它成功脱离了**我自己的**控制台，导致同进程后续 `wsl.exe` 报"获取控制台模式…句柄无效"⇒ 那一轮的结论全部作废（已重跑）。改判据后用 `taskkill`（无 `/F`）实现优雅退出。Ctrl+C 直投仍失败（`AttachConsole` 返回 5），故 **harness 自身的优雅退出通道记未复核**。
4. **故意红②第一版无效**：我只 WM_CLOSE 了 cmd 外壳（harness 仍活）⇒ 守护没被带走。改为"硬杀 harness（客户端）"后才变红。

## 7. 未复核项（不许当通过）

1. **`--dump-config` 与 T12 基线的逐行 diff**：无 T12 时代带插件 dump 归档 ⇒ 只证了 exit 0 / `Error:` 0 / 1266 行。
2. **harness 自身的优雅退出**：Ctrl+C 直投不可用（`AttachConsole` 5）⇒ 未复核；① 用的是 WM_CLOSE 关 cmd 外壳。
3. **`mode`/`warning` 的机器可读字段**：路由响应里没有（只在 notes 文案）⇒ 若 T17 要求字段化，需再测。
4. **真 systemd 缺失的构造是"副本改命令名"**，不是真的未安装 systemd；`systemd=true` 未启用的真实发行版行为未复核。
5. **单位残留清理**：`systemctl --user stop/reset-failed` 已做，`--collect` 语义下的 unit 文件是否留盘未逐项核对。
6. keys>0 / webHosts 非空 / desktop 宿主 / 像素级截图：沿用历轮未复核。
7. **`launch.8936/8937` 残留是我在副本上构造出来的一次性现象**，我已在 vendor 场景（`=on` + 真不可用）复现并留证；是否还有别的失败分支同类残留未穷举。
