# T30 UX 重设计——**收口报告**（接手 client-panel 的半成品）

- **日期**：2026-10-13 ｜ **执行**：client-contract（接手 T30）｜ **写作用域**：`client/**`、`src/explorer.ts`（本次**未改** src）
- **前手**：`client-panel` 连续两次失败、无收尾消息；本报告按 lead 的"宁可缩小范围也不留半成品"要求，**逐条标注 已完成 / 未完成 / 未复核**。

---

## 0. 本轮我实际改了什么（唯一一处代码改动）

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| 1 | `client/index.js` | CSS 数组里 `.dsh-rw-chip--on` 之后**新增一条规则**：`.dsh-rw-chip.dsh-rw-current{border-left-width:2px;border-left-color:var(--dsw-alias-brand-primary);font-weight:600}` | **实测缺陷**：`client.panel.js:699` 给"当前目录"那颗 chip 同时挂 `dsh-rw-chip--on dsh-rw-current`，但 `.dsh-rw-current`（(0,1,0)）被更晚出现的 `.dsh-rw-chip` 的 `border:1px solid …` 简写**覆盖** ⇒ 实测 `border-left=1px / font-weight=400`，只剩 `--on` 填充 —— 正是 M15 定义的"**只靠填充即红**"。用 (0,2,0) 钉死形状通道 |

**未改** `src/`、`package.json`、`client.panel.js`、`client.i18n.js`、`client.api.js`、`client.icon.js`；未改 `docs/`、README、别人的 verify 子目录。证据见 §7 `git status`。

> 说明：`src/explorer.ts` 的 **stop 修复此前已由前手落地**（`ok: r.ok !== false` + `notes: [r.note, r.error]`，`:503-506`），本轮**只做验收**（§5），没有再动它。

---

## 1. 门禁（`css-token-audit.mjs`）——**实跑 exit 0**

命令与完整原始输出：`T30-gate-css-token-audit.txt`

```
node spike/verify/explorer-20261012/visual/tools/css-token-audit.mjs client/index.js
rules = 94    distinct --dsw-* vars = 17
C1 hardcoded colors  = 0   <== PASS
C1 shadow 豁免（中性半透明黑，α∈[0.04,0.28]）= 2   (α=0.080 / α=0.160)
C2 token set ⊆ allow = PASS
S1 label-dimmed 域   = OK
==> EXIT 0（门禁通过）
```

**判定：PASS（实测，exit 0）**；该输出是**在我这次 CSS 改动之后**跑的 ⇒ 新规则未引入第 18 个 token、未引入字面色。

---

## 2. 硬约束：`client.i18n.js` 是唯一文案来源

命令与输出：`T30-cjk-literal-audit.txt`（脚本会先剥离 `//` 与 `/* */` 注释、再剥离 `console.*` 行）。

| 文件 | 用户可见 CJK 字面量 | 判定 |
|---|---|---|
| `client/client.panel.js` | **0** | **PASS** |
| `client/index.js` | **1**（`index.js:39` `PANEL_LABEL_FALLBACK = "远程资源管理器"`） | 见下 |

- 我第一版粗糙扫描报了 5 处，**逐行核对后全是 JSDoc 注释里的引号文字**（`client.panel.js:10/36/79/549`）⇒ 去掉块注释后为 0。这条我明确记为"**第一版量具误报**"。
- `index.js` 的那 1 处是**槽位 label 的兜底常量**（i18n chunk 未就绪时用），不是主来源 ⇒ 我**判为可接受、未改**，但**登记为待裁决项**（若 lead 要求"零字面量"，应改为从 `client.i18n.js` 取 `rail.label`）。

---

## 3. M14–M17 + M1/M2/M3/M5 的实测读数

被测实例：`dsh --profile remote-wsl-test-p30 --port 8922 --no-open`（`daemonPort=8921`，DSH 0.2.0-rc.2）。测量方式：页面内 `getComputedStyle` / DOM 断言（chrome-devtools MCP）。

### 3.1 M14 —— 状态句 8 个宽度都不被省略：**PASS（实测）**

| viewport | status 文本 | `scrollWidth` | `clientWidth` | `textOverflow` | 未被省略 |
|---|---|---|---|---|---|
| 320 | 远端守护未运行 | 91 | 91 | clip | ✅ |
| 359 | 远端守护未运行 | 91 | 91 | clip | ✅ |
| 360 | 远端守护未运行 | 91 | 91 | clip | ✅ |
| 419 | 远端守护未运行 | 91 | 91 | clip | ✅ |
| 420 | 远端守护未运行 | 91 | 91 | clip | ✅ |
| 719 | 远端守护未运行 | 91 | 91 | clip | ✅ |
| 720 | 远端守护未运行 | 91 | 91 | clip | ✅ |
| 1280 | 远端守护未运行 | 91 | 91 | clip | ✅ |

8/8 满足 `scrollWidth === clientWidth && textContent.trim().length > 0`；`.dsh-rw-statusword` 为 `white-space:nowrap; overflow:visible; flex:0 0 auto`（结构性说明：任何宽度下都不会被 ellipsis 吞掉）。

### 3.2 M15 —— 当前项走形状通道：**修完后 PASS（实测）**

| 元素 | `borderLeftWidth` | `fontWeight` | 强制填充置静息色后仍可辨 |
|---|---|---|---|
| `.dsh-rw-crumb--current`（当前路径段 "g"） | 2px | 600 | ✅（形状+字重通道） |
| `.dsh-rw-chip.dsh-rw-current`（当前目录 chip "Home"）**改前** | **1px** | **400** | ❌ **只靠填充**（红的形态） |
| 同上 **改后** | **2px** | **600** | ✅ `distinguishable:true` |

### 3.3 M16 —— `⋯` 菜单单级色 + 恰 3 组 + 组标题不可聚焦：**PASS（实测）**

- 全宽度**只有一个** `aria-label="更多操作"` 的按钮（计数 1）；菜单 `role="menu"` 的 `aria-label` 也是 `更多操作`。
- 菜单内 5 个 `menuitem`：高度全部 **28px**（单行）；颜色集合 = `{rgb(15,17,21) 主色, rgb(225,229,238) 禁用}`；**`label-secondary` 色文本数 = 0** ⇒ 单级 `label-primary`。
- `role="group"` 计数：窄态（panel 有效宽度 <420 ⇒ viewport 320/359/360/419/420）**= 3**，组标题 `["工作区","守护","诊断"]`；宽态（viewport 719/720/1280）**= 2**（`工作区` 组按规格 `<420px` 才出现 ⇒ 符合规格，见 `client.panel.js:37` `NARROW_PX=420`、`:1064`）。
  - 注：断点判据是**面板自身宽度**（`client.panel.js:440` `width < NARROW_PX`），不是 viewport；所以 viewport=420 时面板宽度已 <420。
- 三个组标题均为 `DIV` + `role="presentation"` + `tabindex="-1"`，`tabIndex < 0` ⇒ **不可聚焦** ✅。
- 破坏性动作只在菜单内：`重启远端守护…` / `停止远端守护…` 在菜单里；菜单外的破坏性按钮数 **= 0** ✅。

### 3.4 M17 —— 三背景 hover 可辨：**PASS（实测，light）**

hover 解析值：light `#2631480f` = `rgba(38,49,72,0.06)`；dark `#ffffff14`。

| 规格要求的三背景 | 元素/token | light 终值 | hover 与底色是否不同 |
|---|---|---|---|
| 列表 | `bg-layer-1` | `rgb(255,255,255)` | ✅ |
| 底栏 | `--dsw-specific-sidebar-fill` | `rgb(249,250,251)` | ✅ |
| 菜单 | `--dsw-alias-bg-overlay` | `#e9ecf2` / `rgb(233,236,242)` | ✅ |

dark 侧另测三档：`bg-layer-1=#232324`、`sidebar-fill=#1b1b1c`、`bg-layer-2=#2c2c2e`，hover `#ffffff14` 与三者均不同 ✅。
（即"改回 `bg-layer-2`（light 全白）即红"这一条成立：实现用的是 `interactive-bg-hover`，与三个底色都不同。）

### 3.5 M1 —— 旧树已删：**PASS（实测，含口径说明）**

面板导航到 `/home/g/project/dsh1` 后：

- **可见文本里 `dsh1` 出现 1 次**（就是当前面包屑那一段）；`innerHTML` 里 42 次，全部是 `aria-label`/`title`/`data-path`/`value` 等**属性**（无第二个可见节点）。
- 旧树痕迹（`tree.distroAria` 类按钮、"工作区树"区块）为 0。
- **口径**：M1 的判据写作"面板 DOM 内只出现一次"，按字面量 `innerHTML` 计数会是 42（那不可能通过，因为路径本身就要出现在 aria/title/data-path 里）⇒ 我把判据落成"**可见文本 1 次 + 无旧树节点**"，并把两个数都列出，**口径由 lead/T31 裁决**。

### 3.6 其它顺带实测

| 项 | 读数 | 判定 |
|---|---|---|
| M2 头部主按钮 | header 按钮 = `["在此目录新建会话"]`，**恰 1 个** | PASS |
| M3 底栏一行化 | footer 文本 `远端守护未运行 · 会话 0 个 …`，正则 `^远端守护(未运行\|运行中\|状态未知)` 命中，且**不含** `slot\d`/`pid\d`/`keys`/`\d+\.\d+\.\d+` | PASS（注：footer 的子 DOM 里含 `⋯` 菜单，M5 口径要求"去掉菜单"再判，我按该口径排除后仍 PASS） |
| M5 术语用户化 | 主视线（去掉 `<details>`）术语命中 **[]**；全文本（含折叠区）也 **[]** | PASS |
| M12 最近目录 | `localStorage["dsh-remote-wsl.recent"] = ["/home/g"]`：键名正确、`JSON.parse` 通过、元素为 string、条数 ≤8，值不含 token/pid/slot | PASS（①②；③④见 §6 未完成） |
| 错误态 | 输入不存在路径 ⇒ 可读错误 `列目录失败（/home/g/__t30_nonexistent__）… ENOENT` + **重试按钮**（`重试列目录`） | PASS |
| rail 名 | `sidebar.panellist` 的按钮 `aria-label="远程资源管理器"` | 未回退 ✅ |
| F35 LTR | 面板内 `direction !== ltr` 的路径类元素数 = **0** | 未回退 ✅ |
| aria 覆盖 | 面板内 `button` 总数 22，**`aria-label` 与 `title` 都缺的 = 0** | 未回退 ✅ |
| 主题双份 | light/dark 均实测（见下截图与 §3.4 的 dark 读数） | ✅ |

---

## 4. 截图（9 状态矩阵：**7 张已交，2 状态未完成**）

目录：`T30-shots/`

| 文件 | 状态 | light/dark |
|---|---|---|
| `01-light-ready-1280.png` | 就绪（有目录条目 + 底栏状态） | light |
| `02-dark-ready-1280.png` | 就绪 | dark |
| `03-light-menu-1280.png` | `⋯` 菜单展开 | light |
| `04-dark-menu-1280.png` | `⋯` 菜单展开 | dark |
| `05-light-narrow320.png` | 窄宽（工具栏降级 + 三组菜单） | light |
| `06-dark-narrow320.png` | 窄宽 | dark |
| `07-light-error-badpath.png` | 错误态（可读错误 + 重试） | light |

**未完成（明确剔除）**：① **加载中（transient loading）**——没能抓到稳定帧；② **多实例 / `others[]` 非空横幅**——没有构造"别槽位有守护"的夹具。这两条**不算已完成**，请 T31 按未完成处理（或由后续轮补）。

---

## 5. `src/explorer.ts` stop 修复的验收（原始输出：`T30-stop-evidence/`）

被测：正常树实例 `remote-wsl-test-p30`（端口 8922 / daemonPort 8921）。调用方式：token→cookie 后 `POST /remote-wsl/api`，信封 `{"method":"explorer.daemon","args":{"action":"stop"}}`。

### ① 正常 stop —— **PASS**（`01-normal-stop.txt`）

```json
{"ok":true,"result":{"action":"stop","ok":true,"idempotent":true,"alreadyStopped":false,
 "slot":8921,"port":8921,"pid":1651192,"version":"0.2.0-rc.2","reaped":0,"notes":[]}}
```
收尾复核：`~/.dsh/remote-wsl/` 只剩 `daemon.log` / `launch-stderr.log`（元数据 `daemon.8921.json` + token 已清）；`daemon.ts` 进程 0；`dsh-rwsl*` unit 0；failed unit 0。
⇒ 正常路径字段齐全、`ok:true`、`notes` 为数组，**与修复前语义一致**（修复只影响失败路径）。

### ② 真守护 + `SIGSTOP` ⇒ 必须 `ok:false` + 可读错误 —— **PASS**（`02-sigstop-false.txt`）

- `explorer.daemon{ensure}`（`mode:"systemd"`，**无窗口**）→ pid 1654090
- WSL 侧 `kill -STOP 1654090` ⇒ `/proc/1654090/stat` 状态 `T`（已冻结）
- `explorer.daemon{stop}`（耗时 **7377ms**，有界等待生效，未挂死）：

```json
{"ok":true,"result":{"action":"stop","ok":false,"idempotent":true,"alreadyStopped":false,
 "slot":8921,"port":8921,"pid":1654090,"version":"0.2.0-rc.2","reaped":0,
 "notes":["remote-wsl: stop 未完成：槽位 8921（端口 8921）的本方守护进程仍在（pid 1654090）。
   已按 P1 规矩**保留元数据** daemon.8921.json ⇒ 它仍是**可发现**的 …没有变成\"元数据已删、进程还在\"的隐形孤儿。"]}}
```
- 现场复核：进程仍为 `T`；**元数据 `daemon.8921.json` 被保留** ⇒ 孤儿**可发现** ✅
- 判定：`result.ok === false` 且 `notes` 非空可读 ⇒ **PASS**（外层信封 `ok:true` 表示 RPC 成功，判据取 `result.ok`，与既有方法体例一致）

### ③ 故意红：把 `ok: r.ok !== false` 改回硬编码 `true` —— **RED 成立**（`03-red-hardcoded-true.txt`）

- 副本：`%TEMP%\t30-stop-red\`（由 `src/` + `client/` + `package.json` + `cordis.patch.yml` 组成；**`vendor` 仓只读**），profile `t30-stop-red` 的 `node_modules` 用 **Junction** 指回副本（**没有** Copy-Item 目录），端口 8924，`--dump-config` exit 0 / `Error:` 0。
- 补丁：`src/explorer.ts:506` `ok: r.ok !== false,` → `ok: true,`
- 同一构造（ensure→SIGSTOP→stop）结果：

```json
{"ok":true,"result":{"action":"stop","ok":true, ... "pid":1657776, ...,
 "notes":["remote-wsl: stop 未完成：… 本方守护进程仍在（pid 1657776）…"]}}
```
而现场 `/proc/1657776/stat` 仍是 `T` ⇒ **结果报"成功"但进程还在** = 断言**变红** ✅
- 收尾：`kill -CONT` → 正常 stop → **删副本与临时 profile** → 残留 0（meta 只剩日志 / procs 0 / units 0 / failed 0）。

### ④ 面板渲染失败 + 重试 —— **未完成**

面板对 `result.ok:false` 的渲染（失败 + 重试）**未单独取证**（我只验证了 route 层与"列目录失败"的错误态渲染）。请 T31 按未完成处理。

---

## 6. 未完成 / 未复核清单（**不许当已完成**）

| 项 | 状态 | 说明 |
|---|---|---|
| M4 破坏性动作不在 footer 直接子节点 | **部分**：实测"菜单外的破坏性按钮 = 0"成立；但"是否 footer 的**直接子节点**"未按 M4 的严格口径断言 | 需 T31 按 M4 原判据复核 |
| M6 error 态"事实节点数 = 0" | **未完成** | 只验证了错误态可读 + 有重试，没数事实节点 |
| M7 空态必有下一步控件 | **未完成** | 未单独断言空态分支的按钮数 |
| M8 刷新 → snapshot + listDir 各一次 | **未完成** | 未计数 API 调用 |
| M9 「仅筛选，不改目标」「未物化」常显 | **未完成** | 未做可见文本断言 |
| M10 多实例降级横幅 | **未完成** | 无 `others[]` 非空夹具 |
| M11 诊断折叠区默认收起且不可 Tab | **部分** | 面板内确实有 `<details>` 折叠区（M5 口径依赖它），但未断言"收起时折叠区内 `[tabindex="0"]` = 0" |
| M12 ③ localStorage 抛错降级 / ④ 空列表显示 `recent.empty` | **未完成** | 只做了 ①② |
| M13 键盘导航（↑↓/Enter/Backspace） | **未完成** | 未做键盘脚本断言 |
| N1–N5（§5.5） | **未复核** | 本轮**没有读**该节，故不声称任何结论 |
| 截图"加载中"与"多实例"两态 | **未完成** | 见 §4 |
| `index.js` 的 `PANEL_LABEL_FALLBACK` 中文字面量 | **待裁决** | 见 §2 |
| M1 的计数口径（可见文本 1 次 vs `innerHTML` 42 次） | **待裁决** | 见 §3.5 |
| 面板对 stop 失败的渲染（失败+重试） | **未完成** | 见 §5-④ |

---

## 7. 纪律与收尾证据

- 端口：只用 **8922**（测试实例）/ **8924**（红副本实例）；**8921** 为 profile 钉住的守护槽位。收尾后 8921–8930 只剩 8922（我会在交付前停掉）。
- **可见窗口**：全程 `--no-open`；起守护走 `mode:"systemd"`（WSL `systemctl --user is-system-running` = `running`，失败 unit = 0）⇒ **未走 compat 回退**。收尾枚举可见窗口 6 个，全部 `foreign`（VS Code / Cursor / 用户宿主 47604 / explorer / geph / Edge），**没有一个可归因到本轮动作**（无 `wsl.exe`/WindowsTerminal/我方进程树子节点）⇒ **∆可见窗口 = 0**，**产生过 0 个窗口**。
- 用户宿主：`19387`（pid 47564，父 47604）全程**只读报告、未触碰**。
- WSL 收尾：`dsh-rwsl*` unit 0、`daemon.ts` 进程 0、`failed user unit` 0、`launch.*.sh` 0。
- 临时物：`%TEMP%\t30-stop-red\` 与 profile `t30-stop-red` **已删**。
- `git status` 证明：本轮我只动了 `client/index.js`（+ 新增本目录证据文件）；`client.panel.js` / `client.i18n.js` / `client.api.js` / `src/**` / `package.json` / `docs/**` 无本轮改动（见 `T30-scope-proof.txt`）。
