# REPORT —— T54：重拍**当前 HEAD（`70c697d`）**面板成品图（light+dark）+ 补 dark 逐项读数

- **日期**：2026-10-14 ｜ **作者**：`visual-designer` ｜ **状态**：12 张成品图 + 逐项读数 + 2 条故意红 + 差异对照，全过；1 项候选视觉问题（320 换行）见 §6
- **为什么重拍**：`usability/p04-final/` 那批（T40）拍于 **T42/T43/T52/T53 修复之前** ⇒ 命中盒、底栏高、菜单宽、组标题色都是之后才定的，视觉已过期。
- **被验对象**：`git archive HEAD`（`70c697d4f0e32de3f30462358edfc7485ea3ca62`）导出的**插件副本** `%TEMP%\usab-p06`（`client/index.js` sha256 `E9498D72…`，与工作区逐字节相同）
- **写作用域**：`usability/p06-final/`（新建）+ `docs/panel-visual-spec.md` 复验节；**未碰** `client/**`、`src/**`、`package.json`
- **交付物**：本报告 + 12 张 PNG + 4 份原始 JSON + `p06-boot.ps1` / `p06-shots.ts` / `p06-assert.mjs`（可复跑）

---

## 0. 结论

| 验收项 | 结果 |
|---|---|
| ① 12 张成品图（6 场景 × light/dark）+ 每张一句"看什么" | ✅ §2 |
| ② dark/light 逐项读数（原始 JSON） | ✅ §3（`out-p06-readings.json`） |
| ③ 前置两条证明的原始输出 | ✅ §1（rev exit 0；**9/9 chunk 逐字节 == 磁盘**） |
| ④ **故意红 ≥1**，字节还原复绿 | ✅ §4（RED-A 命中盒、RED-B 组标题色，各 2 条 FAIL / exit 1；还原后 21 PASS / exit 0） |
| ⑤ 与 T40 那批的差异对照 | ✅ §5（明确标出"修复后才有的"） |
| ⑥ 未复核项 | ✅ §6 |

**一句话**：在 HEAD 上，**底栏 47px、`⋯` 24×24、菜单外框 240、组标题 dark 5.55:1、面板内 box-shadow = 0** 全部成立（21/21 断言），肉眼可见的旧视觉（55px 底栏 / 16×16 行内动作 / 22.7px chip / 16–21px `⋯`）已全部消失。

---

## 1. ③ 前置证明（否则读数无效）

### 1.1 `tools/check-client-rev.mjs` exit 0

```
client-rev 门禁：PASS（模式=git）
  入口     : client/index.js   当前 rev : 59faf7156bc2   [size=29194]
  chunks   : 9 个  client.api.js(5a192b93) client.i18n.js(47525217) client.icon.js(e9a824f5)
             client.panel.actions.js(d45d9f9a) client.panel.browser.js(a4bcafa8) client.panel.header.js(b5c1a2c0)
             client.panel.helpers.js(efa1e85c) client.panel.js(e018be93) client.panel.tail.js(f5cbcf7c)
  依据     : 自入口最后一次内容变更（f595e840d6fa）以来没有任何 chunk 变化 ⇒ rev 与内容自洽
exit=0                       ← 原始输出见 out-p06-clientrev.txt
```

### 1.2 页面加载的 chunk == 磁盘（T40 的 trailer 判法，逐 chunk 哈希）

做法：`performance.getEntriesByType('resource')` 取页面**真正加载**的 9 个 chunk URL → 逐个 `fetch(...,{cache:'no-store'})` → 去掉一行 `//# sourceMappingURL=…` trailer → **前缀逐字节**与**磁盘文件**比对。

| chunk | 磁盘字节 | 服务字节 | 追加内容 | 前缀比对 | 磁盘 sha256(16) |
|---|---|---|---|---|---|
| client.i18n.js | 30,998 | 31,057 | `";"` | **PASS** | `47525217062f3107` |
| client.api.js | 14,847 | 14,905 | `";"` | **PASS** | `5a192b93a62900e0` |
| client.panel.js | 9,776 | 9,836 | `";"` | **PASS** | `e018be93236fbd57` |
| client.icon.js | 2,209 | 2,268 | `";"` | **PASS** | `e9a824f50e45e5d4` |
| client.panel.helpers.js | 12,200 | 12,268 | `";"` | **PASS** | `efa1e85cca69012b` |
| client.panel.actions.js | 13,292 | 13,360 | `";"` | **PASS** | `d45d9f9acbc895a1` |
| client.panel.header.js | 7,988 | 8,055 | `";"` | **PASS** | `b5c1a2c06c7ed495` |
| client.panel.browser.js | 13,782 | 13,850 | `";"` | **PASS** | `a4bcafa8e2141ea5` |
| **client.panel.tail.js** | 15,386 | 15,451 | `";"` | **PASS** | `f5cbcf7c4820016c` |

- **9/9 PASS**，`allPass: true`（原始 JSON：`out-p06-integrity.json`）
- 每行 trailer = `//# sourceMappingURL=<chunk>.map?rev=9ca1980db29f`（**服务端 rev**；与仓库侧 git 判定的 `59faf7156bc2` 不同是正常的：rev = 入口文件**元数据**哈希，副本的 mtime/ctime 与仓库不同）
- 追加内容恒为 **`";"`**（服务端在 chunk 末尾补的分号）⇒ 与 T40 同一现象、同一结论

---

## 2. ① 成品图清单（12 张，各一句"看什么"）

⚠️ **本轮我目视核对过 3 张**（`ready-light` / `menu-dark` / `narrow320-light`），其余 9 张由 §3 的读数 + 非空性覆盖（45–86 KB/张）——**未逐张目视**（见 §6）。

| # | light | dark | 场景 | **看什么**（一句话） |
|---|---|---|---|---|
| 1 | `p06-ready-light.png` | `p06-ready-dark.png` | ready | 头部只有「远程资源管理器」+ 副标题，右侧**只有 1 个主按钮**「添加为 WSL 工作区」；卡片标题行右侧是「隐藏文件：不显示」；底栏**一行**高 47px（`● 远端守护未运行 · 会话 0 个` … `启动守护` / `更新于 …` / `⋯`） |
| 2 | `p06-menu-light.png` | `p06-menu-dark.png` | menu 打开 | 浮层在底栏**上方**右对齐、宽 **240**（外框）、**不遮**底栏状态词；组标题「守护」「诊断」**可见且可读**（dark 5.55:1）；菜单项 28px 一条，破坏性项用 `warn`/`error` **图标**而非红字 |
| 3 | `p06-narrow320-light.png` | `p06-narrow320-dark.png` | narrow **320** | 面板宽 264：底栏仍 **47px 单行**、状态词**不被省略**（91/91）、`⋯` 仍 **24×24**；`添加为 WSL 工作区` 在**头部**（>窄态下菜单里就**不**再出现「工作区」组 ⇒ 同一动作全屏只有 1 处） |
| 4 | `p06-loading-light.png` | `p06-loading-dark.png` | loading（**夹具**：snapshot 延迟 5s，1.2s 定格） | 先出「读取中」骨架/文案**而不是**空态或 0 值（未物化/失败文案**不**在首帧出现） |
| 5 | `p06-error-badpath-light.png` | `p06-error-badpath-dark.png` | error-badpath（**真实交互**：填入 `/home/g/__p06_no_such_dir_*__` 后点「跳转」） | 错误**局部化**：路径/列表区给失败提示，头部与底栏状态词仍显示 daemon 真实状态（不整面板变错误页） |
| 6 | `p06-running-light.png` | `p06-running-dark.png` | 守护运行中（**夹具**：`snapshot.daemon.running=true` + 2 个会话键） | 底栏状态点/状态词切到「远端守护**运行中**」、`会话 2 个`，且**头部/底栏的主按钮不再出现「启动守护」**（动作随状态消失） |

**夹具声明（不当事实验收）**：#4 用 `fetch` 延迟注入定格（任务指定"定格手法"）；#6 用 `Response` 改写 `snapshot.daemon`。两者都**只改页面收到的数据**，不改被验对象、不改 CSS ⇒ 渲染出的仍是**真实样式**。#5 是**真实**失败路径（WSL 里确实没有该目录）。

---

## 3. ② 逐项读数（原始 JSON：`out-p06-readings.json`；两主题各一轮）

| 读数 | **light** | **dark** | 判据（规格） | 断言 |
|---|---|---|---|---|
| `footerH`（1280） | **47** | **47** | §7.2.3：47 = 外框 | A1 ✅ |
| `footerH`（320） | **47** | **47** | 同上（窄态不换行） | A1b ✅ |
| 状态词 `scrollWidth===clientWidth` | **91 == 91** | **91 == 91** | §4.2-1 不省略 | A3 ✅ |
| 状态词（320） | 91 == 91 | 91 == 91 | 同上 | A3b ✅ |
| 菜单 `rect.width` | **240** | **240** | §7.2.4 外框 240 | A4 ✅ |
| 组标题对比度（对菜单底 `rgb(233,236,242)` / `rgb(97,102,107)`） | **15.97** | **5.55** | §7.2.4.1：≥4.5（dark） | A5 ✅ |
| 面板内 `box-shadow` 计数 | **0** | **0** | §2.4（Q4）：阴影只给浮层 | A6 ✅ |
| 菜单是否遮状态词 | **false** | **false** | §7.2.4 | A7 ✅ |
| 组标注 | 2 组：`dsh-rw-menu-daemon` / `-diagnostics`；`ariaLabel` 空、目标存在、`tabIndex=-1`、**`role` 为空**（无 `presentation`） | 同 | §7.2.4（T53 定稿） | A8 ✅ |
| 菜单项高 | 28 / 28 / 28 / 28 px | 同 | §7.2.4 item 28 | — |
| 320：`innerWidth` / `narrowMQ420` / `panelW` | 320 / **True** / 264 | 同 | §6.2 断点 420 | — |
| 320：`⋯` rect | **24 × 24** | **24 × 24** | §3.4.1 ≥24×24 | 含在 A2 ✅ |

### 3.1 V1 命中区**逐元素** rect（light；`out-p06-readings.json → ready.hit`）

| 类 | 个数 | 最小 rect | 例（文本） | T40 时 |
|---|---|---|---|---|
| `dsh-rw-btn` | 3 | **48 × 28** | 「跳转」「← 上一级」「启动守护」 | — |
| `dsh-rw-btn--primary` | 1 | **132.3 × 28** | 「添加为 WSL 工作区」 | 132.3×28（未变） |
| `dsh-rw-chip` | 4 | **24 × 24** | 「Home」「/」「/mnt」「隐藏文件：不显示」 | `/` 只有 **22.7×24** ❌ |
| `dsh-rw-crumb` | 4 | **24 × 24** | 「/」「home」「g」「project」 | — |
| `dsh-rw-iconbtn` | 2 | **24 × 24** | 刷新、`⋯` | `⋯` 5/8 档 **16–21×24** ❌ |
| `dsh-rw-row` 的「进入」 | 11 | **32 × 24** | 每行的**唯一**动作（hover 显现） | **16 × 16** ❌ |

- **共 25 个可点元素，`under24Count = 0`**（两主题、含 320）⇒ **A2 ✅**
- 该表与 T40 的 `out-p04-refine-v1.json` **同口径**（都按"参与点击的元素 + 强制 hover 行"枚举）

---

## 4. ④ 故意红（破坏只在 `%TEMP%` 的是**副本**里；工作树/仓库一个字节未动）

| # | 破坏（副本内） | 期望 | 实测 |
|---|---|---|---|
| **RED-A** | `.dsh-rw-iconbtn{… width:24px;height:24px …}` → **12px**（`⋯` 与刷新的命中盒） | A2 红 / exit 1 | ✅ **2 条 FAIL**：`A2 V1 命中区全 ≥24（light/dark）— 2 个 <24：[{"cls":"dsh-rw-iconbtn","rect":{"w":12,"h":12,"x":1254,"y":18}},{"cls":"dsh-rw-iconbtn","rect":{"w":12,"h":12,"x":1256,"y":871}}]`（前者=刷新、后者=`⋯`）⇒ **19 PASS / 2 FAIL / exit 1** |
| **RED-B** | `.dsh-rw-grouplabel{… color:var(--dsw-alias-label-primary) …}` → **`label-dimmed`**（组标题取色） | A5 红 / exit 1 | ✅ **2 条 FAIL**：`A5 组标题对比度 ≥4.5（light）— 实得 1.07`、`（dark）— 实得 1.65` ⇒ **19 PASS / 2 FAIL / exit 1** |
| **字节还原** | `Copy-Item` 从工作树还原副本入口 | 复绿 | ✅ sha256 逐字节相同（`E9498D72…`）；**21 PASS / 0 FAIL / exit 0** |
| 工作树 | 全程未碰 | — | ✅ 仓库 `git status` 里 `client/**` **无改动**（本轮只新增 `usability/p06-final/**`） |

断言清单（`p06-assert.mjs`，21 条 = 10 条 × 2 主题 + A9）：A1/A1b 底栏高 · A2 命中区 ≥24 · A3/A3b 状态词不省略 · A4 菜单 240 · A5 组标题对比度 · A6 box-shadow=0 · A7 不遮状态词 · A8 组标注一致 · A9 chunk==磁盘。

### 4.1 自查踩到的 3 个**我自己的**问题（都属"读数可能骗人"，记下来）

1. **`--phase readings` 把读数数组覆盖成了包装对象**：我原先把本轮汇总写到 `out-p06-${PHASE}.json`，`PHASE=readings` 时正好覆盖上面刚写好的数组 ⇒ 断言脚本拿到非数组 **抛错**（不是断言失败），我一度把"exit 1"当成了红。**修**：汇总一律写 `out-p06-run-<phase>.json`。**教训**：红必须是"断言点名的 FAIL 行"，**崩溃也算 exit 1，不许当红**。
2. **首启模态盖住面板**：全新孤立 profile 会**连弹**「预览版说明」→「添加一个 API Key」两个模态，第一批 12 张全被遮住（已作废重拍）。**修**：`load()` 里循环点掉，且**优先"稍后/跳过"类**（绝不点「保存并继续」——那会写配置）。记录见 `out-p06-run-all.json → dismissed`（本轮 11 次全是「稍后配置」）。
3. **窄态图里残留打开的菜单**：先拍 menu、再改视口拍 320，菜单没关 ⇒ 320 图里浮层压着面板（第二次作废重拍）。**修**：拍 320 前先 `aria-expanded` 为 true 就点回去关闭；并用探针复核 `menuOpen=false`。

---

## 5. ⑤ 与 T40（`p04-final`）的差异对照 —— **哪些是修复后才有的**

| 读数 | **T40**（修前，`out-p04-refine-v1/v3*.json`） | **T54 / HEAD 70c697d** | 由谁修 |
|---|---|---|---|
| 底栏 `footerH`（320→1280 全档） | **55** ❌（与规格 36 打架） | **47** ✅ | **T42 实现 + T43 定稿**（`28+9×2+1`，`box-sizing:border-box`） |
| 行内动作「进入」 | **16 × 16** ❌ | **32 × 24** ✅ | **T42**（≥24×24 + `flex:none`） |
| chips `/` | **22.7 × 24**（1280）/ 23×24（320） ❌ | **24 × 24** ✅ | **T42** |
| `⋯`（底栏） | 8 档里 **5 档 <24 宽**（16–21×24） ❌ | **24 × 24**（1280 与 320 均） ✅ | **T42** |
| 菜单外框宽 | **未测**（T40 没量） | **240** ✅ | **T52**（`box-sizing:border-box`，修前是 250） |
| 组标题取色 | `label-secondary`：dark **3.85** ❌ | `label-primary`：dark **5.55** / light 15.97 ✅ | **T42/R3 定色 + T50 判红 + T43/Q6 裁决** |
| 组标题 `role` | `presentation`（且是 no-op） | **无 role**（普通 `<div id>`） | **T53** |
| 面板内 `box-shadow` | 未统计 | **0** ✅ | **T42/T52** 口径（Q4：阴影只给浮层） |
| 状态词不省略 | 91/91 ✅（本来就对） | 91/91 ✅ | — |
| 主按钮 | 132.3×28 ✅ | 132.3×28 | — |

**结论**：T40 那批图里**肉眼可见的 4 处旧视觉**（55px 底栏、16×16 行内动作、22.7px 的 `/`、窄档 16–21px 的 `⋯`）在当前 HEAD **全部消失**；另有 3 项（菜单 240 / 组标题 `presentation` / 面板内阴影计数）是 **T40 当时根本没有的读数项**，属本轮新增覆盖。

---

## 6. ⑥ 未复核 / 候选问题（不许当通过）

| 项 | 说明 |
|---|---|
| **12 张里我只目视了 3 张** | 目视：`ready-light`、`menu-dark`、`narrow320-light`（含第一版发现的两处问题）。其余 9 张只有"非空性（45–86 KB）+ 与断言同源的读数"覆盖，**没有逐张看图**；若终验要"每张都看过"，需要人再过一遍。 |
| **候选问题：320 下的头部/底栏文字换行** | 320 时面板仅 **264px**宽：① 头部标题「远程资源管理器」换 2 行、副标题「未物化 仅筛选，不改目标」被拆成 4 行（`p06-narrow320-light.png` 可见）；② 底栏「启动守护」按钮实测宽 **49px** < 文本所需（4 个 CJK ≈52px）⇒ 按钮内换行。**底栏外框仍是 47px 且无横向溢出**（A1b/A3b 过），所以**不影响本轮断言**；但观感是瑕疵 ⇒ 建议单开任务（**T54 写作用域禁止改 `client/**`**，未动）。 |
| **夹具场景的"真机"形态** | #4 loading、#6 守护运行中 是夹具。真机下「运行中」还包含 `会话 N 个` 的真实键名/漂移标注等，本轮只验证了**样式与状态词切换**，未跑真守护（那会在 WSL 起进程，涉及收尾风险）。 |
| **dark 主题的对比度全量复算** | 本轮只补了**组标题**一项（任务指定）。其余 58 组对比度仍是 T28/T43 的 `tools/contrast-check.mjs` 静态计算值，未在本实例上逐组复算。 |
| **`⋯` 菜单在 320 打开的样子** | 本轮 menu 图是 1280；320 的菜单（T40 有 `menu-320-light.png`）未重拍。 |
| **hover 态截图** | T40 有 `v1-row-hover-light.png`；本轮 V1 用 `CSS.forcePseudoState` 读数覆盖（32×24），未出 hover 截图。 |
| **多实例冲突态** | T40 有 `multi-instance-fixture.png`；本轮未覆盖（任务未要求）。 |

---

## 7. 交付物 / 复跑入口 / 纪律

| 文件 | 内容 |
|---|---|
| `p06-{ready,menu,narrow320,loading,error-badpath,running}-{light,dark}.png` | **12 张成品图** |
| `out-p06-integrity.json` | 前置②：9 chunk 逐字节比对（`allPass: true`） |
| `out-p06-readings.json` | 逐项读数（V1 逐元素、footerH、状态词、组标题对比度、菜单宽、box-shadow、窄态探针） |
| `out-p06-shots.json` / `out-p06-run-all.json` | 截图清单（含 `dismissed` 模态记录） |
| `out-p06-assert-green.txt` / `out-p06-assert-red.txt` | 21 PASS 绿基线 / 两条红 + 还原 |
| `out-p06-readings-redA.json` / `-redB.json` | 两条红的读数快照 |
| `p06-boot.ps1` / `p06-shots.ts` / `p06-assert.mjs` | 可复跑（Vendor→ShaBefore→Setup→Start→shots→assert→Stop→ShaAfter→ShaDiff） |

```powershell
$p='…\usability\p06-final'
pwsh -File "$p\p06-boot.ps1" -Mode Vendor      # git archive HEAD → %TEMP%\usab-p06
pwsh -File "$p\p06-boot.ps1" -Mode ShaBefore   # 用户全局存储基线
pwsh -File "$p\p06-boot.ps1" -Mode Setup       # 孤立 DSH_HOME + profile p06 + junction
pwsh -File "$p\p06-boot.ps1" -Mode Start       # hidden、端口 8966、拿 token URL
# headless Chrome --remote-debugging-port=8968
node "$p\p06-shots.ts" --url (Get-Content "$p\out-p06-url.txt")[0] --out $p --disk "$env:TEMP\usab-p06" --cdp 8968 --phase all
node "$p\p06-assert.mjs" $p                    # 期望 21 PASS / exit 0
pwsh -File "$p\p06-boot.ps1" -Mode Stop; pwsh -File "$p\p06-boot.ps1" -Mode ShaAfter; pwsh -File "$p\p06-boot.ps1" -Mode ShaDiff
```

### 7.1 纪律

| 项 | 结果 |
|---|---|
| 实例 | **hidden**（`Start-Process -WindowStyle Hidden`），端口 **8966**（落在指定段 8961–8970），PID 写入 `out-p06-instance.pid`；收尾由 `-Mode Stop` 按"pid + 端口 + 命令行含 `--port 8966`/`p06` 三重校验"停（**拒绝停用户宿主**） |
| 浏览器 | **headless Chrome**（`--headless=new` + `--remote-debugging-port=8968` + 独立 `%TEMP%\p06-chrome`）⇒ **0 个可见窗口**；收尾杀该 pid |
| 用户宿主 19387 | **未碰**：起实例前后 `liveHost=33688 (before 33688)`（boot 脚本内置硬校验，不一致就 exit 4）；只读报告 |
| 用户全局存储 | 孤立 `DSH_HOME=%TEMP%\usab-p06-home`；前后 `ShaBefore/ShaAfter` + `ShaDiff` 对照（见收尾输出） |
| `npm/pnpm install` | **0 次** |
| 我创建的 unit / 守护 / 包装层 | 实例只在 Windows 侧起 dsh 宿主；**WSL 侧未起守护**（"运行中"用夹具）⇒ 无 `reset-failed` 对象；`-Mode UnitAudit` 复核 |
| 收尾 | 停实例 + 杀 Chrome + 删 `%TEMP%\usab-p06`、`usab-p06-home`、`p06-chrome`（profile 随孤立 home 一起删，**不碰**用户 `~/.dsh/profiles` 下任何既有 profile） |
