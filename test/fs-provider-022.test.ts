/**
 * WSL fs provider：0.2.2 新接口（patchText / deleteFile / moveFile）与 `~` 展开的离线回归。
 *
 * 用 `createWslFileSystem({...}, {fsCall})` 的测试缝，不启动 wsl.exe/守护；断言 provider 把
 * 正确的 op 参数交给 WSL 侧（路径已按 WSL home 展开、expected 版本透传、move 的源/目标都在）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.ts';
import { createWslFileSystem } from '../src/fs-provider.ts';

const CFG = { ...DEFAULTS, distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u' };

function fakeRpc(result: (method: string, args: any) => any = () => ({})) {
  const calls: Array<[string, any]> = [];
  const fsCall = async (method: string, args: any) => {
    calls.push([method, args]);
    return result(method, args);
  };
  return { calls, fs: createWslFileSystem(CFG, { fsCall }) };
}

test('resolve：开头的 ~ 展开到 WSL home（不是 Windows 用户目录）', async () => {
  const { calls, fs } = fakeRpc((method, args) => ({ realpath: args?.path ?? null }));
  const target = await fs.resolve('~/proj/a.txt');
  assert.equal(target.targetKey, '/home/u/proj/a.txt');
  assert.equal(calls[0][0], 'realpath');
  assert.equal(calls[0][1].path, '/home/u/proj/a.txt');
});

test('patchText：hunks + expected.version 透传，返回 before/after', async () => {
  const { calls, fs } = fakeRpc(() => ({ version: 'v2', before: 'a\n', after: 'b\n' }));
  const target = { targetKey: '/home/u/f.txt', displayPath: '/home/u/f.txt' };
  const hunks = [{ lineNumber: 1, oldLines: ['a'], newLines: ['b'] }];
  const out = await fs.patchText(target, hunks, { version: 'v1' }, undefined, undefined);
  assert.equal(calls[0][0], 'patchText');
  assert.equal(calls[0][1].path, '/home/u/f.txt');
  assert.deepEqual(calls[0][1].hunks, hunks);
  assert.equal(calls[0][1].expectedVersion, 'v1');
  assert.deepEqual(out, { version: 'v2', before: 'a\n', after: 'b\n' });
});

test('deleteFile：expected.version 透传，返回 before', async () => {
  const { calls, fs } = fakeRpc(() => ({ before: 'old\n' }));
  const target = { targetKey: '/home/u/g.txt', displayPath: '/home/u/g.txt' };
  const out = await fs.deleteFile(target, { version: 'v1' }, undefined, undefined);
  assert.equal(calls[0][0], 'deleteFile');
  assert.equal(calls[0][1].path, '/home/u/g.txt');
  assert.equal(calls[0][1].expectedVersion, 'v1');
  assert.deepEqual(out, { before: 'old\n' });
});

test('moveFile：源/目标/可选 hunks 与两侧 expected 都透传', async () => {
  const { calls, fs } = fakeRpc(() => ({
    sourceBefore: 'a\n',
    destination: { operation: 'create', version: 'v9', before: null, after: 'b\n' },
    sourceDeleted: true,
  }));
  const source = { targetKey: '/home/u/src.txt', displayPath: '/home/u/src.txt' };
  const destination = { targetKey: '/home/u/dst.txt', displayPath: '/home/u/dst.txt' };
  const out = await fs.moveFile(
    source,
    destination,
    {
      hunks: [{ lineNumber: 1, oldLines: ['a'], newLines: ['b'] }],
      expectedSource: { version: 'v1' },
      expectedDestination: { kind: 'createIfAbsent' },
    },
    undefined,
    undefined,
  );
  assert.equal(calls[0][0], 'moveFile');
  assert.equal(calls[0][1].sourcePath, '/home/u/src.txt');
  assert.equal(calls[0][1].destinationPath, '/home/u/dst.txt');
  assert.equal(calls[0][1].expectedSourceVersion, 'v1');
  assert.deepEqual(calls[0][1].expectedDestination, { kind: 'createIfAbsent' });
  assert.equal(calls[0][1].hunks.length, 1);
  assert.deepEqual(out, {
    sourceBefore: 'a\n',
    destination: { operation: 'create', version: 'v9', before: null, after: 'b\n' },
    sourceDeleted: true,
  });
});
