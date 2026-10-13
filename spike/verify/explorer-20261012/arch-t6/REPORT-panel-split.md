# T41 架构债 T6 —— `client/client.panel.js` 拆 chunk + 清死键

> **状态：部分完成，已按 lead 指示停下（未标 complete）。** 本轮**交付了「清死键」这一半**并把工作树
> 恢复到**干净可提交**状态；**「拆 chunk」这一半未完成**（尝试两轮后回退，见 §3）。
> 交付形态 = ① 死键清理（已完成、门禁全绿）② 拆分脚本与边界知识（已落盘，供接手人直接续做）
> ③ 不留下任何半成品（生成到一半的 chunk 已删除，`client.panel.js` 与拆分前**逐字节相同**）。

## 1. 已完成（本轮）

### 1.1 清死键（任务第 ③④ 项）

| 项 | 结果 | 证据 |
|---|---|---|
| `tree.*` 死键（13 个家族 ×zh/en） | **全部删除** | `client.i18n.js` 里 `"tree.` 命中 **0**；`client.panel.js` 里 `"tree.` 命中 **0** |
| `status.fixPin*` 死键（4 个家族 ×zh/en） | **全部删除**；host 方法**未动** | `"status.fixPin` 命中 **0**；`src/explorer.ts` 里 `'explorer.fixPin'` 仍有 **2** 处（白名单 + 方法表）⇒ host 方法活着，只是 UI 不露出 |
| 唯一还活着的 `tree.running` 用法 | 改为**活键** `others.stateRunning`（`运行中`/`Running`） | 键覆盖检查：`MISSING: 0` |
| i18n 计数 | **219 → 203**（每语言），逐键配对 | `count-i18n-keys.mjs`：`"keys": 203`（zh/en 各一份）、`paired: true`、`onlyZh: []`、`onlyEn: []` |
| 入口 rev | 已按 `docs/client-contract.md §11` 触碰 `client/index.js` | rev `9715a40b7d3c` → **`65181ea28e1e`**；`check-client-rev.mjs` **exit 0**（"chunk 有变化，但入口元数据更新 ⇒ rev 已换"） |

**故意红（本轮交付范围的判据）**：删掉一个**在用**的键（`others.stateRunning` 的 zh 行）⇒ 键覆盖断言
变红，字节级还原后复绿：
```
备份 hash=70FB55402AF7F9DA0A9BEC3DDFDDD2C1C08D5A60BDFAFED2D17E9DD7C8261D76
红：used: 132 | dict: 202 | MISSING: 1   →  others.stateRunning
还原 hash==备份 ? True
绿：used: 132 | dict: 203 | MISSING: 0
```

### 1.2 四件套 + 附加门禁（全部原始输出见 §1.3）

- `check-client-rev.mjs` **exit 0**（rev `65181ea28e1e`，chunks `client.i18n.js(70fb5540) client.panel.js(70004bdb)`）
- `check-docs-methods.mjs` **PASS ｜ 断言 11 条**（host 6 方法、工具 7 个、README/设计稿/GAP 断言全过）
- `css-token-audit.mjs`：**6 个 client 文件逐个 exit 0**（C1=0 / C2 ⊆ 17 / S1 OK）
- 键覆盖：`MISSING: 0`
- **CJK 约束**：`client.panel.js` 剥注释后中文字面量 **0**
- **无直接 fetch**：`grep 'fetch(|/remote-wsl/api' client/client.panel.js` ⇒ **0**

### 1.3 冒烟（真机 DOM，`remote-wsl-test-p41`，端口 3091，全 hidden，无可见窗口）

```
lang=zh-CN  title=远程资源管理器  subtitle=目标 debian-u8-1 · /home/g  group=浏览目录
footer=远端守护未运行 · 会话 0 个 启动守护 更新于 16:24:58      状态词=远端守护未运行
状态词 scrollWidth===clientWidth = true（M14 形状）
rows=[CodeGeeXProjects bin project tools]  chips=[隐藏文件：不显示 Home / /mnt /mnt/c]
folds=[最近目录, 诊断信息（与 wsl_status 同源）]
⋯ aria-label=更多操作（固定唯一）  aria-expanded=true
菜单（宽 ≥420 时按 §7.3 只有 2 组）: groups=2, 组标题=[守护, 诊断], 组标题 tabindex=-1（不可聚焦）
  items=[重启远端守护…, 停止远端守护…, 查看诊断信息, 复制诊断摘要]  每项高 28（单行）
  启用项 color=rgb(15,17,21)=label-primary；两个破坏性项因 daemonSlot 未知而 disabled ⇒ color=rgb(225,229,238)=label-dimmed（S1 豁免域）
  menuShadow=rgba(0, 0, 0, 0.08) 0px 4px 12px（中性半透明黑，α=0.08 ∈ [0.04,0.28]）
light: bg=rgb(255,255,255) color=rgb(15,17,21)      dark: bg=rgb(35,35,36) color=rgb(249,250,251) statusBg=rgb(27,27,28)
emoji in panel=none      死键泄漏（渲染文本里出现 tree./fixPin）= none
```

## 2. 未完成（明确）—— 拆 chunk 本身

**`wc -l client/client.panel*.js` 各 < 400 这条门禁未达成**：`client.panel.js` 仍是拆分前的
**1293 行单文件**（hash `70004BDB6495FC11…`，与拆分前 `7719876A65A0…` 的差异仅来自 §1.1 的死键改动）。

已落盘、可直接续做的产物：
- 拆分脚本：`spike/verify/explorer-20261012/arch-t6/tools/split-panel.mjs`（**已把边界全部改成动态锚点**，
  不再依赖硬编码行号；生成 6 个文件的框架完整）
- 拆分前原件 + SHA256：`arch-t6/backup/client.panel.js.orig`（`7719876A65A048C6999F5C05F8C49A247DBF75DEE3F85F2351F61E86BA523387`）

**踩到的两个结构事实（续做时必须知道，否则必踩）**：
1. **状态切片必须从 `return function RemoteWslPanel() {` 之**后**开始**：`createPanel` 内部只有两行 +
   组件的开启行，切片若从 `createPanel + 2` 起会把 `return function RemoteWslPanel() {` 这个**未闭合的
   `{`** 带进子文件（脚本已改成 `A.componentOpen + 2`）。
2. **browser 切片必须把 `if (factsVisible && snapshot !== null) {` 那一行**含进去**：否则大括号净差 −1
   （实测 `{}=-1`）。同理 `body` 数组要由入口创建后**经 props 传入**，这样切片里的 `body.push(...)`
   一行都不用改；目录区的**插入位置**用 `browserSlot()` 回调在**原位置**调用即可保持顺序不变。
3. 其余切片实测大括号/圆括号净差 **0**（helpers / header / viewHead / viewTail）。

**为什么停下**：连续两轮生成后仍有 2 个 chunk 语法不通过（browser 的 push 改写括号不平衡、state 的
切片起点错位），每次迭代都要重跑生成 + 全部门禁；为不违反"宁可缩小范围也不留半成品"，我把
**生成到一半的 5 个 chunk 全部删除**并**从备份逐字节还原** `client.panel.js`，然后复跑四件套确认
工作树干净（rev exit 0 / docs-methods PASS / token 门禁 exit 0 / 键覆盖 MISSING=0）。

## 3. 未复核（交给 T31 / 接手人）

1. **`wc -l` <400**：未达成（见 §2）。
2. **`⋯` 菜单三组**：本机面板宽 ≥420 ⇒ 按 §7.3 只渲染 **2 组**；`<420px` 时才会出现第 3 组
   （工作区）——**窄宽度那一路未实测**（未复核）。
3. **两份冻结规格的一处冲突**（不是本轮引入，但会影响判红口径）：`panel-ux-redesign.md §7-M16` 要求
   "菜单内**所有**文本（含组标题）= `label-primary`"，而 `panel-visual-spec.md §7.2.4` 规定组标题是
   `11px ←S`（`label-secondary`）。我按**视觉规格**实现（组标题 `←S`、启用菜单项 `label-primary`），
   请 T31 裁决以哪份为准。
4. **T30 的 M14–M17 完整矩阵**（8 宽度逐宽度读数、三背景 hover 复合值、M15 的"填充置静息"红测）
   不在本轮范围内，仍未落。

## 4. 纪律与收尾

- 端口只用 **8921**（未碰 T40 的 8962）；**未** npm/pnpm install；起实例全程 `-WindowStyle Hidden`
  + 重定向；**未**碰用户宿主 19387/47604；**未**写用户全局存储（本轮没触发 A1）。
- **窗口两个数**：**本轮我方产生的可见窗口 = 0**（宿主进程 `MainWindowTitle` 为空；守护未启动，
  `selftest stop --port 8921` 回 `alreadyStopped`）；**收尾时存在的我方窗口 = 0**。
  现存 2 个 `chrome` 窗口（PID 14136/51164）**不是我起的浏览器**：归属证据 = 父 pid 20772/27840
  （用户名下的 shell 链），我做的只是通过 MCP 在其中开了一个页面；其余窗口均为用户自己的应用
  （Code/Cursor/DSH 宿主/Geph/Edge/输入法/微信）。
- 收尾：3091 实例已停；`systemctl --user reset-failed` 已跑；**units=0 / 8921–8930 守护=0 /
  launcher 残留=0 / meta 残留=0**；`remote-wsl-test-p41` 临时 profile 已删；浏览器页已关。
- 最终锚点（SHA256 前 16 位 / 行数）：
  `client.api.js 5A192B93… 308` · `client.i18n.js 70FB5540… 569` · `client.icon.js E9A824F5… 60` ·
  `client.panel.js 70004BDB… 1293` · `index.js FDB9546E… 393`

**结论**：本轮 = **死键清理（完成、门禁全绿、有红测）+ 拆分脚本与边界知识（落盘、未跑通）**；
**拆 chunk 未完成**，工作树干净、无半成品。建议由接手人基于 `tools/split-panel.mjs` 的
`componentOpen` / browser 含 `if` 行 / `body` 经 props 三条修正续做，或改派熟悉该文件者。
