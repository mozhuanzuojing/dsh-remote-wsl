/**
 * WSL 健康诊断/传输错误提示的纯函数回归（2026-10-29：ECONNRESET/命令通道卡死可操作性）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wslExecHealthNote } from '../src/register-tools.ts';
import { transportErrorAdvice } from '../src/daemon-protocol.ts';

test('wslExecHealthNote：timeout 明确指向 WSL VM 卡住，不把 daemon socket 当成命令通道正常', () => {
  const note = wslExecHealthNote({ killedBy: 'timeout', exitCode: 124 });
  assert.match(note, /timeout/);
  assert.match(note, /wsl --shutdown/);
  assert.match(note, /不会自动杀/);
});

test('wslExecHealthNote：WSL 服务自己的 WSAETIMEDOUT（exit 4294967295）也要归因', () => {
  const note = wslExecHealthNote({
    killedBy: 'exit',
    exitCode: 4294967295,
    stdout: '由于连接方在一段时间后没有正确答复...\n错误代码： Wsl/Service/WSAETIMEDOUT\n',
    stderr: '',
  });
  assert.match(note, /WSAETIMEDOUT/);
  assert.match(note, /wsl --shutdown/);
});

test('wslExecHealthNote：成功探测的输出里恰好出现 WSAETIMEDOUT 也不能误报', () => {
  assert.equal(
    wslExecHealthNote({
      killedBy: 'exit',
      exitCode: 0,
      stdout: 'log line mentions Wsl/Service/WSAETIMEDOUT but command succeeded\n',
    }),
    'ok',
  );
});

test('wslExecHealthNote：成功/普通失败/未启动分别给出不同事实', () => {
  assert.equal(wslExecHealthNote({ killedBy: 'exit', exitCode: 0 }), 'ok');
  assert.match(wslExecHealthNote({ killedBy: 'exit', exitCode: 1, stderr: 'boom\n' }), /exit 1/);
  assert.match(wslExecHealthNote({ killedBy: null, exitCode: 0 }), /not-started/);
  assert.match(wslExecHealthNote({ killedBy: 'signal', killedBySignal: 'SIGKILL', exitCode: 1 }), /SIGKILL/);
});

test('transportErrorAdvice：ECONNRESET 给 WSL 恢复路径，不暗示自动重启', () => {
  const text = transportErrorAdvice('error', 'read ECONNRESET');
  assert.match(text, /socket 被重置/);
  assert.match(text, /wsl --shutdown/);
  assert.match(text, /不会自动杀/);
});

test('transportErrorAdvice：timeout 指引先看 wsl_status，且明确不要 stop all', () => {
  const text = transportErrorAdvice('timeout', 'no reply within 3000ms');
  assert.match(text, /wsl_status/);
  assert.match(text, /不要据此执行 stop all/);
});
