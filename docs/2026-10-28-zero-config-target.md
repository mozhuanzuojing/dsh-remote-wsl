# 2026-10-28 · 目标零配置：去掉写死的 `distro` / `wslHome`

> 版本：0.3.2 → **0.3.3**（协议版本不变：这次只改宿主侧配置解析，守护/WSL 侧一行未动）
> 触发：`HANDOFF.md`「Broken / Unresolved」第 3 条 —— `src/config.ts` 硬编码作者机器的
> `distro: 'debian-u8-1'` / `wslHome: '/home/g'`，换机器直接报「未知发行版」。

## 1. 缺陷形态（为什么必须修而不是只写进 README）

| 事实 | 证据 |
|---|---|
| 默认值就是作者机器上的值 | 修前 `src/config.ts:17-18`：`distro: 'debian-u8-1'`、`wslHome: '/home/g'` |
| 换机器后第一件事就失败 | 发行版名不存在 ⇒ `explorer.resolveDistro` 的 `unknown-distro`；所有 `wsl -d <name>`/UNC 路径同样失败 |
| 原有"规避办法"是文档 | README「配置」要求用户手改 `cordis.patch.yml`；`cordis.patch.yml` 里也把作者值写进默认配置 |

**根因**：默认值把"某台机器的环境"编码成了程序常量。这不是文档问题 —— 插件在任何别的机器上
**开箱即坏**，而错误信息（`unknown-distro`）不会告诉用户"是因为默认值属于作者"。

## 2. 改法（探测顺序 = HANDOFF 建议的那条）

1. **显式配置永远优先**：`distro` 非空就不起 `wsl -l -v`；`wslHome` 非空就不起 `$HOME` 探测。
2. `distro` ← `wsl.exe -l -v` 里 NAME 列带 `*` 的**默认发行版**（**只认 `*`**）。
3. `wslHome` ← `wsl.exe -d <distro> --exec sh -c 'printf %s "$HOME"'`（`sh` 不可用再试 `bash`）。
4. `cwd` ← 跟随解析出的 `wslHome`。
5. 任一步拿不到 ⇒ **留空并给可操作报错**，不回落到任何写死的值（"静默猜"正是被修掉的缺陷形态）。

新增/改动模块：

| 文件 | 作用 |
|---|---|
| `src/target-detect.ts`（新） | 探测实现：`detectDefaultDistro` / `detectDistroHome` / `pickHome` 纯函数 + `resolveAutoTarget`；生产 probe 是 `spawnWslProbe`（同步 `spawnSync`），测试可注入假 probe |
| `src/distro-table.ts`（新） | `wsl -l -v` 表解析从 `explorer.ts` 抽出：面板与探测**共用一份**（`explorer.parseWslDistroTable` 原名 re-export，导出面不变） |
| `src/config.ts` | `DEFAULTS.distro/wslHome/cwd` 改空；`normalizeConfig()` 内解析目标；探测结论挂在**配置对象自己的 Symbol 键**上（`configDetection(config)`，不是模块级状态 —— 同进程多份配置才不会张冠李戴）；新增 `targetProblem()` / `targetProblemFrom()` / `assertConfigTarget()` |
| `src/wsl-io.ts` | `writeScript()` 空发行版 ⇒ 明确根因；`runWsl()` 目标不可用 ⇒ `exit 127` + 可读原因（本函数契约"永不抛"）；`wslPathConvert()` 同 |
| `src/daemon-lifecycle.ts` | `ensureDaemon()` 入口 `assertConfigTarget()`；`stopDaemon()` 回 `ok:false`（**不许**伪成功 `alreadyStopped`）；`daemonSnapshot()` 返回"未扫描"的显式状态、`daemonStatus()` 回 `kind:'no-target'`（沿用 F-50：扫描失败 ≠ 没有进程） |
| `src/explorer.ts` | `resolveDistro()` 默认分支失败时给机器可读 `reason`（`no-distro` / `no-wsl-home`）；显式 `distro` 请求不受限；`readWorkspaces()` 不再生成空 path 的伪条目 |
| `src/fs-provider.ts` | `createWslRpc().ensure()` 与路径解析（`translate`）在首次调用即拒绝（不在 `apply` 抛：那会把整个 WSL preset 变 broken） |
| `src/register-tools.ts` | `wsl_status`：目标未确定时跳过所有 WSL 探测、显示 `target ⚠️`，且**不打印伪造的** state dir 路径；成功时显示 `target auto-detected: …`。`wsl_daemon`（status/stop）与 `wsl_sync_version` 直接回根因（不再给 "not running" 或内部不变量） |
| `src/index.ts` | 启动时把探测结论/失败原因写 stderr（桌面 GUI 里这是唯一能落进日志的地方） |
| `src/selftest.ts` | 脚手架走同一条 `normalizeConfig()`：`--distro/--wsl-home/--cwd` 优先，只有缺的项才探测 |

## 3. 代价（如实记录）

- **同步探测**：`normalizeConfig()` 是同步 API，且不能把空串漏给几十处 `unc(cfg.distro, …)` /
  `wsl.exe -d cfg.distro`（那会变成不可诊断的 errno）。所以探测用 `spawnSync`。
  实测本机：`wsl -l -v` ≈ 150ms、`$HOME` ≈ 6ms（发行版已在跑）⇒ **一次启动 ~156ms**；
  同一进程第二次 `normalizeConfig()` 命中缓存 **0ms**。
  **上限是被明确定义的**：`wsl -l -v` 8s + `$HOME` 10s = **18s 封顶**（单次探测的最坏情况）。
  换 shell 重试只在"该 shell 不可用（exit ≠ 0）"时发生；`spawnSync` 报 error（超时/起不来）或
  shell 正常退出但输出不合法时**立即停**——否则最坏情况会翻倍到 36s+，而结论不会变。
- **可能拉起未运行的发行版**：第 3 步的 `wsl -d` 在发行版停止时会把它启动（WSL 自身行为）。
  这在插件语境下可接受（后续每个操作都要它跑起来），且**显式配置 `distro` + `wslHome` 可完全避免**。
- **缓存语义**：探测结论（**成功与失败都是**）按进程缓存，所以 `8s + 10s` 是**单次**上限而不是每次调用。
  为什么失败也缓存：`normalizeConfig()` 会把结论**冻结进配置对象**（`distro`/`wslHome` 一旦解析就跟着
  cfg 走完全程），短负缓存会让"下一轮 apply 探到了、而先建好的工具仍报没有目标"（fs provider 能用、
  `wsl_exec` 不能用）—— 那是**分裂脑**。代价：修好 WSL / 改 `wsl --set-default` 后需要**重启 DSH**
  （与 `noDistroTimeoutMessage` 的文案一致）。测试用 `resetTargetDetection()` 清缓存。
- **不做的事**：不校验显式 `distro` 是否存在（现状不变；`wsl_status` 的 `targetMissing` 仍负责标红）；
  不自动改 `wsl --set-default`；不猜"唯一那个发行版"；`$HOME` 含空白字符也按失败处理（拼进 bash 脚本会失真）。

## 4. 验证

```powershell
# 语法门禁（29 个 TS + 13 个 JS）
node --experimental-strip-types scripts/check-syntax.ts      # => syntax OK（exit 0）

# 回归：全仓 node --test 全绿（fail 0；12 条 skipped 是既有的 bash 依赖用例）
node --experimental-strip-types --test test/*.test.ts        # => fail 0（exit 0）

# 本次改动的 39 条新增用例（不依赖本机装没装 WSL，CI 也能跑）
node --experimental-strip-types --test test/target-detect.test.ts test/target-guards.test.ts  # => 39 pass
```

> 注：仓库里有其它会话在并行改动，所以这里**不写全仓用例总数**（会当场过期）；上面给出的是
> 本次改动**自己贡献**的 39 条用例，以及门禁命令本身的全绿结论。

本机真实探测（不是 mock）：

```
explicit : {"distro":"explicit-distro","wslHome":"/home/explicit","cwd":"/home/explicit"}
detection after explicit-only: null            ← 显式配置没触发任何探测
auto     : {"distro":"debian-u8-1","wslHome":"/home/g","cwd":"/home/g"} (156ms)
problem  : null
detection: {"notes":["默认发行版 \"debian-u8-1\"（wsl -l -v 的 * 行）",
                     "$HOME = /home/g（wsl -d debian-u8-1 --exec sh）"],"problem":null}
cached 2nd call: 0 ms
```

真插件入口（`apply({})` 空配置）→ `wsl_status` 的实测输出（本机真 wsl.exe / 真守护）：

```
remote-wsl: 目标自动探测 distro=debian-u8-1 wslHome=/home/g（默认发行版 "debian-u8-1"（wsl -l -v 的 * 行）；$HOME = /home/g（wsl -d debian-u8-1 --exec sh））
target auto-detected: 默认发行版 "debian-u8-1"（wsl -l -v 的 * 行）；$HOME = /home/g（wsl -d debian-u8-1 --exec sh）（显式配置 distro/wslHome 可完全跳过探测）
target: debian-u8-1  wslHome=/home/g  cwd=/home/g
daemon: running pid=2363384 actualPort=8731 slot=8731 version=0.2.1-rc.3 plugin=0.3.2 protocol=v2 …
wsl ip: 172.30.190.198
```

新增回归用例：

- `test/target-detect.test.ts`（假 probe，CI 无 wsl.exe 也能跑）：UTF-16LE 表格解析、无 `*` 行不猜、
  `wsl.exe` ENOENT、`wsl -l -v` 超时文案、WSL1 拒绝、`$HOME` 非法（相对/含空白）不猜、`sh`→`bash` 回退、
  起不来/输出不合法时**不**重试第二个 shell、显式配置零探测、只缺 `wslHome` 时只问 `$HOME`、`cwd` 跟随、
  `targetProblemFrom` 的"结论必须与配置对得上才用精确文案"。
- `test/target-guards.test.ts`（直接调真实入口；空目标 ⇒ 守卫在 spawn 之前返回，离线 0–2ms）：
  `writeScript` / `runWsl`(127) / `wslPathConvert` / `stopDaemon`（不许 `alreadyStopped`）/
  `daemonSnapshot` / `daemonStatus`(`no-target`) / `ensureDaemon` / fs provider `ensure` /
  面板 `explorer.snapshot`(`reason:no-distro`) / `wsl_status`（不伪造 state dir、不含 `auto-detected`）/
  `wsl_daemon` status+stop（不报 `not running`、不提 `stop all`）/ `wsl_sync_version`（不泄漏 `cfg.wslHome`）/
  `wsl_exec`。其中"没有 wsl.exe"的场景通过临时清空 `PATH` 做**确定性**模拟。

**未验证**：另一台**没有**作者那套 WSL 发行版的机器上的真实启动（本机只有 `debian-u8-1`）；
"没有默认发行版 / 没有 wsl.exe / WSL1 / 超时"四条分支由假 probe 与清空 `PATH` 的确定性模拟覆盖，
但**真宿主启动**只在本机验过。

## 5. 兼容性

- `protocolVersion` **不变**（守护侧未改）；旧守护可复用。
- 显式配置 `distro` + `wslHome` 的行为与 0.3.2 一致（同一条 `normalizeConfig` 合并，只是不再必需）。
- **一处行为变化（`cwd`）**：显式配了 `wslHome`、没配 `cwd` 的用户，有效 cwd 从旧的固定 `/home/g` 改为
  跟随自己的 `wslHome`（这是修正）。副作用：旧守护报告的 `cwd` 会与新的不一致 ⇒ `configCompat` 判
  **结构性不兼容**，需要显式 `wsl_daemon action=restart` 一次（该动作会丢当前会话上下文）。
- 面板/工具的输出面：`wsl_status` 新增 `target ⚠️` / `target auto-detected` 两行，`wsl_daemon` 在目标
  未确定时直接返回根因；错误多出 `reason: 'no-distro' | 'no-wsl-home'`（面板按 `reason` 分支的机制早已存在）。
