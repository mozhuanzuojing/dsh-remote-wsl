# REPORT —— T52：修 `.dsh-rw-menu` 的真陷阱（声明 240 → 渲染 250）

- **日期**：2026-10-14 ｜ **作者**：`visual-designer` ｜ **状态**：修复完成 + 五道验收全过（1 项未复核，见 §6）
- **写作用域**：`client/index.js`（**仅此一个文件**）+ 本目录证据。**未碰** `src/**`、其它 `client/**`、`package.json`。
- **来源**：本缺陷是 **T49 用新判据查出来的**（`REPORT-t28-reconcile.md` §10.5/§10.8），与 T43 的底栏 **同族**：**规格给的数字 ≠ 实际渲染的盒子**。
- **改动**：`.dsh-rw-menu` 加 **`box-sizing:border-box`**（1 行有效改动 + 3 行注释；`client/index.js` 28,342 → 28,727 B，sha256 `666F0D57…`）。

```diff
- ".dsh-rw-menu{position:absolute;bottom:calc(100% + 4px);right:0;width:240px;z-index:30;…}",
+ // T52：规格 §7.2.4 的「宽 240 固定」指**外框**。宿主无全局 box-sizing 重置 ⇒ 不写 border-box 时
+ // `width:240 + padding:4×2 + border:1×2` 按内容盒渲染成 **250**（真实 Chromium 实测，见本报告 ①）。
+ // 与同族 7 条（row/recent-row/menuitem/status/dot/crumb/link）一致。
+ ".dsh-rw-menu{position:absolute;bottom:calc(100% + 4px);right:0;box-sizing:border-box;width:240px;z-index:30;…}",
```

---

## 0. 结论（先看这张）

| 验收项 | 结果 | 证据 |
|---|---|---|
| ① 外框宽 `=== 240` | ✅ **实测**（真实 Chromium）：**before 250 → after 240** | §1（+ 独立推导一致） |
| ② `box-sizing-audit` ⇒ 真陷阱 = 0 / exit 0 | ✅ | §2 |
| ③ 故意红：副本去掉该属性 ⇒ 真陷阱 = 1 / exit 1；字节还原复绿 | ✅ 副本 sha256 与真文件**逐字节相同** | §3 |
| ④ 改 `client/**` ⇒ bump 入口 | ✅ rev `afc26d1a2793` → **`de709fee59c0`**；`check-client-rev` exit 0；precommit 07 PASS | §4 |
| ⑤ 回归 | ✅ css-token-audit 0 · smoke 16/16 · CJK 剥注释 0 · 菜单不遮状态词（交集面积 **0**）；**M1 未复核**（仓库无该检查器） | §5 |
| ⑥ 两栏 + 未复核 | ✅ | §6 |

**为什么不是"改规格"**：规格 §7.2.4 写「宽 **240px**（固定）」指的是**外框**（与 §7.2.3 的底栏「高 47 = 外框」同一口径）；实现漏了 `box-sizing` 才多出 10px。同族 7 条规则都已 `border-box`，本条是**唯一**漏网 ⇒ **判责：实现错（轻）**，修实现而不是改口径。

---

## 1. ① 外框宽：before 250 → after 240（**真实 Chromium 实测**）

**方法（刻意做成"可复跑 + 能红"）**：把插件**自己的 CSS 文本**（从 `client/index.js` 的 CSS 数组原样抠出）加载进**真实 Chromium**，配最小 DOM（`div.dsh-rw-menu` + 3 个 `menuitem`），读 `getBoundingClientRect()` 与 `getComputedStyle()`。

| 变体 | 输入 CSS | `box-sizing` | `declaredWidth` | padding-X | border-X | **`getBoundingClientRect().width`** | harness |
|---|---|---|---|---|---|---|---|
| **before**（改前） | `out-01-panel-before.css` | `content-box` | `240px` | 8 | 2 | **250** | `harness-menu-before.html` |
| **after**（改后） | `out-02-panel-after.css` | **`border-box`** | `240px` | 8 | 2 | **240** | `harness-menu-after.html` |
| **red**（副本去掉属性） | `vd-t52-red/red.css` | `content-box` | `240px` | 8 | 2 | **250** | `harness-menu-red.html` |

- 逐位关系：`250 = 240 + 8 + 2`（内容盒）；`240 = 240`（边框盒）⇒ **与 T43 的 `55 = 36 + 18 + 1` 同一个机制**。
- 真实 Chromium 读数（原始）：`{"width":250,"boxSizing":"content-box","declaredWidth":"240px","paddingX":8,"borderX":2}` / `{"width":240,"boxSizing":"border-box",…}`。

**⚠️ 口径标注（必须如实说）**：这是**机制实测**——**同一份插件 CSS 文本 + 最小 DOM，跑在真实 Chromium 里**；
**不是 DSH 实例内的面板 DOM 实测**（那需要起 `dsh --profile …` 实例 + 真实渲染）。两者差别只在"DOM 外层"，而本规则的宽度**不依赖任何祖先**（`width` 是绝对值、`box-sizing` 只看自身）⇒ 结论可平移。**实例内未测，列入 §6 未复核。**

**独立第二法（层叠生效值推导，与实测一致）**：T49 的 `box-sizing-audit.mjs` 按"同一选择器的层叠生效值"算出 before `声明W 240 → 渲染W 250`、after `240 → 240`（§2 原始输出）⇒ **两种方法同结论**。

复算：

```powershell
$n='C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$c='D:\project\dsh1\vendor\dsh-remote-wsl\spike\verify\explorer-20261012\client-panel'
& $n "$c\tools\extract-css.mjs" 'D:\project\dsh1\vendor\dsh-remote-wsl\client\index.js' "$c\out-02-panel-after.css"
& $n "$c\tools\build-menu-harness.mjs" "$c\out-02-panel-after.css" after $c
# 用浏览器打开 harness-menu-after.html，执行 window.__measure() ⇒ 期望 width=240 / boxSizing=border-box
```

---

## 2. ② 门禁：真陷阱 = 0 / exit 0（原始输出）

```
$ node visual/tools/box-sizing-audit.mjs client/index.js dsh-rw-
.dsh-rw-menu     ?     border-box   #83   —   —   240   240   —   OK(border-box 生效)
真陷阱数 = 0   候选 = 2   OK = 8   无尺寸声明(跳过) = 86
未检测到 box-sizing 的追加覆盖（每个选择器的 box-sizing 只声明一次）
==> PASS（真陷阱 0 条；候选 2 条需人工核对）        exit=0
```

**改前对照（同一脚本）**：`.dsh-rw-menu  ?  —  —  —  —  240  250  —  **真陷阱（宽 240→250；生效 无 box-sizing）**` ⇒ `真陷阱数 = 1 / exit 1`。
**候选 2 条**（`.dsh-rw-btn` / `.dsh-rw-chip`）是 `<button>`（UA 兜底，实测渲染 = 声明值 28 / 24）⇒ 按工具设计记"候选"而非真陷阱，**不是本次的缺陷**。

---

## 3. ③ 故意红 + 字节还原（**能红也能绿**）

| 步骤 | 命令/输入 | 结果 |
|---|---|---|
| 1. 造红副本（**只动 `%TEMP%` 副本，绝不碰真文件**） | `Copy-Item client/index.js %TEMP%\vd-t52-red\index.js`，然后 `right:0;box-sizing:border-box;width:240px;` → `right:0;width:240px;` | 副本 sha256 `388EF702…`（真文件 `666F0D57…`） |
| 2. 红副本上门禁 | `box-sizing-audit.mjs <副本>` | `.dsh-rw-menu … 240 → 250 … 真陷阱（宽 240→250；生效 无 box-sizing）`；`真陷阱数 = 1`；**exit 1** ✅ |
| 3. 红副本进浏览器 | 同上机制实测 | **250 / content-box** ✅（与 before 逐位相同） |
| 4. **字节还原** | `Copy-Item client/index.js <副本> -Force` | 副本 sha256 = 真文件 sha256 = **`666F0D57…`** ⇒ `byte-identical = True` |
| 5. 还原后复绿 | `box-sizing-audit.mjs <副本>` | `真陷阱数 = 0 / exit 0` ✅ |
| 6. 真文件未被污染 | `box-sizing-audit.mjs client/index.js` | `真陷阱数 = 0 / exit 0` ✅ |

> 判据不是"跑一次绿"，而是**同一份输入能红、能绿，且红/绿由那一个属性决定**。

---

## 4. ④ 入口 rev 已 bump（`docs/client-contract.md §11`）

| 项 | before | after |
|---|---|---|
| `client/index.js` size | 28,342 | **28,727** |
| 入口 rev（平台同算法：`sha1("plugin-artifact", mtime, ctime, size)`） | `afc26d1a2793` | **`de709fee59c0`** |
| `check-client-rev.mjs`（git 模式） | PASS | **PASS / exit 0** |
| `precommit-check.ps1` 第 07 项 | —— | **PASS**（client chunk rev 门禁 PASS，模式 = git） |

```
client-rev 门禁：PASS（模式=git）
  入口     : client/index.js   当前 rev : de709fee59c0  [size=28727]
  chunks   : 9 个（逐个哈希与磁盘一致）
  依据     : 自入口最后一次内容变更（d6815996e09d）以来没有任何 chunk 变化 ⇒ rev 与内容自洽
```

**为什么不用手工 bump**：平台 rev **就是入口文件的元数据哈希**；本次改的**正是入口**（CSS 数组在 `client/index.js` 内）⇒ rev 自动变化。**这也意味着"改 chunk 必须动入口"这条纪律本次天然满足**（我没碰任何 chunk）。

---

## 5. ⑤ 回归（5 项 + precommit 全量）

| 检查 | 命令 | 结果 |
|---|---|---|
| 门禁 C1/C2/S1 | `box-sizing-audit` / `css-token-audit` | ✅ 真陷阱 **0**；`C1 硬编码色 = 0` / `C2 token ⊆ 17 闭集 = PASS` / `S1 label-dimmed 域 = OK` ⇒ **exit 0**（17 token 未变） |
| 装载 + 渲染冒烟 | `arch-t6/tools/panel-smoke-node.mjs <插件根>` | ✅ **16/16 PASS**（含"每个 chunk 可装载""组件渲染出根元素"）⇒ 新增的 3 行 `//` 注释**没有**破坏 CSS 数组的 JS 语法 |
| CJK 剥注释 | 自算 | ✅ CSS 数组内含 CJK **19 行且全部是 `//` 注释**；抠出的 CSS 文件含 CJK **0 行** |
| 菜单**不遮底栏状态词** | 真实 Chromium 布局 harness（复刻真实嵌套：菜单是 `position:relative` 的 `.dsh-rw-status` 的子节点） | ✅ `overlapWithStatusWordArea = **0**`（before 与 after 都是 0）；`menuCoversTrigger = false`；菜单底边到 footer 顶边间隙 **3px**（`calc(100% + 4px)` 的亚像素取整，before/after 相同） |
| M1「可见 `dsh1` 恰 1」 | —— | ⚠️ **未复核**：全仓搜过 `*.mjs/*.ts/*.ps1/*.json/*.md`，**没有**这个检查器（`dsh1` 的命中全是仓库路径 `vendor/dsh1`）。**不改声称**，见 §6 |

**布局 harness 原始读数**（真实 Chromium）：

```
before : {"menuWidth":250,"gapMenuBottomToFooterTop":3,"overlapWithStatusWordArea":0,"menuCoversTrigger":false,"viewport":{"w":1869,"h":2035}}
after  : {"menuWidth":240,"gapMenuBottomToFooterTop":3,"overlapWithStatusWordArea":0,"menuCoversTrigger":false,"viewport":{"w":1869,"h":2035}}
```

### 5.1 `precommit-check.ps1` 全量（13 项，原始输出见 `out-03-precommit.txt`）

| 项 | 判定 | 与本次改动的关系 |
|---|---|---|
| 01 git status 干净 | FAIL（14 条未提交） | **预期**：本轮我改的 1 个文件 + 其它角色的在飞改动；提交前才要求为空 |
| 02 README 冻结表 vs REVISION | FAIL（29 处） | **与本次无关**：README 表还停在拆 chunk 之前（多个 chunk 行 MISSING）⇒ 属 arch 拆分后的待办 |
| 03 交接双份一致 | PASS | —— |
| 04 流水不变量 | FAIL（`change-log.md` CRLF=1） | **与本次无关**：用户全局 `~\.agents\change-log.md`（我本轮未写该文件） |
| 05a 端口 8911–8990 | PASS（0 监听） | 我未起实例 |
| 05b WSL 守护 / 05c 包装层 / 05d `dsh-rwsl*` unit / 05e failed unit | PASS（全 0） | 我未建 unit / 守护 / 包装层 |
| 05f 可见窗口 | WARN（8 个，命令行不含我们的标记 ⇒ 交人判） | 见 §7 归属证据：**无一属于我** |
| 05g 活宿主 19387 | PASS（只报告：pid **33688**，parent 33176） | 未触碰 |
| 06 origin == 本地 HEAD | PASS | —— |
| **07 client chunk rev 门禁** | **PASS** | **本次验收 ④** |
| **08 漏 import 扫描** | **PASS（14 文件 / 命中 = 0）** | 与本次无关，顺带确认你新加的那项是绿的 |

---

## 6. ⑥ 两栏：规格 vs 实现 + 未复核

### 6.1 两栏

| 维度 | **规格**（`docs/panel-visual-spec.md`） | **实现**（`client/index.js`，修复后） | 是否一致 |
|---|---|---|---|
| 菜单外框宽 | §7.2.4「宽 **240px**（固定，不随内容抖动）」 | `box-sizing:border-box; width:240px` ⇒ **外框 240**（实测） | ✅ 一致 |
| 盒模型口径 | §7.2.3 建立的口径：**规格里的像素值指外框**（底栏「高 47」即是） | 同族 8 条规则全部 `border-box`（row / recent-row / menuitem / status / dot / crumb / link / **menu**） | ✅ 一致 |
| 菜单内边距 | §7.2.4 `padding:4px` | `padding:4px` | ✅ |
| 菜单描边 | §7.2.4 `S2` = `border-l2` 1px | `border:1px solid var(--dsw-alias-border-l2)` | ✅ |
| 圆角 | §3.2 浮层 `6px` | `border-radius:6px` | ✅ |
| 阴影 | §2.4 规范值 α=0.08（中性半透明黑） | `box-shadow:0 4px 12px rgba(0,0,0,.08)` | ✅（门禁 shadow 豁免 = 2，另一条是确认层 α=.16） |
| 不遮底栏状态词 | T27 §5 / 本规格 §7.2.4（菜单向上展开） | `bottom:calc(100% + 4px)` ⇒ 实测交集 **0** | ✅ |
| token 闭集 | §1.0 的 17 个 | `C2 token ⊆ allow = PASS`（仍 17 个，本次未新增） | ✅ |

### 6.2 未复核（不许当通过）

| 项 | 拦在哪 |
|---|---|
| **DSH 实例内**的 `menu.getBoundingClientRect().width` | 本轮**未起实例**（纯静态 + 真实 Chromium 的机制 harness）。机制实测与层叠推导**两法一致**，但"实例内 DOM 实测"这一条**没做** ⇒ 若你要那一份，需起 8921–8930 实例 + headless 量取；一行断言：`document.querySelector('.dsh-rw-menu').getBoundingClientRect().width === 240` |
| **M1「可见 `dsh1` 恰 1」** | 仓库里**没有**该检查器（已全仓搜）；本改动只动 CSS 字符串、不可能影响文本计数，但**我不声称数字** |
| 菜单底边间隙 3 vs `calc(100%+4px)` 的 4 | 亚像素取整（footer 高 47px × 非整数缩放）；before/after **相同**，不影响结论；未深究 |
| 菜单在**真实触发按钮**（底栏 `⋯` 被 `flex:none` 固定后）旁的定位 | harness 用等价 DOM 复刻；真实实例内未测 |
| dark 主题 | 与盒模型无关（同一套 CSS）；未测 |
| 截屏 | 本轮**未出截图**（用 rect + computedStyle 读数替代；读数比截图更可判、可复算） |

---

## 7. 纪律与收尾

| 项 | 结果 |
|---|---|
| 实例 / 端口 | **我未起实例**（本任务**一条 `dsh.cmd` / `Start-Process` 都没调用**）。precommit 05a 首次运行时 8911–8990 **0 监听者**；**收尾复检时 8961 已被人占用** —— 归属证据：pid **32048**（`DeepSeek Harness.exe`，start **10:26:08**）← 父 `cmd.exe` **14012** ← 祖父 25612，而 14012 的命令行逐字为 `cmd.exe /c "…\runtime\cli\bin\dsh.cmd" --profile p05 --port 8961 --no-open` ⇒ **是另一位队友的 `p05` 实例，不是我的**（我的写作用域与命令行里都没有 `dsh.cmd`/`--profile`） |
| 可见窗口 | precommit 05f：**8 个，命令行不含我们的标记**（WARN，交人判）。**我的窗口内没有新建任何可见窗口**：本轮我只跑了 `node` 脚本 + `file://` harness（浏览器是 MCP 已存在的 headless 实例，**不产生可见窗口**） |
| WSL 侧 unit / 守护 / 包装层 / profile | **0**（precommit 05b/05c/05d PASS）；`failed user unit = 0`（05e PASS）⇒ **无我创建的 unit，无需 `reset-failed`**（且本轮**未**执行全局 `reset-failed`，以免抹掉他人证据） |
| 用户宿主 19387 | **只读报告**：pid **33688**，parent 33176，`DeepSeek Harness.exe`（宿主已于 10-14 09:21:44 重启，与 lead 告知一致）；**未触碰**；未碰 47604 |
| 用户全局存储 | **未写** `~/.dsh/storages/workspace.json`（本轮未起实例、未用任何 profile ⇒ 无写入路径）；`~/.agents/change-log.md` **未写**（precommit 04 的 CRLF 是既有状态，非本轮产生） |
| `npm/pnpm install` | **0 次**（全部脚本只用 Node 内置模块） |
| 写作用域 | `client/index.js`（1 个文件，4 增 1 删）+ `spike/verify/explorer-20261012/client-panel/**`（本报告与证据） |
| `%TEMP%` | 红测副本目录 `vd-t52-red` **已删**；`vd-*` 残留 = 0 |

### 7.1 浏览器页签收尾

机制实测借用了 MCP 已存在的 **headless Chromium**（`file://` 打开 5 个 harness 页）。收尾已 `close_page` 关闭我打开的那一个页签，`list_pages` 复核 = **只剩 `1: about:blank`（回到原始状态）**；**未启动任何新浏览器进程**。

### 7.2 收尾复检汇总

| 项 | 结果 |
|---|---|
| `%TEMP%\vd-t52-red` | **已删**；`%TEMP%\vd-*` 残留 = **0** |
| 浏览器页签 | **已关**（`list_pages` = 1 个 `about:blank`） |
| 我创建的 unit / 守护 / 包装层 / profile | **0**（precommit 05b–05e 全 PASS）⇒ `reset-failed` 无对象；**未执行全局 `reset-failed`**（避免抹掉他人 failed 态证据） |
| 19387 | pid **33688**（宿主 10-14 09:21:44 重启），**只读报告，未触碰** |
| `client/index.js` | size **28,727** / sha256 **`666F0D57…`**（= ③ 中"字节还原"的基准，三处一致） |

---

## 8. 交付物清单

| 文件 | 内容 |
|---|---|
| `client/index.js`（改动本体） | `.dsh-rw-menu` 加 `box-sizing:border-box`（+ 3 行注释说明）|
| `REPORT-menu-boxsizing.md`（本文件） | ①–⑥ 五道验收 + 两栏 + 未复核 + 纪律 |
| `tools/extract-css.mjs` | 把 `client/index.js` 的 CSS 数组原样抠成 `.css`（95 规则） |
| `tools/build-menu-harness.mjs` | 用真实 CSS 文本 + 最小 DOM 生成「宽度」与「布局」两种 harness |
| `out-01-panel-before.css` / `out-02-panel-after.css` | 改前/改后的面板 CSS（各 95 规则） |
| `harness-menu-{before,after,red}.html` | 外框宽机制实测（250 / 240 / 250） |
| `harness-layout-{before,after}.html` | 布局实测（交集 0、菜单不盖触发按钮） |
| `out-03-precommit.txt` | 13 项 precommit 全量原始输出（07/08 PASS，01/02/04 为既有/在飞问题） |
