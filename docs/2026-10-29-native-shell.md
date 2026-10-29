# 2026-10-29 · WSL 原生 bash（P0 / P2 第一轮）

> 仓库：`D:\project\dsh1\dsh-remote-wsl`（本轮基于 `4ef213d` / v0.3.7，交付 **0.3.8**）
> 轮次定位：HANDOFF 第九版「三项可做」里 **Spike A + P0（`ctx.shell` 的 WSL executor）**；
> P2（面板默认 WSL preset）由并行 teammate 实现，见本文件 §7。
> 上游版本：DSH Desktop **0.2.1-rc.3**（app.asar 内 `@deepseek-ai/*`）。
> 本文所有"上游行为"均以抽取源码为准，路径相对 `...\app.asar\dsh\node_modules\@deepseek-ai\<pkg>\lib\index.js`。

## 1. 结论先行

| 项 | 状态 | 证据 |
|---|---|---|
| `ctx.shell` 在 preset 的 isolate realm 里可被**纯 JS 对象**替换 | ✅ 已实现并挂载 | §3；探针宿主启动日志「WSL preset 已注册（plugins=19）」，`broken` 为空 ⇒ 无失败行、无等待行 |
| WSL preset 里的 `bash` 工具执行**发生在 WSL 内** | ✅ 执行器层已验证（单元 18 条 + 真机 7 条） | §5；`test/shell-provider*.test.ts` |
| 真模型 → `bash` 工具 → WSL 的**整链路** | 🟡 **未验证** | §6 说明为什么两条现成路径都不通，以及用户侧 2 分钟验法 |
| P2 host 路径（`create({agentPreset:'wsl'})` 真的被宿主应用） | ✅ 已验证 | 隔离 web 探针 `POST /remote-wsl/api explorer.newSession {path:'/home/g'}` → `{presetApplied:true, agentPreset:'wsl', sessionId:'session-f2351880…'}`（2026-10-29 11:40） |
| 终端（PTY）仍在宿主 | ⛔ 未动 | 属 P1（HANDOFF 第九版路线 A/B） |
| daemon 新增 `{op:'exec'}` RPC | ⛔ 未做（按 §4 的取舍，本轮走直连 `wsl.exe`） | §4 |

## 2. 改了什么

| 文件 | 变更 |
|---|---|
| `src/shell-provider.ts` | **新增**。WSL shell 执行器：`resolve()` / `execute()` / `sandboxMode=undefined`，handle 契约见 §3.2。零 `@deepseek-ai/*` 依赖。 |
| `src/preset.ts` | `wsl-world` 组从 `isolate: { fs }` 扩成 `isolate: { fs, shell }`；组内新增 `shell-wsl` 行与 `tool-bash` 行；删掉宿主平面上的 `tool-bash`（win32 原本 `disabled`）与 `tool-pwsh`。 |
| `src/config.ts` | 新增 4 个配置项：`shellTimeoutMs`(120s)、`shellMaxTimeoutMs`(600s)、`shellMaxOutputBytes`(64KiB)、`shellGraceMs`(3s)，与 `dsh-bash-local` 默认值同值。 |
| `package.json` | `exports` 加 `./shell-provider`（preset 行名必须走包内子路径，实测绝对路径会 never started）。 |
| `test/shell-provider.test.ts` | 20 条：路径翻译、resolve 夹紧、脚本构造、增量读、UTF-8 边界、kill/超时/abort、spawn error、截断、stdin、distro 未解析、/tmp 写不进。 |
| `test/shell-provider-wsl.test.ts` | 9 条真机：`uname -s`=Linux、退出码/stderr/workdir、env+stdin、超时、进程组回收、输出上限。非 win32 或无 `wsl.exe` ⇒ 整组 skip（不是假通过）。 |

## 3. 契约（事实，带行号）

### 3.1 为什么只能放在 preset 的 isolate 组里

- `dsh-permission-presets` 的构造函数里有硬 guard：`if (ctx.shell.sandboxMode === void 0) throw new Error(...)`（`dsh-permission-presets/lib/index.js:177`；行号为抽取物内行号）。
- 该行在默认组合里**无条件挂载**：`dsh-base/cordis.patch.yml` 的 `permission` insert + `dsh-web-app/cordis.patch.yml` 只 disable 工具行；`permission` 不在 required 启动列表（`dsh-app-boot/lib/index.js:4270-4279`）⇒ 若在**宿主平面**替换 shell，宿主**仍能启动**，但权限预设 / `/permission` 命令 / 权限选择器全失效 + 一条启动告警。
- 结论（施工约束）：`sandboxMode===undefined` 的执行器只能放进 `isolate: { shell: true }` 的 realm，**不得**替换宿主平面。本实现照此落在 `wsl-world` 组里。

### 3.2 `ShellProcess` handle 的最低要求（消费方真实读取）

| 字段/方法 | 谁在什么路径读 | 我们的实现 |
|---|---|---|
| `done` | `dsh-tool-bash:115`（后台 job 等它） | Promise，**永不 reject**；spawn 失败也在 settle 后 resolve |
| `status` | 作业/工具体渲染 | `running` → `completed` / `killed`（超时、abort、我们主动 kill、provider 失败） |
| `exitCode` / `signal` | `tool-bash` 结果映射 | 被强制结束时 `exitCode=null, signal='SIGTERM'`（避免把 bash 的 143 渲染成"命令失败"） |
| `observed.stdout.readFrom(byte)` | `dsh-jobs-local:711-734`（`guardSource` 会吞异常） | 只增 Buffer + 字节偏移；**保证返回完整 UTF-8 码点**（上游参考实现不保证，见 §6 风险） |
| `observed.stderr.readFrom` | 同上 | 同上 |
| `readOutput()` | 模型侧增量输出 | `{delta, lossy}`，stderr 以 `[stderr]` 合并 |
| `kill()` | 作业取消 / 工具中断 | 幂等；先 WSL 内 `kill -TERM -- -PGID`，`shellGraceMs` 后 `KILL` + 兜底 `wsl.exe SIGKILL` |
| `result()` | 前台路径 `await (await execute(spec)).result()` | 只 reject **基础设施错误**（spawn 失败）；返回 `{exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr}` |

## 4. 执行模型（取舍与原因）

**直连 `wsl.exe`，不经守护**：

```
node(宿主) --spawn--> wsl.exe -d <distro> --exec bash /tmp/dsh-rwsl-shell-<token>.sh
  脚本: cd <linuxCwd> || exit 2 ; export KEY=... ; set -m ; bash -c '<command>' &
        pid=$! ; echo $pid > /tmp/<token>.pgid ; wait $pid ; status=$?
        kill -TERM -- -"$pid"        # 收掉命令留在组里的后台孤儿
        exit $status
```

为什么不是 `setsid --wait`（第一版实现，**已被实测否掉**）：setsid 在被调用进程是进程组组长时会 fork；不加 `--wait` 时父进程立刻退出 ⇒ wsl.exe 提前关闭 stdout/stderr 管道，**命令照跑、输出全丢**（实测 `exitCode=0`、stdout 空）。加 `--wait` 虽能拿到输出，但子进程被信号杀死时 setsid 往 stderr 打 `setsid: child … did not exit normally: Success` 并把退出码改写成信号号（实测 15）。`set -m` 让 `cmd &` 直接拿到以自身 pid 为 PGID 的进程组（实测 `ps -o pgid=` = 子 pid），无额外输出、退出码保留 bash 惯例（143）。

为什么本轮不做 `daemon {op:'exec'}`：直连方案不依赖常驻守护（守护空闲会被回收），失败面小、行为可预测；代价是每条命令一次 `wsl.exe` 启动（本机实测 ~40–90ms）。等 P1（PTY）需要宿主代理 backend 时再统一评估守护通道，避免为 shell 单独扩一份协议（v3 → v4）而收益有限。

## 5. 验证（可复跑）

```powershell
cd D:\project\dsh1\dsh-remote-wsl
node --experimental-strip-types scripts/check-syntax.ts          # 32 TS + 13 JS，OK
node --experimental-strip-types --test test/shell-provider.test.ts          # 20/20
node --experimental-strip-types --test test/shell-provider-wsl.test.ts      # 9/9（真 WSL）
node --experimental-strip-types --test test/*.test.ts                       # 全量，见本轮报告数字
```

**挂载证据（真宿主）**：隔离 DSH_HOME（`%TEMP%\rwsl-native-home`）+ profile `rwslprobe`（bundle 列表 `dsh-base` / `dsh-web-app` / `dsh-remote-wsl`，junction 指回仓库），`dsh --profile rwslprobe --port 8917 --no-open`：

```
remote-wsl: 目标自动探测 distro=debian-u8-1 wslHome=/home/g
remote-wsl: apply 进入（codeTag=preset-log-v1，plugins=19）
remote-wsl: WSL preset 已注册（id=wsl，plugins=19）
dsh web: http://127.0.0.1:8917/?token=…
```

`plugins=19` = 顶层从 21 行减掉 tool-bash/tool-pwsh、把 `shell-wsl` + `tool-bash` 放进组内（组内行不计入顶层计数）。**这条比"注册成功"更强**：注册器 `register()` 会 `await` 整棵子树并 `auditRows()`（`dsh-agent-preset-registry/lib/index.js:154-179`、`:470-505`），`diagnostic()` 把 failed **和 pending（等待服务）** 一起回报（`:533-544`），而"已注册"分支是 `broken` 为空时打的 ⇒ **没有失败行、也没有等待行** ⇒ 组内 `tool-bash` 的 `inject`（`tools/shell/systemPrompt/shellEnv/workingDirectory`，`dsh-tool-bash:223-229`）全部解析成功，包括它注入的 `shell` 就是我们提供的执行器。

## 6. 未验证与已知风险（如实）

1. **真模型整链路未验证**。两条现成路径都不通：
   - `dsh headless`：headless profile 的组合里**没有** `agent-preset-registry`（`dsh --profile rwslheadless --dump-config` 报 `patch: entry "agent-preset-registry" not found`），`dsh-headless` 也不读 preset ⇒ 会话落标准工具集。实测（`_work/wsl-native/probe/headless-e2e.jsonl`）：模型明确回"我没有名为 bash 的工具"——**这是探针路径的事实，不是插件缺陷**。
   - 桌面宿主：当前进程是旧代码（preset 21 行、无 shell provider），要用户重启才会加载本轮代码。
   - 用户侧验法（2 分钟）：重启 DSH → 新建会话时选「WSL（远程执行世界）」→ 让模型跑 `uname -a`；正确结果是 Linux 内核串，且工具名是 `bash`。
2. **`readFrom` 偏移**：上游 `dsh-subprocess-local/lib/output.js:188-198` 的 `nextOffset` 恒等于累计字节数、不保证 UTF-8 边界（按字符长度算会静默出 U+FFFD）。我们的实现按字节并回退到码点边界，**语义更严**；若未来宿主把 `nextOffset` 当成"必须等于 total"来用会不兼容——目前消费方只用返回值本身。
3. **无 spill 文件**：超过 `shellMaxOutputBytes` 直接丢尾部并标 `truncated:true`，`readFrom` 不返回 `spillPath`（契约允许省略）。模型能知道被截断，但拿不到全文。
4. **每条命令一次 `wsl.exe`**：~40–90ms 固定开销；发行版没在跑时写入 /tmp 会先把发行版拉起（与既有 UNC 路径同一行为）。
5. **`kill -TERM -- -"$pid"` 的理论竞态**：命令刚退出、pid 立刻被新进程组复用时，收尾那一枪可能打到无关组。窗口极小（同一条脚本内、微秒级），本轮接受；严格做法是收尾前 `kill -0 -- -"$pid"` 再比对 `/proc/<pid>/stat` 的启动时间。
6. **`tool-pwsh` 从 preset 移除**：WSL 世界里它同样是 `ctx.shell` 的消费方，保留会变成"叫 PowerShell 却跑 bash"。宿主平面不受影响。
7. **`sessionController.create` 的 `agentPreset`**（P2 依赖）：契约行号见 `_work/wsl-native/shell-contract.md` 与 teammate 报告；本轮 P2 的降级路径另测。

## 7. P2（并行 teammate）

`explorer.newSession` 带 `agentPreset: 'wsl'`；旧宿主三种"不认"形态分别处理（静默丢字段 ⇒ `presetApplied:false`；`agent-preset/*` 拒绝 ⇒ 明确降级重试并回 `presetDegraded:true` + 宿主原文；其它错误不降级）。客户端把新会话切到主视图。验收记录见 teammate 报告与 `test/explorer-new-session.test.ts`。

## 8. 复现探针（不进交付路径）

| 文件 | 用途 |
|---|---|
| `_work/wsl-native/tools/asar-extract.mjs` | 从 `app.asar` 抽 `@deepseek-ai/*` 的 `lib/**.js` / `presets` / `package.json` / `*.patch.yml` 到普通目录（1423 文件 ≈63MB），让 grep 可用 |
| `_work/wsl-native/asar/` | 抽取结果（302 个包） |
| `_work/wsl-native/shell-contract.md` | `ctx.shell` 契约全表（teammate 交付，逐条行号） |
| `_work/wsl-native/probe/probe-shell.ts` | 直接驱动 shell-provider 打印完整 result（排障） |
| `_work/wsl-native/probe/probe-kill.ts` | kill 结算细节（exitCode/status/残留） |
| `_work/wsl-native/probe/headless-e2e.jsonl` | headless 探针的 `--json` 事件流（证伪 headless 路径） |

探针 profile（**可随时删**）：`%TEMP%\rwsl-native-home\profiles\rwslprobe`（隔离宿主）、`~\.dsh\profiles\rwslprobe` / `~\.dsh\profiles\rwslheadless`（真实 home 下的探针 profile，仅含 junction 与 patch）。

## 9. Review 记录（2026-10-29，提交 `8178b48`）

**P1（已修）**：`kill`/超时路径会留下 Linux 侧孤儿。根因：旧 kill 脚本让 WSL 侧自己 `cat` pgid 文件，
而 `settle()` 会立刻删文件 ⇒ 「超时（命令 trap 了 TERM）」「命令刚起就 kill」两种路径下 TERM/KILL 脚本
读到空 PGID，只剩 `child.kill(SIGKILL)` 杀掉 `wsl.exe`，Linux 侧 `sleep` 变孤儿（实测复现：`sleep 41` / `sleep 47`）。
修复：PGID 由宿主侧 `readFileSync` 读出并**随脚本传参**；kill 时读不到 ⇒ 120ms 后重读补发 TERM；
宽限到点用缓存值发 KILL；`settle` 对被强制结束的组再补一发 KILL。
**P3（已修）**：stderr 保留上限误用调用方 `stdoutMaxBytes`，改为与 `dsh-bash-local` 一致的 `maxOutputBytes`。
**保留（S3 / 已知限制）**：`set -m` 不可用时只会退化为"杀掉 wsl.exe、Linux 侧可能留孤儿"（不会误杀别的组）；
每命令一次 `wsl.exe`（~40–90ms）；无 spill 文件；正常结束会清掉命令自己 `&` 的后台子进程（与 jobs 的
`run_in_background` 是两条路，后者应该用 jobs）；`kill -TERM -- -PGID` 的 pid 复用窗口极小但存在。
**证据**：单测 20/20（新增「pgid 文件缺失时轮询重读」「stderr 不随 stdoutMaxBytes 放大」）；
真机 9/9（新增「trap TERM 的超时无孤儿」「立即 kill 无孤儿」）；全量 196 tests / 184 pass / 0 fail / 12 skip。