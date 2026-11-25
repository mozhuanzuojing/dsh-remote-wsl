/**
 * dsh-remote-wsl / doctor-facts —— 诊断事实的**唯一收集器**（`wsl_doctor` 工具与面板 `explorer.diagnose` 共用）。
 *
 * 只读纪律（结构保证，不是口头承诺）：
 *   · 本模块 **不 import `node:child_process`**，诊断路径上不会出现 `wsl -d …`；
 *   · 发行版内事实（内存）走 UNC 读 `/proc/meminfo`；读不到 ⇒ `memory = null` ⇒ `skip`（skip ≠ ok），
 *     **不回落 `wsl -d free -m`**（那条会在停着的发行版上把它拉起来——2026-11-20 真机教训）；
 *   · 守护事实只来自 `readDaemonMeta()`（只读元数据文件），不做活体探活（真值以 `explorer.snapshot().daemon` 为准）；
 *   · 不写盘、不 ensure/stop/restart 任何东西。
 *
 * 依赖方向：`doctor.ts`（纯函数）← 本模块 ← {register-tools, explorer}；本模块只依赖
 * `node:fs` / `config.ts` / `daemon-protocol.ts`，**不得** import explorer/register-tools/daemon-client（成环）。
 */
import { readFileSync } from 'node:fs';
import { configWarnings as configWarningsOf, targetProblem as targetProblemOf } from './config.js';
import { readDaemonMeta as readDaemonMetaOf, unc } from './daemon-protocol.js';
/** 解析 `/proc/meminfo`（kB 单位）→ 与 `free -m` 对齐的 MB 口径。纯函数。 */
export function parseMeminfo(text) {
    const raw = String(text ?? '');
    if (raw.length === 0)
        return null;
    const field = (name) => {
        const m = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(raw);
        return m ? Number(m[1]) : null;
    };
    const totalKb = field('MemTotal');
    const freeKb = field('MemFree');
    if (totalKb === null || freeKb === null)
        return null;
    const swapTotalKb = field('SwapTotal') ?? 0;
    const swapFreeKb = field('SwapFree') ?? 0;
    const swapUsedKb = Math.max(0, swapTotalKb - swapFreeKb);
    return {
        totalMB: Math.round(totalKb / 1024),
        freeMB: Math.round(freeKb / 1024),
        swapUsedPct: swapTotalKb > 0 ? Math.round((swapUsedKb / swapTotalKb) * 100) : 0,
    };
}
/** 守护元数据 → `DoctorFacts['daemon']`（null = 未探测；`{present:false}` = 已探测但未运行）。纯函数。 */
export function daemonFactsFromMeta(meta) {
    if (meta === null || meta === undefined)
        return null;
    if (typeof meta !== 'object')
        return null;
    return {
        present: true,
        running: meta.running !== false,
        reachable: meta.reachable,
        detail: `slot=${meta.slot ?? '?'} pid=${meta.pid ?? '?'} version=${meta.version ?? '?'}`,
    };
}
/** 默认内存探针：UNC 读 `/proc/meminfo`，**不启动发行版**。 */
export function readMeminfoViaUnc(distro) {
    try {
        return readFileSync(unc(distro, '/proc/meminfo'), 'utf8');
    }
    catch {
        return null;
    }
}
/**
 * 收集诊断事实。**永不抛**（除调用方传错 input）：每个探针独立 try/catch，失败落成 `skip`/`fail`。
 */
export async function collectDoctorFacts(input, probes = {}) {
    const cfg = input?.config ?? {};
    const p = {
        platform: probes.platform ?? process.platform,
        listDistros: probes.listDistros ?? (async () => null),
        resolveVersion: probes.resolveVersion ?? (() => null),
        readDaemonMeta: probes.readDaemonMeta ?? ((c) => readDaemonMetaOf(c)),
        readMeminfo: probes.readMeminfo ?? readMeminfoViaUnc,
        targetProblem: probes.targetProblem ?? ((c) => targetProblemOf(c)),
        configWarnings: probes.configWarnings ?? ((c) => configWarningsOf(c)),
    };
    const targetDistro = String(input?.distro ?? cfg?.distro ?? '') || null;
    const facts = {
        platform: p.platform,
        distros: null,
        distrosReadFailed: false,
        targetIssue: null,
        targetMissing: false,
        distro: targetDistro,
        wslHome: cfg?.wslHome || null,
        cwd: cfg?.cwd || null,
        versionResolved: null,
        versionIssue: null,
        drift: null,
        daemon: null,
        proxy: null,
        memory: null,
        configWarnings: [],
    };
    if (input?.redetect === true && typeof input.resetTarget === 'function') {
        try {
            input.resetTarget();
        }
        catch {
            /* 重探失败不影响本报告（后续 targetIssue/versionIssue 会说明） */
        }
    }
    try {
        const ds = await p.listDistros();
        facts.distros = Array.isArray(ds) ? ds : null;
        facts.distrosReadFailed = Array.isArray(ds) && ds.length === 0;
    }
    catch {
        facts.distrosReadFailed = true;
    }
    try {
        facts.targetIssue = p.targetProblem(cfg) || null;
    }
    catch (e) {
        facts.targetIssue = String(e?.message ?? e);
    }
    try {
        facts.targetMissing =
            !facts.targetIssue &&
                Array.isArray(facts.distros) &&
                facts.distros.length > 0 &&
                !!cfg?.distro &&
                !facts.distros.includes(cfg.distro);
    }
    catch {
        /* ignore */
    }
    try {
        const v = p.resolveVersion(cfg);
        if (v) {
            facts.versionResolved = v.version || (v.resolved && v.resolved.version) || null;
            if (v.issue)
                facts.versionIssue = String(v.issue);
            if (v.drift)
                facts.drift = v.drift;
            else if (typeof v.drifted === 'boolean')
                facts.drift = { drifted: v.drifted, desktop: v.desktop, pin: v.pin };
        }
    }
    catch (e) {
        facts.versionIssue = String(e?.message ?? e);
    }
    try {
        facts.configWarnings = p.configWarnings(cfg) || [];
    }
    catch {
        facts.configWarnings = [];
    }
    // 守护：目标不可用时不做（避免对不存在的发行版读状态目录）
    if (!facts.targetIssue && !facts.targetMissing) {
        try {
            facts.daemon = daemonFactsFromMeta(await p.readDaemonMeta({ ...cfg, distro: targetDistro ?? cfg.distro }));
        }
        catch {
            facts.daemon = null;
        }
    }
    // 内存：UNC 读 /proc/meminfo（不启动发行版）；读不到 → null → skip
    if (!facts.targetIssue && !facts.targetMissing && targetDistro) {
        try {
            facts.memory = parseMeminfo(p.readMeminfo(targetDistro));
        }
        catch {
            facts.memory = null;
        }
    }
    return facts;
}
