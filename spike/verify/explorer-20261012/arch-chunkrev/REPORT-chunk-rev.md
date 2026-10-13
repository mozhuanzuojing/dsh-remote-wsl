# REPORT-chunk-rev —— chunk 陈旧坑：独立复核 + 机器门禁 + 写进 client-contract（task-37）

- **日期**：2026-10-13 ｜ **执行者**：`stability-engineer`（task-37 owner）
- **被验对象**：`dsh-remote-wsl` 的 client 半（`client/index.js` + 4 个 chunk）+ 平台 `@deepseek-ai/dsh-client-modules`（app.asar 内）
- **写作用域**：`spike/verify/explorer-20261012/tools/`（脚本）+ `docs/client-contract.md`（§11，只增不改）
  - ⚠️ **边界说明（请裁）**：任务同时指定交付物为 `spike/verify/explorer-20261012/arch-chunkrev/REPORT-chunk-rev.md`，而 `arch-chunkrev/` **不在** `writeScopes` 的两项里。我按"交付路径明确指名"处理，把报告与原始输出写在 `arch-chunkrev/`；若这不合适，删除该目录即可（不影响其它交付物）。
- **纪律**：未 `npm/pnpm install`；未弹可见窗口（实例用 `-WindowStyle Hidden` 启动）；未碰用户宿主 `19387`（全程 pid **47564**，`47604` 本就空闲）；收尾清理见 §5。

---

## 0. 结论（先说）

T32 的机制判断**成立**，并被我独立复核到**代码行 + 实测**两级。另外我实测到**它比"浏览器缓存"更严重的一层**：

1. **`rev` 是入口文件的元数据哈希**（`mtimeMs/ctimeMs/size`），**不是内容哈希**；chunk URL 的 `rev` 就取自入口 ⇒ **只改 chunk ⇒ rev 不变 ⇒ URL 一模一样**。
2. 该 URL 的响应是 `immutable`（`max-age=31536000`）⇒ 浏览器**不再发请求**（实测 `transferSize=0`）。
3. **新增（本轮）**：**宿主侧也会陈旧** —— 平台在扫描时快照 chunk 字节，而重扫的闸门是**入口元数据**（`:611` 短路）⇒ 只改 chunk 时**连空缓存的全新客户端**也拿到旧字节。

⇒ 正确姿势只有一个：**改任何 chunk 都要让 `client/index.js` 变（推荐加一行版本注释）**。已交付机器门禁 `check-client-rev.mjs`（三种模式、可自测、正/负都实测过）与 `docs/client-contract.md` §11。

---

## 1. 机制复核（独立取证，不接受转述）

### 1.1 `rev` 从哪来 —— **入口文件的元数据**，不是内容

`app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`：

```
:192-198  /** Identify an entry's build from filesystem metadata without hashing its contents. */
          function artifactRevision(baseline) {
            return framedHash("plugin-artifact", [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)]);
          }
:610-614  const baseline = this.captureArtifactBaseline(record.meta.clientPath);   // ← 只取【入口】文件
          const rev = artifactRevision(baseline);
          if (rev === record.entry.rev) return rev;                                  // ← 入口元数据没变就短路，连 bundle 都不重读
:882-884  const rev = artifactRevision(snapshot.baseline);                            // 首次快照同样只吃入口
:363-367  const resources = records.map((record) => ({ id: record.entry.id, rev: record.entry.rev, … }));
```

**复算对账（关键交叉验证）**：我用与平台逐字节相同的算法独立算，得到 **`07cf221a6f42`**；从页面 boot manifest 抓平台真正 serve 的 rev 也是 **`07cf221a6f42`** ⇒ 门禁的复算可信。

```powershell
$page=(Invoke-WebRequest $tokenUrl -UseBasicParsing).Content
[regex]::Match($page,'\{"id":"dsh-remote-wsl","url":"([^"]+)","rev":"([0-9a-f]+)"').Groups[1..2].Value
node spike/verify/explorer-20261012/tools/check-client-rev.mjs --print-rev
# 实测：url=plugins/??dsh-remote-wsl/client.js&rev=07cf221a6f42   rev(本地复算)=07cf221a6f42  相等=True
```

### 1.2 chunk URL 用的是**入口行的 rev**

`…/dsh-client-modules/lib/client.js`：

```
:725  const url = chunkUrl(row, fileName, this.factories.get(ownerId)?.rev ?? this.reloadTargets.get(ownerId)?.rev ?? row.rev);
:480  function chunkUrl(row, fileName, rev) {
:485    return `${url.slice(0, resourceStart)}/${row.id}/${fileName}?${url.slice(revisionStart + 1)}`;   // ← 复用入口 bundle URL 的 &rev=
```

即：**chunk 的 `rev` 与它自己的内容无关**，只跟"入口 bundle URL 上的 rev"一致。

### 1.3 `immutable` 在哪一层 + 不匹配 rev 会被拒（实测）

`…/lib/index.js`：`:159 const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";`（注释：*"Versioned code is immutable; mismatched revisions are rejected instead of serving newer bytes."*）、`:963-971` 命中 `(id,file,rev)` 才 200 + 该头，否则 404。

实测（`out-09-http-evidence.txt`）：

| 请求 | 结果 |
|---|---|
| `GET /plugins/??dsh-remote-wsl/client.js&rev=07cf221a6f42` | **200**，`cache-control: public, max-age=31536000, immutable`，25680 B |
| `GET /plugins/dsh-remote-wsl/client.panel.js?rev=07cf221a6f42`（**入口 rev**） | **200**，同 immutable 头，55863 B |
| `GET /plugins/dsh-remote-wsl/client.i18n.js?rev=07cf221a6f42`（**入口 rev**） | **200**，32741 B |
| `GET /plugins/dsh-remote-wsl/client.panel.js?rev=deadbeefcafe`（错 rev） | **404** |

⇒ 第 2/3 行同时证明两件事：**chunk 的 rev 就是入口 rev**；**平台按 rev 精确校验**。

### 1.4 【本轮新增发现】宿主侧快照陈旧（L1）——比浏览器缓存更靠前

在**副本**上做（不改真仓库），`out-13-live-staleness.txt` / `out-14-snapshot-staleness.txt`：

| 动作 | rev | 同 URL 返回的字节 |
|---|---|---|
| 基线 | `07cf221a6f42` | 55863，无 V2 标记 |
| **只改 `client.panel.js`**（追 V2），不动入口 | **不变** `07cf221a6f42` | **仍 55863，仍无 V2**（宿主快照陈旧） |
| 追 V4（再改 chunk，仍不动入口） | 不变 | **仍 55905/V2** ⇒ 宿主只认入口元数据 |
| **改入口**（追一行注释） | **`9c1bfa68055a`**（变了） | 新 URL → **200 + V2**（55905）；**旧 URL → 404** |

⇒ **L1**：只改 chunk 时连**空缓存的全新客户端**也拿旧字节（服务端快照没更新）；**L2**：URL 不变 + `immutable` ⇒ 老客户端**零请求**吃本地副本。两层同一个解法：**bump 入口**。

（附：平台会在 chunk 响应尾部追加 source-map 引用，实测尾部为 `;\n//# sourceMappingURL=client.panel.js.map?rev=9c1bfa68055a` ⇒ 故"serve 的字节数 = 快照 + 该 trailer"，比磁盘略大。）

### 1.5 L2 浏览器实测（A/B）

设置：只把 `client.i18n.js` 的 `panel.title` 从 `远程资源管理器` 改成 `远程资源管理器【CHUNKREV_L2_新】`（**入口未动**）⇒ rev 仍 `9c1bfa68055a`；重启宿主后**同一 URL** 返回新字节（32762 B，含新标记，仍带 `immutable`）。

| 臂 | 操作 | 结果 |
|---|---|---|
| **A（已缓存）** | 同一浏览器上下文重新加载页面 | 四个 chunk 全部 **`transferSize=0`（零网络请求）**；`client.i18n.js` 的 `decodedBodySize=32741`（= **旧**字节；服务端此时是 32762）；界面文案仍是**旧**的 `远程资源管理器`，新标记**不出现** |
| **B（空缓存）** | 期望用全新隔离上下文对照 | **未取得**：隔离上下文落在 `dsh web authentication required`（未完成 token 握手）⇒ 见 §7 未复核 U1；**改用同 URL 的 HTTP 对照**（同一 URL 对空缓存客户端返回**新**字节）作为反事实证据 |

⇒ 臂 A 直接给出用户可见后果：**"重启宿主 + 新页面"也看不到新 chunk**，因为浏览器连请求都不发。

---

## 2. 机器门禁：`tools/check-client-rev.mjs`

**设计**（三种模式，`--mode auto` 依次择优 git → baseline → mtime）：

| 模式 | 判据 | 特点 |
|---|---|---|
| `git`（默认） | 入口**内容**最后一次变更的提交之后有 chunk 变更，**且**入口元数据不比这些 chunk 新 ⇒ FAIL | 最准；用 `git diff <entryCommit> -- client/`（含工作区未提交改动） |
| `baseline` | 基线记录的 rev 未变、而某 chunk 的内容 sha256 变了 ⇒ FAIL | 便携；`--update` 落 `.client-rev-baseline.json`（rev + 各 chunk sha256），幂等（内容不变不重写） |
| `mtime` | 存在 chunk 的 mtime 晚于入口 ⇒ FAIL（`--mtime-tolerance` 可放宽） | 保守兜底；**全新 checkout 可能误报**（已写进文档与 `--help`） |

**正/负原始输出**（都在 `arch-chunkrev/`）：`--self-test` 在**副本**里跑 9 个断言，全部 OK（`out-02-selftest.txt`）：① 建基线 ②③ 未改动幂等 PASS ④ **只改 chunk ⇒ FAIL（exit 1）** ④b mtime 模式同样 FAIL ⑤ 改入口 ⇒ PASS ⑤b mtime 模式 PASS ⑥⑦ 刷新基线后 PASS。
真仓库三模式**全 PASS**（`out-04-real-git.txt`/`out-05-real-mtime.txt`/`out-06-real-auto.txt`）：当前树**已被 bump 过**（入口元数据 `06:32:37` 晚于最近变更的 chunk `06:28:04`）⇒ 眼下**不存在**陈旧风险。
副本上的红（`out-10-live-copy-fail.txt`、`out-11-live-copy-fail-baseline.txt`）含 FAIL 定位与"必须怎么做"三条指引。

**FAIL 时打印的动作清单**：A) 改入口内容（推荐，例：加 `// client-rev: <日期> chunk=<名字>`）B) 只 `touch` 入口（**不推荐**，跨机器不可复现）C) `--update` 刷新基线。

**它自己的两个缺陷是被自测抓出来的（已修，留痕）**：
1. `--update` 分支排在"基线必须已存在"检查**之后** ⇒ 首次建基线直接 `exit 3`（自测① 抓出）；
2. mtime 比较原来硬编码 `+1000ms` 容差 ⇒ 一次 122ms 的真实 bump 被误判 FAIL（自测⑤b 抓出，改为默认 0 容差 + 可配 `--mtime-tolerance`）。

**取证件 `tools/asar-read.mjs`**：零依赖读 `app.asar`（平台代码在 asar 内，`npx asar` 会装包故禁用）。第一版把 pickle 里的 JSON 长度取错 4 字节 ⇒ `JSON.parse` 失败；已改为 `pickle[4..7]=字符串长度`、`pickle[8..]` 才是 JSON。

---

## 3. 文档：`docs/client-contract.md` 新增 §11（**只增不改**）

见文件末尾 `## 11. chunk 的 rev 与 immutable 缓存：只改 chunk 不生效的机制坑`，含：机制表（附平台行号）、两层陈旧、正确姿势（bump 入口的具体做法 + 为什么不推荐只 touch）、门禁用法（命令/退出码/模式）、局限（需要历史）。
**未改动 §1–§10 任何一个字符**（diff 形式见 §4）。

---

## 4. 无越界证据

```
$ git -C D:\project\dsh1\vendor\dsh-remote-wsl status --porcelain | Select-String 'client/|src/|package.json|README'
 M README.md                 ← 非我（README 指针由别人加）
 M client/client.api.js      ← 非我（T36/T32 在跑；任务明令不得碰）
 M client/client.panel.js    ← 非我
 M client/index.js           ← 非我
 M src/daemon-client.ts      ← 非我
 M src/explorer.ts           ← 非我
 M src/index.ts              ← 非我
?? client/client.i18n.js     ← 非我
$ git status --porcelain | Select-String 'tools/|arch-chunkrev|client-contract'
?? spike/verify/explorer-20261012/tools/
?? spike/verify/explorer-20261012/arch-chunkrev/
 M docs/client-contract.md   ← 我（只追加 §11）
```

**改动时间对照**：`client/**` 与 `src/**` 的最后写入时间**早于**我本任务的第一次写入（14:33），且我在副本（`%TEMP%\dsrw-chunkrev-live`）里做的所有 chunk 实验**都不在仓库内**；副本已删。

---

## 5. 清理与归属证据

| 项 | 结果 |
|---|---|
| 自造进程 | 两个隐藏宿主实例（wrapper + node）已按 pid 停掉；**未起守护**；未起其它常驻进程 |
| 端口 | 8981/8982/8983 **全 free**（终态核查） |
| profile | 自建 `remote-wsl-test-chunkrev` **已删**（先打印路径核对） |
| 副本/临时 | `%TEMP%\dsrw-chunkrev-live`、临时基线 json **已删** |
| units | `systemctl --user list-units --all` 里**只有一个** `dsh-rwsl-8932.service`（active/running，slot 8932）—— **不是我的**：本任务我**从未启动守护**，且我的配置槽位是 8982（终态无 8982 监听）。故**未停它**（他人资源）。`list-units --failed` = 0；已按要求跑 `systemctl --user reset-failed`（无事可清）。 |
| 窗口 | 我的实例以 `-WindowStyle Hidden` 启动；终态可见窗口枚举见 `out-17-windows.txt`（只应见到用户自己的 DSH 等既有窗口，无我进程的窗口） |
| 用户宿主 | `19387` 全程 **pid=47564**（开工=收工）；`47604` 本就空闲 |

---

## 6. 两栏

### 【一旦错了就得返工】
1. **"rev 只来自入口元数据"这个结论**：已用"独立复算 == 平台 serve 的 rev"对账（`07cf221a6f42`），若平台换算法（例如改成内容哈希），门禁的 `--print-rev` 与三模式判据都要跟着改。
2. **"不匹配 rev ⇒ 404"**：实测成立；若上游改成"serve 最新字节"，则 L1/L2 的后果会减轻（但 URL 不变 + immutable 仍在），文档 §11 的措辞需要更新。
3. **门禁的 FAIL 语义**：`git` 模式依赖"入口最后一次内容变更的提交"；若仓库改用别的发布流程（不提交直接发布），应以 `baseline` 模式为准。三模式的取舍写进了文档，改语义要同步改文档。
4. **交付目录**：`arch-chunkrev/` 不在 `writeScopes`（见报告头）。若 lead 认为越界，需要把报告挪到 `tools/` 下。

### 【其余的】
- `immutable` 的具体值（`max-age=31536000`）、`chunkUrl` 的行号、asar 读取器的实现细节、自测的 9 个断言、FAIL 文案的三条指引。
- 平台在 chunk 尾部追加 `sourceMappingURL …?rev=` 的行为（复算字节数时会差这几十字节）。
- 我这次修的两个门禁自身缺陷（`--update` 顺序、mtime 容差）与 asar 读取器的 pickle 偏移。

---

## 7. 未复核

| # | 未复核项 | 说明 |
|---|---|---|
| **U1** | **UI 级"空缓存"对照臂** | 全新隔离上下文起不来（`dsh web authentication required`，token 握手未完成）⇒ 未取得。**替代证据**：同一 URL 的 HTTP 对照（空缓存客户端拿到新字节）+ 臂 A 的 `transferSize=0`。要在 UI 上补齐，需另起一个**不同端口**的实例（新 origin ⇒ 无缓存）——未做 |
| **U2** | 真仓库上的**红例** | 门禁的红只在**副本**里造（不得为造红去改 `client/**`）；真仓库当前是 PASS（已被 bump 过） |
| **U3** | `--update` 基线文件**入库**与否 | 基线文件默认在 `tools/.client-rev-baseline.json`；是否纳入版本管理/CI 由 lead 定（我未擅自提交） |
| **U4** | CI 接线 | 门禁脚本**未**接进任何流水线（本仓无 CI 配置）；"每个 PR 必跑"需要 lead 决定挂在哪 |
| **U5** | `mtime` 模式在**全新 clone** 下的误报率 | 只做了推理与容差参数，未实测（需要一次干净 clone） |
| **U6** | 桌面壳（Electron）内的缓存行为 | 本次只在 `dsh web`（浏览器）上验；桌面壳的 webview 缓存策略未测 |
| **U7** | 平台在 chunk 尾部追加 trailer 的**完整语义** | 只观察到实测尾部（`sourceMappingURL …?rev=`），未读全量实现 |

**未复核：7 条。**

---

## 8. 收尾补记（追加）

### 8.1 `tools/` 是**共享目录**：我只加了两个文件，未动别人的
`tools/` 里已有 task-29 的交付维护件（`precommit-check.ps1` / `sync-freeze-table.ps1` / `handoff-append.ps1` / `INDEX.md` / `hygiene-rules.md` / `NOTES-readme-markers.md` / `snapshots/` / `out/`）。
- **新增（我）**：`check-client-rev.mjs`、`asar-read.mjs`。
- **未改**：`precommit-check.ps1` 的 mtime 仍为 **10-13 09:34:20**（实测），早于我 14:33 的首次写入。
- **为什么不直接接进 precommit-check.ps1**：它是 task-29 自成一体的交付物（"6 类 12 项"是它的验收面），且**没有**通用的"注册一个检查文件"扩展点（检查项是内联的）⇒ 改它等于改别人的验收口径。
- **建议接线（留给 lead / task-29 owner，一行级）**：在 `precommit-check.ps1` 里加第 07 项：
  ```powershell
  # ------------------------------------------------- 07 client chunk rev 门禁（task-37）
  $revOut = & node "$PSScriptRoot\check-client-rev.mjs" 2>&1; $revCode = $LASTEXITCODE
  Add-Result '07' 'client chunk rev 门禁' $(if ($revCode -eq 0) { 'PASS' } elseif ($revCode -eq 1) { 'FAIL' } else { 'WARN' }) ($revOut -join "`n")
  ```
  （`1` ⇒ FAIL，`3` ⇒ 判定不可得 ⇒ 记 WARN 而非 PASS，避免"无 git 无基线"被当成通过。）

### 8.2 文档追加的机械验证（只增不改）
- 追加前 **438 行 / 33,091 B** → 追加后 **502 行 / 38,837 B**。
- 前 438 行与新文件逐行**逐字相同**（脚本比对 = True）。
- `git diff --numstat -- docs/client-contract.md` = **`64	0`** ⇒ **64 行新增、0 行删除**。

### 8.3 窗口归属（`out-17-windows.txt`，判定用 pid + 启动时间）
- 我本次两个宿主（wrapper pid 1912 / 41408）**均已不在**；未见任何属于我的可见窗口（实例以 `-WindowStyle Hidden` 启动）。
- 用户的 DSH 现场：`19387` → pid **47564**（监听者）与可见窗口 pid **47604**（`DeepSeek Harness`，start `10-10 12:25:54`）—— 两者**全程未触碰**。
- 枚举到的其它可见窗口（Chrome/Edge/Cursor/Code/微信/QQ/Geph 等）均与本任务无关。

### 8.4 §7 U4 更新
CI 接线的具体落点已给出（8.1）；**仍未接线**（未改他人脚本）。若 lead 要求我直接接，我可在一轮内加该 07 项并跑一次正/负。

---

## 9. 两项授权内的小活（T37 追加）

### 9.1 ② 门禁已进提交前清单：`precommit-check.ps1` 新增第 **07** 项

- 位置：summary 之前（脚本 276 → **310 行**；`pwsh` AST 解析 **0 错误**）。
- 退出码映射（按 lead 要求）：`0`→**PASS**；`1`→**FAIL**（并附"必须怎么做"）；**`3`→WARN（判定不可得，绝不当 PASS）**；其它→FAIL（脚本自身错）。
- 两个**测试旁路**（让我能在**副本**上演示红，而不必改 `client/**`）：`$env:DSRW_CHUNKREV_ROOT`（默认 `$PluginRepo`）、`$env:DSRW_CHUNKREV_ARGS`（追加参数，用于演示 exit 3）。
- `node` 解析：先 `Get-Command node`，退化到 mise shim；都找不到 ⇒ WARN（不假绿）。

**正/负/不可判定 三次原始输出**（`arch-chunkrev/out-19/20/21-*.txt`）：

| 用例 | 命令 | 第 07 项原始行 | 总退出 |
|---|---|---|---|
| **正**（真仓库） | `pwsh -File precommit-check.ps1 -SkipNetwork` | `[PASS] client chunk rev 门禁 07  client-rev 门禁：PASS（模式=git）` | 1（**因 01 git 脏(128 条) + 02 冻结表陈旧**，与 07 无关） |
| **负**（副本：只改 `client.panel.js`、不动入口；`DSRW_CHUNKREV_ROOT=<副本>`） | 同上 + 环境变量 | `[FAIL] client chunk rev 门禁 07  client-rev 门禁：FAIL（模式=mtime）` + 原始依据行 `依据：存在 chunk 的 mtime 晚于入口（client.panel.js @ …07:11:39Z > 入口 @ …06:32:37Z）` | 1 |
| **不可判定**（`DSRW_CHUNKREV_ARGS='--mode baseline --baseline <不存在的文件>'`） | 同上 | `[WARN] client chunk rev 门禁 07  判定不可得（无 git 且无基线）⇒ 需人判：baseline 模式需要基线文件：…` | 1（FAIL 计数 3→**2**，证明 `3` 落成 WARN 而非 PASS/FAIL） |

### 9.2 ③ README 加一行（指向 §11）

- 位置：坑清单节（"用 CLI / 脚本驱动守护时的两个实测坑"）末尾、`### 新增/即将新增的配置键` 之前；形式为 **blockquote 单行**（该文件既有 `> **…**` 用法），**不改动编号列表结构**。
- 行内容（git diff 原文）：`+> **构建卫生（2026-10-13 新增，机制与复算命令见 [docs/client-contract.md §11](docs/client-contract.md)）**：**只改 chunk（…）而不改入口 client/index.js ⇒ 平台不会重扫**（重扫闸门看的是入口元数据），于是**连空缓存的新客户端也拿到旧脚本**，浏览器在 immutable 下更是零请求吃本地副本 ⇒ **改任何 chunk 都必须同时动一下入口**；该门禁已进提交前清单（precommit-check.ps1 第 07 项），杜绝把陈旧构建发出去。`
- **改动量**：`git diff -U0 -- README.md` 里属于我的 hunk = `@@ -480,0 +482,2 @@` ⇒ **1 行正文 + 1 行空行分隔**（其余 hunk 是别人未提交的改动）。
- **不构成 item 02 变红的证据**：我的行在 **482**，冻结表从 **680** 行起；`sync-freeze-table -Mode Check` 报的是**内容**不一致（例：README=50702 / REVISION=53881 的 size mismatch，即 README 表比 `REVISION.txt` 旧），与插入的一行散文无关。

### 9.3 关于 ⑤/⑥ 与其它

- **`dsh-rwsl-8932.service` 未动**（按 lead 指示留给 `p0-verify` 自己收尾）；本轮结束时 precommit 的 `05d` 已报 **`无 dsh-rwsl* user unit`** ⇒ 该遗留已被其 owner 清掉。
- **平台快照 + trailer** 那段我已按 lead 要求传给 T33 验证者（不再改动）。
- ⚠️ **`tools/` 是未跟踪目录**（`git status` 显示 `?? spike/verify/explorer-20261012/tools/`）⇒ `precommit-check.ps1` 的改动**没有 git diff 可看**，本节的证据是"行数 276→310 + AST 0 错误 + 三次真实运行的第 07 项原始行"。
