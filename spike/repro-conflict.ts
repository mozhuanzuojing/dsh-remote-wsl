#!/usr/bin/env node
/**
 * repro-conflict.ts —— **反证实验**：为什么必须有守护进程。
 *
 * 不走守护，用两个**互相独立的进程**各起一份 `dsh --profile sdk`，让它们复用同一个 sessionId：
 *   A 先 prompt 一轮（session 被创建）并保持存活，B 再拿同一个 id 发 session/prompt
 *   ⇒ 期望服务端拒绝：`JSON-RPC -32603: session "…" already exists`。
 *
 * 这解释了现状的因果链：宿主进程一退，它 spawn 的运行时跟着死；而"重启一个运行时、沿用旧
 * sessionId 把上下文接回来"这条路被上游堵死 ⇒ 唯一出路就是让**运行时别死**（守护持有）。
 *
 * 附带对照（--mode stale）：A 先正常 shutdown，再让 B 用同一个 sessionId
 *   —— 用来区分"冲突来自活着的持有者"还是"来自落盘的 session 记录"。
 *   两种结论对插件的影响不同：若只是活锁，崩溃后 id 可复用；若是落盘占用，则必须每次换新 id。
 *
 * 用法：node repro-conflict.ts [--mode alive|stale] [--version 0.2.0-rc.2] [--cwd /home/g]
 * 退出码：0 = 观察到了跨进程冲突（反证成立）；1 = 没有冲突（假设被证伪）
 *
 * 迁移说明（.mjs → .ts，零构建）：顶层 await + 可擦除类型，Node 原生 type stripping 直接跑。
 */
import { randomUUID } from 'node:crypto';
import { SdkRuntime } from './sdk-runtime.ts';
import type { LogFn } from './sdk-runtime.ts';

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const MODE = arg('mode', 'alive');
const VERSION = arg('version', '0.2.0-rc.2');
const CWD = arg('cwd', '/home/g');

/** 反证的判据：只要 error 里出现 -32603，就说明"跨进程复用 sessionId"被上游真的拒了。 */
interface ConflictVerdict {
  mode: string;
  sessionId: string;
  crossProcessConflictObserved: boolean;
  error: string | null;
}

const sessionId = `remote-wsl-conflict-${randomUUID()}`;
const tag =
  (who: string): LogFn =>
  (...a: unknown[]) =>
    console.log(`[${who}]`, ...a);
const frames =
  (who: string) =>
  (line: string): void => {
    if (line.includes(`"id"`) || line.includes(sessionId)) console.log(`[${who}] FRAME ${line.slice(0, 400)}`);
  };

console.log(`# mode=${MODE} dsh@${VERSION} shared sessionId=${sessionId}`);
console.log(`# A = 独立进程 1 的运行时；B = 独立进程 2 的运行时（两者无任何共享内存/父进程关系）`);

let conflict: string | null = null;

const A = new SdkRuntime({ key: 'A', version: VERSION, cwd: CWD, sessionId, log: tag('A'), onFrame: frames('A'), promptTimeoutMs: 180000 });
console.log('# --- 启动 A ---');
await A.start();
const a1 = await A.prompt('记住数字 7，只回 ACK');
console.log(`[A] turn1 answer=${JSON.stringify(a1.text)} completedBy=${a1.completedBy} runtimePid=${a1.runtimePid} session=${a1.sessionId}`);

if (MODE === 'stale') {
  console.log('# --- A 正常 shutdown（运行时随之消失）---');
  console.log('[A] close ->', JSON.stringify(await A.close()));
} else {
  console.log(`# --- A 保持存活（runtimePid=${A.runtimePid}），B 用同一 sessionId 发 prompt ---`);
}

const B = new SdkRuntime({ key: 'B', version: VERSION, cwd: CWD, sessionId, log: tag('B'), onFrame: frames('B'), promptTimeoutMs: 60000 });
try {
  await B.start();
  console.log('[B] initialize ok');
  const b1 = await B.prompt('刚才让你记的数字？只回数字');
  console.log(`[B] UNEXPECTED SUCCESS answer=${JSON.stringify(b1.text)} completedBy=${b1.completedBy}`);
} catch (e) {
  conflict = (e as Error).message;
  console.log(`[B] ERROR ${(e as Error).message}`);
} finally {
  console.log('[B] close ->', JSON.stringify(await B.close().catch((e: Error) => ({ error: e.message }))));
}
if (MODE === 'alive') {
  console.log('[A] close ->', JSON.stringify(await A.close()));
}

const verdict: ConflictVerdict = {
  mode: MODE,
  sessionId,
  crossProcessConflictObserved: Boolean(conflict && /-32603/.test(conflict)),
  error: conflict,
};
console.log('# VERDICT ' + JSON.stringify(verdict));
process.exit(verdict.crossProcessConflictObserved ? 0 : 1);
