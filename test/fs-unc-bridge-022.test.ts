/**
 * UNC 桥对 DSH 0.2.2 新 fs 方法（patchText / deleteFile / moveFile）的离线回归。
 *
 * 目标：普通 UNC 会话里 `apply_patch` 的 update/delete/move 也必须走 WSL 原生 fs，
 * 否则 0.2.2 的 `GetFileSecurityW EIO` 问题会从 write/edit 扩散到新 op。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachUncWriteBridge } from '../src/fs-unc-bridge.ts';

const DISTRO = 'debian-u8-1';
const UNC_SRC = '\\\\wsl.localhost\\debian-u8-1\\home\\g\\src.txt';
const UNC_DST = '\\\\wsl.localhost\\debian-u8-1\\home\\g\\dst.txt';
const LINUX_SRC = '/home/g/src.txt';
const LINUX_DST = '/home/g/dst.txt';
const HOST_V = '0:11:3:100:100';
const WSL_V = '2096:11:3:100:100';

/** 一个最小的 fs provider：只实现桥需要的 stat + 4 个写方法，并记录调用。 */
function fakeFs(versions: Record<string, string>, label: string) {
  const calls: any[] = [];
  return {
    calls,
    stat: async (target: any) => {
      const v = versions[String(target?.targetKey)];
      return v ? { version: v } : undefined;
    },
    writeText: async (...args: any[]) => {
      calls.push(['write', ...args]);
      return { operation: 'update', version: `${label}-new`, before: null, after: 'x' };
    },
    editText: async (...args: any[]) => {
      calls.push(['edit', ...args]);
      return { version: `${label}-new`, before: 'old', after: 'new' };
    },
    patchText: async (...args: any[]) => {
      calls.push(['patch', ...args]);
      return { version: `${label}-new`, before: 'a\n', after: 'b\n' };
    },
    deleteFile: async (...args: any[]) => {
      calls.push(['delete', ...args]);
      return { before: 'gone\n' };
    },
    moveFile: async (...args: any[]) => {
      calls.push(['move', ...args]);
      return {
        sourceBefore: 'a\n',
        destination: { operation: 'create', version: `${label}-new`, before: null, after: 'b\n' },
        sourceDeleted: true,
      };
    },
  };
}

const policy = { mode: 'danger-full-access' };

test('patchText：UNC 走 WSL，expected 版本从宿主 token 翻译成 WSL token', async () => {
  const host = fakeFs({ [UNC_SRC]: HOST_V }, 'host');
  const wsl = fakeFs({ [LINUX_SRC]: WSL_V }, 'wsl');
  attachUncWriteBridge(host, { distro: DISTRO, wslFs: wsl });
  const hunks = [{ lineNumber: 1, oldLines: ['a'], newLines: ['b'] }];
  const out = await host.patchText({ targetKey: UNC_SRC, displayPath: UNC_SRC }, hunks, { kind: 'replaceIfVersion', version: HOST_V }, undefined, policy);
  assert.equal(out.version, HOST_V, '返回给宿主的是宿主 9P 版本');
  assert.equal(wsl.calls.length, 1);
  assert.deepEqual(wsl.calls[0][1], { targetKey: LINUX_SRC, displayPath: UNC_SRC });
  assert.deepEqual(wsl.calls[0][2], hunks);
  assert.deepEqual(wsl.calls[0][3], { kind: 'replaceIfVersion', version: WSL_V });
  assert.equal(host.calls.length, 0, '仍不该调宿主 patchText');
});

test('deleteFile：UNC 走 WSL，返回删除前基线', async () => {
  const host = fakeFs({ [UNC_SRC]: HOST_V }, 'host');
  const wsl = fakeFs({ [LINUX_SRC]: WSL_V }, 'wsl');
  attachUncWriteBridge(host, { distro: DISTRO, wslFs: wsl });
  const out = await host.deleteFile({ targetKey: UNC_SRC, displayPath: UNC_SRC }, { kind: 'replaceIfVersion', version: HOST_V }, undefined, policy);
  assert.deepEqual(out, { before: 'gone\n' });
  assert.equal(wsl.calls.length, 1);
  assert.deepEqual(wsl.calls[0][1], { targetKey: LINUX_SRC, displayPath: UNC_SRC });
  assert.deepEqual(wsl.calls[0][2], { kind: 'replaceIfVersion', version: WSL_V });
});

test('moveFile：两个 UNC 目标都走 WSL，源/目标 expected 各自翻译', async () => {
  const host = fakeFs({ [UNC_SRC]: HOST_V, [UNC_DST]: HOST_V }, 'host');
  const wsl = fakeFs({ [LINUX_SRC]: WSL_V, [LINUX_DST]: WSL_V }, 'wsl');
  attachUncWriteBridge(host, { distro: DISTRO, wslFs: wsl });
  const out = await host.moveFile(
    { targetKey: UNC_SRC, displayPath: UNC_SRC },
    { targetKey: UNC_DST, displayPath: UNC_DST },
    { expectedSource: { version: HOST_V }, expectedDestination: { kind: 'replaceIfVersion', version: HOST_V } },
    undefined,
    policy,
  );
  assert.equal(out.destination.version, HOST_V, '目标版本回取宿主 stat');
  assert.equal(out.sourceDeleted, true);
  assert.equal(wsl.calls.length, 1);
  assert.deepEqual(wsl.calls[0][1], { targetKey: LINUX_SRC, displayPath: UNC_SRC });
  assert.deepEqual(wsl.calls[0][2], { targetKey: LINUX_DST, displayPath: UNC_DST });
  assert.deepEqual(wsl.calls[0][3].expectedSource, { kind: 'replaceIfVersion', version: WSL_V });
  assert.deepEqual(wsl.calls[0][3].expectedDestination, { kind: 'replaceIfVersion', version: WSL_V });
});

test('非桥路径：patchText 完全走宿主原方法，不碰 WSL', async () => {
  const host = fakeFs({ [`D:\\proj\\x.txt`]: HOST_V }, 'host');
  const wsl = fakeFs({}, 'wsl');
  attachUncWriteBridge(host, { distro: DISTRO, wslFs: wsl });
  await host.patchText({ targetKey: 'D:\\proj\\x.txt', displayPath: 'D:\\proj\\x.txt' }, [], undefined, undefined, policy);
  assert.equal(host.calls.length, 1);
  assert.equal(wsl.calls.length, 0);
});
