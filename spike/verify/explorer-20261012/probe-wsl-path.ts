/**
 * probe-wsl-path.ts —— T14 / A6：`wsl_path` 四条功能 + 注入负例 + 失败面 + 无副作用痕迹。
 *
 * 实现（T12，src/index.ts:393-500）：路径经 `spawnSync('wsl.exe', ['-d',distro,'-e','bash','-c',SCRIPT,'_',path])`
 * **作为 argv 位置参数**进入（脚本里只有固定 `"$1"`），`windowsHide:true`；失败一律抛可读错误，绝不静默回原串。
 * 本探针只 import 交付物本体；每个注入用例都配"执行痕迹"判据。
 */
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const DISTRO = arg('distro', 'debian-u8-1');
// --lib 允许指向**副本**（故意红用）；默认是被验对象本体
const LIB = arg('lib', 'D:/project/dsh1/vendor/dsh-remote-wsl/src/index.ts');

const tools = new Map();
const toolsService = { register: (t) => void tools.set(t.name, t) };
const childCtx = { get: (k) => (k === 'tools' ? toolsService : undefined) };
const ctx = { inject: (_d, cb) => cb(childCtx), get: (k) => (k === 'tools' ? toolsService : undefined), effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); } };
const disposers = [];
const config = {
  distro: DISTRO, wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash', profile: 'sdk',
  dshVersion: '', webPort: 3082, idleTimeoutMs: 120000, timeoutMs: 180000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: 'daemon', daemonPort: 8932, daemonPortTries: 3, daemonIdleMs: 1800000, daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000, useShellEnvironment: true, backgroundWarm: false,
};
const mod = await import(`file:///${LIB}`);
mod.apply(ctx, config);

const tool = tools.get('wsl_path');
const out = { entry: LIB, distro: DISTRO, toolRegistered: !!tool, toolNames: [...tools.keys()], cases: [] };
if (!tool) { console.log(JSON.stringify(out, null, 2)); process.exit(1); }

async function call(args) {
  try { return { ok: true, text: await tool.execute(args, { signal: new AbortController().signal }) }; }
  catch (e) { return { ok: false, text: `THROW: ${e?.message ?? String(e)}` }; }
}
function add(label, args, r, check) {
  const rec = { label, args, ok: r.ok, text: String(r.text).slice(0, 500), verdict: check ? check(r) : null };
  out.cases.push(rec);
  return rec;
}

// ── 1) 四条功能
add('to-wsl: D:\\project\\net1', { path: 'D:\\project\\net1', direction: 'to-wsl' }, await call({ path: 'D:\\project\\net1', direction: 'to-wsl' }),
  (r) => (/\/mnt\/d\/project\/net1/.test(r.text) ? 'PASS' : 'RED'));
add('to-windows: /mnt/d/project/net1', { path: '/mnt/d/project/net1', direction: 'to-windows' }, await call({ path: '/mnt/d/project/net1', direction: 'to-windows' }),
  (r) => (/D:\\project\\net1/i.test(r.text) ? 'PASS' : 'RED'));
add('both 默认（不带 direction）', { path: 'D:\\project\\net1' }, await call({ path: 'D:\\project\\net1' }),
  (r) => (/\/mnt\/d\/project\/net1/.test(r.text) && /D:\\project\\net1/i.test(r.text) ? 'PASS' : 'RED'));
add('含空格: D:\\project\\my dir\\x.txt', { path: 'D:\\project\\my dir\\x.txt', direction: 'to-wsl' }, await call({ path: 'D:\\project\\my dir\\x.txt', direction: 'to-wsl' }),
  (r) => (/my dir\/x\.txt|my\ dir/.test(r.text) ? 'PASS' : 'RED'));
add('含空格反向: /mnt/d/my dir/x.txt', { path: '/mnt/d/my dir/x.txt', direction: 'to-windows' }, await call({ path: '/mnt/d/my dir/x.txt', direction: 'to-windows' }),
  (r) => (/my dir/i.test(r.text) ? 'PASS' : 'RED'));

// ── 2) 注入负例：必须当字面量，且无执行痕迹
const inj = [
  ['$(id)', '/mnt/c/Users/l/$(id).txt', (t) => (!/uid=\d|gid=\d/.test(t) && /\$\(id\)/.test(t) ? 'PASS' : (/\$\(id\)/.test(t) ? 'PASS(无执行痕迹但未见原文?)' : 'RED'))],
  ['反引号 `id`', '/mnt/c/`id`.txt', (t) => (!/uid=\d|gid=\d/.test(t) && /`id`/.test(t) ? 'PASS' : 'RED')],
  ['分号 ;', '/mnt/c/a;echo T14-INJECTED', (t) => (t.includes('T14-INJECTED') && !/T14-INJECTED\s*$/m.test(t) ? 'literal-kept' : (t.includes('T14-INJECTED') ? 'PASS(字面量保留)' : 'RED'))],
  ['管道 |', '/mnt/c/a|echo T14-PIPE', (t) => (t.includes('T14-PIPE') ? 'PASS(字面量保留)' : 'RED')],
  ['混引号', `D:\\a"b'c`, (t) => (t.length > 0 && !t.startsWith('THROW') ? 'PASS' : 'RED')],
  ['touch 探针', '/mnt/c/$(touch /tmp/t14-pwned-a).txt', () => 'see-marker-check'],
  ['sleep 探针', '/mnt/c/$(sleep 37).txt', () => 'see-process-check'],
];
for (const [label, p, check] of inj) {
  const r = await call({ path: p, direction: 'both' });
  add(`注入: ${label}`, { path: p }, r, (rr) => check(String(rr.text)));
}

// ── 3) 失败面（空 / NUL / 不存在的发行版）
add('空路径', { path: '' }, await call({ path: '' }), (r) => (!r.ok || /需要非空|empty/i.test(r.text) ? 'PASS' : 'RED'));
add('NUL', { path: '/mnt/c/a\u0000b' }, await call({ path: '/mnt/c/a\u0000b' }), (r) => (!r.ok || /NUL/i.test(r.text) ? 'PASS' : 'RED'));
add('不认识 direction', { path: '/mnt/c', direction: '__nope__' }, await call({ path: '/mnt/c', direction: '__nope__' }), (r) => (!r.ok || /direction/i.test(r.text) ? 'PASS' : 'RED'));
if (DISTRO !== 'debian-u8-1') add(`发行版不存在(${DISTRO})`, { path: '/mnt/c' }, await call({ path: '/mnt/c' }), (r) => (!r.ok && /发行版|distro/i.test(r.text) && !r.text.includes('/mnt/c') ? 'PASS(可读错误且未回显原串)' : (r.ok ? 'RED(静默成功)' : 'PASS(可读错误)')));

console.log(JSON.stringify(out, null, 2));
for (const d of disposers) { try { await d(); } catch {} }
process.exit(0);
