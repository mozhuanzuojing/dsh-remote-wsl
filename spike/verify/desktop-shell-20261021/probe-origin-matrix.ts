#!/usr/bin/env node
/**
 * probe-origin-matrix.ts —— /remote-wsl/api 来源闸门的回归矩阵（桌面壳补丁的 before/after 证据）。
 *
 * 为什么需要它：面板在 DSH Desktop（Electron 壳）里全部数据/动作 403，错误文案
 * 「跨站请求被拒（Origin/Host 不同源）」。根因不是网络，而是闸门假设"页面来自 http origin"：
 * 桌面壳把页面 dsh-app://app 发起的 fetch 交给 Node fetch 重放，并主动删掉
 * origin/host/cookie/sec-fetch-site（app.asar/lib/main.js 的 forwardWebRequest），
 * 于是到达本路由的请求没有任何 Origin，旧实现直接 403。
 *
 * 本探针不碰 DSH、不碰 WSL：直接把 createExplorerHttpAdapter() 装到一个本地 http 服务上，
 * 用桩 handler 记录"方法是否被执行"，逐形状断言状态码与副作用。
 *
 * 用法（零依赖）：
 *   node probe-origin-matrix.ts [--label before|after]
 *
 * 产物（本目录）：
 *   out-<label>-origin-matrix.json   机器可读
 *   out-<label>-origin-matrix.txt    人读表格
 * 退出码：0=全符合；1=有偏差；3=环境错误（起不来服务）。
 */
import http from 'node:http';
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createExplorerHttpAdapter } from '../../../src/explorer.ts';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const LABEL = opt('label', 'after');

/** 桩数据面：每个方法被调用就记一笔，绝不碰 daemon/WSL。 */
const executed = [];
const handlers = {
  'explorer.snapshot': () => { executed.push('explorer.snapshot'); return { stub: 'snapshot' }; },
  'explorer.openSession': () => { executed.push('explorer.openSession'); return { sessionId: null }; },
  'explorer.daemon': () => { executed.push('explorer.daemon'); return { ok: true }; },
  'explorer.fixPin': () => { executed.push('explorer.fixPin'); return { ok: true }; },
  'explorer.listDir': () => { executed.push('explorer.listDir'); return { entries: [] }; },
  'explorer.addWorkspace': () => { executed.push('explorer.addWorkspace'); return { ok: true }; },
};

let route = null;
const webServer = {
  register(opts) {
    if (opts && opts.kind === 'exact' && typeof opts.handler === 'function') route = opts.handler;
    return { dispose() { route = null; } };
  },
};
createExplorerHttpAdapter(webServer, handlers);
if (typeof route !== 'function') {
  console.error('环境错误：adapter 没有注册路由（webServer.register 未被调用）');
  process.exit(3);
}

const server = http.createServer((req, res) => {
  Promise.resolve(route(req, res)).catch((e) => {
    try { res.statusCode = 500; res.end(String(e && e.message ? e.message : e)); } catch {}
  });
});

/** 一次原始请求：可完全控制 headers。 */
function request(shape) {
  const port = server.address().port;
  const method = shape.method || 'POST';
  const headers = Object.assign({}, shape.headers || {});
  const body = shape.body === undefined ? null : shape.body;
  const payload = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/remote-wsl/api', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, bodyText: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: null, bodyText: '', error: e.message }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** raw socket：唯一能真正省略 Host 的形状。 */
function rawNoHost(body) {
  const port = server.address().port;
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(Object.assign({ status: null, bodyText: Buffer.concat(chunks).toString('utf8') }, extra));
    };
    sock.setTimeout(4000, () => finish({ error: 'timeout' }));
    sock.on('connect', () => {
      const payload = JSON.stringify(body);
      sock.write('POST /remote-wsl/api HTTP/1.0\r\ncontent-type: application/json\r\naccept: application/json\r\ncontent-length: ' +
        Buffer.byteLength(payload) + '\r\n\r\n' + payload);
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(text);
      finish({ status: m ? Number(m[1]) : null, bodyText: text });
    });
    sock.on('error', (e) => finish({ error: e.message }));
  });
}

const JSON_CT = { 'content-type': 'application/json', accept: 'application/json' };
const bodyFor = (method) => ({ method, args: {} });

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const HOST = '127.0.0.1:' + port;
const SELF_ORIGIN = 'http://' + HOST;

const cases = [
  {
    id: 'C1-browser-same-origin-post',
    why: '普通 Web UI（浏览器）同源 POST —— 既有行为，不得回归',
    shape: { method: 'POST', headers: Object.assign({}, JSON_CT, { host: HOST, origin: SELF_ORIGIN, 'sec-fetch-site': 'same-origin' }), body: bodyFor('explorer.snapshot') },
    expectStatus: 200, expectExecuted: ['explorer.snapshot'],
  },
  {
    id: 'C2-desktop-shell-forward-post',
    why: '★ 桌面壳 dsh-app://app 转发：壳删掉 origin/sec-fetch-site 后用 Node fetch 重放 ⇒ 无 Origin、无 Sec-Fetch-Site',
    shape: { method: 'POST', headers: Object.assign({}, JSON_CT, { host: HOST, cookie: 'dsh-host-cookie=redacted' }), body: bodyFor('explorer.snapshot') },
    expectStatus: 200, expectExecuted: ['explorer.snapshot'],
  },
  {
    id: 'C3-desktop-shell-forward-get',
    why: '桌面壳里 GET 方法发现（面板/CLI 探活）',
    shape: { method: 'GET', headers: { accept: 'application/json', host: HOST } },
    expectStatus: 200, expectExecuted: [],
  },
  {
    id: 'C4-desktop-shell-forward-unknown-method',
    why: '无 Origin 也必须进入白名单判定（未知方法 400），不许被闸门误杀',
    shape: { method: 'POST', headers: Object.assign({}, JSON_CT, { host: HOST }), body: bodyFor('explorer.__probe__') },
    expectStatus: 400, expectExecuted: [],
  },
  {
    id: 'C5-foreign-origin-post',
    why: '第三方网页 POST（CSRF）必须仍被拒，且一个方法都不执行',
    shape: { method: 'POST', headers: Object.assign({}, JSON_CT, { host: HOST, origin: 'http://evil.example' }), body: bodyFor('explorer.snapshot') },
    expectStatus: 403, expectExecuted: [],
  },
  {
    id: 'C6-wrong-port-origin-post',
    why: '同 host 异端口（另一个本机服务冒充）必须被拒',
    shape: { method: 'POST', headers: Object.assign({}, JSON_CT, { host: HOST, origin: 'http://127.0.0.1:1' }), body: bodyFor('explorer.snapshot') },
    expectStatus: 403, expectExecuted: [],
  },
  {
    id: 'C7-cross-site-marker-post',
    why: '浏览器明确标记 cross-site（即使 Origin 被改掉）必须被拒',
    shape: { method: 'POST', headers: Object.assign({}, JSON_CT, { host: HOST, origin: SELF_ORIGIN, 'sec-fetch-site': 'cross-site' }), body: bodyFor('explorer.snapshot') },
    expectStatus: 403, expectExecuted: [],
  },
  {
    id: 'C8-browser-same-origin-get',
    why: '浏览器同源 GET 不带 Origin、只带 Sec-Fetch-Site: same-origin ⇒ 放行（只回方法清单）',
    shape: { method: 'GET', headers: { accept: 'application/json', host: HOST, 'sec-fetch-site': 'same-origin' } },
    expectStatus: 200, expectExecuted: [],
  },
  {
    id: 'C9-same-origin-put',
    why: '同源但动词不对 ⇒ 405（闸门已过，动词被拒）',
    shape: { method: 'PUT', headers: { host: HOST, origin: SELF_ORIGIN } },
    expectStatus: 405, expectExecuted: [],
  },
  {
    id: 'C10-same-origin-non-json',
    why: '同源但类型不对 ⇒ 415',
    shape: { method: 'POST', headers: { 'content-type': 'text/plain', host: HOST, origin: SELF_ORIGIN }, body: 'x' },
    expectStatus: 415, expectExecuted: [],
  },
  {
    id: 'C11-same-origin-unknown-method',
    why: '同源 + 未知方法 ⇒ 400（硬白名单）',
    shape: { method: 'POST', headers: Object.assign({}, JSON_CT, { host: HOST, origin: SELF_ORIGIN }), body: bodyFor('explorer.__probe__') },
    expectStatus: 400, expectExecuted: [],
  },
  {
    id: 'C12-no-host',
    why: '没有 Host 头 ⇒ 403（闸门第一个条件）',
    shape: { rawNoHost: true },
    expectStatus: 403, expectExecuted: [],
  },
];

const records = [];
let failures = 0;
for (const c of cases) {
  executed.length = 0;
  const res = c.shape.rawNoHost ? await rawNoHost(bodyFor('explorer.snapshot')) : await request(c.shape);
  const seen = executed.slice();
  const statusOk = res.status === c.expectStatus;
  const execOk = JSON.stringify(seen) === JSON.stringify(c.expectExecuted);
  const ok = statusOk && execOk;
  if (!ok) failures++;
  records.push({
    id: c.id, why: c.why,
    expected: { status: c.expectStatus, executed: c.expectExecuted },
    actual: { status: res.status, executed: seen, bodyText: String(res.bodyText || '').slice(0, 300) },
    verdict: ok ? 'PASS' : 'FAIL',
  });
}

server.close();

const summary = { label: LABEL, generatedAt: new Date().toISOString(), port, total: records.length, pass: records.length - failures, fail: failures, records };
writeFileSync(DIR + 'out-' + LABEL + '-origin-matrix.json', JSON.stringify(summary, null, 2) + '\n', 'utf8');
const pad = (s, n) => String(s).padEnd(n);
let txt = 'origin matrix (' + LABEL + ') @ ' + summary.generatedAt + '  port=' + port + '\n';
txt += pad('case', 44) + pad('expect', 8) + pad('actual', 8) + 'verdict\n';
for (const r of records) txt += pad(r.id, 44) + pad(r.expected.status, 8) + pad(r.actual.status, 8) + r.verdict + '\n';
txt += '\nPASS ' + summary.pass + ' / ' + summary.total + '  (FAIL ' + summary.fail + ')\n';
writeFileSync(DIR + 'out-' + LABEL + '-origin-matrix.txt', txt, 'utf8');
console.log(txt);
for (const r of records) {
  if (r.verdict === 'FAIL') console.log('FAIL ' + r.id + '  expected=' + JSON.stringify(r.expected) + '  actual=' + JSON.stringify({ status: r.actual.status, executed: r.actual.executed }) + '  body=' + r.actual.bodyText);
}
process.exit(failures === 0 ? 0 : 1);
