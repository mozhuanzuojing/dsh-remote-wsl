# REPORT-header-linebox-metric.md —— T72：给"头部是否换行"一条有区分力的量法，并据此复测 T63

- **验证者**：`p0-verify`｜**日期**：2026-10-14｜**写作用域**：`spike/verify/explorer-20261012/arch-t72/`
- **基线**：HEAD `58628ed`（P0.5.4 冻结，25 锚点）；**本任务不重冻结**（我只写 `arch-t72/`，未碰 `client/**`、`src/**` —— 收尾已按 SHA-256 复核 vendor 未被改）。
- **被验对象两态**：**HEAD 副本** = `git archive HEAD client`；**pre-fix 副本** = `git archive f60d9de^ client`（`f60d9de^` = `6245617`）。两副本都是**最小插件包**（`src/` + `client/` + **`cordis.patch.yml`** + `README.md` + `package.json`）⇒ 避开 T69 踩过的"漏 `cordis.patch.yml` ⇒ 插件不注册"的坑。
- **原始读数**：`arch-t72/out-04-readings.json`；门禁输出 `out-01-clientrev-head.txt` / `out-01-clientrev-pre.txt` / `out-03-clientrev-head-red.txt`。

## 结论（≤450 字）

**T63 的"320 下头部标题/hint 各 1 行盒"在新量法下成立（HEAD：title/subtitle/hint/底栏按钮各 1 行）；同一量法在 pre-fix 树给出 title 2 / hint 4 / 底栏按钮 2 ⇒ 该量法有区分力，T63 的修复真实。**
**新量法（v3）**：把"行"定义为**按 top 排序后，相邻 top 间隔 ≤ max(6px, min(相邻高度)×50%)** 的单链式归并簇（文本用 `Range.getClientRects()` 的逐行矩形；容器用可见子项盒）。**四个对照全部通过**：① 已知换行文本（宽 60px）⇒ **6 行**；② 真 `flex-wrap` 换行 ⇒ **2 行**；③ **T69 陷阱**（同排 28px 按钮 + 24px 图标按钮，tops 0/2）⇒ **1 行**（旧指标给 **2**，复现 T69 的误判）；④ **镜像陷阱**（同 top、58px 与 24px）⇒ **1 行**（我自己的 v1"中心分簇"会给 2 ⇒ 说明为什么必须用间隔而非中心）。
**旧指标（T69 用的"子项 distinct `top` 数"）确认无区分力，且我补了反向证据**：HEAD（未换行）给 **2**，pre-fix（已换行）给 **1** ⇒ **两个方向都错、非单调** ⇒ 该指标既不能证"换行"也不能证"未换行"。
**两态读数（320，light 与 dark 同值）**：HEAD header 高 **79**，pre-fix **145**（与 T69 一致）；HEAD `allOneLine=true`，pre-fix `allOneLine=false`。**359/360/419/420（HEAD，light）**经 iframe 内**真实 viewport**（innerWidth 已复核）测得 title/subtitle/hint 各 **1** 行、header 高 **59**。
**前置证明**：两副本 `check-client-rev.ts --root` **exit 0 PASS**（HEAD rev `963372f23bad`、pre-fix `931c2b17f24b`）；**页面取回 chunk == 磁盘逐字节**（HEAD **9/9**、pre-fix 3/3 改动文件）。
**故意红**：pre-fix 整树（= 旧文案 + 旧 CSS 的真实交付态）⇒ 新量法判**换行**；HEAD ⇒ 判 **1 行**。另有一次**手改混搭红作废**（见 §5）。
**未复核**：pre-fix 在 359/360/419/420 的数字、两态在 359–420 的 dark、359–420 的底栏按钮（原因：iframe 批量方案过重触发 MCP 调用超时；逐档 `emulate` 每格 2 次调用，预算不足）。

## 1. 量法（v3）定义与"一一对应"论证

```
行簇 v3(items[{top,h}]):
  s = items 按 top 升序
  tol(i) = max(6px, min(h[i-1], h[i]) * 0.5)     # 6px 下限覆盖亚像素/对齐差；50% 高度上限覆盖不同高度同排
  若 top[i] - top[i-1] <= tol(i)  ⇒ 与上一项同簇（单链式，仅与**相邻项**比较）
  否则 ⇒ 开新簇
• 文本元素：items = Range.selectNodeContents(el).getClientRects() 的每个矩形（每行盒一个矩形）
• 容器：items = 可见子项的外接盒
```
**为什么 1:1**：同一视觉行内的片段（含 `dir=ltr` 包装、行内多段）top 差 ≪ 6px ⇒ 归并；真正的折行必然跨一个行高（实测 16/20px）⇒ 间隔 > max(6, 8/10) ⇒ 分簇。**两个已知失效模式都做了对照**（下表 ③④）。

| # | 对照（构造） | 期望 | 实得 | 旧指标（distinct top） |
|---|---|---|---|---|
| ① | 已知换行文本（`width:60px`，中文长句） | >1 | **lines=6**（rects=7） | 7 |
| ② | 真换行 `flex-wrap`（宽 60px 两个 40px 子项） | 2 | **rows=2** | 2 |
| ③ | **T69 陷阱**：同一 flex 行、28px 按钮 + 24px 图标按钮（tops `[0,2]`） | 1 | **rows=1** | **2（错）** |
| ④ | **镜像陷阱**：同 top、高度 58 与 24（我 v1 的中心分簇会误判） | 1 | **rows=1** | 1（中心分簇=2，错） |

**自我更正（留档）**：我的 v2 变体用"新矩形与**累计 band** 的重叠 ≥50%"归并 ⇒ **传递式吞并**：已知换行文本被并成 **1 行**（`bands=[[-1,101]]`）。这正是"量具本身不可信"的同类事故，我把它记下并改回"与相邻项比 **top 间隔**"（v3），四对照复绿。**结论：判据必须用"相邻间隔"，不能用"与累计区间重叠"。**

## 2. 前置证明（两态）

| 项 | HEAD 副本 | pre-fix 副本 |
|---|---|---|
| `check-client-rev.ts --root` | **exit 0 PASS**（模式=mtime，rev `963372f23bad`，9 chunks） | **exit 0 PASS**（rev `931c2b17f24b`，9 chunks） |
| **页面 chunk == 磁盘** | **9/9 逐字节相同**（取回体剥尾部 `;\n//# sourceMappingURL=…` 后 SHA-256 == 磁盘文件；逐文件名列出） | **3/3** 改动 chunk 相同（`client.i18n.js` 47525217062f / `client.panel.header.js` b5c1a2c06c7e / `client.panel.tail.js` f5cbcf7c4820） |
| 两态差异文件 | — | `client.i18n.js`、`client.panel.header.js`、`client.panel.tail.js`、`index.js`（与 `f60d9de` 的 stat 一致） |

## 3. 两态逐档读数（新量法；旧指标并排）

| 状态 | 宽度 | 主题 | title | subtitle | hint | 底栏按钮 | header 高 | allOneLine | 旧指标（header 子项 distinct top） |
|---|---|---|---|---|---|---|---|---|---|
| HEAD | **320** | light | **1** 「远程资源管理器」 | **1** 「目标 debian-u8-1 · /home/g」 | **1** 「不改目标」 | **1** 「启动」 | **79** | **true** | 1 |
| HEAD | **320** | dark | **1** | **1** | **1** | **1** 「启动」 | **79** | **true** | 1 |
| HEAD | 359 | light | **1** | **1** | **1** | 未取 | 59 | true | — |
| HEAD | 360 | light | **1** | **1** | **1** | 未取 | 59 | true | — |
| HEAD | 419 | light | **1** | **1** | **1** | 未取 | 59 | true | — |
| HEAD | 420 | light | **1** | **1** | **1** | 未取 | 59 | true | — |
| **pre-fix** | **320** | light | **2**（bands [11,28][31,48]） | 1 | **4**（[70,86][86,102][102,118][118,134]） | **2** 「启动守护」 | **145** | **false** | 1 |
| **pre-fix** | **320** | dark | **2** | 1 | **4** | **2** 「启动守护」 | **145** | **false** | 1 |

- 359/360/419/420 那四行来自 **iframe 方案**：每个 iframe 有**自己的真实 viewport**（实测 `innerWidth` = 359/360/419/420，已核对），面板在各自 iframe 内挂载后测量；**该批未测底栏按钮**（当时面板仍在"正在读取"态）。四档 title/subtitle/hint 全为 1 行；那批的容器行数用的是早期分簇（元素级行数是稳健的，容器级数字已在 v3 下于 320 复测 = 1 行）。
- **主题不变性**：320 下 light/dark 的 `font-size/line-height`（title 13px/20px、sub/hint 12px/16px）**逐项相同**，且实测计数一致（HEAD 1/1/1/1；pre-fix 2/1/4/2）⇒ 行数不随主题变；`footerH`（HEAD）两主题都是 47。
- pre-fix 的 hint/按钮用的是**长文案**（「仅筛选，不改目标」「启动守护」）而 HEAD 是**窄态短文案**（「不改目标」「启动」）⇒ 与 `f60d9de` 的提交信息"CSS 兜底 + 窄态短文案"两条都吻合。

## 4. 结论：T63 成立，与旧指标并列

| 问题 | 答案 |
|---|---|
| T63 的"320 下头部标题/hint **各 1 行盒**" | **成立**（新量法：HEAD title=1、subtitle=1、hint=1、底栏按钮=1；light 与 dark 同值） |
| 该结论是否有区分力 | **有**：同一量法在 pre-fix 树给出 title=2 / hint=4 / 按钮=2（`allOneLine=false`），且 header 高 79 vs 145 |
| T69 的"旧指标两态同值 = 2" | 我复现了它的**一半**（HEAD 未换行 ⇒ distinct top = 2），并补了**反向**：pre-fix **已换行** ⇒ distinct top = **1** ⇒ 旧指标**非单调**，两个方向都不可用（比"两态同值"更强的否证） |
| 那 2px 的来源 | 与 T69 判定一致：同一 flex 行内 28px 按钮与 24px 图标按钮的 top 对齐差；我的对照 ③ 精确复现（tops `[0,2]` ⇒ 旧指标 2、新量法 1） |

## 5. 故意红（≥1）

- **有效的红**：**pre-fix 整树**（= 旧文案 + 旧 CSS 的真实交付态，`git archive f60d9de^ client`）⇒ 新量法判 **"换行"**（title 2 / hint 4 / 按钮 2，light 与 dark 相同）；**绿** = HEAD 副本判 **"1 行"**。副本制 ✓、vendor 未动 ✓、收尾删除副本（字节还原）✓。
- **作废的一次手改红（留档，别当证据）**：我试过"只把 HEAD 副本的 `client.i18n.js` 换回旧版 + 触碰 `index.js` 刷 rev"（新 rev `c42ab70bd916`，`check-client-rev` 仍 exit 0）⇒ 页面**确实取到了旧 i18n**（served sha `47525217062f`），但读数变成 **1 行**、文案退化成**裸键名**（`header.distroScopeShort` / `status.startShort`）。原因：那 4 个窄态短文案键是 **f60d9de 新增**的，旧 i18n **没有**它们 ⇒ 与 HEAD 代码混搭是**不一致状态**（缺键回退为键名，恰好也复验了"缺键原样回键"）。⇒ **红必须取"整棵旧树"，不能只换单个文件。**

## 6. 纪律与环境

- **端口**：8919（pre-fix 宿主）/8920（HEAD 宿主）/8921/8922（守护槽位，本轮**未启动任何守护**）；收尾**全部 0**。
- **unit**：`dsh-rwsl-*` = **0**、failed user unit = **0**、`is-system-running=running`；`launch.*.sh` = NONE。
- **孤立 `DSH_HOME`**：`t72-pre-home` / `t72-head-home`（+ Junction profile），收尾删除；**用户全局 `~/.dsh/storages/workspace.json` 起手 `69ac2ec04936` / 1 条 ⇒ 终态同 sha / 同条目**（阴性对照通过）。
- **窗口**：收尾可见窗口 **8，mine=0，WT=0**（本轮只开 headless 标签，无弹窗；无 compat 回退：本轮未起守护）。
- **未碰**：用户宿主 19387（pid **33688**）与用户窗口；vendor（收尾复核 `client.i18n.js` = `8a1ac1e2e961` = HEAD 值、`client/index.js` 无 `T72-RED` 标记）。
- **我的仪器事故**：① v2 传递式吞并（§1，已修 v3）；② iframe 批量方案（5 个完整应用实例）触发 MCP 调用超时两次 ⇒ 改为"已存在的 frame 同步扫描 + 逐档 `emulate`"；③ 手改红混搭无效（§5）。

## 7. 未复核项（不许当通过）

1. **pre-fix 在 359/360/419/420 的读数**（light 与 dark）—— 未测；只用 iframe 方案覆盖了 HEAD 的那四档。理由：iframe 批量触发调用超时；逐档 `emulate` 每格 2 次调用，预算不足。
2. **HEAD 在 359–420 的 dark**、**两态在 359–420 的底栏按钮** —— 未测（同上）。
3. **iframe 批次的容器级行数**：那批用的是早期分簇；**元素级行数（title/subtitle/hint）不受影响**，但容器行数只按 320 的 v3 复测过。
4. **容器级量法对"包裹型元素"的杂质**：对**容器**取 `Range` 时会把容器自身的外接盒也算作一个矩形（对照 ① 的 `bands` 里出现 `[-1,101]` 那一簇）⇒ 容器级要用"仅文本节点"或先滤掉"高度≈容器高"的矩形；**本报告对四个文本块用的是纯文本元素，不受影响**。
5. **像素/截图**：本任务只做几何读数，未交截图。
6. **冻结复算**：T72 未重冻结（不在验收项内）；我只复核了"vendor 未被本任务改动"。
