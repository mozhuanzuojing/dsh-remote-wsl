// probe-copy-detect.ts —— 回退"识别"分支测试：用**临时副本**把 systemd-run 变成不存在的命令，
// 走 auto 模式 ⇒ 必须识别为 SYSTEMD_FAIL → 回退 compat → 守护真活 → notes 里带告警。
// 不碰真机 PATH、不装任何东西；副本在 %TEMP%，测完删。
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SRC = 'D:/project/dsh1/vendor/dsh-remote-wsl/src';
const DIR = join(process.env.TEMP || '/tmp', 't17-sysd-copy');
const PORT = Number(process.argv[2] || 8912);
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
cpSync(join(SRC, 'daemon-client.ts'), join(DIR, 'daemon-client.ts'));
cpSync(join(SRC, 'daemon.ts'), join(DIR, 'daemon.ts'));
// 精准patch：只把启动脚本里的 systemd-run 换成不存在的命令
const f = join(DIR, 'daemon-client.ts');
let s = readFileSync(f, 'utf8');
const before = s.split('systemd-run').length - 1;
s = s.split("command -v systemd-run").join('command -v systemd-run-DOES-NOT-EXIST');
s = s.split('if out=$(systemd-run --user').join('if out=$(systemd-run-DOES-NOT-EXIST --user');
s = s.split('SYSTEMD_FAIL: 找不到 systemd-run（').join('SYSTEMD_FAIL: 找不到 systemd-run-DOES-NOT-EXIST（');
writeFileSync(f, s, 'utf8');
console.log(`[copy] ${DIR} patched（systemd-run 出现 ${before} 处，已替换脚本内 3 处）`);

const cfg = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', proxyPort: 9910, backend: 'daemon',
  daemonPort: PORT, daemonPortTries: 3, daemonIdleMs: 1800000, daemonLingerMs: 600000,
  daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
};
const client = await import(`file:///${DIR}/daemon-client.ts`);
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
await client.stopDaemon(cfg, { slot: PORT, log: () => {} });
const r = await client.ensureDaemon(cfg, { version: '0.2.0-rc.2', log: (m) => out(`# ${m}`) });
out(`RESULT ${JSON.stringify({ ok: r.ok, pid: r.info?.daemonPid, port: r.port, notes: r.notes })}`);
const rec = client.readDaemonRecord(cfg, PORT);
const hs = rec ? await client.handshake(cfg, rec.meta?.port ?? PORT, rec.token, 3000) : { ok: false };
out(`AFTER ${JSON.stringify({ handshakeOk: hs.ok === true, pid: hs.info?.daemonPid ?? null })}`);
await client.stopDaemon(cfg, { slot: PORT, log: () => {} });
rmSync(DIR, { recursive: true, force: true });
out('[copy] 已删除临时副本');
