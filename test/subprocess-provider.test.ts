/**
 * WSL subprocess provider 回归：官方右侧栏 Terminal 的 controller 只认
 * `subprocess.terminalEnvironment/resolveExecutable/spawnTerminal`，这里用假宿主验证
 * 包装后的 argv/env/cwd 与其余方法透传。不启动真实 DSH/WSL。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWslSubprocess } from '../src/subprocess-provider.ts';

function fakeHost() {
  const calls = { spawnTerminal: [], exec: 0 };
  const host = {
    async spawnTerminal(spec) {
      calls.spawnTerminal.push(spec);
      return { handle: true };
    },
    async exec(...args) {
      calls.exec += 1;
      return { args };
    },
  };
  return { host, calls };
}

test('createWslSubprocess：terminalEnvironment 报 linux/bash', async () => {
  const { host } = fakeHost();
  const subprocess = createWslSubprocess(host, { distro: 'Ubuntu' });
  assert.deepEqual(await subprocess.terminalEnvironment(), { platform: 'linux', defaultShell: '/bin/bash' });
});

test('createWslSubprocess：resolveExecutable 把候选 shell 归一到 /bin/bash', async () => {
  const { host } = fakeHost();
  const subprocess = createWslSubprocess(host, {});
  assert.equal(await subprocess.resolveExecutable('powershell.exe'), '/bin/bash');
  assert.equal(await subprocess.resolveExecutable('bash'), '/bin/bash');
});

test('createWslSubprocess：spawnTerminal 包成 wsl.exe 并保留 env/尺寸', async () => {
  const { host, calls } = fakeHost();
  const subprocess = createWslSubprocess(host, { distro: 'Ubuntu' });
  await subprocess.spawnTerminal({
    argv: ['/bin/bash'],
    cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me',
    rows: 30,
    cols: 120,
    terminalType: 'xterm-256color',
    env: { DSH_SESSION_ID: 's1' },
    graceMs: 900,
  });
  const spec = calls.spawnTerminal[0];
  assert.equal(spec.argv[0].endsWith('wsl.exe'), true, spec.argv[0]);
  assert.deepEqual(spec.argv.slice(1), ['-d', 'Ubuntu', '--exec', 'bash', '-l']);
  assert.equal(spec.rows, 30);
  assert.equal(spec.cols, 120);
  assert.equal(spec.env.DSH_SESSION_ID, 's1');
  assert.equal(spec.terminalType, 'xterm-256color');
  assert.equal(spec.graceMs, 900);
  assert.ok(typeof spec.cwd === 'string' && spec.cwd.length > 0);
});

test('createWslSubprocess：distro 为空时不传空 -d（默认发行版）', async () => {
  const { host, calls } = fakeHost();
  const subprocess = createWslSubprocess(host, {});
  await subprocess.spawnTerminal({ argv: ['/bin/bash'] });
  assert.deepEqual(calls.spawnTerminal[0].argv.slice(1), ['--exec', 'bash', '-l']);
});

test('createWslSubprocess：其余 subprocess 方法透传宿主', async () => {
  const { host, calls } = fakeHost();
  const subprocess = createWslSubprocess(host, {});
  const result = await subprocess.exec('cmd', []);
  assert.deepEqual(result, { args: ['cmd', []] });
  assert.equal(calls.exec, 1);
});

test('createWslSubprocess：宿主服务缺 spawnTerminal 时明确抛错', () => {
  assert.throws(() => createWslSubprocess({}, {}), /spawnTerminal/);
});
