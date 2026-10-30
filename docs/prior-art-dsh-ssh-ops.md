# dsh-ssh-ops 对照与吸收记录

来源：`caoyiwei850/dsh-ssh-ops`，tag `v0.4.3`，commit `bdf94ba6d8ba24c5bc331e0d52d6fc5195854bd7`，MIT License。

本记录只借鉴设计与正则思路，不复制 SSH/SFTP/数据库运行时代码；插件包不新增对 `ssh2`、数据库驱动的依赖。

## 对照矩阵

| dsh-ssh-ops 能力 | dsh-remote-wsl 现状（0.3.13） | 结论 |
|---|---|---|
| 危险命令 `tools/pre-execute` 审批 | `wsl_exec`、WSL preset `bash` 无门禁 | **吸收**：`src/command-policy.ts` + `wsl` preset 子插件 |
| `assessShellCommand` deny-list | 无 | **吸收**：删除/批量删除/磁盘格式化/容器/部署/Git/重启分类 |
| 输出脱敏（`redact.js`） | 无 | **不吸收**：用户明确本轮不需要 |
| 右侧栏终端（`sidebarRightTabs`/xterm） | 无；只有 `wsl_open_ui` 独立 Web UI | **吸收（subprocess 后端）**：`wsl-world` 隔离并替换 `subprocess`（`src/subprocess-provider.ts`），官方 xterm/终端池复用；真机 GUI 待验收 |
| SFTP / 数据库 / 隧道 / 批量 | WSL 已有 fs provider、`wsl_exec`、本地 shell | **不吸收**：避免重复 SSH 专属能力 |
| SSH 凭据 / known_hosts / 主机指纹 | 无网络认证 | **不吸收** |
| 远端工作区绑定 | WSL preset + UNC 桥已提供原生文件世界 | **不吸收**：WSL 语义更强 |
| keepalive / 自动重连 | 本地守护 TCP 已有传输错误处理 | **不吸收**：问题域不同 |
| i18n / 插件更新器 | 插件已有客户端双语 | **不吸收** |
| 终端池 / 增量读取 | 只有右侧栏终端才需要 | **随右侧栏方案暂缓**（需先有 WSL subprocess） |

## 吸收细节

### 危险命令审批

`src/command-policy.ts` 适配了 dsh-ssh-ops 的 `safety.js` deny-list 形态：

- `src/index.ts` 对根工具 `wsl_exec` 安装门禁；
- `src/preset.ts` 在 `wsl-world` 组内新增 `wsl-command-policy` 子插件，只拦截该组内的 `bash`；
- 命中后调用 DSH `approval.request({ agent, toolName, callId, reason, signal })`；
- `allowed-once` 才放行；`rejected`/`cancelled`/无审批通道/无 agent/callId 全部 deny；
- 不提供 Agent 可修改的 allowAll；`commandPolicy: "off"` 只能由操作者配置关闭（默认 `standard`）。

### 明确不做的边界

- `wsl_agent` 是 WSL 内的完整 dsh agent，其生成的命令不经过本门禁；README 已写明。
- deny-list 是启发式，不是完整沙箱；合法命令命中时需要操作者审批，不会静默执行。
- 未吸收输出脱敏、右侧栏终端、SFTP/数据库/隧道/批量。

## 参考源码

- https://github.com/caoyiwei850/dsh-ssh-ops/blob/v0.4.3/src/safety.js
- https://github.com/caoyiwei850/dsh-ssh-ops/blob/v0.4.3/src/tools/ssh-session.js
- https://github.com/caoyiwei850/dsh-ssh-ops/blob/v0.4.3/src/tools/sftp.js
- https://github.com/caoyiwei850/dsh-ssh-ops/blob/v0.4.3/src/redact.js （仅阅读，未采纳）
