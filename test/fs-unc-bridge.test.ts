/**
 * UNC 写桥的离线回归（2026-10-29 用户截图：standard preset 在 \\wsl.localhost 上 edit 报
 * `GetFileSecurityW EIO (Win32 1)`）。
 *
 * 这里不启动 WSL / 守护：用假 fs 服务与假 WSL fs 钉住：
 *  · 只有本发行版的 UNC 被桥接，普通路径完全走原方法；
 *  · 写前用宿主 stat 校验 createIfAbsent / replaceIfVersion；
 *  · WSL 侧收到的 targetKey 是 Linux 路径；
 *  · 返回给 observation-policy 的 version 是宿主 stat 的版本（跨 9P/ext4 不混用令牌）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachUncWriteBridge } from '../src/fs-unc-bridge.ts';

const UNC = '\\\\wsl.localhost\\debian-u8-1\\home\\g\\proj\\a.txt';
const LINUX = '/home/g/proj/a.txt';

function hostFs(version = '0:11:3:100:100') {
  const calls: any[] = [];
  return {
    calls,
    stat: async (target: any) => (target?.targetKey === UNC ? { version } : undefined),
    writeText: async (...args: any[]) => {
      calls.push(['write', ...args]);
      return { operation: 'update', version: 'host-old', before: null, after: 'x' };
    },
    editText: async (...args: any[]) => {
      calls.push(['edit', ...args]);
      return { version: 'host-old', before: 'old', after: 'new' };
    },
  };
}

function wslFs() {
  const calls: any[] = [];
  return {
    calls,
    stat: async (target: any) => (target?.targetKey === LINUX ? { version: '2096:11:3:100:100' } : undefined),
    writeText: async (...args: any[]) => {
      calls.push(['write', ...args]);
      return { operation: 'update', version: 'wsl-version', before: null, after: 'x' };
    },
    editText: async (...args: any[]) => {
      calls.push(['edit', ...args]);
      return { version: 'wsl-version', before: 'old', after: 'new' };
    },
  };
}

test('UNC 写桥：普通路径完全走原方法，不碰 WSL', async () => {
  const fs = hostFs();
  const wsl = wslFs();
  attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  const target = { targetKey: 'D:\\proj\\a.txt', displayPath: 'D:\\proj\\a.txt' };
  const out = await fs.writeText(target, 'x', { kind: 'createIfAbsent' }, undefined, undefined);
  assert.equal(out.operation, 'update');
  assert.equal(fs.calls.length, 1);
  assert.equal(wsl.calls.length, 0);
});

test('UNC 写桥：UNC 写/编辑走 WSL，targetKey 映射为 Linux 路径，版本回取宿主 stat', async () => {
  const fs = hostFs('0:11:3:100:100');
  const wsl = wslFs();
  attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  const target = { targetKey: UNC, displayPath: UNC };
  const out = await fs.writeText(target, 'hello', { kind: 'replaceIfVersion', version: '0:11:3:100:100' }, undefined, { mode: 'danger-full-access' });
  assert.equal(out.version, '0:11:3:100:100');
  assert.equal(wsl.calls.length, 1);
  assert.deepEqual(wsl.calls[0][1], { targetKey: LINUX, displayPath: UNC });
  assert.equal(wsl.calls[0][2], 'hello');
  assert.deepEqual(wsl.calls[0][3], { kind: 'replaceIfVersion', version: '2096:11:3:100:100' });

  const edited = await fs.editText(target, { oldString: 'a', newString: 'b' }, { version: '0:11:3:100:100' }, undefined, undefined);
  assert.equal(edited.version, '0:11:3:100:100');
  assert.equal(edited.before, 'old');
  assert.equal(wsl.calls.length, 2);
});

test('UNC 写桥：版本不符走宿主 stat 的 FS_STALE_VERSION，且不调用 WSL', async () => {
  const fs = hostFs('0:11:3:100:101');
  const wsl = wslFs();
  attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  const target = { targetKey: UNC, displayPath: UNC };
  await assert.rejects(
    () => fs.writeText(target, 'x', { kind: 'replaceIfVersion', version: '0:11:3:100:100' }, undefined, undefined),
    (error: any) => error.code === 'FS_STALE_VERSION',
  );
  assert.equal(wsl.calls.length, 0);
});

test('UNC 写桥：createIfAbsent 已存在 ⇒ FS_NOT_OBSERVED；WSL 不执行', async () => {
  const fs = hostFs();
  const wsl = wslFs();
  attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  const target = { targetKey: UNC, displayPath: UNC };
  await assert.rejects(
    () => fs.writeText(target, 'x', { kind: 'createIfAbsent' }, undefined, undefined),
    (error: any) => error.code === 'FS_NOT_OBSERVED',
  );
  assert.equal(wsl.calls.length, 0);
});

test('UNC 写桥：cleanup 恢复原方法且可重复挂载不叠加', async () => {
  const fs = hostFs();
  const wsl = wslFs();
  const first = attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  const second = attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  assert.equal(first, second);
  first();
  assert.equal(typeof fs.writeText, 'function');
  // 恢复后普通路径仍走原方法（本用例只钉住 cleanup 可执行且不抛）。
  await fs.writeText({ targetKey: 'D:\\a.txt' }, 'x', undefined, undefined, undefined);
});

/** /mnt 路径的宿主 fs 每次访问都抛 EPERM（Windows 9P 访问 DrvFs 的真实行为）。 */
function mntHostFs() {
  const mntTarget = '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt';
  const eperm = (syscall: string) => {
    const error: any = new Error(`EPERM: operation not permitted, ${syscall} '${mntTarget}'`);
    error.code = 'EPERM';
    return error;
  };
  return {
    stat: async (target: any) => {
      if (target?.targetKey === mntTarget) throw eperm('realpath');
      return undefined;
    },
    readText: async (target: any) => {
      if (target?.targetKey === mntTarget) throw eperm('open');
      return 'host-read';
    },
    streamText: async () => { throw eperm('open'); },
    readBytes: async () => { throw eperm('open'); },
    readByteRange: async () => { throw eperm('open'); },
    listDir: async () => { throw eperm('readdir'); },
    lstat: async (input: any) => {
      if (String(input).includes('\\mnt\\') || String(input) === 'sac-fe/src/axios.js') throw eperm('lstat');
      return undefined;
    },
    resolve: async (input: any) => {
      if (String(input).includes('\\mnt\\') || String(input) === 'sac-fe/src/axios.js') throw eperm('realpath');
      return { targetKey: String(input), displayPath: String(input) };
    },
    writeText: async () => { throw new Error('host write must not be called'); },
    editText: async () => { throw new Error('host edit must not be called'); },
  };
}

test('UNC 读桥：/mnt 的 resolve/readText/stat 走 WSL，EPERM fallback 生效', async () => {
  const wsl = {
    resolve: async (input: any) => ({ targetKey: '/mnt/d/x.txt', displayPath: '/mnt/d/x.txt' }),
    stat: async () => ({ version: '2096:7:9:100:100' }),
    lstat: async () => ({ version: '2096:7:9:100:100', type: 'file', size: 9 }),
    readText: async () => 'from-wsl',
    writeText: async () => ({ operation: 'update', version: 'wsl' }),
    editText: async () => ({ version: 'wsl', before: '', after: '' }),
  };
  const fs = mntHostFs();
  attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });

  const target = await fs.resolve('\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt', {
    cwd: '\\\\wsl.localhost\\debian-u8-1\\home\\g',
  });
  assert.equal(target.targetKey, '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt');
  assert.equal((await fs.stat(target)).version, '2096:7:9:100:100');
  assert.equal(await fs.readText(target), 'from-wsl');

  // 相对路径 + UNC cwd 的 symlink → /mnt：宿主 resolve/lstat 报 EPERM，必须走 WSL fallback。
  const fallbackCwd = '\\\\wsl.localhost\\debian-u8-1\\home\\g';
  const fallbackTarget = await fs.resolve('sac-fe/src/axios.js', { cwd: fallbackCwd });
  assert.equal(fallbackTarget.targetKey, '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt');
  assert.equal((await fs.lstat('sac-fe/src/axios.js', { cwd: fallbackCwd })).version, '2096:7:9:100:100');
});

test('UNC 读桥：/mnt 的 lstat/streamText/readBytes/readByteRange/listDir 都走 WSL', async () => {
  const wsl = {
    resolve: async (input: any) => ({ targetKey: '/mnt/d/x.txt', displayPath: '/mnt/d/x.txt' }),
    stat: async () => ({ version: '2096:7:9:100:100' }),
    lstat: async () => ({ version: '2096:7:9:100:100', type: 'file', size: 9 }),
    readText: async () => 'from-wsl',
    streamText: async () => ['a', 'b'],
    readBytes: async () => Buffer.from('raw'),
    readByteRange: async () => Buffer.from('ra'),
    listDir: async () => [{ name: 'x.txt', type: 'file', target: { targetKey: '/mnt/d/x.txt', displayPath: '/mnt/d/x.txt' }, version: 'v', size: 9 }],
    writeText: async () => ({ operation: 'update', version: 'wsl' }),
    editText: async () => ({ version: 'wsl', before: '', after: '' }),
  };
  const fs = mntHostFs();
  attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  const target = { targetKey: '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt', displayPath: '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt' };

  assert.equal((await fs.lstat('\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt', {})).version, '2096:7:9:100:100');
  assert.deepEqual(await fs.streamText(target), ['a', 'b']);
  assert.equal((await fs.readBytes(target)).toString(), 'raw');
  assert.equal((await fs.readByteRange(target, { offset: 0, length: 2 })).toString(), 'ra');
  const listed = await fs.listDir(target);
  assert.equal(listed[0].target.targetKey, '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt');
});

test('UNC 写桥：/mnt 的 write/edit 用 WSL 版本做 CAS，且回取 WSL 版本', async () => {
  const wsl = {
    stat: async () => ({ version: '2096:7:9:100:100' }),
    writeText: async (_target: any, _content: any, expected: any) => ({ operation: 'update', version: expected?.version ?? 'wsl' }),
    editText: async (_target: any, _edit: any, expected: any) => ({ version: expected?.version ?? 'wsl', before: 'a', after: 'b' }),
  };
  const fs = mntHostFs();
  attachUncWriteBridge(fs, { distro: 'debian-u8-1', wslFs: wsl });
  const target = { targetKey: '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt', displayPath: '\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\x.txt' };
  const writeOut = await fs.writeText(target, 'x', { kind: 'replaceIfVersion', version: '2096:7:9:100:100' }, undefined, { mode: 'danger-full-access' });
  assert.equal(writeOut.version, '2096:7:9:100:100');
  const editOut = await fs.editText(target, { oldString: 'a', newString: 'b' }, { version: '2096:7:9:100:100' }, undefined, { mode: 'danger-full-access' });
  assert.equal(editOut.version, '2096:7:9:100:100');
});
