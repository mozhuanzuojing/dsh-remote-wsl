/**
 * probe-p1.ts —— T25（P1）验收：stopDaemon 在"元数据已删、进程还在"时的隐形孤儿。
 *
 * 模式：
 *   normal  —— ① 正常 stop（改前/改后逐字对照用）
 *   orphan  —— ② 构造"守护不响应/不退出"：**真守护** + `kill -STOP`（真元数据、可真恢复）
 *
 * 纪律：端口 8911–8920；观测不弹窗（spawn 全 windowsHide）；每轮打印 ensure 的 `mode` 字段（systemd=无窗）。
 */
import { spawnSync } from 'node:child_process';

const MODE = process.argv[2] || 'normal';
const P = Number(process.argv[3] || 8912);
const D = 'debian-u8-1';
const STATE = '/home/g/.dsh/remote-wsl';
const cfg = {
  distro: D, wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', proxyPort: 9910, backend: 'daemon',
  daemonPort: P, daemonPortTries: 3, daemonIdleMs: 1800000, daemonLingerMs: 600000,
  daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
};
const client = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const sh = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').replace(/\0/g, '').trim();
};
const metaExists = (slot) => sh(`test -f ${STATE}/daemon.${slot}.json && echo yes || echo no`) === 'yes';
const scanPids = (slot) => client.scanDaemonProcesses(cfg).map((p) => `${p.pid}@${p.port}`).join(',') || '(none)';
const brief = (o) => JSON.stringify({ ok: o.ok, slot: o.slot ?? null, port: o.port ?? null, pid: o.pid ?? null, version: o.version ?? null, reused: o.reused ?? null, reaped: o.reaped ?? null, transport: o.transport ?? null, alivePids: o.alivePids ?? null, alreadyStopped: o.alreadyStopped ?? null, note: o.note ?? null, error: o.error ? o.error.slice(0, 150) : null });

out(`########## mode=${MODE} slot=${P} ##########`);
await client.stopDaemon(cfg, { slot: P, log: () => {} }).catch(() => {});
await new Promise((r) => setTimeout(r, 500));

const ens = await client.ensureDaemon(cfg, { version: '0.2.0-rc.2', log: () => {} });
out(`ENSURE ${brief(ens)}`);
if (!ens.ok) { out('ensure 失败，无法继续'); process.exit(2); }
const pid = ens.info?.daemonPid;
out(`PID ${pid}  META=${metaExists(P)}  SCAN=${scanPids(P)}  MODE=${ens.mode}`);

if (MODE === 'orphan') {
  out(`构造"不响应/不退出"：kill -STOP ${pid}（真守护被冻结；信号挂起 ⇒ 不退出、不响应）`);
  out(`  SIGSTOP 结果: ${sh(`kill -STOP ${pid} && sleep 0.3 && awk '{print $3}' /proc/${pid}/stat`)}  (T = stopped)`);
  const s1 = await client.stopDaemon(cfg, { slot: P, log: (m) => out(`  # ${m}`) });
  out(`STOP1 ${brief(s1)}`);
  out(`  ② 元数据仍在 = ${metaExists(P)}（期望 True）`);
  out(`  ② scanDaemonProcesses 仍可见 = ${scanPids(P)}（期望含 ${pid}）`);
  out(`  ② 返回可读失败 = ${s1.ok === false && String(s1.error || '').includes('保留元数据')}`);
  out(`恢复：kill -CONT ${pid} ⇒ 再 stop 一次（证明孤儿可被再次收掉、不是永久残留）`);
  out(`  SIGCONT 结果: ${sh(`kill -CONT ${pid} && sleep 0.5 && awk '{print $3}' /proc/${pid}/stat 2>/dev/null || echo gone`)}`);
  const s2 = await client.stopDaemon(cfg, { slot: P, log: (m) => out(`  # ${m}`) });
  out(`STOP2 ${brief(s2)}`);
  out(`  恢复后 元数据已清 = ${!metaExists(P)}（期望 True）  scan = ${scanPids(P)}（期望 none）`);
} else {
  const s = await client.stopDaemon(cfg, { slot: P, log: (m) => out(`  # ${m}`) });
  out(`STOP ${brief(s)}`);
  out(`① 元数据已清 = ${!metaExists(P)}（期望 True）`);
  out(`① 该槽位无进程 = ${scanPids(P)}（期望 none）`);
}
process.exit(0);
