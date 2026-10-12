# REPORT-usability-delta —— 对**修复后** revision 的窄范围 delta 复验（task-5）

> **范围**：只复验 lead 指定的 5 条（F34/F36/F35/跨槽位所有权/M6+aria）。**不重跑全矩阵**：
> `REPORT-usability.md` 里其余结论（D3–D7 可发现性清单、动作数对比、缺口 G-1…G-6、dark 主题未测等）**仍只对修复前 revision 成立**，本文件不改变它们。

- **评估者**：`usability-engineer` ｜ **触发**：lead 的 delta 指令（2026-10-12 16:33）
- **新锚点（复验期间稳定）**：`client/client.panel.js` = **34,915 B / `BB0A24BABCF581D40CC00921B468B072E4ABFA0E903F3D3C076C7FF7A3E52ABF`**、`client/index.js` = **14,841 B / `62AB2F0C799D33541A645E607D5FCF9E8D6BD3036BDB44F371C82F6212501264`**（`src/explorer.ts` 34,016 B、`src/daemon-client.ts` 37,581 B）
  → `out-98-revision-delta-freeze.txt`（16:33:45）vs `out-98-revision-delta-end.txt`（16:39:32）：**13 锚点逐字相同**（仅时间戳行不同）⇒ 复验有效
- **实例**：`http://127.0.0.1:8961`（profile `remote-wsl-test` 只读 + 我的 `--patch`：`cwd=/home/g/project/dsh1`、`daemonPort=8962`）｜ 观测窗口 **16:34–16:39**
- **用户活宿主 19387**：全程 pid **47564**（未碰）

---

## 0. 五条结论一览

| # | 项 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | **F34** 首挂载误报 | ✅ **PASS** | 加载窗口 204–2041ms 底栏只有「正在读取守护与漂移状态…」，**0 条**含"已撤下/数据不可用"的样本；2244ms 转 ready |
| 2 | **F36** 主行动零反馈 | ✅ **PASS** | `role=status` 结果条从 **ms=0 连续存在到 5082ms**（采样结束），期间底栏快照已刷新到 16:35:58；截图 `shot-13` 可见 |
| 3 | **F35** 路径 RTL | ✅ **PASS** | 我自己的量法：逐字符 `Range.getBoundingClientRect()` ⇒ 首字符 `/` 在最左（x=380），x 单调递增到 x=492.1；计算样式 `direction: ltr` / `unicode-bidi: plaintext`；截图 `shot-12/13` 肉眼可核 |
| 4 | 跨槽位误导性所有权 | ✅ **PASS** | 原始快照 `daemon` = **仅配置槽位 8962**，另槽位进 `daemon.others[]`；面板可交互控件里**没有任何**指向 8731/8972/8982 的按钮；只读区块原文「其它槽位的守护（只读：本面板不会对它们发起任何动作）」；文案改为「本插件**配置的**槽位」 |
| 5 | **M6** 二次确认 + aria 不退化 | ✅ **PASS** | 点「停止」→ `role=alertdialog`，**确认前 `explorer.daemon` 请求数 = 0**；取消后弹层消失、请求仍 = 0、WSL 侧 `daemon.8962.json` pid 963733 仍在；`titleOnly=0 / unnamed=0`（7 控件），rail 名＝「远程资源管理器」 |

---

## 1. F34 —— 首挂载不再误报（逐条原始输出）

方法：注入 1.8s 的 snapshot 响应延迟（**夹具，不改被验对象**）+ 面板出现后每 200ms 采样 4.4s。
（首次尝试用 initScript 装采样器失败——采样窗口在我点击前就跑完了，`panelFirstSeenMs: null`，**该次 PASS 为空判，已作废并重做**。）

重做后 22 个样本，加载期行（节选）：

```json
{"ms":204,"panel":true,"status":"尚未取得快照：正在读取守护与漂移状态（超时 9000ms）… 尚未取得快照",
 "hint":"正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…","error":null,"hasTree":false,
 "subtitle":"尚未取得目标发行版"}
```

- `rowsShowingLoading`: 204/406/610/815/1023/1226/1430/1634/1835/2041 ms —— 共 10 行
- `rowsWithFalseFailureClaim`: **[]**（判据：加载期 footer 含"已撤下/数据不可用"或出现 `.dsh-rw-error`）
- ready 行 @2244ms：`status:"daemon 未运行 启动守护 快照 16:35:29"`、`hasTree:true`、`subtitle:"目标 debian-u8-1 · /home/g/project/dsh1"`
- **verdict**：`PASS: 首挂载期间只有"正在读取…"，没有出现"读取失败/已撤下/数据不可用"`

> **残留小瑕（非本次 5 条，供参考）**：加载期底栏把戳记拼了两次 —— 「**尚未取得快照**：正在读取守护与漂移状态（超时 9000ms）… **尚未取得快照**」。控件级改进：`statusLeft` 只放状态句，戳记只由右侧 `stamp` 渲染一次。

---

## 2. F36 —— 结果条可见且不被刷新清空

方法：trusted click「在新会话中打开」→ 之后每 200ms 采样 5.2s。

- `firstNoteMs: 0`、`lastNoteMs: 5082`（采样结束仍在），26/26 个样本都有结果条
- `noteRole: status`、`distinctNoteTexts` 只有 1 条（内容稳定、未被刷新抹掉）
- 同一时刻底栏已推进到 `daemon slot 8962 · :8962 · pid 963733 · 0.2.0-rc.2 · keys 0 … 快照 16:35:58` ⇒ **刷新确实发生了，但结果条活着**
- 视觉证据：`shot-13-delta-note-visible.png`（结果条为带边框的独立块，底栏时间 16:38:33，说明截图时也已刷新过）
- **verdict**：`PASS: 结果条出现且持续到采样结束（≥4s）`

> **残留（内容层，非机制层）**：结果条正文把 host 侧 note 原样透传，出现 `上游 daemon`、`runtime+sessionId`、`本方法`、`openSession({warm:true})` 这类**面向实现者**的词。
> 控件级改进：`openSessionNote()` 里对 `result.note` 做一次"人话化"（或只保留首句「远端会话尚未建立（目标 cwd=…）：首次发消息时才会物化」），把后面那段移进 `title`/折叠区。

---

## 3. F35 —— 路径视觉顺序（我自己的量法）

方法：定位文本恰为 `/home/g/project/dsh1` 的最内层元素（`span.dsh-rw-workspace-path`），用 `Range` 逐字符取矩形，比较**逻辑索引 vs x 坐标**。

```json
{"element":{"tag":"span","cls":"dsh-rw-workspace-path","text":"/home/g/project/dsh1"},
 "computed":{"direction":"ltr","unicodeBidi":"plaintext","textAlign":"left"},
 "charCount":20,"sameLineCount":20,
 "firstChar":{"logical":0,"ch":"/","x":380,"y":103},
 "leftmostChar":{"logical":0,"ch":"/","x":380,"y":103},
 "lastChar":{"logical":19,"ch":"1","x":492.1,"y":103},
 "indexOrderMatchesVisualLTR":true,"leadingSlashIsLeftmost":true,
 "verdict":"PASS: 首字符 \"/\" 位于最左，逐字符 x 单调递增（视觉左→右）"}
```

- 与修复前对照：旧版 CSS 为 `direction: rtl`，渲染成 `home/g/project/dsh1/`（旧证据 `shot-02b-after-click.png`）；现在 `shot-12/13` 里肉眼是 `/home/g/project/dsh1`。
- **残留小瑕（可选加固）**：`unicode-bidi: plaintext` 让方向**由内容首强字符决定**；本路径以中性字符 `/` 开头后接 LTR，本例正常。若哪天 label/路径以强 RTL 字符开头，仍可能翻向。建议 `direction: ltr; unicode-bidi: isolate`（对本地化更稳）。

---

## 4. 跨槽位所有权 —— 原始快照 + 控件清单

同源直取（页面自己的 `fetch`，带 Origin）`explorer.snapshot`：

```json
{"daemon":{"running":true,"slot":8962,"pid":963733,"port":8962,"version":"0.2.0-rc.2","keys":[],"orphans":0,
  "others":[{"slot":8731,"pid":944726,"port":8731,"version":"0.2.0-rc.2","note":"非本槽位（configured daemonPort=8962）；未复用、未打扰"},
            {"slot":8972,"pid":964933,"port":8972,"version":"0.2.0-rc.2","note":"非本槽位（configured daemonPort=8962）；未复用、未打扰"}]},
 "topLevelKeys":["distros","target","daemon","drift","workspaces","webHosts"]}
```

- **配置槽位 = 8962**（`out-11-dumpconfig-*.txt` 第 1282–1289 行），`daemon` 段只报它；另两个槽位（8731 默认槽、8972）在 `others[]` 里，各带一行 note。
- 可交互控件清单（7 个）里，凡提到 slot 号的只有两条，**都指向 8962**：
  `{"text":"重启…","aria":"重启守护 slot 8962（需二次确认）"}`
  `{"text":"停止 slot 8962…","aria":"停止守护 slot 8962（需二次确认，仅此槽位，没有 all）"}`
- `otherSlotActionButtons: []` ⇒ **没有任何指向别槽位的动作按钮**
- 只读区块原文（`shot-12/13` 可见）：「其它槽位的守护（只读：本面板不会对它们发起任何动作）　slot 8731 · :8731 · pid 944726 · 0.2.0-rc.2　非本槽位（configured daemonPort=8962）；未复用、未打扰」
- 文案对比：旧 `title`＝「只停止 slot N（本插件**自有**槽位）」→ 新 `title`＝「只停止 slot N（本插件**配置的**槽位）」⇒ 所有权表述与真实语义一致了
- **verdict**：`PASS: 面板里没有指向别槽位的可交互控件 | daemon段=slot 8962 running=true`
- 观察（不影响判定）：`others[]` 是**快照时刻**的读数，随刷新才更新；同一分钟内新鲜 fetch 返回 8972，而面板（快照 16:35:58）仍显示 8982/961517 ⇒ 只读区块可能短暂列到已消失的槽位。控件级改进：给只读区块加「按刷新更新」提示，或与主刷新一起重取。

---

## 5. M6 二次确认 + aria 不退化

1. 点 `button "停止守护 slot 8962（需二次确认，仅此槽位，没有 all）"` → 弹层：
```json
{"confirmPresent":true,"confirmRole":"alertdialog",
 "confirmText":"确认停止守护？slot 8962（本插件配置的槽位，不存在 all 选项） 后果：该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。 当前该槽位 keys/session = 0。 确认停止 取消"}
```
2. **确认前**：`daemonRequestsBeforeConfirm: []`（当时 `serviceRequestsBeforeConfirm` 只有我自己那次 `explorer.snapshot` 探测）⇒ 点「停止」**不预发**请求
3. 点「取消」后：
```json
{"confirmGoneAfterCancel":true,"daemonRequestsTotal":0,
 "status":"daemon slot 8962 · :8962 · pid 963733 · 0.2.0-rc.2 · keys 0 …","noteStillPresent":true,
 "verdict":"PASS: 取消后弹层消失且未发出任何 explorer.daemon 请求"}
```
4. 独立复核（WSL 侧）：`daemon.8962.json` **pid=963733 仍在**、`ss` 仍有 8962 监听 ⇒ 取消真的什么都没发生
5. aria 不退化：面板可交互控件 **7 个、`titleOnly=0`、`unnamed=0`**（来源 6×aria-label + 1×text）；rail 可访问名＝「**远程资源管理器**」（aria 与文本都对）
6. **未测**：最终按「确认停止」（破坏性路径，刻意不点）

---

## 6. 证据文件（本目录新增）

| 文件 | 内容 |
|---|---|
| `out-98-revision-delta-freeze.txt` / `-delta-end.txt` | 复验首尾锚点（13 条逐字相同） |
| `shot-11-delta-pre.png` | Chrome 窗口：带标签侧栏（进入面板前） |
| `shot-12-delta-panel-open.png` | **F35 + 项4 的视觉证据**：路径 `/home/g/project/dsh1`（左斜杠在最左）＋ 只读"其它槽位的守护"区块（无按钮） |
| `shot-13-delta-note-visible.png` | **F36 的视觉证据**：可见结果条在框内，底栏已刷新到 16:38:33 而结果条仍在 |
| （本轮 DOM/探针原始值） | 见本文件各节逐字 JSON；采集脚本同 `usab-*.js`（MCP 的 `filePath` 写不进本目录，故逐字落盘到本文件） |

## 7. 收尾（前后对照）

| 动作 | 结果 |
|---|---|
| 停我的 8961 实例 | 端口 8961 free |
| 停我的 8962 守护（只 kill 该槽位 pid 963733） | 我这一槽位的 json/token 已被守护自身清理；**8731 / 8972 等他人槽位一律未动**（state 目录仅剩它们） |
| 关我启动的 Chrome（`…\Temp\usab-chrome-profile2`） | 已关（命令行校验过是我的） |
| 用户活宿主 19387 | pid **47564**，开工/收工一致 |
| 复验期间 revision | 13 锚点**未变**（仅时间戳行不同） |
