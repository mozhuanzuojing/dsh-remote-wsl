/**
 * 面板「启动守护」链路的回归锁（2026-11-21）：
 *
 * 背景（真缺陷，实测证据）：面板所有 explorer 请求共用 9s 超时，而守护冷启动实测 22s
 * （2026-11-21 13:50:50 发起 → 13:51:06 listening，pid 289126；热启动 2s，pid 289985）
 * ⇒ 点「启动守护」在冷启动时先被客户端 abort 判成"没启动起来"，20s 后守护其实已在。
 *
 * 这里锁两件事：
 *   · `timeoutForMethod('explorer.daemon')` 必须显著大于读动作（防有人把全局 9s 又套回守护动作）；
 *   · `isDaemonDownError` 必须认 host 的 `detail.reason==='daemon-down'`，且旧宿主兜底不能把
 *     `/mnt`（原生盘直读、不需要守护）误判成"该启动守护"。
 *
 * 纯函数，**离线**：不发请求、不碰 WSL、不起守护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAEMON_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  REDETECT_TIMEOUT_MS,
  timeoutForMethod,
  isDaemonDownError,
  isTargetResolutionError,
  shouldAutoStartDaemon,
  createExplorerApi,
} from '../src/client/client.api.ts';

test('守护动作有独立预算：daemon ≫ 读动作，且读动作仍是 9s', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 9000);
  assert.equal(timeoutForMethod('explorer.snapshot'), 9000);
  assert.equal(timeoutForMethod('explorer.listDir'), 9000);
  assert.equal(timeoutForMethod('explorer.daemon'), DAEMON_TIMEOUT_MS);
  assert.ok(DAEMON_TIMEOUT_MS >= 45000 + 20000, `daemon 预算必须覆盖 启动锁45s+启动20s，实际 ${DAEMON_TIMEOUT_MS}`);
});

/**
 * **接线锁定**：上一条只证明常量/选择器，不证明 `api.daemon()` 真把 120s 交给了 `request()`。
 * 审查（2026-11-21）实测过：把 `call()` 里的 `timeoutForMethod(method)` 撤掉、常量保留，纯函数断言仍全绿。
 * 这里用 stub `fetch` + stub `setTimeout` 抓住"请求实际注册的超时预算"并强制到点，断言：
 *   · daemon 动作注册的是 `DAEMON_TIMEOUT_MS`（不是 9000）；
 *   · 超时错误文案里带的就是这个预算（说明它真的驱动了 abort）。
 */
async function actualBudgetOf(invoke: (api: any) => Promise<any>) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realFetch = globalThis.fetch;
  const budgets: number[] = [];
  const timers: Array<() => void> = [];
  globalThis.setTimeout = ((fn: any, ms?: number) => {
    budgets.push(Number(ms));
    timers.push(fn);
    return timers.length;
  }) as any;
  globalThis.clearTimeout = (() => {}) as any;
  globalThis.fetch = ((_url: any, init: any) =>
    new Promise((_resolve, reject) => {
      const sig = init && init.signal;
      if (sig && typeof sig.addEventListener === "function") {
        sig.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }
    })) as any;
  try {
    const api = createExplorerApi(null);
    const pending = invoke(api).catch((e: any) => e);
    assert.equal(budgets.length, 1, `request() 应只注册一个超时定时器，实际 ${JSON.stringify(budgets)}`);
    timers[0](); // 强制到点
    const error: any = await pending;
    assert.equal(error.kind, "timeout");
    return { budget: budgets[0], message: String(error.message) };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    globalThis.fetch = realFetch;
  }
}

test('接线锁定：api.daemon() 实际按 DAEMON_TIMEOUT_MS 超时（撤掉接线即变红）', async () => {
  const { budget, message } = await actualBudgetOf((api) => api.daemon({ action: "ensure" }));
  assert.equal(budget, DAEMON_TIMEOUT_MS);
  assert.match(message, new RegExp(`${DAEMON_TIMEOUT_MS}ms`));
});

test('接线锁定：api.listDir() 仍按 9s 超时（读动作不被放宽）', async () => {
  const { budget, message } = await actualBudgetOf((api) => api.listDir({ path: "/home/g" }));
  assert.equal(budget, REQUEST_TIMEOUT_MS);
  assert.match(message, /9000ms/);
});

test('isDaemonDownError：host 的 reason 是权威判据（不靠中文句子）', () => {
  assert.equal(isDaemonDownError({ detail: { reason: 'daemon-down' } }), true);
  // 其它结构化原因不能被当成"守护未运行"（否则错误块会给错按钮）
  assert.equal(isDaemonDownError({ detail: { reason: 'unknown-distro' } }), false);
  assert.equal(isDaemonDownError({ detail: { reason: 'distro-not-running' }, }), false);
  // 有 reason 时不看兜底参数
  assert.equal(isDaemonDownError({ detail: { reason: 'unknown-distro' } }, { daemonDown: true, path: '/home/g' }), false);
});

test('isDaemonDownError：旧宿主没有 reason 时按"守护未运行 + 非 /mnt"兜底，/mnt 不给启动建议', () => {
  const oldHostError = { detail: { code: 'E_UNAVAILABLE', error: '…' } };
  assert.equal(isDaemonDownError(oldHostError, { daemonDown: true, path: '/home/g' }), true);
  assert.equal(isDaemonDownError(oldHostError, { daemonDown: true, path: '/home/g/project' }), true);
  assert.equal(isDaemonDownError(oldHostError, { daemonDown: true, path: '/mnt/d/project' }), false);
  assert.equal(isDaemonDownError(oldHostError, { daemonDown: true, path: '/mnt' }), false);
  // 面板已知守护在跑 ⇒ 不归因于守护未运行
  assert.equal(isDaemonDownError(oldHostError, { daemonDown: false, path: '/home/g' }), false);
  // 没有 detail（传输/超时错误）⇒ 不猜
  assert.equal(isDaemonDownError({ kind: 'timeout' }, { daemonDown: true, path: '/home/g' }), false);
});

test('api 句柄把同一套判据与预算暴露给面板（单一口径）', () => {
  const api = createExplorerApi(null);
  assert.equal(api.daemonTimeoutMs, DAEMON_TIMEOUT_MS);
  assert.equal(api.timeoutForMethod('explorer.daemon'), DAEMON_TIMEOUT_MS);
  assert.equal(api.isDaemonDownError({ detail: { reason: 'daemon-down' } }), true);
  assert.equal(api.timeoutMs, 9000);
});

test('redetect 有独立预算：覆盖最坏 8s(列表)+10s($HOME) 探测，且 api 暴露 redetect', () => {
  assert.ok(REDETECT_TIMEOUT_MS >= 18000, `redetect 预算需覆盖 8s+10s，实际 ${REDETECT_TIMEOUT_MS}`);
  assert.equal(timeoutForMethod('explorer.redetect'), REDETECT_TIMEOUT_MS);
  const api = createExplorerApi(null);
  assert.equal(typeof api.redetect, 'function');
});

test('接线锁定：api.redetect() 实际按 REDETECT_TIMEOUT_MS 超时（撤掉接线即变红）', async () => {
  const { budget } = await actualBudgetOf((api) => api.redetect());
  assert.equal(budget, REDETECT_TIMEOUT_MS);
});

test('isTargetResolutionError：只认机器可读 no-distro/no-wsl-home（不靠中文；其它错误不误判）', () => {
  assert.equal(isTargetResolutionError({ detail: { reason: 'no-distro' } }), true);
  assert.equal(isTargetResolutionError({ detail: { reason: 'no-wsl-home' } }), true);
  assert.equal(isTargetResolutionError({ detail: { reason: 'unknown-distro' } }), false);
  assert.equal(isTargetResolutionError({ detail: { reason: 'daemon-down' } }), false);
  // 超时/传输错误的 detail 是 Error（无 reason）⇒ 不得当成"该重探目标"
  assert.equal(isTargetResolutionError({ kind: 'timeout' }), false);
  assert.equal(isTargetResolutionError(null), false);
});

test('shouldAutoStartDaemon：仅“已知未运行且各项就绪”才 true（未知/运行中/扫描未核实/有动作/已试/用户已停 都不拉）', () => {
  const base = { daemon: { running: false, orphansVerified: true, scan: { ok: true } }, actionBusy: false };
  assert.equal(shouldAutoStartDaemon(base), true);
  assert.equal(shouldAutoStartDaemon({ ...base, daemon: { ...base.daemon, running: true } }), false); // 运行中不拉
  assert.equal(shouldAutoStartDaemon({ ...base, daemon: { running: undefined } }), false); // 未知/缺字段不拉
  assert.equal(shouldAutoStartDaemon({ ...base, actionBusy: true }), false); // 有其它动作不抢
  assert.equal(shouldAutoStartDaemon({ ...base, busy: true }), false); // 本次已在拉
  assert.equal(shouldAutoStartDaemon({ ...base, attempted: true }), false); // 本段已试过
  assert.equal(shouldAutoStartDaemon({ ...base, userStopped: true }), false); // 用户手动停止后不拉
  assert.equal(shouldAutoStartDaemon({ ...base, daemon: { ...base.daemon, orphansVerified: false } }), false); // 扫描未核实
  assert.equal(shouldAutoStartDaemon({ ...base, daemon: { ...base.daemon, scan: { ok: false } } }), false); // 扫描失败
  assert.equal(shouldAutoStartDaemon(null), false);
});
