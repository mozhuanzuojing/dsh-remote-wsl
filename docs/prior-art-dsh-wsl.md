# 先例调研：现有 DSH 的 WSL 插件设计与我们的对齐（2026-10-12）

> **为什么写这份**：本插件的 P0 面板（侧栏「远程资源管理器」）是**我们自己设计**的挂点与交互。而 npm 上已经有一批**面向 DSH 的 WSL 插件**在跑真实用户 —— 它们暴露了 DSH 的**官方约定**（槽位、服务注入、兼容声明、目录浏览器形态），也暴露了**这套问题域的主流解法**。本文件把所有可参考的事实、我们的对齐清单与刻意分歧一次写清，供下一轮直接照做。

## 0. 调研方法与边界（可复跑）

| 手段 | 命令 / 位置 | 结果 |
|---|---|---|
| npm registry（**经 geph 代理**） | `curl -x http://127.0.0.1:9910 https://registry.npmjs.org/-/v1/search?text=dsh-wsl&size=25`；`.../<pkg>/latest` | ✅ 拿到 20+ 个相关包的名字/描述/作者/仓库/版本/日期，及 3 个包的 `package.json` 关键字段 |
| README（经代理由 CDN 取） | `curl -x … https://cdn.jsdelivr.net/npm/<pkg>/README.md` | ✅ `dsh-wsl-workspace-picker`、`dsh-plugin-wsl-env`、`dsh-wsl-tool` 全文 |
| 本地 DSH 实现 checkout | `…\DeepSeek Harness\resources\app.asar.unpacked\dsh`（**注意不是 `app.asar\dsh`**） | 只看到 `node_modules/`，**非** monorepo 源码；包名含 wsl/remote 的 **0 个** |
| 兄弟插件 | `D:\project\dsh1\vendor\{dsh-remote-wsl, dsh-shadow, dsh-browser-computer-use, _src, .docs}` | 无其它 WSL 插件 |
| 用户 `web` profile | `~\.dsh\profiles\web\package.json` | bundles = `dsh-base`/`dsh-web-app`/`dsh-experimental-agent-team-profile`/`dsh-shadow`/`dsh-kit`/`dsh-experimental-voice-input-bundle`/`dsh-browser-computer-use`/`@aiwayds/dsh-feishu` —— **没有 WSL 插件** |
| **`web_search` 工具** | —— | ❌ **不可用**：`DEEPSEEK_SEARCH_BASE_URL` 未配置/密钥无效（HTTP 401）。本次改走"代理 + curl + registry/CDN"，**结论不依赖 web_search** |
| `web_fetch` 工具 | —— | ❌ 不走代理，`fetch failed`。同上处理 |

**未复核**：`dsh-wsl-workspace` 的 README（CDN 取不到，只有 `package.json` 字段）；`dsh.client.immediately` 的**确切语义**（未实测，只看到两个包用它）。

## 1. 生态清单（与我们同域的部分）

| 包 | 作者 | 版本/日期 | 一句话 | 与我们的关系 |
|---|---|---|---|---|
| **`dsh-wsl-workspace`** | mimikao | **0.7.7 / 2026-10-12** | **从 Web GUI 添加一个 WSL 工作区，整个会话（bash + 文件工具）在发行版内运行，VS Code Remote-WSL style，WSL 里无需装工具链**；并声明 `compatibility.dshReleases`（0.1.0-rc.7 → 0.2.0-rc.2 全 compatible） | **同题最强先例**：它的"工作区"路线 vs 我们的"常驻守护 + 远端会话"路线 |
| `dsh-plugin-wsl-env` | Big-Dao | 0.9.0 / 2026-10-06 | 把 WSL 发行版当**会话执行环境**：命令/文件读写都在发行版内，**目录选择器与 GUI 终端也定位到发行版路径**；用发行版内 **bubblewrap 沙箱、fail-closed** | 最接近的"环境级"方案；**沙箱立场**是我们没有的 |
| `dsh-wsl-desktop` | zcluo | 0.3.5 / 2026-10-10 | DSH Desktop 的 WSL 执行世界：加 WSL 工作区，所有工具在发行版内跑 | 同族，Desktop 壳侧重 |
| **`dsh-wsl-workspace-picker`** | williamshi666 | 0.1.1 / 2026-08-17 | **增强版"选择工作区目录"对话框**：`/mnt` 盘快捷 chips、**从 `/` 起的完整面包屑**、**常显路径输入**、新建文件夹、隐藏文件开关 | **直接可抄的 UI 先例**（我们的树就是目录浏览器）；README 顺带讲清官方槽 |
| `dsh-wsl-projects` | valentsev | 0.2.3 / 2026-10-03 | **每个项目一个 WSL 内 dsh web 服务/端口/dsh home**，从 Windows 端管理 | 与我们的**槽位=端口**模型互为印证 |
| `dsh-wsl-tool` | XINY11451 | 1.12.2 / 2026-10-12 | 6 个模型面工具：`wsl`/`wsl-path`/`wsl-env`/`wsl-doctor`/`wsl-bootstrap`/`wsl-term`；Windows↔WSL 路径转换、发行版环境汇总、工具链体检、按配方补装、侧栏终端读写 | **工具面先例**：我们缺 `wsl-path`（互转）与 `wsl-doctor`（体检） |
| `dsh-wsl-tray` / `dsh-web-tray` / `dsh-wsl-launcher` | ablee34 / p45senger / ruoqingzhao | 09-27 → 10-05 | 托盘/开始菜单/桌面快捷方式启动 WSL 里的 `dsh web` | 与我们的 `wsl_open_ui` 目的相近，形态不同 |
| `dsh-wsl-expose` | ranbosama | 1.7.0 / 2026-08-20 | 把 WSL 里的 Web GUI 经反代暴露到公网（Lucky + portproxy + IPv6 检测 + trusted-host 围栏） | 反向（外网暴露）；它的 trusted-host 思路可借鉴 |
| `dsh-network-settings` | kjnwrf | 0.3.3 / 2026-08-21 | Windows/WSL 网络状态、诊断与安全修复 | 与我们 §5 的握手/端口域重叠 |
| **`dsh-remote-explorer`** | btsd321 | 0.8.4 / 2026-10-08 | "远程开发启动器：把 dsh 装到远程主机并在本机浏览器用，凭据不离开本机" | **名字最像**（但对象是远程主机 + 隧道，不是 WSL）；注意与我们**包名不同**（`dsh-remote-wsl`），可共存 |
| `@jiyr0119/dsh-workspace-explorer` | jiyr0119 | — | 原生 DSH 插件：**右侧面板**工作区目录树，点击/拖拽插入文件引用，含搜索/预览/**国际化** | **面板形态先例**：i18n、搜索、拖拽引用 |
| `dsh-explorer-editor` | — | — | VS Code 风格文件管理器（浏览/打开/编辑当前会话工作区文件） | 同族 UI |
| `@linxin666/dsh-client-ui-skill-explorer` | linxin666 | — | skill 中心的 Web GUI 面板（按来源分组、启停、增删） | 面板 + 官方 slot/服务用法先例 |
| `dsh-workspace-hub` / `dsh-workspace-kit` / `@huanlin/dsh-plugin-ya-workspace-sidebar` | — | — | 侧栏工作区文件夹分类、拖拽排序、⌘K 搜索、图标/颜色 | 侧栏交互先例（拖拽/搜索） |

## 2. 从先例里提取的**官方约定**（可直接照做）

1. **官方目录选择器挂两个槽，且槽是"吞噬式"（优先级最低者渲染）**：
   - `sidebar.workspaces.directoryFlow`（侧栏工作区 **`+`** 按钮背后）
   - `conversation.hero.workspace.directoryFlow`（会话首页的工作区选择器背后）
   - 官方实现在**优先级 0**；`dsh-wsl-workspace-picker` 用 **−10** 顶替它，**不改官方包**，卸载即恢复。
   ⇒ **对我们**：我们的面板不是"目录选择器"，**不要去抢这两个槽**；但"打开某个路径"这个动作，最正统的落法是走**工作区**这条路（见 §3-A1）。
2. **浏览用宿主既有能力，不要自己造**：`ctx.workspaces.listDirectory` / `createDirectory`（client runtime 上）—— picker 的目录列表**完全复用**它、"no host-side code, no filesystem access of its own"。
   ⇒ **对我们**：我们自建了 `explorer.snapshot` 的树（host 侧 `wsl` 命令列目录）。**两者可以并存**，但如果目标是"让用户能用 WSL 路径开工"，官方路径更短。
3. **`dsh.client.inject` 声明的是"官方客户端包名"**：`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-sidebar`、`@deepseek-ai/dsh-client-ui-primitives`（不是槽名）。
   ⇒ **对我们**：我们 `inject: []`。**但注意**：我们的 client 半是**手写 loader bundle**（只用平台种子 `react`/`react-dom`/…），**并不 import** 这些包 ⇒ 声明它们反而是错的。**这条要按"我们实际用到什么"决定，别照抄**（见 §3-A4）。
4. **兼容性声明 `dsh.compatibility.dshReleases`**：逐版本 `compatible` 映射（`dsh-wsl-workspace` 已列 11 个版本）。
   ⇒ **对我们**：我们有 `engines.dsh = >=0.2.0-rc.2`，但**没有**这个映射。**低成本、高互操作价值**（见 §3-A2）。
5. **`dsh.client.immediately`**：`dsh-wsl-tool` 用它（`inject:['…/dsh-client-ui-primitives'], immediately:true`）。**语义未复核**。
6. **双面包的官方布局**：`package.json(dsh.bundle.patch + dsh.client)` + `cordis.patch.yml` + **构建产物** `lib/index.js` / `lib/client.js`（ESBuild 编 TS/TSX，`react`/`react/jsx-runtime`/`…primitives` 作为 external 由 Web 壳的模块表解析）。
   ⇒ **对我们**：我们**零构建**（手写 `client/*.js`）。这是**刻意分歧**（见 §4-D1）。
7. **i18n 是默认要求**：`dsh-client-locale` 服务 + README 双语（`dsh-wsl-workspace-picker`：English/简体中文，跟随 UI 语言；`dsh-workspace-explorer` 也标 i18n）。
   ⇒ **对我们**：面板**中文写死**。**这是最明显的生态落差**（见 §3-A3）。
8. **安装/升级路径**：`dsh plugin --profile <p> add <pkg>`（我们一致）；`dsh <profile> --from-default-profile web` 造 profile（用它建 `wsl` profile 的做法值得学）。
9. **模型面工具命名**：生态用**连字符** `wsl`/`wsl-path`/`wsl-env`/`wsl-doctor`/`wsl-bootstrap`/`wsl-term`；我们用 **snake_case** `wsl_status`/`wsl_exec`/`wsl_agent`/`wsl_daemon`/`wsl_open_ui`/`wsl_sync_version`。
   ⇒ **不建议改名**（破用户），但要**知道**：同一台机器上如果同时装 `dsh-wsl-tool`，两套工具名并存（不冲突，但模型可能选错）⇒ 建议在 README 写"与 `dsh-wsl-tool` 的分工"。
10. **安全立场（最值得警惕的一条）**：`dsh-wsl-tool` 明写 *"`wsl` 调用位于 DSH 沙箱层之下，文件策略约束不到它"*；`dsh-plugin-wsl-env` 的对策是**发行版内 bubblewrap、fail-closed、绝不 unconfined**。
    ⇒ **对我们**：我们的 `wsl_exec` / `wsl_agent` **同样在 DSH 沙箱之下**（守护在 WSL 里跑，宿主文件策略管不到）。**这是必须在 README 明写的边界**（见 §3-A5）。

## 2.4 实测更正与新增结论（T11，2026-10-12 当天）

> `client-contract` 的只读取证，报告：`spike/verify/explorer-20261012/prior-art/REPORT-prior-art-probe.md`（每条标了「实测到 / 读代码推断 / 未复核」）。**下面两条更正就是冲着本文件 §2 写的。**

**更正 1（§2.2）**：`listDirectory` / `createDirectory` **不在 `ctx.workspaces`**（它只有 CRUD/projection），而在 **`ctx.uiWorkspace`**。
**更正 2（§2.3）**：`@deepseek-ai/dsh-client-runtime` **在 `0.2.0-rc.2` 不存在** —— 把它当"官方客户端包名"是错的（先例的 `inject` 值不能照抄，这也解释了为什么我们 `inject: []` 是对的）。
**更正 3（§2.2 的"复用官方 browse"）**：在本机的 web 组合下**做不到** —— `dsh-web-app` 挂 `dsh-host-directory-picker-auto`，win32 + loopback + 非 SSH ⇒ 组合出 **native**，而 `list`/`createDirectory` 是 **browse-gated** ⇒ `DirectoryBrowseError: directory-picker/unavailable`。这是**组合依赖**，不是普适事实；⇒ **面板列目录必须自建**（我方做法：新增 host 只读方法 `explorer.listDir`，经 UNC 读、不启动发行版）。

**新增结论 1｜A1 可行：WSL 路径能成为 DSH 工作区，但只能用 UNC**（实测到）
- host 服务名 **`workspaceRegistry`**（不是 `workspaces`），`create(path, title)`（arity 2）。
- `\\wsl.localhost\debian-u8-1\home\g` ✅ 创建成功；`\\wsl$\debian-u8-1\home\g` ✅ 也成功；**发行版内路径 `/home/g` ❌** `TypeError: Workspace path is not fully qualified`（`dsh-workspace/lib/index.js:20-24` 在 win32 下把 root=`/` 判非全限定）。
- 路径**必须已存在**（不存在 ⇒ ENOENT realpath）。
- 创建路径三条：host `registry.create()`（**不经 picker 能力**）｜client `ctx.workspaces.create({path})`（`WorkspaceCreateRequest = {path}`）。
- ⇒ **A1 可做**，但 README 必须并列写明：**该工作区路径是 UNC ⇒ 文件工具的读写走 9P**（与设计稿 §7 的"经 UNC 读"是同一条约定，代价要写清）。

**新增结论 2｜`directoryFlow` 槽的"最低优先级者渲染"双向实测成立**（实测到）
- 两槽都是 `single`/`root`；官方 occupant = `@deepseek-ai/dsh-client-ui-directory-picker-native` 的 `NativeDirectoryFlow`，**注册时不写 priority ⇒ 0**，且 renderless。
- 同一份 bundle 只改 priority：**+10 ⇒ 官方赢**；**−10 ⇒ 我们赢**；第三次对照（无人注册该槽）⇒ 计数 0（排除"元素本来就在页面上"）。全程未打开任何菜单 ⇒ 没触发 OS 选择框。
- owner props 契约：`{open, busy, onPicked(path), onCancel(), onError(msg)}`，occupant 自 inject `{pick}`。
- ⇒ 先例"在 −10 顶替官方 picker"**机制上成立**。但我方**仍不抢这两个槽**：我们的面板不是目录选择器（见 §3-A3 与更正 3）。

**新增结论 3｜手写 bundle 的 require 表：16/17 可达**（实测到）
- 可达：9 个平台种子（react / react-dom / react/jsx-runtime / react-dom/client / cordis / client-store / ui-slots / ui-primitives / **ui-dockkit**）+ 7 个图行（client-locale / ui-sidebar / ui-workspace / ui-layout / ui-renderer / client-connection / client-modules）。
- **`ctx.get('locale')` 实测可用**（`register/bind/translate/lookup/setLocale`…），`document.documentElement.lang === "zh-CN"` ⇒ **A4（i18n）可走官方 locale，且不必改 `dsh.client.inject`**。
- ⚠️ `dsh-client-ui-dockkit` 是**种子名但没有对应 npm 包** ⇒ **别用"包存在性"推断种子表**。

**新增结论 4｜`immediately` 我们不需要**（实测到 + 读代码推断）
- 语义 = "插件树 boot **之前**先执行该行所在 batch"；外壳 `prefetchImmediateTier(){…filter(e=>e.immediately).map(e=>modules.prefetch(e.id))}`。
- `prefetch` 拉的是**共享 batch URL**（不会多请求：实测 script 请求 5 条，无单包 combo）。
- **对照运行**（把唯一的 immediately 包从 bundles 移除）：同步 `require` 结果**完全相同** 16/17 ⇒ 同 batch 下**无可观测差异** ⇒ leaf 插件不需要用它。

**未复核（T11 报告 §6）**：UNC 工作区**真开会话**的文件工具路径、跨 batch 的 `inject`/`require.async` 行为、9P 写入的性能与语义风险。

> **2026-10-22 更新**：其中「UNC 工作区 `startSession` 能不能真开一个会话」**已核实**（web 实例 + CDP 端到端：
> `addWorkspace(UNC)` → `ctx.get('uiWorkspace').startSession(ws.id)` → `mainReference` 变新 session、主视图切换；
> 见 `spike/verify/uiworkspace-20261022/REPORT-uiworkspace-verified.md`）。仍未核实的是**开会话后文件工具在 9P 上的行为**与性能。

## 3. 采纳清单（按价值/成本排序）

| # | 采纳项 | 为什么 | 怎么做（具体） | 成本 | 风险 |
|---|---|---|---|---|---|
| **A1** | **"在工作区中打开"走官方工作区路线** | 生态主流是把 WSL 当**工作区**（`dsh-wsl-workspace` / `dsh-plugin-wsl-env` 都这样），而我们只做"远端会话"，用户拿不到"工作区/文件工具在 WSL 内"的完整体验 | 面板行内动作增加「**添加为 WSL 工作区**」：宿主侧调官方工作区能力（`ctx.workspaces` / 现有 workspace 流程）绑定 `\\wsl.localhost\<distro>\<path>` 或发行版路径；保留现有"在新会话中打开"为快路径 | 中 | 需先实测官方 workspace API 与"Windows 宿主 + WSL 路径"的语义；**不改**我们既有工具 |
| **A2** | **加 `dsh.compatibility.dshReleases`** | 生态通行；装插件时能明确"这个 DSH 版本支不支持" | 在 `package.json` 加映射，先列我们**实测过**的 `0.2.0-rc.2`（+ 明确标 `unknown` 的版本不写） | 极小 | 无（纯声明） |
| **A3** | **目录浏览器对齐 `dsh-wsl-workspace-picker`** | 它是**同题 UI 的成熟解**，且明确点出官方 picker 的可用性死角（家目录折叠、`/mnt` 不可达、路径输入不可发现） | 我们面板的树加：**快捷 chips（Home / `/` / `/mnt` / `/mnt/c…`）**、**常显路径输入（回车跳转）**、**从 `/` 起的完整面包屑**、**隐藏文件开关**；并复用 picker 的措辞（中英双语） | 小 | 与既有树/空态/错误态保持一致；不改 host 协议 |
| **A4** | **i18n（跟随 UI 语言）** | 生态默认要求；我们写死中文 | client 半接入 `@deepseek-ai/dsh-client-locale`（或最小实现：从 `document.documentElement.lang` 取），中英两套文案 | 中 | 需要 client 半能拿到 locale 服务（**先实测** `require` 表里有没有它） |
| **A5** | **README 明写"沙箱边界"** | 同类插件都把它当卖点/边界写清楚；不写就是**误导用户以为文件策略管得到 WSL** | 加一节：`wsl_exec`/`wsl_agent` 在 DSH 沙箱与文件策略**之下**；如需隔离请用 WSL 侧手段（对照 `dsh-plugin-wsl-env` 的 bubblewrap fail-closed） | 极小 | 无 |
| **A6** | **补 `wsl-path`（Windows↔WSL 路径互转）** | 我们频繁需要（README 里到处手写 `/mnt/d/...`）；`wslpath` 是现成能力 | 新增一个工具（或加到 `wsl_status` 输出），调 `wslpath -a/-u/-w`；命名建议**跟生态** `wsl_path` | 小 | 新工具需纳入冻结+复验 |
| **A7** | **`wsl-doctor`（工具链体检）** | 同类插件的招牌能力（"发行版里缺什么、哪些命令其实是 Windows 二进制"） | 按需；至少把"发行版里有没有 node/pnpm/rg/git/bwrap"做成 `wsl_status` 的一行或独立工具 | 中 | 只读，风险低 |
| **A8** | **与 `dsh-wsl-tool` 的分工说明** | 两者可同时装；命名不同（`wsl_*` vs `wsl-*`），模型可能选错 | README 加一小节对照（谁负责守护/会话/UI，谁负责一次性命令/体检） | 极小 | 无 |

## 4. 刻意分歧（保留，但写清代价）

| # | 分歧 | 他们的做法 | 我们为什么保留 | 代价（要写进 README） |
|---|---|---|---|---|
| **D1** | **零构建 vs ESBuild** | `src/*.tsx` → `lib/client.js`（TSX + 官方 primitives） | 我们的 client 半**手写 loader bundle**：不引 bundler、不写 JSX、只用平台种子 —— 与"零构建 TS"约定一致，交付物即源码，审计友好 | 不能用 JSX/官方 UI primitives；手写 `createElement` 冗长；**必须自己维护 chunk 加载**（`require.async`） |
| **D2** | **常驻守护 + 远端会话 vs "发行版即会话环境"** | 后者的文件工具/终端/命令都在发行版内，路径语义天然正确（无 `/mnt` 性能坑） | 我们保留守护形态：**关客户端 ≠ 会话结束**、跨宿主重连、空闲回收、显式停止 —— 这是本插件的**核心语义**（README §设计要点） | 用户拿不到"发行版内文件工具"；`/mnt/*` 下的项目仍是 Windows 文件系统语义（同类插件也这么提醒） |
| **D3** | **不沙箱 vs bubblewrap fail-closed** | 发行版内 bubblewrap 包住每条命令，缺 bwrap 就**失败关闭** | 我们的命令就是用户自己 WSL 里的 shell（`wsl_exec` 的语义是"我在 WSL 里跑一条命令"），加沙箱会改变用户预期 | **必须在 README 写清**（=A5）；如需隔离给指引 |
| **D4** | **工具名 snake_case vs 连字符** | `wsl` / `wsl-path` / `wsl-env` | 我们的 6 个工具名已发布并被文档/夹具引用，改名破坏兼容 | 与 `dsh-wsl-tool` 并存时上下文里有两套名字（=A8） |

## 5. 结论（一句话）

**同域已经有 10+ 个真插件，其中 `dsh-wsl-workspace`（10-12 更新）与我们几乎同题但走"工作区"路线；`dsh-wsl-workspace-picker` 给了我们面板可直接照抄的目录浏览器形态；`dsh-plugin-wsl-env` 给了沙箱立场。** 我们应当：**（A2/A5/A8）立刻补齐声明与边界文档；（A3）把面板目录浏览器对齐成熟解；（A1/A4/A6/A7）按优先级排进下一轮**，同时把 **D1–D4 四条刻意分歧连同代价写进 README**。
