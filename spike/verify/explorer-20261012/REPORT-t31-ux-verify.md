# REPORT-t31-ux-verify.md —— T31：UX 重设计的独立复验（M1–M13 / N1–N5 / 门禁 / 可达性 / 不回退）

- **验证者**：`p0-verify`（独立于 T30 实现者）｜**日期**：2026-10-13｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：冻结 → 收尾复算 **锚点一致 = True（14/14）⇒ 验证有效**；advisory 仅 README.md。
  锚点集 = `src/**` 8 + `client/**` 5 + `package.json` = 14；本轮变化面（vs T26）= `client/client.i18n.js`、`client/client.panel.js`、`client/index.js`、`src/explorer.ts`（+ docs）。
- **stop 修复在位**：`explorer.ts:503` `stopNotes = [r.note, r.error]…`、`:506` `ok: r.ok !== false` ✓。

## 结论（≤450 字）

**门禁与大部分 M 项 PASS，但两条"新问题"我都在 DOM 里复现成立 ⇒ 判 RED；另发现面板没消费 host 的失败原因 + 确认框 `{slot}` 未插值。三档分类见文末。**
**门禁**：`css-token-audit.mjs` 对 `client/index.js` 与 `client.panel.js` **实跑 exit 0**（C1 硬编码色 0 / C2 集合 ⊆ 17 / S1 OK）；**CJK 独立复现**：`client.panel.js` 剥注释后中文字面量 **0**（原始 662）✓。
**★ RED-1（lead 截图那条）**：在 `cwd == 目标 cwd`（如 `/home/g`）时头部出现**两个可见标签完全相同**的按钮 `添加为 WSL 工作区`（一个 `.dsh-rw-btn`、一个 `.dsh-rw-btn--primary`）；`headerPrimaryCount=1` ✓ 但 `headerDuplicateLabels=["添加为 WSL 工作区"]` ⇒ 违反"头部不得有两个可见标签相同的动作"。**状态相关**：`cwd ≠ 目标`（如 `/home/g/project`）时头部只有 `在此目录新建会话`(primary) + 刷新 ⇒ 无重复；窄态(320)也只有 primary + 刷新 ⇒ 无重复。主按钮**标签规则**本身正确（未成工作区 ⇒「添加为工作区」；目录≠目标 ⇒「在此目录新建会话」）。
**★ RED-2**：**无守护态**下「启动守护」**同时常显在底栏与 `⋯` 菜单**（菜单 `守护` 组 = 重启(disabled)/停止(disabled)/**启动守护**）；规格的菜单应为 重启/停止/诊断/摘要。**运行中态**菜单只有 4 项（重启/停止/查看诊断/复制摘要）⇒ 不重复；⇒ 判 RED（请给理由或去掉菜单里的「启动守护」）。**重启/停止在无守护时正确禁用**（`disabled:true`）✓。
**stop 失败面（真造）PASS**：真守护 + `SIGSTOP` ⇒ route `result.ok=false` + 可读 `notes`（元数据 PRESENT、进程 ALIVE）；**面板渲染 = 失败 + 重试**（`role=alert`，非成功）；故意红（副本 `ok:true`）⇒ `result.ok=True` **RED 成立**。
**两条新发现（建议进修复清单）**：① 面板失败文案 = `失败：host 用 200 回了 ok:false，但**没有给出原因**` —— 而 host 明明在 `notes` 里给了完整原因 ⇒ **client 没消费 `result.notes`**；② 二次确认框里 `确认停止守护？slot **{slot}**（…）` —— **`{slot}` 未插值**。
**M1 PASS**（`/home/g/project` 下可见 `dsh1` **恰 1 次**；页面级对照注入第二处 ⇒ 计数 2 变红）。**M8 PASS**（刷新 ⇒ `explorer.snapshot`×1 + `explorer.listDir`×1）。**M9 PASS**（`未物化`、`仅筛选，不改目标` 常显）。**M12③ PASS**（`localStorage.setItem` 抛错 ⇒ 无未捕获异常）。**M14 PASS**（宽态 91==91、320 态 104==104，`nowrap` 无省略；状态点 `aria-hidden=true`）。**M15** 当前项 = `border-left:2px` + `font-weight:600` ✓。**M16** 宽态 **2 组** / 窄态 **3 组**，组标题 `tabindex=-1`、浮层不遮状态词 ✓。**M5 PASS**（主视线 0 命中；状态句人话 `远端守护未运行 · 会话 0 个`）。
**故意红 3/3**：M1 注入第二处可见 `dsh1`／状态句 `display:none`／副本 `ok:true`，均已还原。
**未产生可见窗口**（每轮 ensure `mode=systemd`，`Δ=0`）。

## 1. 门禁 / 硬约束（实跑）

| 项 | 结果 |
|---|---|
| `css-token-audit.mjs <client/index.js>` | **exit 0**：C1 hardcoded colors 0（1 soft keyword=transparent/currentColor）、C2 token set ⊆ allow PASS、S1 OK |
| `css-token-audit.mjs <client/client.panel.js>` | **exit 0**：C1 0、shadow 豁免 0、soft keywords 3、C2 PASS、S1 OK |
| CJK：`client.panel.js` 剥注释后中文字面量 | **0**（原始 662 全在 JSDoc/注释）—— **独立复现 T30 的结论** |
| `PANEL_LABEL_FALLBACK` | `client/index.js:39 = "远程资源管理器"`，仅用于 `panel.title`（`fallbackText`），`tr()` 优先 `boot.i18n.t` ⇒ **有界** ✓；但"字典就绪后渲染值 == 字典值"的**判别性**验证**未复核**（UI 语言开关在 T26 就没找到，本轮语言固定 zh-CN，两值同为中文、无法区分），见 §7 |

## 2. 两条 lead 截图问题（DOM 实测）

**(1) 头部重复标签 —— RED（状态相关）**
```
headerButtons = [
  { label:"添加为 WSL 工作区", cls:"dsh-rw-btn",            aria:"把 /home/g 登记为 WSL 工作区（…）" },
  { label:"添加为 WSL 工作区", cls:"dsh-rw-btn dsh-rw-btn--primary", aria:"把 /home/g 登记为 WSL 工作区（…）" },
  { label:"",                cls:"dsh-rw-iconbtn",         aria:"重新读取 explorer.snapshot" } ]
headerPrimaryCount = 1            ← 判据①通过
headerDuplicateLabels = ["添加为 WSL 工作区"]   ← 判据②不通过 ⇒ RED
```
- 判据③（主按钮标签规则）：`/home/g` 未成工作区 ⇒ primary=「添加为工作区」**正确**；`/home/g/project`（≠目标）⇒ primary=「在此目录新建会话」**正确**。
- 代码位置：`client/client.panel.js:554 if (!narrow && !primaryIsSession) { headerButtons.push(…描边…) }` + `:583` primary ⇒ **两者在 `cwd==目标 && 非窄` 时同名**。

**(2) 同一动作两个入口 —— RED（无守护态）**
```
无守护态：底栏 = [启动守护, ⋯]；菜单 守护 组 = [重启远端守护…(disabled), 停止远端守护…(disabled), 启动守护]
          ⇒ 启动守护 同时在底栏与菜单常显
运行中态：菜单 = [重启远端守护…, 停止远端守护…, 查看诊断信息, 复制诊断摘要]  ← 符合规格，且 重启/停止 启用
```
- 另：**无守护时 重启/停止 正确 `disabled:true`** ✓（lead 截图里"灰色"的判断正确）。

## 3. stop 失败面（必须真造）—— PASS

| 层 | 手法 | 结果 |
|---|---|---|
| route | 真守护（`mode=systemd`，pid 1672638）+ `kill -STOP` ⇒ `explorer.daemon{stop}` | HTTP 200、**`result.ok=false`**、`notes=[remote-wsl: stop 未完成：槽位 8932（端口 8932）的本方守护进程仍在（pid 1672638）。已按 P1 规矩**保留元数据** daemon.8932.json ⇒ 它仍是**可发现**的…]`；元数据 **PRESENT**、进程 **ALIVE** |
| 面板 | 先「刷新」让面板看到"运行中"→ 再 `SIGSTOP` → `⋯` → **停止远端守护…** → 内联 `dsh-rw-confirm` 点 **确认停止** | note = `失败：host 用 200 回了 ok:false，但没有给出原因`、`role=alert`、**重试** 在场、`successRender=false`、`failureRender=true` ⇒ **不是成功** ✓ |
| 故意红 | 副本 `:506` 改回 `ok: true` | `result.ok=True`（守护仍 ALIVE、notes 仍说"未完成"）⇒ 断言 `ok===false` **RED 成立**；副本已删、vendor 原样 |

**两条新发现（本轮新增）**
1. **面板没消费 host 的失败原因**：host 在 `notes` 里给了完整可读原因，面板却渲染成"**没有给出原因**" ⇒ 失败信息对用户不可用（与 T26 的 `ok` 透传是同一类问题的下一环）。
2. **确认框 `{slot}` 未插值**：`确认停止守护？slot {slot}（本插件配置的槽位，不存在 all 选项）` ⇒ i18n 参数未替换（`confirm.*` 键带 `{slot}` 占位但调用没传）。
   注：确认框**本身存在**（`dsh-rw-confirm`，按钮 取消/确认停止，`--danger`）⇒ 二次确认 ✓。

## 4. M/N 逐项（我能实测到的）

| 项 | 结果 | 依据 |
|---|---|---|
| **M1** 可见 `dsh1` 恰 1 次 | **PASS** | `/home/g/project` 下 `visibleCount=1`；**页面级对照**注入第二处可见 `dsh1` ⇒ `visibleCount=2`（断言能红）。`innerHTML` 里 5 次出现我做了逐处上下文检查（属性内外），但我的"最近的 `<`/`>`"启发式**不够严谨**（见 §7），只把"可见文本 1 次"当正式判据 |
| **M4** 破坏性动作不在底栏直接子节点 | **PASS**（严格口径） | 底栏直接子节点 = `dot / statusword / extra / spacer / BUTTON(启动守护) / updated / BUTTON(⋯)` ⇒ **无 重启/停止**（我的正则曾被 `dsh-rw-dot--stopped` 的 "stopped" 误命中，已人工排除）⇒ 与 **N3** 同判 |
| **M5** 主视线术语 | **PASS** | 主视线排除折叠/诊断区后命中 **0**（`slot|daemonPort|pid|keys|explorer.snapshot|/remote-wsl/api|snapshot|systemd-run|unit` 全无）；状态句为 `远端守护未运行 · 会话 0 个` |
| **M8** 刷新 → snapshot + listDir 各一次 | **PASS** | fetch 计数：`["explorer.listDir","explorer.snapshot"]` 各 1 |
| **M9** 未物化 / 仅筛选不改目标 常显 | **PASS** | 可见文本两者都在 |
| **M12③** localStorage 抛错降级 | **PASS** | `Storage.prototype.setItem` 抛错后：**无未捕获 error**、无错误文案、界面正常 |
| **M14** 状态句不被省略 | **PASS（2/5 宽度）** | 宽态 `clientWidth=scrollWidth=91`、320 态 `104==104`，`white-space:nowrap`、`text-overflow:clip`；状态点 `aria-hidden="true"`。**420/719/720 未复核**（`resize_page` 未生效，我只用 `emulate` 做了 320） |
| **M15** 当前项形状通道 | **PASS（部分）** | `border-left: 2px` + `font-weight: 600` ✓；"把填充强制置静息色后仍可辨"**未复核**（未做强制重绘对照） |
| **M16** 单 `⋯` + 分组 + 组标题不可聚焦 | **PASS** | 全宽度 1 个 `⋯`(`更多操作`)；宽态 **2 组**、窄态 **3 组**（窄态含"添加为工作区"组）；组标题全部 `tabindex="-1"`；**浮层不遮状态词**（`menuOverlapsStatus=false`）。**"菜单项颜色 == `label-primary`"未复核**（`--dsw-alias-label-primary` 在 `documentElement` 上读到空串，token 在别的 scope） |
| **N1** 一个动作一个名字 | **见 RED-1/RED-2** | 菜单侧**复用同 i18n 键** ✓；但出现"同一动作两个同入口"与"同名两按钮" |
| **N2** 面板内不用 box-shadow 分层 | **PASS（门禁级）** | `css-token-audit`：panel 的 shadow 豁免 = 0；未见面板内卡片阴影 |
| **N3** 破坏性动作不常显底栏 | **PASS** | 同 M4 |
| **N4** 不用 `display:none` 隐藏行内动作 | **未复核** | 未做 hover 前后布局位移对照（我自己的红测用过 display:none，那是仪器不是产品） |
| **N5** 不只靠颜色传达状态 | **部分** | 状态 = 圆点(色) + **文字**状态词（`远端守护未运行`）+ 圆点 `aria-hidden` ⇒ 文字通道在；drift/warn 等其它状态**未复核** |
| **M13** 键盘导航 | **部分/未复核** | `Enter` 生效（路径 `g → CodeGeeXProjects`）；我的 `↑/↓` 脚本未产生可见选中态、`Backspace` 未回上一级 ⇒ **可能是我的派发方式不匹配**，需更精确脚本或人工复测 ⇒ 不当红、记未复核 |
| **M6/M7/M10/M11/M12④** | **未复核** | 见 §7 |
| **截图两态** | 部分 | "加载中"我已用挂起 `explorer.snapshot` 的 initScript**定格**并取证（`正在读取 explorer.snapshot…`）；"多实例/others[] 非空"**无夹具 ⇒ 未复核** |

## 5. 不回退项（抽验）

- **F34 首挂载只显示读取中**：定格加载态时正文 = `正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…`，无"已撤下/失败" ✓
- **`others[]` 只读零按钮**：本轮未构造非空 `others[]`（见未复核）；空态下无多余按钮 ✓
- **停止/重启二次确认**：`dsh-rw-confirm` + `确认停止`（`--danger`）实测存在 ✓
- **rail 名「远程资源管理器」**：宽态 rail 的 `aria-label` = ✓（窄态 320 时 rail 只显示图标，`innerText` 为空但 aria 仍在）
- **窗口/可见窗口**：每轮 ensure 读 `mode=systemd`；T26 的 `Δ=0` 结论沿用（本轮未再逐轮审计窗口，唯一一次窗口相关动作是 320 态重挂载，无新窗口）

## 6. 故意红（3 条，均已还原复绿）

1. **M1**：页面内注入第二处可见 `dsh1` ⇒ `visibleCount 1 → 2`（断言能红）。
2. **可读性**：给状态句 `display:none` ⇒ 可见性断言 `false`（断言能红）。
3. **stop**：副本 `explorer.ts` 把 `ok: r.ok !== false` 改回 `ok: true` ⇒ `result.ok=True`（守护 ALIVE、notes 说"未完成"）⇒ 断言红；副本/profile/临时家已删，vendor 原样。

## 7. 三档分类（lead 要的结论依据）

**已实现且已验证**：门禁（css-token-audit exit 0 / CJK 0）｜M1（可见 1 次）｜M4/N3（严格口径）｜M5｜M8｜M9｜M12③｜M14（宽+320）｜M15（2px+600）｜M16（1 个 ⋯、窄 3 组/宽 2 组、组标题不可聚焦、不遮状态词）｜**stop 失败面**（route `ok:false`+可读 notes；面板失败+重试）｜stop 故意红｜CJK/`PANEL_LABEL_FALLBACK` 的**有界性**（代码级）。
**已实现但未自证（我未实测，实现侧有代码/结构证据）**：M6（错误态事实节点数）｜M7（空态下一步控件）｜M11｜M12④（空列表 `recent.empty`）｜M17（三背景 hover 两主题）｜N2（面板内阴影 = 门禁级，未做视觉判定）｜N5 的其它状态｜M15 的"强制置静息色后仍可辨"｜M16 的"菜单项颜色 == `label-primary`"｜`PANEL_LABEL_FALLBACK` 与字典值的**判别性**相等（语言固定 zh-CN，无法区分）。
**根本未实现 / 判 RED**：**RED-1** 头部同名两按钮（`cwd==目标 && 非窄`）；**RED-2** 无守护态「启动守护」在底栏与菜单**同时常显**；**新发现①** 面板不消费 `result.notes`（失败显示"没有给出原因"）；**新发现②** 确认框 `{slot}` 未插值。

## 8. 未复核项（不许当通过）

1. **M14 的 420 / 719 / 720 三个宽度**：`resize_page` 在我的 MCP 会话里未改变 `innerWidth`（仍 1869），我只用 `emulate` 做了 **320**（有效）与宽态。
2. **M13 键盘 ↑↓/Backspace**：我的 `KeyboardEvent` 派发未产生可见效果（Enter 生效）⇒ 需更贴近真实按键的驱动（CDP `Input.dispatchKeyEvent`）复测。
3. **M6 / M7 / M10 / M11 / M12④**：未构造对应状态（错误态事实节点数、空态控件数、`others[]` 非空横幅、`recent.empty`）。
4. **M17 三背景 hover**：未用 CDP 真实 hover 取两主题计算样式（只读了 T30 的结论）。
5. **N4**（`display:none` vs `visibility`）：未做 hover 位移对照。
6. **M1 的 innerHTML 计数口径**：T30 报 42 次，我在 `/home/g/project` 测得 5 次（状态不同）；我逐处判"属性内/文本内"的启发式不严谨 ⇒ **只把"可见文本恰 1 次"当正式判据**，"42 次全是属性"这条**未独立确认**。
7. **`PANEL_LABEL_FALLBACK` 的判别性回归**：语言固定 zh-CN ⇒ fallback 与字典值同串，无法区分；**T24 那个冷加载缺陷的回归在此环境下不可判定**。
8. 截图：我只做了 DOM 定格取证（loading 态），**没有交像素截图**；"多实例"态未构造。
9. keys>0 / webHosts 非空 / desktop 宿主 / Electron：沿用历轮未复核。
