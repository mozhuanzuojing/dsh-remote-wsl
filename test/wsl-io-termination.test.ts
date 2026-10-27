/**
 * runWsl 的两条底层缺陷的回归测试（2026-10-27 审查 F-32 / F-33）。
 *
 * 为什么这两个缺陷值得单测而不是只靠端到端：
 *  · **F-32**：`runWsl` 每条流 200KB 上限是**静默丢尾** —— 调用方把截断的输出当完整结果，
 *    最关键的尾部错误信息（报错几乎总在最后）无声消失。要证明修好了，必须能断言"真的丢掉时
 *    被标记、恰好到上限没丢时不被标记"这两面；用真 wsl.exe 跑 200KB 场景既慢又不确定。
 *  · **F-33**：旧实现用 `finish(124)` 表示超时、`finish(130)` 表示中断 ⇒「命令自己 exit 124」
 *    （`timeout(1)` 的既有约定）与「插件把它杀了」返回值**一模一样**。根因是"从退出码反推断原因"，
 *    所以修复只能靠我们自己的布尔标记；这里的核心断言就是「code=124 且没超时 ⇒ killedBy='exit'」。
 *
 * 纪律：只 import `src/wsl-io.ts` 的两个**纯函数**与两个常量（不 spawn 任何进程，Windows 侧也能跑）。
 * 特别注意：绝不能 import `src/daemon.ts`（可执行脚本，import 会真起守护并写用户状态目录）。
 *
 * 运行：`node --experimental-strip-types --test test/*.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { capAppend, terminationOf, WSL_STDIO_DRAIN_MAX_MS, WSL_STDIO_DRAIN_MS, WSL_STREAM_MAX_BYTES } from '../src/wsl-io.ts';

// ── F-32：流收集上限（capAppend）──────────────────────────────────────────────

test('capAppend：超限后不再增长，且如实标记 dropped（F-32）', () => {
  const limit = 8;
  let state = { chunks: [], total: 0 };
  const droppedAt = [];
  // 连续小块：4 + 4 正好填满，第三块开始丢
  for (const [i, piece] of ['abcd', 'efgh', 'ijkl'].entries()) {
    const r = capAppend(state.chunks, state.total, Buffer.from(piece, 'utf8'), limit);
    state = { chunks: r.chunks, total: r.total };
    droppedAt.push(r.dropped);
  }
  assert.deepEqual(droppedAt, [false, false, true], '只有真正丢字节的那次才是 dropped=true');
  assert.equal(state.total, limit, 'total 不得超过上限');
  // 再追加多少块都不再增长（旧实现的静默路径）
  for (const extra of ['zzzz', 'yyyy', 'xxxx']) {
    const r = capAppend(state.chunks, state.total, Buffer.from(extra, 'utf8'), limit);
    state = { chunks: r.chunks, total: r.total };
    assert.equal(r.dropped, true);
    assert.equal(r.total, limit);
  }
  assert.equal(Buffer.concat(state.chunks).toString('utf8'), 'abcdefgh', '保留的是头部，不是尾部');
});

test('capAppend：恰好到达上限但没超出 ⇒ dropped=false（不得误报截断）', () => {
  const limit = 8;
  // 一块正好 8 字节：一个字都没丢，绝不能被说成"已截断"
  const one = capAppend([], 0, Buffer.from('abcdefgh', 'utf8'), limit);
  assert.equal(one.total, 8);
  assert.equal(one.dropped, false);
  // 分块累计正好 8 字节，同样不算截断
  const a = capAppend([], 0, Buffer.from('abcd', 'utf8'), limit);
  const b = capAppend(a.chunks, a.total, Buffer.from('efgh', 'utf8'), limit);
  assert.equal(b.total, limit);
  assert.equal(b.dropped, false);
});

test('capAppend：一块就超限时只保留前缀（放不下的部分算丢）', () => {
  const r = capAppend([], 0, Buffer.from('0123456789', 'utf8'), 4);
  assert.equal(r.total, 4);
  assert.equal(r.dropped, true, '一块 10 字节塞 4 字节上限：丢过字节就必须报');
  assert.equal(Buffer.concat(r.chunks).toString('utf8'), '0123');
});

test('capAppend：切点落在多字节字符中间时回退到字符边界（不出 U+FFFD）', () => {
  // '中' = e4 b8 ad（3 字节）。上限 4 ⇒ 硬切会切在 '中' 的第二个字节后面
  const r = capAppend([], 0, Buffer.from('中中', 'utf8'), 4);
  const text = Buffer.concat(r.chunks).toString('utf8');
  assert.equal(r.dropped, true);
  assert.ok(!text.includes('\uFFFD'), `不该出现替换字符，实际=${JSON.stringify(text)}`);
  assert.equal(text, '中', '只保留能完整解码的字符');
  assert.equal(r.total, 3, 'total 必须等于真正保留的字节数');
});

test('capAppend：空块不改变状态、也不标记截断；入参不被改动（纯函数）', () => {
  const chunks = [Buffer.from('ab', 'utf8')];
  const before = [...chunks];
  const r = capAppend(chunks, 2, Buffer.alloc(0), 10);
  assert.equal(r.total, 2);
  assert.equal(r.dropped, false);
  assert.deepEqual(chunks, before, 'capAppend 不得修改传入的数组');
  // 已满再收到空块：没东西可丢 ⇒ 不能吓人地说"截断了"
  const full = capAppend([Buffer.from('abcd', 'utf8')], 4, Buffer.alloc(0), 4);
  assert.equal(full.dropped, false);
  assert.equal(full.total, 4);
  // 有内容被收下时返回**新**数组（调用方可以整体替换状态，不必先拷贝）
  const grown = capAppend(chunks, 2, Buffer.from('cd', 'utf8'), 10);
  assert.notEqual(grown.chunks, chunks, '收下新数据时返回新数组');
  assert.equal(Buffer.concat(grown.chunks).toString('utf8'), 'abcd');
});

test('capAppend：默认上限常量与真实消费者的 200KB 一致', () => {
  assert.equal(WSL_STREAM_MAX_BYTES, 200000, 'runWsl 每流 200KB 是既有契约，别悄悄改小');
  // 用默认上限做一个跨块增长的用例，锁住常量与函数是连起来用的
  let state = { chunks: [], total: 0 };
  const block = Buffer.alloc(150000, 0x61); // 150KB 'a'
  const first = capAppend(state.chunks, state.total, block, WSL_STREAM_MAX_BYTES);
  state = { chunks: first.chunks, total: first.total };
  assert.equal(first.dropped, false);
  const second = capAppend(state.chunks, state.total, block, WSL_STREAM_MAX_BYTES);
  assert.equal(second.total, WSL_STREAM_MAX_BYTES, '第二块只填满余量');
  assert.equal(second.dropped, true, '50KB 被丢掉 ⇒ 必须报');
});

// ── F-33：终止原因（terminationOf）────────────────────────────────────────────

test('terminationOf：命令自己 exit 124 且没超时 ⇒ killedBy=exit（F-33 的根因）', () => {
  // ★ 这条是整个修复的核心断言：`timeout(1)` 这类命令**自己**返回 124 是常见约定，
  //   旧实现会把它当成"插件超时杀了它"，于是人和上层都把"命令自己的失败"读成"插件不给你跑"。
  const t = terminationOf({ code: 124, timedOut: false, aborted: false });
  assert.equal(t.killedBy, 'exit', '没有我们自己的超时标记 ⇒ 就是命令自己退出的');
  assert.equal(t.exitCode, 124, '退出码原样保留，调用方看到的事实不变');
  assert.equal(t.killedBySignal, null);
});

test('terminationOf：我们自己的定时器到点 ⇒ killedBy=timeout，并沿用 124', () => {
  const t = terminationOf({ code: null, timedOut: true });
  assert.equal(t.killedBy, 'timeout');
  assert.equal(t.exitCode, 124, '老调用方按 124 判超时的路径必须继续成立');
});

test('terminationOf：调用方中断 ⇒ killedBy=abort，并沿用 130', () => {
  const t = terminationOf({ code: 130, aborted: true });
  assert.equal(t.killedBy, 'abort');
  assert.equal(t.exitCode, 130);
});

test('terminationOf：命令自己 exit 130 且没被中断 ⇒ killedBy=exit（与上一条必须可区分）', () => {
  // Ctrl-C 的既有约定是 130；调用方没中断我们，就不许把责任揽到插件身上
  const t = terminationOf({ code: 130, aborted: false });
  assert.equal(t.killedBy, 'exit');
  assert.equal(t.exitCode, 130);
});

test('terminationOf：被信号结束 ⇒ killedBy=signal，exitCode 记 1（不退化成伪成功）', () => {
  const t = terminationOf({ code: null, signalCode: 'SIGTERM' });
  assert.equal(t.killedBy, 'signal');
  assert.equal(t.killedBySignal, 'SIGTERM');
  // 2026-10-23 真 child 探针的教训：`code=null` 若记 0，调用方会拿到"成功且空输出"= 伪成功
  assert.equal(t.exitCode, 1, '被信号杀掉必须表现为失败');
});

test('terminationOf：没有进程存在过（既无退出码也无信号）⇒ 与旧实现同为 exit 0', () => {
  const t = terminationOf({ code: null, signalCode: null });
  assert.equal(t.exitCode, 0);
  assert.equal(t.killedBy, 'exit');
  assert.equal(t.killedBySignal, null);
});

test('terminationOf：普通成功/失败码不被改写', () => {
  assert.deepEqual(terminationOf({ code: 0 }), { exitCode: 0, killedBy: 'exit', killedBySignal: null });
  assert.deepEqual(terminationOf({ code: 1 }), { exitCode: 1, killedBy: 'exit', killedBySignal: null });
  assert.deepEqual(terminationOf({ code: 141 }), { exitCode: 141, killedBy: 'exit', killedBySignal: null });
});

test('terminationOf：我们的标记压过退出码（原因永远由插件自述，不由码猜测）', () => {
  // 退出码是 0 也仍然是我们杀的 —— 不能因为 0 就改口说"命令自己成功了"
  assert.equal(terminationOf({ code: 0, timedOut: true }).killedBy, 'timeout');
  assert.equal(terminationOf({ code: 0, aborted: true }).killedBy, 'abort');
  assert.equal(terminationOf({ code: 143, timedOut: true }).killedBy, 'timeout');
});

test('terminationOf：超时与中断同时为真时结果确定（超时优先）', () => {
  // runWsl 里 finish 只结算一次，两标记不会同时为真；这里只是把优先级钉死，避免将来改动漂移
  const t = terminationOf({ code: null, timedOut: true, aborted: true });
  assert.equal(t.killedBy, 'timeout');
  assert.equal(t.exitCode, 124);
});

test('WSL_STDIO_DRAIN_MS：排空窗口有界且短（不然等于把调用拖成假超时）', () => {
  assert.ok(Number.isFinite(WSL_STDIO_DRAIN_MS));
  assert.ok(WSL_STDIO_DRAIN_MS > 0 && WSL_STDIO_DRAIN_MS <= 200, `实际=${WSL_STDIO_DRAIN_MS}`);
  // 总上限必须存在且明显大于单次静默窗口：否则大输出收尾（实测 900KB 需要几十毫秒）会被硬切
  assert.ok(Number.isFinite(WSL_STDIO_DRAIN_MAX_MS));
  assert.ok(WSL_STDIO_DRAIN_MAX_MS >= WSL_STDIO_DRAIN_MS, '总上限不得小于静默窗口');
  assert.ok(WSL_STDIO_DRAIN_MAX_MS <= 5000, `总上限过大不安全，实际=${WSL_STDIO_DRAIN_MAX_MS}`);
});
