# task-5 可用性评估矩阵 —— P0「远程资源管理器」（认知负荷 / 可发现性 / 容错）

- **日期**：2026-10-12 ｜ **评估者**：`usability-engineer`
- **被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`（`client/**` + `src/explorer.ts` + `package.json` 的 `exports["./client"]`/`dsh.client`）—— **只读**
- **写作用域**：本目录 `spike/verify/explorer-20261012/usability/` ｜ **端口段**：8961–8963（+8964–8970 备用）
- **状态**：**准备完成，未开工**（开工条件见 §0.1；在 G2–G4 齐备前**不对界面下任何结论**）
- **准备期探测时间**：2026-10-12 11:26–11:45（"准备期实测"结论均可复算，见 §8）

> 本文件只写**要量什么、怎么量、量到什么算缺陷**。真正的观测值一律不写在这里，等 lead 放行后填进 `REPORT-usability.md`。
> 纪律：**不确定就写"未核实"**；`unknown` 绝不写成通过。

---

## 0. 为什么现在不开工（阻塞项，逐条可复算）

| # | 事实 | 复算方式 | 影响 |
|---|---|---|---|
| B1 | `package.json` **没有** `dsh.client`（只有 `dsh.bundle.patch`） | 读 `package.json`（46 行） | host 不会把 `client/**` 编成 bundle route ⇒ 侧栏无图标 |
| B2 | `package.json` 的 `exports` 只有 `"."` 与 `"./package.json"`，**无 `"./client"`** | 同上（第 17–20 行） | client 入口无处被 serve |
| B3 | `docs/client-contract.md` **不存在** | `Get-ChildItem docs` | T1 未落地 |
| B4 | task-5 的 `blockedBy = [task-3]`，`ready=false` | `team_task_get task-5` | 共享任务板本身也不让我开工 |
| B5 | `client/*.js` 在 10 分钟内两次变大小（`client.api.js` 7089→8185、`client.panel.js` 18222→18285） | 两次 `out-98-revision.txt` 对比 | T3 仍在写 ⇒ 此时冻结的 revision 无意义 |

⇒ 本回合按 lead 指令只做「矩阵 + 采集脚本骨架 + 截图手段自证」，**不评估**。

### 0.1 开工条件（lead 2026-10-12 裁定后的最终版）

| # | 条件 | 当前 |
|---|---|---|
| G1 | `client/**` 存在 | ✅ 已存在（仍在变，T3 收尾中） |
| G2 | `package.json` 的 **`exports["./client"]`** 指向 client 入口 | ❌ 未见 |
| G3 | `package.json` 的 **`dsh.client`** 声明 | ❌ 未见 |
| G4 | `docs/client-contract.md`（T1 落） | ❌ 未见 |

**两条（G2/G3）一到，lead 给 go。**

---

## 0.5 lead 裁决（2026-10-12，开工前，逐条生效）

| 问题 | 裁定 | 对本矩阵的改动 |
|---|---|---|
| **Q1** profile | ✅ 批准：`remote-wsl-test` 只读 + 我自己的 `--patch`（**不写共享 profile**）；`--dump-config` 里 `distro/cwd/daemonPort` 生效即为准 | 无（§5 已按此写） |
| **Q2** 场景 | ✅ 批准：基准场景 `cwd=/home/g/project/dsh1`，**并**另跑默认 `/home/g` 作对照验 D2（"这条对照很重要，请保留"） | 新增 **S-CTRL** 场景（§1.4） |
| **Q3** M6 | ⚠️ **只批一半**：按设计稿 §6，**P0 的 UI 没有起停守护/重启/drift 修复/＋－收藏/settings 页**（都在 P1）⇒ M6 的"不可逆动作有无确认"在 P0 **无对象**，记 **not-applicable / unknown**；**不得**为测它去改实现、或去点不存在的东西。**但**若真界面上**确实存在** stop/restart 这类控件（= 实现超出设计），**这本身就是要报的偏差**。我的 8962 守护可自行 ensure/停（只碰自有槽位），用于错误态/空态用例，**不算 M6 的替代** | M6 判据改写（§2 + §2.2-④）；新增 **§3.1 偏差表 + 页面内偏差探针** |
| **Q4** VS Code 基线 | ✅ 用「官方文档 + 扩展 manifest」口径，报告须标"**文档+manifest 级证据**"；**不要**实测 GUI | 无（§1.3 已按此写） |
| **Q5** 截图粒度 | ✅ 关键动作各 1 张 + 其余用 DOM/探针 | 无（§5/§6 已按此写） |
| — 端口 | 我 **8961–8963**（+8964–8970 备用）｜T4 `8931–8960`｜**T6 `8971–8980`**｜**T7 `8981–8990`**；活宿主 `19387`/pid `47564` 谁都不许碰 | §6 补段位 |
| — **D2 定性** | D2（树里无"添加路径"入口）**归入"P0 已知缺口 / P1 待补"，不当缺陷扣分**；扣分只扣"**P0 承诺了却没做到**"的项 | §3 的 D2 移入 §3.1 缺口表 |

> ⚠️ **Q3 的连带风险（准备期从代码读到的先验，**不算界面结论**）**：`client/client.panel.js` **确实**渲染了 `启动守护`（:390）/`重启`（:403）/`停止 slot N`（:416）/`修 pin`（:432），而设计 §6 把起停/restart/drift 修复列为 **P1**。⇒ 开工后必须做**偏差取证**（§3.1）：若真界面确认存在，则 ① 记「实现超出设计稿 P0 范围」的偏差；② M6 由 not-applicable 改为**有对象**，按阈值判"停止守护有无二次确认"。**先验不写进结论。**

---

## 1. 基准场景（S-BASE）与动作序列模板

**场景原话**：「我要在 WSL 的 `/home/g/project/dsh1` 里干活。」
**起点 t0**：DSH web 界面已加载、停在会话视图（`main` = conversation）、侧栏展开；**假设用户不知道** remote-wsl 面板存在（这才是"可发现性"的诚实起点）。
**终点 t1**：用户获得一个 `cwd=/home/g/project/dsh1` 的 WSL 会话，处于**可继续对话**状态（或界面**明确**告知还差哪一步）。

### 1.1 动作计数口径（先钉死，否则数出来的步骤不可比）

| 项 | 计 1 个动作 | 不计为动作 |
|---|---|---|
| 点击 | 点击控件使状态发生变化 | 移动鼠标、hover（**单独记为可发现性成本 H**） |
| 键击 | 一次有语义的按键提交（Enter / F1 / Ctrl+K）；**逐字符输入按 1 个动作**记，同时另记"需输入的字符数" | 打字中间过程 |
| 选择 | 下拉选一项（含展开） | 滚动（**单独记 S：是否需要滚动才看见目标**） |

> 双证据：①人工逐步记录（`out-20-steps.txt`，每步带时间戳）；②页面内注入探针计真实 `click`/`keydown`（`usab-instrument.js`）。两者必须一致，不一致以探针为准并记录差异。

### 1.2 模板 S-BASE（观测值留空，开工后填）

| 步 | 动作 | 目标控件（控件级） | 类 | 观测：能否完成 / 实际发生 | 备注 |
|---|---|---|---|---|---|
| A1 | 点侧栏 rail 第 N 个图标 | `sidebar.panellist` occupant（id=`remote-wsl`） | click | 待测 | 图标是否可辨识？有没有可见文字/`title`/`aria-label`？ |
| A2 | 找到 `dsh1` 行 | 树里 `workspace` 行 | 0（若可见）/ S | 待测 | 若配置的 `cwd` 已是 dsh1 ⇒ 0 动作 |
| A3 | 点「在新会话中打开」 | `button.dsh-rw-link`（行内动作） | click | 待测 | 该按钮预期**常显**（非 hover）；hover-only 与否按 M2 计 |
| A4 | 读动作结果条 | `div.dsh-rw-note` | 0 | 待测 | 结果条预取位置在 body 末尾 ⇒ 可能不在同视区（M7） |
| A5 | 若 `sessionId:null`（P0 默认不预热）：切到会话面板 + 发一条消息使其物化 | 会话输入框 | 3（click+输入+发送） | 待测 | 记 **D3**：界面承诺（"在新会话中打开"）与实际（无会话）之间的差距成本 |

**题面数**：`动作数 = A1 + A2(0/1) + A3 + A5(0 或 3)` ⇒ **乐观 2 / 现实 5**；另有 `H`、`S` 为附加成本。

### 1.3 对比基线：VS Code Remote-WSL 同场景（**文档+manifest 级证据，不起 GUI**）

- 扩展：`%USERPROFILE%\.vscode\extensions\ms-vscode-remote.remote-wsl-0.104.3\package.json`
- 视图：`contributes.views.remote[0]` → `id: targetsWsl`，`name: WSL 目标`（`package.nls.zh-cn.json`）
- **视图标题栏常显动作**（`menus.view/title`，`when: view == targetsWsl`）：`remote-wsl.explorer.addDistro` = **添加发行版**（`navigation@1`）、`remote-wsl.explorer.refresh` = **刷新**（`navigation@2`）
- **树项 inline 动作**（`menus.view/item/context`，`group: inline@N`）：`viewItem == folder` → **在当前窗口中连接**（inline@1）、**在新窗口中连接**（inline@2）、**删除最近使用的文件夹**；`viewItem == inactiveDistro` → **在当前窗口中连接**、**在新窗口中连接**

| 路径 | 动作数（口径同上） | 说明 |
|---|---|---|
| **V-A 官档「From VS Code」**：F1 → 选 `WSL: Connect to WSL` → File 菜单 → Open Folder → 输入路径 → 确认 | **≈6** | 来源 <https://code.visualstudio.com/docs/remote/wsl.md>（"From VS Code"） |
| **V-B 官档「From the WSL terminal」**：在已处于目标目录的终端敲 `code .` | **1**（前置"已有终端"未计） | 同上 |
| **V-C Remote Explorer（最同口径）**：打开 Remote Explorer（1）→ 点该项目/distro 的 **在当前窗口中连接**（1） | **2** | 我们的面板=同形态 ⇒ **以 V-C 为同口径对比** |

> ⚠️ V-A/V-B/V-C 均为**文档+manifest 级证据**，非实测（理由见 §7）。报告里必须标这一等级。

### 1.4 对照场景 S-CTRL（lead Q2 要求保留）：默认 `cwd=/home/g`

**场景**：同一句需求，但用户**没预置** `config.cwd`（=`/home/g`，插件默认）⇒ 树里**没有** `dsh1` 这一行。

| 步 | 动作 | 目标控件 | 观测 | 这一步证明什么 |
|---|---|---|---|---|
| C1 | 点 rail 图标 | occupant（id=`remote-wsl`） | 待测 | 与 S-BASE 同 |
| C2 | 在树里找 `dsh1` | `workspace` 行 | **预期找不到** | 用户需求与界面可得内容不匹配 |
| C3 | 找"添加路径 / ＋"入口 | ——（P0 无此控件） | 待测 | 全量控件清单里**零**匹配 ⇒ 缺口确认（§3.1 G-1） |
| C4 | 用户实际能走的路 | 手改 WSL 侧 `~/.dsh/remote-wsl/explorer.json` 或 host 配置 | 待测 | 统计"越界面动作"数（命令/编辑次数），作为缺口成本的量化 |

**产出**：`out-15-p0scope.json`（偏差/缺口探针）+ 与 S-BASE 的控件差集 + `shot-08-ctrl-default-cwd.png`。
> C3/C4 按 lead 裁定**计入"缺口"而非缺陷**；但 C4 的**成本数字**（几条命令/几次编辑）要写进报告的"P0 已知缺口"一节。

---

## 2. 要量的指标（M1–M10）与判缺陷阈值

| ID | 指标 | 怎么量（可复算） | 证据文件 |
|---|---|---|---|
| **M1** | S-BASE / S-CTRL 动作数（click / 键击 / 输入字符分列） | 人工逐步记录 + `usab-instrument.js` 计数，两者比对 | `out-20-steps.txt`、`out-21-counters.json` |
| **M2** | **需 hover 才能发现的控件数（H）** | DOM 扫描：`[title]` 且（可见文本为空/无信息）且无 `aria-label` 的**可交互**元素 → 逐条列 | `out-12-dom-controls.json`（`titleOnlyControls`） |
| **M3** | 术语暴露面：主视线/折叠区/`title` 三档的术语**条数与清单** | 术语表正则（§2.1） | `out-12-dom-controls.json`（`terminology`） |
| **M4** | 状态可区分性：「当前目标 distro」vs「下拉选中值」能否区分；**选择是否持久**（切走/关面板再回） | 读 select 值 + 徽标文本；做"改选→切走→切回"实验 | `out-13-states.json`、`shot-07-persist-*.png` |
| **M5** | 错误/空/降级态的**下一步**：每面判 (a) 有原因 (b) 有下一步 (c) 有可点出口 | 三态判定表逐面填 | `out-13-states.json` + 截图 |
| **M6** | 容错：① **busy 锁作用域**（点一个动作后有多少控件变 disabled）② 不可逆动作确认 —— **按设计 P0 无对象 ⇒ not-applicable/unknown**；**仅当**真界面确实存在起停控件时，才作为"实现超设计"的偏差项评其有无确认 | ① DOM disabled 计数；② `fetch` 钩子记录真实请求体（证明"有无确认"是**行为**而非文案） | `out-12-dom-controls.json`、`out-22-requests.json`、`out-15-p0scope.json` |
| **M7** | 反馈可见性：动作结果条与触发控件的纵向距离、是否同视区 | 两者 `getBoundingClientRect()` 之差 vs 视口高 | `out-12-dom-controls.json`（`feedback`） |
| **M8** | 空态可行动性：空态文本是否含**可照做的下一步**（命令/动词） | 空态文本正则 | `out-13-states.json` |
| **M9** | 主题可读性：light/dark 下 `--dsw-*` token **解析值非空** + 两模式**可区分** + **WCAG 对比度** | 计算样式实测（不读 token 清单） | `out-14-theme-{light,dark}.json`、`shot-02/03-*.png` |
| **M10** | 键盘可达性：Tab 能到达的控件数；树行/图标能否键盘展开激活；有无可见焦点态 | 逐次 `Tab` 记录 `activeElement` | `out-23-focus-order.txt` |
| **M11** | **P0 范围偏差/缺口探针**：设计线框承诺的控件 vs 真界面实有控件（含**实现超出设计**的方向） | 页面内探针按固定名单逐项 `present/missing`（§3.1 名单） | `out-15-p0scope.json` |

### 2.1 术语表（M3 用，逐字）

`explorer.snapshot`、`/remote-wsl/api`、`snapshot`、`wsl_status`、`slot`、`pin`、`drift`、`orphans`、`keys`、`daemon`、`web <port>`、`kind`、`cwd`。

> 判定原则：**面板是给人看的，就不能把 host 内部词汇当主文案**。允许出现在 `<details>`（对账区）与 `title`（进阶解释）里；出现在**主视线**（标题行/状态条/空态/错误态首句）即记缺陷。

### 2.2 判缺陷阈值（预先声明，避免事后找理由）

1. **动作数**：同口径 VS Code V-C = 2。S-BASE **现实路径 > 3** 记「负荷偏高」；**> 5** 记「显著偏高」。
2. **H（M2）**：**完成基准场景必须用到**的控件若属 title-only，**每一个**记 1 条可发现性缺陷。
3. **M5**：错误态若只有原因、无**可点的**下一步 ⇒ 缺陷；空态若无可照做的动作 ⇒ 缺陷。
4. **M6**：按限期**只有"实现超出设计"时才评**：若真界面存在起停/重启控件且**无二次确认** ⇒ 记偏差 + 缺陷（因只停自有槽位，严重度降一档）。设计范围内记 **not-applicable**，**不算通过也不算失败**。
5. **M9**：任一 token 在某模式下解析为空 ⇒ 缺陷；正文对比度 < 3 ⇒ 缺陷、< 4.5 ⇒ 记「偏低」。
6. **M10**：树/图标**无法**用键盘到达或激活 ⇒ 缺陷（无障碍可发现性）。
7. **缺口（G-\*）不计缺陷分**，只记"P0 已知缺口 / P1 待补"并给成本数字（口径见 §4 裁定与 §3.1）。
8. **偏差（X-\*）** = 实现与设计稿不一致（任一方向）。**每个偏差都必须记**，但只有"造成用户可见的错误预期/负荷"的偏差才升级为缺陷。

---

## 3. 可发现性缺陷候选（**必须在真界面上确认或推翻**）

> 来源：`[代码先验]` = 从 `client/**` 读出的预期；确认方式一律写真界面取证。**先验不算结论。**
> D2 已按 lead 裁定移入 §3.1（缺口，不计分）。下表的 D\* 才是**按阈值可能扣分**的候选。

| ID | 候选缺陷 | 依据 | 确认方式 | 若确认，控件级改进方向（报告里细化） |
|---|---|---|---|---|
| **D1** | rail 图标无自带可访问名：`svg` 带 `aria-hidden="true"`、无 `<title>`，可访问名完全依赖外壳传入的 `label` | `[代码先验]` `client.icon.js:43-45` | 读 rail DOM 的 `aria-label`/`title`/`innerText`，对比 shipped 两个图标；M10 键盘/读屏面 | 外壳不给名 ⇒ icon 组件加 `<title>`，或让注册 label 落到 `aria-label` |
| **D3** | 「在新会话中打开」的 P0 语义是**不物化会话**（`sessionId:null`），按钮文案却承诺"打开"；真相只在点完之后的结果条里 | `[代码先验]` `client.panel.js:37-46,236`、设计 §4 末条 | 点一次，读结果条原文 + 是否出现 `sessionId`；截图 `shot-06` | 文案改「准备会话（首次发消息时建立）」；或在行上常显"未物化"徽标 + 就地给"去开会话" |
| **D4** | distro 下拉**只筛选视图、不写配置**，且**不持久**（React state，关面板即回退）；该关键语义只写在 `title`（hover 才见） | `[代码先验]` `client.panel.js:57,116-119,329,336` | hover 读 title；切 distro → 切走 → 切回，比对 select 值；`shot-07` | 「当前目标 distro」做成**独立只读徽标**；下拉标注「筛选视图（不改目标）」；筛选在会话内持久 |
| **D5** | 开发者对账区（`<details>原始 snapshot（与 wsl_status 同源）`）与 `snapshot/快照 11:26:13` 等术语出现在主视线 | `[代码先验]` `client.panel.js:292-302,357,452` | M3 术语命中清单（三档） | 对账区收进"开发者"分组；时间戳改「刚刚更新」；`wsl_status` 移入 `title` |
| **D6** | 「停止 slot 8932」是内部槽位概念，用户不知 8932 是什么；解释只在 `title`（若该控件确实存在，见 §3.1 X-1） | `[代码先验]` `client.panel.js:415-418` | 读状态条控件文本 + hover title | 文案改「停止守护进程（端口 8932）」；端口解释放可见副文本 |
| **D7** | 空态（无 distro）只有陈述、无下一步 | `[代码先验]` `client.panel.js:159-162` | 用不存在的 distro 起实例制造空态，读文本 + `shot-05` | 加可照做动作：「在 Windows 终端运行 `wsl --install -d <发行版>`」+ 重试 |
| **D8** | 动作级失败只有「失败：<host 原话>」**无重试**；快照级错误态**有**「重试」⇒ 反馈能力不一致 | `[代码先验]` `client.panel.js:137-156`（有）vs `276-290`（无） | 制造 openSession 失败读结果条 | 结果条加「重试」，与错误态共用同一反馈组件 |
| **D9** | 动作结果条渲染在 body **末尾**，离触发的树行可能很远 ⇒ 反馈与动作不同视区 | `[代码先验]` `client.panel.js:276-302,361-365` | M7 几何测量 + 截图 | 结果条改**吸底/吸顶固定位**（toast 区），或就地插在触发行下方 |

**已知"不是缺陷"的对照项（避免误判）**：VS Code 的树项 inline 动作**同样** hover 才显现（`group: inline@N`）⇒ **"hover 才可见"本身不是缺陷**；判据是"**完成基准场景必须的工具/语义**只存在于 hover"。

### 3.1 缺口（G-\*，不计分）与偏差（X-\*，必记）—— 口径：只扣"P0 承诺了却没做到"

**P0 承诺的判据来源**：设计稿 §6「P0 —— 看得见、点得动」的 5 条验收 + §2 线框 + §3 挂点清单里标 P0 的项。其余一律算缺口。

| ID | 项 | 设计里的地位 | 真界面（待测） | 定性 |
|---|---|---|---|---|
| **G-1** | 「＋ 添加收藏路径」缺失（**原 D2**） | §2 线框有 `＋`；§6 P1 才列「`＋/－` 收藏路径」；workspaces 来自 host 配置 | 探针找 `添加/＋` | **P0 已知缺口 / P1 待补**，不计缺陷；给"用户实际要几步"的成本数字（S-CTRL C4） |
| **G-2** | 「在终端中打开」缺失 | §2 线框的每行 hover 动作之一；§5 交互表有；§6 P0 验收未列 | 探针找 `终端` | 缺口（口径：P0 清单未承诺） |
| **G-3** | 「从列表移除」缺失 | 同上（§2 线框） | 探针找 `移除/删除` | 缺口 |
| **G-4** | `⋯` 更多菜单缺失 | §2 线框有 `⋯` | 探针找 `⋯/更多` | 缺口 |
| **G-5** | `settings.section` 配置页缺失 | §3 标 **P1** | 探针找 settings 入口 | 缺口（明确 P1） |
| **G-6** | 面板上没有「打开 Web UI」动作 | §5 交互表有 `explorer.openUi`；§6 P0 未列 | 探针找 `web/窗口` | 缺口 |
| **X-1** | **实现超出设计**：面板渲染了 `启动守护`/`重启`/`停止 slot N`/`修 pin`（设计 §6 把这些列为 P1） | §6 P1 才列「起/停/restart 守护、drift 修复按钮」 | 探针 + `out-15-p0scope.json` + 截图 | **偏差（必记）**；若确认存在 ⇒ M6 由 N/A 改为评"停止有无二次确认"；文案问题另记 D6 |
| **X-2** | 线框的标题行 `＋ ⟳ ⋯` 实现为 `下拉 + 刷新` 两件 | §2 线框 | 控件清单 | 偏差（轻）；若缺"刷新"则升级 |
| **X-3** | 线框的每行 hover 动作实现为**常显** `link` 按钮 | §2 线框说"每行 hover 动作" | 控件清单 | 偏差（**方向是好的**：常显更可发现），报告里如实记为"实现比线框更可发现" |

> **偏差探针名单（页面内，逐项 present/missing）**：`添加|＋`、`终端中打开|终端`、`移除|删除`、`⋯|更多`、`设置|settings`、`web|窗口|打开 UI`、`启动守护`、`重启`、`停止 slot|停止`、`修 pin|修复`、`刷新`、`重试`、`在新会话中打开`、`复制路径`。
> 结果落 `out-15-p0scope.json`，与设计稿 §2/§3/§6 逐条对照。

---

## 4. 已裁定事项（原"待裁决"，2026-10-12 lead 全部回复）

| # | 原问题 | 裁定 |
|---|---|---|
| Q1 | profile 组合 | ✅ `remote-wsl-test` 只读 + 我的 `--patch` |
| Q2 | 场景 + 默认 `cwd` 对照 | ✅ 两者都做（保留 S-CTRL） |
| Q3 | M6 是否真按「停止」 | ⚠️ 设计 P0 无该控件 ⇒ M6 记 not-applicable/unknown；**实现超设计**则作为偏差报；自有 8962 槽位可自行 ensure/停（用于错误/空态用例） |
| Q4 | VS Code 基线口径 | ✅ 文档 + manifest 级证据；不实测 GUI |
| Q5 | 截图粒度 | ✅ 关键动作各 1 张 + DOM/探针补其余 |
| — | D2 定性 | ✅ 归"P0 已知缺口/P1 待补"，**不计缺陷分** |
| — | 端口 | 我 8961–8963(+8964–8970)｜T4 8931–8960｜T6 8971–8980｜T7 8981–8990 |

---

## 5. 证据与命名（开工后按此落盘）

| 文件 | 内容 |
|---|---|
| `out-10-livehost-baseline.txt` | 用户宿主 `19387` 的 pid（开工/收工必须相同） |
| `out-11-patch.yml` / `out-11-dumpconfig.txt` | 我的 overlay + `--dump-config`（证明覆盖生效） |
| `out-12-dom-controls.json` | **控件级全量清单** + title-only 判定 + 术语三档 + 反馈几何 + 键盘候选 |
| `out-13-states.json` | 各状态面（loading/ready/empty/error/action-note/daemon-off/drift/filter）原文与三态判定 |
| `out-14-theme-{light,dark}.json` | token 解析值 + 两模式可区分性 + 对比度 |
| `out-15-p0scope.json` | **M11 偏差/缺口探针**（§3.1 名单逐项 present/missing） |
| `out-20-steps.txt` | S-BASE / S-CTRL 逐步动作记录（含时间戳、期望 vs 实际） |
| `out-21-counters.json` | 注入探针的真实 click/keydown 计数 |
| `out-22-requests.json` | `fetch` 钩子记录的真实请求（证明动作"发了什么"） |
| `out-23-focus-order.txt` | Tab 顺序与 `activeElement` 轨迹 |
| `out-24-console.txt` | 浏览器 console（error/warn） |
| `shot-01-rail-collapsed.png` | 侧栏折叠态（图标可辨识性） |
| `shot-02-panel-open-light.png` | 面板展开 light |
| `shot-03-panel-open-dark.png` | 面板展开 dark |
| `shot-04-panel-error.png` | 错误态（注入 fetch 失败制造） |
| `shot-05-panel-empty.png` | 空态（distro 列表为空） |
| `shot-06-action-note.png` | 点「在新会话中打开」后的结果条（D3） |
| `shot-07-persist-{before,after}.png` | 筛选持久性实验（D4） |
| `shot-08-ctrl-default-cwd.png` | S-CTRL 默认 `cwd`（缺口证据） |
| `shot-09-dev-controls.png` | 状态条上的起停控件（偏差 X-1 证据，若存在） |
| `out-98-revision.txt` | 被验对象 revision（SHA256+size，只读复算） |
| `out-99-cleanup.txt` | 只停自己起的 pid/守护 |

---

## 6. 截图手段与实例（准备期**已自证可用**，不是计划）

- **主手段 = `chrome-devtools-mcp`**：`list_pages` → `new_page(background:true)` → `navigate_page(127.0.0.1:8961)` → `take_screenshot(filePath=…)`。
  **自证**：本回合对 `about:blank` 调 `take_screenshot` 返回真实 PNG（sha256 `1690203…1263`，1869×2035）⇒ **能拿到截图**；落盘走 `take_screenshot.filePath` / `evaluate_script.filePath`。
- **兜底 = `cua_driver_native`**：`browser_prepare({allow_launch:true, profile:{mode:'isolated_new'}})` → `browser_navigate` → `get_browser_state({include_screenshot:true})`。
- **禁忌**：不 `bring_to_front` 用户窗口；不开前台 tab；截图/点击只对 `127.0.0.1:8961`（对照 `8963`）；**绝不**对 19387 的用户宿主做任何点击。
- **端口段（lead 2026-10-12 确认无冲突）**：我 `8961–8963`（+8964–8970 备用）｜T4 `8931–8960`｜T6 `8971–8980`（T6 会在 8975–8977 短暂占端口做失败注入，与会话无关）｜T7 `8981–8990`｜禁区 `19387`（pid 47564）、`9910`。

---

## 7. 未测 / 不测（现在就声明，报告里沿用）

| 项 | 原因 |
|---|---|
| VS Code Remote-WSL **实机**动作数 | 起 VS Code 会在共享 WSL 发行版里拉起 `vscode-server` 并抢前台 ⇒ 用官档 + manifest（**文档+manifest 级证据**） |
| 屏幕阅读器（NVDA/讲述人）实测 | 环境不可用；M10 只做 Tab/`activeElement` + 静态 aria |
| 触摸 / 高 DPI / 窄窗口下的可用性 | 超出 P0 面；只在 1 个视口尺寸（记录实际值）测 |
| desktop（Electron）壳的图标并排现场 | 需重启用户宿主 ⇒ 禁忌；只在 web 测试实例验 |
| `client/**` 内部实现质量（代码审查） | 属 task-4 验证面；我只评人面交互 |
| 把 WSL 目录当本地工作区（UNC 工作区根） | 设计 §7 标 P2，GAP-AUDIT #7 有数据损坏风险 ⇒ 不碰 |
| M6「不可逆动作确认」 | 设计 P0 无该控件（lead 裁定）⇒ **not-applicable**；仅当确认 X-1 存在时改评 |

---

## 8. 准备期实测记录（可复算）

| 事实 | 命令/方式 | 结果 |
|---|---|---|
| 用户宿主存活 | `Get-NetTCPConnection -LocalPort 19387 -State Listen` | `pid=47564`（与 task-4 记录一致，准备期未变） |
| 我的端口段空闲 | `Get-NetTCPConnection -LocalPort 8961..8970 -State Listen` | 全部无监听 |
| `--patch` 受支持 | `dsh.cmd --help` | `--patch <path> extra patch-list overlay applied after the profile layer (repeatable)` |
| **overlay 生效** | `dsh --profile remote-wsl-test --patch out-11-patch.yml --dump-config` | **exit 0**；第 1282–1289 行 `- id: remote-wsl … distro: debian-u8-1 / wslHome: /home/g / cwd: /home/g/project/dsh1 / daemonPort: 8962` |
| 三个浏览器探针语法 | `node -e "eval('('+src+')')"` | `usab-dom.js`/`usab-instrument.js`/`usab-theme.js` 全 `OK typeof=function` |
| 测试 profile | `~/.dsh/profiles/remote-wsl-test/package.json` | bundles = `dsh-base`+`dsh-web-app`+`dsh-remote-wsl`（link 到 vendor） |
| 场景目录存在 | `wsl.exe -d debian-u8-1 -- bash -lc 'ls -d /home/g/project/dsh1'` | 存在 |
| 收藏文件状态 | UNC 读 `\\wsl.localhost\debian-u8-1\home\g\.dsh\remote-wsl\explorer.json` | **不存在** ⇒ 树里只会有 `config.cwd` 那一条（S-CTRL 的前提） |
| 插件默认配置 | 读 `src/index.ts:81-120` | `distro='debian-u8-1'`、`wslHome='/home/g'`、`cwd='/home/g'`、`daemonPort=8731` ⇒ **必须覆盖** |
| 被验对象 revision | `pwsh ./usab-run.ps1 -Mode Revision` | 8 个 `src/*.ts` + 4 个 `client/*.js` 已落 `out-98-revision.txt`（**10 分钟内 client 两文件变过**，见 B5） |
| 截图能力 | 见 §6 | **可用**（已出图） |
| node | `node.exe -v` | v26.10.0 |
