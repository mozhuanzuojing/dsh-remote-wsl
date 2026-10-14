# REPORT —— T53：N4 组标注对账（菜单三组统一 `aria-labelledby`）

- **日期**：2026-10-14 ｜ **作者**：`visual-designer`（接手 `stability-engineer` 的未完成项）｜ **状态**：对账完成 + 一行修复 + 红/绿双向验收通过
- **来源**：T50 独立复验判红（证据 `usability/p05-final/out-p05-refine-n4.json`），交付面 = 本报告。
- **改动**（2 个文件，11 增 1 删）：
  - `client/client.panel.tail.js`：菜单组标题去掉误导性 `role: "presentation"`（**唯一有效改动**，1 行；+5 行注释）
  - `client/index.js`：**入口 bump**（改 chunk 必须动入口，见 `docs/client-contract.md §11`；+5 行注释）
  - rev：`de709fee59c0` → **`59faf7156bc2`**（entry size 28,727 → 29,194）
- **一句话结论**：**N4 的判红是"读数范围"造成的 —— T50 的查询是 `document.querySelectorAll('[role="group"]')`（全文档），把浏览器卡片里的 chips 行当成了"菜单第 1 组"。`⋯` 菜单里根本没有「快捷目录」组，三组早已统一 `aria-labelledby`。** 我没有为了让它"看起来一致"而硬改菜单，而是：① 把这条范围钉死写成**能红的断言**（`tools/menu-grouplabel-audit.mjs`）；② 修掉同一元素上**真正**与规格不符的一处（`role="presentation"`）。

---

## 0. 结论（先看这张）

| 验收项 | 结果 | 证据 |
|---|---|---|
| ① 三组属性读数一致 | ✅ **菜单内三组 100% `aria-labelledby` 且目标存在**；面板内唯一的 `aria-label` 组是 chips 行（**已登记例外 + 可判理由**） | §1 §2 |
| ② 故意红 + 字节还原 | ✅ RED-1（菜单组改回 `aria-label`）**3 FAIL / exit 1**；RED-2（标题加回 `role=presentation`）**1 FAIL / exit 1**；还原后 sha256 相同 ⇒ **12 PASS / exit 0** | §3 |
| ③ 改 `client/**` ⇒ bump 入口 | ✅ `check-client-rev` **PASS / exit 0**，且它自己打印"chunk 有变化，但入口元数据更新 ⇒ rev 已换 ⇒ 缓存 URL 已失效" | §4 |
| ④ 回归 | ✅ smoke **16/16** · `css-token-audit` **exit 0** · CJK 剥注释 **0** · 菜单**不遮**底栏状态词（交集 **0**）· 组标题**不进 Tab 序列**（`tabIndex=-1`） | §5 |
| ⑤ 两栏 + 未复核 | ✅ | §6 |

---

## 1. 先定位：渲染在哪个 chunk（任务要求写明）

| 元素 | 文件 | 行 | 属性 |
|---|---|---|---|
| **`⋯` 菜单容器** | `client/client.panel.tail.js` | 300 | `role="menu"` + `aria-label={t("menu.more")}`（容器自身的名字，与本条无关） |
| **菜单组容器** | `client/client.panel.tail.js` | 309 | `role="group"` + **`aria-labelledby={labelId}`**，`labelId = \`dsh-rw-menu-${group.key}\`` |
| **菜单组标题** | `client/client.panel.tail.js` | 310（改后） | `<div id={labelId} className="dsh-rw-grouplabel" tabIndex={-1}>` |
| **「快捷目录」**（N4 里被当成第 1 组的那个） | `client/client.panel.browser.js` | 174 | `className="dsh-rw-toolbar" role="group" aria-label={t("browser.chipsAria")}` ← **浏览卡片的 chips 行** |

**菜单的组清单（穷举，来自 `groups.push({key:…})`）**：`workspace`（**仅** `<420px && primaryIsSession` 时出现）/ `daemon` / `diagnostics` —— **没有 `quickDirs` / 「快捷目录」**。
三组由**同一个 `groups.map(...)` 循环**渲染（`tail.js:301-328`），组容器属性、标题元素形态、分隔线处理**都在同一段代码里**，**没有任何 per-group 特例**。⇒ "三组标注不一致"在构造上不可能成立。

---

## 2. ① 属性读数：三组一致（并解释 T50 为什么读到 `aria-label`）

### 2.1 T50 的读数为什么会出现「第 1 组用 aria-label」——**范围错**

T50 的 `p05-refine.ts` 原文（`--phase n4`）：

```js
const groups = Array.from(document.querySelectorAll('[role="group"]'));   // ← 全文档！
```

⇒ 它扫到的是**文档里所有** `role="group"`，按 DOM 顺序第 1 个是**浏览卡片的 chips 行**。其证据在**它自己的 JSON 里**（`out-p05-refine-n4.json`）：

```json
{ "ariaLabel": "快捷目录", "ariaLabelledby": null, "targetExists": false, "groupText": "Home / /mnt" }
{ "ariaLabel": null, "ariaLabelledby": "dsh-rw-menu-daemon",        "targetExists": true, "targetText": "守护", "groupText": "守护 重启远端守护… 停止远端守护…" }
{ "ariaLabel": null, "ariaLabelledby": "dsh-rw-menu-diagnostics",  "targetExists": true, "targetText": "诊断", "groupText": "诊断 查看诊断信息 复制诊断摘要" }
```

- 第 1 条的 **`groupText = "Home / /mnt"`** —— 那是 **chips**（快捷目录），**不是菜单项**；菜单项长这样：`重启远端守护…`。
- 第 2/3 条才是菜单组，两者**都是 `aria-labelledby` 且目标存在**。
- ⇒ **"菜单第 1 组用 `aria-label`" 这条不成立**；真实情况是"**菜单组 100% `aria-labelledby`；面板里另有一个非菜单的 `role=group`（chips 行）用 `aria-label`**"。

### 2.2 面板内 `role="group"` 台账（穷举，`client/*.js` 全文）

| 出现点 | 形态 | 判定 |
|---|---|---|
| `client.panel.tail.js:309`（菜单组，×3 个 key） | `role="group" aria-labelledby={labelId}` | ✅ 三组一致 |
| `client.panel.browser.js:174`（chips 行） | `role="group" aria-label={t("browser.chipsAria")}` | ✅ **例外（已登记，见 §2.3）** |

### 2.2b 独立佐证：**真实例（320px）DOM 读数** —— 由 T53 的上一位 owner 产出（他随后上下文耗尽，未出报告）

本目录里有一套**不是我写的**产物：`n4-readings.js`（10:30:24）+ `n4-readings-320.json`（10:33:05）。它把作用域**正确地**限定到菜单：

```js
document.querySelectorAll('[data-dsh-remote-wsl="panel"] .dsh-rw-menu .dsh-rw-group')   // 菜单组
document.querySelectorAll('[data-dsh-remote-wsl="panel"] [role="group"]')                // 面板里其它 role=group
```

其 320px 读数（**真实例**，profile `rwsl-t53` / port 8921）与我的结论**逐条吻合**：

| 读到的东西 | 值 | 印证了什么 |
|---|---|---|
| `menuGroupCount` | **3** | 窄态三组齐全（`workspace` 出现） |
| `scopedMenuGroups[*].ariaLabelledby` | `dsh-rw-menu-workspace` / `-daemon` / `-diagnostics` | **三组 100% `aria-labelledby`** |
| `ariaLabel`（三组） | 全部 **`null`** | **菜单组里没有 `aria-label`** |
| `labelTargetExists` / `labelTargetText` / `labelTargetVisible` | 全 `true` / 「工作区」「守护」「诊断」 / 全 `true` | 目标元素存在且可见 ⇒ 三组一致 |
| `titleFocus[*].tookFocus` | 三个标题全 **`false`**，`tabIndexProp = -1` | **组标题不进 Tab 序列、不可被聚焦** |
| `otherRoleGroups` | **恰好 1 条**：`cls: dsh-rw-toolbar`、`ariaLabel: "快捷目录"`、`text: "Home / /mnt"` | **那个 `aria-label` 就是 chips 行**，且它在菜单**之外**（`otherRoleGroups` 明确与菜单组分开列） |
| `labelTargetRole` | **`"presentation"`** | **改动前**的真实 DOM 状态（我的修复点；见 §2.4） |
| `geom.menu.w` | **240** | 顺带在真实例里印证了 **T52** 的修复（T52 报告里"实例内 rect"当时列为未复核） |
| `menuOverlapsStatusWord` / `menuOverlapsFooter` | 全 **`false`** | 菜单不遮底栏状态词（与我的 harness 读数一致） |

**归属与用法说明（不许含糊）**：这两个文件是**上一位 owner 的产出**，我**没有重跑**它们；我做的只是**重读 + 交叉校验**（其结论与我的源码穷举、以及 T50 的 JSON 三方一致）。它同时是**改动前**的 DOM 快照 ⇒ **改动后的实例内 DOM 读数我仍未产出**（见 §6.2）。

### 2.3 为什么 chips 行的 `aria-label` 是**正确**的（例外成立，不硬改）

1. **它不是一个"菜单组"**：它在浏览卡片里，与 `⋯` 菜单无父子关系；"同一菜单内两种标注方式"这个前提不存在。
2. **它没有可见组标题**：视觉规格 §7.2.2 的卡片结构就是「标题行（浏览目录（distro） + 隐藏文件开关）」+「chips 行（Home / /mnt/c…）」，chips 行**故意不给标题**。
3. **按 WAI-ARIA，无可见标签的组只能用 `aria-label`**：`aria-labelledby` 的语义是"**用另一个元素的文本**当名字"，需要一个可指向的标签元素；这里没有。要"统一"就必须**新增一个可见标题「快捷目录」** ⇒ 那是**改设计**（多一行视觉元素、与卡片标题「浏览目录」语义重复），**且本插件的视觉规格与 T27 交互规格都没这么定**。⇒ 按任务给的选项，我选"**给可判理由的例外**"，不硬改。
4. **反证（如果我硬改会怎样）**：给 chips 行加可见标题后，`aria-labelledby` 指向一个**11px 的新标签行**，屏幕上会多一行"快捷目录"，与卡片标题「浏览目录（debian-u8-1）」形成**两个近义标题**；同时视觉规格 §7.2.2 需要改（不在本任务写作用域内）。**收益 0（a11y 等价）、代价 = 一处视觉回退。**

### 2.4 我在同一元素上修的**真**问题：`role="presentation"`（规格不符 + 无效声明）

改前：`<div id={labelId} className="dsh-rw-grouplabel" role="presentation" tabIndex={-1}>`

| 判据 | 结论 |
|---|---|
| **我的视觉规格**（`docs/panel-visual-spec.md` §7.2.4） | 明确写"标题是普通 `<div id>`，**不加** `role="presentation"`" ⇒ **实现与规格不符** |
| **WAI-ARIA presentational-role 冲突解决** | 带 `tabindex` 的元素**可聚焦** ⇒ `role="presentation"` **被忽略**（保持 `generic`）⇒ 这是一条**误导性 no-op**：读代码的人（以及审计脚本）会以为标题被移出了可访问性树 |
| **对读屏的实际影响** | 移除它**不改变**运行时语义（它本就被忽略）；`aria-labelledby` 仍指向该 `<div>` 的文本 |
| **一致性** | 去掉后，三组的**组容器 + 标题元素**形态完全相同（`role=group`+`aria-labelledby` / 普通 `<div id>`+`tabIndex=-1`） |

⇒ 改动 = **`role: "presentation", ` 一个片段**（1 有效行）。`tabIndex={-1}` **保留**：满足"组标题**不进 Tab 序列**"（严格意义的"完全不可聚焦"会把 `aria-labelledby` 的文本来源变成一个普通文本节点，既无必要也无收益 —— 见 §6 两栏）。

---

## 3. ② 故意红 + 字节还原（**红测只在 `%TEMP%` 副本上做**）

方法：把整个 `client/` 复制到 `%TEMP%\vd-t53-red\client`（复刻真实目录布局），在**副本**上做两次破坏，跑我写的断言；再字节还原。

| # | 破坏（副本内） | 期望 | 实测 |
|---|---|---|---|
| **RED-1** | 菜单组容器 `"aria-labelledby": labelId` → **`"aria-label": group.label`**（**正是 N4 声称的形态**） | FAIL / exit 1 | ✅ **3 条 FAIL**：`A1 菜单组容器用 aria-labelledby`（找不到）、`A1c 菜单组容器不得用 aria-label`（命中）、`A4 台账：client.panel.tail.js`（既不是菜单组也不在例外清单）⇒ **exit 1** |
| **RED-2** | 组标题重新加回 `role: "presentation"` | FAIL / exit 1 | ✅ **1 条 FAIL**：`A3b 标题不得带 role=presentation` ⇒ **exit 1** |
| **还原** | `Copy-Item` 从工作树还原副本 | 复绿 | ✅ sha256 `F5CBCF7C…` **与基线逐字节相同**；**12 PASS / 0 FAIL / exit 0** |
| 工作树 | 全程未碰 | —— | ✅ 三处 sha256 一致（副本基线 = 还原后 = 工作树 `F5CBCF7C4820016CA98C399E2ACA227D0F08E7DD917B2F657F4EF4550B67A2B3`） |

**断言清单**（`tools/menu-grouplabel-audit.mjs`，12 条，`--json` 可机读）：

| ID | 断言 |
|---|---|
| A1 | 菜单渲染段里组容器必须是 `role:"group"` + `aria-labelledby:<var>` |
| A1b | 标题 id 必须由 `group.key` 派生（`dsh-rw-menu-${group.key}`）⇒ 三组各有唯一目标 |
| A1c | 菜单段内**不得**出现 `role:"group" … "aria-label"` |
| A2 / A2b | `groups.push({key:…})` 的每个 key 都必须有对应的标题 id 路径 |
| A3a–A3e | 标题：有 `id` · **无** `role="presentation"` · **无** `aria-hidden` · `tabIndex` 缺省或 ≤ -1（**不进 Tab**）· 无 `onClick/onKeyDown`（**不是交互元素**） |
| A4 | 面板内**每个** `role="group"` 要么是菜单组，要么在**显式例外清单**里（每条带理由） ⇒ 将来"悄悄换一种标注"会直接判红 |

---

## 4. ③ 入口 rev 已 bump

```
client-rev 门禁：PASS（模式=git）
  入口     : client/index.js   当前 rev : 59faf7156bc2   [size=29194]
  chunks   : 9 个（client.panel.tail.js = f5cbcf7c ← 本次改动）
  依据     : chunk 有变化，但入口元数据更新（02:38:47.450Z > 02:37:48.839Z）⇒ rev 已换 ⇒ 缓存 URL 已失效
exit=0
```

**为什么必须动入口**：平台的 `rev` = **入口文件的元数据哈希**，chunk URL 用入口 rev 且带 `immutable`；只改 chunk 不动入口 ⇒ 浏览器最长一年不再取新字节（`docs/client-contract.md §11`）。本次改的是 **chunk**（`client.panel.tail.js`）⇒ 必须让入口再变一次。做法：在 `client/index.js` 头部加 5 行 **bump 记录**（说明本次改了什么、为什么动入口）—— 与仓库既有风格一致，且**可审计**（diff 里能看到 bump 的原因，而不是一个空 `touch`）。

---

## 5. ④ 回归

| 检查 | 命令 | 结果 |
|---|---|---|
| 装载 + 渲染冒烟 | `arch-t6/tools/panel-smoke-node.mjs <根>` | ✅ **16/16 PASS**（`client.panel.tail.js` 现 344 行） |
| token 闭集 / 硬编码色 | `visual/tools/css-token-audit.mjs client/index.js` | ✅ `C1=0` / `C2 token ⊆ 17 = PASS` / `S1 label-dimmed 域 = OK` ⇒ **exit 0** |
| CJK 剥注释 | 自算 + `tools/extract-css.mjs` | ✅ CSS 数组内 19 行含 CJK **且全部是 `//` 注释**；抠出的 CSS 含 CJK **0 行** |
| 菜单**不遮**底栏状态词 | 真实 Chromium 布局 harness（`harness-layout-n4.html`，复刻"菜单是 `position:relative` footer 的子节点"） | ✅ `overlapWithStatusWordArea = **0**`；`menuWidth = 240`；`menuCoversBorder = menuCoversTrigger = false` |
| 组标题**不进 Tab 序列** | 断言 A3d（`tabIndex=-1`）+ T50 数据（三组标题 `tabIndex` 均为 -1） | ✅ |
| 组标注一致性 | `tools/menu-grouplabel-audit.mjs` | ✅ **12 PASS / 0 FAIL / exit 0** |

**布局 harness 原始读数**（真实 Chromium，`file://` + MCP 已有 headless 实例）：

```json
{"kind":"layout","menuWidth":240,"menuHeight":125,"menuBottom":1985,"footerTop":1988,
 "gapMenuBottomToFooterTop":3,"statusWordRect":{"left":28,"top":2002,"right":119,"bottom":2022},
 "overlapWithStatusWordArea":0,"menuCoversTrigger":false,"viewport":{"w":1869,"h":2035}}
```

---

## 6. ⑤ 两栏（规格 vs 实现）+ 未复核

### 6.1 两栏

| 维度 | **规格**（`docs/panel-visual-spec.md` §7.2.4 / T27 §3.2） | **实现**（改后） | 一致？ |
|---|---|---|---|
| 三组标注 | 组容器 `role="group" aria-labelledby=<组标题 id>`；**禁止** `aria-label` | 三组同走一个 `groups.map`，`aria-labelledby={labelId}` | ✅ |
| 组标题元素 | **普通 `<div id>`**；**不加** `role="presentation"`、不加 `aria-hidden` | `<div id={labelId} className="dsh-rw-grouplabel" tabIndex={-1}>` | ✅（本次修复点） |
| 组标题不进 Tab | "不进 Tab 顺序（`tabindex` 缺省或 `-1` 都可）" | `tabIndex={-1}` | ✅ |
| 组标题不可聚焦（严格义） | 规格允许 `-1`（= **不可 Tab 到达**） | `tabIndex={-1}` ⇒ 可被程序化聚焦、**不参与 Tab 序列** | ⚠️ 见 6.2 |
| 组集合 | 快捷目录 / 工作区（仅 <420px）/ 守护 / 诊断（**四组，非菜单内四组**） | 菜单内：`workspace`（仅 <420px）/ `daemon` / `diagnostics`；**「快捷目录」在卡片 chips 行**（不在菜单内） | ✅（语义一致，位置不同） |
| 组标题取色 | `label-primary`（Q6 定稿，两主题 ≥4.5） | `dsh-rw-grouplabel` 用 `--dsw-alias-label-primary` | ✅ |
| chips 行的组标注 | 规格未规定（§7.2.2 只说它是 chips 行） | `role="group" aria-label="快捷目录"` | ✅（无可见标题 ⇒ `aria-label` 是正确形态） |

### 6.2 未复核（不许当通过）

| 项 | 拦在哪 |
|---|---|
| **读屏器（NVDA/JAWS/VoiceOver）实际播报** | 无环境。本轮只有：源码级断言（12 条）+ 真实 Chromium 的**布局**实测 + T50 的 DOM 属性读数。**"去掉 `role="presentation"` 后读屏念出「守护 组」"这一步没有真机复核**（理由：该 role 在 `tabindex` 存在时被规范忽略 ⇒ 运行时语义不变；但这是**推理**，不是实测）。 |
| **DOM 级读数（真实例内）** | **改动前有、改动后没有**：上一位 owner 在 10:32 产出过 320px 的真实例读数（`n4-readings-320.json`，作用域正确地限定 `.dsh-rw-menu`），我已重读并交叉校验（§2.2b）；但那是**改动前**的快照（`labelTargetRole: "presentation"`）。**我没有为"改动后"再起实例复读 DOM** ⇒ 改动后的证据是：12 条源码级断言（含 A3b）+ 2 条红测 + "该 role 在 `tabindex` 存在时被规范忽略"这一条推理。**若终验要 DOM 级 after 读数**，需在 8921–8930 起一个实例重跑 `n4-readings.js`（上一位 owner 的脚本仍在本目录，可直接复用）。 |
| **`aria-label` 例外是否被审计脚本以外的工具认可** | 例外清单写在 `tools/menu-grouplabel-audit.mjs` 里（带理由）；**其它团队工具（如最终冻结清单）是否引用它**未知。**我另提议**（不在本任务写作用域内）：在 `docs/panel-visual-spec.md` §7.2.4 补一句"本条只约束 `role="menu"` 内的组容器；卡片 chips 行是**无可见标题**的组 ⇒ 用 `aria-label` 是对的"，以免下次又被当成不一致。 |
| dark 主题 | 与本条（ARIA 结构）无关；未测。 |
| `<420px` 的 `workspace` 组 | 断言覆盖了它的 key（`workspace`）与 id 路径；**未在真实例的 320px 菜单里复读 DOM**（T50 的读数里没出现该组，因为它那次的 `primaryIsSession` 为假）。 |

---

## 7. 交付物与复算入口

| 文件 | 内容 |
|---|---|
| `client/client.panel.tail.js`（改动） | 组标题去掉 `role: "presentation"`（+5 行说明） |
| `client/index.js`（改动） | 入口 bump 记录（+5 行） |
| `REPORT-n4-grouplabel.md`（本文件） | ①–⑤ + 定位 + 例外理由 + 未复核 |
| `tools/menu-grouplabel-audit.mjs` | **12 条断言**、能红、`--json` 可机读 |
| `out-04-n4-audit-green.txt` | 复绿原始输出（12 PASS / exit 0） |
| `out-05-n4-audit-red.txt` | **红测原始输出**（RED-1 3 FAIL、RED-2 1 FAIL、字节还原后复绿） |
| `out-06-panel-n4.css` / `harness-layout-n4.html` | 供复跑布局实测的 CSS 与 harness |

```powershell
$n='C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$d='D:\project\dsh1\vendor\dsh-remote-wsl'; $c="$d\spike\verify\explorer-20261012\client-panel"
& $n "$c\tools\menu-grouplabel-audit.mjs" $d                     # 期望 12 PASS / exit 0
& $n "$c\tools\menu-grouplabel-audit.mjs" $d --json              # 机读
```

---

## 8. 纪律与收尾

| 项 | 结果 |
|---|---|
| 实例 / 端口 | **我未起实例**（一条 `dsh.cmd` / `Start-Process` 都没调用）。**收尾时发现 8921–8930 段内有两个我未启动的监听者**，逐条归属如下（禁凭名字猜，给命令行+启动时间+父链）：<br>① **8921** ← pid **12944**（`DeepSeek Harness.exe`，start **10:31:16**）← 父 `cmd.exe` **21608**，其命令行逐字为 `dsh.cmd **--profile rwsl-t53** --port 8921 --no-open` ⇒ **T53 自己的测试实例（上一位 owner 起、他随后死亡）** ⇒ **由我按任务收尾要求停掉**（12944 与 21608 均已退出，端口 8921 复检**已空闲**）<br>② **8925** ← pid **15004**（`node.exe` / `serve-t42.mjs`，start **10:31:14**，父 `mise.exe` 20148）⇒ **脚本名是 t42 的、不是本次产物**，**我未停它**（跨角色物件，交给 lead 裁决）；它的日志 `out-20-serve.log{,.err}` 由同一次启动创建于本目录 ⇒ 很可能是那套 N4 读数工作流的一部分，但**归属不明确，所以不动**<br>③ **8961** = 队友的 `p05` 实例（pid 32048）⇒ **未触碰**（任务要求避开） |
| 我这一轮的 profile | **`~/.dsh/profiles/rwsl-t53` 已删**（上一位 owner 为本任务创建、start 10:31:16；删除前做了路径校验：必须严格等于 `…\.dsh\profiles\rwsl-t53`）。其它 10 个 profile（含队友的 `remote-wsl-test*`、用户的 `desktop`/`web`）**一个未动** |
| 可见窗口 | **0 个属于我**：本轮只跑 `node` 脚本 + `file://` harness；浏览器借用 **MCP 已有的 headless 实例**（不产生可见窗口），页签**已 `close_page` 关闭**，`list_pages` 复核 = **1 个 `about:blank`**（回到原状） |
| 用户宿主 19387 | **未碰**（pid **33688**，10-14 09:21:44 重启，只读报告） |
| 用户全局存储 | **未写** `~/.dsh/storages/workspace.json`；**并做了前后 sha256 对照**：before = after = `A764A306D6112450120E0653014FB8DBD8CC7A77647E891A9F82881772F303A9`（**未变**）；未写 `~/.agents/**` |
| `npm/pnpm install` | **0 次** |
| 我创建的 unit / 守护 / 包装层 | **0**（`reset-failed` 无对象；**且未执行全局 `reset-failed`**，避免抹掉他人 failed 态证据） |
| 红测副本 | `%TEMP%\vd-t53-red` **已删**；`%TEMP%\vd-*` 残留复核 = **0** |
| 写作用域 | `client/client.panel.tail.js` + `client/index.js`（bump）+ `spike/verify/explorer-20261012/client-panel/**`；**未碰** `src/**`、其它 chunk、上一位 owner 的 `n4-readings.*`（只读） |

---

## 9. 补：改动**后**的真实例 DOM 读数（由 `stability-engineer` 追加，填 §6.2 留的缺口）

> 归因：本节的读数**不是** `visual-designer` 产出的 —— 他在 §6.2 明确写"**改动前有、改动后没有**"，
> 并建议"需在 8921–8930 起一个实例重跑 `n4-readings.js`（上一位 owner 的脚本仍在本目录，可直接复用）"。
> 我就是那个脚本的作者，因此按他的建议补齐。**采集脚本与改动前完全同一份**（未改），视口 320×900，
> profile `rwsl-t53-dom` / port 8921，隐藏窗口。原始读数：`n4-readings-320-after.json`。

### 9.1 与改动前逐字段对照（同一脚本、同一视口、同一状态：320px + 已进入子目录 ⇒ 三组齐全）

| 字段 | 改动前（`n4-readings-320.json`, 02:32Z） | 改动后（`n4-readings-320-after.json`, 03:31Z） | 结论 |
|---|---|---|---|
| `scopedMenuGroups[*].labelTargetRole` | **`"presentation"`**（三组） | **`null`**（三组） | ✅ **改动生效**（§2.4 的修复点，DOM 级确认） |
| `ariaLabelledby` | `dsh-rw-menu-workspace` / `-daemon` / `-diagnostics` | 同左 | 未回退 |
| `ariaLabel`（菜单组） | 全 `null` | 全 `null` | 未引入 `aria-label` |
| `labelTargetExists` / `Visible` / `Text` | true/true/工作区·守护·诊断 | 同左 | 未回退 |
| `titleFocus[*]` | 全 `tookFocus=false`, `tabIndex=-1` | 同左 | **仍未进 Tab 序列、仍不可被聚焦** |
| `otherRoleGroups` | 恰好 1 条 `dsh-rw-toolbar`（`aria-label="快捷目录"`, `Home / /mnt`） | 同左 | chips 例外不变，且仍在菜单作用域之外 |
| `geom.menu.w` / `overlapsStatusWord` / `overlapsFooter` | 240 / false / false | 240 / false / false | 菜单不遮状态词未回退（T52 亦保持） |
| `geom.footer.h` | 47 | 47 | T42/R1 未回退 |

### 9.2 两个角度的独立复现（都我自己跑的）

| 工具 | 作者 | 我的复现读数 |
|---|---|---|
| `tools/menu-grouplabel-audit.mjs`（**源码级** 12 条） | visual-designer | **PASS = 12 / FAIL = 0 / exit 0**（我独立复跑 ⇒ 他的结论可复现） |
| `tools/check-n4-menugroups.ts`（**DOM 读数级** 8 条，我新增 A2b："组标题不得带 `role=presentation`"） | stability-engineer | **8/8 PASS / exit 0**（跑改动后读数）；同一条断言跑**改动前**读数 ⇒ **A2b FAIL** ⇒ 该断言确实咬得住这次修复 |

⇒ T53 的验收现在**两个角度都闭环**：源码级（他的 12 条）+ 真实例 DOM 级（本节）。

### 9.3 本节未复核

1. **读屏器实际播报**：仍无环境（与 §6.2 同）。
2. **1280 宽态**的 DOM 读数未取（结论"同一循环 ⇒ 与宽度无关"仍是结构推论 + 320 实测）。
3. `titleFocus` 用的是"`el.focus()` 后看 `document.activeElement`"，**不是**真实 Tab 键遍历（`tabIndex=-1` 已排除 Tab 到达，但严格做法是用 `Tab`/`Shift+Tab` 逐次验证）。
