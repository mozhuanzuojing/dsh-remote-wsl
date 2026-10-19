/**
 * bench.ts —— 宿主数据面（src/explorer.ts）端到端基准：before / after 同一脚本、同一口径。
 *
 * 口径
 *  · 每个场景 N=5（可 --n 改），取中位数，同时给 min/max 与逐样本值；
 *  · 计时窗口只含"被测量的那一次调用"：warm 场景的预热调用在 prep 里完成，**不计时**；
 *  · 计时含 await 全程（真实 wsl.exe spawn + UNC/9p 读 + TCP），不扣任何常量；
 *  · cold = 每个样本新建 handler 实例（cache 空，等价首次请求）；warm = 同实例先预热再计时；
 *  · 只读：不发起/停止/重启守护、不写文件、不 terminate 发行版；wsl -d 探针仅在
 *    STATE=Running 时执行（否则跳过并记 skipped），因此**不会**启动发行版。
 *
 * 用法（bundled node，PATH 上的 node 是坏 shim）：
 *   node bench.ts --label before [--n 5] [--distro debian-u8-1] [--out out-before.json]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { resolveVersion, writePin } from '../../../../src/wsl-io.ts';

type Args = { label: string; n: number; distro: string; out: string | null; modulePath: string };
function parseArgs(argv: string[]): Args {
  const get = (name: string, dflt: string) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
  };
  return {
    label: get('label', 'unlabeled'),
    n: Number(get('n', '5')),
    distro: get('distro', 'debian-u8-1'),
    out: argv.includes('--out') ? get('out', '') : null,
    modulePath: get('module', '../../../../src/explorer.ts'),
  };
}
const A = parseArgs(process.argv.slice(2));
const MODULE = resolve(A.modulePath);
let CREATE: any = null;
let METHODS: string[] = [];

const cfg: any = {
  distro: A.distro,
  wslHome: '/home/g',
  cwd: '/home/g',
  profile: 'sdk',
  daemonPort: 8731,
  daemonPortTries: 3,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  daemonIdleMs: 1800000,
  daemonLingerMs: 600000,
  daemonQueueLimit: 4,
  timeoutMs: 300000,
  webPort: 3082,
  dshVersion: '',
  desktopRuntimeJson: '',
};

/** 与 src/index.ts 的 listDistros 逐字同形（wsl -l -q + 去 \0 + trim + 丢弃空行）。 */
function realListDistros(): string[] {
  const res = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8', windowsHide: true });
  return (res.stdout || '')
    .split('\n')
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean);
}

/** STATE=Running 的发行版集合（只读；不看就不碰）。 */
function runningDistros(): Set<string> {
  const out = new Set<string>();
  const res = spawnSync('wsl.exe', ['-l', '-v'], { encoding: 'utf8', windowsHide: true });
  const text = (res.stdout || '').replace(/\0/g, '');
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\*)?\s*(\S+)\s+(Running|Stopped|Installing|Uninstalling|Converting|Exporting)\b/i.exec(raw.trim());
    if (m && m[3].toLowerCase() === 'running') out.add(m[2]);
  }
  return out;
}

type Counter = { listDistrosCalls: number };
function makeDeps(counter: Counter) {
  return {
    config: cfg,
    listDistros: () => {
      counter.listDistrosCalls += 1;
      return realListDistros();
    },
    resolveVersion: (c: any) => resolveVersion(c),
    writePin: (c: any, v: string) => writePin(c, v),
    webHosts: new Map(),
    workspaceRegistry: () => undefined,
  };
}
function freshHandler() {
  const counter: Counter = { listDistrosCalls: 0 };
  const made = CREATE(makeDeps(counter));
  return { counter, handlers: made.handlers as any };
}

const now = () => Number(process.hrtime.bigint()) / 1e6; // ns -> ms（float，亚微秒分辨率）
const round = (x: number) => Math.round(x * 10) / 10;
const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function stats(xs: number[]) {
  return { medianMs: round(median(xs)), minMs: round(Math.min(...xs)), maxMs: round(Math.max(...xs)), samples: xs.map(round) };
}

type Rec = { scenario: string; ms: ReturnType<typeof stats>; listDistrosCallsPerSample: number[]; note?: string; skipped?: string };
const results: Rec[] = [];

/**
 * @param prep 计时窗口**之外**的准备工作（warm 场景的预热调用放这里）
 * @param fn   被测量的一次调用
 */
async function measure(
  scenario: string,
  fn: (ctx: any) => Promise<{ calls: number; extra?: any }>,
  note?: string,
  prep?: () => Promise<any>,
) {
  const times: number[] = [];
  const calls: number[] = [];
  let extra: any = null;
  for (let i = 0; i < A.n; i += 1) {
    const ctx = prep ? await prep() : undefined;
    const t0 = now();
    const r = await fn(ctx);
    times.push(now() - t0);
    calls.push(r.calls);
    if (r.extra !== undefined) extra = r.extra;
  }
  const rec: Rec = { scenario, ms: stats(times), listDistrosCallsPerSample: calls };
  if (note) rec.note = note;
  results.push(rec);
  console.log('[bench] ' + scenario + ' median=' + rec.ms.medianMs + 'ms (min ' + rec.ms.minMs + ' / max ' + rec.ms.maxMs + ') calls=' + calls.join('/'));
  return { rec, extra };
}

async function main() {
  const mod = await import(pathToFileURL(MODULE).href);
  CREATE = mod.createExplorerHandlers;
  METHODS = mod.EXPLORER_METHODS;
  if (typeof CREATE !== 'function' || !Array.isArray(METHODS)) throw new Error('module 缺少 createExplorerHandlers/EXPLORER_METHODS: ' + MODULE);
  console.log('# host dataplane bench, label=' + A.label + ', n=' + A.n + ', distro=' + A.distro);
  console.log('# module=' + MODULE);
  console.log('# node=' + process.version + ' methods=' + METHODS.join(','));

  // 进程级 warmup（不记录）：把 Node/libuv 首次 spawn、模块懒初始化从测量里排除
  {
    const w = freshHandler();
    await w.handlers['explorer.listDir']({ path: '/home/g' }).catch(() => undefined);
    await w.handlers['explorer.snapshot']({}).catch(() => undefined);
    console.log('# process warmup done');
  }

  // 组成成本：各条 wsl 探测命令的真实 spawn 成本
  await measure('raw:wsl -l -q', async () => {
    const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8', windowsHide: true });
    if (r.error) throw new Error('wsl -l -q failed: ' + r.error.message);
    return { calls: 0 };
  }, 'listDistros 的成本来源（函数体只做解析）');

  await measure('raw:wsl -l -v', async () => {
    const r = spawnSync('wsl.exe', ['-l', '-v'], { encoding: 'utf8', windowsHide: true });
    if (r.error) throw new Error('wsl -l -v failed: ' + r.error.message);
    return { calls: 0 };
  }, 'distroFlags() 的成本来源（函数体只做解析）');

  if (runningDistros().has(A.distro)) {
    await measure('raw:wsl -d <distro> bash -c true', async () => {
      const r = spawnSync('wsl.exe', ['-d', A.distro, '--', 'bash', '-c', 'true'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (r.error) throw new Error('wsl -d failed: ' + r.error.message);
      return { calls: 0 };
    }, 'daemonSnapshot 里 scanDaemonProcesses 的 spawn 形态（发行版已 Running，不会拉起）');
  } else {
    results.push({ scenario: 'raw:wsl -d <distro> bash -c true', ms: stats([0]), listDistrosCallsPerSample: [0], skipped: '发行版未运行 ⇒ 按纪律不执行（避免启动发行版）' });
    console.log('[bench] skip raw:wsl -d（发行版未运行）');
  }

  // listDir
  await measure('listDir cold', async () => {
    const { counter, handlers } = freshHandler();
    const r = await handlers['explorer.listDir']({ path: '/home/g' });
    if (!Array.isArray(r.entries)) throw new Error('listDir 未返回 entries');
    return { calls: counter.listDistrosCalls, extra: { entries: r.entries.length } };
  });

  await measure(
    'listDir warm(同实例第二次)',
    async (ctx) => {
      const r = await ctx.handlers['explorer.listDir']({ path: '/home/g' });
      return { calls: ctx.counter.listDistrosCalls, extra: { entries: r.entries.length } };
    },
    undefined,
    async () => {
      const h = freshHandler();
      await h.handlers['explorer.listDir']({ path: '/home/g' });
      h.counter.listDistrosCalls = 0;
      return h;
    },
  );

  // snapshot
  await measure('snapshot cold', async () => {
    const { counter, handlers } = freshHandler();
    const r = await handlers['explorer.snapshot']({});
    return {
      calls: counter.listDistrosCalls,
      extra: { distros: Array.isArray(r.distros) ? r.distros.length : -1, daemonRunning: r.daemon && r.daemon.running === true },
    };
  });

  await measure(
    'snapshot warm(同实例第二次)',
    async (ctx) => {
      const r = await ctx.handlers['explorer.snapshot']({});
      return { calls: ctx.counter.listDistrosCalls, extra: { distros: Array.isArray(r.distros) ? r.distros.length : -1 } };
    },
    undefined,
    async () => {
      const h = freshHandler();
      await h.handlers['explorer.snapshot']({});
      h.counter.listDistrosCalls = 0;
      return h;
    },
  );

  // 面板首屏 burst：snapshot -> listDir（面板真实顺序）
  await measure('panel burst cold (snapshot->listDir)', async () => {
    const { counter, handlers } = freshHandler();
    await handlers['explorer.snapshot']({});
    await handlers['explorer.listDir']({ path: '/home/g' });
    return { calls: counter.listDistrosCalls };
  });

  await measure(
    'panel burst warm(同实例再来一轮)',
    async (ctx) => {
      await ctx.handlers['explorer.snapshot']({});
      await ctx.handlers['explorer.listDir']({ path: '/home/g' });
      return { calls: ctx.counter.listDistrosCalls };
    },
    undefined,
    async () => {
      const h = freshHandler();
      await h.handlers['explorer.snapshot']({});
      await h.handlers['explorer.listDir']({ path: '/home/g' });
      h.counter.listDistrosCalls = 0;
      return h;
    },
  );

  // snapshot 并发：3 个同参并发（单飞优化是否生效）
  await measure('snapshot x3 concurrent', async () => {
    const { counter, handlers } = freshHandler();
    await Promise.all([
      handlers['explorer.snapshot']({}),
      handlers['explorer.snapshot']({}),
      handlers['explorer.snapshot']({}),
    ]);
    return { calls: counter.listDistrosCalls };
  });

  await measure('snapshot x3 sequential(对照)', async () => {
    const { counter, handlers } = freshHandler();
    await handlers['explorer.snapshot']({});
    await handlers['explorer.snapshot']({});
    await handlers['explorer.snapshot']({});
    return { calls: counter.listDistrosCalls };
  });

  const payload = {
    label: A.label,
    generatedAt: new Date().toISOString(),
    node: process.version,
    distro: A.distro,
    n: A.n,
    results,
  };
  const text = JSON.stringify(payload, null, 2);
  if (A.out) {
    writeFileSync(A.out, text, 'utf8');
    console.log('\n[bench] wrote ' + A.out);
  }
  console.log('\n=== JSON ===');
  console.log(text);
}

main().catch((e) => {
  console.error('BENCH FAILED: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
