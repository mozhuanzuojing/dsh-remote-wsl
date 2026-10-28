/**
 * 「目标未解析」时**关键入口必须给根因、不许制造伪成功**的回归锁（2026-10-28 评审 B2）。
 *
 * 为什么单独一个文件：`test/target-detect.test.ts` 只钉探测与文案（纯函数层），而这些守卫在
 * 工具/守护/provider 层 —— 它们才是这次改动**真正防止回归**的地方：
 *   · `stopDaemon` 曾经会因为"读不到元数据"返回 `alreadyStopped: true`（伪成功，不是"没有守护"）；
 *   · `daemonSnapshot` 曾经会因为"扫不出东西"给出"没有守护"（把未验证当结论）；
 *   · `daemonStatus` / `wsl_daemon action=status` 曾经把"没扫过"输出成 `not running`，还会打印
 *     `/.dsh/remote-wsl` 这种**伪造路径**；
 *   · `runWsl` 契约是**永不抛**，所以必须用 exit 127 + 可读原因表达。
 *
 * 全部用例**离线**：目标为空 ⇒ 守卫在 spawn 之前就返回（每个 0–2ms，不起 wsl.exe）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, normalizeConfig, resetTargetDetection, targetProblem } from '../src/config.ts';
import { runWsl, writeScript, wslPathConvert } from '../src/wsl-io.ts';
import { daemonSnapshot, daemonStatus, ensureDaemon, stopDaemon } from '../src/daemon-client.ts';
import { createWslRpc } from '../src/fs-provider.ts';
import { createExplorerHandlers } from '../src/explorer.ts';
import { registerTools } from '../src/register-tools.ts';

/**
 * `distro` / `wslHome` / `cwd` 全空 = 目标未解析（任何探测都不会发生）。
 *
 * ⚠️ 只对**不经过 `normalizeConfig()`** 的入口成立：`normalizeConfig()` 会按需自动探测，而本机
 * 装了 WSL 就能探到 —— 那些入口要先让探测失败（见 `withoutWsl()`）。
 */
const EMPTY = { ...DEFAULTS };
/** 所有可操作报错都必须指向"去哪配"。 */
const EXPECT = /cordis\.patch\.yml/;

/**
 * 让 `wsl.exe` 探测**确定性地**失败：清空 `PATH`（Windows 与 Linux 上都找不到 wsl.exe），
 * 并清掉进程内探测缓存。用完必须还原（连同缓存），否则同进程后续用例会拿到假的"探测失败"结论。
 * @template T
 * @param fn 在"没有 wsl.exe"的环境里要执行的动作
 * @returns `fn()` 的返回值
 */
function withoutWsl(fn) {
  const savedPath = process.env.PATH;
  resetTargetDetection();
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
    resetTargetDetection();
  }
}

test('守卫：空目标给出可操作说明（后续所有用例的前提）', () => {
  const problem = targetProblem(EMPTY);
  assert.match(problem, /^remote-wsl: /);
  assert.match(problem, EXPECT);
});

test('writeScript：空发行版 ⇒ 明确根因，而不是 UNC 层的不可诊断 errno', () => {
  assert.throws(
    () => writeScript('', 'echo hi'),
    (e) => {
      assert.match(e.message, EXPECT);
      assert.match(e.message, /未能自动探测到 WSL 默认发行版/);
      return true;
    },
  );
});

test('runWsl：空目标 ⇒ exit 127 + 可读原因，**不抛**（本函数契约）', async () => {
  const res = await runWsl(EMPTY, 'echo hi');
  assert.equal(res.exitCode, 127);
  assert.equal(res.killedBy, null);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, EXPECT);
});

test('wslPathConvert：空目标 ⇒ 抛可操作错误，不去 spawn wsl.exe -d ""', () => {
  assert.throws(
    () => wslPathConvert(EMPTY, 'C:\\tmp\\x', 'both'),
    (e) => {
      assert.match(e.message, EXPECT);
      return true;
    },
  );
});

test('stopDaemon：空目标 ⇒ ok:false（**不许**伪成功 alreadyStopped）', async () => {
  const r = await stopDaemon(EMPTY, { log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.alreadyStopped, undefined); // ← 旧实现会在这里给出伪成功
  assert.equal(r.verified, false);
  assert.match(String(r.error), EXPECT);
});

test('stopDaemon all=true：同样不许把"没扫过"说成"没有"', async () => {
  const r = await stopDaemon(EMPTY, { log: () => {}, all: true });
  assert.equal(r.ok, false);
  assert.match(String(r.error), EXPECT);
});

test('daemonSnapshot：空目标 ⇒ 显式"未扫描"，不是"0 个守护 / 0 个孤儿"', async () => {
  const snap = await daemonSnapshot(EMPTY);
  assert.equal(snap.scan.ok, false);
  assert.equal(snap.orphansVerified, false);
  assert.deepEqual(snap.slots, []);
  assert.deepEqual(snap.orphans, []);
  assert.match(String(snap.scan.error), /目标发行版未确定/);
});

test('daemonStatus：空目标 ⇒ kind=no-target（与"确实没有守护"分开）', async () => {
  const s = await daemonStatus(EMPTY);
  assert.equal(s.ok, false);
  assert.equal(s.kind, 'no-target');
  assert.match(String(s.error), EXPECT);
});

test('ensureDaemon：空目标 ⇒ 抛可操作错误（状态目录与 wsl -d 都无处可去）', async () => {
  await assert.rejects(
    () => ensureDaemon(EMPTY, { version: '0.3.3', log: () => {} }),
    (e) => {
      assert.match(e.message, EXPECT);
      return true;
    },
  );
});

test('fs provider RPC：探测失败 ⇒ 首次调用即拒绝（不是「只服务 ""」的伪错误）', async () => {
  // 这条必须让探测真的失败：`createWslRpc` 内部走 `normalizeConfig()`，本机有 WSL 时会探到目标。
  const rpc = withoutWsl(() => createWslRpc(EMPTY));
  await assert.rejects(
    () => rpc.ensure(),
    (e) => {
      assert.match(String(e.message), EXPECT);
      return true;
    },
  );
});

test('探测失败（没有 wsl.exe）⇒ 配置里是空目标 + 可操作报错，工具层据此拒绝（评审 B1 的场景）', async () => {
  const cfg = withoutWsl(() => normalizeConfig({}));
  assert.equal(cfg.distro, '');
  assert.equal(cfg.wslHome, '');
  assert.equal(cfg.cwd, '');
  assert.match(targetProblem(cfg), EXPECT);

  const { byName } = toolsWith(cfg);
  const statusOut = String(await byName('wsl_status').execute({}, {}));
  assert.match(statusOut, /target ⚠️: remote-wsl: /);
  const daemonOut = String(await byName('wsl_daemon').execute({ action: 'status' }, {}));
  assert.match(daemonOut, EXPECT);
  assert.doesNotMatch(daemonOut, /daemon: not running/);
  assert.doesNotMatch(daemonOut, /\/\.dsh\/remote-wsl/);
});

test('面板数据面：空目标 ⇒ E_ARG + reason=no-distro（客户端按 reason 分支）', async () => {
  const { handlers } = createExplorerHandlers({
    config: EMPTY,
    listDistros: () => [],
    listDistrosAsync: async () => [],
    resolveVersion: () => ({ version: '0.3.3', desktopVersion: '0.3.3', pin: null, drift: null }),
    writePin: () => true,
    webHosts: new Map(),
  });
  await assert.rejects(
    () => handlers['explorer.snapshot']({}),
    (e) => {
      assert.equal(e.code, 'E_ARG');
      assert.equal(e.reason, 'no-distro');
      assert.match(e.message, EXPECT);
      return true;
    },
  );
});

/** 用最小 deps 真注册七个工具（与 index.ts 的接线同形，只是把会起进程的依赖换成桩）。 */
function toolsWith(config, overrides = {}) {
  const tools = [];
  const registry = { register: (tool) => tools.push(tool) };
  const ctx = { inject: (_deps, cb) => cb({ get: () => registry }) };
  registerTools({
    ctx,
    config,
    version: { version: '0.3.3' },
    resolveVersion: () => ({ version: '0.3.3', desktopVersion: '0.3.3', pin: null, drift: null }),
    daemonState: { info: null, port: null, notes: [], collisions: [], lastSessionByKey: new Map() },
    logDaemon: () => {},
    machineLine: () => 'machine: slot=- pid=- port=- version=-',
    // 目标为空时这些**一个都不该被调用**；真被调用就说明守卫漏了 ⇒ 让测试响亮地失败。
    ensureDaemonReady: () => {
      throw new Error('目标为空时不该走到 ensureDaemonReady');
    },
    isTransportFailure: () => false,
    priorSessionFor: () => null,
    listDistros: () => [],
    listDistrosAsync: async () => [],
    getRuntime: () => null,
    runtimes: new Map(),
    webHosts: new Map(),
    ensureSwept: async () => {},
    warmInBackground: () => {
      throw new Error('目标为空时不该触发后台预热');
    },
    ...overrides,
  });
  const byName = (name) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `没有注册 ${name}（有 ${tools.map((t) => t.name).join(', ')}）`);
    return tool;
  };
  return { tools, byName };
}

test('wsl_status：空目标 ⇒ target ⚠️ + 跳过探测 + 不伪造 state dir 路径', async () => {
  const { byName } = toolsWith(EMPTY);
  const out = String(await byName('wsl_status').execute({}, {}));
  assert.match(out, /target ⚠️: remote-wsl: /);
  assert.match(out, /（跳过：目标发行版未确定 ⇒ 未检查守护/);
  assert.match(out, /pid files in WSL \/tmp: \(跳过：目标发行版未确定\)/);
  assert.match(out, /daemon state dir \(WSL\): \(未解析：wslHome 未确定\)/);
  assert.doesNotMatch(out, /\/\.dsh\/remote-wsl/, '不存在的状态目录不许被打出来让用户复制');
  assert.doesNotMatch(out, /target auto-detected/);
});

test('wsl_daemon status/stop：空目标 ⇒ 直接回根因（不报 not running、不提 stop all）', async () => {
  const { byName } = toolsWith(EMPTY);
  const daemon = byName('wsl_daemon');
  for (const action of ['status', 'stop']) {
    const out = String(await daemon.execute({ action }, {}));
    assert.match(out, EXPECT, `action=${action}`);
    assert.doesNotMatch(out, /daemon: not running/, `action=${action} 不许给出未扫描的结论`);
    assert.doesNotMatch(out, /stop all=true 收尾/, `action=${action} 不许给出无用的补救建议`);
    assert.doesNotMatch(out, /\/\.dsh\/remote-wsl/, `action=${action} 不许伪造路径`);
  }
});

test('wsl_sync_version：空目标 ⇒ 不泄漏内部不变量（不出现 cfg.wslHome 为空）', async () => {
  const { byName } = toolsWith(EMPTY);
  const out = String(await byName('wsl_sync_version').execute({}, {}));
  assert.match(out, EXPECT);
  assert.doesNotMatch(out, /cfg\.wslHome/);
  assert.doesNotMatch(out, /write failed/);
});

test('wsl_exec：空目标 ⇒ 工具正常返回文本（exit 127 + 可读原因），不炸', async () => {
  const { byName } = toolsWith(EMPTY);
  const out = String(await byName('wsl_exec').execute({ command: 'echo hi' }, {}));
  assert.match(out, EXPECT);
  assert.match(out, /127/);
});

// ── A-P2-E（2026-10-28 复核补修）：会话内重新探测的**工具接线** ─────────────────

test('wsl_status({redetect:true})：触发注入的重探并如实回报；无参调用不重探、只给提示', async () => {
  const cfg = withoutWsl(() => normalizeConfig({}));
  let calls = 0;
  const stubFailure = {
    ok: false,
    problem: 'remote-wsl: 重新探测仍失败（测试桩）：请在 cordis.patch.yml 里显式配置 distro',
    notes: [],
    previous: { distro: '', wslHome: '', cwd: '' },
    current: { distro: '', wslHome: '', cwd: '' },
    changed: false,
    auto: true,
  };
  const { byName } = toolsWith(cfg, {
    redetectTarget: () => {
      calls++;
      return stubFailure;
    },
  });

  const plain = String(await byName('wsl_status').execute({}, {}));
  assert.equal(calls, 0, '不传 redetect 时绝不许探测（状态查询必须保持只读/廉价）');
  assert.doesNotMatch(plain, /^redetect: /m, '无参调用不许出现"已重探"的结果行');
  assert.match(plain, /hint: 目标未解析时可调用 `wsl_status\(\{ redetect: true \}\)`/, '失败时必须给出会话内重试入口');

  const out = String(await byName('wsl_status').execute({ redetect: true }, {}));
  assert.equal(calls, 1, 'redetect:true 必须真的调用重探');
  assert.match(out, /^redetect: ⚠️ 重新探测仍失败：remote-wsl: 重新探测仍失败（测试桩）/m);
  assert.doesNotMatch(out, /hint: 目标未解析时/, '已经重探过就不该再重复同一条提示');
});

test('wsl_daemon status：空目标 ⇒ 根因旁直接给出会话内重试入口（A-P2-E）', async () => {
  const { byName } = toolsWith(EMPTY);
  const out = String(await byName('wsl_daemon').execute({ action: 'status' }, {}));
  assert.match(out, EXPECT);
  assert.match(out, /wsl_status\(\{ redetect: true \}\)/, '不能只说"去改配置/重启"，要给出会话内可执行的动作');
});
