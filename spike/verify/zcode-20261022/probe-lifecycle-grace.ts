#!/usr/bin/env node
/**
 * probe-lifecycle-grace.ts —— ZCode「释放宽限 + 归属 + 晚订阅」纪律的回归（纯假 child，不需要 WSL）。
 *
 * 覆盖（对应 zai-org/ZCode packages/server/src/remote/wsl-backend.ts:427-507 与 closeEvent.ts）：
 *   1) 优雅优先：settle 先对每个登记 child 做 stdin.end()，宽限期内自己退出的**不 kill**；
 *   2) 宽限到点才 kill：只 kill 归属表里仍在的那些，kill 后再等一小段确认退出；
 *   3) kill **只作用于本模块登记的** child（未登记的同形 child 不许被碰）；
 *   4) 总预算仍 ≤ timeoutMs（index 的 settle(5000) 语义不变），默认宽限 300 + kill 后 250；
 *   5) settle 幂等：并发/重复调用返回**同一个** in-flight promise，只 kill 一次；
 *   6) 晚订阅竞态：child 在 settle 调用**之前**就退出时，settle 立刻返回（不许白等到超时）；
 *   7) 归属结算认 exit / error / close 三个事件（原来只认 exit）；
 *   8) ambient（wsl-io 依赖的"当前关停屏障"）指向最新创建的那份；
 *   9) E_SHUTDOWN / track(null) / 已退出不登记 等旧语义不回退。
 *
 * 用法：node probe-lifecycle-grace.ts；产出 out-lifecycle-grace.json；退出码 0=全过，1=有失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  createLifecycle,
  activeLifecycle,
  adoptPreviousLifecycle,
  DEFAULT_GRACE_TIMEOUT_MS,
  DEFAULT_KILL_WAIT_TIMEOUT_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
} from '../../../src/lifecycle.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killed = false;
  killCount = 0;
  stdinEnded = false;
  exitOnKill = true;

  constructor({ onStdinEnd = null } = {}) {
    super();
    this.stdin = {
      writableEnded: false,
      end: () => {
        this.stdinEnded = true;
        this.stdin.writableEnded = true;
        if (onStdinEnd) onStdinEnd(this);
      },
    };
  }

  kill() {
    this.killed = true;
    this.killCount += 1;
    if (this.exitOnKill) this.exit(1);
  }

  exit(code = 0) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code);
    this.emit('close', code);
  }

  fail(message = 'spawn ENOENT') {
    this.emit('error', new Error(message));
  }
}

// 1) 优雅优先：两个 child 收到 stdin EOF 后 10ms 退出 ⇒ killed=0、timedOut=false
{
  const lifecycle = createLifecycle();
  const a = new FakeChild({ onStdinEnd: (c) => setTimeout(() => c.exit(0), 10) });
  const b = new FakeChild({ onStdinEnd: (c) => setTimeout(() => c.exit(0), 10) });
  lifecycle.track(a);
  lifecycle.track(b);
  const report = await lifecycle.settle(2000);
  check('优雅：先 stdin.end()（两个 child 都收到）', a.stdinEnded === true && b.stdinEnded === true, JSON.stringify({ a: a.stdinEnded, b: b.stdinEnded }));
  check('优雅：宽限内自己退出 ⇒ 不 kill', report.forced === false && report.killed === 0 && a.killed === false && b.killed === false, JSON.stringify(report));
  check('优雅：settle 后归属清空', report.remaining === 0 && lifecycle.size() === 0);
  // ★ index.ts 的「关停超时」日志只看 timedOut ⇒ 干净关停必须为 false，否则是伪失败
  check('干净关停 ⇒ timedOut=false（index 不会误报"关停超时"）', report.timedOut === false, JSON.stringify(report));
}

// 2) 宽限到点才 kill，且 kill 后仍等一小段确认退出（旧实现是 kill 完立刻返回）
{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  child.exitOnKill = false; // kill 立刻生效但进程"过一会儿"才真的退
  lifecycle.track(child);
  setTimeout(() => child.exit(1), DEFAULT_GRACE_TIMEOUT_MS + 40); // 宽限后 40ms 才退
  const report = await lifecycle.settle(2000);
  check(
    '宽限 300ms 后才 kill，kill 后等到真的退出（remaining 归零）',
    report.forced === true && report.killed === 1 && report.remaining === 0 && report.waitedMs >= DEFAULT_GRACE_TIMEOUT_MS,
    JSON.stringify(report),
  );
  // ★ 语义分离：超过宽限（forced=true）但在 kill 等待里干净退出 ⇒ 不是"超时"
  check('超过宽限但 kill 后干净退出 ⇒ forced=true 且 timedOut=false', report.forced === true && report.timedOut === false, JSON.stringify(report));
}

// 3) 一直在的 child：宽限 300 + kill 后 250 ≈ 550ms，且 remaining 如实为 1（不谎报已退出）
{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  child.exitOnKill = false; // 连 kill 都不退出
  lifecycle.track(child);
  const report = await lifecycle.settle(DEFAULT_SETTLE_TIMEOUT_MS); // index.ts 的 5000 语义
  check(
    '默认宽限 300 + kill 后等待 250（总预算 5s 内）',
    report.forced === true &&
      report.killed === 1 &&
      report.remaining === 1 &&
      report.waitedMs >= DEFAULT_GRACE_TIMEOUT_MS + DEFAULT_KILL_WAIT_TIMEOUT_MS &&
      report.waitedMs <= DEFAULT_SETTLE_TIMEOUT_MS,
    JSON.stringify(report),
  );
  // ★ 真的关不干净 ⇒ timedOut=true（index 的日志这时才是真的）
  check('真的关不干净 ⇒ timedOut=true 且 remaining>0', report.timedOut === true && report.remaining > 0, JSON.stringify(report));
}

// 4) kill 只作用于归属表：未登记的同形 child 不许被碰
{
  const lifecycle = createLifecycle();
  const owned = new FakeChild();
  owned.exitOnKill = false;
  const stranger = new FakeChild();
  stranger.exitOnKill = false;
  lifecycle.track(owned); // stranger 故意不登记
  const report = await lifecycle.settle(2000, { graceTimeoutMs: 40, killWaitTimeoutMs: 40 });
  check('kill 只作用于自己登记的 child', report.killed === 1 && owned.killed === true && stranger.killed === false, JSON.stringify({ killed: report.killed, owned: owned.killed, stranger: stranger.killed }));
  check('未登记的 stranger 不进 remaining', report.remaining === 1 && report.timedOut === true, JSON.stringify(report));
}

// 5) 幂等：并发 + 重复调用返回同一个 in-flight promise，kill 只发生一次
{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  child.exitOnKill = false;
  lifecycle.track(child);
  const p1 = lifecycle.settle(1000, { graceTimeoutMs: 30, killWaitTimeoutMs: 30 });
  const p2 = lifecycle.settle(1000, { graceTimeoutMs: 30, killWaitTimeoutMs: 30 });
  check('settle 幂等：并发调用是同一个 promise', p1 === p2, typeof p1);
  const report = await p1;
  const p3 = lifecycle.settle(1000, { graceTimeoutMs: 30, killWaitTimeoutMs: 30 });
  check('settle 幂等：结算后再调仍是同一个 promise', p3 === p1);
  check('settle 幂等：kill 只发生一次', child.killCount === 1 && report.killed === 1, 'killCount=' + child.killCount);
}

// ★ 6) 晚订阅竞态（ZCode closeEvent.ts 的教训）：
//    child 在 track 之后、settle 之前就退出 ⇒ settle 必须立刻返回，不许白等到宽限/超时。
{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  lifecycle.track(child);
  child.exit(0); // 同步退出：此时 settle 还没被调用
  check('晚订阅前置：已退出的 child 已从归属表摘除', lifecycle.size() === 0);
  await sleep(20); // 故意晚 20ms 才 settle
  const startedAt = Date.now();
  const report = await lifecycle.settle(120); // 宽限 120ms：旧实现会白等到 120ms
  const elapsed = Date.now() - startedAt;
  check(
    '晚订阅：settle 在已退出的 child 上立刻返回（不白等）',
    report.timedOut === false && report.killed === 0 && elapsed < 60,
    'elapsed=' + elapsed + ' report=' + JSON.stringify(report),
  );
}

// 6b) 同形但还没退出的 child：settle 必须等它（证明上面的"立刻返回"不是漏等）
{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  lifecycle.track(child);
  await sleep(20);
  let settled = false;
  const p = lifecycle.settle(400, { graceTimeoutMs: 400, killWaitTimeoutMs: 0 }).then((r) => {
    settled = true;
    return r;
  });
  const early = settled;
  const report = await p;
  check('对照：在跑的 child 仍被等（不是无条件立刻返回）', early === false && report.forced === true && report.waitedMs >= 300, JSON.stringify(report));
}

// 7) 归属结算认 exit / error / close
{
  const lifecycle = createLifecycle();
  const a = new FakeChild();
  const b = new FakeChild();
  lifecycle.track(a);
  lifecycle.track(b);
  a.exit(0); // exit
  b.fail(); // error（spawn 失败时只有 error，没有 exit）
  check('error 事件也结算归属', lifecycle.size() === 0);
  const report = await lifecycle.settle(120);
  check('只退 error 的 child 不会让 settle 白等', report.timedOut === false && report.killed === 0, JSON.stringify(report));
}
{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  lifecycle.track(child);
  child.emit('close', 0); // 只有 close（没有 exit）
  check('close 事件也结算归属', lifecycle.size() === 0);
  const report = await lifecycle.settle(120);
  check('只退 close 的 child 不会让 settle 白等', report.timedOut === false, JSON.stringify(report));
}

// 8) ambient：wsl-io 的 runWsl 依赖"当前关停屏障"= 最新创建的那份
{
  const first = createLifecycle();
  check('createLifecycle 自动成为 activeLifecycle', activeLifecycle() === first);
  const second = createLifecycle();
  check('最新创建的替换 ambient', activeLifecycle() === second && activeLifecycle() !== first);
}

// 9) 旧语义不回退
{
  const lifecycle = createLifecycle();
  const release = lifecycle.track(null);
  release();
  check('track(null) 安全返回', lifecycle.size() === 0);
  const dead = new FakeChild();
  dead.exitCode = 0;
  lifecycle.track(dead);
  check('已退出的 child 不登记（否则 settle 白等）', lifecycle.size() === 0);
  lifecycle.assertAlive();
  const g1 = lifecycle.beginShutdown();
  const g2 = lifecycle.beginShutdown();
  let code = null;
  try {
    lifecycle.assertAlive();
  } catch (e) {
    code = e.code;
  }
  check('beginShutdown 幂等递增 + 关停后 E_SHUTDOWN', g2 === g1 + 1 && code === 'E_SHUTDOWN', g1 + '->' + g2 + ' code=' + code);
  const empty = await lifecycle.settle(0);
  check('空归属的 settle(0) 立刻返回', empty.timedOut === false && empty.killed === 0 && empty.remaining === 0, JSON.stringify(empty));
}

// ── review ⑥：热重载时认领上一个实例遗留的屏障 ────────────────────────────────
{
  const oldLc = createLifecycle();
  check('新实例创建后 ambient 指向它', activeLifecycle() === oldLc);
  const orphan = new FakeChild();
  oldLc.track(orphan);
  check('旧实例登记了 1 个子进程', oldLc.size() === 1);
  const adopted = adoptPreviousLifecycle(oldLc);
  check('adoptPreviousLifecycle 返回 settle promise', !!adopted && typeof adopted.then === 'function');
  const rep = await adopted;
  check('认领后旧实例进入关停态', oldLc.isShuttingDown() === true);
  check('认领会结算旧实例登记的子进程（不留给新实例背锅）', rep.remaining === 0 && orphan.killed === true, JSON.stringify(rep));
  check('已关停的旧实例再认领返回 null（幂等）', adoptPreviousLifecycle(oldLc) === null);
  check('adoptPreviousLifecycle(null) 安全返回 null', adoptPreviousLifecycle(null) === null);
  check('adoptPreviousLifecycle(非 lifecycle) 安全返回 null', adoptPreviousLifecycle({}) === null);
}

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-lifecycle-grace.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
