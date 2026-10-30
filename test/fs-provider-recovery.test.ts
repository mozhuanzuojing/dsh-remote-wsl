/**
 * WSL fs provider 守护恢复回归（2026-10-30 会话：WSL 重启后 daemonReady 缓存仍命中，
 * 文件工具只报「守护元数据缺失」而不重新拉起）。
 *
 * 用 `createWslRpc` 的测试缝注入，不碰真实 wsl.exe / 守护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.ts';
import { createWslRpc } from '../src/fs-provider.ts';

const CFG = {
  ...DEFAULTS,
  distro: 'TestDistro',
  wslHome: '/home/u',
  cwd: '/home/u',
  dshVersion: '0.2.1-rc.3',
  daemonPort: 18731,
  daemonPortTries: 1,
  fsTimeoutMs: 5000,
};
const REC = { slot: 18731, token: 'token-test', meta: { port: 18731 } };

test('fs provider：守护元数据消失 ⇒ 清 daemonReady、重新 ensure，再执行原调用', async () => {
  let ensureCalls = 0;
  const records = [null, REC];
  const rpc = createWslRpc(CFG, {
    ensureDaemon: async () => {
      ensureCalls += 1;
      return { port: 18731, token: 'token-test' };
    },
    readDaemonRecord: () => (records.length ? records.shift() : REC),
    callDaemon: async () => ({ msg: { ok: true, result: 'ok' } }),
  });
  assert.equal(await rpc.call('fs', 'readText', ['target'], undefined), 'ok');
  assert.equal(ensureCalls, 2);
});

test('fs provider：连接被拒/提前关闭 ⇒ 重 ensure 后只重试一次', async () => {
  let ensureCalls = 0;
  let callCalls = 0;
  const rpc = createWslRpc(CFG, {
    ensureDaemon: async () => {
      ensureCalls += 1;
      return { port: 18731, token: 'token-test' };
    },
    readDaemonRecord: () => REC,
    callDaemon: async () => {
      callCalls += 1;
      if (callCalls === 1) return { ok: false, kind: 'refused', error: 'ECONNREFUSED' };
      return { msg: { ok: true, result: 'ok-after-retry' } };
    },
  });
  assert.equal(await rpc.call('fs', 'readText', ['target'], undefined), 'ok-after-retry');
  assert.equal(ensureCalls, 2);
  assert.equal(callCalls, 2);
});

test('fs provider：timeout 不重发（可能已执行，避免有副作用操作重放）', async () => {
  let ensureCalls = 0;
  const rpc = createWslRpc(CFG, {
    ensureDaemon: async () => {
      ensureCalls += 1;
      return { port: 18731, token: 'token-test' };
    },
    readDaemonRecord: () => REC,
    callDaemon: async () => ({ ok: false, kind: 'timeout', error: 'no reply within 5000ms' }),
  });
  await assert.rejects(() => rpc.call('fs', 'writeText', ['target', 'x'], undefined), /守护调用失败/);
  assert.equal(ensureCalls, 1);
});
