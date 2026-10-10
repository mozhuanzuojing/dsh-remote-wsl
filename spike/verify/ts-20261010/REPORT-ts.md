# task-8 独立复验报告 — 整轮 `.mjs`/JS → TypeScript 迁移（spike-verify）

写作用域：`spike\verify\ts-20261010\`。被验文件零改动。**协议**：所有 WSL 检查走 base64→bash 或落文件+bash（实测内联 `bash -c` 会被登录 shell zsh 接管，`i=`/glob 空计数会假绿）。

## ⚠️ 先说要紧的：验证期间被验物被改动（影响 task-11 报告的时间口径）

`spike-verify` 开工时（17:13）的版本与收尾时的版本**不是同一份**：

| 文件 | 我开工时 | 我收尾时 |
|---|---|---|
| `src/index.ts` | 16:42:58 / 70,947 B | **17:25:00 / 72,525 B** |
| `src/daemon-client.ts` | 17:00:28 / 35,083 B | **17:24:19 / 36,449 B** |
| `src/selftest.ts` | 17:01:23 / 17,191 B | **17:23:20 / 18,282 B** |

⇒ 我 task-11 报告中的并发/槽位/寿命闸门/漂移/端口/文本证据（采集于 17:15–17:23）对应**旧版**；17:24–17:25 的改动**恰好修掉了我报的 F1/F3**：新版不带 slot 的 `stop` 输出 `machine: slot=8861 pid=367001 port=8861 version=0.2.0-rc.2 reaped=1 orphans_left=0`，**不再**把别的槽位健康守护误报为"无元数据孤儿"（`index.ts` 里未过滤 livePid 的那行已不存在）。我已在**新版**上复跑：两槽位并发启动 OK（`machine: slot=8861 pid=360812 …` / `slot=8862 pid=360114 …`）、dump-config OK、e2e OK、直连 src 的 prompt 答 `TS8-OK`。
**另一后果**：`rwsl-test\lib\*.ts` 副本 17:16 时与 src 逐字节相同，现在 **MATCH=False**（`index.ts`/`daemon-client.ts` 均已陈旧）⇒ 夹具回归此刻跑的是旧插件。
**建议**：验证前冻结产物（或给一个 revision 哈希），验证窗口内不要改动；夹具副本需在信任其结果前重新 `Copy-Item`。

## 结论（逐条）

1. **零构建可加载性 ✓（两个版本各验一次）**：`dsh --profile remote-wsl-test --dump-config` → exit 0 / **407 行** / `# == dsh-remote-wsl` 层在 / 导入类错误 **0**；真实 e2e → exit 0（旧版 12.85s、新版 15.7s），stderr 无 `failed to import`/`ERR_MODULE`/`Cannot find module`，`backend: daemon`。
   `package.json`：`type: module`、`main`/`exports` → **`./src/index.ts`**、`files: ["src","cordis.patch.yml","README.md","package.json"]`、`engines.node: ">=26.10"`、`engines.dsh: ">=0.2.0-rc.2"` ⇒ 指向 `src/` 成立。
2. **零构建直跑 ✓**（node **v26.10.0**，mise shim）：桥脚本 `node dsh-sdk-bridge.ts --help` exit 0（打印文档头，说明 type stripping 生效）；`spike/client.ts --status` exit 2 + 可读 `ECONNREFUSED`；`spike/daemon.ts` 真起（stdout listening JSON `{"ok":true,"event":"listening",…}`）后按 `/proc` 身份杀，残留 0；夹具 `test.ts` exit 0（8.9s），`adversarial.ts` exit 0 / **30 PASS / 0 FAIL**（报告见 `fix-20261010/out-07b`）。
3. **无 `.mjs` 残留 ✓**：插件目录 0、`spike/` 0、`~/.agents/scripts` 0、`rwsl-test` 0（四处均 0）。
4. **行为未变 ✓（归一化对比）**：同代码 `.mjs` vs `.ts` 对 —— `CMP-test-mjs.out`≡`CMP-test-ts.out`、`MIG-test-mjs.log`≡`MIG-test-ts.log` **归一化后逐行相同**；adversarial 对仅差 session 短哈希 / 全局 `profile sdk` 计数 / 后台 warm 时序（易变字段，非结构差异）。我新鲜跑 `test.ts`：迁移前不变量全在（6 工具含 `wsl_daemon`、两轮答 `7`、`warm ok`、`cleanup disposers=1`）。`run-spike.ps1 -Port 8881 -WithStale -WithIdle` → **SPIKE RESULT: ALL CHECKS PASSED**，且已改为 task-7 的基线差值断言（自带端口 8881/8882 隔离、按自身 pid 归属、对并发存在的 10 个他人 runtime 明确"不判"）。
   *注*：`BASELINE-test.log` 是守护接入前的时代，直接对比会显示 54 行"差异"，逐类核对后全部是 task-3/9 的功能增量（backend/actualPort/lingerMs/localhost forwarding/dlx 等），**不是迁移回归**；迁移等价性以第 4 条的同代码对为准。
5. **`lib/` 冗余已清 ✓**：`lib/` 不存在；回滚点 `_backup/index.js.bak-auditfix-20261010_141716`（38,582 B）保留且**不在 `files` 里**（不会随包发布）。符号抽样：回滚点里有的（`SdkRuntime`/`writeScript`/`resolveVersion`/`WebHost`/`wsl_agent`）src 全有，另有新增（`ensureDaemon`/`scanDaemonProcesses`/`shellEnvSnippet`/`desktopRuntimeCandidates`/`warmScript`/`dlxInventoryScript`）⇒ src 是超集。
6. **Node 口径 ✓（一处文档缺口）**：`package.json` 与 `spike/package.json` 均 `>=26.10`，桥脚本头部声明 `>=26.10`；**无任何"低于 26.10 就抛错"的运行时守卫**（grep `process.versions.node`/`semver`/`throw…26.10` = 0）⇒ 不会把桌面宿主挂掉。
   **缺口**：README 写"桌面自带 node **24.21.0**"（134/207 行），全文**未出现 24.18.1**；而 DSH 宿主进程实际跑 24.18.1（证据：task-3 探针留档 `%TEMP%\dsh-ts-probe-evidence.txt`：`TS-PLUGIN-LOADED-OK node=v24.18.1 … 宿主进程实际跑在 node 24.18.1（不是 primary-runtime 的 24.21.0）`）。我尝试用 `ELECTRON_RUN_AS_NODE=1 <DeepSeek Harness.exe> -e …` 直接取证未得到输出（GUI exe 不落 stdout），故以该留档为准。建议补一行说明"engines 是目标基线、宿主实为 24.18.1、无守卫、实测可加载"。
7. **收尾**：我的作用域 0 —— 8861/8862 元数据与监听已清、`/tmp/dsh-rwsl-*` 无我的文件、pin=`0.2.0-rc.2`。**未碰他人的**：并发 teammate 的 daemon（`/tmp/rwsl-adv-33252*`→8822/8823、`/tmp/rwsl-adv-31872*`→8824/8825，以及共享 state dir 上的 8731）与 `/tmp/dsh-rwsl-33252-*`（属主 winpid 33252）一律保留并在此说明。
8. **独立判断**：
   - 迁移本身**没有引入多余复杂度**：无 `tsconfig`、无 `scripts`、无 dist，`spike/package.json` 只用 `type: module`（顶层 await 的硬要求）+ `engines` + `//` 说明。
   - **类型不是装饰**：`src/*.ts` 共 4012 行、类型注解行 **471**，而旧 `index.js`（939 行）只有 2 个 JSDoc 类型标签；线上仍以行内注解 + JSDoc 为主（`src` 内 `interface`/`type` 声明数 = 0，具名接口集中在夹具里）——可接受，属风格选择。
   - **两条被我抓到"过渡期/流程"问题**：①产物在验证窗口内被改（见上，导致 task-11 结论需按版本读）；②夹具副本不再与 src 同步，`双态导入`只保证"能跑"，不保证"跑的是当前交付物"——建议把副本刷新纳入每次验证的前置断言（哈希不一致就红）。
   - 另：我这轮选的"唯一端口"8861/8862 与另一位验证者的槽位**撞车**（我 `tool-start --port 8862` 得到 `reused=true`，对端守护由别的 winpid 起）⇒ 建议端口改为集中分配（共享表）而不是各自猜。

## 证据清单（`spike\verify\ts-20261010\`）

| # | 项 | 原始要点 | 文件 |
|---|---|---|---|
| 1 | dump-config | exit 0 / 407 行 / 插件层 1 / 导入错误 0（旧版+新版各一次） | `out-01a-dumpconfig.txt`、`out-01a2-dumpconfig-newrev.txt` |
| 2 | 真实 e2e | exit 0 / 12.85s（旧版）、15.7s（新版），无导入错误，`backend: daemon` | `out-01b-e2e.txt`、`out-01b2-e2e-newrev.txt` |
| 3 | 直跑 .ts | bridge `--help` exit0；client exit2 `ECONNREFUSED`；daemon listening→kill→0 | `out-02a/02b/02c` |
| 4 | 归一化对比 | CMP/MIG test 对逐行相同；adversarial 仅易变字段 | 本报告 §4（命令与输出见终端记录） |
| 5 | 夹具回归 | test.ts exit0（8.1s/8.9s）；adversarial 30 PASS/0 FAIL | `fix-20261010\out-07a/07b` |
| 6 | run-spike | ALL CHECKS PASSED（8881/8882、基线差值、他人 10 runtime 不判） | `out-04a-runspike.txt` |
| 7 | 新版复跑 | 两槽位 `machine: slot=8861 pid=360812…`；stop `orphans_left=0`（F1 已不复发）；prompt `TS8-OK` | `out-08a..08f`、`out-09-cleanup.txt` |
| 8 | `.mjs` 计数 | 四处均 0 | 终端记录（本报告 §3） |
| 9 | 超集/回滚点 | `lib/` 无；备份 38,582 B 保留、不在 `files`；符号抽样 src ⊇ backup | 终端记录（本报告 §5） |

**无密钥外泄；未用全局 `pkill`；未删他人 `/tmp` 文件。**
