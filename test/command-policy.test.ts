/**
 * 危险命令策略与审批门禁回归（2026-10-30 吸收 dsh-ssh-ops）。
 *
 * 这里只测纯策略与 `tools/pre-execute` 接线，不启动真实 WSL、不触发真实 DSH 审批。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWslCommand, installCommandGate } from '../src/command-policy.ts';
import { buildWslPresetPlugins } from '../src/preset.ts';

const DANGEROUS = [
  ['rm -rf /tmp/x', 'delete-files'],
  ['find /tmp -name x -exec rm {} \\;', 'bulk-delete'],
  ['xargs rm -f < files.txt', 'bulk-delete'],
  ['python3 -c "import shutil; shutil.rmtree(\'/tmp/x\')"', 'bulk-delete'],
  ['mkfs.ext4 /dev/sdb1', 'disk-format'],
  ['docker system prune -af', 'docker-destroy'],
  ['kubectl delete pod x', 'deploy-destroy'],
  ['git clean -fd', 'git-destructive'],
  ['systemctl reboot', 'reboot-shutdown'],
];

const SAFE = ['ls -la', 'git status --porcelain', 'docker ps', 'find /tmp -maxdepth 1 -type f', 'echo hello'];

test('assessWslCommand：删除/格式化/销毁/重启类命令命中，普通命令不命中', () => {
  for (const [command, key] of DANGEROUS) {
    const decision = assessWslCommand(command);
    assert.equal(decision.ok, false, command);
    assert.equal(decision.categoryKey, key, command);
  }
  for (const command of SAFE) assert.equal(assessWslCommand(command).ok, true, command);
});

function fakeCtx(approval) {
  const handlers = [];
  return {
    handlers,
    on(name, fn) {
      if (name === 'tools/pre-execute') handlers.push(fn);
    },
    get(name) {
      return name === 'approval' ? approval : undefined;
    },
    run(execution, next) {
      assert.equal(handlers.length, 1);
      return handlers[0](execution, next);
    },
  };
}

function execution(command, name = 'wsl_exec') {
  return { name, agent: 'agent-1', callId: 'call-1', arguments: { command }, signal: undefined };
}

test('installCommandGate：安全命令直接 next', async () => {
  const ctx = fakeCtx(undefined);
  installCommandGate(ctx, { toolNames: ['wsl_exec'] });
  assert.equal(await ctx.run(execution('ls -la'), () => 'next'), 'next');
});

test('installCommandGate：危险命令 allowed-once 才 next', async () => {
  const ctx = fakeCtx({ request: async () => 'allowed-once' });
  installCommandGate(ctx, { toolNames: ['wsl_exec'] });
  assert.equal(await ctx.run(execution('rm -rf /tmp/x'), () => 'next'), 'next');
});

test('installCommandGate：拒绝/取消/无审批通道均 deny，不执行', async () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const ctx = fakeCtx(outcome === 'unavailable' ? undefined : { request: async () => outcome });
    installCommandGate(ctx, { toolNames: ['wsl_exec'] });
    const result = await ctx.run(execution('rm -rf /tmp/x'), () => 'next');
    assert.equal(result.kind, 'deny', outcome);
    assert.match(result.reason, /危险|审批|拒绝|手动执行/, outcome);
  }
});

test('installCommandGate：commandPolicy=off 时不注册门禁（仅操作者配置可关闭）', () => {
  const ctx = fakeCtx(undefined);
  installCommandGate(ctx, { toolNames: ['wsl_exec'], commandPolicy: 'off' });
  assert.equal(ctx.handlers.length, 0);
});

test('installCommandGate：只拦指定工具名，WSL preset 的 bash 可单独挂载', async () => {
  const ctx = fakeCtx(undefined);
  installCommandGate(ctx, { toolNames: ['bash'] });
  assert.equal(await ctx.run(execution('ls', 'bash'), () => 'next'), 'next');
  const denied = await ctx.run(execution('rm -rf /tmp/x', 'bash'), () => 'next');
  assert.equal(denied.kind, 'deny');
});

test('WSL preset 已包含 command-policy 子插件，标准 preset 不受影响', () => {
  const plugins = buildWslPresetPlugins({ distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u', dshVersion: '0.2.1-rc.3' });
  const world = plugins.find((row) => row.id === 'wsl-world');
  const policy = world.config.find((row) => row.id === 'wsl-command-policy');
  assert.equal(policy.name, 'dsh-remote-wsl/command-policy');
  assert.deepEqual(policy.config.toolNames, ['bash']);
  assert.equal(policy.config.commandPolicy, 'standard');
  const off = buildWslPresetPlugins({ distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u', dshVersion: '0.2.1-rc.3', commandPolicy: 'off' });
  const offPolicy = off.find((row) => row.id === 'wsl-world').config.find((row) => row.id === 'wsl-command-policy');
  assert.equal(offPolicy.config.commandPolicy, 'off');
});
