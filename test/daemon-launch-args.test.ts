/**
 * daemon-launch 启动参数回归（2026-10-28）。
 *
 * 为什么要有这条：`provider` / `model` 是 `config.ts` DEFAULTS 里的**用户可见配置**，
 * 但 daemon 后端曾经**从不把它们传给 `dsh`** —— 守护用自己 `--provider`/`--model` 的默认值
 * （`deepseek-official` / `deepseek-flash`），于是这两个配置项在默认后端上形同虚设：
 * 用户把 provider 改成别的网关，`wsl_agent` 仍然去打 DeepSeek 官方并报 401。
 * 这是"配置项写了、执行路径没接线"的经典形态，只用端到端很难发现（默认值恰好能跑）。
 *
 * 这里锁三件事：
 *  1. 用户配的 provider/model 真的出现在启动脚本里（不是硬编码默认值）；
 *  2. 缺省时不省略参数（显式回落到与 daemon.ts 一致的默认值）；
 *  3. 带 `/` 的模型 id 被引号包住（shell 不会把它拆开 / 不会变成路径）。
 *
 * 运行：`node --experimental-strip-types --test test/*.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchScript } from '../src/daemon-launch.ts';

const cfgs = (extra = {}) => ({
  wslHome: '/home/g',
  cwd: '/home/g',
  profile: 'sdk',
  proxyPort: 9910,
  ...extra,
});

test('launchScript：用户配置的 provider/model 必须出现在守护启动参数里', () => {
  const s = launchScript(
    cfgs({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash-fast' }),
    8731,
    '0.2.1-rc.3',
  );
  assert.match(s, /--provider "commandcode"/);
  assert.match(s, /--model "deepseek\/deepseek-v4\.1-flash-fast"/);
  // 反例守卫：不能只把默认值写死（否则上面两条在默认配置下也会"通过"）
  assert.doesNotMatch(s, /--model "deepseek-flash"/);
});

test('launchScript：缺省时显式回落到 deepseek-official / deepseek-flash', () => {
  const s = launchScript(cfgs(), 8731, '0.2.1-rc.3');
  assert.match(s, /--provider "deepseek-official"/);
  assert.match(s, /--model "deepseek-flash"/);
});

test('launchScript：带斜杠的模型 id 被引号包住（不被 shell 拆开）', () => {
  const s = launchScript(cfgs({ model: 'a/b/c' }), 8731, '0.2.1-rc.3');
  assert.match(s, /--model "a\/b\/c"/);
  // 未加引号的形态会命中这条守卫
  assert.doesNotMatch(s, /--model a\/b\/c/);
});

test('launchScript：provider/model 与 daemon.ts 的 arg 名严格一致（拼错就静默用默认值）', () => {
  const s = launchScript(cfgs({ provider: 'p', model: 'm' }), 8731, '0.2.1-rc.3');
  assert.match(s, /--provider "p"/);
  assert.match(s, /--model "m"/);
  // daemon.ts 里是 arg('provider') / arg('model')；换成 --prov/--mdl 之类的别名会读不到
  assert.doesNotMatch(s, /--prov\s/);
  assert.doesNotMatch(s, /--mdl\s/);
});
