# REPORT-prior-art-adoptions.md —— task-14 A2/A3/A6 聚焦复验

- **验证者**：`p0-verify`（独立于 T12/T13 实现者）｜**日期**：2026-10-12｜**被验对象**：`D:\project\dsh1\vendor\dsh-remote-wsl`
- **revision**：开工冻结（17:49）→ 收尾复算（18:0x）**锚点一致 = True（13/13）⇒ 验证有效**；advisory 仅 README.md + docs/prior-art-dsh-wsl.md + docs/remote-explorer-design.md（非锚点）
- 13 个锚点：`src/**/*.ts` 8 + `client/**` 4 + `package.json`。lead 给的 6 个关键哈希 **6/6 MATCH**；7 个"应未变"文件（`selftest.ts`/`daemon.ts`/`sdk-runtime.ts`/`shell-env.ts`/`version.ts`/`daemon-client.ts`/`client.icon.js`）**7/7 unchanged**。

## 结论（≤450 字）

**A2 pass、A6 pass、A3 pass；回归全绿；故意红 2 条都真变红。**
**A2**：`dsh.compatibility.dshReleases = {"0.2.0-rc.2":"compatible"}`（形状 string→string、**键集合恰 = 本项目实测版本**、值域只 `compatible`）；`--dump-config` exit 0 / 1266 行 / `Error:` 命中 **0**；7 个工具照常注册（`wsl_path` 已在列）⇒ 声明无副作用。**宿主不校验该字段**（`--dump-config-schema` 0 命中 —— 上轮已实测），报告按"声明性、无 schema 背书"写。
**A6**：`wsl_path` 四条功能 pass（`D:\project\net1`↔`/mnt/d/project/net1`、含空格、`both` 默认）；**8 类注入负例全部当字面量且零执行痕迹**（`$(id)`/反引号/`;`/`|`/混引号；`$(touch …)` 未生成标记、`$(sleep 37)` 无进程）；失败面 pass（空路径 / NUL / 非法 direction / **不存在的发行版** ⇒ 可读错误且不回显原串，`wsl -l -v` 前后逐字一致 = 未启动任何发行版）；零副作用 pass（调用前后 daemon facts 全 MATCH）。
**A3**：四能力实测 pass —— chips 8 个可点（`/mnt/c` → 面包屑 `/ mnt c` + 22 项 = `C:\` 22 项）｜路径输入**始终可见**+回车/跳转（`/home/g/project` → 4 段面包屑 + 含 `dsh1`）｜面包屑**首段 `/` 可点回根**（46 项）、深路径不省略｜隐藏开关 off→on 后 68 个 `.` 条目出现、标签变 `隐藏文件：显示（68）`。回归：F34 首挂载只有读取态｜F35 新路径文本 `ltr`+`plaintext`｜`others[]` **零按钮**｜停/重启仍标"需二次确认"｜aria/title 齐全｜light/dark 双份正常｜**③ 差集 exit 0（strong=11）**。
**故意红**：① 副本删 `..` 校验 ⇒ `listDir('/home/../etc')` **200 + 158 项含 `passwd`**（真列出 `/etc`；原对象 **400**）；② 副本把 `wsl_path` 换成字符串拼接 ⇒ 注入用例**真的创建了 `/tmp/t14-pwned-a`**（原对象零痕迹）。
**未产生可见窗口**（`-WindowStyle Hidden` / inline 重定向）。**未复核项见文末。**

## A2 逐条

| 判据 | 结果 | 证据 |
|---|---|---|
| ① 形状 string→string | **pass** | `package.json`：`dsh.compatibility.dshReleases = {"0.2.0-rc.2":"compatible"}` |
| ② 键 ⊆ 实测版本 | **pass** | 唯一键 `0.2.0-rc.2` == `runtime.json` 的 `desktopVersion` == `wsl_status` 的 `desktop dsh version`（无未实测版本） |
| ③ 值域 | **pass** | 值为 `"compatible"`（无 `unknown`/空/占位） |
| ④ 无副作用 | **pass** | `--dump-config` exit 0、1266 行、`Error:` 0；工具注册 7 个（`wsl_path` 在内）→ `out-71-a2-tools.txt` |
| ⑤ 表述 | **pass** | 报告如实写"**声明性、宿主不校验、无 schema 背书**"（`T14-PREP-dump-config-schema.txt` 里 `compatibility`/`dshReleases` 各 0 命中） |
- 形状出处（**只读、未安装**）：[registry.npmjs.org/dsh-wsl-workspace/0.7.7](https://registry.npmjs.org/dsh-wsl-workspace/0.7.7) 的 `dsh.compatibility.dshReleases`（11 版本，值皆 `compatible`）。

## A6 逐条（`probe-wsl-path.mjs`）

- **功能四条**：`to-wsl D:\project\net1 → /mnt/d/project/net1`｜`to-windows /mnt/d/project/net1 → D:\project\net1`｜不带 `direction`（`both`）两形态齐出｜含空格双向 pass —— 原始：`out-76-wsl-path.json`
- **注入 8 类**：`$(id)`、反引号 `` `id` ``、`;`、`|`、混引号、`$(touch /tmp/t14-pwned-a)`、`$(sleep 37)` 全部 ok、字面量保留；**执行痕迹：`/tmp/t14-pwned*` 无、`sleep 37` 无进程**（注入前后各查一次）。实现自报的命令行证明路径走**位置参数**：`wsl.exe … -c 'wslpath -a -u -- "$1"' _ "/mnt/c/a;echo T14-INJECTED"`
- **失败面**：空路径 / NUL / 非法 `direction` ⇒ 可读错误；**不存在的发行版**（探针侧 `--distro debian-nope`，**未碰 debian-u8-1**）⇒ `remote-wsl: 在发行版 "debian-nope" 里执行 wslpath 失败（exit 4294967295）…`，且**未回显原串**；`wsl -l -v` 前后逐字一致 ⇒ 未启动任何发行版 —— `out-77-baddistro-verdict.txt`
- **零副作用**：调用前后 `daemon-invariance` compare **exit 0**（我自己的 8932 守护 pid/端口/version/keys/pgrepMine/监听全 MATCH）

## A3 逐条 + `/mnt` 映射与 `listDir` 安全面

| 能力/断言 | 结果 | 证据 |
|---|---|---|
| ① chips 跳转 | **pass** | 8 个路径 chip（Home//`/mnt`//`/mnt/c`…`/mnt/g`）+隐藏开关；点 `/mnt/c` → 面包屑 `["/","mnt","c"]`、条目 22 = `C:\` 22 |
| ② 路径输入常显 + 回车跳转 | **pass** | `.dsh-rw-path-input` 在 5 个状态下 `inputVisible=true`；输入 `/home/g/project` + 跳转 → 面包屑 4 段、条目含 `dsh1` |
| ③ 面包屑从 `/` 起且可点 | **pass** | 基线 `["/","home","g"]`；点首段 `/` → `["/"]` + 根 46 项；深路径不截断 |
| ④ 隐藏文件开关 | **pass** | off：`dotEntries=[]`；on：68 个 `.` 条目、标签 `隐藏文件：显示（68）` |
| `listDir` 白名单/传输面 | **pass** | `methods` 含 `explorer.listDir`；缺/伪造 Origin → 403；`out-72-listdir-probe.txt` |
| 非法形态（7 种） | **pass** | `../etc`/`foo`/空串/反斜杠/`/home/../etc`/NUL/`C:\` ⇒ 全部 **400 E_ARG 且不返回条目** |
| 路径不存在 | **pass** | `/home/g/no-such-dir-xyz-t14` → **404 E_NOTFOUND**，body 含该 path（`out-73-listdir-bad.json`） |
| **`/mnt` 9p 限制与映射**（lead 新增） | **pass** | 原始证据 `out-74-unc-vs-drive.txt`：UNC `\\wsl.localhost\debian-u8-1\mnt` = OK(7)｜**UNC `…\mnt\c` = Access denied（这就是"必须映射"的原因）**｜UNC `…\mnt\wslg` = OK(13) 而 `listDir('/mnt/wslg')` 也 = 13（仍走 UNC）｜`/mnt/c` 22 项 = `C:\` 22 项、`/mnt/c/Users` 6 = `C:\Users` 6｜`/mnt/z`（不存在的盘）→ **404**，错误里带 `scandir 'Z:\'`｜`/mnt`（挂载根）→ **200 / 7 项** |
| 确定性顺序 | **pass** | 同路径两次 body **逐字相同** |
| 零副作用 | **pass** | 我自己的 8932 守护在跑时做 4 次 listDir，前后 facts compare **exit 0**（`out-75-listdir-nosideffect.json`） |
| 回归 F34/F35/others/二次确认/aria | **pass** | F34：采样器前 3 帧仅 `正在读取…`/`正在列目录…`；F35：`.dsh-rw-path-input`/`.dsh-rw-entry-name`/`.dsh-rw-crumb`/`.dsh-rw-workspace-path` 全 `ltr`+`plaintext`；`.dsh-rw-others` 内按钮数 **0**；停/重启 link 的 aria/title 含"需二次确认"；所有新控件都有 aria-label+title |
| light/dark | **pass** | dark `#151517`/light `#fff`，tokens 全变、浏览器 UI 在两模式下都在（chips 9/crumbs 3/input 有） |
| ③ 差集（正常场景） | **pass** | `out-79-diff-normal-t14.json`：**exit 0, strong=11**（pid 1033761/port 8932/version 逐项 MATCH） |

## 故意红（2 条，均在 `%TEMP%` **副本**上做；被验对象只读）

| # | 手法（副本内） | 结果 | 原对象对照 |
|---|---|---|---|
| **RED-a** | 删掉 `explorer.ts` 的 `..` 段校验 | `listDir('/home/../etc')` → **200，158 项，含 `passwd`**（同一测试里的正向对照 `listDir('/etc')` 也是 158 项 ⇒ 确实读到了 `/etc`） | `listDir('/home/../etc')` → **400 E_ARG** |
| **RED-b** | 把 `wsl_path` 的 argv 传参换成字符串拼接 | 注入电池里 `$(touch /tmp/t14-pwned-a)` **真的创建了 `/tmp/t14-pwned-a`**（`-rw-r--r-- … 0 Oct 12 17:59`） | 同一用例 **NO-MARKER**、无 `sleep` 进程 |
- 副本自检：`vendor/src/explorer.ts` 仍有 `segment ===` 校验（1 处）、`vendor/src/index.ts` 仍是 argv 传参（1 处）⇒ **被验对象全程未被改**；收尾已删副本与 `remote-wsl-t14-red` profile。

## 现场与清理（前后对照）

- 我起的（8931 主宿主 / 8933 副本宿主 / 8932 守护）**全部停掉**；端口 8931–8937 **全 0**；WSL 侧 `daemon.ts --port 8932`/`launch.8932.sh`/`launch.8934.sh` 包装层 **均无**；注入标记 `/tmp/t14-pwned-a` **已删（CLEAN）**；副本与临时 profile 已删。
- **可见窗口枚举**：只剩用户自己的程序（Code / Cursor / DeepSeek Harness / Geph / Edge / TextInputHost / 用户自己的 `WindowsTerminal`，pid 32024）⇒ **本轮未产生可见窗口**（启动方式：`Start-Process -WindowStyle Hidden` 或 inline+重定向；`Get-ChildItem *.ps1 | Select-String Start-Process` 仍只有 2 处且都带 Hidden）。
- 活宿主 `19387` pid **47564** 全程未变；**未跑任何 npm/pnpm install**；未碰 `reliability/`/`stability/`/`usability/`。

## 未复核项（不许当通过）

1. **"发行版未运行"分支**（T13 自陈未复核）：我只证了"**发行版不存在**"（`debian-nope`）⇒ 该分支如实记**未复核**（不为它去停 `debian-u8-1`）。
2. **`/mnt/*` 上的 Windows 隐藏属性不参与 `hidden`**（T13 自陈的刻意取舍）：已记录，**未复核**其取舍影响。
3. **`keys > 0` / 多 key**：仍为 0（空集弱证据）⇒ 未复核。
4. **`webHosts` 非空**：面板与 `wsl_status` 皆空 ⇒ 未复核。
5. **desktop（Electron）宿主**：只在 `dsh web` 实例验证 ⇒ 未复核。
6. **注入负例的"字面量保留"判据偏粗**：`;`/`|` 两例我按"输出里仍含该串"判；决定性证据是**标记/进程零痕迹**与实现自报的 argv 命令行。若后续要更严，应断言"输出恰好等于 `wslpath` 对该字面量的转换结果"。
7. **`wsl_path` 的超长输入（4KB+）**：本轮未单独构造（计划里有，时间不足）⇒ 未复核。
8. **副本 RED 是**粗粒度补丁**（拼接后命令形状变了、多数用例 `ok=False`）**：RED 的结论只取"**留下了执行痕迹**"这一点；不据此评价副本的其它行为。
9. **F25 / F14b / F31 / F33 等 T10 项本轮未重跑**（T14 是聚焦复验；这些不在本轮任务面内）。
10. **像素级截图未落盘**（chrome-devtools-mcp 的 `filePath` 只能写它自己的 workspace root）⇒ 视觉证据用 DOM 抽取 + 计算样式替代。
11. **本轮我自己的 harness 修了 3 处**（留档）：`probe-listdir.ps1` 里 compare 的 stdout 重定向撞上它自己要写的文件；`-replace` 写进参数列表导致解析错；副本补丁的引号构造错两次 —— 都不是被验对象的问题。
