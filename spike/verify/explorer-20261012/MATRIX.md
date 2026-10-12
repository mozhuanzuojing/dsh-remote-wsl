# task-4 独立验证矩阵 —— P0「远程资源管理器」（client 半 + host 半）

- **日期**：2026-10-12 ｜ **验证者**：`p0-verify`（独立于 task-1/2/3 的实现者）
- **被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`（`src/*.ts` 7 个冻结集 + `client/**` 新增半）
- **写边界**：本目录 `spike/verify/explorer-20261012/` 是**唯一**写入面；`src/`、`client/`、`package.json`、`docs/` 一律只读。
- **状态**：准备完成（本回合**未**开工验收；task-4 仍被 task-2/task-3 阻塞）

---

## 0. 端口与实例纪律

| 用途 | 端口 | 说明 |
|---|---|---|
| 测试宿主（带插件）web UI | **8931** | 另起 profile `remote-wsl-test-web`，`--no-open` |
| 插件守护槽位（WSL 侧） | **8932** | profile 里覆盖 `daemonPort: 8932`（不占其它槽位 87xx/89xx） |
| 备用（第二守护 / 强制红） | **8933** | 仅在需要时用 |
| 基线宿主（**不带**插件，强制红） | **8934** | profile `remote-wsl-test-web-base` |
| 备用 | 8935–8960 | — |

**绝对禁区**：`19387`（用户正在用的 desktop 宿主 / `pid` 开工时记录，收工必须仍是同一 pid 且存活）、`9910`（proxy）。**禁止**全局 `pkill`/`taskkill`；只按自己记录的 pid 收自己的进程。**禁止**重启用户宿主（会终止当前会话）。

**启动测试宿主的强制前置**：必须清掉从本会话继承的 `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_WEB_URL` / `DSH_SHELL`（否则可能被当成 desktop profile 或贴到活宿主上）。只保留 `DSH_HOME=C:\Users\l\.dsh`。

---

## 1. 五条验收 → 判据 → 原始输出 → 假绿风险 → 反制

> 判据三态：**pass** / **red** / **unknown**。`unknown` 一律**不写成通过**，进报告「未复核项」。

### ① 侧栏出现我们的面板图标（occupant 的 id/order/label 正确）

| 项 | 内容 |
|---|---|
| 判据 | (a) 带插件宿主的 `sidebar.panellist` occupant 集合 = 基线宿主集合 **+1**，新增项 `id='remote-wsl'`、`order=20`、`label` 非空且指向「远程资源管理器」；(b) 基线 occupant 一个都不少（加法，不顶掉 shipped UI） |
| 原始输出 | `out-04-boot-graph.json`、`out-04-index.html`、`out-05-artifact-slots.txt`、`out-06-rail-plugin.json`、`out-06-rail-base.json`、`shot-06-rail-*.png` |
| 假绿风险 | ① 只看「侧栏多了个图标」而没验 id/order/label；② 在**带插件**实例上数图标，把 shipped 的 2 个当成"并排成功"（实例不同、基线不同 ⇒ 不可比）；③ 桌面 profile 的现场（design §1 的 `plugins`/`schedules`）与 web profile 不同，**不得**拿 web 的基线推断 desktop 的并排效果 |
| 反制 | 双实例（8931 带插件 / 8934 基线）同一 profile 结构，只差一个 bundle；occupant 集合做**对称差**，差集必须恰为 `{remote-wsl}`；`order`/`label` 从**注册面**（bundle 里 `sidebar.panellist` 的注册字面量）+ **渲染面**（rail DOM 的 aria/title/顺序）双侧取证。desktop profile 现场标 **未复核** |
| 已知限制 | 本会话 `cordis_inspect_query(client)` **超时**（host 侧正常）。故 **不依赖** Inspect 探针作为主证据，改用「HTTP boot graph + bundle 字面量 + 浏览器 DOM」三条独立取证；若开工后 Inspect 可用，作为**追加**证据 |

### ② 点图标切到 `main` 的 `remote-wsl` 面板，树渲染

| 项 | 内容 |
|---|---|
| 判据 | (a) 点击 rail 图标后，`main` 槽的 key 变为 `remote-wsl`（`layout.selectPanel('remote-wsl')` 生效）；(b) 面板本体渲染出**非空**树：≥1 个 distro 行 + 配置的收藏路径行；(c) 无未捕获异常（console 无 error） |
| 原始输出 | `out-06-panel-open.json`、`out-06-panel-open.png`、`out-06-console.txt`、`out-05-artifact-slots.txt`（`main` key 注册字面量） |
| 假绿风险 | ① 只截个图就判"渲染了"（图里有字 ≠ 树来自数据）；② 点的是 shipped 的图标（`plugins`）而不是我们的；③ 面板渲染了但 `main` key 不是 `remote-wsl`（挂错槽） |
| 反制 | 断言点击前后 `aria-pressed/aria-current` 的**归属变化**，且点击目标的 aria/title 命中我们的 label；树行必须与 ② 的 snapshot 数据对得上（与第 ③ 条同一份取证）；浏览器 console 消息单独落盘（`types=error`） |

### ③ 树上每个数字与 `wsl_status` 输出**逐项一致**（同源，不许两套数）—— **最可能假绿**

| 项 | 内容 |
|---|---|
| 判据 | 可比对项**全部**逐一相等，且集合类项**对称差为空**：distro 集合、daemon `pid/port/version`、daemon `keys`（key 名 + session，含计数）、`drift`（drifted/desktop/pin）、`webHosts` 端口集合。**另**：不能有"面板有、status 无"或反之的孤立数字（未被映射的面板数字必须显式列为 unknown） |
| 原始输出 | `out-07-panel-extract-light.json`、`out-09-status-before.txt`、`out-10-diff-panel-vs-status.json`、`out-12-forced-red-diff.json` |
| 假绿风险（本条的四个具体陷阱） | ① **同源假绿**：两条路径分别算数，恰好今天相等 → 判"一致"。→ 必须加"改一处真相源，面板跟着变"的**联动**验证（见强制红 R3）；② **子集假绿**：只比对 distro 名，漏掉 pid/keys/drift（设计 §1 的现场就有 `● daemon 8895·v0.2.0-rc.2` 与 `keys 2`）→ 用**映射表**逐项列，未映射项显式 unknown；③ **空集假绿**：两侧都是 `keys 0` / `webHosts (none)`，0==0 判一致 → 计数项必须附「非空样本」或联动证据，否则标 unknown；④ **文本包含假绿**：用 `-match`/`Contains` 判"面板里有这个数" → 必须做**对称差**与**逐项值相等**，不是包含 |
| 反制 | `diff-panel-vs-status.ps1`：映射表驱动、三态输出、集合做对称差、退出码区分 0/1（红）/3（不可比）；比较器**先自测**（合成一致→0、换掉一个 distro→1、改 pid→1），证明有区分力；面板 DOM 抽取另用 rawText 正则**独立复核**（抽取层与比较层不共享代码） |
| 联动（若时间允许） | 停掉 8932 守护 → 面板 daemon 段必须变（pid 消失/变为 not running）→ 再起 → 恢复。这是"面板数字不是硬编码"的端到端证据；做不到就写 unknown |

### ④ 主题 light/dark 各一次正常（token 双份）

| 项 | 内容 |
|---|---|
| 判据 | (a) light 与 dark 两次采样的 panel 计算样式**可区分**（`colorScheme` 或解析后的背景/前景色不同）；(b) 面板显式使用的每个 `--dsw-*` token 在**两种模式**下都有非空解析值；(c) 两模式截图均存在且非空 |
| 原始输出 | `out-08-theme-light.json`、`out-08-theme-dark.json`、`shot-08-panel-light.png`、`shot-08-panel-dark.png` |
| 假绿风险 | ① 只在当前主题截一张图就判"双份正常"；② 只看 token *名字*存在，不看**解析值**（dark 下未定义会静默回退）；③ 主题切换没生效（两次采样其实同色） |
| 反制 | 两次采样必须**成对**且断言可区分；token 取值用 `getComputedStyle(el).getPropertyValue(name).trim() !== ''` 实测，而不是读 `listTokens` 的清单；若找不到主题切换入口 → unknown（不算通过）。强制红 R4：注入一份把某 token 在两种模式下钉成同值的样式，断言必须变红 |

### ⑤ 关闭/切换面板**不杀守护**（前后对比守护 pid/端口/keys）

| 项 | 内容 |
|---|---|
| 判据 | 以下事实在「面板打开 → 关闭/切走 → 切回」前后**完全不变**：`pgrep` 得到的守护 pid、`wsl_daemon status` 的 `pid/port/version`、keys 集合（key+session）与计数、8932 端口监听状态。`runtimePid/turns` 变化允许，但必须记录并解释 |
| 原始输出 | `out-11-daemon-before.json`、`out-11-mid-close.json`、`out-11-daemon-after.json`、`out-11-daemon-invariance.json`、`out-11-wsl-pgrep-*.txt` |
| 假绿风险 | ① 只比 pid 不比 keys；② 根本没守护在跑，`not running` == `not running` 判"没杀"（空集假绿）；③ 把 `dispose` 语义（关面板≠停服务）与"进程还活着"混为一谈；④ 关闭动作用的是**非本方槽位**的守护 |
| 反制 | **前置条件**：开工必须先在自己的 8932 槽位起一个真守护（`wsl_daemon start`），并断言 `daemon: pid=...` 非空才进入本条；比较器三态 + 自测；强制红 R5：主动 `wsl_daemon stop`（只停自己 8932），断言比较器必须变红，再恢复 |

---

## 2. 强制红（区分力证明，逐条记录）

| 编号 | 手法 | 必须变红的断言 | 是否需要改被验对象 |
|---|---|---|---|
| **R1** | 比较器自测：合成「一致 / 换掉一个 distro / 改 pid」三组输入 | `diff-panel-vs-status.ps1` 的退出码 0/1/1 | 否 |
| **R2** | 在**不带插件**的 8934 基线上跑同一套 rail/panel 断言 | ①②（rail 少一项、panel 打不开、树为空） | 否 |
| **R3** | 注入 init script 扰动 `explorer.snapshot` 的 distro 列表（best-effort；WS/fetch 层拦截），失败则退化为「把抽取出的面板 JSON 掉一个 distro + 抽取层用 rawText 独立复核」 | ③（差集非空） | 否（仅页面内注入） |
| **R4** | 页面内注入样式，把某 token 在 light/dark 钉成同值 | ④ | 否 |
| **R5** | 主动停自己 8932 守护 | ⑤（pid/keys 变化） | 否（只动自己的守护进程） |

> 纪律：**绝不**为了造红而改 `src/`、`client/`、`package.json`、`docs/`。R3 的降级方案明确写在报告里，并把「未能做端到端扰动」列入未复核项。

---

## 3. Revision 锚点

- 锚点 = `src/*.ts`（7 个）+ `client/**`（全部文件）的 SHA256 + size。
- `revision.ps1 -Mode Preview|Write|Check`；`Write` 开工落 `REVISION.txt`（`client/**` 为空则**拒绝写入**并 exit 2），`Check` 收尾复算，不同即打印差异 + **exit 1**，报告判「验证无效」。
- 另记**非锚点 advisory**（`package.json`、`cordis.patch.yml`、`docs/*.md`）：漂移不直接判无效，但 exit 3 并要求解释——因为 `package.json` 的 `files`/`dsh.client` 与 `docs/client-contract.md` 会**改变 client 半的打包与契约**，只盯 7 个 ts 会漏。

## 4. 原始输出命名约定

`out-NN-<主题>.<ext>` / `shot-NN-*.png`，NN 见上表；比较器产物一律 `.json` + 人类可读回显；所有 PowerShell 脚本同时落 `.err`。报告 `REPORT-explorer.md`：结论 ≤450 字 + 逐条证据 + **未复核项** + 强制红记录 + 被验对象 revision。

## 6. 准备期发现（2026-10-12 11:10–11:30，本回合实测；开工前必须知道）

1. **`src/explorer.ts` 已出现（T2 在写）**：`src/*.ts` 由 7 个变 8 个；`src/explorer.ts` 在 3 分钟内从 21054 → 26352 字节。⇒ 我**现在不冻结**；`revision.ps1` 已改为：原冻结 7 个必须在场（缺失即拒写 exit 2），额外 `src/*.ts` **一并纳入锚点**并大声提示「冻结表需 lead 确认更新」（design §8.2 要求 src/ 冻结集不动 —— 需要 lead 裁决：新增 host 半文件算不算"动冻结集"）。
2. **`wsl_status` 输出面在变**：新增 `daemon idle/linger/queue: … lingerMs=600000`、`daemon ports: configured=<slot>(+3 回退) actual=(未运行)`，state dir 改为"**按槽位** `daemon.<slot>.json` / `daemon.<slot>.token`"，且工具尾部多一行 `remote-wsl: 宿主退出…`。⇒ 比较器加了 **`statusUnmappedLines`（防漏项清单）**：`wsl_status` 里任何没被映射的行都会打印出来 —— 面板若显示同名字段而没进比对，就是漏项，必须补映射或记 unknown。
3. **本会话 `cordis_inspect_query(client)` 超时**（host 侧正常），连试 3 次（`sidebar.panellist` / `main` / `Theme.listTokens`）全部 10s timeout。⇒ 已按「boot graph + bundle 字面量 + DOM」三条独立取证设计；Inspect 可用时作为**追加**证据。
4. **测试宿主可以另起，且 compose 已验证通过**：新建 profile `remote-wsl-test-web`（bundles = `dsh-base` + `dsh-web-app` + `dsh-remote-wsl`，junction 到 vendor），`dsh --profile remote-wsl-test-web --dump-config` **exit 0**（1266 行），且我的覆盖生效：`- id: remote-wsl … config: {distro: debian-u8-1, dshVersion: '', daemonPort: 8932}`（第 1261–1266 行，注释显示 *patched by …\cordis.patch.yml*）。`@deepseek-ai/dsh-host-webserver` + `dsh-web-app` 在场 ⇒ `webServer` 服务存在（T2 的 `explorer.*` HTTP 路由届时会注册）。
5. **probe 夹具已实证**：`node probe-ground-truth.ts --mode status --port 8932` 能跑通，`daemon ports: configured=8932` 证明端口段被尊重；stub 里会打印 `remote-wsl(explorer): webServer 服务不可用 ⇒ explorer.* 的 HTTP 路由未注册（方法表仍可用）` ⇒ **实盘测试宿主里 explorer 有 HTTP 路由**，③ 的真相源可以三方比对（面板 DOM vs `wsl_status` vs `explorer.snapshot` JSON），比设计要求的"两侧"更严。
6. **准备期自查抓出的两个自身缺陷（已修，且都写进自测）**：
   - **比较器假绿**：面板侧"抽不到"（null）会被 `@($null | ForEach-Object …)` + `Sort-Object` 静默吞成空集，从而与 status 的空集判成 MATCH ⇒ 实盘冒烟里真的返回了 **exit 0**（应当 3）。已加 `As-Arr()`（区分「不可用 null/全 null」与「真空集 `@()`」）并把该场景固化为**自测案例 D（期望 exit 3，绝不能 0）**。
   - **`$pid` 是 PowerShell 只读自动变量**：`daemon-invariance.ps1` 自测脚本块 `param($pid,…)` 直接报错。已改名 `$daemonPid`，自测已 PASS。
   - 另修：`Parse-Status` 现在只解析「最后一个 `####` 标记之后」的工具输出段（原先把 probe 前言当 status 行）；probe 新增 `--out <file>` 落**干净**的工具输出。
7. **准备期自测结果**：`diff-panel-vs-status -SelfTest` 4/4 PASS（0/1/1/3）；`daemon-invariance -SelfTest` 2/2 PASS（0/1）；`revision.ps1 -Mode Preview` exit 0（8 src + 0 client，拒绝 Write 属预期）；实盘冒烟（面板全 null + 真实 `wsl_status`）exit 3 ✓；5 个脚本 parse OK。
8. **准备期写入面（已声明）**：除本目录外，只新建了 `C:\Users\l\.dsh\profiles\remote-wsl-test-web\`（package.json / cordis.yml / cordis.patch.yml / node_modules\dsh-remote-wsl junction）。**未改任何既有 profile**（`desktop`/`web`/`headless`/`acp`/`remote-wsl-test` 一律只读）；日志见 `out-03-*`。
9. **活宿主基线**：`127.0.0.1:19387` → pid **47564**（已记入 `out-01-livehost-baseline.txt`）。截至准备结束未变。

## 7. 待 lead 裁决的问题（阻塞开工，见 RUNBOOK §1）

- Q1：`src/*.ts` 8 个（多 `src/explorer.ts`）是否更新冻结表？锚点是否改为"全部 src/*.ts + client/**"？
- Q2：client 半的目录名与注册字段以 `docs/client-contract.md` 为准？`client/**` 是否就是全部需冻结的新增面（还有别的目录吗）？
- Q3：① 的基线口径 —— 用我自建的 web 测试实例（带/不带插件）做加法比对可以吗？（desktop 现场无法在不重启用户宿主的前提下复现，会记未复核）
- Q4：设计 §6-③（点"打开"起 `cwd=` WSL 路径的会话）是否纳入我的 5 条？（现按**不纳入**处理）
- Q5：端口 8931（宿主）/8932（我的守护）/8934（基线宿主）占用是否与其它槽位冲突？

## 8. 未复核项模板（开工后逐条填，禁止留空）

- Inspect client 探针（`Slots.listSubTree`）本会话超时 ⇒ occupant 的**注册面**证据来源改为 bundle 字面量；若 T1 的 `client-contract.md` 给了权威形状，用它复核。
- desktop profile 的侧栏现场（`plugins`/`schedules` 并排）——web 测试实例无法代表。
- 设计 §6 的「点"打开"能起 `cwd=` WSL 路径的会话」改为 lead 2026-10-12 Q4 的新语义 ⇒ 见 §9（已纳入）。
- `webHosts` 行在 `wsl_status` 里的真实文本格式（当前只有 `(none)` 样本）⇒ 实盘若与解析器不符，记 unknown。

---

## 9. 追加验收⑥（lead 2026-10-12 Q4 裁决，**已纳入范围**）

`explorer.openSession` **默认不烧模型调用**：已有物化会话 → 附上并回报 sessionId；没有 → `{sessionId:null, created:false, note:'首次 wsl_agent 轮次才会物化'}`，**且 UI 必须显示该状态**。`warm:true` 真起一轮的分支存在但 **P0 UI 不暴露**。

| 项 | 内容 |
|---|---|
| 判据 | ① **无副作用**：调用前后 `resident runtimes` 不变、守护 `keys` 集合与计数不变（**不许新增 key**）、`runtimePid` 不变、守护 pid/端口不变、WSL 侧不出现新的 sdk/profile 进程；② 返回值形状正确（无物化会话时 `sessionId=null, created=false`，note 语义 = "首次发消息才物化"）；③ **界面明确显示**"远端会话将在首次发消息时建立"（DOM 文本取证）；④ P0 UI **不暴露** `warm` 开关 |
| 原始输出 | `out-30-opensession-before.json`、`out-30-opensession-return.json`、`out-30-opensession-after.json`、`out-30-opensession-nosideeffect.json`、`out-31-opensession-ui.json`、`shot-31-opensession-ui.png` |
| 假绿风险 | ① 只看返回值不看副作用（真烧了一轮看不出来）；② 两侧 keys 都是 0 ⇒ 空集假绿（须用 R5 已证的"停守护会让这些面变红"作对照）；③ UI 文案只凭截图肉眼；④ 把 `warm:true` 的 API 存在当成"UI 暴露了" |
| 反制 | 用**差值**判：before/after 的 `resident runtimes` 行、daemon `keys`/`keys=N`、`runtimePid`、pid 逐项比对（复用 daemon-invariance 的槽位闸）；UI 状态用 `extract-panel.js` 落 `rawText` 后正则取证；`warm` 暴露面用 DOM 全文本 + 静态字面量双查 |

## 10. 强制红 R6（契约缺件必须**大声失败**，lead 核实结论 #3）

- 手法：把插件包**复制**到 `%TEMP%/rwsl-verify-noclient/`（**不动被验对象**），删掉 `client/index.js`，用 `link:` 起测试 profile（8935）→ 按契约"缺文件 ⇒ 激活失败"，`clientModules` 的 FAILED fiber / boot activation audit 必须**响亮报错**；**不得**出现"图标在但点了没反应"的静默成功。
- 判据：启动输出有明确失败诊断；侧栏**没有**我们的图标（缺件不得半绿）。
- 产物：`out-40-r6-noclient-host.log`、`out-40-r6-noclient-boot.txt`、`out-40-r6-verdict.txt`。

## 11. 槽位作用域纪律（准备期实测发现，开工后必须守）

1. **`wsl_daemon status` / `wsl_status` 报的是"被发现的守护"，不保证是我方槽位**：我停掉自己 8932 后，probe 立刻改报 **8912**（后又出现 **8731**）。**归属措辞（lead 2026-10-12 更正）**：这不是"他人污染"，而是**同队其它槽位 / 属主未确认** —— `8912` 落在 T2（host-explorer）端口段 `8911–8920`，`8731` 是插件默认口（某个测试实例 / `--dump-config` 起的）。⇒ 守护事实一律过闸：
   - 存活判据 = WSL 侧 `pgrep -af 'daemon.ts --port <我方槽位>'`（天然排除其它槽位）；
   - 监听判据 = `ss -ltnp | grep ':8932 '`；
   - probe 报的 pid/port/version **仅当 `slot == 我方槽位`** 才采信，否则 unknown。
   - 已实测：不加闸时"我方守护被杀"会因其它槽位守护顶替而**假绿**；加闸后 R5 正确变红（`out-12-forced-red-daemon.json`，exit 1）。
2. **`wsl_daemon action=start` 的调用不返回**（长命守护持有调用方的 stdout 管道）。**两次独立复现**：Lead 的 `selftest.ts ensure` 赋值捕获挂起（>10 min，人工 kill）+ 我的 `wsl_daemon start` 不返回（被 tool 判超时转后台 `pwsh-1093`）。**共同形态 = 调用方持有的 stdout 管道因长命守护不 EOF；根因仍标"未坐实"**（只写现象+可用做法，不宣称根因）。可用做法：后台起 + 轮询 `ss` 就绪 + 收掉 Windows 侧 probe；**状态一律另起一次独立调用取**。
3. **同发行版里始终可能有其它槽位的守护**（准备期见到 8912、8731，属主未确认）：全量 `pgrep` 会把它们的启停算成我的变化。⇒ 报告必须列 `otherSlotDaemons`（信息项，不判红/绿）并写明"另有 N 个**同队其它槽位**守护（属主未确认）未纳入比对"——**不要**写成环境污染。

## 12. 锚点与冻结（lead Q1/Q2 更新后）

- 锚点 = `src/**/*.ts`（现存 **8**）+ `client/**`（现存 4：`index.js`/`client.api.js`/`client.icon.js`/`client.panel.js`）+ `package.json`。
- `revision.ps1 -Mode Write` **必须显式 `-ConfirmFreeze`**（准备期误跑过一次 Write，已撤销 `REVISION.txt`；现行脚本无该开关直接 exit 2）。
- 契约体检（写在 revision 头部，不参与锚点比对）：`exports["./client"]`、`dsh.client.platform=="web"`、入口 `client/index.js` 在场、`files` 含 `client`。
- **准备期发现一条真实 drift（待 lead/T2 处置）**：`package.json` 的 `files` **不含 `client`**（11:2x 还在，11:4x 已不在）⇒ 打包面漏发 client 半；当前走 `link:` 不受影响，`npm pack`/发布面会缺件。
- 文档漂移清单见同目录 `DOC-DRIFT.md`（lead 要的那份）。

## 13. 准备期自测矩阵（可复核）

| 检查 | 命令 | 结果 |
|---|---|---|
| 后台/无 Zombie 的 ⑤ 工具实盘 | `daemon-invariance.ps1 -Mode Capture/Compare`（真守护） | compare **exit 0**（不变）；停守护后 **exit 1**（R5 红） |
| ③ 解析器认实盘 running 文本 + 槽位闸 | `diff-panel-vs-status.ps1 -Panel … -Status out-20-status-running.txt -ExpectedSlot 8932` | **exit 0**（strong=11）；`-ExpectedSlot 8912` ⇒ **exit 1**（闸有区分力） |
| 比较器区分力 | `diff-panel-vs-status.ps1 -SelfTest` | A/B/C/D = 0/1/1/**3** + E 映射完整性 PASS |
| 守护比较器区分力 + 解析器 | `daemon-invariance.ps1 -SelfTest` | A/B = 0/1 + P 解析器 7/7 PASS |
| 脚本语法 | `[Parser]::ParseFile` ×5 | 全部 parse OK |

## 14. 契约硬事实对验证方案的影响（`docs/client-contract.md`，T1 已交付；已据此改夹具）

| # | 契约事实（含行号） | 对我方案的影响（已改） |
|---|---|---|
| C1 | 静态 client 半**没有** `host.call` / `styles.insert`（§4.1，动态包专属）；取数走 host `ctx.inject(["webServer"])` + `register({kind,path,handler})` + 浏览器**同源 `fetch`**（§4.2，已实测） | **R3 的生效分支是 `fetch`**（WS 分支作废，保留为死代码说明）；③ 增加**第三条真相面**：直接 HTTP 取 route JSON（新增 `capture-snapshot-http.ps1`，先 `-Probe` 探路径再定，不猜）；⑥ 的 `openSession` 也走该 route，可**无 UI 直接**核对返回值与无副作用 |
| C2 | bundle 路由 = combo 形态 `/plugins/??<pkg>/client.js&rev=<rev>`（§1.2/§2.2:84）；`client.<name>.js` 只能按需取（入口里的 `require.async` 触发，§2.3） | `capture-boot-graph.ps1` 改为**入口 + 逐 chunk + 磁盘静态**三路取证：任一处 FOUND 即在场，**只有三处都 MISSING 才判 RED**（否则会把"字面量在 chunk 里"误判成假红）；仅磁盘命中 ⇒ 标未复核 |
| C3 | 缺件 ⇒ **激活失败**，消息固定（§1.3:62-63）：`client bundles not found; run \`pnpm run build\` before launch:` + package + path；聚合为 `ClientPackageCompositionError`，启动总报 `error: dsh: startup failed: 3 required plugins did not activate` | **R6 按这个形状断言**（比"随便有个错误"强得多）：日志必须出现该固定串；且侧栏**不得**出现我们的图标 |
| C4 | 只注册 `panellist`、不注册 `main` 的实测后果（§5:289-292）：图标可点、点击抛 `Uncaught Error: layout.selectPanel: main panel "<id>" is not registered`、UI 不动 | ② 的"错配"判据精确到该异常文本；我还会把它作为"② 不是靠肉眼"的独立信号 |
| C5 | 侧栏 id 与 `main` key **同名是点击期约束**（注册期不查重，§3:197/203） | ① 不能只证"两边都注册了"；必须 ② 点击后断言切到 `main:remote-wsl` |
| C6 | 契约 §7:341 已确认本会话 client Inspect（Slots/Service/Builtin/Theme）**全部 10s 超时**，并给出**替代判据**（在被测实例自己的页面里读 `ctx.slots.entriesOfSlot/entries/spec`），明确标注**不等价** | 与我实测一致。我仍以 **DOM rail + 服务端 bundle** 为主证据；替代判据只在 DOM 不可用时作为降级，并在报告里标"替代、不等价" |
| C7 | 注册走 `ctx.slots.inject(key, cb)`，回调用 `ctx.effect` 包同步注册（§3:178-182）；面板数据是 `fetch` 之后才渲染 | **抽取必须等树就绪**（轮询 `[role=treeitem]`/rawText 出现 distro 名，超时才判 unknown），不能 fetch 完立即抓；已加入 §15 |

## 15. 抽取时序（防"抓太早"假红/假 unknown）

`browser/extract-panel.js` 与 `click-rail-icon.js` 在实盘使用时必须先**等就绪**：
1. 点图标后，轮询 `document.body.innerText` 出现 `debian-u8-1` **或** 出现 `[role="treeitem"]`，最多 10s（每 300ms）；
2. 就绪后再跑抽取；超时则落 `rawText` + `domHints` 并把该项记 **unknown**（绝不写成通过）；
3. 每次抽取都把 `document.body.innerText` 前 4KB 一并落盘（`out-07-*.rawtext.txt`），供"抽取器是否漏读"独立复核。

## 16. 目录归属约定（lead 2026-10-12 裁决：保持现状、互不搬动）

- **根目录归我**（p0-verify）：`REPORT-explorer.md`、`REVISION*.txt`、`out-*`、我自己的 `*.ps1` / `probe-ground-truth.ts` / `browser/**` / `MATRIX.md` / `RUNBOOK.md` / `DOC-DRIFT.md`。
- `reliability/**` → T6 ｜ `stability/**` → T7 ｜ `usability/**` → T5。**我不读改搬这三处的任何文件**；报告里若引用它们（例如交叉印证），只写目录名并注明"非我产物、未复核其结论"。
- 措辞纪律（lead 更正）：`8912`/`8731` 是**同队其它槽位（属主未确认）**，不是环境污染；报告提到时按此写。
- 早于本次措辞更正的原始输出（`out-12-*`、`out-21-*`、`out-22-*`）里仍含旧短语"他人守护/别人的守护"。**canonical 措辞以脚本注释与本节为准**；便宜可重跑的自测产物（`out-00-*`）已按新措辞重生成，需守护在跑的原始输出不做事后改写（保留原始性）。

## 17. T2/T3 新必修项 → 我的挂钩（lead 2026-10-12 追加）

| 义务方 | 必修项 | 我怎么验 / 已有证据 |
|---|---|---|
| T3 | 「停止/重启」要**二次确认** + **aria-label** | ① 面板上任何 stop/restart 控件**不入我的自动化**（⑤ 只做观测，不点它，避免误停）；② 控件必须有 `aria-label`（`extract-panel.js` 的 rail/控件扫描已按 aria-label/title 取值，缺失会落进 `domHints`+`rawText` 供复核）；③ 若存在确认对话框，它属于 P1 语义，本报告只记录"是否存在/是否可绕过"，不作为 P0 判据 |
| T2 | **注册失败不得带下插件** | 已有**正向对照**（准备期实测，probe stub 无 `webServer`）：插件打印 `remote-wsl(explorer): webServer 服务不可用 ⇒ explorer.* 的 HTTP 路由未注册（方法表仍可用）`，随后**照常注册 6 个工具**、`wsl_status` 正常返回 ⇒ 未"带下"插件本体。原始输出：`out-20-daemon-start.txt`、`out-20-status-running.raw.txt`。开工后按 T2 最终实现**复核一次**（若实现改为 throw，则本条转红并单独列证据） |
