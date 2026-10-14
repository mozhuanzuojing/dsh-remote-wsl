# REPORT —— T64：窄态文案表 / M11 判据替换 / en 窄态实测

- **日期**：2026-10-14 ｜ **评估者**：`usability-engineer` ｜ **基线**：HEAD `b9e8dfb`、冻结 **P0.5.3**
- **写域内改动**：`docs/panel-visual-spec.md`（**只动 §6.2**，新增 §6.2.1）、`docs/panel-ux-redesign.md`（**只动 M11 行**）
- **证据**：`usability/arch-t64/`（`out-t64-m11-zh.json`、`out-t64-narrow-zh.json`、`out-t64-narrow-en.json`）+ 测量器 `arch-t64/t64-narrow.ts`
- **前置**：改动前已核 `git status -- docs/panel-visual-spec.md docs/panel-ux-redesign.md` = **干净**（无他人未提交改动）

---

## 1. §6.2 窄态文案表（已补，含触发条件与键名对齐）

**触发条件写清了**：窄态由**面板自身宽度**决定，不是视口 —— `client.panel.helpers.js:22` `NARROW_PX = 420`；判定 `const narrow = width < NARROW_PX`（`client.panel.actions.js:194`）。实测佐证：**视口 320/359/420 ⇒ 面板实宽 264/303/364**（全部 < 420）。

新增 §6.2.1 给出「位置 / 键名 / 宽态文案 / 窄态文案 / 代码出处」五行对齐表：

| 位置 | 键名 | 宽态 | 窄态 | 出处 |
|---|---|---|---|---|
| 头部主按钮（添加工作区） | `action.addWorkspace` / `action.addWorkspaceShort` | 添加为 WSL 工作区 | 添加工作区 | `client.panel.header.js:118` |
| 头部主按钮（当前目录开会话） | `browser.openHere` / `browser.openHereShort` | 在此目录新建会话 | 新建会话 | `client.panel.header.js:117` |
| scope hint | `header.distroScope` / `header.distroScopeShort` | 仅筛选，不改目标 | 不改目标 | `client.panel.tail.js:256` |
| 底栏启动按钮 | `status.start` / `status.startShort` | 启动守护 | 启动 | `client.panel.tail.js:281` |
| 底栏会话数 | （非键） | 常显 `status.sessions` | **整块隐藏** `.dsh-rw-extra--hidden` | `client.panel.tail.js:274` |
| 头部入口互斥（N1） | — | 会话按钮 + 添加工作区次按钮 | 主体只留 1 个入口（另一入 `⋯`） | `header.js:58` + `tail.js:162` |

### 1.1 ⚠️ 实测对账发现：**窄态短文案在本 build 未生效**（红/待查，已写进规格同一节）

| 视口 | 面板实宽（<420 ⇒ 应窄态） | 头部主按钮**实测** | 底栏启动按钮**实测** | 会话数块 | N1 行盒 | N1b 省略 | N2 单行 | N4 命中盒 |
|---|---|---|---|---|---|---|---|---|
| 320 | 264 | **添加为 WSL 工作区**（宽态！） | **启动守护**（宽态！） | **未隐藏** | 1/1/1 ✅ | 无 ✅ | ✅ | **25/25** ✅ |
| 359 | 303 | 添加为 WSL 工作区 | 启动守护 | 未隐藏 | 1/1/1 ✅ | 无 ✅ | ✅ | 25/25 ✅ |
| 420 | 364 | 添加为 WSL 工作区 | 启动守护 | 未隐藏 | 1/1/1 ✅ | 无 ✅ | ✅ | 25/25 ✅ |

- **量化结论（"是否需要改文案"）**：**布局层面不需要** —— 三档全部**不换行、不被省略号截断、按钮单行、可见命中盒 25/25 全 ≥24**（`out-t64-narrow-zh.json`）。
- **但对账层面是红**：规格/实现声称的窄态分支（短文案 + 隐藏会话数）**在实测中未出现**，尽管面板实宽 264/303/364 都在窄态区间。**最小复现 = 上表三档**。
- **建议（不擅自改 `client/**`）**：实现侧核对"参与 `narrow` 判定的 `width`"与"面板元素实宽"是否同一量（例如是否取了外层容器/视口宽度而非面板内容宽度）；或核对 `primaryIsSession` 在两档下的取值。修好后本节表格的"实测"列应变成短文案。

---

## 2. M11 判据替换（已写进 `docs/panel-ux-redesign.md` 的 M11 行）

**旧判据（作废）**：`收起时折叠区内可聚焦元素 = 0`。
**新判据**：对折叠的**正文节点**（`details > *:not(summary)`）判 **① 是否存在；② 若存在则 `innerText.trim().length > 0` 且 `checkVisibility()` 为真**；断言**收起 = 不存在/不可见、展开 = 存在且可见**（两态须**相反**）。

### 2.1 实测对照（`out-t64-m11-zh.json`）

| 折叠 | 态 | 旧判据（可聚焦数） | 新判据（正文） | 结论 |
|---|---|---|---|---|
| **失败态「技术细节（host 原文）」**（可展开） | 收起 | **0** | `bodyExists:true`、`innerTextLen:**0**`、`h=234` | — |
| 同上 | 展开（`open=true`） | **0** | `innerTextLen:**162**`、`h=54` | **旧判据 0/0 = 同值 ⇒ 无区分力（反例成立）**；新判据 **0 → 162 = 相反结论 ⇒ 有区分力** ✅ |
| 面板自身折叠 `details.dsh-rw-fold`（最近目录） | 收起 | 0 | `bodyExists:**false**`（正文节点不存在） | 收起侧可判 |
| 同上 | 展开 | — | **不可达**：`details.open=true` 后**面板随即卸载**（`panelGone:true`）；trusted click 亦不展开 | **未复核**（见 §4） |

### 2.2 一条自纠（值得留痕）

我**首版**替换判据用的是"`offsetParent === null` 或零尺寸"，实测**两态都报 `visible`**（收起 `h=234`、`offsetParent≠null`）⇒ **同样无区分力，被我自己的对照否决**，才改用"**渲染文本存在性**（`innerTextLen` / `checkVisibility`）"。⇒ 替换判据也必须**过自己的两态对照**，否则只是换了一个不能红的断言。

---

## 3. en locale 窄态实测 ⇒ **未复核**（如实标注）

| 尝试 | 结果 |
|---|---|
| CDP `Emulation.setLocaleOverride('en-US')` | 面板 `htmlLang` **仍 `zh-CN`**、按钮/状态文案**仍中文** ⇒ **未生效** |
| 叠加 `Object.defineProperty(navigator,'language','en-US')` 注入 | **更糟**：SPA 启动被影响、面板根本不渲染（读数全空）⇒ 已回退该注入 |
| 结论 | 该面板语言**不取自 `navigator.language`**，而由**宿主侧 locale 注入** ⇒ en 窄态行盒（N1/N1b/N2/N4）**未测** |

**拦在哪 / 复现配方（给下一轮）**：起一个 **en locale 的宿主实例**（`DSH_HOME` 隔离 + 在 profile/宿主配置里把 locale 置 en），再用本目录 `t64-narrow.ts --phase narrow --locale en`（脚本已支持，含"回读实际语言"以防假绿）。**没有 en 读数，就不对 en 文案下任何结论**。

---

## 4. 两栏：已验证 / 未复核

**已验证（有原始读数）**：① §6.2.1 表已落盘且与源码键名逐一对应；② 触发条件（面板实宽 < `NARROW_PX=420`）有实测佐证；③ 窄态三档的 **N1 行盒=1 / N1b 未省略 / N2 单行 / N4 25/25 ≥24** 全达标；④ **M11 新判据在两态给出相反结论**（0 → 162），旧判据同值（0/0）作反例；⑤ M1 检查器（T57）在同一基线独立复现（entries=1/exit 0、panel=2/exit 1）。

**未复核（含拦截点）**：
- **en 窄态逐档读数**（§3；须 en locale 宿主实例）；
- **`details.dsh-rw-fold` 的"展开侧"两态对照**（React 受控折叠：置 `open=true` 会卸载面板、trusted click 不展开）；
- **"窄态短文案未生效"的根因**：我只给出最小复现与两个待核方向，**未做代码级归因**（不碰 `client/**`）。

---

## 5. 纪律与收尾

端口仅 **8961/8963/8965**（T64 收窄为 8961–8965，未用 8966–8970）；无 `npm/pnpm install`；无可见窗口（实例 hidden + headless Chrome/CDP）；未碰宿主 `19387`（pid **33688**）；实例一律**孤立 `DSH_HOME`**（`%TEMP%\usab-p05-home`），并做用户 `~/.dsh/storages/workspace.json` 前后 sha 对照（差异出现在 **10-14 09:51**、在我窗口之外，且隔离 home 自带 `storages/workspace.json` ⇒ 归因非本轮）。测量脚本 `t64-narrow.ts` 为**新增 `.ts`**（符合"新增脚本一律 `.ts`"）。
