/**
 * fix-20261010/probe2.ts —— task-11 独立复验夹具（**我自己写**，不复用 selftest.ts）。
 *
 * 两条通道：
 *  · `tool-*` 走**交付的插件工具**（最小 ctx 桩驱动 src/index.ts）⇒ 验产品行为；
 *  · `iso-*` 直接用 src/daemon-client.ts 的导出 API（launchDaemon/ensureDaemon/scanDaemonProcesses…）
 *    ⇒ 验槽位隔离、寿命闸门、孤儿回收这些内部契约。
 * WSL 侧检查一律走 `wslRunScript`（落文件 + bash <file>）或 `--script-b64`，**绝不用内联 bash -c**
 * ——已实测内联串会被发行版登录 shell（zsh）吃掉，`$VAR` 与 glob 会静默变空。
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
  daemonPort: Number(arg('port', '8861')),
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
const ctx: any = {
  inject: (_d: string[], cb: any) => cb({ get: () => ({ register: (t: any) => tools.push(t) }) }),
  get: () => undefined,
  effect: (fn: any) => {
    try {
      const d = fn();
    } catch {}
  },
};
mod.apply(ctx, cfg);
const call = async (n: string, a: Record<string, unknown>) => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error('未注册 ' + n);
  try {
    return String(await t.execute(a, { signal: new AbortController().signal }));
  } catch (e: any) {
    return `THROW(${n}): ${e?.message ?? String(e)}`;
  }
};
const scan = () => client.scanDaemonProcesses(cfg);
const slots = () => client.listDaemonSlots(cfg);
const metaPort = (slot: number) => client.readDaemonRecord(cfg, slot)?.meta?.port ?? null;
const wsl = (script: string) => {
  const r: any = client.wslRunScript(cfg, script);
  return { out: (r?.stdout ?? '').trim(), err: (r?.stderr ?? '').trim(), code: r?.exitCode };
};

out(`[probe2 pid=${process.pid}] mode=${mode} port=${cfg.daemonPort} dshVersion=${cfg.dshVersion || '(desktop)'}`);

if (mode === 'tool-status') {
  out('########## wsl_status ##########');
  out(await call('wsl_status', {}));
} else if (mode === 'tool-start') {
  out('########## wsl_daemon action=start ##########');
  out(await call('wsl_daemon', { action: 'start' }));
} else if (mode === 'tool-stop') {
  out(`########## wsl_daemon action=stop${has('all') ? ' all=true' : ''} ##########`);
  out(await call('wsl_daemon', has('all') ? { action: 'stop', all: true } : { action: 'stop' }));
} else if (mode === 'tool-openui') {
  out('########## wsl_open_ui ##########');
  out((await call('wsl_open_ui', { open: false })).replace(/token=\S+/, 'token=<masked>'));
  out(await call('wsl_open_ui', { stop: true }));
} else if (mode === 'tool-agent') {
  out('########## wsl_agent ##########');
  out(await call('wsl_agent', { task: arg('task', '只回复 ACK')!, key: arg('key', 'k')! }));
} else if (mode === 'tool-exec') {
  out(await call('wsl_exec', { command: arg('command', 'echo hi')! }));
} else if (mode === 'iso-start') {
  const port = Number(arg('port', '8861'));
  const l = client.launchDaemon(cfg, port, VERSION, (m: string) => out('# launch: ' + m));
  out('# launchDaemon = ' + JSON.stringify(l));
  let info: any = null;
  for (let i = 0; i < 80 && !info; i++) {
    await sleep(250);
    const rec = client.readDaemonRecord(cfg, port);
    if (!rec) continue;
    const hs = await client.handshake(cfg, rec.meta?.port ?? port, rec.token, cfg.daemonHandshakeTimeoutMs);
    if (hs.ok) info = { slot: port, port: hs.info.port, pid: hs.info.daemonPid, hsMs: hs.ms };
  }
  out('# iso-start result = ' + JSON.stringify(info));
  out('# slots = ' + JSON.stringify(slots()) + ' procs = ' + JSON.stringify(scan()));
  process.exit(info ? 0 : 1);
} else if (mode === 'iso-status') {
  const recs: any = {};
  for (const s of slots()) recs[s] = metaPort(s);
  out('# slots = ' + JSON.stringify(slots()));
  out('# metaPorts = ' + JSON.stringify(recs));
  out('# procs = ' + JSON.stringify(scan()));
  const listen: any = wsl("ss -ltn | awk '{print $4}' | grep -oE ':(88[0-9][0-9])$' | sort | tr '\\n' ' '");
  out('# listen = [' + listen.out + ']');
} else if (mode === 'iso-stop') {
  const r: any = has('all')
    ? await client.stopDaemon(cfg, { all: true, log: (m: string) => out('# log: ' + m) })
    : await client.stopDaemon(cfg, { log: (m: string) => out('# log: ' + m) });
  out('# stop = ' + JSON.stringify(r));
} else if (mode === 'iso-reclaim') {
  const port = Number(arg('port', '8861'));
  // 1) 造孤儿：起守护后删掉它的元数据（进程活着、端口占着）
  const l = client.launchDaemon(cfg, port, VERSION, () => {});
  let pid: number | null = null;
  for (let i = 0; i < 80 && !pid; i++) {
    await sleep(250);
    const rec = client.readDaemonRecord(cfg, port);
    if (!rec) continue;
    const hs = await client.handshake(cfg, rec.meta?.port ?? port, rec.token, cfg.daemonHandshakeTimeoutMs);
    if (hs.ok) pid = hs.info.daemonPid;
  }
  out(`# 孤儿守护 pid=${pid}（元数据即将删除）`);
  wsl(`rm -f ${client.stateDirLinux(cfg)}/daemon.${port}.json ${client.stateDirLinux(cfg)}/daemon.${port}.token`);
  out('# 删元数据后 procs = ' + JSON.stringify(scan()));
  // 2) 正常 ensure：必须收掉孤儿并在**请求槽位**起
  const e: any = await client.ensureDaemon(cfg, { version: VERSION, log: (m: string) => out('# log: ' + m) });
  out('# ensureDaemon = ' + JSON.stringify({ ok: e.ok, slot: e.slot, port: e.port, pid: e.info?.daemonPid, reused: e.reused }));
  for (const n of e.notes ?? []) out('#   note: ' + n);
  const ps = scan();
  out('# procs after = ' + JSON.stringify(ps));
  out(`# 判据: port==slot=${e.ok && Number(e.port) === port} orphanGone=${pid ? !ps.some((p: any) => p.pid === pid) : 'n/a'} exactlyOne=${ps.filter((p: any) => p.port === port || p.metaPort === port).length === 1}`);
} else if (mode === 'iso-compat') {
  const port = Number(arg('port', '8861'));
  const e1: any = await client.ensureDaemon(cfg, { version: VERSION, log: () => {} });
  out(`# 1st ensure: ok=${e1.ok} port=${e1.port} pid=${e1.info?.daemonPid} idleMs=${e1.info?.idleMs} lingerMs=${e1.info?.lingerMs}`);
  // soft：换个 idleMs 再 ensure（同一槽位）⇒ 期望"复用 + 显式回报"
  const cfgSoft = { ...cfg, daemonIdleMs: cfg.daemonIdleMs + 123456 };
  const e2: any = await client.ensureDaemon(cfgSoft, { version: VERSION, log: () => {} });
  out(`# 2nd ensure(soft idleMs=${cfgSoft.daemonIdleMs}): ok=${e2.ok} reused=${e2.reused} softMismatch=${JSON.stringify(e2.configSoftMismatch)}`);
  for (const n of e2.notes ?? []) out('#   note: ' + n);
  // hard：换 cwd 再 ensure ⇒ 期望明确报错
  const cfgHard = { ...cfg, cwd: '/tmp' };
  const e3: any = await client.ensureDaemon(cfgHard, { version: VERSION, log: () => {} });
  out(`# 3rd ensure(hard cwd=/tmp): ok=${e3.ok} error=${e3.error ?? '(none)'}`);
} else if (mode === 'iso-linger') {
  const port = Number(arg('port', '8861'));
  const ms = Number(arg('linger-ms', '9000'));
  cfg.daemonLingerMs = ms;
  cfg.daemonIdleMs = Math.max(cfg.daemonIdleMs, ms * 20);
  const l = client.launchDaemon(cfg, port, VERSION, (m: string) => out('# launch: ' + m));
  let pid: number | null = null;
  for (let i = 0; i < 80 && !pid; i++) {
    await sleep(250);
    const rec = client.readDaemonRecord(cfg, port);
    if (!rec) continue;
    const hs = await client.handshake(cfg, rec.meta?.port ?? port, rec.token, cfg.daemonHandshakeTimeoutMs);
    if (hs.ok) pid = hs.info.daemonPid;
  }
  out(`# linger 起守护 pid=${pid} lingerMs=${ms} idleMs=${cfg.daemonIdleMs}（无 key、无客户端）`);
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < ms * 3 + 8000) {
    await sleep(400);
    if (!scan().some((p: any) => p.pid === pid)) {
      gone = true;
      break;
    }
  }
  out(`# 结果: gone=${gone} elapsed=${Date.now() - t0}ms（期望 ≈${ms}ms）procs=${JSON.stringify(scan())} slots=${JSON.stringify(slots())}`);
} else if (mode === 'collision') {
  const port = Number(arg('port', '8861'));
  const count = Number(arg('count', '1'));
  const servers: any[] = [];
  for (let i = 0; i < count; i++) {
    const srv = net2.createServer((s: any) => s.on('error', () => {}));
    await new Promise<void>((res) => srv.listen(port + i, '127.0.0.1', () => res()));
    servers.push(srv);
  }
  out(`# Windows 侧已占 127.0.0.1:${Array.from({ length: count }, (_, i) => port + i).join(',')}（只接受连接、不回话）`);
  const t0 = Date.now();
  const text = await call('wsl_daemon', { action: 'start' });
  const ms = Date.now() - t0;
  out(`# wsl_daemon start 总耗时=${ms}ms`);
  out(text);
  out(`# 实际端口 ${port} 监听=${wsl(`ss -ltn | awk '$4 ~ /:${port}$/ {n++} END {print n+0}'`).out} 回退端口 ${port + 1} 监听=${wsl(`ss -ltn | awk '$4 ~ /:${port + 1}$/ {n++} END {print n+0}'`).out}`);
  out('# procs = ' + JSON.stringify(scan()));
  out('# launcher 残留 = ' + wsl(`ls -1 ${client.stateDirLinux(cfg)}/launch.*.sh 2>/dev/null | tr '\\n' ' '`).out);
  out('# launch-stderr.log = ' + (wsl(`tail -3 ${client.stateDirLinux(cfg)}/launch-stderr.log 2>/dev/null`).out || '(empty)'));
  for (const s of servers) s.close();
} else if (mode === 'script') {
  const b64 = arg('script-b64', '')!;
  const script = Buffer.from(b64, 'base64').toString('utf8');
  const r = wsl(script);
  out('--- stdout ---');
  out(r.out);
  out('--- stderr ---');
  out(r.err);
  out('--- exit=' + r.code + ' ---');
} else if (mode === 'agent') {
  out(await call('wsl_agent', { task: arg('task', '记住数字 41。只回复 ACK')!, key: arg('key', 'k1')! }));
} else {
  out('unknown mode: ' + mode);
  process.exit(2);
}
process.exit(0);
