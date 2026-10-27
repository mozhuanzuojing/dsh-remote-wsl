/**
 * 守护控制面原语的回归测试（2026-10-27 审查 F-02/F-05/F-15/F-18 的守卫）。
 *
 * 覆盖：启动锁脚本（mkdir 原子抢占 + 陈旧自愈）、/proc 扫描输出解析、TCP 探活分类。
 * 这些都是纯函数或纯 shell 片段，可以在不启动守护的前提下确定性验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { acquireEnsureLockScript, parseScanOutput, releaseEnsureLockScript, tcpProbe } from '../src/daemon-protocol.ts';

const hasBash = (() => {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('parseScanOutput：只接受数字 pid；端口缺失记 null（进程仍要能被发现/回收）', () => {
  const out = parseScanOutput('123|8731|8731\n456||\nbad-line\n789|9000|\n');
  assert.deepEqual(out, [
    { pid: 123, port: 8731, metaPort: 8731 },
    { pid: 456, port: null, metaPort: null },
    { pid: 789, port: 9000, metaPort: null },
  ]);
});

test('tcpProbe：有人在听 ⇒ open；没人听 ⇒ refused', async () => {
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  const open = await tcpProbe(port, 1500);
  assert.equal(open.open, true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const closed = await tcpProbe(port, 1500);
  assert.equal(closed.open, false);
});

test('启动锁：mkdir 原子抢占、释放后可重抢、陈旧锁自愈', { skip: !hasBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rw-lock-'));
  const lock = join(dir, 'ensure.8731.lock');
  const acquire = join(dir, 'acquire.sh');
  const release = join(dir, 'release.sh');
  writeFileSync(acquire, `${acquireEnsureLockScript(lock, 120)}\n`);
  writeFileSync(release, `${releaseEnsureLockScript(lock)}\n`);
  const run = (f: string) => execFileSync('bash', [f], { encoding: 'utf8' }).trim();

  assert.equal(run(acquire), 'LOCKED', '第一次必须拿到锁');
  assert.equal(run(acquire), 'BUSY', '持锁期间第二次必须失败');
  run(release);
  assert.equal(run(acquire), 'LOCKED', '释放后必须能重抢');
  run(release);

  // 模拟崩溃残留：把锁目录 mtime 改老 3 分钟 ⇒ 视为陈旧并自愈
  mkdirSync(lock, { recursive: true });
  execFileSync('touch', ['-d', '3 minutes ago', lock]);
  assert.equal(run(acquire), 'LOCKED', '陈旧锁必须被自愈抢占');
  run(release);
  rmSync(dir, { recursive: true, force: true });
});
