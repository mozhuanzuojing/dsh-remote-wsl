/**
 * A-P2-E（2026-10-28 独立复核补修）：目标探测失败的「**会话内**重新探测」回归。
 *
 * 背景：探测结论是**进程级缓存**（成功与失败都缓存），并在 `normalizeConfig()` 里冻结进配置对象。
 * DSH 启动那一刻 WSL 冷启动/卡住 ⇒ 首次探测失败 ⇒ 以前本进程所有入口都报"没有目标"，只能重启 DSH。
 * 现在 `refreshAutoTarget(config)`：清缓存 → 按**显式配置原值**重算 → **原地**写回配置对象。
 *
 * 这里全部用假 probe（`opts.probe`），**不依赖本机有没有装 WSL**：
 *   · 成功/失败两个方向；
 *   · 显式配置永不被覆盖（且不该发生任何探测）；
 *   · 半显式（只配 distro）只补 `$HOME`；
 *   · 「旧缓存不许在重探后被复用」——这条是最容易写错的（不清缓存就等于没修）。
 *
 * 运行：`node --experimental-strip-types --test test/*.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, refreshAutoTarget, resetTargetDetection, targetProblem } from '../src/config.ts';
import { detectDefaultDistroCached, detectDistroHomeCached } from '../src/target-detect.ts';

const buf = (s) => Buffer.from(String(s), 'utf8');
const okRes = (stdout) => ({ status: 0, stdout: buf(stdout), stderr: Buffer.alloc(0), error: null });
const missingRes = () => ({
  status: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  error: { code: 'ENOENT', message: 'no wsl.exe in this test' },
});

/** `wsl -l -v` 的最小表（解析口径：列间 2+ 空格，`*` = 默认发行版）。 */
const table = (name) => `  NAME            STATE           VERSION\n* ${name}    Running         2\n`;

/** 一个假 probe：`-l -v` 给默认发行版，`-d …` 给 $HOME。 */
function probeThat({ distro = 'Ubuntu-24.04', home = '/home/u' } = {}) {
  return (args) => (args[0] === '-l' ? okRes(table(distro)) : okRes(home));
}

test('refreshAutoTarget：探测失败后会话内重探成功 ⇒ 原地更新配置，targetProblem 变 null', () => {
  resetTargetDetection();
  const cfg = normalizeConfig({}, { probe: () => missingRes() });
  assert.equal(cfg.distro, '');
  assert.match(targetProblem(cfg), /cordis\.patch\.yml/);

  const r = refreshAutoTarget(cfg, { probe: probeThat() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.problem, null);
  assert.equal(r.changed, true, '从"无目标"到"有目标"必须被标成 changed');
  assert.equal(cfg.distro, 'Ubuntu-24.04');
  assert.equal(cfg.wslHome, '/home/u');
  assert.equal(cfg.cwd, '/home/u', 'cwd 空 ⇒ 跟随解析出来的 wslHome（与 normalizeConfig 同语义）');
  assert.equal(targetProblem(cfg), null, '同一份配置对象必须立刻对下游返回"可用"');
  resetTargetDetection();
});

test('refreshAutoTarget：重探仍失败 ⇒ ok:false + 可操作 problem，配置保持空、不伪造目标', () => {
  resetTargetDetection();
  const cfg = normalizeConfig({}, { probe: () => missingRes() });
  const r = refreshAutoTarget(cfg, { probe: () => missingRes() });
  assert.equal(r.ok, false);
  assert.match(r.problem, /cordis\.patch\.yml/);
  assert.equal(cfg.distro, '');
  assert.equal(cfg.wslHome, '');
  assert.match(targetProblem(cfg), /cordis\.patch\.yml/, '失败后必须继续给出可操作报错，而不是"已重试"');
  resetTargetDetection();
});

test('refreshAutoTarget：显式 distro/wslHome/cwd 永远不被探测覆盖（且根本不该探测）', () => {
  resetTargetDetection();
  const boom = () => {
    throw new Error('显式配置时不该发生任何探测');
  };
  const cfg = normalizeConfig({ distro: 'Debian', wslHome: '/home/d', cwd: '/work' }, { probe: boom });
  const r = refreshAutoTarget(cfg, { probe: boom });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(cfg.distro, 'Debian');
  assert.equal(cfg.wslHome, '/home/d');
  assert.equal(cfg.cwd, '/work');
  resetTargetDetection();
});

test('refreshAutoTarget：只显式 distro ⇒ 只重探 $HOME，distro 保持用户值', () => {
  resetTargetDetection();
  const cfg = normalizeConfig({ distro: 'Debian' }, { probe: () => missingRes() });
  assert.equal(cfg.distro, 'Debian');
  assert.equal(cfg.wslHome, '');
  const calls = [];
  const r = refreshAutoTarget(cfg, {
    probe: (args) => {
      calls.push(args);
      return args[0] === '-l' ? okRes(table('Other')) : okRes('/home/deb');
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(cfg.distro, 'Debian', '显式 distro 不能被探测结果覆盖');
  assert.equal(cfg.wslHome, '/home/deb');
  assert.equal(cfg.cwd, '/home/deb');
  assert.ok(!calls.some((a) => a[0] === '-l'), '有显式 distro 时不该再问 wsl -l -v');
  resetTargetDetection();
});

test('refreshAutoTarget：必须清掉进程级缓存（旧结论不得在重探后被复用）', () => {
  resetTargetDetection();
  // 先用假 probe 把"成功结论 A"写进缓存（不碰真的 wsl.exe）
  assert.equal(detectDefaultDistroCached(() => okRes(table('DistroA'))).distro, 'DistroA');
  detectDistroHomeCached('DistroA', () => okRes('/home/a'));

  const cfg = normalizeConfig({}); // 命中缓存 ⇒ A（若这里真的 spawn wsl.exe，说明缓存没生效，测试会变慢/不确定）
  assert.equal(cfg.distro, 'DistroA');
  assert.equal(cfg.wslHome, '/home/a');

  const r = refreshAutoTarget(cfg, { probe: probeThat({ distro: 'DistroC', home: '/home/c' }) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(cfg.distro, 'DistroC', '重探结果必须覆盖旧结论');

  const after = detectDefaultDistroCached(() => okRes(table('DistroD')));
  assert.equal(after.distro, 'DistroD', 'refreshAutoTarget 必须清缓存（否则这里会读到旧结论 DistroA）');
  resetTargetDetection();
});

test('refreshAutoTarget：纯显式配置不探测、也不清进程缓存（S2-3 回归）', () => {
  resetTargetDetection();
  // 先放一个"旧缓存"进去：如果显式配置也清缓存，下面就会重新探测并返回 FreshProbe。
  assert.equal(detectDefaultDistroCached(() => okRes(table('CachedDistro'))).distro, 'CachedDistro');

  const boom = () => {
    throw new Error('纯显式配置不该发生探测');
  };
  const cfg = normalizeConfig({ distro: 'Debian', wslHome: '/home/d', cwd: '/work' }, { probe: boom });
  const r = refreshAutoTarget(cfg, { probe: boom });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.auto, false, '纯显式配置必须标成 auto:false（供输出措辞用）');
  assert.equal(r.changed, false);
  assert.equal(cfg.distro, 'Debian');
  assert.equal(cfg.wslHome, '/home/d');
  assert.equal(cfg.cwd, '/work');

  const after = detectDefaultDistroCached(() => okRes(table('FreshProbe')));
  assert.equal(after.distro, 'CachedDistro', '显式配置不该清缓存（被清的话这里会返回 FreshProbe）');
  resetTargetDetection();
});
