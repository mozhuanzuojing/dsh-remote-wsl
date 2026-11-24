/**
 * 世界路由（A）的决策测试：**该不该**把会话切到 WSL 世界，以及切到哪个 preset。
 *
 * 这些断言守的是"尊重用户选择 / 只处理新会话 / 只处理本发行版"三条边界 —— 路由本身是优化，
 * 一旦越界就会变成"用户的会话被插件偷偷换了执行世界"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decideWorldRoute, isWslWorldPreset } from '../src/world-route.ts';

const DISTRO = 'Debian';
const UNC = '\\\\wsl.localhost\\Debian\\home\\g\\project\\app';
const BASE = { source: 'startup', cwd: UNC, sessionPreset: null, registered: ['standard', 'wsl', 'wsl-standard'], defaultPreset: 'standard', distro: DISTRO };

test('新会话 + UNC cwd + 无 preset ⇒ 落到与默认模式对应的 WSL 变体', () => {
  const d = decideWorldRoute(BASE);
  assert.equal(d.route, true);
  assert.equal(d.preset, 'wsl-standard');
});

test('没有同模式变体时退回 wsl 预设；两者都没有 ⇒ 不路由（不猜）', () => {
  assert.equal(decideWorldRoute({ ...BASE, registered: ['standard', 'wsl'] }).preset, 'wsl');
  const none = decideWorldRoute({ ...BASE, registered: ['standard'] });
  assert.equal(none.route, false);
  assert.match(none.reason, /没有注册可用的 WSL 预设/);
});

test('用户显式选过 preset ⇒ 一律不覆盖（含其它非 wsl 预设）', () => {
  const d = decideWorldRoute({ ...BASE, sessionPreset: 'code' });
  assert.equal(d.route, false);
  assert.match(d.reason, /尊重用户选择/);
});

test('已经在 WSL 世界里 ⇒ 幂等不重复 select', () => {
  for (const id of ['wsl', 'wsl-code']) {
    const d = decideWorldRoute({ ...BASE, sessionPreset: id });
    assert.equal(d.route, false);
    assert.match(d.reason, /已经是 WSL 世界/);
  }
  assert.equal(isWslWorldPreset('wsl-standard'), true);
  assert.equal(isWslWorldPreset('standard'), false);
});

test('resume / clear / compact 不动（避免改写正在跑的会话）', () => {
  for (const source of ['resume', 'clear', 'compact']) {
    const d = decideWorldRoute({ ...BASE, source });
    assert.equal(d.route, false, `${source} 不该被路由`);
    assert.match(d.reason, /只处理 startup/);
  }
});

test('非 UNC cwd（Windows 盘符 / POSIX / 别的发行版）⇒ 不路由', () => {
  assert.equal(decideWorldRoute({ ...BASE, cwd: 'D:\\project\\x' }).route, false);
  assert.equal(decideWorldRoute({ ...BASE, cwd: '/home/g/x' }).route, false);
  const other = decideWorldRoute({ ...BASE, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u\\x' });
  assert.equal(other.route, false);
  assert.match(other.reason, /只服务/);
});

test('没有 cwd 的会话不路由（无处可归属，明确放过而不是瞎猜）', () => {
  const d = decideWorldRoute({ ...BASE, cwd: '' });
  assert.equal(d.route, false);
  assert.match(d.reason, /没有 cwd/);
});
