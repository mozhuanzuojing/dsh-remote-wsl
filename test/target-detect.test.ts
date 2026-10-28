/**
 * 零配置目标探测的回归测试（2026-10-28）。
 *
 * 为什么值得测：`distro` / `wslHome` 的默认值曾经写死作者机器上的 `debian-u8-1` / `/home/g`
 * —— 换一台机器装上插件，第一条命令就报「未知发行版」。修法是「空 = 自动探测」，而探测逻辑
 * 有三个必须钉死的边界：
 *   1. **只认 `wsl -l -v` 里带 `*` 的行**：没有 `*` 就留空并明确报错，不许挑"唯一那个"猜；
 *   2. 探测失败**不许回落到任何写死的值**（那正是被修掉的缺陷形态：静默猜）；
 *   3. 显式配置**一个 wsl.exe 都不许起**（否则每次启动白付 150-300ms，且会拉起未运行的发行版）。
 *
 * 全部用例用**假 probe**驱动，不依赖本机装没装 WSL（CI 是 ubuntu-latest，没有 wsl.exe）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWslDistroTable } from '../src/distro-table.ts';
import {
  asConfigText,
  detectDefaultDistro,
  detectDistroHome,
  NO_DISTRO_MESSAGE,
  NO_HOME_REASON,
  NO_DISTRO_REASON,
  noHomeMessage,
  pickHome,
  resolveAutoTarget,
  wsl1Message,
} from '../src/target-detect.ts';
import { DEFAULTS, configDetection, normalizeConfig, targetProblem, targetProblemFrom, assertConfigTarget } from '../src/config.ts';

/** `wsl.exe -l -v` 的真实形态：UTF-16LE、CRLF、表头。 */
const TABLE = [
  '  NAME            STATE           VERSION',
  '* Ubuntu-24.04    Running         2',
  '  Debian          Stopped         2',
  '',
].join('\r\n');

const TABLE_NO_DEFAULT = ['  NAME            STATE           VERSION', '  Debian          Stopped         2', ''].join('\r\n');

/** 造一个假运行器，并记录它被怎么调用（用来断言"显式配置不探测"）。 */
function fakeProbe(handler) {
  const calls = [];
  const probe = (args, timeoutMs) => {
    calls.push({ args: [...args], timeoutMs });
    return handler(args, timeoutMs);
  };
  return { probe, calls };
}

const ok = (text) => ({ status: 0, stdout: Buffer.from(String(text), 'utf16le'), stderr: Buffer.alloc(0), error: null });
const fail = (status, stderr = '') => ({ status, stdout: Buffer.alloc(0), stderr: Buffer.from(String(stderr), 'utf8'), error: null });

/** 同时处理 `-l -v` 与 `$HOME` 两种调用的假运行器。 */
function wslProbe({ table = TABLE, home = '/home/alice', homeStatus = 0, homeShells = null } = {}) {
  return fakeProbe((args) => {
    if (args[0] === '-l') return ok(table);
    const shell = args[3];
    if (Array.isArray(homeShells) && !homeShells.includes(shell)) return fail(127, `sh: command not found: ${shell}`);
    return homeStatus === 0 ? ok(home) : fail(homeStatus, 'login failed');
  });
}

test('distro-table：单空格名字、* 前缀、表头行', () => {
  const rows = parseWslDistroTable(
    ['  NAME                   STATE           VERSION', '* Ubuntu 22.04 LTS      Running         2', '  Debian                 Stopped         2'].join('\n'),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'Ubuntu 22.04 LTS', isDefault: true, state: 'Running', version: 2 });
  assert.equal(rows[1].isDefault, false);
});

test('探测：UTF-16LE 里带 * 的发行版 + 它的 $HOME（成功路径不起真进程）', () => {
  const { probe, calls } = wslProbe();
  const r = resolveAutoTarget({}, { probe });
  assert.equal(r.distro, 'Ubuntu-24.04');
  assert.equal(r.wslHome, '/home/alice');
  assert.equal(r.problem, null);
  // 一次列表 + 一次 $HOME（sh 就成功，不试 bash）
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['-l', '-v']);
  assert.deepEqual(calls[1].args, ['-d', 'Ubuntu-24.04', '--exec', 'sh', '-c', 'printf %s "$HOME"']);
  assert.ok(r.notes.some((n) => n.includes('Ubuntu-24.04')), JSON.stringify(r.notes));
});

test('探测：没有 * 行 ⇒ 留空并给可操作报错（不挑"唯一那个"猜）', () => {
  const { probe } = wslProbe({ table: TABLE_NO_DEFAULT });
  const r = resolveAutoTarget({}, { probe });
  assert.equal(r.distro, '');
  assert.equal(r.wslHome, '');
  assert.equal(r.problem, NO_DISTRO_MESSAGE);
  // 报错必须说清去哪配（否则用户只会看到一堆失败的 WSL 调用）
  assert.match(r.problem, /cordis\.patch\.yml/);
  assert.match(r.problem, /distro/);
});

test('探测：wsl.exe 不可用（spawnSync 的 ENOENT）⇒ 留空 + 同一条可操作报错', () => {
  const { probe } = fakeProbe(() => ({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: { code: 'ENOENT', message: 'spawnSync wsl.exe ENOENT' } }));
  const table = detectDefaultDistro(probe);
  assert.equal(table.distro, '');
  assert.equal(table.problem, NO_DISTRO_MESSAGE);
  assert.ok(table.notes.some((n) => n.includes('ENOENT')), JSON.stringify(table.notes));
});

test('探测：wsl -l -v 超时 ⇒ 报"超时"而不是"没有默认发行版"（启动日志只有这一行）', () => {
  const { probe } = fakeProbe(() => ({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: { code: 'ETIMEDOUT', message: 'spawnSync wsl.exe ETIMEDOUT' } }));
  const table = detectDefaultDistro(probe);
  assert.equal(table.distro, '');
  assert.match(table.problem, /超时/);
  assert.match(table.problem, /8000ms/);
  assert.doesNotMatch(table.problem, /未能自动探测到 WSL 默认发行版/);
});

test('探测：默认发行版是 WSL1 ⇒ 明确拒绝并给出升级命令', () => {
  const table = ['  NAME    STATE     VERSION', '* Legacy  Stopped   1'].join('\n');
  const { probe } = wslProbe({ table });
  const r = resolveAutoTarget({}, { probe });
  assert.equal(r.distro, '');
  assert.equal(r.problem, wsl1Message('Legacy'));
  assert.match(r.problem, /wsl --set-version Legacy 2/);
});

test('探测：$HOME 不是绝对路径/含空白 ⇒ 不当作家目录（不猜）', () => {
  for (const home of ['', 'home/alice', '/home/al ice', '$HOME']) {
    const { probe } = wslProbe({ home });
    const r = resolveAutoTarget({}, { probe });
    assert.equal(r.distro, 'Ubuntu-24.04', `home=${JSON.stringify(home)} 时发行版仍应探测到`);
    assert.equal(r.wslHome, '', `home=${JSON.stringify(home)} 必须按失败处理`);
    assert.equal(r.problem, noHomeMessage('Ubuntu-24.04'));
  }
});

test('pickHome：去尾斜杠、根目录保留、CR/NUL 清洗', () => {
  assert.equal(pickHome('/home/alice/\r\n'), '/home/alice');
  assert.equal(pickHome('/'), '/');
  // NUL 是 `wsl.exe` 输出的常见噪声（UTF-16LE 按 utf8 读的产物）⇒ 清洗后仍是合法家目录
  assert.equal(pickHome('/home\0/alice'), '/home/alice');
  assert.equal(pickHome('  /root  '), '/root');
});

test('探测：sh 不可用时回退 bash', () => {
  const { probe, calls } = wslProbe({ homeShells: ['bash'] });
  const r = detectDistroHome(probe, 'Ubuntu-24.04');
  assert.equal(r.home, '/home/alice');
  assert.deepEqual(calls.map((c) => c.args[3]), ['sh', 'bash']);
});

test('探测：wsl.exe 起不来/超时 ⇒ 不再换 bash 重试（探一次就停，别把启动阻塞翻倍）', () => {
  const { probe, calls } = fakeProbe(() => ({
    status: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: { code: 'ETIMEDOUT', message: 'spawnSync wsl.exe ETIMEDOUT' },
  }));
  const r = detectDistroHome(probe, 'Ubuntu-24.04');
  assert.equal(r.home, '');
  assert.equal(r.problem, noHomeMessage('Ubuntu-24.04'));
  assert.equal(calls.length, 1, '起不来是"整个 wsl.exe 不可用"，换 shell 没有意义');
});

test('探测：shell 正常退出但输出不合法 ⇒ 也不再换 bash 重试', () => {
  const { probe, calls } = fakeProbe(() => ({ status: 0, stdout: Buffer.from('not-a-path', 'utf8'), stderr: Buffer.alloc(0), error: null }));
  const r = detectDistroHome(probe, 'Ubuntu-24.04');
  assert.equal(r.home, '');
  assert.equal(calls.length, 1);
  assert.ok(r.notes.some((n) => n.includes('绝对路径')), JSON.stringify(r.notes));
});

test('显式配置优先：两项都给了就一个 wsl.exe 都不起', () => {
  const { probe, calls } = wslProbe();
  const r = resolveAutoTarget({ distro: 'Debian', wslHome: '/home/deb' }, { probe });
  assert.deepEqual([r.distro, r.wslHome, r.problem], ['Debian', '/home/deb', null]);
  assert.equal(calls.length, 0, '显式配置不得触发任何探测');
});

test('只缺 wslHome：只问 $HOME，不再问默认发行版', () => {
  const { probe, calls } = wslProbe();
  const r = resolveAutoTarget({ distro: 'Debian' }, { probe });
  assert.deepEqual([r.distro, r.wslHome], ['Debian', '/home/alice']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), ['-d', 'Debian', '--exec', 'sh']);
});

test('asConfigText：`auto` 与空白都算"自动"，非字符串不炸', () => {
  for (const value of ['', '   ', 'auto', 'AUTO', undefined, null, 42, {}, []]) {
    assert.equal(asConfigText(value), '', String(value));
  }
  assert.equal(asConfigText(' Debian '), 'Debian');
});

test('normalizeConfig：默认值里不含作者机器的路径（缺陷形态不许回潮）', () => {
  assert.equal(DEFAULTS.distro, '');
  assert.equal(DEFAULTS.wslHome, '');
  assert.equal(DEFAULTS.cwd, '');
});

test('normalizeConfig：显式配置原样保留、cwd 跟随 wslHome、且不带探测结论', () => {
  const c = normalizeConfig({ distro: 'Debian', wslHome: '/home/deb' });
  assert.equal(c.distro, 'Debian');
  assert.equal(c.wslHome, '/home/deb');
  assert.equal(c.cwd, '/home/deb', 'cwd 空时应跟随 wslHome');
  assert.equal(configDetection(c), null, '显式配置不该写入探测结论（也不该探测）');
  // 显式配置齐全 ⇒ 目标可用
  assert.equal(targetProblem(c), null);
  assert.equal(assertConfigTarget(c), c);
});

test('normalizeConfig：显式配置不继承别的配置的探测结论（回归：启动日志/状态张冠李戴）', () => {
  // 先自动探测一次（用假 probe ⇒ CI/本机行为一致；探测成不成功都不影响下面的断言）
  normalizeConfig({}, { probe: wslProbe().probe });
  const explicit = normalizeConfig({ distro: 'no-such-distro-xyz', wslHome: '/home/nope' });
  assert.equal(configDetection(explicit), null, '显式配置必须没有"自动探测"的结论');
  assert.equal(targetProblem(explicit), null, '显式配齐两项 ⇒ 目标判据必须说"可用"');
});

test('探测结论跟着 {...cfg} 转发，但子插件重算时不会被当成自己的（preset 那条路）', () => {
  // 这条**必须**用假 probe：真探测在 CI（没有 wsl.exe）会失败、在本机会成功，
  // 断言就会随机器变 —— 2026-10-28 的 CI 红就是这么来的。
  const { probe } = wslProbe();
  const auto = normalizeConfig({}, { probe });
  assert.equal(auto.distro, 'Ubuntu-24.04');
  assert.equal(auto.wslHome, '/home/alice');
  assert.ok(configDetection(auto), '自动探测路径必须带结论（wsl_status 靠它说明来源）');
  // preset 把解析好的配置 `{...cfg}` 转发给子插件；子插件重算时两项都已显式 ⇒ 不探测、不带结论
  const sub = normalizeConfig({ ...auto });
  assert.equal(configDetection(sub), null, '转发来的配置已经解析过 ⇒ 不算"自动探测"');
  assert.equal(sub.distro, 'Ubuntu-24.04');
  assert.equal(sub.wslHome, '/home/alice');
});

test('normalizeConfig：显式 cwd 不被覆盖', () => {
  const c = normalizeConfig({ distro: 'Debian', wslHome: '/home/deb', cwd: '/work' });
  assert.equal(c.cwd, '/work');
});

test('normalizeConfig：探测成功 ⇒ 目标齐全、cwd 跟随 wslHome（假 probe，与本机无关）', () => {
  const c = normalizeConfig({}, { probe: wslProbe().probe });
  assert.equal(c.distro, 'Ubuntu-24.04');
  assert.equal(c.wslHome, '/home/alice');
  assert.equal(c.cwd, '/home/alice', 'cwd 空时应跟随自动探测出的 wslHome');
  assert.equal(targetProblem(c), null);
});

test('normalizeConfig：探测失败 ⇒ 留空 + 可操作报错，绝不静默（假 probe，与本机无关）', () => {
  const { probe } = fakeProbe(() => ({
    status: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: { code: 'ENOENT', message: 'no wsl.exe in this test' },
  }));
  const c = normalizeConfig({}, { probe });
  assert.equal(c.distro, '');
  assert.equal(c.wslHome, '');
  assert.equal(c.cwd, '');
  const problem = targetProblem(c);
  assert.match(problem, /^remote-wsl: /);
  assert.match(problem, /cordis\.patch\.yml/);
  assert.ok(configDetection(c), '失败结论也要留在配置上（wsl_status/启动日志要能解释原因）');
});

test('targetProblemFrom：精确文案只在"结论与配置对得上"时使用', () => {
  const wsl1 = { distro: '', problem: 'remote-wsl: 默认发行版 "L" 是 WSL1' };
  assert.equal(targetProblemFrom({ distro: '', wslHome: '' }, wsl1), wsl1.problem);
  // 配置里有发行版、只是缺家目录 ⇒ 用那条 home 结论（distro 相同）
  const noHome = { distro: 'Debian', problem: 'remote-wsl: 读不到 Debian 的 $HOME' };
  assert.equal(targetProblemFrom({ distro: 'Debian', wslHome: '' }, noHome), noHome.problem);
  // 结论属于别的 distro ⇒ 不复用，退回通用文案
  assert.equal(targetProblemFrom({ distro: 'Ubuntu', wslHome: '' }, noHome), noHomeMessage('Ubuntu'));
  // 没有结论 ⇒ 通用文案
  assert.equal(targetProblemFrom({ distro: '', wslHome: '' }, null), NO_DISTRO_MESSAGE);
  assert.equal(targetProblemFrom({ distro: 'Ubuntu', wslHome: '' }, null), noHomeMessage('Ubuntu'));
  assert.equal(targetProblemFrom({ distro: 'Ubuntu', wslHome: '/home/u' }, null), null);
});

test('assertConfigTarget：目标不可用时抛可操作错误', () => {
  assert.throws(() => assertConfigTarget({ distro: '', wslHome: '' }), (e) => {
    assert.match(e.message, /^remote-wsl: /);
    assert.match(e.message, /distro/);
    return true;
  });
});

test('失败原因码是稳定的机器可读字面量（面板/客户端按它分支）', () => {
  assert.equal(NO_DISTRO_REASON, 'no-distro');
  assert.equal(NO_HOME_REASON, 'no-wsl-home');
});
