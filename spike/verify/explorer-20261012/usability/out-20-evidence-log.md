# out-20 —— task-5 原始证据流水（逐字，含时间戳）

> 为什么有这份文件：chrome-devtools-mcp 的 `filePath` 只能写它自己的 workspace root（实测我的写作用域与 `D:\project\net1` 都被拒），
> 所以观测值先**内联**返回、收工逐字落盘到这里。所有时间戳为 +08:00。
> 被测量：**修复前**的 client 半（`client/client.panel.js` = 29,111 B / `8F5CE575…`），见 `out-98-revision-freeze.txt`。

---

## 0. 实例与安全基线

| 项 | 值 | 来源 |
|---|---|---|
| 用户活宿主 | `127.0.0.1:19387` pid **47564**（开工 15:44 / 收工 16:22 均未变） | `out-10-livehost-baseline.txt`、收尾复算 |
| 我的测试实例 | `http://127.0.0.1:8961/?token=…`（pid 20384 持端口；15:47 起） | `out-04-url.txt`、`out-03-usabhost-8961.log` |
| 裸 `GET /` | **401** | 15:58 实测 |
| 带 token `GET` | **200**（len 34966） | 15:58 实测 |
| `GET /remote-wsl/api`（无 Origin） | **403** | 16:05 实测（同源闸门生效） |
| 我的 overlay | `distro=debian-u8-1 / wslHome=/home/g / cwd=/home/g/project/dsh1 / daemonPort=8962`；`--dump-config` exit 0，第 1282–1289 行 | `out-11-dumpconfig-_home_g_project_dsh1.txt` |
| 启动形态 | `dsh.cmd --profile remote-wsl-test --patch <yml> --port 8961 --no-open`（**不能**再加 `web`：实测 `error: too many arguments. Expected 0 arguments but got 1: web.`） | `out-03-usabhost-8961.log.err`（首次尝试） |

---

## 1. 首挂载加载态（**F34 的直接证据**）

15:59，点 rail 图标后**立即**取 a11y 快照，同一时刻同时存在：

```
uid=3_5 StaticText "正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…"
uid=3_6 StaticText "数据不可用：读取失败后已撤下，不显示守护/漂移状态。"
uid=3_7 StaticText "尚未取得快照"
uid=3_1 StaticText "尚未取得目标发行版"
uid=3_3 combobox "WSL 目标" [disabled]
```

⇒ 正常首挂载期间（尚未失败、也无旧数据），底栏已断言「读取失败后已撤下」。**F34**：把"没发生的失败"当成事实说出口。
（同一字符串在**真失败**态也会出现，见 §4；这正是它误导的原因。）

对照：16:00:38 同一面板转为 ready：

```
uid=3_1 StaticText "目标 debian-u8-1 · /home/g/project/dsh1"
uid=4_8 StaticText "daemon slot 8932 · :8932 · pid 909039 · 0.2.0-rc.2 · keys 0"
uid=3_7 StaticText "快照 16:00:38"
```

---

## 2. S-BASE 动作序列（逐步，含真实计数）

注入的计/录探针：`usab-instrument.js`（`click`/`keydown` 捕获 + `fetch` 包装）。

| 步 | 实际操作 | 结果 | 证据 |
|---|---|---|---|
| A1 | 点 rail 图标 `button "远程资源管理器"`（trusted click） | `main` 面板上屏；标题「远程资源管理器」+ 副标题「目标 debian-u8-1 · /home/g/project/dsh1」 | 15:58 a11y（uid=3_0/3_1）、`shot-02b-after-click.png` |
| A2 | 在树里看 `dsh1` 行 | `▾ debian-u8-1 [默认发行版][运行中 · 1 路径][当前目标]` → `📁 dsh1 /home/g/project/dsh1` | `out-12-raw-dom.json` |
| A3 | 点 `button "在远端会话中打开 /home/g/project/dsh1（首次发消息时才物化会话）"`（trusted click） | POST `explorer.openSession {distro,path}` → 随后 POST `explorer.snapshot`；**界面无任何可见反馈**（见 §3） | 16:13:15 探针、§3 |
| A4 | 读动作结果条 | **不存在**（`noteRect=null`、MutationObserver 0 次插入） | §3 |
| A5 | 让会话真正物化：切到会话面板 + 发一条消息 | **未实测**（不烧模型调用/不建会话）；按 UI 自身文案"首次向该会话发消息（wsl_agent 轮次）时才会物化" ⇒ +3 动作 | 设计 §4 末条 + 面板动作文案 |

**动作数**：观测到 **2 次点击**（A1+A3，均 trusted），探针 `clickCount=2`；把 A5 按界面自己的说明计入 ⇒ **现实 5 动作**，同口径 VS Code（Remote Explorer→「在当前窗口中连接」）**2 动作**。
**请求**：4 条，全部同源 POST（无模型调用、无跨源请求）：
```
{"method":"explorer.openSession","args":{"distro":"debian-u8-1","path":"/home/g/project/dsh1"}}
{"method":"explorer.snapshot","args":{}}
（同样两条重复一次 —— 我点了两次 A3 以确认可复现）
```
`errors: []`（全程无 window error / unhandledrejection）。

---

## 3. A3 的"零反馈"证据（MutationObserver）

16:13:42 安装 observer：
```
() => { window.__USAB_NOTES__=[]; … observe(document.body,{childList:true,subtree:true}) … }
→ {"installed":true,"at":"2026-10-12T08:13:42.632Z","existingNote":false}
```
16:13:58 点 A3；16:14:05 读：
```json
{"at":"2026-10-12T08:14:05.820Z","noteLifecycle":[],"currentNote":null,
 "clickCount":2,
 "requests":[openSession, snapshot, openSession, snapshot],
 "errors":[],"anyErrorState":false,
 "statusText":"daemon slot 8962 · :8962 · pid 930015 · 0.2.0-rc.2 · keys 0"}
```
⇒ 两次点击主行动，结果条 `.dsh-rw-note` **一次都没有进入 DOM**。与代码一致：`run()` 成功时 `setAction({note})`，紧接着 `if(options.refresh) load()`，而 `load()` 开头 `setAction({busy:null,note:null,error:null})` ⇒ 同一次 React 批里被清掉。
**副作用**：`explorer.openSession` 的幂等 ensure 在 WSL 侧起了守护 —— 状态条从 `slot 8982` 变成 `slot 8962`（我配置的槽位，pid 930015）。界面对"起了个守护"也只字未提。

---

## 4. 注入夹具：错误态 / 空态（页面内 fetch 拦截，不改被验对象）

### 4.1 错误态（模拟 `/remote-wsl/api` 不可达）16:18

```
uid=11_1 "目标未知（读取失败）"
uid=11_5 alert [live=assertive] "读取远程资源失败（当前没有可用数据）"
uid=11_7 "无法连接 host 侧 explorer 路由 /remote-wsl/api：usab-injected: 模拟 explorer 路由不可达"
uid=11_8 "出口：/remote-wsl/api　类型：transport"
uid=11_9 button "重试读取 explorer.snapshot"
uid=11_10 "尚未成功读取过任何快照。"
uid=11_11 "数据不可用：读取失败后已撤下，不显示守护/漂移状态。"
uid=11_3 combobox "WSL 目标" [disabled]
```
⇒ **M5 通过**：有原因 + 有可点的下一步（重试）+ 事实（守护/树）整体撤下，没有把"读不到"说成"未运行"。
   遗留：正文暴露 `explorer.snapshot`/`/remote-wsl/api`/`transport` 这类内部词；下一步只有"重试"，没有"换一条路"（如查看日志/版本不匹配）。

### 4.2 空态（注入 `distros:[]` 的快照）16:20

```json
{"emptyPresent":true,
 "emptyText":"wsl.exe -l -v 没有返回任何发行版（WSL 未安装，或没有已安装的发行版）。",
 "emptyHasButtonInside":false,
 "allButtons":[{"text":"刷新"},{"text":"启动守护"}],
 "bodyText":"wsl.exe -l -v 没有返回任何发行版（WSL 未安装，或没有已安装的发行版）。 原始 snapshot（与 wsl_status 同源）",
 "footerText":"daemon 未运行 启动守护 快照 16:20:48"}
```
⇒ 空态**只陈述事实**，没有可照做的下一步（没有 `wsl --install -d <发行版>` 这类命令，也没有指向设置的出口）。
   （注：我的探针正则因文本含 `wsl.exe` 把 `hasActionableNextStep` 误判为 true —— 以上面的人工判读为准：**无下一步**。）

---

## 5. M6 二次确认（我自己的 8962 槽位）16:14

1) 16:14:2x 点 `button "停止守护 slot 8962（需二次确认，仅此槽位，没有 all）"` → 弹层：
```
uid=9_0 "确认停止守护？slot 8962（本插件自有槽位，不存在 all 选项）"
uid=9_1 "后果：该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。　当前该槽位 keys/session = 0。"
uid=9_2 button "确认停止守护 slot 8962" / uid=9_3 button "取消停止守护"
role="alertdialog" aria-label="停止守护确认"
```
2) 确认前读探针：`daemonRequestsSoFar: []`（只有 2×openSession + 2×snapshot）⇒ **点"停止"本身不发请求**（真确认，不是装饰）。
3) 16:14:5x 点「取消」后：
```json
{"confirmPresentAfterCancel":false,"anyDaemonRequest":0,"statusText":"daemon slot 8962 · :8962 · pid 930015 · … · keys 0"}
```
4) 独立复核（WSL 侧）：`/home/g/.dsh/remote-wsl/daemon.8962.json` 仍存在且 `ss` 仍有 8962 监听 ⇒ **取消确实什么都没发生**。
⇒ **M6 通过**（"先确认 / 讲清后果含 slot 与会话数 / 取消无副作用"三条齐）。
   **未测**：最终按「确认停止」的破坏性路径（不做，避免停他人守护；且 lead 已叫停新增测项）。

---

## 6. 跨槽位错显（守护状态条指向**别的实例**的守护）

| 时刻 | 面板显示 | 该槽位归属 |
|---|---|---|
| 16:00:38 | `daemon slot 8932 · :8932 · pid 909039 · 0.2.0-rc.2 · keys 0` | T4（`remote-wsl-test-web` 的 daemonPort=8932） |
| 16:09:29 / 16:12:19 | `daemon slot 8982 · :8982 · pid 917590 · …` | T7（task-7 端口段 8981–8990） |
| 16:13:58 起 | `daemon slot 8962 · :8962 · pid 930015 · …` | **我**（配置 daemonPort=8962，被 A3 的 ensure 拉起） |

我的实例配置是 **8962**（`out-11-dumpconfig-*.txt` 第 1282–1289 行可复算）。⇒ 状态条取的是"扫描到的第一个运行中槽位"（`src/explorer.ts:215-227` 用 `daemonSnapshot(cfg)` 的 `live[0]`），**不是本实例配置的槽位**。
而按钮文案同时声称「**本插件自有槽位**，不存在 all 选项」「仅此槽位」——**在自己并不拥有的守护上做出所有权声明**。
WSL 侧同时存在：`daemon.8962.json`(9,30015) 与 `daemon.8982.json`；8932 在 16:05 已消失（T4 侧变化）。

---

## 7. 截图（3 张，全部在 `usability/`）

| 文件 | 内容 | 怎么来的 |
|---|---|---|
| `shot-01-rail-collapsed.png` | 侧栏折叠态（headless 浏览器视口） | `chrome-devtools-mcp take_screenshot`（15:57，可用期） |
| `shot-02a-rail-before-click.png` | 带标签的侧栏：可见「插件」「**远程资源管理器**」两行 | cua `get_window_state(pid=3364,screenshot_out_file=…)`（OS 级抓窗口） |
| `shot-02b-after-click.png` | **面板展开（light）**：标题行 + 树（dsh1）+ 折叠的原始 snapshot + 底栏 `daemon slot 8962 …` | 同上，16:19 |

> 环境异常（**不归因面板**）：16:05–16:18 期间 `chrome-devtools-mcp take_screenshot` 对**应用页**持续超时（同页 `evaluate_script`/`take_snapshot` 正常、`about:blank` 截图正常），故改用 OS 级窗口抓取。另：tab2 在 15:57 之后失联（渲染进程忙），换 tab3 后**同一操作全部复现成功**，且 tab3 面板全程响应 ⇒ 不作为面板缺陷，列入未核实。

---

## 8. 收尾（自造物清理 + 前后对照）

| 动作 | 结果 |
|---|---|
| 停我的 8962 守护（只 kill 该槽位 pid 930015） | `ss` 8962 监听 = 0；`daemon.8962.json` 被守护自身清理 |
| 停我的测试实例 8961 | 端口 8961 无残留监听；wrapper cmd 亦已退出 |
| 关我启动的 Chrome（`--user-data-dir=…\Temp\usab-chrome-profile`） | 已关（命令行校验过是我的） |
| 用户活宿主 19387 | pid **47564**，开工/收工一致 |
| 我启动的 Chrome 用的隔离 profile | 位于 `%TEMP%\usab-chrome-profile`，未触碰用户 profile |
| revision 首尾复算 | **变了**：`client/client.panel.js` 29,111→**32,377 B**（`8F5CE575…`→`D5F236A0…`），复算时刻 16:22:23 ⇒ 修复在观测之后落地，须 delta 复验（见报告 §0） |
