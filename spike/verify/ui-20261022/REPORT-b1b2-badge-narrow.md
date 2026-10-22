# B1 代理状态头部徽标 + B2 窄态 320/360 实测修布局（client 侧）

- 日期：2026-10-22
- 仓库：`D:\project\dsh1\dsh-remote-wsl`（基线 HEAD `323a695`，本轮改动**未提交**：只落在工作区）
- 范围：`client/**` + 本目录 `spike/verify/ui-20261022/**`。**没有**碰 `src/**`、`docs/**`、`README.md`（工作区里 `src/**`、`docs/learning-zcode-wsl.md` 等改动是 host 侧另一位负责人的，与本轮无关）
- 结论先行：
  1. **B1 已落地并真机验证**：头部标题区多了一枚三态徽标（可达 / 不可达 / 未探测），文字 + 形状 + 颜色三通道，`aria-label`/`title` 是整句（含 `host:port`，不可达时带可操作提示），三态在真浏览器里各自的 class/文案/颜色都被逐条断言过（214/214 PASS）。
  2. **B2 是"修既有缺陷"，不只是加徽标后的回归**：HEAD 在 320/360 档**本来就横向溢出**——面板 391>264、底栏 391>264（320 档）与 482>360（360 档），「显示隐藏」开关在窄态被推出卡片右边界（right=432.9 vs 面板右 320）并被 `overflow:hidden` 裁掉。修后 320/360 及 376/416/420/480/1280 全部 `scrollWidth === clientWidth`，标题恒 1 行且不被省略，主按钮恒可见（≥24×24 且完整落在面板内）。

---

## 1. 交付物

| 路径 | 变更 |
|---|---|
| `client/client.panel.header.js` | 新增 `proxyBadge`（三态徽标）+ 导出；守护药丸窄态短文案 |
| `client/client.panel.tail.js` | 徽标放进 `.dsh-rw-header-meta`；根节点窄态语义类 `dsh-rw-root--narrow`；底栏 chip 窄态短文案 + `aria-label`；漂移提示窄态只留 ⚠（`title`/`aria-label` 带字） |
| `client/client.i18n.js` | 新增 13 键 × zh/en（逐键配对，占位符一致） |
| `client/index.js` | CSS：徽标三态 / 元信息行折行 / 底栏可折行 / 窄态三处分档 + 文件尾 rev 注释（§11 bump） |
| `spike/verify/ui-20261022/probe-badge.ts` + `out-badge.json` | B1 元素树断言（63/63） |
| `spike/verify/ui-20261022/probe-narrow.ts` + `out-narrow.json` | B2 断点/CSS/元素树断言（32/32） |
| `spike/verify/ui-20261022/probe-render.ts` + `out-render-{before,after}.json` + `ASSERT-render-{before,after}.txt` | 真实例 + headless Chrome 的几何实测（after 214/214 PASS） |
| `spike/verify/ui-20261022/boot.ps1` + `out-*.txt` | 隔离 home/profile（junction 到工作区）+ 实例 8917 + Chrome 9333 的起停脚本与日志 |
| `spike/verify/ui-20261022/shot-after-{320,360}-down.png` | 窄态成品截图（不可达态，最长文案） |
| `spike/verify/ui-20261022/out-gate-*.txt/json` | 四个门禁的原始输出（时间戳型证据） |

---

## 2. B1：代理状态头部徽标

### 2.1 数据面（不改宿主）

`explorer.snapshot()` 的 `proxy` 段早就有：`{ host, port, reachable, cached }`，且只对**运行中**的发行版探测（`src/explorer.ts`）。本轮的判据全部由它推出，**没有**新增 host 方法、没有新增请求、没有轮询：

| `snapshot.proxy` | 徽标态 | class | StatusDot | 可见文字（宽态 / 窄态） |
|---|---|---|---|---|
| 段缺失 | 不渲染 | — | — | —（不把"宿主没给数据"说成"探测过"） |
| `reachable === true` | 可达 | `--up` | `running` | 代理可达 / 可达 |
| `reachable === false` | 不可达 | `--down` | `error` | `不可达 {host}:{port}` / 不可达 |
| `reachable === null`（或段内无该字段） | 未探测 | `--unknown` | `unknown` | 代理未探测 / 未探测 |

`factsVisible === false`（首挂载/读失败）时不渲染 —— 与守护药丸同一条可见性闸门。

### 2.2 三条信息通道（颜色不是唯一载体）

- **文字**：三态各有词，且**永远渲染**（不是 icon-only）；
- **形状**：复用 `StatusDot` 的三个 kind —— 实心（running）/ 实心（error 的红）/ 半透空心（unknown），与底栏用的是同一套 `.dsh-rw-dot--*`；
- **颜色**：`--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary` / `--dsw-alias-label-secondary` + `border-l2`，实测量到 `rgb(34,197,94)` / `rgb(236,19,19)` / `rgb(97,102,107)`，三态互不相同。

### 2.3 可访问性

- `role="img"` + `aria-label` + `title`（同一整句，避免读屏与悬停两套说法）；
- 整句含端点，不可达时含一句可操作提示：
  - `proxy.ariaUp`：「代理可达：{endpoint}（WSL 侧流量可以走它）」
  - `proxy.ariaDown`：「代理不可达：{endpoint} —— 请确认本机代理已启动；若你本来就不使用代理，可忽略此提示」
  - `proxy.ariaUnknown`：「代理未探测：{endpoint} —— 目标发行版未运行或本次探测失败，启动发行版后点刷新即可」
- 窄态只缩短**可见**文字，`aria-label`/`title` 仍是整句（信息不丢）；实测窄态 `aria` 仍含 `192.0.2.7:9910`。

### 2.4 i18n 新键（13 × zh/en，逐键配对、占位符一致）

`proxy.up` / `proxy.upShort` / `proxy.down` / `proxy.downShort` / `proxy.downAt` / `proxy.unknown` / `proxy.unknownShort` /
`proxy.ariaUp` / `proxy.ariaDown` / `proxy.ariaUnknown` / `status.daemonPillShortOn` / `status.daemonPillShortOff` / `targets.chipShort`

> 说明：`proxy.down*` 与 `status.daemonPillShort*`、`targets.chipShort` 属于 B1/B2 同一批文案改动（短文案都由 `narrow` 驱动），放在同一块里一起配对登记。

---

## 3. B2：窄态 320/360 实测与修法

### 3.1 怎么量的（真渲染，不是推算）

- 隔离实例：`%TEMP%\rwui-1022-home` 下的 profile `rwui1022`（只有 `dsh-base` + `dsh-web-app` + 本插件三个 bundle），
  插件是 **junction 到工作区**（所以量的就是工作区当前字节，含未提交改动），实例端口 **8917**（任务指定），
  headless Chrome 调试口 **9333**（刻意避开插件守护号段 8911–8990），**守护全程未启动**。
- 真浏览器 + CDP：`Emulation.setDeviceMetricsOverride` 改视口，`Range.getClientRects()` 数标题行数，
  `scrollWidth/clientWidth` 判横向溢出，`getBoundingClientRect()` 判主按钮/徽标是否完整落在面板内。
- 三态由**页面内 fetch mock**（改写返回 JSON 的 `proxy.reachable/host/port`）驱动，不改插件、不改宿主，可复现。
- 两个口径都量了（任务说"320/360 两档"，而 `NARROW_PX` 比较的是**面板实宽**，面板实宽 = 视口 − 56（rail））：

### 3.2 实测数字（light，900 高，`out-render-before.json` vs `out-render-after.json`）

| 视口 | 面板实宽 | 面板 scrollW/clientW（修前 → 修后） | 底栏（修前 → 修后） | 头部文字列（修前 → 修后） | 标题行数 | 主按钮 |
|---|---|---|---|---|---|---|
| **320** | 264 | **391/264（溢出 127）** → 264/264 | **391/264** → 264/264，h=47 | **115/109（溢出 6）** → 109/109 | 1 → 1（未被省略） | 87×28 @x187，完整在 56–320 内 |
| **360** | 304 | **391/304（溢出 87）** → 304/304 | **391/304** → 304/304，h=47 | 149/149 → 149/149 | 1 → 1 | 87×28 @x227，完整在 56–360 内 |
| 376 | 320 | 391/320 → 320/320 | 391/320 → 320/320，h=47 | 165/165 | 1 → 1 | 87×28 @x243 |
| 416 | 360 | 482/360 → 360/360 | 482/360 → 360/360，h=47 | 205/205 | 1 → 1 | 87×28 @x283 |
| 420 | 364 | 482/364 → 364/364 | 482/364 → 364/364，h=47 | 209/209 | 1 → 1 | 87×28 |
| 480 | 424 | 490/424 → 424/424 | 490/424 → 424/424，**h=77（折成 2 行）** | 224/224 | 1 → 1 | 132.3×28（宽态长文案） |
| 1280 | 1000 | 1000/1000（无变化） | 1000/1000，h=47 | 800/800 | 1 → 1 | 132.3×28 |

补充读数（after）：窄态（面板 264/304）元信息行折成 2 行 ⇒ 头部高 109（宽态 83）；面板 ≥320 时元信息行 1 行；
徽标 55×22（短词）/ 79×22（「代理可达」）/ 145.4×22（「不可达 192.0.2.7:9910」），**三档都恒 1 行**（`Range` 行数 = 1）。

### 3.3 修了哪几处（都由实测定位）

1. **底栏横向溢出（既有缺陷，320/360/364/424 都中）**
   底栏现在要装：`WSL: 发行版` chip（126.7）+ 状态点 + 状态词（91）+ 漂移 ⚠ + 漂移词（65）+「会话 N 个」+ 更新时间（83.3）+ `⋯`（24）+ 8px 间距。
   264 档实测 391px、360 档 482px、424 档 490px ⇒ 被面板裁掉，**状态词与 `⋯` 都看不见**。
   修法：`.dsh-rw-status` 改为 `flex-wrap:wrap; row-gap:6px; min-height:47px; height:auto`（宽态内容本来就一行 ⇒ 几何不变，仍 47）；
   窄态再减字：chip 可见文字 → `WSL`（完整「WSL: 发行版」进 `aria-label`）、漂移提示只留 ⚠（`title`/`aria-label` 带「配置已漂移」）、守护药丸 → 「守护未运行」。
2. **头部元信息行溢出（320 档 115>109）+ 加徽标后必溢出**
   修法：`.dsh-rw-header-meta{flex-wrap:wrap; column-gap:6px; row-gap:4px}` + 守护药丸窄态短文案（115→89）+ 徽标窄态短词（55）。
   结果：264/304 折 2 行（头部 109 高），≥320 单行（83 高）。**标题列宽不受徽标影响**（徽标在元信息行里，不在标题行）。
3. **窄态路径行把「显示隐藏」开关推出卡片（既有缺陷）**
   实测 320 档 `.dsh-rw-toggle` 的右边界 432.9（面板右 320），被 `.dsh-rw-card{overflow:hidden}` 裁掉 ⇒ 开关**不可见不可点**。
   修法：根节点在窄态挂 `.dsh-rw-root--narrow`，CSS 让 `.dsh-rw-formrow` 折行、`.dsh-rw-pathform` / `.dsh-rw-search` 各占一行（`flex:1 1 100%`）。
4. **窄态目标行被多发行版徽标挤爆（既有缺陷）**
   实测 320 档 `.dsh-rw-target` 内 `.dsh-rw-targetacts` 右边界 323.3（面板右 320），body `scrollWidth` 267>264。
   修法：窄态让 `.dsh-rw-target` 允许换行（`flex-wrap:wrap; row-gap:2px`），宽态内容本来就放得下 ⇒ 不换。
5. **为什么不加第二个 JS 断点**：实测 264/304/320/360/364/424 六档在 1~4 修完后全部零溢出、标题 1 行、主按钮可见，
   唯一代价是 264/304 档元信息行多一行、424 档底栏折两行（都是"放不下就换行"，不是裁字/压缩命中盒）。
   ⇒ 按实测结论**没有新增断点**，只把既有 `narrow`（<420）暴露成根节点语义类给 CSS 用；
   `NARROW_PX=420` / `HIDE_UPDATED_PX=360` 两个常量**保持原值**（探针里钉住，防止顺手改坏既有分档语义）。
   `@media` 量不到面板实宽（面板 = 视口 − rail 56），所以窄态分档必须走 JS 算出的语义类 —— 探针里有一条反向断言拦 `@media` 冒充。

### 3.4 截图（真渲染，不可达态）

`shot-after-320-down.png`（视口 320 / 面板 264）、`shot-after-360-down.png`（视口 360 / 面板 304）：
标题 1 行不折、元信息两枚药丸（橙「守护未运行」/ 红「不可达」）各自成行、目标行折行、路径与筛选各占一行、底栏 `WSL · 远端守护未运行 ⚠ ⋯` 一行放得下。

---

## 4. 验证（全部真跑，命令 + 退出码 + 关键输出）

> node：`C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（v24.21.0；PATH 里的 mise shim 不用）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `node spike/verify/ui-20261022/probe-badge.ts` | **0** | `63/63 PASS`（三态 class/文案/dot kind/aria=title/含端点/窄态短词/tail 位置/13 键配对） |
| 2 | `node spike/verify/ui-20261022/probe-narrow.ts` | **0** | `32/32 PASS`（断点常量未变；真 CSS 里 15 条修法逐条在位；chip/漂移/状态词窄宽切换正确；无布局 @media） |
| 3 | `node spike/verify/ui-20261022/probe-render.ts --cdp 9333 --tag after --badge --shot` | **0** | `PASS = 214 FAIL = 0`（7 视口 × 三态 + 截图） |
| 4 | `node spike/verify/explorer-20261012/arch-t6/tools/panel-smoke-node.ts D:/project/dsh1/dsh-remote-wsl` | **0** | `18/18 PASS`（8 个 panel chunk 全 <400 行：header 317 / tail 389 / browser 399 …） |
| 5 | `node spike/verify/ui-20261021/probe-layout.ts` | **0** | `25/25 PASS`（未降级） |
| 6 | `node spike/verify/explorer-20261012/arch-t2/tools/count-i18n-keys.ts D:/project/dsh1/dsh-remote-wsl` | **0** | `keys 259 / 259`、`paired: true`、`onlyZh []`、`onlyEn []` |
| 7 | `node spike/verify/explorer-20261012/tools/check-client-rev.ts` | **0** | `client-rev 门禁：PASS（模式=git）`、`rev=2185c1b014a4`、「chunk 有变化，但入口元数据更新 ⇒ rev 已换」 |
| 8 | `pwsh -File spike/verify/ui-20261022/boot.ps1 -Mode Start` / `-Mode Stop` | 0 / 0 | `ready=True port=8917`、`cdp=9333 up=True`；Stop 后 `端口残留：instance=无；cdp=无` |

`out-gate-*.txt/json` 是第 4–7 条的原始输出存档。

### 复跑步骤（约 3 分钟）

```powershell
cd D:\project\dsh1\dsh-remote-wsl\spike\verify\ui-20261022
pwsh -NoProfile -File .\boot.ps1 -Mode Setup      # 只需一次：建隔离 home/profile + junction
pwsh -NoProfile -File .\boot.ps1 -Mode Start      # 实例 8917 + headless Chrome 9333
node probe-render.ts --cdp 9333 --tag after --badge --shot   # 几何实测（214 断言）
node probe-badge.ts ; node probe-narrow.ts                    # 元素树 + CSS 断言
pwsh -NoProfile -File .\boot.ps1 -Mode Stop       # 收尾：实例与 Chrome 都停，端口归零
```

---

## 5. 没验证 / 遗留 / 取舍（诚实清单）

1. **只量了 light 主题**：几何与主题无关（本轮改动全是 `flex-wrap`/宽度/文案长度），dark 下唯一变量是 token 解析值，
   而 token 名与既有 `StatusDot`/守护药丸完全相同；**未单独拍 dark 截图**（沿用 10-21 那轮 p07 的 dark 结论）。
2. **没在桌面 Electron 壳里点过**：本轮只影响 CSS/文案/渲染分支，桌面壳与 web 走同一份 bundle（传输层差异 10-21 已单独验证），
   但「桌面壳里鼠标拖到 320 宽」这个动作**未人工验收**。
3. **面板宽 424 档底栏折成 2 行（77 行高）**：这是修既有溢出的代价（>420 不再算 narrow，chip/漂移/会话数/更新时间全展开）。
   若产品上不接受"底栏变两行"，可把窄态文案策略上移到 ~560px，但那是新的产品决策，本轮没擅自改。
4. **元信息行在 264/304 档折 2 行**：等于头部 83→109 高（列表少 26px）。同理，若要压回 1 行需砍掉守护药丸或徽标的**文字**，
   与"颜色不是唯一载体"的硬要求冲突，故保留折行。
5. **首启弹窗**：隔离实例没有账号，面板背后会压一层「开始使用」对话框；`probe-render` 已会自动点掉（`aria-label="关闭"`），
   截图里已无遮挡。用户真实 profile 不会出现这个前提。
6. **副作用（请 Lead 处置）**：按任务要求复跑 `probe-layout` 会重写 `spike/verify/ui-20261021/out-layout.json`，
   实测 `git diff` 只有 1 行（`generatedAt` 时间戳），结果仍是 25/25；这不是我改的内容，是本目录外的既有基线文件被探针刷新。
   本轮**没有** `git add` / `git commit`。
7. **未做**：徽标点击打开诊断区（当前是不可交互的 `role="img"` 状态标签；诊断区那一行 `advanced.proxy` 原样保留）。
