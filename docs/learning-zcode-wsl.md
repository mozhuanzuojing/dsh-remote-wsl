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

7. **关停屏障**（2026-10-22 晚些补做，参考 design doc 的 dispose 纪律）：新增 src/lifecycle.ts ——
   dispose 开始后 beginShutdown() 拒绝新建运行时（E_SHUTDOWN），track 本插件 spawn 的 wsl.exe 包装层，
   settle(5000) 等它们退出，超时只 kill 自己记录的那些（绝不 wsl --terminate/--shutdown）。
   验证：probe-lifecycle 9/9。未做：窗口级池化（同 distro 共享 host）、web host 子进程的跟踪。

8. **host 侧代理解析 + 快照**（2026-10-22 晚些补做）：wsl-proxy 增加 resolveWslProxy（TTL 5 分钟、
   不可达 30 秒、并发去重）；explorer.snapshot 增加 proxy 段（**只对运行中的发行版探**，不拉起停着的）；
   面板「诊断信息」显示 代理：host:port 可达/不可达/未探测。验证：probe-host-distro 20/20
   （实测 proxy=172.30.176.1:9910 reachable，cached）、probe-layout 23/23。

9. **缓存失效（重新扫描）**（2026-10-22 晚些补做）：snapshot 支持 {refresh:true} —— 丢发行版事实缓存、
   清该 distro 的代理缓存、跳过 snapshot 单飞；面板「重新扫描」改为 load({refresh:true})。
   验证：probe-host-distro 21/21（refresh 后异步清单确实重新探测）、probe-wsl-proxy 18/18（invalidate 后重探）。

10. **web host 也纳入关停屏障**（2026-10-22 晚些补做）：WebHost 接受 lifecycle，spawn 前 assertAlive、
    spawn 后 track；index 把它一路传给 registerTools。验证：probe-webhost-lifecycle 5/5。
11. **家目录探测异步预热**：resolveDistro 在显式发行版分支 await ensureDistroHome（execFile），
    后续 cfgFor → distroHome 直接命中缓存，不再在同步段 spawn。

### 2.1 本轮（2026-10-22 第二轮）新吸收的五条 —— 全部有探针

12. **释放宽限的两段式**（对照 `packages/server/src/remote/wsl-backend.ts` 的 `disposeAndWait()`）：
    先对每个**自己 spawn** 的 child `stdin.end()`（优雅）→ 宽限 300ms → 只 kill 归属表里仍在的 →
    kill 后再等 250ms 确认退出。我们原来「等 5s，超时直接 kill 且不等退」会把子进程的收尾截断。
    总预算仍是 5s（宽限与 kill 后等待都从预算里扣）。验证：`zcode-20261022/probe-lifecycle-grace.ts` 26/26。
13. **幂等 + 三事件归属**（ZCode `disposeInFlight` / `ownedChildren`）：`settle()` 缓存 in-flight promise
    （disposer 与关窗路径各调一次也只跑一遍）；归属表认 `exit`/`error`/`close` 三个事件
    （原来只认 `exit`，spawn 失败时 settle 白等满一个超时）。
14. **晚订阅丢事件**（ZCode `packages/server/src/remote/closeEvent.ts`）：子进程可能在调用方订阅前就退出，
    ZCode 对晚订阅者补发 close code。我们的等价做法是**在 `track()` 时就建好 settled promise**，
    `settle()` 直接 await ——「快照之后、挂监听之前退出就白等到超时」的窗口从根上不存在。
    实测：先退出的 child，20ms 后再 settle，`waitedMs=0`。
15. **spawn 前双检 + 短命子进程归属**（ZCode `assertNotDisposed()` 在每次 await 之后再调一次）：
    `wsl-io.runWsl` 的 wsl.exe 现在全部登记进关停屏障（handoff §5.3 的遗留项由本轮关闭），
    关停态直接返回 127 + 可读原因（`runWsl` 契约仍是"永不抛"）；`reapWsl` / 自有临时文件清扫这两条
    **收尾路径**显式豁免（否则 dispose 时 Linux 侧进程会变孤儿）。
16. **输出解码统一**（ZCode `decodeWslOutput` + `normalizeWslOutput`）：NUL ⇒ utf16le 否则 utf8，
    再归一去 NUL/BOM/CR；`execFile/spawnSync` 用 buffer + 8MB 上限。原来 `wslPathConvert` 按 utf8 硬读。
17. **网关探测统一**（ZCode `resolveRuntimeProxy`）：**先试 loopback**（mirrored 网络模式下宿主代理就在
    WSL 的 127.0.0.1 上，命中就保留、不该换成网关）→ 否则 `ip route default via` →
    `/etc/resolv.conf` nameserver 回落（只接受私有/链路本地）→ 探活 1s。`src/daemon.ts`（跑在 WSL 里的
    独立脚本，不能 import 宿主模块）与 `src/wsl-proxy.ts` 的片段**逐字一致**，由源码级探针防漂移。
    验证：`zcode-20261022/probe-daemon-gateway.ts` 33/33（含真实 WSL 两边发现同一个网关 172.30.176.1）。

    **2026-10-22 review 补齐的三处**（此前只在 daemon 侧成立，宿主 shell 路径没有）：
    · 来源戳 `GW_SRC` 与取值写在**同一条命令**里（原来 daemon 事后用 `ip route … | grep -q .` 猜，
      遇到 `default dev eth0`（无 via）会把 resolv 的候选误标成 route，绕过校验）；
    · 校验（loopback 一律拒；resolv 只收私有/链路本地）**下沉进 shell 片段** —— 原来它只存在于
      `parseGatewayOutput`，而那个函数在生产路径上没人调用；
    · 宿主 shell 也改成 **先试 127.0.0.1 再退网关**（与 daemon、ZCode 顺序一致；mirrored 网络下代理就在
      WSL loopback，以前会以"网关不可达"失败而白白直连）。
    验证：`wsl-parity-20261022/probe-wsl-proxy.ts` 29/29（+11 条，含 6 组候选在**真 bash** 里跑校验）。

## 已关闭/已过时的旧条目

1. ~~异步探测 + 5s TTL + promise 缓存~~ —— **已完成**：`probeDistroState`/`readDistroFacts` 早已是
   `execFile` 异步 + in-flight 去重（commit 8a5bb7b），失败不写缓存；显式失效由 `snapshot({refresh:true})`
   与 `invalidateProxyCache` 提供（commit faccf21）。本条目此前写"仍是 spawnSync"是**过期描述**，已更正。
2. ~~WSL 里的代理网关探测~~ —— **已完成**（第 5 条 + 第 17 条）。
3. ~~UNC 解析~~ —— **已完成**（第 6 条，`src/unc-path.ts`）。
4. ~~生命周期纪律~~ —— **主体已完成**（第 7、10、12–15 条）。
5. ~~`decodeWslOutput` 两处实现~~ —— **已合并**（2026-10-22 review）：单一来源 `src/wsl-output.ts`，
   `explorer.ts` 与 `wsl-io.ts` 都从它取，两个原名保留为 re-export（导出面不变）。

## 仍未做（以及为什么）

1. **窗口作用域池化**（ZCode：同窗口同 distro 共享一个 server launcher，60s idle TTL）：
   DSH 的宿主是**单进程单实例**（`dsh web` 一个进程服务所有窗口），没有 ZCode 那种"每个窗口一个
   Remote Host"的分层 ⇒ 我们的 `daemon` 槽位（每 distro 一个常驻守护、多客户端 attach）在**语义上已经
   是**"同一 distro 共享一个远端 host"。**结论：这一条不抄**（抄了会引入一个 DSH 里不存在的层级）。
   保留差异：我们的守护 idle 是 10 分钟自退 + 运行时 idle 30 分钟回收，比 ZCode 的 60s 宽松（跨宿主复用优先）。
2. **有 running task 时延迟释放到 terminal**（design doc）：我们的守护本就"客户端断开 ≠ 会话结束"，
   且宿主退出时**不杀守护**；在宿主进程内，settle 的宽限已经覆盖"让子进程把收尾做完"。**未实现**
   "跟踪一次 prompt 是否在跑、跑完再释放"——当前语义下宿主退出等同于用户要它退出，延迟反而会让
   关窗变卡。若将来做"宿主热重启不打断 prompt"，再补。
3. **`-u/--user` 指定 WSL 用户**（ZCode `buildWslArgs` 支持 `-u`）：我们只有 `-d`。**未做**（无需求证据）。
4. **上传/大文件通道**（ZCode `upload()` 的 UNC 直写 + `cat >` 流式回落）：我们用 `writeScript` 落
   `/tmp` + `bash <file>`，路径不同但更贴 DSH 需要（stdin 必须留给 SDK 协议）。**不抄**。

## 结论

ZCode 与我们的路线基本同构（本地 `wsl.exe` 子进程 + 远端 server + UNC 文件访问）。两轮下来，
「解析与 `--exec`」「异步探测/缓存」「代理网关」「生命周期屏障」四块都已对齐并各自有探针；
剩下的差异只有**窗口作用域池化**（DSH 架构里不存在，故不抄）与「running task 延迟释放」（语义取舍，暂不做）。
证据索引：`spike/verify/wsl-parity-20261022/`（第一轮）+ `spike/verify/zcode-20261022/`（第二轮）。
