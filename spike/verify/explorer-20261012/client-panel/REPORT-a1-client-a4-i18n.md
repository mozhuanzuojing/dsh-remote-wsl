# T24 —— A1 client 半 + A4 i18n + T5 两条文案瑕

- **日期**：2026-10-13 ｜ **角色**：client-panel ｜ **任务**：task-24
- **写作用域**：**只 `client/**`**（`src/` 未动；`src/explorer.ts` 的 `M` 是 T20 的既有改动）
- **锚点**（SHA256）：
  - `client/client.i18n.js`（**新增 chunk**）`37DBB86BD5C2D8397C5F247175BB7DB86417B4DC6B146290AA6554C3E127D9D0`（29317 B）
  - `client/client.panel.js` `2560811F5F319C8A85F304CD95CE678292F7C2826D7BFC78E04A15CD223D34F4`（49881 B）
  - `client/client.api.js` `C3600EE50356ADE54A4F348038FA1C48E0BF444CA85E219670F38B060899E16F`（13296 B）
  - `client/index.js` `AA033A3795677F22DDA6B22BE9FDA8EE4F3D3C247488C1C9BFC45EAA5593623D`（22108 B）
  - `client/client.icon.js` `E9A824F50E45E5D4840A8604D511DBC2B87CC4BB30A6512AEFE505DC11B7D431`（**未改**）
- **结构改动原则**（lead 协调 2026-10-13）：A1/A4 **挂在现有结构上**，未重排 IA、未新造一级布局容器；新增的可见元素只有：目录浏览器动作行里的 1 个按钮 + 结果条内 1 个 `<details>` 折叠区（后者是 ③(i) 的要求）。文案全部走统一字典，UX 轮只动 `client.i18n.js`。

---

## ① A1「添加为 WSL 工作区」（真机，非桩）

**实现**：`browser` 动作行新增按钮 → `explorer.addWorkspace({path})`（`client.api.js` 新增方法 + `METHODS.addWorkspace`）。
结果渲染复用**既有结果条**机制：`run()` 的 `describe` 返回 `{text, detail}`，正文只放人话，其余进 `<details>`（并同时做 `title`）。
文案口径（aria/title 明说差别，不过度承诺）：
- aria：`把 /home/g 登记为 WSL 工作区（路径是 UNC ⇒ 文件工具经 9P；与“远端会话”是两条路）`
- title：`登记为工作区：host 在 WSL 侧登记该目录并返回 UNC 路径 ⇒ 文件工具走 9P。这与上方“在新会话中打开”的远端会话是两条路，互不替代。`

**四种结果（同一实例，真实 host 响应）**：

| 场景 | 结果条正文（逐字） | 折叠区 |
|---|---|---|
| 成功 | `已登记为工作区：project（id=47624352-1b4c-4a78-8887-289580112644）` | `UNC \\wsl.localhost\debian-u8-1\home\g\project` |
| `alreadyExisted:true` | `已存在，未重复创建：project（id=47624352-…）` | 同上 |
| `E_ARG`（跳 `/mnt/c` 后点） | `失败：路径不合法，未登记（host 说：remote-wsl: explorer.addWorkspace 不接受 /mnt/<盘符> 路径（收到 "/mnt/c"）：…请改用发行版内的 ext4 路径…）` + `重试` | — |
| `E_NOTFOUND`（跳 `/home/g/t24-nonexistent-xyz` 后点） | `失败：该路径在 WSL 里不存在，未登记（host 说：…不存在（UNC \\wsl.localhost\debian-u8-1\home\g\t24-nonexistent-xyz；ENOENT…））` + `重试` | — |

英文面（同一路径，语言切到 en）：`Already existed — not created again: g (id=776d55c6-…)`，折叠区 `UNC \\wsl.localhost\debian-u8-1\home\g`。
`E_UNAVAILABLE` 本轮**未造出真实触发**（需要"发行版/权限/状态目录"故障）⇒ 字典键与分支代码已就位（`action.addWorkspaceErrorUnavailable`），但**只验到分支判据（按 `code` 选键）与另两种 code**，如实标注。

**副作用与已回退（重要）**：host 的 `workspaceRegistry.create()` 落在 **`C:\Users\l\.dsh\storages\workspace.json`（全局，不在 profile 内）** ⇒ 我这次 A1 真机测试往**用户的工作区库**加了 2 条。已**精确回退**：删掉我创建的 2 个 id（`47624352-…`、`776d55c6-…`）及其 `tables.workspaces` 记录，其余 11 条**顺序逐项一致**；备份留在 `%TEMP%\workspace.json.t24bak`。
⚠️ 提醒 lead/用户：用户自己的 GUI（19387）内存里可能仍持有旧列表，若它之后回写 `workspace.json`，这 2 条有可能再出现 —— 值得顺手看一眼工作区列表（这不是我能从外部锁住的）。

**未做**：`openSession`（在新会话中打开）逻辑**未改**（只改它的结果条切句）；不新增结构。

## ② A4 i18n

**两条路（按 lead 要求：官方优先、取不到回退、不许崩）**：
1. `ctx.get('locale')` 可用 ⇒ 把本包字典 `register(NS,{zh,en})`（官方插值 + fallback chain），`translate(NS,key,params)` 命中就用它；
2. 官方缺键/不可用/抛错 ⇒ **内置字典**（`resolveLanguage` 走 `getSnapshot().active` → `documentElement.lang` → 默认 `zh`），`{name}` 插值自带；**缺键原样回键**（绝不 undefined/空占位）；
3. 语言变化：官方 `locale.subscribe` + 兜底 `MutationObserver(<html lang>)` ⇒ 面板重渲染（`i18n.subscribe`）。字典 **zh 181 键 / en 181 键，逐键一致（无缺口）**，前缀：`panel/header/load/error/empty/tree/row/browser/action/others/confirm/note/session/daemon/status/stamp/raw/api/chunk`。

**验收证据**：
- `zh-CN`（真机 DOM）：`远程资源管理器` / `目标 debian-u8-1 · /home/g` / `daemon 未运行`+`启动守护` / 空态·错误态原句保持；`documentElement.lang="zh-CN"`。
- `en`（**官方路径**：设置 → 通用 → 语言 → English，profile 级偏好）：`Remote Explorer`（**含 rail 名**）/ `Target debian-u8-1 · /home/g` / `daemon not running`+`Start daemon` / `Browse directory (WSL: debian-u8-1)` / `Hidden files: off` / `Go`/`Session here`/`Add as WSL workspace` / `Start daemon`/`Restart…`/`Stop slot 8921…` / 错误态 `Failed to read remote resources (no usable data: request timed out)` + `Endpoint: /remote-wsl/api kind: timeout` / `no snapshot yet` / `Raw snapshot (same source as wsl_status)`；`aria`/`title` 同步英文（例：`Register /home/g as a WSL workspace (UNC path ⇒ file tools go through 9P; …)`）。
- `aria` 不退化：**24 按钮 `ariaMissingBoth=0`**，`input/select` 缺 `aria|title` = **0**（`select` 补了 `aria-label`/`title`，另有 `<label>` 兜底）。
- light/dark：light `rootBg=rgb(255,255,255)`；dark `rootBg=rgb(35,35,36)`、`statusBg=rgb(27,27,28)`、`noteBorder=rgba(255,255,255,.06)`；两态文案一致、aria 覆盖不变（全走主题 token，无写死色）。
- 回退路径（探针，`localeService=null`）：`zh=["远程资源管理器","添加为 WSL 工作区","启动守护"]`；`en=["Remote Explorer","Add as WSL workspace","Start daemon"]`；带参 `Registered as workspace: g (id=abc)`；缺键 `"no.such.key"`（原样回键）；`resolveLanguage` 无 locale+`lang=en`⇒`en`、`lang=zh-CN`⇒`zh`、无 doc⇒`zh`；官方服务抛错时返回 `"Remote Explorer"`（**不许崩** ✓）；官方服务存在时**官方优先**（active=zh-CN ⇒ 中文，覆盖 `lang=en`）。

**故意红（A4）**：把内置字典回退整段去掉（`const template = undefined`）⇒ 探针立刻变红：`zh:["panel.title","action.addWorkspace","status.start"]`、`en:["panel.title",…]`、带参 `"action.addWorkspaceDone"`（键名当文案 = 正是要防的）。随后 **字节级还原**（hash 相等）⇒ 复绿。

### 本轮自查发现并修掉的 3 个真缺陷（A4 相关）
1. **冷加载 rail 名停在 fallback 语言**（实测：英文界面里 rail 仍显示「远程资源管理器」）。根因：`apply()` 里**立即**注册 `sidebar.panellist`，侧栏读 `label` 的时机早于 i18n chunk 就绪 ⇒ 拿到 fallback 并一直留着。修法：注册推迟到 `bootSettled`（两条路径都注册一次，幂等），label 仍是 `() => tr("panel.title")`。复验：冷加载（ignoreCache）后 `railButtons=["Plugins","Remote Explorer"]` ✓。
2. **`t` 作用域错**：`request()`/`requireString()` 在**模块作用域**，我的 i18n 注入写在 `createExplorerApi` 内 ⇒ 真机报 `errBody: "t is not defined"`（kind=unknown）。修法：`FALLBACK_TEXT`/`fallbackTranslate` 提到模块作用域，`request(method,args,options,translate)` 收第四参，`createExplorerApi` 内 `const call = (…) => request(…, t)`，`requireString(value, field, t)`。复验：错误体变成 `explorer request timed out: no response from /remote-wsl/api within 9000ms (the route or the gateway is stuck).` ✓（英文路径）。
3. **en 字典缺 2 键**（`tree.optionDefault`/`tree.optionStopped`）⇒ 英文下发行版 `<option>` 会漏出中文「（默认）」。补齐后 **181/181** ✓。

## ③ T5 两条文案瑕

**(i) 结果条原样透传 host 文案 ⇒ 首句人话 + 其余折叠**（探针 + 真机 DOM 双证）

```
host note（改前 body = 原样）：
  已把 /home/g 登记为远端会话的目标目录。上游 daemon 会在首次 wsl_agent 轮次时物化 runtime+sessionId；本方法不会预热，openSession({warm:true}) 才会。
改后 body  = 已把 /home/g 登记为远端会话的目标目录。
改后 detail(折叠/title) = 上游 daemon 会在首次 wsl_agent 轮次时物化 runtime+sessionId；本方法不会预热，openSession({warm:true}) 才会。
```
真机（英文，重启守护走二次确认）：
```
正文  = Daemon restarted slot 8921 · :8921 · pid 1587650 · 0.2.0-rc.2      ← bodyHasHostNotes = false
折叠  = restart: 已停本槽位守护（0 个运行时被回收）
        启动方式: systemd-run --user（unit dsh-rwsl-8921.service；包装层短命 ⇒ 无窗口，且与 Windows 侧生死解耦）
        槽位 8921 由 Windows 侧握手确认就绪（实际端口 8921，4ms）
```
⇒ `daemon` 路径的 host `notes[]`（systemd/unit/握手耗时 = 实现者词汇）也不再进正文；`openSession` 同理（`openSessionNote` 返回 `{text, detail}`）。

**(ii) 加载期「尚未取得快照」渲染两次 ⇒ 右侧只出戳记**（真机 DOM，改前/改后同一条件）
```
改前（故意红版：右侧回到 t("stamp.none")）：
  left  = 尚未取得快照：正在读取守护与漂移状态（超时 9000ms）…
  right = 尚未取得快照                      countNoSnapshot = 2   ← 重复
改后（现版本）：
  left  = 尚未取得快照：正在读取守护与漂移状态（超时 9000ms）…
  right = 读取中…                          countNoSnapshot = 1   （en: left "No snapshot yet: reading daemon…" / right "Reading…"，同样 1）
```
复现条件：`initScript` 把 `/remote-wsl/api` 的 fetch 延后 9s（面板停在首挂载 loading 态），`ignoreCache` 重载后取 DOM。随后**字节级还原**（hash 相等）+ 重启复验。

## 回归清单
| 项 | 结果 |
|---|---|
| 三态（loading/error/ready） | ✓ 三态分别取到 DOM（loading 只有「还在读」；error 只讲读失败并撤下事实；ready 才出数字） |
| F34 首挂载只显示读取中 | ✓ loading 态正文只有 `正在读取 explorer.snapshot(…)` + `尚未取得快照：正在读取…`（左右各一次、不重复） |
| F35 路径 LTR | ✓ `.dsh-rw-note-text`/`.dsh-rw-note-detail` 均 `direction:ltr`；UNC 折叠区 Range 宽 228px（38 字符单行 LTR 段，与 T13 判据同法） |
| `others[]` 只读零按钮 | ⚠️ **本轮快照 `daemon.others` 为空**（无其它槽位守护）⇒ 渲染分支未实测（代码未动该分支；既有 T13 证据仍在） |
| 停止/重启二次确认 | ✓ 英文 `Stop the daemon? slot 8921 (this plugin's configured slot; there is no all option)` + 后果句 + `Confirm stop`/`Cancel` + `aria-label`；点 Cancel 不动作；重启路径点确认后 pid 1583662→1585920 |
| aria/title 不退化 | ✓ 24 按钮 missingBoth=0；input/select 缺名 0；新控件（A1 按钮）aria/title 齐 |
| light/dark | ✓ 见 ②（token 生效，无写死色） |
| `openSession` 不动 | ✓ 仅结果条切句；请求参数/时序未改（`describe` 由 `run()` 统一处理 string 或 `{text,detail}`） |
| 新增 `refresh:true`（A1 成功后刷新） | ✓ 让新登记的工作区进树；结果条不被这次刷新清掉（沿用 F36 的修法） |

## 纪律与收尾
- 端口 8921–8930；**未** `npm/pnpm install`；**未**碰 19387/47604（默认 GUI 窗口 PID 47604 全程未动）。
- **窗口两个数**：本轮**产生过我方可见窗口 = 0**（起实例全程 `-WindowStyle Hidden` + 重定向；守护走 systemd 主路径，结果条原文自证：`启动方式: systemd-run --user（unit dsh-rwsl-8921.service；包装层短命 ⇒ 无窗口…）`）；**收尾时存在的我方可见窗口 = 0**（枚举只剩用户自己的 Code/Cursor/DSH 宿主/Geph/Edge/输入法/微信；归属用启动时间 + 父 pid 判定，`ppid=20772` 那批是用户自己的应用）。
- 收尾：3091 实例已停；`node src/selftest.ts stop --port 8921` ⇒ `alreadyStopped:true`；`systemctl --user` 里 dsh-rwsl 单元 = **0**；8921–8930 守护 = **0**；state 目录 `launcher 残留=0`、`meta 残留=0`（只剩 `daemon.log`/`launch-stderr.log`）；临时 profile `remote-wsl-test-p24` 已删；浏览器页已关闭；A1 的全局工作区副作用已回退（见 ①）。
- 过程中一次自伤：用 `Copy-Item -Recurse` 复制 profile 时把 junction 变成了真实目录副本 ⇒ `remote-wsl (dsh-remote-wsl): failed to import`（rail 项消失）。已改回"新建目录 + 3 个配置文件 + junction"的正确做法，并记录以免复现。

## 未复核 / 交给后续
1. `explorer.addWorkspace` 的 **`E_UNAVAILABLE`** 分支未造出真实触发（只验判据与另两种 code）。
2. 快照 `daemon.others = []` ⇒ `others[]` 零按钮渲染本轮未实测。
3. A1 的副作用是**全局** `~/.dsh/storages/workspace.json`（不在 profile 内）—— 面板侧无删除动作；是否要给 A1 配"移除"或限定作用域，属 host 侧/UX 轮决策。
4. 上游（host）给的 `notes[]`/错误文案本身是中文，英文界面下这部分仍是中文 —— 这是"host 文本不本地化"的既定边界，已在字典里只覆盖**本包自撰**文案。

## 文案键清单（给 UX 规格对齐）
**A1 新增（12）**：`action.addWorkspace`、`action.addWorkspaceBusy`、`action.addWorkspaceAria`、`action.addWorkspaceTitle`、`action.addWorkspaceNeedPath`、`action.addWorkspaceDone`、`action.addWorkspaceDoneAria`、`action.addWorkspaceExisted`、`action.addWorkspaceErrorInvalid`、`action.addWorkspaceErrorNotFound`、`action.addWorkspaceErrorUnavailable`、`action.addWorkspaceErrorOther`
**A4 基础设施新增（12）**：`api.timeout`、`api.aborted`、`api.abortedBeforeStart`、`api.transport`、`api.protocol`、`api.hostFailed`、`api.argument`、`chunk.loadFailed`、`chunk.loadFailedTitle`、`chunk.panelFailed`、`chunk.panelLoading`、`chunk.notExported`
**T5 文案瑕新增（2）**：`note.detailSummary`（折叠区 summary 文案）、`note.unwrapped`（"（未写入）"）
**其余为既有文案搬进字典**（键名与现文案一一对应，zh 值 = 改前原文，保证中文零变化）：`panel.title`、`header.*`(9)、`load.reading`、`error.*`(7)、`empty.*`(2)、`tree.*`(13)、`row.*`(9)、`browser.*`(39)、`others.*`(2)、`confirm.*`(13)、`note.*`(其余 7)、`session.*`(7)、`daemon.*`(7)、`status.*`(33)、`stamp.*`(4)、`raw.summary`。字典合计 **181×2**。
