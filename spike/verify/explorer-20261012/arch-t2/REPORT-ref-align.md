# REPORT-ref-align.md —— T45：护栏更名后的**引用对齐清扫**

- **执行者**：`reliability-keeper` ｜ **日期**：2026-10-13 ｜ **任务**：`task-45`
- **背景**：T2 的护栏按命名规则 `check-docs-methods.mjs → .ts` 更名后，**调用方仍指着旧名**：1 处可执行脚本失效、1 处冻结 `src` 注释指向不存在的文件、4 份报告散文引用旧路径。
- **写作用域（实际只动这 7 个文件）**：`arch-t5/run-patched-gate.ts` · `src/explorer.ts`（**仅 1 行注释，lead 授权**）· `arch-t3/arch-t4/arch-t5/arch-t6` 的 REPORT（**各末尾追加 1 行**）· `arch-t2/tools/check-docs-methods.ts`（注释里补通用纪律）· 本报告
- **未碰**：`client/**`（T41 在写）· `package.json` · `src/` 的其它任何行 · 其它 verify 子目录
- **新路径（权威）**：`spike/verify/explorer-20261012/arch-t2/tools/check-docs-methods.ts`

## 1. 结论

**引用已对齐**：可执行失效的 `run-patched-gate.ts` 改为**位置无关的薄运行器**（直跑 exit 0）；`src/explorer.ts` 的注释改为新路径并注明更名（**剥注释后与 HEAD 逐字节相同 ⇒ 逻辑零改动**）；4 份报告各追加 1 行更名指针（历史正文不动）。护栏本体 **13/13 PASS / exit 0**。
**全库旧名剩 19 处命中**，其中 **12 处是按要求保留的历史正文**、**6 处是本次故意保留旧名的指针/说明**（为了可追溯"它以前叫什么"）、**1 处是我未被授权的活跃引用**（`arch-t4/tools/check-explorer-methods.ts:7` 的注释）——逐处理由见 §5。

## 2. 改动与取证（逐条）

### 2.1 `arch-t5/run-patched-gate.ts`（可执行失效 → 位置无关薄运行器）
- **为什么必须动逻辑**：它原来的做法是"复制 `check-docs-methods.mjs` 到仓外、打两处补丁、再跑" —— ① 被复制的文件**已改名不存在**；② 它的补丁锚点 `readFileSync(join(ROOT,'src/index.ts'),…)` 在新护栏里**已不存在**（新护栏扫 `src/**` 并锚在 `tools.register`）。⇒ 该脚本**跑不起来**，且"要补的缺陷"已不存在。
- **改法**（lead 授权："也可以改为参数化根目录，但不要引入新脆弱点"）：
  - 路径**全部由自身位置推导**：`HERE = dirname(fileURLToPath(import.meta.url))`，护栏 = `HERE/../arch-t2/tools/check-docs-methods.ts`，仓根 = 上溯 4 级（可用 `--root` 覆盖）；
  - 去掉"复制 + 打补丁 + 写仓外临时文件"三步（避免继续往 `D:/project/net1/_t5-split/` 写）；
  - 找不到护栏时**红并提示**"按位置无关纪律不要改成写死仓根的绝对路径"（exit 2），而不是静默；
  - 历史证据不删：`out-10-gate-docs-patched.txt`（当年补丁副本 11/11 PASS）仍在原目录。
- **原始输出（直跑）**：
  ```
  护栏 = D:\project\dsh1\vendor\dsh-remote-wsl\spike\verify\explorer-20261012\arch-t2\tools\check-docs-methods.ts
  仓根 = D:\project\dsh1\vendor\dsh-remote-wsl（由脚本位置推导）
  …
  护栏 exit=0（0 = 全过）
  ```
  ⇒ **不再失效**，且换名/搬家都不影响（路径由位置推导）。

### 2.2 `src/explorer.ts`（**只改 1 行注释**）
`git diff -U0 -- src/explorer.ts`：
```diff
@@ -72 +72 @@ export const EXPLORER_METHODS = [
- *     所以那边是"投影"：`arch-t2/tools/check-docs-methods.mjs`（跨任务门禁）与
+ *     所以那边是"投影"：`arch-t2/tools/check-docs-methods.ts`（跨任务门禁；2026-10-13 由 .mjs 更名，判据未改）与
```
**逻辑零改动的强证明**（不靠肉眼读 diff）：把 HEAD 版本与工作树版本**都剥掉注释、去掉空白**后逐字节比对：
```
HEAD 剥注释长度=16944  工作树剥注释长度=16944  ⇒ 逐字节相同 = True
```
⇒ 代码/字面量**一字未动**，只有注释行变化。（lead 已说明：src 冻结锚点会变，P0.5 会重新冻结。）

### 2.3 四份报告散文（各**末尾追加 1 行**，历史正文不动）
`git diff --stat`：
```
 arch-t3/REPORT-daemon-split.md  | 2 ++
 arch-t4/REPORT-contract-ssot.md | 2 ++
 arch-t5/REPORT-host-split.md    | 2 ++
 3 files changed, 6 insertions(+)
```
追加内容（统一措辞）：
> **引用对齐（2026-10-13，T45）**：本报告引用的 `check-docs-methods.mjs` 现已更名为 `arch-t2/tools/check-docs-methods.ts`（判据未改）。

**第 4 份 `arch-t6/REPORT-panel-split.md` 的取证情况特殊（必须说清）**：我追加后，**T6 的一次提交（`4f4ae1d`）把我的工作树改动一起提交了** ⇒ `git status` / `git diff` 对它**自然为空**。因此该处用"内容取证"而非 diff：
```
git show HEAD:spike/.../arch-t6/REPORT-panel-split.md 含 T45 注记 = True
工作树含 T45 注记 = True
git diff HEAD --numstat / diff --cached --numstat =（均空）⇒ 工作树 == index == HEAD
```
⇒ 追加**已落地且已在 HEAD**；`check-ignore` exit=1（未被忽略）、`ls-files` 确认被跟踪。**这是我控不了的现象：并发提交会扫走我的工作树改动**（见 §6 观察）。

### 2.4 `arch-t2/tools/check-docs-methods.ts`（注释里补通用纪律，判据未改）
把原"护栏纪律：权威来源不得写死到某个文件路径（红过两次）"升级为**通用纪律（T45 立）**："护栏与工具的**权威来源 / 引用路径**不得写死到具体文件"，并把**第三次**（本次更名波及 2 处调用方）记进去，明确 **"位置无关"是新增护栏/工具的验收项之一**。**仅注释变化，断言逻辑未动**（改后 13/13 见 §3）。

## 3. 护栏复跑（改后）

```
权威 tools(7): wsl_status, wsl_exec, wsl_agent, wsl_daemon, wsl_open_ui, wsl_sync_version, wsl_path
  锚定来源（tools.register）：register-tools.ts:wsl_status; …; register-tools.ts:wsl_path
结果：PASS ｜ 断言 13 条        gate exit=0
```

## 4. `git status --porcelain`（我动的全部文件）

```
 M spike/verify/explorer-20261012/arch-t2/REPORT-docs-refresh.md      （T2 那一轮的注记，非本次）
 M spike/verify/explorer-20261012/arch-t2/tools/check-docs-methods.ts（本次：注释补纪律）
 M spike/verify/explorer-20261012/arch-t3/REPORT-daemon-split.md      （本次：追加 1 行）
 M spike/verify/explorer-20261012/arch-t4/REPORT-contract-ssot.md     （本次：追加 1 行）
 M spike/verify/explorer-20261012/arch-t5/REPORT-host-split.md        （本次：追加 1 行）
 M spike/verify/explorer-20261012/arch-t5/run-patched-gate.ts         （本次：位置无关薄运行器）
 M src/explorer.ts                                                    （本次：1 行注释）
?? spike/verify/explorer-20261012/arch-t2/out-08-gate-after-t5.txt    （T45 之前的证据件）
?? spike/verify/explorer-20261012/arch-t2/out-09-gate-renamed-ts.txt  （同上）
```
- `arch-t6/REPORT-panel-split.md` **不在列表里**，原因见 §2.3（已被 T6 提交）。
- **共享 checkout 声明**：仓库被多角色并行修改；本报告只用**限定路径**的 status/diff 作证据。

## 5. 旧名剩余命中：**19 处 + 逐处为什么不改**

| # | 位置 | 类别 | 为什么不改 |
|---|---|---|---|
| 1-3 | `arch-t2/REPORT-docs-refresh.md:6,68,131` | 历史正文 | lead 明确要求"历史正文保持不动"；该文件末尾已有注记声明"以新路径为准" |
| 4 | `arch-t2/REPORT-docs-refresh.md:150` | **我加的注记（故意）** | 就是为了让"它以前叫 .mjs"可追溯 |
| 5 | `arch-t3/REPORT-daemon-split.md:130` | 历史正文 | 同上（末尾已追加指针） |
| 6 | `arch-t3/REPORT-daemon-split.md:148` | **本次追加的指针（故意）** | 指针本身必须写出旧名，否则读者无法把旧名对上 |
| 7-10 | `arch-t4/REPORT-contract-ssot.md:19,48,64,130` | 历史正文 | 同上（末尾已追加指针） |
| 11 | `arch-t4/REPORT-contract-ssot.md:164` | **本次追加的指针（故意）** | 同上 |
| **12** | **`arch-t4/tools/check-explorer-methods.ts:7`** | **⚠️ 活跃引用（未授权改）** | 它是 **T4 脚本的 JSDoc 注释**（非可执行逻辑），且顺带写着"**11 条断言**"（现已是 13 条）。**不在 lead 授权范围**（只点名 4 份报告 + `run-patched-gate.ts` + `explorer.ts` 注释）⇒ **留给 T4 对齐**（建议同时把"11 条"改成"13 条"） |
| 13-15 | `arch-t5/REPORT-host-split.md:82,87,94` | 历史正文 | 同上（末尾已追加指针） |
| 16 | `arch-t5/REPORT-host-split.md:116` | **本次追加的指针（故意）** | 同上 |
| 17 | `arch-t5/run-patched-gate.ts:4` | **脚本头注释（故意）** | 新头部必须引用旧名来解释"为什么要改薄运行器" |
| 18 | `arch-t6/REPORT-panel-split.md:32` | 历史正文 | 同上（末尾指针已在 HEAD，见 §2.3） |
| 19 | `arch-t6/REPORT-panel-split.md:196` | **本次追加的指针（故意）** | 同上 |

**分类计数：历史正文 12 处（不改，按指示）｜本次故意保留旧名的指针/说明 6 处｜未被授权的活跃引用 1 处（`arch-t4/.../check-explorer-methods.ts:7`，建议 T4 改）。**
⇒ **"为什么还有旧名"这个问题的答案是确定的**，不需要以后再扫一遍：**要么是历史正文（有末尾指针兜底），要么是指针本身（必须提旧名），只剩 1 处待 T4 对齐。**

## 6. 两条纪律/观察

1. **通用纪律（已落进护栏注释）**：**护栏与工具的"权威来源 / 引用路径"不得写死到具体文件；新增护栏/工具时，"位置无关"是验收项之一**（用"改文件名 + 挪嵌套目录"两个实证来证明，像 T2 那次做的那样）。本仓为此已红过三次（读死 `index.ts` / T5 搬文件 / 本次更名波及调用方），都记在 `arch-t2/tools/check-docs-methods.ts` 头部。
2. **观察（我控不了，供 lead 知悉）**：**并发提交会把我的工作树改动一起提交** —— `arch-t6/REPORT-panel-split.md` 就是被 T6 的 `4f4ae1d` 顺带提交的，导致 `git status` 对该文件为空、我的"改动取证"必须改用 `git show HEAD:…` 内容比对。在多角色并行写同一 checkout 时，**"git status 为空"不等于"没改过"**。

## 7. 两栏

**【一旦错了就得返工】**
1. **`src/explorer.ts` 必须只有注释变化** —— 已用"剥注释后与 HEAD 逐字节相同（16944 == 16944）"证明，不是靠读 diff 目测；改后护栏 **13/13 PASS**。P0.5 重新冻结时请把这一处算作"注释变更"。
2. **`run-patched-gate.ts` 现在真的能跑**（`exit 0`），且路径**由自身位置推导**；若有人再把它改回"写死仓根 / 复制 .mjs"，就同时违反通用纪律并再次失效。
3. **旧名剩余 19 处必须可解释** —— 本报告 §5 已逐处给理由；**唯一缺口是 `arch-t4/tools/check-explorer-methods.ts:7`（含过期的"11 条断言"）**，属 T4 域，建议由 T4 顺手改。

**【其余的】**
4. 四份报告只追加 1 行、历史正文零改动（`git diff --stat` 各 +2 行）。
5. `arch-t2/REPORT-docs-refresh.md` 历史正文按指示未动。
6. 本次未起任何实例 ⇒ 无需端口/守护/unit 清理（`client/**` 全程未碰）。

## 8. 未复核：4 条

1. **旧名扫描口径**：只扫 `*.md/*.ps1/*.ts/*.mjs/*.json/*.yml`（未覆盖二进制或其它扩展名，如 `.txt` 证据件里可能有历史引用；`arch-t5/out-07-gate-docs.txt` 这类**历史输出**按定义会含旧名，属正常）。
2. **`arch-t4/tools/check-explorer-methods.ts:7`** 未改（未授权）；其"11 条断言"的过期表述也一并留给 T4。
3. **`run-patched-gate.ts` 的行为已变**（薄运行器 vs 原"复制+补丁"），但它的**历史输出与 arch-t5 报告正文仍描述旧行为**——按"历史正文不改"处理，未加注记对齐（若 lead 要，我可在 arch-t5 报告末尾指针里补一句）。
4. **`arch-t6` 那处我无法用 git diff 自证**（已被 T6 提交）；只能用 `git show HEAD:…` 的内容比对 + `diff HEAD`/`--cached` 均为空 来间接证明（见 §2.3）。

---

## 9. 追加（2026-10-13 同日，lead 额外授权两项）

### 9.1 `arch-t4/tools/check-explorer-methods.ts` —— 清掉 §5 的"唯一活跃引用"
- **改动**：第 7 行 JSDoc 注释：旧路径 → `arch-t2/tools/check-docs-methods.ts`，并把顺带写错的"11 条断言" → "**13 条**"（现网实测值）。
- **取证（只动注释，用 §2.2 那套"剥注释逐字节比对"）**：
  ```
  git diff -U0 -- …/arch-t4/tools/check-explorer-methods.ts
    ⇒ 恰好 1 个 hunk / 1 行： - * …`check-docs-methods.mjs` 另有 11 条断言…
                              + * …`check-docs-methods.ts` 另有 **13 条**断言（2026-10-13 由 .mjs 更名，判据未改）…
  剥注释去空白后与 HEAD 逐字节比对：HEAD=3267  工作树=3267  ⇒ 逐字节相同 = True
  ```
- **该工具本身仍能跑**（证明注释改动没碰逻辑）：`node …/check-explorer-methods.ts --root <repo>` ⇒ `结果：PASS ｜ 断言 8 条 ｜ exit 0`。
- ⇒ **§5 表第 12 行"未授权的活跃引用"已清零。**

### 9.2 `arch-t5/REPORT-host-split.md` —— 追加 1 行（历史正文不动）
在既有"引用对齐"指针之后再追加一行：
> **追加（2026-10-13，T45 补）**：该运行器已改为**位置无关薄运行器**（路径由 `import.meta.url` 推导、仓根可 `--root` 覆盖），**本节/上文描述的是它当时的形态**；历史输出 `out-10-gate-docs-patched.txt` 保留为当时的证据。

⇒ 补上了 §8 未复核第 3 条指出的缺口（正文描述旧行为，现已有末尾注记对齐）。

### 9.3 旧名命中清单**更新**：19 → **22**（**活跃引用 = 0**）

| 类别 | 处数 | 明细 |
|---|---|---|
| **历史正文**（按指示不改；各份末尾已有指针兜底） | **12** | `arch-t2:6,68,131` · `arch-t3:130` · `arch-t4:19,48,64,130` · `arch-t5:82,87,94` · `arch-t6:32` |
| **T45 故意保留旧名的指针/说明**（指针必须提旧名才可追溯） | **6** | `arch-t2:150` · `arch-t3:148` · `arch-t4:164` · `arch-t5:116` · `arch-t6:196` · `arch-t5/run-patched-gate.ts:4` |
| **本报告自述**（本报告主题就是"旧名清扫"，正文必然多次提到旧名） | **4** | `arch-t2/REPORT-ref-align.md:4,17,36,54` |
| **⚠️ 活跃引用（该改未改）** | **0** ✅ | 原 `arch-t4/tools/check-explorer-methods.ts:7` 已在 §9.1 清掉 |

**为什么总数从 19 涨到 22（说清，否则像回归）**：`−1`（arch-t4 那处清掉）`+4`（**本报告自身**对旧名的自述）。
⇒ **关键指标是"活跃引用 = 0"，不是总数**：22 处里有 18 处（历史正文 12 + 指针/说明 6）是**按设计必须保留旧名**的位置，另 4 处是本报告的自我描述。
⇒ **今后再扫的判据**：**"脚本常量/可执行路径里的旧名 = 0"**；报告与指针中的旧名属历史，无需清零。

**复跑**：本报告 §3 的护栏结论在追加后不变 ⇒ `13/13 PASS / exit 0`。
**本轮新增写域**：`arch-t4/tools/check-explorer-methods.ts`（授权）· `arch-t5/REPORT-host-split.md`（授权）· 本报告；仍未碰 `client/**`、`package.json`、其它 verify 子目录。
