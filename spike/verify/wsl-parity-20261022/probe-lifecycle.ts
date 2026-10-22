#!/usr/bin/env node
/**
 * probe-lifecycle.ts —— 关停屏障（参考 ZCode 的 Remote Host dispose 纪律）。
 *
 * 覆盖：track/自动摘除、settle 等退出、超时只 kill 自己记录的子进程、beginShutdown 后拒绝新建、
 * 幂等代次。用假 child（EventEmitter）跑，不需要真起 WSL 进程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLifecycle } from '../../../src/lifecycle.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killed = false;
  kill() {
    this.killed = true;
    this.exitCode = 1;
    this.emit('exit', 1);
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code);
  }
}

{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  lifecycle.track(child);
  check('track 后计数 1', lifecycle.size() === 1);
  child.exit(0);
  check('子进程退出后自动摘除', lifecycle.size() === 0);
}

{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  lifecycle.track(child);
  setTimeout(() => child.exit(0), 40);
  const report = await lifecycle.settle(2000);
  check('settle 等到子进程自然退出', report.timedOut === false && report.killed === 0, JSON.stringify(report));
  check('settle 记录等待时长', report.waitedMs >= 20, String(report.waitedMs));
}

{
  const lifecycle = createLifecycle();
  const child = new FakeChild();
  lifecycle.track(child);
  const report = await lifecycle.settle(80);
  check('超时：只 kill 自己记录的子进程', report.timedOut === true && report.killed === 1 && child.killed === true, JSON.stringify(report));
}

{
  const lifecycle = createLifecycle();
  lifecycle.assertAlive();
  check('未关停时 assertAlive 放行', true);
  const g1 = lifecycle.beginShutdown();
  const g2 = lifecycle.beginShutdown();
  check('beginShutdown 幂等且代次递增', g2 === g1 + 1, g1 + ' -> ' + g2);
  let code = null;
  try {
    lifecycle.assertAlive();
  } catch (error) {
    code = error.code;
  }
  check('关停后拒绝新建（E_SHUTDOWN）', code === 'E_SHUTDOWN', String(code));
}

{
  const lifecycle = createLifecycle();
  const release = lifecycle.track(null);
  release();
  check('track(null) 安全返回', lifecycle.size() === 0);
}

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-lifecycle.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
