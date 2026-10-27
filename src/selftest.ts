/**
 * dsh-remote-wsl / selftest —— 守护链路的**可复现验收脚手架**（不参与插件运行，只在验收时手动跑）。
 *
 * 用法（Windows 侧，桌面自带 node 即可）：
 *   node src/selftest.ts status            # 守护可见性：pid/端口/version/keys（不启动）
 *   node src/selftest.ts prompt <key> <文本>   # 一轮 prompt（跨进程重连就是跑两次这个，key 相同）
 *   node src/selftest.ts queue <n> [limit]     # 同 key n 个并发：串行 FIFO + 超限明确拒绝
 *   node src/selftest.ts collision <port>      # Windows 侧先占端口 ⇒ 就绪判据必须快速失败并换端口
 *   node src/selftest.ts stop                  # 显式停守护（会话结束的三种方式之一）
 *
 * 为什么不打印 token：token 是 0600 文件里的凭据，脚手架只报告"文件在不在"。
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureDaemon,
  daemonPrompt,
  daemonStatus,
  stopDaemon,
  readDaemonMeta,
  readDaemonToken,
  readDaemonRecord,
  readDaemonLogTail,
  listDaemonSlots,
  launchDaemon,
  handshake,
  scanDaemonProcesses,
  wslRunScript,
  stateDirLinux,
} from './daemon-client.ts';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'status';
const argOf = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const cfg: any = {
  distro: argOf('distro', 'debian-u8-1'),
  wslHome: argOf('wsl-home', '/home/g'),
  cwd: argOf('cwd', '/home/g'),
  profile: 'sdk',
  daemonPort: Number(argOf('port', '8731')),
  daemonPortTries: Number(argOf('tries', '3')),
  daemonIdleMs: Number(argOf('idle-ms', '1800000')),
  daemonLingerMs: Number(argOf('linger-ms', '600000')),
  daemonQueueLimit: Number(argOf('queue-limit', '4')),
  daemonHandshakeTimeoutMs: Number(argOf('handshake-ms', '3000')),
  daemonStartTimeoutMs: Number(argOf('start-ms', '20000')),
  timeoutMs: Number(argOf('timeout-ms', '300000')),
  proxyPort: 9910,
  backend: 'daemon',
};
const VERSION = argOf('version', '0.2.0-rc.2');
const log = (m: string) => process.stderr.write(`[selftest] ${m}\n`);
const say = (...a: any[]) => process.stdout.write(a.join(' ') + '\n');

const tokenFileExists = () => Boolean(readDaemonToken(cfg));

if (cmd === 'status') {
  const s: any = await daemonStatus(cfg);
  say('status.ok =', s.ok, 'kind =', s.kind, `ms=${s.ms ?? '-'}`);
  if (s.ok) say(JSON.stringify(s.info, null, 2));
  else say('error =', s.error);
  say('state dir       =', stateDirLinux(cfg));
  say('daemon slots    =', JSON.stringify(listDaemonSlots(cfg)), '(每个并发守护一个槽位文件，互不覆盖)');
  say('daemon.json     =', JSON.stringify(readDaemonMeta(cfg, cfg.daemonPort)?.port ?? null), '(本槽位实际端口)');
  say('daemon.token    =', tokenFileExists() ? 'present(0600, 值不打印)' : 'absent');
  process.exit(s.ok ? 0 : 1);
}

if (cmd === 'ensure') {
  // 只起/复用守护，**不发 prompt**（不调模型）—— 用于并发隔离与 /tmp 足迹测量
  if (argv.includes('--isolated')) {
    // 跳过"复用任意存活守护"，直接在指定槽位起一个：证明**两个守护可以并存**（元数据按槽位分文件）
    const port = cfg.daemonPort;
    const l = launchDaemon(cfg, port, VERSION, log);
    if (!l.ok) {
      say('# launchDaemon FAILED:', l.error);
      process.exit(1);
    }
    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const rec = readDaemonRecord(cfg, port);
      if (!rec) continue;
      const hs = await handshake(cfg, rec.meta?.port ?? port, rec.token, cfg.daemonHandshakeTimeoutMs);
      if (hs.ok) {
        say(`# isolated daemon ok slot=${port} port=${hs.info.port} pid=${hs.info.daemonPid}（Windows 侧握手 ${hs.ms}ms）`);
        done = true;
      }
    }
    say('# slots now =', JSON.stringify(listDaemonSlots(cfg)));
    process.exit(done ? 0 : 1);
  }
  const e: any = await ensureDaemon(cfg, { version: VERSION, restart: argv.includes('--restart'), log });
  say('# ensureDaemon:', e.ok ? `ok slot=${e.slot} port=${e.port} pid=${e.info?.daemonPid} reused=${e.reused === true}` : 'FAILED');
  say('# notes:', (e.notes ?? []).join(' | ') || '(none)');
  if (!e.ok) say('# error:', e.error);
  say('# slots now =', JSON.stringify(listDaemonSlots(cfg)));
  process.exit(e.ok ? 0 : 1);
}

if (cmd === 'prompt') {
  const key = argv[1] ?? 'default';
  const text = argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
  const t0 = Date.now();
  const e: any = await ensureDaemon(cfg, { version: VERSION, log });
  if (!e.ok) {
    say('ensureDaemon FAILED:', e.error);
    process.exit(2);
  }
  say(`# ensureDaemon ok port=${e.port} reused=${e.reused === true} pid=${e.info?.daemonPid} version=${e.info?.version} (${Date.now() - t0}ms)`);
  say('# notes:', (e.notes ?? []).join(' | ') || '(none)');
  const r: any = await daemonPrompt(cfg, { port: e.port, token: e.token, key, text });
  say('# prompt result:', JSON.stringify({ ...r }));
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'queue') {
  const n = Number(argv[1] ?? '6');
  const key = argOf('key', `q-${Date.now()}`);
  const e: any = await ensureDaemon(cfg, { version: VERSION, log });
  if (!e.ok) {
    say('ensureDaemon FAILED:', e.error);
    process.exit(2);
  }
  say(`# ensureDaemon ok port=${e.port} reused=${e.reused === true} queueLimit=${cfg.daemonQueueLimit} key=${key}`);
  const t0 = Date.now();
  const jobs = Array.from({ length: n }, (_, i) =>
    daemonPrompt(cfg, { port: e.port, token: e.token, key, text: `只回复 Q${i + 1}` }).then((r: any) => ({
      i: i + 1,
      at: Date.now() - t0,
      ...r,
    })),
  );
  const results: any[] = await Promise.all(jobs);
  for (const r of results) {
    say(
      `# 第 ${r.i} 个并发: ok=${r.ok} at=${r.at}ms` +
        (r.ok ? ` answer=${JSON.stringify(r.answer)} turns=${r.turns}` : ` queueFull=${r.queueFull === true} error=${r.error}`),
    );
  }
  const ok = results.filter((r) => r.ok);
  const rejected = results.filter((r) => r.queueFull === true);
  say(`# 汇总: accepted=${ok.length} rejected=${rejected.length}（串行：ok 的 at 必须单调递增）`);
  const monotonic = ok.every((r, i) => i === 0 || r.at >= ok[i - 1].at);
  say('# 串行单调（FIFO 完成顺序）:', monotonic);
  process.exit(rejected.length === Math.max(0, n - cfg.daemonQueueLimit - 1) ? 0 : 1);
}

if (cmd === 'collision') {
  const port = Number(argv[1] ?? String(cfg.daemonPort));
  const count = Number(argv[2] ?? '1'); // 占住 [port, port+count-1]：count=1 验"换端口"，count=tries 验"可读报错"
  cfg.daemonPort = port;
  const servers: any[] = [];
  for (let i = 0; i < count; i++) {
    const p = port + i;
    const server = net.createServer((s) => {
      /* 只接受连接、从不回话：模拟"Windows 命名空间里被别的属主占用" */
      s.on('error', () => {});
    });
    await new Promise<void>((res) => server.listen(p, '127.0.0.1', () => res()));
    servers.push(server);
  }
  say(
    `# Windows 侧已占用 127.0.0.1:${Array.from({ length: count }, (_, i) => port + i).join(',')}` +
      `（只接受连接、不回话 —— 正是 task-2 复现的那个静默失败场景）`,
  );
  const t0 = Date.now();
  // noReuse：碰撞用例要**强制**在指定槽位起守护，不能被别的槽位的存活守护"复用"掉
  const e: any = await ensureDaemon(cfg, { version: VERSION, noReuse: true, log });
  const ms = Date.now() - t0;
  say('# ensureDaemon:', e.ok ? `ok port=${e.port}` : 'FAILED', `总耗时=${ms}ms（浏览器/调用方看到的是这个，不是 300s）`);
  say('# notes:', (e.notes ?? []).join(' | ') || '(none)');
  if (!e.ok) say('# error:', e.error);
  say('# daemon.log 尾部:', readDaemonLogTail(cfg, 4).split('\n').join(' / '));
  // 追加验收（task-9）：请求槽位就绪失败后**不得留下孤儿** —— 前后对照
  say(`# AFTER /proc 扫描 = ${JSON.stringify(scanDaemonProcesses(cfg))}`);
  say(
    `# AFTER listen: 占位端口=${(wslRunScript(cfg, `ss -ltn | awk '$4 ~ /:${port}$/ {n++} END {print n+0}'`).stdout || '').trim()} ` +
      `回退端口=${(wslRunScript(cfg, `ss -ltn | awk '$4 ~ /:${port + 1}$/ {n++} END {print n+0}'`).stdout || '').trim()}`,
  );
  for (const s of servers) s.close();
  process.exit(e.ok ? 0 : 1);
}

if (cmd === 'stop') {
  if (argv.includes('--all')) {
    const r: any = await stopDaemon(cfg, { log, all: true }); // 含无元数据孤儿（身份扫描）
    say('# stopDaemon --all:', JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  const r: any = await stopDaemon(cfg, { log });
  say('# stopDaemon:', JSON.stringify(r));
  // 2026-10-27 审查 F-20：stopDaemon 在「守护仍在」时会返回 ok:false + alivePids（并保留元数据）。
  // 这里以前恒 exit 0 ⇒ 验收输出「停止通过」不可信。按真实结果退出。
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'race') {
  // task-9 #1 的复现脚本：两个**独立进程**同时启动两个槽位（原缺陷：全局单文件 launch.sh 互相覆盖 ⇒
  // 元数据 port 与实际监听不一致、多出守护、留下不可发现孤儿）
  const a = Number(argv[1] ?? '0');
  const b = Number(argv[2] ?? '0');
  const self = fileURLToPath(import.meta.url);
  const run = (port: number) =>
    new Promise<number>((res) => {
      const child = spawn(process.execPath, [self, 'ensure', '--port', String(port), '--isolated'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('exit', (code) => {
        for (const l of out.trim().split('\n')) say(`#   [slot ${port}] ${l}`);
        res(code ?? 1);
      });
    });
  const t0 = Date.now();
  const [ca, cb] = await Promise.all([run(a), run(b)]);
  const slots = listDaemonSlots(cfg);
  const procs = scanDaemonProcesses(cfg);
  say(`# 两槽位并发启动完成 ${Date.now() - t0}ms（child exit: ${ca}/${cb}）`);
  say(`# metadata slots = ${JSON.stringify(slots)}`);
  say(`# daemon processes = ${JSON.stringify(procs)}`);
  let ok = true;
  for (const slot of [a, b]) {
    const rec = readDaemonRecord(cfg, slot);
    const metaPort = Number(rec?.meta?.port);
    // 用 **Windows 侧握手**证明"这个槽位的端口真的在服务本守护"（与 #11 的就绪判据同一把尺子）
    const hs: any = rec ? await handshake(cfg, metaPort, rec.token, 3000) : { ok: false };
    const good = Boolean(rec) && metaPort === slot && hs.ok === true;
    say(
      `# slot ${slot}: metaPort=${rec?.meta?.port ?? '-'} windowsHandshake=${hs.ok ? `ok(${hs.ms}ms)` : 'FAIL'} => ${good ? 'OK' : 'MISMATCH'}`,
    );
    if (!good) ok = false;
  }
  say(`# 守护进程数 = ${procs.length}（期望恰好 2 ⇒ 2 请求 = 2 守护）`);
  if (procs.length !== 2) ok = false;
  process.exit(ok ? 0 : 1);
}

if (cmd === 'orphans') {
  const st: any = await daemonStatus(cfg);
  say(
    `# daemonStatus: ok=${st.ok} kind=${st.kind} slot=${st.slot} pid=${st.info?.daemonPid ?? '-'} port=${st.info?.port ?? '-'}`,
  );
  say(`# status.orphans  = ${JSON.stringify(st.orphans ?? [])}`);
  say(`# proc-scan       = ${JSON.stringify(scanDaemonProcesses(cfg))}`);
  process.exit(0);
}

if (cmd === 'linger') {
  const ms = Number(argv[1] ?? '8000');
  cfg.daemonLingerMs = ms; // 位置参数就是闸门值（否则 launchDaemon 会带上默认 600000，等 30 分钟）
  cfg.daemonIdleMs = Math.max(cfg.daemonIdleMs, ms * 10); // 确保观察到的退出不是 idle 回收
  const port = cfg.daemonPort;
  const l = launchDaemon(cfg, port, VERSION, log);
  if (!l.ok) {
    say('# launchDaemon FAILED:', l.error);
    process.exit(1);
  }
  let pid: number | null = null;
  for (let i = 0; i < 60 && !pid; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const rec = readDaemonRecord(cfg, port);
    if (!rec) continue;
    const hs = await handshake(cfg, rec.meta?.port ?? port, rec.token, cfg.daemonHandshakeTimeoutMs);
    if (hs.ok) pid = hs.info.daemonPid;
  }
  say(`# 起守护 pid=${pid} lingerMs=${cfg.daemonLingerMs} idleMs=${cfg.daemonIdleMs}（无 key、无客户端）`);
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < cfg.daemonLingerMs * 3 + 5000) {
    await new Promise((r) => setTimeout(r, 500));
    if (!scanDaemonProcesses(cfg).some((p) => p.pid === pid)) {
      gone = true;
      break;
    }
  }
  const elapsed = Date.now() - t0;
  say(`# 寿命闸门：守护${gone ? '已自退' : '仍在跑'}，耗时 ${elapsed}ms（期望 ≈${cfg.daemonLingerMs}ms）`);
  say(`# 残留进程 = ${JSON.stringify(scanDaemonProcesses(cfg))}`);
  say(`# 残留元数据 = ${JSON.stringify(listDaemonSlots(cfg))}`);
  process.exit(gone ? 0 : 1);
}

if (cmd === 'drift') {
  // 用**最小 ctx 桩**驱动插件工具（不调模型）：验证显式 dshVersion 与守护版本不一致时**必须报警**
  // （task-9 #3：以前只比 desktop/pin，`dshVersion:'0.1.0-fake'` 时完全没有报警）
  const fake = argv[1] ?? '0.1.0-fake';
  const e: any = await ensureDaemon(cfg, { version: VERSION, log });
  if (!e.ok) {
    say('# ensureDaemon FAILED:', e.error);
    process.exit(1);
  }
  say(`# 守护在跑：pid=${e.info?.daemonPid} port=${e.port} version=${e.info?.version}`);
  const mod: any = await import('./index.ts');
  const tools: any[] = [];
  const ctx: any = {
    inject: (_deps: string[], cb: any) => cb({ get: () => ({ register: (t: any) => tools.push(t) }) }),
    get: () => undefined,
    effect: () => undefined,
  };
  mod.apply(ctx, {
    distro: cfg.distro,
    wslHome: cfg.wslHome,
    cwd: cfg.cwd,
    dshVersion: fake,
    daemonPort: cfg.daemonPort,
  });
  const tool = tools.find((t) => t.name === 'wsl_status');
  const text = String(await tool.execute({}, { signal: new AbortController().signal }));
  for (const l of text.split('\n').filter((l) => l.startsWith('daemon'))) say('# ' + l);
  const alarm = text.split('\n').find((l) => l.startsWith('daemon drift'));
  say(`# alarm=${Boolean(alarm)}（期望：与守护版本不一致 ⇒ true；一致 ⇒ false）`);
  process.exit(alarm ? 0 : 1);
}

if (cmd === 'reclaim') {
  // task-9 追加 A/B 的验收：请求槽位上**已有本插件的孤儿守护**（元数据被删、进程还占着端口）时，
  // ensureDaemon 必须**先把它收掉、再在同一个请求槽位起新的**，而不是静默迁移到 slot+1 把孤儿留在原地。
  const port = Number(argv[1] ?? cfg.daemonPort);
  cfg.daemonPort = port;
  const self = fileURLToPath(import.meta.url);
  const listenCount = (p: number) => (wslRunScript(cfg, `ss -ltn | awk '$4 ~ /:${p}$/ {n++} END {print n+0}'`).stdout || '').trim();
  const stateDir = stateDirLinux(cfg);

  // 1) 造一个孤儿：isolated 起守护 → 删掉它的元数据（进程活着、端口占着）
  const childOut: string[] = [];
  const childRc = await new Promise<number>((res) => {
    const c = spawn(process.execPath, [self, 'ensure', '--port', String(port), '--isolated'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.stdout.on('data', (d) => childOut.push(String(d)));
    c.stderr.on('data', (d) => childOut.push(String(d)));
    c.on('exit', (x) => res(x ?? 1));
  });
  const beforeRec = readDaemonRecord(cfg, port);
  const orphanPid = Number(beforeRec?.meta?.pid);
  const orphanListens = listenCount(port) === '1';
  say(`# 造孤儿: isolated 子进程 exit=${childRc} ${childOut.join('').trim().split('\n').slice(-1)[0] ?? ''}`);
  say(`# BEFORE: orphanPid=${orphanPid} listen_${port}=${listenCount(port)}`);
  if (!orphanPid || !orphanListens) {
    say('# FAIL: 孤儿没造出来（元数据/监听缺一）⇒ 本用例无效，不做结论');
    process.exit(1);
  }
  wslRunScript(cfg, `rm -f ${stateDir}/daemon.${port}.json ${stateDir}/daemon.${port}.token ${stateDir}/daemon.${port}.json.tmp`);
  say(`# BEFORE 元数据已删（进程 ${orphanPid} 仍活着、端口仍占着）`);
  say(`# BEFORE /proc 扫描 = ${JSON.stringify(scanDaemonProcesses(cfg))}`);

  // 2) 正常 ensure：必须复用/收掉孤儿，并在**请求槽位**起（或复用）守护
  const e: any = await ensureDaemon(cfg, { version: VERSION, log });
  const afterProcs = scanDaemonProcesses(cfg);
  say(
    `# AFTER ensureDaemon: ok=${e.ok} slot=${e.slot} port=${e.port} pid=${e.info?.daemonPid} reused=${e.reused === true}`,
  );
  for (const n of e.notes ?? []) say(`#   note: ${n}`);
  say(`# AFTER listen_${port}=${listenCount(port)}`);
  say(`# AFTER /proc 扫描 = ${JSON.stringify(afterProcs)}`);
  const okPort = e.ok && Number(e.port) === port && Number(e.slot) === port;
  const noOrphan = orphanPid ? !afterProcs.some((p) => p.pid === orphanPid) : true;
  const exactlyOne = afterProcs.filter((p) => p.port === port || p.metaPort === port).length === 1;
  say(`# 判据: port===slot ${okPort ? 'OK' : 'FAIL'} / 孤儿已收掉 ${noOrphan ? 'OK' : 'FAIL'} / 该槽位恰好 1 个守护 ${exactlyOne ? 'OK' : 'FAIL'}`);
  process.exit(okPort && noOrphan && exactlyOne ? 0 : 1);
}

/** 用最小 ctx 桩驱动插件工具（不调模型）——"工具返回原文"类对照的公共入口。 */
async function driveTool(name: string, args: any, overrides: any = {}) {
  const mod: any = await import('./index.ts');
  const tools: any[] = [];
  const ctx: any = {
    inject: (_deps: string[], cb: any) => cb({ get: () => ({ register: (t: any) => tools.push(t) }) }),
    get: () => undefined,
    effect: () => undefined,
  };
  mod.apply(ctx, { distro: cfg.distro, wslHome: cfg.wslHome, cwd: cfg.cwd, daemonPort: cfg.daemonPort, ...overrides });
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`没有这个工具: ${name}（有 ${tools.map((t) => t.name).join(', ')}）`);
  return await tool.execute(args, { signal: new AbortController().signal });
}

if (cmd === 'cwdcheck') {
  // P1 验收（确定性）：per-call cwd 必须真的生效 —— 用**远端 /proc/<runtimePid>/cwd** 证明，
  // 不依赖模型自述的 pwd（模型可能答错或被裁剪）。
  const key = argv[1] ?? 'cwdcheck';
  const want = argv[2] ?? '/tmp';
  const e: any = await ensureDaemon(cfg, { version: VERSION, log });
  if (!e.ok) {
    say('# ensureDaemon FAILED:', e.error);
    process.exit(1);
  }
  const cases: Array<[string, string | undefined]> = [
    ['requested', want],
    ['default', undefined],
  ];
  for (const [label, cwd] of cases) {
    const r: any = await daemonPrompt(cfg, {
      port: e.port,
      token: e.token,
      key: label === 'requested' ? key : `${key}-def`,
      text: '只回复 CWD-OK',
      cwd,
      timeoutMs: 120000,
    });
    const procCwd = r.runtimePid
      ? (wslRunScript(cfg, `readlink -f /proc/${r.runtimePid}/cwd 2>/dev/null || echo '(gone)'`).stdout || '').trim()
      : '(no pid)';
    say(
      `# ${label}: requested=${cwd ?? '(default)'} daemonReportedCwd=${r.cwd ?? '-'} /proc/${r.runtimePid}/cwd=${procCwd} session=${r.sessionId} turns=${r.turns}`,
    );
    const expect = cwd ?? cfg.cwd;
    if (procCwd !== expect) {
      say(`# FAIL: 生效 cwd 不是 ${expect}`);
      process.exit(1);
    }
  }
  say('# PASS: per-call cwd 真的生效（两个 cwd 各自独立运行时/会话）');
  process.exit(0);
}

if (cmd === 'tmpstale') {
  // P2 验收：活宿主自己的陈旧文件（.pid 指向已死的 linux pid）必须被**一次普通变更型调用**收敛；
  // 同时造一个"他人 winpid 且宿主还活着"的对照文件，必须**不被删**。
  const foreignWin = Number(argOf('foreign-winpid', '0'));
  const win = process.pid;
  const deadPid = 999999; // 不可能存活
  const setup = [
    `printf '%s\\n' ${deadPid} > /tmp/dsh-rwsl-${win}-p2test-aaaa.pid`,
    `echo '#!/bin/bash' > /tmp/dsh-rwsl-${win}-p2test-aaaa.sh`,
    foreignWin ? `printf '%s\\n' ${deadPid} > /tmp/dsh-rwsl-${foreignWin}-ctrl-bbbb.pid` : 'true',
    'true',
  ].join('\n');
  wslRunScript(cfg, setup);
  const count = (pat: string) => (wslRunScript(cfg, `find /tmp -maxdepth 1 -name '${pat}' -print | wc -l`).stdout || '').trim();
  say(`# ① 写文件后: own=${count(`dsh-rwsl-${win}-*`)} foreign=${count(`dsh-rwsl-${foreignWin}-*`)} (winpid=${win}, foreign winpid=${foreignWin})`);
  const out = String(await driveTool('wsl_exec', { command: 'true' })); // 一次普通变更型调用
  say(`# 普通变更型调用（wsl_exec true）: ${out.split('\n')[0]}`);
  const ownAfter = count(`dsh-rwsl-${win}-*`);
  const foreignAfter = count(`dsh-rwsl-${foreignWin}-*`);
  say(`# ② 一次普通变更型调用后: own=${ownAfter} foreign=${foreignAfter}`);
  if (foreignWin) wslRunScript(cfg, `rm -f /tmp/dsh-rwsl-${foreignWin}-ctrl-bbbb.pid`); // 只清自造的对照文件
  say(`# ③ 收尾（只清自造的对照文件）: own=${count(`dsh-rwsl-${win}-*`)} foreign=${count(`dsh-rwsl-${foreignWin}-*`)}`);
  const ok = ownAfter === '0' && foreignAfter === '1';
  say(`# 判据: 自己的陈旧文件已收敛 ${ownAfter === '0' ? 'OK' : 'FAIL'} / 他人文件未被删 ${foreignAfter === '1' ? 'OK' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

if (cmd === 'tool') {
  // 用**最小 ctx 桩**直接驱动插件工具（不调模型）—— 用于拿"工具返回原文"做缺陷对照
  const name = argv[1];
  const argsJson = argv.filter((a) => a.startsWith('{'))[0] ?? '{}';
  const overrides: any = {};
  for (const k of ['dshVersion', 'cwd', 'profile', 'backend']) {
    const v = argOf(k, '');
    if (v !== '') overrides[k] = v;
  }
  say(String(await driveTool(name, JSON.parse(argsJson), overrides)));
  process.exit(0);
}

say(`未知子命令: ${cmd}（可用 status|ensure|prompt|queue|collision|race|reclaim|orphans|linger|drift|tool|cwdcheck|tmpstale|stop）`);
process.exit(2);
