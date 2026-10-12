/**
 * inject-b-adapter.ts —— INJ-B′：同源闸门 + 错误码矩阵 + **副作用负向探针**（FMEA F9–F14、F8 的状态码映射）
 *                    + INJ-A 的**守护侧**状态迁移（ensure → 杀 → 复原）。
 *
 * ## 为什么是"在进程内跑真代码"而不是"打真实 HTTP 宿主"
 * 2026-10-12 15:45 起，npm 在 `C:\Users\l`（npm prefix 根）跑了一次 install，
 * 按根 `package.json`（只有 chrome-devtools-mcp）**剪掉了整个 `@deepseek-ai/*` 与 `dsh` CLI**
 * ⇒ 本机**已无法启动任何 dsh 测试宿主**（详见 REPORT 的环境阻断一节）。
 * 因此本实验改为：**真 `src/index.ts` 的 `apply()`**（真 config、真 deps）
 * → **真 `registerExplorer`**（含 lead 加固后的 try/catch）
 * → **真 `createExplorerHttpAdapter`**（被验的传输层本体）
 * → 由桩 webServer 捕获 route.handler，再喂**合成的 node req/res**。
 *
 * **这条实验证明什么 / 不证明什么（必须原样写进报告）**：
 *   ✅ 证明：同源判据、403/400/405/415 的判定**顺序**、白名单、错误码→状态码映射、
 *           "403 时一个方法都不执行"（用真实守护 pid 前后对照）、以及守护 ensure/stop 的状态迁移。
 *   ❌ 不证明：真实 `node:http` 服务器、真实 `webServer.register` 装配、Cordis 运行时、
 *           以及**浏览器**实际发送的 `Origin`/`Sec-Fetch-Site`（这里是手工构造的头部）。
 *
 * 用法（必须带 --go）：
 *   node --experimental-strip-types inject-b-adapter.ts --go [--daemon-slot 8972]
 * 产物：out-B2-*.json、out-B2-api-gate.txt、out-B2-summary.json
 *
 * 纪律：只用自己的槽位 8972（存在则拒绝跑）；结束回到"8972 无守护"的起点；不碰 19387。
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const GO = process.argv.includes('--go');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const SLOT = Number(arg('daemon-slot', '8972'));
const LIVE_HOST_PORT = 19387;
const LIVE_HOST_PID_BASELINE = 47564;
const ALLOWED_SLOTS = [8972, 8973, 8974];

if (!GO) {
  console.log('INJ-B′ 计划（未执行；加 --go 才 import 被验对象并驱动真 adapter）');
  console.log(`  槽位 ${SLOT}（只允许 ${ALLOWED_SLOTS.join('/')}）`);
  console.log('  步骤：1 同源200 · 2 无Origin403 · 3 异源403 · 4 cross-site403 · 5 异端口403 · 6 无Host403');
  console.log('        7 未知方法400 · 8 坏JSON400 · 9 空方法400 · 10 PUT405 · 11 非JSON类型415 · 12 GET200');
  console.log('        13 daemon 未知 action→400(E_ARG) · 14 openSession 相对路径→400(E_ARG)');
  console.log('        15 ★负向探针：异源 stop 必须 403 且守护 pid 不变');
  console.log('        16 凭据泄漏粗筛');
  console.log('  守护侧（INJ-A 的数据面半）：ensure → snapshot(running/slot/pid) → 杀 → snapshot(未运行) → ensure 复原');
  console.log('  结束：停掉本槽位守护，回到"无守护"起点（RESTORED 记录在案）');
  process.exit(0);
}
if (!ALLOWED_SLOTS.includes(SLOT)) { console.error(`拒跑：槽位 ${SLOT} 不在自有段 ${ALLOWED_SLOTS.join('/')}`); process.exit(3); }

const steps = [];
const log = (s) => { appendFileSync(`${DIR}out-B2-api-gate.txt`, s + '\n', 'utf8'); console.log(s); };
writeFileSync(`${DIR}out-B2-api-gate.txt`, '', 'utf8');
log(`INJ-B′ (in-process, real code) @ ${new Date().toISOString()} slot=${SLOT}`);

// ── 桩 ctx + 桩 webServer（register 的真实语义：重复 (kind,path) 抛错）──────────
const tools = new Map();
const services = new Map();
const registered = [];
function makeFakeWebServer() {
  const table = new Map();
  return {
    table,
    registered,
    register(route) {
      const key = `${route.kind}:${route.path}`;
      if (table.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      table.set(key, route);
      registered.push(route);
      return () => table.delete(key);
    },
  };
}
const fakeWebServer = makeFakeWebServer();
services.set('webServer', fakeWebServer);
const childCtx = {
  get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : services.get(k)),
  set: (k, v) => void services.set(k, v),
  provide: (k, v) => void services.set(k, v),
};
const ctx = {
  inject: (_deps, cb) => cb(childCtx),   // 同步触发（真实 Cordis 是条件注入；见 INJ-C 的 C1 说明）
  get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : services.get(k)),
  set: (k, v) => void services.set(k, v),
  provide: (k, v) => void services.set(k, v),
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined; },
  plugin: () => {},
};

// 与 p0-verify 的 probe-ground-truth.ts 同形状（已被证明可跑通），只把守护端口钉在自有槽位。
const config = {
  distro: 'debian-u8-1',
  wslHome: '/home/g',
  cwd: '/home/g',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  profile: 'sdk',
  dshVersion: '',
  webPort: 3082,
  idleTimeoutMs: 120000,
  timeoutMs: 180000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\primary-runtime\\runtime.json',
  proxyPort: 9910,
  backend: 'daemon',
  daemonPort: SLOT,
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  useShellEnvironment: true,
  backgroundWarm: false,
};

const SRC = 'D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts';
const mod = await import(`file:///${SRC}`);
// 直接用真相源按槽位读数，避免 `snapshot.daemon = live[0]` 的串台（见 daemonState() 注释）。
const { daemonSnapshot } = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
mod.apply(ctx, config);
log(`apply() 完成：注册工具 = ${[...tools.keys()].join(', ')}`);
log(`webServer 捕获到的路由 = ${registered.map((r) => `${r.kind}:${r.path}`).join(', ') || '(none)'}`);
if (registered.length !== 1) { log(`ABORT：期望恰好 1 条 explorer 路由，实得 ${registered.length}（形状变了，实验无效）`); process.exit(1); }
const handler = registered[0].handler;

// ── 合成 node req/res ─────────────────────────────────────────────────────────
function fakeRes() {
  return {
    statusCode: null, headers: {}, bodyText: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.bodyText = b === null || b === undefined ? '' : String(b); },
  };
}
function fakeReq({ method = 'POST', headers = {}, body = null }) {
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return { method, headers, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}
const HOST_HEADER = `127.0.0.1:8971`;   // 模拟测试宿主的 Host（本实验不真起服务器）
const sameOrigin = { host: HOST_HEADER, origin: `http://${HOST_HEADER}` };
async function call({ method = 'POST', path, headers = {}, body = null }) {
  const res = fakeRes();
  await handler(fakeReq({ method, headers, body }), res);
  let json = null;
  try { json = JSON.parse(res.bodyText); } catch { /* 保留原文 */ }
  return { status: res.statusCode, json, bodyText: res.bodyText, headers: res.headers };
}
const callSame = (m, a) => call({ headers: { ...sameOrigin, 'content-type': 'application/json' }, body: { method: m, args: a ?? {} } });

function record(step) {
  steps.push(step);
  const nn = String(step.n).padStart(2, '0');
  writeFileSync(`${DIR}out-B2-${nn}-${step.name}.json`, JSON.stringify(step, null, 2), 'utf8');
  log(`[${step.verdict}] ${nn} ${step.name} 期望=${step.expected} 实际=${step.actual}`);
}

// ── 守护侧：**按槽位**精确观测（不用 snapshot.daemon = live[0]，那会串到别人的槽位）──
//    ★ 实测教训（2026-10-12 15:57）：停掉我的 8972 后，`snapshot.daemon`（= live[0]）**回落成 p0-verify 的 8932 守护**
//      ⇒ 我先前的断言把"别人的守护"当成"我的还活着"，造成 A2 假 FAIL + 收尾假 RESTORED: NO。
//      这与 INJ-A 加固①要防的是同一个坑；此处改为直接调 `daemonSnapshot()` 只看 SLOT。
async function daemonState() {
  const snap = await daemonSnapshot(config);
  const live = Array.isArray(snap.live) ? snap.live : [];
  const mineRec = live.find((l) => Number(l.slot) === SLOT) ?? null;
  return {
    mine: mineRec
      ? { running: true, slot: Number(mineRec.slot), pid: mineRec.info?.daemonPid ?? null, port: mineRec.info?.port ?? null }
      : { running: false, slot: SLOT, pid: null, port: null },
    liveSlotsAll: live.map((l) => ({ slot: Number(l.slot), pid: l.info?.daemonPid ?? null })),
    liveFirst: live[0] ? { slot: Number(live[0].slot), pid: live[0].info?.daemonPid ?? null } : null,
    orphans: Array.isArray(snap.orphans) ? snap.orphans.length : 0,
  };
}

// ── 前置：起点 + **串台取证**（配置槽位 vs live[0]）───────────────────────────
{
  const st = await daemonState();
  const apiSnap = await callSame('explorer.snapshot');
  const apiDaemon = apiSnap.json?.result?.daemon ?? null;
  const crossTenant = st.liveFirst !== null && Number(st.liveFirst.slot) !== SLOT;
  log(`前置：本槽位(${SLOT}) running=${st.mine.running}；daemonSnapshot live 全槽=${JSON.stringify(st.liveSlotsAll)}；live[0]=${JSON.stringify(st.liveFirst)}`);
  log(`前置：**面板会看到的** snapshot.daemon = ${JSON.stringify(apiDaemon)}`);
  if (crossTenant) {
    log(`★ 串台取证：配置槽位是 ${SLOT}，但 live[0] 是别人的槽位 ${st.liveFirst.slot}（pid ${st.liveFirst.pid}）`
      + ` ⇒ 若我不先把自己的守护起起来，面板状态条会把**别人的守护**当成本插件目标（F33）。`);
  }
  writeFileSync(`${DIR}out-B2-00-precondition.json`, JSON.stringify({
    at: new Date().toISOString(), slot: SLOT,
    mine: st.mine, liveSlotsAll: st.liveSlotsAll, liveFirst: st.liveFirst, panelVisibleDaemon: apiDaemon,
    crossTenantLiveFirst: crossTenant,
    note: 'lead 15:44 给的起点是"WSL 侧无守护"，但实测 live[0] 是 p0-verify 的 8932 守护（它自己在 task-4 里起的）。本实验全程只动 SLOT。',
  }, null, 2), 'utf8');
}

// ── 1–12：闸门与状态码矩阵 ───────────────────────────────────────────────────
{
  const r = await callSame('explorer.snapshot');
  const ok = r.status === 200 && r.json?.ok === true && r.json?.result?.daemon !== undefined;
  record({ n: 1, name: 'same-origin-snapshot-200', expected: 200, actual: r.status, verdict: ok ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
for (const g of [
  { n: 2, name: 'no-origin-403', headers: { host: HOST_HEADER, 'content-type': 'application/json' } },
  { n: 3, name: 'foreign-origin-403', headers: { host: HOST_HEADER, origin: 'http://evil.example', 'content-type': 'application/json' } },
  { n: 4, name: 'cross-site-403', headers: { ...sameOrigin, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' } },
  { n: 5, name: 'wrong-port-origin-403', headers: { host: HOST_HEADER, origin: 'http://127.0.0.1:9999', 'content-type': 'application/json' } },
  { n: 6, name: 'no-host-403', headers: { origin: 'http://127.0.0.1:8971', 'content-type': 'application/json' } },
]) {
  // 这些步的 body 用**幂等**的 ensure，确保"万一闸门失守"也不造成破坏；破坏性探针只在 step 15。
  const r = await call({ headers: g.headers, body: { method: 'explorer.daemon', args: { action: 'ensure', slot: SLOT } } });
  record({ n: g.n, name: g.name, expected: 403, actual: r.status, verdict: r.status === 403 ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
{
  const r = await callSame('explorer.nope');
  const ok = r.status === 400 && Array.isArray(r.json?.methods);
  record({ n: 7, name: 'unknown-method-400', expected: '400 + methods[]', actual: r.status, verdict: ok ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
{
  const r = await call({ headers: { ...sameOrigin, 'content-type': 'application/json' }, body: '{"method":' });
  record({ n: 8, name: 'malformed-json-400', expected: 400, actual: r.status, verdict: r.status === 400 ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
{
  const r = await callSame('');
  record({ n: 9, name: 'empty-method-400', expected: 400, actual: r.status, verdict: r.status === 400 ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
{
  const r = await call({ method: 'PUT', headers: { ...sameOrigin, 'content-type': 'application/json' }, body: { method: 'explorer.snapshot', args: {} } });
  record({ n: 10, name: 'put-405', expected: 405, actual: r.status, verdict: r.status === 405 ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
{
  const r = await call({ headers: { ...sameOrigin, 'content-type': 'text/plain' }, body: { method: 'explorer.snapshot', args: {} } });
  record({ n: 11, name: 'non-json-ctype-415', expected: 415, actual: r.status, verdict: r.status === 415 ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
{
  const r = await call({ method: 'GET', headers: { ...sameOrigin } });
  const ok = r.status === 200 && Array.isArray(r.json?.methods);
  record({ n: 12, name: 'get-methods-200', expected: '200 + methods[]', actual: r.status, verdict: ok ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
// 13/14：E_ARG → 400（lead 加固 2 的新映射）
{
  const r = await callSame('explorer.daemon', { action: 'bogus' });
  const ok = r.status === 400 && String(r.json?.code) === 'E_ARG';
  record({ n: 13, name: 'daemon-bad-action-400-E_ARG', expected: '400 code=E_ARG', actual: `${r.status} code=${r.json?.code}`, verdict: ok ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}
{
  const r = await callSame('explorer.openSession', { distro: 'debian-u8-1', path: 'relative/not/absolute' });
  const ok = r.status === 400 && String(r.json?.code) === 'E_ARG';
  record({ n: 14, name: 'openSession-relative-path-400-E_ARG', expected: '400 code=E_ARG', actual: `${r.status} code=${r.json?.code}`, verdict: ok ? 'PASS' : 'FAIL', response: { status: r.status, json: r.json } });
}

// ── 守护侧迁移（INJ-A 的数据面半）：ensure → 杀 → 复原 ────────────────────────
let pidA = null;
{
  const r = await callSame('explorer.daemon', { action: 'ensure', slot: SLOT });
  const st = await daemonState();
  pidA = st.mine.pid ?? null;
  const ok = r.status === 200 && st.mine.running === true && Number(st.mine.slot) === SLOT && typeof pidA === 'number';
  log(`  ensure: HTTP ${r.status} ok=${r.json?.ok} 我的槽位 slot=${st.mine.slot} pid=${pidA}（live[0]=${JSON.stringify(st.liveFirst)}）`);
  record({
    n: 'A1', name: 'daemon-ensure-then-snapshot', expected: `200 且本槽位 running=true slot=${SLOT} pid 非空`,
    actual: `HTTP ${r.status} mine.running=${st.mine.running} slot=${st.mine.slot} pid=${pidA}`,
    verdict: ok ? 'PASS' : 'FAIL', response: { ensure: { status: r.status, json: r.json }, mine: st.mine, liveSlotsAll: st.liveSlotsAll },
  });
}

// ★ 15：副作用负向探针（本组唯一的硬证明）—— 异源 + stop 必须 403 且 pid 不变
{
  const before = await daemonState();
  const r = await call({ headers: { host: HOST_HEADER, origin: 'http://evil.example', 'content-type': 'application/json' }, body: { method: 'explorer.daemon', args: { action: 'stop', slot: SLOT } } });
  const after = await daemonState();
  const pidBefore = before.mine.pid ?? null;
  const pidAfter = after.mine.pid ?? null;
  const unchanged = pidBefore !== null && pidBefore === pidAfter && after.mine.running === true;
  record({
    n: 15, name: 'negative-sideeffect-stop-must-not-run',
    expected: `403 且**我的槽位** pid 仍为 ${pidBefore}（running=true）`,
    actual: `HTTP ${r.status} mine.pid=${pidAfter} mine.running=${after.mine.running}`,
    verdict: unchanged ? (r.status === 403 ? 'PASS' : 'FAIL') : 'INVARIANT-BROKEN',
    response: { status: r.status, json: r.json }, pidBefore, pidAfter, liveSlotsAll: after.liveSlotsAll,
  });
  if (!unchanged) { log('!! 闸门失守：403 的 stop 竟然生效 —— 立即 ensure 复原'); await callSame('explorer.daemon', { action: 'ensure', slot: SLOT }); }
}

// 合法 stop（同源）⇒ 必须真的停掉（证明 stop 本身有效，排除"根本没生效"的假绿）
{
  const r = await callSame('explorer.daemon', { action: 'stop', slot: SLOT });
  const st = await daemonState();
  const gone = st.mine.running !== true;
  log(`  合法 stop: HTTP ${r.status} → 我的槽位(${SLOT}) running=${st.mine.running}（live[0]=${JSON.stringify(st.liveFirst)}）`);
  record({
    n: 'A2', name: 'daemon-legit-stop-kills', expected: `200 且**我的槽位**(${SLOT}) running≠true（证明确实能停，排除假绿）`,
    actual: `HTTP ${r.status} mine.running=${st.mine.running}`, verdict: r.status === 200 && gone ? 'PASS' : 'FAIL',
    response: { stop: { status: r.status, json: r.json }, mine: st.mine, liveFirst: st.liveFirst, liveSlotsAll: st.liveSlotsAll },
    note: '注意：此时 snapshot.daemon(=live[0]) 会**回落到别人的槽位**（实测 8932），这正是 INJ-A 加固①与 F33 要防的串台。',
  });
}

// 复原：ensure ⇒ 必须重新有守护（pid 可变）
{
  const r = await callSame('explorer.daemon', { action: 'ensure', slot: SLOT });
  const st = await daemonState();
  const pidB = st.mine.pid ?? null;
  const restored = r.status === 200 && st.mine.running === true && Number(st.mine.slot) === SLOT && typeof pidB === 'number';
  log(`  复原 ensure: HTTP ${r.status} 我的槽位 slot=${st.mine.slot} pid=${pidB}（原 pidA=${pidA}）`);
  record({
    n: 'A3', name: 'restore-ensure', expected: `200 且本槽位运行、slot=${SLOT}、pid 非空（pid 可变）`,
    actual: `HTTP ${r.status} mine.running=${st.mine.running} slot=${st.mine.slot} pid=${pidB}`,
    verdict: restored ? 'PASS' : 'FAIL', response: { ensure: { status: r.status, json: r.json }, mine: st.mine, pidA, pidB },
  });
}

// ── 16：凭据泄漏粗筛（对全部响应原文）──────────────────────────────────────────
{
  const scan = JSON.stringify(steps).toLowerCase();
  const needles = ['token', 'authorization', 'bearer', 'secret', 'credential', 'apikey', 'api_key', 'password'];
  const hits = needles.filter((n) => scan.includes(n));
  record({
    n: 16, name: 'credential-leak-scan', expected: '响应体不含 token/凭据字段',
    actual: hits.length ? `命中 ${hits.join(',')}` : '无命中', verdict: hits.length ? 'FAIL' : 'PASS',
    note: '关键字粗筛；未按 token 形状精筛（列入未复核）', response: { hits },
  });
}

// ── 收尾：停掉本槽位守护，回到起点（lead 给的环境起点 = WSL 侧无守护）──────────
{
  await callSame('explorer.daemon', { action: 'stop', slot: SLOT });
  const st = await daemonState();
  const backToStart = st.mine.running !== true;
  log(`收尾停止守护：我的槽位(${SLOT}) running=${st.mine.running}；liveSlotsAll=${JSON.stringify(st.liveSlotsAll)}；live[0]=${JSON.stringify(st.liveFirst)}`
    + ` ⇒ RESTORED: ${backToStart ? 'yes（本槽位已回到"无守护"起点）' : 'NO'}`);
  writeFileSync(`${DIR}out-B2-99-restore.json`, JSON.stringify({
    at: new Date().toISOString(), backToStart, mine: st.mine, liveSlotsAll: st.liveSlotsAll, liveFirst: st.liveFirst,
    note: '本实验只动自己的槽位；未触碰 live[0] 里别人的守护（8932）。uid 之外的槽位保持原样。',
  }, null, 2), 'utf8');
  if (!backToStart) process.exitCode = 2;
}

const fails = steps.filter((s) => !String(s.verdict).startsWith('PASS'));
writeFileSync(`${DIR}out-B2-summary.json`, JSON.stringify({
  at: new Date().toISOString(), slot: SLOT, mode: 'in-process-real-code', exitCode: fails.length ? 1 : 0,
  pass: steps.filter((s) => String(s.verdict).startsWith('PASS')).length, total: steps.length, steps,
}, null, 2), 'utf8');
log('');
log(`汇总：${steps.filter((s) => String(s.verdict).startsWith('PASS')).length}/${steps.length} PASS；非 PASS：${fails.map((s) => `${s.n}:${s.verdict}`).join(', ') || '(none)'}`);
log('限制：未经过真实 node:http / webServer.register / Cordis / 浏览器 → 记入未复核。');
process.exit(fails.length ? 1 : (process.exitCode ?? 0));
