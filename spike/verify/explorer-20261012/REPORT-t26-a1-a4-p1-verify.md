# REPORT-t26-a1-a4-p1-verify.md —— T26：A1 / A4 / P1 的一次性独立复验

- **验证者**：`p0-verify`（独立于 T23/T24/T25 实现者）｜**日期**：2026-10-13｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：GO 后冻结 → 收尾复算 **锚点一致 = True（14/14）⇒ 验证有效**；advisory 仅 README.md。
- **锚点集 = `src/**` 8 + `client/**` 5（含新 `client/client.i18n.js`）+ `package.json` = 14**。
- **lead 给的锚点 4/4 MATCH**：`daemon-client.ts` `CB420D25EF1B…`、`explorer.ts` `F6C77D5B…`、`index.ts` `E5BE29F5…`、`client.i18n.js` `37DBB86B…D9D0`；
  另 `client.panel.js` `2560811F…34F4`、`client.api.js` `C3600EE5…E16F`、`client/index.js` `AA033A37…623D`；
  `client.icon.js` / `daemon.ts` / `sdk-runtime.ts` / `selftest.ts` / `shell-env.ts` / `version.ts` **unchanged**。

## 结论（≤450 字）

**A1-host 六项 PASS、A1-client 四态 PASS、A4 PASS、T5 两条 PASS、回归全绿、故意红 3/3 成立。P1 只 PASS 一半（元数据保护成立，但"可读失败"没透传 —— 发现一个真缺陷）。**
**A1-host**：① 200 `{ok,id,title,uncPath}` 且孤立注册表可见；② 重复 ⇒ `alreadyExisted:true`、**同一 id**、条目仍 1；③ 不存在 ⇒ **404**；④ `foo`/空/`..`/`/mnt/c` ⇒ **400** 且注册表条目不变，`/mnt/c` 的文案**逐字解释了理由**并**显式引用 `listDir` 的取舍**；⑤ 副本屏蔽服务 ⇒ **503 + body 文案 + 那行降级日志**；⑥ 强证据零副作用（守护在跑时 facts compare **exit 0**）。**全程用孤立 `DSH_HOME`**（`%TEMP%\a1-home`）：用户全局 `~/.dsh/storages/workspace.json` **前后同 sha（048bebe7e239）/ 同条目数（1）**。
**A1-client**：动作可发现（有 aria+title）；成功渲染 `已登记为工作区：g（id=…）` + **折叠**的 `技术细节（host 原文）`；404/400/503 三种失败各有人话首句 + `重试`（`role=alert`）。
**A4**：**ZH=181 / EN=181 逐键一致**；运行时 EN 文案（`Remote Explorer`/`Open in new session`/`Hidden files: off`/`No target distro configured`）与 ZH 对照；`createTranslator` 在**官方 locale 抛错 / 为 null / 无服务**时**不崩且回退内置字典**，**缺键原样回键**；zh 的 `aria-label`/`title` 已本地化。
**P1**：① 正常 stop 元数据清、无进程；② **合法构造**（把真守护 `SIGSTOP`，仍被扫描认得）= 元数据**仍在**、进程**仍活**、**可发现** ⇒ 保护成立；但 **route 返回 `ok:true`、`notes=[]`、无 error** ⇒ **"返回可读失败"未达成**（`explorer.ts:499-511` 硬编码 `ok:true` 且丢弃 `r.error`）；③ 红：副本去掉复核 ⇒ 元数据 GONE + 进程 ALIVE（隐形孤儿）⇒ 断言有区分力；④ 槽位守卫 400 不破。
**T5**：① 结果条首句人话 + host 原文进**折叠** `<details>`；② 定格 loading 态后 `尚未取得快照` **出现 1 次**（改前 2）。
**回归**：`--dump-config` exit 0/1266 行/`Error:` 0；**6 方法白名单含 `addWorkspace`**；缺/伪造 Origin 403；非 JSON 415；无 token；槽位守卫 400；**窗口抽验 mode=`systemd` ⇒ Δ=0**。
**环境**：`is-system-running` = **running**、failed units **0**、无 `t15*` 单元、`/tmp/t15*` 0 ⇒ **degraded 未导致任何回退**（本轮每次 ensure 都读到 `mode=systemd`）。

## 1. A1-host（孤立 `DSH_HOME` = `%TEMP%\a1-home`，端口 8931 / slot 8932）

| # | 断言 | 实测 |
|---|---|---|
| ① | 正常登记 | `200 {"ok":true,"result":{"ok":true,"id":"cd8d8b4b-…","title":"dsh1","uncPath":"\\\\wsl.localhost\\debian-u8-1\\home\\g\\project\\dsh1","alreadyExisted":false}}`；孤立注册表出现该条 |
| ② | 重复调用 | `alreadyExisted:true`、**id 完全相同**、孤立注册表条目数 **1**（未产生第二个） |
| ③ | 不存在路径 | `404`（`/home/g/definitely-not-here-t26`） |
| ④ | 非法形态 | `foo` / `''` / `/home/../etc` / `/mnt/c` 全 **400 `E_ARG`**；非法调用前后注册表条目 **1/1** |
| ⑤ | 服务缺失降级 | 副本把 `workspaceRegistry` 闭包改 `() => undefined` ⇒ **503** + body `host 侧 workspaceRegistry 服务不可用 ⇒ …` + 日志原文 `remote-wsl(explorer): workspaceRegistry 服务不可用 ⇒ explorer.addWorkspace 降级（无法登记 DSH 工作区；方法表其余方法不受影响）` |
| ⑥ | 零副作用 | 守护在跑时 `daemon-invariance` compare **exit 0**（pid/端口/version/keys/pgrep/监听全 MATCH） |
- **`/mnt/c` 的"同一条政策"**（逐字读 400 文案）：`explorer.addWorkspace 不接受 /mnt/<盘符> 路径（收到 "/mnt/c"）：它本来就是 Windows 卷 C:\，与面板浏览（explorer.listDir）把它当 C:\ 读的取舍必须一致。请改用发行版内的 ext4 路径（例如 /home/…）…` ⇒ **文案解释了口径且显式引用 `listDir`** ⇒ 判 PASS（不是自相矛盾，而是同一政策的两个面）。
- **阴性对照**：`~/.dsh/storages/workspace.json` 验证前 sha `048bebe7e239` / 1 条；验证后**同 sha / 同 1 条**（收尾再查仍相同）。

## 2. A1-client / T5

- 动作：`添加为 WSL 工作区`，`aria-label="把 /home/g 登记为 WSL 工作区（路径是 UNC ⇒ 文件工具经 9P；与"远端会话"是两条路）"`（有 title）⇒ **可发现**。
- **成功态**：note `已登记为工作区：g（id=f4a61c45-…）` + `<details class="dsh-rw-note-details">技术细节（host 原文）` 且 **`open=false`（折叠）** ⇒ T5 ① 通过（`bodyHasHostNotes` 语义 = host 原文不在正文里）。
- **三种失败态**（fetch 桩，点真按钮触发）：`role=alert` + `重试`
  - 404 → `失败：该路径在 WSL 里不存在，未登记（host 说：…）`
  - 400 → `失败：路径不合法，未登记（host 说：…）`
  - 503 → `失败：宿主此刻不可用（发行版/权限/状态目录），未登记（host 说：…）`
- **T5 ②**：initScript 挂起 `explorer.snapshot` 定格 loading ⇒ `正在读取 explorer.snapshot（…超时 9000ms）…`，`尚未取得快照` 在**整棵面板**出现 **1 次**（body 0 + status 1）。
- **`openSession` 未受影响**：面板 `在新会话中打开` 行内动作仍在且可点（DOM 证据）；**其完整链路本轮未重跑 ⇒ 记未复核**。

## 3. A4（i18n）

- **字典**：`ZH` 181 键 / `EN` 181 键，**差集两侧都为空** ⇒ 逐键一致（文本解析，`client/client.i18n.js`）。
- **运行时**（loader-bundle 垫片驱动 `spec.factory`）：`createTranslator` 在官方 locale 服务 **抛错 / null / 空对象** 三种输入下**都不抛**，`t('panel.title')` = `远程资源管理器`；**官方 locale 报 `en`** 时 = `Remote Explorer`（`row.open`→`Open in new session`、`browser.hiddenOff`→`Hidden files: off`、`header.noTarget`→`No target distro configured`）。
- **缺键原样回键**：`t('no.such.key')` = `"no.such.key"`（EN/ZH 与三种坏服务下都一致）。
- **aria/title 本地化**：zh 采样（`重新读取 explorer.snapshot`、`家目录：跳转到 /home/g`、`显示 . 开头的隐藏条目（当前：隐藏）` 等）⇒ 已本地化。
- **未复核**：我在设置 UI 里**没找到语言开关**（`langControl=null`）⇒ **"通过 UI 切到 English"这条路径未复核**（我用 `htmlLang=zh-CN` + 模块级 EN 渲染替代，已在上面注明）；light/dark 本轮未重测（T14 已测）。

## 4. P1（`stopDaemon` 元数据复核）

| # | 手法 | 结果 | 判定 |
|---|---|---|---|
| ① | 正常 `stop`（真守护在跑） | 元数据清、无进程；响应形状 `{action,ok,idempotent,alreadyStopped,slot,port,pid,version,reaped,notes}` | **PASS**（"与改前逐字相同"**未复核**：本目录没有 T25 之前的正常 stop 响应体归档，只有形状/键对照） |
| ② | **合法构造**"守护忽略 shutdown"：真守护 + `kill -STOP`（不响应握手，但**仍被 `scanDaemonProcesses()` 认得** —— 探针显示 `orphans=1`） | 元数据 **PRESENT**、进程 **ALIVE**、pgrep 仍可见（可发现） | **元数据保护 PASS**；但 route 返回 **`ok:true` / `notes:[]` / 无 error** ⇒ **"返回可读失败"未达成 = RED** |
| ③ | 故意红：副本 `const survivors = [];`（= 去掉"移除前复核"） | 元数据 **GONE** + 进程 **ALIVE** ⇒ **隐形孤儿被造出来** ⇒ 断言**有区分力** | **RED 成立**，已字节还原（vendor 该调用仍在，副本已删） |
| ④ | `stop --all` / 槽位隔离 | 槽位守卫 `ensure slot=8962` ⇒ **400 `E_ARG`** 且无副作用；`stop --all` **本轮未单独跑** | 部分 PASS / `--all` **未复核** |

**发现的缺陷（本轮新增，建议进 P1 清单）**：`src/explorer.ts:499-511`
```ts
if (action === 'stop') {
  const r = await stopDaemon(eff, slot === undefined ? { log } : { log, slot });
  return { action, ok: true, idempotent: true, alreadyStopped: r.alreadyStopped === true, … notes: r.note ? [r.note] : [] };
}
```
—— **`ok: true` 是硬编码**，`r.ok` / `r.error`（P1 分支专门给出的可读失败文案，见 `daemon-client.ts:919-924`）**被静默丢弃**；`notes` 只收 `r.note`，而 P1 分支给的是 `error` ⇒ **`stop` 未完成时调用方拿到的是"成功"**。这使 P1 的"元数据仍在 + 可发现"成立，但**"返回可读失败"这条判据不成立**。

## 5. 回归 + 环境 + 故意红汇总

- **回归**：`--dump-config` **exit 0** / 1266 行 / `Error:` **0**；方法表 **6 个含 `addWorkspace`**；缺/伪造 Origin **403**；`text/plain` **415**；响应无 `token`；槽位守卫 **400**；**窗口抽验** `stop+ensure` ⇒ `mode=systemd`，before/after = 7/7（WT 0）⇒ **Δ=0**（systemd 栏判据满足）。
- **环境（写清）**：`systemctl --user is-system-running` = **running**；failed units **0**；无 `t15*` 单元文件；`/tmp/t15*` **0**；`dsh-rwsl-*` 单元 0。
  ⇒ **degraded 未导致任何回退**（本轮所有 ensure 的 `mode` 都是 `systemd`）。**卫生缺口（规矩）**：`systemd-run` 探针 unit 收尾必须 `stop` + `reset-failed`，**`--collect` 清不掉 failed 态**（这就是跨夜 degraded 的根因）。
- **故意红（3 条，均已字节还原复绿）**：
  1. **A1-host ⑤**：副本去掉服务缺失守卫（`if (false) {`）+ 闭包 `() => undefined` ⇒ 变成 `登记工作区失败（…TypeError: Cannot read properties of undefined (reading 'create')）`（**文案与那行降级日志都没了**）⇒ 判据红。
  2. **P1**：副本 `survivors = []` ⇒ 元数据 GONE + 进程 ALIVE。
  3. **A4**：副本把 `createTranslator` 内第一处 `catch` 改成 `throw e` ⇒ 官方 locale 抛错时 `RESULT_THREW BOOM`（vendor 为 `远程资源管理器`）⇒ 回退断言红。
- **收尾**：unit `stop` + **`reset-failed`**（`is-system-running` 收尾仍 = `running`）；守护/包装层/`launch.*.sh`/四个临时家（`a1-home`/`t26-c1..c3-home`）/三份副本**全清**；端口 8931–8935 **全 0**；可见窗口 **7、mine=0、WT=0**；用户全局存储**未被动过**。

## 6. 我自己的构造/仪器缺陷（留档）

1. **P1 第一版构造无效**：我用 `bash /home/g/t26/daemon.ts --port 8932`（含 `daemon.ts` 名 + trap TERM）当"忽略 shutdown 的守护"——但插件自己的扫描**不认它**（探针 `machine: slot=- pid=-`），所以那次"元数据被删"是**合法删除**，不能当缺陷。改用 **真守护 + `SIGSTOP`** 后构造才有效（`orphans=1`、扫描仍认得）。
2. A1-host 红的**判据一开始只看状态码**：副本下状态仍是 503（因为 TypeError 被包成 E_UNAVAILABLE），所以"未变红"是**我判据写窄**；真正区分点是**文案 + 那行日志**（本轮已按三元组判）。
3. 两次 PowerShell 解析错（字符串里混 ASCII 双引号、末尾括号不平衡）⇒ **整体未执行、无副作用**。
4. 一条 `Add-Ledger` 未 dot-source `win-audit.ps1` ⇒ 该宿主没进账本（不影响结论）。
5. **残留 decoy 已清理**：`bash /home/g/t26/daemon.ts`（pid 1601760）在我第一次清理时没被杀掉，收尾前单独 `kill -KILL` 并复核 pgrep = 0。

## 7. 未复核项（不许当通过）

1. **P1 ① 的"与改前逐字相同"**：无 T25 之前的 stop 响应体归档 ⇒ 只对照了形状/键（`out-115`/T18 的 stop 体未存盘）。
2. **`stop --all`** 本轮未单独跑（`--all` 语义 + 清理）—— 只跑了槽位守卫与单槽 stop。
3. **`openSession` 完整链路**本轮未重跑（仅 DOM 层确认入口仍在）。
4. **A4 的 UI 语言开关**：设置里没找到（`langControl=null`）⇒ "从 UI 切 English"未复核；EN 用模块级运行时代替。light/dark 本轮未重测。
5. **A1-client 的失败态是 fetch 桩**（真 404/400 走 route 已单独验过；503 真触发在 ⑤ 副本里验过），**"UI + 真 host 的 503 组合"未同时跑**。
6. keys>0 / webHosts 非空 / desktop 宿主 / 像素级截图：沿用历轮未复核。
7. `explorer.ts:502` 硬编码 `ok:true` 的**影响面**（还有哪些 action 同样丢 `ok/error`）我只读了 `stop` 分支，未穷举 `ensure/restart/fixPin` 的映射。
