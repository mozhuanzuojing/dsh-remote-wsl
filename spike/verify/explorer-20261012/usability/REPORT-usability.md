# REPORT-usability —— 「远程资源管理器」P0 可用性评估（task-5）

> ## ⚠️ 被测量的 revision（务必先读）
> **P0 冻结集 13 锚点，`client/client.panel.js` = 29,111 B / `8F5CE575F50F182FA94F584A47B8A9401E7F580C5206C5BD2E3483867957439E`，修复前。**
> 全部观测发生在 **2026-10-12 15:58–16:20**（实例 15:47 启动、15:44:37 冻结）。收尾复算（16:22:23）检出 **盘上已变**：`client.panel.js` → **32,377 B / `D5F236A0…`**。
> ⇒ 本报告全部结论对应**变更前**版本；变更后的 delta 复验由 lead 安排（只复验 F34/F25 与受影响的条目）。
> **F34/F25 标注**：本报告 **§1 与 L1 就是 F34 家族**（首挂载误报"已撤下" + 结果条被自身刷新清空）。**F25（fixPin 失败仍成功语气）我没有观测证据** —— 我未触发 fixPin（面板仅在 drift 时显示该按钮，我的实例 drift 未变红），故**不声称**。
> 复算锚点：`out-98-revision-freeze.txt`（15:44:37）vs `out-98-revision-end.txt`（16:22:23）。

- **评估者**：`usability-engineer` ｜ **实例**：`http://127.0.0.1:8961`（profile `remote-wsl-test` **只读** + 我的 `--patch`：`distro=debian-u8-1 / cwd=/home/g/project/dsh1 / daemonPort=8962`）
- **视口**：1280×800 @1x ｜ **主题**：light（dark 未测） ｜ **用户活宿主 19387**：开工/收工均 pid **47564**（未碰）
- **原始证据**：`out-12-raw-dom.json`（DOM 逐字）、`out-20-evidence-log.md`（含 a11y 快照、探针、WSL 复核的逐字流水）

---

## 0. 结论（≤450 字）

**P0 面板"看得见、点得动"成立，但基准场景到不了"会话建好"。**

**动作数**：点 rail 图标(1)＋点「在新会话中打开」(1)＝**2 次点击即发出请求**（实测 `clickCount=2`、4 条同源 POST、0 error）；但会话不物化，按界面自己的说明还要切到会话面板并发一条消息(+3) ⇒ **现实 5 动作 vs 同口径 VS Code 2 动作**（文档+manifest 级证据）。

**最重的四条**：① **主行动零可见反馈** —— 结果条被它自己触发的刷新在同一次 React 批里清空，MutationObserver 全程 **0 次插入**（同类：F34）；② **首挂载加载态就写「数据不可用：读取失败后已撤下」**，把没发生的失败当事实（**＝F34**）；③ **底栏显示的是别的实例的守护**（16:00 显示 `slot 8932`、16:12 显示 `slot 8982`，我配置的是 **8962**），而按钮自称「本插件自有槽位」「仅此槽位」—— **误导性所有权声明**，真按下去会停他人守护；④ 路径列 `direction:rtl` 把 `/home/g/project/dsh1` **渲染成 `home/g/project/dsh1/`**（DOM 文本正确，只有渲染错）。

**可发现性**：图标有可访问名、8 个控件 **0 个 title-only**（候选 D1 被推翻）；真缺陷是**关键语义只在 hover**、下拉仅一项＝死控件、主视线暴露 `slot/keys/daemon`、空态只陈述无下一步。

**容错**：M6 二次确认真实有效（点"停止"不发请求；取消后 WSL 侧守护 pid 未变）⇒ **通过**；错误态有原因＋重试＋事实撤下 ⇒ **通过**。

**未核实**：dark 主题、S-CTRL 对照、最终确认（破坏性路径）、键盘/读屏。

---

## 1. 动作序列（S-BASE：「我要在 WSL 的 `/home/g/project/dsh1` 里干活」）

| 步 | 实际操作（逐字） | 类 | 结果 | 证据 |
|---|---|---|---|---|
| **A1** | 点 rail 图标 `button "远程资源管理器"` | click | 面板上屏：标题「远程资源管理器」副标题「目标 debian-u8-1 · /home/g/project/dsh1」 | `shot-02b-after-click.png`、`out-20` §2 |
| **A2** | 看树里的 `dsh1` 行（已默认展开） | — | `▾ debian-u8-1 [默认发行版][运行中 · 1 路径][当前目标]` → `📁 dsh1` / `/home/g/project/dsh1` | `out-12-raw-dom.json` |
| **A3** | 点 `button "在远端会话中打开 /home/g/project/dsh1（首次发消息时才物化会话）"` | click | POST `explorer.openSession{distro,path}` → POST `explorer.snapshot`（刷新） | 探针请求流水 |
| **A4** | 读动作结果条 | — | **不存在**（`noteRect=null`；observer `noteLifecycle: []`） | `out-20` §3 |
| **A5** | 切到会话面板 + 发一条消息使其物化 | click+输入+发送 | **未实测**（不烧模型调用/不建会话）；按 UI 自身文案 ⇒ +3 动作 | 设计 §4 末条 |

- **动作数**：观测 2 次点击（均 trusted）｜**现实 5**｜**附加成本**：关键语义需 hover（H）见 L3/L4；本场景 S（滚动）＝0。
- **对比 VS Code（同口径 V-C）**：打开 Remote Explorer(1) + 点「在当前窗口中连接」(1) = **2**。
  基线出处（**文档+manifest 级证据，未实测 GUI**，理由见 §7）：`%USERPROFILE%\.vscode\extensions\ms-vscode-remote.remote-wsl-0.104.3\package.json` 的 `views.remote(id=targetsWsl)` / `menus.view/title`（`addDistro`/`refresh`）/ `menus.view/item/context`（`inline@1/2`）；官档 <https://code.visualstudio.com/docs/remote/wsl.md>（"From VS Code" ≈6、"From terminal `code .`" 1）。

---

## 2. 认知负荷问题清单（现象 → 为什么是负荷 → **控件级**改进）

| # | 现象（证据） | 为什么是负荷 | 控件级改进（改哪个控件、改成什么） |
|---|---|---|---|
| **L1** | 点「在新会话中打开」后**界面无任何变化**：`.dsh-rw-note` 两次点击 **0 次进入 DOM**（`noteLifecycle: []`）。代码上 `run()` 成功即 `setAction({note})`，紧接着 `load()` 又 `setAction({note:null})`，同一批被清空 | 用户无法判断"点到了没有/成没成"，只能重复点击；而这一步的语义（会话**未**物化）恰恰是最需要被告知的 | **把结果条从"每次 load 都清空"解耦**：`load()` 不清 `action.note`，改由"下一次动作"或用户关闭时清；或把结果条移出 `body`、做成**吸底固定条**（不会随刷新消失）；文案用「已准备会话（首次发消息时建立）」 |
| **L2** | 首挂载期间底栏同时显示「正在读取 explorer.snapshot（/remote-wsl/api，超时 9000ms）…」**和**「数据不可用：读取失败后已撤下，不显示守护/漂移状态。」（`out-20` §1，**＝F34**） | 在一切正常的第一秒就报"失败"，用户会以为插件坏了；同一句话在真失败时也出现 ⇒ 失去区分度 | `statusLeft` 加第三态：`loading && lastSuccessAt===null` 时文案改「正在读取守护状态…」；只有 `status==='error'` 才用「已撤下」 |
| **L3** | 底栏 `daemon slot 8962 · :8962 · pid 930015 · 0.2.0-rc.2 · keys 0`：「slot/keys/daemon/pid/0.2.0-rc.2」全是内部概念，出现在**主视线**；端口还写了两遍（`slot 8962` 与 `:8962`） | 用户要的是"远端跑着没/我的会话会不会丢"，不是槽位与版本号 | 主文案改「远端守护：运行中 · 会话 0 个」；把 `slot/port/version/pid` 收进紧随其后的小字或 `title`；**去掉重复端口** |
| **L4** | 两个**关键语义只写在 `title`（hover 才见）**：① distro 下拉的 label title＝「仅筛选视图；P0 契约里没有 explorer.selectDistro，切换不写 host 配置」；② 打开按钮 title＝「…（不预热：首次发消息时才建立远端会话）」 | 这两条恰好决定"我选的发行版生效了吗""会话开好了吗"——不看 hover 就会得出**错的结论** | ① 下拉右侧常显小字「筛选视图（不改目标）」＋「当前目标」做成独立只读徽标；② 行上加常显徽标「未物化」或按钮文案改为「准备会话（首次发消息时建立）」 |
| **L5** | 「WSL 目标」下拉**只有一个选项**（`options:["debian-u8-1（默认）"]`），仍占标题行要位；且它是**视图筛选**、不改配置 | 一个"可选择但无可选"的控件消耗注意力且暗示有配置能力（实际没有） | 单选项时降级为**静态徽标**「WSL 目标：debian-u8-1」，有 ≥2 个发行版才升格为下拉 |
| **L6** | 空态（注入 `distros:[]`）只有一句「wsl.exe -l -v 没有返回任何发行版（WSL 未安装，或没有已安装的发行版）。」，无按钮、无命令（`out-20` §4.2） | 用户在此**无路可走**：不知道该装什么、装完要不要重启 DSH | 空态内加可照做的一步：「在 Windows 终端运行 `wsl --install -d <发行版>`」＋「已装好？点这里刷新」按钮（直接复用 `刷新`） |
| **L7** | 动作失败（代码路径：`run()` 的 error 分支只渲染 `失败：<host 原话>`）没有重试按钮，而**快照级**错误态有「重试」（`out-20` §4.1） | 同一种"失败了"在两处给不同出路；用户学到"重试"只在某些地方有效 | 结果条组件与错误态**共用**一个 `<Feedback>`：错误时始终带「重试」按钮（重放同一次调用） |

> 说明：L1/L2 与 lead 正在修的 **F34** 是同一族（观察与假事实）。L7 是**代码先验**（我未能制造动作级失败；快照级失败已实测）。

---

## 3. 可发现性缺陷（阈值：只有"完成基准场景必须用到的工具/语义只存在于 hover"或"无下一步"才计缺陷）

| ID | 缺陷 | 真界面证据 | 严重度 | 控件级改进 |
|---|---|---|---|---|
| **D3** | 「在新会话中打开」的**真实语义（不物化会话）只在 `title`**；可见标签承诺"打开"。用户按字面理解会以为会话已建好 | `out-12-raw-dom.json`：`text:"在新会话中打开"` / `title:"…（不预热：首次发消息时才建立远端会话）"`；A4 无反馈 | **高** | 可见文案改「准备会话（首次发消息时建立）」；或行内常显「未物化」徽标 |
| **D4** | distro 选择器的**"仅筛选、不写配置"只在 `title`**；且只有一个选项＝**死控件** | 同上：`labelTitle:"仅筛选视图；P0 契约里没有 explorer.selectDistro，切换不写 host 配置"`、`options.length=1` | **高** | 常显「筛选视图（不改目标）」；单选项降级为静态徽标（同 L5） |
| **D5** | **内部术语进主视线**：底栏 `daemon … slot … keys …`；"刷新"按钮的可访问名/`title` 写 `explorer.snapshot`；错误态正文写 `/remote-wsl/api`、`transport` | terminology 命中：主视线 `slot×2, keys×1, daemon×1`；title `explorer.snapshot×1, snapshot×1, slot×2` | 中 | 主视线只留人话；`explorer.snapshot`/`/remote-wsl/api`/`transport` 移入「原始 snapshot」折叠区或 `title` |
| **D6** | 底栏「停止 slot 8962…」「重启…」的**内部概念**（slot 号、`没有 all`）出现在可见文案；解释只在 `title`/弹层 | `text:"停止 slot 8962…"`、`aria:"…（需二次确认，仅此槽位，没有 all）"`、确认层写「本插件自有槽位，不存在 all 选项」 | 中 | 改为「停止远端守护（端口 8962）」；"没有 all"这类**实现自证**从用户文案里删掉（它回答的是评审问题，不是用户问题） |
| **D7** | **空态无下一步**（同 L6） | `out-20` §4.2：`emptyHasButtonInside:false`、按钮仅「刷新」「启动守护」 | 中 | 空态内给 `wsl --install` 指引 + 刷新 |
| — | ~~D1 图标无可访问名~~ | **被推翻**：a11y 快照里 rail 项可访问名＝「远程资源管理器」；8 个面板控件 `titleOnly=0 / unnamed=0` | — | 无需改（保留为"已核实无此缺陷"） |

**对照（避免误判）**：VS Code 的树项 inline 动作同样 hover 才显现（`menus.view/item/context` 的 `inline@N`）⇒ "hover 才可见"本身不算缺陷；上表只列**关键语义/必需动作**只存在于 hover 或缺失的情形。

---

## 4. 容错与反馈（M6/M5）

| 项 | 观测 | 判定 |
|---|---|---|
| 危险动作是否有确认 | 点「停止 slot 8962…」→ `role="alertdialog"`，文案含后果（"正在跑的会话全部中断、上下文丢失"）+ slot + `keys/session = 0`；**确认前 `daemonRequests=0`** | **通过** |
| 取消是否真的什么都没发生 | 取消后：弹层消失、`explorer.daemon` 请求数 **0**；WSL 侧 `daemon.8962.json` 仍在、8962 仍监听 | **通过** |
| busy 锁 | 点 A3 后：`在新会话中打开`/`重启`/`停止` 变 disabled；**「复制路径」仍可点**（该按钮无 `disabled` 绑定） | 轻微不一致（低） |
| 快照读失败 | 错误态给出：原因 + `出口/类型` + **「重试」按钮**；事实（树/守护/漂移）整体撤下，且明说"数字已全部撤下…可能陈旧" | **通过**（M5） |
| 动作失败 | 代码路径只渲染 `失败：<host 原话>`，**无重试按钮**（见 L7，未实测） | 缺陷（代码先验） |

---

## 5. P0 缺口 / 偏差分类（口径：**只扣"P0 承诺了却没做到"**）

| ID | 项 | 设计地位 | 观测 | 定性 |
|---|---|---|---|---|
| **G-1** | 「＋ 添加收藏路径」 | §2 线框有 `＋`；§6 把 `＋/－` 列 **P1** | 观测到的 8 个控件里**无**"添加/＋"（`out-12`） | **P0 已知缺口 / P1 待补**（不计缺陷）。**代价**：用户要把 `/home/g/project/dsh1` 加进列表，只能改 host 配置或 WSL 侧 `~/.dsh/remote-wsl/explorer.json`（本机该文件当前**不存在**，实测），＝**越界面动作** |
| **G-2** | 「在终端中打开」 | §2 线框的行内动作 | 无此控件 | 缺口（P0 清单未承诺） |
| **G-3** | 「从列表移除」 | §2 线框 | 无此控件 | 缺口 |
| **G-4** | 「⋯ 更多」 | §2 线框 | 无此控件 | 缺口 |
| **G-5** | `settings.section` 配置页 | §3 标 **P1** | 无入口 | 缺口 |
| **G-6** | 「打开 Web UI」 | §5 交互表有 | 无此控件 | 缺口 |
| ~~X-1~~ | 起停/重启/`修 pin` | §6 列 P1 | **存在**（启动守护/重启…/停止 slot N…/修 pin） | **已由 lead 裁决转正为受认可的 P0 超集 ⇒ 不计偏差**；但其**跨槽位错显**（§6 below）另计 |
| **X-2** | 标题行 `＋ ⟳ ⋯` vs 实现 | §2 线框 | 实现为 `下拉 + 刷新`，无 `＋`/`⋯`（`＋` 已计 G-1） | 偏差（轻），报告留档 |
| **X-3** | 行内动作「hover 才显现」vs 实现 | §2 线框说"每行 hover 动作" | 实现为**常显** link 按钮 | **正向偏差**（比线框更可发现） |

### 5.1 另记：跨槽位错显（不属于 G/X 分类，是**观测到的行为问题**）
同一面板在 14 分钟内先后显示 **8932（T4）→ 8982（T7）→ 8962（我，被 A3 的 ensure 拉起）**；我的实例配置是 8962。
WSL 侧同时存在 `daemon.8962.json` 与 `daemon.8982.json`。按钮文案却同时声称「本插件自有槽位」「仅此槽位」。
⇒ 两条后果：**(a) 用户分不清这个守护是不是"我的"**；**(b) 在别人的守护上做出所有权声明，并可直接停掉它**。
控件级改进：底栏在 slot ≠ 本实例 `daemonPort` 时显示「其它实例的守护 slot N（本面板不提供停止/重启）」并**禁用**两个按钮；或在标签里明写「本实例槽位 8962 ≠ 当前显示槽位 8982」。

---

## 6. 主题与可读性（M9）

- light 下截图正常（`shot-02b-after-click.png`）；`color-scheme=light`。
- **dark 未测**：`chrome-devtools-mcp` 对应用页截图在 16:05 后持续超时（同页 DOM 读取正常），未完成主题切换+截图 ⇒ 记 **未核实**（不写成通过）。

---

## 7. 截图（3 张，均在本目录）

![面板展开（light）—— 标题行/树/底栏；注意路径列渲染为 home/g/project/dsh1/](<D:/project/dsh1/vendor/dsh-remote-wsl/spike/verify/explorer-20261012/usability/shot-02b-after-click.png>)

![侧栏带标签态：可见「插件」「远程资源管理器」两行（图标可辨识性证据）](<D:/project/dsh1/vendor/dsh-remote-wsl/spike/verify/explorer-20261012/usability/shot-02a-rail-before-click.png>)

![侧栏折叠态（headless 视口）](<D:/project/dsh1/vendor/dsh-remote-wsl/spike/verify/explorer-20261012/usability/shot-01-rail-collapsed.png>)

> 第 2、3 张由 **OS 级窗口抓取**（cua `get_window_state … screenshot_out_file`）产生并直接写入本目录；`chrome-devtools-mcp` 的 `filePath` 写不进本目录（报 "not within any of the configured workspace roots"），故其产图经附件转存（`shot-01`）。
> **路径 RTL 缺陷证据**：`shot-02b` 中路径列显示 `home/g/project/dsh1/`，而 DOM 文本是 `/home/g/project/dsh1`（`out-12-raw-dom.json` 的 `controls[4].aria` / 树行文本）——**只有渲染错，DOM 是对的**。

---

## 8. 未测 / 不确定（不许当通过）

| 项 | 原因 / 影响 |
|---|---|
| **dark 主题** | 应用页截图工具超时（见 §6）；M9 只测了 light |
| **S-CTRL（默认 `cwd=/home/g` 对照）** | lead 16:2x 叫停新增测项；**G-1 的"越界面成本"因此只有设计/配置面证据**，无第二场景实测 |
| **M6 的最终「确认停止」** | 未点是**刻意的**：当时面板指向 `slot 8962`（我的），但同一面板早前指向 8932/8982（他人）；避免误停他人守护。破坏性路径未实测 |
| **A5 会话物化** | 需要真发一条消息（烧模型调用/建会话）；只按 UI 自身文案计入 +3 动作 |
| **键盘顺序（M10）/ 屏幕阅读器** | Tab 轨迹未逐次记录；无 NVDA 环境。仅静态证据：8 控件均可聚焦、0 个无名 |
| **动作级失败（L7）** | 未制造出动作级失败（唯一实测失败是快照级）；L7 为代码先验 |
| **fixPin 语气（F25）** | 我的实例 `drift` 未变红，面板未显示「修 pin」⇒ **无观测证据，不声称** |
| **客户端 bundle 的确切 rev** | 未记录实例实际加载的 `plugins/??dsh-remote-wsl/client.js&rev=…` ⇒ 无法排除观测期内一次 HMR 混入；但实例 15:47 启动、证据取自该实例，且盘上文件在 16:2x 才被检出变化 |
| **VS Code Remote-WSL 实机动作数** | 未实测 GUI（会拉 `vscode-server`、抢前台）⇒ 基线为**文档+manifest 级证据** |
| **desktop(Electron) 壳** | 需重启用户宿主 ⇒ 禁忌；只在 web 实例测 |
| **tab2 渲染进程失联** | 15:57 后 `take_screenshot`/`evaluate_script` 对 tab2 超时；**换 tab3 后同一操作全部复现、面板全程响应** ⇒ 记为环境异常，**不归因面板** |

---

## 9. 证据索引（本目录）

| 文件 | 内容 |
|---|---|
| `out-98-revision-freeze.txt` / `out-98-revision-end.txt` | 首尾 revision（**已变**：29111→32377 B） |
| `out-11-patch.yml` / `out-11-dumpconfig-_home_g_project_dsh1.txt` | 我的 overlay + `--dump-config`（第 1282–1289 行证明 `distro/cwd/daemonPort=8962` 生效） |
| `out-04-url.txt` / `out-03-usabhost-8961.log{,.err}` | 带 token 的实例 URL（裸 `/`=401）、启动日志（含首试 `web` 参数被拒的错误） |
| `out-10-livehost-baseline.txt` / `out-05-startup-facts.txt` | 用户宿主 pid 47564 与实例事实 |
| `out-12-raw-dom.json` | 控件级 DOM 抽取逐字值（8 控件、0 title-only、术语命中、下拉语义） |
| `out-20-evidence-log.md` | **主证据流水**：a11y 快照（加载态/错误态/空态/确认层）、探针计数与 4 条请求、M6 取消复核、跨槽位三次读数、收尾清理对照 |
| `shot-01/02a/02b-*.png` | 3 张截图（见 §7） |
| `MATRIX-usability.md` | 评估矩阵（阈值、场景模板、缺口/偏差口径）；`usab-*.js` / `usab-run.ps1` | 采集骨架（本报告是它们跑出来的） |
| `usab-p0scope.js` | M11 范围探针 —— **未跑**（lead 叫停）；缺口/偏差分类改由"已观测控件清单 + 设计稿逐条对照"得出 |
