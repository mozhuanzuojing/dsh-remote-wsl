// probe-slot-guard.mjs —— 回归：非配置槽位的动作必须被 F33 守卫拒绝（400/E_ARG），且**不产生任何副作用**。
import { spawnSync } from 'node:child_process';
const ex = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/explorer.ts');
const PORT = 8911;
const cfg = { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', daemonPort: PORT };
const before = spawnSync('wsl.exe', ['-d', 'debian-u8-1', '-u', 'g', '--', 'bash', '-c', 'ls /home/g/.dsh/remote-wsl/ | tr "\\n" " "'], { encoding: 'utf8', windowsHide: true }).stdout.replace(/\0/g, '').trim();
const { handlers } = ex.createExplorerHandlers({
  config: cfg,
  listDistros: () => ['debian-u8-1'],
  resolveVersion: () => ({ version: '0.2.0-rc.2', desktopVersion: '0.2.0-rc.2', pin: '0.2.0-rc.2', drift: null }),
  writePin: () => true,
  webHosts: new Map(),
});
let verdict = 'UNKNOWN';
try {
  await handlers['explorer.daemon']({ action: 'stop', slot: 9999 });
  verdict = 'NO-THROW（守卫失效！）';
} catch (e) {
  verdict = `throw code=${e?.code ?? '(none)'} ${e?.code === 'E_ARG' ? 'OK' : '（期望 E_ARG）'} :: ${String(e?.message).slice(0, 120)}`;
}
const after = spawnSync('wsl.exe', ['-d', 'debian-u8-1', '-u', 'g', '--', 'bash', '-c', 'ls /home/g/.dsh/remote-wsl/ | tr "\\n" " "'], { encoding: 'utf8', windowsHide: true }).stdout.replace(/\0/g, '').trim();
console.log(`slot=9999（非配置槽位，配置=${PORT}）=> ${verdict}`);
console.log(`state 目录 before=[${before}]`);
console.log(`state 目录 after =[${after}]`);
console.log(`无副作用（前后一致）= ${before === after}`);
process.exit(0);
