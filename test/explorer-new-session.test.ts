/**
 * P2 回归锁：面板「在此目录/在此目录新建会话」必须落 **WSL preset**（`agentPreset:'wsl'`），
 * 且**旧宿主不认这个字段时**降级可控、事实可见（禁止静默吞掉，也禁止把"请求过"说成"已应用"）。
 *
 * 为什么锁在 host 数据面（`createExplorerHandlers` 的 `explorer.newSession`）而不是 client chunk：
 *   · preset 就在这一层交给宿主（`sessionController.create({..., agentPreset})`，契约见
 *     `src/explorer.ts` 的 `newSession` 注释）；
 *   · client 只消费返回体里的 `presetApplied` / `agentPreset` / `presetError` 事实字段 ——
 *     这几条字段一旦改名/丢字段，面板就会退回"让人以为已是 WSL 世界"的旧行为，所以用返回体锁死。
 *
 * 全部用例**离线**：`distro` 用配置值（`debian`）、发行版事实由注入的 `listDistros` / `distroStateProbe`
 * 提供 ⇒ 不 spawn `wsl.exe`、不碰真实发行版、不写任何文件。
 *
 * 变异验证（删实现 ⇒ 变红）：
 *   · 把 `agentPreset: WSL_PRESET_ID` 从 `ctl.create` 的入参里删掉 ⇒ 用例 1/2/3/4 全红；
 *   · 把 `isPresetRejection` 的降级分支删掉（直接 `failUnavailable`）⇒ 用例 3/6 红；
 *   · 把 `presetApplied: applied === WSL_PRESET_ID` 改成恒 `true` ⇒ 用例 4 红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.ts';
import { createExplorerHandlers } from '../src/explorer.ts';

/** 已解析的目标（`distro` + `wslHome` 都有值 ⇒ `targetProblem()` 为 null，`resolveDistro()` 不再探测）。 */
const CFG = { ...DEFAULTS, distro: 'debian', wslHome: '/home/g', cwd: '/home/g' };
const LINUX_PATH = '/home/g/project';
const UNC_DEBIAN = '\\\\wsl.localhost\\debian\\home\\g\\project';
/** workspaceRegistry 里那条已登记的工作区（`addWorkspace` 的正常产物）。 */
const WORKSPACE = { id: 'ws-1', path: UNC_DEBIAN, sessionIds: [] };

/**
 * 造一个和宿主契约同形的 RemoteError（`dsh-typert-protocol/lib/index.js:11-28`：`code` + `isDSHRemoteError`）。
 * 判据只认 `code`（源码注释明确"Discrimination is always by code, never by instanceof"）。
 */
function remoteError(code, message) {
  const e = new Error(message);
  e.name = 'RemoteError';
  e.code = code;
  e.details = {};
  e.isDSHRemoteError = true;
  return e;
}

/**
 * 最小 deps：只注入"读事实"和"建会话"两个面，其余与 `src/index.ts` 的接线同形。
 * @param create `ctl.create(request)` 的实现（记录调用由本函数负责）
 * @returns `{ handlers, calls }`，`calls` 是逐次 `ctl.create` 收到的原始 request
 */
function depsWith(create) {
  const calls = [];
  const ctl = {
    async create(request) {
      calls.push(request);
      return create(request, calls.length - 1);
    },
  };
  const registry = {
    get: (id) => (id === WORKSPACE.id ? WORKSPACE : undefined),
    create: () => WORKSPACE,
    resolveByPath: () => undefined,
  };
  const { handlers } = createExplorerHandlers({
    config: CFG,
    listDistros: () => ['debian'],
    listDistrosAsync: async () => ['debian'],
    distroStateProbe: () => ({ defaultName: 'debian', running: new Set(['debian']), versions: new Map(), ok: true }),
    resolveVersion: () => ({ version: '0.3.7', desktopVersion: '0.3.7', pin: null, drift: null }),
    writePin: () => true,
    webHosts: new Map(),
    sessionController: () => ctl,
    workspaceRegistry: () => registry,
  });
  return { handlers, calls };
}

/**
 * 截住 host 的降级日志（`explorer.ts` 的 `log` 直接写 `process.stderr`；桌面 GUI 里没有 stderr，
 * 所以"日志里有一行"这件事也必须由用例证明，而不是靠注释）。
 * @returns `{ text, restore }`
 */
function captureStderr() {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

test('P2：explorer.newSession 默认把 agentPreset="wsl" 交给宿主（cwd = WSL 路径的 UNC）', async () => {
  const { handlers, calls } = depsWith(() => ({ sessionId: 'session-a', agentPreset: 'wsl' }));

  const result = await handlers['explorer.newSession']({ path: LINUX_PATH });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { cwd: UNC_DEBIAN, agentPreset: 'wsl' });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'session-a');
  assert.equal(result.cwd, UNC_DEBIAN);
  assert.equal(result.presetRequested, 'wsl');
  assert.equal(result.presetApplied, true);
  assert.equal(result.agentPreset, 'wsl');
  assert.equal(result.presetDegraded, undefined);
  assert.equal(result.presetError, undefined);
});

test('P2：给了 workspaceId ⇒ create 只带 workspaceId（不带 cwd）+ agentPreset，cwd 取自工作区 path', async () => {
  const { handlers, calls } = depsWith(() => ({ sessionId: 'session-b', agentPreset: 'wsl' }));

  const result = await handlers['explorer.newSession']({ path: LINUX_PATH, workspaceId: 'ws-1' });

  assert.equal(calls.length, 1);
  // create 的契约是"workspaceId 或 cwd **之一**"（dsh-api-session-controller lib/index.js:756 会显式拒绝两个都给）。
  assert.deepEqual(calls[0], { workspaceId: 'ws-1', agentPreset: 'wsl' });
  assert.equal(result.workspaceId, 'ws-1');
  assert.equal(result.cwd, WORKSPACE.path);
  assert.equal(result.presetApplied, true);
});

test('P2：旧宿主拒绝 agentPreset（agent-preset/not-found）⇒ 显式降级重试 + 事实与日志都可见', async () => {
  const stderr = captureStderr();
  let result;
  try {
    const { handlers, calls } = depsWith((_request, index) => {
      if (index === 0) throw remoteError('agent-preset/not-found', 'Unknown agent preset: wsl');
      return { sessionId: 'session-c' };
    });
    result = await handlers['explorer.newSession']({ path: LINUX_PATH });
    assert.equal(calls.length, 2, '必须重试一次（降级），而不是把用户挡在门外');
    assert.deepEqual(calls[0], { cwd: UNC_DEBIAN, agentPreset: 'wsl' });
    assert.deepEqual(calls[1], { cwd: UNC_DEBIAN }, '降级重试必须**不带** agentPreset（兼容不认该字段的旧宿主）');
  } finally {
    stderr.restore();
  }

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, 'session-c');
  assert.equal(result.presetApplied, false, 'preset 没应用就不能说 true');
  assert.equal(result.agentPreset, null);
  assert.equal(result.presetDegraded, true);
  assert.match(result.presetError, /agent-preset\/not-found/);
  const logged = stderr.text();
  assert.match(logged, /agentPreset="wsl"/);
  assert.match(logged, /降级/);
  assert.match(logged, /presetApplied:false/);
});

test('P2：旧宿主**静默忽略** agentPreset（返回体没有该字段）⇒ presetApplied:false，且不降级重试', async () => {
  const { handlers, calls } = depsWith(() => ({ sessionId: 'session-d' }));

  const result = await handlers['explorer.newSession']({ path: LINUX_PATH });

  assert.equal(calls.length, 1, '宿主没报错就没有可降级的东西（不能凭空重试两次建两个会话）');
  assert.deepEqual(calls[0], { cwd: UNC_DEBIAN, agentPreset: 'wsl' });
  assert.equal(result.ok, true);
  assert.equal(result.presetApplied, false, '旧宿主静默丢字段 ⇒ 只能报"未应用"，不许伪造成功');
  assert.equal(result.agentPreset, null);
  assert.equal(result.presetDegraded, undefined);
});

test('P2：与 preset 无关的失败**不降级**（不重试、不掩盖根因）', async () => {
  const { handlers, calls } = depsWith(() => {
    throw new Error('failed to ensure project directory: EACCES');
  });

  await assert.rejects(
    () => handlers['explorer.newSession']({ path: LINUX_PATH }),
    (e) => {
      assert.equal(e.code, 'E_UNAVAILABLE');
      assert.match(e.message, /创建 DSH 会话失败/);
      assert.match(e.message, /EACCES/);
      return true;
    },
  );
  assert.equal(calls.length, 1, '非 preset 失败重试只会掩盖根因');
});

test('P2：降级重试仍失败 ⇒ 两条原因都带上（preset 原文进 detail）', async () => {
  const stderr = captureStderr();
  try {
    const { handlers, calls } = depsWith((_request, index) => {
      if (index === 0) throw remoteError('agent-preset/invalid', 'preset "wsl" is broken: boom');
      throw new Error('failed to ensure project directory: ENOTDIR');
    });
    await assert.rejects(
      () => handlers['explorer.newSession']({ path: LINUX_PATH }),
      (e) => {
        assert.equal(e.code, 'E_UNAVAILABLE');
        assert.match(e.message, /重试仍失败/);
        assert.match(e.message, /ENOTDIR/);
        assert.match(String(e.detail), /agent-preset\/invalid/);
        return true;
      },
    );
    assert.equal(calls.length, 2);
  } finally {
    stderr.restore();
  }
});

test('P2：workspaceId 不存在 ⇒ E_ARG（先 addWorkspace），不误建到别的目录', async () => {
  const { handlers, calls } = depsWith(() => ({ sessionId: 'never', agentPreset: 'wsl' }));

  await assert.rejects(
    () => handlers['explorer.newSession']({ path: LINUX_PATH, workspaceId: 'ws-missing' }),
    (e) => {
      assert.equal(e.code, 'E_ARG');
      assert.match(e.message, /ws-missing/);
      assert.match(e.message, /addWorkspace/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'workspace 不存在时不该走到 create');
});
