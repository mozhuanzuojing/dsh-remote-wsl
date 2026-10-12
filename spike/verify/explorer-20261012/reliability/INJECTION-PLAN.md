# 注入实验计划（task-6）—— 等 lead 放行后才可执行

- **状态**：**准备稿**。task-6 被 task-2/task-3 阻塞；**本回合不执行任何注入**。
- **纪律**：只写本目录；被验对象（`src/`、`client/`、`package.json`、`docs/`、他人 profile）只读；不重启用户宿主（`19387`/pid 基线 **47564**）；不全局 `pkill`；端口只用 **8971–8980**。

## 0. 端口与实例分配（8971–8980，与 p0-verify 的 8931–8960 不重叠）

| 端口 | 用途 | 备注 |
|---|---|---|
| **8971** | 测试宿主 web UI（带插件） | `dsh --profile remote-wsl-test web --port 8971 --no-open`（**另起**实例，不碰 19387） |
| **8972** | 我的守护槽位（WSL 侧） | 经 `--patch` 覆盖 `daemonPort: 8972`（**不写用户 profile**：`--patch` 是官方 CLI 支持的覆盖层，`dsh --help` 已确认） |
| 8973–8974 | 守护端口回退槽（F7/F8 需要） | `daemonPortTries: 3` ⇒ 8972/8973/8974 |
| **8975** | 占用探针（squatter）**A**：占 8972 | INJ-D |
| **8976** | 占用探针 **B**：占 8972+8973+8974（F8） | INJ-D |
| **8977** | 占用探针 **C**：占 8971（宿主起不来，F6） | INJ-D |
| 8978–8980 | 备用 | — |

> **邻段协调（已互相通报，零重叠）**：p0-verify `8931–8960` ｜ usability-engineer `8961–8970` ｜ **本任务 `8971–8980`** ｜ 用户宿主 `19387`（pid 47564）、proxy `9910` = 三方共同禁区。
>
> 环境事实（准备期只读复验）：`19387` = pid 47564（未变）；8971–8980 全部空闲。
> **网络模式（2026-10-12 11:46:38 实测，**纠正** p0-verify 的 mirrored 记录）**：`wslinfo --networking-mode` = **`nat`**；`.wslconfig` 含 `localhostForwarding=true` / `autoProxy=true` / `firewall=false` ⇒ **Windows 侧占端口不会挡住 WSL 侧 bind** ⇒ 占用探针**必须用 `occupy-ports.ps1 -Where wsl`**（脚本默认即 wsl）；`-Where windows` 降级为**阴性对照**。详见 [out-00-prep-findings.txt](./out-00-prep-findings.txt) F-1。

## 0.1 准备期现场发现（2026-10-12 11:46:38，零副作用探针）与**待批准**的加固

> 完整取证见 [out-00-prep-findings.txt](./out-00-prep-findings.txt)。**四条都不进结论，只改执行方式。**

| 编号 | 发现 | 对执行的影响 |
|---|---|---|
| **F-1** | **网络模式 = NAT**（`wslinfo --networking-mode`），**不是** p0-verify 记的 mirrored；`.wslconfig` 有 `localhostForwarding=true` / `autoProxy=true` | 占用注入**只用 `-Where wsl`**；`-Where windows` 降为阴性对照（§0 已更正） |
| **F-2** | **默认槽位 8731 上有一个不属于我的守护**（`daemon.8731.json` pid 758411、`ss` 见 `LISTEN 127.0.0.1:8731`、`keys: []`，11:37 启动、非我所起） | ① 我的实验全程只用 **8972**；② 结构上**停不到它**（显式 slot 取不到记录即 `alreadyStopped`，注释明写"未去停别的槽位"，`daemon-client.ts:637-644`）；③ **但"不带 slot 的 ensure"会落到配置槽位** ⇒ 引出我自己的**假绿**通道，见下 |
| **F-3** | WSL 侧 `/usr/bin/python3` ✅、`/usr/bin/ss` ✅ | `occupy-ports.ps1 -Where wsl` 可执行（恰好也是 F-1 要求的路线） |
| **F-4** | `launch-stderr.log` 权限 **0644**（同目录其余均 0600） | FMEA 新增 **F31**；不单开修复轮次 |

### 待 lead 批准的加固（**答复前我不改脚本**）

F-2 暴露了我自己实验的一个**假绿通道**：若 `--patch`（`daemonPort: 8972`）未生效，`capture` 与 `restore` 会落在**同一个 8731** 上前后比对 ⇒ 会得出 `RESTORED: yes`，**而我从未拥有过自己的守护**。提议两处最小改动：

1. **`-Phase capture` 增加前置断言，不满足即 exit 3 拒跑**：
   - `out-A-01-status-before.txt` 必须含 **`configured=8972`**（`wsl_status` 的 `daemon ports: configured=<slot>(+N 回退)` 行）；
   - 若快照显示已有守护，则 `daemon.slot` **必须 = 8972**。
2. **`-Phase restore` 的 `ensure` 改为显式 `slot: 8972`**（`INJ-A 步骤 6` 同步改），彻底消除"落到配置/默认槽位"的路径。
   > 依据：`explorer.daemon` 的 `slot` 只在**本次调用**覆盖 `daemonPort`（`explorer.ts:343-344`）⇒ 显式 slot 不会写坏 `--patch` 配置，只是把"打到哪个槽位"变成不可漂移。

## 1. 两条**必做**实验（lead 下发的"至少 2 条"）

### INJ-A —— 杀死守护后刷新面板（F4/F5，端到端）

- **目的**：证明"守护死掉"在界面上是**可读状态变化**，不是白屏/挂死/**静默陈旧 pid**；并证明能**幂等复原**且复原后与 before 一致。
- **被验 FMEA 行**：F4、F5、F21、F22、F23（顺带看错误态）。
- **脚本**：`inject-a-daemon-kill.ps1 -Phase capture|kill|verify|restore|all -Go`
- **步骤**：
  1. `capture`：同源 POST `explorer.snapshot` → `out-A-01-snapshot-before.json`；跑 `..\probe-ground-truth.ts --mode status --port 8972 --out out-A-01-status-before.txt` 取**同源地面真相**；把 `{daemon.running, slot, pid, version, keys[], distros[]}` 归一化进 `out-A-01-state-before.json`；跑 `..\revision.ps1 -Mode Preview` 落 `out-A-00-revision.txt`（证明被验对象未被我改）。
  2. 浏览器（隔离 Chromium，`cua_driver_native` 首选）：打开 `http://127.0.0.1:8971` → 点我们图标 → `..\browser\extract-panel.js` + `take_screenshot` → `out-A-02-panel-before.json` / `shot-A-02-panel-before.png`。
  3. `kill`：**只停自己槽位**：同源 POST `{method:'explorer.daemon',args:{action:'stop',slot:8972}}` → `out-A-03-stop.json`。**断言请求里没有 `all`，`slot` 恒为 8972**（脚本内含守卫）。再用只读快照证明 `running:false` → `out-A-03-snapshot-after-kill.json`。
  4. 刷新面板（点"刷新"按钮，不用整页 F5 —— 两者都要，见下）→ 抽取 + 截图 → `out-A-04-panel-after-kill.json` / `shot-A-04-*.png`。
  5. `verify`：断言 `out-A-04` 里 (a) 状态条文本含 `daemon 未运行`（或等价可读文案）；(b) **不含** `out-A-01` 里的旧 `pid` 数字（**陈旧值检测**）；(c) 面板根节点存在且文本长度 > 0（**非白屏**）；(d) console 无未捕获 error（`out-A-04-console.txt`）；(e) 根部出现"启动守护"入口。
  6. `restore`：同源 POST `explorer.daemon{action:'ensure'}` → `out-A-05-ensure.json`；断言 `ok:true`、`slot==8972`（若回退则在报告里写明）、`pid` 非空。
  7. 收尾：再抽一次面板 + 快照 → `out-A-06-*`；`verify` 比较 before/after（slot/keys 集合应一致，pid 允许变）。
- **强制的"整页 F5"变体**（F18）：kill 态下按 F5 → 面板必须仍显示可读的"未运行"，且 `lastLoadedAt` 重置；产物 `out-A-07-panel-reload-errorstate.json`。
- **断言失败即红**：白屏 / 旧 pid 残留 / 文本空 / console error ⇒ 实验判 **RED**，写进报告。
- **复原保证**：`restore` 幂等；若 `ensure` 失败，脚本打印 `RESTORED: NO` 并以 exit 2 结束（**不掩盖**）。

### INJ-B —— 打 `/remote-wsl/api`：伪造/缺失 Origin 与错误码矩阵（F9–F13，含"闸门是否真拦住副作用"）

- **目的**：(1) 证明五条硬要求 (a)(b)(c) 的闸门**在方法执行之前**生效；(2) 给出 403/400/405/415/非 JSON 的**真实原始响应**；(3) 证明错误响应**不回传凭据**。
- **脚本**：`inject-b-api-gate.mjs --port 8971 --go`（Node 原生 `http`，可完全控制 headers；无第三方依赖）
- **矩阵（每步落 `out-B-<nn>-<name>.json`，汇总 `out-B-api-gate.txt`/`.json`）**：

| # | 请求 | 期望 | 证明什么 |
|---|---|---|---|
| 1 | 同源 POST `explorer.snapshot` | 200 `ok:true` | 对照（闸门不该拦正常流量） |
| 2 | **无 `Origin`** POST | 403 | (a) `Origin` 必须存在 |
| 3 | `Origin: http://evil.example` | 403 | 跨站被拒 |
| 4 | 同源 Origin + `Sec-Fetch-Site: cross-site` | 403 | `Sec-Fetch-Site` 也参与 |
| 5 | 同源 Host、**端口不同**的 Origin（`:9999`） | 403 | 比的是 host:port 逐字 |
| 6 | `method:"explorer.nope"` | 400 + `methods` | (b) 白名单 |
| 7 | body 非 JSON | 400 | 解析失败回 400 |
| 8 | `method` 缺失 | 400 | 空方法名 |
| 9 | `PUT`（同源） | 405 | (c) 动词 |
| 10 | `POST` + `content-type: text/plain` | 415 | 类型（实现较设计稿更严） |
| 11 | 同源 `GET` | 200 + `methods` | 设计 §4 的只读发现 |
| 12 | `GET /remote-wsl/api/`（尾斜杠） | **实测记录**（预期落 SPA fallback ⇒ 200 HTML） | F11"最易误判形态" |
| 13 | **raw socket：HTTP/1.0 无 `Host`** | 实测记录（预期 http 层 400 或我们的 403） | (a) 缺 Host 的边界 |
| 14 | **副作用负向探针**：`Origin: http://evil.example` + body `{method:'explorer.daemon',args:{action:'stop',slot:8972}}` | 403 **且守护 pid 必须不变** | **"不满足 → 403，且不得执行任何方法"** 的唯一硬证明 |
| 15 | 响应体扫描：全 14 条响应里**不得**出现 token/credential 字段名或长随机串 | 无命中 | (e) 不泄漏凭据 |

- **前置**：守护在 8972 上活着（否则 step 14 的"pid 不变"退化为空集假绿）。脚本开头**断言之**，不满足即 exit 3 并标 unknown。
- **复原**：矩阵全为只读（step 14 期望不执行）⇒ 不需要复原；但脚本收尾**再读一次快照**并与开头比对，若守护不见了，立刻 `ensure` 并打印 `INVARIANT BROKEN` + exit 2。
- **风险**：请求本地 127.0.0.1，不与外部交互；不改被验对象。

## 2. 两条**加分**实验（廉价、无宿主或低风险；若时间不够可只做 INJ-C）

### INJ-C —— `webServer` 未注入 + 重复注册（F15/F16/F20，**不启宿主**）

- **脚本**：`inject-c-inject-and-duplicate.ts --go`（直接 import `src/explorer.ts`，只调 `registerExplorer` + 桩 ctx）
- **三个子例**：
  - **C1** `inject` 永不回调（= 条件注入未触发）⇒ 期望：stderr 出现"webServer 服务不可用 ⇒ … 未注册"，**不抛**，返回的 `methods` 仍是 4 个，`dispose()` 安全。
  - **C2** `register` 第二次抛真实错误（官方文案 `webserver: duplicate exact route "/remote-wsl/api"`，`lib/index.js:179`）⇒ 观察 throw 是否**逃出注入回调**（stub 下会；真实 Cordis 下未复核）。记录 `removeRoute` 未赋值 ⇒ `dispose()` 为 no-op（SP7）。
  - **C3** `inject` 回调**触发两次**（模拟 HMR/服务重提供）⇒ 第二次注册必抛；记录"第一次的路由无人释放"。
- **边界（诚实标注）**：stub 证明的是**实现**会抛，**证明不了真实 Cordis 的卸载行为** ⇒ 那部分留给 INJ-D + 未复核项 #2。

### INJ-D —— 端口占用 与 双装载（F6/F7/F8/F16/F22/F23）

- **D1（F8，可全自动）**：`occupy-ports.ps1 -Ports 8972,8973,8974 -Go` 占住 3 个端口 → 打 `explorer.daemon{action:'ensure'}` → 期望 **500 + 可读原话**（"…全被占用"）；面板侧动作条显示 `失败：…`。复原：杀**自己起的** squatter pid（`occupy-ports.ps1 -Stop`，只按记录的 pid）。
- **D2（F7）**：只占 8972 → `ensure` → 期望守护落在 8973，且 `notes`/`actualPort` 说明被占；断言 `slot` 与 `port` 不一致时**面板状态条只显示 slot**（F30 的实测）。复原：删自己起的守护（`explorer.daemon{action:'stop',slot:8973}`）。
- **D3（F22/F23，页面内注入，不改被验对象）**：用 init script 包一层 `window.fetch`，让 `/remote-wsl/api` 直接 reject（或回 500 JSON）→ 抽取面板文本 → 断言：**错误盒存在**，且**不得出现"daemon 未运行"这类未确认负事实**、**不得留着上一次的"快照 <时间>"**。预期会**红**（FMEA 预判 F22/F23 未覆盖）。
- **D4（F6）**：占 8977 后 `dsh … web --port 8977` → 期望**启动即响亮失败**（bind 诊断），不是半死。检查退出码与 stderr。
- **D5（F16/F20，需宿主）**：用 `dup-plugin.yml`（本目录，**只读地**经 `--patch` 追加第二个 entry，指向同一包）造双装载 → 观察：(a) 宿主是否起来；(b) 我们的路由是否仍 200（先注册者是否存活）；(c) 第二个 entry 的 6 个工具是否在；(d) stderr 是否出现 `duplicate exact route`。

## 3. 产物命名

| 实验 | 产物 |
|---|---|
| INJ-A | `out-A-00-revision.txt`、`out-A-01-*`、`out-A-02-panel-before.json`、`shot-A-02-*.png`、`out-A-03-*`、`out-A-04-*`、`out-A-05-*`、`out-A-06-*`、`out-A-07-*`、`out-A-99-cleanup.txt` |
| INJ-B | `out-B-01..15-<name>.json`、`out-B-api-gate.txt`、`out-B-api-gate.json` |
| INJ-C | `out-C-01-inject-absent.txt`、`out-C-02-duplicate-throw.txt`、`out-C-03-inject-twice.txt` |
| INJ-D | `out-D-01..05-*`、`shot-D-03-*.png`、squatter pid 记录 `out-D-00-squatter-pids.json` |

每个脚本**同时**落 `.err`；stdout 一滴不漏进 `out-*`。

## 4. 每步共同的**前置守卫**（脚本内已实现，违反即拒跑）

1. 必须带 `-Go` / `--go`（否则拒绝执行任何动作）。
2. 端口必须落在 **8971–8980**；命中 `19387` / `9910` ⇒ 拒跑。
3. 每次动作前读 `19387` 的 listener pid，必须等于基线（`out-A-00-revision.txt` 里记录）⇒ 证明**用户宿主未被碰**。
4. 任何 `daemon` 动作**只允许** `slot ∈ {8972,8973,8974}`，**禁止** `all:true`（脚本里对 body 做字符串级断言）。
5. 收尾必须打印 `RESTORED: yes|NO`；NO ⇒ 非零退出并写进报告。

## 5. lead 裁决记录（2026-10-12）与执行影响

| # | 我提的问题 | lead 裁决 | 对执行的影响 |
|---|---|---|---|
| 1 | 放行 | **go 未到**（task-2/task-3 仍 `in_progress`：代码已落盘、写手未宣告完成）；两者一 complete 立刻发 go 并同步通知 T4/T5/T7 | **保持待命、脚本不改**，不提前注入 |
| 2 | profile 口径 | **批准**：用既有 `remote-wsl-test` + `--patch` 覆盖 `daemonPort=8972`，**不新建 profile**；p0-verify 的 `remote-wsl-test-web` 归它自己（8931–8960） | 开工先 `--dump-config` 自证覆盖生效，再起 8971 |
| 3 | 8975–8977 占用是否冲突 | 无冲突（已与 p0-verify 8931–8960、usability-engineer 8961–8970 对齐） | INJ-D 占用探针可用；收尾 `occupy-ports.ps1 -Stop -Go` |
| 4 | F27 桌面壳 | 按 **❓未复核**处理，口径写准：P0 目标面 = **Web 前端**；桌面壳将来要支持须**另立**同源口径（如 `Origin: null` + loopback/token），**不得**直接放宽 web 面闸门 | **不设**桌面壳实验；FMEA/REPORT 已按此改口径 |
| 5 | 415 是否越界 | **不越界，且是更准的实现**；设计稿已改为「非 POST ⇒ 405；POST 但 `content-type` 非 `application/json` ⇒ 415」 | F13 判 ✅；T4 的 B 组验收同步更新 |
| 6 | `revision.ps1` 锚点 | 已含 `client/**` 全量（原冻结 7 个 + `src/**` 新增 + `client/**`） | **只引用**其输出；若要独立复核，读 `REVISION.txt`/`REVISION.preview.txt` 再自算交叉验证 |

**lead 已转给写手的加固项（我的覆盖状态仍以实测为准改判）**：

- **预判 1（F16/SP2）**：已要求 **T2 加固** —— `register` 包 try/catch、失败不得影响插件其余部分、必须 dispose 已注册的那次 ⇒ 我照常做 **INJ-C/D5** 验证。
- **预判 2（F22/F23）**：lead 正在核，已要求 **T3 修** ⇒ **INJ-D3 仍要做**（断言"错误态不得出现未确认的负事实、不得留旧时间戳"）。

**评分纪律（lead 重申，照办）**：`❓` 一律不得升格 ✅、不得写进结论；**INJ-B step14**「异源 + `stop` slot 必须 403 且守护 pid 不变」是整组唯一硬证明 ⇒ **必须留前后 pid 对照的原始输出**；`docs/client-contract.md` 未落地前可先跑不依赖它的 INJ-B 项。

---

## 6. 事后一致性修订（收工后，2026-10-12）

> 本文件的 §0.1 与 §5 写于**开工前**，其中"待批准 / go 未到"等表述在收工后已成**不成立的陈述**。此处统一更正（不改上文原貌，避免无痕修改）：

| 原表述 | 实际结果 | 证据 |
|---|---|---|
| §5 表行 1「go 未到 ⇒ 保持待命」 | **go 已于 2026-10-12 15:44 下达**；task-6 已执行并 **complete** | task-6 状态；[REPORT-reliability.md](./REPORT-reliability.md) |
| §0.1「待 lead 批准的加固（答复前我不改脚本）」 | **已批准并实施**：①`capture` 前置断言（`configured=ExpectedSlot` + 已有守护则 `slot==ExpectedSlot`，不满足 **exit 3**）；②`restore` 的 `ensure` 改**显式 `slot`**。**故意红已实证**：`-ExpectedSlot 8912` → **exit 3** | [out-A-01b-slot-precondition.json](./out-A-01b-slot-precondition.json)、[out-A-04b-verify.json](./out-A-04b-verify.json) |
| §1「INJ-A / INJ-B」 | **两条都按真宿主版做成**（8971 真 `dsh`）：INJ-A 面板 4/4 断言 PASS + 显式 slot 复原；INJ-B **13 PASS / 1 UNKNOWN / 0 FAIL**（含 step14 硬证明） | [out-B-api-gate.txt](./out-B-api-gate.txt)、`out-B-*.json`、`out-A-*.json` |
| §2「INJ-D1/D2/D4/D5」 | **未执行** ⇒ F6（占 8971 响亮失败）、F8 全占场景、`-Where windows` 阴性对照均记 **❓未复核**；INJ-B′（进程内真代码）作为补充路径已完成 **19/19 PASS** | [REPORT-reliability.md](./REPORT-reliability.md) §5、[out-B2-summary.json](./out-B2-summary.json) |
| §2「INJ-C」 | **全部执行**：C1 PASS-BUT-SILENT（F15 缺口）、C2/C4/C5 PASS、**C3 实测命中 F32 路由残留** | [out-C-summary.json](./out-C-summary.json) |
| §4 守卫 3「动作前复验 19387 pid」 | 每次动作前均复验；全程 **47564 未变** | [out-A-00-livehost.txt](./out-A-00-livehost.txt)、[out-A-99-cleanup.txt](./out-A-99-cleanup.txt) |

**CLI 形态更正（lead 实测）**：应用 CLI 是 `dsh --profile <p> [launcher-opts] [app-args]`，**`web` 是 profile 名而非子命令**；`--patch` 属 launcher 选项，**必须在 app args 之前**。我最初写成 `--profile X web --port N --patch …` 得到 `unknown option '--patch'`；正确形态 `--profile X --patch <f> --port N --no-open`（本任务 8971 即用此形态跑通）。
