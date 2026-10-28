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
  // 2026-10-28：`distro`/`wslHome` 缺省现在是"自动探测"（见 test/target-detect.test.ts）。
  // 本用例只关心**合并语义**，所以两项都给显式值 —— 免得测试机装没装 WSL 影响断言。
  const c = normalizeConfig({ distro: 'Ubuntu-24.04', wslHome: '/home/u', readTextMaxBytes: 1024 });
  assert.equal(c.distro, 'Ubuntu-24.04');
  assert.equal(c.wslHome, '/home/u');
  assert.equal(c.cwd, '/home/u');
  assert.equal(c.readTextMaxBytes, 1024);
  assert.equal(c.daemonPort, DEFAULTS.daemonPort);
  assert.equal(c.daemonLockWaitMs, 45000);
  assert.equal(typeof c.timeoutMs, 'number');
  // 非对象/数组/undefined 都退回默认值。这些入参没有显式目标 ⇒ 会走自动探测：
  // 给一个"没有 wsl.exe"的假 probe，避免测试去 spawn 真的 wsl.exe（CI 也没有它）。
  const noWslProbe = () => ({
    status: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: { code: 'ENOENT', message: 'no wsl.exe in this test' },
  });
  for (const bad of [undefined, null, 42, 'x', [], true]) {
    const merged = normalizeConfig(bad, { probe: noWslProbe });
    assert.equal(merged.daemonPort, DEFAULTS.daemonPort);
    assert.equal(merged.distro, '', '探测失败 ⇒ 目标留空（不静默填作者机器的值）');
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
  const msg = c.hard.join(' | ');
  assert.ok(c.hard.some((s: string) => /协议/.test(s)));
  // 2026-10-27 第三轮：这个方向的唯一出路是**升级宿主**（重启 DSH 让它加载新插件代码）。
  // 旧文案还建议「或 restart 守护」—— 那是反的（restart 只会用同一份更新的守护脚本再起一个），
  // 用户照做会原地打转。这里把"该往哪走"钉住，避免文案再漂回误导。
  assert.match(msg, /重启\/升级 DSH Desktop/);
  // 注意不能简单否定 "restart 守护"：新文案里恰有「restart 守护不解决问题」这句（正是要说明它是错方向）。
  // 要拦的是**把 restart 当建议**的那种写法（旧版是「需先升级宿主或 restart 守护」）。
  assert.doesNotMatch(msg, /或 restart 守护/, '宿主旧时不能把 restart 守护当作可选出路');
  assert.match(msg, /不解决问题/, '应明确否掉 restart 守护这个方向，避免用户原地打转');
});

test('configCompat：插件版本不同但协议相同 ⇒ soft 提示对齐', () => {
  const info = { cwd: '/home/g', profile: 'sdk', protocolVersion: PROTOCOL_VERSION, pluginVersion: '0.0.9' };
  const c = configCompat({ cwd: '/home/g', profile: 'sdk' }, info, null);
  assert.equal(c.hard.length, 0);
  assert.ok(c.soft.some((s: string) => /插件版本/.test(s)), JSON.stringify(c.soft));
});
