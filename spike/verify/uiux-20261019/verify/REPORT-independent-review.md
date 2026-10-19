# 独立对抗性复核报告（2026-10-19 UI/UX/性能轮）

- **复核者**：`spec-scout`（T-B 规格与门禁盘点角色，本轮做**独立复算**，不沿用作者读数）
- **日期**：2026-10-19 15:43–16:10（Asia/Shanghai）
- **被复核对象**：工作区（分支 `uiux/perf-20261019`，HEAD `d9f487e` + 未提交改动）
- **基线**：`D:/project/dsh1/baseline-repo`（HEAD `d9f487e` 干净 worktree，`git status` 0 行）
- **夹具**：`D:/project/dsh1/_work/harness/`（作者提供，未修改）；本报告新增脚本：`verify/adversarial.ts`、`probe2.ts`、`probe3.ts`、`probe4.ts`
- **原始读数**：`verify/out/adversarial-after.json`、`probe2-after.json`、`probe3-{after,baseline}.json`、`D:/project/dsh1/_work/out/probe-v3-{verify,baseline}.json`、截图 `_work/out/{verify,baseline,after}-*.png`
- **写作用域**：仅 `spike/verify/uiux-20261019/verify/`；**未改** `client/**`、`src/**`、docs、README
- **⚠️ 并发写者（复核期间发生）**：`README.md` 在 **15:51:06** 被作者重写（488 行，删掉了 P0.5.x 冻结表），`docs/panel-ux-performance-20261019.md` 同期新增。本报告所有 `README.md:行号` 均以**该版本**为准；重写带来的门禁后果见 **F6**

> 口径：每条结论都可由 §6 命令重跑；"未验证"一律标 **未验证**。凡标【既存】= **baseline 同样存在**，不是本轮回归（做了 A/B 对照，见 §4.4/§4.5）。

---

## 0. 结论表

### 0.1 阻断级（必须修）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| **F1** | `css-token-audit` 对**新增 chunk** `client/client.panel.list.js` **exit 1**（C1=1） | **FAIL（门禁口径）**：命中 `@15401 "#310"` —— 注释里的 **React error #310** 被当成 3 位 hex。**没有真实硬编码颜色**（该文件 `rules=0`，零 CSS）。但"门禁跑不过"是事实：作者只跑了 `client/index.js` 就写了"css-token PASS" | §1.1 / §6.1 |
| **F2** | 刷新（`load({alsoList:true, path})`）与"进入已缓存目录"交错 ⇒ 列表被**旧目录**覆盖且**不自愈**：`crumb=proj` 而 `pathInput=/home/g/proj/dir-00000`，1.5s/3s 后仍不一致 | **FAIL（竞态）**：`load` 的 `setBrowse` 只受 `readSeq` 保护，**不受 `browseSeq` 保护**；缓存命中路径不再写 `browse` ⇒ 慢的刷新结果成为终态 | §2.4 / §6.2 `race` |
| **F3** | 同一次"回到窗口"双发：`visibilitychange` + `focus` 各触发一次 `load()` ⇒ `snapshot` **2 次**（每次 ~7 次 `wsl.exe`，作者自述） | **FAIL（与"只刷一次/60s 节流"的陈述不符）**：节流只看 `state.lastSuccessAt` 闭包，同一 tick 两次事件都通过；后续事件确实被节流（第二次 focus Δ=0 ✅） | §2.5 / §6.2 `autoRefresh` |
| **F6** | **冻结表门禁在本轮 README 重写后由 PASS 变 FAIL**：15:03 我实测 `sync-freeze-table.ps1 -Mode Check` = **PASS 25/25**；现状 = **exit 1**（`README=14841` vs `REVISION=30422` 等 HASH/SIZE/MISSING 多条），因为 README 里**已不再有 P0.5.x 冻结表**，脚本只能取到 P0.1 的历史表（`README.md:241` 还标着"**当前**，13 个锚点"） | **FAIL（文档/门禁回归，本轮引入）** ⇒ `precommit-check.ps1` 第 02 项会红 | §5.1 / §6.1 |

### 0.2 既存缺陷（A/B 证明**不是本轮回归**，但仍在冻结规格之外）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| **F4** | 列表**不是**滚动体：`.dsh-rw-entries` 缺 `min-height:0` / `overflow:auto` ⇒ 内容（含虚拟化 `padBottom`）把容器撑到内容高，**行溢出卡片边框、画到「最近目录 / 诊断信息」上** | **FAIL**（SPEC §7.2.2 写的是 `flex:1;min-height:96px;overflow:auto`）。几何：1280×900 下 `card.h=672` 而 `entries.h=3398`（100 条）⇒ 溢出 **2889px**；截图肉眼可见 | §4.4 / `after-adv-1280.png` vs `baseline-ready-900.png` |
| **F5** | `⋯` 菜单键盘契约：**打开后焦点没进第一个菜单项**、**Esc 不关闭**（`menu:true, expanded:"true"`）、只有 `Tab` 关闭 | **FAIL**（SPEC §7.2.4："打开后焦点移入第一个菜单项"、"Esc 关闭并把焦点还给 ⋯"）。A/B **逐字段相同** ⇒ 既存 | §4.5 / `probe3-{after,baseline}.json` |

### 0.3 PASS（我独立复算通过）

| 组 | 通过项 |
|---|---|
| 门禁 | `check-client-rev` **PASS / rev `b50bc2247dda` / 11 chunks / exit 0**；`box-sizing` 真陷阱 **0**（107 规则，新 `.dsh-rw-search-input/-skeleton-row` 均 border-box）；`i18n 218/218 paired`；`panel-smoke-node 18/18`，7 个 panel chunk 全 <400 行（最大 `list.js=397`） |
| 视觉闭集 | `client/index.js`：**107 规则 / 17 token / C1=0 / C2 PASS / S1 OK**；新增 CSS 只用闭集 token；新增间距 ∈{2,4,6,8}、圆角 ∈{4,6,999}、字号 ∈{12,13}；零 emoji（非 BMP=**0**）；`outline` 仅 2 处 offset、无 `outline:none` |
| 命中盒 | 1280 / 320 两档、64 / 68 个可见交互元素，**<24×24 违例 = 0**；`⋯` 24×24、清除按钮 24×24、筛选输入 h=24、菜单项 h=28 |
| 布局 | 底栏 **47**、单行（centerY 唯一）、状态词 **不省略**（91==91）；行高 **32**；320（面板 275）标题/副标题**各 1 行**、按钮全单行、`⋯` **全宽唯一 1 个** |
| 交互 | 行点击导航**恰 1 次**（Δ=1）；点「复制」**不导航**（Δ=0、copy=1）；**文件行点击不导航**；筛选→进目录**自动清空**；无匹配态有「清除筛选」；Esc 清空且焦点回搜索框；缓存命中第二次进入 **Δ=0 请求**；force 刷新 **Δ=1**；stale 保留 30 行 + 提示 + 重试（基线同场景 0 行 + 错误块）；滚动记忆 3000 → **3000** |
| 虚拟化 | 5000 条：**22 行 / DOM 245 / scrollH 170173**；滚到底 `rows=27`、末行 `file-04999`；滚动后筛选（8 行）与清空（22 行）正常；无长任务 |
| 宿主面 | 我独立跑 `compare.ts`：**A/B checked 16, diffs 0**；错误 code/文案逐字相同；HTTP 9 项相同；`listDistros` burst 2→1、TTL 内 0、TTL 后 1；C4 TTL 内翻转不可见、TTL 后 `E_UNAVAILABLE`（与文档一致） |

### 0.4 未验证

1. **30s TTL 到期自动复核**：未等 30s（force 绕缓存已验证；到期路径仅代码审读）。
2. **chunk 加载失败时插件兜底**：夹具 `boot.js` 抢先报 `HARNESS BOOT FAILED`，插件 `chunk.panelFailed` 错误卡没机会渲染；静态确认存在（`client/index.js:309-320, 396`），**运行时未验证**。
3. **真宿主 e2e / dark 逐项 / 焦点环对比度**：夹具不带宿主 `focus.css`，实测 `outline: auto 1px rgb(16,16,16)` 是 **UA 默认** ⇒ 焦点环颜色/2px/对比度**不可判**（只可判"无 `outline:none`、offset 生效、`:focus-visible` ✓"）。
4. **>10 万条**、滚动条跳变、PageUp/PageDown 单测、两端并发、`others[]` 非空。

---

## 1. 规格合规

### 1.1 token 闭集 / 硬编码色

| 检查 | 我的读数 | 判定 |
|---|---|---|
| `client/index.js` | `rules=107, distinct --dsw-*=17, C1=0, shadow 豁免=2(α .08/.16), C2 PASS, S1 OK, exit 0` | **PASS** |
| 其余 10 个 chunk（逐个跑） | 除 `list.js` 外均 `rules=0 / C1=0 / exit 0` | **PASS** |
| `client/client.panel.list.js` | `C1 = 1 @15401 "#310"` ⇒ **exit 1** | **FAIL（误报，但门禁红）** |
| 新增 CSS 取值 | 间距 `2/4/6/8`、圆角 `4/6/999`、字号 `12` —— 闭集内 | **PASS** |
| 新增颜色 | 全 token（`bg-base/layer-2/border-l1/l2/label-primary/secondary/dimmed/interactive-bg-hover`） | **PASS** |
| `box-shadow` | 新增零 `box-shadow`（骨架只用背景明暗，符合 Q4） | **PASS** |

**F1 修法**（二选一，不改产品行为）：① 注释里 `React error #310` → `React error 310`（1 个字符）；② 给 `css-token-audit.ts` 加"剥注释"（该工具不剥注释，会持续误伤 `#NNN` 文本，建议顺手修）。修完 **必须 bump 入口 rev**。

### 1.2 尺寸 / 断点 / 命中盒 / box-sizing

| 检查 | 读数 | 判定 |
|---|---|---|
| 底栏高 | 1280 与 320 均 **47** | **PASS** |
| 底栏单行 | 子元素 centerY 唯一（877） | **PASS** |
| 状态词不省略 | `scrollWidth==clientWidth`（91/91），320 同 | **PASS**（B2 未回退） |
| 行高 | **32** | **PASS** |
| 命中盒 ≥24 | 1280：64 个交互，违例 **0**；320：68 个，违例 **0** | **PASS**（SC 2.5.8） |
| box-sizing | 真陷阱 **0**；新 `.dsh-rw-search-input{box-sizing:border-box;height:24}`、`.dsh-rw-skeleton-row{...height:32}` 均显式 | **PASS** |
| 断点 | `<420` 窄态生效；`360` 逻辑未改 | **PASS** |
| 窄档折行 | 320（面板 275）：标题 1 行、副标题 1 行、按钮 h=28 单行、无横向溢出 | **PASS**（SPEC §1310 的旧遗留已不是问题） |
| `⋯` 唯一性 | `[aria-haspopup=menu]` = **1**（「更多操作」）；菜单宽 **240**；向上展开、与状态词**不重叠** | **PASS** |
| 行内动作占位 | `.dsh-rw-rowacts` 宽 hover 前后 **96→96**、`display:flex`、`visibility:hidden` | **PASS**（N4 未回退） |
| **列表滚动体** | `.dsh-rw-entries{flex:1}` **无** `min-height:0`、**无** `overflow:auto` ⇒ `card.h=672 / entries.h=3398`，行溢出并覆盖折叠区 | **FAIL（既存，F4）** |

### 1.3 文案 / i18n / 零 emoji / LTR / 状态冗余

| 检查 | 读数 | 判定 |
|---|---|---|
| i18n 键 | `zh=218 / en=218 / paired:true / onlyZh=[] / onlyEn=[]` | **PASS**（+11 键与文档一致） |
| 面板 chunk 中文字面量 | 新增 `data.js`、`list.js` 非注释 CJK = **0**；11 个文件合计 11 处全为**既存**：`helpers.js` 2（拆句正则 `/。！？/`）、`client.api.js` 8（**api 错误文案硬编码中文，未走 i18n**，既存缺口）、`index.js` 1（`PANEL_LABEL_FALLBACK` 官方兜底） | **PASS（本轮无新增）** |
| 零 emoji | `client/*.js` 非 BMP **0** | **PASS** |
| LTR | 筛选输入 `direction:ltr;unicode-bidi:isolate;text-align:left`；行名 `dir="ltr"`；无 `plaintext` | **PASS** |
| 状态三重冗余 | 状态点/状态词/颜色未动；stale 用 `role="status"` + 文字，不用颜色单独表达 | **PASS** |
| 术语禁词 M5 | 主视线未见 `slot/pid/keys/explorer.snapshot`；但**刷新按钮 `aria-label` =「重新读取 explorer.snapshot」**（读屏可听到内部方法名）——既存 | **WARN（既存）** |
| 骨架 | 首屏 3 行、列目录 5 行；只做背景明暗呼吸 1200ms；`prefers-reduced-motion` 下静止 | **与 SPEC §6.3 不符（§5.1）** |

---

## 2. 交互正确性

### 2.1 行点击 / 行内按钮（不双跳）

| 动作 | 读数 | 判定 |
|---|---|---|
| 点目录行（未缓存） | `listDir Δ=1`、crumb 变 | **PASS** |
| 点行内「进入」 | `Δ=0`（目标已缓存）+ `moved=true` ⇒ 导航一次、无重复请求 | **PASS** |
| 点行内「复制」 | `Δ=0`、`moved=false`、`copyCalls=1` | **PASS**（`stopPropagation` 生效） |
| 点文件行 | `Δ=0`、不导航 | **PASS** |
| 键盘 Enter（目录行） | `Δ=1` —— 单飞吸收了"行 handler + 容器 handler 各跑一次"的重复导航 | **PASS（但见 R2）** |

### 2.2 筛选

| 检查 | 读数 | 判定 |
|---|---|---|
| 即时过滤 | `file-0001` → 8 行、`8/124 项` | **PASS** |
| **换目录清空** | 过滤 `dir-0000`（2 行）→ 点目录 → `value=""`、`crumb=dir-00000`、回 `共 124 项` | **PASS**（首测是夹具错误，见 §6.3） |
| 无匹配 | 0 行 +「没有匹配「zzz-nope」的条目」+「清除筛选」 | **PASS** |
| Esc 清空 | 值 `""`、回 120 行、焦点回 `.dsh-rw-search-input` | **PASS** |
| `/` 聚焦、`↓` 进列表 | 代码路径存在；键盘未单独实测 | **PASS（代码）/ 部分未验证** |

### 2.3 缓存 / force / stale

| 检查 | 读数 | 判定 |
|---|---|---|
| 首次进入 | `Δ=1` | **PASS** |
| 第二次进入（TTL 内） | `Δ=0`（`3.7ms`） | **PASS** |
| 刷新按钮（force） | `Δ=1`（绕缓存） | **PASS** |
| stale-while-revalidate | `listFail` 后刷新：**保留 30 行** +「显示的是上次缓存；刷新失败，内容可能已过期 / 重试」，**无错误块**；基线同场景 **0 行 + 错误块** | **PASS（真改进）** |
| 30s 到期自动复核 | 未等 30s | **未验证** |

### 2.4 ★ 竞态：刷新 vs 进入缓存目录（F2，必修）

复现（`adversarial.ts` 的 `race`，`latencyMs=400`）：① 进 `/home/g/proj/dir-00000`（入缓存）→ Backspace 回 `proj`；② 点**刷新**（`header.js:128 → load({alsoList:true, path: cwd})`）；③ **立刻**点 `dir-00000`（缓存命中 ⇒ 同步 `setBrowse`，没有后续 promise 纠正）；④ 刷新结果的 `setBrowse({cwd:"proj"})` 覆盖：

~~~
crumb     = "proj"                       ← 旧目录（列表也是旧内容）
pathInput = "/home/g/proj/dir-00000"      ← 新目录
firstRow  = "dir-00000"
1.5s / 3.0s 后相同（不自愈）
~~~

**根因**：`load()` 的目录写回只受 `readSeq`（`actions.js:81`）保护，导航用 `browseSeq`（`data.js:46-47`），两条序号互不相干。
**最小修法**：`load` 写 `browse` 的两处（`actions.js:97, 103-106`）加"仅当 `wanted` 仍是最近一次导航目标"的守卫（跳转时置一个 `navTargetRef` / 递增 `navSeq` 并比对）。**不要**改成"刷新不带 path"——那会退掉 M8。

### 2.5 自动刷新（F3）

~~~
deltaOnReturn（visibilitychange + focus 同 tick） = 2
deltaSecondFocus（紧接着再 focus，<60s）        = 0   ← 节流本身有效
~~~

⇒ 方向对，但**同一次回到窗口打两次 `snapshot`**（作者注释自认 ≈7 次 `wsl.exe`）。修法：节流时间戳放 `useRef` 并在进入时立即写入，或对 `maybeRefresh` 做 rAF 合并。

### 2.6 滚动记忆 / 虚拟化边界

~~~
scrollMemory: set 3000 → 回目录 restored 3000     PASS
5000 条：rows 22 / DOM 245 / scrollH 170173       PASS
滚到底：rows 27 / last = file-04999                PASS
滚到底后筛选：8 行，scrollTop 归 0                  PASS（无卡死）
清空筛选：22 行                                    PASS
~~~

---

## 3. 性能主张的可复现性（我的 A/B）

| 指标 | 基线（我测） | 本轮（我测） | 作者文档 | 判定 |
|---|---:|---:|---|---|
| 5000 条渲染行数 | **5000** | **22** | 5000→22 | ✅ 一致 |
| 5000 条 DOM 节点 | **30078** | **245** | 30078→**243** | ✅ 方向一致，**差 2**（建议区间化） |
| 长任务 | **99ms + 168ms（2 个）** | **0** | **120ms + 200ms** | ⚠️ 逐位不同，结论"有→无"成立 |
| 首行出现 | **519ms** | **244ms** | 571→258–272 | ⚠️ 数值不同（我更快），方向一致 |
| 路径输入每键（5000 条） | **47 / 29.2 / 27.2ms** | **6.2 / 3.7 / 3.0ms** | 25.4/27.7/41.5 → 3.6/2.3/2.0/2.7/2.7 | ⚠️ 基线首键我测 47（作者 25.4），方向一致 |
| 进入同一目录第二次 | **382.9ms** | **3.7ms** | 383–386→3.6–4 | ✅ 一致 |
| 首次进入目录 | 384.4ms | 124.5ms | —（未给） | ✅ |
| 小目录（200 条）DOM | 1278 | 1329 | — | 新增筛选行 + 计数 + role/aria，+51 合理 |
| 搜索每键（300 条） | —（无搜索框） | **5.4/3.3/2.1/1.8ms** | 未给 | 补充读数 |

**结论**：性能主张**方向与量级全部成立**；但文档里的精确值（120/200、571、25.4/27.7/41.5、243）**无法逐位复现**。建议改"区间 + 批次"。证据：`_work/out/probe-v3-verify.json` vs `probe-v3-baseline.json`（同脚本同参数，相隔 5 分钟）。
宿主面（我独立跑 `compare.ts`，未重跑 `wsl.exe`）：**16 项 diffs 0**、错误文案逐字相同、HTTP 9 项相同、缓存/单飞读数一致 ⇒ "16/16 零差异"**成立**。

---

## 4. 风险面

### 4.1 Hooks 顺序

- `list.js:391-393` 的 `function Entries(props){return renderEntries(props);}` 由 `browser.js:218` 以 `createElement(Entries,...)` 挂载 ⇒ hooks 落在自己的 fiber，**#310 的修法正确**。
- 实测：筛选（200→8→120）、导航、滚动、键盘全流程后 `window.__harness.errors` = **[]**，无 `#310`、无 unhandled rejection。
- **风险**：`exports.renderEntries` 仍导出（`list.js:395`）——将来若有人直接调用它（而非挂组件）会让 hooks 挪进父组件 ⇒ #310 复发。建议删导出或写入红线注释。
- 观察项：`useListWindow` 的 `useState` 初值依赖 `enabled`，此后只靠 effect 修正 ⇒ 小目录切大目录时首帧渲全量再收敛（实测无卡顿）。

### 4.2 虚拟化 / 键盘边界

- 首/末行：`Home/End` 实测 index 0 / 39 ✅；5000 条滚到底 `last=file-04999` ✅；筛选后窗口重算正常 ✅。
- **未测**：PageUp/PageDown。且 `page=8` 是固定值（不是"一屏"）⇒ 22 行视口下按一次只走 8 行，**与浏览器惯例不一致**（可用性小瑕，建议按可视行数算）。
- `focusRowAt` 用硬编码 `32`（`list.js:154`）而列表用 `ROW_BLOCK=34` ⇒ 两处常数混用（低风险，同类"规格 vs 实现数字"问题）。

### 4.3 快速连点 / 切换目录（seq / abort）

- ✅ 导航：`browseSeq` last-call-wins，旧结果被丢弃。
- ✅ 请求：`dirCache.inflight` 单飞 ⇒ 目录 Enter 的双 handler 被吸收成 **1 次请求**。
- ❌ **跨路径竞态**：F2（唯一能稳定造出错误终态者）。
- ⚠️ 导航**不再 abort** 上一请求（旧 `listPath` 有 `browseAbort`，现仅卸载时用）⇒ 快速乱点会在飞请求堆积（每个 ~1 次 host 调用）。性能/卫生问题，非缺陷。

### 4.4 布局溢出（F4，既存）

几何（1280×900，100 条）：

~~~
body    top=79  h=774
card    top=87  h=672          ← 被 flex 压缩
entries top=250 h=3398         ← 内容高（100×34）
card bottom 759 ⇒ 溢出 2889px
~~~

CSS 事实：`.dsh-rw-entries{display:flex;flex-direction:column;gap:2px;min-width:0;padding:0;flex:1;outline-offset:2px}` —— **没有 `min-height:0`、没有 `overflow:auto`、没有 `min-height:96px`**（SPEC §7.2.2 三个都有）。于是列表把卡片撑破，行继续绘制在「最近目录 / 诊断信息」上（两张截图都坏）。
**修法（2 个属性）**：`.dsh-rw-entries{min-height:0;overflow:auto}`。修完后 `findScrollParent` 会找到 `.dsh-rw-entries` 而非 `.dsh-rw-body` ⇒ 虚拟化/滚动记忆/`focusRowAt` 的 `scroller` 分支本就兼容（注释需同步）。
> 非本轮引入，但本轮把"列表"当性能主战场，却把"列表没在卡片里滚"留在原地 —— 建议一起修，否则"22 行视口"在真机上仍会被"边框穿行"的观感抵消。

### 4.5 菜单键盘（F5，既存）

`probe3` 用**真实 CDP 鼠标点击**打开 `⋯` 后：

| 期望（SPEC §7.2.4） | 实测（after） | 实测（baseline） |
|---|---|---|
| 焦点移入第一个菜单项 | **仍在触发按钮**（`.dsh-rw-iconbtn`），`↓` 也不进菜单 | 同 |
| `Esc` 关闭并归还焦点 | **未关闭**（`menu:true, expanded:"true"`） | 同 |
| `Tab` 关闭并前进 | ✅ 关闭、`expanded:false` | 同 |

⇒ **既存规格缺口**（菜单 `onKeyDown` 挂在 `.dsh-rw-menu` 上，焦点从未进入 ⇒ 事件到不了它）。修法：打开时 `menuRef.current.querySelector('[role=menuitem]').focus()`，并把 Esc/Tab 收口到菜单容器或 document 捕获。
与 T53/T54 不冲突：T53 只证明了"组标注"正确；键盘契约从未真机验证。

### 4.6 无 JS / 失败模式

- `whenReady()` 失败 ⇒ `index.js` 的 `loadPanel` catch 渲染 `chunk.panelFailed` 错误卡（静态 `index.js:309-320, 396`）；**运行时未验证**（夹具 boot guard 抢先）。
- 7 个 chunk 全 **<400 行**（`list.js=397` 最贴线）；chunk 命名符合 `client.<name>.js` 正则；入口 `CHUNKS` 与 `parts` 解构**逐一对齐**（`panel.js:52-65`），smoke 18/18 兜底。
- ⚠️ 卫生：`helpers.js / panel.js / header.js / i18n.js / index.js` 5 个文件 **末尾换行被删**（`git diff` 的 `\ No newline at end of file`）。不影响运行，但会放大下一次 diff 噪声。

---

## 5. 文档漂移：本轮必须同步更新

### 5.1 必须改

| 文件:行 | 现状 | 应该是什么 |
|---|---|---|
| `README.md:310` | 「distro 选择器 + **收藏路径树** + 状态条（**pid/端口/version/keys/drift**），行内动作「在新会话中打开」」 | **T30 前的旧 IA**，且**违反 M5**（pid/keys 不得进主视线）。应改为：筛选框 + chips + 面包屑 + 路径输入 + 列表（整行点击/键盘）+ 折叠诊断 + 底栏状态句 |
| `README.md:241-257`（**重写后**的冻结表） | 现在是 **P0.1 历史表**（13 锚点 / `client/index.js` 14,841 / `client.panel.js` 34,915），标题却写「**当前**，13 个锚点」；P0.5.x 那张表已被删 ⇒ `sync-freeze-table -Mode Check` **exit 1**（F6） | ① 把「当前」二字去掉（它是历史表）；② 重冻结后由 `sync-freeze-table.ps1 -Mode Generate` **重投影出新的 27 锚点表**（含 `data.js`/`list.js`） |
| `README.md` 的「冻结 revision」叙事 | 只到 P0.1/P0.5.1，无 P0.5.4、无本轮 | 补一行「本轮（2026-10-19）」现状：锚点 27、尚未重冻结 / 或已冻结 |
| `docs/panel-visual-spec.md:697-711`（§6.3） | 「加载（首次）：条目区内 **5 行骨架**：每行 32px，左侧 **16×16 圆角 3px 灰块** + 右侧 **120/90/160/110/140px** 条；**不加动效**（1.2s **opacity** 0.6→1.0）」 | 实现：首屏 **3 行**（header 卡）+ 列目录 5 行、**整行铺满**（无 16px 块/无宽度阶梯）、动效是 **background 明暗**。**必须对齐**（改规格或改实现），并把"首屏 3 行"写进去 |
| `docs/panel-visual-spec.md:778-793`（§7.2.2 逐元素表） | 缺：**筛选框 / 计数 / 清除按钮 / stale 条 / 虚拟化占位 / 行可聚焦（roving tabindex）** | 本轮新增 5 类元素都要进表（24 高 / 圆角 4 / 字号 12 / 命中盒 / aria），否则下一轮无据可依 |
| `docs/panel-visual-spec.md:640-653`（§6.1 高度预算） | 「卡片固定 126px ⇒ 列表可得 625px ⇒ **18 行**」 | 新增筛选行（24+gap6 = **+30px**）⇒ ≈595px ≈ **17 行**；算式需重算，并注明筛选行常显 |
| `docs/panel-visual-spec.md:789` | 「列表容器 `flex:1;min-height:96px;overflow:auto`」 | 实现缺两条（F4）—— **要么补实现，要么改规格**；现状是"规格写了、代码没做、复验也没测" |
| `docs/panel-visual-spec.md:1101-1102`（§9.1） | 「§6.1 高度预算 / §6.3 三态」 | 补一行交叉引用：本轮已改 §6.1/§6.3/§7.2.2 |
| `docs/panel-ux-redesign.md:334-355`（§7 M1–M17） | 无"筛选 / 虚拟化 / 整行点击 / roving tabindex / stale 重试"映射 | 新增 **M18–M22**（或在本轮文档给等价"能红判据"），否则这些行为**没有判据编号**，下一轮无从复验 |
| `docs/panel-ux-redesign.md:195` | 「当前值 **215**」 | 已 218；加"（2026-10-19：218）" |
| `docs/client-contract.md`（§2.3 / §11 举例） | 「零构建**建议单文件** `client/index.js`」「4/9 chunk」 | 现 **11 chunk**；§2.3 补一句"本插件已拆 11 chunk，命名与 `require.async` 契约见下" |
| `docs/panel-ux-performance-20261019.md`（§0 表） | 精确值（120/200ms、571ms、25.4/27.7/41.5、243） | 我复现不出逐位值（§3）⇒ 改区间或标批次，否则下一轮"复现失败"会被误判成回归 |
| `docs/panel-ux-performance-20261019.md:64` | 「css-token-audit = 107 rules / C1 0」 | 补充：**只对 `client/index.js` 成立**；对 `list.js` 跑同一门禁是 **exit 1**（F1） |
| `spike/verify/explorer-20261012/REVISION.txt` | 25 锚点 | 磁盘 27 ⇒ `revision.ps1 -Mode Check` **exit 1**（我实测）；须 **Lead** 用 `-Mode Write -ConfirmFreeze` 重冻结（`REVISION.txt:3` 禁止手改） |
| `package.json files` | — | 已是目录级 `"client"`（`PREFLIGHT OK`）⇒ **无需改**（已核，不用动） |

### 5.2 可以不改（已核）

- SPEC 的 17 token 闭集 / 对比度表 / §8 测值：本轮未动颜色体系 ⇒ 仍成立。
- `hygiene-rules.md`、`prior-art-dsh-wsl.md`、`remote-explorer-design.md`：与本轮无因果。

---

## 6. 复现命令与原始证据

### 6.0 环境

~~~powershell
$node = 'C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'   # v24.21.0
$repo = 'D:/project/dsh1/dsh-remote-wsl'
$T    = "$repo/spike/verify/explorer-20261012"
~~~

### 6.1 门禁（我的实跑）

~~~powershell
& $node "$T/tools/check-client-rev.ts" --root $repo
#   PASS / 模式=git / rev b50bc2247dda / 11 chunks / exit 0

foreach ($f in Get-ChildItem "$repo/client" -Filter *.js) {
  & $node "$T/visual/tools/css-token-audit.ts" $f.FullName dsh-rw-   # ← 必须逐个文件
}
#   index.js: 107 rules / 17 tokens / C1=0 / C2 PASS / S1 OK / exit 0
#   client.panel.list.js: C1 = 1 @15401 "#310" ⇒ **exit 1**

& $node "$T/visual/tools/box-sizing-audit.ts" "$repo/client/index.js" dsh-rw-
#   真陷阱 0 / 候选 2（btn/chip UA 兜底）/ OK 10 / exit 0

& $node "$T/arch-t2/tools/count-i18n-keys.ts" $repo        # zh=218 en=218 paired:true
& $node "$T/arch-t6/tools/panel-smoke-node.ts" $repo       # 必须带插件根；18/18 PASS
~~~

### 6.2 对抗性夹具（本目录，只读产品代码）

~~~powershell
$env:DSH_RW_REPO = $repo
& $node --experimental-strip-types "$repo/spike/verify/uiux-20261019/verify/adversarial.ts" --label after
& $node --experimental-strip-types "$repo/spike/verify/uiux-20261019/verify/probe2.ts" --label after
& $node --experimental-strip-types "$repo/spike/verify/uiux-20261019/verify/probe3.ts" --label after
$env:DSH_RW_REPO = 'D:/project/dsh1/baseline-repo'
& $node --experimental-strip-types "$repo/spike/verify/uiux-20261019/verify/probe3.ts" --label baseline
& $node --experimental-strip-types "D:/project/dsh1/_work/harness/probe-v3.ts" --label baseline   # 性能 A/B
~~~

读数摘（完整 JSON 见 `verify/out/`）：

~~~
layout1280 : footerH=47 / 单行 / 状态词 91==91 / ⋯=1 / 行高 32 / 交互 64 个 0 违例
layout320  : 同上（面板 275）/ 标题副标题各 1 行 / 搜索框 165×24 / 交互 68 个 0 违例
interactions: rowClick Δ=1 moved | enterButton Δ=0 moved | copyButton Δ=0 moved=false copy=1 | fileRow Δ=0
keyboard   : ↓×1→idx0；↓×1→idx1（不跳两格）；End→idx39；文件 Enter→copyCalls=2；目录 Enter→Δ=1
filter     : 8/124 → 点目录 → value="" crumb=dir-00000 rows=120 共 124 项 | 无匹配+清除 | Esc→清空、焦点回框
cache      : first=1 second=0 force=1
race       : consistent=false settledConsistent=false（F2）
autoRefresh: deltaOnReturn=2 deltaSecondFocus=0（F3）
virtual    : 22/245/170173 → 底 27 行 file-04999 → 筛选 8 行 → 清空 22 行 → 记忆 3000==3000
menu       : ⋯ 唯一 1 / 菜单 240 / 不遮状态词 / 菜单项 h=28 / 菜单组=2（both aria-labelledby）
             （文档级第 3 个 role=group 是 chips 行 —— T50 的旧陷阱，别再数它）
geometry   : card.h=672 vs entries.h=3398（F4）
chunkFail  : 夹具 boot guard 先报错 ⇒ 插件兜底未验证
~~~

### 6.3 第一次筛选测试的**自我更正**（留痕）

首版我写"筛选 `file-0001` 后点目录行"，但该过滤结果里**没有目录行** ⇒ `querySelector('.dsh-rw-row--dir')` 为 null、什么都没点，读数"筛选未清空"是**我的夹具错误**。重测（过滤 `dir-0000` → 2 个目录行 → 点击）后：**正确清空**。按项目纪律记录这次假红。

---

## 7. 两栏

### 7.1 【一旦错了就得返工】

1. **F2 竞态**先修再谈收口：会让用户"点了目录却看到旧目录"，且**不自愈**。
2. **F1 修注释**要连带 bump 入口 rev（否则再踩 §11 缓存坑，且 07 门禁红）。
3. **F4 修 `overflow`** 要同步改 `findScrollParent` 注释/预期（滚动体从 `.dsh-rw-body` 变成 `.dsh-rw-entries`），并重跑滚动记忆/虚拟化读数。
4. **重冻结只能 Lead 做**（`-Mode Write -ConfirmFreeze`）+ `sync-freeze-table -Mode Generate` 重投影；**任何人不要手改 `REVISION.txt`**。
5. **文档成对改**：本轮新增行为必须同时在 SPEC 与 UX 里有编号判据，否则下一轮无法判红/绿。

### 7.2 【建议修但不阻断】

- F3 双发（几行）；R2 Enter 双写剪贴板（容器 handler 顶部加 `if (event.defaultPrevented) return;` → 1 行）；R3 慢计时器泄漏（`slowTimer` 在被取代/abort 时未 clear，且成功路径不 `setSlow(false)`）；R4 `ROW_BLOCK` 双源（`helpers.js:28` 与 `list.js:27`，前者导出无人用）+ `focusRowAt` 硬编码 32；R5 5 个文件末尾换行；R6 `renderEntries` 导出红线；R7 `PageDown=8` 应按一屏；R8 `aria-label` 里的 `explorer.snapshot`。
- F5（菜单键盘）虽既存，但**修起来 ~5 行**，且是"键盘用户拿不到破坏性动作入口"的可访问性缺口，建议本轮一起收。

### 7.3 【不是问题，别改】

- `box-sizing-audit` 的「候选 2 条」（`.dsh-rw-btn/.dsh-rw-chip`）：`<button>` UA 兜底，T65 已裁定；**别为了消警告加 `border-box`**（会改变既有渲染）。
- `docOverflow = 1`：baseline 与 after **都是 1**，非本轮引入。
- `rowRole=listitem / role=list / aria-setsize·posinset`：与虚拟化一致，正确。
- 列表容器 `tabindex=0` + 当前行 `tabindex=0` 双停点：与"容器可聚焦以便键盘进入"一致，不算违规。
- `/mnt` chips 修复：`mounts` 已出现（`/mnt/c…/mnt/e`），全流程 `window.__harness.errors` = **0 条** ⇒ const 赋值缺陷确已修好、未留 unhandled rejection。
