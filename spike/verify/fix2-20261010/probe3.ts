/**
 * fix2-20261010/probe3.ts —— task-14 独立复验夹具（我自己写，不复用实现者脚本）。
 * 冻结 revision 见同目录 REVISION.txt；本文件只读交付物、不改任何被验文件。
 * 通道：`tool-*` 走交付的插件工具（最小 ctx 桩）；`iso-*`/`snapshot`/`status-json` 直连
 * src/daemon-client.ts 的导出。WSL 侧一律 wslRunScript / base64，**无内联 bash -c**。
 */
import net2 from 'node:net';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (n: string) => argv.includes(`--${n}`);
const mode = arg('mode', 'tool-status')!;
const DESKTOP_JSON =
  'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json';

const cfg: any = {
  distro: arg('distro', 'debian-u8-1'),
  wslHome: '/home/g',
  cwd: arg('cwd', '/home/g'),
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  profile: arg('profile', 'sdk'),
  dshVersion: arg('dsh-version', ''),
  webPort: 3082,
  idleTimeoutMs: 120000,
  timeoutMs: 180000,
  desktopRuntimeJson: DESKTOP_JSON,
  proxyPort: 9910,
  backend: 'daemon',
  daemonPort: Number(arg('port', '8841')),
  daemonPortTries: Number(arg('tries', '3')),
  daemonIdleMs: Number(arg('idle-ms', '1800000')),
  daemonLingerMs: Number(arg('linger-ms', '600000')),
  daemonQueueLimit: Number(arg('queue-limit', '4')),
  daemonHandshakeTimeoutMs: Number(arg('handshake-ms', '3000')),
  daemonStartTimeoutMs: Number(arg('start-ms', '20000')),
  useShellEnvironment: true,
  backgroundWarm: false,
};
const VERSION = arg('version', '0.2.0-rc.2')!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (...a: any[]) => process.stdout.write(a.join(' ') + '\n');

const client: any = await import('../../../src/daemon-client.ts');
const tools: any[] = [];
const mod: any = await import('../../../src/index.ts');
mod.apply(
  {
    inject: (_d: string[], cb: any) => cb({ get: () => ({ register: (t: any) => tools.push(t) }) }),
    get: () => undefined,
    effect: () => undefined,
  },
  cfg,
);
const call = async (n: string, a: Record<string, unknown>) => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error('未注册 ' + n);
  try {
    return String(await t.execute(a, { signal: new AbortController().signal }));
  } catch (e: any) {
    return `THROW(${n}): ${e?.message ?? String(e)}`;
  }
};
const wsl = (script: string) => {
  const r: any = client.wslRunScript(cfg, script);
  return { out: (r?.stdout ?? '').trim(), err: (r?.stderr ?? '').trim() };
};
const snap = async () => {
  const s: any = await client.daemonSnapshot(cfg);
  const live0: any = Array.isArray(s.live) ? s.live[0] : s.live; // daemonSnapshot 的 live 是**数组**（多守护并存）
  return {
    slots: s.slots,
    liveCount: Array.isArray(s.live) ? s.live.length : s.live ? 1 : 0,
    deadCount: Array.isArray(s.dead) ? s.dead.length : 0,
    livePids: [...(s.livePids ?? [])],
    procs: s.procs,
    orphans: s.orphans,
    liveSlot: live0?.slot ?? null,
    livePort: live0?.info?.port ?? null,
    livePid: live0?.info?.daemonPid ?? null,
  };
};

out(`[probe3 pid=${process.pid}] mode=${mode} port=${cfg.daemonPort}`);

if (mode === 'tool-start' || mode === 'tool-status' || mode === 'tool-stop' || mode === 'tool-restart') {
  const action = mode.slice(5);
  out(`########## wsl_daemon action=${action}${has('all') ? ' all=true' : ''} ##########`);
  out(await call('wsl_daemon', has('all') ? { action, all: true } : { action }));
} else if (mode === 'wsl-status') {
  out('########## wsl_status（工具）##########');
  out(await call('wsl_status', {}));
} else if (mode === 'tool-exec') {
  out(await call('wsl_exec', { command: arg('command', 'echo hi')! }));
} else if (mode === 'agent') {
  out(await call('wsl_agent', { task: arg('task', '只回复 ACK')!, key: arg('key', 'k')! }));
} else if (mode === 'snapshot') {
  out('# snapshot = ' + JSON.stringify(await snap()));
} else if (mode === 'status-json') {
  const st: any = await client.daemonStatus(cfg);
  out(
    '# daemonStatus = ' +
      JSON.stringify({
        ok: st.ok,
        kind: st.kind,
        slot: st.slot,
        pid: st.info?.daemonPid ?? null,
        port: st.info?.port ?? null,
        orphans: st.orphans ?? [],
      }),
  );
} else if (mode === 'ensure-json') {
  const e: any = await client.ensureDaemon(cfg, { version: VERSION, log: (m: string) => out('# log: ' + m) });
  out(
    '# ensureDaemon = ' +
      JSON.stringify({ ok: e.ok, slot: e.slot, port: e.port, pid: e.info?.daemonPid, reused: e.reused, error: e.error }),
  );
  for (const n of e.notes ?? []) out('#   note: ' + n);
} else if (mode === 'iso-start') {
  const port = Number(arg('port', '8841'));
  const l = client.launchDaemon(cfg, port, VERSION, (m: string) => out('# launch: ' + m));
  let info: any = null;
  for (let i = 0; i < 80 && !info; i++) {
    await sleep(250);
    const rec = client.readDaemonRecord(cfg, port);
    if (!rec) continue;
    const hs = await client.handshake(cfg, rec.meta?.port ?? port, rec.token, cfg.daemonHandshakeTimeoutMs);
    if (hs.ok) info = { slot: port, port: hs.info.port, pid: hs.info.daemonPid, hsMs: hs.ms };
  }
  out('# iso-start = ' + JSON.stringify(info) + ' launch=' + JSON.stringify(l));
} else if (mode === 'iso-orphan') {
  // 造**真孤儿**：起守护 → 删掉它的元数据/token（进程继续活着并占着端口）
  const port = Number(arg('port', '8843'));
  const l = client.launchDaemon(cfg, port, VERSION, () => {});
  let pid: number | null = null;
  for (let i = 0; i < 80 && !pid; i++) {
    await sleep(250);
    const rec = client.readDaemonRecord(cfg, port);
    if (!rec) continue;
    const hs = await client.handshake(cfg, rec.meta?.port ?? port, rec.token, cfg.daemonHandshakeTimeoutMs);
    if (hs.ok) pid = hs.info.daemonPid;
  }
  wsl(`rm -f ${client.stateDirLinux(cfg)}/daemon.${port}.json ${client.stateDirLinux(cfg)}/daemon.${port}.token`);
  await sleep(300);
  const listening = wsl(`ss -ltn | awk '$4 ~ /:${port}$/ {n++} END {print n+0}'`).out;
  out(`# 真孤儿造好: pid=${pid} slot=${port} 元数据已删 listen=${listening} launch=${JSON.stringify(l)}`);
  out('# snapshot = ' + JSON.stringify(await snap()));
} else if (mode === 'script') {
  const script = Buffer.from(arg('script-b64', '')!, 'base64').toString('utf8');
  const r = wsl(script);
  out('--- stdout ---');
  out(r.out);
  out('--- stderr ---');
  out(r.err);
} else {
  out('unknown mode: ' + mode);
  process.exit(2);
}
process.exit(0);
