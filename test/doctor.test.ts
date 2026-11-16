import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorReport } from '../src/doctor.ts';

test('doctor：全部正常 → ready', () => {
  const r = doctorReport({ platform: 'win32', distros: ['debian-u8-1'], distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g/p', versionResolved: '0.2.2-rc.2', drift: { drifted: false }, daemon: { present: true, running: true, reachable: true, detail: 'slot=0' }, proxy: { reachable: true, host: 'h', port: 1 }, configWarnings: [] });
  assert.equal(r.verdict, 'ready');
  assert.ok(r.text.includes('就绪'));
});

test('doctor：目标无法确定 → blocked，含补救', () => {
  const r = doctorReport({ platform: 'win32', distros: ['x'], targetIssue: '未配置 distro', versionResolved: 'v' });
  assert.equal(r.verdict, 'blocked');
  const t = r.checks.find((c) => c.id === 'target');
  assert.equal(t!.status, 'fail');
  assert.ok(t!.remedy && t!.remedy.length > 0);
});

test('doctor：发行版读不到 → blocked', () => {
  const r = doctorReport({ platform: 'win32', distrosReadFailed: true, distros: [] });
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.checks.find((c) => c.id === 'distros')!.status, 'fail');
});

test('doctor：版本漂移 + 守护未运行 → degraded（非 blocked）', () => {
  const r = doctorReport({ platform: 'win32', distros: ['d'], distro: 'd', versionResolved: 'v', drift: { drifted: true, desktop: 'a', pin: 'b' }, daemon: { present: false }, proxy: { reachable: false } });
  assert.equal(r.verdict, 'degraded');
  assert.equal(r.checks.find((c) => c.id === 'drift')!.status, 'warn');
  assert.equal(r.checks.find((c) => c.id === 'daemon')!.status, 'warn');
});

test('doctor：非 win32 → blocked', () => {
  const r = doctorReport({ platform: 'linux', distros: ['d'], distro: 'd', versionResolved: 'v' });
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.checks.find((c) => c.id === 'platform')!.status, 'fail');
});
