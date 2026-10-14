# REPORT —— T58：`stopAllDaemons` 全量语义（孤立 state 目录 + 不误停他人）

> 补齐 T3 当时**故意没在真实 state 目录上跑**的那条语义（怕误停他人守护）⇒ 本轮用**三个孤立 state 目录**等价验证：
> · `isoA = /home/g/t58-isoA`（被测：槽位 8911 / 8912 两个**本插件自己的**守护）
> · `isoB = /home/g/t58-isoB`（"不属于 A 的第三个"：槽位 8913）
> · `isoC = /home/g/t58-isoC`（空目录边界；稍后用作陈旧记录）
> **真实的 `~/.dsh` 一个字节没碰**：实验前后都确认"真实 state dir 里的 daemon.ts 进程 = 0"。

## 结论

| 场景 | `stopAllDaemons` 结果（原始） | 目标侧事后 | 第三方（isoB） |
|---|---|---|---|
| **主判据**：isoA 两活守护 | `{"ok":true,"stoppedCount":2,"killed":[],"remaining":[]}` | `scan(A)=(none)`、元数据 8911/8912 **全清**、`/tmp launch` 残留 0 | **握手 ok、pid 不变（121412）、元数据仍在** ✅ |
| **边界①**：isoC 空目录 | `{"ok":true,"stoppedCount":0,"killed":[],"remaining":[]}` | 无副作用 | 未受影响 ✅ |
| **边界②**：isoC 陈旧记录（8914 元数据在、进程被 `kill -9`） | `{"ok":true,"stoppedCount":1,"killed":[],"remaining":[]}` | 元数据 `8914:有 → 无` ✅ | 未受影响 ✅ |
| **故意红**（副本放宽 `--state-dir` 过滤到 `/home/g/t58-iso*`） | `{"ok":true,"stoppedCount":2,"killed":[{"pid":121412,"port":8913}]}` | 目标被停 | **被误停**（握手 false、pid 变、元数据没了）⇒ 断言**红** ✅ |

**机制结论（一条根因解释全部现象）**：作用域**只由 `scanDaemonProcesses()` 的 `--state-dir <本 state>` 过滤决定**（`daemon-protocol.ts:180`），
`stopDaemon` 走的是**元数据记录**。所以"`--all` 只覆盖自己 state 目录里的记录"既是元数据层的，也是进程扫描层的；
两项一起才构成 **F33 跨实例误停边界**的全量版本 —— 红态一放宽过滤，第三方立刻被 `killWslPid` 命中，说明这条边界**确实是承重墙**，不是装饰。

## 关键原始读数

**主判据（`out-02-stopall.txt`）**
```
BEFORE scan(A)=120439@8911,120834@8912 scan(B)=121412@8913 scan(C)=(none)
BEFORE A 元数据 8911:有 8912:有 8914:无；B pid=121412（元数据 pid=121412）
RESULT stopAllDaemons(stopall) => {"ok":true,"stoppedCount":2,"killed":[],"remaining":[]}
AFTER  scan(A)=(none) scan(B)=121412@8913 scan(C)=(none)
AFTER  A 元数据 8911:无 8912:无 8914:无
ASSERT A 无残留进程 = true / 元数据全清 = true / ok=true = true
ASSERT 不误停第三方（isoB）: 握手 ok=true pid 不变=true (121412 vs 121412) 元数据仍在=true
ASSERT A 目录 /tmp launch 残留 = 0
```
三个守护起来时都是 **`mode=systemd`**（无窗主路径；全程 `WT` 空、无新增可见窗口）。
无孤儿三项：**进程** `scan(A)=(none)`、**端口** 8911/8912 无监听（落在收尾的 `8911-8914 监听: 0`）、**`/tmp`** `launch.*` 残留 0。

**边界②（`out-04/05`）**：`SEED-STALE: isoC pid=128014 已 kill -9；元数据仍在 = true` → 随后 `stoppedCount:1`、`AFTER T 元数据 8914:无` ⇒ **陈旧记录会被清掉**（`stopDaemon` 在"元数据在、进程不在"时仍能收尾）。

**故意红（`out-07/08`）**
```
RED-PATCH: scanDaemonProcesses 的 state-dir 过滤已放宽到 /home/g/t58-iso*（仅自家实验目录）
BEFORE scan(T)=121412@8913,131534@8911,132074@8912     ← 第三方也被扫进来了
RESULT {"ok":true,"stoppedCount":2,"killed":[{"pid":121412,"port":8913}],"remaining":[]}
ASSERT 不误停第三方（isoB）: 握手 ok=false pid 不变=false 元数据仍在=false    ← 断言红 ✅
```
**复绿**（删副本、用真仓库重跑同一序列）：`killed:[]`、第三方 `握手 ok=true pid 不变=true (135530 vs 135530)`。
> 变异只放宽到**我自造的 `/home/g/t58-iso*`**（不放宽到真实 `~/.dsh`）⇒ 这一步即使跑红也不会碰到任何他人的守护。

## 无孤儿 / 隔离 / 收尾

- 收尾：`daemon.ts 进程 0`、`dsh-rwsl units 0`（含 `reset-failed`）、`failed 0`、`is-system-running = running`、
  `8911-8914 监听 0`、`/tmp dsh-rwsl 残留 0`、**更 isolated 目录已删**、**真实 state dir 里的他人守护 0**（实验前后都 0）、**无 WindowsTerminal**。
  （注：cleanup 探针打印的那次 `/tmp launch 残留 = 3` 是**清理前**的中间读数——三个孤立目录各一份；随后的 shell 收尾删目录 + 按 winpid 清 `/tmp` ⇒ 最终 0。）
- 未跑任何 npm/pnpm；端口只用 8911–8914（隔离目录内）；未碰 19387（pid 33688）/用户窗口。
- `git status --porcelain -- src/ client/ package.json` = **0 条**（本轮只写证据目录）。

## 故意红（≥1）

见上（副本放宽 state-dir 过滤 ⇒ "不误停第三方"断言红 ⇒ 字节还原/换回真仓库后复绿）。

## 【一旦错了就得返工】

1. **"不误停第三方"必须验到，而且必须是进程层**：元数据层看起来"只处理自己的槽位"很容易让人以为安全，
   但 `--all` 还会 `scanDaemonProcesses()` + `killWslPid()` —— 这条路径的作用域完全取决于脚本里的 `--state-dir` 匹配。
   红态证明：一旦放宽，第三方会被真杀。⇒ 判据必须是"第三方**握手仍 ok 且 pid 不变**"，不是"元数据还在"。
2. **陈旧记录与空目录是两种不同边界**：空目录只能证明"不炸"；陈旧记录才证明"元数据在、进程不在"时能收干净。
   我第一版把 stale 记录种在 isoC 却打 isoA ⇒ 等于又测了一遍空目录（**夹具 bug**，已改并重跑）；
   教训：**造状态的目标目录与执行的目标目录必须同一个**，否则断言会在"什么都没发生"的路径上假绿。
3. **真实 `~/.dsh` 下跑 `--all` 的语义本轮故意未验**（会误停他人守护）——本轮用孤立目录等价验证；
   若将来要验，必须挑"本机确实没有他人守护"的时刻（本轮基线恰好是 0，但仍选择不碰）。

## 【其余的】

- `stopAllDaemons` 的三段实现（逐槽位 `stopDaemon` → legacy 记录 → `scanDaemonProcesses` 兜底 + `launch.*.sh` 清理）在四组读数里都走通了；`ok` 由"事后 `scan` 是否为空"决定，本轮四组都是 `true`。
- 收尾按 winpid 归属清 `/tmp`（不是标题猜）；孤立目录用 `rm -rf` 按绝对路径核对后删除。

## 未复核：5 条

1. **`legacy` 单文件记录分支**（`readDaemonRecord(cfg)` 的过渡期路径）未构造 —— 需要人工造一个单文件记录才会走到。
2. **`remaining.length > 0` ⇒ `ok:false`** 那条分支未构造（要有"杀不掉的守护"，例如身份闸拒绝杀 / D 状态进程）。
3. **真实 `~/.dsh` 目录**上跑 `--all`（尤其"目录里有他人守护"的组合）**故意未验**，也不建议在本机验。
4. **`killed` 分支的正常态构造**：本轮只在红态看到 `killed:[{pid:121412}]`；**没有**在正常态造一个"有进程、无元数据"的孤儿来验证 `killed` + `sleep(900)` 后的 `remaining` 判定。
5. **`launch.<slot>.sh.tmp` 半截文件**的清理（清理正则含 `.tmp`）未构造。

## 证据文件（`spike/verify/explorer-20261012/arch-t58/`）

`REPORT-stopall-semantics.md`、`out-01-setup.txt`、`out-02-stopall.txt`（主判据）、`out-03-empty.txt`（空目录）、`out-04-seed-stale.txt` + `out-05-stale.txt`（陈旧记录）、`out-06-setup2.txt`、`out-07-red-patch.txt` + `out-08-red-stopall.txt`（故意红）、`out-09-setup3.txt` + `out-10-green-stopall.txt`（复绿）、`out-11-cleanup.txt`、`out-12-dumpconfig.txt`；脚本 `probe-t58.ts`。
