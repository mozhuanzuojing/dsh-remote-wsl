# REPORT —— P1：`stopDaemon` 元数据/退出复核（task-25，杜绝隐形孤儿）

- **结论**：`stopDaemon` **不再无条件删元数据**。现在在 `removeMetaFiles` **之前**用 `scanDaemonProcesses()`（读 `/proc/<pid>/cmdline` 认 `daemon.ts` + `--state-dir`，**不依赖元数据**）**有界等待复核**该槽位已无本方守护；仍在 ⇒ **保留元数据** + 返回 `ok:false` + 可读错误（孤儿保持**可发现**），绝不把它删成隐形。兜底 `killWslPid` 之后的"等待并验证退出"由同一个有界复核承担（2s 上限、300ms 间隔）。**成功路径行为与输出不变**：与"改前等价"变异 A/B 对照，`STOP` 行**归一化 pid 后逐字相同**；本次改动是**纯新增 56 行、0 删除**。
- **改动面（仅 `src/daemon-client.ts`）**：`4D5C2EBF…` → **`CB420D25EF1BCF9535CBF2F3DBB3FAAD95FA0D5321B31D0CA798103DE59DBED1`**；其余 7 个 src 逐字不变。

## 1. 实现

```js
if (!r.ok) killWslPid(cfg, rec.meta?.pid);            // 兜底（仍只发 TERM、仍先验身份）
const survivors = await waitForSlotGone(cfg, port, rec.meta?.pid);   // ★ 新增：有界复核（2s / 300ms）
if (survivors.length) {                               // ★ 仍在 ⇒ 保留元数据 + 可读失败
  log(`stop 未完成：槽位 … 仍有本方守护 pid=… ⇒ 按 P1 保留元数据（不制造隐形孤儿）`);
  return { ok: false, …, transport: r.ok ? 'shutdown' : r.kind, alivePids: survivors.map(s=>s.pid),
           error: `remote-wsl: stop 未完成：… 已按 P1 规矩**保留元数据** daemon.<slot>.json ⇒ 它仍是**可发现**的…` };
}
removeMetaFiles(cfg, rec.slot, rec.legacy);           // 只有确认没有存活守护才删
```
`waitForSlotGone(cfg, port, pid)`：匹配口径 = **同一 pid 或同一 `--port`**（守护可能按端口 +1 迁移过，只看 pid 会漏；只看端口会把"同端口换了 pid 的新守护"也算残留 —— 那更该报出来）。
**为什么必须有界**：`shutdown` 成功 ≠ 进程已退（守护还要回收运行时）；无界等待会把"守护卡住"变成"UI 卡住"。
**为什么这条修的是根因**：隐形孤儿的定义就是"**元数据**没了、**进程**还在" ⇒ 根因是"删元数据"与"进程确实没了"之间**没有因果校验**，现在把删除挂在校验之后。

## 2. 验收 ① 正常 stop（`out-01-normal-fixed.txt`）

```
ENSURE {"ok":true,"slot":8912,"port":8912,"reused":false}      MODE=systemd   ← 主路径（无窗）
STOP {"ok":true,"slot":8912,"port":8912,"pid":1571643,"version":"0.2.0-rc.2","reaped":[],"transport":"shutdown"}
① 元数据已清 = true    ① 该槽位无进程 = 1566872@8962（那是**别人的**守护，未被碰）
```
**A/B 逐字对照**（`out-03-normal-prefix-equiv.txt`；对照物 = 把 `if (survivors.length)` 改成 `if (false && …)` 的**改前等价**变异）：
```
修复版  : STOP {"ok":true,…,"pid":<P>,"version":"0.2.0-rc.2","reaped":[],"transport":"shutdown",…}
改前等价: STOP {"ok":true,…,"pid":<P>,"version":"0.2.0-rc.2","reaped":[],"transport":"shutdown",…}
归一化后逐字相同 = True
```
（`pid` 每次都是新进程，故归一化后再比；其余字段——含 `reaped`/`transport`/`alreadyStopped` 语义——完全一致。）

## 3. 验收 ② "守护不响应/不退出"（`out-02-orphan.txt`）

构造手法：**真守护** + `kill -STOP <pid>`（冻结 ⇒ `callDaemon` 5s 超时、`kill -TERM` 挂起不生效，进程仍在）。用真守护的好处：元数据是**真格式**、且可 `SIGCONT` 恢复（不会留永久孤儿）。
```
SIGSTOP 结果: T  (T = stopped)
# daemon shutdown on slot 8913 (port 8913): ok=false 守护调用失败(timeout): no reply within 5000ms
# stop 未完成：槽位 8913（端口 8913）仍有本方守护 pid=1568757 ⇒ 按 P1 保留元数据（不制造隐形孤儿）
STOP1 {"ok":false,"transport":"timeout","alivePids":[1568757],"error":"remote-wsl: stop 未完成：…已按 P1 规矩**保留元数据** daemon.8913.json ⇒ 它仍是**可发现**的…"}
② 元数据仍在 = true ✅     ② scanDaemonProcesses 仍可见 = …,1568757@8913 ✅     ② 返回可读失败 = true ✅
恢复：kill -CONT 1568757 ⇒ SIGCONT 结果: gone（挂起的 TERM 立即送达 ⇒ 守护自己收尾并删掉自己的元数据）
STOP2 {"ok":true,"alreadyStopped":true,"note":"自己槽位 8913 没有守护（未去停别的槽位）"}
```
⇒ ② 三条断言全绿，且**孤儿不是永久残留**（恢复后自愈/可再次收掉）。

## 4. 验收 ③ 故意红（`out-04-red-orphan.txt`）

去掉"移除前复核"（= 回到改前语义）后跑**同一**孤儿场景：
```
STOP1 {"ok":true,"transport":"timeout","alivePids":null}     ← 谎报成功
② 元数据仍在 = false                                          ← 元数据被删（RED）
② scanDaemonProcesses 仍可见 = …,1574173@8913（进程还活着）
② 返回可读失败 = false                                        ← 断言变红 ✅
```
⇒ **隐形孤儿被完整复现**（元数据已删、进程还在、工具报 ok）。字节还原后（`restore byte-exact: True`）② 复绿。

## 5. 验收 ④ 回归

- `--dump-config`：**exit 0 / `Error:` 0 / 与基线逐行 diff = 0 行**。
- **空槽位** `stop(8915)` ⇒ `{"ok":true,"alreadyStopped":true,"reaped":[],"note":"自己槽位 8915 没有守护（未去停别的槽位）"}`（槽位隔离语义未变）。
- **`stop --all`**：把 `cfg.wslHome` 指到**孤立 state 目录**（`/home/g/t25-iso-home`，真实 state 目录一个字都没碰）后跑 ⇒ `{"ok":true}`，无异常；孤立目录**未被创建**（`stopAll` 只读扫描）。**我没有对真实 state 目录执行 `stop --all`** —— 当时本机有一个**别人的**守护（`1566872@8962`）在跑，`stop --all` 按设计会停掉它；宁可不跑，也不碰别人的槽位。该函数本轮**一行未改**（`git diff --stat` 只有 `stopDaemon` 体内 + 新 helper）。

## 6. 环境 / 窗口 / 收尾

- **每轮 ensure 都报告 `mode: systemd`**（8912 / 8913）⇒ 走的是**无窗主路径**，**没有发生 compat 回退**；全程 `WT = (空)`、包装层空、可见窗口只有用户应用（`Code/Cursor/DSH 47604/explorer/gephgui-wry/msedge/QQ/TextInputHost/Weixin`）⇒ 窗口 ∆=0。lead 提示的 `degraded` 已由 lead 复位为 `running`，本轮开始时 `is-system-running = running`。
- 收尾：守护 **0**、`daemon.*.json` **0**、`launch.*` 残留 **0**、state 目录只剩 `daemon.log` + `launch-stderr.log`、我造的副本/临时目录 **0**、`dsh-rwsl-*` 单元 **0** 且已 `stop`+`reset-failed`；19387/47604 未动。
- ⚠️ **一个不是我的 failed 单元**：收尾后 `is-system-running` 仍为 `degraded`，`failed` 计数 1，名字是 **`t29-failed-probe.service`**（`[systemd-run] /usr/bin/false`，创建时间 09:32）—— 我的单元一律叫 `dsh-rwsl-<slot>.service`，且已清零。**我没有去 `reset-failed` 它**（不属于本任务，可能是 T29 的探针）。⇒ 若需要恢复 `running`，请让那个任务的 owner 清，或授权我清（一条 `systemctl --user reset-failed t29-failed-probe.service`）。

## 7. 未复核

1. **"shutdown 成功但进程慢慢退"** 这条分支：本次走的是"超时/不响应"路径；有界复核按构造同样覆盖它（等待窗口内退出 ⇒ 正常删元数据），但**没有单独构造**该时序。
2. **身份闸拒绝杀**（cmdline 不含 `daemon.ts`）时 `killWslPid` 不发信号 ⇒ 依赖复核发现存活并保留元数据；检测路径与本次相同，未单独构造。
3. 恢复步骤依赖 Linux 语义"**stopped 进程收到 SIGTERM 会挂起、`SIGCONT` 后立即送达并退出**"；这是本机 Debian 的行为，换内核/发行版未验证。
4. `waitForSlotGone` 的 2s 上限是经验值（守护正常退出在几十~几百 ms 量级）；**极慢退出**（>2s）会被判"可能仍在"并保留元数据 —— 这是**偏保守**的选择（宁可留可发现的记录，也不制造隐形孤儿），代价是可能多一次 `stop`。

## 8. 证据文件（`spike/verify/explorer-20261012/host-p1/`）

`REPORT-stop-metadata.md`、`out-01-normal-fixed.txt`（① 修复版）、`out-03-normal-prefix-equiv.txt`（① 改前等价 A/B）、`out-02-orphan.txt`（② 孤儿场景 + 恢复）、`out-04-red-orphan.txt`（③ 红）、`out-05-dumpconfig.txt`、`baseline-sha256.txt`/`final-sha256.txt`；脚本 `probe-p1.mjs`、`mut-t25.mjs`。
