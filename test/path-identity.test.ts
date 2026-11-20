/**
 * `path-identity` 的往返无损/归一化回归（P1：纯模块，尚未接调用点）。
 * 目标：`identityFromWire(wireFromIdentity(id)) ≡ id`，以及边界拒绝规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identityFromWire,
  wireFromIdentity,
  nativeWireFromIdentity,
  normalizeLinuxPath,
  vscodeUriFromIdentity,
  isWindowsVolumeIdentity,
} from '../src/path-identity.ts';

const DISTRO = 'debian-u8-1';

test('归一化：折叠 //、消解 . 与 ..、去尾斜杠、保证前导 /', () => {
  assert.equal(normalizeLinuxPath('/a//b/./c/../d/'), '/a/b/d');
  assert.equal(normalizeLinuxPath('a/b'), '/a/b');
  assert.equal(normalizeLinuxPath('/'), '/');
  assert.equal(normalizeLinuxPath('/a/../..'), '/');
});

test('UNC → 身份：wsl.localhost 与 wsl$ 都接受，发行版不匹配则 null', () => {
  const a = identityFromWire('\\\\wsl.localhost\\debian-u8-1\\home\\g\\x.txt', DISTRO);
  assert.deepEqual(a, { distro: 'debian-u8-1', linuxPath: '/home/g/x.txt' });
  const b = identityFromWire('\\\\wsl$\\debian-u8-1\\home\\g\\x.txt', DISTRO);
  assert.deepEqual(b, { distro: 'debian-u8-1', linuxPath: '/home/g/x.txt' });
  assert.equal(identityFromWire('\\\\wsl.localhost\\other\\home\\g\\x', DISTRO), null);
});

test('POSIX 绝对路径 → 身份；盘符/相对/空 → null', () => {
  assert.deepEqual(identityFromWire('/home/g/x', DISTRO), { distro: DISTRO, linuxPath: '/home/g/x' });
  assert.equal(identityFromWire('D:\\proj\\x', DISTRO), null);
  assert.equal(identityFromWire('rel/x', DISTRO), null);
  assert.equal(identityFromWire('', DISTRO), null);
});

test('往返无损：UNC wire → identity → wire 恒等（含空格/Unicode/%/#/? 等）', () => {
  const cases = [
    '/home/g/a.txt',
    '/home/g/with space/x y.txt',
    '/home/g/中文/文件.md',
    '/home/g/a%b#c?d.txt',
    '/home/g/a&b=c+d@e.txt',
    "/home/g/a'b(c).txt",
    '/home/g/dir/sub/leaf',
  ];
  for (const linuxPath of cases) {
    const id = { distro: DISTRO, linuxPath: normalizeLinuxPath(linuxPath) };
    const wire = wireFromIdentity(id);
    const back = identityFromWire(wire, DISTRO);
    assert.deepEqual(back, id, `roundtrip failed for ${linuxPath} -> ${wire}`);
  }
});

test('wire 生成：路径含反斜杠必须抛（UNC 无法无歧义表达）', () => {
  assert.throws(() => wireFromIdentity({ distro: DISTRO, linuxPath: '/home/g/a\\b' }), /backslash/);
});

test('/mnt 身份：原生盘符映射与判定', () => {
  const id = { distro: DISTRO, linuxPath: '/mnt/d/project/x' };
  assert.equal(nativeWireFromIdentity(id), 'D:\\project\\x');
  assert.equal(isWindowsVolumeIdentity(id), true);
  assert.equal(isWindowsVolumeIdentity({ distro: DISTRO, linuxPath: '/home/g/x' }), false);
  // `/mnt/d` 本身就是盘符根 → `D:\`；`/mnt/wslg` 不是单字母盘 → 不可映射。
  assert.equal(nativeWireFromIdentity({ distro: DISTRO, linuxPath: '/mnt/d' }), 'D:\\');
  assert.equal(nativeWireFromIdentity({ distro: DISTRO, linuxPath: '/mnt/wslg' }), null);
});

test('VS Code URI：vscode-remote://wsl+<distro>/<encoded>', () => {
  const uri = vscodeUriFromIdentity({ distro: DISTRO, linuxPath: '/home/g/a b/x#1.md' });
  assert.equal(uri, 'vscode-remote://wsl+debian-u8-1/home/g/a%20b/x%231.md');
});
