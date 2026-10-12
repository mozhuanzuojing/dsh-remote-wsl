# REPORT-t21-f38-verify.md —— T21：F-38 + 字段透传的窄范围独立复验

- **验证者**：`p0-verify`（独立于 T19/T20/T22 实现者）｜**日期**：2026-10-12｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：GO 后冻结（21:0x）→ 收尾复算 **锚点一致 = True（13/13）⇒ 验证有效**；advisory 仅 README.md。
- **4 个锚点 4/4 MATCH**：`daemon-client.ts` `4D5C2EBF955C…`、`index.ts` `A8BDB70C61AC…`、`daemon.ts` `E471A5807054…`、`explorer.ts` `906B9554…2E1E`；
  **`client/**` 4 个 + `package.json` 与上次冻结逐字一致（unchanged）**；本轮变化面 = `daemon-client.ts` + `explorer.ts` + `index.ts` + README。

## 结论（≤450 字）

**F-38a/b/c 全部成立、双前缀已修、字段透传四取值齐、两条约束抽验仍绿、回归全绿、性能读数落回 T19 自陈区间。**
**F-38a**：失败路径**残留 0**（vendor），错误仍"**按显式配置\*\*不\*\*回退**"；故意红 = 副本禁用 `removeLauncher`（`daemon-client.ts:732`）⇒ **残留 3 个**（`launch.8935/8936/8937.sh`）⇒ 断言有区分力，已字节还原（vendor 该调用 1 处、副本/profile 已删）。
**F-38b**：红态 3 个残留**全部 `-rw-------`（0600）** —— 对照 **T18 改前同场景是 `-rw-r--r--`（0644）** ⇒ 用**红态 `ls -la` 对照**证明（非 100ms 采样）；正常路径与 `launch-stderr.log`、元数据也均 0600。
**F-38c**：① systemd ⇒ `mode='systemd'`/`warning=null`；② `=off` ⇒ `mode='compat-detached'` + 非空 warning（措辞与 T19 一致、准确）；③ 复用 ⇒ `mode='reused'`；④ `=on` 失败 ⇒ **HTTP 503 / `ok:false` / `code='E_UNAVAILABLE'` / 无 `result`**（错误信封，未断言 `result.mode`）；`result` 键含 `mode,warning`，`notes[]` 未被删改。
**双前缀**：失败文本 `remote-wsl:` **计数 = 1**、不含 `remote-wsl: remote-wsl`；改前为 **2**（T22 `before-fail-on.txt` + T18 实测句）⇒ 句中那份上游标记按口径**保留**。
**两条约束**：systemd 主路径窗口 **Δ=0**（W1/W2 + **真面板点「启动守护」**共 3 轮）；compat 路径**允许弹窗**：`=off` 实测**产生 1 个 `WindowsTerminal`**、收尾存在 **0**；存活抽验 **宿主优雅退出后 pid 不变**（1182914）。
**性能**：systemd 主路径 5 次读数 `1144/662/1122/1137/1087 ms` ⇒ **p50 1122ms / max 1144ms**（只给数据，不设阈值）。
**回归全绿**：`--dump-config` exit 0 / `Error:` 0；5 方法白名单；缺/伪造 Origin 403；非 JSON 415；无 token 回传；槽位隔离 400 `E_ARG` 且 WSL 侧 `:8962` 无监听。

## 1. F-38a 残留（含故意红）

| 场景 | 残留 | 守护 | 错误 |
|---|---|---|---|
| **vendor**：副本把 `command -v systemd-run` 换成 `systemd-run-t21-nope`，`=on` + 端口回退（8935/8936/8937） | **0** ✓ | **0** ✓ | 503 `E_UNAVAILABLE`，"按显式配置\*\*不\*\*回退" ✓ |
| **故意红**：同副本再把 `if (removeLauncher(cfg, p))` → `if (false && removeLauncher(cfg, p))` | **3**（`launch.8935/8936/8937.sh`）⇒ **RED 成立** | 0 | 503（同） |
- 还原核对：vendor 的 `if (removeLauncher(cfg, p))` = **1 处**；副本目录与 `remote-wsl-t21-c1` profile 已删；残留终检 `NONE`。
- 原始：`out-115-on-envelope.txt`（vendor 绿态）、`out-116-c1-red.log`（红态宿主日志）。

## 2. F-38b 权限（红态对照法）

```
卖家（vendor，绿态）：  无残留（无从对照）
副本（红态，禁用回收）： -rw------- 1 g g 506 Oct 12 21:00 launch.8935.sh
                        -rw------- 1 g g 506 Oct 12 21:00 launch.8936.sh
                        -rw------- 1 g g 506 Oct 12 21:00 launch.8937.sh
T18 改前（同场景、修复前）： -rw-r--r-- 1 g g 506 Oct 12 20:04 launch.8936.sh / launch.8937.sh   （out-104-launch-residue-finding.txt）
```
⇒ **0600 在失败路径与正常路径都成立**；`launch-stderr.log`（62144B, `-rw-------`）与 `daemon.<slot>.json`/token 亦 0600。

## 3. F-38c 字段透传（四取值）

| # | 场景 | 实测 `result` | 判定 |
|---|---|---|---|
| ① | systemd 主路径 | `mode='systemd'`，`warning=null`；`notes[0]='启动方式: systemd-run --user（unit dsh-rwsl-8932.service；包装层短命 ⇒ 无窗口，且与 Windows 侧生死解耦）'` | **PASS** |
| ② | `=off`（compat） | `mode='compat-detached'`，warning 非空：`⚠️ 未能由 systemd 托管守护（DSH_REMOTE_WSL_SYSTEMD=off（显式关闭 systemd 托管））⇒ 已回退到**兼容启动**：守护仍可脱离客户端存活（约束 b 保住），但在 Win11 + Windows Terminal 下**可能弹出一个可见控制台窗口**（约束 a 不保证）。建议在发行版 /etc/wsl.conf 里打开 [boot] systemd=true…` | **PASS**（措辞准确） |
| ③ | 复用 | `mode='reused'`、`reused=true`、`warning=null`、耗时 10ms | **PASS** |
| ④ | `=on` + 托管失败 | **错误信封**：`ok:false`、`code='E_UNAVAILABLE'`、**无 `result` 字段**（按口径，不断言 `result.mode`） | **PASS** |
- `result` 键序：`action,ok,idempotent,mode,warning,slot,port,pid,version,reused,started,notes` ⇒ `mode/warning` 已字段化（T20 的诉求达成）。
- `notes[]` **未被删改**：仍含"启动方式…"与"槽位 … 由 Windows 侧握手确认就绪（实际端口 …，N ms）"。

## 4. 双前缀（改前 / 改后）

- **判据**（照口径）：失败文本里 `remote-wsl:` **计数 == 1** 且**不出现** `remote-wsl: remote-wsl`；句中那份上游自带标记**必须保留**。
- **改前 = 2 次**：T22 `host-prefix/before-fail-on.txt` + 我 T18 实测句 `… —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败…`。
- **改后 = 1 次**：本次 `=on` 失败体原文（`out-115-on-envelope.txt`）——
  `"error":"远端守护在 Windows 侧不可达：试过端口 8935, 8936, 8937 —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败（找不到 systemd-run（发行版可能未启用 systemd））；按显式配置**不**回退。…"`，
  且 `remote-wsl: remote-wsl` 子串 **False**。**成功路径**的面板 note 里 `remote-wsl:` 计数 = 0（无前缀噪声）。

## 5. 两条约束抽验 + 窗口面两栏

| 栏 | 轮次 | before/after | Δ | 说明 |
|---|---|---|---|---|
| **systemd 主路径** | W1 stop+ensure｜W2 复用｜**W3 真面板点「启动守护」** | 8/8、8/8、8/8 | **0 / 0 / 0** | WT 全 0；W3 note 明写 `启动方式: systemd-run --user…（pid 1178147）` |
| **compat（=off）** | 1 轮 | 8/9 | **1（WT=1）** | **产生过 N=1**（`WindowsTerminal#29196`，ppid=1700）；**收尾存在 0**（已关我方窗口） |
- 归属：账本 + `win-audit.ps1`（父链可达账本 pid）+ `daemon.log peer=win-pid-…`，**不凭标题猜**；本机基线 8 个窗口（含用户 19:22 自开的 QQ）。
- **存活抽验（1 轮）**：宿主席位（cmd 49552）`taskkill` 无 `/F`（WM_CLOSE）⇒ 守护 `pgrep=[1182914]`、`meta.pid=1182914` **不变**、unit `active`；随后新宿主 `ensure` 以 `mode='reused'` 复用**同一 pid** ⇒ **PASS**。
- compat 栏的归属链形状与 T20 参照一致（宿主 → `wsl.exe` 包装层 → `daemon.log` 的 `peer=win-pid-…`）。

## 6. 回归 + 性能

| 项 | 结果 |
|---|---|
| `--dump-config` | **exit 0**、1266 行、`Error:` **0** |
| 5 方法白名单 | `explorer.snapshot, explorer.openSession, explorer.daemon, explorer.fixPin, explorer.listDir` |
| 同源门 | 缺 Origin **403**、伪造 Origin **403** |
| 仅 POST+JSON | `text/plain` **415** |
| 无凭据回传 | 响应不含 `token` |
| 槽位隔离 | `ensure slot=8962` → **400 `E_ARG`**；同刻 WSL 侧 `:8962` 监听数 **0**（无副作用） |
| `launch.*.sh` | vendor 全程 **NONE**（收尾复核） |
| `--collect` 清理 | `systemctl --user stop/reset-failed` 已执行；**注**：`list-units | wc -l` 的输出被 `wsl.exe` 告警噪声污染（解析出无意义数字）⇒ 我以 `is-active` 在 stop 后为 `inactive` 判断，**未做穷尽计数**（记未复核） |
- **性能（我自己 5 次读数，stop→ensure）**：`1144, 662, 1122, 1137, 1087 ms` ⇒ **p50 = 1122ms、max = 1144ms**（原始 `out-111-perf-systemd.json`）。落在 T19 自陈的 ≈1.0–1.5s 区间；**不作阈值判定**。

## 7. 我自己的步骤/仪器缺陷（留档）

1. **`=off` 用例第一版无效**（同 T18）：宿主切换 env 时**没先停守护** ⇒ `ensure` 直接 `mode='reused'`，根本没走 compat、也没窗口。改为 **stop-first** 后得到 `compat-detached` + warning + **Δ=1（WT=1）**。
2. `Add-Ledger` 未 dot-source `win-audit.ps1` ⇒ 一条账本没记上（不影响结论，该宿主 pid 另有日志可查）。
3. 两处 PowerShell 解析错（`awk` 引号、缺右括号）⇒ **整体未执行、无副作用**，已改。
4. **"不回退"断言第一版自造假红**：实现文案是 `按显式配置**不**回退`（中间有 `**`），我的正则 `不回退` 不命中 → 判 False。复核用 `按显式配置.{0,10}` 命中片段 `按显式配置**不**回退。这些` ⇒ **PASS**。

## 8. 未复核项（不许当通过）

1. **`=on` + 托管失败在本机无法自然复现**（本发行版 systemd 可用）：我用的是 **T22 同款手法**（副本把 `command -v systemd-run` 换成不存在命令名；**未改** `/etc/wsl.conf`、未动用户发行版配置）⇒ **"真实未启用 systemd 的发行版"行为未复核**。
2. **`--collect` 的 unit 落盘/穷尽计数**：输出被 `wsl.exe` 噪声污染 ⇒ 未做穷尽计数（仅 `is-active` 可见判断）。
3. **`mode/warning` 在失败面**：按口径失败走错误信封（无 `result`）⇒ 失败面的 `mode` 只能从 T19 直调 `daemon-client` 的对象取（`host-f38/out-01-scenario-on.txt`：`{ok:false,mode:null,warning:null,tried:[8911,8912,8913]}`），**不是** route 响应字段。
4. **compat 窗口的"必然性"**：我只跑了 1 轮 `=off`（Δ=1）；不同 Windows 终端配置下是否**每次**都弹窗未穷举（T19/T20 与本次都观察到弹窗）。
5. keys>0 / webHosts 非空 / desktop 宿主 / 像素级截图：沿用历轮未复核。
