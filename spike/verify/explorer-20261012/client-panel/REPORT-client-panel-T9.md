# T9 —— client 半缺口修复报告（F34 / F25 / F35 / F36 + T8 语义跟随）

- **日期**：2026-10-12 ｜ **角色**：client-panel（task-3 / task-9）
- **写作用域**：`client/`（`index.js`、`client.api.js`、`client.icon.js`、`client.panel.js`）—— 未碰 `src/`、`package.json`、`docs/`
- **测试实例**：`dsh --profile remote-wsl-test --port 3091 --no-open`（**不带 web token**；进程命令行已核对 = 测试 profile），浏览器经 chrome-devtools MCP 操作该实例。
  - ⚠️ 该 profile 的 bundles 被我从 `dsh-headless` 换成 `@deepseek-ai/dsh-web-app`（`dsh-headless` 自述 "mounts no Host, HTTP server, Web runtime" ⇒ 与浏览器 UI 互斥）；原文件备份在 `C:\Users\l\.dsh\profiles\remote-wsl-test\package.json.bak-headless-20261012`。
  - 用户正在用的宿主（GUI :19387）**未被触碰**；测试实例用端口 3091，全程未 `pkill`、未 `npm/pnpm install`。

---

## 0. 交付前状态：改动清单

| 文件 | 改动 | 对应缺口 |
|---|---|---|
| `client/client.panel.js` | 状态条第 1 分支从 `!factsVisible` 收紧为 `status === 'error'`；新增"尚未取得快照：正在读取…"中性分支 | **F34** |
| `client/client.panel.js` | `run()` 按 `result.ok === false` 分支渲染失败（只有**显式 false** 才算失败；`openSession` 结果没有 `ok` 字段）；失败给原因 + 「重试」按钮（`aria-label="重试上一个失败的动作"`，靠 `lastRun` ref 记住上一次动作）；`actionFailureText()` | **F25** |
| `client/client.panel.js` | 动作结果条与随后的 `snapshot` 刷新**解耦**（`load()` 不再清 note；只在读取失败时撤下"成功口吻"的 note，保留失败结论+重试） | **F36** |
| `client/index.js` | `.dsh-rw-workspace-path` 从 `direction:rtl` 改为 `direction:ltr;unicode-bidi:plaintext;text-align:left`；并把 `.dsh-rw-pre/.dsh-rw-note/.dsh-rw-error-body/.dsh-rw-confirm-body/.dsh-rw-hint/.dsh-rw-other-note` 一并显式 LTR | **F35 + 自查** |
| `client/client.panel.js` | 新增 `daemon.others[]`（T8 加法字段）**只读**分组，容错 undefined/缺 note；**零动作按钮** | T8 语义 |
| `client/client.panel.js` | 所有权文案改成"本插件**配置的**槽位"；`停止/重启` 仅当 `running===true && slot!==null` 才渲染，目标恒为 `snapshot.daemon.slot` | T8 语义 + T5 的误导性所有权 |
| `client/index.js` | 新增 `.dsh-rw-others*` 样式（只用主题 token） | 同上 |
| `client/client.panel.js` | 守护动作成功结论带 slot/port/pid（`daemonNote()`），`启动中…/停止中…/重启中…/修复中…` 可见进行态 | T5 的"可见反馈" |

---

## 1. F34 —— 首挂载误报"读取失败后已撤下"

**改前（reliability-keeper 实测，不是我复述）**：`spike/verify/explorer-20261012/reliability/out-A-01c-initial-load-false-claim.json`
```
uid=2_5 StaticText "正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…"
uid=2_6 StaticText "数据不可用：读取失败后已撤下，不显示守护/漂移状态。"
uid=2_7 StaticText "尚未取得快照"
```
同一时刻其实 `status='loading'` 且从未失败；紧接着 reqid=43 返回 200。

**改后（本人实测，把首挂载的快照请求挂在 fetch 层，稳定观察 loading 窗口）**：
```json
"firstMount":{"bodyText":"正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…",
 "statusBar":"尚未取得快照：正在读取守护与漂移状态（超时 9000ms）…\n尚未取得快照",
 "hasLoadingHint":true,"hasFalseUnavailableClaim":false,"hasErrorBox":false}
```
`hasFalseUnavailableClaim` 由 `true` → `false`；同一渲染里不再出现"已撤下"。

---

## 2. F25 —— `fixPin` 回 `{ok:false}` 仍按成功语气

**改前**：`spike/verify/explorer-20261012/reliability/REPORT-reliability.md:140` —— *"`describe` 忽略 result，恒报「已请求修复 version pin（不自动杀守护）。」⇒ 失败也显示成功语气"*。

**改后（注入桩：HTTP 200 + `{ok:false}`，与 host 真实形状一致 —— `src/explorer.ts:414-420` 的 fixPin 返回 `{ok:false,error,pinBefore,pinAfter,wrote:false}`）**：
```json
"fixPinFailure":{"text":"失败：桩：pin 写入失败（模拟 host 用 200 回 ok:false）（未写入） pin: 0.1.0 → 0.1.0 重试",
 "isError":true,"role":"alert",
 "retryButton":[{"text":"重试","aria":"重试上一个失败的动作"}]},
"fixPinRetryCalls":2
```
- `role=alert` + `--error` 样式 + 原因 + 重试入口；点"重试"真的重发（计数 1 → 2）。
- **同类一并修**：`run()` 里的判定对**所有动作**生效（`explorer.daemon`、`explorer.openSession` 同一条路径）；因为 `openSession` 结果里没有 `ok` 字段，判定用**显式 `ok === false`**，不会把"没有 ok"误判成失败。

---

## 3. F36 —— 主行动零可见反馈（结果条被自己触发的刷新清空）

**改前**：usability-engineer 实测 `openSession`+`snapshot` 两条 POST、0 error，但 MutationObserver 全程 0 插入（`noteLifecycle: []`）。
根因：`load()` 开头 `setAction({busy:null,note:null,error:null})`，而动作成功后会带 `refresh:true` 调 `load()` ⇒ 同一次批里把刚写的结果条清掉。

**改后（真实点击「在新会话中打开」，非桩）**：
```json
"mutationsWhileAction":7,
"requests":[{"method":"explorer.openSession","args":{"distro":"debian-u8-1","path":"/home/g"}},
            {"method":"explorer.snapshot","args":{}}],
"noteRightAfter":{"text":"远端会话尚未建立（目标 cwd=/home/g）：首次向该会话发消息（wsl_agent 轮次）时才会物化。 …","role":"status","isError":false},
"noteStillThereAfter4s":{"text":"（同上，仍在）","isError":false}
```
结果条出现、且**在随后的 snapshot 刷新之后仍在**（4.2s 后复查仍在），插入数 0 → 7。

守护动作的成功反馈同样可见（真实 host）：`已启动守护` → 状态条 `daemon slot 8731 · :8731 · pid 944726 · 0.2.0-rc.2 · keys 0`（pid 为真实新进程）。

---

## 4. F35 —— 路径被按 RTL 渲染

**改前**：usability 实测 `/home/g/project/dsh1` 显示成 `home/g/project/dsh1/`（DOM 文本对，是渲染方向错）。旧规则 `direction:rtl`（无 `unicode-bidi`）。

**改后（长路径桩 + Range 矩形度量，证明的是**视觉顺序**而不只是声明值）**：
```json
"pathText":"/home/g/project/dsh1",
"fixed":{"direction":"ltr","unicodeBidi":"plaintext","firstCharLeft":380,"lastCharLeft":492,"readsLeftToRight":true},
"beforeEquivalent":{"direction":"rtl","unicodeBidi":"normal","firstCharLeft":435,"lastCharLeft":429,"readsLeftToRight":false},
"rtlButPlaintext":{"direction":"rtl","unicodeBidi":"plaintext","firstCharLeft":321,"lastCharLeft":433,"readsLeftToRight":true}
```
- 首字符 `/` 的 x 座标 < 末字符 `1` ⇒ **从左到右**（改后）；"改前等价规则"下首字符在右（435 > 429）⇒ 复现了那个翻转。
- 附带发现：`unicode-bidi:plaintext` 单独就足以让路径按内容方向渲染（即使容器是 rtl）⇒ 该修复有双重保险。
- 自查：`select`/`pre`/`note`/`error-body`/`confirm-body`/`hint`/`other-note` 全部显式 LTR（`dir=ltr` 已逐项打印）。

---

## 5. T8 语义跟随：`daemon.others[]` 只读、动作只打配置槽位

**真实快照（非桩）**：
```json
"daemon":{"running":true,"slot":8731,"pid":944726,"port":8731,"version":"0.2.0-rc.2","keys":[],"orphans":0,
 "others":[{"slot":8932,"pid":750364,"port":8932,"version":"0.2.0-rc.2","note":"非本槽位（configured daemonPort=8731）；未复用、未打扰"},
           {"slot":8912,"pid":747406,"port":8912,"version":"0.2.0-rc.2"}]}
```
**面板渲染（真实数据）**：
```json
"realOthers":{"text":"其它槽位的守护（只读：本面板不会对它们发起任何动作）\nslot 8932 · :8932 · pid 750364 · 0.2.0-rc.2\n非本槽位（configured daemonPort=8731）；未复用、未打扰\nslot 8912 · :8912 · pid 747406 · 0.2.0-rc.2\n非本槽位；未复用、未打扰",
 "buttonsInside":0}
```
- `others[]` 里**一个 button 都没有**（`buttonsInside:0`）；第二条缺 `note` ⇒ 回落默认文案（容错已被真实数据覆盖）。
- 动作目标唯一：状态条只对 `snapshot.daemon.slot`（8731）给"停止/重启"，且先弹 `role=alertdialog` 二次确认：
  ```
  确认停止守护？slot 8731（本插件配置的槽位，不存在 all 选项）
  后果：该槽位上的守护会被关掉，正在跑的会话全部中断、上下文丢失；之后需要重新「启动守护」。　当前该槽位 keys/session = 0。
  ```
- **host 的可读 400（T8）能渲染成提示而非白屏/成功语气**（桩体逐字取自真实响应）：
  ```
  失败：remote-wsl: slot 8932 不是本插件配置的槽位（8932≠8731）；本插件只操作自己的槽位   重试
  ```
  （真实响应实测：`HTTP 400 {"ok":false,"error":"remote-wsl: slot 8932 不是本插件配置的槽位（8932≠8731）；本插件只操作自己的槽位","code":"E_ARG"}`）
- 同一脚本复查真实守护**未被动过**：`{"running":true,"slot":8731,"pid":944726,...}`。

---

## 6. 三态 / 超时 / Abort / 乱序保护（回归自查）

| 场景 | 注入 | 结果（原始输出摘要） |
|---|---|---|
| 首挂载 → 失败 → 重试成功 | fetch 永不 settle（signal-faithful） | 首挂载只显示"正在读取…"；约 9s 后 `读取远程资源失败（当前没有可用数据：请求超时）… 类型：timeout 重试`；点重试 → `factsBack:true` |
| 非 200 | HTTP 500 + `{ok:false,error}` | `读取远程资源失败（当前没有可用数据）\n桩：host 500 …\n出口：/remote-wsl/api　类型：host\n重试`，`retryButtons:1`，状态条 `数据不可用：读取失败后已撤下…` |
| 挂载/卸载监听器 | 每轮 插件 ↔ 远程资源管理器 | `+AbortSignal|abort = 2` / `-AbortSignal|abort = -2`（**我加的 abort 监听 1:1 平衡**）；另有 React 给 `<select>`/`<details>` 装的非委托监听各 +1/轮，宿主节点随卸载销毁 ⇒ 存活 DOM 计数 `{selects:1, details:1, panels:1}`（8+ 轮切换后仍为 1，无累积）。对照组（插件↔会话，不挂我的面板）`added:0 removed:0` |

---

## 7. light / dark（各一次，改后）

| token | light | dark |
|---|---|---|
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | `#fff` | `#2c2c2e` |
| `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` |
| `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |
| `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |

两种模式下面板根/标题/副标题/链接/状态条/状态点/路径/others 分组的 `color`、`background` 都随 token 变化，且**方向恒为 `dir:ltr`**。无硬编码颜色（CSS 里只出现 `var(--dsw-*)`）。

## 8. 可访问性不退化（T5 的 M6/D1）

面板内 6 个按钮逐一审计：`aria` + `title` **全部存在**，`buttonsMissingBothAriaAndTitle: []`；rail 可访问名仍为「远程资源管理器」。危险动作为 `role=alertdialog` 的二次确认（确认前 0 条 daemon 请求、取消后 0 条、守护完好）。

---

## 9. 未核实 / 已知残留

1. **热更**：client 半改动是否需要 `pnpm run dev:web` 才能热更，本轮**未实测**（我一律用"入口 mtime 变更 → rev 变化 → 重启测试实例"验证；重启用户宿主不在授权内）。`dsh-client-hmr` 在 boot graph 里，但未验证 chunk 内容变更会不会自动换 rev。
2. **`others[]` 的动作面**：本轮只保证**不生成按钮**；若将来有人想对 others 做动作，必须先有 host 侧授权语义（T8 已把非配置槽位判 400，面板不提供入口）。
3. **`daemon.keys` 语义**：状态条显示 `keys N`（本次恒为 0）；"key 数 = 活跃远端会话数"这一措辞未逐项核实，故文案只写 `keys`。
4. **随机点位**：`daemon.others[]` 的 pid/port 是 WSL 侧进程，Windows 侧 `Get-Process` 查不到（正常，非缺陷）。
