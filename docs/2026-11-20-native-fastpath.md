# 原生快路径：让"数据归属方"原生读（去 9P）

> 记录 2026-11-20 这轮改动的**主题、方向、判据、参考依据与取舍**（v0.7.0 → v0.7.2）。
> 配套实现记录：`_reports/native-mount-plan.md` §0–§13；代码：`src/native-mount.ts`、`src/fs-provider.ts`、`src/fs-unc-bridge.ts`、`src/explorer.ts`、`src/native-search.ts`、`src/git-route.ts`。

## 1. 主题（一句话）
**谁拥有这份字节，就让谁原生读它；不要让数据跨过宿主 ↔ WSL 的 9P 桥。**

- Windows 拥有的字节（`/mnt/<盘>`，即 `X:\`）→ **Windows 侧原生**（盘符直读）。
- WSL 拥有的字节（ext4：`/home`、`/etc`、`/tmp`…）→ **WSL 侧原生**（守护 fs-rpc 或 WSL 内进程）。
- 宿主（Windows 插件进程）需要访问 ext4 时，唯一不经过 9P 的通道是：**守护 RPC**（首选）或 **`wsl.exe` 一次性执行**（次选）。

## 2. 方向（怎么一步步收敛）
| 版本 | 做了什么 | 主题落点 |
|---|---|---|
| v0.7.0 | `/mnt` 盘符原生快路径：文件/搜索/git 免 9P | `/mnt` 归 Windows → 走 `D:\`、宿主 `rg.exe`、宿主 `git.exe` |
| v0.7.1 | ext4 的读/列/stat/resolve 也改走 **WSL 守护原生**；安全与评审修复 | ext4 归 WSL → 走 daemon，不再宿主 UNC 9P |
| v0.7.2 | 面板 ext4 列表**减少 9P 往返**（不再逐项 stat；状态读短 TTL 缓存） | 9P 代价在"往返次数"，不在"是否原生" |

## 3. 判据（后续改动的决策准则）
1. **归属方原生**：能落到"拥有者那侧"就别跨桥。
2. **同平面令牌**：同一个文件的 `stat` / 写 CAS / 写后版本必须来自**同一引擎**（要么全原生、要么全 RPC），否则误报 `FS_STALE_VERSION`。
3. **fail-closed**：拿不准就拒绝，不猜、不读"近似路径"。
4. **结构化错误**：用稳定错误码（`FS_DAEMON_UNAVAILABLE` 等）判定降级，**不匹配中文文案**。
5. **面板零副作用**：面板浏览不主动拉起发行版/守护。
6. **成本模型**：9P 贵在**每次往返与元数据量**；单个小文件的 9P 读往往比 `wsl.exe`（0.3–1s 启动）更快——**小文件/引导文件不改成 wsl.exe**。

## 4. 决策表（做了什么 / 为什么 / 风险）
| 决策 | 做法 | 理由 | 已知风险/边界 |
|---|---|---|---|
| `/mnt` 文件 I/O | 宿主原生 `fs-rpc` 复用，`/mnt/x` ↔ `X:\` | 9P 往返慢；同一卷 Windows 原生最快 | 盘符错映射 → `verifyMount` 校验 `/proc/mounts`（fail-closed，60s 复核） |
| `/mnt` 搜索 | 宿主自带 `rg.exe`（`@vscode/ripgrep-win32-x64`） | 在 Windows 卷上原生 rg | 需定位 rg 路径；缺失回落 RPC |
| `/mnt` git | 宿主 `git.exe` + `D:\` cwd | 跨 9P 的 git 元数据扫描极慢 | 无 Windows git 时回落 WSL git |
| ext4 文件读/写/stat/resolve/list | `fs-unc-bridge` 全量转 `wslFs`（daemon） | ext4 归 WSL；宿主 UNC 9P 既慢又会 `GetFileSecurityW EIO` | 依赖守护；**决策 A**：`FS_DAEMON_UNAVAILABLE` 即明确失败（不回退宿主 9P） |
| 令牌平面 | 统一 WSL/ext4 令牌 | 同平面逐字 CAS，比"跨平面翻译+10ms 容差"更严 | 令牌值变化（不透明，仅相等比较） |
| ext4 面板列目录 | 守护**已在跑**才用原生；未运行 → **确定性错误**（不回退 UNC） | 面板承诺零副作用（不拉起守护）+ 决策 A（无两个真相源） | 面板浏览 ext4 依赖守护；`identity⇄wire` 统一生成 UNC/盘符 |
| ext4 打开编辑器 | 默认 `vscode`（Remote-WSL 在 WSL 内原生读）；`explorer` 为次要并附 `note` | 与 VS Code 架构对齐 | 资源管理器看 ext4 只能 9P（Windows 无 ext4 挂载） |

## 5. 参考依据（"参考什么做的"）
- **实测前提**：`/mnt` 是 9P（drvfs），WSL 经 9P 访问比 Windows 原生慢约 **10×**（本机实测/用户结论；`node_modules` 这类小文件最敏感）。
- **VS Code Remote-WSL（架构对照）**：VS Code 在 WSL 里跑 **Server 进程原生读 ext4**；这正是"归属方原生"的现成先例，也是本插件对 ext4 走 daemon 的类比依据。
- **VS Code 自带 ripgrep**：`@vscode/ripgrep-<platform>` 在各平台原生跑；`/mnt` 用宿主 `rg.exe` 即此模式。
- **上游 DSH `dsh-fs-sandbox` 源码**（`app.asar` 内只读提取）：读操作**不加围栏**（"Reads pass through untouched"），写操作才校验策略——据此判断"ext4 读改走 daemon"不构成读授权回归。
- **`dsh-fs-local` 的 9P 根因**：替换文件时走 `GetFileSecurityW`/`ReplaceFileW` 复制 DACL，在 `\\wsl.localhost` 上报 `EIO (Win32 1)`——`fs-unc-bridge` 存在的直接原因。
- **WSL `/proc/mounts` 语义**：source 里的反斜杠被转义成八进制 `\134`（`D:\` → `D:\134`），`verifyMount` 需先解码。
- **Windows 路径语义**：`\ : * ? " < > |`、尾点/尾空格、保留设备名（`CON`/`NUL`…）、ADS（`a:b`）——fail-open 前必须校验"可被 Windows 无歧义表示"。
- **ZCode 的 WSL 实现**（`docs/learning-zcode-wsl.md`）：输出解码、路径桥接等既有参考。
- **本项目既有设计文档**：`docs/prior-art-dsh-wsl.md`、`docs/prior-art-dsh-ssh-ops.md`、`docs/2026-10-29-native-shell.md`。

## 6. 未做 / 有意不做的
- **WSL 内对 `/mnt` 的命令**：drvfs 本质，无法改道；正确策略是"别在 WSL 里对 `/mnt` 跑重操作"。
- **资源管理器看 ext4**：Windows 无 ext4 挂载，只能 `\\wsl.localhost`（9P）。
- **引导链小文件**（守护 `meta/token/log`、`/tmp` 启动脚本、`.desktop-version-pin`、`/etc/wsl.conf`）：**保留 UNC**——小文件 9P 比 `wsl.exe` 启动快，且守护起来之前必须先读，不能依赖守护。

## 7. 验证方式（可复核）
- 单测：`node --experimental-strip-types --test test/*.test.ts`（含令牌平面、**守护不可用不回退宿主**、身份往返、挂载粘滞/去重用例）。
- 语法门：`node --experimental-strip-types scripts/check-syntax.ts`。
- 真机冒烟：`_work/smoke-native.ts`（宿主原生 fs）、`_work/smoke-search.ts`（宿主 rg）。
- 边界：`wsl_daemon action=status` 看守护；`wsl_path`/`wsl_status` 交叉核对。

## 8. 对标 VS Code Remote-WSL
**它的范式**：远端进程（VS Code Server）**拥有字节并原生执行**（extension host / ripgrep / git / 终端都在 WSL 内），Windows 侧只做 UI + 窄 RPC 通道；**身份是远端 URI**（`vscode-remote://wsl+<distro>/<path>`），**UNC 只是"在 Windows shell 打开"的导出**，不进文件身份。

**我们已对齐**：daemon 原生读写 ext4；`/mnt` 走宿主原生（VS Code 同样把 `/mnt` 视为 Windows 侧）；rg/git 各自归位；端口转发式 Web UI；版本配套检查；doctor 式诊断。

**尚未对齐（P2/P3）**：内部仍用 UNC 字符串当路径（桥/面板）。→ 计划改成 `{distro, linuxPath}` 身份、UNC 只在边界生成，见 `docs/2026-11-21-path-identity.md`。

**不适用**：VS Code 的 UI/工作区双 extension host 模型；DSH 没有对应物（我们是宿主插件 + WSL daemon）。

## 9. DSH 特殊性（决定"照抄 VS Code"的边界）
- **宿主 fs 是可注入服务，合约吃字符串 `targetKey`** → URI 只能内部用，wire 仍是 UNC。
- **没有 extension host/server 二分** → "authority 决定 provider"翻译成"preset + bridge attach 时锁定平面"。
- **两个 preset 可指向同一工作区** → 结构上就有两个 provider（改不掉），只能在 token 平面与文档上保证一致。
- **守护不保证存在** → 不能像 VS Code 那样"server 一定在"；因此必须有确定性错误 + 可执行修复。
- **读不加围栏**（上游 fs-sandbox）→ fail-open 不是越权，只是**视图不一致**；但按决策 A 仍改为 fail-closed。
- **插件热重载/多会话** → 平面与缓存按 fs 服务实例，不全局。
- **版本可漂移** → 身份/契约演进必须可加版本（`plugin-version.ts` 已有 v2 先例）。

## 10. 决策 A（已确认）：ext4 读 fail-closed
守护不可用时 **明确失败**（`FS_DAEMON_UNAVAILABLE` + 修复指引），**移除静默回退宿主 9P**；`allowHost9pFallback` 默认 `false` 仅作显式逃生口。理由与影响见 `docs/2026-11-21-path-identity.md` §决策 A。

## 11. 实测指标（2026-11-20 本机，debian-u8-1）

目标目录 `/home/g/.local/bin`（20 项），文件 `sd`（2.4 MB）。同机、热缓存、取中位数。

| 操作 | 宿主 UNC（9P） | WSL 内原生 | 倍数 |
|---|---|---|---|
| readdir（20 项） | 1.1 ms | 0.009 ms | ~120× |
| stat（每项） | 0.79 ms | 0.0008 ms | ~1000× |
| read 2.4 MB | 8.9 ms | 0.169 ms | ~53× |

**另一个反直觉但重要的数**：`wsl.exe` 单次启动基线 **≈104 ms**。所以：
- **单次**小操作走 `wsl.exe`（104ms 起）**远慢于** 9P（1–9ms）——这就是"引导链小文件保留 UNC、不要把 9P 回退换成 wsl.exe"的数据依据；
- 真正快的是**常驻守护**（≈ WSL 内原生，无启动开销），即 daemon 路径；
- 9P 的代价主要在**每操作往返与元数据量**，不是带宽 → 面板"1 次 readdir + N 次 stat" 的 N 倍放大最致命（已改为 0 次）。

**附带事实**：`\\wsl.localhost\<distro>\mnt\d\…` 从 Windows 访问是 **Access denied**（PowerShell `Test-Path` 为 False）——历史上"`/mnt` 回退宿主 UNC"本来就不可用，这也印证 `/mnt` 必须走盘符原生。


