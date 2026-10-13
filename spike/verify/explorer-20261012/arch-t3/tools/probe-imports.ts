/**
 * probe-imports.ts —— T3 的**逐导出调用探针**：对拆分后的每个导出符号**真的调用一次**，
 * 只为回答一个问题：*"这个函数的代码路径里有没有漏 import 的标识符？"*
 *
 * 为什么需要它：本仓是"零构建 TS + 相对 `.ts`"，**漏 import 不在语法期报错**，只在执行到那一行时
 * ReferenceError。所以对每个符号都构造一次"能进函数体但不产生副作用"的调用：
 *   · 纯函数 → 正常参数；
 *   · 会连守护 / 起守护 / 停他人的 → 用**不存在的 distro**（`__no_such_distro__`）让它在最早期失败，
 *     既进函数体又不碰真实 state dir、不起进程、不停别人的守护。
 *
 * 用法：node --experimental-strip-types probe-imports.ts [--out <json>]
 * 退出码：0 = 没有任何 ReferenceError；1 = 有（列出符号与标识符）
 */
import { writeFileSync } from 'node:fs';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const OUT = arg('out', '');

const client: any = await import(`file:///${ROOT}/src/daemon-client.ts`);
const protocol: any = await import(`file:///${ROOT}/src/daemon-protocol.ts`);
const launch: any = await import(`file:///${ROOT}/src/daemon-launch.ts`);
const lifecycle: any = await import(`file:///${ROOT}/src/daemon-lifecycle.ts`);

/** 真 cfg（**只用于只读调用**：路径拼接、元数据读、ps 扫描）。 */
const cfg = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', dshVersion: '',
  daemonPort: 8919, daemonPortTries: 1, timeoutMs: 3000, daemonHandshakeTimeoutMs: 400,
  daemonStartTimeoutMs: 4000, daemonIdleMs: 1800000, daemonQueueLimit: 4, useShellEnvironment: true,
};
/** 坏 distro cfg（**用于一切"会写/会起/会停"的调用**，保证最早期失败、零副作用）。 */
const bad = { ...cfg, distro: '__no_such_distro__' };

const CASES: Array<[string, () => unknown]> = [
  // protocol（纯/只读）
  ['unc', () => protocol.unc('debian-u8-1', '/home/g/x')],
  ['winToWsl', () => protocol.winToWsl('D:\\project\\x')],
  ['daemonScriptWsl', () => protocol.daemonScriptWsl()],
  ['stateDirLinux', () => protocol.stateDirLinux(cfg)],
  ['metaLinux', () => protocol.metaLinux(cfg)],
  ['tokenLinux', () => protocol.tokenLinux(cfg)],
  ['launchLinux', () => protocol.launchLinux(cfg)],
  ['logLinux', () => protocol.logLinux(cfg)],
  ['legacyMetaLinux', () => protocol.legacyMetaLinux(cfg)],
  ['legacyTokenLinux', () => protocol.legacyTokenLinux(cfg)],
  ['listDaemonSlots', () => protocol.listDaemonSlots(cfg)],
  ['readDaemonMeta', () => protocol.readDaemonMeta(cfg, 8919)],
  ['readDaemonToken', () => protocol.readDaemonToken(cfg, 8919)],
  ['readDaemonRecord', () => protocol.readDaemonRecord(cfg, 8919)],
  ['readDaemonLogTail', () => protocol.readDaemonLogTail(cfg, 2)],
  ['scanDaemonProcesses', () => protocol.scanDaemonProcesses(cfg)],
  ['wslRunScript', () => protocol.wslRunScript(cfg, 'true', 3000)],
  ['tcpCall', () => protocol.tcpCall(8919, [{ op: 'hello', token: 'x' }], 400)],
  ['handshake', () => protocol.handshake(cfg, 8919, 'bogus', 400)],
  ['callDaemon', () => protocol.callDaemon(cfg, { port: 8919, token: 'bogus', req: { op: 'status' }, timeoutMs: 400 })],
  ['daemonPrompt', () => protocol.daemonPrompt(cfg, { port: 8919, token: 'bogus', key: 'k', text: 'ACK', cwd: '/home/g', timeoutMs: 400 })],
  // launch（会写/会起 ⇒ 用坏 distro）
  ['systemdUnit', () => launch.systemdUnit(8919)],
  ['writeLauncherWsl', () => launch.writeLauncherWsl(bad, '/home/g/.dsh/remote-wsl/launch.8919.sh', 'echo probe')],
  ['removeLauncher', () => launch.removeLauncher(bad, 8919)],
  ['launchDaemon', () => launch.launchDaemon(bad, 8919, '0.0.0.0', () => {})],
  ['configCompat', () => launch.configCompat(cfg, { version: 'x', pid: 1 }, 'x')],
  ['killWslPid', () => launch.killWslPid(bad, 999999)],
  ['sleep', () => protocol.sleep(1)],
  // lifecycle（会起/会停 ⇒ 坏 distro）
  ['ensureDaemon', () => lifecycle.ensureDaemon(bad, { version: '0.0.0.0' })],
  ['stopDaemon', () => lifecycle.stopDaemon(bad, { slot: 8919 })],
  ['stopAllDaemons', () => lifecycle.stopAllDaemons(bad)],
  ['daemonSnapshot', () => lifecycle.daemonSnapshot(bad)],
  ['daemonStatus', () => lifecycle.daemonStatus(bad)],
];

const results: Array<Record<string, unknown>> = [];
for (const [name, fn] of CASES) {
  let cls = 'OK', msg = '';
  try { const v = await fn(); msg = `返回 ${v === undefined ? 'undefined' : typeof v}`; }
  catch (e: any) {
    if (e instanceof ReferenceError) { cls = 'REFERENCE_ERROR'; msg = e.message; }
    else { msg = `${e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 90)}`; }
  }
  results.push({ name, class: cls, detail: msg });
  console.log(`  ${cls === 'REFERENCE_ERROR' ? 'FAIL' : 'OK  '} ${name.padEnd(22)} ${msg}`);
}

const refErrors = results.filter((r) => r.class === 'REFERENCE_ERROR');
/** 顺带确认：新增的内部导出不进对外面。 */
const clientKeys = Object.keys(client).sort();
const extraInClient = clientKeys.filter((k) => ![
  'unc', 'winToWsl', 'daemonScriptWsl', 'stateDirLinux', 'metaLinux', 'tokenLinux', 'launchLinux', 'logLinux',
  'legacyMetaLinux', 'legacyTokenLinux', 'listDaemonSlots', 'readDaemonMeta', 'readDaemonToken', 'readDaemonRecord',
  'readDaemonLogTail', 'scanDaemonProcesses', 'wslRunScript', 'tcpCall', 'handshake', 'callDaemon', 'daemonPrompt',
  'systemdUnit', 'writeLauncherWsl', 'removeLauncher', 'launchDaemon', 'configCompat',
  'ensureDaemon', 'stopDaemon', 'stopAllDaemons', 'daemonSnapshot', 'daemonStatus'].includes(k));
console.log(`\n探针符号数 = ${CASES.length}；ReferenceError = ${refErrors.length}`);
console.log(`daemon-client 对外符号 = ${clientKeys.length}；多出 = ${extraInClient.length ? extraInClient.join(',') : '(无)'}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), results, clientKeys, extraInClient }, null, 2), 'utf8');
console.log(refErrors.length ? '\n结果：FAIL' : '\n结果：PASS');
process.exit(refErrors.length ? 1 : 0);
