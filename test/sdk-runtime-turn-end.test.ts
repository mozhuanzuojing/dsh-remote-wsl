/**
 * `turn/end` 失败原因的抽取（2026-10-28 真机实测补的回归）。
 *
 * 为什么值得测：`wsl_agent` 真跑时遇到 WSL 侧 API key 失效，上游在 `turn/end` 里给了
 *   `{kind:'error', error:{message:'Authentication Fails, Your api key: ****3e11 is invalid', code:'AUTH', status:401}}`
 * 旧实现只把 `completedBy` 记成 'turn/end'，然后按「没有产出正文 ⇒ 可重试」回报 ⇒ 用户看到的是
 * 「本轮没有产出正文，可直接重试」，会一直重试一个**必然失败**的操作，而真正的诊断（401 / 凭据无效）
 * 就在事件里被我们丢了。这是「错误丢失」，所以把判定抽成纯函数并锁住两侧：
 *   · 有 error reason ⇒ 必须带出 message / code / status；
 *   · 正常结束 / 没有 message ⇒ null（**不能**把正常回合误报成失败）。
 *
 * 纪律：只 import 纯函数，不 spawn 任何运行时；也不 import `src/daemon.ts`（那是可执行脚本）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptOkOf, turnEndErrorOf } from '../src/sdk-runtime.ts';

/** 真机抓到的那一帧（逐字复制自 session.v4.jsonl 的 seq=17）。 */
const REAL_AUTH_EVENT = {
  type: 'turn/end',
  seq: 17,
  data: {
    turn: 1,
    reason: {
      kind: 'error',
      error: {
        message: 'Authentication Fails, Your api key: ****3e11 is invalid (request_id: 52b409fb-2166-445f-81eb-557404e42650)',
        code: 'AUTH',
        status: 401,
      },
    },
  },
};

test('turnEndErrorOf：真机 401 AUTH 必须带出 message/code/status（不得只剩"没有正文"）', () => {
  const r = turnEndErrorOf(REAL_AUTH_EVENT);
  assert.ok(r, '有 error reason 却返回 null ⇒ 诊断信息又被丢了');
  assert.match(r.message, /Authentication Fails/);
  assert.equal(r.code, 'AUTH');
  assert.equal(r.status, 401);
});

test('turnEndErrorOf：assistant/attempt 的 finish 帧用 reason.failure，同样要能取到', () => {
  const r = turnEndErrorOf({
    type: 'turn/end',
    data: { reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } } },
  });
  assert.deepEqual(r, { message: 'rate limited', code: 'RATE_LIMIT', status: 429 });
});

test('turnEndErrorOf：正常结束（reason.kind 不是 error）⇒ null，绝不误报失败', () => {
  assert.equal(turnEndErrorOf({ type: 'turn/end', data: { reason: { kind: 'turn' } } }), null);
  assert.equal(turnEndErrorOf({ type: 'turn/end', data: {} }), null);
  assert.equal(turnEndErrorOf({ type: 'turn/end' }), null);
  assert.equal(turnEndErrorOf(null), null);
});

test('turnEndErrorOf：error 但没有 message ⇒ null（不造一条空错误去吓人）', () => {
  assert.equal(turnEndErrorOf({ data: { reason: { kind: 'error', error: { code: 'AUTH' } } } }), null);
  assert.equal(turnEndErrorOf({ data: { reason: { kind: 'error', error: { message: '   ' } } } }), null);
});

test('turnEndErrorOf：code/status 的形态做过归一（数字 code → 字符串；status 非数字 ⇒ null）', () => {
  const a = turnEndErrorOf({ data: { reason: { kind: 'error', error: { message: 'x', code: 42, status: '500' } } } });
  assert.equal(a.code, '42');
  assert.equal(a.status, 500, '数字字符串 status 应被接受（上游不同版本类型不一致）');
  const b = turnEndErrorOf({ data: { reason: { kind: 'error', error: { message: 'x', status: 'oops' } } } });
  assert.equal(b.status, null);
  assert.equal(b.code, null);
});

// ── promptOkOf：成败判定不能靠 retryable 反推（真机踩过的伪成功）───────────────
test('promptOkOf：带 error 一律算失败 —— retryable=false 不等于成功', () => {
  // 真机 401 时 runtime 返回的就是这个形状；旧守护用 `ok: !retryable` ⇒ 报成"成功但空答案"
  const authFail = { retryable: false, error: '远端运行时在上游侧失败（AUTH 401）：Authentication Fails…' };
  assert.equal(promptOkOf(authFail), false, '带 error 必须判失败，否则就是伪成功');
  assert.equal(promptOkOf({ retryable: true }), false, '没有正文 ⇒ 不可重试也要算失败');
  assert.equal(promptOkOf({ retryable: false, text: 'ACK' }), true, '真的产出正文且无 error 才算成功');
  assert.equal(promptOkOf({}), true, '空对象按旧语义视为成功（无 retryable/无 error）');
});
