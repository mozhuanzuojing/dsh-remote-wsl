# T57 报告：M1 检查器（面板内可见 `dsh1` 的次数）

> **归属如实说明**：脚本 `spike/verify/explorer-20261012/tools/m1-visible-count.ts`（12,667 B）由 `usability-engineer` 写好并跑通真机读数后**中途上下文耗尽死亡**；**两个对照 + 报告由 Lead 接手完成**（与 `precommit` 第 08 项同样的处理）。因此本任务的"量具红/白能力"由 **Lead 自证**，**不是独立验证**。

## 1. 背景

`visual-designer` 在 T52 全仓搜索后指出：**M1「面板内可见 `dsh1` 恰 1 次」历轮都是临时手测，没有可复算门禁**。本任务把它变成脚本。

## 2. 脚本口径（写在脚本头部注释里，逐条可判）

1. 只取**文本节点**（`TreeWalker SHOW_TEXT`）⇒ `aria-label`/`title`/`data-*`/`value` **天然不计**；
2. 排除不可见祖先（`script`/`style`/`noscript`/`template`/`[hidden]`/`[aria-hidden="true"]`）；
3. 排除**未展开 `<details>`** 的内容（除非在 `<summary>` 子树内）；
4. 排除计算样式 `display:none` / `visibility:hidden|collapse`；
5. 排除**零尺寸**（`getBoundingClientRect` 宽或高为 0，含 `opacity:0`）；
6. 空白折叠后匹配；`--scope panel|entries` 选择统计根；`exit 0/1/2/3` = PASS/FAIL/用法错/不可判定。

## 3. 真机读数（两台**当前 HEAD `70c697d`** 的孤立实例）

| 实例 | scope=panel | 命中（路径） | scope=entries |
|---|---|---|---|
| `8961`（usability p05 pristine） | **2** | ① `…header-text > span.dsh-rw-subtitle` ⟵ `目标 debian-u8-1 · /home/g/project/dsh1`　② `…nav.dsh-rw-crumbs > span.dsh-rw-crumb--current` ⟵ `dsh1` | **1**（列表行 `dsh1`） |
| `8966`（T54 的 p06 实例） | **2** | 同上两条 | **0**（该实例 cwd 不同，列表里没有该行） |

## 4. 判据缺口（**本次最重要的产出**）

M1 的原文是"可见 `dsh1` **恰 1 次**"，但实测 **panel scope 恒为 2**，且两条命中**都是合法的"路径展示"**：

- ① 副标题里的目标路径 `/home/g/project/dsh1`；
- ② 当前目录面包屑 `dsh1`。

⇒ 当**被打开的工作区路径本身含 `dsh1`**（`D:\project\dsh1` 就是本仓实际路径）时，**"恰 1"不可满足**，这与实现好坏无关。
⇒ 反过来也说明：**历轮"M1 = 1"的结论是"实例相关"的** —— 只有当实例的 cwd/目标路径**不含** `dsh1` 时才会是 1。**此前把它当作实现属性来引用是不严谨的**（记录在案）。

**建议的判据重述（三选一，推荐 C）**：

- A. `--scope entries`（只数列表行）：8961 得 1 ✅，但 8966 得 0（cwd 不同）⇒ **脆弱**，不适合作固定期望。
- B. 排除"看起来像路径"的文本节点（含 `/`）后再断言恰 1：能覆盖副标题，但面包屑 `dsh1` 不含 `/` ⇒ 仍会多算。
- **C（推荐）**：把 M1 重述为「**工作区名作为"标签/条目"出现恰 1 次；出现在"路径展示"（副标题、面包屑、`data-*`）中不计**」
  ⇒ 实现方式：统计 `panel` scope 且**排除** `span.dsh-rw-subtitle`（路径展示）与 `nav.dsh-rw-crumbs` 子树后，断言恰 1；当前实现在此口径下**成立**（`entries`=1 / `panel−路径展示`=1）。

> 本报告**不擅自改** M1 的规格文本（那属于 `docs/panel-ux-redesign.md` 的写域，且应由 UX 线裁决）；在此给出可判形式与证据，供裁决。

## 5. 量具红/白能力（Lead 复跑）

命令：`node tools/m1-visible-count.ts --url <8966 tokenUrl> --cdp 8965 --scope panel --expect 2 --selftest --json …`
（`--expect 2` 是为了量化"判别力"：真读数恰为 2）。

| 项 | 结果 |
|---|---|
| 真读数 | `count = 2`，`hits` = 上表两条 ⇒ **PASS(恰 2)** |
| **对照①属性注入**（往 `aria-label`/`data-*` 里塞 `dsh1`） | `count` **仍为 2** ⇒ `ok:true`（**属性不计入**，证明口径不是"数全页字符串"） |
| **对照②可见注入**（在 panel 内插入第二处可见文本） | `count → 3`，`expected 3` ⇒ `ok:true`（**能咬住**） |
| 清理 | `afterCleanup.count = 2` ⇒ 复原 |
| 总判定 | `verdict = PASS(恰 2)`；`selftestVerdict = PASS(三项控制全部符合预期)`；**exit 0** |

**同时给出一条"应该红就红"的真实 FAIL**：同一脚本在 `--scope entries --expect 1`、而实例 8966 的 entries=0 时 ⇒ `verdict=FAIL(0 ≠ 1)`、**exit 1**（即门禁不会把 0 当通过）。

## 6. 为什么不接进 `precommit-check.ps1`

`precommit` 的设计前提是**静态、无需实例、不弹窗**；本检查器需要**真浏览器 + 一个活着并已渲染面板的实例 + CDP 端口**。硬接进去会让"提交前必跑"变成"必须先起实例" ⇒ 违反其前提。
**建议**：保持**独立脚本**，在 UX 轮的复验清单里跑（与 T40/T50 的手法一致）；若日后要自动化，应挂在"起实例的 CI 阶段"而不是 `precommit`。

## 7. 未复核 / 遗留

- **屏读器实机播报**（无环境）；
- M1 判据重述后**重新基线**（需 UX 线裁决口径后重跑）；
- 本报告未覆盖 `--scope entries` 在"cwd 含 `dsh1` 且列表已加载"时的稳定性（仅按 8961 单例）；
- 真机读数取自已存活实例（`8961`/`8966`），**收尾未由我停**（属他人任务在跑，见交接纪律）。

## 8. 纪律

未起实例（复用他人的 8961/8966 与 headless CDP 8965，只读页面 + 两次 DOM 注入后**均复原**）；未碰用户宿主 19387（pid 33688）；未写用户全局 `~/.dsh/storages/workspace.json`；未装任何包；未创建 unit/守护/包装层/profile。

---

## 9. 附录（`usability-engineer` 续作，2026-10-14 ｜ HEAD `b9e8dfb` / P0.5.3）

上一轮我在"字节还原"中途死亡；Lead 已接手写好正文（§1–§8）。本附录只补**正文未覆盖的两件**：**副本级红测**与**字节还原复绿**，并**修掉脚本里一处控制项缺陷**。

### 9.1 修脚本：控制项的期望值不该用 `--expect`

原实现的 `--selftest` 把控制项期望写成 `EXPECT`（= 断言期望，通常 1），而真实 baseline 是 **2** ⇒ **控制项自己假红**（`selftestVerdict: FAIL`，尽管注入行为完全正确）。
已改为**以实测 baseline 为基准**（`expected: count` / `count + 1`），并**注入到"读数 scope 根"**（原先注入 panel 根而读 entries scope ⇒ 负例测不到）。修后：`selftestVerdict = PASS(三项控制全部符合预期)`（`out-m1-selftest.json`）。

### 9.2 副本级红测（"必须能红"的**副本**形态）

| 步骤 | 读数 |
|---|---|
| 副本入口追加注入（往 `.dsh-rw-entries` 塞第二个同名可见条目） | `28342 B / B138A277…` → **`28842 B / 1B8428704BC1BAF9`** |
| 副本上跑：`--scope entries --up 1` | **count 2 ⇒ FAIL / exit 1** ✅（两条命中均为 `div.dsh-rw-entries > div.dsh-rw-row--dir > span.dsh-rw-rowname`）→ `out-m1-red-copy.json` |
| **字节还原**（拷回 pristine 入口） | `sha256 = B138A277BCE45DB4`、28342 B、红标记串已无 ✅ |
| 还原后**同实例直接复跑** | **count 仍 2 / exit 1** ⚠️ |
| **重启该实例**后复跑 | **count 1 ⇒ PASS / exit 0** ✅ → `out-m1-red-restored.json` |

### 9.3 由此得到的一条**机制补充**（给 `docs/client-contract.md §11` 的作者）

§11 讲的是"**只改 chunk（入口不动）**⇒ 宿主不重扫、连空缓存浏览器也拿旧字节"。本附录补另一半：**即使改/还原的是入口本身，运行中的实例也不会立刻换字节** —— 必须**重启实例**后才生效（上表"同实例仍 2 / 重启后 1"）。
⇒ 排查"改了没生效"时，**除了 `rev` 还要问"实例是否重启过"**；这条与判法无关，但会让"还原即复绿"的期望落空。

### 9.4 与本轮 T64 的口径一致性

本轮 T64 在同一基线（`b9e8dfb` / P0.5.3、孤立 `DSH_HOME`、headless CDP）上复核：`entries` scope = **1 / exit 0**、`panel` scope = **2 / exit 1**（两条命中与 §3 表一致：副标题路径 + 面包屑当前段）⇒ **与 Lead 正文结论一致，独立复现**。
