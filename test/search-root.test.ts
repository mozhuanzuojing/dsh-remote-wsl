/**
 * 宿主平面 WSL 搜索（B）的路径解析测试。
 *
 * 这一层只做一件事：把模型给的三类写法（UNC / Linux 绝对 / 相对会话 cwd）统一成**发行版内绝对路径**，
 * 并且拒绝别的发行版（否则会把搜索发到错误的 WSL 里）。真正的树搜索在守护里执行，一次 RPC。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.ts';
import { resolveSearchRoot } from '../src/search-tool.ts';

const CFG = { ...DEFAULTS, distro: 'Debian', wslHome: '/home/g', cwd: '/home/g' };
const UNC = '\\\\wsl.localhost\\Debian\\home\\g\\project';

test('UNC ⇒ 发行版内绝对路径', () => {
  assert.equal(resolveSearchRoot(CFG, UNC, undefined), '/home/g/project');
  assert.equal(resolveSearchRoot(CFG, `${UNC}\\app`, undefined), '/home/g/project/app');
});

test('Linux 绝对路径原样使用（宿主平面不需要 realpath，遍历交给守护）', () => {
  assert.equal(resolveSearchRoot(CFG, '/home/g/project/app', undefined), '/home/g/project/app');
});

test('相对路径按会话 cwd 拼接：UNC cwd 与 POSIX cwd 都成立', () => {
  assert.equal(resolveSearchRoot(CFG, 'app/src', `${UNC}\\app`), '/home/g/project/app/app/src');
  assert.equal(resolveSearchRoot(CFG, 'src', '/home/g/project/app'), '/home/g/project/app/src');
});

test('缺省（无 path）⇒ 会话 cwd', () => {
  assert.equal(resolveSearchRoot(CFG, undefined, `${UNC}\\app`), '/home/g/project/app');
});

test('别的发行版 ⇒ 明确拒绝，绝不发到错误的 WSL', () => {
  assert.throws(
    () => resolveSearchRoot(CFG, '\\\\wsl.localhost\\Ubuntu\\home\\u\\x', undefined),
    /只服务 "Debian"/,
  );
});

test('相对路径 + 非 WSL cwd ⇒ 明确失败（不猜根目录）', () => {
  assert.throws(() => resolveSearchRoot(CFG, 'src', 'D:\\project\\x'), /无法解析相对路径/);
});
