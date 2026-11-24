/**
 * fs-provider 的**批量与池化**行为（协议 v5）。
 *
 * 目的：把"N 次往返压成 1 次"这件事锁在测试里，且不许改变既有语义：
 *  · 同一 tick 的多条**元数据类**只读调用 ⇒ 一帧 batch（超过 64 条由宿主分帧）；
 *  · 批内一条失败 ⇒ 只有那条失败，其它照常返回；
 *  · 批量不可用（旧守护）/传输失败 ⇒ **逐条退回单发**，不吞错、不伪造成功；
 *  · 写操作、以及大载荷读（readText/readChunk）永不进批（前者是副作用语义，后者是一帧大小的边界）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.ts';
import { createWslRpc } from '../src/fs-provider.ts';

const CFG = { ...DEFAULTS, distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u', dshVersion: '0.2.2' };
const REC = { token: 't', slot: 8731, meta: { port: 8731 } };

function rpcWith({ pooledBatch, pooled, single }) {
  return createWslRpc(CFG, {
    ensureDaemon: async () => ({}),
    readDaemonRecord: () => REC,
    callDaemon: single ?? (async () => ({ msg: { ok: true, result: { via: 'single' } } })),
    callDaemonPooled: pooled ?? (async () => ({ msg: { ok: true, result: { via: 'pooled' } } })),
    callDaemonPooledBatch: pooledBatch ?? (async () => ({ msg: { ok: true, result: { results: [] } } })),
  });
}

test('同一 tick 的三条元数据类只读调用 ⇒ 合成一帧 batch（省下 2 次往返）', async () => {
  const frames = [];
  const rpc = rpcWith({
    pooledBatch: async (_cfg, opts) => {
      frames.push(opts.calls);
      return {
        ms: 3,
        msg: { ok: true, result: { results: opts.calls.map((c) => ({ ok: true, result: { path: c.args.path } })) } },
      };
    },
  });
  const out = await Promise.all([
    rpc.call('fs', 'stat', { path: '/a' }),
    rpc.call('fs', 'listDir', { path: '/b' }),
    rpc.call('fs', 'lstat', { path: '/c' }),
  ]);
  assert.deepEqual(out.map((o) => o.path), ['/a', '/b', '/c']);
  assert.equal(frames.length, 1, '三条并发只读调用必须只发 1 帧');
  assert.equal(frames[0].length, 3);
  assert.deepEqual(frames[0].map((c) => c.method), ['stat', 'listDir', 'lstat']);
});

test('超过一帧上限（>64）由宿主分帧，而不是让守护整帧拒绝', async () => {
  const frames = [];
  const rpc = rpcWith({
    pooledBatch: async (_cfg, opts) => {
      frames.push(opts.calls.length);
      return { ms: 1, msg: { ok: true, result: { results: opts.calls.map((c) => ({ ok: true, result: { path: c.args.path } })) } } };
    },
  });
  const out = await Promise.all(Array.from({ length: 70 }, (_, i) => rpc.call('fs', 'stat', { path: `/p${i}` })));
  assert.equal(out.length, 70);
  assert.deepEqual(frames, [64, 6], '70 条应拆成 64 + 6 两帧');
});

test('批内一条失败 ⇒ 只有那条抛错，其它照常返回（错误码按原样透传）', async () => {
  const rpc = rpcWith({
    pooledBatch: async (_cfg, opts) => ({
      ms: 2,
      msg: {
        ok: true,
        result: {
          results: opts.calls.map((c) =>
            c.args.path === '/bad' ? { ok: false, code: 'FS_NOT_FOUND', error: 'no such file' } : { ok: true, result: { path: c.args.path } },
          ),
        },
      },
    }),
  });
  const ok = await rpc.call('fs', 'stat', { path: '/good' });
  assert.equal(ok.path, '/good');
  await assert.rejects(
    () => rpc.call('fs', 'stat', { path: '/bad' }),
    (e) => e.code === 'FS_NOT_FOUND' && /no such file/.test(String(e.message)),
  );
});

test('批量不可用（旧守护 / 传输失败）⇒ 逐条退回单发，结果与错误都不丢', async () => {
  const singleCalls = [];
  const rpc = rpcWith({
    pooledBatch: async () => ({ ms: 0, ok: false, kind: 'unsupported', error: 'daemon does not support fs batch', batchUnsupported: true }),
    single: async (_cfg, opts) => {
      singleCalls.push(opts.req);
      return { msg: { ok: true, result: { path: opts.req.args.path } } };
    },
  });
  const out = await Promise.all([rpc.call('fs', 'stat', { path: '/a' }), rpc.call('fs', 'listDir', { path: '/b' })]);
  assert.deepEqual(out.map((o) => o.path), ['/a', '/b']);
  assert.equal(singleCalls.length, 2, '批量不可用时必须逐条走单发');
  assert.deepEqual(singleCalls.map((c) => c.method), ['stat', 'listDir']);
});

test('写操作与大载荷读都不进批：走池化单发', async () => {
  const poolBatches = [];
  const pooledCalls = [];
  const rpc = rpcWith({
    pooledBatch: async (_cfg, opts) => {
      poolBatches.push(opts.calls);
      return { msg: { ok: true, result: { results: opts.calls.map(() => ({ ok: true, result: {} })) } } };
    },
    pooled: async (_cfg, opts) => {
      pooledCalls.push(opts.req);
      return { msg: { ok: true, result: { via: 'pooled', method: opts.req.method } } };
    },
  });
  const out = await Promise.all([
    rpc.call('fs', 'writeText', { path: '/a', content: 'x' }),
    rpc.call('fs', 'readText', { path: '/b' }),
    rpc.call('fs', 'stat', { path: '/c' }),
  ]);
  assert.equal(out[0].method, 'writeText');
  assert.equal(out[1].method, 'readText');
  assert.equal(poolBatches.length, 1, '只有 stat 那条进批');
  assert.equal(poolBatches[0].length, 1);
  assert.deepEqual(pooledCalls.map((c) => c.method).sort(), ['readText', 'writeText']);
});
