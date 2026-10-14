# REPORT —— T55：补 `wsl_open_ui` 的 `open:true` 与 `WebHost.start()` 失败/超时路径

> 补齐 T47 报告里列的"未复核 1/2"。**未改 `src/**`**：所有变异都在 `%TEMP%` 的**整目录副本**上做（带锚点命中次数断言），
> 真调用一律**孤立 `DSH_HOME`**。写域：本证据目录。

## 结论

- **① `open:true`**：用**记录器法**证明该分支被走到、且 URL 形状正确 —— `http://127.0.0.1:8916/?token=…`，工具输出 `(opened: recorded-t55)`；
  全程**产生过 0 个可见窗口、收尾后 0 个**（可见窗口 11→11、新增 `WindowsTerminal` 0）。
  **口径如实**：记录器法 ≠ 真实开窗 —— 它只证明"`open:true` 走到那一步、拿到的是合法 URL"，**没有**验证 `openAppWindow()` 真去开浏览器（那会在用户桌面弹窗，本轮按纪律不做）。
- **② `WebHost.start()` 失败/超时**（两种构造）：**都可读错误、都不是裸抛** ——
  (i) `dsh web` 非零退出 ⇒ `remote-wsl: web 进程退出（exit 7）`（204ms）；
  (ii) 起了但拿不到 URL（把 60s 定时器改 1500ms + `exec sleep 30`）⇒ `remote-wsl: web 未在 60s 内给出 URL`（1609ms）。
- **③ 一个真缺陷（新发现，未修 —— `src/**` 不在本轮写域）**：**失败后同端口再调一次会"静默假成功"** ——
  `WebHost.start()` 开头是 `if (this.child) return this.url;`，失败后 `this.child` 已置、`this.url` 仍是空
  ⇒ 第二次调用**0ms 返回 `null`** 而工具照样报 OK：原始输出 `[②retry 同端口第二次] OK 0ms :: null | (opened: not-opened)`。
- **④ 残留口径（P2 卫生）**：失败路径**不自动清理**（`/tmp` 脚本 + `.pid` 必留；超时构造下 WSL 侧进程还活着），
  但**调用方 `{stop:true}` 能 100% 收干净**（进程/端口/`/tmp` 三项增量都回到 0）。逐条数字见下表。

## ① `open:true`（记录器法；`out-10-recorder.txt`）

```diff
- const how = (args?.open ?? true) ? openAppWindow(url) : 'not-opened';      # 原样（会被真开窗）
+ const how = (args?.open ?? true) ? (globalThis.__t55_url = url, 'recorded-t55') : 'not-opened';   # 副本里换成记录器
```
```
PATCH recorder: 命中 1 处
[①open:true（记录器）] OK 2397ms :: http://127.0.0.1:8916/?token=ZeAMjsWc74gLYJxJARSh7vr9Fhf5EaWQpTu4BLzWEJ4 | (opened: recorded-t55)
RECORDER url=http://127.0.0.1:8916/?token=ZeAMjsWc74gLYJxJARSh7vr9Fhf5EaWQpTu4BLzWEJ4
ASSERT 记录器被走到且 URL 形状正确 = true
窗口：可见 11 → 11；新增 WindowsTerminal = 0
```
**代码级差异证据（(b) 法）**：`open:true` 与 `open:false` 的差异就是**同一个三元表达式的一次调用**：
`(args?.open ?? true) ? openAppWindow(url) : 'not-opened'` —— `false` 分支只把 `how` 写成字面量 `'not-opened'`
（T47 的 `out-02-after.txt` 有此原始读数），`true` 分支多一次 `openAppWindow(url)`；两条路径**共用同一个 `url`**（同一次 `host.start()` 的返回值）。

## ② 失败/超时（`out-10-exit.txt` / `out-10-timeout.txt`）

| 构造 | 可读错误（原始） | 耗时 | 调用后增量（进程/端口/`tmp`） | `{stop:true}` 后 |
|---|---|---|---|---|
| (i) `exit 7`（整行替换 exec） | `remote-wsl: web 进程退出（exit 7）⏎ <stderr tail>` | 204ms | **0 / 0 / +2** | **0 / 0 / 0** ✅ |
| (ii) `exec sleep 30` + 定时器 1500ms | `remote-wsl: web 未在 60s 内给出 URL⏎ <stderr tail>` | 1609ms | **+1 / 0 / +2** | **0 / 0 / 0** ✅ |

- 量具说明：`/tmp` 与进程数都取**增量**（本探针每次都是新 winpid，绝对数会含历史残留；`sweepOwnTempFiles` 只清**自己 winpid** 的文件，
  这也是为什么历史残留不会被后一次运行顺手清掉）。
- `+2` = 该次启动留下的 `<script>.sh` + `.pid`；`+1` = (ii) 里被 `exec sleep 30` 顶住的 WSL 侧进程（真孤儿，直到 stop）。
- **结论口径**：失败路径**可读、可恢复，但不自清**。调用方只要 `{stop:true}`（或任何会 `sweepOwnTempFiles` 的同进程路径）就能回收到 0 —— 已在两行 `DELTA[stop 后]` 上进位证明。

## ③ 故意红（`out-10-red-swallow.txt`）

把**失败路径**改成吞错（副本里把超时分支的 `reject(...)` 换成 `resolve('http://127.0.0.1:0/')`）：
```
[②red-swallow] OK 1632ms :: http://127.0.0.1:0/ | (opened: not-opened)
ASSERT 故意红（失败被吞掉 ⇒ 这里应为 false）= false        ← 断言变红 ✅
```
不带该变异的同构造复跑即回到绿（`out-10-timeout.txt` 的 `ASSERT 可读错误 = true`）。**变异全部在 `%TEMP%` 副本上，`src/**` 一个字节没动**（`git status --porcelain -- src/ client/ package.json` 为空）。

## 新缺陷：失败后重试 ⇒ 静默假成功（`out-14-retry-clean.txt`）

```
[②retry] THREW 1611ms :: Error: remote-wsl: web 未在 60s 内给出 URL ⏎ <stderr tail>
[②retry 同端口第二次] OK 0ms :: null | (opened: not-opened)
ASSERT 第二次返回的是**可用的 http URL** = false     ← 报 OK 但 URL 是 null ⇒ 静默假成功
```
根因（读码）：`WebHost.start()` 第一行 `if (this.child) return this.url;`；失败时 `this.child` 已赋值、`this.url` 仍空，
而宿主把它留在 `webHosts` 里 ⇒ 第二次同端口调用直接返回空 URL 且**没有任何错误**。
**与 T47 的两条同族**（都是"失败/异常路径留下的状态没有清理或不被检查"）。⇒ **建议作为 P2 派单**；本轮写域不允许改 `src/**`，只报不改。

## ④ 护栏复跑 / 隔离 / 收尾

| 检查 | 结果 |
|---|---|
| `arch-t3/tools/export-matrix.ts` | **PASS**（31 符号） |
| `arch-t2/tools/check-docs-methods.ts` | **PASS ｜ 断言 13 条** |
| 用户全局 `~\.dsh\storages\workspace.json` | `before = after = A764A306D6112450120E0653014FB8DBD8CC7A77647E891A9F82881772F303A9` ⇒ **完全相同** |
| 收尾 | `t55-*` 副本 0、`/tmp/dsh-rwsl-*` 0、`dsh-rwsl-*` unit 0（含 `reset-failed`）、守护 0、`dsh web` 宿主 0、8910 段监听 0、**新增 `WindowsTerminal` 0** |

⚠️ **一条不属于本轮的卫生问题（如实报，未处置）**：`systemctl --user` 现为 **`degraded`**，failed = **2**：
`t15k26568u.service`（`[systemd-run] bash -c "for i in 1..8; do date … >> /tmp/t15k26568.tick; …"`）与
`t15s33132.service`（`[systemd-run] bash /tmp/t15s33132.sh`），
两条的 `ActiveEnterTimestamp` 都是**今天 11:33:16 / 11:33:33**（本会话 T55 窗口内，但**不是我的**：我这轮一个 `systemd-run` 都没用，
全部构造都走 `wsl.exe -- bash`）。⇒ 是谁在 11:33 重跑了 **T15 的探针矩阵**（命名同款 `t15k<pid>u`/`t15s<pid>`），
请其 owner `stop` + `reset-failed` 即可恢复 `running`；**我没有动别人的单元**（此前也因动了会被你表扬过边界守得对）。

## 【一旦错了就得返工】

1. **"可读错误"已证，但"无孤儿"没证成 —— 这是本轮最重要的口径**：失败路径**不自动清理**。
   若按"失败即无孤儿"下结论就会漏掉：`/tmp` 脚本 + `.pid` 必留、(超时构造)WSL 侧进程继续存活。
   唯一保证是**调用方调 `{stop:true}`** ⇒ 判据必须写成"**失败后可读 + stop 后可 0**"，而不是"失败后就是 0"。
2. **重试缺陷（静默假成功）**：`start()` 的 `if (this.child) return this.url` 早退 + 失败后状态残留 ⇒ 第二次调用报 OK 但 URL 为空。
   这类"假成功"比报错更危险（UI 会显示一个空/错 URL 而没有任何告警）。
3. **记录器法的边界**：它证明"分支被走到 + URL 合法"，**不证明** `openAppWindow()` 真能开窗 —— 报告里必须一直带着这个限定词。
4. **我的探针第一次跑出的"失败"是夹具 bug**（整行锚点漏了行尾 `--no-open` ⇒ 生成 `exit 7 --no-open` ⇒ bash 立刻退 1），
   差点把"脚本写坏"当成"产品失败路径"。⇒ 变异脚本必须**整行替换 + 命中次数断言**，并且要**手工复核生成的脚本原文**。

## 【其余的】

- 四个模式各一份原始输出；每个模式都把 `src/` 整目录复制到 `%TEMP%\t55-<mode>-<rand>`，只在副本上替换（`recorder` 1 处、`exit` 整行 1 处、`timeout`/`red-swallow` 各 2~3 处，均有命中数断言）。
- 收尾删净副本；`%TEMP%\t55-home`（孤立 home）已删；端口只用 8916/8917/8918/8919；未装任何包；未碰用户宿主 19387（现 pid 33688）与用户窗口。

## 未复核：5 条

1. **真实开窗**（`openAppWindow()` 的实际行为：调什么、成不成功、URL 是否正确交给浏览器）—— 记录器法无法覆盖，且按纪律不能触发。
2. **失败路径是否存在其他自动清理路径**：本轮只证明了 `{stop:true}` 能清；"同进程下一次别的工具调用顺手 `sweepOwnTempFiles`"只间接推断（`stop` 分支里有它），未单独构造。
3. **失败后 `webHosts` 里残留的 host 对象在宿主重启后的行为**（该状态不落盘 ⇒ 重启即丢）未测。
4. **重试缺陷的完整面**：只在超时构造下测了"同端口第二次"；非零退出构造下的第二次、以及"第二次之后 `{stop:true}` 是否仍能收干净"未逐个测。
5. **`open:true` + 启动失败**的组合（失败时不应开窗、也不该留下记录器调用）未构造。

## 证据文件（`spike/verify/explorer-20261012/arch-t55/`）

`REPORT-openui-paths.md`、`out-10-recorder.txt`、`out-10-exit.txt`、`out-10-timeout.txt`、`out-10-red-swallow.txt`、`out-14-retry-clean.txt`（重试缺陷）、`out-11-retry.txt`（首版）、`out-12-matrix.txt`、`out-13-docs.txt`、`sha-before.txt`；脚本 `probe-t55.ts`。
