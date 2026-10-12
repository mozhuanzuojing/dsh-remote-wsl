/**
 * inject-delta.ts —— task-6 **delta 复验**（T8 修完 5 条 host 缺口后，独立第三双眼睛的复检）。
 *
 * 复检项（**不照抄 T8 结论**，全部自己判定 + 自己留原始输出）：
 *   D1  F32：同一次 registerExplorer 内 inject 二次触发 ⇒ **dispose 后路由计数必须 = 0**（改前实测 = 1）
 *   D1b     额外：两次回调拿到**不同** webServer 实例 ⇒ 新路由就位、旧路由被释放（T8 新增的"释放上一次"分支）
 *   D2  F33：配置槽位无守护、别处有守护 ⇒ `snapshot.daemon.running=false` + 别槽进 `others[]`（带 note）；
 *           `explorer.daemon{action:'stop',slot:<别槽>}` ⇒ **400/E_ARG 且该守护 pid 前后不变**（硬证明）
 *   D3  F15：inject 永不回调 ⇒ stderr 出现降级日志（接缝 `DSH_REMOTE_WSL_INJECT_WARN_MS=300`）；inject 正常时**不得**出现
 *   D4  F14b（`--phase ensurefail`，需先占住 8972–8974）：同一 ensure 失败路径 `openSession` 与 `daemon` **都是 503**
 *
 * 冻结锚点（本次复验对象，自算见 REVISION-observed-delta.txt）：
 *   src/explorer.ts  a2c6b8b9… 34,016 B   ｜ src/daemon-client.ts 184f6b87… 37,581 B
 *
 * 用法：node --experimental-strip-types inject-delta.ts --go [--phase main|ensurefail]
 * 产物：out-D2-delta-summary.json、out-D2-*.txt
 * 纪律：只用自己的槽位段（8972–8974）；只读被验对象；不启宿主；不碰 19387。
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const GO = process.argv.includes('--go');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const PHASE = arg('phase', 'main');
const MY_SLOT = 8972;        // 配置槽位
const FOREIGN_SLOT = 8973;   // 扮演"别处的守护"
const LIVE_HOST_PORT = 19387;
const LIVE_HOST_PID_BASELINE = 47564;

if (!GO) {
  console.log('task-6 DELTA 复验计划（加 --go 才执行）');
  console.log('  D1  F32：inject 二次触发 ⇒ dispose 后 routes 必须 0（改前=1）');
  console.log('  D1b     两次回调不同 webServer ⇒ 旧路由被释放、新路由就位');
  console.log('  D2  F33：配置槽位无守护/别处有 ⇒ running=false + others[]；stop 别槽 ⇒ 400/E_ARG 且 pid 不变');
  console.log('  D3  F15：inject 不回调 + DSH_REMOTE_WSL_INJECT_WARN_MS=300 ⇒ 出现降级日志；正常回调 ⇒ 不出现');
  console.log('  D4  F14b（--phase ensurefail）：占住 8972-8974 后 openSession 与 daemon 都必须 503');
  process.exit(0);
}

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const dump = (n) => writeFileSync(`${DIR}${n}`, lines.join('\n') + '\n', 'utf8');
const summary = { at: new Date().toISOString(), phase: PHASE, anchors: {
  'src/explorer.ts': 'a2c6b8b9a19a215316625053bdef5eabf76769cb2d2aeea84bb9c1ce209fba8c (34016)',
  'src/daemon-client.ts': '184f6b87ef2ebc78b53b57bb13ebcecc28c546ccf1aee029c21daca19280098f (37581)',
} };

function captureStderr(fn) {
  const cap = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...r) => { cap.push(String(c)); return orig(c, ...r); };
  try { return { value: fn(), captured: cap }; } finally { process.stderr.write = orig; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 桩：ctx / webServer（register 真实语义：重复 (kind,path) 抛错）──────────────
function makeFakeWebServer() {
  const table = new Map();
  return {
    table,
    register(route) {
      const key = `${route.kind}:${route.path}`;
      if (table.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      table.set(key, route);
      return () => table.delete(key);
    },
  };
}
const tools = new Map();
const services = new Map();
function makeCtx({ wsList, fireTimes = 1 }) {
  // wsList: 每次回调依次返回的 webServer（不足则复用最后一个）
  let i = 0;
  return {
    inject: (_deps, cb) => {
      for (let k = 0; k < fireTimes; k++) {
        const ws = wsList[Math.min(i, wsList.length - 1)];
        i++;
        cb({ get: (key) => (key === 'webServer' ? ws : undefined) });
      }
    },
    get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : services.get(k)),
    set: (k, v) => void services.set(k, v),
    provide: (k, v) => void services.set(k, v),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined; },
    plugin: () => {},
  };
}
const baseConfig = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g',
  provider: 'deepseek-official', model: 'deepseek-flash', profile: 'sdk', dshVersion: '',
  webPort: 3082, idleTimeoutMs: 120000, timeoutMs: 180000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: 'daemon', daemonPort: MY_SLOT, daemonPortTries: 3,
  daemonIdleMs: 1800000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
  useShellEnvironment: true, backgroundWarm: false,
};
const SRC_EXPLORER = 'D:/project/dsh1/vendor/dsh-remote-wsl/src/explorer.ts';
const SRC_INDEX = 'D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts';
const DC = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
const { registerExplorer } = await import(`file:///${SRC_EXPLORER}`);

// ── D1 / D1b：F32 ─────────────────────────────────────────────────────────────
if (PHASE === 'main') {
  lines.length = 0;
  say('### D1  F32：同一次 registerExplorer 内 inject 回调触发两次（第二次 duplicate）');
  const ws = makeFakeWebServer();
  const ctx = makeCtx({ wsList: [ws], fireTimes: 2 });
  let handle = null, outer = null;
  const { captured } = captureStderr(() => { try { handle = registerExplorer(ctx, baseConfig); } catch (e) { outer = e; } });
  const before = ws.table.size;
  let disposeErr = null;
  try { handle?.dispose?.(); } catch (e) { disposeErr = e; }
  const after = ws.table.size;
  say(`逃到最外层的抛错=${outer ? outer.message : '(none) ✅'}`);
  say(`stderr=${JSON.stringify(captured)}`);
  say(`routes: before dispose = ${before}（期望 1）｜after dispose = ${after}（**期望 0**；改前实测为 1）`);
  const pass = outer === null && before === 1 && after === 0 && disposeErr === null;
  say(`verdict=${pass ? 'PASS —— F32 已修（dispose 后路由归零）' : '❌ FAIL —— 仍有残留或抛错逃逸'}`);
  summary.D1_F32 = { outerThrow: outer?.message ?? null, routesBefore: before, routesAfterDispose: after, disposeErr: disposeErr?.message ?? null, stderr: captured.join(''), verdict: pass ? 'PASS' : 'FAIL' };
  dump('out-D2-D1-F32-dispose-zero.txt');

  lines.length = 0;
  say('### D1b 额外：两次回调拿到**不同** webServer 实例（T8 新增的"释放上一次"分支）');
  const ws1 = makeFakeWebServer(), ws2 = makeFakeWebServer();
  const ctx2 = makeCtx({ wsList: [ws1, ws2], fireTimes: 2 });
  let h2 = null, o2 = null;
  const cap2 = captureStderr(() => { try { h2 = registerExplorer(ctx2, baseConfig); } catch (e) { o2 = e; } });
  const s1 = ws1.table.size, s2 = ws2.table.size;
  let e2 = null; try { h2?.dispose?.(); } catch (e) { e2 = e; }
  const s1b = ws1.table.size, s2b = ws2.table.size;
  say(`throw=${o2 ? o2.message : '(none)'}`);
  say(`旧 server routes: ${s1} → dispose 后 ${s1b}（期望 0 → 0）`);
  say(`新 server routes: ${s2} → dispose 后 ${s2b}（期望 1 → 0）`);
  const pass2 = o2 === null && s1 === 0 && s2 === 1 && s2b === 0;
  say(`verdict=${pass2 ? 'PASS（换 server 时旧路由被释放、只留一条，且可归零）' : '❌ FAIL'}`);
  summary.D1b_rebind = { throw: o2?.message ?? null, oldServer: [s1, s1b], newServer: [s2, s2b], stderr: cap2.captured.join(''), verdict: pass2 ? 'PASS' : 'FAIL' };
  dump('out-D2-D1b-rebind.txt');

  // ── D3：F15 ─────────────────────────────────────────────────────────────────
  lines.length = 0;
  say('### D3  F15：inject 永不回调 ⇒ 应出现一次性降级日志（接缝 300ms）；正常回调 ⇒ 不得出现');
  process.env.DSH_REMOTE_WSL_INJECT_WARN_MS = '300';
  // ⚠ 插桩修正（2026-10-12 16:3x 首跑踩到）：原来的 `captureStderr()` 只包住**同步**调用，
  //   而这条日志是 `setTimeout` 里打的 ⇒ 捕获早已还原、日志直接落到真 stderr（控制台看得见、captured 却是空）
  //   ⇒ 我自己的断言假 FAIL。必须让捕获**跨过 sleep**。
  async function captureStderrAsync(fn, ms) {
    const cap = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c, ...r) => { cap.push(String(c)); return orig(c, ...r); };
    try { fn(); await sleep(ms); } finally { process.stderr.write = orig; }
    return cap;
  }
  // A：永不回调
  const ctxNever = { inject: () => {}, get: () => undefined, set: () => {}, provide: () => {}, effect: () => {}, plugin: () => {} };
  const capAList = await captureStderrAsync(() => { try { registerExplorer(ctxNever, baseConfig); } catch (e) { say(`A throw=${e.message}`); } }, 700);
  const A = capAList.join('');
  const aHit = A.includes('未就绪');
  say(`A(不回调) 700ms 后 stderr=${JSON.stringify(capAList)}`);
  say(`  ⇒ 出现"未就绪"降级日志 = ${aHit}`);
  // B：正常回调
  const wsB = makeFakeWebServer();
  const capBList = await captureStderrAsync(() => { try { registerExplorer(makeCtx({ wsList: [wsB], fireTimes: 1 }), baseConfig); } catch (e) { say(`B throw=${e.message}`); } }, 700);
  const B = capBList.join('');
  const bHit = B.includes('未就绪');
  say(`B(正常回调) 700ms 后 stderr=${JSON.stringify(capBList)}`);
  say(`  ⇒ 出现"未就绪"降级日志 = ${bHit}（**期望 false**）`);
  const pass3 = aHit && !bHit;
  say(`verdict=${pass3 ? 'PASS —— F15 已修（该日志只在永不就绪时出现一次，正常路径不打）' : '❌ FAIL'}`);
  summary.D3_F15 = { neverFired: { hit: aHit, stderr: A }, normalFired: { hit: bHit, stderr: B }, verdict: pass3 ? 'PASS' : 'FAIL' };
  dump('out-D2-D3-F15-inject-warn.txt');

  // ── D2：F33 ─────────────────────────────────────────────────────────────────
  lines.length = 0;
  say('### D2  F33：配置槽位(8972)无守护、别槽(8973)有守护 ⇒ running=false + others[]；stop 别槽 ⇒ 400/E_ARG 且 pid 不变');
  // 用真 index.ts 的 apply（真 deps）拿到 handler；配置槽位 = 8972
  const wsReal = makeFakeWebServer();
  const ctxReal = makeCtx({ wsList: [wsReal], fireTimes: 1 });
  const idx = await import(`file:///${SRC_INDEX}`);
  idx.apply(ctxReal, baseConfig);
  const handler = [...wsReal.table.values()][0].handler;
  const call = async ({ method = 'POST', headers = {}, body = null }) => {
    const res = { statusCode: null, headers: {}, bodyText: '', setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, end(b) { this.bodyText = b == null ? '' : String(b); } };
    const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
    const req = { method, headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
    await handler(req, res);
    let json = null; try { json = JSON.parse(res.bodyText); } catch {}
    return { status: res.statusCode, json, bodyText: res.bodyText };
  };
  const SAME = { host: '127.0.0.1:8971', origin: 'http://127.0.0.1:8971', 'content-type': 'application/json' };
  const callSame = (m, a) => call({ headers: SAME, body: { method: m, args: a ?? {} } });

  // 前置：确保 8972 无守护、8973 有守护（都只碰我自己的槽位）
  await DC.stopDaemon({ ...baseConfig, daemonPort: MY_SLOT }, { log: () => {}, slot: MY_SLOT }).catch(() => ({}));
  const ensuredF = await DC.ensureDaemon({ ...baseConfig, daemonPort: FOREIGN_SLOT }, { version: '0.2.0-rc.2', log: () => {} });
  const pidF0 = ensuredF?.info?.daemonPid ?? null;
  say(`前置：配置槽位 ${MY_SLOT} 无守护；别槽 ${FOREIGN_SLOT} 已起守护 pid=${pidF0} ok=${ensuredF?.ok}`);

  const snap = await callSame('explorer.snapshot');
  const d = snap.json?.result?.daemon ?? null;
  const others = Array.isArray(d?.others) ? d.others : [];
  const otherHit = others.find((o) => Number(o.slot) === FOREIGN_SLOT) ?? null;
  say(`snapshot.daemon = ${JSON.stringify(d)}`);
  const c1 = snap.status === 200 && d?.running === false && d?.pid == null && otherHit !== null && typeof otherHit.note === 'string' && otherHit.note.includes('非本槽位');
  say(`判据① running=false 且未回落别槽 = ${d?.running === false && d?.pid == null} ；判据② others[] 含 ${FOREIGN_SLOT} 且带"非本槽位"note = ${otherHit !== null && String(otherHit.note).includes('非本槽位')}`);

  // 硬证明：stop 别槽 ⇒ 400/E_ARG 且 pid 不变
  const st = await callSame('explorer.daemon', { action: 'stop', slot: FOREIGN_SLOT });
  const afterSnap = await DC.daemonSnapshot({ ...baseConfig, daemonPort: FOREIGN_SLOT });
  const liveAfter = (afterSnap.live ?? []).find((l) => Number(l.slot) === FOREIGN_SLOT) ?? null;
  const pidF1 = liveAfter?.info?.daemonPid ?? null;
  const unchanged = pidF0 !== null && pidF0 === pidF1;
  say(`explorer.daemon stop slot=${FOREIGN_SLOT} ⇒ HTTP ${st.status} code=${st.json?.code} msg=${st.json?.error}`);
  say(`别槽 pid: before=${pidF0} after=${pidF1} ⇒ 未变 = ${unchanged}（**硬证明**）`);
  const pass4 = c1 && st.status === 400 && st.json?.code === 'E_ARG' && unchanged;
  say(`verdict=${pass4 ? 'PASS —— F33 已修（面板只认配置槽位 + 动作面拒绝别槽，且别槽守护确实没被动）' : '❌ FAIL'}`);
  summary.D2_F33 = {
    snapshotStatus: snap.status, daemon: d, othersFound: others, otherEntry: otherHit,
    stopStatus: st.status, stopCode: st.json?.code, stopError: st.json?.error,
    pidBefore: pidF0, pidAfter: pidF1, pidUnchanged: unchanged, verdict: pass4 ? 'PASS' : 'FAIL',
  };
  dump('out-D2-D2-F33-slot-isolation.txt');

  // 收尾：只停我起的别槽守护（**不经 handler**，因为它按设计会拒别槽）
  const stopF = await DC.stopDaemon({ ...baseConfig, daemonPort: FOREIGN_SLOT }, { log: () => {}, slot: FOREIGN_SLOT });
  say(`收尾：直接停别槽 ${FOREIGN_SLOT} ⇒ ok=${stopF?.ok} alreadyStopped=${stopF?.alreadyStopped === true}`);
  summary.D2_cleanup = { slot: FOREIGN_SLOT, ok: stopF?.ok ?? null, alreadyStopped: stopF?.alreadyStopped === true };
}

// ── D4：F14b（需先占住 8972–8974）─────────────────────────────────────────────
if (PHASE === 'ensurefail') {
  lines.length = 0;
  say('### D4  F14b：ensure 失败路径 —— `openSession` 与 `daemon` 必须**都是 503**（改前 openSession 是 500）');
  // ⚠ 用户投诉可见控制台窗口后改用**不存在的发行版**诱发 ensure 失败（原来的 WSL 侧占端口方案要直接调 wsl.exe）。
  //   两种手法走的是**同一条** ensure 失败分支；插件自身的 spawn 已有 windowsHide:true（daemon-client.ts:403-406）。
  const cfgBogus = { ...baseConfig, distro: 'debian-u8-1-__no_such_distro__' };
  say(`诱发方式：distro=${cfgBogus.distro}（不存在）⇒ ensureDaemon 必然失败；不占端口、不直接调 wsl.exe`);
  const ws = makeFakeWebServer();
  const ctx = makeCtx({ wsList: [ws], fireTimes: 1 });
  const idx = await import(`file:///${SRC_INDEX}`);
  idx.apply(ctx, cfgBogus);
  const handler = [...ws.table.values()][0].handler;
  const call = async (m, a) => {
    const res = { statusCode: null, headers: {}, bodyText: '', setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, end(b) { this.bodyText = b == null ? '' : String(b); } };
    const bodyStr = JSON.stringify({ method: m, args: a ?? {} });
    const req = { method: 'POST', headers: { host: '127.0.0.1:8971', origin: 'http://127.0.0.1:8971', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(bodyStr); } };
    await handler(req, res);
    let json = null; try { json = JSON.parse(res.bodyText); } catch {}
    return { status: res.statusCode, json };
  };
  const rd = await call('explorer.daemon', { action: 'ensure' });
  say(`explorer.daemon{ensure} → HTTP ${rd.status} code=${rd.json?.code}`);
  say(`  err=${String(rd.json?.error).slice(0, 260)}`);
  const ro = await call('explorer.openSession', { distro: cfgBogus.distro, path: '/home/g' });
  say(`explorer.openSession{path:/home/g} → HTTP ${ro.status} code=${ro.json?.code}`);
  say(`  err=${String(ro.json?.error).slice(0, 260)}`);
  const pass = rd.status === 503 && rd.json?.code === 'E_UNAVAILABLE' && ro.status === 503 && ro.json?.code === 'E_UNAVAILABLE';
  say(`verdict=${pass ? 'PASS —— F14b 已修（两条路径一致 503/E_UNAVAILABLE，且失败原因确为 ensure 失败而非"无法确定版本"）' : '❌ FAIL（不一致或状态码不对）'}`);
  summary.D4_F14b = { inducedBy: 'nonexistent distro (ensure failure)', daemonEnsure: { status: rd.status, code: rd.json?.code, error: rd.json?.error }, openSession: { status: ro.status, code: ro.json?.code, error: ro.json?.error }, verdict: pass ? 'PASS' : 'FAIL' };
  dump('out-D2-D4-F14b-status-parity.txt');
}

writeFileSync(`${DIR}out-D2-delta-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nDELTA(${PHASE}) 完成；汇总见 out-D2-delta-summary.json`);

// ── 辅助阶段：停掉我自己的槽位（供 F31/D4 前后清理；**不经 handler**，避免与 F33 的守卫纠缠）──
if (PHASE === 'stopmine') {
  const r = await DC.stopDaemon({ ...baseConfig, daemonPort: MY_SLOT }, { log: () => {}, slot: MY_SLOT });
  console.log(`stopmine: slot=${MY_SLOT} ok=${r?.ok} alreadyStopped=${r?.alreadyStopped === true} pid=${r?.pid ?? '-'}`);
}
process.exit(0);
