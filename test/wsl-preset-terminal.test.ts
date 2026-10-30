/**
 * 右侧栏终端后端（standalone `wsl` preset）回归：wsl-world 内挂 wsl-terminal，
 * 显式发行版必须进入 `-d` 参数。只构造 plugins 数组，不启动 DSH、不注册 preset。
 * （distro 为空时 normalizeConfig 会先尝试自动探测；探测失败才留空，那一条
 * 不在单测里伪造，避免测试依赖本机 WSL 状态。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWslPresetPlugins } from '../src/preset.ts';

function terminalBackend(plugins) {
  const world = plugins.find((row) => row.id === 'wsl-world');
  assert.ok(world, 'preset 必须含 wsl-world 组');
  const group = world.config.find((row) => row.id === 'wsl-terminal');
  assert.ok(group, 'wsl-world 内必须含 wsl-terminal 子组');
  const backend = group.config.find((row) => row.id === 'terminal-wsl');
  assert.ok(backend, 'wsl-terminal 必须挂 dsh-terminal-bash 后端');
  assert.equal(backend.name, '@deepseek-ai/dsh-terminal-bash');
  assert.equal(backend.config.backendType, 'wsl');
  assert.equal(backend.config.shellPath, 'wsl.exe');
  return backend;
}

test('wsl preset：显式发行版进入右侧栏终端后端的 -d 参数', () => {
  const backend = terminalBackend(buildWslPresetPlugins({ distro: 'Ubuntu' }));
  assert.deepEqual(backend.config.shellArgs, ['-d', 'Ubuntu', '--exec', 'bash', '-l']);
});
