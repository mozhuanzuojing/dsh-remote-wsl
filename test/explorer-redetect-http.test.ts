/**
 * `explorer.redetect` 的**传输层全链路**（2026-11-23）：
 * 不只测 handler，而是把 `createExplorerHttpAdapter` 与 handler 表装到一起，用假 req/res 走
 * 「POST /remote-wsl/api」这一真实入口，锁住：
 *   · 方法进 EXPLORER_METHODS ⇒ HTTP 白名单放行（不再 400 未知方法）；
 *   · 同源门/JSON 体解析/200 包裹 `{ok:true,result}` 正常；
 *   · `result` 形状对（ok/target），面板据此决定是否重载。
 *
 * 纯离线：显式配置（distro+wslHome 写死）⇒ redetect 不探测（auto:false），不起 wsl.exe。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.ts';
import { createExplorerHandlers, createExplorerHttpAdapter } from '../src/explorer.ts';

const explicitCfg = () => normalizeConfig({ distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u' });

/** 造一个能通过同源门（无 Origin/Sec-Fetch-Site、有 Host）且可异步迭代的 POST req。 */
function makeReq(bodyObj) {
  const buf = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  return {
    method: 'POST',
    headers: { host: '127.0.0.1:49252', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield buf;
    },
  };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) {
      res.headers[k] = v;
    },
    end(s) {
      res.body = s;
    },
  };
  return res;
}

/** 把 handlers 装进 adapter，返回可直接调用的 `handler(req,res)`。 */
function mount(handlers) {
  let handler = null;
  const webServer = {
    register(cfg) {
      handler = cfg.handler;
      return () => {};
    },
  };
  createExplorerHttpAdapter(webServer, handlers);
  assert.equal(typeof handler, 'function', 'adapter 未注册 handler');
  return handler;
}

test('HTTP 全链路：POST explorer.redetect ⇒ 200 + result.ok + target', async () => {
  const { handlers } = createExplorerHandlers({ config: explicitCfg() });
  const handler = mount(handlers);
  const res = makeRes();
  await handler(makeReq({ method: 'explorer.redetect', args: {} }), res);
  assert.equal(res.statusCode, 200, `期望 200，实际 ${res.statusCode}：${res.body}`);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, true);
  assert.equal(json.result.ok, true);
  assert.equal(json.result.auto, false);
  assert.equal(json.result.target.distro, 'TestDistro');
  assert.equal(json.result.target.wslHome, '/home/u');
});

test('HTTP 方法清单（GET）包含 explorer.redetect', async () => {
  const { handlers } = createExplorerHandlers({ config: explicitCfg() });
  const handler = mount(handlers);
  const res = makeRes();
  await handler({ method: 'GET', headers: { host: '127.0.0.1:49252' } }, res);
  assert.equal(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.ok(Array.isArray(json.methods));
  assert.ok(json.methods.includes('explorer.redetect'), 'GET 方法清单缺 explorer.redetect');
});

test('HTTP 全链路：未知方法仍按原契约 400（白名单不被放宽）', async () => {
  const { handlers } = createExplorerHandlers({ config: explicitCfg() });
  const handler = mount(handlers);
  const res = makeRes();
  await handler(makeReq({ method: 'explorer.__nope__', args: {} }), res);
  assert.equal(res.statusCode, 400);
  const json = JSON.parse(res.body);
  assert.equal(json.ok, false);
  assert.equal(json.code, 'E_UNKNOWN_METHOD');
});
