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
3. `wslHome` ← `wsl.exe -d <distro> --exec sh -c 'printf %s "$HOME"'`（`sh` 不行再试 `bash`）。
4. `cwd` ← 跟随解析出的 `wslHome`。
5. 任一步拿不到 ⇒ **留空并给可操作报错**，不回落到任何写死的值（"静默猜"正是被修掉的缺陷形态）。

新增/改动模块：

| 文件 | 作用 |
|---|---|
| `src/target-detect.ts`（新） | 探测实现：`detectDefaultDistro` / `detectDistroHome` / `pickHome` 纯函数 + `resolveAutoTarget`；生产 probe 是 `spawnWslProbe`（同步 `spawnSync`），测试可注入假 probe |
| `src/distro-table.ts`（新） | `wsl -l -v` 表解析从 `explorer.ts` 抽出：面板与探测**共用一份**（`explorer.parseWslDistroTable` 原名 re-export，导出面不变） |
| `src/config.ts` | `DEFAULTS.distro/wslHome/cwd` 改空；`normalizeConfig()` 内解析目标；新增 `lastTargetDetection()` / `targetProblem()` / `targetProblemFrom()` / `assertConfigTarget()` |
| `src/wsl-io.ts` | `writeScript()` 空发行版 ⇒ 明确根因；`runWsl()` 目标不可用 ⇒ `exit 127` + 可读原因（本函数契约"永不抛"）；`wslPathConvert()` 同 |
| `src/daemon-lifecycle.ts` | `ensureDaemon()` 入口 `assertConfigTarget()`；`daemonSnapshot()` 在目标未确定时返回"未扫描"的显式状态（沿用 F-50：扫描失败 ≠ 没有进程） |
| `src/explorer.ts` | `resolveDistro()` 默认分支失败时给机器可读 `reason`（`no-distro` / `no-wsl-home`）；显式 `distro` 请求不受限 |
| `src/fs-provider.ts` | `createWslRpc().ensure()` 首次调用即拒绝（不在 `apply` 抛：那会把整个 WSL preset 变 broken） |
| `src/register-tools.ts` | `wsl_status`：目标未确定时跳过所有 WSL 探测并显示 `target ⚠️`；成功时显示 `target auto-detected: …` |
| `src/index.ts` | 启动时把探测结论/失败原因写 stderr（桌面 GUI 里这是唯一能落进日志的地方） |
| `src/selftest.ts` | 脚手架默认值同样走自动探测（`--distro/--wsl-home/--cwd` 仍可覆盖） |

## 3. 代价（如实记录）

- **同步探测**：`normalizeConfig()` 是同步 API，且不能把空串漏给几十处 `unc(cfg.distro, …)` /
  `wsl.exe -d cfg.distro`（那会变成不可诊断的 errno）。所以探测用 `spawnSync`。
  实测本机：`wsl -l -v` ≈ 150ms、`$HOME` ≈ 6ms（发行版已在跑）⇒ **一次启动 ~156ms**；
  第二次 `normalizeConfig()` 命中缓存 **0ms**。
  **上限是被明确定义的**：`wsl -l -v` 8s + `$HOME` 10s = **18s 封顶**（WSL 卡死时最坏情况）。
  换 shell 重试只在"该 shell 不可用（exit ≠ 0）"时发生；`spawnSync` 报 error（超时/起不来）或
  shell 正常退出但输出不合法时**立即停**——否则最坏情况会翻倍到 36s+，而结论不会变。
- **可能拉起未运行的发行版**：第 3 步的 `wsl -d` 在发行版停止时会把它启动（WSL 自身行为）。
  这在插件语境下可接受（后续每个操作都要它跑起来），且**显式配置 `distro` + `wslHome` 可完全避免**。
- **缓存语义**：成功结论按进程缓存（改 `wsl --set-default` 后需重启 DSH）；失败只缓存 5s
  （`NEGATIVE_CACHE_MS`）—— 用户装好发行版后不必重启就能重新探到。
- **不做的事**：不校验显式 `distro` 是否存在（现状不变；`wsl_status` 的 `targetMissing` 仍负责标红）；
  不自动改 `wsl --set-default`；不猜"唯一那个发行版"。

## 4. 验证

```powershell
# 语法门禁（29 个 TS + 13 个 JS）
node --experimental-strip-types scripts/check-syntax.ts      # => syntax OK（exit 0）

# 回归：110 个用例，98 pass / 0 fail / 12 skipped（skipped 为既有的 bash 依赖用例）
node --experimental-strip-types --test test/*.test.ts        # => fail 0（exit 0）
```

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

新增回归用例（`test/target-detect.test.ts`，全部用假 probe，CI 无 wsl.exe 也能跑）：
UTF-16LE 表格解析、无 `*` 行不猜、`wsl.exe` ENOENT、WSL1 拒绝、`$HOME` 非法（相对/含空白）不猜、
`sh`→`bash` 回退、起不来/输出不合法时**不**重试第二个 shell、显式配置零探测、
只缺 `wslHome` 时只问 `$HOME`、`cwd` 跟随、
`targetProblemFrom` 的"结论必须与配置对得上才用精确文案"。

**未验证**：另一台**没有**作者那套 WSL 发行版的机器上的真实启动（本机只有 `debian-u8-1`）；
已用假 probe 覆盖"没有默认发行版/没有 wsl.exe/WSL1"三条分支，但真宿主启动只在本机验过。

## 5. 兼容性

- `protocolVersion` **不变**（守护侧未改）；旧守护可复用。
- 显式配置 `distro` / `wslHome` 的行为与 0.3.2 **完全一致**（走同一条 `normalizeConfig` 合并，只是不再需要）。
- 面板/工具的输出面：`wsl_status` 新增 `target ⚠️` / `target auto-detected` 两行；错误多出
  `reason: 'no-distro' | 'no-wsl-home'`（面板按 `reason` 分支的机制早已存在）。
