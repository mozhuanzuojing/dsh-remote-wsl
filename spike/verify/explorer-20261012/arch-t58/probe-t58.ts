/**
 * probe-t58.ts —— T58：`stopAllDaemons` 的全量语义（**用孤立 state 目录，绝不碰真实 `~/.dsh` 里他人的守护**）。
 *
 * 三个孤立 state 目录（彼此独立、都不在真实 `~/.dsh` 下）：
 *   · isoA = /home/g/t58-isoA  ⇒ state dir /home/g/t58-isoA/.dsh/remote-wsl  ← 被测对象（槽位 8911 / 8912）
 *   · isoB = /home/g/t58-isoB  ⇒ state dir /home/g/t58-isoB/.dsh/remote-wsl  ← "不属于 A 的第三个"（槽位 8913）
 *   · isoC = /home/g/t58-isoC  ⇒ 空 state 目录（边界：`--all` 应 ok:true 无副作用）
 *
 * 用法：node probe-t58.ts <setup|stopall|empty|stale|seed-stale|red|cleanup> [copyRoot]
 *   copyRoot：给了就从**副本**（含 red 变异）import，否则用真仓库。
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MODE = process.argv[2];
const COPY = process.argv[3] || '';
const REPO = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const ROOT = COPY || REPO;
const D = 'debian-u8-1';
const mk = (wslHome, port) => ({
  distro: D, wslHome, cwd: '/home/g', profile: 'sdk', proxyPort: 9910, backend: 'daemon',
  daemonPort: port, daemonPortTries: 1, daemonIdleMs: 1800000, daemonLingerMs: 600000,
  daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
});
const A = mk('/home/g/t58-isoA', 8911);
const A2 = mk('/home/g/t58-isoA', 8912);
const B = mk('/home/g/t58-isoB', 8913);
const C = mk('/home/g/t58-isoC', 8914);
const cli = await import(`file:///${ROOT}/src/daemon-client.ts`);
const brief = (o) => JSON.stringify(o).slice(0, 300);

if (MODE === 'red') {
  // 故意红：把 scanDaemonProcesses 的作用域从"本 state 目录"放宽到"自家 t58 实验目录们"
  // （**只放宽到自己造的 /home/g/t58-iso***，绝不放宽到真实 ~/.dsh ⇒ 不会碰任何他人守护）
  const dir = process.argv[4];
  const f = `${dir}/src/daemon-protocol.ts`;
  let s = readFileSync(f, 'utf8');
  const anchor = `  case "$c" in *"--state-dir $S "*|*"--state-dir $S") ;; *) continue ;; esac`;
  if (s.split(anchor).length - 1 !== 1) { console.log('RED-PATCH-FAIL: 锚点未命中 1 次'); process.exit(3); }
  s = s.replace(anchor, `  case "$c" in *"--state-dir /home/g/t58-iso"*) ;; *) continue ;; esac`);
  writeFileSync(f, s, 'utf8');
  console.log('RED-PATCH: scanDaemonProcesses 的 state-dir 过滤已放宽到 /home/g/t58-iso*（仅自家实验目录）');
  process.exit(0);
}

if (MODE === 'setup') {
  for (const [name, cfg] of [['A-8911', A], ['A-8912', A2], ['B-8913', B]]) {
    const r = await cli.ensureDaemon(cfg, { version: '0.2.0-rc.2', log: () => {} });
    console.log(`SETUP ${name}: ok=${r.ok} mode=${r.mode} pid=${r.info?.daemonPid} warning=${r.warning === null ? 'null' : 'set'}`);
  }
  process.exit(0);
}

if (MODE === 'seed-stale') {
  // 陈旧记录：先起 8914（isoC），再 kill -9 它的进程（元数据留在盘上、进程没了）
  const r = await cli.ensureDaemon(C, { version: '0.2.0-rc.2', log: () => {} });
  const pid = r.info?.daemonPid;
  const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `kill -9 ${pid}`], { windowsHide: true, encoding: 'utf8' });
  await new Promise((res) => setTimeout(res, 700));
  console.log(`SEED-STALE: isoC pid=${pid} 已 kill -9；元数据仍在 = ${cli.readDaemonRecord(C, 8914) !== null}`);
  process.exit(0);
}

if (MODE === 'cleanup') {
  for (const cfg of [A, A2, B, C]) { try { await cli.stopDaemon(cfg, { slot: cfg.daemonPort, log: () => {} }); } catch { /* ignore */ } }
  const sh = (script) => String(spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true }).stdout || '').replace(/\0/g, '').trim();
  console.log(`CLEANUP 残留 daemon.ts 进程 = ${sh("pgrep -af 'daemon.t[s]' | wc -l")}`);
  console.log(`CLEANUP /tmp launch 残留 = ${sh("ls /tmp/dsh-rwsl-* 2>/dev/null | wc -l")}`);
  console.log(`CLEANUP 孤立目录 = ${sh("ls -d /home/g/t58-iso* 2>/dev/null | tr '\\n' ' '")}`);
  process.exit(0);
}

// stopall / empty / stale / red：都跑 stopAllDaemons，只是前置状态不同
// ★ 目标必须与被造状态一致：stale 记录种在 **isoC** ⇒ stale 模式也要打在 isoC 上（第一版打在 A 上 ⇒ 等于又测了一遍"空"）
const target = MODE === 'stopall' ? A : C;
const TSLOTS = MODE === 'stopall' ? [8911, 8912] : MODE === 'stale' ? [8914] : [];
const TNAME = MODE === 'stopall' ? 'isoA（两个活守护）' : MODE === 'stale' ? 'isoC（含陈旧记录 8914）' : 'isoC（空 state 目录）';
const label = TNAME;
const scan = (cfg) => cli.scanDaemonProcesses(cfg).map((p) => `${p.pid}@${p.port}`).join(',') || '(none)';
const metaOf = (cfg, slots) => slots.map((s) => `${s}:${cli.readDaemonRecord(cfg, s) ? '有' : '无'}`).join(' ') || '(无槽位)';
console.log(`== ${MODE} on ${label} ==`);
console.log(`BEFORE scan(T)=${scan(target)} scan(B)=${scan(B)}`);
const bPidBefore = (cli.scanDaemonProcesses(B).find((p) => p.port === 8913) || {}).pid ?? null;
console.log(`BEFORE T 元数据 ${metaOf(target, TSLOTS)}；B pid=${bPidBefore}`);

const r = await cli.stopAllDaemons(target, { log: (m) => console.log(`  # ${m}`) });
console.log(`RESULT stopAllDaemons(${MODE}) => ${brief({ ok: r.ok, stoppedCount: r.stopped?.length, killed: r.killed, remaining: r.remaining })}`);

await new Promise((res) => setTimeout(res, 1200));
console.log(`AFTER  scan(T)=${scan(target)} scan(B)=${scan(B)}`);
console.log(`AFTER  T 元数据 ${metaOf(target, TSLOTS)}`);
console.log(`ASSERT T 无残留进程（scan(T) 空）= ${cli.scanDaemonProcesses(target).length === 0}`);
console.log(`ASSERT T 元数据被处理 = ${TSLOTS.every((s) => cli.readDaemonRecord(target, s) === null)}（期望：活守护的记录清掉；陈旧记录也清掉；空目录无事）`);
console.log(`ASSERT 结果 ok=true = ${r.ok === true}`);
console.log(`ASSERT 目标进程被停（stopped 条数）= ${r.stopped?.length}（stopall 期望 2；其它模式允许 0）`);
// 不误停第三方：isoB 的守护必须还活着、pid 不变、元数据还在
const bRecAfter = cli.readDaemonRecord(B, 8913);
const hs = bRecAfter ? await cli.handshake(B, bRecAfter.meta?.port ?? 8913, bRecAfter.token, 3000) : { ok: false };
console.log(`ASSERT 不误停第三方（isoB）: 握手 ok=${hs.ok} pid 不变=${String(hs.info?.daemonPid) === String(bPidBefore)} (${hs.info?.daemonPid} vs ${bPidBefore}) 元数据仍在=${!!bRecAfter}`);
const sh = (script) => String(spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true }).stdout || '').replace(/\0/g, '').trim();
console.log(`ASSERT T 目录 /tmp launch 残留 = ${sh(`ls ${target.wslHome}/.dsh/remote-wsl/ 2>/dev/null | grep -c '^launch\\.' || true`)}（期望 0）`);
if (MODE === 'empty') console.log(`ASSERT 空目录无副作用（stopped=${r.stopped?.length} killed=${r.killed?.length}）= ${r.stopped?.length === 0 && r.killed?.length === 0}`);
process.exit(0);
