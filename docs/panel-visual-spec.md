# 面板视觉规格（task-28｜token · 层级 · 尺度 · 状态色 · 交互态 · 线框稿 · 对比度）

> **历史基线（2026-10-27 注）**：本文冻结的字节数与 SHA 指向 commit `7cb3362` 的 `client/` 快照，
> **不代表当前文件**（当前值以 `git show HEAD:client/index.js` 为准）；面板此后仍有改动，本文是
> 当时的验收记录，不是现状描述。可重跑的回归用例见 `test/`。
>
> **2026-10-27 视觉增量**：新增 `.dsh-rw-targetmain`（发行版行的原生按钮主操作，替代藏在
> `visibility:hidden` 里的切换按钮）；`.dsh-rw-sessionmeta` 的取色由 `label-tertiary` 改为
> `label-secondary`（原值 3.71:1 不达 4.5:1，且不在 17 token 闭集内）。详见
> [`docs/2026-10-27-fix-round.md`](2026-10-27-fix-round.md)。

- **日期**：2026-10-13 ｜ **作者**：`visual-designer` ｜ **状态**：**规格（已定稿，含 lead 三轮裁决 Q1–Q5）**（**本轮只写文档**，不改 `src/**`、`client/**`、`package.json`）
- **2026-10-21 UI 重做（本规格的头部/卡片布局已被替换）**：头部改为「标题 + 目标 + 守护状态药丸」，卡片内三层为「常去位置条 / 上一级+面包屑 / 路径框+筛选框同排」，列表吃满剩余高度；隐藏文件开关并入位置条。§7 的布局读数（M1–M17 / N1–N5）只对 2026-10-19 版本成立；重做后的结构判据见 `spike/verify/ui-20261021/REPORT-ui-redesign.md`。
- **本轮的 4 条 lead 裁决（已写进正文，见 §9.5）**：
  | 裁决 | 结果 | 落在哪 |
  |---|---|---|
  | **Q1** | **采用 17 个 token 的闭集**（含 `brand-primary` / `interactive-bg-hover` / `interactive-bg-active` / `label-dimmed`）；并加**两条机械门禁**：硬编码色 = 0 **且** token 集合 ⊆ 17 | §1.0.1、§1.5 |
  | **Q2** | **全宽度只保留底栏那一个 `⋯`**；组标题分 **工作区 / 守护 / 诊断** 三组；破坏性动作只在菜单内 + 二次确认 | §7.2.4、§7.3 |
  | **Q4** | **允许 `box-shadow`，但只限"面板外浮层"**；**只许中性半透明黑**（α ∈ [0.04,0.28]）；**不得作为唯一分离手段**；门禁脚本对其**窄豁免** | §2.4、§1.5 |
  | **Q5** | 断点 720 / 420 成立；补验 **719/720、419/420、359/360** 三个边界 | §7.3 |
- **配套文档（互引）**：`docs/panel-ux-redesign.md`（task-27，`usability-engineer`）= **信息架构 / 交互 / 文案 / 状态机 / 键盘**。
  **本文 = 视觉**：颜色 token / 层级容器 / 尺度 / 状态色 / 交互态 / 线框级视觉稿 / 对比度。
  **冲突由 lead 裁决**；本文凡涉及"点了会发生什么"的地方一律写「见 `docs/panel-ux-redesign.md` §…」，**不自行定义交互**。
  （`docs/panel-ux-redesign.md` 顶部已反向引用本文；其 §9.1 给出 V1–V8 八条视觉硬约束 ⇒ 本文 §9.2 逐条回答；其第二轮 review 又给 3 条约束 ⇒ 本文 §5.1/§5.2/§7.2.4/§4.1 收口。）
- **方向（用户已拍板）**：**骨架 = DSH 原生简洁风；交互细节借 VS Code Remote-WSL 的习惯；不照搬 VS Code 的概念命名**（命名与概念映射见 T27 §8.3，不在本文重复）。
- **基线锚点（截图/读数来源，只对已提交版本）**：commit **`7cb3362`** 经 `git archive` 导出到 `%TEMP%\vd-baseline-7cb3362`；**未对工作区截图**（`client/**` 正被 `client-panel` 改）。
  - `client/index.js` = **17,685 B / `0588B3D32DED5FD4B80E3A96970C9740AE18A1607EB9FF3A6F6D29B92353B416`**（内含面板全部 CSS）
  - `client/client.panel.js` = **50,840 B / `86F24076D6CD6A0DCDE1017734E8E7B2A811B5246C28DE2093EC3F4E6775907E`**
  - `client/client.api.js` = 11,234 B ｜ `client/client.icon.js` = 2,209 B
- **视觉真值来源（不是猜测）**：`C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 的
  ① token 注册表（官方 `description` + `requiresLightAndDark`）② `body{}` / `body[data-ds-dark-theme]{}` 两套主题块 ③ `focus.css` 的焦点环策略 ④ 出厂 CSS 里各 token 的**用法计数**。
  解析脚本与原始输出见 §10（`visual/tools/*.mjs`、`visual/out-0*.txt`），**全部可复跑**。
- **基线截图引用**：`spike/verify/explorer-20261012/usability/ux-baseline/`（11 张，`usability-engineer` 从同一个 commit 的副本抓，其中 `ux-01-overview-light.png` / `ux-07-dark.png` / `ux-09-daemon-running.png` 是本文 §2/§6 的主要对照）。
- **本轮未起测试实例、未产生任何窗口/进程**：本文只需 token 真值（来自 `app.asar`）+ 已提交基线的视觉对照（来自上面两份现成证据），起实例的唯一收益是复测渲染值，而**渲染值已被 T27 §0.1 独立测到并被本文 §1.6 用作交叉校验**（dark 面板底色 `rgb(35,35,36)` ≡ 本文算出的 `--dsw-alias-bg-layer-1` dark `#232324`）。

---

## 0. 结论（≤300 字）

**视觉上真正要先解决的不是"配色不好看"，而是三条硬事实：**

1. **light 主题的层级是塌的**：`--dsw-alias-bg-layer-1/2/3` 在 light **全是 `#ffffff`**（实测），所以任何"用底色分层"的做法在 light 上等于没做。⇒ 本文规定 **层级三件套 = 背景档 + 描边 + 缩进/竖线**，light 缺背景档时由后两者承担（§2.3）。
2. **现有 token 里没有任何一个能把"发丝描边"做到 3:1**：`border-l1` = 1.09:1、`border-l2` = 1.26:1（light）/ 1.19、1.46（dark）。⇒ 不再试图用"更深的边框"解决，改为**用文字标签 + 结构 + 形状**让控件的存在可被识别，并把这一条写成**有理由的、可判的偏离**（§8.4）。
3. **状态色单独用是会失效的**：light 上 `success` 2.28:1、`idle` 1.48:1、`warn` 2.15:1 都达不到非文本 3:1。⇒ **状态词常显且永不省略**（承载语义），颜色与形状**只做冗余**（§4、§5.4）。

闭集 **17 个 DSH 既有 token**（不含硬编码色；**lead Q1 已裁决定稿**），密度按 **32px 行高**定，焦点环**复用平台策略、不覆盖**（实测 4.23:1 light / 6.75:1 dark），浮层阴影按 **Q4** 只许中性半透明黑。

**两条可机械判定的门禁**（§1.5，`css-token-audit.mjs`，任一不满足即 exit 非 0）：
**C1 硬编码色 = 0**（基线实跑 88 规则 / 0 命中 / exit 0）｜**C2 面板引用的 `--dsw-*` 集合 ⊆ 这 17 个**（防第 18 个 token 漂移）。
**门禁本身已被 5 个夹具证伪过**（4 负 1 正，见 §1.5 表）。

---

## 1. Token 用法表

### 1.0 闭集（authoring allowlist）——**共 17 个，全部是 DSH 既有 token（lead Q1 定稿）**

> **状态**：**已裁决采用 17 个**（lead Q1；`usability-engineer` 第二轮同意，并给了独立反证：light 下点名 13 个里**没有任何一个**能做可见 hover ⇒ 13 会让 T27 §9.1-V7 不成立）。
> **下游影响**：`client-panel` 只能用下表的 17 个 token；门禁脚本 **C2** 会把第 18 个判红（§1.5）。

| # | token | 官方描述（token 注册表原文） | 在别处被用了几次（出厂 CSS） |
|---|---|---|---|
| 1 | `--dsw-alias-bg-base` | Application base background. | — |
| 2 | `--dsw-alias-bg-layer-1` | Primary raised surface background. | 60 |
| 3 | `--dsw-alias-bg-layer-2` | Secondary nested surface background. | 33 |
| 4 | `--dsw-alias-bg-overlay` | **Overlay and popover background.** | 7 |
| 5 | `--dsw-alias-border-l1` | Primary subtle border. | 62 |
| 6 | `--dsw-alias-border-l2` | Secondary stronger border. | 98 |
| 7 | `--dsw-alias-label-primary` | Primary text color. | — |
| 8 | `--dsw-alias-label-secondary` | Secondary text color. | — |
| 9 | `--dsw-alias-label-dimmed` | （无注册表条目；**用法证据**：出厂 CSS 只把它用于 `:disabled` 与 `::placeholder`） | 10（全部是 `:disabled`/`::placeholder`） |
| 10 | `--dsw-alias-brand-primary` | Primary brand accent. | 24 |
| 11 | `--dsw-alias-state-success-primary` | Primary success state color. | — |
| 12 | `--dsw-alias-state-error-primary` | Primary error state color. | — |
| 13 | `--dsw-alias-state-warn-primary` | Primary warning state color. | 24 |
| 14 | `--dsw-alias-state-idle-primary` | **Primary inactive state color.** | 5 |
| 15 | `--dsw-specific-sidebar-fill` | **Sidebar column and title-row background.** | — |
| 16 | `--dsw-alias-interactive-bg-hover` | （无注册表条目；**用法证据**：出厂 CSS 里 **194 处** `:hover` 背景） | 194 |
| 17 | `--dsw-alias-interactive-bg-active` | （无注册表条目；用法证据：出厂 CSS 的 `[aria-expanded=true]` / 选中态背景） | 10 |

**只读、不由本文 authoring 的 1 个（平台提供，禁止覆盖）**：

| token | light | dark | 为什么只读 |
|---|---|---|---|
| `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` | 它是**平台焦点环的兜底色**：`focus.css` 写 `:focus-visible{outline-color:var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}`。我们**不设** `--dsw-focus-ring-color`，也就不可能与平台的键盘/指针模态策略打架（§5.2）。 |

#### 1.0.1 与 task-28 给定清单的差异（**只有 3 个新增，逐个给理由**）

task-28 点名的清单是 `bg-base/-layer-1/-layer-2/-overlay`、`border-l1/l2`、`label-primary/secondary`、`state-*`、`specific-sidebar-fill`（= 上表 1–8、11–15，共 13 个）。另外 4 个：

| 新增 | 为什么必须有（不引入它会出现什么） |
|---|---|
| `--dsw-alias-brand-primary` | **基线已在用（12 处）**，且它不是"装饰色"：light `#0f1115` / dark `#f9fafb`，**是与 `label-primary` 同值的单色强调**。本文用它做「当前/选中」的左侧 2px 竖条 —— 这是 light 三档全白时**唯一**能在两个主题都清晰表达"当前"的手段（18.90:1 / 15.03:1，§8）。 |
| `--dsw-alias-interactive-bg-hover`<br>`--dsw-alias-interactive-bg-active` | **light 下没有可用的"浅填充"**：`bg-layer-2` 在 light = `#fff`（与底同色，hover 完全不可见）。这两个 token 是 DSH 出厂 CSS 里 **194 处**使用的**官方 hover/active 覆盖层**，且因为是 alpha 叠加（light `rgba(38,49,72,.06/.10)`、dark `rgba(255,255,255,.08/.14)`），**在任何容器档上都能正确合成**，不必为每个背景单独定 hover 色。**它们决定了 T27 §9.1-V7（hover 与"当前"可区分）能不能成立**（§5.1）。 |
| `--dsw-alias-label-dimmed` | 官方 `:disabled` 与 `::placeholder` 专用色（用法计数 10，全是这两种选择器）。**替代基线的 `opacity:.55`**：透明度会把描边/图标一起削弱且在不同主题下不可预测；用显式 token 才能"可判"（§5.5）。 |

> **裁决记录（lead Q1，已定稿）**：**采用 17 个**。原先写的"若 lead 坚持 13 个"的**降级方案**保留为**备选记录**（在 §5.1 末尾），但**不再是本轮方案**；采用 13 个的代价是 dark 的 hover 会变成一块 `#61666b` 的重灰（因为只能用 `bg-overlay` 兼职 hover），且 T27 §9.1-V7 在 light 下失去填充通道。**17 个的版本不引入任何新色**（4 个补充项全是 DSH 既有 token，见左表）。

**lead 附带的 2 条硬要求（已落到 §1.5）**：① 门禁脚本把这 17 个当 **allow-list**，出现集合外 token 一律 exit 非 0；② 本文逐 token 给出"用在哪 + 为什么 + light/dark 取值"（§1.1，含 `interactive-bg-hover/-active` 两项）。

### 1.1 逐 token 用法表（用在哪 / 为什么 / light 取值 / dark 取值）

> 取值来源：`out-02-theme-token-values.txt`（`app.asar` 两套主题块递归解 `var()` 到静态调色板）。light 行 = `body{}`，dark 行 = `body[data-ds-dark-theme]{}`。

| token | light 取值 | dark 取值 | 用在哪（本文的规则） | 为什么是它 |
|---|---|---|---|---|
| `bg-base` | `#ffffff` | `#151517` | ① 路径输入框 / 搜索框的**内凹填充**；② `<pre>` 原始诊断块 | 官方 "Application base background"；在 dark 里它比内容面更暗 ⇒ 天然"凹"；light 里与内容面同色，所以**输入框的识别不靠填充而靠描边 + 标签 + 光标**（§3.7） |
| `bg-layer-1` | `#ffffff` | `#232324` | 面板 root 底色（内容画布） | 官方 "Primary raised surface"；T27 §0.1 实测 dark 面板底色 = `rgb(35,35,36)` = `#232324`，与本表逐字一致（交叉校验） |
| `bg-layer-2` | `#ffffff` | `#2c2c2e` | **嵌套一层的容器**：目录浏览器卡片、错误块、结果条、确认层 | 官方 "Secondary nested surface"；dark 下比 layer-1 亮一档（1.35:1 的可见差异）；light 下与 layer-1 同色 ⇒ 由 `border-l1` 承担（§2.3） |
| `bg-overlay` | `#e9ecf2` | `#61666b` | **只用于浮层**：`⋯` 菜单面板、二次确认弹层 | 官方 "Overlay and popover background"。**它是本文唯一在 light 下能给出"明显不同于白底"的整块填充**（**1.18:1**，实测 R10），所以 light 的浮层靠它；代价见 §8.4-C2（dark 里它上面的焦点环只有 2.49:1 ⇒ 用双色焦点指示补，§5.2） |
| `border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` | ① 头/底两条分隔线；② 卡片与分组容器的**外框**；③ 树/列表的**左侧缩进竖线** | 官方 "Primary subtle border"；用于"分组"而不用于"强调" |
| `border-l2` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` | ① 可交互控件的描边（按钮、chip、输入框、下拉）；② 浮层外框 | 官方 "Secondary stronger border"；是"这是一个可操作的东西"的描边档 |
| `label-primary` | `#0f1115` | `#f9fafb` | ① 面板标题 / 分组标题（600）；② 列表项名；③ 按钮文字；④ 底栏状态句；⑤ 菜单项文字 | 官方 "Primary text color"；底栏在 `sidebar-fill` 上仍 18.08:1 / 16.47:1 |
| `label-secondary` | `#61666b` | `#cfd3d6` | ① 副标题 / 路径 / 计数 / 时间戳；② breadcrumb 分隔符；③ 卡片说明文字；④ 占位文案（**仅非信息性**） | 官方 "Secondary text color"；5.80:1 / 10.42:1，**在 light 与 dark 都 ≥4.5**，所以它承担**全部"小字"**（不再引入第三级文字色，理由见 §1.2） |
| `label-dimmed` | `#e1e5ee` | `#43454a` | ① `:disabled` 的文字；② `::placeholder` 的示例值 | 官方用法就是这两个选择器。**警告**：light 下仅 1.07:1 —— 它**只能**出现在 WCAG 1.4.3 明确豁免的位置（禁用控件、placeholder 占位示例），**任何"用户需要读的信息"禁止用它**（§8.4-A4） |
| `brand-primary` | `#0f1115` | `#f9fafb` | ① "当前/选中"的**左侧 2px 竖条**；② 主按钮的默认填充 | 单色强调（与 `label-primary` 同值）。**它同时是本文拒绝蓝色链接的依据**：若把行内动作文字改成 `--dsw-alias-link`（`#4176e6`），light 只有 **4.23:1 < 4.5**（§8.4-A1） |
| `state-success-primary` | `#22c55e` | `#22c55e` | 底栏"运行中"圆点（**实心圆**形状） | 官方 "Primary success state color"；**只做形状+颜色的冗余**，语义由状态词承担（§4） |
| `state-error-primary` | `#ec1313` | `#f25a5a` | ① 错误块的描边 + 标题；② 确认层"停止"主按钮的**填充**；③ 读失败时底栏状态词的**形状图标** | 官方 "Primary error state color"；作为非文本（描边/图标/填充）时 light 4.50:1 / dark 4.24:1 均 ≥3（§8） |
| `state-warn-primary` | `#f59e0b` | `#f59e0b` | **只用于形状**：漂移/冲突的三角图标、以及"只读"提示的图标 | **禁止当文字**：light 上 2.15:1（§8.4-A2）。官方出厂 CSS 里确有把 warn-primary 当文字色的用法（`.cJsG2q_maxTokensTitle`），但**上游这么用不等于它达标**，本文不引用它当理由 |
| `state-idle-primary` | `#d4d4d4` | `#545557` | 底栏"未运行"圆点（**空心圆**形状，见 §4） | 官方描述就是 "Primary **inactive** state color"；light 1.48:1 ⇒ 空心圆的**环**用 `border-l2` 画、填充用 idle 色，形状本身可辨（§4.2） |
| `specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` | 底栏背景（"chrome"档） | 官方 "Sidebar column and title-row background"。**两个主题里它都比内容面暗**（light `#f9fafb < #ffffff`、dark `#1b1b1c < #232324`）⇒ 是本文**唯一语义在两个主题里同向**的填充 token，所以用它做 chrome |
| `interactive-bg-hover` | `rgba(38,49,72,.06)` | `rgba(255,255,255,.08)` | 列表行 / 菜单项 / 按钮的 hover 覆盖层。**用在哪**：`row:hover`、`menuitem:hover`、图标按钮 `:hover`、chip `:hover`。**为什么**：light 三档全白 ⇒ 不透明 token 做不出可见 hover，而它是官方 `:hover` 覆盖层（出厂 194 处）。**终值随背景变**（见 §5.1 三背景表）：light → `#f2f3f4`(layer-1) / `#edeef0`(sidebar-fill) / `#dee1e8`(overlay)；dark → `#343435` / `#2d2d2e` / `#6d7277` | 见 §1.0.1 |
| `interactive-bg-active` | `rgba(38,49,72,.10)` | `rgba(255,255,255,.14)` | 按压态（active）。**用在哪**：`:active`、以及"选中但非当前"的行/菜单项。**为什么**：与 hover 同族但强度更高，保证"按下去"与"划过去"有序。**终值**：light → `#e9eaec` / `#e3e6e9` / `#d5d9e1`；dark → `#424243` / `#3b3b3c` / `#777c80` | 同上 |

### 1.2 明确**不用**的 token（及为什么）

| 不用 | 为什么 |
|---|---|
| `--dsw-alias-bg-layer-3` / `-layer-4` | 官方用途是"更深一档的嵌套面/输入框"（出厂 CSS：`input[type=text]{background:bg-layer-3}`），但 **light 下 layer-3 = `#ffffff`**（与 layer-1/2 完全同色）⇒ 对 light 零收益；本文的嵌套最多两层，`layer-2` 已够，引入第三档只会让"该用哪一档"变成无法判的问题 |
| `--dsw-alias-label-tertiary` | light 上 `#81858c` = **3.71:1 < 4.5** ⇒ 不能承担信息文本；而"禁用/占位"的正确 token 是官方的 `label-dimmed`。**引入第三级文字色 = 制造一条必然会被误用（把元信息放进去）的规则** |
| `--dsw-alias-link` / `--dsw-alias-brand-primary-new-colorprimary-new-color` | light 上 `#4176e6` = **4.23:1 < 4.5**（当文字时）。蓝色只在**焦点环**（非文本，3:1 门槛，实测 4.23/6.75 通过）里由平台使用。行内动作文字的对比度必须 ≥4.5，因此用单色 `brand-primary`（18.90:1 / 15.03:1） |
| `--dsw-alias-state-warn-label` | 它是官方"警告**文字**色，但 light 上 `#dd8629` = **2.79:1**，仍不达 4.5 ⇒ 用它只是把不达标从"更不达标"变成"不达标"。本文的警告**文字**一律 `label-primary`，`warn` 只做形状（§4.2） |
| `--dsw-alias-state-*-tertiary`（success/warn 底色徽标） | 实测"绿底上的绿点" = 2.09:1，"黄底上的黄点" = 1.99:1（light）⇒ 底色徽标反而**降低**了状态图形的可辨性。徽标一律 `border-l1 + label-secondary`（形状靠图标） |
| `--dsw-focus-ring-color` | **平台所有**（§5.2）。我们覆盖它就会与 `html[data-input-modality=pointer]` 的"指针模态下不画环"策略打架 |
| 任何 `#hex` / `rgb()` / `hsl()` / 命名色 / `color-mix(<字面色>)` | 硬约束（§1.5 有机械自查） |

### 1.3 light / dark 双份成立性检查表

判据：**每个 token 在两套主题下都被显式赋值**（token 注册表 `requiresLightAndDark: true`），且**本文的用法在两种主题下语义相同**。

| token | light 有值 | dark 有值 | 语义同向？ | 若不成立，补偿 |
|---|---|---|---|---|
| `bg-base` | ✅ `#ffffff` | ✅ `#151517` | ✅（都是"比内容面更凹/更基"） | — |
| `bg-layer-1` | ✅ `#ffffff` | ✅ `#232324` | ✅ | — |
| `bg-layer-2` | ✅ `#ffffff` | ✅ `#2c2c2e` | ❌ light 与 layer-1 同色 | 由 `border-l1` 承担容器识别（§2.3） |
| `bg-overlay` | ✅ `#e9ecf2` | ✅ `#61666b` | ⚠️ light 是"浅灰蓝"、dark 是"中灰"（相对底色方向相反：light 更暗、dark 更亮） | 允许：两向都是"明显不同于底色的一块面"，浮层语义成立 |
| `border-l1/l2` | ✅ | ✅ | ✅ | — |
| `label-primary/secondary` | ✅ | ✅ | ✅ | — |
| `label-dimmed` | ✅ `#e1e5ee` | ✅ `#43454a` | ✅（都是"接近底色"） | 只在豁免位置使用（§8.4-A4） |
| `brand-primary` | ✅ `#0f1115` | ✅ `#f9fafb` | ✅（都是"最高对比单色"） | — |
| `state-success/error/warn/idle-primary` | ✅ | ✅ | ✅ | 见 §4（形状冗余是硬要求） |
| `specific-sidebar-fill` | ✅ `#f9fafb` | ✅ `#1b1b1c` | ✅（都比内容面暗） | — |
| `interactive-bg-hover/-active` | ✅ | ✅ | ✅（alpha 叠加，自动适配任何底） | — |

### 1.4 本文的视觉"三档"定义（写死，供实现与复验引用）

```
填充档（fill）
  F0 = bg-base        「凹」：输入框、代码/原始块
  F1 = bg-layer-1     「画布」：面板 root
  F2 = bg-layer-2     「嵌套一层」：卡片、结果条、错误块、确认层
  F3 = bg-overlay     「浮层」：⋯ 菜单、确认弹层
  FC = specific-sidebar-fill  「chrome」：底栏
  叠加层：hover = interactive-bg-hover；active/选中 = interactive-bg-active

描边档（stroke）
  S1 = border-l1      「分组」：卡片外框、分隔线、缩进竖线
  S2 = border-l2      「可交互」：按钮/chip/输入框/下拉/浮层的框

文字档（text）
  T1 = label-primary     信息主体（标题/项名/按钮/状态句/菜单项）
  T2 = label-secondary   元信息（路径/计数/时间/说明/分隔符）
  TD = label-dimmed      仅 :disabled 与 ::placeholder
```

**可判规则**：一个元素属于哪一档，由**它的语义**唯一决定（不是由"我觉得好看"）：
- 只要元素**可点/可输入** → 描边必须是 `S2`；
- 只要元素是**容器** → 外框必须是 `S1`，背景 ∈ {F2, F3}，且**不得**用 `S2`（`S2` 是交互信号，容器用了会假装可点）；
- 只要文字是**用户需要读的** → `T1` 或 `T2`（≥4.5:1，§8）；
- 只有 `:disabled` / `::placeholder` 允许 `TD`。

### 1.5 机械门禁（两条硬约束 + 一条软检查 + Q4 的窄豁免）

**基线事实（实测，非引用）**：commit `7cb3362` 的面板 CSS = **88 条规则 / 13 个 token / 硬编码颜色 0 条**（`out-05-css-token-audit.txt`）。**这个 0 必须保持。**

```powershell
node spike/verify/explorer-20261012/visual/tools/css-token-audit.mjs <被查文件> dsh-rw-
# 通过判据： exit=0
# 选项： --no-allow（关掉 C2）  --allow=t1,t2（自定义闭集）
```

| 门禁 | 断言 | 为什么单有 C1 不够 |
|---|---|---|
| **C1（硬）** | **硬编码颜色 = 0**：扫 `#hex(3/4/6/8)`、`rgb()/rgba()`、`hsl()/hsla()`、`color()/lab()/lch()/oklab()/oklch()/hwb()`、CSS 命名色（命名色两侧不得是标识符/连字符，防 `white-space` 误报） | —— |
| **C2（硬）** | 面板 CSS 引用的 `var(--dsw-…)` 集合 **⊆ §1.0 的 17 个**；出现集合外 token ⇒ **exit 非 0**（并逐个列出 + 出现次数） | C1 只证明"没有字面色"，**证明不了"没有第 18 个 token"** —— 引用一个合法但不在闭集里的 token（如 `label-tertiary`）不会有任何字面色，却会让对比度与语义分析全部失效（lead Q1-① + T27 第二轮约束 #3） |
| **S1（软，打印但不影响退出码）** | `label-dimmed` 只允许出现在 `:disabled` / `[disabled]` / `[aria-disabled]` / `:placeholder` / `::placeholder` 相关规则里 | T27 第二轮约束 #1：它是"禁用/占位"专用色（light 仅 1.07:1），**不得**用来"弱化仍然有效的信息"——那是对比度滑坡的入口 |

**Q4 的窄豁免（只对 shadow，不放松其它任何东西）**：`box-shadow`（含 `-webkit-`）声明里的**无 色 相**半透明黑 —— `rgba(0,0,0,α)` 或 `#000α(α)` —— 且 **α ∈ [0.04, 0.28]**（规格 §2.4），**不计入 C1**。
不豁免的：带色相的阴影（如 `rgba(38,49,72,.16)`）、α 越界、命名色 `black`、以及 `box-shadow` 之外的任何字面色。

**门禁本身已被夹具证伪过（4 负 1 正）** —— 一个从不判红的门禁不是证据：

| 夹具 | 构造 | 期望 | 实测 |
|---|---|---|---|
| C1 | CSS 里引用第 18 个 token `--dsw-alias-label-tertiary` | FAIL | ✅ `C2 = FAIL 集合外 1 个` → **exit 1** |
| C2 | `box-shadow:0 8px 24px rgba(38,49,72,.16)`（带色相） | FAIL | ✅ `C1 hardcoded = 1` → **exit 1** |
| C3 | `color:#3b82f6`（非 shadow 位置） | FAIL | ✅ `C1 hardcoded = 1` → **exit 1** |
| C5 | `box-shadow:0 4px 12px rgba(0,0,0,.6)`（α 越界） | FAIL | ✅ `C1 hardcoded = 1` → **exit 1** |
| C4 | `box-shadow:0 8px 24px rgba(0,0,0,.16)` + 闭集内 token（合法的浮层样式） | PASS | ✅ `shadow 豁免 = 1`、`C1 = 0`、`C2 = PASS` → **exit 0** |
| A/B | 基线 `7cb3362` 与工作区 `client/index.js` | PASS | ✅ 两份均 `C1=0 / C2=PASS / exit 0`（基线 88 规则 / 13 token） |

**输出样例（基线，exit=0）**：

```
rules                = 88
distinct --dsw-* vars= 13
C1 hardcoded colors  = 0  <== PASS
C1 shadow 豁免（中性半透明黑，α∈[0.04,0.28]）= 0
C2 token set ⊆ allow = PASS
S1 label-dimmed 域   = OK（未使用，或只用于 :disabled/::placeholder）
==> EXIT 0（门禁通过）
```

**第二道自查（渲染侧，实现轮跑；本文给出的断言）**：在 light/dark 两种 `colorScheme` 下各取一次
`getComputedStyle(document.documentElement).getPropertyValue('<17 个 token>')`，断言 **非空且不为 `initial`**，并断言面板 root 的 `color-scheme` 与主题一致。
（已有一条独立交叉校验可复用：T27 §0.1 实测 dark 下面板底色 `rgb(35,35,36)` = 本文算出的 `bg-layer-1` dark `#232324`。）

### 1.6 与基线的对照（现状 88 条规则都用了什么）

| 基线 token | 基线出现次数 | 基线用法 | 本文的处置 |
|---|---|---|---|
| `label-secondary` | 17 | 副标题、路径、说明、底栏小字 | **保留**，但把"时间戳/计数"也统一到这里 |
| `brand-primary` | 12 | 链接文字、chip 边框、下拉 hover | **保留**（含语义：选中竖条 / 主按钮），**但删掉"hover 时文字变黑"这种"颜色即反馈"**（§5.1 改用填充） |
| `state-error-primary` | 9 | 错误块、危险按钮描边/填充 | **保留**，但**限定非文本用途 + 确认层填充**（§4.3） |
| `bg-layer-2` | 8 | 头部、卡片、错误块、结果条 | **保留**，但明确"嵌套一层"语义（§2） |
| `border-l1` | 8 | 分隔线、卡片框、缩进竖线 | **保留** |
| `label-primary` | 8 | 正文 | **保留** |
| `border-l2` | 5 | 控件描边 | **保留** |
| `bg-base` | 4 | 下拉/按钮/输入框填充 | **保留**（F0） |
| `bg-layer-1` | 3 | root、危险按钮 hover 的字色 | root 保留；**"用背景色当字色"（`color: bg-layer-1`）禁止**（跨主题会翻车，§4.3） |
| `state-warn-primary` | 3 | 漂移文字 + 确认标题 | **改为只做形状**（§4.2） |
| `state-idle-primary` | 2 | 未运行圆点 | **保留 + 加形状冗余**（§4.2） |
| `state-success-primary` | 1 | 运行中圆点 | 同上 |
| `specific-sidebar-fill` | 1 | 底栏背景 | **保留**，并升格为 chrome 档（FC） |

---

## 2. 层级与容器策略

### 2.1 容器逐项规格（可判）

| 容器 | 填充档 | 描边 | 圆角 | 内边距 | 外边距 | 为什么 |
|---|---|---|---|---|---|---|
| **面板 root** | F1 `bg-layer-1` | 无 | 0 | 0 | 0 | 面板是画布，不与外壳争层级 |
| **头部** | F1 `bg-layer-1` | `S1` 只加 `border-bottom` | 0 | `10px 14px` | 0 | **不能用 FC**：FC 与 F1 在 light 差 1.05:1，等于没有；头部与主体的分界由 `S1` 承担（§2.3） |
| **主体 body**（滚动区） | 继承 F1 | 无 | 0 | `8px 8px 4px` | 0 | `flex:1;min-height:0;overflow:auto`（§6.1 的高度预算） |
| **目录浏览器卡片** | F2 `bg-layer-2` | `S1` 1px 全框 | `6px` | `8px 10px` | `0`（父 gap 8） | "嵌套一层"的官方语义；dark 下 1.35:1 可见，light 下靠 `S1` |
| **条目列表区**（卡片内的滚动体） | 继承 F2 | **无内部框** | 0 | `0` | `0` | 列表**不是**第二个容器：它已经"在卡片里"。再画一层框 = "框套框"，是基线"一条纵轴平铺"的观感来源之一 |
| **折叠详情**（诊断） | 无（透明） | `S1` 只加 `border-top` | 0 | `6px 4px` | `0` | 它要"轻"（T27 §9.1-V5）：只有一条分隔线 + `T2` 摘要 |
| **底栏** | FC `specific-sidebar-fill` | `S1` 只加 `border-top` | 0 | `9px 12px` | 0 | 官方 "Sidebar column and title-row background"；两主题都比内容面暗 ⇒ chrome 语义同向 |
| **`⋯` 菜单浮层** | F3 `bg-overlay` | `S2` 1px 全框 | `6px` | `4px`（内层菜单项自管） | `4px`（与触发元素的间隙） | 官方 "Overlay and popover background"；`S2` 因为它是**可交互**的浮层 |
| **确认弹层** | F3 `bg-overlay` | `S2` 1px 全框 | `6px` | `12px` | `8px`（内联在 body 内，不遮罩整屏，见 T27 §5.2） | 复用浮层档：它与 `⋯` 菜单是同类东西，不需要第三档 |
| **结果条 / 错误块** | F2 `bg-layer-2` | `S1` 全框（错误块用 `state-error-primary` 描边） | `6px` | `8px 10px` | `0` | 它们是**内联**反馈（不是浮层），所以不占 F3 |
| **只读"其它实例的守护"**（诊断区内） | 继承（透明） | `S1` 全框 | `4px` | `6px 8px` | `0` | 只读 ⇒ **不用 `S2`**（`S2` 会假装可点） |

### 2.2 可判规则（写死）

1. **容器一律 `F2 + S1`；只有"浮在内容之上"的东西才用 `F3 + S2`。** （`F3` 是 overlay 语义，把它当容器用会让 light 主题出现一整块灰蓝。）
2. **`S2` 是交互信号**：只有可点/可输入/可聚焦的元素才允许 `S2`。纯容器用 `S2` = 视觉上说谎。
3. **嵌套再进一层才升档**：root(F1) → 卡片(F2) → 卡片内不再有填充档（列表/行靠叠加层 `interactive-*` 表达状态）。**最多两层填充**；第三层由**`S1` 缩进竖线**表达（§2.3）。
4. **浮层最多一块**：同屏不允许两个 `F3` 面（`⋯` 菜单与确认层互斥）。
5. **分隔线只允许出现在三条位置**：头部下沿、底栏上沿、折叠详情上沿。其余分隔靠"卡片框"而不是"横线"（基线的病灶之一就是每个语义块之间都有横线，读起来像一堆碎片）。
6. **圆角只有 3 档**：`3px`（小徽标/图标按钮内部）、`4px`（控件：按钮/chip 之外的行/只读块）、`6px`（容器/浮层）、`999px`（chip 胶囊）。**禁止**给容器混用。
7. **`z-index` 只有两档**：`0`（普通内容）、`30`（浮层）。**禁止**出现第三个值。
8. **阴影只在浮层**：面板内任何容器**不得**用 `box-shadow` 表达层级（一律 `none`）；浮层的阴影按 §2.4（中性半透明黑，α ∈ [0.04,0.28]），且**不得作为唯一分离手段**。**验收**：断言面板内卡片/分组的计算 `box-shadow === "none"`。

### 2.3 light 主题"层级塌缩"的补偿（本文最重要的一条视觉结论）

**事实**：light 下 `bg-layer-1 = bg-layer-2 = bg-layer-3 = #ffffff`（实测）。
**后果**：任何"靠背景色区分层级"的设计在 light 上收益为 **1.00:1（完全不可见）**。
**这就是基线 `ux-01-overview-light.png` 里"目录卡片看起来只是漂在白底上的一条细线"的原因**；在 `ux-07-dark.png` 里同一张卡片却有清晰的面（`#2c2c2e` on `#232324`）。

**规格：层级三件套（light 与 dark 都必须成立）**

| 通道 | 承担什么 | 具体参数 | light 实测 | dark 实测 |
|---|---|---|---|---|
| ① 背景档 | 只在**档位真实不同**时表达层级 | 见 §1.4 | `layer-1→2` = 1.00（**无效**） | 1.35（有效） |
| ② 描边 | **容器识别的主通道** | `S1` = `border-l1` 1px | 1.09:1 | 1.19:1 |
| ③ 缩进 / 竖线 | 表达"嵌套在第几层" | 每层 `padding-left: +16px`，并在嵌套容器的左侧画 `1px S1` 竖线（基线已有此手法：`.dsh-rw-workspaces{border-left:1px solid border-l1}`） | 竖线本身 1.09:1，但**位置差 16px 是几何差异，不依赖对比度** | 同 |

> **为什么用几何差异兜底是对的**：WCAG 1.4.11 要求的是"**识别控件及其状态**所需的视觉信息"达到 3:1。层级（"这个块属于哪个父块"）由**位置/缩进**表达时，不是"靠一条 1.09:1 的线"在表达，因此不受 3:1 约束；而"这是一个控件"由**文字标签 + `S2` 描边 + hover 反馈**三条一起表达（§8.4-C3）。**这不是绕过标准，是把"识别依据"从不可达的通道换到可达的通道上。**

### 2.4 阴影规则（lead Q4 裁决）

| 项 | 规格 | 为什么 |
|---|---|---|
| **允许用在哪里** | **只允许"面板外浮层"**：`⋯` 菜单、二次确认弹层（即 §1.4 的 `F3` 面）。**面板内**的卡片、分组、结果条、错误块**一律不得**用阴影表达层级 | 面板内层级已由"背景档 + 描边 + 缩进"三件套表达（§2.3）；再叠阴影会让 light 的层级变成"影子游戏"，且与 DSH 原生简洁风冲突 |
| **颜色** | **只许中性半透明黑**：`rgba(0, 0, 0, α)` 或 `#000α(α)`。**禁止**带色相的阴影（如 `rgba(38,49,72,·)`——那是"蓝黑"，会随主题偏色） | Q4 原文要求"不带主题色相" |
| **α 区间（文档化）** | **`α ∈ [0.04, 0.28]`**；本规格的**规范取值只有两个**：**菜单 `0.08`**、**确认弹层 `0.16`** | 低于 0.04 看不见（等于没加），高于 0.28 在 light 下会变成一块灰污 |
| **几何** | 菜单：`0 4px 12px`；确认弹层：`0 8px 24px`（`box-offset-y / blur` 随"离页面更远"递增）。**不加 spread**（`0 0 0 Npx` 是描边，不是阴影） | 用几何表达"浮得多高"，不靠加深颜色 |
| **不得作为唯一分离手段** | 浮层**必须同时**具备 `F3` 填充 + `S2` 1px 描边 +（浮层内可聚焦项的）1px 内圈（§5.2）。阴影**只是第四层冗余** | Q4 原文；也是本文 §8 的实测结论：`bg-overlay` 与内容面在 light 只差 **1.18:1**，单靠阴影在浅色背景下不可判 |
| **门禁** | `css-token-audit.mjs` 对"`box-shadow` 声明里的中性半透明黑 + α ∈ [0.04,0.28]"**窄豁免**；带色相、α 越界、命名色 `black`、以及 `box-shadow` 之外的任何字面色**照旧判红**（§1.5） | Q4 原文"窄豁免" |
| **验收** | ① 断言 `box-shadow` 计算值只出现在浮层选择器上（面板内卡片为 `none`）；② 断言其颜色为 `rgba(0, 0, 0, α)` 且 α ∈ [0.04,0.28]；③ 门禁 exit 0 | 可判 |

---

## 3. 尺度表

### 3.1 间距阶梯（基数 4；只允许下表的值）

| 值 | 用在哪 |
|---|---|
| `2px` | 图标与文字之间（紧凑：chip 内、徽标内） |
| `4px` | 菜单项之间的间隙；浮层内边距 |
| `6px` | 卡片内部行间距（chips ↔ 面包屑 ↔ 输入行）；chip 之间 |
| `8px` | 卡片之间、行内动作之间的间隙、卡片内边距（纵向） |
| `10px` | 卡片内边距（横向）、头部纵向内边距 |
| `12px` | 底栏横向内边距、确认层内边距 |
| `14px` | 头部横向内边距 |
| `16px` | 每层缩进步长 |
| `20px` | 树的"发行版行"缩进（基线值，保留） |

**禁止**：`5px`、`7px`、`9px`、`11px`、`13px`（奇数且不在阶梯上）。基线里存在 `padding:5px 8px`、`padding:7px 12px`、`gap:10px` 混用 —— 本文统一到上表。

### 3.2 圆角

| 值 | 用在哪 |
|---|---|
| `3px` | 面包屑段、图标按钮的命中盒内层 |
| `4px` | 按钮、路径输入框、行、只读小块的内部框 |
| `6px` | 卡片、浮层、结果条、错误块、确认层 |
| `999px` | chip（胶囊）、徽标、状态点（`border-radius:50%`） |

### 3.3 字号 / 行高 / 字重

| 用途 | 字号 | 行高 | 字重 | token |
|---|---|---|---|---|
| 面板标题 | `13px` | `20px` | `600` | `label-primary` |
| 副标题 / 目标路径 | `12px` | `16px` | `400` | `label-secondary` |
| 分组标题（"浏览目录"/"诊断信息"） | `12px` | `16px` | `600` | `label-secondary` |
| 正文（列表项名、按钮文字、菜单项、状态句） | `13px` | `20px` | `400`（**当前项 600**） | `label-primary` |
| 元信息（路径、计数、时间、说明） | `12px` | `16px` | `400` | `label-secondary` |
| 徽标（`默认发行版` / `当前目标` / `未物化`） | `11px` | `16px` | `400` | `label-secondary` |
| 原始诊断块 | `12px` | `18px` | `400` | `label-primary`，**等宽字体** |

**根字号不设**（继承外壳 `13px`，基线一致）。**禁止** `font-size` 出现 `10px`（11px 是下限，仅徽标）或 `>14px`（面板内不该有更大字，标题靠字重而非字号抬层级）。

### 3.4 图标

| 项 | 规格 | 为什么 |
|---|---|---|
| 视觉尺寸 | **16×16**（`viewBox="0 0 24 24"`，`width/height=16`） | 与 13px 正文的 x-height 匹配；24 网格允许 1.5 描边不糊 |
| 命中盒 | **24×24**（图标外包一层 24×24 的按钮，`display:inline-flex;align-items:center;justify-content:center`） | T27 §5.3 的硬约束（V1）；也是"精细度妥协"的通行值 |
| 描边 | `stroke-width: 1.5`（`currentColor`，`stroke-linecap/linejoin: round`，`fill:none`） | 与 baseline rail 图标同一套（`client.icon.js` 用 1.6/24 网格，本文统一 1.5） |
| 颜色 | **一律 `currentColor`**，由父元素给 `T1`/`T2`/状态色 | 基线列表项用的是 **emoji `📁` `📄`**（实测 2+1 处 surrogate pair）——emoji 不吃 `currentColor`、跨平台宽度/基线不一致（见 §9.3-P1）。**本文要求面板内零 emoji，全部换成内联 SVG** |
| 装饰性图标 | `aria-hidden="true" focusable="false"` | 可访问名由按钮的 `aria-label` 提供（T27 §6，基线已达标 `unnamed=0`，不回退） |
| 命中盒不重叠 | 相邻行的 24×24 命中盒之间**垂直净距 ≥4px** | T27 的复核修正 B1：32px 行高 + 24px 盒 ⇒ 净距 8px ✅。**规则化**：`行高 ≥ 命中盒高 + 4` |

#### 3.4.1 命中区最小尺寸（**可断言，T43 对账后定稿**）

> **规则（全文唯一口径）**：凡是**参与点击**的元素（`a` / `button` / `[role=button]` / `label` 包裹的开关 / chip），其 **`getBoundingClientRect()` 的宽与高都必须 ≥ 24px**。
> 依据：WCAG 2.2 **SC 2.5.8 Target Size (Minimum) = 24×24 CSS px（AA）**。

| 项 | 规格 | 为什么不是别的数 |
|---|---|---|
| **全局最小** | **≥24×24** | 2.5.8 是 AA 门槛，也是本项目唯一需要引用的标准数字 |
| **`⋯`（破坏性动作唯一入口）** | **≥24×24，且不得被压缩**（`flex:none`） | **明确不要求 32×32**：32 不是任何 WCAG 阈值（2.5.5 的 AAA 是 44×44，与"底栏=一行 chrome"的角色冲突）。误触风险由 ① 与相邻控件净距 ≥8px ② 二次确认 ③ 焦点环 共同承担，**不需要再造一个私有数字去抬高底栏高度** |
| **chip** | 高度 ≥24（已有），**宽度补 `min-width:24px` + `justify-content:center`** | chip 宽度是内容驱动的：单字符 chip（如 `/`）实测 **22.7×24** ⇒ 差 1.3px。虽然 2.5.8 的"间距例外"可能救它（间距 6px + 22.7 宽 ⇒ 中心距 28.7 > 24），但**一行 CSS 就能达标，不必走例外** |
| **命中盒在 flex 容器里** | 必须显式 **`flex:none`**（或 `flex-shrink:0`） | **这是 T43 实测出来的系统性坑**：`.dsh-rw-iconbtn{width:24px}` 在底栏 `display:flex` 里默认 `flex-shrink:1`，`min-width:auto` 退到内容宽（16px 图标）⇒ `⋯` 在 320/359/360/419/420 被压成 **16–21×24**（8 档里 5 档不达标）。**只有 `flex:none` 能让"声明的 24"变成"渲染的 24"** |
| **豁免（必须在验收集里显式列出，否则断言会误红）** | ① 非交互元素（纯文本/图标/徽标）；② `:disabled` 的控件；③ 整行可点时的**行本身**（行高 32 已 ≥24） | 豁免必须有理由，不允许"自然漏掉" |

**可断言清单（实现轮直接用）**：

```js
// 除豁免外，所有可点击元素的盒子都必须 ≥24×24
const hit = [...panel.querySelectorAll('button,[role="button"],a[href],label')]
  .filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
  .map(el => ({ cls: el.className, r: el.getBoundingClientRect() }))
  .filter(x => x.r.width < 24 || x.r.height < 24);
// 期望： hit.length === 0
```

#### 3.4.2 `box-sizing`（**同一个根因的另一半，T43 对账后新增**）

> **规则**：**任何同时声明 `height`/`width` 与 `padding`/`border` 的规则，必须显式写 `box-sizing:border-box`。**

为什么这条是硬约束（实测依据，见 `out-08-box-sizing-audit.txt`）：

| 事实 | 证据 |
|---|---|
| 宿主 DSH 的 CSS **没有全局 `box-sizing` 重置** | `app.asar` 里 235 处 `box-sizing:border-box` **全是逐组件 class 形态**（通配/伪元素命中 3 处均为误配，表单控件形态 0 处）⇒ **插件不能指望宿主兜底** |
| 表单控件（`<button>`）**看起来正常**是元素自身的默认行为 | 实测反推：`.dsh-rw-btn{height:28px;padding:4px;border:1px}` 渲染 **28**（不是 38）、`.dsh-rw-chip{height:24px}` 渲染 **24**（不是 26）⇒ 这两个 `<button>` 是 border-box |
| 非表单元素**没有兜底** | `.dsh-rw-status` 是 **`<footer>`**：`height:36px` + `padding:9px 12px` + `border-top:1px` ⇒ 渲染 **36+18+1 = 55**（= T40 实测的 55 ✅） |
| 同一 bundle 里只有 3 处显式声明 | `.dsh-rw-row` / `.dsh-rw-recent-row` / `.dsh-rw-menuitem`（作者在那三条想过这件事，其余漏了） |

**因此**：底栏 55（§7.2.3）与"空心状态点外径 10–11 而非 8"（§7.2.3）**是同一个根因**的两个现象 —— 都用"显式 `box-sizing:border-box`"修。
**自查**：`node tools/box-sizing-audit.mjs client/index.js dsh-rw-`（列出"声明高度 → 实际渲染高度"的差额；§10 有用法）。

### 3.5 列表 / 树的行高与缩进

| 项 | 值 | 为什么 |
|---|---|---|
| 列表行高 | **`32px`**（内容 20px + `padding:6px 8px`，行与行之间 `gap:2px`） | ① T27 §5.3 要求 ≥32px；② 保证 24×24 命中盒净距 8px；③ 900px 视口下条目区约 500px ⇒ 仍能显示 **≈15 行**（T27 §9.2 已确认"不破坏信息量预期"） |
| 行内边距 | `6px 8px`（`border-radius:4px`） | 与 32px 行高配套 |
| 树缩进 | 每层 `+16px`；**容器左侧 1px `S1` 竖线** | §2.3 通道③ |
| 缩进下的行宽 | 行**撑满**容器宽度（`width:100%`） | hover 覆盖层要覆盖整行，否则"可点区域"看起来大于"可点区域实际" |
| 行内元素顺序 | `[图标16] [名称 flex:0 1 auto] [徽标×n flex:none] [动作组 flex:none]` | **动作紧跟内容，禁止 `margin-left:auto` 右端对齐**（基线把 `在新会话中打开`/`复制路径` 推到面板最右端：`ux-01` 里名称在 x≈390、动作在 x≈1220，鼠标要横跨 **830px**；这是实测的可用性缺陷，不是审美问题） |
| 动作组占位 | 始终占位（`visibility`/`opacity` 切换，**不用 `display:none`**） | 保证 hover 时**零布局位移**（否则行内容会在鼠标进入的瞬间跳动，点击目标移动） |

### 3.6 对齐规则

1. **左对齐基线**：所有行的左缘对齐到容器的 `内边距` 之后；图标列固定 16px + `gap 6px`，因此**名称列左缘在所有行上严格对齐**（emoji 会破坏这一条，见 §3.4）。
2. **数字右对齐**：只有"计数"这类会变化的数字用 `font-variant-numeric: tabular-nums`，且同类数字在同一列。
3. **`min-width:0` 链**：任何参与省略的 flex 祖先都必须 `min-width:0`，否则 `text-overflow:ellipsis` 不生效（基线已踩过：路径列靠 `direction:rtl` 绕，结果渲染反了，见 F35）。
4. **禁止垂直居中错位**：图标与文字同行时用 `align-items:center` + 固定行高，**不用 `line-height` 凑**（否则 16px 图标相对 13px 文字会偏 1–2px）。

### 3.7 长路径的省略策略 + tooltip 规则

**路径在面板里出现 4 处**：头部副标题、面包屑、路径输入框、列表项名。各自策略不同：

| 位置 | 策略 | 为什么 |
|---|---|---|
| 头部副标题 | **只显示 distro + cwd**，整体 `text-overflow:ellipsis`（尾部省略）；完整值给 `title` | 副标题是"我在哪"的摘要，不是导航 |
| 面包屑 | **不省略**，`overflow-x:auto`（横向滚动），当前段 `600` 且 `cursor:default` | 面包屑的作用就是"能点到任一层"，省略掉就等于删掉了入口 |
| 路径输入框 | 原生 `<input>` 的横向滚动（**不用省略号**），`direction:ltr;unicode-bidi:isolate` | 输入框必须能显示光标位置的字符；`ellipsis` 会让用户看不到自己正在编辑的尾部 |
| 列表项名（可能是目录名） | `text-overflow:ellipsis` **尾部省略** + `title` = **完整 WSL 路径**（不是名字） | 用户需要的是路径；名字在行内已可见 |

**方向与 tooltip 规则（F35 的教训，写死）**：
- 任何内嵌 WSL 路径 / 命令 / JSON 的文本容器：`direction:ltr; unicode-bidi:isolate; text-align:left`。
  **不用 `plaintext`**（基线与 F35 复验用的是 `plaintext`，它的方向由"首个强字符"决定：本例以中性 `/` 开头后接 LTR 所以恰好正常；若将来 label 以强 RTL 字符开头仍会翻向 —— T27 §3 F35 的"残留小瑕"已指出，本文采纳其建议改为 `isolate`）。
- 所有被省略的文本 **必须**有 `title`（完整值），且 `title` 不承担**必要语义**（T27 §7-M9：语义必须常显，不能藏在 `title`）。
- 面板内**不使用**"中段省略"（`/home/…/dsh1` 这种） —— 纯 CSS 做不到，且它与"路径是层级结构"的心智模型冲突；要表达层级请用面包屑。

### 3.8 尺度对照（基线 → 本文 → 为什么）

| 项 | 基线（`7cb3362`） | 本文 | 为什么改 |
|---|---|---|---|
| 列表行高 | `padding:4px 6px` + 13px ⇒ ≈24px | `32px` | 24px 行放不下 24×24 命中盒（净距变负 ⇒ 误点邻行） |
| 列表项名宽度 | `max-width:280px`（工作区名） | 交给 flex + `ellipsis`（无魔法数） | 固定 `max-width` 在窄面板下会溢出，在宽面板下浪费 |
| 行内动作位置 | 右端对齐（`margin-left:auto` 效果） | 紧跟名称 | 实测 830px 的鼠标行程 |
| 目录列表高度 | `max-height:220px` | `flex:1`（吃满卡片剩余高度） | 固定 220px 是"内容只占顶部"的直接原因之一（§6.1） |
| 标题字号 | `13px/1.5` | `13px/20px 600` | 行高数值化，避免 `.5` 行高导致的 1px 抖动 |
| 禁用 | `opacity:.55` | `label-dimmed` + `border-l1` | 透明度会连带削弱描边/图标，且跨主题不可预测（§5.5） |
| emoji 图标 | `📁`/`📄`（3 处） | 内联 SVG `currentColor` | 不吃主题色、跨平台宽度不一致、破坏左对齐（§9.3-P1） |

---

## 4. 状态色语义 + 非颜色冗余

### 4.1 六态定义表（**形状是第一编码，颜色是第二**）

| 状态 | 何时 | 颜色 token | **非颜色编码（形状 + 文案）** | 色盲可辨性 | 颜色单独对比度（light / dark） |
|---|---|---|---|---|---|
| **守护运行中** | `daemon.running=true` 且 slot = 本实例 | `state-success-primary` | **实心圆**（8px）+ 状态词「远端守护运行中」 | ✅ 实心 vs 其他都是空/带形 | 2.28 / 6.89 → **light 不达标** ⇒ 靠形状+文案 |
| **守护已停止** | `running=false` | `state-idle-primary` | **空心圆**（8px，`border-l2` 1.5px 环 + `bg-base` 填充）+ 「远端守护未运行」 | ✅ 空心 vs 实心 | 1.48 / 2.10 → 两侧都不达标 ⇒ 靠**环的形状**+文案 |
| **漂移（drift）** | `drift.drifted=true` | `state-warn-primary` | **等边三角形**（10px，尖端向上）+ 「配置已漂移」 | ✅ 三角 vs 圆 | 2.15（light）/ 7.31（dark）→ light 不达标 ⇒ **禁止当文字**，只做形状 |
| **错误** | 读取失败 / 动作失败 | `state-error-primary` | **圆内叉**（10px）或错误块的 1px 描边 + 标题「读取失败」 | ✅ 叉形 | 4.50（文字，light，勉强）/ 4.77（dark）；作为非文本 4.50 / 4.24 ✅ |
| **只读** | `others[]`（其它实例的守护） | `label-secondary`（**不用状态色**） | 文案「只读」+ **锁形图标**（12px）+ 「本面板不会对它发起任何动作」 | ✅ 文字承担 | 5.80 / 10.42 ✅ |
| **禁用** | 动作在飞（busy）或不可用 | `label-dimmed` | 文案不变（**不改成"不可用"**）+ `aria-disabled`；可选：行内「…中」 | ✅ 文字承担 | 豁免（1.07 / 1.65）§8.4-A4 |

### 4.2 为什么必须"形状先行"

light 主题实测（`out-03-contrast.txt`）：

| 状态图形 | light 对比度 | 判据（非文本 ≥3:1） |
|---|---|---|
| `success` 圆点在 `layer-1` 上 | **2.28** | ❌ |
| `success` 圆点在 `success-tertiary`（绿底徽标）上 | **2.09** | ❌（底色徽标反而更差） |
| `warn` 三角/文字在 `layer-1` 上 | **2.15** | ❌ |
| `warn` 在 `warn-tertiary` 上 | **1.99** | ❌ |
| `idle` 圆点在 `layer-1` 上 | **1.48** | ❌ |
| `idle` 圆点在 `sidebar-fill` 上（底栏） | **1.48** | ❌ |
| `error` 作为非文本（描边/图标/填充） | **4.50** | ✅ |

⇒ **结论（可判）**：`success` / `warn` / `idle` 三个状态色在 light 主题**无法**独立承担"识别状态"的责任。
因此本文规定 **两条同时生效**：

1. **状态词常显且永不省略**（与 T27 的复核修正 B2 一致）：底栏状态句里「未运行 / 运行中 / 读取失败」这一段**放在不发生省略的 `span` 上**；只有"会话 N 个"这类附加信息允许 `ellipsis`。
   **验收**：在 **320 / 359 / 360 / 419 / 420 / 719 / 720 / 1280** 各宽度下截图，状态词的 `getBoundingClientRect().width > 0` 且 `scrollWidth <= clientWidth`（未被截断）。
2. **形状必须能区分**：实心圆 / 空心圆 / 三角形 / 叉 —— 四者在 16×16 下灰度化后仍可区分（去色截图可判）。

#### 4.2.1 可判条目：状态项**必须同时具备 2 种非颜色线索**（T27 第二轮约束 #2 / lead 收口）

**规则（WCAG 1.4.1 的落地形式）**：

> **任何表达"状态"的元素，必须同时具备 ① 一个文字状态词 与 ② 一个形状/图标 两种非颜色线索。颜色只能是第三条冗余。**

| 状态 | ① 文字状态词（必须常显，不可只用 `title`） | ② 形状/图标 | ③ 颜色（冗余） | 判据 |
|---|---|---|---|---|
| 守护运行中 | 「远端守护运行中」 | 实心圆 | `state-success-primary` | 三者齐备 |
| 守护已停止 | 「远端守护未运行」 | 空心圆 | `state-idle-primary` | 三者齐备 |
| 漂移 | 「配置已漂移」 | 等边三角形 | `state-warn-primary` | 三者齐备（**颜色单独 2.15:1，不达标 ⇒ 靠 ①②**） |
| 错误 | 「读取失败」 | 圆内叉 / 红色描边块 | `state-error-primary` | 三者齐备 |
| 只读 | 「只读」 | 锁形图标 | **不给状态色**（用 `label-secondary`） | ① + ② |
| 禁用 | 文案不变 + `aria-disabled` | —（可由 `cursor` 辅助） | `label-dimmed` | ① 为主；豁免域 |

**验收（可判，能红）**：
1. 对每个状态元素，断言其**可见文本**包含状态词（不是只在 `title`/`aria-label` 里）——把状态词删掉即红；
2. 断言该元素内含一个 `<svg>`（形状）——把图标删掉即红；
3. **灰度检查**：对面板截图做 `filter: grayscale(1)`，四种守护状态（实心圆/空心圆/三角/叉）两两可区分；
4. **新增状态色的前置条件**（写给未来）：**任何以后新增的状态色，必须同时给出它的"形状 + 文字"两通道，否则不得进入面板**。这条把 T27 的约束变成一条可执行的准入规则，而不是一次性修补。

### 4.3 "破坏性" ≠ "错误"（回答 T27 §9.1-V4）

T27 要求"danger 与 error 用不同 token 或不同形态"。本文的裁决：

| 场景 | 用色 | 形态 | 为什么 |
|---|---|---|---|
| **错误**（读取失败、动作失败） | `state-error-primary` | **描边 + 标题文字 + 圆叉图标** | 这是"出事了"，必须高唤醒 |
| **破坏性动作**（停止/重启守护）**在菜单里** | **不用红色** —— 文字 `label-primary` + `state-error-primary` 的**图标**（仅 16×16 的叉/警示形状） | 菜单项 | T27 §5 要求"绝不常显" ⇒ 它已经在菜单里，红色在菜单里只是噪音；且红色若常驻菜单会让"菜单=危险"泛化 |
| **破坏性动作的确认按钮** | **填充** `state-error-primary`，文字 `bg-layer-1` | 实心按钮 | 这是**用户已经按下并进入确认流程**的唯一时刻，红色在这里才有信息量 |

**验收**：`重启/停止` 的**菜单项**计算样式 `color` 必须是 `label-primary`；确认层主按钮的 `background-color` 必须是 `state-error-primary`。
**注意**：基线的 `color: var(--dsw-alias-bg-layer-1)`（用背景 token 当字色）**禁止** —— 它在 dark 下会变成深色字压深色面（§1.6 已列）。本文明确"确认按钮的字色"取 `bg-layer-1` 是**唯一例外**，且必须**同时**断言该按钮的 `background-color` 是 `state-error-primary`（即"深底浅字"关系被按钮自己保证，而不是依赖主题）。

---

## 5. 交互态视觉

### 5.1 hover / active / 选中 / 当前（回答 T27 §9.1-V7：两态必须可区分）

| 态 | 填充 | 其它通道 | light 实测 | dark 实测 | 说明 |
|---|---|---|---|---|---|
| **静息** | 无 | — | — | — | — |
| **hover** | `interactive-bg-hover` | **无竖条、无字重变化** | 叠加后 1.11:1（**是可感知的浅色变化，不是对比度门禁项**） | 1.27:1 | 只用"填充"这一个通道，避免与"当前"混淆 |
| **active（按压）** | `interactive-bg-active` | 无 | 1.20:1 | 1.57:1 | 比 hover 重一档，两主题同向 |
| **选中 / 当前** | **不填充** | ① 左侧 **2px `brand-primary` 竖条**；② 文字 `label-primary` **600**；③ 可选 `bg-base` 底（dark 下形成"凹"） | 竖条 18.90:1 | 竖条 15.03:1 | **与 hover 走完全不同的通道（形状 + 字重），因此两者绝不会混淆**，且灰阶/色盲下同样成立 |
| **选中 + hover** | `interactive-bg-hover` | 竖条 + 600 保留 | — | — | 组合态 = 两通道叠加，语义仍唯一 |
| **选中 + focus-visible** | 同上 | 平台焦点环（§5.2） | — | — | — |

> **判据**：去色（灰度）截图里，"当前行"必须**仅凭竖条 + 字重**就能定位；"hover 行"必须**仅凭填充**就能定位。两态在灰度下**不允许**互相看起来一样。
>
> **为什么"当前"不用填充而用竖条**：① light 下 `bg-layer-2` 与底同色，填充不可用；② 可用为填充的 `bg-overlay`（light `#e9ecf2` / dark `#61666b`）在 dark 下会让**焦点环掉到 2.49:1**（§8.4-C2），把可用性换成了不可达；③ 竖条是形状通道，能同时满足"可辨"与"不抢焦点环的背景"。

#### 5.1.1 alpha 覆盖层必须在**三种背景**上分别成立（T27 第二轮约束 #2）

`interactive-bg-hover/-active` 是 **alpha 色** ⇒ 同一条 CSS 在不同容器上**合成出的终值不同**。所以"V7 两态可区分"必须逐背景各验一次（原始输出：`out-07-overlay-on-surfaces.txt`）。

| 背景 | 主题 | 静息 | hover 终值 | active 终值 | hover/静息 | active/静息 | **active/hover** | 正文/hover | 次要/active |
|---|---|---|---|---|---|---|---|---|---|
| `bg-layer-1`（列表行） | light | `#ffffff` | `#f2f3f4` | `#e9eaec` | 1.11 | 1.20 | **1.08** | 17.01 ✅ | 4.82 ✅ |
| `sidebar-fill`（底栏） | light | `#f9fafb` | `#edeef0` | `#e3e6e9` | 1.11 | 1.20 | **1.08** | 16.29 ✅ | 4.62 ✅ |
| `bg-overlay`（`⋯` 菜单） | light | `#e9ecf2` | `#dee1e8` | `#d5d9e1` | 1.11 | 1.20 | **1.08** | 14.42 ✅ | **4.10 ❌** |
| `bg-layer-1`（列表行） | dark | `#232324` | `#343435` | `#424243` | 1.27 | 1.57 | **1.24** | 11.86 ✅ | 6.66 ✅ |
| `sidebar-fill`（底栏） | dark | `#1b1b1c` | `#2d2d2e` | `#3b3b3c` | 1.25 | 1.54 | **1.24** | 13.19 ✅ | 7.41 ✅ |
| `bg-overlay`（`⋯` 菜单） | dark | `#61666b` | `#6d7277` | `#777c80` | 1.19 | 1.37 | **1.15** | **4.64 ⚠️** | **2.81 ❌** |

**三条结论（可判）**：

1. **hover 在三种背景上都可见**（hover/静息 = 1.11 light / 1.19–1.27 dark，六格全部非 1.00）⇒ T27 §9.1-V7 的"hover 可感知"在三处都成立。
2. **同一个控件上的 hover→active 只有 1.08（light）/ 1.15–1.24（dark）** ⇒ **不靠填充区分按压态与悬停态**（按压是瞬时态且伴随动作发生，不需要独立可辨）。这也**再次证明**"当前/选中"必须走竖条 + 字重通道（1.08 的填充差在灰度/低视力下不可辨）。
3. **`bg-overlay`（`⋯` 菜单）上禁止次级文字**：`label-secondary` 在 hover 底上 dark = **4.64 ⚠️（刚过线）**、在 active 底上 light = **4.10 / dark = 2.81 ❌**。⇒ 菜单项文字**必须** `label-primary`（§7.2.4 已写死，并额外禁止"标题+副标题"两行式菜单项）。

**降级方案（备选记录，本轮不采用 —— lead Q1 已裁定 17 个）**：
hover = `bg-overlay`；选中/当前 = 2px `brand-primary` 竖条（不变）。
**代价**：dark 下 hover 变成一整块 `#61666b` 的中灰（很重，接近"选中"观感）；light 下 hover 是 `#e9ecf2`；且 `bg-overlay` 一旦被 hover 占用，浮层底就没有可用的"明显不同于白底"的面（§8.4-C2）。**V7 仍成立**（"当前"走竖条），但 hover 的"轻"与 light 的浮层面同时失去。

### 5.2 焦点环（`focus-visible`）—— **平台提供，禁止覆盖**

**平台策略（实测自 `app.asar` 的 `focus.css`，逐字）**：

```css
:root{--dsw-focus-ring-width:2px}
:focus-visible{outline-color:var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-width:var(--dsw-focus-ring-width)}
html[data-input-modality=pointer] body :focus-visible:not(:read-write){--dsw-focus-ring-color:transparent; outline-color:#0000}
```

⇒ **`outline` 是全局生效的，不需要我们写一行**。本文的规定只有 4 条：

| # | 规定 | 为什么 / 怎么验 |
|---|---|---|
| F1 | **禁止** `outline:none` / `outline:0`（任何选择器） | `grep -n 'outline' client/**` 只允许出现 `outline-offset` / `outline-width` 的**显式不改色**声明 |
| F2 | 允许 `outline-offset`，取值 ∈ {`0`, `-2px`, `2px`} | `-2px` 用于**贴着滚动容器边缘**的行/按钮（否则 2px 外环会被 `overflow:auto` 裁掉）；`2px` 用于**非浮层**内、四周有 ≥4px 空间的项。**浮层内固定 `-2px`**（浮层只有 `4px` 内边距，`+2px` 的外环会被 `padding` 裁掉 —— T27 第二轮明确要求确认这一点） |
| F3 | **不得**设置 `--dsw-focus-ring-color` | 覆盖它会与上面的"指针模态不画环"策略打架（那是一条**刻意的**产品决策：鼠标用户不需要键盘环） |
| F4 | 焦点环色**不由本文授权**，测值仅用于验证可达性 | 见下表 |
| F5 | **浮层内的可聚焦项必须在两个主题都使用"双色焦点指示"**（不只 dark） | T27 第二轮约束 #3 / lead 收口：dark 是因为测出 2.49:1 才发现的，但"两主题一致"能避免"light 下能看见 dark 下看不见"的分叉；且双色指示是 1.4.11 的通行走法，不挑主题 |

**焦点环对比度（关键 6 组之一）**：

| 焦点环 vs 背景 | light | dark | 判据 ≥3:1 |
|---|---|---|---|
| vs `bg-layer-1`（主体） | **4.23** | **6.75** | ✅ / ✅ |
| vs `sidebar-fill`（底栏） | **4.05** | **7.39** | ✅ / ✅ |
| vs `interactive-bg-hover`（hover 行的底） | **3.81** | **6.38** | ✅ / ✅ |
| vs `interactive-bg-active`（按压/选中的底） | **3.52** | **5.18** | ✅ / ✅ |
| vs `bg-overlay`（**浮层**的底） | **3.58** | **2.49** | ✅ / ❌ **dark 不达标** |

**⇒ 由此派生一条硬规则（C2）**：**`bg-overlay` 只允许用于"非行内"的浮层容器**，且浮层内可聚焦项**必须**使用**双色焦点指示**（F5：两主题都加）：

```
可聚焦项（浮层内，light 与 dark 完全相同的两条）:
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;                                     /* 环画在项的内侧；也避免被 4px padding 裁掉 */
  box-shadow: inset 0 0 0 1px var(--dsw-alias-bg-layer-1);   /* 内圈 hairline，token 色 */
```

**可判构成（≥2 种非颜色线索）** —— lead 收口要求"浮层内必须有 ≥2 种非颜色线索"，逐条：

| # | 线索 | 与谁对比 | light | dark | 判据 |
|---|---|---|---|---|---|
| 1 | **2px 蓝环**（外圈，平台色 `state-business-primary`） | vs 浮层底 `bg-overlay` | **3.58** | **2.49** | light ✅ / dark ❌（单靠它不够） |
| 2 | **1px `bg-layer-1` 内圈 hairline** | vs 第 1 条蓝环 | **4.23** | **6.75** | ✅ / ✅（两主题都 ≥3） |
| 3 | **`outline-offset:-2px` 带来的"环在内侧"几何** | 与静态项对比 | 几何 | 几何 | 不依赖对比度 |
| 4 | **`outline-width:2px` 的可见厚度**（平台值，非 1px） | — | 几何 | 几何 | 平台已保证 |

**结论**：第 1 条在 dark 单独不达标，但"外环 + 内圈"构成**双色指示**：任意单色背景上，**至少有一层**达到 3:1（light：外环 3.58 / 内圈 4.23；dark：外环 2.49 / 内圈 6.75）。因此焦点指示**整体**始终可判 —— 这是 WCAG 1.4.11 认可的双色技法，**且第 3/4 条另给两种与颜色无关的线索**，满足 lead"≥2 种非颜色线索"的要求。

**验收（可判）**：
1. 断言浮层内项的 `box-shadow` 计算值含 `inset` 且颜色 = `--dsw-alias-bg-layer-1` 的解析值，**在 light 与 dark 各断言一次**（证明 F5 的"两主题都加"）；
2. 断言该 `box-shadow` 的 `1px` 内圈**未被裁切**：项的 `getBoundingClientRect()` 内可见（`outline-offset:-2px` 保证环在内侧）；
3. 截图度量："蓝环像素 vs 内圈像素"亮度比 ≥3（dark 下即 6.75，light 下 4.23）。

### 5.3 其它交互态

| 态 | 规格 | 备注 |
|---|---|---|
| `disabled`（真禁用：无对象或权限不足） | 文字 `label-dimmed`；描边从 `S2` 降到 `S1`；`cursor:default`；**不加任何透明度** | §5.5 |
| `aria-disabled` + `busy`（动作在飞） | 文字**保持** `label-primary`（用户仍要读它是哪个按钮）；按钮右侧加 **12px 环形 spinner**（`currentColor` 描边画弧，`animation: 1s linear infinite`）；可选项：文字加 `…中` | T27 §4 的 `busy` 行；**spinner 用形状表达，不用颜色** |
| `active`（按压） | 填充 `interactive-bg-active` | §5.1 |
| 拖拽 | **本版无拖拽**（T27 未定义） | 若将来加"把目录拖成工作区"：`drag-over` = `interactive-bg-active` + 2px **虚线** `brand-primary` 边框（形状通道，不引入新色） |
| `:focus`（非 `focus-visible`） | **不给任何视觉**（让平台决定） | 与平台一致，避免"鼠标点一下也出现环" |

### 5.4 非颜色冗余总表（色盲 / 灰度可辨）

| 要表达的东西 | 颜色通道（可能不达标） | **非颜色通道（必须存在）** | 灰度下可辨？ |
|---|---|---|---|
| 守护运行中 / 已停止 | success / idle | 实心圆 / 空心圆 + 状态词 | ✅ |
| 漂移 | warn | 三角形（尖朝上）+ 「配置已漂移」 | ✅ |
| 读取失败 | error | 圆叉 + 「读取失败」+ 重试按钮 | ✅ |
| 只读 | ❌ 不给色 | 锁形图标 + 「只读」 | ✅ |
| 禁用 | ❌ 不给色 | 文案不变 + `aria-disabled` | ✅ |
| 当前 / 选中 | ❌ 不给色 | 2px 竖条 + 600 字重 | ✅ |
| 可交互（按钮/输入框） | ❌ 边框不达标 | `S2` 描边 + 文字标签 + hover 填充 | ✅ |
| 破坏性 | error（确认层填充） | 菜单里的警示图标 + 二次确认 | ✅ |

### 5.5 为什么删掉基线的 `opacity:.55`

基线用 `opacity:.55` 表达禁用（`.dsh-rw-btn:disabled`、`.dsh-rw-link:disabled`）。问题：
1. 它**同时**削弱文字、描边、图标 —— 于是"哪一部分被削弱"不可控，light 下描边直接消失（`border-l2` 1.26:1 × 0.55 ⇒ 视觉上等同于无边框）；
2. 它是**主题无关**的乘数，而"多暗才够暗"在 light/dark 上答案不同；
3. 它让"禁用"成为一个**只能用眼睛判断**的东西（无法从 token 断言）。

本文改为：文字 `label-dimmed` + 描边降档 `S1` + `cursor:default`，**不透明度恒为 1**。
**验收**：断言禁用按钮的计算 `opacity === "1"` 且 `color` 解析为 `label-dimmed` 的值。

---

## 6. 密度与留白取舍

### 6.1 为什么"这样密"——高度预算（900px 视口，可判）

| 区块 | 高度 | 依据 |
|---|---|---|
| 头部 | **58px** | `padding 10` ×2 + 标题 20 + gap 2 + 副标题 16 |
| 主体 padding | `8 + 4` = 12px | §2.1 |
| 目录浏览器卡片（固定部分） | `8(pad) + 20(head) + 6 + 24(chips) + 6 + 20(crumbs) + 6 + 28(path) + 8(pad)` = **126px** | §3 |
| **条目列表区** | **`flex:1`（吃满）** | 见下 |
| 折叠详情（收起） | **24px** | `6+16+6`+边线 |
| 卡片间距 | 8 ×1 = 8px | §3.1 |
| 底栏 | **47px**（**T43 对账后定稿**） | 公式 `H = max(子元素高) + 2×padding + border-top = 28 + 9×2 + 1`（最高子元素 = `启动守护` 次按钮 28px）。**原写 36 是错的**（按"18 行高 + 18 内边距"算，忽略了底栏里必然存在的 24px/28px 控件）；**实测 55 也是错的**（`height:36` 被 content-box 解释成内容高，多出 19px）。详见 §7.2.3 |
| **条目列表可得高度** | ≈ **900 − 58 − 12 − 126 − 24 − 8 − 47 = 625px** | ⇒ 625 / 34（32 行 + 2 gap）≈ **18 行**（底栏从 36→47 只吃掉 11px，行数不变） |

**结论**：**32px 行高在这个高度预算下不牺牲信息量**（18 行 > 基线实测的 10 行）。T27 §9.2 已确认这一点。

### 6.2 与"内容只占顶部 1/3、下方全空"的关系（本文的取舍）

基线的空白的**根因是结构冗余**（T27 §1-#7：同一路径出现两次）**加上**两个视觉决策：
1. 条目列表固定 `max-height:220px`（**不随高度生长**）；
2. 主体不是"撑满 + 单一滚动体"的布局，而是"若干块自上而下堆叠" ⇒ 块用完后就是裸底。

**本文的规定（两条）**：

| 规则 | 具体 | 为什么 |
|---|---|---|
| **R1 唯一生长体** | 面板垂直方向**只有**"条目列表区"允许生长（`flex:1;min-height:96px`）；其余全部 `flex:0 0 auto`。**面板高度变化只影响可见条目数** | 让"面板高"与"看到更多东西"直接对应；也让"下方全空"变成"列表里还有空间"，观感从"面板没内容"变成"这个目录就这些条目" |
| **R2 列表区外框常驻** | 即使列表为空，卡片的外框（`F2 + S1`）仍然撑满到折叠详情之上 | 空白的**边界**可见 ⇒ 它被读成"列表区域"而不是"页面坏了" |

**反过来说"为什么不再往下加内容"**：面板的职责是"选一个 WSL 目录"（T27 §2.1），任何为了填满高度而新增的区块都会与"运维细节不抢主视线"（T27 §9.1-V5）冲突。**所以留白由 R1 转成"列表内的空间"，而不是靠塞东西。**

#### 6.2.1 窄态文案表（T64 补，据 `client/**` 源码 + 实测）

**触发条件 = 面板自身宽度**（不是视口）：`client.panel.helpers.js:22` 定义 **`NARROW_PX = 420`**，判定写成 `const narrow = width < NARROW_PX`（`client.panel.actions.js:194`）；`width` 由面板自身的宽度观测得到，**与浏览器视口宽度解耦**（实测：视口 320/359/420 时面板实宽只有 **264 / 303 / 364**，都落在窄态区间）。

| 位置 | 键名（`client/i18n` 字典） | 宽态文案 | 窄态（`narrow`）文案 | 代码出处 |
|---|---|---|---|---|
| 头部主按钮（添加工作区） | `action.addWorkspace` / **`action.addWorkspaceShort`** | 添加为 WSL 工作区 | **添加工作区** | `client.panel.header.js:118`（`t(narrow ? "action.addWorkspaceShort" : "action.addWorkspace")`） |
| 头部主按钮（在当前目录开会话） | `browser.openHere` / **`browser.openHereShort`** | 在此目录新建会话 | **新建会话** | `client.panel.header.js:117` |
| 目标 scope hint | `header.distroScope` / **`header.distroScopeShort`** | 仅筛选，不改目标 | **不改目标** | `client.panel.tail.js:256`（`narrow ? t("header.distroScopeShort") : t("header.distroScope")`，`title` 恒为宽态全文） |
| 底栏启动按钮 | `status.start` / **`status.startShort`** | 启动守护 | **启动** | `client.panel.tail.js:281`（busy 时用 `status.startBusy`） |
| 底栏会话数 | —（非键，改由 CSS 承载） | 常显「会话 N 个」（`status.sessions`） | **整块隐藏**（`.dsh-rw-extra--hidden`）⇒ 会话数改由 `⋯` 菜单/诊断承载 | `client.panel.tail.js:274`（`"dsh-rw-extra" + (narrow ? " dsh-rw-extra--hidden" : "")`） |
| 头部主按钮的取舍（N1 互斥） | — | 宽态：会话按钮 + 添加工作区次按钮并存 | **窄态：主体只留 1 个入口**（添加工作区进 `⋯`） | `client.panel.header.js:58`（`if (!narrow && primaryIsSession)`）、`client.panel.tail.js:162`（`if (narrow && primaryIsSession)` 剔除头部那个） |

**T64 实测（zh-CN）** —— 与上表的**对账结果：窄态生效 ✅**（**2026-10-14 复查更正**，见下）

| 视口 | 面板实宽（<420 ⇒ 走窄态） | 头部主按钮**实测**文案 | 底栏启动按钮**实测**文案 | 会话数块 | N1 行盒 | N1b 省略 | N2 单行 | N4 命中盒 ≥24 |
|---|---|---|---|---|---|---|---|---|
| 320 | 264 | **添加工作区** ✅（窄态键） | **启动** ✅（窄态键） | **已隐藏**（`extraHidden=true`） | 1/1/1 ✅ | 无 ✅ | ✅ | **25/25** ✅ |
| 359 | 303 | **添加工作区** ✅ | **启动** ✅ | 已隐藏 | 1/1/1 ✅ | 无 ✅ | ✅ | 25/25 ✅ |
| 420 | 364 | **添加工作区** ✅ | **启动** ✅ | 已隐藏 | 1/1/1 ✅ | 无 ✅ | ✅ | 25/25 ✅ |

⇒ **窄态短文案在 HEAD `58628ed` 上生效**：面板实宽 264/303/364 全部 < `NARROW_PX=420`，渲染的正是窄态键（`action.addWorkspaceShort` / `status.startShort`），会话数块 `dsh-rw-extra--hidden` 亦按规格隐藏；**四行盒 / 不省略 / 按钮单行 / 命中盒 25/25 ≥24 全部达标** ⇒ **"窄态是否需要改文案"的结论：不需要**。

> **⚠️ 更正留痕（T64① 的假红）**：本节的**首版**曾判红（"面板实宽 <420 却渲染宽态文案、会话数未隐藏"），**根因是我测量时所用实例跑的是旧 client 字节**，不是产品缺陷。证伪链：首版实测的 chunk 内容哈希为 `i18n 47525217 / header b5c1a2c0 / tail c946a6c8`，而 HEAD `58628ed` 上为 `i18n 8a1ac1e2 / header 7b4c67ef / tail fefe4775` ⇒ **首版实例的 `client.panel.header.js` 不含 T63 的 `narrow` 三元式**，故渲染宽态文案。复查按可验证流程重做：`git archive HEAD` 干净副本 → 门禁 `tools/check-client-rev.ts` **exit 0**（入口 rev `0d0f1fb9fe9e`，9 chunk）→ **页面 chunk 与磁盘 9/9 逐字节前缀相等**（trailer 判法）→ 重新逐档测量。
> **配套纪律（写进本节，供后续轮次照做）**：**任何入口/文案改动或还原之后，先重启实例再测**（改/还原入口后运行中的实例仍按内存快照服务旧字节，见 `arch-t57/REPORT-m1-checker.md §9.3`）。
> **en locale 仍未复核**：CDP `Emulation.setLocaleOverride('en-US')` **不生效**（面板 `htmlLang` 仍 `zh-CN`）；叠加 `navigator.language` 注入会**打断 SPA 启动**（面板不渲染）⇒ 该面板语言由**宿主侧 inject**，需起一个 **en locale 的宿主实例**（脚本 `arch-t64/t64-narrow.ts --phase narrow --locale en` 已备，含"回读实际语言"防假绿）。

### 6.3 空态 / 加载态 / 错误态（三态视觉，采纳 T27 复核的 V-b）

| 态 | 视觉 | 尺寸 / 位置 | 为什么 |
|---|---|---|---|
| **加载（首次）** | 条目区内渲染 **5 行骨架**：每行 32px，左侧 16×16 圆角 3px 灰块（`interactive-bg-active` 填充）+ 右侧 120/90/160/110/140px 宽、8px 高的圆角条（同上填充），行内 `gap 8px`；**不加动效**（`prefers-reduced-motion: reduce` 时必然静止；默认也只做 1.2s 的 opacity 呼吸，幅度 0.6→1.0） | 骨架占满条目区（**不居中对齐到屏幕中央**） | ① 900px 面板只有一行"正在读取…"会"像坏了"（T27 用 `ux-02` 拍到了这个观感）；② 骨架**占位**能让首帧之后不跳版 |
| **加载（刷新中，已有数据）** | **不换骨架**：保留现有内容，头部刷新按钮进入 `busy`（spinner），底栏状态词不变，戳记**保持不变**直到成功 | — | 有数据时用骨架会"闪一下"，比慢更糟 |
| **空（无目录内容）** | 条目区内一行 `T2` 文案「此目录为空」，下方一行 `T2`「（隐藏文件已隐藏，可打开开关查看）」；**卡片外框保持撑满** | 左对齐，`padding 14px 8px` | R2；文案必须给出"下一步"（T27 §4 的 `empty.mustHaveAction` 针对的是"无发行版"那一格） |
| **空（无发行版）** | 卡片内一行 `T1`「没有发现 WSL 发行版」+ 一行 `T2` 指引（在 Windows 终端运行 `wsl --install -d <发行版>`）+ 一个**次按钮**「刷新」；**不用虚线大框**（基线的 `.dsh-rw-empty` 是 `border:1px dashed` 的 14px 内边距块，在 light 下几乎没有边界感） | 块宽撑满卡片，`padding 12px`，圆角 4px，描边 `S2`（因为里面有按钮） | ① T27 §4 要求空态必有可点动作；② 虚线框在 light 下不可见（`border-l2` 1.26:1），换成 `S2` 实线并**承载一个按钮**⇒ 识别来自按钮而非边框 |
| **错误（读取失败）** | `F2` 块 + `state-error-primary` 的 1px 描边 + `T1 600` 标题「读取失败」+ `T2` 一句原因（**用户语言**）+ **次按钮**「重试」；圆的叉图标 16px 在标题左侧。<br>**正文/详情分层（T43-N3 定稿）**：主句 = `T2` **一句话人话**；**host 原文（`\\wsl.localhost\…`、`ENOENT`、路由、超时）必须进同块的 `<details>` 折叠**（摘要 `T2`、12px、无框无填充、不进 Tab 死停点，与 §7.2.5 同规）。**归属 client 呈现层**（按 T36 已定的"主句人话 + 原文进折叠"模式） | **顶部对齐**（`margin:8px`），块宽撑满，**不垂直居中** | 居中会让它在 900px 高度里"漂在正中"，且错误后事实撤下（T27 §4）只剩一个块 ⇒ 顶部对齐读起来是"页面刚开始就出错了"；正文/详情分层则避免 UNC 路径与重复错误码占据主视线（T40-N3 实测） |
| **错误（局部：目录列表失败）** | 只在条目区内部替换为：一行 `T2`「该目录读不到」+ host 原文进 `<details>` 折叠 + 次按钮「重试」；**卡片其余部分（chips/面包屑/输入框）保持** | — | T27 §4 的"局部错误"格 + 与上一行同一条分层规则（T43-N3） |

**三态共同规则**：
1. 三态都**不改变**头部/底栏的骨架（它们始终在同一位置）⇒ 用户不会因为状态切换而"找不到东西"。
2. 三态里的文字角色只有 `T1` / `T2`（**没有第三档**）。
3. **三态一律不用"居中容器"**（面板是工具面板，不是营销页）。

---

## 7. 线框级视觉稿（逐元素）

> 约定：`←P` = `label-primary`，`←S` = `label-secondary`，`←D` = `label-dimmed`；`[i]` = 16×16 图标；`⟦…⟧` = 24×24 命中盒。
> 宽度断点（与 `usability-engineer` 复核后统一）：**W ≥720** / **420–720** / **<420**（见 §9.3-P6）。

### 7.1 整面板（W ≥720，1280×900 实测基线尺寸）

```
┌ root: F1(bg-layer-1), 13px/1.5, ←P ────────────────────────────────────────────────────────┐
│                                                                                             │
│ 头部 58px · F1 · border-bottom S1 · padding 10 14 · display:flex · justify-content:space-between · gap 10
│ ┌ 标题块 flex:1 min-width:0 ─────────────────────────────┐ ┌ 动作区 flex:none gap 8 ────────┐
│ │ 远程资源管理器            13px/20 600 ←P                │ │ ⟦在此目录新建会话⟧  主按钮      │
│ │ 目标 debian-u8-1 · /home/g/project/dsh1  12px/16 ←S     │ │ ⟦添加为工作区⟧      次按钮      │
│ └ (title 属性 = 完整 cwd；省略号尾部) ────────────────────┘ │ ⟦⟳⟧ 24×24 图标按钮（无文字）    │
│                                                             └────────────────────────────────┘
│
│ body · flex:1 min-height:0 overflow:auto · padding 8 8 4 · display:flex column gap 8
│ ┌ 目录浏览器卡片 F2 + S1 + r6 + padding 8 10 · flex:1 1 auto min-height:0 ─────────────────┐
│ │ 浏览目录（debian-u8-1）  12px/16 600 ←S            [隐藏文件 不显示]  12px ←S   ←常显      │
│ │  ↕ 6px                                                                                    │
│ │ ⟦Home⟧⟦/⟧⟦/mnt⟧⟦/mnt/c⟧⟦/mnt/d⟧⟦/mnt/e⟧⟦/mnt/f⟧⟦/mnt/g⟧   chip: h24 r999 S2 ←S 11-12px   │
│ │  ↕ 6px                                                                                    │
│ │ ⟦/⟧ ⟨sep⟩ ⟦home⟧ ⟨sep⟩ ⟦g⟧ ⟨sep⟩ ⟦project⟧ ⟨sep⟩ ⟦dsh1⟧   crumb 12px；非当前 ←S，当前 ←P 600 │
│ │  ↕ 6px                                                                                    │
│ │ ┌ 路径输入框 F0 + S2 + r4 + padding 3 6 + 12px ←P ─────────────┐ ⟦跳转⟧ 次按钮 28px 高      │
│ │ │ /home/g/project/dsh1                                   (ltr) │                          │
│ │ └───────────────────────────────────────────────────────────────┘                          │
│ │  ↕ 6px                                                                                    │
│ │ ┌ 条目列表 flex:1 min-height:96 overflow:auto · 行 32px · 行间 gap 2 ───────────────────┐ │
│ │ │ [i] vendor            16px ←P      ⟦在新会话中打开⟧⟦添加为工作区⟧⟦复制路径⟧  24×24 各 │ │
│ │ │ [i] dsh-kit                        ⟦…⟧⟦…⟧⟦…⟧   hover/焦点时才可见（占位不变）        │ │
│ │ │ [i] README.md   ←S(文件行)         ⟦复制路径⟧                                        │ │
│ │ │ [i] dsh-handoff-20260820.md                                                          │ │
│ │ │   ←S 长名字尾部省略 + title=完整路径                                                  │ │
│ │ └───────────────────────────────────────────────────────────────────────────────────────┘ │
│ └───────────────────────────────────────────────────────────────────────────────────────────┘
│ ┌ 折叠详情 24px · border-top S1 · padding 6 4 ─────────────────────────────────────────────┐
│ │ ⟦▸⟧ 诊断信息（与 wsl_status 同源）   12px/16 ←S      ← 摘要**不是**按钮样式（无框无填充） │
│ └───────────────────────────────────────────────────────────────────────────────────────────┘
│
│ 底栏 36px · FC + border-top S1 · padding 9 12 · display:flex align-items:center gap 8 ──────
│ ●⟦实心圆8px success⟧ 远端守护运行中   · 会话 0 个 ←S        ⟨flex:1 撑开⟩   更新于 09:21:53 ←S  ⟦⋯⟧24×24
└─────────────────────────────────────────────────────────────────────────────────────────────┘
        ↑ 状态词 span：flex:none（**永不省略**）      ↑ 附加信息 span：min-width:0 + ellipsis
```

### 7.2 逐元素规格表

#### 7.2.1 头部

| 元素 | 位置 | 尺寸 | 层级 / 描边 | 字重 / 大小 | 颜色 | hover | focus-visible |
|---|---|---|---|---|---|---|---|
| 头部容器 | 面板顶 | 高 58，`padding:10px 14px` | F1；`border-bottom:1px S1` | — | — | — | — |
| 标题「远程资源管理器」 | 左，第一行 | `13px/20` | — | `600` | `←P` | — | — |
| 副标题「目标 <distro> · <cwd>」 | 左，第二行 | `12px/16`，`min-width:0` + ellipsis；`title`=完整值 | — | `400` | `←S` | — | — |
| 主按钮（`在此目录新建会话` / `添加为工作区`，**恰 1 个**，规则见 T27 §5.1） | 右 | 高 28，`padding:4px 12px`，r4 | 填充 `brand-primary`，**文字同色反相**：见下注 | `13px/20 400` | 文字 = `bg-layer-1` | 亮度减一档：用 `interactive-bg-active` 叠加（**不换色**） | 平台环，`outline-offset:2px` |
| 次按钮（`添加为工作区` 或按 T27 §5.1 降级） | 右，主按钮左 | 高 28，`padding:4px 10px`，r4 | F0 + `S2` | `13px` | `←P` | 填充 `interactive-bg-hover` | 平台环 `offset 2px` |
| 刷新按钮 | 最右 | **24×24**（图标 16×16） | 透明填充 + **无描边**（图标按钮） | — | 图标 `←S` | 填充 `interactive-bg-hover`，图标→`←P` | 平台环 `offset 2px` |

> **注（主按钮的"反相"不依赖 token）**：`brand-primary` 在 light 是 `#0f1115`、dark 是 `#f9fafb`，而 `bg-layer-1` 在 light 是 `#fff`、dark 是 `#232324` ⇒ `color: bg-layer-1` + `background: brand-primary` 在**两个主题里都自动是"深底浅字"**（light：`#fff` on `#0f1115` = 18.90:1；dark：`#232324` on `#f9fafb` = 15.03:1）。
> 这是 §4.3 里"禁止用背景 token 当字色"的**唯一例外**，理由是"这两对颜色被主题**成对地反相定义**"，而 `state-error-primary` 不是（light `#ec1313` 是深色、dark `#f25a5a` 是浅色，所以危险确认按钮必须显式指定 `color: bg-layer-1` 且**必须**同时断言背景是 error 色）。

#### 7.2.2 目录浏览器（chips + 面包屑 + 常显路径输入 + 列表）

| 元素 | 尺寸 | 层级 / 描边 | 字号 / 字重 | 颜色 | hover | focus-visible | 状态 |
|---|---|---|---|---|---|---|---|
| 卡片 | `padding:8px 10px`，r6，`flex:1` | F2 + `S1` | — | — | — | — | — |
| 卡片标题「浏览目录（<distro>）」 | `12px/16` | — | `600` | `←S` | — | — | **标题行本身不可聚焦**（T27 第二轮 P7 的条件）：只有右侧的隐藏文件开关可聚焦，否则 Tab 顺序里会多一个"死停点"。Tab 顺序保持 开关 → chips → 面包屑 → 路径输入 → 跳转（T27 §6） |
| 隐藏文件开关 | 右，高 24 | `S2` 描边的胶囊 or 复选文字按钮（**由实现选一，但必须 ≥24×24 命中**） | `12px` | `←S`（开：`←P`） | `interactive-bg-hover` | 平台环 | 开关状态**必须**有文字（"显示/不显示"），不能只靠颜色；**位置已从 chips 行移到卡片标题行**（§9.3-P7：chips 是 `flex-wrap`，窄宽折行会与开关相撞） |
| chips 行 | 高 24，`gap:6`，`flex-wrap:wrap` | chip：透明底 + `S2` 描边 + r999，**`min-width:24px` + `justify-content:center`**（§3.4.1：单字符 chip 实测 22.7×24） | `12px` | `←S` | 描边与文字 → `←P`（**颜色变化只在 hover，不常显**） | 平台环 | 当前目标 chip：`S2` + `←P` + **常显**（`chip--on`） |
| 面包屑 | 高 20，`gap:2`，`overflow-x:auto`（不换行、不省略） | 段：透明 + r3 | `12px` | 非当前 `←S`；**当前 `←P 600`**；分隔符 `←S` | `text-decoration:underline`（**只有这一处用下划线**：它是"多段文字导航"，下划线是它的可点信号） | 平台环 | — |
| 路径输入框 | 高 28，`flex:1`，`padding:3px 6px`，r4 | F0 + `S2` | `12px` | 值 `←P`；placeholder `←D` | 无（输入框 hover 不加填充） | 平台环 | 前置**常显标签**「路径」（在输入框左侧、`←S` 12px）—— 因为 light 下输入框的填充与描边都不足以独立识别（§2.3/§8.4-C3） |
| `跳转` 按钮 | 高 28，`padding:4px 10px`，r4 | F0 + `S2` | `13px` | `←P` | `interactive-bg-hover` | 平台环 | 输入为空或未变化时 `disabled`（`←D` + `S1`） |
| 列表容器 | `flex:1;min-height:96px;overflow:auto` | 无框 | — | — | — | — | — |
| 目录行 | 高 32，`padding:6px 8px`，r4，`width:100%` | 静息透明 | `13px/20` | 名称 `←P`；图标 `←S` | `interactive-bg-hover` | 平台环 `offset:-2px`（贴滚动边缘） | hover 时动作组 `opacity:0→1` |
| 文件行 | 同上 | 同上 | 同上 | 名称 `←S`（**文件不是可执行动作**，T27 §5.3）；图标 `←S` | `interactive-bg-hover`（仍给 hover，因为它可复制路径） | 同上 | 只有 1 个动作 |
| 行内动作按钮 | **≥24×24 命中盒（图标 16×16 居中）**；**禁止"裸 `.dsh-rw-link`"（`padding:0`、无最小盒）** | 透明 + 无描边 | — | 图标 `←S` | `interactive-bg-hover`，图标→`←P` | 平台环 `offset:0` | **始终占位**（`visibility:hidden`→`visible`），`opacity` 过渡 120ms；**T43 实测**：实现用 `.dsh-rw-link{padding:0}` ⇒ 命中盒 = 内容盒 **16×16**（§3.4.1 违规），改法与 `.dsh-rw-iconbtn` 一致（24×24 + `flex:none`） |
| 行内"当前/选中" | — | 左侧 **2px `brand-primary` 竖条** | 名称 **600** | `←P` | 见 §5.1 | — | — |

#### 7.2.3 底部一行状态（采纳 T27 复核修正 B2）

```
● 远端守护运行中 · 会话 0 个                              更新于 09:21:53   [⋯]
└──────┬──────┘   └────┬────┘                            └──────┬──────┘   └┬┘
   flex:none 永不省略   min-width:0 + ellipsis             flex:none      24×24
   （状态词是语义载体）  （附加信息，可省）
```

| 元素 | 规格 |
|---|---|
| 容器 | **高 47px（定稿）+ `box-sizing:border-box`**，`padding:9px 12px`，FC 填充 + `border-top:1px S1`，`display:flex;align-items:center;gap:8px` |
| 状态点 | **`box-sizing:border-box`；外径恒 `8×8`（两态一致）**，`border-radius:50%`；**运行中** = 实心 `state-success-primary`；**未运行** = 空心（`border:1.5px S2` + `background: bg-base`，颜色取 `state-idle-primary`）；**读不到** = 实心 `state-error-primary`。`aria-hidden="true"`（**语义由状态词承担**）<br>**为什么加 `box-sizing`**：不加则空心态外径 = `8 + 2×1.5 = 11`（T40 实测 10），**与实心态 8×8 不等** ⇒ 形状通道被"大小差"污染；§4.1 规定形状是第一编码，两态外径必须相同 |
| 状态词 span | `flex:none`，`13px/20`，`←P`。文案 = 「远端守护运行中」/「远端守护未运行」/「远端守护状态未知」（T27 §3）。**它是 §4.2.1 要求的"文字线索"，任何宽度都不得被省略/截断** |
| 附加信息 span | `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`，`12px/16`，`←S`。文案 = 「会话 {N} 个」/「状态读取中…」，**前导分隔符 `· ` 由本 span 唯一提供**（见下"分隔符唯一性"） |
| 撑开 | 中间 `flex:1` 的空 `span`（把右侧推到末端；**`⋯` 打开时它仍留在视口内** ⇒ 保证浮层不遮状态词） |
| 更新时间 | `flex:none`，`12px/16`，`←S`，`font-variant-numeric:tabular-nums`。文案「更新于 HH:MM:SS」；**<360px 时允许整体 `display:none`**（它是三者中信息量最低的，且被截断的是它而不是状态词） |
| `启动守护`（**仅未运行态**） | 次按钮：高 28，`padding:4px 10px`，r4，F0 + `S2`，`13px ←P`。**视觉权重必须低于头部主按钮**（V-c）：它没有 `brand-primary` 填充。放在更新时间**左侧**。**它是底栏最高的子元素（28px）⇒ 决定 §6.1 的 `H=47`** |
| `⋯` 按钮 | **24×24 + `flex:none`**（T43：缺 `flex:none` 会被压成 16–21×24），图标 16×16 `←S`；hover → `interactive-bg-hover` + `←P`；**`aria-label="更多操作"`（固定且唯一，不随宽度/菜单内容变化）**；`aria-haspopup="menu"`；`aria-expanded` 随开合切换；**全宽度可达**（lead Q2） |

**底栏高度的推导与定稿（T43 对账，`out-08-box-sizing-audit.txt`）**

```
H = max(子元素高) + padding-top + padding-bottom + border-top
  = max(状态点 8, 状态词 20, 附加 16, 更新时间 16, 启动守护 28, ⋯ 24) + 9 + 9 + 1
  = 28 + 18 + 1
  = 47px
```

| 值 | 来源 | 判定 |
|---|---|---|
| **36**（本文旧值） | 误按"18 行高 + 18 内边距"算，**忽略了底栏里必然存在的 24px / 28px 控件** | ❌ **规格错**（与本规格自己的 ≥24×24 命中区约束互斥：最小可行是 `24+18+1=43`） |
| **55**（T40 实测） | `<footer>` 上 `height:36px` 被 **content-box** 解释成**内容高**：`36 + 18 + 1 = 55` | ❌ **实现错**（多给 19px；且 36 的内容盒里只用了 28，还空 8px） |
| **47**（定稿） | 上式；写法 `.dsh-rw-status{box-sizing:border-box;height:47px;padding:9px 12px;border-top:1px …}` | ✅ 固定值 ⇒ **守护起停时底栏不跳**（`启动守护` 只在未运行态出现；若用内容高会 47↔43 抖 4px） |

**分隔符唯一性（T40 的 N5：加载态 `远端守护状态未知 · · 状态读取中…` 出现两个 `·`）**
规则：**底栏可见文本里 `·` 的出现次数 ≤ 1**；唯一来源是"附加信息 span"的前导 `· `（漂移标记/时间戳都**不自带** `·`）。
验收：`footer.textContent.match(/·/g)?.length ?? 0 <= 1`（loading / ready / error 三态各断言一次）。

**不换行验收（V3）**：1280 宽下 `footer.scrollWidth <= footer.clientWidth === true`；
**状态词不省略验收（B2）**：在 320/420 宽下，状态词 span 的 `scrollWidth === clientWidth`（未被截断），此时**允许**被截断的是"附加信息"与"更新时间"（后者可整体 `display:none` < 360px）。
**底栏高度验收**：`footer.getBoundingClientRect().height === 47`（**8 个宽度 + 守护运行/未运行两态**都断言，防止"窄宽换行"和"状态切换跳高"）。

#### 7.2.4 `⋯` 菜单展开态

```
                                          ┌ 浮层 F3 + S2 + r6 + padding 4 · 宽 = 240px ─┐
                                          │ ▸ 快捷目录                11px ←P  ← 组标题 │  ← 常显（chips 的镜像）
                                          │ ⟦[i] Home⟧ ⟦[i] /mnt⟧ …      13px ←P  h28  │
                                          │ ─────────── 1px S1 ───────────              │
                                          │ ▸ 工作区                  11px ←P  ← 组标题 │  ← 仅 <420px 时整组出现
                                          │ ⟦[i] 添加为工作区⟧            13px ←P  h28  │
                                          │ ─────────── 1px S1 ───────────              │
                                          │ ▸ 守护                    11px ←P  ← 组标题 │
                                          │ ⟦[i] 重启远端守护…⟧           13px ←P  h28  │  ← 图标用 warn 形状，文字不用红
                                          │ ⟦[i] 停止远端守护…⟧           13px ←P  h28  │  ← 图标用 error 形状
                                          │ ─────────── 1px S1 ───────────              │
                                          │ ▸ 诊断                    11px ←P  ← 组标题 │
                                          │ ⟦[i] 查看诊断信息⟧            13px ←P  h28  │
                                          │ ⟦[i] 复制诊断摘要⟧            13px ←P  h28  │
                                          └──────────────────────────────────────────────┘
                                            位置：触发元素（底栏 ⋯）右对齐、**向上**展开
                                            与触发元素垂直间隙 4px；**不得盖住底栏本身**
```

> **组标题取色 = `←P`（`label-primary`）**，不是 `←S`。依据见下"组标题对比度"（T43 实测：`label-secondary` 在菜单底 dark 仅 **3.85** ⇒ 不达 AA 文本门槛 4.5）。**层级改由 4 条非颜色线索承担。**

| 元素 | 规格 | 为什么 |
|---|---|---|
| 浮层容器 | F3 `bg-overlay` + `S2` 1px + r6 + `padding:4px`；宽 **240px**（固定，不随内容抖动）；`z-index:30`；`box-shadow:0 4px 12px rgba(0,0,0,.08)`（Q4 规范值） | 240px 能容纳最长项「重启远端守护…」+ 图标不换行；阴影是第四层冗余（§2.4），**不是唯一分离手段** |
| **组标题**（`快捷目录` / `工作区` / `守护` / `诊断`） | **`11px/16`、颜色 `←P`（`label-primary`）**、`font-weight:400`、`padding:4px 8px 2px`；**不进 Tab 顺序**（`tabindex` 缺省或 `-1` 都可）、**不回 hover**、**无填充**。<br>**DOM/aria（T43 统一）**：标题是普通 `<div id="…">`，**不加** `role="presentation"`（它是 `aria-labelledby` 的文本来源）；组容器 `role="group" aria-labelledby=<该 id>`；**禁止**用 `aria-label`（会与可见文本成为两份真相，T40-N4） | **lead Q6 定稿**：组标题是"小字号非交互文字"，同样受 AA 文本门槛 **4.5:1** 约束。§8 实测：闭集里只有 `label-primary`（**15.97 / 5.55**）达标；`label-secondary` 是 **4.90 / 3.85**（dark 不达标）⇒ **必须换 token**。<br>**层级由非颜色承担**：11px（比菜单项小 2px）+ 不进 Tab + 不回 hover + 无填充 —— 四条都与颜色无关，灰度/色盲/两种主题下同样成立 |
| 组容器 | `role="group"` + `aria-labelledby=<组标题 id>`；**`aria-label` 一律不用** | 读屏能念出"守护 组"，且组名与屏幕上的文字**逐字相同**（单一真相源） |
| 菜单项 | 高 **28**（≠ 列表行的 32：菜单项没有二级信息）、`padding:4px 8px`、r4、`display:flex;align-items:center;gap:8px`；`role="menuitem"` | 与列表行区分：**菜单项比列表行矮**，这是"我在菜单里不在列表里"的几何线索 |
| 菜单项文字 | `13px/20`、`←P`（**不是 `←S`**） | **实测约束**：`label-secondary` 在 `bg-overlay` 上 dark = **3.85:1**、在 hover 底上 dark = 4.64、在 active 底上 light = 4.10 / dark = **2.81**（§5.1.1）⇒ 菜单项文字**禁止**用次级色；**因此也禁止"标题 + 副标题"两行式菜单项** |
| 菜单项 hover / 键盘聚焦 | `interactive-bg-hover` | 官方 hover 覆盖层 |
| 菜单项 focus-visible | 平台环 `outline-offset:-2px` + `box-shadow: inset 0 0 0 1px bg-layer-1`（**两主题都加**，Q4/F5） | §5.2 的 C2/F5（dark 下环 vs 浮层底只有 2.49:1 ⇒ 双色指示） |
| 破坏性项 | 文字 **不用红**；左侧 16×16 图标用 `state-error-primary`（停止）/ `state-warn-primary`（重启）；**保留二次确认 + 后果三要素** | §4.3 / T27 §5.2 |
| 分组分隔 | 组标题本身即是分隔（`padding` 上下各 4px）+ 组间 `1px S1` | 用"标题 + 线 + 间隙"三重表达分组 |
| 禁用项（如无对象） | 文字 `←D` | §5.5 |
| `⋯` 触发按钮 | 24×24 **+ `flex:none`**（§3.4.1）；`aria-label="更多操作"`（**稳定且唯一**）；`aria-haspopup="menu"`；`aria-expanded` 随开合切换 | lead Q2 ①；`flex:none` 是 T43 的实测结论 |

#### 7.2.4.1 组标题对比度（**Q6 定稿表，可复算**）

| 候选 token（闭集内） | light（on `bg-overlay` `#e9ecf2`） | dark（on `bg-overlay` `#61666b`） | ≥4.5:1（AA 文本）？ | 结论 |
|---|---|---|---|---|
| **`label-primary`** ← **采用** | **15.97** | **5.55** | ✅ / ✅ | 唯一两主题都达标的闭集 token |
| `label-secondary`（原方案） | 4.90 | **3.85** | ✅ / ❌ | **dark 不达标** ⇒ 弃用（T40 + Q6 改判） |
| `brand-primary` | 15.97 | 5.55 | ✅ / ✅ | 数值达标，但它与 `label-primary` **RGB 完全相同**（light `#0f1115` / dark `#f9fafb`）⇒ 没有任何区分作用，**不是"第三个候选"** |
| `label-dimmed` | 1.07 | 1.65 | ❌ / ❌ | 且 §1.2 已禁用其非豁免用途 |
| `state-warn-primary` | 2.15 | 7.31 | ❌ / ✅ | light 不达标 |
| `state-error-primary` | 4.50 | 4.24 | ✅ / ❌ | dark 4.24 差 0.26 |
| `state-success-primary` / `state-idle-primary` | 2.28 / 1.48 | 6.89 / 2.10 | ❌ / ❌（前者 dark ✅ 但 light ❌；后者两theme ❌） | 不达标 |

**被否的"保留弱色"替代方案（记录代价，避免以后重开）**：把组标题所在行给一个**填充档**（如 `bg-layer-1`），则 `label-secondary` 变成 **5.80 / 10.42** ✅✅，可保住"更弱"的观感。
**为什么否掉**：① 那是在 `F3`（浮层）里再加一层填充，违反 §2.2 规则 3"最多两层填充"；② 会给菜单加一条与本规格无关的色带（light 下是白条压在灰蓝浮层上、dark 下是深条压在浅灰浮层上），**改变浮层观感**；③ 为了一个 11px 标签引入一个结构性例外，不划算。**"层级"这条需求已由 4 条非颜色线索满足，不需要再用颜色买。**

**附加约束（lead 要求保留，**不是** 4.5:1 的替代）**：**组标题不得承载"唯一行动信息"** ——
组标题只做"分组命名"；任何"要用户做的事"（如"这里可以添加工作区"）必须落在**同组内的 `menuitem`** 或常显区域上。
**验收**：把全部组标题文本从 DOM 删除后，用户仍能完成每一组内的动作（断言：组内 `menuitem` 的 `aria-label`/文本自足，不依赖组标题补全语义）。

**需要的组标题 i18n 键（与 T27 §3.2 对齐；实现已有 4 组）**：

| 键 | zh-CN | en | 备注 |
|---|---|---|---|
| `menu.group.quickDirs` | 快捷目录 | Quick folders | 实现已用「快捷目录」（chips 的菜单镜像）；键名以 T27 表为准，若已有别键以实现为准 |
| `menu.group.workspace` | 工作区 | Workspace | 与 `action.addWorkspace` 的语义空间一致 |
| `menu.group.daemon` | 守护 | Daemon | —— |
| `menu.group.diagnostics` | 诊断 | Diagnostics | 与 `raw.summary`「诊断信息」同词根 |

> **T43 对账**：实现实测 **1280 下 3 组（快捷目录/守护/诊断）、320 下 4 组（+工作区）**，与本表的组集合一致（工作区组只在 <420px 出现）。**组标题数不再固定为 3**；`aria` 统一走 `aria-labelledby`（T40-N4）。

**键盘 / ARIA 契约（来源：T27 §5/§6 + 第二轮；本文只做收口转述，落在这里以便实现轮只读一处）**

| 项 | 契约 | 为什么要在视觉规格里出现 |
|---|---|---|
| `⋯` 触发 | `aria-haspopup="menu"` + `aria-expanded`（开合切换）；打开后**焦点移入第一个菜单项** | 悬浮层与触发元素是"一对"，视觉与语义必须同时成立 |
| 菜单项 | `role="menuitem"`；`↑/↓` 移动；`Home/End` 到首/末；**焦点环即 hover 底**（同一填充） | 键盘用户必须看到与鼠标用户**相同的**位置指示 |
| `Esc` | **关闭菜单并把焦点还给底栏 `⋯`** | 焦点丢失是最常见的键盘可用性事故 |
| `Tab` | **关闭菜单并前进**（不把焦点困在菜单里） | 与平台行为一致 |
| 点击外部 | 关闭 | —— |
| **浮层不得遮住底栏状态词** | 菜单**向上**展开；断言：菜单打开时状态词 `span` 仍在视口内且可被读屏读到（`aria-hidden` 未加在底栏上） | lead Q2 ②。理由：底栏的守护状态是**唯一常显**的守护信号（§4.2），被菜单盖住等于状态丢失 |

#### 7.2.5 折叠详情（诊断，默认收起）

```
收起（24px）：
┌ border-top S1 · padding 6 4 ────────────────────────────────────────────────────────┐
│ ⟦▸⟧ 诊断信息（与 wsl_status 同源）   12px/16 ←S        ← 无框 · 无填充 · 无字重       │
└─────────────────────────────────────────────────────────────────────────────────────┘

展开：
│ ⟦▾⟧ 诊断信息（与 wsl_status 同源）   12px/16 600 ←S                                 │
│   ┌ 只读区块：透明底 + S1 + r4 + padding 6 8 ──────────────────────────────────┐    │
│   │ 其它实例的守护（只读）        12px ←S   [i 锁] 12px ←S                     │   │
│   │ 实例 #8731 · 运行中           13px ←P      title = slot/port/pid/version   │   │
│   └───────────────────────────────────────────────────────────────────────────┘    │
│   ┌ 原始诊断块 F0 + S1 + r6 + padding 8 + 12px/18 等宽 ←P ────────────────────┐    │
│   │ {"distros":[...],"target":{...}}                                          │   │
│   └───────────────────────────────────────────────────────────────────────────┘    │
```

| 元素 | 规格 | 为什么 |
|---|---|---|
| 摘要行（收起态） | 高 24；`border-top:1px S1`；`padding:6px 4px`；文字 `12px/16 ←S`；**无填充、无描边、无圆角、无 600** | T27 §9.1-V5（"默认收起的摘要要轻"）；light 三档全白时，**唯一**能表达"次要"的手段就是"不给框、不给填充、字号降一档" |
| 展开态摘要 | 同上，但文字 `600` + 展开图标 `▾` | 展开后它是**区域标题**，需要一点重量；仍不给自己加框 |
| 展开内容 | 紧随摘要，`padding-left:16px`（缩进表达"属于上方标题"） | §2.3 通道③ |
| 只读区块 | 透明底 + `S1` 框 + r4 | §2.1（只读 ⇒ 不用 `S2`） |
| 原始块 | F0 + `S1` + r6 + 等宽 | 官方把 `bg-base` 用于"代码/原始"面 |
| 折叠时内部元素 | `hidden` 或 `tabindex="-1"` | T27 §6/§7-M11（键盘不可达） |

### 7.3 三种宽度下的头部降级（**lead Q2/Q5 定稿**）

> **定稿（Q2）**：**全宽度只保留底栏那一个 `⋯`**（同屏两个同形 `⋯`、内容却不同 ⇒ 用户无法预测点开哪一组；底栏常驻 ⇒ 触发点位置稳定；破坏性动作的唯一入口不该有两个候选）。`usability-engineer` 已把其文档里那条"移入**头部** `⋯`"改成"移入**底栏** `⋯` 的「工作区」组"，两份文档自洽。
> **`⋯` 的稳定契约**：`aria-label` **固定且唯一 = 「更多操作」**（不随宽度/菜单内容变化），`aria-haspopup="menu"` + `aria-expanded`；**所有宽度都必须可达**。

| 宽度 | 头部内容 | 底栏 `⋯` 的「工作区」组 | 规则 |
|---|---|---|---|
| **≥720px** | `主按钮(带字)` + `添加为工作区(带字，次按钮)` + `刷新(24×24 icon)` | **不出现**（动作在头部） | 全套 |
| **420–720px** | `主按钮(带字)` + `添加为工作区(带字，次按钮)` + `刷新(icon)` | **不出现** | 两个动作都短，够放 |
| **<420px** | **`主按钮(带字)` + `刷新(icon)`** | **出现**：菜单项「添加为工作区」，**键名与头部按钮完全相同**（`action.addWorkspace`） | **主路径永不降级为图标**（Q2 硬要求）；`⋯` 在所有宽度可达 |

**命令式规则（可判）**：
1. `添加为工作区` 无论是头部按钮还是菜单项，**必须用同一个 i18n 键 `action.addWorkspace`**（同一动作两个名字会让人以为是两件事 —— T27 第二轮）。
2. `<420px` 时头部**必须仍有 ≥1 个带字按钮**，且其文案 ∈ {`在此目录新建会话`, `添加为工作区`}（T27 §5.1 的裁决规则）。
3. 底栏 `⋯` 在 **320px** 也必须可见且可聚焦（不允许为腾宽度而隐藏）。
4. **同一个动作不得在两个常驻位置同时出现**（**T43 对账 T40-N1**）：实测 320px 下「添加为 WSL 工作区」**同时在头部与菜单工作区组**。
   **定稿：<420px 时从头部移除，只保留菜单内的那一个**（因为"窄宽收进菜单"本身就是该规则的意图；保留头部＝让规则失效）。
   **验收**：`<420px` 时 `header.querySelectorAll('button')` 的文案集合**不含**「添加为工作区」；`≥420px` 时头部**含**它，且菜单**不含**「工作区」组。
   **为什么选"移除头部"而不是"菜单不列"**：320px 下头部空间是稀缺资源（主按钮 + 刷新已占满），而菜单是溢出动作的正确归宿；反过来会让"窄宽溢出规则"名存实亡。

**边界验收（Q5：除 1280 外必须验三个边界）**：在 **719 / 720**、**419 / 420**、**359 / 360** 各截一次（共 6 张 + 1280 基线），每张断三条：

| 断言 | 判据 |
|---|---|
| 状态词不被截断 | 状态词 `span` 的 `scrollWidth === clientWidth`（§4.2-1） |
| 底栏不换行 | `footer.scrollWidth <= footer.clientWidth`（V3） |
| `⋯` 可达 | `⋯` 的 `getBoundingClientRect().width > 0` 且在 a11y 树里 |
| **底栏高恒 47** | `footer.getBoundingClientRect().height === 47`（§7.2.3） |
| **`⋯` 命中盒 ≥24×24** | `⋯` 的 rect 宽高均 ≥24（§3.4.1；T43 实测 5/8 档不达标） |
| **动作不双现** | `<420px` 头部不含「添加为工作区」；`≥420px` 菜单不含「工作区」组（本页规则 4） |
| 主按钮带字 | 主按钮的 `textContent.trim().length > 0`（<420px 时也必须成立） |

### 7.4 确认层（破坏性动作，二次确认不回退）

```
┌ 确认层 F3 + S2 + r6 + padding 12 · 宽 360px · 在 body 内联、距底栏 8px ──────────────┐
│ [i 圆叉 16px error] 确认停止远端守护？      13px/20 600 ←P                          │
│                                                                                     │
│ 这将关闭为「debian-u8-1」启动的远端守护，正在运行的 0 个会话会全部中断、上下文丢失； │
│ 之后需要重新「启动守护」。                  12px/16 ←S                              │
│                                                                                     │
│                                          ⟦停止远端守护⟧ 主按钮(error 填充)  ⟦取消⟧   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

| 元素 | 规格 |
|---|---|
| 容器 | F3 + `S2` 1px + r6 + `padding:12px`；宽 `min(360px, 100% - 16px)`；`role="alertdialog"` |
| 标题 | `13px/20 600 ←P`（**不是 `warn` 色** —— 基线用 `state-warn-primary` 当标题色，light 下只有 2.15:1，§8.4-A2） |
| 正文 | `12px/16 ←S`；必须含"影响对象 / 影响范围 / 之后怎么办"三要素（文案见 T27 §5.2） |
| 确认按钮 | **填充** `state-error-primary`，文字 `bg-layer-1`，高 28，`padding:4px 12px`，r4。实测 **4.50:1（light，`#fff` on `#ec1313`）/ 4.77:1（dark，`#232324` on `#f25a5a`）** |
| 取消按钮 | 次按钮：F0 + `S2` + `13px ←P`，高 28 |
| 打开后 | 焦点移入**取消**按钮（更安全的默认）；`Esc` 取消；关闭后焦点回触发元素（T27 §6） |

---

## 8. 对比度与可达性

### 8.1 计算方法（可复算）

- **标准**：WCAG 2.x 相对亮度 `L = 0.2126R + 0.7152G + 0.0722B`（每通道先做 `c ≤ 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`），对比度 `(Lmax + 0.05)/(Lmin + 0.05)`。
- **alpha 合成**：DSH 的描边与 hover 层大量带 alpha（`border-l1 = #0000000a`、`interactive-bg-hover = #2631480f`），**必须**先按 src-over 合成到"它实际所处的背景"上再算 —— 直接把 alpha 色当不透明色算会得到错误的 1.00:1。
- **判据**：正文/小字 **≥4.5:1**；大字（≥18.66px 粗或 ≥24px）**≥3:1**；**非文本**（图形、UI 边界，WCAG 1.4.11）**≥3:1**。
- **脚本**：`spike/verify/explorer-20261012/visual/tools/contrast-check.mjs`（输入 `app.asar`，**58 组**，逐组打印 fg/bg 解析值 + 比值 + 判定；两主题共 116 行，PASS 70 / FAIL 45 / 1 行 UNRESOLVED）。原始输出：`out-03-contrast.txt`。

### 8.2 关键 6 组（task-28 要求的门槛）

| # | 前景 / 背景 | light | dark | 判据 | 结论 |
|---|---|---|---|---|---|
| **1 正文文字** | `label-primary` / `bg-layer-1` | **18.90** | **15.03** | ≥4.5 | ✅ 两主题都远超标 |
| **2 次要文字** | `label-secondary` / `bg-layer-1` | **5.80** | **10.42** | ≥4.5 | ✅（在 `sidebar-fill` 上 5.55 / 11.43 也 ✅） |
| **3 禁用文字** | `label-dimmed` / `bg-layer-1` | **1.07** | **1.65** | 豁免（WCAG 1.4.3 明确豁免禁用控件；1.4.11 也豁免非必需图形） | ⚠️ **豁免但受限**：只允许出现在 `:disabled` 与 `::placeholder`（§8.4-A4） |
| **4 状态色** | `state-error-primary` 作为非文本 / `bg-layer-1` | **4.50** | **4.24** | ≥3 | ✅。**但** `success` 2.28/6.89、`warn` 2.15/7.31、`idle` 1.48/2.10 ⇒ light 三态**不达标**，改为形状+文案承载（§4.2） |
| **5 焦点环** | `state-business-primary` / `bg-layer-1` | **4.23** | **6.75** | ≥3 | ✅（底栏 `sidebar-fill` 上 4.05 / 7.39 ✅；hover 底 3.81 / 6.38 ✅；active 底 3.52 / 5.18 ✅） |
| **6 按钮** | 主按钮 `bg-layer-1` on `brand-primary` | **18.90** | **15.03** | ≥4.5 | ✅；危险确认按钮 `bg-layer-1` on `state-error-primary` = **4.50 / 4.77** ✅（light 刚好压线，见 §8.4-A5） |

### 8.3 完整测值表（58 组，以下为必须记住的 15 组）

| 组 | light | dark | 判定 |
|---|---|---|---|
| G1b 正文 / 底栏 FC | 18.08 | 16.47 | ✅ |
| G2b 次要 / 底栏 FC | 5.55 | 11.43 | ✅ |
| G4b**链接（蓝）当文字** | **4.23** | 6.75 | ❌ light（**这是拒绝蓝色链接的依据**） |
| G6b error 当文字 / 底栏 FC | **4.30** | 5.23 | ❌ light（⇒ 底栏不用红字，用红**形状**） |
| G7 warn 当文字 | **2.15** | 7.31 | ❌ light（⇒ warn 只做形状） |
| G7b warn-label 当文字 | **2.79** | 5.62 | ❌ light（⇒ 不引入该 token） |
| G8 idle 点 / layer-1 | **1.48** | **2.10** | ❌ 两主题（⇒ 空心圆形状） |
| G9 border-l1 / layer-1 | 1.09 | 1.19 | ❌ 非文本 3:1（⇒ §8.4-C3） |
| G9b border-l2 / layer-1 | 1.26 | 1.46 | ❌ 非文本 3:1（⇒ §8.4-C3） |
| R4 次要文字 / popover F3 | 4.90 | **3.85** | ❌ dark（⇒ 菜单项文字用 `label-primary`） |
| R8 hover 填充 / layer-1 | 1.11 | 1.27 | — 不是门禁项（§8.4-C4） |
| R9 active 填充 / layer-1 | 1.20 | 1.57 | — 同上 |
| **R12 `bg-layer-2` / `bg-layer-1`** | **1.00** | 1.13 | ❌ light：**这就是"light 层级塌缩"的机械证据**（§2.3） |
| **R11 `sidebar-fill` / `bg-layer-1`** | 1.05 | 1.10 | ❌ 两主题都很弱 ⇒ 底栏/头部的分界必须由 `border-top/bottom` 承担 |
| **R10 `bg-overlay`（浮层）/ `bg-layer-1`** | **1.18** | 2.71 | ⚠️ 是本文能拿到的**最强"整块面"差异**（仍 <3）⇒ 浮层必须同时有 `S2` 描边（§2.1） |

### 8.4 不达标项的替代方案（**逐条给替代，不留"注意一下"**）

| ID | 不达标项 | 实测 | 替代方案 | 替代后达标？ |
|---|---|---|---|---|
| **A1** | 蓝色 `--dsw-alias-link` 当**行内动作文字** | light 4.23 < 4.5 | **改用 `brand-primary`（单色强调）**：18.90 / 15.03 | ✅ |
| **A2** | `state-warn-primary` / `state-warn-label` 当**文字** | light 2.15 / 2.79 | **文字一律 `label-primary`**；warn 只做 16×16 三角图标；漂移另给常量文案「配置已漂移」 | ✅（文字 18.90；三角作为"冗余图形"，其语义已由文字承担 ⇒ 不触发 1.4.11） |
| **A3** | `state-idle-primary` 当**状态图形** | light 1.48 / dark 2.10 | **空心圆**：环用 `border-l2`（1.26/1.46）+ 填充 `bg-base`；形状（空心 vs 实心）承担区分；状态词承担语义 | ✅（形状差异；且状态词常显） |
| **A4** | `label-dimmed` 当**信息文字** | light 1.07 | **限制使用域**：仅 `:disabled` 与 `::placeholder`（与官方出厂用法一致） | ✅（豁免域内合法）；**实现断言**：`label-dimmed` 只出现在 `[disabled]` / `::placeholder` 选择器里 |
| **A5** | 危险确认按钮 | light **4.50**（刚好压线） | 保留（4.50 ≥ 4.5 成立），但**必须**用"填充 + 反相字"实现并断言计算值；字色**禁止**用 `label-dimmed`/`label-secondary`（会掉到 3.x） | ✅ |
| **A6** | `state-success-primary` 当状态图形（light） | 2.28 < 3 | **实心圆**（形状）+ 状态词；如需更强，可给圆点加 `0 0 0 1px S2` 的环（把有效图形边界扩到环上：`border-l2` 1.26 仍 <3 ⇒ **只作为视觉加强，不作为达标依据**） | ✅（冗余图形，语义由文字承担） |
| **B1** | 菜单项次级文字在 dark | 3.85 < 4.5 | 菜单项文字用 `label-primary`（5.55 / 15.97） | ✅ |
| **B2** | 菜单项焦点环在 dark（F3 底） | 2.49 < 3 | **双色焦点指示**：平台蓝环 + `inset 0 0 0 1px bg-layer-1` 内圈（内圈 vs 蓝环 = 4.23 / 6.75） | ✅ |
| **C1** | 主按钮 hover 的"换色"（基线把文字变 `brand-primary`） | 不可断言 | 改为**不改色、只加覆盖层** `interactive-bg-active`（形状/亮度通道） | ✅（可断言：hover 前后 `color` 不变、`background-image`/`background-color` 变化） |
| **C2** | 把 `bg-overlay` 当**行内行填充**（若照抄 baseline 思路） | dark 下会把焦点环拖到 2.49 | **禁止**：`bg-overlay` 只用于**浮层容器**；行/选中的填充只用 `interactive-*` | ✅ |
| **C3** | **容器/控件的 3:1 边界** | `border-l1` 1.09 / `border-l2` 1.26（light） | **不可能用现有 token 达标**（15 个 token 全试过：最重的 `border-l4` = 1.45 light 也 <3）。改为**多渠道识别**：① 可交互控件**必须有文字标签**（按钮有字/输入框有前置标签「路径」）；② 有 hover 填充反馈；③ 容器由 `S1` + 缩进 + 章节标题识别。**并显式声明**：识别控件所需的视觉信息**不是**那条 1.26:1 的线，所以不依赖它 ⇒ 1.4.11 不适用。**这是本文最重要的一条"有理由的偏离"** | — |
| **C4** | hover / active 填充本身 | 1.11–1.57 | **不作为对比度门禁项**：WCAG 没有"hover 背景必须 3:1"的要求（hover 不是识别控件或状态**所必需**的信息；它是增强）。**"当前/选中"这类必须可辨的状态改走竖条 + 字重**（18.90 / 15.03 / 灰度可辨） | ✅ |
| **C5** | `warn` 徽标底色（`state-warn-tertiary`）方案 | 底上图形 1.99 | **放弃底色徽标**；徽标一律 `S1` + `label-secondary` + 图标形状 | ✅ |
| **D1** | **菜单组标题**（11px 非交互文字）在浮层底上 | `label-secondary` = light **4.90** / dark **3.85** ⇒ **dark < 4.5**（T43/Q6 实测） | **换成 `label-primary`**（**15.97 / 5.55**）；层级改由 4 条非颜色线索承担（11px / 不进 Tab / 不回 hover / 无填充），见 §7.2.4.1 | ✅ 两主题都 ≥4.5 |
| **D2** | 若坚持组标题用"弱色" | —— | 唯一出路是把组标题行加一层填充（`bg-layer-1` ⇒ `label-secondary` 变 5.80 / 10.42 ✅），**但那违反 §2.2-3"最多两层填充"并改变浮层观感** ⇒ **否掉**（代价记录在 §7.2.4.1） | ❌ 不采用 |

### 8.5 色盲 / 灰度复核

| 检查 | 怎么验 | 通过判据 |
|---|---|---|
| 去色后状态可辨 | 对面板截图施加 `filter: grayscale(1)`（或用 CDP `Emulation.setEmulatedMedia` + 截图后转换） | 4 种状态形状（实心圆/空心圆/三角/叉）在灰度下两两可区分 |
| 去色后"当前"可辨 | 同上 | "当前行"仅凭竖条亮度差 + 字重即可定位 |
| 红绿色盲模拟 | 用 `protanopia`/`deuteranopia` 矩阵变换截图 | `success` 与 `error` 不承担区分职责（形状已区分）⇒ 通过 |

### 8.6 焦点环可判性（结论）

| 断言 | 判据 | 依据 |
|---|---|---|
| 每个可聚焦元素在 `:focus-visible` 下有可见环 | 计算样式 `outline-style !== "none"` 且 `outline-width ≥ 2px` | 平台 `focus.css`（§5.2） |
| 环与所在背景 ≥3:1 | 见 §5.2 表（4 组全 ✅；浮层内 1 组 ❌ ⇒ 用双色指示） | `out-03` |
| 指针模态下不画环 | `html[data-input-modality=pointer]` 时环透明 | **这是平台策略，不接受改** |
| 环不被裁切 | 贴在滚动容器边缘的行/按钮 `outline-offset:-2px` | 几何 |

### 8.7 明确的豁免与偏离（写清理由，便于复审）

| # | 项 | 偏离内容 | 理由 | 谁可以推翻 |
|---|---|---|---|---|
| 1 | 禁用控件对比度 | `label-dimmed` light 1.07:1 | WCAG 1.4.3 明文豁免"非活动用户界面组件" | 无需推翻 |
| 2 | 容器/控件边界 3:1 | `border-l1/l2` 1.09–1.46 | 现有 15 个 token 里**没有**能达 3:1 的描边（最重 1.45）⇒ 识别改由文字标签 + hover + 结构承担（§8.4-C3） | 若 lead 允许**新增/扩展** theme token（超出本插件范围），可重开 |
| 3 | hover/active 填充 3:1 | 1.11–1.57 | 非 1.4.11 门禁项（§8.4-C4）；必须可辨的状态走竖条通道 | 同上 |
| 4 | 状态色 light 不达标 | `success`/`warn`/`idle` | 颜色只做冗余，语义由**常显状态词**承担（§4.2） | 若 T27 允许状态词可省略，则本豁免失效（**所以 B2 的修正是硬约束**） |

---

## 9. 与交互规格的接口（依赖矩阵）

### 9.1 视觉决定 → 依赖 T27 的哪一条（谁改了什么，我这要重算）

| 本文条目 | 依赖 `docs/panel-ux-redesign.md` 的 | 若对方改了会怎样 |
|---|---|---|
| §2.1 目录浏览器是**唯一**目录概念；不需要"旧树卡片" | T27 §2.3（删除旧树） | 若旧树保留 ⇒ §6.2 的"唯一生长体"失效（两个生长体 ⇒ 又变成"各占一块 + 下方空白"） |
| §3.5 行高 32 / 动作紧跟内容 / 动作组占位不变 | T27 §5.3（hover 出图标 + ≥24×24 命中 + 行高 ≥32） | 若改成"常显动作"，占位策略不变（视觉无差）；若命中区降到 24 以下，行高可降到 28（本文不主动降） |
| §3.7 长路径策略 / `direction:ltr + unicode-bidi:isolate` | T27 F35 的"残留小瑕"（建议改 `isolate`） | 改回 `plaintext` ⇒ 强 RTL 开头的内容可能翻向（本文不接受） |
| §4.3 破坏性动作"菜单项不用红、确认按钮填充红" | T27 §5（破坏性进 `⋯`）+ §5.2（后果文案三要素）+ §9.1-V4 | 若破坏性动作**常显**在底栏 ⇒ 本文 §4.3 的"红色只在确认层"失去依据（常显按钮必须有危险外观），需重开 |
| §5.1 hover=填充 / 当前=竖条+600 | T27 §9.1-V7 + §5.3（行内动作 hover 显形） | 若"当前目录"改成只用填充表达 ⇒ V7 在 light 下不成立（layer 全白） |
| §5.2 焦点环不覆盖 | T27 §6（焦点环 ≥3:1）+ §9.2（撤掉"新增焦点环 token"） | — |
| §6.1 高度预算（18 行） | T27 §9.2（确认 32px 不破坏信息量） | 若加回"旧树/多一块内容" ⇒ 重新分配高度 |
| §6.3 三态视觉（骨架/空/错） | T27 §4 状态矩阵（loading/empty/error 的判据与文案） | 状态矩阵增态 ⇒ 本文需补一行视觉 |
| §7.2.3 底栏"状态词永不省略" | T27 复核修正 B2 | **硬耦合**：若状态词可省略，则 §4 的状态色豁免全部失效 |
| §7.2.4 菜单项文字必须 `label-primary` | T27 §3.2 的 `menu.*` 键（文案长度 ≤8 汉字） | 若菜单项改成"标题 + 副标题"两行 ⇒ 副标题在 dark 只有 3.85:1，需改设计 |
| §7.3 三档宽度降级 | T27 §10（<900px 未测）+ `usability-engineer` 复核（主路径永不降级） | 若主行动允许降级为图标 ⇒ 本文 §7.2.1 的按钮规格要加一条图标态 |
| §1.4 的"`S2` = 可交互" | T27 §5 动作分层（哪些是动作、哪些是状态） | 若某个只读块被变成可点 ⇒ 描边必须升到 `S2` |
| §1.0.1 的 17 token 闭集 | T27 §8.2"不做的事"（不改 shell chrome、不抢槽） | — |

### 9.2 逐条回答 T27 §9.1 的 V1–V8

| # | T27 的约束 | 本文的答复 | 落在本文哪 |
|---|---|---|---|
| **V1** | 行内动作图标命中区 ≥24×24、行高 ≥32 | **满足**：命中盒 24×24、行高 32、包内 `padding:6px 8px`；且**相邻行命中盒净距 8px（≥4）**（采纳复核修正） | §3.4 / §3.5 / §7.2.2 |
| **V2** | 头部只有 1 个主按钮，次按钮权重明确更低 | **满足**：主按钮 = `brand-primary` 填充 + 反相字；次按钮 = F0 + `S2`；两者在"填充/无填充"上分档，灰度下也可分 | §7.2.1 |
| **V3** | 底栏 1280 不换行 | **满足**：`flex` 三段（状态词不缩 / 附加信息可缩 / 时间不缩）+ `gap 8`；验收 `scrollWidth <= clientWidth` | §7.2.3 |
| **V4** | danger 与 error 不同 token 或不同形态 | **满足**：菜单项**不用红色**（文字 `label-primary` + 图标形状）；`error` 色只用于"错误状态"与"确认层填充" | §4.3 / §7.2.4 |
| **V5** | 折叠摘要/菜单不抢主视线 | **满足**：摘要无框无填充、字号 12、色 `←S`；不引用主按钮任何样式 | §7.2.5 |
| **V6** | 焦点环两主题 ≥3:1 | **满足且不覆盖**：平台环实测 4.23/6.75（主体）、4.05/7.39（底栏）、3.81/6.38（hover 底）；浮层内 2.49(dark) ⇒ **已给双色指示替代** | §5.2 / §8.2-5 |
| **V7** | hover 与"当前"必须可区分 | **满足**：两态走**不同通道**（填充 vs 竖条+字重），既非同一 token 也不同一属性 | §5.1 |
| **V8** | dark 不得硬编码色 | **满足**：17 个 token 全部有 dark 值；机械自查 `hardcoded color hits = 0`（exit 0） | §1.5 |

### 9.3 我对 T27（及复核）的**视觉问题**逐条记录（含是否采纳）

| # | 提出处 | 问题 | 我的裁定 | 处理 |
|---|---|---|---|---|
| **P1** | 复核 V-a | 基线列表用 **emoji `📁`/`📄`**（实测 3 处），与 16×16 单色图标混排会破坏左对齐与命中盒对齐 | **采纳** | §3.4：面板内**零 emoji**，全部内联 SVG + `currentColor`；§3.6 规则 1 的"名称列左缘严格对齐"由它保证 |
| **P2** | 复核 V-b | 加载态只有一行字"像坏了"；空态只有一句陈述 | **采纳** | §6.3：加载 5 行骨架（不居中）、空态三两行 + 次按钮；**并追加**"刷新中不换骨架"（避免闪） |
| **P3** | 复核 V-c | 底栏 `启动守护` 不能画成主按钮样式 | **采纳** | §7.2.3：`启动守护` = 次按钮（F0 + `S2`，无 `brand-primary` 填充） |
| **P4** | 复核 V-d | 诊断摘要不能像主按钮 | **采纳** | §7.2.5：摘要**无框、无填充、无圆角**，只有 `border-top S1` + `12px ←S` |
| **P5** | 复核 B2 | 省略号不得吞掉状态词 | **采纳（升为硬约束）** | §7.2.3 的 span 结构 + §4.2 的验收（**8 个宽度**下状态词不被截断）；**它是 §8.7 第 4 条豁免成立的前提** |
| **P6** | 复核第 3 节 | `<420px` 把 `添加为工作区` 收进"头部溢出菜单" ⇒ 会与 T27 放在底栏的 `⋯` 形成**两个同形 `⋯`** | **lead Q2 已定稿 + T27 第二轮采纳**：**全宽只保留底栏一个 `⋯`**；`添加为工作区` 在 <420px 进它的「工作区」组；组标题分 工作区/守护/诊断 三组；键名与头部同键 | §7.3 / §7.2.4（**不再挂"待裁决"**） |
| **P7** | T27 §2.1 线框 | 用 `[隐藏文件开关]` 与 chips **同一行**（chips 会 `flex-wrap` 折行）⇒ 窄宽下开关会与折行的 chips 相撞 | **采纳（改视觉）**：开关放**卡片标题行右侧**（与「浏览目录」同行的末端），chips 行只放 chips；**附加条件（T27 第二轮）**：卡片标题行本身**不可聚焦**，只有开关可聚焦 | §7.2.2 |
| **P8** | T27 §2.1 线框 | 头部挤了"标题+副标题+主行动+次行动+刷新+distro 显示"6 项，未给宽度降级 | **采纳并补规格**：三档宽度降级（§7.3）+ 单发行版时 distro 退化为只读文本（T27 §2.3） | §7.3 / §7.2.1 |
| **P9** | T27 §4 `error` 格 | "所有事实撤下"后只剩一个块 ⇒ 若不约束对齐方式，块会漂在 900px 高度的正中央 | **采纳**：错误块**顶部对齐**、宽撑满 | §6.3 |
| **P10** | T27 §5.3 | "行内动作 hover 才显形"未定义**是否保留占位** | **采纳（补规则）**：**必须保留占位**（`visibility` 切换），禁止 `display:none`，否则 hover 瞬间布局跳动导致点击目标位移 | §3.5 / §7.2.2 |
| **P11** | T27 §6 焦点环行 | 只写"对比度 ≥3:1"，未给环色与实现方式 | **采纳**：平台已给环色与宽度，本文只加 4 条约束（F1–F4） | §5.2 |
| **P12** | T27 §2.2 底栏三形态 | 底栏三种形态里都放了 `⋯`（4 个元素）；1280 下可容，但 <420 下 `启动守护` + `⋯` + 时间会挤 | **部分采纳**：给出"时间 <360px 隐藏、`启动守护` 未运行态才出现"两条降级；`⋯` 永不隐藏 | §7.2.3 / §7.3 |
| **P13** | T27 §3.1 文案表 | 新文案里有 `{count}` 会变宽（「会话 128 个」）⇒ 底栏宽度会抖 | **采纳（补规则）**：可变数字用 `tabular-nums`，且它所在的 span 是**可省略**的那个（不挤状态词） | §3.6-2 / §7.2.3 |
| **P14** | T27 §0.2 `ux-09` | 守护运行态底栏出现**红色**「停止 slot 8962…」常显 ⇒ 与"错误红"混淆 | **采纳**：破坏性动作进菜单且菜单项不用红（§4.3）；`error` 色的**文字**用途收敛为"错误状态" | §4.3 |

### 9.4 T27 侧仍需我复验的 4 项（我在本文预留了判据，待实现轮给数）

| T27 复核要复验 | 本文提供的判据 | 复验时机 |
|---|---|---|
| V1 命中区实测 | `getBoundingClientRect()` ≥24×24；相邻行净距 ≥4 | 实现轮 |
| V3 底栏 1280 不换行 | `footer.scrollWidth <= footer.clientWidth`；状态词 span 不截断 | 实现轮 |
| V7 hover/当前两态截图可区分 | 灰度截图下两态各自可定位（§5.1 判据） | 实现轮 |
| 视觉稿没把 #1–#8 已解决项拉回来 | 对照 `ux-01/02/04/05/06/07/09`：① 同一路径只出现一次；② 主视线无 `slot/pid/keys/slot N`；③ 底栏无破坏性按钮；④ 折叠区默认收起 | 实现轮 |

### 9.4.1 实现轮需要补测的**边界截图**（lead Q5 / T27 第二轮）

| # | 项 | 判据 | 出处 |
|---|---|---|---|
| B1 | **719 / 720** 各一张 | 主按钮带字；`添加为工作区` 在 720 仍带字、在 719 仍带字（本文的降级不含"降为图标"，见 §7.3） | §7.3 |
| B2 | **419 / 420** 各一张 | 419 时头部只剩「主按钮(带字) + 刷新」；420 时 `添加为工作区` 仍在头部 | §7.3 |
| B3 | **359 / 360** 各一张 | 359 时更新时间整体隐藏、状态词仍完整、底栏不换行 | §7.2.3 |
| B4 | 以上六张 + 1280 基线，逐张断 4 条 | 状态词不截断 / 底栏不换行 / `⋯` 可达 / 主按钮带字 | §7.3 表 |
| B5 | dark 下打开 `⋯` 菜单并 `Tab` | `box-shadow` 计算值含 `inset` 且颜色 = `bg-layer-1` 解析值（F5 两主题都加） | §5.2 |
| B6 | 面板内卡片/分组 | `box-shadow === "none"`（Q4：阴影只在浮层） | §2.2-8 / §2.4 |

### 9.5 裁决记录（**6 条全部已定稿 —— 本节不再是"待决"**）

| # | 事项 | **裁决** | 我原来写的 | 落在哪 |
|---|---|---|---|---|
| **Q1** | token 闭集取 17 个还是点名的 13 个 | **采用 17 个**（§1.0）。理由：17 个**全是 DSH 既有 token**、不引入新色；降到 13 会逼出"用不透明 token 近似或硬编码"，反而破坏门禁。可用性侧独立反证：light 下 13 个里**没有一个**能做可见 hover ⇒ 13 会让 T27 §9.1-V7 不成立。<br>**附 lead 两条硬要求**：① 门禁脚本把这 17 个当 **allow-list**，集合外 token 一律 exit 非 0；② 逐 token 给"用在哪 + 为什么 + light/dark 取值"。 | 倾向 17 | **§1.0 / §1.0.1 / §1.1 / §1.5（C2）** |
| **Q2** | `⋯` 放底栏还是头部；是否允许同屏两个 | **全宽度只保留底栏那一个 `⋯`**（lead 裁决采纳本文建议；T27 第二轮也采纳并把其文档改成"移入底栏 `⋯` 的「工作区」组"）。<br>**落地形态**：`aria-label` 固定唯一 =「更多操作」；菜单分 **快捷目录 / 工作区 / 守护 / 诊断** 四组（**每组有组标题**；T43 实测实现即 1280=3 组、320=4 组）；破坏性两项**只在此菜单内** + 保留二次确认与后果三要素；`<420px` 主按钮**仍带字常显**，`添加为工作区` 进「工作区」组且**与头部按钮同键** `action.addWorkspace`；**浮层不得盖住底栏状态词**。 | 只留一个（底栏），三组无组标题 | **§7.2.4 / §7.3**（组标题 i18n 键见 §7.2.4） |
| **Q3** | `添加为工作区` 是否允许在 <420px 降为图标 | **不接受降级为图标**（与可用性侧一致） | 不接受 | **§7.3**（并加"`<420px` 头部必须仍有 ≥1 个带字按钮"的可判断言） |
| **Q4** | 是否允许 `box-shadow` | **允许，但只限"面板外浮层"**（`⋯` 菜单 / 确认弹层）；**面板内**卡片/分组**不得**用阴影表达层级（仍按"背景档 + 描边 + 缩进"）。**只许中性半透明黑**（无色相），规范取值 **菜单 α=0.08 / 确认层 α=0.16**，允许区间 **α ∈ [0.04, 0.28]**；**不得作为唯一分离手段**（必须与 `bg-overlay` + `S2` 描边同时存在）；门禁对它**窄豁免**（只放行 `box-shadow` 里的中性半透明黑，带色相/α 越界/命名色照旧判红）。 | 原来倾向"不用阴影" | **§2.4 / §1.5 / §7.2.4** |
| **Q5** | 断点是否就是 720 / 420 | **是**；并补验 **719/720、419/420、359/360** 三个边界（每张断 6 条：状态词不截断 / 底栏不换行 / `⋯` 可达 / 主按钮带字 / 底栏高恒 47 / `⋯` ≥24×24 / 动作不双现） | 是 | **§7.3 / §4.2-1** |
| **Q6** | 菜单**组标题**的对比度门槛 | **提高到「两主题各 ≥4.5:1」**（小字号非交互文字同样受 AA 文本门槛约束）⇒ **组标题必须换 token**：`label-secondary`（4.90 / **3.85**）→ **`label-primary`（15.97 / 5.55）**；**层级改由 4 条非颜色线索承担**（11px / 不进 Tab / 不回 hover / 无填充）；并保留附加约束"**组标题不得承载唯一行动信息**"。 | 组标题 = `←S`（只按 ≥3:1 判） | **§7.2.4 / §7.2.4.1 / §8.4-D1/D2** |

### 9.6 T43 对账后的定稿变更（只列改动的条目）

| 条目 | 改动前 | 改动后 | 判责（谁错） |
|---|---|---|---|
| §6.1 底栏高度 | 36px | **47px**（公式 `28+9×2+1`） | **规格错**（36 与本规格自己的 ≥24×24 约束互斥）+ **实现错**（content-box 把 36 放大成 55） |
| §7.2.3 底栏容器 | 高 36 | **高 47 + `box-sizing:border-box`** | 同上 |
| §7.2.3 状态点 | 8×8（未提 box-sizing） | **外径恒 8×8 + `box-sizing:border-box`** | **规格缺一条**（未说外径）+ **实现错**（空心态 10–11） |
| §3.4.1（新增） | 无（只有 §3.4"命中盒 24×24"） | **≥24×24 全文唯一口径 + 豁免清单 + 可断言片段 + flex 容器必须 `flex:none`** | **规格不够可判**（未给"哪个元素/怎么断言"）+ **实现错**（`⋯` 5/8 档、行内 16×16、chip 22.7） |
| §3.4.2（新增） | 无 | **`height/width`+`padding/border` ⇒ 必须显式 `box-sizing:border-box`** | **规格缺一条系统性约束**（宿主无全局重置） |
| §7.2.2 chip | 高 24（未提宽度） | **+ `min-width:24px` + `justify-content:center`** | 规格不够可判 + 实现错（22.7） |
| §7.2.2 行内动作 | 24×24 | **≥24×24，禁止裸 `.dsh-rw-link`** | 实现错（16×16） |
| §7.2.4 组标题 | `←S`、3 组、`role="presentation"` 或 `aria-hidden` | **`←P`、4 组（含快捷目录）、普通 `<div>` + `aria-labelledby`、禁用 `aria-label`** | **规格错**（3:1 门槛 + aria 形态含糊）+ 实现错（N4 混用） |
| §7.2.3 分隔符 | 未规定唯一性 | **底栏可见文本 `·` ≤ 1，只有附加信息 span 产生** | **规格缺一条**（拼接规则）+ 实现错（N5 双 `·`） |
| §7.3 规则 4（新增） | 无 | **同一动作不得在两个常驻位置同时出现**；`<420px` 从头部移除 `添加为工作区` | 实现错（N1 双入口） |



> **两条"有理由的偏离"（lead 要求"偏离要能自证"）**：**§8.4-C3**（容器/控件 3:1 边界）与 **§8.7-2** —— 两条都给了①实测对比度②为什么现有 token 不可达（15 个都测过，最重 1.45）③替代的多通道方案。lead 已确认"这轮已经做到了"。

---

## 10. 复算入口（脚本 / 原始输出 / 命令）

全部产物在 `spike/verify/explorer-20261012/visual/`（本文的写作用域；**未触碰 `src/**`、`client/**`、`package.json`**）。

| 文件 | 内容 |
|---|---|
| `tools/scan-asar-tokens.mjs` | 扫 `app.asar`：列出全部 `--dsw-*` token 名（**423** 个）+ 定义上下文 |
| `tools/resolve-theme-tokens.mjs` | 解析 `body{}` / `body[data-ds-dark-theme]{}` 两套块，递归解 `var()` 到静态调色板 ⇒ light/dark 真值 |
| `tools/contrast-check.mjs` | **58 组**对比度（含 alpha 合成、逐组 PASS/FAIL） |
| `tools/usage-of-token.mjs` | 某 token 在**出厂 CSS** 里的用法（选择器 + 声明）⇒ "官方这样用它"的先例 |
| `tools/token-descriptors.mjs` | token 注册表的官方 `description` / `requiresLightAndDark` |
| `tools/css-token-audit.mjs` | **门禁**：C1 硬编码色 = 0 **且** C2 token 集合 ⊆ 17（exit 0 = 通过）；外加 S1 软检查（`label-dimmed` 使用域）+ Q4 的 shadow 窄豁免。已对基线/工作区/5 个夹具实跑（§1.5） |
| `tools/overlay-on-surfaces.mjs` | alpha 覆盖层在**三种背景**上的终值 + `hover/静息`、`active/静息`、`active/hover` 三组可区分性（T27 第二轮约束 #2） |
| `tools/box-sizing-audit.mjs` | **content-box 陷阱审计**（T43）：列出"声明 height/width + 有 padding/border 却未声明 `box-sizing:border-box`"的规则，给出「声明值 → 实际渲染值 → 差额」；`--host=<asar>` 另报宿主的 `box-sizing` 重置形态 |
| `out-01-asar-token-scan.txt` | **423** 个 token 名 + 定义上下文（476 KB） |
| `out-02-theme-token-values.txt` | 本文 §1.1 表格的取值来源 |
| `out-03-contrast.txt` | 本文 §8 的全部测值来源（58 组） |
| `out-04-token-usage-precedent.txt` | 官方用法先例（`bg-overlay` = "Overlay and popover background"；`interactive-bg-hover` 194 处；`label-dimmed` 只用于 `:disabled`/`::placeholder`；`bg-layer-3` 用于 input 背景） |
| `out-05-css-token-audit.txt` | 门禁实跑：基线（`7cb3362`）与工作区均 **C1=0 / C2=PASS / exit 0**；5 个夹具 = 4 负（各 exit 1）+ 1 正（exit 0） |
| `out-06-token-descriptors.txt` | 14 条官方 token 描述 |
| `out-07-overlay-on-surfaces.txt` | 本文 §5.1.1 三背景表的原始读数 |
| `out-08-box-sizing-audit.txt` | 本文 §3.4.2 / §7.2.3 的根因证据：3 条 content-box 陷阱（`.dsh-rw-btn +10` / `.dsh-rw-chip +2` / **`.dsh-rw-status +19 ⇒ 55`**）+ 宿主无全局重置（235 处全逐组件） |
| `REPORT-t28-reconcile.md` | **T43 对账报告**（T40 实测 vs T28 规格）：底栏 55/36 判责、命中区最小尺寸、组标题取色 Q6、N1–N5 逐条 |

**复算命令（五条，零安装、无可见窗口、不碰用户宿主）**：

```powershell
$node = 'C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$visual = 'D:\project\dsh1\vendor\dsh-remote-wsl\spike\verify\explorer-20261012\visual'
$asar = 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\app.asar'

# 1) token 真值（light / dark）
& $node "$visual\tools\resolve-theme-tokens.mjs" $asar --dsw-alias-bg-layer-1 --dsw-alias-bg-layer-2 --dsw-alias-bg-overlay --dsw-alias-label-primary --dsw-alias-label-secondary --dsw-alias-state-idle-primary

# 2) 对比度（58 组）
& $node "$visual\tools\contrast-check.mjs" $asar

# 3) alpha 覆盖层在三背景上的终值 + 两态可区分性
& $node "$visual\tools\overlay-on-surfaces.mjs" $asar

# 4) 门禁（C1 硬编码色 + C2 token 闭集；exit 0 = 通过）
& $node "$visual\tools\css-token-audit.mjs" 'D:\project\dsh1\vendor\dsh-remote-wsl\client\index.js' dsh-rw-

# 5) content-box 陷阱审计（T43）
& $node "$visual\tools\box-sizing-audit.mjs" 'D:\project\dsh1\vendor\dsh-remote-wsl\client\index.js' dsh-rw- --host=$asar
```

**基线副本**：`%TEMP%\vd-baseline-7cb3362`（由 `git -C <repo> archive 7cb3362 | tar -x` 产生，只读使用，收尾删除）；
门禁夹具用的提交版单文件取自 `git show 7cb3362:client/index.js`（同样只读，收尾删除 `%TEMP%\vd-gate-7cb3362`）。

---

## 11. 收尾与纪律（本轮实际执行情况）

| 项 | 结果 |
|---|---|
| 是否起测试实例 | **没有**。本文只需 token 真值（来自 `app.asar`）+ 已提交基线的视觉对照（来自 `usability-engineer` 的 `ux-baseline/`，同一 commit 的副本）⇒ 起实例的唯一收益是复测渲染值，而该值已有独立实测（T27 §0.1：dark 面板底 `rgb(35,35,36)` = 本文 `bg-layer-1` dark `#232324`） |
| 可见窗口 / 进程 | **0 个属于我**（枚举见下方"窗口归属证据"） |
| 端口占用 | **0 个**（8971–8980 无监听者：`Get-NetTCPConnection -State Listen` 逐端口查过） |
| 用户宿主 `127.0.0.1:19387` | **未碰**：监听的 pid = **47564**，`StartTime = 2026-10-10 12:25:54`（= 任务开始前就在跑的活宿主） |
| WSL 侧 unit / 守护 / profile / 包装层 | **我创建了 0 个**（本轮全部工作在 Windows 侧的文件与 node 脚本里，从未调用 `wsl.exe` / `dsh.cmd`）。备注：Windows 宿主 shell 里**没有** `systemctl`（它是 WSL 内的命令）⇒ 无法从宿主侧执行 `systemctl --user reset-failed`；**且我没有需要清的 unit**。本文**刻意不运行全局 `reset-failed`**：那会抹掉其它仍在校验的角色留下的 failed 态证据 |
| 写作用域 | `docs/panel-visual-spec.md` + `spike/verify/explorer-20261012/visual/**`；**未改** `src/**`、`client/**`、`package.json`、`docs/panel-ux-redesign.md`（`git status` 可核：我只贡献了这 2 条 untracked 路径） |
| `npm/pnpm install` | **0 次**（6 个脚本只用 Node 内置 `fs`） |
| `%TEMP%` 副本 | `%TEMP%\vd-baseline-7cb3362` —— 收尾已删（`Test-Path` 复核 = `False`） |
| 截图 | 未新拍；引用 `spike/verify/explorer-20261012/usability/ux-baseline/` 的 11 张（同一 commit 副本，来源可核） |

**窗口归属证据（禁凭标题猜，逐条交叉）**

| 判据 | 观测 | 结论 |
|---|---|---|
| 可见顶层窗口枚举（`EnumWindows` + `IsWindowVisible` + 非空标题） | **9 个进程 / 12 个窗口**：`explorer.exe`(20772)、`ClickToDo.exe`(41120)、`TextInputHost.exe`(19728)、`msedge.exe`(24960)、`DeepSeek Harness.exe`(**47604**，StartTime **10-10 12:25:54**)、`gephgui-wry.exe`(22844)、`Code.exe`(17048)、`Cursor.exe`(39532)、`Weixin.exe`(36284) | **没有任何一个窗口的进程启动时间落在我的任务窗（10-13 09:22–09:45）内** |
| 父链交叉 | 上列窗口的父进程分别是 `explorer.exe`(20772)、`svchost.exe`(1488/3684)、`13836` —— **没有一条链可回溯到我这轮创建的任何进程** | 我无窗口 |
| 我窗口内新起的进程 | 只有 `chrome.exe` 共 9 个（父 = **50588 / 14096**，二者均为 `chrome-devtools-mcp@1.10.1` 的 MCP 服务进程，且父进程是**用户宿主 47564**、启动于 09:07:41 / 09:22:22） | 它们是 **MCP 的浏览器实例**，**不出现在可见窗口枚举里**（headless）；我对它们的唯一动作是一次**只读** `list_pages`（返回 `about:blank`） |
| `peer=win-pid-…` 交叉 | 本插件的 `wsl_open_ui` 会写出该标记；我**从未**走那条路径 ⇒ 无标记可比对 | — |
| 启动类工具调用记录 | 本轮只调用 `read / glob / grep / pwsh / git archive / node / team_* / send_message / cordis_inspect_query / read_image`；**未调用** `launch_app`、`bring_to_front`、`Start-Process`、任何 cua 输入类工具 | 与我"0 窗口"的观测一致 |

**T43 对账轮的收尾（2026-10-13 16:37–17:03，纯静态对账）**

| 项 | 结果 |
|---|---|
| 实例 / 端口 | **未起实例**；8971–8980 **无监听者**；未调用 `wsl.exe` / `dsh.cmd` ⇒ WSL 侧 unit/守护/profile **均为 0**（宿主 shell 无 `systemctl`；**刻意不执行全局 `reset-failed`**，以免抹掉其它角色的 failed 态证据） |
| 可见窗口（本轮） | 15 个窗口 / 11 个进程；**窗口内（16:37 之后）新起的只有 1 个**：`chrome.exe` pid **45372**，启动 **17:02:33**，**父进程 = `explorer.exe`(20772)** ⇒ **用户自己开的浏览器**（本轮我未调用任何启动类工具）；其余 14 个窗口启动时间均 ≤ 10-13 09:49 |
| `%TEMP%` | 夹具目录 `vd-t43-fixtures` 已删；`vd-*` 残留 = **0** |
| 写作用域 | 仅 `docs/panel-visual-spec.md` + `visual/**`；`client/**`、`src/**` **只读**（用于定位根因），未改一行 |
| 详版 | `spike/verify/explorer-20261012/visual/REPORT-t28-reconcile.md` §7 |

---

## 附录 A：本文与 T27 的分工边界（一句话版）

| 问题 | 归谁 |
|---|---|
| 屏幕上应该有哪些东西、先看哪个、点了会发生什么、键怎么走 | **T27**（`docs/panel-ux-redesign.md`） |
| 每样东西长什么样、用什么色、多大、多重、间距多少、聚焦时什么样、两种主题下都成立吗 | **本文** |
| 两份冲突时 | **lead 裁决**（本文把冲突逐条列在 §9.3-P6 与 §9.5-Q1–Q5） |

---

## 附录 B：T54 复验节 —— HEAD `70c697d` 上的实测成品图与逐项读数（2026-10-14）

> 本轮把**成品图与读数**从"T40 那批（修前）"更新到**当前 HEAD**。原始证据：`spike/verify/explorer-20261012/usability/p06-final/`（12 张 PNG + 4 份 JSON + 断言脚本）。**前置**：`check-client-rev` exit 0，且**页面加载的 9 个 chunk 与磁盘逐字节相同**（trailer 判法，`allPass: true`）。

| 本文的定稿值 | 本轮实测（light / **dark**） | 判定 |
|---|---|---|
| §7.2.3 底栏高 **47**（外框） | **47 / 47**（320 亦 47） | ✅ |
| §4.2-1 状态词不省略 | `scrollWidth==clientWidth` **91==91 / 91==91** | ✅ |
| §3.4.1 命中区 **≥24×24**（V1：25 个可点元素） | **`<24` 计数 0 / 0**；行内动作 32×24、chip 24×24、`⋯` 24×24 | ✅ |
| §7.2.4 菜单外框宽 **240** | **240 / 240** | ✅（T52 修复后） |
| §7.2.4.1 组标题对比度（Q6：dark ≥4.5） | 15.97 / **5.55** | ✅ |
| §2.4 阴影只给浮层（Q4） | 面板内 `box-shadow` 计数 **0 / 0** | ✅ |
| §7.2.4 菜单不遮底栏状态词 | `overlapWithStatusWord` **false / false** | ✅ |
| §7.2.4 组标题是普通 `<div id>`（无 `presentation`） | 2 组：`aria-labelledby` 目标存在、`ariaLabel` 空、`tabIndex=-1`、**`role` 为空** | ✅（T53 修复后） |

**与 T40 那批的差异（修复后才有的）**：底栏 **55 → 47**、行内动作 **16×16 → 32×24**、chip `/` **22.7×24 → 24×24**、`⋯` 窄档 **16–21×24 → 24×24**；菜单宽 240、组标题 `presentation` 去除、面板内阴影计数 = 0 属**本轮新增的读数项**（T40 未测）。逐项对照见 `p06-final/REPORT-p06-shots.md` §5。

**本轮新增的一条判据写法**（可复用）：断言必须打在**页面真实读数**上（`getBoundingClientRect` / `getComputedStyle` / `scrollWidth`），且**必须能红**——本轮用两条故意红验证：命中盒 24→12 ⇒ A2 红；组标题色 → `label-dimmed` ⇒ A5 红（dark 1.65）；字节还原后复绿 21/21。

**遗留（未在本轮修，写作用域禁改 `client/**`）**：320 时面板仅 264px 宽 ⇒ 头部标题/副标题换行（副标题被拆成 4 行）、底栏「启动守护」按钮 49px 宽而文本换行；底栏外框仍 47px 且无横向溢出，观感瑕疵待后续任务。
