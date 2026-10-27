# client 半契约（实测钉死版）

- **日期**：2026-10-12 ｜ **任务**：task-1 ｜ **状态**：契约已实测；最小证明已跑通，原始输出在 `%TEMP%\rwsl-client-probe\`
- **适用范围**：给 `dsh-remote-wsl` 加「侧栏图标 + 中央面板」所需的**静态 `dsh.client` 半**（与动态包 `cordis_define/run` 的 client 半是两套东西，别混）。
- **结论先说（3 条会改变落地方式的硬事实）**
  1. `exports["./client"]` 指向的**文件必须存在**，否则整个 client 组合**激活失败**（不是一个包静默掉线）。⇒ 顺序必须是 **T1 契约 → T3 `client/**` 落盘 → T2 补 `dsh.client` → T4 验证**。
  2. 静态 client 半**没有** `host.call` / `styles.insert`（那是动态包专属）。取数走**host 注册 webServer 路由 + 浏览器同源 `fetch`**。
  3. 零构建成立：客户端产物就是一个**手写的** `window.__ModuleLoader__.load({...})` 文件，不需要 bundler/JSX/TS。

**引用约定**：形如 `dsh-client-modules/lib/index.js:713` 的路径，指 **app.asar 内** DSH 实现（解包方法见文末 §9）；插件自己的路径指仓库内路径。凡标注「实测」的都有原始输出留档（§8）。

> **2026-10-27 增量（本文之后的契约变化）**：面板 host 错误体统一为 `{ ok:false, error, code, detail?, reason? }`（新增 `E_ORIGIN` / `E_METHOD` / `E_CONTENT_TYPE` / `E_BODY` / `E_UNKNOWN_METHOD`；`reason` 取 `cross-origin` / `bad-verb` / `not-json` / `bad-json` / `unknown-method` / `unknown-distro`）；新增 chunk `client/client.panel.a11y.js`（面板 chunk 现 8 个）；`snapshot.webHosts[].url` 已脱敏（`token=***`，保留 host:port）。细节见 [`docs/2026-10-27-fix-round.md`](2026-10-27-fix-round.md)。

---

## 1. `dsh.client` 的确切形状

### 1.1 字段（判定代码即规范）

```jsonc
"dsh": {
  "client": {
    "platform": "web",        // 必填；本值不是 "web" ⇒ 该包被静默忽略
    "inject": ["@deepseek-ai/dsh-client-ui-layout"],  // 可选，string[]
    "external": ["<pkg>/client"],                     // 可选，string[]
    "immediately": false                              // 可选，boolean
  }
}
```

出处：

- `dsh-client-modules/lib/index.js:61-75` `parseDshClient(pkgName, value)`：
  - `:63` 非对象 ⇒ throw；`:65` `platform` 非 string ⇒ throw；`:66-67` `inject`/`external` 必须 string[]；`:68` `immediately` 必须 boolean。
  - 返回 `{platform, inject?, external?, immediately?}` —— **就这四个字段**，没有别的。
- `dsh-client-modules/lib/index.js:713-717` `resolveMeta()`：`parseDshClient(packageName, dsh.client)` 之后 **`decl.platform !== "web" ⇒ 记 `null`（该包当非 client 包，静默跳过）`**。
- 官方样例（值形态）：
  - `dsh-client-ui-sidebar/package.json:28-41`（`platform` + `inject`）
  - `dsh-client-modules/package.json:32-38`（`platform` + `inject` + `immediately`）
  - `dsh-api-remotes/package.json:32-40`（`platform` + `inject` + `immediately`）
  - 第三方 **`dsh-wechat@0.8.0/package.json:41-52`**（`platform: "web"` + `inject: [...]` + `dsh.bundle.patch`）

### 1.2 入口路径怎么来：`exports["./client"]`

- 解析器 `dsh-client-modules/lib/index.js:171-181` `clientExportOf(pkgName, exportsField)`：
  - `exports["./client"]` 是 **string** 或 **`{ default: string }`**（一层条件形态）；
  - 没有 `./client` ⇒ `undefined`；形态不合法 ⇒ throw `exports["./client"] must be a string or an object with a string default`。
- 组合时 `:718-719`：`clientRel === undefined` ⇒ throw **`declares dsh.client but exports no "./client" bundle`**。
- 实际文件路径 `:723`：`clientPath = join(dirname(package.json 的路径), clientRel)`。**相对于 package.json 所在目录解析**，与 `main` 无关。
- 所以插件里应当写（目录名随意，**不必**叫 `lib/`）：

```jsonc
"exports": {
  ".":         { "default": "./src/index.ts" },
  "./client":  "./client/index.js",
  "./package.json": "./package.json"
}
```

（`dsh-wechat@0.8.0` 用 `"./client": "./dist/client.js"`；官方包用 `{"types":…,"default":"./lib/client.js"}`。string 与条件对象两种都行。）

### 1.3 「文件不存在」的后果：**激活失败**（实测，不是推测）

- `:794-799` `captureArtifactBaseline(clientPath)` 直接 `statSync` ⇒ 缺件抛 `MissingClientBundleError`（`:128-142`，消息固定为 `client bundle not found; run \`pnpm run build\` before launch:` + package + path）。
- `:144-157` `ClientPackageCompositionError extends AggregateError`：把所有缺件包聚合成一条响亮错误；**client-modules 自身是 required 插件**，它挂掉会连带一片插件卡在 waiting。
- **实测（2026-10-12，profile `rwsl-client-probe`，见 §8.5）**：

```
error: dsh: startup failed: 3 required plugins did not activate
  modules (required)  Package: @deepseek-ai/dsh-client-modules
    AggregateError: client-modules: 1 client package failed to compose:
      client bundles not found; run `pnpm run build` before launch:
        - package: dsh-rwsl-client-probe-broken
          path: C:\Users\l\AppData\Local\Temp\rwsl-client-probe\plugbroken\client\DOES-NOT-EXIST.js
  ... 另 9 个插件 waiting for services
```

⇒ **落地顺序（写死）**：`client/**` 文件先存在，`dsh.client` 后补。中途若必须提交声明，就让 `exports["./client"]` 指向一个已存在的占位文件。

### 1.4 服务 URL 与 `files`

- 路由常量 `dsh-client-modules/lib/index.js:201` `PLUGIN_ROUTE = "/plugins"`；combo 形式 `:203-205` `comboSearch(ids, rev) = "??<id>/client.js&rev=<rev>"`。
- 浏览器实际请求的是 **`plugins/??<packageName>/client.js&rev=<rev>`**（文档相对形式，`:210-218` `comboReference`）——**不是** `lib/` 下的真实路径。
- 实测两件事（§8.2）：
  - `GET /plugins/??dsh-rwsl-client-probe/client.js&rev=391dc0f658c2` ⇒ **200**，正文就是磁盘上那个文件；
  - `GET /plugins/dsh-rwsl-client-probe/client.js?rev=…` ⇒ **404**。`client.js`（无 `??`）不是合法路由；带 `??` 才是 combo，单文件也走 combo。**别照抄 README 里 `<id>/client` 的字面当 URL**（那是**模块说明符**层面的别名，`:89-100` `stripClientSuffix`）。
- 另有 chunk 路由：只有形如 `client.<name>.js` 的文件可被按需取（正则 `:169` `^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$`），且必须由入口工厂里的 `require.async("./client.<name>.js")` 触发。**chunk 不是「每个文件自带 wrapper」**——见 §2.3。
- `files` 字段：`dsh-client-modules` 只读 `package.json` 的 `exports`，**从不读 `files`**（`:701-731` 全程只有 `readFileSync(pkgPath)`）。`files` 是 npm 发布清单，**link 安装无关**。⇒ 本插件**不需要**为了 client 半改 `files`（上 npm 时要记得带上 client 目录）。

---

## 2. 静态 client 半的 loader 格式（零构建可行）

### 2.1 产物长这样

文件内容必须自带注册调用（浏览器把 combo 当普通 `<script>` 执行）：

```js
window.__ModuleLoader__.load({
  id: "dsh-remote-wsl",                 // 必须是**包名**（解析出的 manifest name）
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require("react");        // 只允许平台种子表 + 图内其它 client 包行
    function apply(ctx) { /* 注册槽位 */ }
    exports.apply = apply;
    exports.inject = ["slots"];          // cordis 服务注入（等 slots 就绪）
    return module.exports;
  },
});
```

出处：

- 官方 `dsh-client-ui-sidebar/lib/client.js:1-11`（`window.__ModuleLoader__.load({id, factory:(require)=>{ var module={exports:{}}; …`），尾部 `ui-schedule/lib/client.js:6864-6868`（`exports.apply = apply; exports.inject = inject; return module.exports; } });`）。
- **第三方生产先例**：`dsh-wechat@0.8.0/dist/client.js:1-18` —— 注释原文 *"Authored directly in the DSH client module format (window.__ModuleLoader__), … the host-side client-modules service serves this file at /plugins/dsh-wechat/client.js and the browser kernel loads it … no @deepseek-ai imports at runtime."*，`inject = ["slots"]`（`:20`）、`exports.apply` / `exports.inject`（`:341-343`）。
- 为什么 `id` 必须是包名：`dsh-client-modules/lib/index.js:82-100` + README *"the resolved manifest package name identifies the browser module"*；`:428` 同包自请求会被判为 composition error。

### 2.2 能 `require` 什么：只有平台种子表 + 图内行

- 种子表（**权威、只有 8 项**）在 web 外壳里：asar `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js`，`function rM(){ return { react, "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit" } }`。
- 解析顺序 `dsh-client-modules/lib/client.js:700-705`：种子表 → 已物化模块 → boot 图行 → 已注册工厂；否则 **throw**（`require("X") missed the module table`）。
- ⇒ **`@deepseek-ai/dsh-client-ui-layout` 等不在种子里**。要 `require` 别的客户端包，必须把它写进 `dsh.client.inject`（图序排序，`:408-428`），并且**只能用包名或 `<包名>/client`**（`:89-100` 只剥 `/client` 后缀）。
- **没有全局 `React`**：那是动态包注入的 closure 符号（`dsh-cordis-client-runner/lib/client.js:55`：*"React arrives as the `React` closure symbol"*）。静态半一律 `require("react")`。
- 无 JSX 转换 ⇒ `react.createElement`（或 `require("react/jsx-runtime")` 的 `jsx`）。

### 2.3 多文件：只有入口那一个文件会进 combo

- 应用组合 URL 是按图行拼的，每行只列 `<id>/client.js`（实测 §8.1 的 combo URL 里 `dsh-rwsl-client-probe/client.js` 之后直接是下一行）。
- 所以**不要**给「每个文件都套一层 `window.__ModuleLoader__.load`」——那些文件不会被请求。要拆包只有一条路：文件名匹配 `client.<name>.js` 并用入口工厂里的 `require.async("./client.<name>.js")` 触发（README「Incremental composition」段 + `:169`）。
- 零构建场景下**建议单文件** `client/index.js`，内部自己拆函数/组件。

### 2.4 IP 内主题 CSS

- `styles.insert(css)` **不可用**（同 §3.1 的 `host.call`，动态包专属）。
- 官方做法：工厂里手写 `<style data-plugin=… data-plugin-css=…>` 注入，见 `dsh-client-ui-sidebar/lib/client.js:12-21`、`dsh-wechat@0.8.0/dist/client.js:67-73`。

---

## 3. `ctx.slots.register` 的确切签名

服务提供者：**`@deepseek-ai/dsh-client-ui-renderer`**（`lib/client.js:1280` `var SlotRegistry = class extends Service`、`:1323` `super(ctx, "slots")`），纯注册语义在 **`@deepseek-ai/dsh-client-ui-slots`**（`lib/index.js` 的 `SlotCore`，本身是**平台种子模块**）。

### 3.1 签名

```ts
ctx.slots.register(options, Component) -> disposer
```

`options`（`dsh-client-ui-slots/lib/index.js:163-243`）：

| 字段 | 必需性 | 语义 / 校验位置 |
|---|---|---|
| `name` | **必填** | 目标槽 key；`:164-165` 槽未声明 ⇒ throw `slot "X" is not declared (a parent entry's children table must declare it)` |
| `id` | **list 槽必填** | `:181-185` `list slot "X" requires options.id`，同 id 同 priority 重复 ⇒ throw |
| `key` | **keyed 槽必填** | `:175-179` `keyed slot "X" requires options.key` |
| `select` | chain 槽必填 | `:187-189` |
| `order` | 可选（list 排序） | `:209`、`:221` 排序键 |
| `label` | 可选（list 用） | `:210`；可为 `string` 或 `() => string`（读时求值 `resolveSlotLabel`，`ui-slots/lib/index.js:27-29`） |
| `priority` | 可选，默认 0 | `:167`、`:171/177/183` 同 cell 同 priority 视为冲突/遮蔽 |
| `locale` | 可选 | 注入 `t` 等标准 seat |
| `inject` | 可选 | `(…args) => props`，把自有数据喂给组件 |
| `children` | 可选 | 声明子槽 |
| `store` / `registrant` | 可选 | store 句柄 / 归属标记 |

注册期一律经 `ctx.effect` 包裹（`ui-renderer/lib/client.js:1788-1791`），返回的 disposer 即卸载。

### 3.2 两个槽的实测 spec（本机新起实例，§8.3）

```
sidebar.panellist  {kind:"list",  scope:"root", declaredBy:"an entry in \"sidebar\" (mf)"}
main               {kind:"keyed", scope:"root", declaredBy:"an entry in \"root\" (mf)"}
```

- 声明者：`sidebar.panellist` 由 `@deepseek-ai/dsh-client-ui-sidebar` 的 `apply()` 在 `sidebar` entry 的 `children` 表里声明（`ui-sidebar/lib/client.js:487-519`，`:503-506` 那一项是 `{kind:"list", scope:"root"}`）。
- `main` 由 `@deepseek-ai/dsh-client-ui-layout` 在 `root` entry 的 `children` 表里声明（`ui-layout/lib/client.js:601-627`，`:609-612` 是 `{kind:"keyed", scope:"root"}`）。
- ⇒ 两者都**不是**「注册了才存在」，而是别的插件先声明；所以官方统一写法是包一层等声明：

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({...}, Icon));
ctx.slots.inject("main",               () => ctx.slots.register({...}, Panel));
```

`ctx.slots.inject(key, cb)` 语义（`ui-renderer/lib/client.js:1343-1402`）：声明已存在则**同步**跑 `cb`；否则订阅声明边界，声明出现后跑、折叠后销毁、再声明再跑。官方样例：`ui-schedule/lib/client.js:6793-6810`、`dsh-wechat@0.8.0/dist/client.js:332-339`、`ui-plugin-manager` 同形（`{name:"main",key:PANEL_ID}` / `{name:"sidebar.panellist",id:PANEL_ID,order:0,label:()=>t("panel")}`）。

### 3.3 图标组件 props = `{ size: number; active: boolean }`

- 渲染点 `ui-sidebar/lib/client.js:190-193`：`renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })`。
- 官方图标实现只取 `size`：`ui-schedule/lib/client.js:6196-6198` `function TaskManagerIcon({ size }) {...}`；`active` 用于高亮（本插件探针两参数都用，实测正常）。
- 没有 `label` 之外的额外 props；`{only: id}` 表示只渲染该 id 的 occupant。

### 3.4 面板组件：由 `main` 按 key 渲染

- `ui-layout/lib/client.js:117-118`：`renderSlot("main", {}, { entryKey: usePanelInfo(i => i.activePanelId) ?? "conversation" })`。
- 面板组件默认没有 props（除 `locale` / `inject` 注入的标准 seat）。

### 3.5 「`main` key 与 panellist id 同名」是**点击期**约束，不是注册期约束

- 注册期：两个槽各自独立，registry **不会**替你检查同名（`ui-slots/lib/index.js` 全程不比较主/侧 id）。
- 点击期：侧栏行点击 → `selectPanel(id)` → `ctx.layout.selectPanel(id)`（`ui-sidebar/lib/client.js:184-186`、`:478-481`），落到
  `ui-layout/lib/client.js:462-463`：
  ```js
  selectPanel(panelId) {
    if (panelId !== null && !this.hasMainPanel(panelId))
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
  ```
  其中 `hasMainPanel` = `ctx.slots.entries("main").some(e => e.options.key === id)`（`ui-layout/lib/client.js:595`）。
- ⇒ 同名是**运行时必备条件**，违反即点击抛错（见 §5 反例）。设计稿 §3 的「必须同名」结论正确，但机制在 `layout`，不在槽注册。

---

## 4. 静态 client 半 → 本包 host 半：取数通道

### 4.1 `host.call` **不可用**（反证）

- `dsh-cordis-client-runner/lib/client.js:54-55`（动态包 sandbox 的教学文案）：
  > `fetch: "network belongs to the HOST half: register a handler there with harness.handle(method, fn) and call it here via host.call(method, args)."`
  > `require: "modules cannot be imported here. React arrives as the React closure symbol; everything else goes through ctx services or host.call."`
- `:68`、`:6162-6169` 的 signature 表（`host.call(method, args?)` / `styles.insert(css)`）都挂在**动态 runner** 的内建表上。
- 静态 `dsh.client` 半的执行环境**只有** `require`（平台种子表）+ cordis `ctx` + 浏览器全局，**没有** `host` 闭包。
- **grep 复核**：全部 **53 个 `@deepseek-ai/dsh-client-ui-*`** 包的 `lib/client.js`（420 文件）搜 `host\.call|styles\.insert` ⇒ **零命中**；全解包树内这两个符号只出现在 `dsh-cordis-client-runner/lib/client.js`（动态 runner）。
- 另一条也别指望：`ctx.remote.<ns>` 只在 host 侧 `@deepseek-ai/dsh-api-remotes/lib/types/client/index.js:34-46` 的**显式清单**里挂载；第三方插件不在清单里，且 typert 生成物是 host-face only（`dsh-typert-loader/README.md` 的 *"Host face only … client runtimes need a separate composition owner"*）。**P0 不要走 `ctx.remote`。**

### 4.2 裁决路径：host 注册 webServer 路由 + 浏览器同源 `fetch` ✅

**官方 WebRoute 契约**（`dsh-host-webserver`）：

```ts
ctx.get("webServer").register({
  kind: "exact",            // "exact" | "prefix"
  path: "/remote-wsl/api",  // 精确 pathname，或 prefix 前缀
  handler: async (req /* node:http IncomingMessage */, res /* ServerResponse */) => { … }
})                          // -> disposer
```

出处：`dsh-host-webserver/lib/index.js:177-184`（`route.kind === "exact" ? this.exact : this.prefixes`；重复 `(kind,path)` throw）、`:235` `await route.handler(req, res)`；README.md:45/49（exact → 最长 prefix → fallback 的匹配顺序；无 fallback 时 404）。

**必须用条件 inject**：`ctx.get("webServer")` 在 `apply` 时刻是 `undefined`（webserver row 要等 `webStartup`）。生产先例 `dsh-wechat@0.8.0/dist/index.js:198-205`：

```js
if (typeof context.inject === "function") {
  context.inject(["webServer"], (httpCtx) => {
    const webServer = httpCtx.get("webServer");
    if (!webServer) return;
    webServer.register({ kind: "exact", path: "/wechat/api/status",
      handler: (_req, res) => sendJson(res, 200, bridge.getStatus()) });
    // … 另有 kind:"prefix" path:"/wechat/api/user/" 的样例（:287-315）
  });
}
```

**多发行版（2026-10-21）**：`/remote-wsl/api` 的 `args` 可带可选 `distro`；host 用 `listDistros()`（`wsl -l -q`）校验，未知 ⇒ `E_ARG`(400)。非配置发行版的 `wslHome` 由 host 解析一次（`wsl -d <distro> -- sh -c 'printf %s "$HOME"'`，进程内缓存，失败回落配置值）——因为守护 state 目录是 `${wslHome}/.dsh/remote-wsl`，猜错会找不到/写错位置。`snapshot` 的单飞按发行版分键。

浏览器侧同源取数（同包 `dist/client.js:100-105`）：

```js
fetch("/wechat/api" + path, { headers: { "Content-Type": "application/json" }, ...options })
```

**鉴权/信任边界**：这条路由是**裸 node http**，不经过 `connection` 的信任/会话校验（webserver 自己也没有 TLS/认证/origin 策略，README:39）。⇒ 面板只做只读/幂等动作时可用；涉及**写型或有副作用**的动作应改用 §4.3。

**本任务的最小证明已实测走通这条路**（§8.4）：host 注册 `GET|POST /rwsl-probe/echo`，client 半 `fetch("/rwsl-probe/echo", {method:"POST", …})`，返回 `{"ok":true,"got":"{\"hello\":\"from-client\",\"panel\":\"rwsl-probe\"}","from":"dsh-rwsl-client-probe host half"}`。

### 4.3 P1 备选（**带鉴权**的通用 RPC 通道）：`ctx.connection.rpc`

host（`dsh-client-connection/lib/index.js:640-657`）：注册一个 **prefix 路由**，并内置 `admit()`（Host/Origin 信任栅栏 + 浏览器会话校验）：

```js
ctx.connection.rpc.handle("/remote-wsl", async (endpoint, payload, signal, peer) => {
  // endpoint 必须是 [A-Za-z0-9_$.-]+ 的路径段（:714）
  return { ok: true, result: { … } };   // 信封由 rpcFetchHandler 组装
});
```

- handler 签名 `(endpoint, payload, signal, peer)`，返回 `{ ok: true, result }` 或 `{ ok:false, error }`（`:673-701`）。
- 客户端（`dsh-client-connection/lib/client.js:1209-1232`）：
  ```js
  await ctx.get("connection").rpc.call("/remote-wsl", "explorer.snapshot", args);
  ```
  内部 `POST <channel>/<endpoint>`，body `{type:"client-request", rpcId, method, payload}`，校验 `rpcId` 回环；非 2xx 抛 `transport failure for …`。
- channel 受 `^\/[A-Za-z0-9._~-]+$` 限制（`:1201`），即**单段**。
- 代价：客户端要注入 `connection` 服务（`exports.inject = ["slots","connection"]`），且与官方 `/api` 通道**不共享**（只有 `/api` 能注册 interceptor，`:658-659`）。
- 状态：**P1 备选通道，未端到端实测**（代码级已核对；P0 不需要，本任务未在实例上跑通）⇒ 见 §7 未核实项。

---

## 5. 反例（真实行为，实测）

**只注册 `sidebar.panellist`（id `rwsl-probe-neg`，order 21），不注册同名 `main` key。**

实测结果（原始输出 §8.6，`%TEMP%\rwsl-client-probe\04-negative-readonly-panellist.txt`）：

1. **图标照常出现且可点** —— 侧栏 rail 的 entries 来自 `ctx.slots.entriesOfSlot("sidebar.panellist")`（`ui-sidebar/lib/client.js:454`），与 `main` 无关；DOM 里出现 `button[aria-label="RWSL Probe NEG"]`。
2. 点击 → **抛出未捕获异常**（React 不把事件处理器异常交给 error boundary）：
   ```
   Uncaught Error: layout.selectPanel: main panel "rwsl-probe-neg" is not registered
     at selectPanel (client.js:463:1)     <- ui-layout
     at  (client.js:480:1)                <- ui-sidebar: ctx.layout.selectPanel(id)
     at  (client.js:185:1)                <- ui-sidebar PanelRow onClick
   ```
3. **界面完全不动**：该按钮**没有**拿到 `aria-current="page"`，之前选中的面板保持挂载，`main` 槽没有为这个 id 做任何渲染。
   ```json
   {"neg_button_aria_current":null,"rail_active":["RWSL Probe"],
    "positive_panel_still_mounted":true,"neg_panel_mounted":false}
   ```
4. ⇒ 不是「静默空白面板」，而是**控制台报错 + UI 无响应**。任何「只挂侧栏图标」的半成品都会以这个形态暴露。

对照：**同名都注册**时，同一个按钮点击后 `aria-current` 生效、`main` 面板上屏（§8.4）。

---

## 6. 落地清单（照本契约写）

`package.json`（在 `client/**` 已存在之后再加 `dsh.client`）：

```jsonc
{
  "main": "./src/index.ts",
  "exports": {
    ".": { "default": "./src/index.ts" },
    "./client": "./client/index.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }        // 需要别家客户端包时才加 inject
  }
}
```

- host 半：只读动作走 §4.2 的 `ctx.inject(["webServer"], …)` + `register({kind,path,handler})`；写型动作预留 §4.3 的 `connection.rpc`。
- client 半：单文件手写 `window.__ModuleLoader__.load(...)`；`inject = ["slots"]`；用 `ctx.slots.inject(...)` 包注册；图标 `({size,active})`；面板 `main` key 与 panellist `id` **同名**。
- 纪律：client 半**零 `@deepseek-ai/*` 运行时导入**（`required` 只能落在种子表 8 项上）；样式手写 `<style>` 注入。
- 面板 id 建议 `remote-wsl`；`order` 取 20（本机 web profile 里 `plugins=0`，desktop profile 里 `plugins=0`/`schedules=10`）。

---

## 7. 未核实 / 已知空白

| 项 | 状态 | 说明 |
|---|---|---|
| client 半热更是否必须 `pnpm run dev:web` | **未核实** | 直接保留为未核实项。设计稿 §8.3 的旧记录未被本任务复核。已核实的是：bundle 内容的变更只经 `rebuilt()`（HMR 钩子）进入图（`dsh-client-modules/lib/index.js` 模块文档 :72-73、:123-124）；**新增/删除 `dsh.client` 声明或改 `exports["./client"]` 需要重启**（元数据按 Loader specifier 缓存，README *"until restart"*；`:701-731` 的 `pkgMeta` 缓存）。静态半是否能在页面存活的实例上热替换、以及是否依赖 `pnpm run dev:web` 在跑 = **未测**。 |
| `ctx.connection.rpc` 端到端跑通 | **P1 备选通道，未端到端实测** | §4.3；代码级已核对，本任务用 §4.2 完成证明，未起实例验证 rpc 通道。 |
| `ctx.slots.register` 是否可在**异步**上下文中调用（例如 `await fetch` 之后再注册） | **未核实** | 官方一律在 `slots.inject` 回调里同步调用（回调用 `ctx.effect` 包住）。本任务遵循该形态。 |
| **Inspect client 探针（`Slots.listSubTree`）在本会话不可用** | **环境限制 + 替代判据（不等价）** | 本会话内 `client` 平台四个 provider（Slots/Service/Builtin/Theme）**全部 10s 超时**（用户 GUI 页未接入本会话的 client inspect 传输）。且新起实例是**另一个 Host 进程**，本来也不在该探针视野内。替代取证见 §8.3：在**被测实例自己**的页面里读 `ctx.slots.snapshot()/entries()/spec()`（`SlotRegistry` 与 Inspect provider 的 `SlotCore` 是同一底层）。⚠ 这是**替代判据，不是等价判据**：未经 Inspect provider 自身的投影/裁剪路径，字段集合可能与该 provider 的输出略有差异。 |
| `dsh.client.external` 的精确语义 | **未实测** | 代码证据：`:408-428`（图序/自请求/环检测）、`stripClientSuffix` `:89-100`；本任务未使用该字段。 |
| client 半在 **desktop（Electron）** 宿主下的同源 fetch 行为 | **已核实（2026-10-21，实测 + 平台源码）** | 壳用 `dsh-app://app` 载页面（`app.asar/lib/main.js` `applicationUrl`）；**非静态资源**请求经 `forwardWebRequest` 用 **Node fetch** 重放到 `http://127.0.0.1:<port>`，并**主动删掉** `origin`/`host`/`cookie`/`sec-fetch-site`（`lib/main.js:8268-8298`）⇒ 桌面端到达插件路由的请求**没有 Origin**。据此修正了 `/remote-wsl/api` 的闸门：无 `Origin` + 无 `Sec-Fetch-Site` ⇒ 放行（与官方 `admit()` 同策略），异源 `Origin` / `cross-site` 仍 403。回归矩阵与证据：`spike/verify/desktop-shell-20261021/`。 |

---

## 8. 最小可注册证明（可复跑）

**产物目录**：`%TEMP%\rwsl-client-probe\`
**被测实例**：`node <runtime>\@deepseek-ai\dsh\lib\bin.js --profile rwsl-client-probe --port 3090 --no-open`
**profile**：`C:\Users\l\.dsh\profiles\rwsl-client-probe`（`--from-default-profile web` 新建；**没有**碰用户桌面 profile，也没有改共享的 `remote-wsl-test`）

| # | 文件 | 内容 |
|---|---|---|
| 8.1 | `01-boot-rows.txt`、`index.html` | `window.__DSH_BOOT__` 里我们两条 row + 应用 combo URL |
| 8.2 | `served-client-bundle.js` | combo 路由 200 的正文（就是磁盘文件） |
| 8.3 | `03-slots-dump.txt` | 实例自身 slot registry dump（occupant 列表 + tree + declaredBy） |
| 8.4 | `evidence-1-positive-panel.png` + 正文文本 | 点图标 → `main` 面板上屏 + host echo 往返 |
| 8.5 | 见 §1.3 | 缺 bundle 的激活失败原始输出 |
| 8.6 | `04-negative-readonly-panellist.txt`、`evidence-2-negative-no-switch.png` | §5 反例 |

### 8.1 —— 注入确实发生

```
{"id":"dsh-rwsl-client-probe","url":"plugins/??dsh-rwsl-client-probe/client.js&rev=391dc0f658c2","rev":"391dc0f658c2"}
{"id":"dsh-rwsl-client-probe-neg","url":"plugins/??dsh-rwsl-client-probe-neg/client.js&rev=11b714dc0721","rev":"11b714dc0721"}
```
两条都在 application combo 的 `<link rel="preload">` 与 `batches[].entries` 里。

### 8.2 —— bundle 被 serve

`GET /plugins/??dsh-rwsl-client-probe/client.js&rev=391dc0f658c2` ⇒ **200 / 4072 bytes**，正文首行即手写 bundle 注释。
（同一路径去掉 `??` ⇒ 404，见 §1.4。）

### 8.3 —— occupant 存在（实例自证）

见 §3.2 / `03-slots-dump.txt`：`sidebar.panellist` 的 occupants = `plugins(0)`、`rwsl-probe(20)`、`rwsl-probe-neg(21)`，`declaredBy: an entry in "sidebar" (mf)`；`main` 的 occupants keys = `rwsl-probe`、`plugins`、`conversation`。

### 8.4 —— 点图标切面板 + client→host 取数

- 点击前：rail 有 `button[aria-label="RWSL Probe"]`。
- 点击后：`[data-rwsl-probe-panel="rwsl-probe"]` 存在，`rail_active = ["RWSL Probe"]`（`aria-current="page"` 生效），面板正文：
  ```
  RWSL Probe Panel
  PANEL-RENDERED
  host echo
  {"ok":true,"got":"{\"hello\":\"from-client\",\"panel\":\"rwsl-probe\"}","from":"dsh-rwsl-client-probe host half"}
  ```
  —— 最后一行是 host 半 `webServer.register` 的 handler 返回的 JSON，证明**同源 fetch 通道打通**。

### 复跑步骤

1. 目录 `%TEMP%\rwsl-client-probe\`：`plug`（正例：panellist + main + host echo 路由）、`plugneg`（反例：只 panellist）、`plugbroken`（缺 bundle）。
2. `dsh --profile <p> --from-default-profile web`；在 `package.json` 的 `dsh.profile.bundles` 追加 `dsh-rwsl-client-probe` / `-neg`，并在 `node_modules` 建 junction 指向 `plug` / `plugneg`。
3. `node <dsh>/lib/bin.js --profile <p> --port 3090 --no-open`，取打印的 `?token=` URL。
4. 浏览器打开该 URL（首启会有点「继续」的预览版说明弹窗）；侧栏出现 `RWSL Probe` / `RWSL Probe NEG`。
5. 控制台里 `window.__RWSL_PROBE_SLOTS__()` 取 §8.3 的 dump；点两个图标分别得 §8.4 / §8.6。
6. 反例与激活失败：加 `--patch <overlay.yml>` 插入 `plugbroken`（⚠ `--patch` 必须写在 `--profile` **之前**）。

---

## 9. 证据获取方法（可复现）

app.asar = 8 字节 pickle 头（`uint32 ×2`）+ JSON 目录树 + 文件数据拼接；文件数据按 4 字节对齐，起点 `16 + ceil(headerJSONLen/4)*4`。
本任务用的两个小脚本（**只读、只写 `%TEMP%`**）：

- `%TEMP%\rwsl-client-probe\asar-list.js` —— dump/过滤目录树；
- `%TEMP%\rwsl-client-probe\asar-extract.js` —— 按路径子串抽取文件（`unpacked` 目录可能落在 `app.asar.unpacked`，脚本已处理）。

```powershell
node asar-list.js "C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" "dsh-client" "out.txt"
node asar-extract.js "…\app.asar" "dsh-client-ui-slots" "unpacked"
```

asar 内关键路径：`dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`、`…/dsh-client-ui-slots/lib/index.js`、`…/dsh-client-ui-renderer/lib/client.js`、`…/dsh-client-ui-sidebar/lib/client.js`、`…/dsh-client-ui-layout/lib/client.js`、`…/dsh-host-webserver/lib/index.js`、`…/dsh-client-connection/lib/{index,client}.js`、`…/dsh-web-frontend/dist/assets/index-5SrrfWpU.js`。

---

## 10. 与设计稿 §1/§3 的差异（以实测为准）

> **本轮最值钱的一条（必须留档）：设计稿 §1 曾把 `host.call(method,args)` 写成静态 `dsh.client` 半的内建。这是错的。**
> 该行事实来自 Inspect `client/Builtin.listBuiltins`，而 `Builtin` provider 描述的是**动态包**（`cordis_define`/`cordis_run`）的浏览器半——它的内建表里有 `host` / `styles` / `React` closure 三个符号（`dsh-cordis-client-runner/lib/client.js:6162-6169`），
> 且动态包的 client 半只能渲染进自己那张工具卡（`tool.view.cordis`，key 只接受 `self`），**进不了侧栏**。
> 静态 `dsh.client` 半的执行环境只有 `require`（平台种子表）+ cordis `ctx` + 浏览器全局，**没有** `host.call`，**没有** `styles.insert`。
> **grep 复核**：把 app.asar 里全部 **53 个 `@deepseek-ai/dsh-client-ui-*` 包**的 `lib/client.js` 抽出来（420 个文件，落在 `%TEMP%\rwsl-client-probe\unpacked-ui\`）搜 `host\.call|styles\.insert` ⇒ **零命中**；全解包树里这两个符号**只出现在 `dsh-cordis-client-runner/lib/client.js`**（动态 runner）。
> 设计稿 §1 已由 Lead 加删除线式更正段落并指向本文件 §1/§4；本表保留「设计稿曾错 → 实测纠正」的完整记录，供后续交接复核。

| 设计稿 | 实测 | 处置 |
|---|---|---|
| §1「client 半可零构建（`createElement`，无 JSX）」 | ✅ 成立；但产物**必须**是 `window.__ModuleLoader__.load(...)` 包装的手写文件，且平台种子表只允许 8 个 specifier | 按 §2 写 |
| §1 内建含 **`host.call(method,args)`**「**包私有** Client→Host JSON-RPC」 | ❌ **错**（见上方留档）：那是**动态包**浏览器半的内建（`dsh-cordis-client-runner/lib/client.js:54-55,68,6162-6169`），静态 `dsh.client` 半拿不到；官方静态包也**从不**用 `host.call`（grep `dsh-client-ui-*` 的 `lib/client.js` 零命中，它们走 `ctx.remote.<ns>`，而第三方插件不在 `dsh-api-remotes` 的挂载清单里） | 取数改走 §4.2（host `webServer.register` + 浏览器同源 `fetch`，**已实测**）；§4.3 `connection.rpc` 为 P1 备选 |
| §1 内建含 `styles.insert(css)` | ❌ 同属动态包（`dsh-cordis-client-runner/lib/client.js:6169`） | 手写 `<style data-plugin-css=…>` 注入（先例 `ui-sidebar/lib/client.js:12-21`、`dsh-wechat/dist/client.js:67-73`） |
| §1 内建含全局 `React` | ❌ 无全局 `React`；那是动态包注入的 closure 符号（`dsh-cordis-client-runner/lib/client.js:55`） | 静态半一律 `require("react")` |
| §1 内建 `ctx.slots.register` | ✅ 成立，但实际是 **`@deepseek-ai/dsh-client-ui-renderer`** 提供的 `ctx.slots` 服务（`lib/client.js:1280/1323`），注册语义在 `dsh-client-ui-slots` 的 `SlotCore` | 按 §3 写 |
| §3 `sidebar.panellist` 注册 `{id, order, label}` + `main` `{key}` **必须同名** | ✅ 但要补三点：(a) 两侧都需 `ctx.slots.inject` 等声明（槽由 `ui-sidebar` / `ui-layout` 先声明）；(b) 同名是**点击期**约束（`layout.selectPanel` 抛错 @ `ui-layout/lib/client.js:463`），不是注册期；(c) 只注册 panellist 的后果已实测 = 图标可点、点击抛未捕获异常、UI 不动（§5） | 按 §3 写 |
| §1「client 半由 host 侧 `clientModules` 扫描 + bundle route + index injection」 | ✅ 成立，且机制已细化到行号：增量扫描 `:701-731`、combo 路由 `/plugins/??<pkg>/client.js&rev=` `:201-218`、index 注入行 `bootInjections()` `:453-498` | 按 §1.4 写 |
| §9「`dsh.client` 字段形状需先探一次」 | ✅ 已探完（§1），**且多出一条硬约束**：`exports["./client"]` 指向的文件必须已存在，否则 `modules`(required) 挂掉、startup failed（实测 §1.3） | 顺序写死：先 client 文件后 `dsh.client` |
| §8.3「client 改动要 `pnpm run dev:web` 在跑才热更；否则重启宿主」 | ⚠ **未复核**（保留为未核实项，见 §7 第 1 行） | 不写入契约 |

---

## 11. chunk 的 `rev` 与 `immutable` 缓存：**只改 chunk 不生效**的机制坑（2026-10-13 实测，task-37）

> 本节只增不改；§1–§10 的内容一字未动。
> 结论先说：**`client/` 下的 chunk（`client.panel.js` / `client.i18n.js` / `client.api.js` / `client.icon.js`）改了之后，如果入口 `client/index.js` 没有跟着变，宿主与浏览器都可能继续用旧脚本**——改的人以为生效了，用户拿到的是旧代码。

### 11.1 机制：`rev` 是**入口文件的元数据哈希**，不是内容哈希

| 事实 | 出处（app.asar 内） |
|---|---|
| `rev = sha1("plugin-artifact", mtimeMs, ctimeMs, size)` —— **只吃入口文件的元数据**，从不哈希任何内容 | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:193-198` |
| 取的是**入口路径** `meta.clientPath`（即 `exports["./client"]` 指向的文件） | 同上 `:610-611`、`:882` |
| 入口元数据没变 ⇒ **短路返回同一个 rev**（连 bundle 都不重读） | 同上 `:611-614`（`if (rev === record.entry.rev) return rev;`） |
| 行的 `rev` = 入口 rev | 同上 `:363-367`、`:882-884` |
| chunk URL 用**入口行的 rev** 拼：`…/<pkg>/<file>?rev=<row rev>` | `…/lib/client.js:725`（`chunkUrl(row, fileName, … ?? row.rev)`）、`:480-486` |
| 响应头：`public, max-age=31536000, immutable`（一年、不重验证） | `…/lib/index.js:159` + `:963-971` |
| `(id,fileName,rev)` 不匹配 ⇒ **404**（"mismatched revisions are rejected instead of serving newer bytes"） | 同上 `:158` 注释 + 实测（见 11.3） |

**复算命令（与平台同算法，可直接对照 serve 出来的 rev）**
```powershell
# 平台 serve 的 rev（从页面 boot manifest 抓）
$page = (Invoke-WebRequest $tokenUrl -UseBasicParsing).Content
[regex]::Match($page, '\{"id":"dsh-remote-wsl","url":"([^"]+)","rev":"([0-9a-f]+)"').Groups[1..2].Value
# 本地独立复算（同一算法：sha1("plugin-artifact" + \0 + framed(mtime, ctime, size)) 取前 12 hex）
node spike/verify/explorer-20261012/tools/check-client-rev.mjs --print-rev
```

实测两者**逐字相等**（本次 = `07cf221a6f42`），故门禁脚本的复算与平台一致，可用来判定"rev 会不会变"。

### 11.2 两层陈旧（本次实测：**服务器侧也有**，不只是浏览器缓存）

| 层 | 现象 | 实测 |
|---|---|---|
| **L1 host 侧快照** | 宿主在扫描时**快照 chunk 字节**；此后只改 chunk（入口未动）⇒ 入口 rev 不变 ⇒ `:611` 短路 ⇒ **不重读** ⇒ 连**空缓存的全新浏览器**也拿到旧字节 | 改 `client.panel.js`（加标记 V2）后，同 URL 仍返回 **旧字节**（55863，无 V2）；再次改（V4）后同 URL **仍**返回 V2（55905）⇒ 快照陈旧 |
| **L2 浏览器 immutable 缓存** | chunk URL 由入口 rev 决定 ⇒ 入口不动则 URL **一模一样**，而响应是 `immutable`（一年不重验证）⇒ 浏览器**根本不发请求**，直接用本地副本 | 改了 `client.i18n.js` 的 `panel.title` 并**重启宿主**（服务端已是新字节）后，同一浏览器上下文重新加载：四个 chunk 的 `transferSize=0`（**零网络请求**），界面文案仍是旧的 |

L1 的**解法**与 L2 相同：**让入口 rev 变化** ⇒ 新 URL ⇒ 新的快照 + 新的缓存键。

### 11.3 正确姿势（改任何 chunk 时**必须**同时 bump 入口）

1. **改入口 `client/index.js` 的内容**（推荐、可复现）：加/改一行版本注释即可，例如
   ```js
   // client-rev: 2026-10-13 chunk=client.panel.js（改了 xxx）
   ```
   `rev` 含 `size` 与 `mtime/ctime` ⇒ 内容一变 rev 必变 ⇒ chunk URL 变 ⇒ 缓存失效、宿主重读。
2. **不推荐只 `touch client/index.js`**：它确实能改 mtime/ctime ⇒ rev 也会变，但 clone/checkout 会重置 mtime，跨机器不可复现（别人拿到手的 rev 可能又撞回旧 URL）。
3. 改完跑门禁（见 11.4）确认。
4. 排查"改了没生效"时：先看页面 boot manifest 里的 `rev` 是否变了；没变就是本条坑。

### 11.4 机器门禁：`spike/verify/explorer-20261012/tools/check-client-rev.mjs`

```powershell
node spike/verify/explorer-20261012/tools/check-client-rev.mjs            # 自动选模式（git→baseline→mtime）
node spike/verify/explorer-20261012/tools/check-client-rev.mjs --self-test # 自测：副本里"改 chunk ⇒ FAIL / 改入口 ⇒ PASS"
node spike/verify/explorer-20261012/tools/check-client-rev.mjs --mode baseline --update   # bump 后记录基线
node spike/verify/explorer-20261012/tools/check-client-rev.mjs --print-rev                # 只算当前入口 rev
```

- **退出码**：`0` PASS ／ `1` FAIL（chunk 变了而入口未 bump，并打印"必须怎么做"）／`2` 用法或环境错误 ／`3` 判定不可得（既无 git 又无基线）。
- **三种模式**：`git`（默认，最准：入口最后一次内容变更的提交之后有 chunk 变更、且入口元数据不比它新 ⇒ FAIL）；`baseline`（便携；`--update` 落的 `.client-rev-baseline.json` 记录 rev + 各 chunk 内容 sha256，rev 未变而 chunk 哈希变了 ⇒ FAIL）；`mtime`（保守兜底：存在 chunk 的 mtime 晚于入口 ⇒ FAIL）。
- **局限（必读）**：它需要**历史**才能判定——纯"当前文件"信息无法区分"chunk 是在入口最后一次变化之前还是之后改的"。故须 git 或基线；`mtime` 模式在**全新 checkout**（所有 mtime 几乎同时）下可能误报，可用 `--mtime-tolerance <ms>` 放宽（放宽会同时放过真缺陷）。
- **它不做的**：不改任何文件（除 `--update` 写基线）、不做内容哈希推断 rev（那会与平台行为不一致）。
