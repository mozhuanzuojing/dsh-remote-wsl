# 文档漂移清单（`wsl_status` / 守护面）—— 交给 lead 补 README

- **口径**：以**实现实际输出**为准（lead 2026-10-12 核实结论 #2）。本清单只列"实测输出"与"README 现有文字"的差异，不评价实现好坏。
- **实测样本**（本目录，可复核）：
  - `out-20-status-running.txt` —— 我方守护在跑时的 `wsl_status`（slot 8932，2026-10-12 11:29）
  - `out-20-daemonstatus-running.txt` —— 同一时刻 `wsl_daemon action=status`
  - `out-09-status-smoke-clean.txt` 已删；未跑守护时的形态见 `out-20-*` 与 `out-12-forced-red-after-stop.json`

## A. README §「诊断面：`wsl_status` 报告什么」（README L466–489）的表格

| # | 实测存在的输出行 | README 现状 | 建议 |
|---|---|---|---|
| A1 | `shell env injection (useShellEnvironment): on（…）` | 只在 **L482–489「计划补进」**里作为"概念"列着 | 前移进 L470–480 的表（已实现） |
| A2 | `localhost forwarding: true  <- wslconfig（networkingMode=mirrored 时该键被忽略）` | 同上（L485–487「计划补进」） | 前移进表。**并请修正这行文字**：本机实测 `wslinfo --networking-mode` = **`nat`**（lead F-1 更正；非 mirrored），所以"mirrored 时该键被忽略"这句在本机是**误导性说明** —— 实际是 **NAT + `localhostForwarding=true`**，Windows→WSL 的 `127.0.0.1` 由**转发**提供 |
| A3 | `dlx dsh versions in WSL: 0.2.0-rc.2` | 同上（L488–489「计划补进」） | 前移进表 |
| A4 | `backend: daemon（默认：运行时由 WSL 侧常驻守护持有，关客户端 ≠ 会话结束）` | 表里**没有** | 补一行 |
| A5 | `daemon: running pid=750364 actualPort=8932 slot=8932 version=0.2.0-rc.2 uptime=152s idleMs=1800000 lingerMs=600000 keys=0 [(none)]` | 表里**完全没有 `daemon:` 行**；而 L273 与 L304 两条证据行的格式**互相矛盾**：L273 `daemon: running pid=… port=… version=… uptime=… keys=1 [rc1(turn 2,pid140497)]`，L304 `daemon: pid=… actualPort=… slot=… version=…` | 补 `daemon:` 行并把**实测**键序写死：`running pid=<pid> actualPort=<n> slot=<n> version=<v> uptime=<t> idleMs=<n> lingerMs=<n> keys=<n> [<key>(turn N,pid P), …]`；不为空时 `keys=0 [(none)]` |
| A6 | `daemon idle/linger/queue: idleMs=1800000（…）/ lingerMs=600000（…）/ queueLimit=4（…）` | 表里**没有**（L308 只有一行把 `lingerMs` 当证据） | 补一行；注意**旧样本**里这行叫 `daemon idle/queue:`（无 linger）——README 若还留旧名请改 |
| A7 | `daemon ports: configured=8932(+3 回退) actual=8932 slot=8932` | 表里**没有**（L304 只把它当证据行） | 补一行；写明"未运行时 `actual=(未运行)`" |
| A8 | `daemon state dir (WSL): …/remote-wsl（元数据**按槽位**：daemon.<slot>.json / daemon.<slot>.token，0600；日志 daemon.log；本插件不把守护的东西落 /tmp）` | 表里**没有**（L305 证据行） | 补一行 |
| A9 | `resident runtimes (in-host backend only): (none)` | 表 L478 写作 `resident runtimes:`（**无** `(in-host backend only)` 后缀） | 标签对齐（表里补后缀） |
| A10 | 尾行 `remote-wsl: 宿主退出；WSL 侧守护保持运行（关客户端 ≠ 会话结束）` | 表里没有 | 可选补一行（属提示语，非字段） |

**反向核对**：表 L470–480 的 9 行（`distros/target/wsl ip/desktop dsh version/version this plugin uses/wsl pin/drift/resident runtimes/web hosts/pid files in WSL /tmp`）在实测里**都能找到** ⇒ 没有"表里有、实测没有"的项。

## B. README 内部自相矛盾（比 A 类更值得先改）

| # | 矛盾点 | 位置 |
|---|---|---|
| B1 | **元数据文件名**：L85–87 说 `~/.dsh/remote-wsl/daemon.json`（单文件）、退出时清理 `daemon.json`/`daemon.token`/`launch.sh`；L109–121 说**按槽位** `daemon.<slot>.json` / `daemon.<slot>.token` / `launch.<slot>.sh`。实测：**按槽位**（`daemon.8912.json`、`daemon.8932.json` 并存，均为 0600；`launch.<slot>.sh` 起来后自删） | L85–87 未随 L109–121 更新 |
| B2 | **`daemon:` 行格式**：L273（`running pid= port=`）与 L304（`pid= actualPort= slot=`）两种写法并存，实测是二者**合并后**的形态（见 A5） | L273 vs L304 |
| B3 | **`daemon idle/queue:` vs `daemon idle/linger/queue:`**：旧样本/旧文字无 `lingerMs`，实测有 | L308 附近 |

## C. 本清单**不覆盖**（避免越界）

- `wsl_exec` / `wsl_agent` / `wsl_open_ui` / `wsl_sync_version` 的输出面 —— 本轮只抓了 `wsl_status` 与 `wsl_daemon`。
- `docs/*.md` 与 README 其余章节 —— 只按"实测输出行"逐条对，没有通读全文。
- 未运行态下 `daemon ports: … actual=(未运行)` 已实测；**未实测**：多 key 时 `keys=n [k(turn N,pid P), …]` 的完整形态（我用 0 key 验证）⇒ 若要写进 README，建议 lead 用自己的多 key 现场再核一次。
