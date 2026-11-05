/**
 * 回归：`wsl` preset 的静态拷贝与 DSH 0.2.2 的标准 preset 形状一致。
 *
 * 0.2.2 删除了 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径（list_agents 并入主包），
 * 并把 `dsh-tool-subagent` 的 `modelSelectionSettings` 改成 `modelSelection` + `modelDiscovery`。
 * 任何一条回退都会让真实宿主里的 WSL preset 变成 broken（"never started"）或静默丢掉子模型选择 UI，
 * 而单测不跑宿主，所以这里用结构断言把这两个契约钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWslPresetPlugins, WSL_PRESET_ID } from '../src/preset.ts';

interface Row {
  id?: string;
  name?: string;
  config?: unknown;
  group?: boolean;
  isolate?: unknown;
}

/** Depth-first rows, groups included. */
function flatten(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    out.push(row);
    if (row.group === true && Array.isArray(row.config)) out.push(...flatten(row.config as Row[]));
  }
  return out;
}

function rows(): Row[] {
  return flatten(buildWslPresetPlugins({ distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u' }) as Row[]);
}

function byId(id: string): Row {
  const row = rows().find((candidate) => candidate.id === id);
  assert.ok(row, `preset 缺少行 ${id}`);
  return row;
}

test('preset id 仍是稳定的 wsl', () => {
  assert.equal(WSL_PRESET_ID, 'wsl');
});

test('0.2.2：不再引用被删除的 tool-subagent-control/list-agents 子路径', () => {
  const offenders = rows()
    .map((row) => row.name)
    .filter((name): name is string => typeof name === 'string' && name.includes('dsh-tool-subagent-control/list-agents'));
  assert.deepEqual(offenders, []);
  assert.equal(rows().some((row) => row.id === 'tool-subagent-list-agents'), false, '不应再有 list-agents 行');
  assert.equal(byId('tool-subagent-control').name, '@deepseek-ai/dsh-tool-subagent-control');
});

test('0.2.2：tool-subagent 使用 modelSelection + modelDiscovery，不再用 modelSelectionSettings', () => {
  const config = byId('tool-subagent').config as Record<string, unknown>;
  assert.equal(config.provider, 'spawn');
  assert.equal(config.toolName, 'subagent');
  assert.equal(config.modelSelection, true);
  assert.equal(config.modelDiscovery, true);
  assert.equal('modelSelectionSettings' in config, false);
});

test('0.2.2：tool-fs 显式关闭 applyPatch（与 standard 默认一致，provider 已实现 patchText）', () => {
  const config = byId('tool-fs').config as Record<string, unknown>;
  assert.equal(config.applyPatch, false);
});

test('0.2.2：plan-mode section 与标准 preset 对齐（decision-complete）', () => {
  const config = byId('plan-mode').config as Record<string, unknown>;
  assert.equal(typeof config.section, 'string');
  assert.match(String(config.section), /decision-complete/);
});
