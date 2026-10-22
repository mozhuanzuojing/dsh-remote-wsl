#!/usr/bin/env node
/**
 * probe-webhost-lifecycle.ts —— web host 也纳入关停屏障（参考 ZCode 的 dispose 纪律）。
 *
 * 覆盖：关停后 WebHost.start() 立刻拒绝（E_SHUTDOWN），以及源码里两处接线（spawn 前过闸 / spawn 后 track）
 * 与 index 把 lifecycle 传给 registerTools。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebHost } from '../../../src/register-tools.ts';
import { createLifecycle } from '../../../src/lifecycle.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

{
  const lifecycle = createLifecycle();
  lifecycle.beginShutdown();
  const host = new WebHost({ distro: 'd', wslHome: '/home/g', webPort: 3082, proxyPort: 9910, cwd: '/home/g', profile: 'sdk' }, '0.0.0', lifecycle);
  let message = '';
  try {
    await host.start();
  } catch (error) {
    message = String(error && error.message ? error.message : error);
  }
  check('关停后 WebHost.start 拒绝', message.indexOf('关停') >= 0, message.slice(0, 120));
}

{
  const src = fs.readFileSync(path.join(DIR, '../../../src/register-tools.ts'), 'utf8');
  check('WebHost：spawn 前过 assertAlive', src.indexOf('this.lifecycle.assertAlive()') >= 0);
  check('WebHost：spawn 后 track 子进程', src.indexOf('this.lifecycle.track(this.child)') >= 0);
  const index = fs.readFileSync(path.join(DIR, '../../../src/index.ts'), 'utf8');
  check('index：lifecycle 传给 registerTools', /registerTools\(\{[\s\S]*?lifecycle/.test(index));
  check('index：lifecycle 传给 createInHostPool', /createInHostPool\(\{[^}]*lifecycle/.test(index));
}

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-webhost-lifecycle.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
