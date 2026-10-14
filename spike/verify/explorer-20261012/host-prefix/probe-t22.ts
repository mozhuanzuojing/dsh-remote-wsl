// probe-t22.ts —— task-22：index.ts 双前缀收口的**同一位置真实原文**对照。
// 模式：start / status / fail-inst（伪造发行版，无需改环境）/ fail-on（=on + 托管失败，用于触发双前缀）
const MODE = process.argv[2] || 'start';
const mod = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts');
const tools = new Map();
const toolsSvc = { register: (t) => tools.set(t.name, t) };
const wsSvc = { register: () => () => {} };
const ctx = { inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? toolsSvc : wsSvc) }), get: () => undefined, effect: () => undefined };
const base = {
  distro: MODE === 'fail-inst' ? 'no-such-distro-t22' : 'debian-u8-1',
  wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash', profile: 'sdk',
  dshVersion: '', webPort: 3082, idleTimeoutMs: 120000, timeoutMs: 180000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: 'daemon', daemonPort: 8911, daemonPortTries: 3, daemonIdleMs: 1800000,
  daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 12000,
  useShellEnvironment: true, backgroundWarm: false,
};
mod.apply(ctx, base);
const call = async (n, a) => String(await tools.get(n).execute(a, { signal: new AbortController().signal }));
const audit = (label, text) => {
  const n = (text.match(/remote-wsl:/g) || []).length;
  const doubled = text.includes('remote-wsl: remote-wsl');
  console.log(`[${label}] remote-wsl: 出现次数 = ${n}  双前缀(remote-wsl: remote-wsl) = ${doubled}`);
  return { n, doubled };
};

console.log(`########## mode=${MODE} distro=${base.distro} DSH_REMOTE_WSL_SYSTEMD=${process.env.DSH_REMOTE_WSL_SYSTEMD ?? 'auto'} ##########`);
if (MODE === 'start') {
  const t = await call('wsl_daemon', { action: 'start' });
  console.log(t);
  audit('normal-start', t);
  console.log('--- 收尾 stop ---');
  console.log((await call('wsl_daemon', { action: 'stop' })).split('\n')[0]);
} else if (MODE === 'status') {
  const t = await call('wsl_daemon', { action: 'status' });
  console.log(t);
  audit('normal-status', t);
} else {
  // 失败路径：工具会 throw ⇒ 打印**抛出的原文**（这就是"同一位置的失败文本"）
  let thrown = '';
  try {
    const t = await call('wsl_daemon', { action: 'start' });
    thrown = `(未抛错！) ${t}`;
  } catch (e) {
    thrown = String(e?.message ?? e);
  }
  console.log('THROWN-RAW-START>>>');
  console.log(thrown);
  console.log('<<<THROWN-RAW-END');
  audit(MODE, thrown);
}
process.exit(0);
