# T42 UX 收口二轮 —— 验收报告（接手人 `stability-engineer`）

> 接手说明：前 owner `client-contract` 中途失败（无收尾消息），**其 CSS 三条全部保留、逐条复核**，本报告补齐 JS 侧四条 + 全部读数 + 回归。
> 口径：**before = 已提交基线 `4f4ae1d` 的字节副本**（`%TEMP%\rwsl-base-4f4ae1d`，`git archive` 取出，**未被修改**）；
> **after = 工作树**。两个实例同时起（8921=before / 8922=after），同一份读数脚本 `measure-t42.js`（经 8925 静态服务器），
> 视口统一 `320×900,mobile`（V1 与 N1 的最坏态），真机、页面内 fetch 夹具、**只数不点**（无写存储动作）。

## 1. 六条：before → after 原始读数

| # | 项 | before（`4f4ae1d`） | after（工作树） | 判定 |
|---|---|---|---|---|
| V1 | 命中区 `width<24 \|\| height<24`（11 个可见交互元素） | **3 条违规**：`dsh-rw-chip` **22.69×24**（根目录 chip）、`dsh-rw-crumb` **12.69×20**、`dsh-rw-crumb` **38.44×20**；`minW=12.69` `minH=20` | **0 条违规**；`minW=24` `minH=24` | **✅ 达成** |
| R1 | `footerH`（`.dsh-rw-status`） | **55** | **47** | **✅ 达成**（规格 28+9×2+1） |
| R1 | 状态点两态外径 | running **8×8** / stopped **10×10** ⇒ `equalOuter=false` | running **8×8** / stopped **8×8** ⇒ `equalOuter=true` | **✅ 达成** |
| N1 | 320px 下「添加为 WSL 工作区」可见入口数 | **3**（头部 2 + ⋯ 菜单「工作区」组 1） | **1**（菜单组按互斥条件不再出现） | **✅ 达成** |
| N3 | 列目录失败信息结构 | 主句`列目录失败（/home/g）`+ **raw 内联**（`ENOENT…\\wsl.localhost\…`，未展开即见 3 处） | 主句不变 + `details`（`技术细节（host 原文）`，`open=false`）+ **内联 raw 消失** | **✅ 达成** |
| N4 | 菜单组标注 | 3 组均 `role=group` + `aria-labelledby` + 可见标题（`role=presentation` `tabIndex=-1`） | 同构（该态 2 组）；aria 读数 `dsh-rw-menu-daemon` / `dsh-rw-menu-diagnostics` | **✅ 已统一**（本轮**无需改**，仅取读数） |
| N5 | 加载态底栏分隔符 | 全文 `远端守护状态未知 · · 状态读取中…` ⇒ **2** 个 `·` | `远端守护状态未知 · 状态读取中…` ⇒ **1** 个 | **✅ 达成** |
| R3 | 组标题取色 / 对比度（light） | `rgb(97,102,107)`=label-secondary ⇒ **4.9** | `rgb(15,17,21)`=label-primary ⇒ **15.97** | **✅ 达成**（dark 见 §4 未复核） |

- 运行态底栏（非加载）before/after 均 `远端守护运行中 · 会话 0 个` ⇒ 修 N5 **没有**动到正常态分隔符。
- 复位后（夹具撤除）两实例均为真机 `远端守护未运行 · 会话 0 个 · 启动守护`。

## 2. 改了什么（根因 → 修法）

| 文件 | 改动 | 根因 |
|---|---|---|
| `client/client.panel.tail.js` | 菜单「工作区」组条件 `if (narrow)` → **`if (narrow && primaryIsSession)`** | 头部主按钮在 `!primaryIsSession` 时**本身就是**「添加为 WSL 工作区」（窄态那个次按钮被 `!narrow` 挡住）⇒ 菜单再给一份即**双入口**。互斥条件 = 菜单只在头部**没有**提供该动作时出现 |
| `client/client.panel.browser.js` | 失败块：`<div class="dsh-rw-error-body">errorText(host)` → **`<details class="dsh-rw-note-details"><summary>技术细节</summary><pre>`** | host 原文（`\\wsl.localhost\…`、重复 ENOENT）与主句同块；照 T36 给 stop 失败定的**同一模式/同一 i18n 键**，故**不新增文案键** |
| `client/client.i18n.js` | `status.readingExtra`：`· 状态读取中…` → **`状态读取中…`**（zh/en 各一处） | 该值自带前导 `· `，而底栏 JSX 自己会插 `" · "` ⇒ 加载态**双分隔符**。分隔符只由 JSX 提供一处 |
| `client/index.js` | `.dsh-rw-crumb` 补 `display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;box-sizing:border-box` | **V1 验收口径是"不存在 <24 的交互元素"**，而任务书列的三处（`⋯`/chip/`进入`）不含面包屑；实测面包屑 20px 高 ⇒ 不补就不满足验收。同根因（缺命中盒），故补齐 |
| `client/client.panel.js` | 内部 `throw new Error` 的中文串 → ASCII | **CJK 剥注释=0** 门禁：T41 拆分时我留下的中文异常消息。非用户可见文案，但门禁口径要求 0 ⇒ 清零 |
| `client/index.js`（前 owner 留的，**保留**） | `.dsh-rw-iconbtn` 加 `flex:none`；`.dsh-rw-chip` 加 `min-width:24px`；`.dsh-rw-link` 补命中盒；`.dsh-rw-status` `box-sizing:border-box;height:47px`；`.dsh-rw-dot` 加 `box-sizing`；`.dsh-rw-grouplabel` → `label-primary` | 见其逐条证据注释；本轮**实测复现**了 footer 55、dot 10≠8、chip 22.69 ⇒ 三条 CSS 修法与读数一致 |

**未回退**：前 owner 的 CSS 三条一字未动（`git diff client/index.js` 里仍是其 `T42/V1`、`T42/R1`、`T42/R3` 注释）。

## 3. 故意红（副本制）

| 红 | 载体 | 读数 | 绿 |
|---|---|---|---|
| 红① V1 | `4f4ae1d` 字节副本（8921） | 3 条 <24 违规、`minW=12.69` | 工作树（8922）：0 条、`min=24` |
| 红② 组标题 | 同上 | `label-secondary` **4.9**（dark 3.85 系 T40/T43 读数，见 §4-1） | 工作树：`label-primary` **15.97** |
| 红③（附加）R1/N5/N3 | 同上 | `footerH=55`、`dot 8 vs 10`、分隔符 **2**、raw **内联无折叠** | 工作树：`47`、`8 vs 8`、**1**、**折叠且默认收起** |

> 副本**未被修改**（`git archive` 取出的只读副本），所以"字节还原复绿"等价于"副本保持 4f4ae1d 即红、工作树即绿"；我**没有**在工作树上做破坏-还原，以免留半成品工作树。

## 4. 回归门禁（全部 exit 0）

| 门禁 | 读数 |
|---|---|
| `check-client-rev.mjs` | **exit 0**（PASS，模式=git）。**中途红过一次**：CJK 清零改的是 chunk（`client.panel.js`）⇒ 入口元数据又落后 ⇒ `FAIL… 入口未随之 bump` ⇒ 按 §11 bump 后 PASS |
| `css-token-audit.mjs` | 10 个 client 文件**逐个 exit 0**（非 0 文件数 = 0） |
| `box-sizing-audit.mjs`（T43） | `exit 0`；**真陷阱条数 = 0**（候选表单控件 2，需实测核对）+ 宿主重置形态读数 |
| `arch-t2/tools/check-docs-methods.ts` | `exit 0`；**结果：PASS ｜ 断言 13 条** |
| `arch-t6/tools/panel-smoke-node.mjs`（我自己写的装载+渲染判据） | **16/16 PASS**（证 JS 侧改动没弄坏 chunk 接线） |
| CJK 剥注释（panel chunk） | **合计 0**（修前 `client.panel.js` = 8） |
| `count-i18n-keys.mjs` | `keys 203`×2、`paired: true` |
| `git status -- client` | 仅 5 个文件：`client.i18n.js` / `client.panel.browser.js` / `client.panel.js` / `client.panel.tail.js` / `index.js`（无越界） |

原始输出：`client-panel/out-10-clientrev.txt`、`out-11-csstoken.txt`、`out-12-boxsizing.txt`、`out-13-docsmethods.txt`、`out-14-smoke.txt`、`out-15-i18n.txt`；读数脚本 `client-panel/measure-t42.js`（+ `serve-t42.mjs`，端口 8925，临时、收工即停）。

## 5. 两栏

**【一旦错了就得返工】**
1. **N1 的互斥方向**：条件是 `narrow && primaryIsSession`。若写成 `!primaryIsSession`，就会在"头部主按钮 = 添加为 WSL 工作区"时**再多给一份** —— 正是要修的双入口（T32/RED-1 同型错误：条件写反 ⇒ 同一动作两处同名）。
2. **N5 的分隔符归属**：分隔符只能由**底栏 JSX** 提供（`" · "`）。往 i18n 值里再写 `· ` 会立刻回到双分隔符 ⇒ 改文案时要看 JSX 是否已插分隔符。
3. **V1 验收口径**：是"**所有**可见交互元素 ≥24×24"（WCAG 2.2 SC 2.5.8），不是"改了任务书点名的三处"。新增任何行内按钮/链接都要给命中盒，否则门禁又红（本次面包屑就是这么被抓出来的）。
4. **R1 不许用 `min-height`**：守护起停时 `47↔43` 会抖 4px；必须 `box-sizing:border-box;height:47px`。
5. **改 `client/**` 必须 bump 入口**：本轮实测又踩一次（见 §4 第一行）——改 chunk 后入口元数据落后 ⇒ rev 不变 ⇒ immutable 缓存下用户拿旧 chunk。

**【其余的】**
- `measure-t42.js` 里 `adjacentGap` 我按"同一行、按 x 排序的相邻可见交互元素间隙"算，实测 **2**（面包屑 gap:2px）；任务书写的"现状 18"应是另一口径（列表行内动作间距）⇒ **口径不同，勿直接比**（见 §6-2）。
- 状态点外径用 `getBoundingClientRect` 量；圆点是 `border-radius:50%` 的 span，故"外径"= rect（8×8）。
- `box-sizing-audit` 的 2 条"候选"是表单控件（宿主对 `<button>` 有兜底），非真陷阱。
- 前 owner 的三条 CSS 我**逐条复核**过：`flex:none` / `min-width:24px` / `height:47px`+`box-sizing` / `label-primary` 均在位且带证据注释。

## 6. 未复核：4 条

1. **dark 主题读数**（组标题 `label-secondary` dark **3.85**、以及 dark 下 footerH/dot/命中区）：本轮只在 **light** 实测。R3 的 dark 3.85 是 **T40/T43 的读数**（我未切主题复现）⇒ 我未复核。缺的下一步：`emulate colorScheme=dark` 后重跑 `measure-t42.js`。
2. **相邻净距"现状 18"**：我的脚本算出 2（面包屑 gap 2px），与任务书口径不一致 ⇒ 未复核（需要口径定义：哪一类元素、哪一行）。
3. **N3 折叠内容在"展开"态**：只验证了 `details` 存在、`open=false`、主句是人话、内联 raw 消失；展开后的 `<pre>` 文本未量取（`closed` 时未渲染）。
4. **M1（可见 `dsh1` 恰 1）/ M5（术语 0 命中）/ M14–M17 不回退**：我这轮**没有**跑（未在本仓找到对应检查器，时间预算用尽）⇒ **全部未复核**，不能算通过。我实际跑到的回归见 §4。

## 7. 纪律与收尾

- 端口只用 **8921 / 8922 / 8925**（本任务段 8921–8930）；未 `npm/pnpm install`；实例全 `-WindowStyle Hidden` + 重定向。
- **未碰**用户宿主 `19387`（pid **47564** 全程一致）与可见窗口 `47604`；**未写**用户全局 `~/.dsh/storages/workspace.json`：N1 只**数**可见入口、**未点**「添加为 WSL 工作区」（不需要孤立 `DSH_HOME` 那条链）。
- 收尾：两实例 + 静态服务器已停、两个 profile（`rwsl-t42-before` / `rwsl-t42-after`）已删、`%TEMP%\rwsl-base-4f4ae1d` 副本清理、8921–8930 全 free、`reset-failed` 已跑、窗口枚举给归属证据（见回报正文）。
