# REPORT —— T50：UX 残余项复验（V3 八宽度 / V7+M17 真实 hover / N3 展开态 / M6–M12）

- **日期**：2026-10-13 18:38 – 19:02 采集，2026-10-14 10:2x 收口写报告 ｜ **评估者**：`usability-engineer`
- **被测量**：**HEAD `4699876`**（UX 修复主体＝`d681599` fix(ux2)：命中区 ≥24 / 底栏 `box-sizing`+47 / 状态点外径恒 8 / N1·N3·N5 / 组标题 `label-primary`）+ 其上的 docs/chore 提交；**入口 rev**：页面 `ce31566f7f55`（`%TEMP%` 副本，元数据哈希）/ 仓库 `afc26d1a2793`
- **证据目录**：`spike/verify/explorer-20261012/usability/p05-final/`（**20 个文件**：17 份 JSON + 3 张 PNG）
- **本轮**：**有界收尾**（lead 指令：不再开新战线；只允许补 N3，且 N3 上一轮已测到）
- **三态分类口径**：**已实现且已验证** / **已实现未自证** / **未实现或判红**

---

## 0. 前置证明（两条都过，**未重跑，引用已有落盘证据**）

### ① `tools/check-client-rev.mjs` → **exit 0 / PASS**（模式=git）

```
client-rev 门禁：PASS（模式=git）
  入口     : client/index.js（来自 exports["./client"]）
  当前 rev : afc26d1a2793   [size=28342]
  chunks   : 9 个
  依据     : 自入口最后一次内容变更（d6815996e09d）以来没有任何 chunk 变化 ⇒ rev 与内容自洽
```

### ② 页面加载的 chunk == 磁盘 chunk → **9/9 PASS**（`out-p05-integrity.json`）

判法（与 T40 相同）：从页面 `performance.getEntriesByType('resource')` 取**页面真正用过的** chunk URL → `fetch(url,{cache:'no-store'})` → 去 `sourceMappingURL` trailer → 与磁盘**逐字节前缀**比较。

| chunk | served | disk | 平台追加 | 前缀相等 | 磁盘 sha256(前16) |
|---|---|---|---|---|---|
| `client.api.js` | 14,905 | 14,847 | `";"` | **PASS** | `5a192b93a62900e0` |
| `client.i18n.js` | 31,057 | 30,998 | `";"` | **PASS** | `47525217062f3107` |
| `client.icon.js` | 2,268 | 2,209 | `";"` | **PASS** | `e9a824f50e45e5d4` |
| `client.panel.js` | 9,836 | 9,776 | `";"` | **PASS** | `e018be93236fbd57` |
| `client.panel.actions.js` | 13,360 | 13,292 | `";"` | **PASS** | `d45d9f9acbc895a1` |
| `client.panel.browser.js` | 13,850 | 13,782 | `";"` | **PASS** | `a4bcafa8e2141ea5` |
| `client.panel.header.js` | 8,055 | 7,988 | `";"` | **PASS** | `b5c1a2c06c7ed495` |
| `client.panel.helpers.js` | 12,268 | 12,200 | `";"` | **PASS** | `efa1e85cca69012b` |
| `client.panel.tail.js` | 14,892 | 14,827 | `";"` | **PASS** | `c946a6c883a65e97` |

- 磁盘 sha256 与门禁列出的 9 个 chunk 哈希**逐个相等** ⇒ 门禁复算口径与平台一致。
- 平台追加的仍是 **`;` 分号**（非换行），与 T40 实测一致 ⇒ 契约 §11 的措辞建议不变。
- 结论：**渲染读数有效**（页面跑的就是提交树字节）。

---

## 1. 逐项读数（本任务书第 1–4 项）

### 1.1 **V3 八宽度** → ✅ **已实现且已验证**（`out-p05-v3.json`）

| 请求宽度 | innerWidth 回读 | footerH | footer scrollW/clientW | 子元素中心数 | 单行 | 状态词 | 状态词 scrollW==clientW | `⋯` 尺寸 |
|---|---|---|---|---|---|---|---|---|
| 320 | **320** | 47 | 264/264 | 1 | ✅ | 远端守护未运行 | 91==91 ✅ | **24×24** |
| 359 | **359** | 47 | 303/303 | 1 | ✅ | 同上 | ✅ | 24×24 |
| 360 | **360** | 47 | 304/304 | 1 | ✅ | 同上 | ✅ | 24×24 |
| 419 | **419** | 47 | 363/363 | 1 | ✅ | 同上 | ✅ | 24×24 |
| 420 | **420** | 47 | 364/364 | 1 | ✅ | 同上 | ✅ | 24×24 |
| 719 | **719** | 47 | 663/663 | 1 | ✅ | 同上 | ✅ | 24×24 |
| 720 | **720** | 47 | 664/664 | 1 | ✅ | 同上 | ✅ | 24×24 |
| 1280 | **1280** | 47 | 1000/1000 | 1 | ✅ | 同上 | ✅ | 24×24 |

- **视口真改了**：用 CDP `Emulation.setDeviceMetricsOverride`（**不是** `resize_page`），8/8 宽度 `innerWidth` 回读与请求值**逐一相等** ⇒ 自证成立。
- **单行判据**（防"换行所以不溢出"的假绿）：底栏全部可见子元素垂直中心**唯一**（`distinctCenters=1`）+ `footerH` 在 320→1280 **恒为 47**。
- **与 T40 的差异**：T40 时 `footerH=55`、`⋯` 在 5/8 宽度只有 16–21×24；T42 之后 **47px** 且 `⋯` **8/8 宽度都 24×24** ⇒ 两项均**已修复且本轮自证**。
- 截图：`v3-320-footer.png`

### 1.2 **V7 / M17 真实 hover（两主题 × 三背景）** → ✅ **已实现且已验证**（`out-p05-v7.json`）

| 主题 | 当前项形状通道 | hover：底栏按钮 | hover：`⋯` | hover：目录列表行 | 强制静息填充后 |
|---|---|---|---|---|---|
| light | `.dsh-rw-crumb--current` **`border-left:2px` + `font-weight:600`** | `rgb(255,255,255)` → **`rgba(38,49,72,0.06)`** | 透明 → `rgba(38,49,72,0.06)` | 透明 → `rgba(38,49,72,0.06)` | **`distinguishableWithoutFill = true`**（2px + 600 仍在） |
| dark | 同上（2px + 600） | `rgb(21,21,23)` → **`rgba(255,255,255,0.08)`** | 透明 → `rgba(255,255,255,0.08)` | 透明 → `rgba(255,255,255,0.08)` | **`true`** |

- hover 用 `CSS.forcePseudoState` 强制、读数取 `getComputedStyle`；三背景两主题**全部 changed=true**。
- **"强制置静息填充后仍可分辨"**：注入样式把当前项背景置透明后，`border-left:2px` 与 `font-weight:600` 仍在 ⇒ 区分**不依赖填充**（只靠填充即红的判据在此点通过）。
- **M16 顺带核对**（菜单）：`role=menu` + **3 组** + **4 个 menuitem**；启用项文字 = **`label-primary`**（light `rgb(15,17,21)` / dark `rgb(249,250,251)`）；未启用项为弱色（light `rgb(225,229,238)` / dark `rgb(67,69,74)`，即无守护时的禁用态）；**组标题（守护/诊断）解析为 `label-primary`**（与 T46 实测 dark **5.55:1** 一致——本轮未重复算对比度，引用其读数）。
- 截图：`v7-menu-light.png`、`v7-menu-dark.png`

### 1.3 **N3 折叠展开态** → ✅ **已实现且已验证**（`out-p05-n3.json` + `n3-details-open.png`）

触发：路径输入 `/definitely/not/here-usab` → 跳转 → 列目录失败。

| 状态 | 读数 |
|---|---|
| **closed** | `details` 摘要 = 「**技术细节（host 原文）**」，`open=false`，`innerTextLen=13`（**只有摘要，正文未渲染**） |
| **open=true** | 正文 = host 原文 **162 字符**：`remote-wsl: 列目录失败：路径 /definitely/not/here-usab 不存在或不是目录（ENOENT: ENOENT: no such file or directory, scandir '\\wsl.localhost\debian-u8-1\definitely\not\here-usab'）`；容器 940×54 |
| **主句未受影响** | 主句仍是人话「**列目录失败（/definitely/not/here-usab）**」+ 「重试」；面板高度仍 900（布局未破） |

- 该失败态现有 **3 个折叠**：`技术细节（host 原文）` / `最近目录` / `诊断信息（与 wsl_status 同源）`，**默认全收起**。
- **N5 顺带核对**：底栏 `· ·` 双分隔符 **`doubleSeparator=false`** ⇒ 已修复。
- 结论：与 T40 的 N3（当时 host 原文在**主视线**、与主句同块）相比，**本轮为修复后且首度自证**。

### 1.4 **M6 / M7 / M10 / M11 / M12④**

| 项 | 结论 | 读数 |
|---|---|---|
| **M6**（状态机：loading 不误报 + error 撤事实） | ✅ **已实现且已验证** | loading（延迟夹具）：「…**网络较慢，仍在读取…**　远端守护状态未知 · 状态读取中…」，`hasFalseFailure=false`；error（路由 reject）：`entryRows=0`、`daemonFactShown=false`、`retryPresent=true`（**事实撤下 + 有重试**） |
| **M7**（空态必须有下一步） | ✅ **已实现且已验证** | ⚠️ 首测用 `distros:[]` 夹具 **不适用**（新 IA 已无发行版列表 ⇒ 夹具未生效，记 `FIXTURE-NOT-APPLIED`，**该次结论作废**）；改用 **listDir→空** 夹具复测：条目 0，提示「**该目录没有非隐藏条目。换一个目录，或回到 Home 重新开始。**」+ 可点「**回到 Home**」+「隐藏文件」开关 ⇒ **有下一步** |
| **M10**（多实例降级） | ✅ **已实现且已验证** | 非冲突（夹具 8731/8972）：主视线 `slot\d` 命中 **0**、无指向别槽位的按钮；**真冲突**（夹具 `running=true` + `others[]` 同槽 8962）：出现一行 **「检测到另一个实例正在使用同一槽位（8962）」**，底栏「远端守护运行中 · 会话 0 个」，主视线 `slot\d` 命中仍 **0** |
| **M11**（折叠收起时不可 Tab 到达） | ✅ **通过（弱）** | 收起时内部可聚焦元素 **0**（`verdict=PASS`）。**弱在哪**：展开后内部可聚焦元素同样是 **0**（这两个折叠的内容是纯文本）⇒ 该断言在当前内容下**不具区分力**；另 `refine-m11b` 测得收起时容器 `innerText=4`（仅摘要）⇒ 正文未渲染 |
| **M12④**（清空最近目录 ⇒ 显示空态提示） | ⚠️ **未复核** | 拦在哪：`dsh-remote-wsl.recent` 键存在且被置 `[]`（`lsKeys` 已核），但 **`details.open=true` 对 React 受控折叠不生效**（`refine-m11b`/`refine-m12b` 同现象：置 open 后内容仍不渲染，`h` 恒 37、`text` 仍只有摘要）⇒ 需**真实点击 summary** 才能读到 `recent.empty`。按 lead 的"有界收尾（只允许补 N3）"**未再开实验**。**补测成本**：1 次 trusted click，约 1 分钟 |

**附：一项判红（同类不一致仍在）**

| 项 | 结论 | 读数（`out-p05-refine-n4.json`） |
|---|---|---|
| **N4**（菜单组标注一致性） | ❌ **未实现/判红** | 第 1 组「**快捷目录**」用 `aria-label`（`ariaLabelledby=null`）；第 2/3 组（守护/诊断）用 **`aria-labelledby`** 且目标元素存在（`dsh-rw-menu-daemon` / `-diagnostics`）。同一菜单内两种标注方式 ⇒ **T42 提交信息虽列 N4，实测第一组仍为 `aria-label`** |

---

## 2. 未复核 / 未做（明确标注，不当通过）

| 项 | 拦在哪 / 说明 |
|---|---|
| **M12④ 最近目录空态提示** | 见 §1.4（React 受控折叠，需 trusted click；按有界收尾未跑） |
| **故意红（本轮）** | **未做**。拦在：上一轮在红测**之前**中断（18:38–19:02 采集后失效）；lead 本轮把范围收缩为"只补 N3"。**对照**：T40 轮已对**同一断言**（当前项形状通道）做过 A/B 红测（副本去 2px+600 ⇒ 断言 RED；字节还原绿），但那是**上一个 commit**；本轮**未复做**，故本报告不含本轮的故意红证据 |
| **API 方法表探针** | `out-p05-refine-api.json` 为空（页面内 fetch 包装未被捕获）。**间接证据**：`listDir` 夹具生效（返回 0 条目）⇒ 目录列表确实经 `*listDir*` 方法取数 |
| **dark 下的逐项数值**（除 V7 已测） | V7 已覆盖两主题；V3 只在 light 测 8 宽度（dark 的底栏读数未取）；M6/M7/M10/M11 只在 light 测 |
| **灰度截图形态** | 本轮用计算样式读数 + `CSS.forcePseudoState` 替代（更可判、可复算），未出灰度截图 |

---

## 3. 纪律核验：**用户全局存储未被本次运行改写**（`out-p05-userstorages-{before,after}.txt`）

**先如实说结论**：`before/after` 对比显示用户 `workspace.json` **确实变了**（12,058 B / `692B5265…` → 11,448 B / `6C1107D3…`）。但**归因证据指向"不是我"**：

| 证据 | 读数 | 含义 |
|---|---|---|
| 用户 `workspace.json` **mtime** | **2026-10-14 09:51:47** | 我的运行窗口 = **10-13 18:38–19:02**；改动发生在**约 15 小时后**，且其间**用户宿主重启**（19387 由 47564 → **33688**） |
| **隔离 home 自带 storages** | `%TEMP%\usab-p05-home\storages\workspace.json`（711 B，**mtime 10-13 18:44:39** = 我窗口内） | ⇒ 本轮的存储写入落到了**隔离 home**，而非用户目录（隔离生效的直接证据） |
| 用户 storages 最近改动文件 | 10-14 10:20（`session_projcache` 若干） | 是本会话宿主的缓存写入，与我无关 |

⇒ **结论**：本轮**没有写用户全局存储**；`before→after` 的差异由**宿主重启前后的用户侧/宿主侧活动**解释（`mtime` 与我的窗口不重叠 + 隔离 home 自有 storages 两次独立佐证）。**不把 before/after 不等号单独当成"我改了"的证据**。

---

## 4. 与 T40 的差异（面板此后经过 T41 拆 chunk + T42 六条修法）

| 维度 | T40（`63320b4`） | 本轮（`4699876` / UX 主体 `d681599`） |
|---|---|---|
| chunk 数 | 9（`client.panel.js` 单体 + 8 其它） | **9**（面板已拆 6 个：`panel.js` 9.8KB + `actions/browser/header/helpers/tail`，入口 28KB） |
| `⋯` 命中区 | 5/8 宽度 **16–21×24**（我判红 V1） | **8/8 宽度 24×24** ✅ |
| 底栏高度 | **55px**（我记 N2：与规格 36 不符） | **47px**（T42 `box-sizing` 后） |
| 状态点 | — | 两态外径恒 8（T46 已验，本轮未复测） |
| N3（host 原文） | 主视线同块暴露（我记 N3） | **收进 `技术细节（host 原文）` 折叠** ✅ 本轮自证 closed/open |
| N5（双分隔符） | 存在 | **不存在** ✅ |
| N1（窄态双入口） | 320 下「添加为 WSL 工作区」头部+菜单双入口 | T42 修（本轮**未复测**该校验点，记为未复核） |
| 组标题取色 | 层次冲突风险 | **`label-primary`**（T46 实测 5.55:1） |
| N4（组标注一致性） | 未覆盖 | **仍判红**（第 1 组 `aria-label`） |

---

## 5. 交付与证据索引（`p05-final/`）

| 文件 | 内容 |
|---|---|
| `out-p05-integrity.json` | 9 chunk 逐字节前缀对照 + 页面 row rev |
| `out-p05-probe.json` | 面板类名清单、2 个 `details`（ready 态）、localStorage 键 |
| `out-p05-v3.json` | V3 八宽度全量读数（含逐子元素） |
| `out-p05-v7.json` | V7 两主题 × 三背景 hover + 形状通道 + 强制静息填充 + 菜单读数 |
| `out-p05-n3.json` | N3 closed/open 读数 + N5 |
| `out-p05-m6.json` / `out-p05-m7.json` / `out-p05-m10.json` / `out-p05-m11.json` / `out-p05-m12.json` | M6/M7/M10/M11/M12 首次读数（M7 首测夹具失效已标注） |
| `out-p05-refine-{m7,m10c,m11b,m12b,n4,api}.json` | 定向补测：真空目录 / 真冲突 / 折叠可见性 / 最近目录空态 / 组标注 / API 探针 |
| `v3-320-footer.png`、`v7-menu-{light,dark}.png`、`n3-details-open.png` | 3 张现场截图 |
| （根目录）`out-p05-pristine-{dumpconfig,url,8961.log,.log.err,.pid}.txt`、`out-p05-userstorages-{before,after}.txt` | 实例与存储对照 |

脚本（可复跑，均在我写作用域内，未碰 `client/**`）：`p05-boot.ps1`（**孤立 DSH_HOME** + Hidden 起实例）、`p05-verify.ts`、`p05-refine.ts`。

---

## 6. 一句话结论

**前置两条证明通过**（门禁 exit 0；9/9 chunk == 磁盘，平台追加 `;`）；
**已验证**：V3（8/8 宽度真改视口、47px、单行、状态词不省略、`⋯` 处处 24×24）、V7/M17（两主题 × 三背景 hover 均变、当前项 2px+600、**强制静息填充后仍可分辨**）、N3（折叠 closed/open 自证，主句与布局未破）、N5、M6、M7、M10（含真冲突横幅）、M11（弱通过）；
**未复核**：M12④（React 受控折叠需 trusted click）、本轮的**故意红**（上轮中断 + 本轮有界收尾）、dark 除 V7 外的逐项数值；
**判红**：N4（`快捷目录` 组仍用 `aria-label`，与另两组的 `aria-labelledby` 不一致）；
**纪律**：用户全局存储**未被本轮改写**（mtime 10-14 09:51 在我窗口之外 + 隔离 home 自有 `storages/workspace.json` 于 10-13 18:44 写入）。
