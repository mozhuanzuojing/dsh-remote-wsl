/**
 * standalone `wsl` preset 的 subprocess 接线：官方右侧栏 Terminal 只认会话 subprocess，
 * 所以 wsl-world 必须隔离并挂 dsh-remote-wsl/subprocess-provider。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWslPresetPlugins } from '../src/preset.ts';

test('wsl preset：wsl-world 隔离 subprocess 并挂 WSL provider', () => {
  const plugins = buildWslPresetPlugins({ distro: 'Ubuntu' });
  const world = plugins.find((row) => row.id === 'wsl-world');
  assert.ok(world, 'preset 必须含 wsl-world 组');
  assert.equal(world.isolate?.subprocess, true, 'wsl-world 必须隔离 subprocess');
  const row = world.config.find((entry) => entry.id === 'subprocess-wsl');
  assert.ok(row, 'wsl-world 必须挂 subprocess provider');
  assert.equal(row.name, 'dsh-remote-wsl/subprocess-provider');
  assert.equal(row.config?.distro, 'Ubuntu');
  assert.ok(!plugins.some((entry) => entry.id === 'wsl-terminal'), '不再挂无效的 terminals 组');
});
