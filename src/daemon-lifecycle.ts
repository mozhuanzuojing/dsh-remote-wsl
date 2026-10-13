/**
 * daemon-lifecycle.ts —— T3 拆分自 `daemon-client.ts`（1068 行）的 **生命周期层**：ensure/stop/snapshot/status 与孤儿判定（`daemonSnapshot` 仍是唯一孤儿真相源）。
 *
 * 来源：`src/daemon-client.ts` @ sha256 cb420d25ef1bcf9535cbf2f3dbb3faad95fa0d5321b31d0ca798103de59dbed1（原文件已备份到
 * `spike/verify/explorer-20261012/arch-t3/backup/daemon-client.cb420d25.ts.bak`）。
 * **代码逐字搬移**（由 `arch-t3/tools/apply-split.ts` 按行区间生成），未改写实现。
 * 导出：`ensureDaemon`/`stopDaemon`/`stopAllDaemons`/`daemonSnapshot`/`daemonStatus`；`removeMetaFiles`/`ownDaemonsOnPorts`/`recordForPid`/`waitForSlotGone` 保持模块内私有。
 *
 * 零构建纪律：只用可擦除语法；相对导入带 `.ts`；只引 `node:` 内置与同目录相对模块。
 */
import { readdirSync, rmSync } from 'node:fs';
import { callDaemon, handshake, legacyMetaLinux, legacyTokenLinux, listDaemonSlots, metaLinux, readDaemonLogTail, readDaemonRecord, scanDaemonProcesses, sleep, stateDirLinux, tokenLinux, unc } from './daemon-protocol.ts';
import { configCompat, killWslPid, launchDaemon, removeLauncher } from './daemon-launch.ts';

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
function ownDaemonsOnPorts(cfg, ports) {
  const want = new Set(ports.map(Number));
  return scanDaemonProcesses(cfg).filter((p) => (p.port != null && want.has(p.port)) || (p.metaPort != null && want.has(p.metaPort)));
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
  const notes = [];
  const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
  const wantSlot = Number(cfg.daemonPort) || 8731;
  const adopt = (rec, hs, reused) => {
    const compat = configCompat(cfg, hs.info, version);
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
      const hs = await handshake(cfg, rec.meta?.port ?? rec.slot, rec.token, hsTimeout);
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
      if (rec.meta?.pid) killWslPid(cfg, rec.meta.pid);
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
        killWslPid(cfg, rec.meta?.pid);
        removeMetaFiles(cfg, slot, rec.legacy);
        notes.push(`清理了失联的槽位 ${slot}`);
      }
    }
  } else {
    const stopped = await stopDaemon(cfg, { log, slot: wantSlot }).catch((e) => ({ ok: false, error: e?.message }));
    notes.push(`restart: 已停本槽位守护（${stopped?.reaped?.length ?? 0} 个运行时被回收）`);
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
  for (let i = 0; i < tries; i++) {
    const port = wantSlot + i;
    tried.push(port);

    // ★ A/B 修复：起之前先看这个槽位/端口上有没有**本插件自己的**守护在跑
    const occupants = ownDaemonsOnPorts(cfg, [port]);
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
      killWslPid(cfg, o.pid);
    }
    if (occupants.length) await sleep(900); // 等它退出，让端口真的空出来（否则守护会 +1 迁移）

    // 清掉**陈旧元数据**（文件在、但上面那个 pid 已经不在进程表里）：否则下面的轮询会一直握到一个死 pid，
    // 白等满 daemonStartTimeoutMs（实测过：进程表里没有它，但文件还在 ⇒ 20s 假等）。
    const stale = readDaemonRecord(cfg, port);
    if (stale) {
      const livePids = new Set(scanDaemonProcesses(cfg).map((p) => p.pid));
      if (!livePids.has(Number(stale.meta?.pid))) {
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
          // 守护在 WSL 侧做了 +1 迁移：必须说清楚（并在可能时指出占用者）
          const holder = scanDaemonProcesses(cfg).filter((p) => p.port === port);
          notes.push(
            `WSL 侧端口 ${port} 已被占（${holder.length ? `占用者 pid=${holder.map((h) => h.pid).join(',')}` : '非本插件进程'}）⇒ 守护实际监听 ${hs.info.port}`,
          );
        }
        notes.push(`槽位 ${port} 由 Windows 侧握手确认就绪（实际端口 ${hs.info.port}，${hs.ms}ms）`);
        // ★ F-38c（task-19）：`mode`/`warning` 作为**机器可读字段**随结果返回（notes 照旧保留）。
        const ready = adopt({ slot: port, meta: rec.meta, token: rec.token }, hs, false);
        ready.mode = launched.mode ?? null; // 'systemd' | 'compat-detached'
        ready.warning = launched.warning ?? null; // 回退时非空字符串；主路径为 null
        return ready;
      }
      if (hs.kind === 'refused') {
        // 元数据存在但守护已死（pid 不在进程表）⇒ 清掉再等新守护写自己的，别把 20s 白等在一个死 pid 上
        const livePids = new Set(scanDaemonProcesses(cfg).map((p) => p.pid));
        if (!livePids.has(Number(rec.meta?.pid))) removeMetaFiles(cfg, port);
        continue;
      }
      if (hs.kind === 'timeout' || hs.kind === 'unauthorized' || hs.kind === 'garbage') break;
    }
    const why = hs ? `${hs.kind}（${hs.ms}ms）` : '元数据未出现';
    notes.push(`槽位 ${port} 未通过 Windows 侧就绪判据：${why}`);
    log(`slot ${port} not ready from Windows side: ${why}`);
    const rec2 = readDaemonRecord(cfg, port);
    if (rec2?.meta?.pid) killWslPid(cfg, rec2.meta.pid);
    // 兜底：即使元数据没写成，也按 /proc 身份扫描把这个端口上的自家守护收掉
    for (const o of ownDaemonsOnPorts(cfg, [port])) killWslPid(cfg, o.pid);
    if (rec2 || ownDaemonsOnPorts(cfg, [port]).length) await sleep(700);
    removeMetaFiles(cfg, port);
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
}

/**
 * 有界等待：直到该端口/pid 上**再没有本方守护**为止；返回**仍在**的那些（空数组 = 已清干净）。
 *
 * 判据 = `scanDaemonProcesses()`（读 `/proc/<pid>/cmdline` 认 `daemon.ts` + `--state-dir` ⇒ **不依赖元数据**）。
 * 为什么必须有界：`shutdown` 成功后守护要回收运行时才退（几十~几百 ms）；兜底 `kill -TERM` 也要等它走。
 * 无限等会把"守护卡住"变成"UI 卡住"，所以给 2s 上限，超时按"可能仍在"处理（调用方保留元数据）。
 *
 * 匹配口径：**同一个 pid** 或**同一个 `--port`** 都算"该槽位仍在"（守护可能已按端口 +1 迁移过，
 * 单看 pid 会漏；单看端口会把"同端口但换了 pid 的新守护"也当残留 —— 那更该报出来，不是漏报）。
 */

// ── 原 daemon-client.ts 第 855-874 行 ──
async function waitForSlotGone(cfg, port, pid) {
  const wantPid = Number(pid);
  const deadline = Date.now() + 2000;
  let survivors = [];
  for (;;) {
    survivors = scanDaemonProcesses(cfg).filter(
      (p) => (Number.isFinite(wantPid) && p.pid === wantPid) || (p.port !== null && p.port === Number(port)),
    );
    if (survivors.length === 0) return [];
    if (Date.now() >= deadline) return survivors;
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
  if (all) return stopAllDaemons(cfg, { log });
  const wantSlot = Number(slot ?? cfg.daemonPort) || 8731;
  let rec = readDaemonRecord(cfg, wantSlot);
  if (!rec) {
    const legacy = readDaemonRecord(cfg);
    if (legacy?.legacy && Number(legacy.meta?.port) === wantSlot) rec = legacy; // 过渡期单文件记录，且确实是我这个端口
  }
  if (!rec) {
    return { ok: true, alreadyStopped: true, reaped: [], slot: wantSlot, note: `自己槽位 ${wantSlot} 没有守护（未去停别的槽位）` };
  }
  const port = rec.meta?.port ?? rec.slot;
  const r = await callDaemon(cfg, {
    port,
    token: rec.token,
    req: { op: 'shutdown', id: 1 },
    timeoutMs: Math.max(Number(cfg.daemonHandshakeTimeoutMs ?? 3000), 5000),
  });
  log(`daemon shutdown on slot ${rec.slot} (port ${port}): ok=${r.ok} ${r.error ?? ''}`);
  if (!r.ok) killWslPid(cfg, rec.meta?.pid); // 守护已死/端口被占 ⇒ 按 pid 兜底（验身份后）

  // ★★ P1（task-25）：**移除元数据之前**必须复核该槽位真的没有本方守护了。
  //
  // 为什么：原来是"`shutdown` 一返回（或兜底 kill 一发）就无条件 `removeMetaFiles`"。可是
  //   · `shutdown` 成功 ≠ 进程已经退出（守护还要回收运行时最后才 exit）；
  //   · 兜底 `killWslPid` 只发 `kill -TERM`，**不等待、不验证**，而且身份闸拒杀（cmdline 不含 `daemon.ts`）时它什么都不做；
  // ⇒ 就得到"**元数据已删、进程还在**"= 对 `wsl_status` / `snapshot.daemon` **不可见**的隐形孤儿
  // （仍占端口与运行时）。所以这里按有界等待复核（身份判据走 `scanDaemonProcesses()` 读 `/proc/<pid>/cmdline`，
  // **不依赖元数据**）；仍在 ⇒ **保留元数据**（让孤儿保持可发现）+ 可读失败，绝不把它删成隐形。
  const survivors = await waitForSlotGone(cfg, port, rec.meta?.pid);
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
  };
}

/**
 * **`stop --all`**：停掉所有槽位的守护 + 过渡期单文件记录 + **无元数据的孤儿**（身份扫描发现）。
 * 这是"工具能自己收干净"的保证：task-4 的竞态曾留下"发现不了也回收不了、只能人工按 pid 杀"的孤儿。
 */

// ── 原 daemon-client.ts 第 944-976 行 ──
export async function stopAllDaemons(cfg, { log = () => {} }: any = {}) {
  const stopped = [];
  for (const slot of listDaemonSlots(cfg)) stopped.push(await stopDaemon(cfg, { log, slot }));
  const legacyRec = readDaemonRecord(cfg);
  if (legacyRec?.legacy) stopped.push(await stopDaemon(cfg, { log }));
  const found = scanDaemonProcesses(cfg);
  const killed = [];
  for (const p of found) {
    killWslPid(cfg, p.pid); // 内部仍按 cmdline 验身份
    killed.push(p);
  }
  if (killed.length) await sleep(900);
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
  const remaining = scanDaemonProcesses(cfg);
  return { ok: remaining.length === 0, stopped, killed, remaining };
}

/**
 * 发一轮 prompt（**单次尝试**，不做恢复）——恢复策略在 index.js 里（它才知道上下文是否重置）。
 */

// ── 原 daemon-client.ts 第 1013-1039 行 ──
export async function daemonSnapshot(cfg) {
  const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
  const slots = listDaemonSlots(cfg);
  const records = (slots.length ? slots.map((s) => readDaemonRecord(cfg, s)) : [readDaemonRecord(cfg)]).filter(Boolean);
  const live: any[] = [];
  const dead: any[] = [];
  const livePids = new Set<number>();
  for (const rec of records) {
    const r = await callDaemon(cfg, {
      port: rec.meta?.port ?? rec.slot,
      token: rec.token,
      req: { op: 'status', id: 1 },
      timeoutMs: hsTimeout,
    });
    if (r.msg?.ok) {
      live.push({ slot: rec.slot, legacy: rec.legacy, meta: rec.meta, token: rec.token, info: r.msg, ms: r.ms });
      if (r.msg.daemonPid) livePids.add(Number(r.msg.daemonPid));
    } else {
      dead.push({ slot: rec.slot, legacy: rec.legacy, meta: rec.meta, kind: r.kind, error: r.error, ms: r.ms });
    }
  }
  const procs = scanDaemonProcesses(cfg);
  const orphans = procs.filter((p) => !livePids.has(p.pid));
  return { slots, records, live, dead, livePids, procs, orphans };
}

/** 读守护状态（read-only，用于 wsl_status / wsl_daemon status；不触发启动；多守护并存 + 正确孤儿口径）。 */

// ── 原 daemon-client.ts 第 1040-1068 行 ──
export async function daemonStatus(cfg) {
  const snap = await daemonSnapshot(cfg);
  const { orphans, slots, live, dead, records } = snap;
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
      orphans,
    };
  }
  if (!records.length && !orphans.length) return { ok: false, kind: 'absent', error: '没有守护元数据（守护未运行）' };
  const last = dead[dead.length - 1];
  return {
    ok: false,
    kind: last?.kind ?? 'orphan-only',
    error: last?.error ?? `只有无元数据的孤儿守护在跑（${orphans.length} 个）`,
    meta: last?.meta,
    slot: last?.slot,
    orphans,
    live: [],
  };
}
