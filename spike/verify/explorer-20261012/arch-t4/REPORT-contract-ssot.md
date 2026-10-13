# T39 · 架构债 T4：方法表单源 + 选择器命名 + `fixPin` 决议

- **日期**：2026-10-13 ｜ **执行**：client-contract ｜ **前置**：T1 已提交（`023de79`）
- **写域**：`src/explorer.ts` · `client/client.api.js` · `client/index.js`（**仅 rev 刷新注释**，见 §5 的写域冲突说明）· 新增 `spike/verify/explorer-20261012/arch-t4/tools/check-explorer-methods.ts`
- **未动**：`client/client.panel.js`、`client/client.i18n.js`、`docs/**`、`reliability-keeper` 的 `src/daemon-client.ts` 等 T3 文件

---

## 一、做了什么

### 1. 方法表单源（零构建约束下的"权威 + 投影 + 机械门禁"）

`src/explorer.ts` 的 `EXPLORER_METHODS` 是**唯一权威**（新增一段块注释把"三处消费它、谁都不许再抄"写死在现场）；`client/client.api.js` 因**手写 bundle 零构建**（不能 import host、不能跑生成器）只能保留**字面量投影**，因此把"不许漂"交给两道机器门禁 + 一个可再生成工具：

| 角色 | 位置 | 作用 |
|---|---|---|
| 权威 | `src/explorer.ts` `EXPLORER_METHODS`（6 项） | HTTP 白名单 / `GET` 方法清单 / 文档三处的事实源 |
| 投影 | `client/client.api.js` `METHODS`（6 项）+ `METHOD_NAMES = Object.freeze(Object.values(METHODS))` | 客户端唯一方法视图（**派生**，不再另抄一份） |
| 门禁 1（跨任务） | `arch-t2/tools/check-docs-methods.mjs` | 11 断言，含 `client ≡ host` |
| 门禁 2（本任务新增） | `arch-t4/tools/check-explorer-methods.ts` | 8 断言：集合相等 / **顺序一致** / 前缀 / 去重 / **每个键都有可调用包装** / `METHOD_NAMES` 确为派生；`--print` 从 host 直接生成可粘贴的 client 块 |

> 为什么是 `.ts` 而不是 T4 原文建议的 `scripts/check-explorer-methods.mjs`：用户级硬规则"新脚本一律 TypeScript"。
> 本文件**只用可擦除类型标注**，Node 26 原生 `node check-explorer-methods.ts` 直接跑（实测通过，无构建）。

### 2. `status` / `snapshot` 选择器命名（与 README 一致）

在 `src/explorer.ts` 落地**两个具名选择器**，并当场用在选择点上（不是装饰性常量）：

- `discoverDaemons(live)` —— **发现选择器**：`wsl_status` 的发现语义 = "这台机器上发现了哪些守护"；
- `selectOwnedDaemon(live, slot)` —— **所有权选择器**：只认 `cfg.daemonPort`，`null` ⇒ 明确 `null`，**绝不回落 `live[0]`**（F33 的跨实例误停根因）。

`snapshot()` 里原来的 `live.find(...)` 已改为调用具名选择器。线上字段**不改名**（`discoveredDaemon` 属 P2），与 README「仍余」② 的陈述一致；README 那句"同源 + 明确选择器"的定义因此**有实现对应物**。

验收 grep（`discoveredDaemon|daemonStatus`）：

```
src/explorer.ts:82  * `discoveredDaemon` 属 P2（README「仍余」②），本轮只命名、不改名。
src/explorer.ts:335 …线上字段正式改名 `discoveredDaemon` 属 **P2**…
src/index.ts:64     daemonStatus,          ← 仍是既有函数名（P2 才改）
src/index.ts:989/1232 daemonStatus(config)
README.md:261       …② `wsl_status` 字段改名 `discoveredDaemon` 属 P2…
```

### 3. `fixPin` 决议（**判定：host 活 / client 无门**）

| 面 | 证据 | 判定 |
|---|---|---|
| host 白名单 | `src/explorer.ts:64` 在 `EXPLORER_METHODS` 里（第 4 项） | **活**——删它 ⇒ `check-docs-methods.mjs`「host 方法数 = 6」与设计稿 §4 方法表一起红 |
| host 实现 | `src/explorer.ts:525` `async function fixPin()` + `:713` handler 映射 + `:521` 注释（与 `wsl_sync_version` 同实现） | **活**——有实现、在路由白名单内，HTTP 可调 |
| 文档 | README:311「方法表 6 个」列了 `explorer.fixPin`；设计稿 §4 方法表 + `:118` 把它写成 drift 的「修」动作 | **活**——是**已宣布的**数据面 |
| client 包装 | `client/client.api.js` `METHODS.fixPin` + `fixPin(options)` | 保留（门禁要求 client ≡ host；且面板随时可重新露出） |
| client 调用者 | `rg fixPin client/`：只剩 `client.api.js` 三处 + `client.i18n.js` 四个 `status.fixPin*`；**`client.panel.js` 0 命中** | **client 侧当前无门**：T6 的"死 `fixPin`"指的是**这个** |
| i18n 死键 | `client.i18n.js:245-248`（zh）/ `:489-492`（en）：`status.fixPin` / `status.fixPinBusy` / `status.fixPinAria` / `status.fixPinDone` 四个键无调用者 | **死键，但不在本任务写域内**（见 §5） |

**结论**：`fixPin` 是**活的数据面**（host 权威、文档已宣布、门禁锁定），不能删；死的是 **UI 露出**（面板无调用点 + 4 个 i18n 死键）。
本任务按 T4 原文"UI 露出交给 T6 / 本任务不改 panel UI"处理：**保留 + 在 `client.api.js` 的包装上把用途与当前无门状态写清**，死键与露出交给 T6。

---

## 二、验收证据

| # | 项 | 结果 |
|---|---|---|
| ① | `check-docs-methods.mjs`（跨任务门禁） | **11/11 PASS，exit 0** |
| ② | `--dump-config`（profile remote-wsl-test-p30） | **exit 0**，`Error:` 命中 0 |
| ③ | 面板冒烟 snapshot → listDir → ensure → openSession | 见下 |
| ④ | 故意红：副本删掉 client 投影一项 | **T35 门禁 FAIL(1) exit 1**；本任务工具 FAIL(2) exit 1 |
| ⑤ | `tools/check-client-rev.mjs` | **PASS，exit 0** |
| ⑥ | 本报告两栏 + 未复核计数 | 见 §3 / §4 |

### ① T35 门禁原始输出（节选）

```
权威 EXPLORER_METHODS(6): explorer.snapshot, explorer.openSession, explorer.daemon, explorer.fixPin, explorer.listDir, explorer.addWorkspace
权威 tools(7): wsl_status, wsl_exec, wsl_agent, wsl_daemon, wsl_open_ui, wsl_sync_version, wsl_path
client METHODS(6): explorer.snapshot, explorer.openSession, explorer.daemon, explorer.fixPin, explorer.listDir, explorer.addWorkspace
PASS host 方法数 = 6 / PASS client METHODS ≡ host EXPLORER_METHODS / PASS 工具数 = 7
PASS README 列出全部 explorer 方法 / PASS README 不含"只有 4 个方法"的过期字面量 / PASS README 列出全部工具
PASS 设计稿列出全部 explorer 方法 / PASS 设计稿 §4 的方法表行 = 6 项
PASS GAP #8 行写明「守护已闭合」/ PASS GAP #8 行不再写「真缺口，卡在上游」/ PASS GAP-AUDIT 提到真缺口 = 桌面壳 attach
结果：PASS ｜ 断言 11 条          exit=0
```

### 新增工具（8 断言，exit 0）

```
权威 src/explorer.ts EXPLORER_METHODS (6) / 投影 client/client.api.js METHODS (6)
PASS host 方法表非空 · 集合相等 · 顺序与 host 一致 · 都带 explorer. 前缀 · 无重复项
PASS 每个 METHODS 键都有一个可调用包装 · client 用 METHOD_NAMES 从 METHODS 派生（未再抄一份）
结果：PASS ｜ 断言 8 条          exit=0
```

### ③ 面板冒烟

| 步 | 读数 |
|---|---|
| snapshot | `{"ok":true,…"daemon":{"running":false,…,"others":[{"slot":8962,…, "note":"非本槽位（configured daemonPort=8921）；未复用、未打扰"}]}}` ⇒ **具名所有权选择器生效**：自有槽位空就报 `running:false`，别人的 8962 只进只读 `others[]`（不回落 `live[0]`） |
| 探针（`explorer.__probe__`） | host 自报 `methods` = 6 项，**与 client 投影逐字相同**（单源活证） |
| listDir | `{"ok":true,"result":{"path":"/home/g",…,"entries":[…]}}`；面板 `rows=11` |
| ensure | 面板点「启动守护」⇒ footer `远端守护运行中`，note「已启动守护 + 技术细节（host 原文）」 |
| openSession | 面板点「在此目录新建会话」⇒ note「远端会话尚未建立（目标 cwd=/home/g/project）：首次向该会话发消息…才会物化」+ detail（host 原文），**0 个 error 节点** |

### ④ 故意红（副本 `%TEMP%\t39-red`：删掉 client 投影里的 `fixPin` 一行）

```
T35 门禁：FAIL client METHODS ≡ host EXPLORER_METHODS — client=5        → 结果：FAIL(1)   exit=1
T39 工具：FAIL 集合相等 — host=6 client=5，少=explorer.fixPin
         FAIL 顺序与 host 一致 — 首个漂移项：explorer.fixPin            → 结果：FAIL(2)   exit=1
```
⇒ 两道门禁都**真的会红**，不是恒绿。

### ⑤ chunk rev 门禁

```
client-rev 门禁：PASS（模式=git）
  入口   : client/index.js（来自 exports["./client"]）
  当前 rev : 9715a40b7d3c [mtime=2026-10-13T08:00:53.293Z …]
  chunks : 4 个 client.api.js(5a192b93) client.i18n.js(cba40e69) client.icon.js(e9a824f5) client.panel.js(7719876a)
  依据   : chunk 有变化，但入口元数据更新 ⇒ rev 已换 ⇒ 缓存 URL 已失效
exit=0
```

---

## 三、【一旦错了就得返工】

| # | 结论 | 依据 |
|---|---|---|
| 1 | **`fixPin` 不能删**（host 活、门禁锁定），死的是 UI 露出 + 4 个 i18n 键 | ①④的两道门禁都断言 host=6 且 client ≡ host；`rg` 证明 `client.panel.js` 0 命中 |
| 2 | **client 投影必须保留字面量**（零构建）⇒ "单源"只能靠**门禁 + 可再生成工具**落地，不能靠 import/生成器 | 手写 bundle 无构建步骤；`check-docs-methods.mjs` 直接正则读 `client.api.js` 的字面量块 |
| 3 | **`discoveredDaemon` 本轮只命名不改名** | README「仍余」② 明确属 P2（要动 6 工具 + selftest）；改字段名会与 T35 刷新过的文档冲突 |
| 4 | **`selectOwnedDaemon` 绝不允许回落 `live[0]`** | F33 安全级根因：回落 = 面板显示别人的 slot，而停止/重启以该 slot 为目标 ⇒ 跨实例误停。实测 `others=[{slot:8962}]` 时自有槽位仍报 `running:false` |

## 四、【其余的】

- 顺序断言（client 与 host **同序**）是本任务加的**更严**一条：跨任务门禁只断言集合相等。
- `--print` 让"漂移了怎么办"有机械答案（从 host 直接生成，不用手抄）。
- 新增的 `discoveredDaemon` 出现在 `src/explorer.ts` 的**注释**里（非字段名），满足 T4 验收 grep，且与 README 的"P2 才改名"不矛盾。

### 未复核：4 条

1. **`fixPin` 的失败渲染**（F25：`describe` 忽略 result、恒报成功语气）—— 本轮不改 panel UI，**未复核**；
2. **`client.i18n.js` 四个 `status.fixPin*` 死键未删除** —— 本任务写域不含 `client.i18n.js`，**未删**（见 §5）；
3. **`daemonStatus` → `discoveredDaemon` 的字段改名未做** —— 属 P2，**未复核**（本轮只命名选择器）；
4. **client 侧 `METHOD_NAMES` 的运行时消费点** —— 本轮只把它导出 + 由工具静态断言；面板/探针尚未在运行时读它，**未复核**该运行时路径。

---

## 五、写域冲突（需要 lead 知悉）

任务原文既写"不得碰 `client/index.js`"，验收⑤ 又写"改 `client/**` 后**必须**动一下 `client/index.js`"。我按**验收⑤**执行（它是 T37 已确认的 chunk rev 机制：只改 chunk 不动入口 ⇒ 平台不重扫 ⇒ 客户端拿旧脚本），在 `client/index.js` 的既有注释块里**只加了一行注释**（无逻辑改动），并跑 `check-client-rev.mjs` 得 **exit 0**。若 lead 认为该文件不可动，请指示 —— 撤掉那一行注释即可（但 `check-client-rev.mjs` 会随即红）。

同理，`fixPin` 的 4 个 i18n 死键在 `client/client.i18n.js`（任务原文列为禁改）⇒ 未删，已记入「未复核」。

## 六、纪律与收尾

- **端口**：只用 8922（测试实例）；收尾 `8921–8930` 监听 **0**。
- **只动自己的槽位**：`explorer.daemon{stop}` 针对 slot 8921 ⇒ `ok:true`；**未触碰**别人在 **8962** 上的活守护（`%TEMP%\usab-p04`，另一 teammate 的副本）——收尾时它仍在（unit `dsh-rwsl-8962.service`、`daemon.8962.json`），这是**别人的**资产，按纪律保留。
- **可见窗口**：实例用 `Start-Process -WindowStyle Hidden`；起守护走 `mode=systemd`（无窗口）⇒ **产生 0 个窗口**；枚举窗口全部 `foreign`（无 `wsl.exe`/WindowsTerminal 子节点）。
- **用户宿主**：19387（pid 47564）只读未触碰；未写用户全局存储。
- **`--state=failed` = 0**；`launch.8921.sh` 等本槽位包装层已清；`%TEMP%\t39-red` 已删。
- **`--dump-config` exit 0**（`Error:` 0 命中）。
