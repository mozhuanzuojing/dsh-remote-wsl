/**
 * 守护瞬断的恢复语义（2026-11-20 真机：WSL swap 100% ⇒ 守护瞬断，读直接失败）。
 * 用 `createWslRpc` 的 `ensureDaemon/readDaemonRecord/callDaemon` 测试缝，不启动 wsl.exe/守护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.ts';
import { createWslRpc, DAEMON_DOWN_CODE } from '../src/fs-provider.ts';

const CFG = { ...DEFAULTS, distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u', dshVersion: '0.2.2' };
const REC = { token: 't', slot: 8731, meta: { port: 8731 } };

function rpcWith(callDaemon) {
  return createWslRpc(CFG, {
    ensureDaemon: async () => ({}),
    readDaemonRecord: () => REC,
    callDaemon,
  });
}

test('读操作：守护瞬断（无回包）⇒ 自动重试后成功', async () => {
  let n = 0;
  const rpc = rpcWith(async () => {
    n += 1;
    if (n < 3) return { kind: 'error', error: 'ECONNRESET' };
    return { msg: { ok: true, result: { text: 'ok' } } };
  });
  const out = await rpc.call('fs', 'readText', { path: '/home/u/a' });
  assert.equal(out.text, 'ok');
  assert.equal(n, 3, '前两次瞬断应被重试掉');
});

test('读操作：持续不可用 ⇒ FS_DAEMON_UNAVAILABLE，消息带重试次数与诊断建议', async () => {
  const rpc = rpcWith(async () => ({ kind: 'error', error: 'reset' }));
  await assert.rejects(
    () => rpc.call('fs', 'readText', { path: '/home/u/a' }),
    (e) => e.code === DAEMON_DOWN_CODE && /已重试 4 次/.test(String(e.message)) && /wsl_doctor/.test(String(e.message)),
  );
});

test('写操作：不重试（避免重复副作用）', async () => {
  let n = 0;
  const rpc = rpcWith(async () => {
    n += 1;
    return { kind: 'error', error: 'reset' };
  });
  await assert.rejects(() => rpc.call('fs', 'writeText', { path: '/home/u/a', content: 'x' }), (e) => e.code === DAEMON_DOWN_CODE);
  assert.equal(n, 1, '写操作只尝试一次');
});
