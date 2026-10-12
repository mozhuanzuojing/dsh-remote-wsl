/**
 * probe-ground-truth.ts —— task-4 验证夹具（零依赖，最小 ctx 桩）。
 *
 * 与 int-20261010/probe.ts 同源手法：import **交付物本体**
 * `D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts`（不是副本），
 * 端口钉在验证段（默认 8932），因此它验的就是 profile 会加载的那份文件。
 *
 * 用法：
 *   node probe-ground-truth.ts --mode status   [--port 8932]              # wsl_status（验收③⑤的地面真相）
 *   node probe-ground-truth.ts --mode daemon --action start|status|stop   # 自己的守护槽位
 *   node probe-ground-truth.ts --mode exec --command 'echo hi'            # 触发一次 wsl_exec
 *   node probe-ground-truth.ts --mode services                            # 列出插件注册的 host 服务键（探 T2 的 explorer.* 落点）
 *   node probe-ground-truth.ts --mode snapshot                            # best-effort 直调 explorer.snapshot（拿不到就明确 UNKNOWN）
 *
 * 纪律：任何"没拿到"都必须打印 UNKNOWN/THROW —— 绝不允许静默当作通过。
 */
import { existsSync, appendFileSync, writeFileSync } from 'node:fs';

interface ToolDef {
  name: string;
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<string>;
}

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODE = arg('mode', 'status')!;
const PORT = Number(arg('port', '8932'));
const OUT = arg('out', '');           // 干净的"仅工具输出"落盘（stdout 仍保留前言供溯源）
const DSH_VERSION = arg('dsh-version', '')!;
const DESKTOP_JSON =
  'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\primary-runtime\\runtime.json';

const disposers: Array<() => unknown> = [];
const tools = new Map<string, ToolDef>();
const services = new Map<string, unknown>();
const registrations: string[] = [];

const toolsService = { register: (t: ToolDef) => void tools.set(t.name, t) };
const childCtx = {
  get: (k: string) => (k === 'tools' ? toolsService : services.get(k)),
  set: (k: string, v: unknown) => void (services.set(k, v), registrations.push(`set(${k})`)),
  provide: (k: string, v: unknown) => void (services.set(k, v), registrations.push(`provide(${k})`)),
};
const ctx: any = {
  inject: (_d: string[], cb: (c: typeof childCtx) => void) => cb(childCtx),
  get: (k: string) => (k === 'tools' ? toolsService : services.get(k)),
  set: (k: string, v: unknown) => void (services.set(k, v), registrations.push(`set(${k})`)),
  provide: (k: string, v: unknown) => void (services.set(k, v), registrations.push(`provide(${k})`)),
  effect: (fn: () => unknown) => {
    const d = fn();
    if (typeof d === 'function') disposers.push(d as () => unknown);
  },
  plugin: (p: unknown, cfg?: unknown) => void registrations.push(`plugin(${(p as any)?.name ?? String(p)})`),
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
  daemonPort: PORT, // 验证端口段 8931–8960
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  useShellEnvironment: true,
  backgroundWarm: false,
};

const LIB = 'D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts';
console.error(`[probe] entry=${LIB} exists=${existsSync(LIB)}`);
const mod: any = await import(`file:///${LIB}`);
const exec = { signal: new AbortController().signal };

console.log(
  `[probe pid=${process.pid}] mode=${MODE} port=${PORT} dshVersion=${DSH_VERSION || '(desktop)'}`,
);
mod.apply(ctx, config);
console.log(`注册工具: ${[...tools.keys()].join(', ')}`);
console.log(`注册/服务痕迹: ${registrations.length ? registrations.join(', ') : '(none captured by stub)'}`);

const call = async (n: string, a: Record<string, unknown>): Promise<string> => {
  const t = tools.get(n);
  if (!t) throw new Error(`未注册: ${n}`);
  return await t.execute(a, exec);
};
const safe = async (n: string, a: Record<string, unknown>): Promise<string> => {
  try {
    return await call(n, a);
  } catch (e: any) {
    return `THROW(${n}): ${e?.message ?? String(e)}`;
  }
};

if (MODE === 'status') {
  const text = await safe('wsl_status', {});
  if (OUT) writeFileSync(OUT, text + '\n', 'utf8');
  console.log('\n########## wsl_status ##########');
  console.log(text);
} else if (MODE === 'daemon') {
  const action = arg('action', 'status')!;
  const text = await safe('wsl_daemon', { action });
  if (OUT) appendFileSync(OUT, text + '\n', 'utf8');
  console.log(`\n########## wsl_daemon action=${action} ##########`);
  console.log(text);
} else if (MODE === 'exec') {
  const command = arg('command', 'echo probe-ground-truth')!;
  console.log('\n########## wsl_exec ##########');
  console.log(await safe('wsl_exec', { command }));
} else if (MODE === 'services') {
  console.log('\n########## 插件注册痕迹（stub 能看到的） ##########');
  console.log(`services keys: ${[...services.keys()].join(', ') || '(none)'}`);
  console.log(`registrations: ${registrations.join(', ') || '(none)'}`);
  console.log('NOTE: 若 T2 用 ctx.set/provide 之外的方式挂 host 服务，这里会是 none => 记 UNKNOWN，不当通过。');
} else if (MODE === 'snapshot') {
  console.log('\n########## explorer.snapshot（best-effort） ##########');
  const cands: Array<[string, any]> = [];
  for (const k of ['explorer', 'remote-wsl', 'remoteWsl']) {
    const s = services.get(k);
    if (s) cands.push([`services.get('${k}')`, s]);
  }
  const anyCtxGet = (ctx as any).get;
  if (typeof anyCtxGet === 'function') {
    for (const k of ['explorer', 'remote-wsl', 'remoteWsl']) {
      try {
        const s = anyCtxGet.call(ctx, k);
        if (s) cands.push([`ctx.get('${k}')`, s]);
      } catch {}
    }
  }
  let done = false;
  for (const [how, svc] of cands) {
    for (const m of ['snapshot', 'getSnapshot', 'explorerSnapshot']) {
      if (typeof svc?.[m] === 'function') {
        try {
          const out = await svc[m]();
          console.log(`VIA ${how}.${m}()`);
          console.log(JSON.stringify(out, null, 2));
          done = true;
        } catch (e: any) {
          console.log(`THROW ${how}.${m}(): ${e?.message ?? e}`);
        }
      }
    }
  }
  if (!done) console.log('UNKNOWN: 未能从 stub 触到 explorer.snapshot —— 不做结论（面板侧数字改由 DOM 抽取 + wsl_status 差集比对）');
} else {
  throw new Error(`未知 mode: ${MODE}`);
}

for (const d of disposers) {
  try {
    await d();
  } catch {}
}
void sleep;
console.log(`\n[probe pid=${process.pid}] cleanup disposers=${disposers.length}`);
process.exit(0);
