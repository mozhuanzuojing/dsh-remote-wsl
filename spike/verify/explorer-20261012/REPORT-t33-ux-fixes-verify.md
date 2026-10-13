# REPORT-t33-ux-fixes-verify.md —— T33：UX 收口的独立复验

- **验证者**：`p0-verify`（独立于 T32/T36 实现者）｜**日期**：2026-10-13｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：冻结 → 收尾复算 **锚点一致 = True（14/14）⇒ 验证有效**；advisory 仅 README/docs。
  锚点集 = `src/**` 8 + `client/**` 5 + `package.json`；本轮变化面（vs T31）= `client/client.i18n.js` (`cba40e696f68…`)、`client/client.panel.js` (`7719876a65a0…`)、`client/index.js` (`5f2430ead9e8…`)+docs（`src/**` 与 T31 同）。
- **口径**：i18n 键数**以脚本为准** —— `arch-t2/tools/count-i18n-keys.mjs` 实测 **ZH=219 / EN=219（paired=true，onlyZh/onlyEn 空）**；GO 里的 215 是旧值，差 4。

## 结论（≤450 字）

**★ 先做的关键一条：页面加载的 chunk == 磁盘 chunk（逐字节）⇒ 本轮所有渲染读数有效。** 抓 4 个 chunk 的实际 URL（`/plugins/dsh-remote-wsl/client.*.js?rev=07cf221a6f42`）→ `fetch(no-store)` → 剥掉服务端追加的 `;\n//# sourceMappingURL=<file>.map?rev=…` → SHA-256 **与磁盘逐一相等**（panel `7719876a…` 55803B、i18n `cba40e69…` 32682B、api `c3600ee5…` 13296B、icon `e9a824f5…` 2209B）。机制坑**在构造上确实存在**（4 个 chunk 共用入口 rev、响应头 `cache-control: public, max-age=31536000, immutable`）⇒ T32 注释里"只改 chunk 会永久复用旧脚本 + 要同时动 `index.js` 刷 owner rev"的机制成立。
**RED-1 已修（三情形全绿）**：① `cwd==目标` ⇒ 头部 `[添加为工作区(--primary), 刷新]`、`dupLabels=[]`；② `cwd≠目标` ⇒ `[添加为工作区, 在此目录新建会话(--primary), 刷新]`、无同名；③ 窄 320 ⇒ `[添加为工作区(--primary), 刷新]`、主按钮带字。修点在 `client.panel.js:600 if (!narrow && primaryIsSession)`（T31 是写反的 `!primaryIsSession`）。
**RED-2 已修（两态全绿）**：无守护态「启动守护」在主视线**只 1 处**、菜单 `守护` 组 = 重启/停止/诊断/摘要（**无 启动守护**）且 重启/停止 `disabled`；运行中态「启动守护」**0 处**。
**`notes` 已消费（vendor 真造 PASS）**：真守护 + `SIGSTOP` ⇒ 面板 `失败：远端守护仍在运行，停止未完成`（用户语言主句）+ `role=alert` + `重试`，**不再出现"没有给出原因"**；主句术语 **0 命中**；host 原文（含 `pid 1798254`）在**折叠**的 `技术细节（host 原文）` 里仍可获取。
**`{slot}` 已用户化 PASS**：确认框（`role=alertdialog`）= `停止远端守护？ 该槽位上的守护会被关掉…（影响：「debian-u8-1」上正在运行的 0 个会话）`，**无 `{slot}`/`slot`/`daemonPort`/裸 pid**，后果三要素与 取消/确认停止 结构俱在。
**回归**：门禁 `css-token-audit.mjs` 两文件 **exit 0**（C1 0/C2 ⊆17/S1 OK）；CJK 剥注释 **0**（原始 982）；M1 可见 `dsh1` 恰 1；M5 四态主视线 0 命中；M14 宽 91==91 / 320 104==104；M15 `2px`+`600`；M16 单 `⋯`、宽 2 组/窄 3 组、组标题 `tabindex=-1`；M4/N3 底栏无破坏性动作。
**故意红 3/3（全部副本制、字节还原复绿）**：A 条件改回写反 ⇒ 头部出现两个同名按钮；B 忽略 `notes` ⇒ host 原文不可获取；C i18n 放回 `{slot}`/`{daemonPort}` ⇒ 确认框命中。
**环境/纪律**：每轮 `mode=systemd`（无弹窗）；收尾 unit（含 `reset-failed`）/守护/包装层/profile/副本/`launch.*.sh` 全清、端口 8931–8936 全 0；**用户全局 `storages/workspace.json` 全程未变**（`fc3eab1ade5d`/1 条，前后同）；未碰 19387/47604。

## 0. ★ chunk == 磁盘（先做，决定后续读数是否有效）

| chunk | 服务端 URL | 服务端体 | 剥离后缀后 | 磁盘 SHA-256 | 判定 |
|---|---|---|---|---|---|
| client.panel.js | `?rev=07cf221a6f42` | 55863 B | 55803 B | `7719876a65a0…` | **逐字节相同** ✓ |
| client.i18n.js | 同上 | 32741 B | 32682 B | `cba40e696ff6…` | ✓ |
| client.api.js | 同上 | 13354 B | 13296 B | `c3600ee50356…` | ✓ |
| client.icon.js | 同上 | 2268 B | 2209 B | `e9a824f50e45…` | ✓ |

- 结论：服务端体 = **磁盘内容 + `;\n//# sourceMappingURL=<file>.map?rev=<rev>\n`**（剥离 2 字节 + 该行后哈希逐一相等）。
- 机制：4 个 chunk 的 rev **同为一个值**（取自入口 `client/index.js` 的 rev），响应头 `cache-control: public, max-age=31536000, immutable` ⇒ **只改 chunk 时 URL 不变、浏览器按 immutable 复用旧脚本**（T32 记录、T36 用"动 index.js 刷新锚点"规避）。
- **自我更正**：我第一次把 `arrayBuffer().byteLength` 与磁盘 `Length` 比，得出"多 58–60 字节"并差点误判为"不一致"；那其实是 `//# sourceMappingURL` 后缀——按"剥离后比 SHA-256"才是正确判据。
- **判法写明（按 lead 补充①）**：我采用的是**第二种**——"**磁盘内容 == serve 内容的前缀，且只剩一行 trailer**"：先定位 `lastIndexOf('//# sourceMappingURL=')`，回退 2 字节（`;`+换行）取前缀，对该前缀算 SHA-256，与磁盘文件 SHA-256 **逐一相等**；同时记录 serve 体/trailer 的原始字节数（见上表）。**不是**"直接拿 serve 体与磁盘体比"（那样会假红）。
- **④ 收尾现场（按 lead 补充④ 复核）**：`dsh-rwsl-8932.service` 收尾时实测 **not loaded**（`list-units "dsh-rwsl-*"` 输出空、`list-unit-files` 空、`stop`/`reset-failed` 返回 "Unit … not loaded"）、8932 端口监听 **0**、WSL 侧 `daemon.ts --port 8932` 进程 **0**、`is-system-running=running` ⇒ 我在 T33 运行期起的该 unit 已随收尾清掉，**当前无残留**。

## 0.1 前置读数（lead 补充③ 的"陈旧陷阱"闸门，先于渲染判据）

- **入口 `client/index.js`**：mtime `2026-10-13 14:32:37.108`、size 25609。
- **4 个 chunk**：`client.panel.js` 14:28:04.760（55803B）｜`client.i18n.js` 14:32:23.227（32682B）｜`client.api.js` 09:41:18.655（13296B）｜`client.icon.js` 2026-10-12 11:24:32.932（2209B）。
- ⇒ **入口元数据晚于全部 chunk = True ⇒ PRE-CHECK PASS**（不满足"只改 chunk 不 bump 入口"的陈旧条件）。
- **官方脚本**：`spike/verify/explorer-20261012/tools/check-client-rev.mjs` **exit 0 ⇒ `client-rev 门禁：PASS（模式=git）`**，原文：
  - `当前 rev : 07cf221a6f42 [mtime=2026-10-13T06:32:37.108Z ctime=2026-10-13T06:32:37.117Z size=25609]`
  - `chunks : 4 个 client.api.js(c3600ee5) client.i18n.js(cba40e69) client.icon.js(e9a824f5) client.panel.js(7719876a)`
  - `依据 : chunk 有变化，但入口元数据更新（…06:32:37.108Z > …06:28:04.760Z）⇒ rev 已换 ⇒ 缓存 URL 已失效`
- 与补充② 一致：rev 由**入口**元数据派生（sha1 over mtime/ctime/size），我实测 4 个 chunk 的 URL **共用同一个 `rev=07cf221a6f42`**（=上表当前 rev）；路由命中才 200（另测 `/plugins/dsh-remote-wsl/client.js` 无 rev ⇒ **404**，与"路由 (id,file,rev) 命中才 200"一致）。
- **⇒ 我的全部渲染读数有效**（另有独立佐证：`no-store` 取回的服务端体与**当前磁盘**哈希相等 ⇒ 不可能是陈旧快照）。

## 1. RED-1（头部）三情形 —— 修好

| 情形 | 头部按钮 | 主按钮数 | 同名重复 | 标签合规 |
|---|---|---|---|---|
| `cwd == 目标`（`/home/g`） | `[添加为 WSL 工作区(--primary), 刷新]` | 1 | **无** | ✓ 未成工作区 ⇒「添加为工作区」 |
| `cwd ≠ 目标`（`/home/g/project`） | `[添加为 WSL 工作区, 在此目录新建会话(--primary), 刷新]` | 1 | **无** | ✓ 目录≠目标 ⇒「在此目录新建会话」 |
| 窄 320 | `[添加为 WSL 工作区(--primary), 刷新]` | 1 | **无** | ✓ 主按钮带字（非图标） |

## 2. RED-2（同一动作双入口）两态 —— 修好

| 状态 | 主视线「启动守护」次数 | 菜单项 | 重启/停止 |
|---|---|---|---|
| 无守护 | **1**（只在底栏） | 重启远端守护…/停止远端守护…/查看诊断信息/复制诊断摘要（**菜单里没有 启动守护**） | `disabled:true` ✓ |
| 运行中 | **0**（底栏也不显示） | 重启/停止/查看诊断/复制诊断（全启用） | 启用 ✓ |

## 3. `result.notes` 已被消费（真造）—— PASS

- route：真守护（`mode=systemd`，pid 1798254）+ `kill -STOP` ⇒ `result.ok=false` + `notes=[remote-wsl: stop 未完成：槽位 8932（端口 8932）的本方守护进程仍在（pid 1798254）… 已按 P1 规矩保留元数据…]`。
- 面板：`失败：远端守护仍在运行，停止未完成` + **`技术细节（host 原文）`（折叠 `<details>`，内含 pid/host 原文）** + `重试` + `role=alert`；`saysNoReason=false`；主句术语命中 **0**。
- **注意**：我第一版断言 `hostRawRecoverable` 读的是**整面板 `innerText`**，而 host 原文在**折叠** `<details>` 里 ⇒ 读不到，返回 false —— 那是**我的测量口径问题**（`textContent`/展开后可读到完整原文，含 `pid 1798254`），**不是产品缺陷**。

## 4. `{slot}` 已用户化 —— PASS

`role="alertdialog"`，文案：`停止远端守护？ 该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。（影响：「debian-u8-1」上正在运行的 0 个会话）` + 按钮 `取消 / 确认停止`。
判定：`{slot}`/`slot`/`daemonPort`/裸 pid **全部 0 命中** ✓；后果三要素（影响谁=发行版、几个会话=0 个、之后怎么办=重新「启动守护」）✓。

## 5. 回归与 M/N 读数

| 项 | 读数 |
|---|---|
| 门禁 `css-token-audit.mjs` | `client/index.js`、`client.panel.js` **exit 0**（C1=0、C2 ⊆17 PASS、S1 OK） |
| CJK 门禁 | `client.panel.js` 剥注释后中文字面量 **0**（原始 982） |
| M1 | `/home/g/project` 下可见 `dsh1` **1 次**；T31 的注入对照（第二处 ⇒ 2）沿用 |
| M5 | 无守护 / 运行中 主视线术语 **0 命中**；stop 失败态主句 **0 命中**（错误/加载两态见 §8 未复核） |
| M14 | 宽 91==91；窄 320 104==104（`nowrap`，无省略） |
| M15 | 当前项 `border-left: 2px` + `font-weight: 600` |
| M16 | 单 `⋯`（窄态 `moreButtonCount=1`）；宽 **2 组** / 窄 **3 组**；组标题 `tabindex="-1"`；浮层不遮状态词（T31 读数） |
| M4/N3 | 底栏直接子节点 = `dot/statusword/extra/spacer/BUTTON(启动守护)/updated/BUTTON(⋯)` ⇒ 无破坏性动作 |
| `PANEL_LABEL_FALLBACK` | `client/index.js:39` 仅用于 `panel.title`、`tr()` 优先 `boot.i18n.t` ⇒ **有界**；**判别性不可测**（本机语言固定 `zh-CN`，fallback 与字典值同串）—— 按 GO 口径**如实标注，不强判** |

## 6. 故意红（3 条，全部副本制，vendor 只读 + 字节还原）

| # | 副本改法 | 红态读数 | 判定 |
|---|---|---|---|
| **A** | `client.panel.js` 条件改回 `if (!narrow && !primaryIsSession)` | 头部 = `[添加为 WSL 工作区, 添加为 WSL 工作区(--primary), 刷新]`，`dupLabels=["添加为 WSL 工作区"]` | **RED 成立** |
| **B** | `actionFailure` 里 `const notes = [];`（忽略 host notes） | 主句仍是用户语言，但**host 原文不可获取**（`hostRawRecoverable=false`） | **RED 成立** |
| **C** | i18n `confirm.stopTitle` 放回 `slot {slot} daemonPort {daemonPort}` | 确认框文案命中 `\{slot\|\bslot\b\|daemonPort` ⇒ 断言红 | **RED 成立** |

还原：副本目录/包/孤立家全部删除；vendor 三个改动点前后 `Contains` 复核为"未改"（含 `REVISION.txt` 收尾 `锚点一致=True`）。

## 7. 三档分类

**已实现且已验证**：chunk==磁盘证明（4/4）｜RED-1 三情形｜RED-2 两态｜`notes` 消费（route+面板）｜`{slot}` 用户化｜门禁（css-token-audit ×2 / CJK 0）｜M1｜M5（三态）｜M14（宽+320）｜M15｜M16｜M4+N3｜停止/重启二次确认（`alertdialog`）｜3 条故意红。
**已实现未自证（我未实测）**：M6（错误态事实节点数）｜M7（空态下一步控件）｜M8（T31 测过 1/1，本轮未重跑）｜M11｜M12④（空列表 `recent.empty`）｜M17（三背景 hover 两主题）｜N2（门禁级 shadow=0，未做视觉判定）｜N4 |N5 其它状态｜M15 强制置静息色｜M16 菜单文本色 == `label-primary`（`--dsw-alias-label-primary` 在 `documentElement` 读到空串，token 在别的 scope）。
**未实现 / 判红**：本轮**无**（RED-1/RED-2/notes/`{slot}` 四条均已修好且我独立验过；三条红都是我自己造的对照）。

## 8. 未复核项（不许当通过）

1. **M14 的 420 / 719 / 720**：`resize_page` 在本会话不改 `innerWidth`（仍 1869），只用 `emulate` 做了 **320** 与宽态。
2. **M5 的"错误态 / 加载中态"**：本轮只测了 无守护 / 运行中 / stop 失败三态（加载态在 T31 定格过）。
3. **M6/M7/M10/M11/M12④/M17/N4/N5 其它状态**：未构造对应夹具（M10 需 `others[]` 非空；M17 需 CDP 真实 hover）。
4. **M13 键盘 ↑↓/Backspace**：T31 我的 `KeyboardEvent` 派发未复现效果（Enter 生效），本轮未重试。
5. **`PANEL_LABEL_FALLBACK` 判别性回归**：语言固定 zh-CN ⇒ 不可判别（按 GO 口径如实标注）。
6. **chunk 机制的"跨页面加载缓存复用"**：我证明了**服务端返回==磁盘**（`no-store` 取证），未构造"只改 chunk 后二次加载命中 immutable 缓存"的实测（机制与响应头已证，但"浏览器真的复用了旧体"未实测）。
7. 像素截图未交（沿用 DOM 取证）；keys>0 / webHosts 非空 / desktop 宿主沿用历轮未复核。

## 9. 环境与纪律

- 每轮守护 `mode=systemd`（无 `compat-detached` 回退 ⇒ **无弹窗**）；`is-system-running=running`。
- 收尾：unit `stop`+**`reset-failed`**（units=0）、守护、包装层、profile、副本、`launch.*.sh`、临时家全清；端口 **8931–8936 全 0**。
- **用户全局 `~/.dsh/storages/workspace.json` 阴性对照：起手 `fc3eab1ade5d`/1 条 ⇒ 终态同值同条目**（全部操作在孤立 `DSH_HOME`）。
- **口径（对账）**：`arch-t2/tools/count-i18n-keys.mjs` 完整输出 = `"zh": {"keys": 219, "markedNew": 210}` / `"en": {"keys": 219, "markedNew": 210}` / `"paired": true` / `onlyZh=[] onlyEn=[]`。⇒ **脚本实测 219/语言**；GO（含补充消息）写的 **215** 与脚本差 4，**以脚本为准记 219**（两者都远大于 181 ⇒ 不影响任何判定；差异可能来自 215 取自更早时刻或另一种计数口径）。
- 用户宿主 19387（pid **47564**）与用户窗口 **47604** 未动；可见窗口终态 **10**，归属 **mine=0 / WT=0**（多出的 2 个不是我起的守护窗口 —— 我有 3 个 MCP 浏览器页，2 个后台；**无 WT 窗口 ⇒ 无守护弹窗**）。
- 我自己的 3 处仪器/口径失误留档：① chunk 比对用"字节数"差点误判（已改为"剥后缀比 SHA-256"）；② `hostRawRecoverable` 读折叠区 `innerText` 得假阴（已改 `textContent`/展开）；③ 点 `更多操作` 后立刻查 `[role=menu]` 偶发查不到（加等待即可）—— 都已更正。
