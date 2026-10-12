# 法证：17:44:10 的 8731 守护 + 为什么它"活着却没有元数据"

## 1. 事实链（原始出处）

1. `daemon.log:2253` — `[daemon pid=1026481 2026-10-12T09:44:10.920Z] listening 127.0.0.1:8731 pid=1026481 dsh@0.2.0-rc.2 cwd=/home/g idleMs=1800000 queue=4 lingerMs=600000`
   ⇒ 守护启动时刻 = **2026-10-12T09:44:10.920Z = 17:44:10 本地**（与 lead 给的窗口启动时间同秒）。
2. `daemon.log:2254` — `已清理启动脚本 /home/g/.dsh/remote-wsl/launch.8731.sh`（守护起来后自删包装层，属设计）。
3. `daemon.log:2255-2257` — peer **`win-pid-44496`**：先断开、再 `recv op=status id=1`、再断开。
4. 该守护一生共收到 `op=status` ×12、`op=shutdown` ×1（后者 = lead 那次成功 stop）。
5. 状态目录（现在）：`daemon.log`(0600) + `launch-stderr.log`(0600)。**没有** `daemon.8731.json` / `.token` / pin。
6. lead 观察：**停它之前**状态目录里就没有它的元数据 ⇒ "活着的孤儿"。

## 2. 机制：这个现象是 `selftest reclaim` 的**故意夹具**

`src/selftest.ts`：

- `321: if (cmd === 'reclaim') {`
- `324: const port = Number(argv[1] ?? cfg.daemonPort);` ← **不传 `--port` 时 = `cfg.daemonPort`（无覆盖的 profile = 默认 8731）**
- `333: spawn(process.execPath, [self, 'ensure', '--port', String(port), '--isolated'])` ← 夹具**自己起一个真守护**（经插件 `launchDaemon` ⇒ 会生成 `launch.<port>.sh`）
- `340-342: const beforeRec = readDaemonRecord(cfg, port); const orphanPid = Number(beforeRec?.meta?.pid); const orphanListens = listenCount(port) === '1';`
- `349: wslRunScript(cfg, \`rm -f ${stateDir}/daemon.${port}.json ${stateDir}/daemon.${port}.token ${stateDir}/daemon.${port}.json.tmp\`)`
- `350: say('# BEFORE 元数据已删（进程 ${orphanPid} 仍活着、端口仍占着）')`
- `354: const e = await ensureDaemon(...)` ← 夹具随后**要求** ensure 复用/收掉这个孤儿

⇒ 只要有人在该 profile（无 `daemonPort` 覆盖）上跑 **`reclaim`**（不显式给 `--port`），就会**按设计**：
在 **8731** 起一个真守护 → **删掉活守护的元数据** → 得到"活着但无元数据"的孤儿。
若该次夹具在 `349` 之后被中断/失败（例如夹具自己 `exit 1`、或操作者中断），孤儿就会**留在原地** —— 与 lead 看到的状态完全一致。

**结论（③ 的第一问）**：这不是"某条清理路径的偶发越界"，而是**测试夹具的既定副作用**（`selftest.ts:324/333/349`）。
**但它不该在共用默认槽位上做**：夹具会真的起守护并真的删元数据 ⇒ **测试卫生问题**（应先显式 `--port`，或夹具改用临时槽位）。
`stop --port 8731` 仍能按端口找到并停掉它，是因为 `scanDaemonProcesses()` **读 `/proc/<pid>/cmdline` 认身份，不依赖元数据** —— 这点是**好的**（孤儿可发现、可回收）。

## 3. 顺带发现：确实**存在**一条能自动产生同款孤儿的无条件路径（P1 候选，不改代码）

`src/daemon-client.ts`：

- `216: function removeMetaFiles(cfg, slot = cfg.daemonPort, legacy = false)` —— 只清**指定槽位**（注释 215 明确"绝不动别的槽位"）✔
- `648-668: stopDaemon()`：
  - `660-665` 发 `op:'shutdown'`
  - `667: if (!r.ok) killWslPid(cfg, rec.meta?.pid);`
  - `668: removeMetaFiles(cfg, rec.slot, rec.legacy);` ← **无条件**（不看 shutdown 是否成功、也不看 kill 是否真的把进程收掉）
- `319-326: killWslPid()` —— **身份闸**：`if [ -r /proc/<p>/cmdline ] && ... grep -q 'daemon\.ts'; then kill -TERM <p>; fi`
  ⇒ 身份校验**可能拒绝杀**（cmdline 不含 `daemon.ts`、pid 已变、或 TERM 被忽略/竞态），而 `killWslPid` **不等待、不验证**退出。
- 于是：`shutdown` 不成功 → `killWslPid` 可能没杀掉 → **元数据已被 `668` 删掉** ⇒ **活的守护 + 无元数据**。
- 同款形状还有 `618: removeMetaFiles(cfg, port)`（ensure 失败兜底；那里前面 613-616 先杀，风险较低）。

**结论（③ 第二问）**：`stopDaemon` 的清元数据**缺少"确认进程已消失"的后置条件** ⇒ 能产生"活着但无元数据"的孤儿。
建议（不改代码，只记 P1）：`668` 前置/后置改为"重新扫描 `/proc` 确认该槽位无本方守护后才清元数据"。
**本次 8731 的具体成因**：日志显示它在被 lead 停掉**之前**从未收到 `op=shutdown`（唯一一次 shutdown 就是 lead 那次成功 stop），
所以"停到一半失败"这条**对本次不成立**；本次最匹配第 2 节的夹具路径（夹具的元数据删除**不留日志**）。
两条结论互不冲突：本次 = 夹具；机制上存在的自动路径 = P1 候选。
