/**
 * native-search 单元：非 Windows 一律回落（nativeGrep/nativeGlob 返回 null → 调用方走 WSL 搜索）。
 * 真正的原生执行需要 Windows + 打包 rg.exe，由 `_work/smoke-search.ts` 在 Windows 上验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowsRg, nativeGrep, nativeGlob } from '../src/native-search.ts';

test('native-search：非 Windows ⇒ 无 rg、grep/glob 返回 null（回落 WSL）', async () => {
  if (process.platform === 'win32') return; // Windows 上另由冒烟覆盖
  assert.equal(resolveWindowsRg(), null);
  assert.equal(await nativeGrep({ pattern: 'x', rootLinux: '/mnt/d/a' }), null);
  assert.equal(await nativeGlob({ pattern: '*.ts', rootLinux: '/mnt/d/a' }), null);
});
