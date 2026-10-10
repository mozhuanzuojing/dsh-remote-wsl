#!/usr/bin/env node
/**
 * verify/one-runtime.ts —— 反证实验用的**单运行时**持有者（在 WSL 内用 node 跑）。
 *
 * 与 spike/repro-conflict.ts 的区别（这是本次独立验证的加码点）：
 *   repro-conflict.ts 把 A/B 两个 SdkRuntime 放在**同一个 node 进程**里；
 *   本文件一次只持有一个运行时，由 verify-conflict.ps1 起**两个互相独立的 OS 进程**，
 *   这样"跨进程复用 sessionId 被拒"才是真的跨进程证据，而不是同进程内的两次 initialize。
 *
 * 用法（WSL 内）：
 *   node one-runtime.ts --session-id <id> --text "..." [--hold-ms N] [--close] [--version 0.2.0-rc.2]
 * stdout：每阶段一行 JSON（start / prompt / close）；诊断走 stderr。
 *
 * 迁移说明（.mjs → .ts，零构建；相对导入带 .ts 扩展名）。
 */
import { SdkRuntime } from '../sdk-runtime.ts';

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (n: string): boolean => argv.includes(`--${n}`);

const sessionId = arg('session-id', '');
const text = arg('text', 'Reply only ACK.');
const holdMs = Number(arg('hold-ms', '0'));
const version = arg('version', '0.2.0-rc.2');
const cwd = arg('cwd', '/home/g');

/**
 * 每阶段一行 JSON 的形状。
 * 为什么逐字段写出来：verify-conflict.ps1 用**字面正则**（如 `"stage":"prompt","ok":false`）匹配 stdout，
 * 所以字段名与顺序都是对外契约，必须是显式类型而不是随手对象。
 */
interface StageLine {
  stage: 'args' | 'start' | 'prompt' | 'close';
  ok?: boolean;
  pid?: number;
  runtimePid?: number | null;
  sessionId?: string;
  turns?: number;
  completedBy?: string;
  text?: string;
  error?: string;
  /** stage=close 时的 close() 结果（或 { error } 兜底）。 */
  result?: unknown;
}

const out = (o: StageLine): void => process.stdout.write(JSON.stringify(o) + '\n');
const log = (...a: unknown[]): void => process.stderr.write(`[one-runtime] ${a.join(' ')}\n`);

if (!sessionId) {
  out({ stage: 'args', ok: false, error: '--session-id required' });
  process.exit(2);
}

const rt = new SdkRuntime({
  key: 'verify-one',
  version,
  cwd,
  sessionId,
  promptTimeoutMs: 180000,
  log,
});

try {
  await rt.start();
  out({ stage: 'start', ok: true, pid: process.pid, runtimePid: rt.runtimePid, sessionId });
  const r = await rt.prompt(text);
  out({
    stage: 'prompt',
    ok: true,
    pid: process.pid,
    runtimePid: r.runtimePid,
    sessionId: r.sessionId,
    turns: r.turns,
    completedBy: r.completedBy,
    text: r.text,
  });
} catch (e) {
  out({ stage: 'prompt', ok: false, pid: process.pid, sessionId, error: (e as Error)?.message ?? String(e) });
}

if (holdMs > 0) {
  log(`holding ${holdMs}ms so the runtime stays alive while the other process tries`);
  await new Promise((r) => setTimeout(r, holdMs));
  out({ stage: 'close', result: 'skipped(hold)', pid: process.pid });
} else {
  const c = await rt.close().catch((e: Error) => ({ error: e?.message ?? String(e) }));
  out({ stage: 'close', result: c, pid: process.pid });
}
process.exit(0);
