/**
 * probe-f37.ts —— F-37 修复验证：走**交付物本体**（src/daemon-client.ts）的真实 ensure/stop 路径。
 * 只碰 --port（默认 8912，属于 8911–8920 我的验证段），绝不碰他人的槽位。
 *
 * 模式：ensure / reuse / restart / stop / status / wrapperpid / perms
 */
import { readdirSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const MODE = arg('mode', 'ensure');
const PORT = Number(arg('port', '8912'));
const VERSION = arg('version', '0.2.0-rc.2');
const cfg = {
  distro: 'debian-u8-1',
  wslHome: '/home/g',
  cwd: '/home/g',
  profile: 'sdk',
  proxyPort: 9910,
  backend: 'daemon',
  daemonPort: PORT,
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonLingerMs: 600000,
  daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
};
const client = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const log = (m) => out(`# ${m}`);

const summarise = (r) => ({
  ok: r.ok,
  slot: r.slot ?? null,
  port: r.port ?? null,
  pid: r.info?.daemonPid ?? null,
  version: r.info?.version ?? null,
  reused: r.reused === true,
  started: r.started === true,
  alreadyStopped: r.alreadyStopped === true,
  error: r.error ?? null,
  notes: r.notes ?? [],
});

const stateDir = client.stateDirLinux(cfg);
const lsState = () => {
  try {
    return readdirSync(client.unc(cfg.distro, stateDir));
  } catch {
    return [];
  }
};

if (MODE === 'ensure' || MODE === 'reuse' || MODE === 'restart' || MODE === 'fresh') {
  if (MODE === 'fresh') await client.stopDaemon(cfg, { slot: PORT, log });
  const t0 = Date.now();
  const r = await client.ensureDaemon(cfg, { version: VERSION, restart: MODE === 'restart', log });
  out(`RESULT ${JSON.stringify({ ...summarise(r), ms: Date.now() - t0 })}`);
  out(`STATE ${JSON.stringify(lsState())}`);
} else if (MODE === 'stop') {
  const r = await client.stopDaemon(cfg, { slot: PORT, log });
  out(`RESULT ${JSON.stringify(summarise(r))}`);
  out(`STATE ${JSON.stringify(lsState())}`);
} else if (MODE === 'status') {
  const s = await client.daemonSnapshot(cfg);
  out(
    `RESULT ${JSON.stringify({
      slots: s.slots,
      live: (s.live ?? []).map((l) => ({ slot: l.slot, pid: l.info?.daemonPid, port: l.info?.port, keys: (l.info?.keys ?? []).length })),
      dead: (s.dead ?? []).map((d) => ({ slot: d.slot, kind: d.kind })),
      orphans: (s.orphans ?? []).map((o) => o.pid),
    })}`,
  );
} else if (MODE === 'handshake') {
  // 直接握手：证明守护**真的活着且在 Windows 侧可达**（不依赖元数据是否新鲜）
  const rec = client.readDaemonRecord(cfg, PORT);
  if (!rec) {
    out('RESULT {"ok":false,"error":"no metadata record"}');
  } else {
    const hs = await client.handshake(cfg, rec.meta?.port ?? PORT, rec.token, cfg.daemonHandshakeTimeoutMs);
    out(`RESULT ${JSON.stringify({ ok: hs.ok === true, kind: hs.kind, ms: hs.ms, pid: hs.info?.daemonPid ?? null, port: hs.info?.port ?? null, keys: (hs.info?.keys ?? []).length })}`);
  }
} else if (MODE === 'perms') {
  const r = client.wslRunScript(cfg, `ls -la ${stateDir} | grep -E 'launch-stderr|daemon\\.${PORT}' ; echo '---'; ls ${stateDir} | tr '\\n' ' '`);
  out(String(r.stdout || '').trim());
} else if (MODE === 'wrapperpid') {
  // 找**我这次槽位**的包装层 wsl.exe（命令行含 launch.<slot>.sh），只报告不杀
  out(`RESULT ${JSON.stringify({ port: PORT })}`);
} else {
  out(`unknown mode: ${MODE}`);
  process.exit(2);
}
process.exit(0);
