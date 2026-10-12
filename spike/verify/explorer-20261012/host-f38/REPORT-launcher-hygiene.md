# REPORT —— F-38 启动脚本卫生（task-19）：失败路径回收 + 创建即 0600 + `mode/warning` 字段化

- **结论**：T18 抓到的那条真 RED **已修并复现验证**。三条：**① 失败路径回收**（本轮所有尝试槽位，含端口回退；成功路径仍由守护自删）；**② 创建即 0600**（改在 **WSL 侧** `umask 077` + `chmod 600` 写脚本 —— 因为 **UNC/9p 上 `chmodSync` 静默无效**，这正是 T18 看到 0644 的原因）；**③ `mode`/`warning` 成为机器可读字段**（`ensureDaemon` 结果里 + `wsl_daemon` 输出新增 `launch: mode=… warning=…` 一行；`notes[]` 照旧保留）。验证：T18 场景（`=on` + 托管失败 + 端口回退 8911/8912/8913）**残留 0、未起守护、错误仍明确"不"回退**；故意红（禁用回收）⇒ **残留 3**（且那 3 个也是 `-rw-------`，证明 ② 独立成立），字节还原后转绿；三条路径（systemd / compat-off / restart）的脚本**都被观测到 600**。

## 1. 改了什么（写作用域 `src/daemon-client.ts` + `src/index.ts`）

| 文件 | SHA256 | 内容 |
|---|---|---|
| `src/daemon-client.ts` | `4D5C2EBF955CBAABB4EC8A2A64E6EF528B98790C1EF0DE8D8C87E9D126D88E7F` | `WRITE_LAUNCHER_SCRIPT` + `writeLauncherWsl()`（WSL 侧写、0600）、`removeLauncher()`、`reclaimLaunchers()`、失败路径回收、结果带 `mode`/`warning` |
| `src/index.ts` | `84ACA8D025473F284F5626509919BABEA15B579601D596E18D8D6323A6B463F4` | `wsl_daemon` start/restart 输出新增 `launch: mode=… warning=…` 一行（`machine:` 行**未动**，其字段语义保持冻结） |
| 其余 6 个 src | — | **逐字不变**（首尾双断言） |

**F-38a 回收点（三处，全部按"本次尝试过的槽位"回收）**：
1. `launchDaemon` 启动环节就失败（`=on` 拒绝回退 / 写脚本失败）⇒ 调用方立刻 `reclaimLaunchers([port])`；
2. 某个槽位握手始终不通过 ⇒ 该槽位回收；
3. 整轮都失败（`return {ok:false, …}` 之前）⇒ **兜底回收 `tried` 里全部端口**。
成功路径**不变**：脚本由守护起来后自删（§2 实测 start 后 state 目录无 `launch.*.sh`）。

**F-38b 为什么要改成 WSL 侧写**：原来 `writeFileSync(tmp,{mode:0o600}) → rename → chmodSync`，而 **UNC/9p 上 chmod 静默无效**（T15/T17 已实测；F31 同坑）⇒ 未被执行的脚本就以 **0644** 留下（T18 的 `launch.8936.sh/8937.sh`）。现在：
```bash
umask 077
printf %s "$B" | base64 -d > "$P" && chmod 600 "$P"
```
脚本内容以 **base64 作为 argv 位置参数**传入（无 shell 元字符）。原子性说明：写入期间该脚本**不会**被任何进程执行（只有拿到 `LAUNCHER_OK` 后调用方才去 `systemd-run`/`spawn`），故不存在"读到半截脚本"的窗口。

## 2. 验收（逐条原始输出）

**① T18 场景复现**（`=on` + systemd 不可用 + 端口回退；`out-01-scenario-on.txt`）：
```
RESULT {"ok":false,"mode":null,"warning":null,"tried":[8911,8912,8913],
        "error":"远端守护在 Windows 侧不可达：试过端口 8911, 8912, 8913 —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on
                 但 systemd 托管失败（找不到 systemd-run…）；按显式配置**不**回退…"}
[after] launch 残留:（空）
[after] 守护进程数 = 0
[watch] 600 /home/g/.dsh/remote-wsl/launch.8911.sh
        600 …launch.8912.sh
        600 …launch.8913.sh
[scenario] 是否残留 launch.* = 0      [scenario] 是否起了守护 = 0
```
⇒ **无残留 + 未起守护 + 错误仍"不回退"** 三条同时成立；三次尝试的脚本**都被观测到 600**（watcher 每 100ms 采样一次）。

**② 正常路径**（`out-02-normal.txt` / `out-03-restart.txt` / `out-04-off.txt`）：

| 情形 | `mode` | `warning` | 脚本权限（watcher） | start 后残留 |
|---|---|---|---|---|
| ensure（systemd 主路径） | `systemd` | `null` | `600` | 无（守护自删） |
| restart | `systemd` | `null` | — | 无 |
| `DSH_REMOTE_WSL_SYSTEMD=off` | `compat-detached` | **非空**（含 `/etc/wsl.conf` 建议） | `600` | 无 |

**③ 工具面（F-38c）**（`out-13-tool-launch-line.txt`）：
```
daemon start: ok port=8911 pid=1148911 version=0.2.0-rc.2 reused=false
machine: slot=8911 pid=1148911 port=8911 version=0.2.0-rc.2 reused=false
launch: mode=systemd warning=null          ← 新增机器可读行
notes: 启动方式: systemd-run --user（unit dsh-rwsl-8911.service…） | 槽位 8911 由 Windows 侧握手确认就绪…
```
（`=off` 时该行为 `launch: mode=compat-detached warning=⚠️ 未能由 systemd 托管守护…`；失败时 `ensureDaemon` 结果里 `mode:null, warning:null` —— 调用方可据此判定"没起来/没回退"，不必解析 notes。）

**④ 故意红**（禁用失败路径回收，`out-05-red-residue.txt` + `out-06-after-restore.txt`）：
```
[after] launch 残留:
-rw------- launch.8911.sh
-rw------- launch.8912.sh
-rw------- launch.8913.sh
[scenario] 是否残留 launch.* = 3     ← 断言变红 ✅
```
⇒ 还原后同场景 `是否残留 launch.* = 0`（转绿），两个变异**均字节还原**（`restore byte-exact: True`）。
注：红态下残留脚本是 **`-rw-------`（600）**，与 T18 观测到的 `-rw-r--r--`（644）对比 ⇒ **F-38b 的修复独立于 F-38a 成立**。

**⑤ 回归**：`--dump-config` **exit 0 / `Error:` 0 / 与 T12 基线逐行 diff = 0 行**；窗口面 1 轮 **∆=0**；存活面 1 轮 **宿主退出后握手 ok、pid 不变**（`1148041 → 1148041`）；槽位隔离：非配置槽位 `explorer.daemon{slot:9999}` ⇒ `throw code=E_ARG`（`slot 9999 不是本插件配置的槽位（9999≠8911）`）且 **state 目录前后完全一致（无副作用）**；`--collect` 不回归（stop 后 `systemctl --user list-units 'dsh-rwsl-*'` 为空）。

## 3. 未复核 / 交接

1. **`explorer.daemon` 的结果字段（F-38c 的另一半）**：`explorer.ts` 是 `client-panel` 的独占写作用域，本轮**未碰**。`ensureDaemon` 现在已返回 `mode`/`warning`，因此 `explorer.daemon` 只需把 `r.mode`/`r.warning` 放进 `result`（一行改动）。⇒ **交接给 client-panel**；`wsl_daemon`（`index.ts`，我的作用域）已完成。
2. **代价**：F-38b 改成 WSL 侧写脚本，每次启动尝试**多一次 `wsl.exe` 调用**（≈0.4–0.8s）；主路径原有一次 systemd-run 调用，故启动总耗时从 ≈0.6s 增到 ≈1.0–1.5s（一次性成本，未做基准对比）。
3. **`launch-stderr.log` 的 0600**：它仍靠"F31 的脚本内 chmod"，即**脚本真的跑起来**才收紧；失败路径下它若是**全新**创建的文件，理论上可能仍是 0644（本机现状一直是既有 0600 文件，`openSync 'a'` 保持原 mode）⇒ **未构造"全新状态目录 + 纯失败路径"来实测**。
4. `-u g`：所有验证都用默认用户（与插件一致）；未验证以其他用户运行时的 unit/权限行为。
5. watcher 采样是 100ms 粒度、且依赖脚本在采样窗口内存在（本次采到 3/59 行不等）⇒ "创建即 600"的结论建立在**每次采样到的都是 600**（含红态残留的 `ls -la` 复核），不是"从未出现过 644"的穷尽证明。

## 4. 证据文件（`spike/verify/explorer-20261012/host-f38/`）

`REPORT-launcher-hygiene.md`、`out-01-scenario-on.txt`、`out-02-normal.txt`、`out-03-restart.txt`、`out-04-off.txt`、`out-05-red-residue.txt`、`out-06-after-restore.txt`、`out-10-dumpconfig.txt`、`out-11-window-survival.txt`、`out-12-slot-guard.txt`、`out-13-tool-launch-line.txt`、`baseline-sha256.txt`/`final-sha256.txt`；脚本 `probe-f38.mjs`、`mut-f38.mjs`、`probe-slot-guard.mjs`、`probe-tool-line.mjs`。
