# REPORT —— T63：修 320px 窄态观感瑕疵（头部折行 + 「启动守护」按钮内折行）

- **日期**：2026-10-14 ｜ **作者**：`visual-designer` ｜ **状态**：修完 + 两主题 × 8 档实测 + 故意红/字节还原 + 回归全过
- **来源**：T54 在真实例上标出的**唯一**候选瑕疵（`usability/p06-final/REPORT-p06-shots.md` §6）
- **改动**：4 个文件，**36 增 7 删**（`client/index.js` CSS · `client.panel.tail.js` · `client.panel.header.js` · `client.i18n.js`）
- **前置**：实例 = `git archive HEAD` 导出的插件副本（`%TEMP%\usab-p07`，逐字节代表 HEAD）+ 孤立 `DSH_HOME`；headless Chrome + CDP（无可见窗口）
- **截图**：`p07-narrow320-{light,dark}.png`、`p07-narrow359-{light,dark}.png`

---

## 0. 结论

| 验收项 | 结果 |
|---|---|
| ① 先给可判判据（可判形式写清） | ✅ §1（N1 / N1b / N2 / N3 / N4 / N5） |
| ② 修法最小（优先窄态短文案，不压命中盒） | ✅ §2（4 文件 36 增 7 删；命中盒 `<24` 计数 **0**） |
| ③ 两主题 × 320/359/360/419/420 实测 | ✅ §3（**before 64 PASS/16 FAIL → after 96 PASS/0 FAIL**） |
| ④ 故意红 + 字节还原复绿 | ✅ §4（**18 FAIL / exit 1** → 还原后 **96 PASS / exit 0**） |
| ⑤ bump 入口 ⇒ `check-client-rev.ts` exit 0 | ✅ §5（rev `0d0f1fb9fe9e`；auto/mtime 两模式 **PASS / exit 0**） |
| ⑥ 回归 | ✅ §6（smoke 16/16 · css-token exit 0 · CJK 0 · box-sizing 真陷阱 0 · 菜单不遮状态词 6/6） |
| ⑦ 两栏 + 未复核 | ✅ §7 |

**一句话**：320 下头部三行文本**各 1 行**、「启动」按钮**文字 1 行**、底栏仍 **47px** 且无横向溢出、**命中盒全 ≥24×24**；宽态（≥420 面板）文案与几何**一字未变**。

---

## 1. ① 判据（"应当怎样"的可判形式）

> 共同前提：**`narrow` 由面板自身宽度决定**（`NARROW_PX = 420`，`width < 420` 为窄态）——320 视口下插件面板实宽 **264px**；视口 480 时面板 424px ⇒ **已是宽态**。所以"窄态"不等于"视口 320"。

| ID | 判据（可判形式） | 依据 |
|---|---|---|
| **N1** | 头部四块文本（`title` / `badge` / `hint` / 按钮）**各 1 个行盒**：`document.createRange()` 选中元素内容后 `getClientRects()` 去重 `top` 数 **= 1** | 窄态不许折行 |
| **N1b** | 同四块**未被省略号截断**：`scrollWidth <= clientWidth + 1` | **这条才让"换短文案"承重**——只加 CSS `nowrap` 也能做到 1 行，但那样是被 `…` 吃掉 |
| **N2** | 底栏「启动守护/启动」按钮**文字 1 行**（同行盒法）+ `scrollHeight <= clientHeight` | T54 实测 49px < 4 个 CJK ≈52px |
| **N3** | 底栏 `scrollWidth === clientWidth`（无横向溢出）+ 外框高 **47** + 状态词 `scrollWidth === clientWidth`（不省略） | §7.2.3 |
| **N4** | V1 命中盒**全部 ≥24×24**（硬底线，不许为"不折行"而压缩） | WCAG 2.2 SC 2.5.8 |
| **N5** | 主按钮**仍带文字**（不许退化成纯图标） | §9.5/Q3 |

**副标题例外（写在判据里，不是漏判）**：`.dsh-rw-subtitle` **按设计**就是 `nowrap + ellipsis`（它带 `title` 全文，T54 实测 1 行）⇒ N1 要求它 1 行，**N1b 不要求它不截断**（目标路径本来就可能很长）。

---

## 2. ② 修法（最小；根因 + 逐文件）

**根因（一个解释全部现象）**：底栏/头部都是 flex 行，而 `.dsh-rw-btn` 默认 `flex-shrink:1` 且没有 `white-space:nowrap` ⇒ 空间不足时**按钮被压到比内容还窄**，CJK 逐字折行（「启动守护」被压到 **48.8px** ⇒ 折 2 行；419/420 时是 **52.5/53px**，仍差 ~21px）。同理 `.dsh-rw-title` / `.dsh-rw-hint` 没有 `nowrap`，在只剩 63.7px 的文字列里逐字折行（标题 2 行、hint 4 行）。而"文字列只剩 63.7px"是因为头部主按钮在窄态**仍用全名**「添加为 WSL 工作区」（132.3px）。

| 文件 | 改动 | 为什么 |
|---|---|---|
| `client/index.js`（CSS 数组） | `.dsh-rw-title` 加 `overflow:hidden;text-overflow:ellipsis;white-space:nowrap`；`.dsh-rw-hint` 加 `min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`；`.dsh-rw-btn` 加 **`flex:none;white-space:nowrap`**；新增 `.dsh-rw-extra--hidden{display:none}` | 让"绝不折行"由 CSS 兜底；`flex:none` 直击根因（按钮不再被压缩） |
| `client/client.panel.tail.js` | ① 底栏启动按钮文案 `narrow ? t("status.startShort") : t("status.start")`；② hint `narrow ? t("header.distroScopeShort") : t("header.distroScope")` + `title` 永远给**完整句**；③ 窄态给会话数加 `dsh-rw-extra--hidden` | 窄态换短文案（让空间真的够，而不是靠省略号）；完整语义留在 `title`/`aria-label` |
| `client/client.panel.header.js` | 主按钮文案 `narrow ? t("action.addWorkspaceShort") : t("action.addWorkspace")`（`primaryIsSession` 分支同理 `browser.openHereShort`） | 把 132.3px 让回给标题/副标题（窄态 87px） |
| `client.i18n.js` | 新增 4 键 × zh/en：`status.startShort`「启动」/ Start · `action.addWorkspaceShort`「添加工作区」/ Add workspace · `browser.openHereShort`「新建会话」/ New session · `header.distroScopeShort`「不改目标」/ No target change | 短文案的**正源**（不拼接、不猜英文） |

**⚠️ 写作用域说明（请 lead 过一眼）**：任务声明的 `writeScopes` 是 `client/index.js` + 两个 panel chunk；我**多改了 `client.i18n.js`**（+9 行）。理由：要求②首选"窄态换更短文案"，而文案的**单一真相源**就在 i18n（zh/en 两套），在 chunk 里现拼字符串会造成"英文硬截断/拼接造假"；且 scope 是 advisory、本轮 `client/**` 只有我一个 owner。若你不同意，回退方式 = 删掉 4 个键 + 把 3 处 `narrow ? t(xxShort) : …` 改回 `t(xx)`（CSS 兜底仍在，只是窄态变省略号）。

**键值对照（320 面板 264px）**：

| 元素 | 窄态（宽 <420） | 宽态（≥420） |
|---|---|---|
| 主按钮 | 「添加工作区」87px（曾 132.3px） | 「添加为 WSL 工作区」132.3px |
| 头部 hint | 「不改目标」48px（`title` = 完整「仅筛选，不改目标」） | 「仅筛选，不改目标」88px |
| 底栏按钮 | 「启动」48px（曾 48.8px 折 2 行） | 「启动守护」74px |
| 底栏会话数 | **隐藏**（`.dsh-rw-extra--hidden`） | 显示（原来在 ≤420 一直被挤成省略号） |

---

## 3. ③ 实测：before / after（两主题各 8 档；`out-p07-before.json` / `out-p07-after.json`）

| 视口 | 面板宽 | **before** title/hint 行 · 按钮行(宽) · 会话数省略 | **after** 同项 |
|---|---|---|---|
| **320** | 264 | **2/4** · **2**(48.8) · True | **1/1** · **1**(48) · False |
| **359** | 303 | 1/**2** · **2**(67.7) · True | **1/1** · **1**(48) · False |
| **360** | 304 | 1/**2** · **2**(68.2) · True | **1/1** · **1**(48) · False |
| **419** | 363 | 1/1 · **2**(52.5) · True | 1/1 · **1**(48) · False |
| **420** | 364 | 1/1 · **2**(53) · True | 1/1 · **1**(48) · False |
| 480 | 424 | 1/1 · 1(74) · False | 1/1 · 1(**74**) · False（宽态不变） |
| 560 | 504 | 1/1 · 1(74) · False | 1/1 · 1(74) · False |
| 1280 | 1000 | 1/1 · 1(74) · False | 1/1 · 1(74) · False |

- **断言：before 64 PASS / 16 FAIL（exit 1）→ after 96 PASS / 0 FAIL（exit 0）**（两主题、8 档、含 N1b ⇒ 16 条/主题的一次遍历）
- 320 关键读数（light）：`title='远程资源管理器'(1 行, 未截断)` · `primary='添加工作区'(87px, 未截断)` · `meta='未物化 不改目标'(1 行, 未截断)` · `start='启动'(48px, 1 行, 未截断)` · `footerH=47` · `footer 264==264` · `wordElided=false` · `<24=0`
- 480 关键读数：`primary='添加为 WSL 工作区'(132.3px)` · `meta='未物化 仅筛选，不改目标'` · `start='启动守护'(74px)` · `textColW=223.7` ⇒ **宽态一字未变**
- 底栏子元素（320）：`dot 8px · 状态词 91px · spacer 37px · 「启动」48px · ⋯ 24px`（会话数已按设计隐藏）⇒ 240/240 刚好不溢出、**无省略**
- 截图：`p07-narrow320-light.png`（同上结构，肉眼确认 3 行头部 + 单行底栏）

---

## 4. ④ 故意红（破坏只在 `%TEMP%` 的 vendor 副本上；工作树一个字节未动）

### 4.1 先说两个**没咬**的红 —— 都是有效诊断，写进报告

| 尝试 | 破坏 | 期望 | 实测 | 为什么没咬（已证） |
|---|---|---|---|---|
| RED-A | 只去掉 `.dsh-rw-btn` 的 `flex:none;white-space:nowrap`（保留新短文案） | N2 红 | **96 PASS** ❌ | 换成「启动」后底栏有 **37px 余量** ⇒ 按钮不被压缩 ⇒ 自然不折行。**CSS 兜底只在空间紧时才承重** |
| RED-B | 只把 3 处文案改回旧文案（不动入口） | N1b 红 | **96 PASS** ❌ | 实测该状态下 320 的 `start` 仍是「**启动**」⇒ 页面读的是**缓存 chunk**。**改 chunk 不动入口 ⇒ rev 不变 ⇒ 浏览器继续用旧字节**——正是 `docs/client-contract.md §11` 与 T63 §5 FAIL 的同一条机制 |

### 4.2 红 v2（咬住了）

破坏 = 把 vendor 恢复成 **T63 之前的完整状态**：旧文案（3 处）+ 去掉 `.dsh-rw-btn` 的 `flex:none/nowrap` + 去掉 `.dsh-rw-title` 的 `nowrap/ellipsis` + 给入口加一个标记使其**内容变更（rev 换掉）**。

| 项 | 结果 |
|---|---|
| 断言 | **78 PASS / 18 FAIL / exit 1** ✅ |
| 失败明细 | `N1` ×2（320 标题 **2 行**，两主题）· `N2` ×10（窄态按钮**文字 2 行**，`lines=2`、`scrollHeight 33 > clientHeight 26`、宽 48.8/67.7/68.2/52.5/53）· `N1b` ×6（提示被 `…` 截断） |
| 字节还原 | 3 个文件 sha256 **逐个一致**（`byte-identical=True`）⇒ **96 PASS / 0 FAIL / exit 0** ✅ |

---

## 5. ⑤ bump 入口 ⇒ `check-client-rev.ts` exit 0

**中途确实被门禁拦了一次，这是真实教训**：我按"CSS→chunk→i18n"的顺序改，结果**最后一次编辑落在 chunk（`client.i18n.js` 12:38）而不是入口（`index.js` 12:32）** ⇒ 门禁判 **FAIL**（git/mtime/auto 三模式都 exit 1，原文："自入口最后一次内容变更（f595e840d6fa）以来有 chunk 变了，但入口未随之 bump：client.i18n.js, client.panel.header.js, client.panel.tail.js"）。**修**：在入口的 bump 记录里补 T63 段（内容变更，13:06:48 ⇒ 晚于所有 chunk）。

```
client-rev 门禁：PASS（模式=git）
  当前 rev : 0d0f1fb9fe9e   [mtime=2026-10-14T05:06:48.497Z ctime=… size=30422]
  依据     : chunk 有变化，但入口元数据更新（05:06:48.497Z > 04:38:34.205Z）⇒ rev 已换 ⇒ 缓存 URL 已失效
auto exit=0        （--mode mtime 亦 PASS / exit 0；原始输出 out-p07-clientrev.txt）
```

---

## 6. ⑥ 回归（最终字节上复跑；`out-p07-gates.txt`）

| 检查 | 命令 | 结果 |
|---|---|---|
| 装载 + 渲染冒烟 | `arch-t6/tools/panel-smoke-node.ts` | ✅ **16/16 PASS**（exit 0）——证明 3 个 chunk 的改动没破坏装配 |
| token 闭集 / 硬编码色 | `visual/tools/css-token-audit.ts` | ✅ `C1=0` / `C1 shadow 豁免=2` / `C2 token ⊆ 17 = PASS` / `S1 OK` ⇒ **exit 0** |
| 盒模型真陷阱 | `visual/tools/box-sizing-audit.ts` | ✅ 真陷阱 **0** / 候选 2 ⇒ **exit 0** |
| CJK 剥注释 | 自算（CSS 数组） | ✅ 数组内含 CJK 24 行**全部是 `//` 注释**；非注释行 **0** |
| 菜单不遮底栏状态词 | `p07-measure.ts --menu`（真实例，320/420/1280 × 两主题） | ✅ **6/6 PASS**：`menuW=240`（外框未变）· `footerH=47` · `menuOverlapsWord=false` · `menuOverlapsFooter=false` · 间隙 3px |
| 命中盒底线 | 每档实测 | ✅ `<24` 计数 **0**（两主题、8 档） |

---

## 7. ⑦ 两栏（规格 vs 实现）+ 未复核

| 维度 | 规格 | 实现（改后） | 一致？ |
|---|---|---|---|
| 折断阈值 | §6.2 `NARROW_PX=420`（**面板宽**） | `narrow = width < 420`（未动） | ✅ |
| 底栏高 | §7.2.3 **47**（外框，不因换行变化） | 47（320→1280 全档） | ✅ |
| 命中区 | §3.4.1 **≥24×24**（WCAG 2.2 SC 2.5.8 底线） | 全档 `<24 = 0`；本次**未**为不折行压任何命中盒 | ✅ |
| 主按钮不图标化 | §9.5/Q3 | 窄态仍带文字（「添加工作区」/「启动」），未退化成纯图标 | ✅ |
| 状态词不被省略 | §4.2-1 | 91/91（全档） | ✅ |
| 头部文本 | §7.2.1（标题 + 副标题 + 元信息 3 行） | 各 1 行；hint 窄态用短句，完整句在 `title` | ✅（**口径微调**：见下） |
| 窄态文案 | 规格**原文未规定**窄态短文案 | 新增 4 个 i18n 短键，阈值 = `narrow` | ⚠️ **规格待补**（建议 §6.2 加一行"窄态文案表"） |

**未复核（不许当通过）**：

| 项 | 拦在哪 |
|---|---|
| 英文 locale 的窄态渲染 | 本轮实测实例是 **zh**（`t()` 取中文）。`en` 的 4 个短键已按同长度量级给（"Start"/"Add workspace"/"New session"/"No target change"），但**未在 en 实例上量过行盒** |
| 真机 DPI / 系统字体缩放（125%/150%） | 实测 `deviceScaleFactor=1`。CJK 逐字折行对字体度量敏感 ⇒ 非 1.0 缩放下余量会变，**未测** |
| 浏览器缩放 / 最小字号设置 | 同上，未测 |
| 320 以下（如 280px） | 未测（规格最小断点是 360；320 是 T54/T63 的下限） |
| 长 `cwd` 路径下的副标题 | 副标题**按设计**截断（N1b 不要求）；本轮快照的 cwd 是常规长度 |
| `--menu` 只跑了 320/420/1280 | 359/360/419/480/560 未跑菜单回归（菜单几何只依赖宽度与 footer 高 ⇒ 风险低，但没测） |
| 菜单在 320 打开的样子 | 历史遗留（T54 §6 也标了）：未拍 320 菜单图 |

---

## 8. 纪律与收尾（原始证据 `out-p07-cleanup.txt`）

| 项 | 结果 |
|---|---|
| 实例 | `-WindowStyle Hidden`，端口 **8966**（指定段 8961–8970；8961/8965 是队友的 `p05` 实例与其 headless Chrome，**未碰**）；`liveHost=33688 (before 33688)` 硬校验通过 |
| 浏览器 | **headless Chrome**（`--headless=new` + CDP **8968** + 独立 `%TEMP%\p07-chrome`）⇒ **0 可见窗口**；收尾按"命令行含 8968"精确杀 |
| 用户宿主 19387 | **未碰**：pid **33688**（start 09:21:44）—— 起实例前后均只读核对 |
| 用户全局存储 | 孤立 `DSH_HOME=%TEMP%\usab-p07-home`；`workspace.json` sha256 前后**一致**（`A764A306…`）。**注**：`~/.dsh/storages` 的**树哈希**在我窗口内有变，但**不是我的实例**写的——改动集中在 `storages/session_projcache/sessions/*.json`（11:31–12:09 多次），并发写入者是**用户宿主 19387** 与**队友 8961 实例**（各自写自己的 session 缓存）；我的实例写的是孤立 home。属 T54 已记录过的同一现象。 |
| `npm/pnpm install` | **0 次** |
| 我创建的 unit / 守护 / 包装层 | **0**（"守护运行中"未使用；未起 WSL 守护）⇒ `reset-failed` 无对象；**未执行全局 `reset-failed`**（避免抹掉他人 failed 态证据） |
| 红测副本 / 临时目录 | `%TEMP%\usab-p07*`、`p07-chrome` 收尾删除；`%TEMP%\<prefix>-*` 残留自查（见收尾输出） |
| 写作用域 | `client/index.js` · `client.panel.tail.js` · `client.panel.header.js` · **`client.i18n.js`（+9 行，已说明）** + `usability/p07-narrow/**`；**未碰** `src/**`、`package.json`、其它 chunk |

### 复跑入口

```powershell
$p='…\usability\p07-narrow'
pwsh -File "$p\p07-boot.ps1" -Mode Vendor      # git archive HEAD → %TEMP%\usab-p07
pwsh -File "$p\p07-boot.ps1" -Mode ShaBefore
pwsh -File "$p\p07-boot.ps1" -Mode Setup; pwsh -File "$p\p07-boot.ps1" -Mode Start
# headless Chrome --remote-debugging-port=8968
node "$p\p07-measure.ts" --url (Get-Content "$p\out-p07-url.txt")[0] --out $p --tag after --cdp 8968   # 96 PASS / exit 0
node "$p\p07-measure.ts" --url … --out $p --tag menu --cdp 8968 --menu                               # 6/6 PASS
node "$p\p07-measure.ts" --url … --out $p --tag shot --cdp 8968 --shot                               # 4 张窄态图
pwsh -File "$p\p07-boot.ps1" -Mode Stop; pwsh -File "$p\p07-boot.ps1" -Mode ShaAfter; pwsh -File "$p\p07-boot.ps1" -Mode ShaDiff
```
