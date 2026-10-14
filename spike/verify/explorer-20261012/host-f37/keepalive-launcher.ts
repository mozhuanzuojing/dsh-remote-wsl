// keepalive-launcher.ts —— 扮演"长驻宿主"：ensure 起守护，然后**一直活着** N 秒（不退出）。
// 用于分离两个变量：包装层死 vs 父进程死。守护日志/状态由外部脚本观察。
import { spawnSync } from 'node:child_process';
const PORT = Number(process.argv[2] || 8912);
const KEEP_MS = Number(process.argv[3] || 30000);
const MODE = process.argv[4] || 'fresh';
const VERSION = '0.2.0-rc.2';
const cfg = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', proxyPort: 9910, backend: 'daemon',
  daemonPort: PORT, daemonPortTries: 3, daemonIdleMs: 1800000, daemonLingerMs: 600000,
  daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
};
const client = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
if (MODE === 'fresh') await client.stopDaemon(cfg, { slot: PORT, log: () => {} });
const r =
  MODE === 'stop'
    ? await client.stopDaemon(cfg, { slot: PORT, log: (m) => out(`# ${m}`) })
    : await client.ensureDaemon(cfg, { version: VERSION, restart: MODE === 'restart', log: (m) => out(`# ${m}`) });
out(`LAUNCHED mode=${MODE} ok=${r.ok} pid=${r.info?.daemonPid ?? '-'} port=${r.port ?? '-'} reused=${r.reused === true} me=${process.pid}`);
const wrap = spawnSync('pwsh', ['-NoProfile', '-Command',
  `(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -EA SilentlyContinue | ? { $_.CommandLine -match 'launch\\.${PORT}\\.sh' } | % { $_.ProcessId }) -join ','`],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 });
out(`WRAPPER ${String(wrap.stdout || '').trim()}`);
// 长驻：保持父进程活着（模拟真实宿主）
await new Promise((res) => setTimeout(res, KEEP_MS));
out('KEEPALIVE-DONE');
process.exit(0);
