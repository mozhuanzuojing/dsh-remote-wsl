/**
 * int-20261010/probe.ts —— task-4 独立复验夹具（零外部依赖，最小 ctx 桩）。
 *
 * 与 rwsl-test\test.ts 的关键差别：本夹具 import 的是**交付物本体**
 * `D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts`（不是 %TEMP% 下的副本），
 * 因此它验的是真正会被 profile 加载的那份文件；且端口用我自己的槽位（默认 8755）。
 *
 * 每个模式都打印 `[probe pid=N]`，便于证明"两个真宿主进程"与"跨进程"。
 * 用法：node probe.ts --mode <status|daemon|agent|concurrent|recover-inproc> [--port 8755] ...
 */
import { existsSync } from 'node:fs';

interface ToolDef {
  name: string;
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<string>;
}

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (n: string) => argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODE = arg('mode', 'status')!;
const PORT = Number(arg('port', '8755'));
const KEY = arg('key', 'int-key-1')!;
const N = Number(arg('n', '6'));
const DSH_VERSION = arg('dsh-version', '')!;
const QUEUE_LIMIT = Number(arg('queue-limit', '4'));
const DESKTOP_JSON =
  'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json';

const disposers: Array<() => unknown> = [];
const tools = new Map<string, ToolDef>();
const toolsService = { register: (t: ToolDef) => void tools.set(t.name, t) };
const childCtx = { get: (k: string) => (k === 'tools' ? toolsService : undefined) };
const ctx = {
  inject: (_d: string[], cb: (c: typeof childCtx) => void) => cb(childCtx),
  get: (k: string) => (k === 'tools' ? toolsService : undefined),
  effect: (fn: () => unknown) => {
    const d = fn();
    if (typeof d === 'function') disposers.push(d as () => unknown);
  },
};
const config = {
  distro: 'debian-u8-1',
  wslHome: '/home/g',
  cwd: '/home/g',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  profile: 'sdk',
  dshVersion: DSH_VERSION,
  webPort: 3082,
  idleTimeoutMs: 120000,
  timeoutMs: 180000,
  desktopRuntimeJson: DESKTOP_JSON,
  proxyPort: 9910,
  backend: 'daemon',
  daemonPort: PORT,
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonQueueLimit: QUEUE_LIMIT,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  useShellEnvironment: true,
  backgroundWarm: false,
};

const LIB = 'D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts';
console.error(`[probe] entry=${LIB} exists=${existsSync(LIB)}`);
const mod: any = await import(`file:///${LIB}`);
const exec = { signal: new AbortController().signal };

console.log(`[probe pid=${process.pid}] mode=${MODE} port=${PORT} key=${KEY} dshVersion=${DSH_VERSION || '(desktop)'}`);
mod.apply(ctx, config);
console.log(`注册工具: ${[...tools.keys()].join(', ')}`);

const call = async (n: string, a: Record<string, unknown>): Promise<string> => {
  const t = tools.get(n);
  if (!t) throw new Error(`未注册: ${n}`);
  return await t.execute(a, exec);
};

/** 工具抛错（例如守护在 Windows 侧不可达）必须**可读地**打出来，而不是只留一个栈。 */
const safe = async (n: string, a: Record<string, unknown>): Promise<string> => {
  try {
    return await call(n, a);
  } catch (e: any) {
    return `THROW(${n}): ${e?.message ?? String(e)}`;
  }
};

if (MODE === 'status') {
  console.log('\n########## wsl_status ##########');
  console.log(await call('wsl_status', {}));
} else if (MODE === 'daemon') {
  const action = arg('action', 'status')!;
  console.log(`\n########## wsl_daemon action=${action} ##########`);
  console.log(await safe('wsl_daemon', { action }));
} else if (MODE === 'exec') {
  const command = arg('command', 'echo sweep-probe')!;
  console.log('\n########## wsl_exec（有副作用 ⇒ 会触发 ensureSwept）##########');
  console.log(await safe('wsl_exec', { command }));
} else if (MODE === 'agent') {
  const task = arg('task', '记住数字 41。只回复 ACK')!;
  const followUps = has('follow-up') ? [arg('follow-up')!] : [];
  console.log('\n########## wsl_agent ##########');
  const t0 = Date.now();
  const text = await safe('wsl_agent', { task, followUps, key: KEY });
  console.log(`elapsed_ms=${Date.now() - t0}`);
  console.log(text);
} else if (MODE === 'concurrent') {
  console.log(`\n########## 同 key ${N} 个并发 prompt（queueLimit=${QUEUE_LIMIT}）##########`);
  const jobs: Array<Promise<string>> = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const seq = i;
    jobs.push(
      (async () => {
        const s = Date.now();
        let text: string;
        try {
          text = await call('wsl_agent', { task: `第${seq}个并发：只回复 OK-${seq}`, key: KEY });
        } catch (e: any) {
          text = `THROW: ${e?.message ?? e}`;
        }
        return `--- job#${seq} elapsed_ms=${Date.now() - s} wall_from_start=${Date.now() - t0}\n${text}`;
      })(),
    );
    await sleep(120); // 让它们几乎同时但有序地进入
  }
  const results = await Promise.all(jobs);
  console.log(results.join('\n'));
} else if (MODE === 'recover-inproc') {
  const flag = arg('flag', '')!;
  console.log('\n########## 第 1 轮（建会话）##########');
  console.log(await call('wsl_agent', { task: '记住数字 41。只回复 ACK', key: KEY }));
  console.log(`\n等待外部 kill 守护完成（flag=${flag}）...`);
  const deadline = Date.now() + 90000;
  while (!existsSync(flag) && Date.now() < deadline) await sleep(200);
  console.log(`flag 出现=${existsSync(flag)}；现在再 prompt 同一 key（守护应已死）`);
  console.log('\n########## 第 2 轮（kill 之后，同进程）##########');
  const t0 = Date.now();
  console.log(await call('wsl_agent', { task: '刚才让你记的数字？只回数字', key: KEY }));
  console.log(`elapsed_ms=${Date.now() - t0}`);
} else {
  throw new Error(`未知 mode: ${MODE}`);
}

for (const d of disposers) {
  try {
    await d();
  } catch {}
}
console.log(`\n[probe pid=${process.pid}] cleanup disposers=${disposers.length}`);
process.exit(0);
