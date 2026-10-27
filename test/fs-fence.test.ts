/**
 * fs 围栏判定回归测试（2026-10-27 审查 F-01 的守卫，P0）。
 *
 * 关键不变量：**新建文件的叶子必然不存在**（realpath ENOENT），此时必须解析到"最近存在的祖先"，
 * 否则一个指向工作区外的目录符号链接就能把写入带出围栏。这里用假的 realpath 映射精确复现那棵树，
 * 不依赖真实文件系统权限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeepestAncestor } from '../src/fs-provider.ts';

/** 假 realpath：只认"存在"的路径，且按树返回真实位置。 */
const tree: Record<string, string> = {
  '/': '/',
  '/home': '/home',
  '/home/g': '/home/g',
  '/home/g/ws': '/home/g/ws',
  '/home/g/ws/sub': '/home/g/ws/sub',
  '/home/g/ws/current': '/srv/releases/v9', // 指向工作区外的目录符号链接
  '/home/g/ws/file.txt': '/home/g/ws/real.txt', // 文件符号链接
  '/tmp': '/tmp',
};
const realpathOf = async (p: string) => (p in tree ? tree[p] : null);
const fence = (target: string | null, root: string) =>
  target === root || (target !== null && target.startsWith(root.endsWith('/') ? root : `${root}/`));

test('新建文件：祖先存在 ⇒ 解析为祖先真实路径 + 后缀', async () => {
  assert.equal(await resolveDeepestAncestor('/home/g/ws/a/new.js', realpathOf), '/home/g/ws/a/new.js');
});

test('符号链接祖先 + 不存在叶子 ⇒ 解析到工作区之外（围栏必须拒绝）', async () => {
  const resolved = await resolveDeepestAncestor('/home/g/ws/current/app.js', realpathOf);
  assert.equal(resolved, '/srv/releases/v9/app.js');
  assert.equal(fence(resolved, '/home/g/ws'), false, '逃逸目标不得通过 workspace 前缀判定');
});

test('已存在的符号链接文件 ⇒ 解析到真实文件', async () => {
  assert.equal(await resolveDeepestAncestor('/home/g/ws/file.txt', realpathOf), '/home/g/ws/real.txt');
});

test('正常新文件通过围栏判定', async () => {
  assert.equal(fence(await resolveDeepestAncestor('/home/g/ws/a/new.js', realpathOf), '/home/g/ws'), true);
});

test('深层缺失逐级上溯；根可解析', async () => {
  assert.equal(await resolveDeepestAncestor('/home/g/ws/x/y/z', realpathOf), '/home/g/ws/x/y/z');
  assert.equal(await resolveDeepestAncestor('/', realpathOf), '/');
});

test('连根都解析不出 ⇒ 返回 null（调用方 fail-closed，绝不按词法放行）', async () => {
  assert.equal(await resolveDeepestAncestor('/nope/a', async () => null), null);
});

test('尾斜杠/重复斜杠/相对路径的归一', async () => {
  assert.equal(await resolveDeepestAncestor('/home/g/ws/sub/', realpathOf), '/home/g/ws/sub');
  assert.equal(await resolveDeepestAncestor('/home//g/ws/q.js', realpathOf), '/home/g/ws/q.js');
  assert.equal(await resolveDeepestAncestor('rel/a.js', realpathOf), 'rel/a.js');
});
