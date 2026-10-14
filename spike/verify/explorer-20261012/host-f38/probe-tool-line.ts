// probe-tool-line.mjs —— F-38c 工具面：wsl_daemon action=start 输出里必须出现机器可读的 `launch: mode=… warning=…`
import { spawnSync } from 'node:child_process';
const mod = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts');
const tools = new Map();
const toolsSvc = { register: (t) => tools.set(t.name, t) };
const wsSvc = { register: () => () => {} };
const ctx = { inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? toolsSvc : wsSvc) }), get: () => undefined, effect: () => undefined };
const cfg = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
  profile: 'sdk', dshVersion: '', webPort: 3082, idleTimeoutMs: 120000, timeoutMs: 180000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: 'daemon', daemonPort: 8911, daemonPortTries: 3, daemonIdleMs: 1800000,
  daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 12000,
  useShellEnvironment: true, backgroundWarm: false,
};
mod.apply(ctx, cfg);
const call = async (n, a) => String(await tools.get(n).execute(a, { signal: new AbortController().signal }));
const startTxt = await call('wsl_daemon', { action: 'start' });
console.log('--- wsl_daemon action=start ---');
console.log(startTxt);
console.log(`\n含 launch: 行 = ${/^launch: mode=\S+ warning=/m.test(startTxt)}`);
const line = (startTxt.match(/^launch: .*$/m) || [''])[0];
console.log(`launch 行 = ${line}`);
const cleanup = spawnSync('wsl.exe', ['-d', 'debian-u8-1', '-u', 'g', '--', 'bash', '-c', 'ls /home/g/.dsh/remote-wsl/ | tr "\\n" " "'], { encoding: 'utf8', windowsHide: true }).stdout.replace(/\0/g, '').trim();
console.log(`start 后 state 目录 = [${cleanup}]（应无 launch.*.sh：守护已自删）`);
console.log('--- stop ---');
console.log(await call('wsl_daemon', { action: 'stop' }).then((s) => s.split('\n')[0]));
process.exit(0);
