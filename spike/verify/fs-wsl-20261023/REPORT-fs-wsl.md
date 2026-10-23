# REPORT —— WSL 执行世界：`ctx.fs` 的 WSL provider（2026-10-23，阶段一）

> 目录：`spike/verify/fs-wsl-20261023/`
> 起因：DSH 的 `write` 在 `\\wsl.localhost\debian-u8-1\…` 上失败（`GetFileSecurityW EIO`）——
> Windows 侧 9P 共享不支持 `dsh-fs-local` 的原子写（复制 DACL / 硬链接发布）。
> 结论：**文件操作已经可以真的在 WSL 里执行**（26/26 探针，独立复核），剩下的接入点
> （agent preset）在阶段二完成前还没生效 —— 本文只声称"后端与 provider 已验证"。

## 1. 方案（为什么不是照抄 dsh-wsl-workspace）

| 做法 | 文件读写在哪儿 | 证据 |
|---|---|---|
| `dsh-wsl-workspace` 0.7.9 | Windows 9P（`WslFileSystem` 继承 `LocalFileSystem`，override 掉 DACL/硬链接） | 其 README 第 46 行："文件工具经 Windows 侧的 WSL 9P 共享访问" |
| ZCode | Windows 9P（`wsl-backend.ts` 里 `readFile/copyFile/access` 全走 UNC） | 源码 `toWslUncCandidates` |
| VS Code Remote-WSL | WSL 内 `vscode-server`（文件、搜索、扩展全在远端） | `~/.vscode-server/bin/<commit>/` |
| **本实现** | **WSL 内 node:fs**（宿主只发 RPC，不读 UNC） | `probe-fs-wsl` 26/26 |

DSH 的缝是 `ctx.fs` 服务定义：`dsh-tool-fs` 只调 `ctx.fs.resolve/stat/readText/writeText/editText/…`。
`fs` 是单例，不能在宿主平面再 `provide` 一次；必须挂在 **agent preset 的 isolate realm**
（`isolate: { fs: true }`）里 —— 这正是阶段二要补的入口。

## 2. 已实现

| 文件 | 作用 |
|---|---|
| `src/fs-rpc.ts` | WSL 侧文件操作实现（node:fs）。版本 = `mtimeNs:size`；原子写 = 同目录 temp + rename；`replaceIfVersion`/`createIfAbsent`；`readText` 拒二进制/超限；`readBytes`/`readRange` 走 base64 |
| `src/daemon.ts` | 新增 `{op:'fs', method, args}`：调用 `fs-rpc.handleFsOp`，错误带 `FS_*` 码 |
| `src/fs-provider.ts` | 宿主 provider：`resolve` 认 Linux 路径 / UNC / 相对 cwd；方法全部转发 daemon；`ctx.provide('fs', impl)` |

关键语义：错误码与 `dsh-fs-local` 对齐（`FS_STALE_VERSION`、`FS_NOT_OBSERVED`、`FS_NOT_REGULAR_FILE`、
`FS_BINARY`、`FS_TOO_LARGE`、`FS_NOT_FOUND`），工具层可以照常渲染。

## 3. 证据（probe-fs-wsl 26/26，真 WSL）

- 解析：Linux 路径 / `\\wsl.localhost\…` / UNC cwd 下的相对路径；`processPath` 回 UNC。
- 读写：create/update、`replaceIfVersion` 成功与过期（`FS_STALE_VERSION`）、`createIfAbsent` 撞已有
  （`FS_NOT_OBSERVED`）、版本随写入变化、失败写入不污染内容。
- 编辑：唯一替换、非唯一拒绝、`replaceAll` 全替换。
- 字节：二进制 `readBytes` 往返一致；`readText` 拒绝二进制（`FS_BINARY`）。
- 目录/链接：`listDir` 类型正确；`stat` 跟随符号链接、`lstat` 不跟随。
- **独立复核**（不是同一进程自证）：`wsl.exe … cat` 读到的字节一致；`stat -c '%a:%U'` 看到
  mode 600 与属主；`stat -c %d` 证明落在 ext4 而不是 `/mnt/d`。
- 架构断言：provider 源码不 import `node:fs`，只发 `{op:'fs'}` RPC。

回归（`daemon.ts` 改了）：`probe-daemon-gateway` 33/33、`probe-wsl-io-lifecycle` 24/24、
`probe-lifecycle-grace` 34/34 全绿。

## 4. 尚未完成（阶段二）

1. **preset 接入**：注册一个 `wsl` agent preset，在 `isolate: { fs: true }` 的组里挂
   `fs-provider` + `@deepseek-ai/dsh-tool-fs`；这样 DSH 的 `read/write/edit` 才真正用上本 provider。
2. **搜索**：`tool-fs-search` 仍用 Windows ripgrep；Linux 路径需要 WSL 内 grep/find（见
   `dsh-wsl-workspace` 的 `wsl-search.js` 做法）。
3. **watch**：明确报不支持；DSH 的文件观察策略会退化为不观察。
4. **多发行版**：provider 当前只服务配置的一个发行版（`distro`）。
5. **sandbox**：`sandboxMode` 为 undefined（不做 Windows ACL 围栏）；是否在 WSL 侧接
   `writableRoots` 需要单独设计。
6. 端到端：还没有用真实 agent 会话调 `write` 工具验证（要模型额度，等 preset 接入后做）。

## 5. 复跑

```powershell
$node='C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
cd D:\project\dsh1\dsh-remote-wsl
& $node spike/verify/fs-wsl-20261023/probe-fs-wsl.ts   # 26/26（真 WSL，约 10s）
```
