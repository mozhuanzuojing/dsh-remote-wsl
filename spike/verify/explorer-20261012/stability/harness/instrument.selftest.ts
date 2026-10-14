/* instrument.selftest.mjs —— 在 **Node 里**给仪表层做单元自检（不需要浏览器、不需要宿主、不开端口）。
 *
 * 为什么值得做：①②的所有结论都建立在 instrument.js 的记账上（监听器 add−remove 净额、定时器未决、
 * fetch 在飞/闸门/seq）。仪表错了 ⇒ 读数全错，而且是"看起来很专业"的错。所以在宿主就绪前先用
 * vm + DOM shim 把它按用例跑通，把"仪表能正确计数"这件事变成**可执行的证据**而不是信念。
 *
 * 覆盖：安装幂等 / 监听器净额 / 定时器未决 / fetch 记账+闸门（延迟与 never）/ 夹具集成（marker、行数、
 *       路径长度、prettyBytes）/ 数组上限 / 探针不自污染（rawDelay 用未包装定时器）。
 *
 * 用法：node instrument.selftest.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL（失败细节打印在 stdout）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAB = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(STAB, 'browser', p), 'utf8');

// ---------- 最小 DOM / 宿主 shim ----------
class FakeEventTarget extends EventTarget {}
class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.documentElement = { nodeName: 'HTML' };
    this.body = { nodeName: 'BODY' };
    this.head = { nodeName: 'HEAD' };
    this._all = new Array(120).fill(null).map(() => ({ nodeName: 'DIV' }));
  }
  getElementsByTagName() {
    return this._all;
  }
  querySelector() {
    return null; // 无面板、无 .dsh-rw-pre：本自检不测 DOM 读数（那要真浏览器）
  }
  querySelectorAll() {
    return [];
  }
  createElement(tag) {
    return { tagName: String(tag).toUpperCase(), dataset: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } };
  }
}
class FakeMutationObserver {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
}
class FakeGlobal extends FakeEventTarget {}
const g = new FakeGlobal();
g.window = g;
g.self = g;
g.document = new FakeDocument();
g.MutationObserver = FakeMutationObserver;
g.EventTarget = EventTarget; // ★ 必须给：漏了它 → instrument 的监听器包装抛错被吞 ⇒ 全零假绿（S5）
g.Response = Response;
g.WeakRef = WeakRef;
g.FinalizationRegistry = FinalizationRegistry;
g.performance = performance;
g.navigator = { userAgent: 'node-selftest/1.0' };
g.location = { href: 'http://127.0.0.1:8981/' };
g.console = console;
// 原生定时器（仪器要包它们；包装前的这些必须真实可用）
g.setTimeout = setTimeout;
g.clearTimeout = clearTimeout;
g.setInterval = setInterval;
g.clearInterval = clearInterval;
g.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
g.cancelAnimationFrame = (h) => clearTimeout(h);
g.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

const ctx = vm.createContext(g);
const run = (src) => vm.runInContext(src, ctx, { filename: 'shim.js' });

// ---------- 断言 ----------
const results = [];
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`}`);
};
const ge = (name, actual, min) => {
  const ok = typeof actual === 'number' && actual >= min;
  results.push({ name, ok, actual, min });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   期望 ≥${min} 实得 ${JSON.stringify(actual)}`}`);
};

// ---------- 1) 安装 + 幂等 ----------
run(read('instrument.js'));
const first = g.window.__dsrw_instr__;
const at1 = first.snapshot().installedAt;
run(read('instrument.js')); // 再装一次
const second = g.window.__dsrw_instr__;
eq('安装后暴露 __dsrw_instr__（version=1）', second.version, 1);
eq('重复注入是幂等的（同一实例，不二次包装）', first === second, true);
eq('重复注入不改 installedAt', second.snapshot().installedAt, at1);
eq('包装层建立（listeners/timers/fetch 三表都在）', [typeof second.listenerSnapshot, typeof second.timerSnapshot, typeof second.fetchSnapshot], ['function', 'function', 'function']);

// ---------- 2) 监听器净额 ----------
// ★ 前置：仪表健康必须先为 true —— 否则下面的"净额=0"就是**假绿**（这正是 harness 第一版抓到的缺陷）。
const health0 = second.snapshot().health;
eq('仪表健康：listeners/timers/fetch 三类包装全部成功（false ⇒ 零值不构成证据）', [health0.listeners, health0.timers, health0.fetch], [true, true, true]);
const l0 = second.listenerSnapshot().totals.outstanding;
const doc = g.document;
const f1 = () => {}, f2 = () => {}, f3 = () => {};
doc.addEventListener('click', f1);
doc.addEventListener('click', f2);
doc.addEventListener('keydown', f3);
const lAdd = second.listenerSnapshot().totals.outstanding;
doc.removeEventListener('click', f1);
const lNet = second.listenerSnapshot().totals.outstanding;
eq('监听器净额：+3 后 = 基线+3', lAdd - l0, 3);
eq('监听器净额：再 -1 后 = 基线+2（remove 抵扣 add）', lNet - l0, 2);
const byKey = second.listenerSnapshot().byKey;
eq('按 targetKind|type 分桶（document|click 净额=1）', byKey['document|click'], 1);

// ---------- 3) 定时器未决 ----------
const window_ = g.window;
const t0 = second.timerSnapshot().outstanding;
const th = window_.setTimeout(() => {}, 10_000);
const ti = window_.setInterval(() => {}, 10_000);
const tAfter = second.timerSnapshot().outstanding;
window_.clearTimeout(th);
window_.clearInterval(ti);
const tCleared = second.timerSnapshot().outstanding;
eq('定时器：+1 timeout +1 interval 后未决 = +2', tAfter - t0, 2);
eq('定时器：clear 后未决回到基线', tCleared - t0, 0);
eq('定时器：scheduled 计数已建立', second.timerSnapshot().stats.scheduled >= 2, true);
const rawDelayWorked = await new Promise((res) => {
  second.rawDelay(30).then(() => res(true));
});
eq('rawDelay（未包装定时器）可用 ⇒ 探针等待不会污染定时器读数', rawDelayWorked, true);
eq('rawDelay 未新增未决定时器', second.timerSnapshot().outstanding - t0, 0);

// ---------- 4) fetch 记账 + 闸门（延迟） ----------
second.setGatePlan({ delayBySeq: { 1: 200 } });
const tStart = performance.now();
const r1 = await window_.fetch('/remote-wsl/api', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'explorer.snapshot', args: {} })
});
const wallMs = performance.now() - tStart;
const fs1 = second.fetchSnapshot();
eq('fetch 记账：识别 /remote-wsl/api POST 并分配 seq=1', fs1.apiRequests.map((r) => r.seq), [1]);
ge('闸门生效：交付被延迟 ≥180ms', Math.round(wallMs), 180);
eq('闸门延迟被记录 gateDelayMs=200', fs1.apiRequests[0].gateDelayMs, 200);
eq('交付后无在飞请求', fs1.pendingApiCount, 0);
eq('lastApiSeqIssued / lastApiSeqDelivered 都=1', [fs1.lastApiSeqIssued, fs1.lastApiSeqDelivered], [1, 1]);
eq('响应本身没被改写（仍是 200 + JSON）', [r1.status, typeof (await r1.json())], [200, 'object']);

// ---------- 5) 闸门 never ⇒ 请求挂住（卡死判定的底座） ----------
second.setGatePlan({ never: [2] });
const pNever = window_.fetch('/remote-wsl/api', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'explorer.snapshot', args: {} })
});
pNever.catch(() => {});
await second.rawDelay(120);
const fsNever = second.fetchSnapshot();
eq('闸门 never：请求保持未决（pendingApiCount=1）', fsNever.pendingApiCount, 1);
eq('闸门 never：seq#2 已记账但未交付', [fsNever.apiRequests.at(-1).seq, fsNever.apiRequests.at(-1).deliveredAt], [2, null]);
second.clearGate();

// ---------- 6) 夹具集成（marker / 行数 / 路径长度 / prettyBytes） ----------
const fixturesFn = run('(' + read('fixtures.js') + ')');
const fxInstall = await fixturesFn({ fixture: 'TINY' });
eq('夹具安装成功', fxInstall.ok, true);
eq('夹具 warm 返回构造耗时与 prettyBytes（计时窗外单独测）', [typeof fxInstall.warm.buildMs, fxInstall.warm.prettyBytes > 0], ['number', true]);

const before = second.fetchSnapshot().apiSeqIssued;
await window_.fetch('/remote-wsl/api', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method: 'explorer.snapshot', args: {} })
});
const fsFx = second.fetchSnapshot();
eq('夹具接管：请求来源标为 fixture（不许冒充真实 host）', fsFx.apiRequests.at(-1).source, 'fixture');
eq('夹具 marker 进到响应里（DOM 归属断言的前提）', g.window.__dsrw_fx__.lastSeq >= 1, true);

const fxA = await fixturesFn({ fixture: 'A' });
eq('夹具 A：1 distro × 200 行', [fxA.warm.distros, fxA.warm.rows], [1, 200]);
eq('夹具 A：路径长度=60', fxA.warm.pathLen, 60);
const fxB = await fixturesFn({ fixture: 'B' });
eq('夹具 B：路径长度=300（极长路径边界）', fxB.warm.pathLen, 300);
const fxC = await fixturesFn({ fixture: 'C' });
eq('夹具 C：60 distro × 200 行 = 12000 条', [fxC.warm.distros, fxC.warm.rows], [60, 12000]);
const snapC = g.window.__dsrw_fx__.makeSnapshot(7);
const lensC = new Set(snapC.workspaces.map((w) => w.path.length));
eq('夹具 C：所有路径长度都=60（无短于 spec 的漏网）', [...lensC], [60]);
eq('夹具 C：marker 写进 target.cwd 与 daemon.version', [snapC.target.cwd, snapC.daemon.version], ['FIXTURE-SEQ-7', 'fx-7']);
ge('夹具 C：pretty-print 体积 > 1MB（= 面板 <pre> 每 render 都要重算的那份）', fxB.warm.prettyBytes, 1000);
ge('夹具 C：prettyBytes 实测值（记录用）', fxC.warm.prettyBytes, 1000000);

// ---------- 7) 仪表自身的上限（防"仪表自己泄漏"） ----------
const caps = second.caps;
eq('仪表有硬上限（fetchLog/listenerSamples/timerSamples/marks/mounts）', Object.keys(caps).sort(), ['fetchLog', 'listenerSamples', 'marks', 'mounts', 'timerSamples']);
ge('fetchLog 上限配置 >0', caps.fetchLog, 1);

// ---------- 结论 ----------
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`instrument.selftest: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log('失败用例：' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
process.exit(0);
