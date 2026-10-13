# REPORT —— T40：§9.4 四项复验 + P0.4 成品截图

- **日期**：2026-10-13 ｜ **评估者**：`usability-engineer` ｜ **被测量**：**P0.4 = commit `63320b4`**（14 锚点）
- **证据目录**：`spike/verify/explorer-20261012/usability/p04-final/`（截图 + 每阶段原始 JSON）
- **工具**：`p04-boot.ps1`（Hidden 起实例 + overlay）｜`p04-verify.ts` / `p04-refine.ts`（headless Chrome + CDP，Node 26 直跑 TS）
- **纪律核对**：端口仅 8961/8963 + CDP 8965（现全段空闲）；无 `npm/pnpm install`；无可见窗口（实例 `-WindowStyle Hidden`、浏览器 `--headless=new`）；未碰用户宿主 19387/47604；未写 `~/.dsh/storages/workspace.json`

---

## 0. 一律先读：前置证明（否则看到的是旧脚本）

### ① `tools/check-client-rev.mjs` → **exit 0 / PASS**

```
client-rev 门禁：PASS（模式=git）
  插件根   : D:\project\dsh1\vendor\dsh-remote-wsl
  入口     : client/index.js（来自 exports["./client"]）
  当前 rev : 07cf221a6f42   [mtime=2026-10-13T06:32:37.108Z ctime=…117Z size=25609]
  chunks   : 4 个  client.api.js(c3600ee5) client.i18n.js(cba40e69) client.icon.js(e9a824f5) client.panel.js(7719876a)
  依据     : 自入口最后一次内容变更（63320b4e243a）以来没有任何 chunk 变化 ⇒ rev 与内容自洽
```

### ② 页面实际加载的 chunk == 磁盘 chunk（trailer 感知，逐字节）→ **4/4 PASS**

做法：从页面 `performance.getEntriesByType('resource')` 取**页面真正用过的** chunk URL（4 条）→ 逐条 `fetch(url,{cache:'no-store'})` 取 serve 正文 → 去掉 `sourceMappingURL` trailer → 与**磁盘文件**逐字节比较。

| chunk | served 正文 | 磁盘 | 平台追加 | 逐字节前缀 | 磁盘 sha256(前16) |
|---|---|---|---|---|---|
| `client.api.js` | 13,297 | 13,296 | `";"` | **PASS** | `c3600ee50356ade5` |
| `client.i18n.js` | 32,683 | 32,682 | `";"` | **PASS** | `cba40e696ff68cf0` |
| `client.icon.js` | 2,210 | 2,209 | `";"` | **PASS** | `e9a824f50e45e5d4` |
| `client.panel.js` | 55,804 | 55,803 | `";"` | **PASS** | `7719876a65a048c6` |

- 判据（契约 §11 的精确口径）：**磁盘内容 == serve 正文的前缀**；serve 正文 = 磁盘字节 + `;` + 一行 `//# sourceMappingURL=…?rev=…`。
- **对契约 §11 的一处措辞修正（实测）**：平台插的是 **`;`（分号）**，不是换行。建议 §11 把"落一行 trailer"写成"追加 `;` + `sourceMappingURL` trailer"。
- **rev 的两个值不要混淆**：页面里 row rev = **`6928d6dfce5e`**（我的实例指向 **`%TEMP%` 副本**，rev = sha1(入口 mtime/ctime/size)，故与仓库工作区的 `07cf221a6f42` 不同）；**内容逐字节相同**（上表磁盘哈希 == 门禁列出的 chunk 哈希）。⇒ **rev 是元数据哈希**这一机制在本轮再次被证实。
- 磁盘 chunk 哈希与门禁输出**逐个相等** ⇒ 门禁的复算口径与平台一致。

---

## 1. V1 —— 行内动作命中区 ≥24×24 且净距 ≥4 ⇒ **FAIL（尺寸）/ PASS（净距）**

方法：1280×900；`CSS.forcePseudoState('.dsh-rw-row', 'hover')` 让行内动作显现后读 `getBoundingClientRect()`（`out-p04-refine-v1.json`）。

| 控件 | 实测 rect（w×h） | 判定 |
|---|---|---|
| **行内动作「进入」**（新的 IA 下每行**唯一**的动作，hover 才显现；未 hover 行 `visibility:hidden`） | **16 × 16** | ❌ **< 24×24** |
| 行高 | **32** | ✅ 与 T28 §3.5 一致 |
| 相邻行命中盒**净距** | **18px**（两行 16px 盒、32px 行距） | ✅ ≥4（T28 给 8，实测更宽） |
| 行内相邻动作水平净距 | 每行只有 1 个动作 ⇒ 不适用 | — |
| 「添加为 WSL 工作区」（头部主按钮） | 132.3 × 28 | ✅ |
| 「刷新」(icon) | 24 × 24 | ✅ |
| 「隐藏文件：不显示」 | 114 × 24 | ✅ |
| chips：`Home`/`/mnt*` | 43.9–55.6 × 24 | ✅ |
| chips：**`/`** | **22.7 × 24**（1280）/ **23 × 24**（320） | ❌ **< 24 宽** |
| **`⋯`（底栏，破坏性动作唯一入口）** | 320→**16×24**、359/360→**21×24**、419/420→**16×24**、719/720/1280→**24×24** | ❌ **8 个宽度里有 5 个 < 24 宽** |

**结论**：V1 **不通过**。最要紧的两个：
1. **行内动作 16×16**（正是 V1 想防的"hover 才显现 + 太小点不中"组合）；
2. **`⋯` 在窄宽下缩到 16–21×24** —— 它是**破坏性动作的唯一入口**，窄宽（用户最可能误触/最难点）反而最小。

**能红断言（建议进验收集）**：`panel.querySelectorAll('button,[role="button"]')` 中，凡 `getBoundingClientRect()` 参与点击的控件，**宽与高均 ≥24**（或显式声明豁免并写明理由）。当前状态该断言**红**。

---

## 2. V3 —— 8 个宽度：不换行 + 状态词不被省略 ⇒ **PASS**

**视口怎么真改的（回应 lead 的提醒）**：不用 `resize_page`，用 CDP `Emulation.setDeviceMetricsOverride`；**8 个宽度都回读 `innerWidth` 并与请求值逐一相等**（下表的 `innerW` 列即证据）。

| 请求宽度 | innerWidth | footerH | scrollW/clientW | 状态词 | 状态词 scrollW/clientW | 不省略 | 单行证据 |
|---|---|---|---|---|---|---|---|
| 320 | **320** | 55 | 264/264 | 远端守护未运行 | 91/91 | ✅ | distinctCenters=**1** |
| 359 | **359** | 55 | 303/303 | 同上 | 91/91 | ✅ | — |
| 360 | **360** | 55 | 304/304 | 同上 | 91/91 | ✅ | — |
| 419 | **419** | 55 | 363/363 | 同上 | 91/91 | ✅ | — |
| 420 | **420** | 55 | 364/364 | 同上 | 91/91 | ✅ | — |
| 719 | **719** | 55 | 663/663 | 同上 | 91/91 | ✅ | — |
| 720 | **720** | 55 | 664/664 | 同上 | 91/91 | ✅ | — |
| 1280 | **1280** | 55 | 1000/1000 | 同上 | 91/91 | ✅ | distinctCenters=**1** |

- **单行判据（避免"换行了所以不溢出"的假绿）**：底栏 `footer.dsh-rw-status` 的**所有可见子元素垂直中心唯一**——
  - 320：5 个子元素（状态点 10×10 / 「远端守护未运行」91×20 / 「· 会话 0 个」31×16 / 「启动守护」52×28 / `⋯` 16×24），`centerY` **全 = 873**
  - 1280：7 个子元素，`centerY` **全 = 873**
  - 且 **footerH 在 320→1280 恒为 55**（若在窄宽换行，320 必然更高）⇒ **无换行**
- 320 下「更新于 …」按 T28 §7.2.3 被隐藏（子元素数 7→5）✅；「启动守护」在 320 仍完整（52×28，文本未被截断）✅；`⋯` 在 320 仍存在且可见/可聚焦 ✅（但宽度只有 16 → 见 V1）
- **给 T28 的一条对账**：底栏实测 **高 55px**，其 §7.2.3 写的是 **36**（`padding:9px 12px` + 内容）。V3 判据不受影响，但**垂直预算需对齐**（`out-p04-refine-v3b.json` 有逐子元素读数）。

**结论**：V3 **通过**（8/8 宽度：不换行、状态词未被 ellipsis 吞掉、`⋯` 可达）。

---

## 3. V7 —— hover 与"当前项"在三种背景上可区分；当前项走形状通道 ⇒ **PASS**

### 3.1 hover 在三种背景上都可见（`CSS.forcePseudoState`，读 `getComputedStyle().backgroundColor`）

| 背景 | 控件 | 静息 | hover | 变化 |
|---|---|---|---|---|
| `sidebar-fill`（底栏） | 底栏按钮「启动守护」 | `rgb(255,255,255)` | `rgba(38, 49, 72, 0.06)` | ✅ |
| `sidebar-fill`（底栏） | `⋯` 菜单按钮 | `rgba(0,0,0,0)` | `rgba(38, 49, 72, 0.06)` | ✅ |
| `bg-layer-1`（列表） | 目录列表行 `.dsh-rw-row` | `rgba(0,0,0,0)` | `rgba(38, 49, 72, 0.06)` | ✅ |

⇒ 三处背景都有**非 1.00** 的可见变化（与 T28 §5.1.1 的 1.11 light 一致）。

### 3.2 "当前项"确实走**形状通道**（不是只靠填充）

实测定位：`.dsh-rw-crumb.dsh-rw-crumb--current.dsh-rw-current`（面包屑的当前段，文本 `dsh1`）

```
border-left-width : 2px          ← 竖条
border-left-color : rgb(15,17,21)
font-weight       : 600          ← 字重
```

- 面板内**只有 1 个**元素带 `border-left ≥ 2px`（就是这个 current crumb），字重 ≥600 的另有标题与分组标题（预期）。
- **位置说明（与 §9.4 的措辞对齐）**："当前项"落在**面包屑的当前段**；目录**列表行是"条目"而非"当前项"**，故行内没有竖条——这与新 IA 自洽。我的 §9.4 原句"当前行须有 2px 竖条+600"应精确为"**当前目录的标记**须有 2px 竖条+600"。
- **"强制置静息填充后仍可分辨"**：形状通道是 `border` + `font-weight`，与填充无关，故天然成立；下面的红测进一步证明。

### 3.3 故意红（≥1）—— A/B 两侧对照

**红变体**：`%TEMP%\usab-p04-red`（`63320b4` 的副本，入口 `client/index.js` 追加一段注入样式的脚本：`.dsh-rw-crumb--current,.dsh-rw-current{border-left-width:0 !important;font-weight:400 !important}`；入口 25,609 → **25,982 B** ⇒ rev 必变，避开契约 §11 的陈旧坑），起在 8963。

| 变体 | 竖条 | 字重 | 断言结果 |
|---|---|---|---|
| **pristine（P0.4）** | `2px` | `600` | **PASS** |
| **red（去掉形状通道，只留填充）** | `<无>` | `<无>` | **RED**（M15/V7 失败） |

⇒ 断言**有区分力**（两侧都动过），不是"永远绿"。

### 3.4 菜单可达性读数（顺带）

- `role="menu"` 存在；1280 下 **3 组**（`快捷目录` / `守护` / `诊断`），320 下 **4 组**（多出 `工作区`，与 §5.4 的窄宽溢出规则一致 ✅）
- 组标题：`守护`/`诊断`/`工作区` 用 `aria-labelledby`（指向 `dsh-rw-menu-daemon` / `-diagnostics` / `-workspace`）；**`快捷目录` 用的是 `aria-label`** ⇒ **同一菜单内两种标注方式不一致**（小瑕疵，建议统一为 `aria-labelledby`）
- 菜单项高度 **28** ✅、单行 ✅；**启用态文字 = `rgb(15,17,21)`（`label-primary`）** ✅（守护运行时实测）
- 守护未运行时 `重启/停止` 显示为**淡色 `rgb(225,229,238)`**（禁用态）；**未核实**它是否等于 `label-dimmed` 且带 `aria-disabled`（本轮未测该属性）

---

## 4. 第 4 项 —— 未把 #1–#8 拉回来（对照 `ux-01/02/04/05/06/07/09`）

| # | 原批判 | 现在 | 证据 |
|---|---|---|---|
| 1 | IA 混乱：两套目录概念并存 | ✅ **修复**：旧树整块消失；面板只剩**一个**目录概念 + `最近目录`（折叠）+ `诊断信息`（折叠） | 面板全文（`out-p04-refine-menu320.json` / `out-p04-shots.json` 的 `errorBadpath.text`）里已无 `默认发行版`/`当前目标`/`原始 snapshot`；`ready-light.png` |
| 2 | 状态 chip 与交互混在一行 | ✅ **修复**：随旧树一起消失；"当前"只在面包屑当前段（见 §3.2） | `out-p04-refine-v7.json` |
| 3 | 动作是裸文字 | ✅ **修复**：头部是真按钮（主按钮深色填充 132×28）；行内动作是**图标**（不再是裸文字） | `ready-light.png`；`out-p04-refine-v1.json` ⚠️ 但**新问题**：图标命中盒 16×16（见 §1） |
| 4 | 实现者词汇进主视线 | ✅ **大体修复**：加载态「正在读取远端信息…」（不再出现 `explorer.snapshot`/`超时 9000ms`）；底栏「远端守护运行中 · 会话 0 个」「更新于 15:56:57」；`守护/诊断/其它实例` 进折叠区 | `out-p04-shots.json`（loadingText）、`ready-light.png` ⚠️ **残留 1 处**：列目录失败时主句是人话，但**紧跟 host 原文**（含 `\\wsl.localhost\debian-u8-1\…`、重复的 `ENOENT`），见 §5-N3 |
| 5 | 破坏性动作裸露在常显状态条 | ✅ **修复**：守护**运行**时底栏按钮数 = **0**；`重启/停止` 只在 `⋯` 菜单 | `out-p04-refine-running.json`（footerText 只有状态句+时间）、`menu-daemon-running-light.png` |
| 6 | 缺一等入口 | ✅ **修复**：头部「添加为 WSL 工作区」+「在此目录新建会话」；工作区组在 <420px 出现于菜单 | `ready-light.png`、`out-p04-refine-menu320.json` ⚠️ 但 **320 下同一动作在头部与菜单**都出现（§5-N1） |
| 7 | 大面积空白 | 🟡 **明显改善**：11 行列表 + 两个折叠区把面板填到 ~675px；剩余 ~200px 空白（短目录固有） | `ready-light.png` |
| 8 | 时间戳/刷新语义不明；D3/D4 只在 hover | ✅ **修复**：底栏「更新于 HH:MM:SS」；**「未物化」「仅筛选，不改目标」常显**（不再只在 `title`） | `ready-light.png` |

---

## 5. 本轮新发现（不在 §9.4 四项内，但属于同一验收面）

| # | 现象 | 为什么是问题 | 建议 |
|---|---|---|---|
| **N1** | **320px 下「添加为 WSL 工作区」同时出现在头部和 `⋯` 工作区组**（同一 i18n 键、同文案） | 同一动作两个常驻入口 ⇒ 用户要判断"点哪个不一样"，且与"窄宽收进菜单"的意图矛盾 | 二选一：<420px 时**从头部移除**（保留在菜单），或**保留头部、菜单不再列**。`out-p04-refine-menu320.json` |
| **N2** | 底栏实测**高 55px**，T28 规格写 36 | 垂直预算与视觉规格不一致；两文档对不上会让实现反复改 | 由 T28 裁决取哪个值并同步两份文档；`out-p04-refine-v3b.json` 有逐子元素读数 |
| **N3** | `列目录失败` 的主句是人话，但**同块内紧跟 host 原文**（`\\wsl.localhost\…`、`ENOENT: ENOENT`） | 与"host 原文进折叠"的口径不一致；主视线出现 UNC 路径与重复错误码 | 主句 + 「详情」折叠装 host 原文（同 stop 失败态的处理）；`out-p04-shots.json` 的 `errorBadpath.text` |
| **N4** | 菜单 `快捷目录` 用 `aria-label`，其余组用 `aria-labelledby` | 同一控件两种标注方式 ⇒ 读屏体验不一致且难维护 | 统一为 `aria-labelledby`（或在文档里写明为何不同） |
| **N5** | 加载态底栏文案 `远端守护状态未知 · · 状态读取中…` 出现**两个分隔符** | 文案拼接缺陷（分隔符被两侧各加一次） | 由一个位置统一加分隔符 |
| **N6** | chips「`/`」22.7×24；`⋯` 在 5/8 宽度下 <24 宽 | 见 §1（V1） | 命中区至少 24 宽（`min-width:24px`） |

---

## 6. 未复核（明确标注，不当通过）

| 项 | 拦在哪 |
|---|---|
| **多实例 / `others[]` 真实非空** | 本机此刻**没有**其它实例的守护在跑（`daemon.others = []`，实测）⇒ 用了**页面内 fetch 夹具**注入 8731/8972，截图命名 `multi-instance-fixture.png` 并在 JSON 里标注 `mode=fixture`。**真实非空态未复核** |
| **`E_UNAVAILABLE` 的渲染** | 按 lead 先前指令**以 T26 为准**，不列入本报告（§9.4 已写边界声明） |
| 禁用菜单项是否 `label-dimmed` + `aria-disabled` | 只读到颜色 `rgb(225,229,238)`，未读属性 |
| 灰度/色盲下的两态区分（V7 的"灰度截图"形态） | 用**计算样式读数 + A/B 红测**替代（读数比灰度截图更可判且可复算）；**未出灰度截图** |
| dark 主题下的 V1/V3/V7 读数 | 本轮 dark 只出了**成品截图**（`ready-dark.png`/`menu-dark.png`/`narrow320-dark.png`），**未逐项读数** |
| `~/.dsh/storages/workspace.json` 是否被动过 | 未触碰（纪律要求）；**未做**"未变更"的前后哈希取证 |

---

## 7. 成品截图清单（`p04-final/`，每张一句"看什么"）

| 文件 | 看什么 |
|---|---|
| `ready-light.png` | 整面板 light：头部（标题/目标/两个常显 chips/一个主按钮）、面包屑当前段有竖条、11 行列表、两个折叠区、底栏一行 |
| `ready-dark.png` | 同上的 dark 版（token 双份是否成立） |
| `menu-light.png` / `menu-dark.png` | `⋯` 菜单：三组（快捷目录/守护/诊断）+ 菜单项单行 `label-primary` |
| `menu-daemon-running-light.png` | 守护**运行**时菜单：`重启/停止远端守护…` 启用态（文字 `rgb(15,17,21)`） |
| `ready-daemon-running-light.png` | 守护运行时**底栏按钮数 = 0**（破坏性动作不在常显状态条） |
| `narrow320-light.png` / `narrow320-dark.png` | 320px：头部只剩主按钮+刷新、底栏单行、状态词完整 |
| `menu-320-light.png` | 320px 的菜单**多出「工作区」组**（§5.4 溢出规则），同时暴露 N1 的重复入口 |
| `error-badpath.png` | 路径输入 `/definitely/not/here-usab` → `列目录失败（…）` + `重试`（顺带暴露 N3 的 host 原文） |
| `loading.png` | **定格**加载态（延迟 fetch 夹具 4s）：`正在读取远端信息…`，无 `explorer.snapshot`/`超时 Nms` 术语 |
| `multi-instance-fixture.png` | **夹具**注入的 `others[]` 非空态（真实态不可得，见 §6） |
| `v1-row-hover-light.png` | 行 hover 时显现的**唯一行内动作**（16×16，V1 的失败证据） |
| `v3-320-footer.png` | 320px 底栏单行（V3 证据） |
| `v7-menu-open-light.png` | V7 菜单读数时的现场 |
| `red/v7-menu-open-light.png` | **红变体**现场（当前项无竖条/无 600 字重） |

---

## 8. 收尾（自造物清单 + 归属证据）

| 动作 | 结果 |
|---|---|
| 停我的守护 unit | `systemctl --user stop dsh-rwsl-8962` + **`reset-failed`** ⇒ `dsh*` 单位 **0**、**failed 0** |
| 停实例 | 8961（pristine）/ 8963（red）均已停，**8961–8970 全段空闲** |
| 关浏览器 | headless Chrome（`--user-data-dir=%TEMP%\usab-p04-chrome`）已关；**0** 个 chrome 进程带我的 profile；8965 free |
| 删 profile / 副本 | `remote-wsl-p04`、`remote-wsl-p04-red`、`%TEMP%\usab-p04`、`usab-p04-red`、`usab-p04-chrome` 全部删除（逐一复核不存在） |
| 用户宿主 | `19387` = **47564**、桌面 GUI **47604** 均存活 |
| **窗口枚举（禁凭标题猜）** | 28 窗口/15 应用；按**启动时间**核验：除 `chrome.exe pid 14136`（**16:04:48** 启动）外全部早于本次会话（10-08…10-13 14:36）。该 pid 经**命令行**核验：`"C:\Program Files\Google\Chrome\Application\chrome.exe"`（**无** `--headless`、**无** `usab-p04-chrome`），父进程 = `explorer.exe` ⇒ **用户自己开的浏览器**，非我的。另，全机提到我 profile 字样的 2 个进程分别为 `DeepSeek Harness.exe`（本会话宿主）与 `pwsh.exe`（我自己的校验命令）⇒ **均非残留** |

---

## 9. 结论（一句话）

**前置两条证明都通过**（门禁 exit 0；4/4 chunk 逐字节 == 磁盘，平台追加的是 `;`）；
**V3 通过、V7 通过（含 A/B 红测证明断言有区分力）**；
**V1 不通过**：行内动作 `16×16`、chips「`/`」`22.7×24`、**`⋯` 在 5/8 宽度下 `16–21×24`**（后两者尤其要紧——`⋯` 是破坏性动作的唯一入口）；
**#1–#8 未拉回**（1/2/3/5/6/8 修复；7 明显改善；4 大体修复但残留列目录失败的 host 原文）；
另记 6 条新发现（320 下 addWorkspace 双入口、底栏 55 vs 规格 36、N3 host 原文、菜单组标注不一致、加载态双分隔符、窄宽命中区）。
**未复核**：`others[]` 真实非空（夹具替代）、`E_UNAVAILABLE`（以 T26 为准）、dark 下的逐项读数、灰度截图形态。
