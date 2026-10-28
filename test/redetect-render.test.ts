/**
 * 复核遗留项收尾（v0.3.7）的纯函数回归：
 *   · `renderRedetectResult`：显式配置 / 换发行版 / 失败三种分支的措辞（S2-4、S3-3、S5）；
 *   · `structuralIncompatError`：hard 不兼容的出路必须写在文案里（S3-7）；
 *   · `configWarnings`：空/`auto` 回落默认值**不静默**（S3-8）。
 *
 * 全部是纯函数 / 字符串断言，**不起任何进程**（不依赖本机 WSL）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { configWarnings, normalizeConfig } from '../src/config.ts';
import { renderRedetectResult } from '../src/register-tools.ts';
import { structuralIncompatError } from '../src/daemon-launch.ts';

const cfg = (distro = 'Ubuntu-24.04', home = '/home/u') => ({ distro, wslHome: home, cwd: home });
const base = (extra = {}) => ({
  ok: true,
  problem: null,
  notes: [],
  previous: cfg('OldDistro', '/home/o'),
  current: cfg('NewDistro', '/home/n'),
  changed: true,
  auto: true,
  ...extra,
});

test('renderRedetectResult：null ⇒ 不渲染任何行（普通 wsl_status 调用保持廉价）', () => {
  assert.deepEqual(renderRedetectResult(null, cfg()), []);
});

test('renderRedetectResult：失败 ⇒ 一行 ⚠️，带原因，不假装成功', () => {
  const lines = renderRedetectResult(base({ ok: false, problem: 'remote-wsl: 探测默认发行版超时' }), cfg());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^redetect: ⚠️ 重新探测仍失败：remote-wsl: 探测默认发行版超时/);
});

test('renderRedetectResult：纯显式配置（auto:false）⇒ 说"无需重探"，不能说"已重新探测"（S3-3）', () => {
  const lines = renderRedetectResult(base({ auto: false, changed: false }), cfg('Debian', '/home/d'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /无需重探/);
  assert.doesNotMatch(lines[0], /已重新探测/);
});

test('renderRedetectResult：换发行版 ⇒ 追加孤儿守护风险与可操作出路（S2-4）', () => {
  const lines = renderRedetectResult(base(), cfg('NewDistro', '/home/n'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /已重新探测/);
  assert.match(lines[1], /目标发行版已从 "OldDistro" 换到 "NewDistro"/);
  assert.match(lines[1], /wsl_daemon action=stop/, '必须给可操作出路');
});

test('renderRedetectResult：发行版没变 ⇒ 不追加警告', () => {
  const same = base({ previous: cfg('Same', '/home/s'), current: cfg('Same', '/home/s') });
  assert.equal(renderRedetectResult(same, cfg('Same', '/home/s')).length, 1);
});

test('structuralIncompatError：hard 原因 + 两条出路都必须出现（S3-7）', () => {
  const msg = structuralIncompatError({ hard: ['provider a≠b', 'model c≠d'] }, 8731, 9000);
  assert.match(msg, /结构性不兼容/);
  assert.match(msg, /provider a≠b、model c≠d/);
  assert.match(msg, /wsl_daemon action=restart/);
  assert.match(msg, /config\.daemonPort/);
});

test('configWarnings：空/纯空白/auto 回落默认值必须被记录（S3-8），合法值不报警', () => {
  const bad = normalizeConfig({ distro: 'D', wslHome: '/h', provider: '', model: '  ', profile: 'auto' });
  assert.equal(bad.provider, 'deepseek-official');
  assert.equal(bad.model, 'deepseek-flash');
  assert.equal(bad.profile, 'sdk');
  const w = configWarnings(bad);
  assert.equal(w.length, 3, JSON.stringify(w));
  assert.ok(w.some((s) => /provider/.test(s)));
  assert.ok(w.some((s) => /model/.test(s)));
  assert.ok(w.some((s) => /profile/.test(s)));

  const good = normalizeConfig({ distro: 'D', wslHome: '/h', provider: 'commandcode', model: 'deepseek/x', profile: 'sdk' });
  assert.deepEqual(configWarnings(good), []);
  // 普通对象（非 normalizeConfig 产物）不炸
  assert.deepEqual(configWarnings({}), []);
});
