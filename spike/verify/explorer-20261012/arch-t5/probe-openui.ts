/**
 * probe-openui.ts —— T47：**真调** `wsl_open_ui` 两态（stop:true / 真正启动），证明 P0 修好。
 *
 * 纪律：
 * · **孤立 DSH_HOME**（`%TEMP%\t47-home`）：本轮一切调用都在孤立 home 下，绝不碰用户全局
 *   `~/.dsh/storages/workspace.json`（上一轮 A5 的教训）；
 * · `open:false` ⇒ 不会去开 Windows 应用窗口；`wsl.exe` 包装层是 `windowsHide`（无 detached，见 F-37 四态矩阵）；
 * · 端口只用 8911–8920。
 *
 * 用法：node probe-openui.ts <port>
 */
import { mkdirSync } from 'node:fs';

const PORT = Number(process.argv[2] || 8915);
const HOME = (process.env.TEMP ?? '/tmp') + '\\t47-home';
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME; // ★ 孤立 home（与"用户全局存储"隔离）

const root = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const mod = await import(`file:///${root}/src/index.ts`);
const tools = new Map();
const ctx = {
  inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : undefined) }),
  get: () => undefined,
  effect: () => undefined,
};
mod.apply(ctx, {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
  profile: 'sdk', dshVersion: '', webPort: PORT, idleTimeoutMs: 120000, timeoutMs: 180000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: 'daemon', daemonPort: 8912, daemonPortTries: 2, daemonIdleMs: 1800000,
  daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
  useShellEnvironment: true, backgroundWarm: false,
});
const tool = tools.get('wsl_open_ui');
console.log(`DSH_HOME(孤立)=${process.env.DSH_HOME}  port=${PORT}  tool=${typeof tool}`);
const call = async (label, args) => {
  const t0 = Date.now();
  try {
    const out = String(await tool.execute(args, { signal: new AbortController().signal }));
    console.log(`[${label}] OK ${Date.now() - t0}ms :: ${out.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
    return { ok: true, out };
  } catch (e) {
    console.log(`[${label}] THREW ${Date.now() - t0}ms :: ${String(e?.name)}: ${String(e?.message).slice(0, 200)}`);
    return { ok: false, out: String(e?.message ?? e) };
  }
};
await call('②a stop:true（无害态）', { port: PORT, stop: true });
const started = await call('②b 真正启动（open:false）', { port: PORT, open: false });
await call('②c 收尾 stop:true', { port: PORT, stop: true });
process.exit(started.ok && /http|url|listening|ok/i.test(started.out) ? 0 : 1);
