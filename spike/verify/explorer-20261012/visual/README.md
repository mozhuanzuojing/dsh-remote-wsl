# visual/ —— T28 视觉方向的证据目录

**产出**：[`docs/panel-visual-spec.md`](../../../../docs/panel-visual-spec.md)（9 节 + 复算入口）
**角色**：`visual-designer`（task-28）｜**日期**：2026-10-13
**写作用域**：本目录 + 上述文档。**未改** `src/**`、`client/**`、`package.json`、`docs/panel-ux-redesign.md`。

## 0. 这份目录解决什么问题

视觉规格里每一个数字都必须**可复算**。本目录提供 6 个零依赖脚本 + 6 份原始输出，
把"DSH 主题 token 在 light/dark 的真实取值"从"凭印象"变成"从 `app.asar` 里解析出来的事实"。

**为什么不去读 DSH 的源码仓库**：本机安装只有 `resources/app.asar`（Electron 归档），
其中包含**出厂 CSS 与 token 注册表**；`app.asar` 里的 CSS 就是运行时装进页面的那一份，
比源码仓库更接近事实。脚本以字节流方式读它（121 MB，`latin1` 解码，ASCII 安全），**不做任何写入**。

## 1. 脚本（`tools/`，全部只用 Node 内置 `fs`；零安装）

| 脚本 | 作用 | 用法 |
|---|---|---|
| `scan-asar-tokens.mjs` | 列出 `app.asar` 里全部 `--dsw-*` token 名（423 个）及其定义上下文 | `node scan-asar-tokens.mjs <asar> [prefix]` |
| `resolve-theme-tokens.mjs` | 解析 `body{}`（light）与 `body[data-ds-dark-theme]{}`（dark），把 `var()` 链递归解到静态调色板 | `node resolve-theme-tokens.mjs <asar> --dsw-… …` |
| `contrast-check.mjs` | 58 组 WCAG 对比度（含 alpha 合成），逐组打印解析值 + 比值 + PASS/FAIL | `node contrast-check.mjs <asar>` |
| `usage-of-token.mjs` | 某 token 在**出厂 CSS** 里的用法（选择器 + 声明）——用来证明"官方就是这么用的" | `node usage-of-token.mjs <asar> <token> [max]` |
| `token-descriptors.mjs` | token 注册表里的官方 `description` / `requiresLightAndDark` | `node token-descriptors.mjs <asar> [regex]` |
| `css-token-audit.mjs` | **门禁（两条硬约束 + 一条软检查 + Q4 窄豁免）**：抽出 `.<prefix>*{…}` 规则；**C1** 硬编码色（`#hex(3/4/6/8)` / `rgb()/rgba()` / `hsl()` / `color()/lab()/oklch()` / 命名色，已防 `white-space` 误报）；**C2** 引用的 `--dsw-*` 集合 **⊆ 17-token 闭集**（防第 18 个 token）；**S1** `label-dimmed` 只许出现在 `:disabled`/`::placeholder`；**Q4** 只豁免 `box-shadow` 里的中性半透明黑（α ∈ [0.04,0.28]） | `node css-token-audit.mjs <文件> [classPrefix] [--no-allow] [--allow=…]`；**exit 0 = 通过** |
| `overlay-on-surfaces.mjs` | alpha 覆盖层（`interactive-bg-hover/-active`）在**三种背景**上的合成终值 + `hover/静息`、`active/静息`、`active/hover` 可区分性 + 其上文字对比度 | `node overlay-on-surfaces.mjs <asar>` |

`<asar>` = `C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
`node` = `C:\Users\l\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`

## 2. 原始输出（`out-0*.txt`）

| 文件 | 内容 | 被文档哪一节引用 |
|---|---|---|
| `out-01-asar-token-scan.txt` | 423 个 token 名 + 定义上下文（476 KB） | §1.0（"在别处被用了几次"） |
| `out-02-theme-token-values.txt` | light/dark **真值**（本文 §1.1 整张表的来源） | §1.1、§1.3 |
| `out-03-contrast.txt` | 58 组对比度原始读数（两主题 116 行，PASS 70 / FAIL 45 / 1 行 UNRESOLVED） | §8.2、§8.3、§8.4、§5.2 |
| `out-04-token-usage-precedent.txt` | 官方用法先例：`bg-overlay`（popover/overlay 背景）、`interactive-bg-hover`（194 处 hover 背景）、`label-dimmed`（**只**用于 `:disabled`/`::placeholder`）、`bg-layer-3`（input 背景）、`state-warn-label`（官方警告文字色） | §1.0、§1.0.1、§1.6、§8.4-A4 |
| `out-05-css-token-audit.txt` | 门禁实跑：基线（`7cb3362`）与工作区两份均 **C1=0 / C2=PASS / exit 0**；另附 **5 个夹具**（4 负各 exit 1 + 1 正 exit 0）—— 证明门禁真的会判红 | §1.5、§1.6 |
| `out-06-token-descriptors.txt` | 14 条官方 token 描述（`bg-overlay` = "Overlay and popover background." 等） | §1.0、§2.1 |
| `out-07-overlay-on-surfaces.txt` | alpha 覆盖层在三背景上的终值 + 两态可区分性（含"菜单上禁止次级文字"的测值） | §5.1.1 |

## 3. 基线锚点（只对已提交版本）

- **commit `7cb3362`**，`git archive` 导出到 `%TEMP%\vd-baseline-7cb3362`（**已删除**，见 §5）。
  - `client/index.js` = 17,685 B / `0588B3D32DED5FD4B80E3A96970C9740AE18A1607EB9FF3A6F6D29B92353B416`（面板 CSS 在这里）
  - `client/client.panel.js` = 50,840 B / `86F24076D6CD6A0DCDE1017734E8E7B2A811B5246C28DE2093EC3F4E6775907E`
- **没有对工作区截图**：工作区 `client/**`、`src/explorer.ts` 正被其它角色改（`git status` 可核）。
- **没有自己拍截图**：视觉对照直接引用 `usability-engineer` 的 `../usability/ux-baseline/`（11 张，
  同一 commit 的副本，含 `ux-01-overview-light.png` / `ux-07-dark.png` / `ux-09-daemon-running.png`；来源与哈希见 `../usability/out-ux-shots.json`）。

## 4. 自检结论（最重要的三条"反直觉"事实）

1. **light 主题的层级是塌的**：`--dsw-alias-bg-layer-1 = -2 = -3 = #ffffff`（`out-02`）。
   ⇒ 任何"用底色分层"的视觉方案在 light 上收益 = **1.00:1**（= 完全不可见）；这直接解释了
   `ux-01`（light）里目录卡片只是"白底上一条细线"、而 `ux-07`（dark）里同一张卡片有清晰的面。
2. **现有 token 里没有任何一个能把发丝描边做到 3:1**：`border-l1` = 1.09:1、`border-l2` = 1.26:1（light）；
   最重的 `border-l4` 也只有 1.45:1（`out-03` G9/A1/A2）。
   ⇒ 规格改为"识别控件靠 **文字标签 + hover 反馈 + 结构**"，并把这条写成有理由的偏离（§8.4-C3）。
3. **alpha 覆盖层的终值随背景变，且"菜单底"是最差的一种**（`out-07`）：`label-secondary` 在
   `bg-overlay` 上 dark = **3.85:1**、在 active 底上 light = **4.10** / dark = **2.81** ⇒ 菜单项文字
   **必须** `label-primary`（这是"菜单项禁止两级文字"的实测依据，不是审美偏好）。

## 5. 纪律（本轮实际执行）

| 项 | 结果 |
|---|---|
| 测试实例 / 可见窗口 / 守护 / 包装层 / profile | **全部 0 个**（没有 `Start-Process`，没有任何端口监听） |
| 用户宿主 `127.0.0.1:19387` | **未碰** |
| `npm/pnpm install` | **0 次**（脚本只用 `node:fs`） |
| 写入范围 | 本目录 + `docs/panel-visual-spec.md` |
| `%TEMP%\vd-baseline-7cb3362` | **收尾已删除**（`Test-Path` 复核 = `False`） |
| WSL 侧 unit / 守护 / profile | 我创建了 **0 个**（本轮全在 Windows 侧文件与 node 脚本）；宿主 shell 无 `systemctl` ⇒ 未执行 `reset-failed`，且**刻意不执行全局 `reset-failed`**（会抹掉其它在校验角色的 failed 态证据） |
| 可见窗口 | **0 个属于我**（枚举 + 父链 + 启动时间三重交叉，见 `docs/panel-visual-spec.md` §11"窗口归属证据"） |
