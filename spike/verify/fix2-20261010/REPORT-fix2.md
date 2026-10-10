# task-14 独立复验报告 — F1/F3/F4 + F2 的修复（spike-verify）

- **revision**：开工与收尾两次对 `src/*.ts` 取 SHA256，**7/7 与冻结清单逐一相同**（`REVISION.txt`；收尾断言 `FINAL_ALL_MATCH=True`）⇒ **所有结论都基于同一 revision**，无跨版本混证。
- 写作用域：`spike\verify\fix2-20261010\`。被验文件零改动。端口只用我的专属段 8841–8870。WSL 命令一律 base64→bash / 落文件+bash，**无内联**；未用全局 `pkill`；未删他人 `/tmp` 文件。

## 结论：task-12/13 的五项修复**全部独立通过**，含 Lead 没拿到的那半条断言

### 1. F1（最关键）— 完整断言通过，且已收敛到单一真相源
现场：A(8841) 与 B(8842) 两个**健康**守护（各有元数据、握手 5ms/4ms），此时无孤儿。

| 动作 | 原始输出 |
|---|---|
| 对 B 不带 slot `stop` | `machine: slot=8842 pid=406202 port=8842 version=0.2.0-rc.2 reaped=0 orphans_left=0`，**无 `Orphans:` 行** |
| stop 后查 A | `daemonStatus = {"ok":true,"slot":8841,"pid":405630,"port":8841,"orphans":[]}` ⇒ **A 存活且握手正常** |

⇒ Lead 只拿到的"无 `Orphans:` 误报行"之外，**"停 B 而 A 存活"**这条也拿到了（我自己的脚本 `run-f1.ps1`，未复用实现者脚本）。

**单一真相源核对**：`daemon-client.ts:739 daemonSnapshot()` 返回 `{slots,records,live[],dead[],livePids,procs,orphans}`，`daemonStatus`（:767）与 `index.ts` 的 stop 分支（:1311）**都调它**；`index.ts` 内**已无** `scanDaemonProcesses(config)` 直接调用（grep 0 命中）⇒ 不是"又写一份判定"。

### 2. F1 反例 — 真孤儿仍被识别（没修成"一律不报"）
真造孤儿（8843：isolated 起守护后删元数据，进程活着、`listen=1`）：

- `snapshot.orphans=[{"pid":406800,"port":8843}]`；`daemonStatus.orphans` 同一 pid；工具 status `machine: … orphans=1` + `Orphans: ⚠️ 1 个守护在跑但无元数据（pid406800@8843）`
- 此后对 A 不带 slot `stop` ⇒ `orphans_left=1` + `Orphans: … pid406800@8843`，**Orphans 行不含任何健康守护 pid**（我按 snapshot 里的 `405630,406202` 逐个查过）
- `ensure` 侧口径一致：`note: 槽位 8843 上发现**无元数据/失联**的本插件守护 pid=406800 ⇒ 先收掉再起（不留孤儿）`，`{"ok":true,"slot":8843,"port":8843,"pid":408033}` ⇒ **仍在请求槽位起（未迁移 +1）**，随后 `orphans=[]`

⇒ `status` / `stop` / `ensure` 三处孤儿口径**一致**（同一 snapshot），且真孤儿不会被漏掉。

### 3. F3 — 五种动作机器行统一，同一正则全部可解析
```
[start   ] machine: slot=8844 pid=409691 port=8844 version=0.2.0-rc.2 reused=false
[status  ] machine: slot=8844 pid=409691 port=8844 version=0.2.0-rc.2 keys=0 orphans=0
[restart ] machine: slot=8844 pid=410089 port=8844 version=0.2.0-rc.2 reused=false
[stop    ] machine: slot=8844 pid=410089 port=8844 version=0.2.0-rc.2 reaped=0 orphans_left=0
[stop-all] machine: slot=all  pid=-      port=-      version=-      stopped=1 killed=0 orphans_left=0 reaped=0
```
正则 `^machine: slot=(\S+) pid=(\S+) port=(\S+) version=(\S+)( .*)?$` 对五条全部匹配（含"守护未运行"时的 `slot=- pid=- port=- version=- orphans=0`）。`extra` 段仍按动作不同（`reused` / `keys+orphans` / `reaped+orphans_left` / `stopped+killed+orphans_left+reaped`）——属文档化设计；**解析影响面**：上一轮我自己按旧格式 `daemon=<pid>@<port>` 写的解析式已失效，外部脚本需按新格式（这正是 F3 的意图）。

### 4. F4 — 无 `wsl.exe` 层内联；功能面计数正确
`src/*.ts` 内所有含 `bash` 的行逐条人工核对，**零处**"`wsl.exe … -- bash -c/-lc \"<含 $ 的串>\"`"；剩余 `bash -c` 均为**已论证安全**的形态：
`daemon-client.ts:199`（`echo <b64> | base64 -d | bash`，base64 已消除展开面）、`daemon.ts:138`/`sdk-runtime.ts:114`（WSL 内 `spawn('/bin/bash',['-c',script])`，父进程即 bash，无 zsh 介入）、`index.ts:208`（**已落文件**的脚本内部再 `bash -c` 探代理，父 bash 为 argv-exec）、`shell-env.ts:42`（登录 shell 环境片段自身）。
`index.ts:948-950` 的注释记录了整改理由。功能面：`wsl_status` 的 `pid files in WSL /tmp` 走落文件后计数**正确**——BEFORE `0` → 我造 3 个 `.pid`（+3 个 `.sh`）后 `3`（该计数只数 `.pid`，与文案一致）→ 一次有副作用调用后 `0`，`MINE_LEFT=0`。

### 5. F2 — 夹具判据与文案一致且真覆盖自建 `/tmp` 足迹
`test.ts`/`adversarial.ts` 的 **P0 前置闸门**打印 7 行 `lib=… src=… MATCH`（前缀与冻结 revision 一致）+ `PASS P0 前置：rwsl-test\lib\*.ts 与 vendor src\*.ts 逐字节一致`。
`adversarial.ts` 断言 **32 PASS / 0 FAIL**，其中：
- `PASS Z3 … 本夹具私有 wslHome 目录已清理（**只覆盖 /tmp/rwsl-adv-\***，即夹具自建的目录）`（文案已收窄到实际范围）
- `PASS Z4 … 本运行自己的 /tmp/dsh-rwsl-27976-* 归零（自作用域真判据；覆盖 D2 in-host 与 E WebHost 的自建文件 + 探针）  [第①步=6 第②步(wsl_exec后)=6 第③步(sweep后)=0]` ⇒ 声称的"sweep 会清"**实测为 6→6→0**
- `PASS Z5 … 最终为 0（兜底清理后复核）`

### 6. README node 口径
`README.md:136-138` 明确写：`runtime.json` 声明 **24.21.0**，而**宿主进程实测 24.18.1**（引探针 `TS-PLUGIN-LOADED-OK node=v24.18.1`），并说明 `engines.node` 写 26.10 是 WSL 侧守护口径；`:210` 环境行同口径。`src/*.ts` + 桥脚本 grep `process.versions.node|semver|parseInt(process` ⇒ **无任何版本守卫**。

### 7. 回归
`test.ts` exit 0 / 9.3s（6 工具含 `wsl_daemon`、两轮答 `7`、`warm ok`、`disposers=1`、`backend=daemon`）；`adversarial.ts` exit 0 / 75.2s（32 PASS/0 FAIL）；真宿主 e2e exit 0 / 9.9s（导入错误 0）；`ADV_FORCE_FAIL=1` ⇒ **exit 1**（5 条 FAIL：C1/C2/C3/D1h/D1i，故障注入行在）⇒ 断言仍非假绿。

### 8. 收尾（自作用域差值 0）
`my_private_dirs=[]`、`my_ports_8841_8870_listeners=[]`、共享 state dir 只剩 `daemon.log launch-stderr.log`（= 基线）、全局无守护、`/tmp/dsh-rwsl-*` 为空、pin=`0.2.0-rc.2`；我自建的 `/tmp/rwsl-fix2-8844` 已删。**未碰**任何他人足迹。

## 独立判断

- **F1 修法确实收敛到单一真相源**，而不是第二份判定：`daemonSnapshot` 同时供 `daemonStatus`、`wsl_daemon status`、`stop`（含 `orphans_left`）使用，`index.ts` 不再直接扫进程表；且"有元数据的活守护"与"无元数据孤儿"的区分由 `livePids`（真实握手得来）决定 —— 这解释了为什么它同时满足"不误报健康守护"和"不漏报真孤儿"。（我上一轮报 F1 时正是这两件事被同一个函数混淆。）
- **机器行统一没有破坏内部解析**（插件自身不解析该行），但**外部脚本必须改**：旧 `daemon=<pid>@<port>` 已不存在。建议在 README 给出一行正则样例（现在只有字段名）。
- **仍然存在的边界**（非本轮缺陷）：`stop all=true` 会连带杀掉**共享 state dir 上别的宿主的守护与孤儿**（它按设计如此）；裸 `stop`（不带 slot）只看自己槽位，孤儿需靠 `all=true` 或"对该槽位 ensure"两条路径回收 —— 本轮我刻意**只用逐槽位 stop + ensure** 收尾，避免误杀他人。
- 无新引入的自相矛盾；`machine` 行缺项一律 `-` 的约定在"守护未运行"与 `stop --all` 两种边界下都自洽。

## 证据清单（`spike\verify\fix2-20261010\`）

| # | 项 | 文件 |
|---|---|---|
| 0 | 冻结 revision（开工/收尾 7/7 MATCH） | `REVISION.txt` |
| 1 | F1 完整断言 + 反例 + 三处口径（`RUN-F1: ALL CHECKS PASSED`） | `out-01-f1.txt`，`out-f1-00..13-*.txt` |
| 2 | F3 五条机器行（同一正则全匹配） | `out-02-f3f4.txt`，`out-f3-1..7-*.txt` |
| 3 | F4 grep 逐条 + 计数 0→3→0 | `out-02-f3f4.txt`、`out-04-f4count.txt` |
| 4 | F2 P0 闸门 7 MATCH + Z3/Z4/Z5（6→6→0） | `out-03-regression.txt` |
| 5 | 回归 test/adversarial/e2e/FORCE_FAIL | 同上 |
| 6 | 收尾哈希一致性断言 `FINAL_ALL_MATCH=True` | 本报告 §收尾 + 终端记录 |

**无密钥外泄。**
