/**
 * 回归：运行时在「一轮 prompt 进行中」退出（exit≠0）时，`SdkRuntime.prompt()` 必须**立刻**失败，
 * 而不是等到 `promptTimeoutMs`（默认 5 分钟）或客户端连接空闲超时（120s）—— 后者正是用户看到的
 * 「插件一直卡，最后报 socket 被重置」。
 *
 * 用一个 fake runtime（node 子进程）精准复现：
 *   1) initialize 正常回包（start() 成功）；
 *   2) session/prompt 先回 {messageId}（让 request() 成功 resolve，进入等 turn/end 的阶段）；
 *   3) 50ms 后直接 exit(1)，且**不发** turn/end。
 * 修复前：turnDone 永不 resolve ⇒ 一直挂到超时。修复后：exit 立刻结束本轮并抛 RUNTIME_EXITED。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { SdkRuntime, runtimeAdapter } from '../src/sdk-runtime.ts';

const FAKE = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: {} } }) + '\\n');
    } else if (m.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { messageId: 'm1' } }) + '\\n');
      setTimeout(() => process.exit(1), 50);
    } else if (m.method === 'shutdown') {
      process.exit(0);
    }
  }
});
`;

test('运行时轮次中途死亡 ⇒ prompt 立刻以 RUNTIME_EXITED 失败（不再空等到超时）', async () => {
  const rt = new SdkRuntime({
    key: 'exit-test',
    version: '0.0.0',
    cwd: tmpdir(),
    env: process.env,
    promptTimeoutMs: 600000,
    quietMs: 250,
    graceMs: 250,
    adapter: runtimeAdapter({
      spawnRuntime: ({ self }: any) =>
        spawn(process.execPath, ['-e', FAKE], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: self.env }),
    }),
  });
  await rt.start();
  const t0 = Date.now();
  await assert.rejects(() => rt.prompt('hello'), /runtime exited during prompt \(exit=1\)/);
  assert.ok(Date.now() - t0 < 5000, `必须在数秒内失败，实际 ${Date.now() - t0}ms`);
  try {
    await rt.close();
  } catch {
    /* 运行时已退出，收尾忽略 */
  }
});
