// probe-survive2.mjs —— 诊断：去掉 detached 之后，守护到底是怎么死的？
// 三种父进程寿命 × 观察 daemon.log / 元数据 / 包装层是否存在。
import { spawnSync } from 'node:child_process';
const D = 'debian-u8-1';
const PORT = Number(process.argv[2] || 8912);
const VERSION = '0.2.0-rc.2';
const KEEP_MS = Number(process.argv[3] || 9000);
const cfg = {
  distro: D, wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', proxyPort: 9910, backend: 'daemon',
  daemonPort: PORT, daemonPortTries: 3, daemonIdleMs: 1800000, daemonLingerMs: 600000,
  daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
};
const client = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = client.stateDirLinux(cfg);
const lsState = () => { try { return spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `ls -la ${stateDir} 2>&1 | tail -8`], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).stdout.replace(/\0/g, '').trim(); } catch { return ''; } };
const logTail = () => { try { return spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `tail -6 ${stateDir}/daemon.log 2>&1`], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).stdout.replace(/\0/g, '').trim(); } catch { return ''; } };
const wrap = () => {
  const ps = `(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -EA SilentlyContinue | ? { $_.CommandLine -match 'launch\\.${PORT}\\.sh' } | % { "wrap-pid=$($_.ProcessId) ppid=$($_.ParentProcessId)" }) -join ' | '`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String(r.stdout || '').trim() || '(无包装层)';
};

await client.stopDaemon(cfg, { slot: PORT, log: () => {} });
out(`[0] 清场后 state 目录:\n${lsState()}`);
const r = await client.ensureDaemon(cfg, { version: VERSION, log: (m) => out(`# ${m}`) });
out(`[1] ensure ok=${r.ok} slot=${r.slot} port=${r.port} pid=${r.info?.daemonPid}`);
out(`[1] 包装层: ${wrap()}`);
out(`[1] daemon.log:\n${logTail()}`);
await sleep(KEEP_MS);
out(`\n[2] 父进程仍活着（已过 ${KEEP_MS}ms）`);
out(`[2] 包装层: ${wrap()}`);
const rec = client.readDaemonRecord(cfg, PORT);
out(`[2] readDaemonRecord = ${rec ? `slot=${rec.slot} pid=${rec.meta?.pid} port=${rec.meta?.port}` : 'NULL（元数据没了）'}`);
out(`[2] daemon.log:\n${logTail()}`);
out(`[2] state 目录:\n${lsState()}`);
const hs = rec ? await client.handshake(cfg, rec.meta?.port ?? PORT, rec.token, 3000) : { ok: false, kind: 'no-record' };
out(`[2] handshake ok=${hs.ok === true} kind=${hs.kind} pid=${hs.info?.daemonPid ?? '-'}`);
out(`[2] 收尾 stop`);
await client.stopDaemon(cfg, { slot: PORT, log: () => {} });
out(`[3] 最终 state:\n${lsState()}`);
