# REPORT-host-perf —— 宿主数据面性能（TTL 缓存 + snapshot 单飞）

- **任务**：task-3（T-C 宿主数据面性能）
- **仓库/分支**：`D:/project/dsh1/dsh-remote-wsl` / `uiux/perf-20261019`
- **写范围**：仅 `src/explorer.ts` + `spike/verify/uiux-20261019/host-perf/`（新目录）。**未**改 `client/**`、其它 `src/*`、README/docs/REVISION。
- **纪律**：未执行任何 `wsl --shutdown` / `wsl --terminate`；未起/停任何守护；未写仓库内文件（除本任务产物）；所有 `wsl.exe` 调用均为只读探测（发行版 `debian-u8-1` 当时为 Running，`wsl -d` 探针仅在 Running 时才执行）。
- **生成时间**：2026-10-19

## 0. 结论（先看这一段）

| 项 | before | after | 变化 |
|---|---:|---:|---:|
| `listDir`（同实例第二次，事实已缓存） | **104.3ms** | **1.2ms** | **↓ 86.9×**（-103.1ms） |
| `snapshot`（同实例第二次） | **306.2ms** | **226.7ms** | ↓ 1.4×（-79.5ms） |
| 面板首屏 burst（`snapshot`→`listDir`，热） | **398.3ms** | **238.4ms** | ↓ 1.7×（-159.9ms） |
| `snapshot` ×3 **并发** | **950.3ms** | **326.8ms** | ↓ 2.9×（-623.5ms） |
| `snapshot` ×3 顺序（对照，不该被合并） | 925.6ms | 744.4ms | 仅省掉 2 次重复事实读 |

**结构性证据（与机器负载无关，是本次改动的直接判据）**：

| 场景 | 每次调用里 `listDistros` 被调用次数（before → after） |
|---|---|
| `listDir` 冷（新实例） | 1 → 1（不变：仍真读） |
| `listDir` 热（TTL 内第二次） | **1 → 0** |
| 面板 burst（`snapshot`→`listDir`） | **2 → 1** |
| 面板 burst 再来一轮（TTL 内） | **2 → 0** |
| `snapshot` ×3 并发 | **3 → 1**（单飞） |

口径：同一脚本、同一台机器、**同一时间窗内**先 before 后 after；每项 N=5 取中位数；端到端含真实 `wsl.exe` spawn（`wsl -l -q` ≈ 60–80ms、`wsl -l -v` ≈ 50–60ms、`wsl -d <distro> -- bash -c true` ≈ 125–190ms，均为本轮实测）。

## 1. 做了什么（3 处改动，全部在 `src/explorer.ts`）

净 diff：`+87 / -10`（`git diff --stat -- src/explorer.ts`）。

### 1.1 发行版事实短 TTL 缓存（`DISTRO_FACTS_TTL_MS = 2000`，`src/explorer.ts:120`）

- 缓存对象：`{ names, flags }`。`names` 来自注入的 `deps.listDistros()`（`wsl -l -q`）；`flags` 来自 `probeDistroState()`（`wsl -l -v` 的 STATE/默认标志）。
- 读取器 `readDistroFacts()`（`src/explorer.ts:351-360`）：`snapshot` 与 `listDir` **共用**同一份 —— 面板一次刷新里两处对"有哪些发行版/哪个在跑"的判断必须同源。
- **为什么能缓存**：这两条是只读快照，每次 spawn 60–80ms / 50–60ms；面板刷新会**连着**调 `snapshot` + `listDir` ⇒ 不合并就是纯重复成本。
- **为什么 2s**：远长于一次刷新（百毫秒级），又短到"用户刚 `wsl --terminate` 再看面板"最多滞后 2s。**不是实时性承诺**。
- **失败不缓存**（`src/explorer.ts:357-358`）：只有"名字非空 **且** STATE 表读取成功（`ok===true`）"才写入；否则既不写入也不复用旧值，下一次调用立刻重试。
- **失效方式（写清，不留"魔法"）**：①**时间**：2s 到期后下一次调用重取；②**失败**：探测失败或名字为空 ⇒ 立即清空，下一次重取；③**没有主动失效钩子** —— 面板在 TTL 内点"刷新"仍可能命中旧值（这就是"最多滞后 2s"的来源）。
- `listDir` 的发行版前置判定改用同一份事实（`src/explorer.ts:686-689`）；两个判定分支与错误文案**逐字未动**。

### 1.2 `probeDistroState()` 增加 `ok` 标志（原 `distroFlags()`，`src/explorer.ts:257`）

解析逻辑逐字保留；仅新增"命令是否真的跑成功且有输出"的 `ok`（`res.error === undefined && res.status === 0`），供缓存判定用。**不对外暴露**，不改变任何返回字段。

### 1.3 snapshot 并发单飞（`src/explorer.ts:371-383`）

`snapshot` 无参 ⇒ 同参并发共享**同一次执行**（`snapshotInflight`）。执行结束立刻在 `finally` 清空 ⇒ **不是缓存**：下一个调用（哪怕紧接着）必然重新探测；失败同样共享 rejection 并清空，不会留下"永远返回旧错误"的悬挂 Promise。并发调用者共享同一个结果对象（只读语义；HTTP adapter 只做 JSON 序列化）。

### 1.4 可选测试缝（生产不传）

`deps.distroStateProbe?`（`src/explorer.ts:348`）：注入 `() => {defaultName, running, ok}`，用于在**不动真实发行版生命周期**的前提下验证"未运行 / 启停"分支。`index.ts` **不传**，默认走真实 `wsl.exe -l -v`；生产路径行为不变（见 §4.3 的 before/after 对照）。

## 2. 前后实测（同窗口、N=5、中位数）

~~~text
| 场景 | before 中位数 (min/max) | after 中位数 (min/max) | Δ | 提速 |
|---|---:|---:|---:|---:|
| raw:wsl -l -q | 79.5 (66.6/86.4) | 60.1 (56.4/65.6) | -19.4ms | 1.3x |
| raw:wsl -l -v | 59.6 (50.9/66.2) | 50.2 (47.3/58.9) | -9.4ms | 1.2x |
| raw:wsl -d <distro> bash -c true | 188 (117.5/234.8) | 124.8 (118.3/143) | -63.2ms | 1.5x |
| listDir cold | 102.7 (100/118.1) | 99.9 (93.9/121.8) | -2.8ms | 1x |
| listDir warm(同实例第二次) | 104.3 (97/111.5) | 1.2 (1.1/1.8) | -103.1ms | 86.9x |
| snapshot cold | 341.1 (331.7/355.7) | 325.2 (317.3/364.6) | -15.9ms | 1x |
| snapshot warm(同实例第二次) | 306.2 (298.8/337.8) | 226.7 (215.7/248.4) | -79.5ms | 1.4x |
| panel burst cold (snapshot->listDir) | 400.4 (398.8/412.1) | 380.9 (307.5/443.4) | -19.5ms | 1.1x |
| panel burst warm(同实例再来一轮) | 398.3 (385.6/417.4) | 238.4 (219.5/251.9) | -159.9ms | 1.7x |
| snapshot x3 concurrent | 950.3 (899.4/985) | 326.8 (316.6/394.3) | -623.5ms | 2.9x |
| snapshot x3 sequential(对照) | 925.6 (901/1094.9) | 744.4 (727.1/780.7) | -181.2ms | 1.2x |
~~~

（表由 `table.ts` 从 `out-before.json` / `out-after.json` 机械生成，不是手抄。）

### 2.1 噪声与解读（不要把冷路径的 ±15% 当结论）

- 两次独立窗口的原始 spawn 基线本身在漂：`wsl -l -q` 45–80ms、`wsl -l -v` 45–60ms、`wsl -d` 105–190ms（机器上还有 Lead 的构建/编辑在跑）。所以 **`listDir cold`（102.7→99.9）、`snapshot cold`（341.1→325.2）属于"不变"**：冷路径的代码路径没变，仍是 2 次 spawn。
- **可靠的是结构指标**（§0 的调用次数表）与**热路径的量级差**：`listDir warm` 在两次 after 窗口都是 ~1.1–1.2ms（before 94–104ms），跨窗口可复现。
- `snapshot` 的热路径只省掉事实读（2 次 spawn ≈ 110–140ms），剩下的 ~210ms 是 `daemonSnapshot()`（`/proc` 扫描的 `wsl -d` ≈ 125–190ms + UNC 元数据 + 每槽 TCP），**本轮未缓存它**（任务范围只要事实读 + 单飞）。
- `snapshot ×3 并发` 950→327ms 的 2.9× 几乎等于 3 次 `daemonSnapshot` 合成 1 次；`×3 顺序` 仍 ~744ms（每次都真实扫描），证明**单飞没有变成"完成后缓存"**。

## 3. 语义回归（before/after 逐字对照）

方法：`regression.ts` 用 `--module` 分别指向 **HEAD 副本**（`_before/src/explorer.ts`，由 `git archive HEAD src` 原样导出）与工作区文件，同一脚本跑两遍；A/B 两组共 **16 项**，用 `JSON.stringify` 逐字比较。

~~~text
=== A/B 稳定性（必须 0 差异）===
checked: 16, diffs: 0
~~~

### 3.1 错误 code / 文案（逐条 before/after 相同）

| 场景 | code | 文案（两轮逐字相同，此处省略共同的英文/路径细节） |
|---|---|---|
| 路径不存在 | `E_NOTFOUND` | `remote-wsl: 列目录失败：路径 /home/g/__no_such_dir_bench__ 不存在或不是目录（ENOENT: …）` |
| 参数非法（相对路径） | `E_ARG` | `remote-wsl: explorer.listDir 的 path 必须是 WSL 绝对路径（以 / 开头），收到 "../etc"（Windows 盘符请写成 /mnt/c/...）` |
| 含有 NUL | `E_ARG` | 同上族（含 NUL 拒绝）—— 两轮相同 |
| 发行版不在 `wsl -l -q` 列表 | `E_UNAVAILABLE` | `remote-wsl: 配置的发行版 "bench-no-such-distro-xyz" 不在 wsl -l -q 的输出里 ⇒ 无法读取 /home/g。面板是只读的，不会为了浏览而启动发行版；请检查 config.distro 或先手动启动它。` |
| 发行版未运行 | `E_UNAVAILABLE` | `remote-wsl: 发行版 "bench-fake-not-running" 此刻未运行（wsl -l -v 的 STATE ≠ Running）⇒ 无法读取 /home/g。面板是只读的，不会为了浏览而启动发行版；请先手动启动它。` |

> "未运行"分支的构造方式：注入 `listDistros` 返回"真实名字 + 假名"，让假名通过第一道闸门、再被真实 STATE 判为未运行。这条在 **before 版本上也可构造**（不需要测试缝），所以两边是真对照。

### 3.2 HTTP 适配层状态码（9 项全部相同）

| 用例 | before → after |
|---|---|
| 无 `Origin` | 403 → 403 |
| 跨源 `Origin` | 403 → 403 |
| `GET` 方法清单 | 200 → 200 |
| `PUT` | 405 → 405 |
| `content-type: text/plain` | 415 → 415 |
| 未知方法 `explorer.__probe__` | 400 → 400（仍回 `methods` 清单） |
| `listDir` 路径不存在 | 404 → 404 |
| `listDir` 参数非法 | 400 → 400 |
| `snapshot` 正常 | 200 → 200 |

返回字段形状同样逐字相同（`listDir_okShape` / `snapshot_okShape` 两轮 JSON 相等：`distros/target/daemon/drift/workspaces/webHosts` 与 `entries[{name,kind,hidden}]`）。

## 4. 缓存与单飞行为读数（如实记录）

### 4.1 合并效果（burst）

| 读数 | before | after |
|---|---:|---:|
| burst 首次：`snapshot` + `listDir` 内 `listDistros` 次数 | 2 | **1** |
| burst 第二轮（TTL 内） | 2 | **0** |
| 过 TTL（2.3s）后再一轮 | 2 | **1**（到期重取） |

### 4.2 TTL 内"发行版启停"可见性（C4，真实发行版 + 注入探针翻转 STATE）

| 时刻 | 结果 |
|---|---|
| 初始（探针 running=true） | `ok:true`、`entries:71` |
| **翻转为 stopped 后立刻调用**（仍在 2s TTL 内） | **`ok:true`、`entries:71`（看不见翻转 —— 如实记录为设计行为）** |
| 等 2.3s（> TTL）后再调用 | `E_UNAVAILABLE` + "…此刻未运行（wsl -l -v 的 STATE ≠ Running）…" |
| 探针调用次数 | **2**（首调用 1 次 + 过期后 1 次；TTL 内那次没有探测） |

**如实写**：发行版在 TTL 窗口内被 terminate 时，面板/`listDir` 最多有 **2 秒**继续按"运行中"处理（可能读到 UNC 失败才报错）；被 start 时同理最多 2 秒仍显示未运行。这是缓存换来的确定代价，不是"实时保证"。**本轮没有在真机上 terminate/start 用户的发行版**（按纪律），上表用注入探针构造同一代码路径。

### 4.3 失败不缓存（C5）

| 构造 | before | after |
|---|---|---|
| 探针 `ok:false`（STATE 表读取失败），连续 2 次调用 | 2 次 `listDistros`（无缓存概念） | **2 次 `listDistros` + 2 次探针**（每次重试，未缓存失败） |
| `listDistros` 返回空数组，连续 2 次调用 | 2 次 | **2 次**（空列表不缓存） |

### 4.4 单飞（D）

| 读数 | before | after |
|---|---|---:|
| `snapshot` ×3 并发：`listDistros` 次数 / 耗时 / 三个结果是否同一对象 | 3 / 737.4ms / false | **1 / 243.0ms / true** |
| `snapshot` ×2 顺序（TTL 内） | 2 | 0（命中的是 TTL 缓存） |
| `snapshot` ×2 顺序（跨 TTL） | 1 | 1（第一个必然重探；第二个落回 TTL 缓存 —— 见 §4.1 口径） |
| 顺序两次的结果是否同一对象 | false | **false**（无"完成后缓存"） |

## 5. 复现（bundled node；PATH 上的 `node` 是坏 shim）

工作目录：`D:/project/dsh1/dsh-remote-wsl/spike/verify/uiux-20261019/host-perf`
NODE=`C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

~~~powershell
# 0) 导出 HEAD 源码（before 对照用；输出目录 _before/ 已被本目录 .gitignore 排除，可删除重建）
git -C D:\project\dsh1\dsh-remote-wsl archive --format=tar HEAD src | tar -x -C .

# 1) 基准：before（HEAD 副本）与 after（工作区）
& $NODE bench.ts --label before --n 5 --module ./_before/src/explorer.ts --out out-before.json
& $NODE bench.ts --label after  --n 5 --out out-after.json
& $NODE table.ts out-before.json out-after.json

# 2) 回归 + 缓存/单飞读数
& $NODE regression.ts --label before --module ./_before/src/explorer.ts --out out-regression-before.json
& $NODE regression.ts --label after --out out-regression-after.json
& $NODE compare.ts out-regression-before.json out-regression-after.json

# 3) 第二次 after（量化噪声，不参与主表）
& $NODE bench.ts --label after2 --n 5 --out out-after2.json
~~~

单次耗时：bench 约 40–60s（每场景 5 样本，含真实 spawn）；regression 约 20–30s（含 2 次 2.3s TTL 等待）。

## 6. 文件清单

| 文件 | 作用 |
|---|---|
| `src/explorer.ts` | **唯一改动的源码**：TTL 常量 + `probeDistroState` 的 `ok` + `readDistroFacts` + snapshot 单飞 + listDir 复用 + 可选 `deps.distroStateProbe` |
| `spike/verify/uiux-20261019/host-perf/bench.ts` | 端到端基准（`--module` 可指向 HEAD 副本；`--n`/`--label`/`--out`） |
| `spike/verify/uiux-20261019/host-perf/regression.ts` | 语义回归 + 缓存/启停/失败不缓存/单飞读数（`--module`） |
| `spike/verify/uiux-20261019/host-perf/compare.ts` | before/after 回归 JSON 对照（A/B 必须 0 差异） |
| `spike/verify/uiux-20261019/host-perf/table.ts` | 从两份 bench JSON 机械生成 Markdown 表 |
| `.../out-before.json`、`out-after.json`、`out-after2.json` | 基准原始读数 |
| `.../out-regression-before.json`、`out-regression-after.json` | 回归原始读数 |
| `.../_before/src/*.ts` | `git archive HEAD src` 的**生成副本**（仅 before 对照组用）。已被本目录 `.gitignore` 排除，**不随产物提交**；可随时删除并用 §5 第 0 步重建 |

## 7. 未验证 / 风险（不许当通过）

1. **真机启停未验证**：按纪律没有 `wsl --terminate` / `--shutdown`，也没有 start 一个停止的发行版；§4.2 的"TTL 内不可见"是**注入探针构造同一代码路径**得到的，真实 terminate/start 的时序（含 UNC 句柄失效）未实测。
2. **冷路径的毫秒结论只到"不变"**：机器负载漂移使冷路径 ±15%；结构上冷路径仍是 2 次 spawn（调用次数表可证）。
3. **`daemonSnapshot` 未优化**：它占 `snapshot` 热路径的绝大部分（~210ms，其中 `wsl -d` 探针 125–190ms）。本轮范围不含它；若要做，建议单独任务（例如给它自己的短 TTL + 单飞，并单独写"守护状态滞后"的语义代价）。
4. **多实例**：缓存是**每个 handler 实例一份**（生产只有一个实例）。若将来进程内建多个 `createExplorerHandlers`，它们各缓存各的（不会互相污染，但也不会共享）。
5. **`snapshot` 并发调用者共享同一结果对象**：当前消费方（HTTP adapter JSON 序列化、面板只读）安全；将来若有调用方就地修改返回值，会串扰 —— 已在注释里写明"只读使用"。
6. **未跑门禁全量**：`precommit-check` / `check-explorer-methods` / `check-client-rev` 等属 Lead 的收尾流程；本次只跑上述脚本（且 `client/**` 的改动不是本任务做的）。
7. **`_before/` 是生成物**：它不是源码，不应被当成"第二份实现"；已被本目录 `.gitignore` 排除（不随产物提交），可随时删除并用 §5 第 0 步重建。
