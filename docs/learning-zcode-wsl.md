# 参考 ZCode 的 WSL 机制（2026-10-22）

上游：https://github.com/zai-org/ZCode（智谱 ZCode，开源）。重点看：

- `packages/server/src/remote/wsl-detect.ts` —— 发行版探测
- `packages/server/src/remote/wsl-backend.ts` —— WSL 子进程后端（连接/执行/上传）
- `packages/server/src/remote/wslProxy.ts` —— WSL 里的宿主网关/代理可达性
- `packages/ui/src/lib/wslUncWorkspace.ts` —— UNC 工作区路径解析
- `docs/wsl-remote-workspace-design.md` —— 生命周期与释放规则

## 已采纳（本轮，含验证）

1. **输出解码按 NUL 判码**（wsl-detect）：`wsl -l -v` 常是 UTF-16LE，按 UTF-8 读会夹满 NUL。
   我们采用 `decodeWslOutput()`：含 NUL ⇒ `utf16le`，否则 `utf8`。
2. **按「两个以上空格」切列**：发行版名可以含单个空格（`Ubuntu 22.04 LTS`），
   原正则 `(S+)` 会把名字截断、并把默认标记并进名字。现用 `parseWslDistroTable()`。
3. **一律 `wsl.exe --exec`，不用 `--`**：`--` 会把整段命令行交给默认 shell `-c`，
   引号和 `$VAR` 会在到达 bash 前被提前展开（ZCode 记录过「远端缺少 tar」的误报）。
   已把 `daemon-launch / daemon-protocol / explorer / in-host-runtime / register-tools / wsl-io`
   共 7 处 `'--'` 改成 `'--exec'`，并用真实命令验证（`$HOME` 展开、base64 脚本、脚本文件执行）。

验证：`spike/verify/wsl-parity-20261022/probe-wsl-detect.ts`（11/11，含真实 `wsl -l -v`）。

4. **异步探测**（2026-10-22 晚些补做）：probeDistroState 改为 execFile + Buffer 解码；
   readDistroFacts 变 async，并在同一次 TTL 窗口内共享 in-flight promise（并发只探测一次）；
   失败不写缓存；发行版清单走新增的 deps.listDistrosAsync（index.ts 用 execFile wsl -l -q），
   面板的 snapshot/listDir 不再阻塞 host 事件循环。验证：probe-host-distro 15/15（含「异步清单被调用」）。

5. **代理网关探测**（2026-10-22 晚些补做，参考 wslProxy）：新增 src/wsl-proxy.ts —— 网关候选先
   ip route 的 default via、再退回 /etc/resolv.conf 的 nameserver（只接受私有/链路本地）；
   探活超时从 3s 降到 1s；wsl-io.shellPreamble 改为拼装这些片段。验证：probe-wsl-proxy 16/16
   （含真实 WSL 里跑片段，GATEWAY 取到 172.30.176.1）。未做：host 侧一次性解析 + 缓存、把结果写进快照。

6. **UNC 反解**（2026-10-22 晚些补做）：新增 src/unc-path.ts —— 接受 wsl.localhost 与 wsl$ 两种前缀、
   反斜杠/正斜杠、含空格的发行版名；explorer 的 listDir/openSession/newSession/addWorkspace 统一走
   resolveTarget（UNC 反解出 distro + Linux 路径，显式 distro 不一致则报错）；客户端路径框粘贴 UNC 会自动归一。
   验证：probe-unc 10/10、probe-host-distro 19/19（含真实 UNC 的 listDir/addWorkspace）。

## 值得下一步抄的（未做）

1. **异步探测 + 5s TTL + promise 缓存**（**已部分完成**：探测已异步，显式失效接口未做）（wsl-detect 的 `getCachedDiscovery`）：失败不缓存，
   立刻可重试；`invalidateWSLDiscoveryCache` 供「重新扫描」用。我们的 `probeDistroState` 仍是
   `spawnSync`（已加 8s 超时），冷启动会阻塞 host。
2. **WSL 里的代理网关探测**（wslProxy）：`ip route` / `/etc/resolv.conf` 找宿主网关，
   把 `127.0.0.1:9910` 换成网关地址；用 `/dev/tcp` 判可达。我们目前只透传 `proxyPort`。
3. **UNC 解析**（wslUncWorkspace）：`\\wsl.localhost\<distro>\<path>` 与 `\\wsl$\...` 都能反解成 `{distro, linuxPath}`。我们只在 addWorkspace 时正向拼 UNC，没有反解。
4. **生命周期纪律**（design doc）：释放只针对自己 spawn 的子进程，**禁止** `wsl --terminate/--shutdown`；
   按 workspace generation 释放、有 running task 时延迟到终止；关窗快照去重后再 dispose。
   我们的守护走 linger + idle，方向一致，但缺少「关窗时等待子进程退出」的显式屏障。
5. **池化**：同一窗口、同一 distro 共享一个 server launcher（60s idle TTL）；我们是每 distro 一个
   daemon 槽位，语义接近但没做窗口作用域。

## 结论

ZCode 与我们的路线基本同构（本地 `wsl.exe` 子进程 + 远端 server + UNC 文件访问），差异在
「异步探测/缓存」「代理网关」「生命周期屏障」。本轮先把**解析与 `--exec`**这两个已证实的坑补上，
其余按上面的顺序排进后续。
