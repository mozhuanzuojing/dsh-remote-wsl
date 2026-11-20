# ADR：路径身份 = `{distro, linuxPath}`（wire 才用 UNC/盘符）

- 状态：**P1/P2/P3 已落地**（P2=fail-closed/决策 A；P3=explorer 输出统一走 `identity⇄wire`）；P4（基准+发版）待执行
- 日期：2026-11-21
- 相关：`docs/2026-11-20-native-fastpath.md`、`src/path-identity.ts`、`src/unc-path.ts`、`src/native-mount.ts`

## 背景
插件一直把 **UNC 字符串**（`\\wsl.localhost\<distro>\…`）当成"路径"在内部传：桥的 `targetKey`、面板输出、守护状态文件。它同时承担三种角色：**身份**、**wire format**、**显示串**。

UNC 当身份的问题（已被 9P 实践反复验证）：
- Windows 语义渗入：`a:b`(ADS)、尾点/尾空格、`CON`/`NUL` 保留名、`\` 是分隔符而 ext4 允许文件名含 `\`；
- "同一文件两个键"风险（词法拼接 vs realpath）；
- 安全判定（前缀/包含）被迫在**未经规范化的字符串**上做；
- 与 VS Code Remote 的 URI 身份不一致，`open in VS Code` 需要额外转换。

## 决策
1. **内部身份** = `{distro, linuxPath}`，`linuxPath` 必须是**归一化 POSIX 绝对路径**（`path.posix.normalize`，去尾斜杠）。
2. **UNC / 盘符只是 wire**，只在边界生成：
   - 进宿主 fs 服务（`targetKey`）/ Windows 命令 / 会话 cwd → **UNC**（`wireFromIdentity`）；
   - 仅 `/mnt/<letter>/…` 才可映射成 `X:\`（`nativeWireFromIdentity`）；
   - 显示给用户/模型 → Linux 路径（`displayFromIdentity`）；
   - 交给 VS Code → `vscode-remote://wsl+<distro>/<encoded>`（复用 `open-editor.buildVsCodeWslUri`）。
3. **不改上游合约**：DSH 宿主 fs 的 `targetKey` 仍是**字符串**（UNC）。URI 只在插件内部/我们自己的 API 用。
4. **安全判定只信规范化后的身份**，不在 wire 串上做前缀/包含判断。
5. **平面在连接期确定**（bridge attach 时探测并锁定该 fs 服务实例的平面）；运行期守护掉线 → **确定性错误**，不逐 op 切换（见下文 A 决策）。

## 决策 A（已由用户确认）：ext4 读 fail-closed
- 守护不可用 → **确定性失败**，错误码 `FS_DAEMON_UNAVAILABLE`，消息附可执行修复（`wsl_daemon start` / `wsl_doctor`）。
- **移除**静默回退宿主 9P 的 fail-open；因此 `isWindowsRepresentable` 的"回退前校验"不再需要（仅保留 `safeRestSegments` 供 `/mnt` 盘符映射）。
- 理由：与"ext4 读依赖守护"的既有决策一致；避免**两个真相源**（同一路径两次调用来自不同引擎/不同 token 平面）。
- 灰度：`allowHost9pFallback`（默认 `false`）作为显式逃生口，回退结果标 `plane:'host-9p'`。

## 影响与验收
| 阶段 | 内容 | 验收 |
|---|---|---|
| P1（已完成） | `src/path-identity.ts` + 7 条往返/归一化测试 | 全量 286/277/0/9 |
| P2 | 抽 `RemoteFileSystem` 接口，桥变 adapter；平面 attach 期锁定；fail-open → fail-closed（A） | 桥测试全绿；"守护不可用时不触碰宿主 9P"回归门 |
| P3 | `explorer` 的 `openExternal/newSession/addWorkspace/listDir` 统一走 `identity⇄wire` | 面板两发行版 browse/open 各一遍 |
| P4 | 指标（9P 调用数、p50/p95）+ 发版 `0.8.0` | 基准脚本可复现 |

## 不在范围
- 不把 `targetKey` 改成 URI（会破坏上游合约）。
- 不改引导链小文件（`meta/token/log`、`/tmp` 脚本）——小文件 9P 比 `wsl.exe` 快且必须先于守护存在。
- 不消除"两个 preset 同工作区"这一 DSH 固有结构（wsl preset 与 standard preset 各有一个 provider）。
