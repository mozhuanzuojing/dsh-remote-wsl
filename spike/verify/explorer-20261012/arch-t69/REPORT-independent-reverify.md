# T69 独立复验 T60 / T62 / T63 —— 状态：**1 条独立确认（T60）、1 条部分确认（T63）、1 条未做（T62）**

> owner `stability-engineer`。方法：**不照抄他们的脚本**，自己构造复现；`pre-fix` 用 `git archive <修复提交>^` 取**整棵自洽的树**，
> HEAD 用工作树。**我没有参与 T60/T62/T63 这三笔**（独立性来源）。
> 写域：仅 `arch-t69/`；**未改 `src/**`、`client/**`**（全部是 `%TEMP%` 副本 + 只读）。

## 0. 先说三条结论（含我**没能**验的）

| 笔 | 我独立复现并确认 | 依据 |
|---|---|---|
| **T60** `WebHost` 失败后重试静默假成功 | ✅ **独立复现 + 独立确认修复** | 我自己注入"半死态"（child 有/url 无）打 `start()`：**pre-fix `resolved_null` / 0ms** ⇒ **HEAD `threw` 且把半死态丢弃**（§1） |
| **T63** 320 窄态折行 | ⚠️ **部分确认**：「启动守护」按钮**内折行**确认已修（2 行盒 → 1 行盒）；**头部"1 行盒"我没能用有效判据确认** | §2 |
| **T62** F56-1..5 | ❌ **本轮未做**（如实列出，不算通过） | §3 |

**另有一条与三笔无关、但影响"冻结复算"的发现**：`revision.ps1 -Mode Check` **exit 1**，漂移**全部落在 `client/**` 4 个文件**、`src/**` 漂移 **0** ⇒ 我的 **T60（src 侧）结论仍有效**；而 **T63 自己的改动就是那次漂移**、冻结文本没跟上（§4）。

## 1. T60：`WebHost.start()` 的"可用态判据"——**独立复现 + 独立确认修复**

**正确的前置对象**（任务书给的 `c33c5c7` **不是** T60 的修复提交 —— 它是一个 docs/freeze 提交，`--stat` 只动 README/REVISION/证据）：
真实修复提交 = **`598543c`**（`fix(host)+chore(tools): WebHost 失败路径根因修复（不再 OK+null）…`）。
⇒ pre-fix 基线 = `git archive 598543c^ src`（14 文件，自洽），HEAD = 工作树 `src/`。
两棵树的判据行实测：pre-fix `if (this.child) return this.url;` / HEAD `if (this.url) return this.url;`（`register-tools.ts:41` vs `:45`）。

**我的构造**（`harness-t60.ts`，打在根因对象上，不打工具层返回串）：把 T55 抓到的现场**注入**出来 ——
`host.child = {kill(){…}}`、`host.url = null`、`host.script = /tmp/…sh` ⇒ 同端口再 `start()`。
**安全性**：pre-fix 的旧判据在 **spawn 之前**短路返回 ⇒ 零副作用；HEAD 侧用**不存在的发行版**做 `cfg.distro`，
使其在真正 `spawn wsl.exe … dsh web` **之前**失败（UNC 写入即刻报错）⇒ 不会真起任何 web、不占端口。实测 8911–8930 **全 free**。

| 断言 | pre-fix（`598543c^`） | HEAD | 判定 |
|---|---|---|---|
| `outcome` | **`resolved_null`，`ms=0`** | **`threw`**（`ms=2201`，`remote-wsl: 无法写入发行版 "rwsl-t69-nonexistent" 的 /tmp（UNC … 不可用）`） | ✅ 缺陷复现 / 修复确认 |
| 注入的 child | `childAfter=object`、**`killCalls=0`**（不自清） | `childAfter=null`、**`killCalls=1`**（真的丢弃） | ✅ |
| 残留状态 | `scriptAfter=string` | `scriptAfter=null`、`urlAfter=null` | ✅ |

**我的断言**：`assert-t60.ts`（6 条）⇒ 真读数 **6/6 PASS / exit 0**（`out-04-t60-green.txt`）。
**一次应当红**：把 HEAD 读数副本人为退回缺陷签名（`resolved_null` + 半死态保留）⇒ **A3/A4/A5 三条 FAIL / exit 1**（`out-03-t60-red.txt`）；删副本后复绿 exit 0。
原始读数：`out-01-t60-prefix.json` / `out-02-t60-head.json`。

**诚实边界**：HEAD 侧我证明的是「**绝不再静默返回 null；且半死尝试被真的丢弃**」；**没有**证明"同端口能真的重启成功"——
那需要在真发行版里真起 `dsh web`（会占端口、动 WSL 进程，超出本任务"避让他人"的边界）。⇒ 该项列**未复核**。

## 2. T63：320 窄态折行 —— **部分确认**

pre-fix 树 = `git archive f60d9de^ client` + HEAD 的 `src/`（T63 只动 `client/**`）；两个孤立实例：**8919=pre-fix / 8920=HEAD**，视口 `320×900,mobile`，守护用页面内夹具置为"未运行"（让「启动守护」出现）。

| 读数（320px） | pre-fix（8919） | HEAD（8920） | 判定 |
|---|---|---|---|
| 「启动守护」按钮文本 | **启动守护** | **启动**（T63 的短文案） | —— |
| 该按钮**文本行盒数**（Range.getClientRects） | **2** | **1** | ✅ **内折行确认已修** |
| 该按钮 `scrollHeight` / `clientHeight` | **33 / 26**（溢出=折行） | **26 / 26**（不溢出） | ✅ |
| `.dsh-rw-header` 高度 | **145** | **79** | ✅ 大幅下降（同向证据） |
| `.dsh-rw-header-actions` 子项 top | `[10, 12]` ⇒ distinct=2 | `[10, 12]` ⇒ distinct=2 | ⚠️ **该指标无效**（见下） |

**为什么我不说"头部也已修"**：我原本用"子项 distinct top 数"当"行盒数"判据，**两态都是 2**（10 与 12）。
差额 2px 来自**同一 flex 行内不同高度的项 top 对齐不同**（28px 按钮 vs 24px 图标按钮），**不是换行**。
⇒ 这个指标**不能**支撑"头部 1 行盒"，我**不拿它下结论**。头部折行是否已修，我**未用有效判据独立确认**（属于"我只读码/只信他们"的一栏）。
要用有效判据复验，需要：按 top **分簇**（容差 ≥6px）数行，或直接比 `header.contentHeight` 与单行高度。**留给下一位**（脚本已在 `arch-t69/`）。

## 3. T62（F56-1..5）：**未做**

本轮**没有**对 `src/sdk-runtime.ts` 的 F56-1..5 做任何独立复现或确认。原因：我的会话上下文已极深，
而 T62 需要**真 spawn + 孤立 `DSH_HOME`** 的多态构造（5 个子缺陷各需独立现场），继续硬做只会产出"半成品验证"。
⇒ **如实列为未做，不算通过**；对象已备妥：修复提交 `815f2c8`（`-- src/sdk-runtime.ts` 仅 3 增 1 删，主要修复在运行期脚本里，需先定位）。

## 4. 冻结复算：`revision.ps1 -Mode Check` = **exit 1（锚点漂移）** —— 与我的验证无关，但必须报

```
结论：**验证无效**（被验对象在验证期间发生变化）      exit=1
- 47525217…(30998)  client/client.i18n.js        + 8a1ac1e2…(31440)  client/client.i18n.js
- b5c1a2c0…( 7988)  client/client.panel.header.js + 7b4c67ef…( 8385)  client/client.panel.header.js
- f5cbcf7c…(15386)  client/client.panel.tail.js   + fefe4775…(15766)  client/client.panel.tail.js
- e9498d72…(29194)  client/index.js               + ee3c0642…(30422)  client/index.js
```

**逐条判读（我自己算的）**：
1. **`src/**` 漂移 = 0 行**，漂移**只落在 `client/**` 4 个文件** ⇒ **T60（src 侧）的结论不受影响**。
2. 漂移的 4 个文件**正是 T63 改的那 4 个**；`REVISION.txt` 由 `c33c5c7`（**12:05**）落，而 T63 `f60d9de` 在 **13:19** ⇒ **冻结早于该改动**。
3. 之后的 HEAD `b9e8dfb` 标题写着「P0.5.3（T63 之后 **client 四锚点再变**）」，但 `git log -- REVISION.txt` 显示该文件**最后一次改动仍是 `c33c5c7`** ⇒ **它没有真的重落锚点**（声称 vs 事实的差）。按 `revision.ps1` 自己的规则，此时任何 **client 侧**验证都落在**未冻结**的对象上。
4. 我的 pre-fix/HEAD 副本与冻结值**互相印证**：pre-fix `client.panel.tail.js` = **15386**（= 冻结值）、HEAD = **15766**（= 漂移新值）⇒ 我的两态对象选得对。

**处置建议（不在我写域内）**：由冻结 owner 跑一次 `revision.ps1 -Mode Write` 重落锚点；否则 T63/T69 的 client 侧结论按项目自己的规则都算"验证无效"。

## 5. 两栏

**【一旦错了就得返工】**
1. **T60 的前置对象**：任务书写的 `c33c5c7` 不是修复提交（它只动 docs/REVISION）；正确是 **`598543c`**。用错前置 ⇒ 复现的是"改动前"还是"别的状态"就无从谈起（我一开始就核了 `git log -- src/register-tools.ts` 才发现）。
2. **别用"子项 distinct top"当"行盒数"**：同 flex 行内不同高度元素的 top 天然不同（本例差 2px）⇒ 会把"没折行"误判成"折行"。有效判据 = 按 top 分簇（容差 ≥6px）或比 `scrollHeight/clientHeight`（我这次用的是后者 + Range 行盒数）。
3. **pre-fix 副本必须带插件根文件**：我第一次漏了 `cordis.patch.yml`，插件直接**不注册**（rail 只有「插件」、`rw-*` 节点 0）⇒ 面板根本不出现，会误判成"改动前没毛病"。补齐根文件后立刻复现。

**【其余的】**
- `%TEMP%\rwsl-t69\` 里留着 pre-fix/HEAD 两棵树，脚本 `harness-t60.ts` / `assert-t60.ts` 是可复跑的。
- T60 的 HEAD 侧错误信息是**真错误**（UNC 写不进不存在的发行版），不是 harness 造出来的。
- 我的两个实例在 **8919/8920**（T69 指定的 8919–8922），未碰 `host-explorer` 的 8911–8914 / `reliability-keeper` 的 8915–8918。

## 6. 未复核（不许当通过）

1. **T62 全部 5 项**（§3）—— 本轮未做。
2. **T60 的"同端口真重启成功"**（只能用不存在发行版证明"不再静默假成功 + 半死态被丢弃"）。
3. **T63 的"头部 1 行盒"**（§2 的无效指标问题）—— 只有"按钮内折行已修 + header 高度 145→79"两条同向证据。
4. **dark 主题**下的 T63 读数（本轮只测 light）。
5. **冻结锚点**：client 侧 4 个文件当前**未冻结**（§4），client 侧结论按项目规则属"验证无效"。
6. WSL 侧 `/tmp/dsh-rwsl-*` 残留里发现 **2 个不是我产生的**文件（`dsh-rwsl-18532-mv7rui4b-e2f1205f.{pid,sh}`，winpid **18532**；我的 harness winpid 是 24052 且从未写成）⇒ 我**没删**（跨角色物件），交 lead 裁决。

## 7. 纪律与收尾

端口只用 **8919/8920**（T69 指定段）；未 `npm/pnpm install`；实例全 `-WindowStyle Hidden`；**未碰**用户宿主 `19387`（pid **33688** 全程一致）与用户窗口；
**未改** `src/**`、`client/**`（全是 `%TEMP%` 副本 + 只读）；未写用户全局 `~/.dsh/storages/workspace.json`（本轮无真实 DSH 调用）。
收尾：两实例已停、两个 profile（`rwsl-t69-prefix` / `rwsl-t69-head`）已删、`%TEMP%\rwsl-t69` 副本已清、8911–8930 复核、`reset-failed` 已跑、窗口枚举给归属证据。
