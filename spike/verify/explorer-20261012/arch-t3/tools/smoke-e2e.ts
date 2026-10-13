/**
 * smoke-e2e.ts —— T3 端到端冒烟（**真守护**，端口 8911，落在纪律允许段 8911–8920 内）。
 *
 * 覆盖三条：
 *   A. daemon-client 面：ensure（本机应走 `systemd` 主路径）→ 元数据/记录/token/log → snapshot/status → 端口/进程扫描
 *   B. index.ts 面：`wsl_status` 工具 + explorer 路由方法（snapshot / listDir / daemon）——证明拆分后**宿主接线**仍通
 *   C. **stop 失败面**（T26/T31/T33 刚验证过的语义）：把真守护 `SIGSTOP` 后 `stopDaemon`
 *      ⇒ 必须 `ok:false` 且带**可读** note/error（不得变成 ok:true 或静默）
 *
 * 用法：node --experimental-strip-types smoke-e2e.ts [--slot 8911] [--out <json>]
 * 纪律：只用 8911–8920；结束停自己的守护 + `systemctl reset-failed` 自己的 unit；不碰 19387/47604。
 */
import { writeFileSync } from 'node:fs';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const SLOT = Number(arg('slot', '8911'));
const OUT = arg('out', '');
if (!(SLOT >= 8911 && SLOT <= 8920)) { console.error(`拒跑：slot ${SLOT} 不在纪律段 8911–8920`); process.exit(3); }

const DC: any = await import(`file:///${ROOT}/src/daemon-client.ts`);
const steps: Array<Record<string, unknown>> = [];
const say = (s: string) => console.log(s);
const rec = (step: string, ok: boolean, detail: unknown) => { steps.push({ step, ok, detail }); say(`  [${ok ? 'PASS' : 'FAIL'}] ${step} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

const cfg: any = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', dshVersion: '',
  daemonPort: SLOT, daemonPortTries: 1, timeoutMs: 60000, daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000, daemonIdleMs: 1800000, daemonQueueLimit: 4, useShellEnvironment: true,
  provider: 'deepseek-official', model: 'deepseek-flash', desktopRuntimeJson: '',
  webPort: 8912, idleTimeoutMs: 120000, proxyPort: 9910, backend: 'daemon', backgroundWarm: false,
};
const VER = '0.2.0-rc.2';

// ── A. daemon-client 面 ───────────────────────────────────────────────────────
say('### A. daemon-client 面（真起守护）');
let ensured: any = null;
try {
  ensured = await DC.ensureDaemon(cfg, { version: VER, log: (m: string) => say(`    (daemon-client) ${m}`) });
  rec('A1 ensureDaemon ok', ensured?.ok === true, { ok: ensured?.ok, slot: ensured?.slot, port: ensured?.port, pid: ensured?.info?.daemonPid, mode: ensured?.mode ?? ensured?.info?.mode, notes: ensured?.notes });
} catch (e: any) { rec('A1 ensureDaemon ok', false, `${e?.name}: ${e?.message}`); }

const meta = DC.readDaemonRecord(cfg, SLOT);
rec('A2 readDaemonRecord 有槽位记录', !!meta && Number(meta.slot) === SLOT, { slot: meta?.slot, legacy: meta?.legacy, hasToken: typeof meta?.token === 'string' && meta.token.length > 0 });
rec('A3 readDaemonMeta / readDaemonToken / readDaemonLogTail', (() => { const m = DC.readDaemonMeta(cfg, SLOT); const t = DC.readDaemonToken(cfg, SLOT); const l = DC.readDaemonLogTail(cfg, 2); return !!m && typeof t === 'string' && typeof l === 'string'; })(), { metaKeys: meta?.meta ? Object.keys(meta.meta).slice(0, 6) : null });
const slots = DC.listDaemonSlots(cfg);
rec('A4 listDaemonSlots 含本槽位', slots.includes(SLOT), slots);
const snap = await DC.daemonSnapshot(cfg);
rec('A5 daemonSnapshot 里 live 含本槽位（唯一孤儿真相源）', (snap.live ?? []).some((l: any) => Number(l.slot) === SLOT), { live: (snap.live ?? []).map((l: any) => Number(l.slot)), dead: (snap.dead ?? []).map((d: any) => d.slot), orphans: (snap.orphans ?? []).length });
const st = await DC.daemonStatus(cfg);
rec('A6 daemonStatus ok 且 slot 正确', st?.ok === true && Number(st.slot) === SLOT, { ok: st?.ok, slot: st?.slot, pid: st?.info?.daemonPid, version: st?.info?.version, mode: st?.info?.mode });
const procs = DC.scanDaemonProcesses(cfg);
rec('A7 scanDaemonProcesses 认得本槽位进程', (procs ?? []).some((p: any) => Number(p.port) === SLOT || Number(p.metaPort) === SLOT), (procs ?? []).map((p: any) => ({ pid: p.pid, port: p.port, metaPort: p.metaPort })));
try {
  const hs = await DC.handshake(cfg, SLOT, meta?.token ?? '', 3000);
  rec('A8 handshake 成功', hs?.ok === true, { ms: hs?.ms, version: hs?.info?.version });
} catch (e: any) { rec('A8 handshake 成功', false, `${e?.name}: ${e?.message}`); }

// ── B. index.ts 面（宿主接线：wsl_status 工具 + explorer 路由方法）───────────────
say('### B. index.ts 面（wsl_status 工具 + explorer 路由方法）');
const tools = new Map<string, any>();
const services = new Map<string, any>();
function makeFakeWebServer() {
  const table = new Map<string, any>();
  return {
    routes: table,
    register(route: any) { const k = `${route.kind}:${route.path}`; if (table.has(k)) throw new Error(`duplicate ${k}`); table.set(k, route); return () => table.delete(k); },
  };
}
const fakeWS = makeFakeWebServer();
services.set('webServer', fakeWS);
const childCtx = { get: (k: string) => (k === 'tools' ? { register: (t: any) => tools.set(t.name, t) } : services.get(k)), set: (k: string, v: unknown) => void services.set(k, v), provide: (k: string, v: unknown) => void services.set(k, v) };
const ctx: any = { inject: (_d: string[], cb: (c: unknown) => unknown) => cb(childCtx), ...childCtx, effect: (fn: () => unknown) => { const d = fn(); return typeof d === 'function' ? d : undefined; }, plugin: () => {} };
const idx: any = await import(`file:///${ROOT}/src/index.ts`);
idx.apply(ctx, cfg);
rec('B1 apply() 注册 7 个工具 + 1 条 explorer 路由', tools.size === 7 && fakeWS.routes.size === 1, { tools: [...tools.keys()], routes: [...fakeWS.routes.keys()] });

const exec = { signal: new AbortController().signal };
const statusText: string = await tools.get('wsl_status')!.execute({}, exec);
rec('B2 wsl_status 报出守护 pid（拆分后宿主面仍通）', /daemon=(running )?pid=\d+/.test(statusText) || /pid=\d+/.test(statusText), statusText.split('\n').filter((l: string) => /daemon/.test(l)).slice(0, 3).join(' | ').slice(0, 300));

const handler = [...fakeWS.routes.values()][0].handler;
const call = async (method: string, args: unknown) => {
  const res: any = { statusCode: null, headers: {}, bodyText: '', setHeader(k: string, v: string) { this.headers[String(k).toLowerCase()] = v; }, end(b: unknown) { this.bodyText = b == null ? '' : String(b); } };
  const bodyStr = JSON.stringify({ method, args: args ?? {} });
  const req: any = { method: 'POST', headers: { host: '127.0.0.1:8912', origin: 'http://127.0.0.1:8912', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(bodyStr); } };
  await handler(req, res);
  let json: any = null; try { json = JSON.parse(res.bodyText); } catch { /* 保留原文 */ }
  return { status: res.statusCode, json, text: res.bodyText };
};
const es = await call('explorer.snapshot', {});
const daemonSeg = es.json?.result?.daemon ?? null;
rec('B3 explorer.snapshot 的 daemon 段指向本槽位', es.status === 200 && Number(daemonSeg?.slot) === SLOT, { status: es.status, daemon: daemonSeg });
const el = await call('explorer.listDir', { path: '/home/g' });
rec('B4 explorer.listDir 能列目录（目录面仍通）', el.status === 200 && Array.isArray(el.json?.result?.entries ?? el.json?.result), { status: el.status, count: (el.json?.result?.entries ?? el.json?.result ?? []).length });
const ed = await call('explorer.daemon', { action: 'ensure' });
rec('B5 explorer.daemon{ensure} 幂等复用本槽位', ed.status === 200 && ed.json?.ok === true && Number(ed.json?.result?.slot) === SLOT, { status: ed.status, result: ed.json?.result });

// ── C. stop 失败面（SIGSTOP 后 stop 必须 ok:false + 可读 notes）──────────────────
say('### C. stop 失败面（真守护 SIGSTOP）');
const pid = Number(st?.info?.daemonPid ?? ensured?.info?.daemonPid ?? meta?.meta?.pid);
rec('C0 拿到守护 pid', Number.isFinite(pid) && pid > 0, { pid });
DC.wslRunScript(cfg, `kill -STOP ${pid} 2>/dev/null; echo STOPPED $?`, 5000);
const stopped = await DC.stopDaemon(cfg, { slot: SLOT, log: (m: string) => say(`    (stop) ${m}`) });
const stopOk = stopped?.ok === false;
const readable = typeof stopped?.note === 'string' && stopped.note.length > 0 || typeof stopped?.error === 'string' && stopped.error.length > 0;
rec('C1 stopDaemon 在 SIGSTOP 下 ok:false（语义不得变）', stopOk, { ok: stopped?.ok, alreadyStopped: stopped?.alreadyStopped, note: stopped?.note, error: stopped?.error, reaped: stopped?.reaped });
rec('C2 失败面带可读 note/error', readable, { note: stopped?.note, error: stopped?.error });
// explorer 侧同一条链：stopNotes=[r.note,r.error] 与 ok: r.ok !== false
const edStop = await call('explorer.daemon', { action: 'stop', slot: SLOT });
rec('C3 explorer.daemon{stop} 透传 ok:false + notes（explorer.ts 依赖的语义）', edStop.json?.result?.ok === false && Array.isArray(edStop.json?.result?.notes) && edStop.json.result.notes.filter(Boolean).length > 0, { status: edStop.status, result: edStop.json?.result });

// ── 收尾：CONT/KILL 后正常 stop，验证能收干净 ─────────────────────────────────
say('### 收尾');
DC.wslRunScript(cfg, `kill -CONT ${pid} 2>/dev/null; sleep 0.3; kill -9 ${pid} 2>/dev/null; echo cleaned`, 8000);
const stopped2 = await DC.stopDaemon(cfg, { slot: SLOT, log: (m: string) => say(`    (stop2) ${m}`) });
const snap2 = await DC.daemonSnapshot(cfg);
const gone = !(snap2.live ?? []).some((l: any) => Number(l.slot) === SLOT);
rec('D1 收尾 stop + 快照确认本槽位已消失', (stopped2?.ok === true || stopped2?.alreadyStopped === true) && gone, { ok: stopped2?.ok, alreadyStopped: stopped2?.alreadyStopped, live: (snap2.live ?? []).map((l: any) => Number(l.slot)) });
rec('D2 无孤儿残留', (snap2.orphans ?? []).length === 0, { orphans: (snap2.orphans ?? []).length });

const fails = steps.filter((s) => s.ok !== true);
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), slot: SLOT, pass: steps.length - fails.length, total: steps.length, fails: fails.map((f) => f.step), steps }, null, 2), 'utf8');
say(`\n冒烟：${steps.length - fails.length}/${steps.length} PASS；失败：${fails.map((f) => f.step).join(', ') || '(无)'}`);
process.exit(fails.length ? 1 : 0);
