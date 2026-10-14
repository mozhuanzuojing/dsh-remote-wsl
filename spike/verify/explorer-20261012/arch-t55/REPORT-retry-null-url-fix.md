# REPORT —— T60：修 `WebHost.start()` 失败后重试的「静默假成功」（`OK + null`）

> **追加**，不覆盖同目录的 `REPORT-openui-paths.md`（T55）与 `REPORT-host-split.md`（T5）。

## 结论

**根因修好了**：`WebHost.start()` 不再把 `this.child` 当"可用"判据，失败态与可用态分开，失败尝试的残留也当场清掉。
**真调证明**：失败一次后同端口再调 ⇒ **真的重新启动**（拿到真 URL）；若注定失败 ⇒ **再次给出可读错误**；**任何情况下都不再 `OK + null`**。
**顺带关掉 T55 的 P2**：失败路径现在**自清**（`/tmp` 增量 0，超时态孤儿也被 `reapWsl` 收掉），不再需要靠调用方 `{stop:true}` 兜。

**改动面（只 1 个文件）**：`src/register-tools.ts`（`class WebHost` 所在文件；全仓 `rg 'class WebHost'` = 1 处）。
新 SHA `5f15ac8d7a9587324671dd22f2b7c235199d171352dd00f8da1159439d188b21`。

## ① 修法（只打根因那一层）

```diff
   async start() {
-    if (this.child) return this.url;                     // ← 失败时 child 已置、url 仍空 ⇒ 0ms 返回 null
+    if (this.url) return this.url;                       // 只有"真起来了"才复用
+    if (this.child) await this.#discardFailedAttempt();  // 上次失败留下的半死状态 ⇒ 先收干净，再真起
     ...
+    let url;
+    try {
       url = await new Promise((resolve, reject) => { ... 原有 URL 等待 / 60s 超时 / 进程退出 ... });
+    } catch (e) {
+      await this.#discardFailedAttempt();                // 失败**不**留半死对象/残留
+      throw e;                                           // 错误原样上抛（保持可读）
+    }
+    if (!url) { await this.#discardFailedAttempt(); throw new Error('remote-wsl: web 启动未返回 URL（内部状态不一致）'); }
     this.url = url;
   }
+
+  /** 丢掉一次失败尝试留下的状态：半死包装层 / WSL 侧 dsh web / /tmp 一次性脚本。 */
+  async #discardFailedAttempt() {
+    const child = this.child; this.child = null; this.url = null;
+    try { child?.kill(); } catch { /* 已退出 */ }
+    await reapWsl(this.cfg, this.script);                // 包装层被杀 ≠ Linux 侧退出（T55 实测）
+    removeScript(this.cfg.distro, this.script);
+    this.script = null;
+  }
```
三处改动同属一个根因：**"这个 host 可不可用"原来由 `child` 存在与否代言**，而 `child` 在失败时也已经存在。

## ② 真调证据（全部孤立 `DSH_HOME`；端口 8915–8918）

| 场景 | 原始读数 | 判定 |
|---|---|---|
| **成功三态回归**（真仓库） | `start 2382ms → http://127.0.0.1:8915/?token=…`；`stop 287ms`；`start again 2417ms → 真 URL`；`stop 460ms` | ✅ 无静默假成功；新增 `WindowsTerminal` **0** |
| **失败一次后同端口重试**（副本：首次 `exit 7`） | ①`THREW 787ms web 进程退出（exit 7）`、`DELTA 0/0/0`；②`OK 2171ms → http://127.0.0.1:8916/?token=…`、`DELTA[stop 后] 0/0/0` | ✅ **真的重新启动**；`ASSERT 第二次绝不 OK+null = true` |
| **每次都失败**（副本：`exit 7`） | ①`THREW 277ms`、`DELTA 0/0/0`；②`THREW 187ms`（同样可读）、`ASSERT 第二次仍可读报错 = true` | ✅ 绝不假成功；**失败后无残留** |
| **故意红**（副本 = `HEAD` 的 `register-tools.ts`（无 `#discardFailedAttempt`）+ 每次失败） | ①`THREW 185ms`、`DELTA procs=0 listen=0 **tmp=2**`；②`**OK 0ms :: null**` | ✅ **P0 复现**：`ASSERT 第二次绝不 OK+null = false`（断言红） |

**字节还原/复绿** = 把副本换回真仓库（已修）后的同一构造：`out-06-green-faithful.txt` — ①`THREW 298ms` + `DELTA 0/0/0`、②`THREW 203ms`、`ASSERT 第二次仍可读报错 = true`。
> **两处夹具失误如实记**：① 第一次跑红时我只换了 HEAD 的代码、**没让首次启动失败** ⇒ 旧代码正常返回**缓存的真 URL**（`OK 0ms :: http://…`），红不起来 —— 这反而成了"成功态快路径未回归"的旁证；② 第一次"复绿"我把补丁忘了（跑的是真仓库、脚本没改）⇒ 首调成功、二调返回缓存真 URL，构造与红态不一致。**红/绿必须同构造、只差代码版本**，修正后才成对（`out-04-red2` vs `out-02-alwaysfail` / `out-06-green-faithful`）。

## ③ 顺带关闭 T55 的 P2（失败路径不自清）

T55 曾测到：失败后 `/tmp` 脚本 + `.pid` 必留、超时态 WSL 侧进程还活着，只有调用方 `{stop:true}` 才能归零。
现在 `#discardFailedAttempt()` 在**失败当场**做同样三件事（kill 包装层 / `reapWsl` / `removeScript`）⇒ 上表里 `DELTA[第一次失败后]` 在修复版下**都是 0/0/0**（红态仍是 `tmp=2`）。

## ④ 护栏 / 冻结 / 隔离 / 收尾

| 检查 | 结果 |
|---|---|
| `arch-t3/tools/export-matrix.ts` | **PASS**（31 符号） |
| `arch-t2/tools/check-docs-methods.ts` | **PASS ｜ 断言 13 条** |
| `--dump-config` | **exit 0 / `Error:` 0 / 与基线 diff 0 行** |
| **`revision.ps1 -Mode Check`** | **exit 1 —— 锚点已漂移（如实报，未动 `REVISION.txt`）** |
| 用户全局 `workspace.json` | before = after = `A764A306…`（**完全相同**） |
| 收尾 | `daemon.ts 0`、`dsh-rwsl units 0`（含 `reset-failed`）、`failed 0`、`is-system-running = running`、`dsh web 宿主 0`、`8911-8920 监听 0`、`/tmp dsh-rwsl 0`、**真实 state dir 他人守护 0（未碰）**、`t60-*` 副本 0、**无 WindowsTerminal** |

**冻结漂移原始输出**（P0.5.1 会因此失效，按你的要求只报不改）：
```
锚点一致 = False ｜ advisory 一致 = False
  - b00b68ee0d5d91baefddecd07b7334d4538cf67ead4d9fdf93eaeeca22895ea1      43546  src/register-tools.ts
  + 5f15ac8d7a9587324671dd22f2b7c235199d171352dd00f8da1159439d188b21      45356  src/register-tools.ts
结论：**验证无效**（被验对象在验证期间发生变化）
```

## 【一旦错了就得返工】

1. **"可用"的判据必须挂在 `url`，不能挂在 `child`**：只要还有人用"进程对象存在与否"代言可用性，这类静默假成功就会以别的形式回来（`child` 在失败、半死、已退出三种情况下都可能存在）。
2. **失败必须当场清**：不清就会出现"半死对象 + `/tmp` 残留 + WSL 侧孤儿"，而**下一次调用会看起来成功**——这比报错危险得多（UI 拿到 `url: null` 且无告警）。
3. **红/绿必须同构造、只差代码版本**：本轮我第一次红（只换代码、没造失败）与第一次绿（忘打补丁）都因为构造不同而**证不了任何事**。判据脚本要显式打印"本次构造"（哪个副本、哪个补丁命中几次）。
4. **冻结会因这一处改动失效**：`revision.ps1 -Mode Check` exit 1 是**预期**结果（`src/register-tools.ts` 43546 → 45356 B），需要你重新冻结；我**没有**改 `REVISION.txt`。

## 【其余的】

- 改动只 1 个文件 1 个类：`rg 'class WebHost' src/` = 1 处（`register-tools.ts`）；`git status --porcelain -- src/ client/ package.json` = ` M src/register-tools.ts` 一条。
- 所有真调用走孤立 `DSH_HOME`；变异全部在 `%TEMP%` 整目录副本上（`%TEMP%\t60-*`），收尾已删净。
- 现有 `stop()` 未改（`kill + reapWsl + removeScript + sweepOwnTempFiles` 原样）；成功态行为与耗时量级未变（2.4s 级）。

## 未复核：5 条

1. **`open:true` × 启动失败**的组合：失败在 `host.start()` 就抛 ⇒ 读码上 `openAppWindow` 不会被调用，但**未真调**验证"绝不因失败而开窗"。
2. **多次失败的状态机**：本轮每个构造只跑 2 次调用；连续 3+ 次失败/成功交替未测（`webHosts` 里同一对象的长期行为）。
3. **`stop()` 在 `#discardFailedAttempt` 清过状态之后再调**：`stop()` 首行 `if (!this.child) return;` 会早退，本轮只观察到 `stopped web host on port …`（工具分支里另有 `sweepOwnTempFiles`），未单独断言"此时确实无事可做"。
4. **真实 60s 超时**（不打补丁）下的失败清理：本轮超时构造都是用副本把 60000 改 1500 跑的；真实 60s 未等。
5. **其它可能的 `WebHost` 副本**：只按 `rg 'class WebHost'` = 1 处确认，未扫历史/生成文件。

## 证据文件（`spike/verify/explorer-20261012/arch-t55/`，追加）

`REPORT-retry-null-url-fix.md`（本文）、`out-01-success.txt`（成功三态）、`out-02-once.txt`（失败后真重启）、`out-02-alwaysfail.txt`（每次失败 · 修复版绿）、`out-03-red.txt`（**无效红，留作教训**）、`out-04-red2.txt`（**有效红：`OK 0ms :: null`**）、`out-05-green-after-red.txt`（无效复绿，留作教训）、`out-06-green-faithful.txt`（忠实复绿）、`out-07-matrix.txt`、`out-08-docs.txt`、`out-09-dumpconfig.txt`、`out-10-revision.txt`（冻结漂移）、`baseline-sha256.txt`、`sha-before.txt`；脚本 `probe-t60.ts`。
