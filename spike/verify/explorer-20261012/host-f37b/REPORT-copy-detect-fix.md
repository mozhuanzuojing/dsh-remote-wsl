# T61 · 修 `probe-copy-detect` 的 `src/` 拷贝清单（T3 拆分后过期）

- **日期**：2026-10-14 ｜ **执行**：client-contract
- **写域**：`spike/verify/explorer-20261012/host-f37b/`（**只改了 `probe-copy-detect.ts` 一个文件**）
- **未碰**：`client/**`、`src/**`、`package.json`（证据见 §6）
- **纪律**：未装包；未弹窗；宿主 19387（pid **33688**）只读未触碰；收尾见 §6

---

## 一、定因：为什么它会"悄悄失效"

探针的两处**硬编码**在 T3 拆分后**同时**过期 —— 这正是 T45 那轮"硬编码权威路径"的**同型问题**：
它不是"路径搬家"这一类，而是"**把会变的内部结构写死在脚本里**"。

### 1.1 拷贝清单过期 ⇒ 副本内模块缺失

原写法只拷两个文件：

```ts
cpSync(join(SRC, 'daemon-client.ts'), join(DIR, 'daemon-client.ts'));
cpSync(join(SRC, 'daemon.ts'),        join(DIR, 'daemon.ts'));
```

T3 把原 1068 行的 `daemon-client.ts` 拆成"薄 re-export + 三个实现模块"，`daemon-client.ts` 现在
`export {…} from './daemon-protocol.ts' / './daemon-launch.ts' / './daemon-lifecycle.ts'`。
副本里**没有**这三个文件 ⇒ `ERR_MODULE_NOT_FOUND`。

**T3 拆分后的差异清单（真 `src/*.ts` = 14 个，旧清单只见 2 个 ⇒ 漏 12 个）**：

| 漏拷文件 | 说明 |
|---|---|
| `daemon-protocol.ts` | T3 新拆（路径/元数据/扫描/脚本执行/TCP 与握手）—— **就是报错里那个** |
| `daemon-launch.ts` | T3 新拆（启动脚本、systemd 主路径 + compat 回退、launcher 回收） |
| `daemon-lifecycle.ts` | T3 新拆（ensure/stop/snapshot/status） |
| `explorer.ts` · `index.ts` · `register-tools.ts` · `selftest.ts` · `in-host-runtime.ts` · `sdk-runtime.ts` · `shell-env.ts` · `version.ts` · `wsl-io.ts` | 本来就不在清单里（因为"只拷 daemon 链"的假设，在被拷文件的 import 图扩张后不成立） |

### 1.2 补丁目标过期 ⇒ 探针**静默退化成"测正常路径"**（比 1.1 更隐蔽）

原写法把补丁打在**文件名**上：`const f = join(DIR, 'daemon-client.ts')`，然后替换三个 `systemd-run` 锚点。
T3 之后 `systemd-run` 三处锚点已经在 **`daemon-launch.ts`**（`daemon-launch.ts:66/69/74`）里，而
`daemon-client.ts` 只剩注释 ⇒ 三个 `split().join()` 全是**空操作**。

**实测证据（改前原样跑）**：改前探针自己打印

```
[copy] C:\Users\l\AppData\Local\Temp\t17-sysd-copy patched（systemd-run 出现 0 处，已替换脚本内 3 处）
```

—— "出现 **0** 处"却仍宣称"已替换 3 处"，随后才因 1.1 报 `ERR_MODULE_NOT_FOUND` **而侥幸没静默通过**。
**若 1.1 单独修好，探针就会"绿灯"地跑正常路径**（`mode=systemd`），而它本该验的是**回退分支** ⇒
**假绿风险**。所以 1.2 必须一并修，且**要能响**。

> 自我更正：我最初用 `Select-String -SimpleMatch` 叠加 `[regex]::Escape()`（双重转义）扫锚点，
> 得到"三处锚点在全库已消失"的**错误结论**；改成正确写法后确认锚点**仍在**，只是搬到了
> `daemon-launch.ts`。记在这里，避免下一个人复踩这个量具坑。

## 二、根因修法（消掉"会变的结构被写死"）

| # | 修法 | 效果 |
|---|---|---|
| ① | **按目录枚举**：`readdirSync(SRC).filter(n => n.endsWith('.ts'))` 全量拷贝（并**位置无关**：`SRC` 从 `import.meta.url` 上溯 4 层推导，不再写死 `D:/project/...`） | 以后再拆/再加文件**自动跟随** |
| ② | **按内容定位补丁**：扫**所有**已拷入文件找锚点，命中的文件才改 | 锚点再搬家也能自动找到 |
| ③ | **命中数为 0 ⇒ `exit 2` 并说明**："补丁一处都没打上 ⇒ 本探针会退化成测正常路径，结果无意义" | **不许再静默降级**（这是 1.2 的根治） |
| ④ | `RESULT` 行追加 `mode` 字段 | 结论里直接可见"走的是 compat 还是 systemd"，便于人工核对探针语义 |

## 三、真跑（前台，不重定向；端口 8912 属本任务段 8911–8920）

```
[copy] C:\Users\l\AppData\Local\Temp\t17-sysd-copy：整目录拷贝 src/*.ts 14 个（daemon-client.ts, daemon-launch.ts,
       daemon-lifecycle.ts, daemon-protocol.ts, daemon.ts, explorer.ts, in-host-runtime.ts, index.ts,
       register-tools.ts, sdk-runtime.ts, selftest.ts, shell-env.ts, version.ts, wsl-io.ts）
[copy] systemd-run 锚点命中 3 处，已 patch：daemon-launch.ts(3)
# ⚠️ 未能由 systemd 托管守护（找不到 systemd-run-DOES-NOT-EXIST（发行版可能未启用 systemd））⇒ 已回退到**兼容启动**…
RESULT {"ok":true,"pid":145974,"port":8912,"mode":"compat-detached","notes":[…告警…,"槽位 8912 由 Windows 侧握手确认就绪（实际端口 8912，3ms）"]}
AFTER {"handshakeOk":true,"pid":145974}
[copy] 已删除临时副本
→ exit=0
```

**语义自证**：补丁命中 **3 处在 `daemon-launch.ts`** ⇒ 启动确实走了"systemd 失败"分支 ⇒
`mode:"compat-detached"` + 告警进 `notes` + 握手成功 ⇒ **探针现在测的正是它声称要测的回退识别**。

## 四、故意红（副本制）+ 绿

| 轮 | 做法 | 结果 |
|---|---|---|
| **红 A** | 从 `git show HEAD:…` 取**改前原文**，原样跑（真 `src/`） | `patched（systemd-run 出现 0 处…）` → `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…\t17-sysd-copy\daemon-protocol.ts' imported from '…\daemon-client.ts'` ⇒ **exit=1** ✅ |
| **红 B** | 在 `%TEMP%\t61-red\skel\` 造"**未来再拆分**"骨架：`src/` 全量 + 新增 `zz-future-module.ts`，并让 `daemon-client.ts` `export … from './zz-future-module.ts'`；跑**旧逻辑 1:1 复刻**（只拷 2 个文件再 import） | `[old-logic] 只拷了 2 个文件（= 改前写法）` → `ERR_MODULE_NOT_FOUND: …\t61-oldlogic-copy\daemon-protocol.ts` ⇒ **exit=1** ✅ |
| **绿** | **改后探针** + 同一骨架 | 拷贝 **15 个**（清单里**含 `zz-future-module.ts`**）· 锚点命中 3 处 → `daemon-launch.ts(3)` · `mode:"compat-detached"` · `handshakeOk:true` · 自删副本 ⇒ **exit=0** ✅ |

⇒ 红 B + 绿 一起证明：**同样的"未来新文件"场景，旧写法必红、新写法通过**，且这是**枚举**带来的，不是运气。

**字节还原**：红/绿全部在 `%TEMP%` 副本内进行 ⇒ 真 `src/` **一行未改**（§6）。

## 五、precommit 复跑（07 项已指向 `check-client-rev.ts`）

```
[PASS] launch.*.sh 包装层      05c  ~/.dsh/remote-wsl/ 下无 launch.*.sh
[PASS] client chunk rev 门禁   07   client-rev 门禁：PASS（模式=git）
[PASS] 漏 import 扫描          08   14 文件 / 命中合计 = 0
PASS=10  WARN=3  FAIL=1     （唯一 FAIL = 第 01 项「git status 干净」：15 条未提交改动，属提交前正常态）
```

首次复跑时 05c 报过 `1 个残留: launch.8913.sh` —— 那是**红 A**（改前探针，端口 8913）在失败前写下的包装层；
已删除并复跑为 **PASS**（`~/.dsh/remote-wsl/` 现在只剩 `daemon.log` / `launch-stderr.log`）。

---

## 【一旦错了就得返工】

1. **"修好 1.1 就收工"会制造假绿**：补丁目标过期(1.2)时，探针会以"正常路径"跑出 `mode=systemd` 并**成功退出** ⇒ 结论看着绿，实际没测回退。所以本次两处一起修，并加了**命中数为 0 即 exit 2** 的响铃。
2. **判据必须落在"内容"而不是"文件名/文件清单"**：这两处过期都属于"把会变的结构写死"（同 T45 的硬编码权威路径）。新写法把"权威"交给**目录**（有哪些文件）与**内容**（谁含锚点）。
3. **量具坑**：`Select-String -SimpleMatch` 与 `[regex]::Escape()` **不要叠加**（会让 `-` 变成字面 `\-` 而漏配）。我因此误判过一次"锚点消失"。

## 【其余的】

- `RESULT` 新增 `mode` 字段（不改任何断言，只让语义可核对）。
- 原始脚本里 `import { spawnSync }` 是**未使用**的 import，本次顺手删掉（不影响行为）。
- 该探针会把副本目录放在 `%TEMP%\t17-sysd-copy`，**跑完自删**（本次实测 `[copy] 已删除临时副本`，且收尾复查 `Test-Path = False`）。

## 未复核：2 条

1. **`ERR_MODULE_NOT_FOUND` 之外的失败面未构造**：例如 `src/` 为空目录、`SRC` 路径不存在时，
   新写法会在 `readdirSync` 抛裸错误（未做可读化）。本轮只按任务要求修"清单过期"，**未加这层防御**。
2. **compat 回退是否弹窗**：本次实跑 `mode=compat-detached`（该路径文档写明"**可能**弹可见控制台窗口"）。
   收尾枚举 11 个可见窗口，命令行全部不含 `wsl.exe`/WindowsTerminal ⇒ **本次 ∆可见窗口 = 0**；
   但"compat 一定不弹"未被证明，且**不在本任务范围**（F-37 已由 T17 用 `systemd` 主路径解决）。

## 六、写域与收尾证据

- **我的改动面**：`git status --porcelain -- spike/verify/explorer-20261012/host-f37b` ⇒ 仅
  `M spike/verify/explorer-20261012/host-f37b/probe-copy-detect.ts`。
- **`src/` 未被我动**：所有红/绿测都在 `%TEMP%` 副本内（真 `src/` 无 `zz-future-module.ts`）。
  ⚠️ `git diff --stat -- src/` 现在**显示 `src/sdk-runtime.ts` 有改动** —— 那是 **T60 owner** 在写的（"T60 只碰 `src/`"），
  **与本任务无关**，我一次都没写过 `src/`。
- **收尾**：`%TEMP%\t61-red` / `t17-sysd-copy` / `t61-oldlogic-copy` **全删**；`~/.dsh/remote-wsl/` 只剩两个 log；
  `launch.*.sh` 残留 **0**（含删掉红 A 留下的 `launch.8913.sh`）；`dsh-rwsl*` unit **0**；`--state=failed` 已 `reset-failed` 归 **0**；
  `daemon.ts` 进程 **0**；端口 8912/8913 **无监听**。
- **窗口**：枚举 11 个，全为他人/系统进程（chrome×2 / Code / Cursor / 用户宿主 33176 / explorer×2 / msedge / QQ / TextInputHost / Weixin），
  无 `wsl.exe`、无 WindowsTerminal ⇒ **本任务产生 0 个 dsh 窗口**（凭 pid/父 pid/启动时间/命令行判，未凭标题猜）。
