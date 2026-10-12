# REPORT —— `index.ts:1022` 同型双前缀收口（task-22）

- **结论**：`wsl_daemon` 路径上的双前缀**已收口**，只用了 `client-panel` 在 `src/explorer.ts` 导出的既有 helper（未另发明逻辑）。实测同一位置：**改前 2 份 `remote-wsl:` → 改后 1 份**；而**无标记**的失败文案**逐字不变**（仍恰好 1 份，说明是"守卫"而不是"删"）。正常路径 `start`/`status` 输出**逐字相同**（含 `machine:` 与 `launch:` 行）。故意红（把调用点临时换成"无条件删前缀"）⇒ 无标记路径的"含 `remote-wsl:`"断言**变红**（0 份），字节还原后复绿。
- **改动面**：只有 `src/index.ts`（`A8BDB70C61ACACBC07906307E2954D1F9B4F6C9FA97D167EECDE349536FC43D7`），实际 delta = **import 一行 + throw 一行 + 注释**；其余 7 个 src 逐字不变（首尾双断言）。`explorer.ts` **未碰**（哈希与基线一致）。

## 1. 改动（两处，共 2 行有效代码）

```diff
-import { registerExplorer } from './explorer.ts';
+// `withModulePrefix`：F-38 同族收口（task-22）—— 上游 `ensureDaemon` 的聚合错误在组合条件下**已含** `remote-wsl:`
+// 且落在**句中**（`远端守护… —— remote-wsl: …`），直接再拼一次就会出两份标记；helper 用 `includes` 守卫
+// （`startsWith` 对句中标记永远不命中）。
+import { registerExplorer, withModulePrefix } from './explorer.ts';

-    if (!r.ok) throw new Error(`remote-wsl: ${r.error}`);
+    // task-22：上游 `r.error` 在组合条件下已含 `remote-wsl:`（落在句中）⇒ 用 `withModulePrefix` 守卫，
+    // 不再无条件拼前缀（否则会得到两份 `remote-wsl:`）。非标记文案仍会被补上恰好一份。
+    if (!r.ok) throw new Error(withModulePrefix(r.error));
```
**其余 `remote-wsl:` 站点一律未动**（自撰单前缀 12 处、`[remote-wsl: …]` 括号注记等），错误码/工具签名/输出结构均未改。

## 2. 验收 ①：同一位置 改前/改后 真实原文对照

触发条件 = `DSH_REMOTE_WSL_SYSTEMD=on` + systemd 托管失败（组合条件；见 §5 关于触发手段的说明），走 `wsl_daemon action=start`，打印**抛出的原文**：

**改前（BEFORE，`before-fail-on.txt`）——`remote-wsl:` 出现 2 次：**
```
remote-wsl: 远端守护在 Windows 侧不可达：试过端口 8911, 8912, 8913 —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on
但 systemd 托管失败（找不到 systemd-run（发行版可能未启用 systemd））；按显式配置**不**回退。这些端口在
Windows 命名空间里可能被别的程序占用（WSL 侧 bind 成功不代表 Windows 侧能连上）。请释放其中一个端口，
或把 config.daemonPort 指到别的端口。
daemon.log 尾部：…
```
**改后（AFTER，`after-fail-on.txt`）——`remote-wsl:` 出现 1 次：**
```
远端守护在 Windows 侧不可达：试过端口 8911, 8912, 8913 —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on
但 systemd 托管失败（…）；按显式配置**不**回退。…
daemon.log 尾部：…
```
⇒ **同一位置的差异只有开头那份多余前缀**；句中那份（上游自带）原样保留。
> 注意：**它不是 `remote-wsl: remote-wsl` 形式** —— 第二份落在句中（`… —— remote-wsl: …`）。这正是 helper 必须用 `includes` 而非 `startsWith` 的实测理由（`startsWith` 对本例永远不命中）。

**无标记路径（伪造发行版，天然不需要改环境）**：改前 `remote-wsl: 出现次数 = 1`、改后 `= 1`，文案**逐字相同** ⇒ 守卫路径对"本来没有标记"的文案**仍然补一份**，没有变成 0 份。

## 3. 验收 ②③：中性 + 判据

- **正常路径逐字不变**：`wsl_daemon action=start` / `action=status` 的输出在改前/改后**逐字相同**（除去 pid/时间戳/`remote-wsl(explorer)` 注册行这类每次都变的部分）；
  关键行原样：`machine: slot=8911 pid=… port=8911 version=0.2.0-rc.2 reused=false`、`launch: mode=systemd warning=null`、`notes: 启动方式: systemd-run --user（…）| 槽位 8911 由 Windows 侧握手确认就绪（实际端口 8911，4ms）`。
- **判据（脚本 `probe-t22.mjs` 自动审计）**：`remote-wsl:` 出现次数 `== 1` **且** `remote-wsl: remote-wsl` 不出现。
  `[fail-on] 出现次数 = 1  双前缀 = false`、`[fail-inst] 出现次数 = 1  双前缀 = false`；正常 `start`/`status` 的**工具文本**里 0 份（标记只出现在 stderr 日志行，与本站点无关）。

## 4. 验收：故意红（证明"只能守卫、不能删"）

把调用点临时换成**无条件删前缀**（`String(r.error).replace(/^remote-wsl:\s*/, '')`，等价于 helper 被改成只删不守）⇒ 跑**无标记**失败路径（伪造发行版）：
```
[RED] 远端守护在 Windows 侧不可达：…（**开头没有 remote-wsl:**）
[fail-inst] remote-wsl: 出现次数 = 0      ← 断言变红 ✅
```
字节还原（`restore byte-exact: True`）后同路径复跑：`出现次数 = 1`（复绿）。
⇒ 结论：**删前缀会让无标记文案失去模块标记**，因此只能守卫。变异只落在我自己的 `index.ts` 调用点（未触碰 `explorer.ts`）。

## 5. 回归 / 未复核

- **回归**：`--dump-config` **exit 0 / `Error:` 0 / 与基线逐行 diff = 0 行**；`wsl_status` 实跑正常（18 行、`daemon:` 行在），且它**不经过**该 throw 站点（它只读状态：`daemonStatus`，站点在 `ensureDaemonReady` 的失败分支）；`wsl_daemon status` 输出逐字不变（§3）。收尾：unit 空、守护 0、包装层 0、`launch.*.sh` 残留 **0**、**无 WindowsTerminal**、state 目录只剩 `daemon.log`/`launch-stderr.log`；19387、47604 未动。
- **未复核 / 说明**：
  1. 触发双前缀需要"上游错误自带标记"的组合条件（本例 = `=on` + 托管失败）。本机发行版**有** systemd，所以我用**临时把启动脚本里的 `systemd-run` 换成不存在的命令名**来制造该失败（**源码级临时变异、非环境改动**：没动 `/etc/wsl.conf`、没装东西），跑完已字节还原（`mut restore byte-exact: True`）。若不接受此手法，可在真实"未启用 systemd"的发行版上复跑（T21 若有该环境更佳）。
  2. 按指示**未走** `DSH_REMOTE_WSL_SYSTEMD=off`（compat 路径会弹 1 个窗）；因此本轮没有新增窗口面证据 —— 该站在成功/失败两条路径上都不产生副作用（纯文案收口）。
  3. 判据是"`remote-wsl:` 计数 + `remote-wsl: remote-wsl` 子串"两条；对本例"句中双标记"它命中（计数 2→1），但**不覆盖**"标记被拼在句首两次"的其它写法（若将来出现 `remote-wsl: remote-wsl:` 形态，计数与子串两条都能红）。

## 6. 证据文件（`spike/verify/explorer-20261012/host-prefix/`）

`REPORT-index-prefix.md`、`before-fail-on.txt`、`after-fail-on.txt`（双前缀路径 改前/改后）、`before-fail-inst.txt`、`after-fail-inst.txt`、`red-fail-inst.txt`（无标记路径 改前/改后/红态）、`before-start.txt`、`after-start.txt`、`before-status.txt`、`after-status.txt`、`out-10-dumpconfig.txt`、`baseline-sha256.txt`/`final-sha256.txt`；脚本 `probe-t22.mjs`、`mut-t22.mjs`。
