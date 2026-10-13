# REPORT —— T43 视觉规格对账（T40 实测 vs T28 规格）

- **日期**：2026-10-13 ｜ **作者**：`visual-designer`（T28 规格的作者，本次做**对账/裁决**）｜ **状态**：对账完成，规格已按结论更新
- **被对账的两侧**：
  - **实测侧**：`spike/verify/explorer-20261012/usability/p04-final/REPORT-v1v3v7-regression.md`（T40，`usability-engineer`，被测量 = **P0.4 = commit `63320b4`**）+ 其原始 JSON（`out-p04-refine-v1.json` / `-v3b.json` / `-menu320.json`）
  - **规格侧**：`docs/panel-visual-spec.md`（T28，本文件作者，1132 → 1280+ 行）
- **本轮性质**：**纯静态对账**。未起实例、未监听端口、未产生可见窗口。读取了工作区 `client/index.js`（CSS）与 `client/client.panel.js`（渲染）**仅用于定位根因**，**未改动 `client/**` 或 `src/**`**。
- **纪律**：端口 8971–8980 无监听；用户宿主 `19387` = pid **47564**（`10-10 12:25:54` 启动，未碰）；未执行 `npm/pnpm install`；未写 `~/.dsh/storages/workspace.json`；`%TEMP%` 夹具已删（§7）。
- **一句话结论**：**底栏 55 与 36 都是错的 —— 定稿 47**（规格的 36 与自己的 ≥24×24 约束互斥；实现的 55 是 `content-box` 把 36 当内容高，多出 19px）；**命中区规格是对的（≥24×24），实现在 3 处违规**；**组标题规格门槛偏低，必须换 token（`label-secondary` → `label-primary`）**。

---

## 0. 三条裁定（先看这张）

| # | 事项 | 裁定 | 谁错 |
|---|---|---|---|
| **R1** | **底栏高 55（实测） vs 36（规格）** | **两个值都错；定稿 `47px`** —— `H = max(子元素) + 2×padding + border-top = 28 + 9×2 + 1` | **规格错**（36 与本规格自己的 ≥24×24 命中区 + 9px 内边距 + 1px 描边**互斥**，最小可行 43）**＋ 实现错**（`box-sizing` 把 36 当内容高 ⇒ 55，比"框架允许"还多 19px） |
| **R2** | **命中区最小尺寸** | **规格写的是「参与点击的元素宽高均 ≥24×24」（WCAG 2.2 SC 2.5.8 AA）**；**明确不要求 `⋯` ≥32×32**（32 非任何标准阈值）。实测 **3 处违规**：行内动作 16×16、`⋯` 5/8 档 16–21×24、chip `/` 22.7×24 | **规格不够可判**（原 §3.4 只写"命中盒 24×24"，没说适用元素/豁免/断言）**＋ 实现错**（三处） |
| **R3** | **菜单组标题取色** | **门槛按 lead Q6 提高到两主题各 ≥4.5:1** ⇒ 闭集里**只有 `label-primary` 达标（15.97 / 5.55）**；`label-secondary` 是 4.90 / **3.85**（dark 不达标）⇒ **必须换 token**；层级改由 **4 条非颜色线索**承担 | **规格错**（原文按 ≥3:1 判，且已写了 `←S`）**＋ 实现**（当前实现就是 `label-secondary`，5 处待改 1 处取色） |

---

## 1. R1 —— 底栏 55 vs 36：判定与定稿

### 1.1 一个根因解释全部现象（不是孤例）

**根因**：本插件的 CSS 在"声明尺寸 + `padding`/`border`"的规则上，**只有 3 条显式写了 `box-sizing:border-box`**（`.dsh-rw-row` / `.dsh-rw-recent-row` / `.dsh-rw-menuitem`）；**宿主 DSH 没有全局重置**（`app.asar` 里 235 处 `box-sizing:border-box` 全是**逐组件 class 形态**；`probe-host-universal-reset.mjs` 复查了 3 处形如 `*{…}` 的命中，均无法证明作用于本面板）。于是：

| 元素 | 是否吃到 border-box | 声明 | 实际渲染 | 实测佐证 |
|---|---|---|---|---|
| `.dsh-rw-btn`（`<button>`） | ✅（表单控件有兜底） | `height:28;padding:4px;border:1px` | **28** | T40：头部主按钮 **132.3×28** ✅ |
| `.dsh-rw-chip`（`<button>`） | ✅ | `height:24;padding:0 8px;border:1px` | **24** | T40：chips **43.9–55.6×24** ✅ |
| `.dsh-rw-menu`（`<div>`，只声明 width） | ——（无 padding） | `width:240` | 240 | T40 菜单宽 240 ✅ |
| **`.dsh-rw-status`（`<footer>`）** | ❌ **无兜底** | `height:36;padding:9px 12px;border-top:1px` | **55** | T40：`footerH` 恒 **55**（8 档宽度）✅ |
| **`.dsh-rw-dot`（`<span>`）** | ❌ 无兜底 | `width/height:8` + 空心态 `border:1.5px` | 空心态 **10–11**（≠ 实心态 8） | T40：320 态子元素「状态点 **10×10**」✅ |

⇒ **55 完全由 `36 + 18 + 1` 解释**（`out-08-box-sizing-audit.txt` 的差额列 +19）。**它不是"24px 命中区 + 内边距 + 描边"的必然结果** —— 命中区是 **24**，而撑高底栏的是 **`启动守护` 次按钮的 28px**（T40 实测 `52×28`）。

### 1.2 我的 36 是怎么来的（推导 + 错在哪）

```
旧规格推导（错）:  H = 行高 18 + padding 9×2 = 36        ← 把底栏当成"一行纯文本"
正确推导:          H = max(子元素高) + padding×2 + border-top
                      = max(点 8, 状态词 20, 附加 16, 更新时间 16, 启动守护 28, ⋯ 24) + 18 + 1
                      = 28 + 18 + 1 = 47
```

**错因**：我在 §6.1/§7.2.3 里把底栏当纯文本行算，**忽略了同一张表里我自己规定的** `⋯` 24×24（§7.2.3）与 `启动守护` 高 28（§7.2.3）。
**自检证据**：36 与本规格的 ≥24×24 命中区约束**互斥** —— 即使把底栏所有按钮都压到 24，也需要 `24+18+1 = 43 > 36`。**所以 36 不是"偏小"，而是不可达。**

### 1.3 定稿与改法（**只出规格结论，不动代码**）

**定稿 `47px`**，写法：

```css
.dsh-rw-status{
  box-sizing: border-box;     /* ← 关键：与 .dsh-rw-row / -recent-row / -menuitem 的既有写法一致 */
  height: 47px;               /* 28(启动守护) + 9×2(padding) + 1(border-top) */
  padding: 9px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  /* …其余不变（FC 填充 / flex / gap:8 / position:relative / box-shadow:none） */
}
```

| 设计选择 | 理由 |
|---|---|
| **固定 `height`，不用 `min-height`** | `启动守护` 只在"未运行"态出现；若高度由内容决定，守护起停时底栏会在 **47↔43** 之间跳 **4px**（整块面板跟着抖）。**固定 47 让两态一致** |
| **保留 9px 内边距与 28px 次按钮** | 只改 `box-sizing` + `height` 两个属性，**不动任何其它规格**（按钮层级、间距阶梯、状态词不被截断三条约束全部保持） |
| **不把 `⋯` 抬到 32×32** | 见 §2.3：32 非 WCAG 阈值，且会把底栏推到 51px —— 用"抬高高度"换一个私有数字不划算 |
| **空心态状态点同时加 `box-sizing:border-box`** | 否则空心态外径 10–11 ≠ 实心态 8，**形状通道被"大小差"污染**（§4.1 规定形状是第一编码，两态外径必须相同）。**这是同一根因的第 2 个现象** |

**收益 / 代价**：55 → 47 **省 8px**（约 0.24 个列表行，可忽略）；改动 **1 条规则、2 个属性**；风险低（不影响布局语义，只影响盒子高度）；底栏进入"两态同高"。

### 1.4 一旦错了就得返工栏（R1）

| 如果结论取 … | 后果 | 返工面 |
|---|---|---|
| 取 **55**（照实测冻结） | 面板永久少 8px 列表空间；且把"content-box 失误"固化成规格，**同根因的第 2 个现象（状态点外径 10–11）会失去解释依据**，将来还会再冒 | 规格 §6.1/§7.2.3 + 两份文档的垂直预算 |
| 取 **36**（照旧规格冻结） | **不可能达成**（与 ≥24×24 命中区互斥）⇒ 实现只能把按钮压到 <24 或把 padding 压到 ≤2，**直接破坏 V1 命中区与 §3.1 间距阶梯** | 命中区规格、间距阶梯、T27 §5.3 同时返工 |
| 取 **47**（本轮定稿） | 只需改 2 个属性；垂直预算是闭合的（§6.1 已同步：条目区 636→625，**18 行不变**） | —— |

---

## 2. R2 —— 命中区最小尺寸（规格 vs 实测）

### 2.1 规格现在写的是什么（**已可判**）

`docs/panel-visual-spec.md` **§3.4.1（本轮新增）**：

> 凡**参与点击**的元素（`a` / `button` / `[role=button]` / `label` 包裹的开关 / chip），其 `getBoundingClientRect()` **宽与高都必须 ≥ 24px**。依据 **WCAG 2.2 SC 2.5.8 Target Size (Minimum) = 24×24（AA）**。

并给出：① 豁免清单（非交互元素 / `:disabled` / 整行可点时的行本身）；② **`flex` 容器内的命中盒必须 `flex:none`**；③ 可直接跑的可断言片段。

### 2.2 实测 vs 规格（T40 `out-p04-refine-v1.json`）

| 控件 | 实测 rect | 规格要求 | 判定 | 根因（静态阅读 `client/**` 定位） |
|---|---|---|---|---|
| **行内动作「进入」** | **16 × 16** | ≥24×24 | ❌ | 渲染成**裸 `.dsh-rw-link`**（`padding:0`、无最小盒、`font-size:12px/16px`）⇒ 命中盒 = 内容盒 |
| **`⋯`（破坏性动作唯一入口）** | 320→**16×24**、359/360→**21×24**、419/420→**16×24**、719/720/1280→24×24 | ≥24×24 | ❌ **5/8 档** | `.dsh-rw-iconbtn{width:24px;height:24px}` **缺 `flex:none`**；底栏是 `display:flex`，`flex-shrink:1` + `min-width:auto` 退到 SVG 内容宽 **16px** ⇒ 被压缩 |
| **chip `/`** | **22.7×24**（1280）/ **23×24**（320） | ≥24×24 | ❌（差 1.3px） | `.dsh-rw-chip` 宽度是内容驱动（单字符） |
| chips `Home`/`/mnt*` | 43.9–55.6 × 24 | ≥24×24 | ✅ | —— |
| 头部主按钮「添加为 WSL 工作区」 | 132.3 × 28 | ≥24×24 | ✅ | —— |
| 「刷新」(icon) | 24 × 24 | ≥24×24 | ✅ | `.dsh-rw-iconbtn` 未被压缩时的正确值 |
| 「隐藏文件：不显示」 | 114 × 24 | ≥24×24 | ✅ | —— |
| 列表行高 / 相邻行净距 | 32 / **18** | ≥32 / ≥4 | ✅ / ✅ | `.dsh-rw-row{box-sizing:border-box;height:32}` |

### 2.3 为什么**不**要求 `⋯` ≥32×32（明确给"不是"的理由）

| 候选门槛 | 出处 | 为什么取/不取 |
|---|---|---|
| **24×24** ← **采用** | WCAG 2.2 **SC 2.5.8（AA）** | 唯一需要引用的标准数字；与 32px 行高、24px 图标盒、间距阶梯全部自洽 |
| 32×32 | 无标准出处 | **私有数字**：会再造一条无法追溯到标准的要求，并把底栏推到 `32+18+1=51px`（多 4px 无收益） |
| 44×44 | WCAG 2.2 **SC 2.5.5（AAA）** | 与"底栏=一行 chrome"的角色冲突；本面板不做 AAA 目标 |

**误触风险的真正对策**（不是把数字抬高）：① `⋯` 与相邻控件净距 ≥8px；② 破坏性动作**二次确认 + 后果三要素**（已在 T27 §5.2）；③ 焦点环（§5.2）；④ `flex:none` 保证它在窄宽**不被压缩**（T40 的 5/8 档失效正是这条缺失）。

### 2.4 改法（规格已写，实现由 T42 做）

| 控件 | 改法 |
|---|---|
| 行内动作 | 用 `.dsh-rw-iconbtn` 式盒子：`display:inline-flex;width:24px;height:24px;justify-content:center;padding:0;flex:none`（图标仍 16×16 居中） |
| `⋯` | 在 `.dsh-rw-iconbtn` 上加 **`flex:none`**（一行） |
| chip | `.dsh-rw-chip` 加 **`min-width:24px;justify-content:center`** |
| 断言 | `panel.querySelectorAll('button,[role=button],a[href],label')` 过滤 `disabled/aria-disabled` 后，**不存在** `width<24 || height<24`（§3.4.1 已给片段） |

---

## 3. R3 —— 菜单组标题取色（lead Q6：门槛提高到 4.5:1）

### 3.1 候选实测（`on bg-overlay`，数据源 `out-03-contrast.txt` / `out-07-overlay-on-surfaces.txt`）

| 候选（闭集内） | light | dark | ≥4.5（AA 文本） | 结论 |
|---|---|---|---|---|
| **`label-primary`** ← **采用** | **15.97** | **5.55** | ✅ / ✅ | **唯一两主题都达标的闭集 token** |
| `label-secondary`（现状实现就是这个） | 4.90 | **3.85** | ✅ / ❌ | **dark 不达标** ⇒ 弃用 |
| `brand-primary` | 15.97 | 5.55 | ✅ / ✅ | 数值达标，但**与 `label-primary` 的 RGB 完全相同**（`#0f1115` / `#f9fafb`）⇒ **不是"第三个候选"**，没有任何区分作用 |
| `label-dimmed` | 1.07 | 1.65 | ❌ / ❌ | 且 §1.2 已禁用其非豁免用途 |
| `state-warn-primary` | 2.15 | 7.31 | ❌ / ✅ | light 不达标 |
| `state-error-primary` | 4.50 | 4.24 | ✅ / ❌ | dark 差 0.26 |
| `state-success-primary` | 2.28 | 6.89 | ❌ / ✅ | light 不达标 |
| `state-idle-primary` | 1.48 | 2.10 | ❌ / ❌ | 不达标 |

### 3.2 方案：换 token，层级改由**非颜色**承担

```css
.dsh-rw-grouplabel{
  color: var(--dsw-alias-label-primary);  /* ← 唯一改动（原 label-secondary） */
  font-size: 11px; line-height: 16px; font-weight: 400;
  padding: 4px 8px 2px;
  /* 非颜色层级线索：不进 Tab / 不响应 hover / 无填充 / 字号比菜单项小 2px */
}
```

| 层级线索（**全部与颜色无关**） | 与 `menuitem` 的差异 |
|---|---|
| ① 字号 **11px**（menu item 13px） | −2px，灰度/色盲/两主题一致 |
| ② **不进 Tab 顺序**（`tabindex` 缺省或 `-1`） | 键盘用户越不过它（它不是控件） |
| ③ **不响应 hover**（无 hover 填充） | 鼠标用户不会误以为可点 |
| ④ **无填充/无描边** | 它是一行标签，不是一行控件 |

### 3.3 被否的替代方案（记录代价，避免以后重开）

把组标题所在行**加一层填充**（如 `bg-layer-1`）⇒ `label-secondary` 在该底上变成 **5.80 / 10.42** ✅✅，可保住"更弱的观感"。
**为什么否掉**：① 那是在 `F3`（浮层）里再加一层填充，违反 §2.2 规则 3「最多两层填充」；② 会给菜单插一条与本规格无关的色带（light 下白条压在灰蓝浮层上、dark 下深条压在浅灰浮层上），**改变浮层观感**；③ 为 11px 标签引入结构性例外不划算 —— **层级需求已由 §3.2 的 4 条线索满足，不需要再用颜色买**。

### 3.4 附加约束（lead 要求保留，**不是** 4.5:1 的替代）

> **组标题不得承载"唯一行动信息"**：组标题只做分组命名；任何"要用户做的事"必须落在**同组内的 `menuitem`** 或常显区域上。
> **验收**：删掉全部组标题文本后，用户仍能完成每组内的动作（组内 `menuitem` 的文本/`aria-label` 自足）。

---

## 4. 其它 T40 发现的对账（N1–N6 + 状态点）

| # | T40 现象 | T28 规格原文 | 实测 | 判责 | 处置（规格侧） |
|---|---|---|---|---|---|
| **N1** | 320px 下「添加为 WSL 工作区」**同时在头部与菜单工作区组** | §7.3 明写 `<420px` 头部只剩「主按钮+刷新」，动作进菜单 | 双入口 | **实现错**（1 处条件渲染） | **§7.3 新增规则 4**：「同一动作不得在两个常驻位置同时出现」+ 明确**从头部移除**（而非菜单不列）+ 可判断言 |
| **N2** | 底栏 55 vs 规格 36 | §6.1/§7.2.3 | 55 | **规格错 + 实现错** | 见 §1（定稿 **47**） |
| **N3** | `列目录失败` 主句是人话，但同块紧跟 host 原文（`\\wsl.localhost\…`、重复 `ENOENT`） | §4.3 只规定"错误块的描边/标题取色"；**未规定**正文与 host 原文的分层 | 主视线出现 UNC 路径与重复错误码 | **实现错**（呈现层）；**规格缺一条**（未规定正文/详情分层） | 视觉侧对账（**lead T43 裁决：留在 client 面**，按 T36 已定的模式，不推给 T27）：**错误块正文 = `T2`（`label-secondary`）一句人话；host 原文进同块的 `<details>` 折叠**（摘要 `T2`、12px、无框无填充、不进 Tab 死停点，与 §7.2.5 同规）。**已在 §6.3 落成规格条目** |
| **N3'** | 同上，归属说明 | —— | —— | **不由 T27 承担** | lead 2026-10-13 裁决：N3 属 **client 侧呈现**（T36 已定"主句人话 + 原文进折叠"的模式），T43 报告初稿把它记为"归属 T27"**已更正** |
| **N4** | 菜单 `快捷目录` 用 `aria-label`，其余组用 `aria-labelledby` | §7.2.4 原文含糊：`role="presentation"` **或** `aria-hidden` + `aria-labelledby` | 两种标注混用 | **规格含糊（本文错）+ 实现混用** | **§7.2.4 已统一**：组标题是**普通 `<div id>`**（**不加** `role="presentation"`、不加 `aria-hidden` —— 它是 `aria-labelledby` 的**文本来源**）；组容器 `role=group aria-labelledby=<id>`；**禁止 `aria-label`**（会与可见文本成为两份真相） |
| **N5** | 加载态底栏 `远端守护状态未知 · · 状态读取中…` 出现**两个 `·`** | 规格未规定分隔符归属 | 双 `·` | **规格缺一条 + 实现错** | **§7.2.3 已加**：底栏可见文本里 `·` **≤1**，唯一来源是"附加信息 span"的前导 `· `（漂移标记/时间戳都不自带）。断言：`footer.textContent.match(/·/g)?.length ?? 0 <= 1` |
| **N6** | chips `/` 22.7×24；`⋯` 5/8 档 <24 宽 | §3.4「命中盒 24×24」（不够可判） | 见 §2.2 | **规格不够可判 + 实现错** | 见 §2（§3.4.1 新增 + 三处改法） |
| **补** | 320 态状态点 **10×10**（实心态应为 8×8） | §7.2.3 写"8×8"（**未写外径口径**） | 空心态外径 10–11 ≠ 实心态 8 | **规格缺一条 + 实现错（同根因）** | **§7.2.3 已加**：状态点 `box-sizing:border-box`，**两态外径恒 8×8** |

---

## 5. 判责汇总（规格错 / 实现错 / 两者都要改）+ 返工栏

| 条目 | 规格错？ | 实现错？ | 一旦冻结错值的返工面 |
|---|---|---|---|
| 底栏高度 55/36 → **47** | ✅（36 不可达） | ✅（content-box 放大 19px） | 两份文档的垂直预算 + 3 条底栏验收 |
| 状态点外径（8 vs 10–11） | ✅（未写口径） | ✅（缺 `box-sizing`） | §4.1 形状编码、灰度复核 |
| 命中区最小尺寸 | 🟡（原文不够可判） | ✅（3 处） | V1 验收、T27 §5.3、行高与图标盒 |
| chip 宽度 | 🟡（未写宽度） | ✅（22.7） | 同上 |
| `box-sizing` 系统性约束 | ✅（**本文从未写这条**，是本次最大收获） | 🟡（3 条已写 / 2 条该写没写） | **所有** `height+padding` 规则（未来新增的也会踩） |
| 组标题取色 | ✅（门槛 3:1 偏低） | 🟡（照规格实现） | 菜单可读性（dark 3.85）+ Q6 验收 |
| 组标题 aria 形态 | ✅（表述含糊） | ✅（N4 混用） | §7.2.4 + 读屏一致性 |
| 底栏分隔符唯一性 | ✅（未规定） | ✅（N5） | loading 态文案 |
| 动作双入口（N1） | ❌ | ✅ | §7.3 规则 4 |
| N3（host 原文） | ✅（未规定分层） | ✅ | §6.3（**client 侧**；按 T36 模式，不推给 T27） |

**判据口径**：**规格错 = 我的文档里给不出可判的、或与自身其它条目矛盾的；实现错 = 已给定可判条目但实现没做到。** 本轮 9 条里 **4 条规格错、1 条规格含糊、1 条规格缺、8 条实现错**（有重叠）。

### 5.1 顺带确认：其余部分已合规（不是只有问题）

同一次门禁复跑（`out-08-box-sizing-audit.txt` 的 D 段）证明实现**在闭集与阴影上完全达标**：

```
rules = 95   distinct --dsw-* vars = 17   ← 恰好等于闭集，C2 = PASS
C1 hardcoded colors  = 0                  ← PASS
C1 shadow 豁免 = 2  (@14147 α=0.080, @15230 α=0.160)  ← 恰好是 §2.4 的两个规范值（菜单 .08 / 确认层 .16）
S1 label-dimmed 域 = OK（只用于 :disabled/::placeholder）
```

---

## 6. 对账脚本（用法 + 正/负输出）

### 6.1 `tools/box-sizing-audit.mjs`（本轮新增）

```powershell
$node = 'C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node spike\verify\explorer-20261012\visual\tools\box-sizing-audit.mjs `
    client\index.js dsh-rw- --host='C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'
```

**正向（真实现，`out-08` A 段）**：

```
.dsh-rw-status   footer  声明 36  → 渲染 55  (+19)  **真陷阱（<footer> 无兜底）**
.dsh-rw-btn      button  声明 28  → 渲染 38  (+10)  候选（<button> UA 兜底，需实测）→ 实测 28 ⇒ OK
.dsh-rw-chip     button  声明 24  → 渲染 26  (+2)   候选 → 实测 24 ⇒ OK
.dsh-rw-row / -recent-row / -menuitem            OK(显式 border-box)
真陷阱条数 = 1   候选 = 2
```

**负向夹具（B 段，构造必红）**：`.dsh-rw-neg{height:20px;padding:4px;border-top:1px …}` → `声明 20 → 渲染 29 (+9)  **真陷阱**`，`真陷阱条数 = 1`。
**正向夹具（C 段，构造必绿）**：同尺寸 + `box-sizing:border-box` → `真陷阱条数 = 0`、`OK(显式 border-box)`。

⇒ **脚本能红也能绿**（不是"永远报 OK"）。

### 6.2 其它对账脚本（已存在于前几轮，本轮复用）

| 脚本 | 本轮用途 | 关键输出 |
|---|---|---|
| `tools/contrast-check.mjs` | 组标题候选对比度、底栏/浮层各组的实测 | 58 组；`label-primary` on `bg-overlay` = 15.97/5.55；`label-secondary` = 4.90/**3.85** |
| `tools/css-token-audit.mjs` | 复核实现是否仍在闭集内 + 硬编码色 = 0 | 17 token / C1=0 / C2=PASS / **exit 0** |
| `tools/probe-host-universal-reset.mjs` | 复查"宿主是否有全局 `box-sizing` 重置" | 3 处形如 `*{…}` 的命中**均无法证明作用于本面板**（前文取证见 `out-09`） |

---

## 7. 收尾、纪律与自造物

| 项 | 结果 |
|---|---|
| 实例 / 端口 | **未起实例**；`Get-NetTCPConnection -State Listen` 查 8971–8980 **无监听者** |
| 可见窗口 | **0 个属于我**（本轮未调用任何启动类工具；全程只读文件 + 跑 Node 脚本） |
| 用户宿主 | `19387` 监听 pid **47564**，`StartTime = 2026-10-10 12:25:54`（任务窗之前就在跑，未碰）；未触碰 47604 |
| WSL 侧 unit / 守护 / profile | **0 个**（本轮全在 Windows 侧静态对账，未调用 `wsl.exe` / `dsh.cmd`）。宿主 shell 无 `systemctl`；**刻意不执行全局 `reset-failed`**（会抹掉其它在校验角色的 failed 态证据），且我本就没建 unit |
| `%TEMP%` | `vd-t43-fixtures`（脚本正/负夹具）**已删**；`vd-*` 残留 = 空 |
| `~/.dsh/storages/workspace.json` | **未触碰** |
| `npm/pnpm install` | **0 次** |
| 写作用域 | 仅 `docs/panel-visual-spec.md` + `spike/verify/explorer-20261012/visual/**`；**未改** `client/**`、`src/**`、`package.json`、`docs/panel-ux-redesign.md`（`client/**` 只被**读取**用于定位根因） |
| 本轮新增自造物 | `tools/box-sizing-audit.mjs`、`tools/probe-host-universal-reset.mjs`、`out-08-box-sizing-audit.txt`、`out-09-host-universal-reset.txt`、本报告 |

---

## 8. 规格文件的改动 diff（只列改动的条目）

| # | 位置 | 改动前 | 改动后 |
|---|---|---|---|
| 1 | §6.1 高度预算 | `底栏 36px`；条目区 `636px` | **`底栏 47px`**（公式 `28+9×2+1`）；条目区 **625px**（18 行不变） |
| 2 | §7.2.3 容器 | `高 36，padding:9px 12px…` | **`高 47 + box-sizing:border-box`**，并新增"底栏高度的推导与定稿"三行表（36 错 / 55 错 / 47 定稿） |
| 3 | §7.2.3 状态点 | `8×8，border-radius:50%…` | **`box-sizing:border-box`；外径恒 `8×8`（两态一致）** + 为什么 |
| 4 | §7.2.3 附加信息 span | 文案 `「· 会话 {N} 个」…` | 文案去掉内嵌 `·`，改为**前导分隔符由本 span 唯一提供** + 新增"分隔符唯一性"规则与断言 |
| 5 | §7.2.3 底栏 `⋯` | `24×24…` | **`24×24 + flex:none`**（T43 实测依据） |
| 6 | §7.2.3 验收 | 不换行 / 状态词不省略 | 追加 **底栏高度 = 47**（8 宽度 × 2 守护态） |
| 7 | **§3.4.1（新增）** | —— | 命中区最小尺寸 **≥24×24** 全文唯一口径 + 豁免清单 + `flex:none` 要求 + 可断言片段 + **明确不要求 32×32 的理由** |
| 8 | **§3.4.2（新增）** | —— | **`height/width` + `padding/border` ⇒ 必须显式 `box-sizing:border-box`** + 宿主无全局重置的证据表 |
| 9 | §7.2.2 chips | `高 24，gap:6，flex-wrap…` | **+ `min-width:24px` + `justify-content:center`** |
| 10 | §7.2.2 行内动作 | `**24×24**（图标 16×16）` | **≥24×24 命中盒（图标 16×16 居中）；禁止裸 `.dsh-rw-link`** + 实测依据 |
| 11 | §7.2.4 组标题 | `11px/16、←S、…role="presentation" 或 aria-hidden` | **`←P`（`label-primary`）**、普通 `<div id>`（不加 `role="presentation"`/`aria-hidden`）、组容器 `role=group aria-labelledby`、**禁用 `aria-label`** |
| 12 | §7.2.4 组集合与键 | 3 组（工作区/守护/诊断） | **4 组**（快捷目录/工作区/守护/诊断）+ 4 个 `menu.group.*` 键 + "T43 实测 1280=3 组 / 320=4 组" |
| 13 | **§7.2.4.1（新增）** | —— | 组标题对比度定稿表（8 个候选，只有 `label-primary` 两主题达标）+ 被否替代方案（加填充档）的代价 + "不得承载唯一行动信息"约束 |
| 14 | §7.2.4 `⋯` 触发 | `24×24；aria-label=…` | **`24×24 + flex:none`** |
| 15 | §7.3 规则 | 3 条 | **+ 规则 4：同一动作不得在两个常驻位置同时出现**（`<420px` 从头部移除「添加为工作区」）+ 为什么选"移除头部" |
| 16 | §7.3 边界验收表 | 4 条断言 | **6 条**（+ 底栏高恒 47 / `⋯` ≥24×24 / 动作不双现） |
| 17 | §8.4 | A1–A6/B1/B2/C1–C5 | **+ D1（组标题换 `label-primary`）/ D2（"加填充档保留弱色"被否）** |
| 18 | §9.5 | 5 条裁决 | **+ Q6（组标题门槛 4.5:1）**；Q2 的组集合改为 4 组；Q5 断言 4→6 条 |
| 19 | **§9.6（新增）** | —— | **T43 对账后的定稿变更表**（9 行：改动前/改动后/判责） |
| 20 | §10 | 4 条复算命令 / 8 个输出 | **5 条命令**（+ box-sizing 审计）/ **+ out-08、out-09、本报告**；工具表 + 2 个脚本 |

---

## 9. 未核实 / 不作声称

| 项 | 状态 |
|---|---|
| **dark 主题下的逐项读数**（命中区/底栏高） | T40 只出了 dark 成品截图，**未逐项读数**；本轮的 dark 结论（组标题 5.55）来自 `app.asar` 的 token 真值计算，**不是页面实测** |
| **宿主 3 处 `*{…box-sizing…}` 的作用域** | 未能证明其归属（asar 含多卷 CSS）；**本轮结论不依赖它** —— 判据是"footer 实测渲染 55"这一事实 |
| **`.dsh-rw-dot` 空心态实测 10 vs CSS 推导 11** | 差 1px 未定因（边框粗细/DPR/测量元素层级）；**不影响结论**（无论 10 还是 11 都 ≠ 实心态 8） |
| **行内动作的可见文案**（T40 记「进入」16×16） | 未复核该文案的字符构成（`16×16` 与两字 CJK 的预期宽度不符）；**不影响裁定**：命中盒小于 24 是确定的 |
| **灰度截图形态的两态区分** | 沿用 T40 的计算样式读数 + A/B 红测；**未出灰度截图** |

---

## 10. T49 —— `box-sizing-audit.mjs` 的红能力补强（按层叠生效值判定）

**结论（一句话）**：旧判据既会**漏**（`追加覆盖` 形态报假绿）也会**误**（安全方向的追加覆盖报假红）⇒ 已改为**按同一选择器的层叠生效值**（源码顺序 + `!important` + 简写/长写逐边覆盖）判定，并给出**退出码**。补强后：**4 个负向夹具全红（exit 1）、3 个正向夹具全绿（exit 0）**、**幂等**；对真实现复跑 ⇒ **真陷阱 = 1**（`.dsh-rw-menu`：声明宽 240 → 实际外框 250），**不是 0**，原因见 §10.5（新判据多看了**宽度轴**，且这是同族缺陷的真实残留）。

### 10.1 旧判据的两个盲区（都用夹具钉住，可 `--judge=old` 当场复现）

旧判据：**逐条规则独立**看"这条规则自己的声明里有没有出现过 `box-sizing:border-box`"。

| 夹具（`fixtures/`） | 生效 `box-sizing` | **旧判据** | **新判据** | 性质 |
|---|---|---|---|---|
| `neg2-append-override.css`<br>`.x{box-sizing:border-box;height:20px;padding:4px 6px;border-top:1px}`<br>`.x{box-sizing:content-box}` | **content-box**（后规则胜） | `OK(显式 border-box)` ⇒ **真陷阱 0 / exit 0** | `真陷阱（高 20→29；生效 content-box）` ⇒ **exit 1** | **假绿（漏报）** |
| `neg4-append-then-important.css`<br>`.x{box-sizing:border-box;height:20px;padding:4px}`<br>`.x{box-sizing:content-box !important}` | **content-box !important** | `OK(显式 border-box)` ⇒ **exit 0** | `真陷阱（高 20→28；生效 content-box !imp）` ⇒ **exit 1** | **假绿（漏报）** |
| `pos2-append-safe.css`<br>`.x{box-sizing:content-box;height:20px;padding:4px 6px;border-top:1px}`<br>`.x{box-sizing:border-box}` | **border-box**（后规则胜） | `**真陷阱（<div> 无兜底）**` ⇒ **exit 1** | `OK(border-box 生效)` ⇒ **exit 0** | **假红（误报）** |
| `neg1-plain-trap.css`（无 `box-sizing`） | content-box | `真陷阱` ⇒ exit 1 ✅ | `真陷阱` ⇒ exit 1 ✅ | 两边一致（对照） |
| `neg3-important-override.css`<br>`.x{box-sizing:content-box !important;…}` + `.x{box-sizing:border-box}` | content-box !important | 碰巧 `真陷阱`（**它从不建模 `!important`，只是恰好先看到没有 border-box 的那条**） | `真陷阱（生效 content-box !imp，来自 #0）` | 旧判据**结论对、机理错**（顺序一换就漏） |

**原始输出**：`out-10-redcap-old-judge.txt`（旧判据 4 个负向夹具）与 `out-11-redcap-new-judge.txt` / `out-12-redcap-ab.txt`（新判据 7 个夹具 + A/B）。
**旧判据为什么会漏**：它把"**某个声明块里出现过 `border-box`**"当成"**这个选择器最终是 border-box**"——这两个命题在"同选择器多规则 + `!important` + 简写/长写覆盖"的世界里**不等价**。

### 10.2 新判据（可判、可复算）

```
对每个选择器 S：
  1. 取**所有**选择器列表含 S 的规则，按源码顺序合并；
  2. 逐条声明入状态：!important 胜普通（与顺序无关）；同等重要性下**后出现者胜**；
     padding / border 走简写→长写的逐边覆盖（padding-top 覆盖 padding 的上边；border-top 覆盖 border 的上边）；
  3. 生效盒模型 = 状态里的 box-sizing：
       == border-box  → 安全（渲染尺寸 = 声明尺寸）；
       != border-box  → 渲染 H = 声明 H + padT+padB + borderT+borderB；
                        渲染 W = 声明 W + padL+padR + borderL+borderR；
  4. **只有 dH>0 或 dW>0 才算陷阱**（无 padding/border 时声明值 = 渲染值，不构成缺陷 —— T49 自查时这条缺失导致过报 2 条，见 §10.6）；
  5. 元素标签决定兜底：表单控件（<button> 等）由 UA 给 border-box ⇒ 记为**候选**（不判红）；
     其它元素（footer/div/span）无兜底 ⇒ **真陷阱**；
  6. 只给了 `border-width` 而没给 `border-style` ⇒ 记为**候选（样式未知 ⇒ 未必占位）**，避免脆弱断言。
退出码：真陷阱 ≥1 ⇒ **exit 1**（`--no-fail` 可关；`--strict` 把候选也算失败）。
```

**范围边界（不声称，写清以免被当成全称保证）**：
✗ 跨选择器的**优先级比较**（不同选择器互相覆盖不建模 —— 需要完整 CSS 引擎）；
✗ `@media` / `@supports` 的条件生效；
✗ 宿主或其它 `<style>` **后插入**的覆盖。
本工具只声称一条**可复算**的判据：**"同一选择器内、按源码顺序 + `!important` 的生效值"**。

### 10.3 夹具矩阵（`fixtures/`，8 个 = 5 负 + 3 正）

| 夹具 | 构造 | 期望 | 实测 |
|---|---|---|---|
| **`neg0-footer-36-t43-shape.css`** | **T43 原缺陷的逐字同形**：`height:36 + padding:9px 12px + border-top:1px`，`@tag footer` | FAIL | ✅ exit 1 —— **声明 36 → 渲染 55**，与 T40 实测逐位一致。**它让"36→55"这个根因在产品修好之后仍然可复现**，不会被"已修"掩盖 |
| `neg1-plain-trap.css` | `height:20 + padding:4px 6px + border-top:1px`，无 `box-sizing` | FAIL | ✅ exit 1（高 20→29） |
| `neg2-append-override.css` | 先 `border-box`，**追加覆盖** `content-box` | FAIL | ✅ exit 1（并回报"检测到追加覆盖 1 个"） |
| `neg3-important-override.css` | `content-box !important` 先，`border-box` 后（普通） | FAIL | ✅ exit 1（显示 `content-box !imp`，来自 #0） |
| `neg4-append-then-important.css` | 先 `border-box`，追加 `content-box !important` | FAIL | ✅ exit 1 |
| `pos1-single-borderbox.css` | 一次到位 `border-box` | PASS | ✅ exit 0 |
| `pos2-append-safe.css` | 先 `content-box`，后追加 `border-box` | PASS | ✅ exit 0（覆盖方向相反也不误报） |
| `pos3-form-control-no-boxsizing.css` | `<button>` 无 `box-sizing`（`@tag button`） | PASS（候选） | ✅ exit 0（候选 1 条） |

> 夹具用注释 pragma 声明元素标签：`/* @tag div */` / `/* @tag button */`（工具**先取 pragma 再剥注释**）。

### 10.4 幂等性

| 输入 | 连跑两次 |
|---|---|
| 真实现 `client/index.js` | `sha256` 逐字节相同 ⇒ **idempotent = True** |
| 夹具 `neg4` | 同上 ⇒ **True** |

（工具无状态、不写文件、不依赖遍历顺序；`Map` 插入序 + 显式排序。）

### 10.5 对真实现复跑：**真陷阱 = 1（不是 0）**，并说明为什么

```
SELECTOR            元素     生效box-sizing  来自  声明H 渲染H 声明W 渲染W 判定
.dsh-rw-row         button   border-box      #22   32    32    —     —     OK
.dsh-rw-btn         button   —               —     28    38    —     —     候选（<button> UA 兜底）
.dsh-rw-chip        button   —               —     24    26    —     —     候选（<button> UA 兜底）
.dsh-rw-status      footer   border-box      #73   47    47    —     —     OK   ← T43 定稿值已落地
.dsh-rw-dot         span     border-box      #74   8     8     8     8     OK   ← 两态外径口径已落地
.dsh-rw-menu        ?        —               —     —     —     240   250   **真陷阱（宽 240→250）**
.dsh-rw-menuitem    button   border-box      #86   28    28    —     —     OK
真陷阱数 = 1   候选 = 2   OK = 7   无尺寸声明(跳过) = 86
未检测到 box-sizing 的追加覆盖（每个选择器的 box-sizing 只声明一次）
```

**为什么"不是 0"**：**新判据比 T43 版多看了宽度轴**。`.dsh-rw-menu{…width:240px;…padding:4px;border:1px solid …}` 是**唯一**一条"声明了 px 尺寸、却既没有 `box-sizing`、又不是表单控件"且**真的被放大**的规则 ⇒ 外框 = 240+8+2 = **250**，而规格 §7.2.4 写的是"宽 **240px**（固定）"。

**这是真缺陷还是我在挑刺？** 判为**真、但轻**：它与 T43 的底栏是**同一族**（规格给的数字 ≠ 渲染出的盒子尺寸），修法与同族一致（一行 `box-sizing:border-box`）；可见后果极小（绝对定位 + `right:0`，外框多 10px，`240` 那条"能容纳最长项"的最小要求两种口径都满足）。
**同期已合规**：7 个选择器显式带 `box-sizing`（`crumb / dot / link / menuitem / recent-row / row / status`），其中包括 T43 定稿的 `status`（47）与 `dot`（8×8）。

**附加观察（旧判据在真实现上同时假红 + 假绿）**：同一文件用 `--judge=old` 跑，报 **3 条"真陷阱"**（`out-08` B 段）：

| 旧判据报的"陷阱" | 真相 |
|---|---|
| `.dsh-rw-icon`（16/16） | ❌ **假红**：没有 padding/border ⇒ `delta = 0`，声明值就是渲染值（新判据已用 `dH/dW>0` 排除） |
| `.dsh-rw-menusep`（1/1） | ❌ **假红**：同上（1px 分隔线，无 padding/border） |
| `.dsh-rw-menu`（宽 240） | ✅ **真**：外框 250（§10.8） |

⇒ 旧判据不是"偏保守"，而是**两个方向都不准**：漏掉追加覆盖（§10.1 的 neg2/neg4），又对无 delta 的规则误报。

**为什么不是"判据变松/变紧"造成的数字游戏**：
① 宽松方向：本判据**新增了宽度轴**、**新增了 `!important` 与覆盖建模**、**新增了"dH/dW>0 才算陷阱"这一减法**（见 §10.6）⇒ 既加了红能力也去掉了过报；
② 红能力未被牺牲：§10.1 的 4 个负向夹具在**同一版脚本**下**全部 exit 1**；
③ 0 的分母是可见的：报告逐行打印"哪个选择器的生效值是什么、来自第几条规则、是否有追加覆盖"，不是黑箱结论。

### 10.6 自查中修掉的自身缺陷（避免把工具的不精确当成产品的缺陷）

| # | 我在初版新判据里犯的错 | 现象 | 修法 |
|---|---|---|---|
| 1 | 用 **`px()` 解析"无单位的捕获组"**（正则已把 `px` 排除在捕获组外） | `--judge=old` 一行都不打印、静默全跳过 | 旧判据改用 `num1()`（`Number(m[1])`） |
| 2 | **未剥 CSS 注释** | 夹具注释里的 `.dsh-rw-btn 渲染 28 = …` 被当成选择器，与后面的规则拼成一条假规则 | 先取 `@tag` pragma，再 `replace(/\/\*[\s\S]*?\*\//g,"")` |
| 3 | 只记"**生效变化**"的 `box-sizing` | `!important` 拒绝掉的那条不计数 ⇒ neg3 的"覆盖"列显示 `—` | 记录**每一条** `box-sizing` 声明 + `won` 标记 |
| 4 | border-box 生效时仍打印"声明+padding"的渲染值 | `OK` 行显示 `20 / 29`，自相矛盾 | border-box ⇒ 渲染值 = 声明值 |
| 5 | **无 padding/border 也判陷阱** | 真实现过报 2 条（`.dsh-rw-icon` 16/16、`.dsh-rw-menusep` 1/1，两者 delta = 0） | 只有 `dH>0 || dW>0` 才算陷阱 |

> 这 5 条都是**我先看到"真实现报 3 条"这个可疑数字、再逐条查证**的结果；第 5 条修掉后剩下的 1 条经查是**真**的（§10.5）。**先怀疑工具，再怀疑产品** —— 否则会拿一个自己造出来的红去要求实现返工。

### 10.7 判据变化对照（旧 → 新）

| 维度 | 旧判据（T43） | 新判据（T49） |
|---|---|---|
| 判定粒度 | **每条规则**独立 | **每个选择器**一条结论 |
| 取值 | "声明块里是否出现过 `border-box`" | **层叠后的生效值** |
| 顺序 | 不考虑 | 源码顺序，后出现者胜 |
| `!important` | 不考虑 | 建模（胜普通声明，与顺序无关） |
| 简写/长写 | 只看 `padding` 简写 + `border`/`border-top` | `padding`/`padding-*`、`border`/`border-*`、`border-width`、`border-style`（含 `none` ⇒ 不占位） |
| 尺寸轴 | 只有高度（宽度只打印） | **高度 + 宽度**（各自 delta） |
| 是否报"覆盖" | 无 | **有**（列 + 汇总一行） |
| 退出码 | 永远 0（纯信息） | **真陷阱 ≥1 ⇒ exit 1**（可 `--no-fail`） |
| 元素兜底 | 表单控件 ⇒ 候选 | 同（+ `border-width` 无样式 ⇒ 候选） |
| 过报防护 | 无 | **`dH/dW > 0` 才算陷阱**（§10.6-5） |
| A/B 复现 | —— | `--judge=old` 可当场跑出旧结论 |

### 10.8 唯一新发现的真陷阱：`.dsh-rw-menu` 的宽度口径

| 项 | 内容 |
|---|---|
| 事实 | `.dsh-rw-menu{position:absolute;right:0;width:240px;padding:4px;border:1px solid var(--dsw-alias-border-l2);…}`，**无 `box-sizing`**，元素是 `<div>`（非表单控件 ⇒ 无 UA 兜底）⇒ 外框宽 **250** |
| 依据 | 与 T40 实测的 `.dsh-rw-status`（`<footer>`：`height:36`+`padding:9×2`+`border-top:1` ⇒ 渲染 **55**）**同一机制**；本机非表单元素为 `content-box` 已由该实测锚定。**本轮未起实例实测菜单 rect** ⇒ 标记为"**推导（由 T40 的 footer 实测锚定）**" |
| 判责 | **实现错（轻）**：同族里唯一漏写 `box-sizing` 的尺寸声明 |
| 修法（一行，不由本轮执行） | `.dsh-rw-menu` 加 `box-sizing:border-box`（与 `row/recent-row/menuitem/status/dot/crumb/link` 一致） |
| 替代（不推荐） | 规格把 §7.2.4 的"宽 240px"改成"内容宽 240 / 外框 ≤250" ⇒ 会在闭集里留下唯一一条"声明不是外框"的规则 |
| 终验可判断言 | 修后：`menu.getBoundingClientRect().width === 240`（修前预期 250） |

### 10.9 "追加覆盖"在本仓**可能发生**吗（T49 ⑥ 的正面回答）

**会 —— 而且本仓已经在用这种写法，所以这不是假想：**

| 依据 | 观察 |
|---|---|
| 插件自己的 CSS **已经在重复选择器** | 实测重复：`.dsh-rw-fold` ×3、`.dsh-rw-rowacts` ×3、`.dsh-rw-chip` ×2、`.dsh-rw-crumb` ×2、`.dsh-rw-current` ×2、`.dsh-rw-path-input` ×2、`.dsh-rw-row:hover` ×2 ⇒ "**同一选择器再写一条来改**"是本仓既有手法 |
| 后一条只改一部分属性（典型的"追加精修"） | `.dsh-rw-current{border-left-width:2px;border-left-color:…;font-weight:600}` 就是这样一条（它不重复声明 height/padding，但**同一模式完全可以用来改 `box-sizing`**） |
| 只有 1 处样式注入点（今天） | `client/index.js`：手写 `<style data-plugin-css="dsh-remote-wsl/panel.css">` + **去重守卫**；10 个 chunk 里**只有 `index.js` 产 CSS**（其余 9 个 cssLikePatternHits = 0）⇒ **跨 `<style>` 覆盖今天不成立**，但**同表内追加今天就能发生** |
| 逻辑上的不对称 | 门禁的价值在于"**将来有人这么写时能红**"；若只在"确定不会发生"时才保留判据，就等于放弃这条护栏 |

⇒ **不需要**发明脆弱断言：修好的判据在**既有写法**上就已具备红能力（4 个负向夹具证明），且实测真实现**当前没有**任何 `box-sizing` 追加覆盖（汇总行打印"未检测到…"）—— **红能力是"备而未用"，不是"为了红而红"。**

### 10.10 复算入口（T49 增量）

```powershell
$n='C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$v='D:\project\dsh1\vendor\dsh-remote-wsl\spike\verify\explorer-20261012\visual'
$asar='C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'

# ① 真实现（期望：真陷阱 0「`.dsh-rw-menu` 修复后」；当前 = 1）—— **有真陷阱则 exit 1**
& $n "$v\tools\box-sizing-audit.mjs" 'D:\project\dsh1\vendor\dsh-remote-wsl\client\index.js' dsh-rw- --host=$asar

# ② 旧判据反例（neg2/neg4 期望假绿 PASS、pos2 期望假红 FAIL）
& $n "$v\tools\box-sizing-audit.mjs" "$v\fixtures\neg2-append-override.css" dsh-rw- --judge=old
& $n "$v\tools\box-sizing-audit.mjs" "$v\fixtures\neg4-append-then-important.css" dsh-rw- --judge=old
& $n "$v\tools\box-sizing-audit.mjs" "$v\fixtures\pos2-append-safe.css" dsh-rw- --judge=old

# ③ 夹具矩阵（4 负必须 exit 1；3 正必须 exit 0）
Get-ChildItem "$v\fixtures\*.css" | ForEach-Object { & $n "$v\tools\box-sizing-audit.mjs" $_.FullName dsh-rw- | Select-String '==>'; "  ^ $($_.Name) exit=$LASTEXITCODE" }
```

| 文件 | 内容 |
|---|---|
| `fixtures/neg0-footer-36-t43-shape.css` … `pos3-form-control-no-boxsizing.css` | **8 个夹具**（5 负 3 正），带 `@tag` pragma；`neg0` 是 T43 原缺陷（36→55）的永久复现 |
| `out-10-redcap-old-judge.txt` | **旧判据**在 5 个负向夹具上的原始输出（含 `neg2`/`neg4` 两个**假绿**） |
| `out-11-redcap-new-judge.txt` | **新判据**在 8 个夹具上的原始输出（5 负 exit 1 / 3 正 exit 0） |
| `out-12-redcap-ab.txt` | 逐夹具 A/B（旧 vs 新并排） |
| `out-08-box-sizing-audit.txt` | 真实现（新判据 + 旧判据对照）+ **neg0 的 36→55 复现** + 幂等性（本轮用最终版脚本重跑） |

### 10.11 未声称 / 未核实（T49）

| 项 | 状态 |
|---|---|
| **跨选择器优先级** | 不建模（需完整 CSS 引擎）；若将来出现 `.a` 与 `.b` 互相覆盖 `box-sizing`，本工具**不会**报红 ⇒ 已在 §10.2 明写为范围边界 |
| **`.dsh-rw-menu` 的实测 rect** | **未起实例实测**（本轮为静态对账）；250 是**由 T40 的 footer 实测锚定的推导**，终验可用一行 `getBoundingClientRect().width` 证实/证伪 |
| **`@media` / 宿主后插样式** | 不建模 |
| **dark 主题** | 与 box-sizing 无关（同一套 CSS） |

