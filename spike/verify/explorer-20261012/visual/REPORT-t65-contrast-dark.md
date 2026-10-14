# REPORT —— T65：dark 全量对比度**实测**复算 + 320 菜单/hover 补拍 + `box-sizing` 候选裁定

- **日期**：2026-10-14 ｜ **作者**：`visual-designer` ｜ **HEAD**：`b9e8dfb`（P3 冻结后）
- **前置⑤**：`check-client-rev.ts` **PASS / exit 0**（rev `0d0f1fb9fe9e`）；**页面加载的 9 个 chunk 与磁盘逐字节相同**（`allPart: true`，见 `t65/out-t65-integrity.json`）
- **实例**：`git archive HEAD` → `%TEMP%\usab-t65`（逐字节代表 HEAD）+ 孤立 `DSH_HOME`；headless Chrome + CDP **8968**（端口段按要求只用 **8966–8970**）
- **交付**：本报告 + `t65/` 下 8 张图 + 5 份原始 JSON + 3 个可复跑脚本（`t65-contrast.ts` / `t65-diff.ts` / `t65-assert.ts`）
- **不碰**：`docs/panel-visual-spec.md`（按 lead 要求避让 T64 的 §6.2 改写）；**未改** `client/**`、`src/**`

---

## 0. 结论

| 验收项 | 结果 |
|---|---|
| ① 对比度总表（元素对/前景/**合成背景**/比值/判定）+ 新旧值差异 | ✅ §1–§3（实测 18 元素 + 58 token 组；**静态 vs 实测 Δ=0**） |
| ② 320 菜单 + hover 截图（各带"看什么"） | ✅ §4（8 张） |
| ③ `box-sizing` 候选 2 条裁定 | ✅ §5（**两条都不是真问题**，delta=0，有 UA 依据） |
| ④ 故意红 ≥1 + 字节还原 | ✅ §6（hint 改 `label-dimmed` ⇒ **2 FAIL / exit 1**；还原 ⇒ **46 PASS / exit 0**） |
| ⑤ 前置两条证明 | ✅ 抬头 + `out-t65-integrity.json` |
| ⑥ 两栏 + 未复核 | ✅ §7 |

**一句话**：**插件的"在用"文字对两主题全部 ≥4.5:1**（light 5.55–18.9 / dark 9.25–17.45）；实测值与被检的静态值**逐位相同**（该静态工具是准的）；**红项只有两类**：① 控件/容器**边界**（1.25–1.46）受 17-token 闭集所限（已登记的 1.4.11 缺口 + 焦点环补偿）；② **dark 浮层面上的焦点环** 2.49（T43 已用"双色指示"补偿，实测两色之间 6.75）。

---

## 1. ① 判据与阈值

| 类别 | 阈值 | 依据 |
|---|---|---|
| 正文/标签（kind=text） | **≥4.5:1** | WCAG 2.x SC 1.4.3 |
| 非文本（图形/指示/边界/焦点环，kind=nontext·nontext-border） | **≥3:1** | SC 1.4.11 / 2.4.11 |
| 禁用态（R5、`label-dimmed` 域） | 记录不判 | SC 1.4.3 豁免（禁用控件） |

**"实测"的口径（比静态强在哪）**：
1. **值来自运行实例**：`getComputedStyle(document.body).getPropertyValue('--dsw-alias-…')` ⇒ 真实 token 解析结果（静态是从 `app.asar` 文本里解析）；
2. **元素级另取"沿父链合成后的实际背景"**：`_effBg(el)` 从元素向上收集带 alpha 的 `background-color`，遇不透明即停，再自外向内 src-over ⇒ 不是"只取声明值"；
3. **焦点环用 CDP 强制 `:focus`+`:focus-visible`**（脚本 `el.focus()` **不会**触发 `:focus-visible`）⇒ 才能量到真实的 ring / 内圈 hairline。

---

## 2. 元素级实测（18 项 × 2 主题；"合成背景"逐项给出）

**全部文本目标 PASS**（原始 `t65/out-t65-contrast.json`）：

| 元素 | 前景（实测） | 合成背景 | light | dark |
|---|---|---|---|---|
| 标题 `.dsh-rw-title` | `rgb(15,17,21)` / `rgb(249,250,251)` | `#ffffff` / `#232324` | **18.9** | **15.03** |
| 副标题 `.dsh-rw-subtitle` | `rgb(97,102,107)` / `rgb(207,211,214)` | `#ffffff` / `#232324` | **5.80** | **10.42** |
| 头部提示 `.dsh-rw-hint` | 同副标题 | 同 | **5.80** | **10.42** |
| 徽标 `.dsh-rw-badge` | 同副标题 | 同 | **5.80** | **10.42** |
| 底栏状态词 `.dsh-rw-statusword` | `rgb(15,17,21)` / `rgb(249,250,251)` | `#f9fafb` / `#1b1b1c` | **18.08** | **16.47** |
| 底栏会话数 `.dsh-rw-extra` | `rgb(97,102,107)` / `rgb(207,211,214)` | `#f9fafb` / `#1b1b1c` | **5.55** | **11.43** |
| 底栏更新时间 `.dsh-rw-updated` | 同 | 同 | **5.55** | **11.43** |
| 卡片标题 `.dsh-rw-cardhead` | `rgb(15,17,21)` / `rgb(249,250,251)` | `#ffffff` / `#2c2c2e` | **18.9** | **13.34** |
| 主按钮文字 `.dsh-rw-btn--primary` | `#fff` / `rgb(35,35,36)` | `#0f1115` / `#f9fafb` | **18.9** | **15.03** |
| 普通按钮文字 `.dsh-rw-btn` | 同主按钮（该例命中的是 primary） | 同 | **18.9** | **15.03** |
| chip 文字 `.dsh-rw-chip` | `rgb(97,102,107)` / `rgb(207,211,214)` | `#ffffff` / `#151517` | **5.80** | **12.11** |
| 面包屑 `.dsh-rw-crumb` | 同 chip | `#ffffff` / `#2c2c2e` | **5.80** | **9.25** |
| 行内动作 `.dsh-rw-link` | `rgb(15,17,21)` / `rgb(249,250,251)` | `#ffffff` / `#2c2c2e` | **18.9** | **13.34** |
| 输入框文字 `.dsh-rw-path-input` | 同标题 | `#ffffff` / `#151517` | **18.9** | **17.45** |
| **组标题**（T54 实测，菜单内） | `label-primary` | 菜单面 `#e9ecf2` / `#61666b` | **15.97** | **5.55** |

**非文本（边界）4 项 —— 真红，见 §3.2**：

| 元素 | 前景（border 实测） | 合成背景 | light | dark |
|---|---|---|---|---|
| 卡片描边 `.dsh-rw-card` | `rgba(0,0,0,.04)` / `rgba(255,255,255,.06)` | `#ffffff` / `#2c2c2e` | **1.09** | **1.20** |
| 空心状态点 border `.dsh-rw-dot` | `rgba(0,0,0,.1)` / `rgba(255,255,255,.12)` | `#ffffff` / `#151517` | **1.25** | **1.41** |
| 普通按钮描边 `.dsh-rw-btn`（非主） | 同上 | 同 | **1.25** | **1.41** |
| 输入框描边 `.dsh-rw-path-input` | 同上 | 同 | **1.25** | **1.41** |

**焦点环（CDP 强制 `:focus-visible`）—— 全 PASS**：

| 探针 | outline（实测） | 生效背景 | 单色环比值 | 内圈 hairline | 两色之间 |
|---|---|---|---|---|---|
| 底栏主按钮 | `auto 2px rgb(65,118,230)` / `rgb(122,170,255)` | `#ffffff` / `#151517` | **4.23 / 7.83** ✅ | 无 | — |
| 行内动作 | 同上 | `#ffffff` / `#2c2c2e` | **4.23 / 5.99** ✅ | 无 | — |
| 路径输入框 | 同上 | `#ffffff` / `#151517` | **4.23 / 7.83** ✅ | 无 | — |
| **菜单项（浮层上）** | 同上 | `#e9ecf2` / `#61666b` | **3.58 / 2.49** ⚠️ | `inset 0 0 0 1px rgb(35,35,36)`（= `layer-1`） | **4.23 / 6.75** ✅ |

> 焦点环来自 **DSH 宿主全局** `:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}`（插件自身只在 `.dsh-rw-menuitem:focus-visible` 上加了内圈 hairline）——**这一点是实测出来的**（`outline-style: auto`）。

---

## 3. token 台账（58 组 × 2 主题）与红项分类

完整逐组表（静态 vs 实测并排）：`t65/out-t65-diff.txt`。**58 组全部 resolved**（否则断言 A4 会红 —— 这正是防"假绿"的闸门）。

### 3.1 新旧值差异：**Δ = 0**

抽查 **12 组 × 2 主题**，静态值与实测值**逐位相同**（另见 `out-t65-diff.json`）：

| 组 | light 静态/实测 | dark 静态/实测 |
|---|---|---|
| G1 正文 | 18.90 / 18.90 | 15.03 / 15.03 |
| G2 次要文字 | 5.80 / 5.80 | 10.42 / 10.42 |
| G9b 边框 l2 vs layer-1 | 1.26 / 1.26 | 1.46 / 1.46 |
| G16 焦点环 vs overlay | 3.58 / 3.58 | 2.49 / 2.49 |
| R7 border-l2 vs bg-base | 1.26 / 1.26 | 1.41 / 1.41 |
| R12 layer-2 vs layer-1 | 1.00 / 1.00 | 1.13 / 1.13 |
| G11b / R4 次要·overlay | 4.90 / 4.90 | 3.85 / 3.85 |
| G8 idle 点 | 1.48 / 1.48 | 2.10 / 2.10 |

⇒ **结论：T28/T43 的静态计算值是准的，没有"静态说行、实测不行"的漏网**。**判定翻转 = 0**。

> ⚠️ **工具诚实声明**：我的自动 diff 脚本（`t65-diff.ts`）仍有**解析残留** —— 静态输出是 `padEnd` 定宽排布，CJK id 超过 26 码元时整行右移、值正好 40 字符时两列粘连 ⇒ 它能配上 101/116 行，**另有 15 行取不到静态值、8 行读到错列**（例如把 `5.21` 读成 `55.21`）。我把这三类都修过一轮仍未彻底干净，**因此"Δ=0"的结论以 §3.1 的逐位抽查为准，不以该脚本的输出为准**；脚本留在目录里但**标注为不可信**。

### 3.2 红项逐个给复现（**两类，共 6 条**）

| # | 红项 | 实测（light / dark） | 阈值 | 复现 |
|---|---|---|---|---|
| **R-A1** | **控件/容器边界**：输入框描边 `.dsh-rw-path-input` | **1.25 / 1.41** | 3 (1.4.11) | 1280 打开面板 → 量 `.dsh-rw-path-input` 的 `border-top-color` vs `_effBg` |
| **R-A2** | 普通按钮描边 `.dsh-rw-btn`（非 primary） | **1.25 / 1.41** | 3 | 同法量「跳转」/「← 上一级」 |
| **R-A3** | 空心状态点 `.dsh-rw-dot`（`--stopped` 时状态色在 border 上） | **1.25 / 1.41** | 3 | 需 `daemon.running=false`（默认快照即是）⇒ 量 `.dsh-rw-dot` 的 border 色 |
| **R-A4** | 卡片描边 `.dsh-rw-card` | **1.09 / 1.20** | 3 | 量卡片 `border-top-color`（=`border-l1`） |
| **R-B1** | **dark 浮层面上的焦点环**：`.dsh-rw-menuitem:focus-visible` 的蓝环 vs 菜单面 `#61666b` | 3.58 / **2.49** | 3 | 1280 打开 ⋯ 菜单 → CDP `CSS.forcePseudoState([focus, focus-visible])` → 量 outline 色 |
| **R-B2** | **运行中状态点**（`state-success-primary`，图形）：`G5` | **2.28** / 6.89 | 3 | 需 `daemon.running=true`（夹具）⇒ 绿点 vs 底栏面 |

**根因（一个根因解释 R-A1..A4）**：插件边界一律取 DSH 的 `border-l1/l2`；而**17-token 闭集内最重的 `border-l4` 也只有 1.45(light)/1.92(dark)**（实测 A2 行）⇒ **闭集内不存在能到 3:1 的边界色**。所以这不是"选错 token"，是**闭集与 1.4.11 的结构性冲突**。

**已实施的补偿（实测有效）**：① 焦点环 **4.23 / 5.99–7.83** ≥3（键盘用户可定位）；② 主按钮用**填充面** 18.9/15.03（不靠描边）；③ 输入框另有 `bg-base` 填充面 + placeholder + 焦点环；④ `R-B1` 由 **T43 裁决的双色焦点指示**兜住（两色之间 **6.75**）。
**可选修法（需 lead/规格裁决，`client/**` 不在本轮写域）**：把控件边界从 `border-l2` 换成 **`label-secondary`**（实测 5.80/10.42 ⇒ 轻松 ≥3）——代价是描边视觉明显变重；或显式接受 1.4.11 缺口并把理由写进规格。

### 3.3 token 台账里失败的"文字"类 = **参考行**（不是面板在用）

台账里 7 组 text 类不达标（G3 3.71/7.36、G4b 4.23/6.75、G5b 2.28/6.89、G6b 4.30、G7 2.15、G7b 2.79、G7c 2.58/5.53、G10 4.498、R4 3.85、R5 1.07/1.65）——**它们在插件里都不作为正文使用**：
- `label-tertiary`（G3/A10）：`css-token-audit.ts` 的 **S1 = OK（只用于 `:disabled`/`::placeholder`）** ⇒ 禁用/占位域，1.4.3 豁免；
- `state-warn/error/success`（G5b/G6b/G7/G7b/G7c/G10）：**T40/T42 已把行内动作与状态改成"图标取状态色、文字取 `label-primary`"**（`client.panel.tail.js` 的 `iconClass: "dsh-rw-menuicon--warn/--error"`）⇒ 状态色只作**图形**（阈值 3:1），其中 light 的 `warn`(2.15)/`success`(2.28) 见 R-B2 一类；
- `R4/R5`：`label-secondary`/`label-dimmed` **在浮层上**的组合 —— 插件菜单项文字用 `label-primary`（实测 R3 类 16.39/…），组标题也用 `label-primary`（T54 实测 5.55）⇒ 这两行是"若改用 secondary/dimmed 会怎样"的**参考行**。

---

## 4. ② 新增截图（8 张，`t65/`，均 HEAD 实测）

| 文件 | 场景 | **看什么** |
|---|---|---|
| `t65-menu320-light.png` / `-dark.png` | 320 菜单 | 面板仅 264px 时菜单**宽仍 240**、贴着底栏**上方**展开（间隙 3px）、右侧不被裁；组标题「守护/诊断」用 `label-primary` 清晰可读；菜单项各 28px 高；破坏性项用 `warn`/`error` **图标**（不是红字） |
| `t65-hover-row-light.png` / `-dark.png` | V1 行 hover | 行 hover 时**行内动作「进入」才显形**（`visibility` 切换，不占位、不顶动布局）；行背景 `interactive-bg-hover`（α=0.06）**可感知但不喧宾**；行高/文字不跳动 |
| `t65-hover-footer-light.png` / `-dark.png` | 底栏按钮 hover | 「启动守护」hover 填充为 `interactive-bg-hover` 叠在底栏面 `sidebar-fill` 上；文字仍**单行**、描边与尺寸不变；`⋯` 不受影响 |
| `t65-hover-menuitem-light.png` / `-dark.png` | 菜单项 hover | 菜单项 hover 填充叠在**浮层面** `bg-overlay` 上（dark 下能看清"hover 的项是哪一条"）；图标/文字不位移 |

---

## 5. ③ `box-sizing-audit` 候选 2 条逐条裁定

门禁报 `真陷阱 0 / 候选 2 条需人工核对`。候选 = 声明了 `width/height` 但**自身没写 `box-sizing`** 的规则（工具不敢直接判死，因为可能被 UA 兜住）。逐条实测（`t65/out-t65-boxes.json`，两主题同值）：

| 候选 | 元素 | `box-sizing`（实测计算值） | 声明 | 渲染外框 | **delta** | 裁定 |
|---|---|---|---|---|---|---|
| `.dsh-rw-btn` | `<button>`（**表单控件**） | **`border-box`** | 132.297×28 | **132.3×28** | **0** | ✅ **不是真问题**：UA 对 `button` 默认 `border-box`（宿主也无全局重置把它改成 content-box），外框 == 声明值。另测「跳转」48×28 → 48×28 |
| `.dsh-rw-chip` | `<button>`（表单控件） | **`border-box`** | 114×24 | **114×24** | **0** | ✅ **不是真问题**：同上；`Home` 50.17×24 → 50.2×24 |

**判定依据（三条同时成立才叫"不是问题"）**：① 是**表单控件**（UA 兜底）；② 计算值 `box-sizing` 实测 = `border-box`；③ 渲染外框与声明值 **delta = 0**（没有"声明 240 渲染 250"那种膨胀）。
**对照**：真正的陷阱是 T52 的 `.dsh-rw-menu`（`<div>`，无 UA 兜底 ⇒ 声明 240 渲染 250），**已修**（本轮实测菜单宽 240 ✓）。⇒ 门禁可以保持"候选 2 条需人工核对"，**裁定结论 = 两条均无需改动**；建议在 `box-sizing-audit` 的报告里把这两条标注为"UA 表单控件兜底，已人工裁定 2026-10-14"，以免每次都要重看。

---

## 6. ④ 故意红 + 字节还原

破坏只在 `%TEMP%\usab-t65` 的**副本**上（工作树/`client/**` 一个字节未动）：

| 步骤 | 操作 | 结果 |
|---|---|---|
| 破坏 | `client/index.js` 的 `.dsh-rw-hint`：`color: label-secondary` → **`label-dimmed`** | 替换成功；入口变更 ⇒ rev 换 |
| 断言 | `t65-assert.ts` | ✅ **A1 FAIL ×2**：`light 1.26`（`rgb(225,229,238)` on `#ffffff`）、`dark 1.64`（`rgb(67,69,74)` on `#232324`）⇒ **44 PASS / 2 FAIL / exit 1** |
| 还原 | 从工作树 `Copy-Item` 还原 | sha256 **逐字节相同** |
| 复绿 | 重跑 contrast + assert | ✅ **46 PASS / 0 FAIL / exit 0** |

---

## 7. ⑥ 两栏（规格 vs 实测）+ 未复核

| 维度 | 规格（T28/T43 定稿） | 实测（HEAD） | 一致？ |
|---|---|---|---|
| 正文 ≥4.5:1 | §8 对比度表 | 在用文字对 light 5.55–18.9 / dark 9.25–17.45 | ✅ |
| 组标题 ≥4.5（Q6） | `label-primary` | 15.97 / **5.55** | ✅ |
| 非文本 ≥3:1 | §8 | 焦点环 4.23–7.83 ✅；**边界 1.25–1.46 ❌**（§3.2 缺口） | ⚠️ 缺口已登记 |
| 焦点指示（双色） | §2.4 / Q-焦点 | 浮层上单色 2.49、双色 6.75 | ✅ 按裁决 |
| 阴影只给浮层（Q4） | §2.4 | 面板内 `box-shadow` 计数 **0**（T54 实测） | ✅ |
| 菜单宽 240 | §7.2.4 | **240**（320/420/1280） | ✅ |
| 底栏高 47 | §7.2.3 | **47** | ✅ |

**未复核（不许当通过）**：

| 项 | 拦在哪 |
|---|---|
| **运行中(green)状态点 / warn 图标** 的 3:1 | 我实测的是 `--stopped`（空心点 border）；`state-success/warn` 作图形的不达标值来自 **token 台账**（G5 light 2.28、G7 2.15），**未在"守护运行中"真实态下量元素级**（需起真守护 ⇒ 本轮用夹具，未做） |
| **hover / active 填充态**的元素级对比 | 台账 R8/R9 是 token 级（1.11/1.20 light）；截图只看"可感知"，**没量 hover 时的文字对比** |
| **自动 diff 脚本**（`t65-diff.ts`） | 15 行取不到静态值、8 行读错列（定宽列解析），**已声明不可信**；结论以逐位抽查为准 |
| **菜单项/组标题的元素级** | 本轮元素级 18 项是**菜单关闭**时量的；菜单内文字用 token 台账（R3/R4）+ T54 的组标题 5.55 交叉，**未在菜单打开态量 `.dsh-rw-menuitem` 元素级** |
| 英文 locale / 真机 DPI / 高对比度强制模式(`forced-colors`) | 未测（实例是 zh、`deviceScaleFactor=1`） |
| 截图的 4xx/低分屏表现 | 只测 320/1280 viewport |

---

## 8. 纪律与收尾（`t65/out-t65-cleanup.txt`）

| 项 | 结果 |
|---|---|
| 实例/端口 | hidden 起在 **8966**（守护槽位 8967）；**只用 8966–8970**（lead 修正后的段）；`liveHost=33688 (before 33688)` 硬校验通过 |
| 浏览器 | headless Chrome + CDP **8968**（独立 `%TEMP%\t65-chrome`）⇒ **0 可见窗口**；收尾按"命令行含 8968"精确杀 |
| 宿主 19387 | **未碰**（pid **33688**） |
| 用户全局存储 | 孤立 `DSH_HOME=%TEMP%\usab-t65-home`；`workspace.json` sha256 前后对照（见收尾日志） |
| npm/pnpm | **0 次** |
| unit/守护/包装层 | **0**（未起 WSL 守护）⇒ `reset-failed` 无对象；**未执行全局 `reset-failed`** |
| 临时目录 | `usab-t65*`、`t65-chrome` 收尾删除 |
| 写作用域 | 仅 `visual/t65/**` + `visual/REPORT-t65-contrast-dark.md`；**未碰** `docs/panel-visual-spec.md`（避让 T64）、`client/**`、`src/**`、既有 `visual/tools/**` |

### 复跑

```powershell
$t='…\visual\t65'
pwsh -File "$t\t65-boot.ps1" -Mode Vendor; pwsh -File "$t\t65-boot.ps1" -Mode ShaBefore
pwsh -File "$t\t65-boot.ps1" -Mode Setup;  pwsh -File "$t\t65-boot.ps1" -Mode Start
node "$t\t65-contrast.ts" --url <tokenUrl> --out $t --disk "$env:TEMP\usab-t65" --cdp 8968 --phase all
node "$t\t65-assert.ts" $t      # 46 PASS / exit 0
node "$t\t65-diff.ts"  $t      # 静态 vs 实测（⚠️ 解析残留，见 §3.1）
pwsh -File "$t\t65-boot.ps1" -Mode Stop; pwsh -File "$t\t65-boot.ps1" -Mode ShaAfter
```
