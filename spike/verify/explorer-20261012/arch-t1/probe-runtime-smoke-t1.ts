/**
 * probe-runtime-smoke-t1.ts —— 架构债 T1（task-34）：**唯一实现**在两个形态下都要真能跑起来。
 *
 * 用法：node probe-runtime-smoke-t1.ts <pluginRoot> <daemon|in-host>
 * 做的事：把插件 apply 到桩 ctx（真 deps），调 `wsl_agent` 跑**一轮真模型调用**，打印输出头部。
 * 判据：两种形态都必须真的拿到模型正文（而不是报错/超时）—— 这是"去重不改行为"的端到端证据。
 */
const root = process.argv[2].replace(/\\/g, '/');
const mode = process.argv[3];
const mod = await import(`file:///${root}/src/index.ts`);

const tools = new Map();
const ctx = {
  inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : { register: () => () => {} }) }),
  get: () => undefined,
  effect: () => undefined,
};
mod.apply(ctx, {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
  profile: 'sdk', dshVersion: '', webPort: 3082, idleTimeoutMs: 120000, timeoutMs: 240000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: mode, daemonPort: 8912, daemonPortTries: 2, daemonIdleMs: 1800000,
  daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
  useShellEnvironment: true, backgroundWarm: false,
});
const tool = tools.get('wsl_agent');
if (!tool) { console.log(`SMOKE ${mode}: FAIL 没注册 wsl_agent`); process.exit(1); }
const t0 = Date.now();
try {
  const out = String(await tool.execute({ task: '请只回复两个字：可以', key: `t1-${mode}-${Date.now()}` }, { signal: new AbortController().signal }));
  const head = out.split('\n').slice(0, 6).join(' \\n ');
  console.log(`SMOKE ${mode}: ok=${/turns=|completedBy=/.test(out)} ms=${Date.now() - t0}`);
  console.log(`SMOKE ${mode}: head=${head.slice(0, 400)}`);
} catch (e) {
  console.log(`SMOKE ${mode}: THREW ms=${Date.now() - t0} :: ${String(e?.message ?? e).slice(0, 300)}`);
  process.exit(1);
}
process.exit(0);
