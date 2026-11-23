/**
 * `explorer.redetect()` —— 面板失败自愈（A+B）的后端能力（2026-11-23）。
 *
 * 背景（真缺陷，用户实测）：WSL 冷启动时宿主启动路径里的 `$HOME` 同步探测超时（10s）失败，
 * 结论被**冻结进进程配置** ⇒ 侧栏「远程资源管理器」整程报「读取远程资源失败」，且面板「重试」
 * 只重取 snapshot、**不会重新探测**（`refresh` 只清发行版/代理缓存），自愈不了。
 *
 * 修法：host 暴露 `explorer.redetect()`，复用 `refreshAutoTarget()` 原地更新 live cfg；
 * 客户端在 `no-distro` / `no-wsl-home` 失败时调它（自动 + 手动）。这里锁：
 *   · 方法进 `EXPLORER_METHODS` 且 handler 可调；
 *   · **显式配置**（distro+wslHome 都写死）时 `auto:false`、**不发起真实探测**（离线 0 副作用）；
 *   · 成功/失败/异常三种返回形状（ok / problem / target），供面板据此决定是否重载；
 *   · 重探结果**原地写回 cfg**（面板随后的 snapshot 读的就是新值）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.ts';
import { createExplorerHandlers, EXPLORER_METHODS } from '../src/explorer.ts';

/** 显式配置：distro+wslHome 都写死 ⇒ `refreshAutoTarget` 不探测、不改值，离线可测。 */
const explicitCfg = () => normalizeConfig({ distro: 'TestDistro', wslHome: '/home/u', cwd: '/home/u' });

test('EXPLORER_METHODS 含 explorer.redetect，且 handler 可调', () => {
  assert.ok(EXPLORER_METHODS.includes('explorer.redetect'), '方法表缺 explorer.redetect');
  const { handlers } = createExplorerHandlers({ config: explicitCfg() });
  assert.equal(typeof handlers['explorer.redetect'], 'function');
});

test('redetect：显式配置 ⇒ auto:false、ok:true、不探测、target 原样', async () => {
  const cfg = explicitCfg();
  const { handlers } = createExplorerHandlers({ config: cfg });
  const r = await handlers['explorer.redetect']({});
  assert.equal(r.ok, true);
  assert.equal(r.auto, false, '显式配置不应发起自动探测');
  assert.equal(r.target.distro, 'TestDistro');
  assert.equal(r.target.wslHome, '/home/u');
  assert.equal(r.target.cwd, '/home/u');
  // 显式配置下 refreshAutoTarget 不改变值
  assert.equal(cfg.distro, 'TestDistro');
});

test('redetect：注入 redetectTarget 成功 ⇒ 形状透传 + 结果原地写回 cfg', async () => {
  const cfg = explicitCfg();
  const { handlers } = createExplorerHandlers({
    config: cfg,
    // 模拟一次"探测成功且换了目标"：把结果写回 cfg（与 refreshAutoTarget 的原地更新同语义）
    redetectTarget: () => {
      cfg.distro = 'FoundDistro';
      cfg.wslHome = '/home/found';
      cfg.cwd = '/home/found';
      return {
        ok: true,
        problem: null,
        notes: ['probed'],
        previous: { distro: '', wslHome: '', cwd: '' },
        current: { distro: 'FoundDistro', wslHome: '/home/found', cwd: '/home/found' },
        changed: true,
        auto: true,
      };
    },
  });
  const r = await handlers['explorer.redetect']({});
  assert.equal(r.ok, true);
  assert.equal(r.auto, true);
  assert.equal(r.changed, true);
  assert.deepEqual(r.notes, ['probed']);
  assert.equal(r.target.distro, 'FoundDistro', 'target 必须读重探后的 cfg（原地更新）');
  assert.equal(r.target.wslHome, '/home/found');
});

test('redetect：探测仍失败 ⇒ ok:false + problem（不抛）', async () => {
  const { handlers } = createExplorerHandlers({
    config: explicitCfg(),
    redetectTarget: () => ({ ok: false, problem: 'remote-wsl: 读不到 $HOME', notes: [], previous: null, current: null, changed: false, auto: true }),
  });
  const r = await handlers['explorer.redetect']({});
  assert.equal(r.ok, false);
  assert.match(r.problem, /读不到 \$HOME/);
});

test('redetect：redetectTarget 抛异常 ⇒ ok:false 且归一成 problem（绝不把异常冒给面板）', async () => {
  const { handlers } = createExplorerHandlers({
    config: explicitCfg(),
    redetectTarget: () => {
      throw new Error('boom');
    },
  });
  const r = await handlers['explorer.redetect']({});
  assert.equal(r.ok, false);
  assert.match(r.problem, /重新探测异常/);
  assert.match(r.problem, /boom/);
});
