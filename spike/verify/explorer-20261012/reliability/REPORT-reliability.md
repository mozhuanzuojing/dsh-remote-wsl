# REPORT-reliability —— P0 数据通道 + 守护 可靠性审查（task-6）

- **审查者**：`reliability-keeper` ｜ **日期**：2026-10-12 ｜ **状态**：**已完成**
- **被验对象（只读）**：`D:\project\dsh1\vendor\dsh-remote-wsl`
  - **冻结 revision（开工复算 + 收尾复核，13/13 逐字节未变）**：`src/explorer.ts` **86f29d83…** 29,545 B ｜ `client/client.panel.js` **8f5ce575…** 29,111 B ｜ `client/client.api.js` 4f98663d… 10,661 B ｜ `client/index.js` a0c96568… 13,859 B ｜ `client/client.icon.js` e9a824f5… 2,209 B ｜ `package.json` 36f70175… 1,452 B ｜ 其余 6 个 `src/*.ts` 见 [REVISION-observed.txt](./REVISION-observed.txt)
  - 与 p0-verify 的 `REVISION.txt`（15:45:24 冻结）**锚点段一致**
- **端口**：8971（测试宿主）/8972–8974（自有守护槽位）｜**活宿主 `19387` 全程 pid = 47564 未变**｜收尾端口全部 free
- **配套**：[FMEA.md](./FMEA.md)（逐条故障模式）｜[INJECTION-PLAN.md](./INJECTION-PLAN.md)｜[out-00-prep-findings.txt](./out-00-prep-findings.txt)（环境取证）

---

## 1. 结论（**438 字**，≤450）

真宿主闸门矩阵 **13 PASS / 1 UNKNOWN / 0 FAIL**；异源 `stop` 被 403 拦且 pid 前后不变（硬证明）。守护死后面板 4/4 绿：可读「daemon 未运行」、时间戳新鲜、无旧 pid、有启动入口；复原后 pid 回归、slot 恒 8972。lead 两处加固实测生效：重复装载不再打倒插件、快照失败不渲染负事实。

**仍存 4 缺口**：①inject 二次触发置空首次路由 disposer ⇒ 卸载/HMR 路由残留（F32）；②webServer 未就绪时零日志、数据面静默缺席（F15）；③初次加载即宣称「读取失败后已撤下」（F34）；④`fixPin` 返回 ok:false 仍按成功语气渲染（F25）。另 snapshot.daemon=live[0] 会显示他人槽位守护（实测 live[0]=8932 而 configured=8972；行为层已隔离，显示层未区分，F33）。

**未复核**：桌面壳/反代 Origin、双装载 Cordis 后果、F31 内容、凭据精筛；未改被验对象（13/13 锚点未变），活宿主 47564 未动。

---

## 2. 两条必做注入实验 —— 原始输出

### INJ-A：杀死守护 → 刷新面板（F4/F5/F18/F22/F23）

| 项 | 内容 |
|---|---|
| 命令 | `pwsh ./inject-a-daemon-kill.ps1 -Phase verify -Go -ExpectedSlot 8972`（kill/restore 经真宿主 API 逐步执行） |
| 前置 | 测试宿主 8971（真 `dsh`，见 §4 更正）；自有槽位 8972 上守护活着；`19387`=47564 |
| 原始输出 | [out-A-01-state-before.json](./out-A-01-state-before.json)、[out-A-02-panel-before.json](./out-A-02-panel-before.json)、[out-A-03-stop.json](./out-A-03-stop.json)、[out-A-04-panel-after-kill.json](./out-A-04-panel-after-kill.json)、[out-A-01c-initial-load-false-claim.json](./out-A-01c-initial-load-false-claim.json)、[out-A-05-ensure.json](./out-A-05-ensure.json)、[out-A-06-panel-after-restore.json](./out-A-06-panel-after-restore.json)、[out-A-04b-verify.json](./out-A-04b-verify.json)、[out-A-01b-slot-precondition.json](./out-A-01b-slot-precondition.json) |

**① before（面板状态条，pid 914091）** —— `out-A-02-panel-before.json`：
```
daemon slot 8972 · :8972 · pid 914091 · 0.2.0-rc.2 · keys 0
重启… | 停止 slot 8972… | 快照 16:00:49
```
**② kill（只停我的 slot 8972；脚本对请求体做字符串级断言，禁止 `all:true`）** —— `out-A-03-stop.json`：
```json
{"ok":true,"result":{"action":"stop","ok":true,"idempotent":true,"alreadyStopped":false,
 "slot":8972,"port":8972,"pid":914091,"version":"0.2.0-rc.2","reaped":0,"notes":[]}}
```
kill 后接口读数：`snapshot.daemon = {"running":false,"keys":[],"orphans":1}`；
地面真相（同源 `wsl_status`，`out-A-03-status-after-kill.txt`）：`daemon ports: configured=8972(+3 回退) actual=(未运行)`。

**③ after-kill（点刷新后抽取）** —— `out-A-04-panel-after-kill.json`：
```
远程资源管理器 / 目标 debian-u8-1 · /home/g
▾ debian-u8-1  默认发行版  运行中 · 1 路径  当前目标
📁 g  /home/g   [在新会话中打开] [复制路径]
原始 snapshot（与 wsl_status 同源）
daemon 未运行   [启动守护]        快照 16:01:59
```
**④ 机器断言（`-Phase verify`，真实基线 `pidBefore=914091`）**：
```json
{"pidBefore":914091,"panelFile":"out-A-04-panel-after-kill.json","present":true,
 "checks":{"non-blank":true,"mentions-daemon-stopped":true,"no-stale-pid":true,"has-recovery-entry":true},
 "verdict":"PASS"}
```
**⑤ 复原（显式 `slot:8972`，lead 加固②）** —— `out-A-05-ensure.json` / `out-A-06`：
```json
ensure → {"ok":true,"result":{"slot":8972,"port":8972,"pid":918242,"reused":false,"started":true,
          "notes":["另有守护在槽位 8982（端口 8982）—— 不属于本次配置（daemonPort=8972），未复用、未打扰",
                   "槽位 8972 由 Windows 侧握手确认就绪（实际端口 8972，3ms）"]}}
面板 after-restore → daemon slot 8972 · :8972 · pid 918242 · 0.2.0-rc.2 · keys 0   快照 16:02:40
```
⇒ **往返对照：914091 →（未运行）→ 918242，slot 恒为 8972；无白屏、无挂死、无陈旧 pid。** 收尾已 stop，8972 free。
**同时抓到 F34**：面板刚打开、fetch 未返回时，快照里同时出现「正在读取 explorer.snapshot…」与「数据不可用：读取失败后已撤下，不显示守护/漂移状态。」（`out-A-01c-initial-load-false-claim.json`）。

### INJ-B：`/remote-wsl/api` 闸门 + 错误码矩阵（F9–F14）

| 项 | 内容 |
|---|---|
| 命令 | `node ./inject-b-api-gate.mjs --go --port 8971 --daemon-slot 8972`（**真宿主真 HTTP**；Node 原生 http 逐头控制） |
| 前置 | 同源 POST `explorer.snapshot` 可 200；守护在 8972 活着（否则脚本 exit 3，防空集假绿） |
| 原始输出 | [out-B-api-gate.txt](./out-B-api-gate.txt)、[out-B-api-gate.json](./out-B-api-gate.json)、`out-B-01..15-*.json`、[out-B-00-dumpconfig.txt](./out-B-00-dumpconfig.txt)、[out-B-01-host.log](./out-B-01-host.log) |

**原始汇总（逐行，`out-B-api-gate.txt`）**：
```
[PASS] 01 same-origin-snapshot-200 期望=200 实际=200
[PASS] 02 no-origin-403 期望=403 实际=403
[PASS] 03 foreign-origin-403 期望=403 实际=403
[PASS] 04 cross-site-403 期望=403 实际=403
[PASS] 05 wrong-port-origin-403 期望=403 实际=403
[PASS] 06 unknown-method-400 期望=400 + methods[] 实际=400
[PASS] 07 malformed-json-400 期望=400 实际=400
[PASS] 08 empty-method-400 期望=400 实际=400
[PASS] 09 put-405 期望=405 实际=405
[PASS] 10 non-json-ctype-415(实测) 期望=415 实际=415
[PASS] 11 get-methods-200 期望=200 + methods[] 实际=200
[PASS] 12 trailing-slash(实测) 期望=404 或 200-非JSON（SPA fallback） 实际=405 json=false
[UNKNOWN] 13 http10-no-host(实测) 实际=无状态行：closed
[PASS] 14 negative-sideeffect-stop-must-not-run 期望=403 且 pid 仍为 914091 实际=403 pid=914091
[PASS] 15 credential-leak-scan 期望=响应体不含 token/凭据字段 实际=无命中
INJ-B 完成：exit 0
```
**★ step 14 是整组唯一的硬证明**：请求为**异源** `Origin: http://evil.example` + `{method:'explorer.daemon',args:{action:'stop',slot:8972}}` ⇒ 回 **403**，且**前后两次按槽位读数的 pid 都是 914091**（`out-B-14-*.json` 内含 `pidBefore/pidAfter`）⇒ 闸门确实在**任何方法执行之前**生效。

**实测修正了两条准备期预判**：
- **step 12**：`POST /remote-wsl/api/`（尾斜杠）实测 **405 + 非 JSON**，**不是**预判的"SPA fallback 200-HTML" ⇒ F11 的"看似通了"假绿形态在该路径**不存在**（比预判更安全）。
- **step 13**：HTTP/1.0 无 `Host` ⇒ **连接被关闭、无状态行**（不是 403）⇒ 记 **UNKNOWN**；但"没有放行"成立（无任何 200）。
- 另：真宿主上 `GET /` 是 **401**（GUI 鉴权），而我们的**精确路由未被鉴权中间件截获**（step 1 同源 POST = 200）——由 [out-B-01-host.log](./out-B-01-host.log) 的 `面板数据面已注册: /remote-wsl/api（方法 …）` 与浏览器网络记录 `reqid=43 POST /remote-wsl/api [200]` 双向印证。

### 附加注入实验

- **INJ-B′（进程内真代码）**：真 `index.ts apply()` + 真 `registerExplorer` + 真 adapter + 合成 req/res ⇒ **19/19 PASS**（E_ARG→400、守护 A1→15→A2→A3 迁移、`RESTORED: yes`）。产物 [out-B2-summary.json](./out-B2-summary.json)、[out-B2-api-gate.txt](./out-B2-api-gate.txt)。**限制**：不经真实 `node:http`/Cordis/浏览器；同一批断言已由上面的真宿主版覆盖。
- **INJ-C（桩级）**：`C1 PASS-BUT-SILENT(F15 缺口)`、`C2 PASS`、`C3 HARDENING-OK-BUT-RESIDUAL-LEAK(F32)`、`C4 PASS`、`C5 PASS`。产物 [out-C-summary.json](./out-C-summary.json)、`out-C-0*.txt`。

---

## 3. FMEA 表（**开工后改判版**；完整表见 [FMEA.md](./FMEA.md)）

图例：✅ 已覆盖（代码位置/实测）｜⚠️ 部分覆盖｜❌ 未覆盖｜❓ **未复核（不得当通过）**｜S1 进程/数据 · S2 不可用 · S3 **误导显示** · S4 体验。★ = 本轮改判。

| ID | 故障模式 | 检测手段 | 影响半径 | 缓解/降级 | 覆盖（实测定稿） |
|---|---|---|---|---|---|
| F1 | 配置发行版不存在 | 树无该 distro 行；`target.distro` 仍为配置值 | 面板/agent 面 | 不崩，但**仍断言未验证的目标** | ⚠️ `explorer.ts:162-186,254` ★行号改 |
| F2 | 发行版被关（Stopped） | 徽标「已停止」；`reachable`=STATE=Running | 动作必失败 | **零副作用探活** | ✅ `explorer.ts:132-152,210` |
| F3 | WSL 整体不可用 | 空态「没有返回任何发行版」 | 面板空态 | 可读空态 | ✅ `client.panel.js:245` ★实测该分支已渲染 |
| F4 | **守护死掉** | 状态条 `daemon 未运行` + 启动入口 | 只影响动作 | 幂等 ensure，不自动重启 | ✅ **INJ-A 实测 4/4 PASS** |
| F5 | 元数据残留（幽灵守护） | `live[]` 空即未运行；`orphans` 计数 | 不显示幽灵 pid | 与 `wsl_status` 同口径 | ✅ 实测 `orphans:1` 时仍报 `running:false` |
| F6 | host web 端口被占 | 启动即失败（bind 诊断） | 整个 GUI | 平台层，无降级但响亮 | ❓ 本轮未做（占 8971 的成本权衡） |
| F7 | 守护端口被占 | `actualPort`≠`slot`；`notes` | 守护换端口仍可用 | `+1` 重试 | ✅ `daemon.ts:589-601`；实测 `notes` 会说明「未复用、未打扰」他人槽位 |
| F8 | 3 个端口全被占 | `throw`… ⇒ **503 / E_UNAVAILABLE** | 只影响守护动作 | 动作条可读错误 | ★✅ 状态码从 500 改 **503**（`explorer.ts:502-503,373,566`）；真宿主全占场景 ❓ 未复现 |
| F9 | API 403（Origin 缺失/异源/异端口/Sec-Fetch-Site） | 403 + 文案，且在方法执行前 | 仅该路由 | **唯一**闸门 | ✅ 真宿主 5/5 + step14 证明副作用被拦；❓ 桌面壳/反代（F26/F27） |
| F10 | API 400（未知方法/坏 JSON/空方法） | 400 + `methods[]` | 仅该请求 | 白名单 | ✅ 真宿主 3/3 |
| F11 | 路径尾斜杠 | 实测 **405 + 非 JSON** | 仅该请求 | client 侧非 JSON ⇒ `protocol` 错误 | ★实测改判：**无 200-HTML 假绿形态** |
| F12 | API 405（PUT 等） | 405 + 动词提示 | 仅该请求 | 明确提示 | ✅ 真宿主 |
| F13 | API 415（POST 非 JSON 类型） | 415 | 仅该请求 | 更严，lead 已裁决不越界 | ✅ 真宿主 |
| F14 | API 500 / 503 | 结构化 `{ok:false,error,code}`；官方层**不退出进程** | 面板错误盒 | 只回 message，不带栈 | ★✅ 映射实测（E_ARG→400、E_UNAVAILABLE→503；`explorer.ts:96-106,502-503,565-566`）。**不一致点**：`openSession` 的 ensure 失败仍用裸 `Error`（`:307`）⇒ 走 500 ⇒ **F14b（S4）** |
| F15 | **webServer 未注入** | **实测：inject 永不回调 ⇒ 无任何日志** | 6 工具与数据面方法表不受影响；面板取数失败 | 只降级 | ★❌ **可诊断性缺口**：原判"会打一行日志"**错误**——那行只在「回调触发了但服务形状不对」时出现（`explorer.ts:601-604`）；`inject` 不回调时**完全静默**（INJ-C1 实测 `stderr=[]`） |
| F16 | **route 重复注册 throw** | 官方 `duplicate exact route` | ~~整体卸载~~ | **lead 加固已落地** | ★✅ **加固生效**（`explorer.ts:597-629`）：INJ-C2（独立两次）/C5（非 duplicate 错误）均无 throw 逃逸、第一次路由仍可 dispose（routes 1→0）；**残留见 F32** |
| F17 | 浏览器离线 | `kind='transport'/'timeout'` + 错误盒 + 重试 | 只影响取数 | 可读、不白屏 | ✅ `client.api.js:130-141`、`client.panel.js:214-236` |
| F18 | 刷新/重挂载 | 重拉快照 + `readSeq` 防乱序 + abort | 正常 | 刷新自愈 | ✅ `client.panel.js:104-150`；INJ-A 刷新步实测新鲜 `快照 16:01:59` |
| F19 | 两个面板实例并存 | 各自独立 state；「快照 \<时间\>」可辨 | 只读 ×2；动作后另一侧陈旧 | 无广播，手动刷新 | ⚠️ `client.panel.js:509-516` |
| F20 | 插件被装载两次 | 同 F16 | 同 F16 | — | ★✅ 加固后**不再打倒插件**（INJ-C2）；❓ 真实可达性 |
| F21 | client chunk 加载失败 | 「面板模块加载失败」兜底 UI | 面板废、host 半活 | 有兜底 | ✅ `client/index.js:196-218` |
| F22 | **读失败时断言 daemon 未运行** | — | — | — | ★✅ **已修**：三态门 `factsVisible`（`client.panel.js:180-181`）+ footer 只在 `!factsVisible` 时写「数据不可用…」（`:420-421`） |
| F23 | 读失败时时间戳陈旧 | — | — | — | ★✅ **已修**：`stamp` error 态写「读取失败 · 最后一次成功 HH:MM:SS」（`:509-516`）+ 显式提示「数字已全部撤下」（`:225-232`） |
| F24 | drift（desktop≠pin） | 状态条 `drift ⚠` + 修 pin | 版本一致性 | 只告警，点击才写 | ✅ `explorer.ts:241-243,410-437` |
| F25 | `fixPin` 返回 `ok:false` | 接口回 `{ok:false,error}` | 仅 pin 修复 | — | ★❌ **仍在**：`client.panel.js:499` 的 `describe` **忽略 result**，恒报「已请求修复 version pin（不自动杀守护）。」⇒ 失败也显示成功语气 |
| F26 | 反代/代理 ⇒ Host≠Origin | 403 | 面板全废 | 无 | ❌ 未覆盖；❓ 未复核 |
| F27 | 桌面壳（`file://`+IPC） | — | 不在 P0 目标面 | **不得**放宽 web 面闸门 | ❓ 未复核（lead 裁决口径） |
| F28 | 非 loopback 下 clipboard 不可用 | 可读错误 | 仅复制 | 显式 reject | ✅ `client.panel.js:324-332` |
| F29 | 收藏路径 UNC 读失败 | 回落 `cwd` 一条 | 少一条路径 | 有回落但分不清「读失败/真只有 1 条」 | ⚠️ `explorer.ts:167-171` |
| F30 | `slot`≠`port` 只显示 slot | 状态条**已同时显示 `:port`**（实测 `slot 8972 · :8972`） | 误导面收窄 | 原始 snapshot 自查 | ★⚠️→✅ `client.panel.js:447` |
| **F31** | 状态目录 `launch-stderr.log` **0644**（其余 0600） | `ls -la`（11:46:38 实测） | 仅该文件可被同机他人读 | 无 | ❓ 内容是否含敏感串**未核实**（我只看了权限）；lead 归 P1（`chmod 600`），P0 不改 |
| **F32** | **同一次 `registerExplorer` 内 inject 二次触发 ⇒ 首次路由 disposer 被置空 ⇒ 路由残留** | INJ-C3 实测 `before=1 / after dispose=1` | 卸载/HMR 后路由不释放（仍持旧闭包） | — | ★❌ **未覆盖（新发现，实测）**：`explorer.ts:608-620` 的 catch 里 `removeRoute = null` 抹掉了同一次调用内**先前成功注册**的 disposer。建议用局部 `registeredHere` 标志区分 |
| **F33** | **`snapshot.daemon = live[0]` 把他人槽位的守护当作本插件目标** | 实测 `snapshot.daemon={slot:8932,pid:909039}` 而 `configured=8972`；落地 `notes` 明说「未复用、未打扰」 | **显示层**误导：状态条会报别的槽位的 pid/port/version | 无（显示层未区分）；daemon-client 行为层已正确 | ★❌ **显示层未覆盖（新发现，实测）**；验证侧缓解 = INJ-A 的 `configured`+`slot` 前置断言。P0 不改（`src/` 冻结），记 P1 |
| **F34** | **初次加载（从未失败）时状态条宣称「读取失败后已撤下」** | 面板打开即快照：同时出现「正在读取…」与「数据不可用：读取失败后已撤下…」，随后同一请求 200 | 短暂误报（接口慢/偶发超时更明显） | 无 | ★❌ **未覆盖（新发现，实测）**：条件 `!factsVisible`（`client.panel.js:420-421`）在首次挂载（`snapshot===null`）即命中；应收紧为 `status==='error'`。见 [out-A-01c-initial-load-false-claim.json](./out-A-01c-initial-load-false-claim.json) |

---

## 4. 单点故障清单（含覆盖状态）

| # | 单点 | 一旦失效 | 覆盖 |
|---|---|---|---|
| SP1 | `/remote-wsl/api` 的 `isSameOrigin`（**唯一**闸门） | 面板全部数据与动作 | ✅ 在（`explorer.ts:460-475,520-523`）；真宿主 5/5 + step14；❓ 桌面壳/反代 |
| SP2 | `webServer.register` 幂等性 | 双装载 | ★✅ **加固已落地**（`explorer.ts:597-629`；INJ-C2/C5 PASS）；残留见 **F32** |
| SP3 | `daemonSnapshot()` 是 daemon 段唯一真相源，`snapshot()` 主体无 try/catch | 它一抛 ⇒ **整张面板 500** | ⚠️ 无分段容错（`explorer.ts:218`） |
| SP4 | client bundle 加载 | 面板全废（host 半活） | ✅ 兜底 UI（`client/index.js:196-218`） |
| SP5 | `listDistros()` | 树空 ⇒ 空态 | ✅（`client.panel.js:245`） |
| SP6 | WSL 网络模式 | 原判 mirrored **实测纠正为 `nat`** | ✅ 见 [out-00-prep-findings.txt](./out-00-prep-findings.txt) F-1 |
| SP7 | `removeRoute` 的 dispose 链 | 注册失败/二次触发 ⇒ 无主路由 | ★❌ **F32 实测命中** |
| SP8 | 状态条不区分「未确认」与「未运行」 | 按假状态行动 | ★✅ **已修**（F22）；残留 **F34**（加载态即宣称失败） |

---

## 5. 未复核项（**禁止当通过**）

1. **F27 桌面壳 / F26 反代**：`Origin` 的真实形态（`file://`+IPC 是否带 Origin；反代下 Host≠Origin）——纪律禁止重启活宿主，**无可接受取证手段**，按 lead 裁决记 ❓。
2. **F16/F20 的真实 Cordis 后果**：桩证明「实现不抛」，**证明不了**真实 Cordis 对 inject 回调抛错/重放的处置；HMR 是否重放 inject（F32 的触发前提）未复核。
3. **同一 host 内双装载是否可达**（bundle 重复是否被去重）——`--patch` 造的场景不代表用户手改 profile 的真实分布。
4. **F6**：占住 8971 时"响亮失败"的确切形态（退出码/stderr 文案）——本轮未做。
5. **F8 全占场景**：503 映射未在真宿主复现（未占 8972–8974 三连）；E_UNAVAILABLE 路径在 INJ-B′ 覆盖。
6. **INJ-B step 13**：HTTP/1.0 无 Host 实测为"连接被关闭、无状态行" ⇒ UNKNOWN（"未放行"成立，形态不是 403）。
7. **F31**：`launch-stderr.log`(0644) 的**内容**是否含敏感串——只看了权限。
8. **凭据泄漏**只有关键字粗筛（`out-B-15`）。
9. **主题 light/dark 错误盒对比度**：属可用性，归 task-5。
10. **F34 的窗口长度**未量化。

---

## 6. 越界披露 与 自我更正（主动列出，未做无痕修改）

**越界（1 处，已定性）**：为做 capture，我的脚本曾调用 `../revision.ps1 -Mode Preview`，而**它的 `OutDir` 默认是 task-4 的目录** ⇒ **我覆盖了 p0-verify 的 `REVISION.preview.txt` 一次**（mtime 15:49:50）。已核实**信息中性**：p0-verify 的 `REVISION.txt`（15:45:24 冻结）与被覆盖后的 preview **锚点段逐字节相同**（14 行，`-eq` 比较 True）。**脚本已改为只读引用**（复制其内容 + 自算 `REVISION-observed.txt`），不再写他人目录；`REVISION.txt` 我从未写（仍 15:45:24 / 2650 B）。
**另**：我曾把「`dsh` CLI 与 `@deepseek-ai/*` 消失」上报为"包被误删 ⇒ 跨组阻断"。lead 用实测更正：那是**他 11:45 的定向回滚**（`client-contract` 11:22 误装的副作用）**叠加我用错 CLI 语法**（`--patch` 必须在 app args 之前；`dsh web` 里的 `web` 是 profile 名）。**我撤回原定性**：环境**没有**阻断，`T4` 的 CLI 路径本来就能用。

**自我更正（5 处，都是我自己脚本/断言的错，不是实现的错）**：
1. **时间戳笔误**：产物里写过"11:52/11:5x"，按 mtime 改为 **11:42:41 / 11:46:38**（时间戳是锚点的一部分）。
2. **`$pid` 是 PowerShell 只读自动变量** ⇒ 脚本一启动就抛「无法覆盖变量 PID」（p0-verify 踩过同一个坑）。
3. **`$out` 与 `$Out` 在 PowerShell 是同一个变量**（大小写不敏感）⇒ 局部赋值覆盖参数，`Set-Content` 把整段 probe 输出当路径抛 `IOException`，害得**故意红测试 exit 1 而非 3**。修好后：`-ExpectedSlot 8912` → **exit 3** 且 `statusHasConfigured:false`（[out-A-01b-slot-precondition.json](./out-A-01b-slot-precondition.json)）。
4. **断言假红**：`no-stale-pid` 曾因**我自己的对比元数据**（`roundTrip.before` 里的 914091）判红；收窄扫描面到被观测字段（`text`/`statusBarText`/`buttons`）后 **PASS**。
5. **原判 F15 写错**：曾断言"webServer 未注入会打一行日志"；INJ-C1 实测 `stderr=[]` ⇒ 改为「**静默**缺席（可诊断性缺口）」。

**方法论（lead 要求条目化）**：
> **① 任何 capture/restore 前后比对，都必须先证明这两次落在同一个、且我拥有的槽位上。** 本任务的实现：`wsl_status` 必须自证 `configured=8972` + 若已有守护则 `daemon.slot==8972`，否则 **exit 3 拒跑**；`ensure` 一律显式 `slot`。这条对 T4/T7 同样适用（默认槽位 8731、他人槽位 8932/8982 都真实存在过）。
> **② 断言只许扫"被观测到的字段"**，绝不能把证据文件里的自注元数据算进去（否则自己造红）。
> **③ PowerShell 里 `$pid`/`$host`/`$args`/`$out` 这类名字会咬人**：只读自动变量、大小写不敏感同名变量各是一次真实故障。
> **④ 环境类结论要留可复算证据**（mtime + 逐字节比较），被更正时**撤回原定性**，不改口径硬撑。

---

## 7. 收尾核对（[out-A-99-cleanup.txt](./out-A-99-cleanup.txt)）

| 项 | 结果 |
|---|---|
| 我起的测试宿主（pid 5692） | 已 `Stop-Process`，存活 = False（`job_kill` 只收了 pwsh 包装，宿主进程需单独收 ⇒ 记入方法论） |
| 端口 8971/8972/8973/8974 | **全部 free** |
| 自有守护 | 已 stop（`slot 8972`）；他人槽位（8932/8982）**未触碰** |
| 活宿主 `19387` | pid **47564**，与开工基线一致 ✅ |
| 被验对象锚点 | **13/13 逐字节未变** ✅（全程只读） |
| 浏览器 | 仅用后台页，用完 close（未动用户窗口/前台） |
