/**
 * daemon-conn（协议 v5 宿主侧长连接）的回归测试。
 *
 * 背景（2026-11-24 真机根因）：旧实现**每 op 一条 TCP 连接**，一次文件密集回实测 1106 次 RPC / 8.3s，
 * Windows 每个关闭的连接占本地临时端口约 120s（池 16384）⇒ 全机 `connect EADDRINUSE`。
 *
 * 本测试用一个假守护（真 TCP）锁住四件事：
 *  1. N 次调用只建 **1 条连接**；
 *  2. 回包**乱序**也必须按 `id` 配对上（不能错配给别的请求）；
 *  3. 超时 ⇒ `kind:'timeout'` 并断开重连（协议状态不可信）；
 *  4. batch 帧：新守护逐条回；旧守护（`unknown fs method`）⇒ `batchUnsupported` 且不再重试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { pooledCall, pooledCallBatch, poolStats, disposePool } from '../src/daemon-conn.ts';

/** 起一个假守护：hello 后按 handler 逐帧回包。 */
async function fakeDaemon(handler) {
  const state = { connections: 0, frames: [], sockets: new Set() };
  const server = net.createServer((sock) => {
    state.connections += 1;
    state.sockets.add(sock);
    sock.on('close', () => state.sockets.delete(sock));
    sock.setEncoding('utf8');
    let buf = '';
    let authed = false;
    const write = (obj) => {
      if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`);
    };
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        if (!authed) {
          authed = true;
          write({ ok: true, op: 'hello', port: server.address().port, protocolVersion: 5 });
          continue;
        }
        state.frames.push(req);
        handler(req, write);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    state,
    port: server.address().port,
    close: async () => {
      for (const s of state.sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test('N 次池化调用只建 1 条 TCP 连接（旧实现是 N 条）', async () => {
  const d = await fakeDaemon((req, write) => write({ ok: true, id: req.id, op: req.op, echo: req.id }));
  try {
    for (let i = 0; i < 20; i++) {
      const r = await pooledCall({}, { port: d.port, token: 'tok-a', req: { op: 'status' }, timeoutMs: 3000 });
      assert.equal(r.msg?.ok, true);
      assert.equal(r.msg?.echo, i + 1, 'id 必须单调递增并原样回来');
    }
    assert.equal(d.state.connections, 1, '20 次调用只能开 1 条连接');
    assert.ok(poolStats().reused >= 19, '复用计数应随调用增长');
  } finally {
    await d.close();
    disposePool('test');
  }
});

test('回包乱序也按 id 配对：慢的请求不能拿到别人的结果', async () => {
  const d = await fakeDaemon((req, write) => {
    // 第一条故意慢（120ms 后回），后面的立刻回 ⇒ 回包顺序与请求顺序相反。
    const reply = () => write({ ok: true, id: req.id, value: `v${req.id}` });
    if (req.id === 1) setTimeout(reply, 120);
    else reply();
  });
  try {
    const [a, b, c] = await Promise.all([
      pooledCall({}, { port: d.port, token: 'tok-b', req: { op: 'status' }, timeoutMs: 3000 }),
      pooledCall({}, { port: d.port, token: 'tok-b', req: { op: 'status' }, timeoutMs: 3000 }),
      pooledCall({}, { port: d.port, token: 'tok-b', req: { op: 'status' }, timeoutMs: 3000 }),
    ]);
    assert.equal(a.msg.value, 'v1');
    assert.equal(b.msg.value, 'v2');
    assert.equal(c.msg.value, 'v3');
    assert.equal(d.state.connections, 1);
  } finally {
    await d.close();
    disposePool('test');
  }
});

test('超时 ⇒ kind:"timeout"，并断开连接（下一次调用重新建连而不是错配回包）', async () => {
  let drop = true;
  const d = await fakeDaemon((req, write) => {
    if (drop) return; // 永不回包
    write({ ok: true, id: req.id, value: 'later' });
  });
  try {
    const r = await pooledCall({}, { port: d.port, token: 'tok-c', req: { op: 'status' }, timeoutMs: 120 });
    assert.equal(r.kind, 'timeout');
    assert.match(String(r.error), /no reply within 120ms/);
    drop = false;
    const r2 = await pooledCall({}, { port: d.port, token: 'tok-c', req: { op: 'status' }, timeoutMs: 3000 });
    assert.equal(r2.msg?.value, 'later');
    assert.equal(d.state.connections, 2, '超时后必须重连');
  } finally {
    await d.close();
    disposePool('test');
  }
});

test('守护断开 ⇒ 挂起请求得到 closed（不悬挂），随后可重连', async () => {
  let kill = false;
  const d = await fakeDaemon((req, write) => {
    if (kill) {
      // 不回包，直接断
      for (const s of d.state.sockets) s.destroy();
      return;
    }
    write({ ok: true, id: req.id });
  });
  try {
    await pooledCall({}, { port: d.port, token: 'tok-d', req: { op: 'status' }, timeoutMs: 3000 });
    kill = true;
    const r = await pooledCall({}, { port: d.port, token: 'tok-d', req: { op: 'status' }, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.ok(['closed', 'error'].includes(String(r.kind)), `断开应报 closed/error，实得 ${r.kind}`);
  } finally {
    await d.close();
    disposePool('test');
  }
});

test('batch 帧：一次请求带走多条调用，逐条成败都在 msg.result.results 里', async () => {
  const d = await fakeDaemon((req, write) => {
    if (req.op === 'fs' && req.method === 'batch') {
      write({
        ok: true,
        id: req.id,
        result: {
          results: req.args.calls.map((c, i) => (i === 1 ? { ok: false, code: 'FS_NOT_FOUND', error: 'nope' } : { ok: true, result: { method: c.method } })),
        },
      });
      return;
    }
    write({ ok: true, id: req.id });
  });
  try {
    const r = await pooledCallBatch(
      {},
      {
        port: d.port,
        token: 'tok-e',
        calls: [
          { method: 'readText', args: { path: '/a' } },
          { method: 'readText', args: { path: '/b' } },
          { method: 'stat', args: { path: '/c' } },
        ],
        timeoutMs: 3000,
      },
    );
    const results = r.msg.result.results;
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].code, 'FS_NOT_FOUND');
    assert.equal(results[2].result.method, 'stat');
    assert.equal(r.batchUnsupported, false);
    assert.equal(d.state.connections, 1);
  } finally {
    await d.close();
    disposePool('test');
  }
});

test('旧守护（协议<5）回 unknown fs method ⇒ batchUnsupported 粘住，不再发 batch', async () => {
  let batchFrames = 0;
  const d = await fakeDaemon((req, write) => {
    if (req.op === 'fs' && req.method === 'batch') {
      batchFrames += 1;
      write({ ok: false, id: req.id, error: 'unknown fs method: batch' });
      return;
    }
    write({ ok: true, id: req.id });
  });
  try {
    const first = await pooledCallBatch({}, { port: d.port, token: 'tok-f', calls: [{ method: 'stat', args: {} }], timeoutMs: 3000 });
    assert.equal(first.batchUnsupported, true, '旧守护必须被标记为不支持批量');
    const second = await pooledCallBatch({}, { port: d.port, token: 'tok-f', calls: [{ method: 'stat', args: {} }], timeoutMs: 3000 });
    assert.equal(second.kind, 'unsupported', '第二次必须直接拒绝，不再发帧');
    assert.equal(batchFrames, 1, '只应发过 1 次 batch 帧');
  } finally {
    await d.close();
    disposePool('test');
  }
});
