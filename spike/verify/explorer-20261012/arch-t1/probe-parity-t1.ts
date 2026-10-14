/**
 * probe-parity-t1.ts —— 架构债 T1（task-34）：**去重前(HEAD) vs 去重后(工作树)** 的对外字段一致性。
 *
 * 用法：node probe-parity-t1.ts <pluginRoot>
 * 输出：每个被测面的**字段名集合**（不是值 —— 值里有会话数/时间戳这类每次都变的东西）。
 * 判据：两棵树输出的 fields 行必须逐字相同；值行允许不同（只做参考）。
 */
// ── T73：**必须在任何 import src/** 之前**隔离 DSH_HOME**，并在收尾比对用户全局 workspace.json 前后 sha ──
import { isolateDshHome } from '../../arch-t58/tools/dsh-guard.ts';
const dshGuard = isolateDshHome('arch-t1-probe-parity-t1');

const root = process.argv[2];
if (!root) { console.error('需要 pluginRoot'); process.exit(2); }
const mod = await import(`file:///${root.replace(/\\/g, '/')}/src/index.ts`);

const tools = new Map();
const ctx = {
  inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : { register: () => () => {} }) }),
  get: () => undefined,
  effect: () => undefined,
};
mod.apply(ctx, {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
  profile: 'sdk', dshVersion: '', webPort: 3082, idleTimeoutMs: 120000, timeoutMs: 180000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: 'daemon', daemonPort: 8911, daemonPortTries: 3, daemonIdleMs: 1800000,
  daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 12000,
  useShellEnvironment: true, backgroundWarm: false,
});

const { handlers } = (await import(`file:///${root.replace(/\\/g, '/')}/src/explorer.ts`)).createExplorerHandlers({
  config: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', daemonPort: 8912 },
  listDistros: () => ['debian-u8-1'],
  resolveVersion: () => ({ version: '0.2.0-rc.2', desktopVersion: '0.2.0-rc.2', pin: '0.2.0-rc.2', drift: null }),
  writePin: () => true,
  webHosts: new Map(),
  workspaceRegistry: () => undefined,
});

const keysOf = (o) => Object.keys(o ?? {}).sort().join(',');

// ① explorer.snapshot 的形状
const snap = await handlers['explorer.snapshot']({});
console.log(`snapshot.top        = ${keysOf(snap)}`);
console.log(`snapshot.target     = ${keysOf(snap?.target)}`);
console.log(`snapshot.daemon     = ${keysOf(snap?.daemon)}`);

// ② explorer.daemon 的形状（stop 无事可做 + ensure 真起一次；mode=systemd ⇒ 无窗）
const st = await handlers['explorer.daemon']({ action: 'stop', slot: 8912 });
console.log(`daemon.stop.result  = ${keysOf(st)}`);
const en = await handlers['explorer.daemon']({ action: 'ensure', slot: 8912 });
console.log(`daemon.ensure.result= ${keysOf(en)}`);
console.log(`daemon.ensure.mode  = ${en?.mode ?? '-'} warning=${en?.warning === null ? 'null' : typeof en?.warning}`);
await handlers['explorer.daemon']({ action: 'stop', slot: 8912 });

// ③ wsl_status：行标签集合（值里有动态数字，这里只比"有哪些字段/行"）
const txt = String(await tools.get('wsl_status').execute({}, { signal: new AbortController().signal }));
const labels = txt.split('\n').map((l) => (l.split(':')[0] ?? '').trim()).filter(Boolean);
console.log(`wsl_status.labels   = ${[...new Set(labels)].join(' | ')}`);
console.log(`wsl_status.lineCount= ${txt.split('\n').length}`);
// ── T73 断言：用户全局 workspace.json 前后 sha 必须相同（不同 ⇒ 抛错，调用方按非零退出处理）──
dshGuard.assertUnchanged();
process.exit(0);
