/**
 * 配置单一真相 + 插件/协议版本的回归测试（2026-10-27 换角度评审第 1、3 条）。
 *
 * 为什么值得测：
 *  · 默认值以前散在四个模块里，`preset.ts` 只转发 4 个键 ⇒ `readTextMaxBytes` 部署不可调（已修）；
 *  · 守护是 detached 的，宿主升级后旧守护仍活着 ⇒ 协议错配必须有明确的 hard/soft 判据，
 *    不能靠"某个新功能不工作"反推。这里用假 info 直接把三种错配钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../src/config.ts';
import { PLUGIN_VERSION, PROTOCOL_VERSION } from '../src/plugin-version.ts';
import { configCompat } from '../src/daemon-launch.ts';

test('normalizeConfig：补齐默认值、调用方覆盖优先、非对象入参不炸', () => {
  const c = normalizeConfig({ distro: 'Ubuntu-24.04', readTextMaxBytes: 1024 });
  assert.equal(c.distro, 'Ubuntu-24.04');
  assert.equal(c.readTextMaxBytes, 1024);
  assert.equal(c.daemonPort, DEFAULTS.daemonPort);
  assert.equal(c.daemonLockWaitMs, 45000);
  assert.equal(typeof c.timeoutMs, 'number');
  // 非对象/数组/undefined 都退回默认值
  for (const bad of [undefined, null, 42, 'x', [], true]) {
    assert.equal(normalizeConfig(bad).daemonPort, DEFAULTS.daemonPort);
  }
});

test('插件版本与协议版本：来自 package.json 与单一常量', async () => {
  const pkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION >= 1);
});

test('configCompat：守护协议比宿主旧 ⇒ soft（可复用但提示 restart 后生效）', () => {
  const info = { cwd: '/home/g', profile: 'sdk', protocolVersion: PROTOCOL_VERSION - 1, pluginVersion: '0.1.0' };
  const c = configCompat({ cwd: '/home/g', profile: 'sdk' }, info, null);
  assert.equal(c.hard.length, 0);
  assert.ok(c.soft.some((s: string) => /协议/.test(s) && /restart/.test(s)), JSON.stringify(c.soft));
  assert.equal(c.plugin.protocolDaemon, PROTOCOL_VERSION - 1);
});

test('configCompat：旧守护没上报协议版本 ⇒ soft 且标 unknown', () => {
  const c = configCompat({ cwd: '/home/g', profile: 'sdk' }, { cwd: '/home/g', profile: 'sdk' }, null);
  assert.equal(c.hard.length, 0);
  assert.equal(c.plugin.protocolDaemon, null);
  assert.equal(c.plugin.daemon, null);
  assert.ok(c.soft.some((s: string) => /未上报协议版本/.test(s)), JSON.stringify(c.soft));
});

test('configCompat：守护协议比宿主新 ⇒ hard（宿主比守护旧，拒绝静默复用）', () => {
  const info = { cwd: '/home/g', profile: 'sdk', protocolVersion: PROTOCOL_VERSION + 1, pluginVersion: '9.9.9' };
  const c = configCompat({ cwd: '/home/g', profile: 'sdk' }, info, null);
  assert.ok(c.hard.some((s: string) => /协议/.test(s)));
});

test('configCompat：插件版本不同但协议相同 ⇒ soft 提示对齐', () => {
  const info = { cwd: '/home/g', profile: 'sdk', protocolVersion: PROTOCOL_VERSION, pluginVersion: '0.0.9' };
  const c = configCompat({ cwd: '/home/g', profile: 'sdk' }, info, null);
  assert.equal(c.hard.length, 0);
  assert.ok(c.soft.some((s: string) => /插件版本/.test(s)), JSON.stringify(c.soft));
});
