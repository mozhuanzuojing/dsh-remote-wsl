/**
 * 守护侧 `{op:'fs', method:'batch'}`（协议 v5）的语义测试。
 *
 * 关键约束：**逐条独立成败** —— 一条 ENOENT 不能把同批其它调用一起带走（旧行为里调用方得整批重发，
 * 而有副作用的调用因此会重放）。另外锁住边界：空批 / 超上限 / 嵌套 batch 都必须明确失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FS_BATCH_LIMIT, handleFsOp } from '../src/fs-rpc.ts';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-rw-batch-'));
}

test('batch：存在的读成功、缺失的只失败自己、stat 照常返回', async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, 'b.txt'), 'world');
    const r = await handleFsOp({
      method: 'batch',
      args: {
        calls: [
          { method: 'readText', args: { path: join(dir, 'a.txt') } },
          { method: 'readText', args: { path: join(dir, 'missing.txt') } },
          { method: 'stat', args: { path: join(dir, 'b.txt') } },
        ],
      },
    });
    assert.equal(r.results.length, 3);
    assert.equal(r.results[0].ok, true);
    assert.equal(r.results[1].ok, false);
    assert.equal(r.results[1].code, 'FS_NOT_FOUND');
    assert.equal(r.results[2].ok, true);
    assert.equal(r.results[2].result.type, 'file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batch：空批 / 嵌套 batch / 超上限都明确失败（不静默当成空结果）', async () => {
  await assert.rejects(
    () => handleFsOp({ method: 'batch', args: { calls: [] } }),
    (e) => e.code === 'FS_BATCH_INVALID',
  );
  await assert.rejects(
    () => handleFsOp({ method: 'batch', args: { calls: [{ method: 'batch', args: { calls: [] } }] } }),
    (e) => e.code === 'FS_BATCH_INVALID' && /cannot nest/.test(String(e.message)),
  );
  await assert.rejects(
    () => handleFsOp({ method: 'batch', args: { calls: Array.from({ length: FS_BATCH_LIMIT + 1 }, () => ({ method: 'stat', args: {} })) } }),
    (e) => e.code === 'FS_BATCH_INVALID' && /too large/.test(String(e.message)),
  );
});
