/**
 * probe-f38.ts —— task-19（F-38）验收：启动脚本卫生 + mode/warning 字段。
 * 端口只用 8911–8920（本任务验证段）。全部走真源码；观测不弹窗（spawn 均 windowsHide）。
 *
 * 模式：scenario-on / normal / off / restart / residue
 */
import { spawn, spawnSync } from 'node:child_process';

const MODE = process.argv[2] || 'normal';
const D = 'debian-u8-1';
const WANT = Number(process.argv[3] || 8911);
const TRIES = 3;
const STATE = '/home/g/.dsh/remote-wsl';
const cfg = {
  distro: D, wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', proxyPort: 9910, backend: 'daemon',
  daemonPort: WANT, daemonPortTries: TRIES, daemonIdleMs: 1800000, daemonLingerMs: 600000,
  daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 12000,
};
const client = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').replace(/\0/g, '').trim();
};
const scan = () => sh(`ls -la ${STATE} 2>/dev/null | awk '$NF ~ /^launch\\./ {print $1, $NF}'; echo "---meta---"; ls ${STATE} | grep -c '^daemon\\.[0-9]*\\.json$' || true`);
const daemons = () => sh(`pgrep -af "daemon.t[s]" | wc -l | tr -d ' '`);

out(`=== mode=${MODE} wantSlot=${WANT} tries=${TRIES}（DSH_REMOTE_WSL_SYSTEMD=${process.env.DSH_REMOTE_WSL_SYSTEMD ?? 'auto'}）===`);
// 起始现场
out(`[before] launch 残留:\n${scan()}`);
out(`[before] 守护进程数 = ${daemons()}`);

// 观测启动脚本的**创建权限**：WSL 侧每 100ms 采样一次（脚本可能很快被守护自删）
const WATCH = `rm -f /tmp/t19-watch.txt; for i in $(seq 1 120); do for p in ${WANT} ${WANT + 1} ${WANT + 2}; do [ -f ${STATE}/launch.$p.sh ] && stat -c "%a %n" ${STATE}/launch.$p.sh >> /tmp/t19-watch.txt; done; sleep 0.1; done; echo WATCH-DONE`;
const watcher = spawn('wsl.exe', ['-d', D, '-u', 'g', '-e', 'bash', '-c', WATCH], { stdio: 'ignore', windowsHide: true });

if (MODE === 'residue') {
  out(`[residue] 只看现场（不动作）`);
} else {
  if (MODE === 'normal' || MODE === 'restart') await client.stopDaemon(cfg, { slot: WANT, log: () => {} });
  if (MODE === 'off') process.env.DSH_REMOTE_WSL_SYSTEMD = 'off';
  const r = await client.ensureDaemon(cfg, { version: '0.2.0-rc.2', restart: MODE === 'restart', log: (m) => out(`# ${m}`) });
  out(`RESULT ${JSON.stringify({ ok: r.ok, reused: r.reused === true, mode: r.mode ?? null, warning: r.warning ?? null, slot: r.slot ?? null, pid: r.info?.daemonPid ?? null, tried: r.tried ?? null, error: r.error ? r.error.slice(0, 220) : null })}`);
  out(`notes 里是否仍含 mode/告警: ${JSON.stringify((r.notes || []).filter((n) => /启动方式|未能由 systemd/.test(n)).map((s) => s.slice(0, 60)))}`);
}

await sleep(1200);
out(`[after] launch 残留:\n${scan()}`);
out(`[after] 守护进程数 = ${daemons()}`);
out(`[watch] 观测到的启动脚本权限采样（应无 6 开头以外）:\n${sh('sort -u /tmp/t19-watch.txt 2>/dev/null | head -8; echo "采样行数=$(wc -l < /tmp/t19-watch.txt 2>/dev/null || echo 0)"')}`);
if (MODE === 'scenario-on') {
  out(`[scenario] 是否残留 launch.* = ${sh(`ls ${STATE} | grep -c '^launch\\.' || true`)}`);
  out(`[scenario] 是否起了守护 = ${daemons()}`);
}
if (MODE !== 'residue') await client.stopDaemon(cfg, { slot: WANT, log: () => {} });
try { watcher.kill(); } catch {}
sh(`rm -f /tmp/t19-watch.txt`);
process.exit(0);
