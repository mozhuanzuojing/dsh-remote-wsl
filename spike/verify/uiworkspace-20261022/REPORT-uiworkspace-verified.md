# REPORT —— 「在此目录新建会话」的 uiWorkspace 路径已端到端验证（2026-10-22）

> 结论先说：**handoff-2026-10-22 §5 的第 1 条风险已关闭**。第三方 client 插件的 ctx 在用户能点的
> 时机一定能 `ctx.get("uiWorkspace")`；`addWorkspace(UNC)` → `startSession(ws.id)` 在真实例里
> 真的会把主视图切到新会话。桌面壳（Electron）侧没有单独复测，理由见 §5。

## 1. 被验的问题

handoff §5.1 原文：

> **uiWorkspace.startSession 只做了单元探针**，真机未确认插件 ctx 能否 ctx.get(uiWorkspace)；
> 拿不到时静默回落，用户会看到「已创建 DSH 会话」但主视图不切（即用户报过的没反应）。

两个未定事实：
1. 插件 `apply(ctx)` 收到的受限 cordis ctx，能不能读到 `ui-workspace` 提供的 `uiWorkspace` 服务？
2. 读到了之后 `startSession(workspaceId)` 会不会真的 `replaceMain`（切主视图）？

## 2. 为什么此前判不了

`ctx.get` 早已有先例（`ctx.get("locale")` 在 T11 实测可用，见 docs/prior-art-dsh-wsl.md §3-A4），
但那只是"某个服务能读到"，不是"`uiWorkspace` 能读到"；而 `startSession` 是同步的、没有返回值，
单看调用点无法判断成功与否。

## 3. 方法与证据

### 3.1 源码层：`ctx.get` 不需要 inject 声明

asar `dsh/node_modules/@deepseek-ai/cordis/src/reflect.ts`（**源码，不是推断**）：

- `:10` 注释原文 *"Read a service from the store **without the inject requirement**"*；
- `:233-243` `get(name, strict = true)` → `_getImpl(name, strict)`：
  按 `this.ctx[symbols.isolate][name]` 取隔离标签、在**共享 store** 里查实现；
  `strict` 只要求"提供者的 fiber 当前 ACTIVE"；
- `:286` `provide()` 里 `this.ctx.root[symbols.isolate][name] ??= Symbol(name)`
  ⇒ 隔离标签落在**根 ctx**，子 ctx 未被 `isolate()` 时读到同一个键。
- `dsh-client-modules/lib/client.js` 里 **0 处 `.isolate(`** ⇒ 插件 client ctx 不是隔离作用域。

⇒ 结论：只要 `ui-workspace` 的 client 插件在组合里、且 fiber 已 ACTIVE，`ctx.get("uiWorkspace")` 就该命中。

### 3.2 运行时：真机探针（`probe-uiworkspace.ts`）

- 实例：`dsh web --port 8917 --no-open`（web profile；组合 `ui-workspace` + `dsh-remote-wsl`，
  `--dump-config` 里 `- id: ui-workspace` 在 623 行、`- id: remote-wsl` 在 1280 行）。
- 浏览器：headless Chrome + CDP 直读属性（`--dump-dom` 会在长连接页面上挂住，本轮实测 3 分钟无输出，
  已放弃该路径）。
- 探针补丁（临时、验完即删，未进任何提交）：在 `client/index.js` 的 `apply()` 末尾按
  0/1500/4000ms 读 `ctx.get("uiWorkspace")` / `ctx.get("locale")`，结果写进 `<html data-rwsl-ui-probe>`。

原始输出（`out-uiworkspace.json`）：

```
PROBE_JSON = {"at":"apply","get":"function","tries":[
  {"label":"apply","uiHit":false,"localeHit":false},
  {"label":"t+1500","uiHit":true,"startSession":"function","openSession":"function","listDirectory":"function","localeHit":true},
  {"label":"t+4000","uiHit":true,...}]}
```

读法：**`apply()` 那一瞬间还是 undefined**（provider fiber 未 ACTIVE），**1.5 秒后就命中**。
用户点按钮时 chunk 已就绪，处在 t+1500 之后 ⇒ 命中是常态。`locale` 与 `uiWorkspace` 同进同退，
交叉印证了 §3.1 的机制判断。

### 3.3 端到端（`probe-uiworkspace-e2e.ts`）

同一条链路照 header 主按钮的写法跑：

```
ADD_WORKSPACE = {"ok":true,"ws":{"ok":true,"id":"a1d7a290-ca09-4349-a31d-c325ecf925f7",
                 "title":"g","uncPath":"\\\\wsl.localhost\\debian-u8-1\\home\\g","alreadyExisted":true}}
START_SESSION = {"called":true,"returned":"undefined","thenable":false}
AFTER         = {"sessions":{"phase":"ready","count":45},"workspaces":{"phase":"ready","count":6},
                 "mainReference":"session-64cf3586-22a6-43d4-8548-d4403e9e78a1",
                 "hasComposer":true,"failedToasts":[]}
```

- `addWorkspace` 登记成功；第二轮 `alreadyExisted=true` ⇒ 幂等。
- `startSession` **同步返回 undefined**，与源码一致：`dsh-client-ui-workspace/lib/client.js:1499-1527`
  先算 target，再 `openWorkspaceSession(...).catch(reason => console.warn("new session failed:", reason))`
  —— **它自己吞掉失败**（并 `notify({kind:"createFailed"})` 让平台弹 toast）。
- `mainReference.sessionId` 变成新 session、会话数 +1、页面出现输入框、无失败 toast
  ⇒ `replaceMain` 确实发生，主视图切了。**两轮复跑结论一致**（14:47 与 14:53）。

## 4. 因此改了什么代码

`client/client.panel.header.js`（主按钮 onclick）只改一处：把 `nav.startSession(ws.id)` 变成
"按 thenable 兜一层"（`opening && typeof opening.then === "function"` 才 await）。
理由：现在它同步返回 undefined，但**将来若改成返回 Promise，失败就不会被静默吞掉**。
本轮的探针也证明了行为不变（`returned:"undefined"`，主视图照常切）。

入口 `client/index.js` 追加一行 rev 注释（chunk 变了，rev 必须换，见 docs/client-contract.md §11）。

## 5. 未覆盖 / 遗留

1. **没在 Electron 桌面窗口里复测**：桌面壳载 `dsh-app://app`，与 web 的差别只有传输层
   （`forwardWebRequest` 剥 Origin/Host；闸门已由 `desktop-shell-20261021` 的 origin 矩阵 12/12 覆盖）。
   client runtime、cordis 服务、`startSession` 全在浏览器侧，同一份字节。**唯一没做的是"在桌面窗口里点一次"**。
2. **`startSession` 的失败路径没有可观测出口**：它同步返回 undefined 且自己 catch。面板现在的
   成功文案只表示"已登记工作区 + 已发起开会话"，失败时由平台 toast 承担告警。要更强的一致性，
   得订阅 `uiWorkspace.mainReference` 之类的内部状态（本轮无证据支撑其稳定性，不做）。
3. **探针副作用**：web profile 里留下了一个工作区 `g`（UNC `\\wsl.localhost\debian-u8-1\home\g`）
   和两个 blank 会话（sessions 从 44 → 45）。都在 `~/.dsh` 的 **web** profile 下，与 desktop profile 无关。
4. 探针依赖 `client/index.js` 的临时补丁；补丁原文两处都写在两个 probe 的头部注释里，
   复跑时照着贴，跑完 `git checkout -- client/index.js`（入口 rev 注释是**提交内容**，别一起回滚）。

## 6. 复跑

```powershell
$node='C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
# 1) 按 probe 头部注释贴临时探针，2) 起实例
& 'C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' web --port 8917 --no-open
# 3) 起 headless Chrome（把打印出来的带 token URL 给它）
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu `
  --remote-debugging-port=8966 --remote-allow-origins=* --user-data-dir="$env:TEMP\rwsl-probe-chrome" <URL>
# 4) 取证
& $node spike/verify/uiworkspace-20261022/probe-uiworkspace.ts 8966 25          # 期望 exit 0
& $node spike/verify/uiworkspace-20261022/probe-uiworkspace-e2e.ts 8967        # 需另一个 CDP 端口的 Chrome
# 5) 收尾：kill 实例与 Chrome，git checkout -- client/index.js
```
