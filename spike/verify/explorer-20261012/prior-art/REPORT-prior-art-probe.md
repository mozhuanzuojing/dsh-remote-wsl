# 先例对齐的可行性实测报告（task-11）

- **日期**：2026-10-12 ｜ **执行**：client-contract ｜ **写作用域**：本目录（`spike/verify/explorer-20261012/prior-art/`）
- **背景文档**：`docs/prior-art-dsh-wsl.md`（生态先例 + 官方约定 + 采纳清单 A1–A8）
- **纪律**：本插件源码/文档/`package.json` **全程只读**；未 npm/pnpm install 到任何共享目录；未弹任何可见窗口（`--no-open` + 后台作业，无 `Start-Process`）；端口只用 **8911**；未触碰用户宿主（19387，实测结束时仍存活）；每次运行结束都停掉自己的进程并确认 8911 已释放。
- **证据分级**（本报告每条都标）：
  - **【实测到】** = 在另起的隔离实例上跑出来的结果，原始输出在本目录 `raw-*.json/txt`；
  - **【读代码推断】** = asar 内已解包源码的行级证据（路径+行号可核），未在运行时验证；
  - **【未复核】** = 没拿到证据，**不猜**。

---

## 0. 结论速览

| # | 问题 | 结论 | 分级 |
|---|---|---|---|
| 1 | `ctx.workspaces` / client 工作区 API 的确切签名 | host 服务名是 **`workspaceRegistry`**（不是 `workspaces`）；`create(path, title)`；client 侧有 **`ctx.workspaces`**（CRUD/projection）与 **`ctx.uiWorkspace`**（浏览+会话+打开）两套 | 【实测到】+【读代码推断】 |
| 1b | WSL 路径能不能成为 DSH 工作区 | **能，但只能用 UNC 形式**：`\\wsl.localhost\<distro>\<path>` 与 `\\wsl$\<distro>\<path>` 都创建成功；**发行版内路径 `/home/g` 被拒**（`TypeError: Workspace path is not fully qualified`）；路径必须**已存在** | 【实测到】 |
| 2 | 两个 `directoryFlow` 槽 | 都是 `single`/`root`；官方 occupant = `@deepseek-ai/dsh-client-ui-directory-picker-native` 的 `NativeDirectoryFlow`（**不写 priority ⇒ 0**）；**「最低 priority 者渲染」双向实测确认**（+10 输、−10 赢） | 【实测到】 |
| 3 | 手写 bundle 的 `require` 表 | 16/17 可达（9 个平台种子 + 7 个图行）；**`@deepseek-ai/dsh-client-runtime` 不存在**（三份 bundle 全部 require 失败）；`ctx.get('locale')` 可用 ⇒ **A4 可走官方 locale** | 【实测到】 |
| 4 | `dsh.client.immediately` | 语义 = 在**插件树 boot 之前**把该行所在 **batch** 执行完（`prefetchImmediateTier()`）；**不会多拉文件**；同 batch 对照实验**无可观测差异** ⇒ 我们**不需要** | 【实测到】+【读代码推断】 |
| ★ | 额外发现（会改 A1/A3 的做法） | **官方目录浏览能力在本机 web 组合下不可用**：`uiWorkspace.listDirectory()` 抛 `directory-picker/unavailable: … needs the browse capability; the composed picker serves "native"` | 【实测到】 |

---

## 1. 官方工作区能力（决定 A1）

### 1.1 服务面：host 是 `workspaceRegistry`，client 有两套

**【实测到】** host 服务名 = **`workspaceRegistry`**（`ctx.get('workspaceRegistry')` 拿到实例）。原型方法清单（运行时枚举，原始输出 `raw-02`）：

```
archiveSession(1) bootstrap(1) create(2) createCanonical(2) delete(1) deleteKnown(1)
enqueueOperation(1) get archivedSessionIds get pinnedSessionIds get(1) indexHeader(1)
indexHeaders(1) indexLiveSessions(0) initializeDefault(1) insertBefore(2) list(0)
listStoredHeaders(0) pinSession(1) readSessionHeader(1) rebuildEntities(0)
recoverPendingMutation(0) replaceHeaderIndex(1) reportFilteredCandidates(0) requireState(0)
requireTable(0) resolveByPath(1) sessionKnown(1) setState(1) stopSessionActivity(1)
unarchiveSession(1) unpinSession(1) validateStoredState(1)
```

【读代码推断】服务声明处：`dsh-workspace/lib/index.js:354-374`（`class WorkspaceRegistry extends Service`、`static inject = ["storageDomain","sessionPersistence"]`、`super(ctx, "workspaceRegistry")`）。
`create(path, title)` 的语义：`:395-410` —— `realpathNormalize(path)`（要求**全限定**且**存在**）→ `stat().isDirectory()` → 复用同 canonical 路径的既有 workspace。

**【实测到】** client 侧**两个**服务（`raw-07`）：

| client 服务 | 原型方法（运行时枚举） |
|---|---|
| `ctx.workspaces` | `create, rename, delete, initializeDefault, insertBefore, insertSessionBefore, archiveSession, unarchiveSession, pinSession, unpinSession`（+ `ownKeys: ctx,name,model,list` 里的 `list` 快照 store） |
| `ctx.uiWorkspace` | `listDirectory(2), createDirectory(2), pickDirectory(0), startSession, openSession, openWorkspace, connectWorkspace, forkSession, pinSession, archiveSession, initializeDefaultWorkspace, restoreSelection, watchNavigation, clearMain, replaceMain, reuseBlank, reuseOrCreateBlank, clearArchivedCurrent` |

> ⚠ **对 prior-art 文档的更正**：§2.2 写的是「`ctx.workspaces.listDirectory` / `createDirectory`（client runtime 上）」。
> 实测 **`ctx.workspaces` 没有这两个方法**；目录浏览在 **`ctx.uiWorkspace`** 上（其实现见
> `dsh-client-ui-workspace/lib/client.js:884-892`，内部转 `ctx.remote.directoryPicker`）。
> `ctx.uiWorkspace.listDirectory` 的签名是 `(path, signal)`（arity 2，path 可为 `undefined`）。

### 1.2 WSL 路径 → DSH 工作区：**能，但只能 UNC**

**【实测到】** 用 `ctx.get('workspaceRegistry').create(path)` 跑 5 个用例（`raw-02`，隔离 DSH_HOME）：

| 用例 | 路径 | 结果 |
|---|---|---|
| `\\wsl.localhost\` UNC | `\\wsl.localhost\debian-u8-1\home\g` | ✅ **ok**，`id=c29a0b2f-d7a2-40d3-ac5d-132c644c9f01`，`path` 原样保留，`title="g"` |
| `\\wsl$` 旧式 UNC | `\\wsl$\debian-u8-1\home\g` | ✅ **ok**，`id=a1a2d3e9-a42d-4182-8698-c751eaab33a5`，`title="g"` |
| UNC 下不存在的子目录 | `\\wsl.localhost\debian-u8-1\home\g\definitely-not-here-t11` | ❌ `ENOENT: … realpath '…'` |
| **发行版内路径** | `/home/g` | ❌ `TypeError: Workspace path is not fully qualified: '/home/g'` |
| Windows 对照（已存在目录） | `C:\Users\l\AppData\Local\Temp\rwsl-t11\win-control-dir` | ✅ **ok**，`id=a4d52eeb-8a56-44b1-8531-70277eebc3ab` |

- `resolveByPath()` 对两个 UNC 路径都返回实体；`list()` 投影按新→旧列出三个 workspace（`raw-02` 的 `projection`）。
- 实体形态（实测 `ownKeys`）：`["host","id","record"]`；`id` 是 UUID，**没有** `workspaceId` 字段（客户端投影 `WorkspaceView` 才叫 `workspaceId`）。
- 【读代码推断】为什么 `/home/g` 被拒：`dsh-workspace/lib/index.js:20-24`
  ```js
  function fullyQualifiedWorkspacePath(path, platform = process.platform) {
    if (platform !== "win32") return posix.isAbsolute(path);
    const root = win32.parse(path).root;
    return win32.isAbsolute(path) && root !== "\\" && root !== "/";
  }
  ```
  win32 下 `/home/g` 的 `win32.parse().root === "/"` ⇒ 直接判非全限定。UNC 的 root 是 `\\host\`，所以通过。

### 1.3 怎么创建（三条可用路径）

**【实测到】** 三条都绕开了 UI：
1. host 侧直接 `ctx.get('workspaceRegistry').create(uncPath, title?)` —— 本报告就是这么做的（**不经 picker 能力**，见 §5）。
2. client 侧 `ctx.get('workspaces').create({...})`（Remote namespace `workspace.create`）—— 【读代码推断】签名：`@Remote('create') create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue>`，`WorkspaceCreateRequest = { readonly path: string }`（`dsh-api-workspace-controller/lib/typert.host.js:576 / :673-679`）。当前 DSH 自己的 picker 就是走这条：`dsh-client-ui-workspace/lib/client.js:1920` `createWorkspace({ path })`。
3. 事件/命令面无 —— 【未复核】没有去查有没有 CLI/命令入口。

### 1.4 A1 的可行性判断 + 必须写进 README 的代价

- **可行**：把「添加为 WSL 工作区」落在 `workspaceRegistry.create('\\\\wsl.localhost\\<distro>\\<path>')`。
- **硬约束**：只能是 **UNC**；发行版路径（`/home/g`）**不可能**成为 DSH 工作区。这与设计稿 §7 的 UNC 约定一致，但把「UNC 是唯一形态」从约定升级成了机制事实。
- **代价（必须明写）**：workspace 的 `path` 是 UNC ⇒ DSH 的文件工具/会话 cwd 都会经 **9P**（`\\wsl.localhost\`）走。设计稿 §7 已记录「UNC 上跑写型 Windows 工具会写坏 ext4 属主/权限」。⇒ 若采纳 A1，README 必须把「**该工作区内的写入走 9P，不要在其中跑 git/npm 等写型 Windows 工具**」写清楚；我们现有的「经 `wsl_exec` 执行」纪律要与之并列。
- **【未复核】** 用 UNC 工作区真的开一个会话（`startSession`，cwd=UNC）是否成功、会话头部 cwd 校验是否通过、以及 9P 上的实际读写风险 —— 本轮没跑（需要模型/会话，超出只读取证）。

---

## 2. 两个官方目录选择器槽（决定 A3）

### 2.1 槽名、kind、声明者

**【实测到】**（实例页面里 `ctx.slots.spec()` / `entries()`，原始输出 `raw-05`）：

| 槽 | spec | declaredBy | 官方 occupant |
|---|---|---|---|
| `sidebar.workspaces.directoryFlow` | `{kind:"single", scope:"root"}` | `an entry in "sidebar.workspaces" (mf)` | `NativeDirectoryFlow` @ priority 0 |
| `conversation.hero.workspace.directoryFlow` | `{kind:"single", scope:"root"}` | `an entry in "conversation.hero.workspace" (mf)` | `NativeDirectoryFlow` @ priority 0 |

**【读代码推断】** 声明点：
- `dsh-client-ui-workspace/lib/client.js:4299-4305` —— `sidebar.workspaces` entry 的 `children` 里声明 `{kind:"single",scope:"root"}`；
- `dsh-client-ui-workspace/lib/client.js:4398-4406` —— `conversation.hero.workspace` entry 的 `children` 里声明同名子槽；
- README 原文（`dsh-client-ui-workspace/README.md:94`）：*"Each registration declares a **directory-flow child hole** (`single` kind …). The flat **Add workspace...** action renders only while the surface's hole is occupied; an empty hole means the composition has no picking affordance."*

### 2.2 官方 occupant 的包名与注册方式

**【读代码推断】** 两个官方实现：
- `@deepseek-ai/dsh-client-ui-directory-picker-native` —— `lib/client.js:54-76`：
  `const inject = ["slots","uiWorkspace"]`；`ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () { yield ctx.slots.register({name:"conversation.hero.workspace.directoryFlow", inject: injected}, NativeDirectoryFlow); yield ctx.slots.register({name:"sidebar.workspaces.directoryFlow", inject: injected}, NativeDirectoryFlow); }))`
  —— **没有 `priority` 字段 ⇒ 默认 0**；组件返回 `null`（renderless，`:50`）。
- `@deepseek-ai/dsh-client-ui-directory-picker-browse` —— `lib/client.js:1027-1035`，同形（应用内浏览对话框）。
- **【实测到】** 本机 web 组合的 boot graph 里**只有 `-native`**（`raw-06` 的 picker 条目 grep 结果；`dsh-web-app/cordis.patch.yml:113-114` 挂 host 侧 `@deepseek-ai/dsh-host-directory-picker-auto`）。

### 2.3 occupant 的 props 契约

**【读代码推断】** owner 侧（`dsh-client-ui-workspace/lib/client.js:1945-1962`）传给 occupant 的 props：

```js
const flowOwner = {
  open: flowOpen,              // boolean：是否处于选择流程
  busy: pickingFolder,         // boolean：已提交、正在被 host 接纳
  onPicked: (path) => {...},   // 选中一个路径（owner 会 createWorkspace({path})）
  onCancel: () => {...},
  onError: (message) => {...}, // 失败交给 owner 的 modal
};
```
渲染点：`:1988` `renderDirectoryFlow(flowOwner)`（= `renderSlot("<hole>", flowOwner)`）。
occupant 侧自己 `inject: () => ({ pick })`（native 包 `:65`），并在 `open` 变 true 时调用
`pick()`，然后按 `onPicked(path)` / `onCancel()` / `onError(msg)` 回报（native 包 `:36-50`）。
**【实测到】** 我们的探针 occupant 在 RUN2 里被渲染成
`<div data-t11-flow="im">T11-FLOW-WINNER role=im open=false busy=false</div>` —— `open`/`busy` 两个 owner prop 确实被传入。

### 2.4 优先级语义：**「最低者渲染」——双向实测确认**

**【实测到】** 关键在**同一次实验只改 priority 一个变量**，且页面**不打开任何菜单**（避免触发 OS 选择框）：

| RUN | 我们的 priority | 官方 priority | 我们注册的 occupant 是否进了 DOM |
|---|---|---|---|
| 1 | **+10** | 0 | ❌ 否（`[data-t11-flow]` 计数 0） |
| 2 | **−10** | 0 | ✅ 是（计数 1，内文 `T11-FLOW-WINNER role=im open=false busy=false`） |
| 3（对照，无任何包注册该槽） | — | 0 | ❌ 否（计数 0，排除「元素来自别处」） |

⇒ **priority 更小者优先渲染**（+10 输给 0；−10 赢过 0），且 RUN3 否证了「元素本来就在页面上」的解释。
【读代码推断】机制一致：`dsh-client-ui-slots/lib/index.js:167-172`（`single` 槽同 priority 冲突会 throw，
错误文案自带 *"register at a different priority to shadow it (lowest renders)"*）、`:278-293`
`entriesOfSlot()` 按 priority 升序取每 cell 的第一个。

**先例说法核对**：`dsh-wsl-workspace-picker` 自称「官方在 0、它在 −10 顶替官方」—— 机制与我们实测的完全一致
（官方确实 0；更低 priority 确实赢）。⇒ **A3 的「顶替官方 picker」招式在本机机制上成立**（不需要改官方包）。
但**是否值得用**见 §5：本机组合下官方 picker 的 `browse` 能力根本不可用（§4），而 native `pick()` 会弹可见窗口。

---

## 3. 手写 loader bundle 的 `require` 表（决定 A4）

**【实测到】** 三个手写 bundle（差别只有 `dsh.client` 声明）在 factory 内逐个 `try{require(spec)}catch`，
三个 role 结果**完全一致**（原始输出 `raw-07` 与 `raw-04`）：

**可取到（16/17）**

- 平台种子 9 项：`react`、`react-dom`、`react/jsx-runtime`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`（⚠ 最后这个**没有对应的 npm 包**，只是种子表里的名字，见 §3.2）
- 图行 7 项：`@deepseek-ai/dsh-client-locale`、`-ui-sidebar`、`-ui-workspace`、`-ui-layout`、`-ui-renderer`、
  `@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-modules`

**取不到（1/17）**

- `@deepseek-ai/dsh-client-runtime`
  → `client-modules: require("@deepseek-ai/dsh-client-runtime") missed the module table — not a platform seed word,
  not a materialized module, and no registered package factory`

> ⚠ **对 prior-art 文档的更正**：§2.3 把 `@deepseek-ai/dsh-client-runtime` 列为「官方客户端包名」。
> **该包在 DSH 0.2.0-rc.2 里不存在**（asar 的 package.json 全表里没有；运行时 require 直接抛）。
> 真正存在的 client 包名见上面 16 项里的 7 个图行 + 种子名。

**【读代码推断】** 为什么三种声明结果一样：`dsh-client-modules/lib/client.js:698-706` 的**同步** `require`
只有三条命中路径（平台种子 / 已 materialize / 工厂已注册），否则抛错；而 `:644-661` `arriveGraphRow`
会先按 `row.inject` 抵达依赖、再 `arrive(row)` 加载**整个共享 batch**。
⇒ 我们的三个探针包在**同一个 application batch** 里，第一个抵达的就把整批注册了，
所以 `plain`（无 inject）也能同步 require 到那 7 个包。
**结论**：`dsh.client.inject` 不是"能不能 require"的开关，而是**顺序保证**（保证在 consumer 之前抵达）；
跨 batch / 不同组合下不声明就可能抛错 —— 【未复核】没有构造跨 batch 的反例。

### 3.1 A4（i18n）的判定

**【实测到】**
- `ctx.get('locale')` = **present**（`raw-07`），原型方法齐全：
  `register, bind, translate, lookup, getLocale, setLocale, subscribe, getSnapshot, addLanguage, adopt,
  resolveText, publish, publishCatalog, localeList, fallbackChain, assertFallbackChain, resolveActive`。
- `require('@deepseek-ai/dsh-client-locale')` 也可用（导出 `LocaleRuntime, COMMON_NS, FALLBACK_LOCALE, SETTINGS_NS, apply, inject`）。
- `document.documentElement.lang === "zh-CN"`，`html[lang] === "zh-CN"`。

⇒ **A4 走官方 locale 服务是可行的**，而且**不必**改 `dsh.client.inject`：`ctx.get('locale')` 直接拿得到
（要用 `ctx.locale` 这种注入式写法则把 `"locale"` 加进 `exports.inject`）。两条路都通；
`document.documentElement.lang` 作为兜底也成立（实测值 `zh-CN`，非空）。

### 3.2 一个反直觉的种子事实

**【实测到】** `require("@deepseek-ai/dsh-client-ui-dockkit")` 成功返回一个有 `DOCK_ZONES/DockLayout/Sequencer/...`
的对象，但 asar 里**没有** `@deepseek-ai/dsh-client-ui-dockkit` 这个包。
⇒ 平台种子表（`dsh-web-frontend/dist/assets/index-5SrrfWpU.js` 的 `rM()`，9 个键）**不能**用"包里有没有这个包名"来推断。
【读代码推断】种子表内容（9 键）：`react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
@deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit`。

---

## 4. `dsh.client.immediately` 的确切语义（决定要不要用）

### 4.1 声明与校验位置（**【读代码推断】**）

- `dsh-client-modules/lib/index.js:61-75` `parseDshClient`：`immediately` 必须 boolean，返回 `{platform, inject?, external?, immediately?}`。
- `:720-727` `resolveMeta`：`immediately: decl.immediately === true`。
- `:394-403` `graphRow`：`...fields.immediately ? { immediately: true } : {}` ⇒ **只有为真才写进 wire row**。
- wire 解析（浏览器侧）：`dsh-client-modules/lib/client.js:135-139` → `plugins.push({id, inject, immediately: row.immediately === true})`。

### 4.2 它真的做什么（**【读代码推断】+【实测到】wire**）

消费点在 **web 外壳**（`dsh-web-frontend/dist/assets/index-5SrrfWpU.js`，字符串偏移 ≈631064 / ≈631652）：

```js
// boot(): 注意顺序 —— 先起 prefetch，等它完成，然后才 boot 插件树
this.modules = o.create({ boot: __DSH_BOOT__, staticModules: rM(), ... });
this.manifest = this.modules.manifest;
const a = this.prefetchImmediateTier();
this.ctx = u; this.page.setTotal(this.manifest.plugins.length);
await a; await JS({ ctx: u, modules: this.modules, manifest: this.manifest, ... });
...
async prefetchImmediateTier() {
  await Promise.all(this.manifest.plugins.filter(e => e.immediately)
    .map(e => this.modules.prefetch(e.id).catch(n => {})))
}
```

`dsh-client-modules/lib/client.js:758-764` `prefetch(id)` → `arriveGraphRow(row)`；而
`arrive(row)`（`:610-619`）的 `preferred = row.initialUrl`（**共享 batch URL**），`loadShared` 去重；
`:612` 已注册就直接返回。

⇒ **语义**：把该行**所属 application batch 的执行**提前到「插件树 boot 之前」完成，从而保证该包的
factory 在树激活时已注册；**不**执行模块副作用（lazy-CJS，副作用在 materialize 时）。
**不是**"给这个包单独拉一个文件"。

### 4.3 对照实验（**【实测到】**，`raw-06`）

| RUN | bundles 含 `immediately` 包 | 网络 script 请求 | `lz`/`plain` 的同步 require 结果 |
|---|---|---|---|
| 1 / 2 | 是（`dsh-t11-client-im`） | 2 条 application batch + bootstrap + 2 条 shell = **5 条**，**没有单包 combo 请求** | 16/17 成功 |
| 3（对照，移除 im） | 否 | 同形 | **16/17 成功（完全相同）** |

⇒ **参数默认组合下，`immediately` 对同 batch 内的包无可观测差异**（既没多请求，也没让 require 从失败变成功）。
它的价值在于**跨 batch / 激活期被别的包 require**：官方用它的是 kernel tier ——
`dsh-client-modules`、`dsh-client-ui-renderer`、`dsh-client-hmr`、`dsh-client-connection`、`dsh-api-gateway`、
`dsh-api-remotes`、`dsh-typert-registry`（各自的 `package.json` 里 `dsh.client.immediately: true`）。

### 4.4 我们该不该用

**不必要**（建议不用）。我们的 client 半是 leaf：没有任何包在激活期 `require` 我们；实测同 batch 下加不加它
没有任何可观测差别。若哪天出现"别的包在激活期必须 require 我们"，再加。

---

## 5. 额外发现（**会改 A1/A3 的做法**）：官方目录浏览能力在本机组合下不可用

**【实测到】**（RUN4，`raw-09`）在页面里直接调官方 client 服务：

```
await ctx.get('uiWorkspace').listDirectory(undefined)
  -> DirectoryBrowseError: directory browse failed: directory-picker/unavailable:
     directoryPicker.list needs the browse capability; the composed picker serves "native"
await ctx.get('uiWorkspace').listDirectory('C:\\Users\\l')                -> 同上
await ctx.get('uiWorkspace').listDirectory('\\\\wsl.localhost\\debian-u8-1\\home\\g') -> 同上
ctx.remote.directoryPicker.pick()  -> Error: cannot get property "remote" without inject
```

**【读代码推断】** 原因链：
- `dsh-web-app/cordis.patch.yml:113-114` 挂 `@deepseek-ai/dsh-host-directory-picker-auto`；
- 该包的 resolve 规则（文件头 JSDoc）：`native` 需要「loopback-only bind + 非 SSH + 可服务显示会话
  （darwin/win32 直接假定成立）」⇒ **本机 win32 + 127.0.0.1 + 非 SSH ⇒ native**；
- `dsh-api-workspace-controller/lib/index.js:483/498/517`：`pick()` 需 `native` 能力，
  **`list()` 与 `createDirectory()` 需 `browse` 能力**；组合只提供一个后端 ⇒ 另一侧必抛 `directory-picker/unavailable`。

⇒ **对 prior-art 文档 §2.2 的更正**：「浏览用宿主既有能力，不要自己造（复用 `listDirectory`/`createDirectory`）」
在这台机器的 `dsh web` 组合下**做不到**。这是**组合依赖**结论，不是普适结论（换成 browse 组合或远程浏览器组合就可用）。
⇒ 对我们：面板里要列目录，**仍旧得用我们自己的 host 侧列目录**（`wsl` 命令那套），这条刻意分歧（D1/D2 一族）在
本机组合下不是"可选优化"，而是**唯一可行**。同时 `workspaceRegistry.create()` **不走 picker 能力**
（`dsh-workspace/lib/index.js:406-409` 直接 `fs.realpath`）⇒ 「面板里选好路径 → 创建 WSL 工作区」这条路可行。

---

## 6. 未复核清单（**不猜**）

| 项 | 状态 | 说明 |
|---|---|---|
| UNC 工作区里真开一个会话（`startSession`，cwd=UNC） | **未复核** | 需要真实会话/模型；本轮只读取证未跑。会话头部 cwd 必须 `realpath` 等于 workspace path（`dsh-workspace/lib/index.js:114-122`） |
| `insertBefore` / `insertSessionBefore` / `delete` 的确切请求体 | **未复核** | 只从 typert 目录拿到 `@Remote` 名与签名，没有逐个读请求 schema |
| `dsh.client.inject` 在**跨 batch**或"consumer 先于 dependency 抵达"时的失败形态 | **未复核** | 同 batch 下三份 bundle 结果一致；未构造反例 |
| `require.async("<pkg>")` 的运行时行为 | **未复核** | 只读了 `client.js:707-713/743-757` 的代码；为避免在图构建期产生副作用，本轮**故意没有调用** |
| 官方 `-browse` picker 在其被组合进 boot graph 时的表现 | **未复核** | 本机 web 组合只加载 `-native`；`-browse` 只有源码证据 |
| `dsh-wsl-workspace`（mimikao）等先例的**实现方式** | **未复核** | 本轮没有取它们的源码（prior-art 文档也标了 CDN 取不到 README） |
| `dsh.client.immediately` 在**跨 batch**下的可观测差异 | **未复核** | 对照实验只覆盖同 batch |
| client 半热更 / `dev:web` | **未复核** | 已在 task-1 契约文档 §7 标过；本轮未涉及 |
| `\\wsl.localhost` 工作区下的 9P 读写风险（属主/权限） | **未复核（本轮无法验证）** | 属设计稿 §7 的记录；本轮只确认"路径能成为 workspace" |

---

## 7. 原始输出与复跑

本目录文件：

| 文件 | 内容 |
|---|---|
| `raw-01-workspace-api-run1.json` | 第一次 workspace 实验（`id` 字段名还没修对；用来对照） |
| `raw-02-workspace-api-run2.json` | **主证据**：5 个用例 + 实体 `id` + `projection` |
| `raw-03-workspace-api-run3-control.json` | RUN3（去掉 immediately 包）的 workspace 输出 |
| `raw-04-client-report-run3.json` | RUN3 三个…两个 client bundle POST 的完整报告（require 表 + 服务表 + 槽表） |
| `raw-05-directoryflow-and-priority.txt` | 槽 spec / occupants / 三次 DOM 计数 / owner props 契约 |
| `raw-06-immediately.txt` | `immediately` 的代码位置、shell 片段、wire 证据、对照实验、网络请求清单 |
| `raw-07-client-module-table.txt` | 16/17 require 表 + 三个 client 服务的原型方法 + i18n 两条路 |
| `raw-08-runtime-environment.txt` | 隔离环境/命令行/三次运行表（含"为什么要自己解包 asar"） |
| `raw-09-directory-picker-capability.txt` | **§5 的原始报错**与原因链 |
| `raw-10-workspace-api-run4.json` | RUN4 的 workspace 输出 |

探针与运行时（**在 `%TEMP%`，不在仓库**）：
`%TEMP%\rwsl-t11\{plug-host,plug-im,plug-lz,plug-plain,generate.mjs,runtime,home\profiles\t11}`。

复跑：见 `raw-08`。要点：`DSH_HOME=%TEMP%\rwsl-t11\home`、`--profile t11 --port 8911 --no-open`、
`T11_PRIORITY` 控制 occupant 优先级、`T11_OUT` 指定结果文件。

---

## 8. 对采纳清单的净影响（一句话每条）

- **A1**：**可行但形态被锁死** —— 只能 `\\wsl.localhost\<distro>\<path>`（UNC），发行版路径不行；创建走
  `workspaceRegistry.create()`（host）或 `ctx.workspaces.create({path})`（client）；**README 必须写 UNC/9P 写入代价**。
- **A3**：**「顶替官方 picker」机制成立**（−10 赢、+10 输，实测），但**本机组合下官方 browse 能力不可用**，
  且 native `pick()` 会弹可见窗口 ⇒ 我们面板的目录浏览**仍应自建**；可抄的是 UI 形态（chips/面包屑/路径输入/隐藏文件），不是数据面。
- **A4**：**走官方 locale 可行**（`ctx.get('locale')` 实测可用，`register/bind/translate` 齐全），
  `document.documentElement.lang` 作为兜底也成立。**不需要**为它改 `dsh.client.inject`。
- **immediately**：**不用**（实测同 batch 无差别）。
- **更正 prior-art 文档两处事实**：§2.2 的 `ctx.workspaces.listDirectory/createDirectory` 应为 `ctx.uiWorkspace`；
  §2.3 的 `@deepseek-ai/dsh-client-runtime` 在 0.2.0-rc.2 **不存在**。
