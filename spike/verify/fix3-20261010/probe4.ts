/**
 * fix3-20261010/probe4.ts —— task-16 独立复验夹具（我自己写）。冻结 revision 见 REVISION.txt。
 * 两通道：`tool-*`/`agent` 走交付的插件工具；`dprompt` 直连 daemon-client 的协议层（可指定 per-call cwd）。
 * 确定性判据：调用后读 `/proc/<runtimePid>/cwd`（不靠模型自述）。
 * WSL 侧一律 wslRunScript / base64，**无内联 bash -c**。
 */
const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (n: string) => argv.includes(`--${n}`);
const mode = arg('mode', 'dprompt')!;
const DESKTOP_JSON =
  'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json';

const cfg: any = {
  distro: 'debian-u8-1',
  wslHome: arg('wsl-home', '/home/g'),
  cwd: arg('cfg-cwd', '/home/g'),
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  profile: 'sdk',
  dshVersion: '',
  webPort: 3082,
  idleTimeoutMs: 120000,
  timeoutMs: 180000,
  desktopRuntimeJson: DESKTOP_JSON,
  proxyPort: 9910,
  backend: arg('backend', 'daemon'),
  daemonPort: Number(arg('port', '8841')),
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonLingerMs: 600000,
  daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  useShellEnvironment: true,
  backgroundWarm: false,
};
const VERSION = '0.2.0-rc.2';
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
const procCwd = (pid: number | string) => wsl(`readlink -f /proc/${pid}/cwd 2>/dev/null || echo '(gone)'`).out;
const ensure = async () => client.ensureDaemon(cfg, { version: VERSION, log: (m: string) => out('# log: ' + m) });

out(`[probe4 pid=${process.pid}] mode=${mode} port=${cfg.daemonPort} backend=${cfg.backend}`);

if (mode === 'dprompt') {
  const key = arg('key', 'p1')!;
  const cwd = arg('cwd', undefined);
  const text = arg('text', '只回复 ACK')!;
  const e: any = await ensure();
  if (!e.ok) {
    out('# ensure FAILED: ' + e.error);
    process.exit(2);
  }
  const r: any = await client.daemonPrompt(cfg, { port: e.port, token: e.token, key, cwd, text });
  out(`# requested_cwd=${cwd ?? '(absent→守护 --cwd)'} daemonReportedCwd=${r.cwd ?? '-'} session=${r.sessionId} turns=${r.turns} runtimePid=${r.runtimePid} ok=${r.ok}`);
  out(`# /proc/${r.runtimePid}/cwd=${procCwd(r.runtimePid)}`);
  out('# answer=' + JSON.stringify(r.answer ?? r.error));
} else if (mode === 'dstatus') {
  const e: any = await ensure();
  const st: any = await client.daemonStatus(cfg);
  out('# daemonStatus.keys = ' + JSON.stringify((st.info?.keys ?? []).map((k: any) => ({ key: k.key, cwd: k.cwd, session: k.sessionId, turns: k.turns, runtimePid: k.runtimePid }))));
} else if (mode === 'agent') {
  const a: any = { task: arg('task', '只回复 ACK')!, key: arg('key', 'k1')! };
  if (arg('cwd', undefined)) a.cwd = arg('cwd');
  out('########## wsl_agent ##########');
  out(await call('wsl_agent', a));
} else if (mode === 'inhost-cwd') {
  // in-host 对照（未被 task-15 改动的那条路）：起前/起后对 profile sdk 进程取差集，读新 pid 的 /proc/<pid>/cwd
  const cwdWanted = arg('cwd', '/tmp')!;
  const listPids = () => {
    const r = wsl(`for p in $(pgrep -f -- 'profile sd[k]' 2>/dev/null); do echo $p; done | sort -n`);
    return new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean));
  };
  const before = listPids();
  out('########## in-host wsl_agent（cwd=' + cwdWanted + '）##########');
  out(await call('wsl_agent', { task: '只回复 ACK', key: 'inhost-cwd', cwd: cwdWanted }));
  await sleep(500);
  const after = listPids();
  const fresh = [...after].filter((p) => !before.has(p));
  out(`# 新增 profile sdk pid = [${fresh.join(',')}]`);
  for (const p of fresh) out(`# pid=${p} /proc/${p}/cwd=${procCwd(p)}`);
} else if (mode === 'tool-status') {
  out(await call('wsl_daemon', { action: 'status' }));
} else if (mode === 'tool-start' || mode === 'tool-stop') {
  const action = mode.slice(5);
  out(await call('wsl_daemon', has('all') ? { action, all: true } : { action }));
} else if (mode === 'exec') {
  out(await call('wsl_exec', { command: arg('command', 'echo hi')! }));
} else if (mode === 'script') {
  const r = wsl(Buffer.from(arg('script-b64', '')!, 'base64').toString('utf8'));
  out('--- stdout ---\n' + r.out + '\n--- stderr ---\n' + r.err);
} else if (mode === 'races') {
  // 起停竞态：连续 N 轮（每轮都是"起 → 停"），看 stop 是否仍偶发 connection closed before reply
  const rounds = Number(arg('rounds', '5'));
  for (let i = 1; i <= rounds; i++) {
    const s: any = await ensure();
    const t0 = Date.now();
    const r: any = await client.stopDaemon(cfg, { log: (m: string) => out(`#   [round ${i}] log: ${m}`) });
    out(`# round ${i}: ensure.ok=${s.ok} port=${s.port} pid=${s.info?.daemonPid} | stop.transport=${r.transport} ok=${r.ok} ms=${Date.now() - t0}`);
    await sleep(400);
  }
} else if (mode === 'sweep3') {
  // P2 三步：自建 own/foreign(活)/foreign(死) 三类 .pid/.sh，然后一次普通变更型调用
  const foreignAlive = Number(arg('foreign-alive', '0'));
  const deadLin = Number(arg('dead-linux-pid', '999999'));
  const mk = (winpid: number, tag: string) =>
    `printf 'x' > /tmp/dsh-rwsl-${winpid}-${tag}.sh; echo ${deadLin} > /tmp/dsh-rwsl-${winpid}-${tag}.pid`;
  const me = process.pid;
  const script1 = [mk(me, 'ownA'), mk(me, 'ownB'), foreignAlive ? mk(foreignAlive, 'foreignAlive') : 'true', mk(999998, 'foreignDead'), 'echo step1_done'].join('\n');
  out('# step1: ' + wsl(script1).out);
  out('# step1 count = ' + wsl(`find /tmp -maxdepth 1 -name 'dsh-rwsl-*' -printf '%f\\n' | sort | tr '\\n' ' '`).out);
  out('########## 一次普通变更型调用（wsl_exec ⇒ ensureSwept）##########');
  out(await call('wsl_exec', { command: 'echo sweep3-trigger' }));
  out('# step2 count = ' + wsl(`find /tmp -maxdepth 1 -name 'dsh-rwsl-*' -printf '%f\\n' | sort | tr '\\n' ' '`).out);
  out(`# 判据: own(${me}) 应 0；foreign(${foreignAlive}, 活) 应仍在；foreignDead(999998) 应被回收`);
  // step3: 我自己收尾（只删我造的）
  out('# step3: ' + wsl(`rm -f /tmp/dsh-rwsl-${me}-*.sh /tmp/dsh-rwsl-${me}-*.pid /tmp/dsh-rwsl-${foreignAlive}-*.sh /tmp/dsh-rwsl-${foreignAlive}-*.pid /tmp/dsh-rwsl-999998-*.sh /tmp/dsh-rwsl-999998-*.pid; echo step3_done`).out);
  out('# step3 count = ' + wsl(`find /tmp -maxdepth 1 -name 'dsh-rwsl-*' -printf '%f\\n' | sort | tr '\\n' ' '`).out);
} else {
  out('unknown mode: ' + mode);
  process.exit(2);
}
process.exit(0);
