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

## 18. T10 预备：两条**刻意语义变更**的判定口径（lead 2026-10-12 预备通知；**尚未 claim T10**）

> 目的：把"更严"判成"正确"，不要当回归；同时不许把"更严"当挡箭牌放过真回归。

### 18.1 F32/F33 —— `snapshot.daemon` 只报配置槽位

- 新语义：`snapshot.daemon` 只看 `cfg.daemonPort`；本槽位无守护 ⇒ **`running:false`，不回落 `live[0]`**；其它槽位进**加法字段 `others[]`**。
- 对照：`wsl_status` 的 `daemon:` 行**仍**走 `daemonStatus()`/`live[0]`（任何槽位）。
- ⇒ **唯一允许不一致的场景**：「配置槽位无守护、别处有守护」。此时正确形态 = `snapshot.running=false` **且** `wsl_status` 报的那个别槽**出现在 `others[]`**；**其余场景仍要求逐项一致**。
- 我的实现（已就位、默认关闭，避免改动已冻结的 T4 结论）：
  - `diff-panel-vs-status.ps1` 新增 `-Snapshot <route JSON>` + `-F33StrictSlot`；判定函数 `Test-F33Scope()`。
  - 判定：`status.daemon.slot == 配置槽` ⇒ 要求 `snapshot.running=true` 且 `snapshot.slot == 配置槽`，否则**红**；
    `status.daemon.slot != 配置槽` ⇒ 要求 `snapshot.running=false` **且** `others[]` 含该槽 ⇒ `f33.snapshot-scope=MATCH`（原来是判红/unknown 的槽位闸改为"已解释的 unknown"，由 `f33.snapshot-scope` 承担强证据）。
  - **自测已覆盖**：case **F**（F33 成立 ⇒ exit 0）、case **G**（snapshot 把别槽当自己报 `running=true` ⇒ **exit 1**）⇒ 该口径本身有区分力。
  - 用法（T10）：`-Panel <抽取> -Status <wsl_status> -Snapshot <out-2x-snapshot-http.json> -ExpectedSlot 8932 -F33StrictSlot`
- 反向风险（必须一起看）：若 T8 顺手把 `wsl_status` 的 daemon 行也改成只报配置槽位，则"唯一允许不一致"的场景消失 ⇒ 一律要求逐项一致；发现这种情况**不是回归**，但要在报告里写明口径已变。

### 18.2 `explorer.daemon({action,slot})` 非配置槽位 ⇒ 400/E_ARG

- 纳入错误码矩阵（T10 逐条跑）：

| 输入 | 期望 | 备注 |
|---|---|---|
| `{action:'ensure'\|'status'\|'stop'\|'restart', slot: <配置槽>}` | 200 | 正常路径 |
| `{action:'ensure', slot: <非配置槽，如 8962>}` | **400 / E_ARG** | 报错文案形如 `slot 8962 不是本插件配置的槽位（8962≠8982）…`；**且不得对该槽位产生副作用**（用 WSL 侧 `ss -ltn :8962` + `pgrep --port 8962` 做阴性对照） |
| `{action:'__bogus__'}` | 400 / E_ARG | 已有实测（T4） |
| 未知 method / 空 method / 原型链 `constructor` | 400 | 已有实测（T4） |
| 非配置槽位的 `slot` 类型错（字符串/负数/超大） | 400 / E_ARG | 边界 |

- 纪律（沿用 F-1 更正）：**真占用必须在 WSL 里占**（NAT，Windows 占端口不挡 WSL bind）；本条的"无副作用"判据只看 **WSL 侧** `ss`/`pgrep`。

### 18.3 T10 开工时的增量（等 go）

1. **先重冻结**：锚点集不变（`src/**` 8 + `client/**` 4 + `package.json`），但内容会变 ⇒ `revision.ps1 -Mode Write -ConfirmFreeze`。
2. A 组回归：①②⑤ + **③ 差集必须重跑**（③ 现在多了 `-Snapshot`/`-F33StrictSlot` 两个口径）。
3. 7 条新缺陷断言逐条（F32/F33/F15/F14b/F31/F34/F25）+ T9 的 F35(RTL)/F36(主行动零反馈)。
4. **至少两条故意红**（沿用 R3 页面内 fetch 扰动 + R5 停守护；F33 建议再加一条：把 `others[]` 掏空让 `f33.snapshot-scope` 变红）。
5. 收尾清理 + `-Mode Check`。

## 19. T14 预备：A2 / A6 / A3 的断言设计（lead 2026-10-12 预备通知；**尚未 claim**）

> 先读 `docs/prior-art-dsh-wsl.md`（§2 官方约定 / §3 采纳清单，已读）与 §4 刻意分歧。

### 19.1 A2 `dsh.compatibility.dshReleases` —— **schema 佐证不可得（已实测，先说清）**

- **先例形状（权威、可复现，无需安装）**：`web_fetch https://registry.npmjs.org/dsh-wsl-workspace/0.7.7` ⇒
  `"dsh":{"compatibility":{"dshReleases":{"0.1.0-rc.7":"compatible",…,"0.2.0-rc.2":"compatible"}}}`（11 个版本，值都是 `"compatible"`）。
- **但 `--dump-config-schema` 与合法取值无关**（实测，本目录 `T14-PREP-dump-config-schema.txt`，873KB）：
  `compatibility` **0 次**、`dshReleases` **0 次**；唯三处 `compat` 是别的插件 config 里的 `{supportsStore:…}`，与包清单字段无关。
  该 dump 的标题即 *"Cordis configuration for profile …"* —— 它只描述**profile 的 patch/entry 列表**，不描述 `package.json` 的 `dsh` 字段。
- **安装树里也没有这个字符串**：对 `resources\**` 做原始字节扫描，`dshReleases` 与 `dsh.compatibility` 均**未命中** ⇒ 该字段在本构建里既不校验、也无从"用 schema 佐证"。
- ⇒ **T14 对 A2 的断言改为**（逐条可红）：
  1. 形状合法：`dsh.compatibility.dshReleases` 是 **string→string** 的对象（对齐先例形状）；
  2. **只许声明实测过的版本**：键集合 ⊆ 本项目本次真正跑过的 DSH 版本（当前 = `0.2.0-rc.2`，来源 `runtime.json` + `wsl_status` 的 `desktop dsh version`）；**出现未实测版本即判红**；
  3. 值域：只允许 `"compatible"`（不写 `unknown`/空值/占位符）；
  4. 无副作用：加了该字段后 `--dump-config` 仍 exit 0、插件仍加载（`wsl_status` 6 工具照常注册）；
  5. **诚实标注**：本字段**不阻断，也无本地校验**（见上）⇒ 报告里写"声明性、无 schema 背书"，不得写成"已被宿主校验通过"。
- 已留原始输出：`T14-PREP-dump-config-schema.txt`（含 `compatibility/dshReleases` 命中 0 的事实）。

### 19.2 A6 新工具 `wsl_path` —— 重点：**注入负例必须被当字面量**

| # | 输入（注入探针） | 期望 | 判红条件 |
|---|---|---|---|
| 1 | `/mnt/c/Users/l/$(id).txt` | 输出里 `$(id)` **原样保留**（可逆） | 出现 `uid=`/`gid=`/用户名等**命令执行痕迹** |
| 2 | 反引号 `` `/mnt/c/`id`.txt `` | 同上 | 出现命令替换结果 |
| 3 | `'`/`"` 混合：`/mnt/c/a'b"c.txt` | 字面量往返一致 | 引号被吞/被解释 |
| 4 | `;`/`|`/`&&`/换行：`/mnt/c/a;id`、`/mnt/c/a|id`、`a\nb` | 字面量 | 出现第二条命令的痕迹 |
| 5 | 空格与中文：`/mnt/c/我的 目录/x` | 字面量；全程用**参数数组**而非拼 shell 串 | 词分割错误/编码损坏 |
| 6 | `..` 与越界：`/mnt/c/../../etc/passwd` | 按字面转换（**不解析、不读文件**） | 试图读文件（如出现 `/etc/passwd` 内容） |
| 7 | `\\wsl.localhost\debian-u8-1\home\g\x` ↔ `/home/g/x` | 互转往返一致（`-a/-u/-w` 语义） | 往返不稳定 |
| 8 | 空串 / 非字符串 / 超长（4KB+） | 明确 4xx/工具错误，**不 panic、不执行** | 崩溃/静默截断 |
- **副作用阴性对照（每条注入用例都跑）**：WSL 侧 `pgrep -af 'id$'` 无新增、`/tmp` 无我的标记文件、探针目录无新文件、`wsl_path` 不启守护（`daemon.<slot>.json` mtime 不变）。
- **正向对照**：`wslpath` 直调（`wsl.exe -d … -- wslpath -a '/mnt/c/…'`）给出同一结果 ⇒ 证明断言读的是**真行为**而不是硬编码。
- 工具名/参数形状以 T12/T13 落地为准（若参数名不同，按实现改探针，不改判据）。

### 19.3 A3 面板目录浏览器四能力（DOM 可观测判据）

| # | 能力 | 判据（DOM/行为） | 能红的形式 |
|---|---|---|---|
| 1 | 快捷 chips | 面板内存在 ≥3 个 chip，文案含 `Home`/`/`/`/mnt`（或中英双语），点击后路径输入/面包屑跳到该处 | 把 chips 容器删掉/改名 ⇒ 断言红 |
| 2 | 常显路径输入 | 输入框**始终可见**（不依赖 hover/展开），回车跳转生效（面包屑随之变化） | 需要 hover 才出现 ⇒ 红 |
| 3 | 从 `/` 起的完整面包屑 | 面包屑首段是 `/`，逐级可点，末段 = 当前目录；深路径不省略 | 只显示末两段/首段不是 `/` ⇒ 红 |
| 4 | 隐藏文件开关 | 有开关控件（aria-label 含"隐藏/."），切换后 `.` 开头条目出现/消失 | 无控件或切换后列表不变 ⇒ 红 |
- 回归叠加：**F34**（首挂载只有读取态，无"已撤下/失败"）、**F35**（新元素里含路径的也要 `direction:ltr`+`unicode-bidi:plaintext`）、**`others[]` 只读区零按钮**（该区不得有任何可点动作按钮）、**二次确认**（停止/重启仍需确认，不因新 UI 退化）、**aria**（新控件都要有 aria-label）、**light/dark**、**③ 差集**（按既定 F33 口径，`-Snapshot` + `-F33StrictSlot`）。

### 19.4 T14 开工增量（等正式 GO）

1. 重冻结（新锚点集；`src/**` 8 + `client/**` 4 + `package.json`，内容会变）。
2. A2/A6/A3 逐条断言 → 回归（19.3 末段清单）→ **故意红 ≥2 条**（建议：A6 注入用例把实现换成 shell 拼接；A3 把 chips/面包屑容器改名）→ 收尾清理 + 枚举可见窗口 + `-Mode Check`。
3. 纪律：端口 8931–8960；**不跑 npm/pnpm install**（A2 的形状证据走 registry 只读抓取）；`Start-Process` 必带 `-WindowStyle Hidden`；不碰 19387。

### 19.5 新增 host 只读方法 `explorer.listDir`（lead 2026-10-12 补充；A3 的前置）

**为什么必须有它**：T13 实测官方 `directoryPicker.list` 在本宿主恒为 **`native`**（loopback + win32）⇒ `ctx.workspaces.listDirectory` 与先例的浏览路线**在本机不可用**；A3 的四能力需要自建只读列目录。

- **契约**：`explorer.listDir({path})` → `{path, distro, entries:[{name, kind:'dir'|'file'|'other', hidden:boolean}]}`；**一次返回全部条目（含隐藏）**，隐藏开关由 client 侧过滤。
- 依赖：T13 已获授权改 `src/explorer.ts`（**仅此一个 src 文件**）⇒ 重冻结必须在 T12/T13 都 complete **之后**做。

| # | 断言 | 判据（能红的形式） |
|---|---|---|
| ① | **白名单 + 传输面不松** | `GET /remote-wsl/api` 的 `methods[]` 必须含 `explorer.listDir`（缺 ⇒ 红）；伪造/缺失 Origin ⇒ **403 且未执行**（用 `listDir` 自身 + WSL 侧阴性对照）；非 POST ⇒ 405、非 JSON content-type ⇒ 415；响应/错误**不含 token/凭据**（复用 `probe-transport.ps1`，用真实 token 做针） |
| ② | **路径穿越/非法形态** | `../`、`/home/g/../../etc`、相对路径 `foo`、空串 `''`、含 NUL、Windows 风格 `C:\`、UNC `\\wsl.localhost\…` ⇒ 全部 **400/E_ARG**、**不得返回任何条目**；并**不得读到发行版之外**（返回体里不得出现越界路径条目；用**正向对照**证明合法路径上确实能列出条目，排除"接口本来就坏"） |
| ③ | **路径不存在** | 可读错误（**body 含请求的那个 path**），**不是 500**、不抛栈 |
| ④ | **发行版不存在** | 用**自建副本 profile** 把 `distro` 改成不存在的名字（**绝不停 `debian-u8-1`**）⇒ 可读错误；且**未启动任何发行版**（`wsl -l -v` 的 STATE 前后一致、无新 WSL 进程） |
| ⑤ | **零副作用** | 调用前后 `daemon-invariance` facts 全 MATCH（pid/端口/version/keys/pgrepMine/监听）、`daemon.<slot>.json` mtime 不变、无新 WSL 进程、`/tmp` 无新文件 |
| ⑥ | **确定性顺序** | 同一路径连续两次 ⇒ 条目顺序**逐字相同**（并记录观察到的排序规则；若实现未定义排序则只断言"稳定"，不断言具体规则） |
- **故意红（不碰被验对象）**：照 T10 R6 的做法，把插件包**复制**到 `%TEMP%` 副本、在副本里去掉 `..` 校验、用副本起测试实例 ⇒ **② 必须变红**；删副本后复绿（原对象全程只读）。若时间不允许副本实例，则退化为"合成响应喂同一断言函数"的桩级对照，并在报告里注明降级。
- **A3 的桩/真机分界（lead 强调）**：client-panel 会用 fetch 层桩先验四能力 DOM —— **我复验必须用真 host 再跑一遍**，桩级证据**不算交付判据**；若某条无法在不打扰用户的前提下构造（例如"发行版未运行"），**如实记未复核**，不写成通过。

## 20. T21 预备：F-38 + 字段透传的判据（lead 2026-10-12 预备通知；**尚未 claim、尚未冻结**）

> **冻结纪律**：`client-panel` 正在 `src/explorer.ts` 上修"双前缀"一行 ⇒ **必须等正式 GO 再冻结**。
> 预备时看到的 `src/explorer.ts` 哈希 `27887933a1bb…` 是**改动前**的值，不作锚点。

### 20.1 失败响应口径（lead 裁决，照此写死；**不得**断言 `result.mode===null`）

- **本插件失败走错误信封**：实测 `=on` + 托管失败 ⇒ **HTTP 503 / `ok:false` / `code='E_UNAVAILABLE'` / 无 `result` 字段**。
- ⇒ 断言 = **`ok===false && code==='E_UNAVAILABLE' && !('result' in body)`**，并**引用 T19 的 `host-f38/out-01-scenario-on.txt`** 证明"不回退"那句仍在（该文件里：`RESULT {"ok":false,…,"mode":null,"warning":null,…,"tried":[8911,8912,8913],"error":"…按显式配置**不**回退…"}`）。
- **lead 已裁决不改信封**（不为字面 `mode:null` 动错误信封）⇒ 这条**不是缺陷**，报告里不得写成缺陷。

### 20.2 `=on` + 托管失败**本机复现不了**（本发行版 systemd 可用）

- 本机 `=on` 走**主路径并成功** ⇒ 该失败场景**构造不出来**（用副本改命令名属于"构造"，T21 不重复造）。
- ⇒ 用**等价证据**三条：① 直调 `daemon-client` 得到的失败对象 `{ok:false,mode:null,warning:null,tried:[…]}`（T19 的 `out-01-scenario-on.txt`）② route 错误信封（§20.1）③ T19 证据文件本身。
- **报告必须明确标注**："场景本身是副本构造/本机无法自然复现"，不写成"已复现"。

### 20.3 窗口面判据**分两栏**（compat 弹窗是固有代价，不是缺陷）

| 路径 | 判据 | 要写的数 |
|---|---|---|
| **systemd 主路径** | `∆可见窗口` **必须 = 0**（≥2 轮，其中一轮**真面板点「启动守护」**，profile 层钉槽位；归属禁凭标题猜） | Δ 逐轮 before/after |
| **compat 路径（`=off`/回退）** | **允许出现窗口**（固有代价）——记录"它出现了"，并核对 T19 的 warning 措辞是否准确 | **产生过 N** ＝ ? ／ **收尾时存在 0** |

- T20 实测参照：`=off` 真的产生 **1 个 `WindowsTerminal`（pid 49220）**，归属链 = 宿主 40588 → `wsl.exe` 34900 → `daemon.log peer=win-pid-40588`，停守护后消失 ⇒ 我的复验要能对上这条链的形状。

### 20.4 双前缀：判据写在**组合后的响应文本**上，不写在源码字面量上

- 预备实测：`src/*.ts` 里 `remote-wsl: remote-wsl` **字面命中 0** ⇒ 双前缀是**组合**出来的，必须断言**响应文本**。
- 组合点（预备定位）：`daemon-client.ts:588` 内层已带前缀（`error: 'remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但…'`）→ `daemon-client.ts:838` 把它拼进 `远端守护在 Windows 侧不可达：… —— ${last}` → `explorer.ts:382/457` 又加一层（`remote-wsl: ${ensured.error}`）。
- **改前证据**：T18 当时的响应文本 = `… —— remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败…`（T19 文件里同款）。
- **判据**：响应文本 **不得**匹配 `remote-wsl:\s*remote-wsl`；同时 §20.1 的"不回退"句仍在。报告写清**改前/改后**两句原文。

### 20.5 其余条款（写死再跑）

1. **F-38a 残留**：`=on` + 托管失败 + 端口回退 ⇒ `launch.*.sh` **残留 0**、守护 **0**、错误仍"不回退"；**故意红** = `%TEMP%` 副本**禁用失败路径回收** ⇒ 残留断言必须**红**，删副本复绿（vendor 只读）。
2. **F-38b 权限**：失败路径与正常路径的启动脚本**都 0600**；`launch-stderr.log`、元数据仍 0600；**不用"100ms 采样"当穷尽证明** ⇒ 用**红态残留的 `ls -la` 对照**（含"改前 0644 vs 改后 0600"）。
3. **F-38c 字段**：`result` 四取值 —— ① systemd ⇒ `mode='systemd'`/`warning=null`；② `=off` ⇒ `mode='compat-detached'` + 非空 warning；③ 复用 ⇒ `mode='reused'`；④ `=on` 失败 ⇒ 走 §20.1 信封（无 `result`）；且 **`notes[]` 未被删改**。
4. **两条约束抽验**：窗口 **≥2 轮 Δ=0**（一轮真面板）+ 存活 **≥1 轮**（宿主退出后 pid 不变）。
5. **回归**：`--dump-config` exit 0/`Error:` 0；槽位隔离 `E_ARG` 且**无副作用**；5 方法白名单/同源门/仅 POST+JSON/无 token 回传；`--collect` 清理不回归。
6. **性能**：systemd 主路径启动**我自己的 ≥5 次读数**（p50/max），只给数据不设阈值（T19 自陈 ≈0.6s → ≈1.0–1.5s）。
7. **收尾**：清 unit/守护/包装层/profile/`launch.*.sh` + 枚举窗口（含归属）；端口 8931–8960；不跑 npm/pnpm；不弹窗；不碰 19387/47604。

## 21. T26 预备：A1 / A4 / P1 的判据（lead 2026-10-13 预备通知；**尚未 claim、尚未冻结**）

> **冻结纪律**：`task-23/24/25` 未完成 ⇒ **等正式 GO 再冻结**。
> 预备时快照（**非锚点**）：`explorer.ts` `906b9554df9a…`、`index.ts` `a8bdb70c61ac…`、`daemon-client.ts` `4d5c2ebf955c…`、`daemon.ts` `e471a5807054…`、`client.panel.js` `86f24076d6cd…`、`index.js` `0588b3d32ded…`、`client.api.js` `4ca5c7ba1a95…`、`package.json` `ce486eced7bc…`（= T21 冻结值）。

### 21.1 两条环境事实（**写进报告**）

1. **`degraded` 已查清并修复**：跨夜后 `systemctl --user is-system-running` = `degraded`；根因 = **T15 实验遗留的 3 个 failed `systemd-run` 探针单元**（`t15k41520u` / `t15k50720u` / `t15s31420`）。lead 已 `reset-failed` ⇒ **我预备期实测：`running`、failed units = 0、`t15*` unit files = 0、`/tmp/t15*` = 0、`dsh-rwsl-*` units = 0**。
   ⇒ 记成一条**已知卫生缺口**（规矩）：**`systemd-run` 探针 unit 收尾必须 `stop` + `reset-failed`；`--collect` 清不掉 failed 态**。
2. **`systemd-run --user` 仍可用**（预备期实测 `systemd 257 (257.13-1~deb13u1)`）⇒ 守护**预期走无窗主路径**。

### 21.2 每轮先读 `mode`（本轮判据的总闸）

| `result.mode` | 窗口判据 | 要写的数 |
|---|---|---|
| `systemd` | **∆ 必须 = 0** | 逐轮 before/after |
| `compat-detached` | **允许弹窗**（固有代价） | **产生过 N** ／ **收尾存在 0** |

- **若出现回退**：必须记录**是哪个环节**导致的（`systemd-run` 缺失/失败、`=off`、`=on`、degraded、其它）——这是本轮最想知道的边界。**degraded 是否导致回退**要单独回答。

### 21.3 A1-host 六项（`explorer.addWorkspace`）

| # | 断言 | 能红的形式 |
|---|---|---|
| ① | 存在的 WSL 目录 ⇒ `{ok,id,title,uncPath}` 且**注册表里可见** | 副本把登记写入改坏 ⇒ 红 |
| ② | **重复调用** ⇒ `alreadyExisted:true`、**`id` 不变**、**不产生第二个** | 副本强制走新建分支 ⇒ 红 |
| ③ | 不存在路径 ⇒ **404** | 改成 200/400 ⇒ 红 |
| ④ | 非法（相对/空/`..`/`/mnt/c`）⇒ **400 且无副作用**（用注册表条数 + 守护 facts 双对照） | 去掉校验 ⇒ 红 |
| ⑤ | **服务缺失**降级 ⇒ **503 + 那一行日志**（副本/桩屏蔽 `workspaceRegistry`） | 副本去掉降级 ⇒ 红 |
| ⑥ | 零副作用：调用前后 `daemon-invariance` facts 全 MATCH | — |

- **`/mnt/c` 取舍必须与 `listDir` 一致（不允许自相矛盾）**：`listDir('/mnt/c')` 走 `windowsDriveForMount()` ⇒ 200（**读**）；`addWorkspace('/mnt/c')` 预期 400（**登记**一个 WSL 工作区）。判据不是"两边同结果"，而是**同一条政策**：**只读浏览可以把盘符映射到 Windows 卷，登记工作区不行** —— 我会逐字读 400 的**文案是否解释了这个理由**，解释不清就记"不一致/未复核"。

### 21.4 A1-client 渲染四态 / A4 i18n / P1 / T5

1. **A1-client**：动作**存在且可发现**（可点、`aria-label` 有）；**成功 / `alreadyExisted` / 三种失败**（404、400、503）**各有渲染对照**（DOM 原文并排）；`openSession` 未受影响（同一轮复跑其 note）。
2. **A4**：`zh-CN` 与 `en` **逐项对照**（标题/按钮/状态条/空态/错误态 + `aria-label`/`title`）；**无 locale 服务时回退可用且不崩**（构造：桩掉 locale 服务）；light/dark 正常；aria 覆盖不退化。
3. **P1（`stopDaemon` 元数据复核）**：① 正常 `stop` 输出**与改前逐字相同** + 元数据清 + 无进程；② 构造"**守护忽略 shutdown**" ⇒ **元数据仍在**、返回可读失败、且 `scanDaemonProcesses()` **仍能看见它（可发现）**；③ **故意红**：副本去掉"移除前复核" ⇒ ②必须红，字节还原复绿；④ `stop --all` 语义不回归、**槽位隔离不破**。
4. **T5 两条文案瑕**：结果条**不再出现实现者词汇**（给 DOM 对照）；"**尚未取得快照**"**只出现一次**。

### 21.5 回归 + 故意红 + 收尾

- **回归**：`--dump-config` exit 0/`Error:` 0；**5→6 方法白名单含 `addWorkspace`**；同源门/仅 POST+JSON/415/无 token 回传；F33 槽位守卫（非配置槽位 `E_ARG` 无副作用）；`listDir` 的 `/mnt` 映射与 `addWorkspace` 取舍一致（§21.3）；窗口抽验 ≥1 轮（**先读 `mode`**）。
- **故意红 ≥3（每项各一条）**：A1-host（②或④或⑤任一条，建议 ⑤ 服务缺失关闭降级）／A1-client（改动作标签或去掉失败渲染）／**A4**（写死单语言或破坏无-locale 回退）／**P1**（去掉"移除前复核"）——**至少三条**，副本做、vendor 只读、字节还原后复绿。
- **收尾**：清 **unit（含 `reset-failed`）**/守护/包装层/profile/`launch.*.sh` + 枚举窗口（归属用启动时间+父 pid+进程树+`peer=win-pid-…` 交叉，**禁凭标题猜**）；端口 8931–8960；不跑 npm/pnpm；不弹窗；不碰 19387/47604。




