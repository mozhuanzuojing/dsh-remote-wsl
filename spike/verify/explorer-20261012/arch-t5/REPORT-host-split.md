# REPORT —— 架构债 T5：`src/index.ts` 拆分（task-44）

## 结论

**做了什么**：把 `src/index.ts`（**1491 行**）拆成三块并只留 wiring —— **`src/index.ts` = 266 行**（门禁要求 < 400）：

| 新模块 | 行数 | 装什么 |
|---|---|---|
| `src/wsl-io.ts` | 409 | WSL 低层 IO：`writeScript`/`removeScript`/`shellPreamble`/`reapWsl`/`runWsl`/`sweepOwnTempFiles`/`WSLPATH_SCRIPT`/`wslPathConvert`/`readLogViaWsl` + 版本/pin（`desktopVersion`/`readPin`/`writePin`/`resolveVersion`）+ `sleep`/`renderText` |
| `src/in-host-runtime.ts` | 106 | 宿主逃生舱（`backend='in-host'`）的**运行时池** `createInHostPool()` + `inHostAdapter()`；**import 共享 `SdkRuntime`**（禁止再复制） |
| `src/register-tools.ts` | 731 | **七个工具**的注册面 + `WebHost`/`sweepStaleRuntimes`/`openAppWindow` |
| `src/index.ts` | 266 | `name`/`inject`/`DEFAULTS` + `apply` wiring（状态与判定**只在这里**创建）+ `registerExplorer` + disposer |

**怎么做的**：用**带边界断言的切片脚本**逐字搬运（`split-t5b.ts`，源 = `git show HEAD:src/index.ts` 的原始快照），
七个 `tools.register` 的函数体**一字未改** —— `registerTools(deps)` 只在开头做一次**同名解构**，
把拆分前的自由变量改成 deps 字段。**没有**任何工具逻辑重写。

**验证**：门禁① `wc -l src/index.ts` = **266**（<400）；② 工具面**逐符号逐字对照 HEAD = True**（7 个工具的参数 JSON/描述哈希/描述长度/output.schema/render/execute 全同）；③ `--dump-config` exit 0 / `Error:` 0 / diff 0 行；④ 冒烟 `snapshot→listDir→ensure→wsl_status→openSession`（含 `warm:true` 真起一轮）+ **卸载不杀守护**（dispose 后守护仍活、**pid 不变**）；⑤ 故意红（删一个**只在调用期用到**的 import ⇒ 模块仍可加载但真调炸 ⇒ 断言红，字节还原复绿）；⑥ `arch-t3/tools/export-matrix.ts` **PASS**；⑦ 报告见下。

**一条真缺陷（被探针抓到并已修）**：切分后 `wsl-io.ts` 用了 `spawn()` 但只 import 了 `spawnSync` —— **零构建 TS 在 import 期不报错**，直到真调 `wsl_status`（内部走 `runWsl`）才 `ReferenceError: spawn is not defined`。这正是 lead 提醒的那类坑，也成了本轮的故意红素材。

---

## 改动面（只 4 个文件；其余 src 逐字不变）

`git status --porcelain -- src/` ⇒ ` M src/index.ts` + `?? src/{in-host-runtime,register-tools,wsl-io}.ts`（只有这 4 个）。
`explorer.ts`（含 T4 的 `discoverDaemons()` / **`selectOwnedDaemon(live, slot)`**）、`daemon-client.ts`（薄 re-export）、`sdk-runtime.ts`、`version.ts`、`daemon-*.ts` **哈希未变**；`class SdkRuntime` 仍**仅 1 处**（`sdk-runtime.ts:119`）。
**导入边界守住了**：新模块一律**从 `daemon-client.ts` 取**（没深挖 `daemon-protocol/launch/lifecycle`）。
`explorer.ts` 的具名选择器仍在（`rg 'selectOwnedDaemon|discoverDaemons' src/explorer.ts` = 7 处）——**没有**退化回 `live.find`/`live[0]`。

哈希（改后，见 `final-sha256.txt`）：`index.ts`=`2D2AE401067934BCBDFE6E89423B69A02E9C7C3BC660BEF13B8F1552CEDF41FB`、`wsl-io.ts`=`09894DE7AAB401BDA2BD820526FBC1297B593D6CBB932B3BE96B15AAE00427AB`、`register-tools.ts`=`BE9DA470FCE5B0BFF333BE2FDBBE889149EE56672404CC933E0FF19AFB83D5A7`、`in-host-runtime.ts`=`E53AC2A889DFAA16A9E45C0905989FA890F318CCEFE881236861EC1E3A6CD68C`。

## 验收（逐条原始输出）

**① 行数**：`wc -l src/index.ts` ⇒ **`266 src/index.ts`**（拆分前 1491）。

**② 工具面逐符号对照（HEAD vs 工作树，判据 = 逐字相同）**：
```
plugin.name=dsh-remote-wsl inject=[] effectRegistered=true      （两边同）
tool.count=7                                                    （两边同）
wsl_agent        | params={…}| descHash=a0f43e59 descLen=1248 | outSchema={"type":"string"} | hasRender=true | hasExecute=true
wsl_daemon       | params={…}| descHash=65ee2e85 descLen=1330 | outSchema={"type":"string"} | hasRender=true | hasExecute=true
wsl_exec         | params={…}| descHash=3d968ec7 descLen=747  | …
wsl_open_ui      | params={…}| descHash=c309b67c descLen=894  | …
wsl_path         | params={…}| descHash=7cc9c5bd descLen=867  | …
wsl_status       | params={…}| descHash=5b044a95 descLen=452  | …
wsl_sync_version | params={…}| descHash=3524edfc descLen=345  | …
逐字相同 = True
```
> 这个判据比"符号存在"强：它把 `parameters` 全量 JSON、描述哈希+长度、`output.schema`、`render`/`execute` 是否函数都比了一遍（**7/7 逐字相同**）。

**③ `--dump-config`**：`exit=0 / Error命中=0 / 与 T12 基线逐行 diff=0 行`。

**④ 冒烟**（`probe-t5.ts smoke`，真 deps + 真 WSL；`exit=0`）：
```
SMOKE snapshot ok types: daemon={"running":false,"keys":[],"orphans":0,"others":[]}
SMOKE listDir entries=72 (前 3: .agents/dir, .atuin/dir, .bash-preexec.sh/file)
SMOKE ensure ok=true mode=systemd warning=null pid=1910748        ← 主路径（无窗），先读 mode
SMOKE wsl_status lines=18 hasDaemonLine=true
SMOKE openSession(no-warm，面板 P0 的真实调用) => {"sessionId":null,…,"created":false,…,"note":"守护已就绪，但该 cwd 尚无远端会话…"}
SMOKE openSession(warm=true) => {"sessionId":"remote-wsl-explorer-ecc7874b-…","created":true,…,"note":"已用一轮 prompt 物化运行时（warm:true 是显式动作，P0 UI 不调用）"}
SMOKE 判定 = true
```
**④b 卸载不杀守护**（`probe-t5.ts unload`，`exit=0`）：
```
UNLOAD ensure ok=true mode=systemd pid=1911752
UNLOAD after-dispose: daemonAlive=true pidSame=true (1911752)
```
（disposer 与拆分前同一段代码：只 `close()` 本进程持有的 in-host 运行时 + web host + 自有 /tmp 一次性文件，**不碰守护**。）

**⑤ 故意红**（删掉 `wsl-io.ts` 的 `spawn` import —— 它只在调用期用到）：
```
变异后语法期是否仍可加载（期望：可以 —— 这正是零构建 TS 的坑）:
  wsl-io.ts 仍可 import（不报语法错）        ← 没有语法错 ⇒ 静态检查抓不到
RED smoke exit=1
  ReferenceError: spawn is not defined       ← 真调 wsl_status（内部 runWsl）才炸 ⇒ 断言红 ✅
还原 byte-exact: True ⇒ 还原后 smoke exit=0（复绿）
```

**⑥ 跨任务护栏**：
- `arch-t3/tools/export-matrix.ts` ⇒ **`结果：PASS`**（31 个符号 typeof/arity 全 OK）。
- `arch-t2/tools/check-docs-methods.mjs` ⇒ **FAIL(1) / 11 条**：`FAIL 工具数 = 7 — 实得 0`。
  **根因**（不是文档错，是护栏的"工具名权威"路径写死在拆分前的位置）：该脚本第 34 行
  `const indexSrc = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')`，再从中数 `name: 'wsl_*'`；
  T5 把这 7 个注册搬到了 `src/register-tools.ts` ⇒ 数到 0。
  **证明**：我**没有改 T2 的文件**，而是把它复制一份、只把"在哪读工具名"改成 `src/register-tools.ts`（并把 ROOT 绝对化，因为副本在仓外）⇒ **`结果：PASS ｜ 断言 11 条`**（`out-10-gate-docs-patched.txt`）。
  ⇒ **交接一条 2 行改动**（owner = T2）：`arch-t2/tools/check-docs-methods.mjs` 里读 `src/index.ts` 取工具名的那处改读 `src/register-tools.ts`；更稳的做法是**扫 `src/*.ts`** 找 `name: 'wsl_*'`（以后再拆也不怕）。**我没有越界改它。**

## 【一旦错了就得返工】

1. **`registerTools(deps)` 的同名解构**：七个工具体逐字未改，代价是它们现在依赖 **16 个 deps 键名**与拆分前自由变量一致。漏一个键 ⇒ **只在对应代码路径被真调时才炸**（本轮 `spawn` 那条就是同类：静态无感、真调才红）。⇒ 判据必须包含**真调**（本轮的 surface + smoke + unload 三探针）。
2. **切片脚本不幂等**：第一版读的是**已被自己改过的** `src/index.ts`，第二次跑就按旧行号切错（被断言挡住，没写文件）。最终版固定从 `git show HEAD:src/index.ts` 取源。⇒ 复核拆分结果时**不要**再对着"当前 index.ts"重跑旧脚本。
3. **`explorer.ts` 的所有权选择器**：拆分没有碰它，但如果后续有人"顺手"把 daemon 段的发现逻辑复制进 `wsl-io.ts`，就可能退化回 `live[0]` ⇒ 那是 **F33 跨实例误停**的安全边界（T26 验过）。本轮判据：`rg 'selectOwnedDaemon|discoverDaemons' src/explorer.ts` = 7 处、未变。
4. **护栏的权威路径**：`check-docs-methods.mjs` 现在必然 FAIL，直到 T2 owner 落那 2 行。若 lead 要在 T26 前看到"护栏全绿"，这处必须先改；我已在补丁副本上证明改完即 PASS。
5. **HTTP 路由面**：`registerExplorer` 的调用点只是从 index.ts 的旧位置移到新位置，**同源门/仅 POST+JSON/白名单/动词门/F33 槽位守卫一行未动**；但本轮**没有**再端到端跑一遍 HTTP（见未复核 1）。

## 【其余的】

- 机械项：`split-t5b.ts` 的 13 条**边界断言**（每段首尾行都核对，含"`listDistros` 结束行"这类差一风险）；`addExports` 给搬走的 16 个顶层声明补 `export`；`inhost`/`wsl-io`/`register-tools` 的模块头注释写清职责与纪律；`index.ts` 重写为 wiring（266 行）。
- 收尾：`is-system-running = running`、failed 0、`dsh-rwsl-*` 单元 0（**已 `stop` + `reset-failed`**）、守护 0、`launch.*` 残留 0、**`/tmp/dsh-rwsl-*` 残留 0**（清掉 3 个 winpid 已消失的陈旧脚本，按文件名里的 winpid 用 `/proc` 归属判定 —— 不是标题猜）、**无 WindowsTerminal**；`%TEMP%\t5-head` 快照与临时产物待归档后删除。
- 纪律：端口只用 8911–8920（8912）；没跑 npm/pnpm install；没碰 19387/47604；**没有**写用户全局 `~/.dsh/storages/workspace.json`（本轮不碰 addWorkspace，用户那两条工作区未动）；`client/**`、`docs/**`、`package.json`、`daemon-*.ts`、`explorer.ts`、`sdk-runtime.ts`、`version.ts` **一律未改**；本轮不涉及 `client/**` ⇒ 不需要跑 `check-client-rev.mjs`。

## 未复核：6 条

1. **HTTP 路由端到端**（`POST /remote-wsl/api`：同源门 / 仅 POST+JSON / 白名单 400 / 动词 405-415 / F33 槽位 400）拆分后**没有再驱动一遍** —— 本轮用 `createExplorerHandlers` 直接调 handler 覆盖了四个动作，注册面调用点未变但没走真实 HTTP。建议 T26 在一个**孤立 `DSH_HOME`** 实例上补这一轮。
2. **disposer 的 in-host 分支**：unload 探针跑 disposer 时 `runtimes` 为空 ⇒ `rt.close()` 那条没被触发（只验了"守护不被杀"与 web host 空表）。in-host 运行时的 close/`reapWsl` 路径本轮未真跑。
3. **其余 5 个工具的真调**：`wsl_exec` / `wsl_agent` / `wsl_daemon` / `wsl_open_ui` / `wsl_sync_version` / `wsl_path` 只做了**注册面逐字对照**（②）；真调只覆盖 `wsl_status`（+ explorer 的四个动作）。⇒ 若某个工具体内有"只在调用期解析"的漏 import，本轮判据**抓不到**（`wsl_exec`/`wsl_agent`/`wsl_open_ui`/`wsl_daemon`/`wsl_sync_version`/`wsl_path` 各自都有独立调用路径）。
4. **`backend='in-host'` 形态**：拆分后**没有**重跑一轮（T1 验过 adapter；本轮只搬了 `inHostAdapter` + `createInHostPool`）。
5. **`warmInBackground`**：漂移时后台预热那条分支没有构造 drift 场景实测（拆分后它仍在 index.ts 的闭包里）。
6. **`sweepStaleRuntimes` / `ensureSwept`**：只随 `wsl_status`/`explorer.snapshot` 的调用间接触发过（懒清理），没有单独构造"孤儿运行时"场景验证。

## 证据文件（`spike/verify/explorer-20261012/arch-t5/`）

`REPORT-host-split.md`、`out-01-split.txt`（13 条边界断言 + 写出行数）、`out-02-surface-head.txt` / `out-03-surface-new.txt`（② 逐字对照）、`out-04-smoke.txt`（④）、`out-05-unload.txt`（④b）、`out-06-dumpconfig.txt`（③）、`out-07-gate-docs.txt`（原版护栏 FAIL）、`out-08-gate-matrix.txt`（T3 护栏 PASS）、`out-09-red-smoke.txt`（⑤ 红）、`out-10-gate-docs-patched.txt`（补丁副本 11/11 PASS）、`baseline-sha256.txt`/`final-sha256.txt`、`index.orig.ts`（拆分前的 HEAD 快照，供复核）；脚本 `split-t5b.ts`、`probe-t5.ts`、`run-patched-gate.ts`。
