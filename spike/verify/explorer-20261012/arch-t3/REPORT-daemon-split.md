# REPORT-daemon-split.md —— T3：`daemon-client.ts` 拆分（protocol / launch / lifecycle + 薄 re-export）

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-13 ｜ **任务**：`task-38`（架构债包 §2 的 T3）
- **写作用域（实际只动这 4 个 src 文件 + 本目录）**：`src/daemon-client.ts`（改为薄层）+ **新建** `src/daemon-protocol.ts` / `src/daemon-launch.ts` / `src/daemon-lifecycle.ts`
- **未动**：`src/daemon.ts` · `src/explorer.ts` · `src/index.ts` · `client/**` · `docs/**` · `package.json`（`git status` 见 §6）
- **旧版备份（先另存，含 SHA256）**：`backup/daemon-client.cb420d25.ts.bak`（53,881 B）
  - 原文件 **sha256 = `cb420d25ef1bcf9535cbf2f3dbb3faad95fa0d5321b31d0ca798103de59dbed1`**，1068 行 / 41,879 字符 / 53,881 字节
  - 该 sha 与 **T26 报告记录的 `daemon-client.ts CB420D25EF1B…` 一致** ⇒ 拆分起点的文件自 T26 起未变（不是我改出来的差异）
- **产物规模**：`daemon-protocol.ts` 15,236 B ｜ `daemon-launch.ts` 18,935 B ｜ `daemon-lifecycle.ts` 23,436 B ｜ `daemon-client.ts` **1,789 B（57 行，薄 re-export）**
- **工具（本目录，可复跑）**：`tools/analyze-split.ts`（依赖分析）· `tools/apply-split.ts`（机械拆分器）· `tools/export-matrix.ts`（导出矩阵）· `tools/probe-imports.ts`（逐导出调用探针）· `tools/smoke-e2e.ts`（端到端冒烟）

## 1. 结论

**拆分完成，对外面与行为两不变。** 31 个导出符号**拆前/拆后逐符号一致**（present/typeof/**arity** 三项零差异，且无多出符号）；**19/19 端到端冒烟 PASS**（本机走 `mode=systemd` 主路径：`wsl_status` 报 pid、`explorer.snapshot` 的 daemon 段指向本槽位、`explorer.listDir` 列 72 项、`explorer.daemon{ensure}` 幂等复用）；**`stopDaemon` 的 `ok:false` + 可读 notes 语义在 `SIGSTOP` 下原样保住**，并经 `explorer.daemon{stop}` 透传（explorer.ts 的 `ok: r.ok !== false` / `stopNotes` 依赖它）；`--dump-config` exit 0 / `Error:` 0；故意红成立（副本删一个 re-export ⇒ 矩阵红、exit 1）；**无可见窗口**。
**实现体逐字搬移**：唯一的改动是给两个跨模块复用的私有符号补 `export`（`sleep`、`killWslPid`），由脚本 `apply-split.ts` 按**行区间**生成，可复核；新增的这两个模块内导出**未**进入 `daemon-client` 的对外面。

## 2. 拆分结构（块级映射，可直接复核）

| 目标模块 | 从原文件搬走的块（原行号） | 对外导出 |
|---|---|---|
| `daemon-protocol.ts`（协议/IO 层） | `sleep`(25) `unc`(28-32) `winToWsl`(33-39) `daemonScriptWsl`(40-43) `stateDirLinux`(44-45) `metaLinux`(46) `tokenLinux`(47-53) `launchLinux`(54) `logLinux`(55-60) `legacyMetaLinux`(61) `legacyTokenLinux`(62-64) `listDaemonSlots`(65-81) `readDaemonMeta`(82-94) `readDaemonToken`(95-108) `readDaemonRecord`(109-135) `readDaemonLogTail`(136-149) `scanDaemonProcesses`(150-195) `wslRunScript`(196-215) `tcpCall`(236-291) `handshake`(292-302) `callDaemon`(303-318) `daemonPrompt`(977-1012) | 21 个 + `sleep`（模块内共用） |
| `daemon-launch.ts`（启动层） | `killWslPid`(319-328) `launchScript`(329-361) `SYSTEMD_LAUNCH_SCRIPT`(362-378) `systemdUnit`(379-381) `ensureStateDir`(382-404) `WRITE_LAUNCHER_SCRIPT`(405-418) `writeLauncherWsl`(419-440) `removeLauncher`(441-449) `launchDaemon`(450-602) `configCompat`(603-618) | 5 个 + `killWslPid`（供 lifecycle 用） |
| `daemon-lifecycle.ts`（生命周期层） | `removeMetaFiles`(216-235) `ownDaemonsOnPorts`(619-624) `recordForPid`(625-641) `ensureDaemon`(642-854) `waitForSlotGone`(855-874) `stopDaemon`(875-943) `stopAllDaemons`(944-976) `daemonSnapshot`(1013-1039) `daemonStatus`(1040-1068) | 5 个 |
| `daemon-client.ts`（薄层） | 全部改成 `export { … } from './daemon-*.ts'` | **31 个（与拆前逐一对应）** |

依赖方向 **protocol ← launch ← lifecycle**（无环）。跨模块 import 清单不是靠肉眼：先用 `analyze-split.ts` 做块级引用分析（`out-01-analyze.txt`），再用**使用点定位**（每个符号的调用行号）复核 —— 过程中抓到分析器漏报的一个真实依赖（`launchScript` 用 `daemonScriptWsl`），已补进 launch 的 import。

## 3. 验收逐条（原始输出在盘）

### ① 导出矩阵：拆前/拆后逐符号对照（`out-02*` / `out-03*` / `out-03b*`）
```
before: 期望=31 实到=31 缺=0 多出=0        （out-02-export-matrix-before.json）
after : 期望=31 实到=31 缺=0 多出=0        （out-03-export-matrix-after.json）
逐符号比对：共 31 个；**不一致 = 0**  ⇒ 全部 present/typeof/arity 三项一致 ✅   （out-03b-export-matrix-diff.txt）
```
（`--strict-surface`：多出符号也算失败 —— 两个矩阵都判 PASS。`sleep`/`killWslPid` 只在各自模块里，**未**出现在 `daemon-client` 对外面。）

### ①b 附加：**逐导出调用探针**（防"漏 import 只在运行时炸"）
```
探针符号数 = 33；ReferenceError = 0
daemon-client 对外符号 = 31；多出 = (无)
结果：PASS                                    （out-04-probe-imports.json/.txt）
```
对每个符号都**真的调用一次**：纯函数用正常参数；会连/起/停守护的用**不存在的 distro**（`__no_such_distro__`）让它在最早期失败 —— 既进函数体，又不起进程、不碰真实 state dir、不停别人的守护。

### ② `--dump-config`
```
exit=0  行数=1291  Error 命中=0               （out-06-dumpconfig.txt）
```

### ③ 端到端冒烟（真守护，slot **8911**）
```
冒烟：19/19 PASS；失败：(无)                   （out-05-smoke-e2e.json/.txt）
```
关键行（原文摘要）：
- **`mode=systemd` 主路径**：`守护已由 systemd 托管（unit=dsh-rwsl-8911.service）：Windows 侧包装层短命 ⇒ 无窗口；unit 归用户 systemd`
- `A6 daemonStatus` → `{ok:true, slot:8911, pid:1875152, version:0.2.0-rc.2}`；`A8 handshake` → `{ms:3}`
- `B2 wsl_status` → `daemon: running pid=1875152 actualPort=8911 slot=8911 version=0.2.0-rc.2 …`
- `B3 explorer.snapshot` → `daemon={"running":true,"slot":8911,…,"others":[]}`；`B4 explorer.listDir` → `count=72`
- `B5 explorer.daemon{ensure}` → `{reused:true, started:false, mode:"reused", warning:null, notes:["复用自己槽位 8911 的守护：端口 8911，Windows 侧握手 3ms 通过"]}`
- **C 相（SIGSTOP 造失败面）**：`C1 stopDaemon ok:false`（`{"ok":false,"error":"remote-wsl: stop 未完成：槽位 8911（端口 8911）的本方守护进程仍在（pid 1875152）。已按 P1 规矩**保留元数据** daemon.8911.json ⇒ 它仍是**可发现**的…"}`）、`C2 可读` ✓、`C3 explorer.daemon{stop}` → `result.ok=false` + `notes[]` 非空 ✓
- `D1/D2`：收尾 stop 后 `live=[]`、`orphans=0` ✓

### ④ 故意红
```
副本改前含 'daemonSnapshot,' 次数 = 1
副本改后含 'daemonSnapshot,' 次数 = 0
期望 31 个符号；实到 30；缺 daemonSnapshot
结果：FAIL        RED exit=1   （期望 1）
```
变异**当场验证生效**（1→0 处），失败项**恰好归因**到被删的那个 re-export；同一脚本对真对象判 PASS（§①）。

### ⑤ 无可见窗口（启动方式 + 归属）
- **本机走 systemd 主路径**，daemon-client 自己的日志即证据：`systemd-run --user（unit dsh-rwsl-8911.service；包装层短命 ⇒ 无窗口，且与 Windows 侧生死解耦）`。
- 我的工具里唯一的外部进程是 `spawnSync('wsl.exe', …, { windowsHide: true })`（daemon-client 原样，未改）与一次 `Start-Process -WindowStyle Hidden`（收尾审计，命令写在 `.sh` 里走位置参数）。
- **窗口枚举（收尾）**：9 个，**无一个是 `wsl.exe`/conhost 窗口**；归属：`chrome`(14136 必应搜索) · `chrome`(51164 Jira) · `Code`(17048) · `Cursor`(16624) · `DeepSeek Harness`(47604) · `gephgui-wry` · `msedge` · `TextInputHost` · `Weixin`（全为用户/既有应用，**我一个都没关**）。

## 4. 硬约束逐条核对

| 约束 | 结论 | 证据 |
|---|---|---|
| ① 对外导出矩阵不得掉 | ✅ 31/31 且 arity 一致、无多出 | §① / `out-03b` |
| ② `stopDaemon` 的 `ok:false`+`notes` 语义不得变 | ✅ SIGSTOP 下 `ok:false` + 可读 error；explorer 透传 `ok:false`+`notes[]` | §③ C1/C2/C3 |
| ③ `daemonSnapshot` 仍是唯一孤儿真相源 | ✅ 未改判定逻辑（逐字搬移），冒烟里 live/orphans 与 `wsl_status` 一致 | §③ A5/D2 |
| ③ 不改 `src/daemon.ts` | ✅ 未在写域内、未触碰 | §6 git status |
| ③ 不改槽位/元数据文件布局 | ✅ 仍 `daemon.<slot>.json` / `.token` / `daemon.log`；state dir 里无新文件 | §5 收尾 `ls` |
| ③ 保留 `mode`/`warning` 与 F-38 文案 | ✅ `B5` 出现 `mode:"reused"`/`warning:null`；`C1` 保留"按 P1 保留元数据…不制造隐形孤儿"原文 | §③ |
| 端口只用 8911–8920 | ✅ 仅用 8911（防呆断言：越界即 exit 3） | `smoke-e2e.ts` 首行校验 |
| 不写用户全局 `~/.dsh/storages/workspace.json` | ✅ 我的工具面**无** `addWorkspace`/`workspace.json` 命中；冒烟只调 `snapshot`/`listDir`/`daemon` | 见 §7 观察 |
| 不许弹窗 | ✅ 见 §⑤ | 同上 |

## 5. 收尾清理（原始输出 `out-07-cleanup-wsl.txt`）

```
--- failed units ---            （空）
--- unit state ---     inactive
--- reset-failed ---   Failed to reset failed state of unit dsh-rwsl-8911.service:
                       Unit dsh-rwsl-8911.service not loaded.   rc=1
--- after reset ---    inactive
--- state dir ---      daemon.log   launch-stderr.log        （无 daemon.8911.json / 无 launch.8911.sh 残留）
--- 8911 listen ---    0
remote-wsl wsl.exe 包装层：无 ✅
port 8911 free ｜ port 8912 free
活宿主 19387 = 47564（未变）
```
- **`reset-failed` 我按要求跑了**：该 transient unit 在守护退出后已被 systemd **卸载**，故报 `Unit not loaded`（rc=1）；随后 `is-failed` = `inactive`。⇒ 收尾态 **无失败单元、无我的 unit 残留**（`--failed` 为空）。
- 守护已停（`live=[]`、`orphans=0`、8911 无监听）；**未触碰任何他人槽位**（本次全程只操作 8911）。

## 6. `git status`（只动写域）

```
$ git status --porcelain -- src/daemon-client.ts src/daemon-protocol.ts src/daemon-launch.ts src/daemon-lifecycle.ts
 M src/daemon-client.ts
?? src/daemon-protocol.ts
?? src/daemon-launch.ts
?? src/daemon-lifecycle.ts
```
- **共享 checkout 声明**：仓库当前被 T4（`src/explorer.ts`/`client/client.api.js`/`src/index.ts`）等并行修改；本报告只用**限定路径**的 status 作为"只动写域"的证据（全局 status 无法归属作者）。
- 零构建纪律：新文件只用可擦除语法、相对导入带 `.ts`、只引 `node:` 内置与同目录相对模块（未引入任何新依赖，未跑 npm/pnpm）。

## 7. 观察（不是我的写入，供 lead 判）

`C:\Users\l\.dsh\storages\workspace.json` 的 mtime = **2026-10-13 16:04:54**。这**不是**我的工具写的：`arch-t3/tools/*.ts` 里 `addWorkspace`/`workspace.json` **零命中**，冒烟只调 `explorer.snapshot`/`explorer.listDir`/`explorer.daemon`（**不含** `addWorkspace`）。时间点落在本会话早期（我在写分析器时），**可能是并发会话**（`addWorkspace` 属 T4/`explorer.ts` 的域）在测试。⇒ 我如实登记 mtime 与"我未写"的证据，归属不由我判定。

> 另：本任务工具一律写成 **`.ts`**（`node --experimental-strip-types` 运行），符合用户级规则"脚本一律 TypeScript"；我在上一轮（T2）留下的两个 `.mjs` 工具属该规则之前的产物 —— 需要的话我可以转成 `.ts`。

## 8. 两栏

**【一旦错了就得返工】**
1. **对外面 31 个符号**（含 arity）—— 已用 `export-matrix.ts` 双向锁定（缺/多出/类型/arity 全判）；**T4 若改动 `explorer.ts`/`index.ts` 的取用方式，必须重跑它**（脚本在 `arch-t3/tools/`，建议与 T2 的 `check-docs-methods.mjs` 一起进收尾门禁）。
2. **`stopDaemon` 的失败语义**（`ok:false` + 可读 note/error + 保留元数据不造成隐形孤儿）—— 用真守护 + `SIGSTOP` 实测，且经 `explorer.daemon` 透传复核；这是 T26/T31/T33 刚验过的行为，**不得被后续"顺手重构"改掉**。
3. **`daemonSnapshot` 仍是唯一孤儿真相源** —— 本次只搬不改；若将来有人把孤儿判定复制到别处，就等于回退到本次架构债要修的问题。

**【其余的】**
4. 依赖方向 protocol ← launch ← lifecycle（无环）；`sleep`/`killWslPid` 是唯二新增的**模块内**导出，不进对外面。
5. 块级映射表（§2，带原行号）可直接对着备份复核"逐字搬移"。
6. 备份 + SHA256 已留（`backup/daemon-client.cb420d25.ts.bak`），与 T26 记录哈希一致 ⇒ 起点可审。
7. 逐导出调用探针（33/33 无 ReferenceError）是本次"零构建 TS 无编译期检查"的**专用兜底**，后续任何 src 拆分都能复用。

## 9. 未复核：5 条

1. **`daemonPrompt` 的"成功一轮"路径**未跑（只跑了连接失败路径以防烧模型调用）；其真实 prompt/物化语义沿用 T26/T31 的既有结论。
2. **compat 回退路径**（`DSH_REMOTE_WSL_SYSTEMD` 关掉时）**未跑** —— 本机走 systemd 主路径；回退分支只由"逐导出调用探针"证明**代码可进**，未做行为验证。
3. **`stopAllDaemons` 的全量语义**未在真守护上跑（只用坏 distro 进了函数体），以免误停他人槽位 ⇒ 该函数的"停全部"行为沿用原实现（逐字搬移，未改）。
4. "拆分未改变行为"的覆盖 = **冒烟实际走到的分支**（ensure/status/snapshot/prompt 失败面/stop 成功与失败/launcher 回收/scan/record）；**未做全分支穷举**（例如端口被占的 `+1` 迁移、`noReuse`、`restart:true`）。
5. `--dump-config` 只证明配置组合无误，**不加载**我拆出来的模块（真正的模块级证据是 §①b 探针 + §③ 冒烟）。
