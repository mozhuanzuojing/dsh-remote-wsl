/**
 * daemon-lifecycle.ts —— T3 拆分自 `daemon-client.ts`（1068 行）的 **生命周期层**：ensure/stop/snapshot/status 与孤儿判定（`daemonSnapshot` 仍是唯一孤儿真相源）。
 *
 * 来源：`src/daemon-client.ts` @ sha256 cb420d25ef1bcf9535cbf2f3dbb3faad95fa0d5321b31d0ca798103de59dbed1（原文件已备份到
 * `spike/verify/explorer-20261012/arch-t3/backup/daemon-client.cb420d25.ts.bak`）。
 * **代码逐字搬移**（由 `arch-t3/tools/apply-split.ts` 按行区间生成），未改写实现。
 * 导出：`ensureDaemon`/`stopDaemon`/`stopAllDaemons`/`daemonSnapshot`/`daemonStatus`；`removeMetaFiles`/`ownDaemonsOnPorts`/`recordForPid`/`waitForSlotGone` 保持模块内私有。
 *
 * ★★ F-50（2026-10-27 审查）：本文件所有 `/proc` 扫描的调用点都必须区分「扫描失败」与「没有进程」——
 * `scanDaemonProcessesAsync` 现在返回 `{ ok, procs, error? }`。纪律（违反即回归）：
 *   · `ok:false` ⇒ **绝不**删元数据、**绝不**判死、**绝不**对任何 pid 发信号；
 *   · 需要"结论"的地方（stop 是否停干净、stop --all 是否全清、有没有孤儿）必须把
 *     `ok:false` 表达成「未验证 / ok:false」，不许退化成伪成功。
 *
 * 零构建纪律：只用可擦除语法；相对导入带 `.ts`；只引 `node:` 内置与同目录相对模块。
 */
import { readdirSync, rmSync } from 'node:fs';
import {
  callDaemon, handshake, legacyMetaLinux, legacyTokenLinux, listDaemonSlots, metaLinux, readDaemonLogTail, readDaemonRecord,
  releaseEnsureLock, scanDaemonProcessesAsync, sleep, stateDirLinux, tcpProbe, tokenLinux,
  tryAcquireEnsureLock, unc,
} from './daemon-protocol.ts';
import { configCompat, killWslPidAsync, launchDaemon, removeLauncher } from './daemon-launch.ts';
import { assertConfigTarget, targetProblem } from './config.ts';
import { asConfigText } from './target-detect.ts';

// ── 原 daemon-client.ts 第 216-235 行 ──
function removeMetaFiles(cfg, slot = cfg.daemonPort, legacy = false) {
  const paths = legacy
    ? [legacyMetaLinux(cfg), `${legacyMetaLinux(cfg)}.tmp`, legacyTokenLinux(cfg)]
    : [metaLinux(cfg, slot), `${metaLinux(cfg, slot)}.tmp`, tokenLinux(cfg, slot)];
  for (const p of paths) {
    try {
      rmSync(unc(cfg.distro, p), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 一次连接、一次交换：写若干帧，读到"目标帧"即为结果。
 * `skipHello`（默认 true）：跳过协议里的 hello 回包，等真正的 op 结果；
 * 握手场景必须传 false —— 那时 hello 回包**就是**结果（否则只能靠超时判定，白等 3s）。
 * 超时是**快速失败**的关键：对端是陌生属主时它不会按协议回话，只能靠超时判定。
 * @returns {Promise<{ok:boolean, msg?:object, kind:string, error?:string, ms:number}>}
 */

// ── 原 daemon-client.ts 第 619-624 行 ──
/**
 * 扫出"占着这些端口（或元数据槽位）的本插件守护"（异步版：不阻塞宿主事件循环，F-15）。
 *
 * ★ F-50：返回 `{ ok, procs, error? }` 而不是裸数组 —— 调用方拿到的如果只是空数组，
 * 就分不清「端口确实空着」和「扫描失败所以什么都不知道」，后者再往下走就会变成
 * 「又起一个、把上一个留成无元数据孤儿」或者「对未知进程发信号」。
 */
async function ownDaemonsOnPorts(cfg, ports) {
  const want = new Set(ports.map(Number));
  const scan = await scanDaemonProcessesAsync(cfg);
  if (!scan.ok) return { ok: false, procs: [], error: scan.error };
  const procs = scan.procs.filter((p) => (p.port != null && want.has(p.port)) || (p.metaPort != null && want.has(p.metaPort)));
  return { ok: true, procs };
}

/**
 * 轮询抢占启动锁（2026-10-27 审查 F-05）：拿不到就等，最多 `waitMs`。
 * 为什么要等而不是直接失败：并发方只是**同一个槽位**的启动，等它起好后复用比"两个都起"安全得多。
 */
async function acquireEnsureLockWithWait(cfg, slot, { waitMs = 45000, log = () => {}, notes = [] } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await tryAcquireEnsureLock(cfg, slot)) return true;
    if (Date.now() - t0 >= waitMs) {
      notes.push(`启动锁 ${slot} 在 ${waitMs}ms 内未取得（另一个宿主可能正在同一槽位启动）`);
      return false;
    }
    await sleep(400);
  }
}

/**
 * 另一个宿主持有启动锁时，等它的守护就绪 —— 判据仍是 Windows 侧 `hello+token`（不看 listening 日志）。
 * 返回 `{ rec, hs }`；超时返回 `null`。
 */
async function waitForSlotReady(cfg, slot, hsTimeout, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const rec = readDaemonRecord(cfg, slot);
    if (!rec) continue;
    const hs = await handshake(cfg, rec.meta?.port ?? rec.slot, rec.token, hsTimeout);
    if (hs.ok) return { rec, hs };
  }
  return null;
}

/** 元数据里记的 pid 恰好是某进程的那些记录（用于判断"占着端口的是不是一个有元数据的活守护"）。 */

// ── 原 daemon-client.ts 第 625-641 行 ──
function recordForPid(cfg, pid) {
  for (const slot of listDaemonSlots(cfg)) {
    const rec = readDaemonRecord(cfg, slot);
    if (rec && Number(rec.meta?.pid) === Number(pid)) return rec;
  }
  return null;
}

/**
 * 确保有一个**在 Windows 侧真实可达**的守护。
 *
 * 语义 #8（单实例幂等）：**只复用调用方自己槽位（`cfg.daemonPort`）的守护**，不碰别的槽位
 * （task-9 追加 D：以前"复用同状态目录里任意活守护"会静默忽略调用方配的端口/idle）。
 * 缺陷 #11：就绪判据 = Windows 侧 hello+token 拿到身份应答；失败则清影子守护 + 换端口（`daemonPortTries` 次）。
 * task-9 追加 A/B：请求槽位上若已有**本插件**的守护（有元数据的活守护 ⇒ 复用；无元数据的孤儿 ⇒ 先收掉），
 * 绝不允许"又起一个、把上一个留在那儿" —— 那正是"3 守护/2 请求""slot≠actualPort""孤儿占端口"的同族根因。
 */

// ── 原 daemon-client.ts 第 642-854 行 ──
export async function ensureDaemon(cfg, { version, restart = false, noReuse = false, log = () => {} }: any = {}) {
  // 2026-10-28（零配置）：没有确定的目标发行版/家目录 ⇒ 状态目录与 `wsl -d` 都无处可去。
  // 在**唯一入口**抛出可操作错误（而不是让 launchDaemon 在 UNC 层报 errno）。
  assertConfigTarget(cfg);
  const notes = [];
  const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
  const wantSlot = Number(cfg.daemonPort) || 8731;
  const adopt = (rec, hs, reused) => {
    const compat = configCompat(cfg, hs.info, version);
    // 换角度评审第 1 条：插件/协议版本错配要在**结果里可见**（notes + 机器可读字段），
    // 否则用户只能从"某个新功能不工作"反推。soft 不阻断复用，但必须写明 restart 才生效。
    if (compat.plugin) {
      const older = compat.plugin.protocolDaemon == null || compat.plugin.protocolDaemon < compat.plugin.protocolHost;
      if (older || (compat.plugin.daemon && compat.plugin.daemon !== compat.plugin.host)) {
        notes.push(
          `版本: 守护插件 ${compat.plugin.daemon ?? 'unknown'} / 协议 v${compat.plugin.protocolDaemon ?? 0}，` +
            `宿主 ${compat.plugin.host} / 协议 v${compat.plugin.protocolHost} ⇒ 新功能在 restart 前不可用（wsl_daemon action=restart）`,
        );
      }
    }
    return {
      ok: true,
      port: hs.info.port,
      slot: rec.slot,
      info: hs.info,
      token: rec.token,
      meta: rec.meta,
      reused,
      started: !reused,
      notes,
      // F-38c（task-19）：`mode`/`warning` 是**机器可读字段**。
      // 复用既有守护时没有"启动方式"这回事 ⇒ `mode: 'reused'`、`warning: null`（下面复用分支会覆盖成这个值）。
      mode: 'reused',
      warning: null,
      versionMismatch: compat.version,
      // 换角度评审第 1 条：机器可读版本字段（旧守护的守护侧字段会是 null/0）。
      pluginMismatch: compat.plugin,
      configHardMismatch: compat.hard,
      configSoftMismatch: compat.soft,
    };
  };

  if (!restart && !noReuse) {
    // 1) 只认**自己槽位**的记录（+ 过渡期单文件记录，且它必须就监听在配置端口上）
    const candidates: any[] = [];
    const slotRec = readDaemonRecord(cfg, wantSlot);
    if (slotRec) candidates.push(slotRec);
    const legacy = readDaemonRecord(cfg);
    if (legacy?.legacy && Number(legacy.meta?.port) === wantSlot) candidates.push(legacy);
    for (const rec of candidates) {
      let hs = await handshake(cfg, rec.meta?.port ?? rec.slot, rec.token, hsTimeout);
      if (!hs.ok && hs.kind === 'timeout') {
        // F-06（2026-10-27 审查）：单次 3s 握手超时**不等于**守护死了。守护是单线程，provision/预热
        // 里的 `spawnSync(curl)` 能把它按住几十秒；旧实现在这里直接 kill + 删元数据 ⇒ 把"忙"当"死"，
        // 杀掉带会话的健康守护。现在先做**二次探测**（更长超时）；仍然超时就如实报错、**不杀不重启**，
        // 让用户决定（稍后重试，或显式 `wsl_daemon action=stop`）。
        notes.push(`自己槽位 ${rec.slot} 第一次握手超时（${hs.ms}ms）⇒ 二次探测（${hsTimeout * 2}ms，不立即杀）`);
        hs = await handshake(cfg, rec.meta?.port ?? rec.slot, rec.token, hsTimeout * 2);
        if (!hs.ok && hs.kind === 'timeout') {
          const port = Number(rec.meta?.port ?? rec.slot);
          const probe = await tcpProbe(port, 800);
          const busy = probe.open === true;
          return {
            ok: false,
            notes,
            tried: [rec.slot],
            mode: null,
            warning: null,
            error:
              `远端守护（槽位 ${rec.slot} / 端口 ${port}）在 ${hsTimeout * 3}ms 内没有应答` +
              `${busy ? '，但端口仍可连接 ⇒ 它可能正在安装工具/预热，属于「忙」而不是「死」' : '，端口也不可连接'}` +
              `。为避免杀掉带会话的守护，本次**不杀、不重启、也不另起一个**。请稍后重试；` +
              `确需强制结束请用 wsl_daemon action=stop（会丢弃会话上下文）。`,
          };
        }
      }
      if (hs.ok) {
        const compat = configCompat(cfg, hs.info, version);
        if (compat.hard.length) {
          // 结构性不兼容 ⇒ 明确报错（不静默复用、也不偷偷另起一个占着别人会话的守护）
          return {
            ok: false,
            notes,
            error:
              `远端守护（槽位 ${rec.slot} / 端口 ${hs.info.port}）与本次配置**结构性不兼容**：${compat.hard.join('、')}。` +
              `复用会让会话跑在错误的工作目录/插件集上。请显式执行 wsl_daemon action=restart 以新配置重启，或改用另一个 config.daemonPort。`,
          };
        }
        if (hs.info.port !== wantSlot) {
          notes.push(`请求槽位 ${wantSlot} 在 WSL 侧被占：该守护实际监听 ${hs.info.port}（元数据 daemon.${rec.slot}.json）`);
        }
        notes.push(`复用自己槽位 ${rec.slot} 的守护：端口 ${hs.info.port}，Windows 侧握手 ${hs.ms}ms 通过`);
        if (compat.soft.length) notes.push(`注意：守护参数与本次配置不同（${compat.soft.join('、')}）—— 已复用，未静默忽略；要应用新值请 wsl_daemon action=restart`);
        return adopt(rec, hs, true);
      }
      const why = hs.kind === 'timeout' ? `握手 ${hs.ms}ms 超时（该端口可能被 Windows 侧别的属主占用）` : hs.kind === 'refused' ? '连接被拒（守护已死，元数据是陈的）' : `握手失败(${hs.kind}: ${hs.error})`;
      notes.push(`自己槽位 ${rec.slot} 复用失败：${why}`);
      log(`daemon reuse failed on own slot ${rec.slot}: ${why}`);
      // 只有"确证不是我们的守护/已死"才清理；走到这里说明二次探测也没超时（timeout 已提前返回）。
      if (rec.meta?.pid) await killWslPidAsync(cfg, rec.meta.pid);
      removeMetaFiles(cfg, rec.slot, rec.legacy);
    }
    // 2) 别的槽位的活守护：**只报告、绝不复用**（否则等于静默忽略调用方配的端口）
    for (const slot of listDaemonSlots(cfg)) {
      if (Number(slot) === wantSlot) continue;
      const rec = readDaemonRecord(cfg, slot);
      if (!rec) continue;
      const hs = await handshake(cfg, rec.meta?.port ?? slot, rec.token, hsTimeout);
      if (hs.ok) {
        notes.push(`另有守护在槽位 ${slot}（端口 ${hs.info.port}）—— 不属于本次配置（daemonPort=${wantSlot}），未复用、未打扰`);
      } else {
        await killWslPidAsync(cfg, rec.meta?.pid);
        removeMetaFiles(cfg, slot, rec.legacy);
        notes.push(`清理了失联的槽位 ${slot}`);
      }
    }
  } else {
    const stopped: any = await stopDaemon(cfg, { log, slot: wantSlot }).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
    if (!stopped || stopped.ok === false) {
      // F-19（2026-10-27 审查）：旧实现不看 stop 结果就继续起新守护 —— 旧守护变孤儿、新守护 +1 迁移、
      // 槽位元数据被覆盖，输出里还写着"已停"。restart 必须"停干净才起"。
      // F-50：`verified === false` 是"复核失败（无法确认是否停干净）"，与"确认还在跑"要分开说，
      // 但**结论相同**：都不许继续启动（否则可能两个守护并存 / 覆盖元数据）。
      const why = stopped?.verified === false ? '无法确认是否已停干净（/proc 扫描失败）' : '旧守护没有停干净';
      return {
        ok: false,
        notes,
        tried: [wantSlot],
        mode: null,
        warning: null,
        error:
          `restart 中止：${why}（${stopped?.error ?? '未知原因'}）。` +
          `继续启动会留下孤儿并覆盖元数据，所以本次不启动。请稍后重试，或先执行 wsl_daemon action=stop。`,
      };
    }
    notes.push(`restart: 已停本槽位守护（${stopped.reaped?.length ?? 0} 个运行时被回收）`);
  }

  const tries = Math.max(1, Number(cfg.daemonPortTries) || 3);
  const tried = [];
  let last = notes.join('；');
  /**
   * ★★ F-38a（task-19）：失败路径**必须回收本次所有尝试槽位**写下的启动脚本。
   * 为什么：端口回退会为每个尝试过的槽位各写一个 `launch.<slot>.sh`；一旦守护没起来，
   * "起来后自删"就不会发生 ⇒ T18 实测 `=on` + 托管失败时留下 `launch.8936.sh`/`launch.8937.sh`。
   * 成功路径语义不变（脚本由守护自己删；这里只清理**没起来**的那些）。
   */
  const reclaimLaunchers = (ports) => {
    for (const p of ports) {
      if (removeLauncher(cfg, p)) notes.push(`回收启动脚本 launch.${p}.sh（该槽位未起来，避免残留）`);
    }
  };
  // ★ F-05（2026-10-27 审查）：启动段必须互斥。没有锁时，两个宿主（或同一轮的两次并行工具调用）会同时
  // 判"无守护"并各自启动 —— 槽位的 token / launch 脚本 / 元数据是三份**共享文件**，后写覆盖先写；随后
  // "无元数据 ⇒ 先收掉"的分支会杀掉对方刚起的、带着会话的健康守护。锁只覆盖"启动"这一段（复用路径不加锁，
  // 避免把最常用路径变慢）；崩溃残留由锁自身的 mtime 判定自愈（120s 后视为陈旧）。
  const lockSlot = wantSlot;
  const lockWaitMs = Math.max(0, Number(cfg.daemonLockWaitMs ?? 45000));
  const gotLock = await acquireEnsureLockWithWait(cfg, lockSlot, { waitMs: lockWaitMs, log, notes });
  if (!gotLock) {
    const waited = await waitForSlotReady(cfg, lockSlot, hsTimeout, Math.max(5000, Number(cfg.daemonStartTimeoutMs ?? 20000)));
    if (waited) {
      notes.push(`并发启动：另一个宿主已完成槽位 ${lockSlot}（端口 ${waited.hs.info.port}）⇒ 复用，未重复启动`);
      return adopt(waited.rec, waited.hs, true);
    }
    return {
      ok: false,
      notes,
      tried: [lockSlot],
      mode: null,
      warning: null,
      error:
        `槽位 ${lockSlot} 的启动锁被另一个宿主持有超过 ${lockWaitMs}ms，且期间没有出现可复用的守护；` +
        `本次**未启动**（避免两个守护互相覆盖元数据/互杀）。稍后重试，或改用另一个 config.daemonPort。`,
    };
  }
  let lockReleased = false;
  /**
   * 释放启动锁（幂等）。2026-10-27 换角度评审第 4 条：启动段现在整段包在 `try/finally` 里，
   * **任何出口（含异常）都会释放**；锁自带的 mtime 自愈只兜"进程被硬杀"这种 finally 跑不到的情况。
   */
  const releaseOnce = async () => {
    if (lockReleased) return;
    lockReleased = true;
    await releaseEnsureLock(cfg, lockSlot, log);
  };
  try {
    // 双检（double-checked）：拿锁期间并发方可能已经起好了 —— 绝不再起第二个。
    {
      const recheck = readDaemonRecord(cfg, lockSlot);
      if (recheck) {
        const hs = await handshake(cfg, recheck.meta?.port ?? recheck.slot, recheck.token, hsTimeout);
        if (hs.ok) {
          notes.push(`启动锁内复核：槽位 ${lockSlot} 的守护已由并发方就绪（端口 ${hs.info.port}）⇒ 复用，未起第二个`);
          return adopt(recheck, hs, true);
        }
      }
    }
    for (let i = 0; i < tries; i++) {
      const port = wantSlot + i;
      tried.push(port);

      // ★ A/B 修复：起之前先看这个槽位/端口上有没有**本插件自己的**守护在跑
      const occupancy = await ownDaemonsOnPorts(cfg, [port]);
      // ★★ F-50：扫描失败时**一个都不杀**（旧实现拿空数组当"端口空着"⇒ 对未知进程发信号的风险）。
      // 这里不改判"是否继续启动"：就绪判据始终是 Windows 侧握手，失败也只是多一次端口迁移；
      // 但"我们没看见占用者"这件事必须留在 notes 里，不能让上层以为端口确认是空的。
      if (!occupancy.ok) {
        notes.push(
          `⚠️ 无法扫描 /proc 判断端口 ${port} 的占用者（${occupancy.error ?? '未知原因'}）` +
            ` ⇒ 未杀任何进程、未据此清理元数据；若端口确有本插件守护，新守护可能迁移到下一个端口`,
        );
      }
      const occupants = occupancy.procs;
      for (const o of occupants) {
        const rec = recordForPid(cfg, o.pid);
        if (rec) {
          const hs0 = await handshake(cfg, rec.meta?.port ?? rec.slot, rec.token, hsTimeout);
          if (hs0.ok) {
            // 身份相符的活守护 ⇒ 复用它，**绝不起第二个**
            notes.push(`槽位 ${port} 上已有身份相符的活守护 pid=${o.pid}（端口 ${hs0.info.port}）⇒ 复用，未起第二个`);
              return adopt(rec, hs0, true);
          }
        }
        notes.push(`槽位 ${port} 上发现**无元数据/失联**的本插件守护 pid=${o.pid} ⇒ 先收掉再起（不留孤儿）`);
        await killWslPidAsync(cfg, o.pid);
      }
      if (occupants.length) await sleep(900); // 等它退出，让端口真的空出来（否则守护会 +1 迁移）

      // 清掉**陈旧元数据**（文件在、但上面那个 pid 已经不在进程表里）：否则下面的轮询会一直握到一个死 pid，
      // 白等满 daemonStartTimeoutMs（实测过：进程表里没有它，但文件还在 ⇒ 20s 假等）。
      //
      // ★★ F-50：这条清理必须**有证据**才做 —— `scan.ok === true` 且 pid 确实不在扫描结果里。
      // 旧实现把"扫描失败"当"进程表为空"，于是每一次扫描失败都会删掉活守护的元数据（= 隐形孤儿）。
      const stale = readDaemonRecord(cfg, port);
      if (stale) {
        const scan = await scanDaemonProcessesAsync(cfg);
        if (!scan.ok) {
          notes.push(
            `⚠️ 保留槽位 ${port} 的元数据：无法扫描 /proc 确认 pid ${stale.meta?.pid} 是否还在（${scan.error ?? '未知原因'}）`,
          );
        } else if (!scan.procs.some((p) => p.pid === Number(stale.meta?.pid))) {
          notes.push(`清掉槽位 ${port} 的陈旧元数据（记录里的 pid ${stale.meta?.pid} 已不在进程表）`);
          removeMetaFiles(cfg, port);
        }
      }

      const launched = launchDaemon(cfg, port, version, log);
      if (!launched.ok) {
        last = launched.error;
        notes.push(`端口 ${port}: ${launched.error}`);
        // ★ F-38a：启动环节就失败（例如 `=on` 拒绝回退）⇒ 这一轮写下的启动脚本必须立刻回收
        reclaimLaunchers([port]);
        continue;
      }
      // F-37 双约束（task-17）：把"走的是哪条启动路径"如实带回调用方 ——
      // systemd 主路径无事；兼容回退**必须**让告警一路浮到工具输出（不许静默降级）。
      if (launched.mode === 'systemd') {
        notes.push(`启动方式: systemd-run --user（unit ${launched.unit}；包装层短命 ⇒ 无窗口，且与 Windows 侧生死解耦）`);
      } else if (launched.mode === 'compat-detached') {
        notes.push('启动方式: 兼容 spawn（detached:true + windowsHide:true）—— 见上面那条告警');
      }
      if (launched.warning) notes.push(launched.warning);
      const deadline = Date.now() + Number(cfg.daemonStartTimeoutMs ?? 20000);
      let hs = null;
      while (Date.now() < deadline) {
        await sleep(250);
        const rec = readDaemonRecord(cfg, port);
        if (!rec) continue;
        hs = await handshake(cfg, rec.meta.port ?? port, rec.token, hsTimeout);
        if (hs.ok) {
          if (hs.info.port !== port) {
            // 守护在 WSL 侧做了 +1 迁移：必须说清楚（并在可能时指出占用者）。
            // ★ F-50：扫描失败 ⇒ 只能说"无法确认占用者"，不能说"非本插件进程"（那是把失败当结论）。
            const who = await scanDaemonProcessesAsync(cfg);
            const holder = who.ok ? who.procs.filter((p) => p.port === port) : [];
            const holderText = !who.ok
              ? `占用者未验证：/proc 扫描失败（${who.error ?? '未知原因'}）`
              : holder.length
                ? `占用者 pid=${holder.map((h) => h.pid).join(',')}`
                : '非本插件进程';
            notes.push(`WSL 侧端口 ${port} 已被占（${holderText}）⇒ 守护实际监听 ${hs.info.port}`);
          }
          notes.push(`槽位 ${port} 由 Windows 侧握手确认就绪（实际端口 ${hs.info.port}，${hs.ms}ms）`);
          // ★ F-38c（task-19）：`mode`/`warning` 作为**机器可读字段**随结果返回（notes 照旧保留）。
          const ready = adopt({ slot: port, meta: rec.meta, token: rec.token }, hs, false);
          ready.mode = launched.mode ?? null; // 'systemd' | 'compat-detached'
          ready.warning = launched.warning ?? null; // 回退时非空字符串；主路径为 null
          return ready;
        }
        if (hs.kind === 'refused') {
          // 元数据存在但守护已死（pid 不在进程表）⇒ 清掉再等新守护写自己的，别把 20s 白等在一个死 pid 上。
          // ★★ F-50：`refused` 只证明"端口上没人在听"，**不证明**这个 pid 死了（守护可能还没 bind、
          // 或 pid 被复用）。所以删元数据必须**另有证据**：扫描成功 + pid 确实不在列表里；
          // 扫描失败 ⇒ 保留元数据（宁可多等一轮，也不制造"元数据已删、进程还在"的隐形孤儿）。
          const scan = await scanDaemonProcessesAsync(cfg);
          if (!scan.ok) continue;
          if (!scan.procs.some((p) => p.pid === Number(rec.meta?.pid))) removeMetaFiles(cfg, port);
          continue;
        }
        // F-06：超时不再立刻判定失败 —— 守护可能只是慢（冷启动 / 事件循环被按住）；继续轮询到 deadline。
        // 只有"端口被别的属主占用/应答不是我们的协议"才立刻放弃。
        if (hs.kind === 'unauthorized' || hs.kind === 'garbage') break;
      }
      const why = hs ? `${hs.kind}（${hs.ms}ms）` : '元数据未出现';
      notes.push(`槽位 ${port} 未通过 Windows 侧就绪判据：${why}`);
      log(`slot ${port} not ready from Windows side: ${why}`);
      const rec2 = readDaemonRecord(cfg, port);
      if (rec2?.meta?.pid) await killWslPidAsync(cfg, rec2.meta.pid);
      // 兜底：即使元数据没写成，也按 /proc 身份扫描把这个端口上的自家守护收掉。
      // ★★ F-50：扫描失败时**不能**当成"扫过了、没有残留" —— 只记一条告警，不杀任何进程，
      // 也不据此把元数据删成隐形（删元数据另走 removeMetaFiles，前提是我们已知这个槽位没起来）。
      const leftovers = await ownDaemonsOnPorts(cfg, [port]);
      if (!leftovers.ok) {
        notes.push(
          `⚠️ 槽位 ${port} 的残留进程未验证：/proc 扫描失败（${leftovers.error ?? '未知原因'}）` +
            ` ⇒ 未对任何进程发信号；该槽位可能仍有本插件守护在跑（可用 wsl_daemon action=status 复核）`,
        );
      }
      for (const o of leftovers.procs) await killWslPidAsync(cfg, o.pid);
      if (rec2 || leftovers.procs.length) await sleep(700);
      // ★★ F-50：删元数据的**唯一**前提是「扫描成功且确实没有本方守护残留」。
      // 扫描失败时保留元数据 —— 宁可让上层看到一条指向失败槽位的记录（可发现、可再 stop），
      // 也不要制造"元数据已删、进程还在"的隐形孤儿。
      if (leftovers.ok) {
        removeMetaFiles(cfg, port);
      } else {
        notes.push(`⚠️ 槽位 ${port} 的元数据已保留（扫描失败 ⇒ 无法确认是否已无本方守护）`);
      }
      // ★ F-38a：该槽位没起来 ⇒ 回收**这个槽位**的启动脚本（成功路径由守护自删，语义不变）
      reclaimLaunchers([port]);
      last = `槽位 ${port} ${why}`;
    }

    const tail = readDaemonLogTail(cfg, 6);
    // ★ F-38a：整轮都失败 ⇒ **兜底回收所有尝试过的槽位**的启动脚本（它们全都"没起来"，不会自删）
    reclaimLaunchers(tried);
    return {
      ok: false,
      notes,
      tried,
      // F-38c：失败时也给出这两个字段（调用方不必解析 notes 即可判定"没起来/没回退"）
      mode: null,
      warning: null,
      error:
        `远端守护在 Windows 侧不可达：试过端口 ${tried.join(', ')} —— ${last}。` +
        `这些端口在 Windows 命名空间里可能被别的程序占用（WSL 侧 bind 成功不代表 Windows 侧能连上）。` +
        `请释放其中一个端口，或把 config.daemonPort 指到别的端口。` +
        (tail ? `\ndaemon.log 尾部:\n${tail}` : ''),
    };
  } finally {
    await releaseOnce();
  }
}

/**
 * 有界等待：直到该端口/pid 上**再没有本方守护**为止。
 *
 * 判据 = `scanDaemonProcesses()`（读 `/proc/<pid>/cmdline` 认 `daemon.ts` + `--state-dir` ⇒ **不依赖元数据**）。
 * 为什么必须有界：`shutdown` 成功后守护要回收运行时才退（几十~几百 ms）；兜底 `kill -TERM` 也要等它走。
 * 无限等会把"守护卡住"变成"UI 卡住"，所以给 2s 上限，超时按"可能仍在"处理（调用方保留元数据）。
 *
 * 匹配口径：**同一个 pid** 或**同一个 `--port`** 都算"该槽位仍在"（守护可能已按端口 +1 迁移过，
 * 单看 pid 会漏；单看端口会把"同端口但换了 pid 的新守护"也当残留 —— 那更该报出来，不是漏报）。
 *
 * ★★ F-50（2026-10-27 审查）：返回值是 `{ ok, survivors, error? }`，**`ok` 的含义是「这次判定有没有证据」**：
 *   · `ok:true, survivors:[]` ⇒ 确认已停干净；
 *   · `ok:true, survivors:[…]` ⇒ 确认仍有本方守护；
 *   · `ok:false` ⇒ **无法确认**（扫描失败；`survivors` 为空**不代表**已停）。
 * 旧实现在扫描失败时返回 `[]`，于是 `stopDaemon` 认为"已停干净"⇒ 删元数据 ⇒ 活守护变成隐形孤儿。
 */
async function waitForSlotGone(cfg, port, pid) {
  const wantPid = Number(pid);
  const deadline = Date.now() + 2000;
  let lastError = '';
  for (;;) {
    const scan = await scanDaemonProcessesAsync(cfg);
    if (!scan.ok) {
      // 失败不当作结论：留到 deadline 之前一直重试（可能只是一次瞬时的 wsl.exe 抖动）。
      lastError = scan.error ?? '未知原因';
      if (Date.now() >= deadline) return { ok: false, survivors: [], error: lastError };
      await sleep(300);
      continue;
    }
    const survivors = scan.procs.filter(
      (p) => (Number.isFinite(wantPid) && p.pid === wantPid) || (p.port !== null && p.port === Number(port)),
    );
    if (survivors.length === 0) return { ok: true, survivors: [] };
    if (Date.now() >= deadline) return { ok: true, survivors };
    await sleep(300);
  }
}

/**
 * 显式停止守护（语义 #4：这是会话结束的三种方式之一）。
 *
 * **默认只停调用方自己槽位（`cfg.daemonPort`）**，不传 slot 时**绝不**去遍历别人的槽位
 * （task-9 追加 C：以前"自己槽位缺失就顺手停别人"是危险脚枪）。要停全部/含孤儿，用显式 `all: true`。
 */

// ── 原 daemon-client.ts 第 875-943 行 ──
export async function stopDaemon(cfg, { log = () => {}, slot, all = false }: any = {}) {
  // 2026-10-28（零配置）：目标发行版未确定时，元数据读取与 `/proc` 身份扫描都无从谈起。
  // 旧路径会读不到记录 ⇒ 走进"alreadyStopped: true"——那是**伪成功**（不是"没有守护"，是"读不了"）。
  // 这里如实回 ok:false（本函数的契约是返回结果对象，不是抛错）。
  const issue = targetProblem(cfg);
  if (issue) return { ok: false, verified: false, error: issue, reaped: [], alivePids: [], orphansVerified: false };
  if (all) return stopAllDaemons(cfg, { log });
  const wantSlot = Number(slot ?? cfg.daemonPort) || 8731;
  let rec = readDaemonRecord(cfg, wantSlot);
  if (!rec) {
    const legacy = readDaemonRecord(cfg);
    if (legacy?.legacy && Number(legacy.meta?.port) === wantSlot) rec = legacy; // 过渡期单文件记录，且确实是我这个端口
  }
  if (!rec) {
    // F-50：这里**没有**扫描过进程，所以说的是"没有元数据"，不是"确认没有守护"。
    // 无元数据孤儿由 stop all=true（身份扫描）负责；文案必须留出这个区别，别让人以为"已确认干净"。
    return {
      ok: true,
      alreadyStopped: true,
      reaped: [],
      slot: wantSlot,
      note: `自己槽位 ${wantSlot} 没有守护元数据（未扫描进程、未去停别的槽位；无元数据孤儿请用 action=stop all=true）`,
    };
  }
  const port = rec.meta?.port ?? rec.slot;
  const r = await callDaemon(cfg, {
    port,
    token: rec.token,
    req: { op: 'shutdown', id: 1 },
    timeoutMs: Math.max(Number(cfg.daemonHandshakeTimeoutMs ?? 3000), 5000),
  });
  log(`daemon shutdown on slot ${rec.slot} (port ${port}): ok=${r.ok} ${r.error ?? ''}`);
  if (!r.ok) await killWslPidAsync(cfg, rec.meta?.pid); // 守护已死/端口被占 ⇒ 按 pid 兜底（验身份后）

  // ★★ P1（task-25）：**移除元数据之前**必须复核该槽位真的没有本方守护了。
  //
  // 为什么：原来是"`shutdown` 一返回（或兜底 kill 一发）就无条件 `removeMetaFiles`"。可是
  //   · `shutdown` 成功 ≠ 进程已经退出（守护还要回收运行时最后才 exit）；
  //   · 兜底 `killWslPid` 只发 `kill -TERM`，**不等待、不验证**，而且身份闸拒杀（cmdline 不含 `daemon.ts`）时它什么都不做；
  // ⇒ 就得到"**元数据已删、进程还在**"= 对 `wsl_status` / `snapshot.daemon` **不可见**的隐形孤儿
  // （仍占端口与运行时）。所以这里按有界等待复核（身份判据走 `scanDaemonProcesses()` 读 `/proc/<pid>/cmdline`，
  // **不依赖元数据**）；仍在 ⇒ **保留元数据**（让孤儿保持可发现）+ 可读失败，绝不把它删成隐形。
  //
  // ★★ F-50（2026-10-27 审查）：复核**失败**（扫描拿不到证据）时同理 —— 那不等于"已停干净"。
  // 旧实现里 `[]` 同时表示"没有残留"和"扫描失败"，于是 stop 会在扫描失败时删元数据、报成功。
  const gone = await waitForSlotGone(cfg, port, rec.meta?.pid);
  if (!gone.ok) {
    log(`stop 未完成：槽位 ${rec.slot}（端口 ${port}）的残留判定失败（${gone.error ?? '未知原因'}）⇒ 保留元数据`);
    return {
      ok: false,
      port,
      slot: rec.slot,
      pid: rec.meta?.pid ?? null,
      version: rec.meta?.version ?? null,
      reaped: r.msg?.reaped ?? [],
      transport: r.ok ? 'shutdown' : r.kind,
      alivePids: [], // 未验证 —— **不是** 0，见 verified:false
      verified: false,
      error:
        `remote-wsl: stop 结果未验证：槽位 ${rec.slot}（端口 ${port}）无法确认本方守护是否已退出` +
        `（/proc 扫描失败：${gone.error ?? '未知原因'}）。已按 P1 规矩**保留元数据** daemon.${rec.slot}.json` +
        ` ⇒ 不会制造"元数据已删、进程还在"的隐形孤儿；请稍后重试 wsl_daemon action=stop，` +
        `或用 wsl_daemon action=status 复核（status 里 scan.ok=false 表示它也无法确认）。`,
    };
  }
  const survivors = gone.survivors;
  if (survivors.length) {
    log(
      `stop 未完成：槽位 ${rec.slot}（端口 ${port}）仍有本方守护 pid=${survivors.map((s) => s.pid).join(',')} ` +
        `⇒ 按 P1 保留元数据（不制造隐形孤儿）`,
    );
    return {
      ok: false,
      port,
      slot: rec.slot,
      pid: rec.meta?.pid ?? null,
      version: rec.meta?.version ?? null,
      reaped: r.msg?.reaped ?? [],
      transport: r.ok ? 'shutdown' : r.kind,
      alivePids: survivors.map((s) => s.pid),
      verified: true, // F-50：这次"仍在跑"是**有证据**的结论（扫描成功），不是未验证
      error:
        `remote-wsl: stop 未完成：槽位 ${rec.slot}（端口 ${port}）的本方守护进程仍在（pid ${survivors
          .map((s) => s.pid)
          .join('、')}）。已按 P1 规矩**保留元数据** daemon.${rec.slot}.json` +
        ` ⇒ 它仍是**可发现**的（wsl_status / snapshot.daemon 会报出来，也可再次 stop）；` +
        `没有变成"元数据已删、进程还在"的隐形孤儿。`,
    };
  }
  removeMetaFiles(cfg, rec.slot, rec.legacy);
  return {
    ok: true,
    port,
    slot: rec.slot,
    // F3：机器行统一字段 ⇒ 这里把"停之前"的身份一起带回去（守护已经没了，事后查不到）
    pid: rec.meta?.pid ?? null,
    version: rec.meta?.version ?? null,
    reaped: r.msg?.reaped ?? [],
    transport: r.ok ? 'shutdown' : r.kind,
    verified: true, // F-50：删除元数据前已用 /proc 扫描确认"没有本方守护残留"
  };
}

/**
 * **`stop --all`**：停掉所有槽位的守护 + 过渡期单文件记录 + **无元数据的孤儿**（身份扫描发现）。
 * 这是"工具能自己收干净"的保证：task-4 的竞态曾留下"发现不了也回收不了、只能人工按 pid 杀"的孤儿。
 *
 * ★★ F-50（2026-10-27 审查）：旧实现 `ok: remaining.length === 0` 里 `remaining` 来自可能失败的扫描 ——
 * 扫描一失败就得到 `remaining: []` ⇒ `ok:true` ⇒ **伪成功**（"全都停了"），而实际上什么都没验证。
 * 现在把"结论"和"证据"分开：
 *   · `verified: false` ⇒ 最后一次扫描失败，`remaining` 只是**已知部分**，**不是** 0；
 *   · `scan: { ok, error? }` ⇒ 上层可据此展示告警（扫描失败时**不许**说"已清干净"）；
 *   · `subFailures: number` ⇒ 有槽位的 stopDaemon 自己报了 ok:false（它们的元数据被刻意保留）；
 *   · `ok` 只在「扫描成功 + 确实没残留 + 每一步 stop 都没报失败」时为 true。
 */
export async function stopAllDaemons(cfg, { log = () => {} }: any = {}) {
  const stopped = [];
  for (const slot of listDaemonSlots(cfg)) stopped.push(await stopDaemon(cfg, { log, slot }));
  const legacyRec = readDaemonRecord(cfg);
  if (legacyRec?.legacy) stopped.push(await stopDaemon(cfg, { log }));

  /**
   * 有界轮询扫描（F-51 的 8s 收敛语义保留）：返回**最后一次**扫描结果。
   * `stopWhen(procs)` 为真即提前结束；扫描失败**不**提前结束（继续重试到 deadline）。
   */
  const scanRetry = async (deadline, stopWhen) => {
    let last = await scanDaemonProcessesAsync(cfg);
    while (Date.now() < deadline) {
      if (last.ok && stopWhen(last.procs)) break;
      await sleep(500);
      last = await scanDaemonProcessesAsync(cfg);
    }
    return last;
  };

  // 找出无元数据的孤儿进程并回收（身份闸在 killWslPidAsync 内部）。
  // ★ F-50：扫描失败 ⇒ **一个都不杀**（我们连"有哪些"都不知道），更不能把失败当"收完了"。
  // 失败时先给一次短重试（可能只是 wsl.exe 抖动），仍失败就不再猜。
  let first = await scanDaemonProcessesAsync(cfg);
  if (!first.ok) {
    await sleep(300);
    first = await scanDaemonProcessesAsync(cfg);
  }
  const killed = [];
  if (first.ok) {
    for (const p of first.procs) {
      await killWslPidAsync(cfg, p.pid); // 内部仍按 cmdline 验身份
      killed.push(p);
    }
  } else {
    log(`stop --all: /proc 扫描失败（${first.error ?? '未知原因'}）⇒ 未回收孤儿进程`);
  }

  // F-51（2026-10-27 审查）：守护收尾是**异步**的（每个运行时 close 上界约 10s），旧实现只固定
  // sleep(900) 再扫一次 ⇒ 多会话时几乎必然报 remaining>0 且不再重试。改为有界轮询（8s），
  // 仍在则对**验过身份**的守护升级 SIGKILL，再给 2s 收敛。
  // F-50：首轮就扫不到时**没有**任何"已观察到的残留"需要等，缩短重试窗口（8s → 2s），
  // 免得一个坏掉的 wsl.exe 把 stop --all 拖成十秒仍未验证。
  let last = await scanRetry(Date.now() + (first.ok ? 8000 : 2000), (procs) => procs.length === 0);
  if (last.ok && last.procs.length) {
    log(`stop --all: 仍有 ${last.procs.length} 个守护未在收敛窗口内退出 ⇒ 升级 SIGKILL（${last.procs.map((p) => p.pid).join(',')}）`);
    for (const p of last.procs) await killWslPidAsync(cfg, p.pid, 'KILL');
    last = await scanRetry(Date.now() + 2000, (procs) => procs.length === 0);
  }
  // 顺手清掉遗留的启动脚本（目录是我们自己的；守护活着的话它早已自删）
  try {
    for (const n of readdirSync(unc(cfg.distro, stateDirLinux(cfg)))) {
      if (/^launch\.[0-9]+\.sh(\.tmp)?$/.test(n)) {
        try {
          rmSync(unc(cfg.distro, `${stateDirLinux(cfg)}/${n}`), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  const remaining = last.ok ? last.procs : [];
  const subFailures = stopped.filter((s) => s && s.ok === false).length;
  const verified = last.ok === true;
  return {
    ok: verified && remaining.length === 0 && subFailures === 0,
    verified,
    scan: { ok: verified, error: verified ? undefined : (last.error ?? '未知原因') },
    remaining, // F-50：`verified:false` 时这是**已知部分**（不是全集）
    // F-50：**唯一可信的"还剩几个"**。`verified:false` ⇒ null（未知），**不要**用 remaining.length 当 0。
    remainingCount: verified ? remaining.length : null,
    subFailures,
    stopped,
    killed,
    ...(verified && subFailures === 0
      ? {}
      : {
          error:
            `remote-wsl: stop --all 未完成：` +
            (verified
              ? `${subFailures} 个槽位的 stop 未完成（元数据已按 P1 保留）`
              : `/proc 扫描失败（${last.error ?? '未知原因'}）⇒ 无法确认是否还有本方守护在跑（**剩余数量未知**，不是 0）`) +
            `。请稍后用 wsl_daemon action=status 复核，或重试 action=stop all=true。`,
        }),
  };
}

/**
 * 发一轮 prompt（**单次尝试**，不做恢复）——恢复策略在 index.js 里（它才知道上下文是否重置）。
 */

// ── 原 daemon-client.ts 第 1013-1039 行 ──
export async function daemonSnapshot(cfg) {
  // 2026-10-28（零配置）：目标发行版没解析出来时，`listDaemonSlots` 与 `/proc` 扫描都只能得到空
  // 数组 —— 上层会把它们误读成「没有守护」。这里直接给"未扫描"的显式状态（与 F-50 同一条纪律：
  // 扫描失败 ≠ 没有进程）。
  if (!asConfigText(cfg?.distro)) {
    const why = '目标发行版未确定（自动探测失败）：未执行守护扫描';
    return {
      slots: [],
      records: [],
      live: [],
      dead: [],
      busy: [],
      livePids: new Set(),
      procs: [],
      orphans: [],
      scan: { ok: false, error: why },
      orphansVerified: false,
      scanError: why,
    };
  }
  const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
  const slots = listDaemonSlots(cfg);
  const records = (slots.length ? slots.map((s) => readDaemonRecord(cfg, s)) : [readDaemonRecord(cfg)]).filter(Boolean);
  const live: any[] = [];
  const dead: any[] = [];
  const busy: any[] = [];
  const livePids = new Set<number>();
  for (const rec of records) {
    const port = rec.meta?.port ?? rec.slot;
    const r = await callDaemon(cfg, {
      port,
      token: rec.token,
      req: { op: 'status', id: 1 },
      timeoutMs: hsTimeout,
    });
    if (r.msg?.ok) {
      live.push({ slot: rec.slot, legacy: rec.legacy, meta: rec.meta, token: rec.token, info: r.msg, ms: r.ms });
      if (r.msg.daemonPid) livePids.add(Number(r.msg.daemonPid));
      continue;
    }
    // F-18（2026-10-27 审查）：一次 3s 的 status 超时**不等于死**。守护是单线程，provision/预热里的
    // 同步 curl 会把它按住几十秒；旧实现据此把 pid 归进 orphans，`wsl_status` 再建议 `stop all=true`，
    // 用户照做就杀掉带会话的健康守护。TCP 还能连上 ⇒ 进程活着，只是忙 ⇒ 单列 busy，绝不算孤儿。
    let probe = { open: false, kind: 'skipped' };
    if (r.kind === 'timeout' || r.kind === 'error' || r.kind === 'closed') {
      probe = await tcpProbe(port, 800);
    }
    if (probe.open) {
      busy.push({ slot: rec.slot, legacy: rec.legacy, meta: rec.meta, kind: r.kind, error: r.error, ms: r.ms });
      if (rec.meta?.pid) livePids.add(Number(rec.meta.pid));
    } else {
      dead.push({ slot: rec.slot, legacy: rec.legacy, meta: rec.meta, kind: r.kind, error: r.error, ms: r.ms });
    }
  }
  // ★★ F-50（2026-10-27 审查）：`orphans` 的**权威性**取决于这一次扫描是否成功。
  // 旧实现直接把扫描结果 filter 一下就当"孤儿全集"；扫描失败时得到空数组 ⇒ 上层（wsl_status /
  // wsl_daemon status / 面板）报"没有孤儿"，而实际可能有活守护在跑。
  // 现在把证据与结论分开返回：`scan.ok === false` ⇒ `orphans` 只是**已知部分**（可能是空），
  // 上层必须显式展示告警，不许把它当"0 个孤儿"。
  const scan = await scanDaemonProcessesAsync(cfg);
  const procs = scan.ok ? scan.procs : [];
  const orphans = scan.ok ? procs.filter((p) => !livePids.has(p.pid)) : [];
  const scanOk = scan.ok === true;
  return {
    slots,
    records,
    live,
    dead,
    busy,
    livePids,
    procs,
    orphans,
    // 机器可读的扫描状态（F-50）：`{ ok: boolean, error?: string }`
    scan: { ok: scanOk, ...(scanOk ? {} : { error: scan.error ?? '未知原因' }) },
    // 语义别名：孤儿列表**是否已核实**（`orphans` 为空且 `orphansVerified:false` ⇒ 不可当作真相）。
    orphansVerified: scanOk,
    ...(scanOk ? {} : { scanError: scan.error ?? '未知原因' }),
  };
}

/** 读守护状态（read-only，用于 wsl_status / wsl_daemon status；不触发启动；多守护并存 + 正确孤儿口径）。 */
export async function daemonStatus(cfg) {
  const snap = await daemonSnapshot(cfg);
  const { orphans, slots, live, dead, busy, records } = snap;
  // ★ F-50：`scan.ok` 透传到所有返回值 —— 上层（wsl_status / wsl_daemon status）据此打印告警。
  const scan = snap.scan ?? { ok: false, error: '快照未提供扫描状态' };
  const orphansVerified = snap.orphansVerified === true;
  if (live.length) {
    const first = live[0]; // listDaemonSlots 已把 cfg.daemonPort 排最前 ⇒ 优先报调用方自己槽位
    return {
      ok: true,
      info: first.info,
      meta: first.meta,
      slot: first.slot,
      legacy: first.legacy,
      ms: first.ms,
      slots,
      live,
      busy: snap.busy,
      orphans,
      scan,
      orphansVerified,
    };
  }
  if (busy.length) {
    // F-18：端口可连但没应答 ⇒ 忙，不是死。不要提示 stop all（那会杀掉带会话的守护）。
    const first = busy[0];
    const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
    return {
      ok: false,
      kind: 'busy',
      error:
        `守护在槽位 ${first.slot}（端口 ${first.meta?.port ?? first.slot}）**端口可连接但 ${hsTimeout}ms 内没有应答** ⇒` +
        `判定为「忙」（单线程守护可能正在安装工具/预热），**不是死**；本次不把它算作孤儿，也不要据此执行 stop all。` +
        `稍后重试 wsl_status 即可。`,
      meta: first.meta,
      slot: first.slot,
      busy,
      orphans,
      scan,
      orphansVerified,
      live: [],
    };
  }
  if (!records.length && !orphans.length) {
    // ★ F-50：以前这里无条件说"守护未运行"。可是扫描失败时 `orphans` 恒为空 ⇒ 这句话把
    // **未验证**说成了**确定没有**。现在把失败原因写进 error，上层展示时不会误导。
    if (scan.ok === false) {
      return {
        ok: false,
        kind: 'absent',
        error:
          `没有守护元数据，但 /proc 扫描失败（${scan.error ?? '未知原因'}）⇒ **无法排除**存在无元数据的孤儿守护；` +
          `本次结论仅为「没有元数据」，不是「确认没有守护在跑」。稍后重试 wsl_status，或用 wsl_daemon action=stop all=true 收尾。`,
        orphans,
        scan,
        orphansVerified,
        live: [],
      };
    }
    return { ok: false, kind: 'absent', error: '没有守护元数据（守护未运行）', scan, orphansVerified, live: [], orphans: [] };
  }
  const last = dead[dead.length - 1];
  return {
    ok: false,
    kind: last?.kind ?? 'orphan-only',
    error: last?.error ?? `只有无元数据的孤儿守护在跑（${orphans.length} 个）`,
    meta: last?.meta,
    slot: last?.slot,
    orphans,
    scan,
    orphansVerified,
    live: [],
  };
}
