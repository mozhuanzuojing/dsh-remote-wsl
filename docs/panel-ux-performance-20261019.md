# UI / UX / 性能轮（2026-10-19）：面板筛选、虚拟化、键盘与两级缓存

> **性质**：在冻结规格（`docs/panel-ux-redesign.md` + `docs/panel-visual-spec.md`）**之内**的增量轮。
> 本文记录**改了什么、为什么、实测多少、哪些没验证**；规格正文未改，新增元素与取值在本文件里逐条给了理由。
> 证据目录：`spike/verify/uiux-20261019/`（夹具在仓外 `D:/project/dsh1/_work/harness/`，可复跑）。

## 0. 结论（先看数字）

同一台机器、同一份夹具、同一脚本、基线 = `d9f487e` 的干净 worktree（`D:/project/dsh1/baseline-repo`）：

| 指标 | 基线 | 本轮 | 变化 |
|---|---:|---:|---|
| 5000 条目录：渲染行数 | **5000** | **22**（视口 + overscan） | ↓ 227× |
| 5000 条目录：DOM 节点 | **30,078** | **243–245**（跨批次 ±2） | ↓ ~124× |
| 5000 条目录：长任务（>50ms） | **99–200ms × 2 个** | **0 个** | 主线程不再卡顿 |
| 5000 条目录：首行出现 | 519–571ms | 244–272ms | ↓ ~2.1× |
| 路径输入每键（5000 条时） | 25–47ms | 2–7ms | ↓ ~7–10× |
| 进入同一目录第二次 | 383–386ms | **3.6–4ms**（缓存命中） | ↓ ~100× |
| 点目录行 | **无反应**（只有 hover 的「进入」小按钮） | 整行进入 | 交互缺陷修复 |
| 键盘 | 焦点停在容器、`aria-activedescendant` 缺失 | 行级真实焦点 + 平台焦点环（`:focus-visible` ✓） | 可访问性补齐 |
| 高延迟下"读失败" | 列表整块撤成错误页（内容丢失） | 保留列表 + **stale 提示 + 重试** | 不再丢上下文 |
| 加载态 | 一行文字 | 3 条骨架行（token 生成，reduced-motion 静止） | 结构稳定 |
| /mnt 盘符 chips | **永不出现**（const 赋值 TypeError） | 正常出现（`/mnt/c … /mnt/e`） | 真缺陷修复 |
| i18n 键 | 207/207 | **218/218**（paired:true） | 新增 11 键（筛选/缓存/行语义） |

宿主数据面（队友 `dataplane-perf`，真实 `wsl.exe`、N=5 中位数；证据 `spike/verify/uiux-20261019/host-perf/`）：

| 场景 | before | after | 说明 |
|---|---:|---:|---|
| `listDir` 热（TTL 内第二次） | 104.3ms | **1.2ms** | 事实缓存命中，0 次 `wsl.exe` |
| 面板首屏 burst（snapshot→listDir 热） | 398.3ms | **238.4ms** | 事实读 2 次 → 1 次 |
| `snapshot` 热 | 306.2ms | **226.7ms** | 仍每次真实扫描守护（非缓存） |
| `snapshot` ×3 并发 | 950.3ms | **326.8ms** | 单飞：3 次执行 → 1 次 |
| 语义回归（错误 code/文案 + HTTP 9 项 + 字段形状） | — | **16/16 逐字 0 差异** | 见 host-perf 报告 `3 |

## 1. 客户端改动（`client/**`）

### 1.1 交互（UX）

1. **整行点击即进入目录**（`client.panel.list.js`）。行内「进入 / 复制路径」按钮 `stopPropagation`，同一动作不会导航两次。文件行点击不导航（避免误触），Enter 复制路径。
2. **筛选框**（`client.panel.browser.js`）：对当前目录做**客户端**子串过滤（大小写不敏感），即时、不重发请求；显示 `共 N 项` / `{shown}/{total} 项`；`/` 聚焦、Esc 清空、`↓` 进列表；换目录自动清空筛选（否则新目录可能被旧筛选显示成"空目录"）。
3. **目录优先排序**：host 只保证 name 升序，设计稿 `7 规定 dir/file 分组由 client 做 —— 本轮到账（目录在前、组内名称升序，二进制比较保证确定性）。
4. **键盘模型**：roving tabindex（只有当前行 `tabIndex=0`）+ 真实 DOM 焦点；`↑/↓/Home/End/PageUp/PageDown`、`Enter` 进入/复制、`Backspace` 上一级、`/` 聚焦筛选、`Esc` 清筛选。焦点环由平台提供（`:focus-visible` ✓，`outline-offset:-2px`，不覆盖 `outline`）。
5. **stale-while-revalidate**：缓存过期先回显旧内容、后台复核；复核失败**保留**列表并显示「显示的是上次缓存；刷新失败…」+ 重试，不再把内容撤成错误页。刷新按钮改为 snapshot/listDir **分开结算**（`Promise.allSettled`）。
6. **加载骨架**：首屏与列目录各给骨架行（`dsh-rw-skeleton-row`，只用 token 明暗呼吸；`prefers-reduced-motion` 下静止）。
7. **自动刷新**：窗口重新可见/获得焦点时，若上次成功 >60s 才刷一次（不轮询；snapshot 有 ~7 次 `wsl.exe`，不做常驻计时器）。
8. **滚动位置记忆**：按目录记录 `scrollTop`，回到上一目录停在原处（与缓存命中配合）。
9. **修复 /mnt 盘符 chips 永不渲染**：原实现把 `exports.mountsCache`（值拷贝，恒 null）解构成 const 后仍赋值 ⇒ `TypeError: Assignment to constant variable`，被 promise 吞成 unhandled rejection，`setMounts` 永不执行。改为 chunk 模块级 `let`（跨挂载仍缓存）。

### 1.2 性能（client）

1. **列表窗口化**（>200 条启用）：只渲染视口 ±4 行，上下用占位 div 撑住滚动高度（`scrollHeight` 与全量一致：170,173 vs 170,139）；`rAF` 合并滚动计算。
2. **目录缓存 + 单飞 + 预取**：模块级 LRU（TTL 30s、上限 80）；同路径并发共享一个请求；悬停/聚焦目录行 140ms 后预取下一层（只写缓存）。
3. **组件拆分**：新增 `client.panel.data.js`（数据层）与 `client.panel.list.js`（列表），保持"每个 chunk <400 行"纪律（`panel-smoke-node` 18/18 PASS）。

## 1.3 独立复核后的修复（F1–F5）

独立成员（spec-scout）用另一套探针做了对抗性复核（报告 `spike/verify/uiux-20261019/verify/REPORT-independent-review.md`），提出 3 条阻断 + 2 条既存规格违例，**本轮全部修掉并复测**：

| 编号 | 问题 | 修法 | 复测 |
|---|---|---|---|
| **F1** | `client.panel.list.js` 注释里的 "React error #310" 被 css-token 的 C1 当成 3 位 hex ⇒ 该文件门禁 exit 1（作者只跑了 index.js 就写 PASS） | 注释去掉 `#`；**11 个 client 文件逐个跑 audit** | 全部 exit 0 |
| **F2** | 刷新与导航的竞态：进目录（缓存）→ 返回 → 刷新 → 立刻点回目录 ⇒ 迟到的刷新结果把列表写回旧目录，**不自愈** | `navSeq` 导航代次：listPath 自增；load 写 browse 前校验代次未变 | 复现脚本：终态 crumb=dir-00000 / pathInput 一致 / 首行正确 |
| **F3** | 同一次切回窗口 visibilitychange + focus 双发 ⇒ snapshot 打两遍（每次 ~7 次 `wsl.exe`） | 节流时间戳放进 ref 并在进入时立刻写入 | 代码路径单发（事件级复测受 headless 限制，见 §5） |
| **F4** | 列表不是滚动体：`.dsh-rw-entries` 缺 `min-height/overflow`，卡片被压到 672px、内容 3398px ⇒ 行画到"最近目录/诊断"上面（**A/B 都坏**，违反 SPEC §7.2.2/R1） | 按规格补 `flex:1;min-height:96px;overflow:auto`；窗口化/滚动记忆/键盘适配"列表自己滚" | card 672 / entries 500 可滚 / entriesBottom 750 < recentTop 767；5000 条滚到底仍见 file-04999 |
| **F5** | ⋯ 菜单打开后焦点仍在触发按钮 ⇒ Esc 关不掉（**A/B 都坏**，违反 SPEC §7.2.4） | 打开即 `requestAnimationFrame` 聚焦首个 menuitem；文档级 Esc 关闭并还焦点 | 打开 activeElement=menuitem；Esc 后 menu=false / expanded=false / 焦点回触发按钮 |

## 2. 宿主改动（`src/explorer.ts`）

1. **发行版事实短 TTL 缓存**（`DISTRO_FACTS_TTL_MS=2000`）：`wsl -l -q` 名字 + `wsl -l -v` STATE 合成一份只读事实，`snapshot` 与 `listDir` 共用；失败/空列表**不缓存**，下次立刻重试。
2. **snapshot 并发单飞**：执行结束即清空 in-flight（是"合并同一次执行"，不是完成后缓存）；顺序调用仍每次真实探测。
3. **语义代价（如实写）**：发行版在 2s 窗口内被 terminate/start，面板最多滞后 2s（`reachable` 仍是"上次探测时 STATE=Running"）。这不是实时性承诺；本轮未在真机 terminate/start（用注入探针构造同一代码路径，见 host-perf `4.2）。

## 3. 规格合规（逐条自查）

- **17 token 闭集**：`css-token-audit` = 107 rules / 17 tokens / **C1 硬编码色 0** / C2 PASS / S1 OK（exit 0）。
- **尺度闭集**：新增只用 2/4/6/8/10/12/14/16/20 间距、3/4/6/999 圆角、11/12/13 字号；行高 32、底栏 47、状态点 8 未动。
- **命中盒**：夹具实测可见交互元素**最小宽高 ≥24**（0 违例）；筛选输入 24 高、清除按钮 24×24、`flex:none`。
- **box-sizing**：`box-sizing-audit` 真陷阱 **0**（新骨架行已显式 `border-box`）。
- **零 emoji / CJK 只在 i18n**：筛选与行语义 11 个键中英配对（218/218）。
- **路径 LTR**：筛选输入与行内路径沿用 `direction:ltr;unicode-bidi:isolate`。
- **状态三重冗余**：状态点/状态词/颜色未改；stale 只加文字提示，不用颜色单独表达。
- **入口 rev**：改 chunk 后已 bump 入口（`check-client-rev` PASS，rev `9608e0cc05bf`）。
- **CSS 门禁按文件跑**：`css-token-audit` 一次只吃一个文件 —— 11 个 client 文件逐个 exit 0（`client/index.js` 107 rules / 17 tokens / C1=0；其余 chunk 无 CSS）。

## 4. 验证证据

| 项 | 命令/路径 | 结果 |
|---|---|---|
| 面板装载/渲染 smoke | `arch-t6/tools/panel-smoke-node.ts <repo>` | **18/18 PASS** |
| 入口 rev | `tools/check-client-rev.ts --root <repo>` | **PASS**（rev `9608e0cc05bf`，11 chunks） |
| CSS tokens | `visual/tools/css-token-audit.ts <file> dsh-rw-`（11 个 client 文件逐个） | 全部 exit 0（C1=0 / C2 PASS / S1 OK） |
| box-sizing | `visual/tools/box-sizing-audit.ts client/index.js dsh-rw-` | PASS（真陷阱 0） |
| i18n | `arch-t2/tools/count-i18n-keys.ts <repo>` | **218/218 paired** |
| 宿主 A/B | `host-perf/compare.ts out-regression-*.json` | **16/16 0 差异** |
| 客户端读数 | 夹具 `probe-v3.ts`（基线与本轮同脚本） | 见 `0 表；原始 JSON 在 `_work/out/probe-v3-*.json` |

## 5. 未验证 / 风险（不许当通过）

1. **未在真实 DSH 宿主里重启验证**：本轮只跑"真实 client chunk + 真 React + mock host"的浏览器夹具与 Node 级宿主回归；插件要在 profile 里生效需**用户重启宿主**（rev 已换，缓存 URL 已失效）。真实 WSL 端到端（UNC/9P、守护）未在本轮重跑。
2. **虚拟化阈值 200**：小目录仍全量渲染（几何与旧实现一致）；超大目录的"滚动条跳变/键盘跨窗口"已用 5000 条夹具测（底部可见 `file-04999`、滚动高度一致），但极端高度（>10 万条）未测。
3. **缓存语义**：client 目录缓存 TTL 30s、host 事实 TTL 2s；窗口内文件变化不会立刻反映（刷新按钮/换目录可绕过）。这是"更快"换来的确定性代价。
4. **夹具非真宿主**：token 取值为规格采样的 9 个 + 其余常用值；暗色下非采样 token（success/warn/error）为近似值，逐像素对比不等同于真机。
5. **长任务/帧率**只在 headless Chrome 上测；带 GPU 的真实窗口、低端机未测。
6. **precommit 环境项**：`git status`（提交前应为空）、`change-log CRLF/NUL`（全局流水文件的历史状态）与"可见窗口归属"（本机其它应用误判）属环境/流程项，与本轮代码无因果；07/08 在 PATH 指向打包 node 时 PASS。

## 6. 文件与入口

- 新增：`client/client.panel.data.js`、`client/client.panel.list.js`、`docs/panel-ux-performance-20261019.md`（本文）。
- 修改：`client/index.js`（CSS + rev）、`client/client.panel.{actions,browser,header,helpers,panel}.js`、`client/client.i18n.js`（+11 键）、`src/explorer.ts`、`README.md`。
- 证据：`spike/verify/uiux-20261019/{host-perf,verify}/`；夹具与原始读数在仓外 `_work/`（不随仓发布）。