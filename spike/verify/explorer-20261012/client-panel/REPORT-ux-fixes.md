# T32 UX 收口报告（RED-1 / RED-2 / notes 未消费 / `{slot}` 未插值 + 补测）

- **日期**：2026-10-13 ｜ **执行**：client-contract ｜ **写作用域**：`client/**`（`src/` 一行未动）
- 被测实例：`dsh --profile remote-wsl-test-p30 --port 8922 --no-open`（`daemonPort=8921`，DSH 0.2.0-rc.2）；红副本实例 `--profile t32-red --port 8926`（`%TEMP%\t32-red`，Junction 指回副本，测完已删）。

---

## 1. 四条缺陷：改前 → 改后

### 1.1 RED-1 头部同名两按钮 —— **已修，实测绿**

**根因**：`client/client.panel.js:554` 的条件写反 —— `if (!narrow && !primaryIsSession)`。
`primaryIsSession = cwdDiffersFromTarget`；当 `cwd == 目标 cwd`（`/home/g`）时 `primaryIsSession === false`
⇒ 该分支**仍会**再 push 一个次按钮，而**主按钮本身**的标签也是「添加为工作区」（`:606`）⇒ 头部出现两个同名按钮。

**改前**（红副本实测，原始读数）：

```
cwd = "/home/g"
headerButtons = [ 添加为 WSL 工作区 (secondary), 添加为 WSL 工作区 (primary), refresh ]
headerDuplicateLabels = ["添加为 WSL 工作区"]        ← 断言非空 ⇒ 红
```

**改法**：`!primaryIsSession` → `primaryIsSession`（只有主按钮是「在此目录新建会话」时，才额外给一个「添加为工作区」）。

**改后**（正常树实测）：

```
cwd = "/home/g"
headerButtons = [ 添加为 WSL 工作区 (primary), refresh ]
headerDuplicateLabels = []        headerPrimaryCount = 1
```

**故意红**：副本把条件改回 `!primaryIsSession` ⇒ `headerDuplicateLabels` 重新非空（见 §3-①）。

### 1.2 RED-2 同一动作两入口 —— **已修，实测绿**

**根因**：底栏在 `factsVisible && daemonKnown && daemon.running !== true` 时渲染「启动守护」（`:1174-1180`），
而菜单项的条件是 `daemonKnown && daemon.running !== true`（`:1093`）—— **缺 `!factsVisible`**，两者在无守护态同时成立。

**改前**（红副本实测）：

```
footerOwnButtons = ["启动守护"]     menuItems = [重启, 停止, 启动守护, 查看诊断, 复制诊断]
duplicatedAcrossFooterAndMenu = ["启动守护"]        ← 断言非空 ⇒ 红
```

**改法**：菜单项条件补 `&& !factsVisible`（与底栏条件互补）⇒ 两者**互斥**。

**改后**（正常树实测，菜单开/闭各一次）：

```
菜单关闭：footerOwnButtons = ["启动守护"]（1 处）       开始计数 = 1
菜单打开：menuItems = [重启远端守护…, 停止远端守护…, 查看诊断信息, 复制诊断摘要]（无「启动守护」）
          footerOwnButtons = ["启动守护"]   duplicatedAcrossFooterAndMenu = []   ⇒ 主视线合计 1 处
```

**故意红**：副本把 `&& !factsVisible` 去掉 ⇒ 交集重新非空（见 §3-②）。

### 1.3 新发现① client 未消费 `result.notes` —— **已修，实测绿**

**根因**：`client.panel.js` 的 `actionFailureText()` 只读 `result.error`（字符串）与 `result.note`（字符串），
而 host 把原因放在 **`result.notes`（数组）** ⇒ 都取不到 ⇒ 落到 `t("note.hostNoReason")`
= 「host 用 200 回了 ok:false，但没有给出原因」。
**改前证据**：T31 报告观测到的面板原文即该句（lead 任务描述亦引用）。

**改法**：新增 `actionFailure(t, result) -> {text, detail}` 并让调用点用它（`setAction({... detail: failure.detail, error:{message: failure.text}})`）：
- 取因顺序 `result.error` → **`result.notes[0]`** → `result.note` → `note.hostNoReason`；
- 首项只把**首句**放正文，其余（含 `notes[1..]`）进 `detail`（沿用 `{text,detail}` 约定 ⇒ 渲染成折叠/`title`）。

**改后**（正常树实测，真守护 + `SIGSTOP`）：

```
正文 = "失败：remote-wsl: stop 未完成：槽位 8921（端口 8921）的本方守护进程仍在（pid 1762093）。"
detail(title) = "已按 P1 规矩**保留元数据** daemon.8921.json ⇒ 它仍是**可发现**的（…）；没有变成\"元数据已删、进程还在\"的隐形孤儿。"
retry = ["重试"]        hasNoReason = false        splitApplied = true
```

### 1.4 新发现② 确认框 `{slot}` 未插值 —— **已修，实测绿**

**根因**：`confirm.stopTitle` / `confirm.restartTitle` 的值里带 `slot {slot}`，而调用点（`:1006-1007`）**不传参** ⇒ 字面量 `{slot}` 直接渲染；`confirm.body` 还重申了一遍后果（重复）。

**改法**（i18n zh/en 各 5 处 + 1 处调用点）：
- `confirm.stopTitle/restartTitle` → 「停止远端守护？」/「重启远端守护？」
- `confirm.body` → `{consequence}（影响：「{distro}」上正在运行的 {count} 个会话）`（**消除重复**）
- `confirm.okAria` → `确认{verb}远端守护`（调用点不再传 `slot`）
- `confirm.stopBody` 与 4 个 `status.{stop,restart}{Title,Aria}` 是**死键**，一并改成用户语言（去 `slot`/`keys`），避免以后被误用。

**改后**（正常树实测）：

```
aria-label / title = "停止远端守护？"
body = "该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。（影响：「debian-u8-1」上正在运行的 0 个会话）"
buttons = [取消, 确认停止(aria=确认停止远端守护)]
重复计数("需要重新") = 1（改前 2）        leaks{slot|{slot}|daemonPort|pid N|keys|版本号} = false
```

> 说明：`confirm.body` 里的「该槽位」是中文词，不命中 M5 的 `\bslot\b`；且它属于"用户语言"（不是 `slot 8921`）。

---

## 2. 同轮补测（T31 的"已实现未自证"）

| 判据 | 读数 | 结论 |
|---|---|---|
| **M6** 快照 error 态事实节点 = 0 | **未实测**（快照失败态需要让 snapshot 路由失败，本轮没造）；**实测**了"列目录失败"态：错误可读 + 重试，且 `factsVisible` 只由**快照**状态决定 ⇒ 浏览错误不清快照事实（设计如此）。【读代码】`:455` `factsVisible=false` 时 `:724/:964/:992/:1187/:1212` 分支全不渲染 | **部分 / 未实测快照态** |
| **M7** 空态必有下一步 | 夹具 `/tmp/t32-empty-dir`（空目录）⇒ 渲染「该目录没有非隐藏条目。换一个目录，或回到 Home 重新开始。」+ **1 个可点控件**（`回到 Home`） | ✅ PASS |
| **M9**（顺带）语义常显 | 主视线可见文本包含「**仅筛选，不改目标**」（非 `title`） | ✅ PASS |
| **M10** 多实例降级 | **无夹具**（需 `others[]` 非空） | **未复核** |
| **M11** 诊断折叠区 | 2 个 `<details>` 默认 **closed**；收起状态下内部可聚焦元素数 = **0** | ✅ PASS |
| **M12④** 空最近列表显示 `recent.empty` | **未判定**：面板每次都会把当前 cwd 写回 `dsh-remote-wsl.recent`（`removeItem` 后重挂载立刻变回 `["/home/g"]`）⇒ 用本夹具**到不了**"列表为空"的渲染分支；空态分支（`:976` `recent.empty`）只有代码证据 | **未判定** |
| **M15** 形状通道 + 强制置静息填充仍可辨 | 当前 crumb `border-left:2px / font-weight:600`（light+dark）；T30 已实测"强制背景置 transparent 后仍可辨"；本轮 CSS 未变动 | ✅ PASS |
| **M16** 菜单文本色 == `label-primary` | 菜单项颜色集合 = `{label-primary(#0f1115→rgb(15,17,21)) , 禁用色}`；高度全 28px；无 `label-secondary` 文本 | ✅ PASS |
| **M17** 三背景 hover（两主题） | **light**：hover `rgba(38,49,72,0.06)` vs `layer-1 #fff` / `sidebar-fill #f9fafb` / `overlay #e9ecf2` ⇒ 全不同。**dark**：hover `rgba(255,255,255,0.08)` vs `#232324` / `#1b1b1c` / `#61666b` ⇒ 全不同 | ✅ PASS |
| **N1** 一个动作一个名字 | 头部次按钮、头部主按钮、(`<420px`)菜单项都用同一键 `action.addWorkspace`（改后头部不再出现第二个同名按钮） | ✅ PASS |
| **N2** 面板内不得用 `box-shadow` 表达层级 | 面板 root 内**非浮层**元素 `box-shadow !== none` 数 = **0**；菜单（浮层）`box-shadow = rgba(0,0,0,0.08) 0 4px 12px` + `bg-overlay` + **1px 内圈**（border-l2）⇒ 阴影非唯一分离手段 | ✅ PASS |
| **N4** 行内动作用 `visibility` 而非 `display:none` | 行 hover 前后 `rowRectDelta = [0,0,0,0]`；`.dsh-rw-rowacts` `display:flex` + **`visibility:hidden`**；宽度 24→24 不变 | ✅ PASS |
| **N5** 不得仅用颜色传达状态 | 状态点 `aria-hidden=true` 且 `--stopped` 变体是**空心**（1px 边框 + 白底）而 `--running` 是实心；状态句文本「远端守护未运行」同屏 | ✅ PASS |

### 回归（逐条复核）

| 项 | 读数 | 结论 |
|---|---|---|
| 门禁 `css-token-audit.mjs client/index.js` | `exit 0`（94 规则 / 17 token / C1 硬编码色 0 / C2 ⊆17 / S1 OK） | ✅ 未回退 |
| CJK 剥注释（`client.panel.js`） | **0** 条用户可见中文字面量 | ✅ 未回退 |
| M1 | 导航到 `/home/g/project/dsh1` ⇒ **可见文本 `dsh1` = 1**（`innerHTML` 43 次全是属性） | ✅ 未回退 |
| M5 | 主视线（去 `<details>`）术语命中 **[]**（该状态下） | ✅ 未回退（**例外见下**） |
| M14 | 宽屏 + 320：`scrollWidth === clientWidth`（91/91），文本非空 | ✅ 未回退 |
| M15 / M16 | 见上表 | ✅ |
| stop 失败面（真守护 `SIGSTOP`） | 面板渲染 `role=alert` 失败条 + **重试** 按钮，正文带 host 的 `notes` 原因 | ✅ 未回退且已增强 |

> **M5 的一个已知例外（请 T33 裁决）**：在**stop 失败**这一态下，host 的原文首句本身含
> `槽位 8921（端口 8921）…（pid 1762093）` ⇒ 主视线会出现 `pid <数字>`。
> 我选择**如实透传 host 原因**（可行动信息优先）而不是在客户端改写它。若 T33 按
> "任何状态下主视线都不得出现 `pid`" 判，则需另定口径（例如把整句 host 原文也折进 `detail`）。

---

## 3. 故意红（≥2，均在 `%TEMP%` 副本上做，`vendor` 只读，测完删除）

副本 `%TEMP%\t32-red`（`src/`+`client/`+`package.json`+`cordis.patch.yml`；profile `t32-red` 的 `node_modules` 用 **Junction** 指回副本，端口 8926）：

| # | 改回什么 | 实测（红） | 断言 |
|---|---|---|---|
| ① | `client.panel.js:554` 条件改回 `!primaryIsSession` | cwd=`/home/g` 时头部 = `[添加为 WSL 工作区, 添加为 WSL 工作区(--primary), 刷新]`，`headerDuplicateLabels = ["添加为 WSL 工作区"]` | `headerDuplicateLabels.length === 0` ⇒ **红** |
| ② | 菜单项条件去掉 `&& !factsVisible` | 无守护态：底栏「启动守护」**且**菜单也有「启动守护」，`duplicatedAcrossFooterAndMenu = ["启动守护"]` | 主视线该动作 **恰 1 处** / 交集为空 ⇒ **红** |

两条**共用同一个副本与同一次实例启动**；恢复 = 删副本 + 删 profile（已删，见 §5）。

---

## 4. ★ 本轮顺带打出来的一个机制坑（与本次四条无关，但会害下一个人）

**只改 `client.panel.js` / `client.i18n.js`（包内 chunk）不会刷新浏览器拿到的 chunk。**

- chunk URL = `/plugins/dsh-remote-wsl/client.<name>.js?rev=<rev>`，而这个 **rev 取自"入口行" `client/index.js`** 的
  mtime/ctime/size（`dsh-client-modules` 的 `chunkUrl` 用 owner 行的 rev）；
- 该路由又带 `Cache-Control: public, max-age=31536000, immutable`（同包的 `IMMUTABLE_CACHE`）；
- ⇒ 只改 chunk：URL 不变 ⇒ 浏览器**直接复用旧脚本**。
- **实测**：我先只改了 `client.panel.js` + `client.i18n.js`，重启宿主并用新 token 新开页面后，面板仍渲染**旧文案**
  （确认框仍是旧的重复句、失败条仍不分首句/细节）；把 `client/index.js` 加了一段注释（改动 owner 的 mtime/size）后重启，
  同两条立即变成新文案。
- 处置：把这条**写进 `client/index.js` 的注释**（就在 chunk 常量上方），并在此报告留档。
  ⇒ 改 chunk 后要生效：**同时动一下 `client/index.js`**，或用 HMR / `pnpm run dev:web`，或让用户硬刷新。

---

## 5. 纪律与收尾

- **端口**：8922（正常树）/ 8926（红副本）；收尾后 **8921–8930 监听数 = 0**。
- **可见窗口**：全程 `--no-open`（红/正常副本实例都用 `Start-Process -WindowStyle Hidden` 或后台作业）；
  起守护走 **`mode:"systemd"`** 主路径（WSL `systemctl --user is-system-running` = `running`，失败 unit = 0）⇒ **未走 compat 回退，未产生 dsh 窗口**。
  收尾枚举可见窗口 10 个，`CommandLine` 全部 `foreign`（VS Code / Cursor / 用户宿主 47604 / explorer / geph / Edge / QQ / TextInputHost / Weixin / 一个 headless `chrome`（DevTools MCP 自己的浏览器，非 dsh 窗口））
  ⇒ **没有任何窗口可归因到本轮的 dsh 动作**（无 `wsl.exe`/WindowsTerminal 子节点）。**归属按 pid/parent/启动时间/命令行判，未凭标题**。
- **用户宿主 19387**（pid 47564）全程只读报告、未触碰；**未写** `~/.dsh/storages/workspace.json`（本轮没有验证 A1，不需要孤立 DSH_HOME）。
- **WSL 收尾**：`daemon.ts` 进程 0、`dsh-rwsl*` unit 0、`--state=failed` 0、`launch.*.sh` 0（目录只剩日志）。
- **临时物**：`%TEMP%\t32-red`、profile `t32-red`、profile 里删掉的空目录夹具 `/tmp/t32-empty-dir` 均已清除。
- **作用域**：本轮只改 `client/`（3 个文件：`client.panel.js`、`client.i18n.js`、`client/index.js` 注释）；`src/` 一行未动。

---

## 6. 未复核 / 未判定（明确剔除，不算完成）

| 项 | 状态 | 说明 |
|---|---|---|
| **M14 的 420 / 719 / 720 三宽度** | **未复核** | 需要能真正改 `innerWidth` 的手法；本轮只测了**宽屏** + **320**（用 CDP `Emulation.setDeviceMetricsOverride` 的 `emulate`），未把三档跑全 |
| **M13 键盘 ↑↓ / Backspace** | **未复核** | 需要 CDP 真按键；本轮未做 |
| `PANEL_LABEL_FALLBACK` 判别性 | **不可判别** | 本机语言固定 `zh-CN`，兜底常量与字典值**同串**（都是「远程资源管理器」）⇒ 在无语言切换夹具前**无法判别**是否真的走字典；未找 UI 语言开关 |
| **多实例 / `others[]` 非空态** | **未复核** | 无夹具 |
| **M6 快照失败态** | **未实测** | 只实测了"列目录失败"态（属浏览态）；快照失败需要让 snapshot 路由失败 |
| **M12④ 空最近列表** | **未判定** | 见 §2（面板会把当前 cwd 写回 storage，夹具到不了空列表分支） |
| 面板对 `result.ok:false` 的**成功/失败两态整屏**截图 | **未交** | 本轮只给了 DOM 读数（正文/detail/重试），未补截图 |
| M5 在 **stop 失败态**的 `pid N` 例外 | **待裁决** | 见 §2 末尾 |

---

# 附：T36 裁决落实（stop 失败态主句用户化，host 原文只进 detail）

**裁决**：主视线必须是用户语言；host 原文（含 `pid`）只能进折叠 detail。原 T32 的"如实透传"被否决（会让 M5 在 stop 失败态失效）。

## 改法（`client/`，`src/` 未动）

1. `client.panel.js` 的 `actionFailure(t, result, failKey)` 新增第三参 `failKey`：
   - 有 `failKey` ⇒ 正文 = **用户语言主句**（i18n 键），host 原文**整段**（首句 + 其余 + `notes[1..]`）进 `detail`（渲染成 `title`/tooltip）；
   - 无 `failKey` 的调用方（`addWorkspace` / `openSession` 等，它们有自己的用户语言 `describeError`，原文不含实现者术语）**沿用旧行为**（首句进正文、其余进 detail）；
   - `note.failStop` 只在"守护进程仍在"（`result.pid` 非空）时贴切，否则退到 `note.failGeneric`。
2. 三个守护动作的 `run()` 调用点传 `failKey`：`ensure→note.failStart`、`stop→note.failStop`、`restart→note.failRestart`。
3. `client.i18n.js` 新增 4 键 × zh/en：`note.failStop` / `note.failRestart` / `note.failStart` / `note.failGeneric`
   （`note.failure` 外壳已经会加「失败：」，所以这 4 键**不再自带"失败"**，避免"失败：停止失败："叠字）。
4. `client/index.js` 的 chunk-rev 注释块又动了一行（本轮第二次刷新 owner rev —— 见 §4 的机制坑）。

## 验收读数（真守护 + `SIGSTOP`，正常树 `--port 8922`）

**① 主句用户语言、无实现者术语**

```
role = alert        MAIN = "失败：远端守护仍在运行，停止未完成"        retry = ["重试"]
mainTerms（正则 \bslot\b|daemonPort|\bpid\b|\bkeys\b|explorer\.snapshot|/remote-wsl/api|\bsnapshot\b|\d+\.\d+\.\d+|systemd-run|\bunit\b）= []
mainSightTerms（整棵主视线，去 details+菜单）= []
```

**② host 原文仍可获取（含 pid）**

```
detail(title) = "remote-wsl: stop 未完成：槽位 8921（端口 8921）的本方守护进程仍在（pid 1783013）。已按 P1 规矩**保留元数据** daemon.8921.json ⇒ …"
detailHasPidAndMetadata = true
菜单诊断组仍有：["查看诊断信息", "复制诊断摘要"]
```

**③ 故意红**（副本 `%TEMP%\t36-red`：把调用点的 `failKey` 参数去掉 ⇒ 退回"host 首句进正文"）

```
RED_MAIN   = "失败：remote-wsl: stop 未完成：槽位 8921（端口 8921）的本方守护进程仍在（pid 1787056）。重试"
RED_mainTerms = ["pid"]        RED_assertWouldFail = true      ← 断言 `mainTerms.length === 0` 变红
```

**④ 回归：四态主视线术语**

| 态 | 读数 |
|---|---|
| 无守护 | `terms = []`（footer「远端守护未运行 · 会话 0 个 启动守护」） |
| 运行中 | `terms = []`（footer「远端守护运行中 · 会话 0 个」） |
| 加载中（刷新全过程） | 用 `MutationObserver` 全程录帧（3 帧），`anyTermsAcrossFrames = []`；注：有前一次快照时 `factsVisible` 保持 true（设计如此，`:455`），所以加载态不显示独立的"读取中"状态句 |
| 错误（stop 失败） | `terms = []`（见 ①） |

**回归门禁**：`css-token-audit.mjs client/index.js` **exit 0**；CJK 剥注释后 `client.panel.js` = **0**。

## 收尾

端口 8921–8930 监听 **0**；WSL `daemon.ts` 进程 0 / `dsh-rwsl*` unit 0 / `--state=failed` **0** / `launch.*.sh` 0（`is-system-running = running`）；
`%TEMP%\t36-red` 与 profile `t36-red` 已删；用户宿主 19387(47564) 只读未触碰；
可见窗口 11 个（VS Code / Cursor / 用户宿主 47604 / explorer / geph / Edge / QQ / TextInputHost / Weixin / 两个 DevTools MCP 的 chrome），
`CommandLine` 全部 `foreign`，**无 wsl.exe/WindowsTerminal 子节点 ⇒ 本轮 dsh 动作产生 0 个窗口**（起守护走 `mode=systemd`）。
