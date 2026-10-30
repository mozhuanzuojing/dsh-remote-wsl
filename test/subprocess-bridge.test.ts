/**
 * subprocess bridge 回归：官方 Terminal 的 spawnTerminal 按 UNC cwd 分派到 wsl.exe，
 * 非 WSL cwd 原样放行，disposer 恢复原方法。不启动真实 DSH/WSL。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSubprocessBridge, isWslUncCwd } from '../src/subprocess-bridge.ts';

function fakeHost() {
  const calls = [];
  const host = {
    async spawnTerminal(spec) {
      calls.push(spec);
      return { handle: true };
    },
  };
  return { host, calls };
}

test('isWslUncCwd：只认 wsl.localhost / wsl$ 的 UNC', () => {
  assert.equal(isWslUncCwd('\\\\wsl.localhost\\Ubuntu\\home\\me'), true);
  assert.equal(isWslUncCwd('\\\\wsl$\\Ubuntu\\home\\me'), true);
  assert.equal(isWslUncCwd('D:\\project'), false);
  assert.equal(isWslUncCwd('\\\\server\\share'), false);
  assert.equal(isWslUncCwd(undefined), false);
});

test('installSubprocessBridge：WSL UNC cwd 换成 wsl.exe bash', async () => {
  const { host, calls } = fakeHost();
  installSubprocessBridge(host, { distro: 'Ubuntu' });
  await host.spawnTerminal({ argv: ['cmd.exe'], cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me', rows: 30, cols: 120, env: { DSH_SESSION_ID: 's' } });
  const spec = calls[0];
  assert.equal(spec.argv[0].endsWith('wsl.exe'), true);
  assert.deepEqual(spec.argv.slice(1), ['-d', 'Ubuntu', '--exec', 'bash', '-l']);
  assert.equal(spec.rows, 30);
  assert.equal(spec.cols, 120);
  assert.equal(spec.env.DSH_SESSION_ID, 's');
});

test('installSubprocessBridge：非 WSL cwd 原样放行', async () => {
  const { host, calls } = fakeHost();
  installSubprocessBridge(host, { distro: 'Ubuntu' });
  await host.spawnTerminal({ argv: ['powershell.exe'], cwd: 'D:\\project' });
  assert.deepEqual(calls[0].argv, ['powershell.exe']);
  assert.equal(calls[0].cwd, 'D:\\project');
});

test('installSubprocessBridge：disposer 恢复原方法', async () => {
  const { host, calls } = fakeHost();
  const original = host.spawnTerminal;
  const restore = installSubprocessBridge(host, {});
  assert.notEqual(host.spawnTerminal, original);
  restore();
  assert.equal(host.spawnTerminal, original);
  await host.spawnTerminal({ argv: ['cmd.exe'], cwd: '\\\\wsl.localhost\\Ubuntu\\x' });
  assert.deepEqual(calls[0].argv, ['cmd.exe'], '恢复后不再改写');
});
