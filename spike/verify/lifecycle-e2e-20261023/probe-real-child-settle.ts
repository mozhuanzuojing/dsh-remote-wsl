#!/usr/bin/env node
/**
 * probe-real-child-settle.ts —— **真 wsl.exe child** 版的关停屏障回归：补 probe-lifecycle-grace（假 child）
 * 缺的那一格 —— "settle 面对真 wsl.exe 包装层时，宽限/强制/清扫到底怎么走"。
 *
 * 与 probe-host-dispose 的分工（两者必须一起读）：
 *   · probe-host-dispose  = **真宿主**（隔离 dsh 实例）走真 dispose —— 证明宿主退出语义与零残留；
 *     但面板数据面全走 execFile/spawnSync（不登记 lifecycle）⇒ 那条 e2e 里 settle 的 tracked 恒为 0。
 *   · 本探针 = 真 `runWsl()` + 真 `createLifecycle()` + 真 `settle()` + 真 `sweepOwnTempFiles()`，
 *     唯一"假"的是没有宿主 ctx；因此能把 settle 的五个字段与 /tmp 清理**直接断言**（不靠日志解析）。
 *
 * 判据：
 *   B1 两个并发 `runWsl('sleep 5')` 真的起来：/tmp 有 2 个本 pid 脚本、2 个 wsl.exe 子进程；
 *   B2 settle 前归属表 size=2（这是"真在途"的硬证据）；
 *   B3 settle(5000) 结果：forced=true（5s 脚本不可能在 300ms 宽限里自己退）、killed=2、remaining=0、
 *      timedOut=false、waitedMs ∈ [300, 1500]（扣的是宽限+kill 等待，不是白等满 5s）；
 *   B4 关停态下 `runWsl` 立刻返回 127 + E_SHUTDOWN（不再新建运行时）；
 *   B5 两个调用 promise 都 resolve（不悬挂），exitCode 非 0（被 kill 的包装层）；
 *      **本轮真发现**：旧 `code ?? 0` 把被 SIGTERM 的包装层记成 exitCode 0（伪成功）—— 已修，由 B5c 钉住；
 *   B6 关停后本 pid 的 /tmp 脚本清零（runWsl 的 finish→removeScript 真的跑了）；
 *   B7 `sweepOwnTempFiles` 在关停态仍可执行（allowDuringShutdown），且不抛；
 *   B8 记录 Linux 侧残留（观测值：kill 包装层后脚本进程可能短暂存活 —— 这是已知边界，不当失败）。
 *
 * 用法：node probe-real-child-settle.ts；产物 out-real-child-settle.json；退出码 0=全过，1=有失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLifecycle } from '../../../src/lifecycle.ts';
import { runWsl, sweepOwnTempFiles, shutdownRejection } from '../../../src/wsl-io.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DISTRO = 'debian-u8-1';
const CFG = { distro: DISTRO, wslHome: '/home/g', proxyPort: 9910, useShellEnvironment: false };
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ownTmp = () => {
  try {
    return fs.readdirSync(`\\\\wsl.localhost\\${DISTRO}\\tmp`).filter((n) => n.startsWith(`dsh-rwsl-${process.pid}-`));
  } catch {
    return null;
  }
};
const wslKids = () => {
  try {
    const out = execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.ParentProcessId -eq ${process.pid} } | ForEach-Object { $_.ProcessId }`],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number);
  } catch {
    return null;
  }
};
const wslScriptProcs = () => {
  try {
    const out = execFileSync(
      'wsl.exe',
      ['-d', DISTRO, '--exec', 'bash', '-c', `ps -eo pid,args | grep dsh-rwsl-${process.pid} | grep -v grep | wc -l`],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    return Number(String(out).trim());
  } catch {
    return null;
  }
};

const lifecycle = createLifecycle(); // 自动成为 ambient：runWsl 据此登记
const evidence = {};

// 起两个"5 秒才退"的真 child（宽限期 300ms 内绝不会自己退 ⇒ 必然走 kill 分支）
const p1 = runWsl(CFG, `sleep 5\necho REAL-CHILD-1\n`);
const p2 = runWsl(CFG, `sleep 5\necho REAL-CHILD-2\n`);
await sleep(250); // 让 bash 真的跑起来（wsl.exe + /tmp 脚本就位）

const filesBefore = ownTmp();
const kidsBefore = wslKids();
evidence.before = { tmp: filesBefore, wslPids: kidsBefore };
check('B1 两个真 runWsl 已就位（/tmp 2 个脚本）', Array.isArray(filesBefore) && filesBefore.length === 2, `tmp=${JSON.stringify(filesBefore)}`);
check('B1b 两个 wsl.exe 子进程在跑', Array.isArray(kidsBefore) && kidsBefore.length === 2, `pids=${JSON.stringify(kidsBefore)}`);
check('B2 settle 前归属表 size=2', lifecycle.size() === 2, `size=${lifecycle.size()}`);

const t0 = Date.now();
lifecycle.beginShutdown();
const gen = lifecycle.generation();
const settled = await lifecycle.settle(5000);
const wall = Date.now() - t0;
evidence.settle = { ...settled, wallMs: wall, generation: gen };
check(
  'B3a forced=true（宽限期内没退 ⇒ 走了 kill 分支）',
  settled.forced === true,
  `forced=${settled.forced}`,
);
check('B3b killed=2（只 kill 归属表里的两个）', settled.killed === 2, `killed=${settled.killed}`);
check('B3c remaining=0', settled.remaining === 0, `remaining=${settled.remaining}`);
check('B3d timedOut=false（不是伪失败）', settled.timedOut === false, `timedOut=${settled.timedOut}`);
check(
  'B3e waitedMs ∈ [300,1500]（扣宽限+kill 等待，没白等满 5s）',
  settled.waitedMs >= 300 && settled.waitedMs <= 1500 && wall <= 2000,
  `waitedMs=${settled.waitedMs} wallMs=${wall}`,
);

// B4 关停态拒绝新建
const rejected = await runWsl(CFG, `echo SHOULD-NOT-RUN\n`);
evidence.rejected = { exitCode: rejected.exitCode, stderr: rejected.stderr };
check(
  'B4 关停态 runWsl 返回 127 + E_SHUTDOWN（不再新建运行时）',
  rejected.exitCode === 127 && String(rejected.stderr).includes(shutdownRejection),
  `exitCode=${rejected.exitCode}`,
);

// B5 两个 promise 都不悬挂
const [r1, r2] = await Promise.all([p1, p2]);
evidence.childResults = [
  { exitCode: r1.exitCode, stdoutHasMarker: r1.stdout.includes('REAL-CHILD-1') },
  { exitCode: r2.exitCode, stdoutHasMarker: r2.stdout.includes('REAL-CHILD-2') },
];
check(
  'B5 被 kill 的两个 runWsl promise 已结算（不悬挂）',
  [r1.exitCode, r2.exitCode].every((c) => typeof c === 'number'),
  `codes=${r1.exitCode},${r2.exitCode}`,
);
check(
  'B5b 两个都是被强制中断（exitCode 非 0，且没有跑到 echo 成功路径）',
  r1.exitCode !== 0 && r2.exitCode !== 0 && !r1.stdout.includes('REAL-CHILD-1') && !r2.stdout.includes('REAL-CHILD-2'),
  `codes=${r1.exitCode},${r2.exitCode} markers=${r1.stdout.includes('REAL-CHILD-1')},${r2.stdout.includes('REAL-CHILD-2')}`,
);
// 2026-10-23：这条是本探针第一轮**真发现的缺陷**——settle 的 kill 让 wsl.exe 走 signal='SIGTERM'、
// code=null，旧 `code ?? 0` 把被杀的包装层记成 exitCode 0（空 stdout + 成功 = 伪成功）。已修成 1，这里钉住。
check(
  'B5c 被 kill 的包装层 exitCode=1（不许再把 SIGTERM 记成 0=成功）',
  r1.exitCode === 1 && r2.exitCode === 1,
  `codes=${r1.exitCode},${r2.exitCode}`,
);

// B6 /tmp 清理
const filesAfter = ownTmp();
evidence.after = { tmp: filesAfter };
check(
  'B6 关停后本 pid 的 /tmp 脚本清零（finish→removeScript 真的跑了）',
  Array.isArray(filesAfter) && filesAfter.length === 0,
  filesAfter === null ? 'UNC 读不到（不能当 0）' : `left=${filesAfter.length}`,
);

// B7 sweepOwnTempFiles 在关停态仍可执行
let sweepError = null;
const tSweep = Date.now();
try {
  await sweepOwnTempFiles(CFG);
} catch (e) {
  sweepError = String(e?.message ?? e);
}
const sweepMs = Date.now() - tSweep;
evidence.sweep = { ms: sweepMs, error: sweepError };
check('B7 关停态 sweepOwnTempFiles 不抛（allowDuringShutdown 生效）', sweepError === null, `ms=${sweepMs} error=${sweepError}`);

// B8 Linux 侧残留：只记录（kill 包装层不保证立刻收掉 Linux 侧脚本进程 —— 已知边界）
const procsRightAfter = wslScriptProcs();
await sleep(5500); // 让 sleep 5 自己跑完
const procsLater = wslScriptProcs();
evidence.linuxSide = { rightAfterSettle: procsRightAfter, after6s: procsLater };
check(
  'B8 记录 Linux 侧残留（观测口径，不当通过条件）',
  true,
  `rightAfter=${procsRightAfter} after6s=${procsLater}`,
);

const failed = results.filter((r) => !r.ok);
const summary = {
  probe: 'probe-real-child-settle',
  generatedAt: new Date().toISOString(),
  target: { distro: DISTRO, wslHome: CFG.wslHome, probePid: process.pid },
  evidence,
  checks: results,
  passed: results.length - failed.length,
  total: results.length,
  failures: failed.map((f) => `${f.name}: ${f.detail}`),
};
fs.writeFileSync(path.join(DIR, 'out-real-child-settle.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: summary.passed, total: summary.total, failures: summary.failures, settle: evidence.settle, linuxSide: evidence.linuxSide }, null, 2));
process.exit(failed.length ? 1 : 0);
