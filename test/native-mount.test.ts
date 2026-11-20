/**
 * native-mount 单元：`/mnt` ↔ 盘符映射、Windows 段级安全、平台/挂载门。
 *
 * 真实原生读写需要真实 `D:\` 盘，不在单测覆盖（由 Windows 冒烟脚本与集成测试负责）。
 * 这里钉住"纯逻辑 + 安全边界"，尤其：非 Windows 恒不启用、危险段一律拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windowsDriveForMount,
  safeRestSegments,
  toWindowsPath,
  isNativeMountPath,
  _setMountProbe,
  _resetMountCache,
} from '../src/native-mount.ts';

test('windowsDriveForMount：只认 /mnt/<单字母>，/mnt、/mnt/wsl(g)、多字母首段都拒绝', () => {
  assert.deepEqual(windowsDriveForMount('/mnt/d'), { letter: 'D', rest: '' });
  assert.deepEqual(windowsDriveForMount('/mnt/d/a/b'), { letter: 'D', rest: 'a/b' });
  assert.deepEqual(windowsDriveForMount('/mnt/C/x'), { letter: 'C', rest: 'x' });
  for (const p of ['/mnt', '/mnt/wsl', '/mnt/wslg', '/mnt/data', '/home/g', 'D:\\x', '']) {
    assert.equal(windowsDriveForMount(p), null, `应为 null: ${p}`);
  }
});

test('safeRestSegments：拒穿越/反斜杠/冒号/保留设备名/尾点尾空格/空段', () => {
  assert.deepEqual(safeRestSegments(''), []);
  assert.deepEqual(safeRestSegments('a/b/c'), ['a', 'b', 'c']);
  assert.deepEqual(safeRestSegments('.hidden'), ['.hidden']); // 前导点不是尾点，允许
  for (const bad of ['..', 'a/../b', '.', 'a/./b', 'a//b', '/a', 'a\\b', 'a:b', 'CON', 'nul', 'COM1', 'LPT9', 'foo.', 'foo ', 'a\u0000b']) {
    assert.equal(safeRestSegments(bad), null, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

test('toWindowsPath：安全才映射，否则 null', () => {
  assert.equal(toWindowsPath('/mnt/d'), 'D:\\');
  assert.equal(toWindowsPath('/mnt/d/a/b'), 'D:\\a\\b');
  for (const bad of ['/mnt/d/a/../x', '/mnt/d/NUL', '/mnt/d/evil.exe.', '/home/g', '/mnt/wsl/x']) {
    assert.equal(toWindowsPath(bad), null, `应为 null: ${bad}`);
  }
});

test('isNativeMountPath：非 Windows 恒 false（安全边界，与改动前一致）', async () => {
  if (process.platform !== 'win32') {
    _setMountProbe(async () => true); // 即便探测说 true，非 Windows 也必须 false
    assert.equal(await isNativeMountPath('/mnt/d/x', 'd'), false);
    return;
  }
});

test('isNativeMountPath（Windows）：受挂载探测门控 + 缓存，且不安全段直接 false', async () => {
  if (process.platform !== 'win32') return;
  _setMountProbe(async (letter) => String(letter).toUpperCase() === 'D');
  assert.equal(await isNativeMountPath('/mnt/d/x', 'debian'), true);
  assert.equal(await isNativeMountPath('/mnt/c/x', 'debian'), false, 'C 未被探测为真');
  assert.equal(await isNativeMountPath('/home/g', 'debian'), false, '非 /mnt');
  assert.equal(await isNativeMountPath('/mnt/d/../x', 'debian'), false, '危险段直接 false');
  _resetMountCache();
});
