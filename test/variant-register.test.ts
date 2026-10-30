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
});

test('registerWslVariants：没有 readDocument/read 时返回失败而不是抛/伪造', async () => {
  const result = await registerWslVariants({
    list: async () => [{ id: 'standard' }],
    register: async () => async () => {},
  });
  assert.equal(result.registered.length, 0);
  assert.match(result.failures[0], /readDocument|read/);
});

test('registerWslVariants：不关闭宿主 read_image（本仓库没有 image 替身）', async () => {
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
  const world = registered[0].plugins.find((row) => row.id === 'wsl-world');
  const toolFs = world.config.find((row) => row.id === 'tool-fs');
  assert.notEqual(toolFs.config?.readImage, false, '没有 image 替身时不得关闭 read_image');
});

test('registerWslVariants：roster 中所有健康基础 preset 都生成变体（不只固定 5 个）', async () => {
  const registered = [];
  const presets = {
    list: async () => [{ id: 'standard' }, { id: 'custom-mode' }, { id: 'wsl-old' }, { id: 'broken-mode', broken: 'x' }],
    readDocument: async (id) => ({ content: SOURCE, name: id }),
    register: async (definition) => {
      registered.push(definition);
      return async () => {};
    },
  };
  const result = await registerWslVariants(presets);
  assert.deepEqual(result.registered.sort(), ['wsl-custom-mode', 'wsl-standard']);
  assert.ok(!registered.some((row) => row.id === 'wsl-old'), '已存在的 wsl-* 不应重复');
  assert.ok(!registered.some((row) => row.id === 'wsl-broken-mode'), 'broken preset 不应生成变体');
});

test('registerWslVariants：dispose 释放本次注册的变体', async () => {
  const disposed = [];
  const presets = {
    list: async () => [{ id: 'standard' }],
    readDocument: async () => ({ content: SOURCE, name: 'standard' }),
    register: async (definition) => async () => disposed.push(definition.id),
  };
  const result = await registerWslVariants(presets);
  assert.equal(result.registered.length, 1);
  await result.dispose();
  assert.deepEqual(disposed, ['wsl-standard']);
});

test('registerWslVariants：源 preset 的 !!js 表达式保留为 __jsExpr，交给宿主 loader 求值', async () => {
  const registered = [];
  const presets = {
    list: async () => [{ id: 'standard' }],
    readDocument: async () => ({ content: '- id: persona\n  name: !!js process.env.X\n', name: 'standard' }),
    register: async (definition) => {
      registered.push(definition);
      return async () => {};
    },
  };
  const result = await registerWslVariants(presets);
  assert.equal(registered.length, 1, '!!js 行不应阻止变体注册');
  assert.equal(result.registered[0], 'wsl-standard');
  const row = registered[0].plugins.find((entry) => entry.id === 'persona');
  assert.equal(row.name.__jsExpr, 'process.env.X');
});
