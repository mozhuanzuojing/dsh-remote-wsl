/**
 * regression.ts —— 宿主数据面的**语义回归** + **缓存/单飞行为**读数（before / after 同一脚本）。
 *
 * 用法（bundled node）：
 *   node regression.ts --label after  [--module <path to explorer.ts>] [--out out-regression-after.json]
 *   node regression.ts --label before --module ./_before/src/explorer.ts --out out-regression-before.json
 *
 * 检查面
 *  A 直接调用（handler 级）：路径不存在 / 发行版不在列表 / 发行版未运行 / 参数非法 / 返回字段形状
 *  B HTTP 适配层：同源闸门 403、GET 方法清单、405、415、未知方法 400、E_ARG 400、E_NOTFOUND 404
 *  C 短 TTL 缓存：burst 合并、TTL 到期重取、**TTL 内状态变化不可见（如实记录）**、失败不缓存
 *  D snapshot 单飞：3 并发只跑一次；顺序调用**不**共享（分"TTL 内"与"过 TTL 后"两个口径）
 *
 * 纪律：只读。不 start/stop/terminate 发行版、不写任何文件、不起守护。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name: string, dflt: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const LABEL = argOf('label', 'after');
const MODULE = resolve(argOf('module', '../../../../src/explorer.ts'));
const OUT = argv.includes('--out') ? argOf('out', '') : null;
const REAL_DISTRO = argOf('distro', 'debian-u8-1');
const TTL_WAIT_MS = Number(argOf('ttl-wait', '2300'));

const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function realListDistros(): string[] {
  const res = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8', windowsHide: true });
  return (res.stdout || '')
    .split('\n')
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean);
}

const baseCfg = (distro: string) => ({
  distro,
  wslHome: '/home/g',
  cwd: '/home/g',
  daemonPort: 8731,
  daemonHandshakeTimeoutMs: 3000,
  daemonIdleMs: 1800000,
  daemonLingerMs: 600000,
  daemonQueueLimit: 4,
  timeoutMs: 300000,
  webPort: 3082,
});

type Probe = { defaultName: string | null; running: Set<string>; ok: boolean };
function makeHarness(mod: any, opts: { distro?: string; names?: () => string[]; probe?: (() => Probe) | null }) {
  const state = { listDistrosCalls: 0, probeCalls: 0 };
  const cfg = baseCfg(opts.distro ?? REAL_DISTRO);
  const deps: any = {
    config: cfg,
    listDistros: () => {
      state.listDistrosCalls += 1;
      return opts.names ? opts.names() : realListDistros();
    },
    resolveVersion: () => ({ version: null, desktopVersion: null, source: null, pin: null, drift: null }),
    writePin: () => true,
    webHosts: new Map(),
    workspaceRegistry: () => undefined,
  };
  if (opts.probe) {
    deps.distroStateProbe = () => {
      state.probeCalls += 1;
      return opts.probe!();
    };
  }
  const made = mod.createExplorerHandlers(deps);
  return { handlers: made.handlers as any, state, deps, cfg };
}

async function capture(fn: () => Promise<any>) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? null, name: e?.name ?? null, message: String(e?.message ?? e) };
  }
}
const brief = (r: any) => (r.ok ? { ok: true, entries: r.value?.entries?.length } : { ok: false, code: r.code, message: r.message });

function makeAdapter(mod: any, handlers: any) {
  let route: any = null;
  const webServer = {
    register(opts: any) {
      route = opts;
      return () => {
        route = null;
      };
    },
  };
  const adapter = mod.createExplorerHttpAdapter(webServer, handlers);
  return { adapter, getRoute: () => route };
}
function makeReq(method: string, headers: Record<string, string>, body?: any) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req: any = { method, headers };
  req[Symbol.asyncIterator] = async function* () {
    for (const c of payload) yield c;
  };
  return req;
}
function makeRes() {
  const out: any = { status: 0, headers: {}, body: '' };
  const res: any = {
    setHeader(k: string, v: any) {
      out.headers[String(k).toLowerCase()] = v;
    },
    end(s: any) {
      out.body = s === undefined ? '' : String(s);
    },
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => out.status,
    set: (v: any) => {
      out.status = v;
    },
  });
  return { res, out };
}
const SAME = { host: '127.0.0.1:3096', origin: 'http://127.0.0.1:3096', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

async function main() {
  const mod = await import(pathToFileURL(MODULE).href);
  const report: any = { label: LABEL, module: MODULE, generatedAt: new Date().toISOString(), node: process.version, distro: REAL_DISTRO, checks: {} };

  // ── A 直接调用 ────────────────────────────────────────────────────────────────
  {
    const h = makeHarness(mod, {});
    report.checks.listDir_pathMissing = await capture(() => h.handlers['explorer.listDir']({ path: '/home/g/__no_such_dir_bench__' }));
    report.checks.listDir_argError = await capture(() => h.handlers['explorer.listDir']({ path: '../etc' }));
    report.checks.listDir_argErrorNul = await capture(() => h.handlers['explorer.listDir']({ path: '/home/g/\u0000x' }));
    const shape = await capture(() => h.handlers['explorer.listDir']({ path: '/home/g' }));
    report.checks.listDir_okShape = shape.ok
      ? { ok: true, keys: Object.keys(shape.value).sort(), entryKeys: Object.keys(shape.value.entries[0] ?? {}).sort(), entryCount: shape.value.entries.length, distro: shape.value.distro, path: shape.value.path }
      : shape;

    const missing = makeHarness(mod, { distro: 'bench-no-such-distro-xyz' });
    report.checks.listDir_distroNotInList = await capture(() => missing.handlers['explorer.listDir']({ path: '/home/g' }));

    // 未运行分支（真实路径）：伪造一个"在名字列表里但 STATE 不是 Running"的发行版
    const fakeName = 'bench-fake-not-running';
    const notRunning = makeHarness(mod, { distro: fakeName, names: () => [...realListDistros(), fakeName] });
    report.checks.listDir_distroNotRunning = await capture(() => notRunning.handlers['explorer.listDir']({ path: '/home/g' }));

    const snap = makeHarness(mod, {});
    const snapRes = await capture(() => snap.handlers['explorer.snapshot']({}));
    report.checks.snapshot_okShape = snapRes.ok
      ? {
          ok: true,
          keys: Object.keys(snapRes.value).sort(),
          daemonKeys: Object.keys(snapRes.value.daemon ?? {}).sort(),
          distros: snapRes.value.distros,
          target: snapRes.value.target,
          driftKeys: Object.keys(snapRes.value.drift ?? {}).sort(),
          workspacesIsArray: Array.isArray(snapRes.value.workspaces),
          webHostsIsArray: Array.isArray(snapRes.value.webHosts),
        }
      : snapRes;
  }

  // ── B HTTP 适配层 ─────────────────────────────────────────────────────────────
  {
    const h = makeHarness(mod, {});
    const { getRoute } = makeAdapter(mod, h.handlers);
    const route = getRoute();
    const call = async (method: string, headers: Record<string, string>, body?: any) => {
      const { res, out } = makeRes();
      await route.handler(makeReq(method, headers, body), res);
      return { status: out.status, body: out.body.length > 400 ? out.body.slice(0, 400) + '…' : out.body };
    };
    report.checks.http_noOrigin = await call('POST', { host: SAME.host, 'content-type': SAME['content-type'] }, { method: 'explorer.snapshot', args: {} });
    report.checks.http_crossOrigin = await call('POST', { ...SAME, origin: 'http://evil.example:3096' }, { method: 'explorer.snapshot', args: {} });
    report.checks.http_getMethods = await call('GET', SAME);
    report.checks.http_put = await call('PUT', SAME, { method: 'explorer.snapshot', args: {} });
    report.checks.http_badCtype = await call('POST', { ...SAME, 'content-type': 'text/plain' }, { method: 'explorer.snapshot', args: {} });
    report.checks.http_unknownMethod = await call('POST', SAME, { method: 'explorer.__probe__', args: {} });
    report.checks.http_listDirMissing = await call('POST', SAME, { method: 'explorer.listDir', args: { path: '/home/g/__no_such_dir_bench__' } });
    report.checks.http_listDirArg = await call('POST', SAME, { method: 'explorer.listDir', args: { path: 'rel' } });
    report.checks.http_snapshotOk = await call('POST', SAME, { method: 'explorer.snapshot', args: {} });
  }

  // ── C 短 TTL 缓存行为 ─────────────────────────────────────────────────────────
  const READS = realListDistros();
  {
    const h = makeHarness(mod, { names: () => READS.slice() });
    h.state.listDistrosCalls = 0;
    await h.handlers['explorer.snapshot']({});
    const afterSnap = h.state.listDistrosCalls;
    await h.handlers['explorer.listDir']({ path: '/home/g' });
    const afterBurst = h.state.listDistrosCalls;

    h.state.listDistrosCalls = 0;
    const t0 = now();
    await h.handlers['explorer.snapshot']({});
    await h.handlers['explorer.listDir']({ path: '/home/g' });
    const secondBurst = { listDistrosCalls: h.state.listDistrosCalls, ms: Math.round((now() - t0) * 10) / 10 };

    await sleep(TTL_WAIT_MS);
    h.state.listDistrosCalls = 0;
    const t1 = now();
    await h.handlers['explorer.snapshot']({});
    await h.handlers['explorer.listDir']({ path: '/home/g' });
    const afterTtl = { listDistrosCalls: h.state.listDistrosCalls, ms: Math.round((now() - t0) * 10) / 10 };

    report.checks.cache = {
      burst_listDistrosCalls: afterBurst,
      snapshotAlone_listDistrosCalls: afterSnap,
      secondBurstWithinTtl: secondBurst,
      afterTtl: { listDistrosCalls: afterTtl.listDistrosCalls, msAfterTtlWait: Math.round((now() - t1) * 10) / 10 },
      ttlWaitMs: TTL_WAIT_MS,
    };
  }

  // C4：TTL 内"发行版启停"是否可见 —— 真实发行版 + 注入探针翻转 STATE（不动真实生命周期）
  {
    try {
      let running = true;
      const seam = makeHarness(mod, {
        distro: REAL_DISTRO,
        names: () => READS.slice(),
        probe: () => ({ defaultName: REAL_DISTRO, running: running ? new Set([REAL_DISTRO]) : new Set(), ok: true }),
      });
      const before = await capture(() => seam.handlers['explorer.listDir']({ path: '/home/g' }));
      running = false;
      const immediately = await capture(() => seam.handlers['explorer.listDir']({ path: '/home/g' }));
      await sleep(TTL_WAIT_MS);
      const afterTtl = await capture(() => seam.handlers['explorer.listDir']({ path: '/home/g' }));
      report.checks.cacheStateWithinTtl = {
        ranAs: { before: brief(before), immediatelyAfterFlip: brief(immediately), afterTtl: brief(afterTtl) },
        probeCalls: seam.state.probeCalls,
        note: 'before/immediatelyAfterFlip 应一致（TTL 内看不见翻转）；afterTtl 应变成 E_UNAVAILABLE 未运行',
      };
    } catch (e: any) {
      report.checks.cacheStateWithinTtl = { notApplicable: String(e?.message ?? e) };
    }
  }

  // C5：读失败不缓存（探针 ok:false / 名字为空 ⇒ 每次调用都重新探测）
  {
    const failingProbe = makeHarness(mod, {
      distro: REAL_DISTRO,
      names: () => READS.slice(),
      probe: () => ({ defaultName: null, running: new Set([REAL_DISTRO]), ok: false }),
    });
    failingProbe.state.listDistrosCalls = 0;
    const r1 = await capture(() => failingProbe.handlers['explorer.listDir']({ path: '/home/g' }));
    const r2 = await capture(() => failingProbe.handlers['explorer.listDir']({ path: '/home/g' }));
    const emptyNames = makeHarness(mod, { distro: REAL_DISTRO, names: () => [] });
    const e1 = await capture(() => emptyNames.handlers['explorer.listDir']({ path: '/home/g' }));
    const e2 = await capture(() => emptyNames.handlers['explorer.listDir']({ path: '/home/g' }));
    report.checks.failureNotCached = {
      probeNotOk: {
        listDistrosCallsForTwoCalls: failingProbe.state.listDistrosCalls,
        probeCalls: failingProbe.state.probeCalls,
        sample: { first: brief(r1), second: brief(r2) },
      },
      emptyNames: {
        listDistrosCallsForTwoCalls: emptyNames.state.listDistrosCalls,
        sample: { first: brief(e1), second: brief(e2) },
      },
    };
  }

  // ── D snapshot 单飞 ──────────────────────────────────────────────────────────
  {
    const h = makeHarness(mod, { names: () => READS.slice() });
    h.state.listDistrosCalls = 0;
    const t0 = now();
    const conc = await Promise.all([h.handlers['explorer.snapshot']({}), h.handlers['explorer.snapshot']({}), h.handlers['explorer.snapshot']({})]);
    const concurrent = { listDistrosCalls: h.state.listDistrosCalls, ms: Math.round((now() - t0) * 10) / 10, allSameObject: conc[0] === conc[1] && conc[1] === conc[2] };

    h.state.listDistrosCalls = 0;
    await h.handlers['explorer.snapshot']({});
    await h.handlers['explorer.snapshot']({});
    const sequentialWithinTtl = { listDistrosCalls: h.state.listDistrosCalls };

    const s1 = await h.handlers['explorer.snapshot']({});
    await sleep(TTL_WAIT_MS);
    h.state.listDistrosCalls = 0;
    const s2 = await h.handlers['explorer.snapshot']({});
    const sequentialAfterTtl = { listDistrosCalls: h.state.listDistrosCalls, sameObjectAsBefore: s1 === s2 };

    report.checks.singleFlight = {
      concurrent3: concurrent,
      sequential2WithinTtl: sequentialWithinTtl,
      sequential2AfterTtl: sequentialAfterTtl,
      note: 'concurrent3 应 =1（单飞）；sequential2AfterTtl 应 =2（无"完成后缓存"）；sequential2WithinTtl 受 TTL 影响可为 0',
    };
  }

  const text = JSON.stringify(report, null, 2);
  if (OUT) {
    writeFileSync(OUT, text, 'utf8');
    console.log('[regression] wrote ' + OUT);
  }
  console.log(text);
}

main().catch((e) => {
  console.error('REGRESSION FAILED: ' + (e && e.stack ? e.stack : String(e)));
  process.exit(2);
});
