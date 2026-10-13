# REPORT —— 架构债 T1：`SdkRuntime` / `ALLOW_BUILDS` / `unc` 去重（task-34）

## 结论（做了什么 / 怎么做的 / 验证 / 遗留）

**做了什么**：把 `src/` 里**双份的 `class SdkRuntime`** 收敛成**唯一实现**（`src/sdk-runtime.ts`），`index.ts` 的内嵌 in-host 副本改为 `import` + 一个描述差异的 `adapter`；`ALLOW_BUILDS` / `allowBuildFlags` 定义唯一化到 `sdk-runtime.ts`（`version.ts` 改为 import）；`unc` 只留 `daemon-client.ts` 那一份（`index.ts` 改为 import）；`textOf` 改用共享的 `textOfAssistantEvent`。**没有拆 facade**（按任务要求），没有碰 `client/**`、`docs/**`、`package.json`、`daemon-client.ts`。

**怎么做的**：两个副本的差异**不是**靠复制粘贴维持的 —— 我把差异逐条变成**数据**（adapter 的 14 个字段），类里没有一个散落的 `if (mode === …)`。守护形态的默认值**逐字等于抽取前**；宿主形态（`backend='in-host'` 逃生舱）通过 `inHostAdapter(cfg)` 覆盖。

**验证**：门禁 ①②（定义各一处）、③（`--dump-config` exit 0 / `Error:` 0 / 与基线 diff 0 行）、④（**HEAD vs 工作树**的字段集合逐字相同 + **两个形态各真跑一轮模型调用都拿到正文**）、⑤（故意红）全部通过。
**遗留**：见文末「未复核：6 条」；其中最重要的是「宿主形态的**失败分支**只做了读码对照，没有逐条构造」。

---

## 改动面（只 3 个文件，`git status` 实证）

| 文件 | 行数 | SHA256（改后） |
|---|---|---|
| `src/sdk-runtime.ts` | 311 → **438** | `22D854B47659312A7B94AC6FB4D770D95F1CBABDD3126A6D98DA5FA748B2A7AD` |
| `src/index.ts` | 1657 → **1491**（−241 行重复块，+75 行 adapter/注释） | `57F0A7ABB62E14CA1264E6F3AF3BB57994621095128152FA0F528671D4C2BA9E` |
| `src/version.ts` | 275 → **266** | `F2DACB90943CFAE006E0161EC5737DD4BCFF0C584DC291BA59EF5A074ADBB7E3` |

`git diff --stat -- src/` ⇒ `3 files changed, 236 insertions(+), 294 deletions(-)`（净 −58 行）。
其余 5 个 src **逐字不变**（首尾双断言，见 `baseline-sha256.txt` / `final-sha256.txt`）。

## 唯一实现是怎么成立的（差异 → adapter 字段）

| 差异点 | 守护形态（默认，= 抽取前） | 宿主形态（in-host 逃生舱） |
|---|---|---|
| 启动脚本 | 类内 `cd …; exec mise exec -- pnpm dlx …` | `scriptFor`：`shellPreamble`(登录 shell env+代理) + `cd` + `echo $$ > ${0%.sh}.pid` |
| 起进程 | `spawn('/bin/bash', ['-c', script], { detached: true, env })` | `spawnRuntime`：`writeScript` 落 `/tmp` + `spawn('wsl.exe', …)` |
| 关停 | `kill(-pid)` 杀**进程组**（连带 pnpm/node） | `killMode:'wrapper'` + `closeHook`（`reapWsl` + 删脚本） |
| `close()` 返回 | `{exitCode}` / `{alreadyClosed}` | `undefined` |
| 空正文 | `fallbackMode:'retryable'`（语义 #6：**绝不**换 sessionId） | `fallbackMode:'close-read-log'` + `fallbackText`（读持久化日志）+ `idleTimeoutMs` 自回收 |
| `prompt()` 形状 | `resultProfile:'daemon'`（`retryable/turns/runtimePid/stderrTail`） | `resultProfile:'host'`（`turn/runtimeRestarted`） |
| `initialize` 超时 | 120000 | `cfg.timeoutMs` |
| `stdin.write` | 包 try/catch → rejected promise | 原来不包（`guardStdinWrite:false`） |
| spawn 错误 | 打日志（`logSpawnError:true`） | 只置 `closed` |
| `sawAssistant` | 要求正文非空 | 只看事件类型（`sawAssistantRequiresText:false`） |
| 静止窗口标签 | `quiet` / `quiet-after-grace` | 不写（`quietLabels:{quiet:null,grace:null}`） |
| `prompt()` 入口检查 | 连"进程已死"一起拒 | 只看 `closed`（`requireAliveOnPrompt:false`） |
| `stderrTail` 上限 | 4000 | 8000 |
| 文案 | `runtime closed` / `… timeout after Nms` | `remote-wsl: 运行时已关闭…` / `remote-wsl: <m> 超时`（`text.*`） |

## 验收（逐条原始输出）

**① `class SdkRuntime` 唯一**
```
rg -n "class SdkRuntime" src/   ⇒ 1 处
  sdk-runtime.ts:119: export class SdkRuntime {
```
（过程中我发现注释里对类名的**逐字提及**也会被 `rg` 计到 ⇒ 把 4 处注释改成不含该字样的表述，门禁从 5 处降到 1 处。）

**② `ALLOW_BUILDS` / `unc` 定义各一处（引用点注明）**
```
const ALLOW_BUILDS   ⇒ 1 处: sdk-runtime.ts:41
  引用: version.ts:35  import { ALLOW_BUILDS } from './sdk-runtime.ts';   ← 原为本地第二份数组
  引用: sdk-runtime.ts:46 allowBuildFlags()
  引用: index.ts:76    import { … allowBuildFlags … } from './sdk-runtime.ts'
function unc         ⇒ 1 处: daemon-client.ts:28（export）
  引用: index.ts:68    unc,   ← 原为本地第二份实现
  引用: explorer.ts:57 从 daemon-client.ts 导入
```

**③ `--dump-config`**：`exit=0 / Error命中=0 / 与 T12 基线逐行 diff=0 行`。

**④ 对外形状逐字不变** —— 用 **HEAD（= 去重前 revision，`git archive HEAD`）vs 工作树**同探针对打（`probe-parity-t1.ts`，只比**字段名集合**，值里有会话数/时间戳这类每次都变的东西）：
```
HEAD snapshot.top        = daemon,distros,drift,target,webHosts,workspaces
NEW  snapshot.top        = daemon,distros,drift,target,webHosts,workspaces
HEAD snapshot.target     = cwd,distro,wslHome           NEW 同
HEAD snapshot.daemon     = keys,orphans,others,running  NEW 同
HEAD daemon.stop.result  = action,alreadyStopped,idempotent,notes,ok,pid,port,reaped,slot,version        NEW 同
HEAD daemon.ensure.result= action,idempotent,mode,notes,ok,pid,port,reused,slot,started,version,warning  NEW 同
HEAD daemon.ensure.mode  = systemd warning=null          NEW systemd warning=null
HEAD wsl_status.labels/lineCount = 18                     NEW 同（标签集合逐字相同）
字段集合逐字相同（含 daemon.ensure / wsl_status）= True
```
**并且两个形态各真跑了一轮模型调用**（`probe-runtime-smoke-t1.ts`，真 deps、真 WSL）：
```
HEAD daemon: ok=true ms=4110  head=可以 … completedBy=turn/end turns=1 runtimePid=1850559 daemon=1850340@127.0.0.1:8912
NEW  daemon: ok=true ms=4261  head=可以 … completedBy=turn/end turns=1 runtimePid=1851502 daemon=1851108@127.0.0.1:8912
NEW  in-host: ok=true ms=75027 head=可以 … backend=in-host completedBy=turn/end turns=1 dsh@0.2.0-rc.2
```
> ⚠️ 冷启动插曲（如实记）：**第一次**跑 daemon 形态时 `initialize timeout after 120000ms`（本轮首次物化 `pnpm dlx` + dsh 首启）。我没有当成回归，而是做了 **cache 已热后的 HEAD vs NEW A/B**：两者都 `ok=true`、4.1s vs 4.3s、正文与形状一致 ⇒ **环境冷启动，不是去重引入的回归**。

**⑤ 故意红**：把类复制回宿主文件（`Add-Content 'class SdkRuntime { }'`）⇒
```
RED  rg 'class SdkRuntime' ⇒ 2 处（index.ts:1494 / sdk-runtime.ts:119）   ← 门禁①变红 ✅
还原 byte-exact: True  ⇒  rg 1 处（复绿）
```

---

## 【一旦错了就得返工】

1. **adapter 的 14 条差异必须条条对得上**：宿主逃生舱的行为等价性全押在这张表上。我逐条从旧内嵌副本搬过来并读码对照，但**只真跑了主链路**（成功路径），**失败分支没逐条构造**（见未复核 1）。
2. **`initTimeoutMs=120000` 的冷启动超时是环境**：如果这个判断错了，就是对**默认路径**（daemon）的误判。证据 = 热 cache 下 HEAD/NEW A/B 双绿（§④）。
3. **`version.ts → sdk-runtime.ts` 这条新依赖边**：`version.ts` 现在 import `sdk-runtime.ts`。我确认了 sdk-runtime 顶层无副作用、且不反向 import version（无环）；将来若有人给 sdk-runtime 加 `import … from './version.ts'`，就成环 —— 这是结构性的，错了要返工。
4. **`--dump-config` 的加载链**：配置面要经 `index.ts → version.ts → sdk-runtime.ts` 三层都能加载（零构建 TS、无裸包导入）。已实测 exit 0 / 0 Error / diff 0。

## 【其余的】

- 机械项：`rg` 门禁（类名定义唯一 + 注释里的逐字提及也要清）、`unc`/`ALLOW_BUILDS` 改为 import、删 `textOf` 改 `textOfAssistantEvent`、严格相对导入带 `.ts`、无 `@deepseek-ai/*` 裸导入、没碰 `client/**`/`docs/**`/`package.json`/`daemon-client.ts`。
- `index.ts` 里那 241 行是**按段落标记切片**删的（`splice-t1.ts` 带结构断言：标记各命中一次、区间含 `class SdkRuntime {` 与 `function textOf`、末尾是空行），删完复核行数 1657 → 1423，再补 adapter 到 1491。
- 收尾：`is-system-running = running`、failed 0、`dsh-rwsl-*` 单元 0（已 `stop` + `reset-failed`，含新规矩）、守护 0、in-host/node dsh 0、`launch.*` 残留 0、`/tmp` 脚本残留 0、**无 WindowsTerminal**；`%TEMP%\t1-head` 临时副本已删；其它 teammate 的 `spike/.../usability/` 未跟踪文件**我没动**。

## 未复核：6 条

1. **宿主形态的失败分支**（5 个 adapter 开关的实际行为）：`guardStdinWrite:false`（stdin 写失败时同步抛 vs rejected promise）、`logSpawnError:false`（spawn 失败静默置 closed）、`requireAliveOnPrompt:false`、`quietLabels:{null,null}`（宽限路径不写 `completedBy`）、`stderrTailLimit:8000` —— 全是**读码对照**，没有构造对应条件实测。
2. **宿主形态的 `idleTimeoutMs` 自回收**（`armIdle` → `close()` → `closeHook`/`reapWsl`）没有等满空闲实测（`cfg.idleTimeoutMs` 默认 120000，等满成本高）；只验证了 `close()` 在正常收尾时经 `closeHook` 收干净（in-host 那轮跑完没有残留 node dsh 进程）。
3. **宿主形态 `fallbackText` 分支**（事件流没正文 ⇒ `close()` + 读持久化日志 + `completedBy='log-fallback'`）没有构造"事件流缺正文"的场景实测。
4. **守护形态 `stderrTail` 截断值**（4000）与 `stderrTail` 字段内容没有逐字对照（两次 smoke 都没进空正文分支）。
5. **`daemon.ts` 侧对 `SdkRuntime` 的其它调用面**（除 `openSession`/`wsl_agent` 之外的分支，例如 `key` 复用、`queueFull`）没有全量重跑 —— 只跑了 `wsl_agent` 两条形态各一轮。
6. **`in-host` 在 `explorer.openSession`（面板路径）下的行为**没有单独跑：面板路径走的是 `explorer.ts` 的 daemon 分支，`backend='in-host'` 只影响 `wsl_agent` 与 `explorer.openSession` 的逃生舱分支（后者的调用点在 `index.ts:1286` 附近，我只读了码未实跑）。

## 证据文件（`spike/verify/explorer-20261012/arch-t1/`）

`REPORT-runtime-unify.md`、`out-01-parity-head.txt`、`out-02-parity-new.txt`（④ 字段集合对照）、`out-03-dumpconfig.txt`（③）、`out-04-smoke-daemon.txt`（冷启动那次，含 120s 超时原始输出）、`out-05-smoke-inhost.txt`（②形态端到端）、`out-06-smoke-daemon-head.txt`、`out-07-smoke-daemon-new.txt`（热 A/B）、`baseline-sha256.txt`/`final-sha256.txt`（首尾双断言）；脚本 `probe-parity-t1.ts`、`probe-runtime-smoke-t1.ts`、`splice-t1.ts`。
