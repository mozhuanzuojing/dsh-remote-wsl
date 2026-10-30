/**
 * WSL 模式变体生成回归：用假 roster 验证 transform + js-yaml 解析 + register 接线。
 * 不启动真实 DSH，也不注册真实 preset。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWslVariants } from '../src/variant-register.ts';

const SOURCE = [
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  '',
].join('\n');

test('registerWslVariants：基础模式生成 wsl-<mode>，world 含 fs/shell/命令门禁', async () => {
  const registered = [];
  const presets = {
    list: async () => [{ id: 'standard' }, { id: 'ptc' }],
    readDocument: async (id) => ({ content: SOURCE, name: id }),
    register: async (definition) => {
      registered.push(definition);
      return async () => {};
    },
  };
  const result = await registerWslVariants(presets, undefined, { distro: 'Ubuntu' });
  assert.deepEqual(result.registered.sort(), ['wsl-ptc', 'wsl-standard']);
  const standard = registered.find((row) => row.id === 'wsl-standard');
  assert.ok(standard);
  const world = standard.plugins.find((row) => row.id === 'wsl-world');
  assert.ok(world, '变体必须含 wsl-world 组');
  assert.ok(world.config.some((row) => row.id === 'shell-wsl'));
  assert.ok(world.config.some((row) => row.id === 'fs-wsl'));
  assert.ok(world.config.some((row) => row.id === 'wsl-command-policy'));
  // 右侧栏终端：每个变体都要挂 WSL 后端（宿主自带 terminal UI/注册表）。
  const terminal = standard.plugins.find((row) => row.id === 'wsl-terminal');
  assert.ok(terminal, '变体必须含 wsl-terminal 组');
  assert.equal(terminal.group, true);
  const backend = terminal.config.find((row) => row.id === 'terminal-wsl');
  assert.ok(backend, 'wsl-terminal 必须挂 dsh-terminal-bash 后端');
  assert.equal(backend.name, '@deepseek-ai/dsh-terminal-bash');
  assert.deepEqual(backend.config.shellArgs, ['-d', 'Ubuntu', '--exec', 'bash', '-l']);
});

test('registerWslVariants：无显式发行版时不传空 -d（默认发行版）', async () => {
  const registered = [];
  const presets = {
    list: async () => [{ id: 'standard' }],
    readDocument: async () => ({ content: SOURCE, name: 'standard' }),
    register: async (definition) => {
      registered.push(definition);
      return async () => {};
    },
  };
  await registerWslVariants(presets);
  const terminal = registered[0].plugins.find((row) => row.id === 'wsl-terminal');
  const backend = terminal.config.find((row) => row.id === 'terminal-wsl');
  assert.deepEqual(backend.config.shellArgs, ['--exec', 'bash', '-l']);
});

test('registerWslVariants：没有 readDocument/read 时返回失败而不是抛/伪造', async () => {
  const result = await registerWslVariants({
    list: async () => [{ id: 'standard' }],
    register: async () => async () => {},
  });
  assert.equal(result.registered.length, 0);
  assert.match(result.failures[0], /readDocument|read/);
});
