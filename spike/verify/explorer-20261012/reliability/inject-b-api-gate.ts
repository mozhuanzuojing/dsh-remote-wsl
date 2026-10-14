#!/usr/bin/env node
/**
 * inject-b-api-gate.mjs —— INJ-B：`/remote-wsl/api` 的同源闸门 + 错误码矩阵（FMEA F9–F13）。
 *
 * 为什么用 Node 而不是 PowerShell：HttpClient 不允许自由设置/省略 `Host` 等受限头，
 * 而本实验的核心恰恰是"**伪造/缺失** Origin、Sec-Fetch-Site、Host"三类边界 + 一条
 * HTTP/1.0 无 Host 的 raw socket 请求。Node 原生 `http`/`net` 可以逐字节控制。
 *
 * 零依赖、只打 127.0.0.1、绝不改被验对象。
 *
 * 用法（**必须带 --go**，否则只打印计划、不发一个包）：
 *   node inject-b-api-gate.mjs --go [--port 8971] [--daemon-slot 8972]
 *
 * 产物（本目录）：
 *   out-B-<nn>-<name>.json     每步原始请求/响应
 *   out-B-api-gate.json        机器可读汇总
 *   out-B-api-gate.txt         人读表格（期望 / 实际 / 判定）
 *
 * 退出码：0=全部符合期望；1=有偏差（已落档，报告里必须写）；
 *        2=**副作用闸门失守**（403 的请求竟然停掉了守护 —— 最高危）；3=前置条件不满足。
 */
import http from 'node:http';
import net from 'node:net';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const GO = has('go');
const PORT = Number(arg('port', '8971'));
const SLOT = Number(arg('daemon-slot', '8972'));
const HOST = '127.0.0.1';
const ROUTE = '/remote-wsl/api';
const LIVE_HOST_PORT = 19387; // 用户在用宿主：只允许一次只读 GET 作为"还活着"的证据
const LIVE_HOST_PID_BASELINE = 47564; // 2026-10-12 准备期实测；开工后若变了必须在报告里说明

// ── 前置守卫（违反即拒跑，绝不"尽力而为"）────────────────────────────────────
function guard() {
  const problems = [];
  if (!Number.isInteger(PORT) || PORT < 8971 || PORT > 8980) {
    problems.push(`--port 必须在 8971–8980（task-6 端口段），收到 ${PORT}`);
  }
  if (PORT === 19387 || PORT === 9910) problems.push('目标是用户宿主/proxy 端口，绝对禁止');
  if (!Number.isInteger(SLOT) || ![8972, 8973, 8974].includes(SLOT)) {
    problems.push(`--daemon-slot 只允许 8972|8973|8974（本插件自有槽位段），收到 ${SLOT}`);
  }
  return problems;
}

const problems = guard();
if (problems.length) {
  console.error('拒跑：\n - ' + problems.join('\n - '));
  process.exit(3);
}

if (!GO) {
  console.log('INJ-B 计划（未执行；加 --go 才发请求）');
  console.log(`  目标   POST/GET http://${HOST}:${PORT}${ROUTE}`);
  console.log(`  守护槽  ${SLOT}（只读比较 pid；唯一会写的是 step14 的负向探针，期望它被 403 拦住）`);
  console.log('  步骤   1 同源200 · 2 无Origin403 · 3 异源403 · 4 cross-site403 · 5 异端口403');
  console.log('         6 未知方法400 · 7 坏JSON400 · 8 空方法400 · 9 PUT405 · 10 非JSON类型415');
  console.log('         11 GET200 · 12 尾斜杠(实测) · 13 HTTP/1.0 无Host(实测)');
  console.log('         14 负向探针：异源 stop 必须 403 且 pid 不变 · 15 凭据泄漏扫描');
  console.log('  退出码 0=全符合 1=有偏差 2=副作用失守 3=前置不满足');
  process.exit(0);
}

const steps = [];
const log = (s) => appendFileSync(`${DIR}out-B-api-gate.txt`, s + '\n', 'utf8');
writeFileSync(`${DIR}out-B-api-gate.txt`, '', 'utf8');
writeFileSync(`${DIR}out-B-api-gate.json`, '', 'utf8');
log(`INJ-B api-gate @ ${new Date().toISOString()} host=${HOST}:${PORT} slot=${SLOT}`);

/** 一次原始 HTTP 请求（可自由给 headers，可指定 HTTP 版本）。 */
function request({ method, path = ROUTE, headers = {}, body = null, httpVersion = '1.1' }) {
  return new Promise((resolve) => {
    const payload = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const finalHeaders = { ...headers };
    if (payload !== null) finalHeaders['content-length'] = Buffer.byteLength(payload);
    const req = http.request(
      { host: HOST, port: PORT, method, path, headers: finalHeaders, setHost: httpVersion !== '1.0' },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString('utf8'),
            error: null,
          }),
        );
      },
    );
    req.on('error', (e) => resolve({ status: null, headers: {}, bodyText: '', error: e.message }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** HTTP/1.0 raw socket，**不带 Host** —— 只有 raw socket 才能省略 Host。 */
function rawNoHost({ body }) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    const chunks = [];
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ status: null, headers: {}, bodyText: Buffer.concat(chunks).toString('utf8'), error: null, ...extra });
    };
    sock.setTimeout(5000, () => finish({ error: 'timeout' }));
    sock.on('connect', () => {
      const b = JSON.stringify(body);
      sock.write(
        `POST ${ROUTE} HTTP/1.0\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(b)}\r\n\r\n${b}`,
      );
    });
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => finish({ rawNoHost: true }));
    sock.on('error', (e) => finish({ error: e.message, rawNoHost: true }));
  });
}

const sameOrigin = () => ({ origin: `http://${HOST}:${PORT}` });
const postBody = (method, args) => ({ method, args: args ?? {} });

/** 落档 + 判定。 */
function record(step) {
  const ok = step.verdict === 'PASS';
  steps.push(step);
  const nn = String(step.n).padStart(2, '0');
  writeFileSync(`${DIR}out-B-${nn}-${step.name}.json`, JSON.stringify(step, null, 2), 'utf8');
  const line = `[${step.verdict}] ${nn} ${step.name} 期望=${step.expected} 实际=${step.actual}${step.note ? '  ' + step.note : ''}`;
  log(line);
  console.log(line);
}

// ── 只读读数：守护 pid（step 14 的前置与后置比较）──────────────────────────────
async function readDaemon() {
  const r = await request({ method: 'POST', headers: { ...sameOrigin(), 'content-type': 'application/json' }, body: postBody('explorer.snapshot') });
  if (r.status !== 200 || !r.bodyText) return { ok: false, reason: r.error || `HTTP ${r.status}`, raw: r };
  try {
    const j = JSON.parse(r.bodyText);
    if (j?.ok !== true) return { ok: false, reason: `ok!=true: ${r.bodyText.slice(0, 200)}`, raw: r };
    return { ok: true, daemon: j.result?.daemon ?? null, raw: r };
  } catch (e) {
    return { ok: false, reason: `非 JSON: ${e.message}`, raw: r };
  }
}

async function main() {
  // 0) 活宿主只读探活（证明用户宿主未被我们碰过；只 GET，不改）
  const live = await new Promise((resolve) => {
    const req = http.get({ host: HOST, port: LIVE_HOST_PORT, path: '/', timeout: 4000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', (e) => resolve({ status: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: null, error: 'timeout' }); });
  });
  writeFileSync(
    `${DIR}out-B-00-livehost.json`,
    JSON.stringify({ liveHostPort: LIVE_HOST_PORT, baselinePid: LIVE_HOST_PID_BASELINE, probe: live, at: new Date().toISOString() }, null, 2),
    'utf8',
  );
  log(`livehost ${LIVE_HOST_PORT}: GET / => ${live.status ?? 'no-response'}（只读；基线 pid ${LIVE_HOST_PID_BASELINE}）`);

  // 前置：守护必须活着，否则 step14 的"pid 不变"是空集假绿
  const before = await readDaemon();
  if (!before.ok || before.daemon?.running !== true || typeof before.daemon?.pid !== 'number') {
    log(`前置不满足：守护未运行或快照不可读（${before.ok ? JSON.stringify(before.daemon) : before.reason}）`);
    log('=> 先在本插件槽位起守护（explorer.daemon action=ensure / wsl_daemon start），否则 step14 无判别力。');
    console.log('前置不满足：见 out-B-api-gate.txt');
    process.exit(3);
  }
  const pidBefore = before.daemon.pid;
  log(`前置 OK：daemon pid=${pidBefore} slot=${before.daemon.slot} version=${before.daemon.version ?? '-'}`);

  const J = (body) => ({ headers: { ...sameOrigin(), 'content-type': 'application/json' }, body });

  // 1) 同源对照
  {
    const r = await request({ method: 'POST', ...J(postBody('explorer.snapshot')) });
    let ok = false, note = '';
    try { ok = r.status === 200 && JSON.parse(r.bodyText)?.ok === true; } catch { ok = false; }
    record({ n: 1, name: 'same-origin-snapshot-200', expected: 200, actual: r.status, verdict: ok ? 'PASS' : 'FAIL', request: { method: 'POST', path: ROUTE, origin: sameOrigin().origin }, response: r, note });
  }

  // 2–5) 同源闸门
  const gates = [
    { n: 2, name: 'no-origin-403', headers: { 'content-type': 'application/json' } },
    { n: 3, name: 'foreign-origin-403', headers: { origin: 'http://evil.example', 'content-type': 'application/json' } },
    { n: 4, name: 'cross-site-403', headers: { ...sameOrigin(), 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' } },
    { n: 5, name: 'wrong-port-origin-403', headers: { origin: `http://${HOST}:9999`, 'content-type': 'application/json' } },
  ];
  for (const g of gates) {
    const r = await request({ method: 'POST', path: ROUTE, headers: g.headers, body: postBody('explorer.daemon', { action: 'ensure' }) });
    // 注意：这四步的 body 是 ensure（幂等、不改变本槽位状态），确保"万一闸门失守"也不会造成破坏；
    // 真正的破坏性负向探针放在 step 14（stop），并用 pid 比较来判定。
    record({
      n: g.n, name: g.name, expected: 403, actual: r.status,
      verdict: r.status === 403 ? 'PASS' : 'FAIL',
      request: { method: 'POST', path: ROUTE, headers: g.headers, body: postBody('explorer.daemon', { action: 'ensure' }) },
      response: r,
    });
  }

  // 6) 未知方法
  {
    const body = postBody('explorer.nope');
    const r = await request({ method: 'POST', ...J(body) });
    let hasMethods = false;
    try { hasMethods = Array.isArray(JSON.parse(r.bodyText)?.methods); } catch {}
    record({ n: 6, name: 'unknown-method-400', expected: '400 + methods[]', actual: r.status, verdict: r.status === 400 && hasMethods ? 'PASS' : 'FAIL', request: { method: 'POST', path: ROUTE, body }, response: r });
  }
  // 7) 坏 JSON
  {
    const r = await request({ method: 'POST', path: ROUTE, headers: { ...sameOrigin(), 'content-type': 'application/json' }, body: '{"method":' });
    record({ n: 7, name: 'malformed-json-400', expected: 400, actual: r.status, verdict: r.status === 400 ? 'PASS' : 'FAIL', request: { method: 'POST', path: ROUTE, body: '{"method":' }, response: r });
  }
  // 8) 空方法
  {
    const r = await request({ method: 'POST', ...J({ args: {} }) });
    record({ n: 8, name: 'empty-method-400', expected: 400, actual: r.status, verdict: r.status === 400 ? 'PASS' : 'FAIL', request: { method: 'POST', path: ROUTE, body: { args: {} } }, response: r });
  }
  // 9) PUT
  {
    const r = await request({ method: 'PUT', ...J(postBody('explorer.snapshot')) });
    record({ n: 9, name: 'put-405', expected: 405, actual: r.status, verdict: r.status === 405 ? 'PASS' : 'FAIL', request: { method: 'PUT', path: ROUTE }, response: r });
  }
  // 10) content-type 非 JSON
  {
    const r = await request({ method: 'POST', path: ROUTE, headers: { ...sameOrigin(), 'content-type': 'text/plain' }, body: JSON.stringify(postBody('explorer.snapshot')) });
    record({ n: 10, name: 'non-json-ctype-415(实测)', expected: '415（实现较设计稿更严）', actual: r.status, verdict: r.status === 415 ? 'PASS' : 'FAIL', request: { method: 'POST', path: ROUTE, 'content-type': 'text/plain' }, response: r });
  }
  // 11) GET 方法清单
  {
    const r = await request({ method: 'GET', path: ROUTE, headers: sameOrigin() });
    let hasMethods = false;
    try { hasMethods = Array.isArray(JSON.parse(r.bodyText)?.methods); } catch {}
    record({ n: 11, name: 'get-methods-200', expected: '200 + methods[]', actual: r.status, verdict: r.status === 200 && hasMethods ? 'PASS' : 'FAIL', request: { method: 'GET', path: ROUTE }, response: r });
  }
  // 12) 尾斜杠（预期落 SPA fallback）—— 期望值本身是"实测记录"，判定用 UNKNOWN 语义
  {
    const r = await request({ method: 'POST', ...J(postBody('explorer.snapshot')), path: `${ROUTE}/` });
    const isJson = (() => { try { JSON.parse(r.bodyText); return true; } catch { return false; } })();
    record({
      n: 12, name: 'trailing-slash(实测)', expected: '404 或 200-非JSON（SPA fallback）', actual: `${r.status} json=${isJson}`,
      verdict: r.status === 403 || isJson ? 'FAIL' : 'PASS', // 403 也不行（说明没走到 fallback 的语义另有问题）、返回 JSON 则更奇怪
      request: { method: 'POST', path: `${ROUTE}/` }, response: { ...r, bodyText: r.bodyText.slice(0, 400) },
      note: 'F11：若为 200-HTML，则"接口看似通了"是最易误判形态；client 侧 readBody 会给出 protocol 错误（client.api.js:96-103）',
    });
  }
  // 13) HTTP/1.0 无 Host
  {
    const r = await rawNoHost({ body: postBody('explorer.snapshot') });
    record({
      n: 13, name: 'http10-no-host(实测)', expected: '403（我们的闸门）或 400（http 层）', actual: r.status === null ? `无状态行：${r.error ?? 'closed'}` : r.status,
      verdict: r.status === 403 ? 'PASS' : 'UNKNOWN',
      request: { method: 'POST (HTTP/1.0, 无 Host)', path: ROUTE }, response: { ...r, bodyText: String(r.bodyText).slice(0, 300) },
      note: 'HTTP/1.1 必需 Host ⇒ 该边界的真实意义有限；重点是我们不会因缺 Host 而放行',
    });
  }

  // 14) ★ 副作用负向探针：异源 + stop ⇒ 必须 403 且 pid 不变
  {
    const body = postBody('explorer.daemon', { action: 'stop', slot: SLOT });
    const r = await request({ method: 'POST', path: ROUTE, headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body });
    const after = await readDaemon();
    const pidAfter = after.ok ? after.daemon?.pid ?? null : null;
    const unchanged = pidAfter === pidBefore;
    record({
      n: 14, name: 'negative-sideeffect-stop-must-not-run', expected: `403 且 pid 仍为 ${pidBefore}`, actual: `${r.status} pid=${pidAfter}`,
      verdict: unchanged ? (r.status === 403 ? 'PASS' : 'FAIL') : 'INVARIANT-BROKEN',
      request: { method: 'POST', path: ROUTE, headers: { origin: 'http://evil.example' }, body },
      response: r, pidBefore, pidAfter,
      note: '这是"403 时不得执行任何方法"的唯一硬证明；slot 只用本插件自有槽位',
    });
    if (!unchanged) {
      log('!! 闸门失守：403 的 stop 竟然生效了 —— 立即复原（ensure）');
      const fix = await request({ method: 'POST', ...J(postBody('explorer.daemon', { action: 'ensure' })) });
      writeFileSync(`${DIR}out-B-14-emergency-restore.json`, JSON.stringify(fix, null, 2), 'utf8');
      log('RESTORED: ' + (fix.status === 200 ? 'attempted(ensure 200)' : `NO (HTTP ${fix.status})`));
      finish(2);
      return;
    }
  }

  // 15) 凭据泄漏扫描
  {
    const scan = JSON.stringify(steps).toLowerCase();
    const needles = ['token', 'authorization', 'bearer', 'secret', 'credential', 'apikey', 'api_key', 'password'];
    const hits = needles.filter((n) => scan.includes(n));
    record({
      n: 15, name: 'credential-leak-scan', expected: '响应体不含 token/凭据字段', actual: hits.length ? `命中 ${hits.join(',')}` : '无命中',
      verdict: hits.length ? 'FAIL' : 'PASS', request: { note: '对前 14 步的原始响应做关键字扫描' }, response: { hits },
      note: '关键字扫描是粗筛；精筛需按 daemon-client 的 token 形状（非明文比对）复核 ⇒ 未复核项',
    });
  }

  finish(steps.some((s) => s.verdict === 'FAIL' || s.verdict === 'INVARIANT-BROKEN') ? 1 : 0);
}

function finish(code) {
  const fails = steps.filter((s) => s.verdict !== 'PASS');
  writeFileSync(`${DIR}out-B-api-gate.json`, JSON.stringify({ at: new Date().toISOString(), port: PORT, slot: SLOT, exitCode: code, steps }, null, 2), 'utf8');
  log('');
  log(`汇总：${steps.filter((s) => s.verdict === 'PASS').length}/${steps.length} PASS；非 PASS：${fails.map((s) => `${s.n}:${s.verdict}`).join(', ') || '(none)'}`);
  log('复原：本实验对守护的唯一可能影响已被 step14 断言为"未发生"；若 step14 = INVARIANT-BROKEN 则已尝试 ensure 复原。');
  console.log(`INJ-B 完成：exit ${code}；产物 out-B-*.json / out-B-api-gate.txt`);
  process.exit(code);
}

main().catch((e) => {
  // 任何未预期异常都要落档，不许静默
  try {
    appendFileSync(`${DIR}out-B-api-gate.txt`, `\nFATAL: ${e?.stack ?? e}\n`, 'utf8');
    appendFileSync(`${DIR}out-B-api-gate.err`, `${e?.stack ?? e}\n`, 'utf8');
  } catch {}
  console.error('FATAL', e);
  process.exit(1);
});
