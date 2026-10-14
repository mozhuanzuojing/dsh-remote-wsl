/**
 * probe-t55.ts —— 补 T47 的两条未复核：① `open:true` 分支（**记录器法，绝不开真窗**）；
 * ② `WebHost.start()` 的失败/超时路径（可读错误 + 无孤儿 + /tmp 无残留）。
 *
 * 纪律：**不改 `src/**`** —— 每个模式都把 `src/` 整目录复制到 `%TEMP%\t55-<mode>-<rand>\src`，
 * 只在**副本**上做字符串/整行替换（带命中次数断言），再从副本 import。真调用一律 **孤立 `DSH_HOME`**。
 * 量具：`/tmp` 与进程数都用**增量**（本探针每次都是新 winpid，绝对数会含历史残留）。
 *
 * 用法：node probe-t55.ts <recorder|exit|timeout|red-swallow> <port>
 */
// ── T73：本工具自己设了孤立 DSH_HOME；这里补"用户全局 workspace.json 前后 sha"闭环 ──
import { watchGlobalWorkspace } from '../../arch-t58/tools/dsh-guard.ts';
const dshGuard = watchGlobalWorkspace();

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MODE = process.argv[2] || 'recorder';
const PORT = Number(process.argv[3] || 8916);
const REPO = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const HOME = (process.env.TEMP ?? '/tmp') + '\\t55-home';
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME; // 孤立 home

const sh = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return String(spawnSync('wsl.exe', ['-d', 'debian-u8-1', '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout || '').replace(/\0/g, '').trim();
};
const inspect = (label) => {
  const procs = Number(sh(`pgrep -af 'dsh.*web --port ${PORT}|sleep 30' | wc -l`) || '0');
  const tmp = Number(sh(`ls /tmp/dsh-rwsl-* 2>/dev/null | wc -l`) || '0');
  const listen = Number(sh(`(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c ":${PORT} " || true`) || '0');
  console.log(`STATE[${label}] wslProcs=${procs} wslListener=${listen} tmpScripts=${tmp}`);
  return { procs, listen, tmp };
};

const COPY = `${process.env.TEMP}\\t55-${MODE}-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(`${COPY}\\src`, { recursive: true });
cpSync(`${REPO}/src`, `${COPY}/src`, { recursive: true });
console.log(`COPY=${COPY}`);
console.log(`DSH_HOME(孤立)=${process.env.DSH_HOME}  mode=${MODE}  port=${PORT}`);

const F = `${COPY}/src/register-tools.ts`;
let src = readFileSync(F, 'utf8');
const rep = (from, to, expect = 1) => {
  const n = src.split(from).length - 1;
  if (n !== expect) { console.log(`PATCH-FAIL: 锚点命中 ${n} 次（期望 ${expect}）: ${JSON.stringify(from).slice(0, 90)}`); process.exit(3); }
  src = src.split(from).join(to);
  console.log(`PATCH ${MODE}: 命中 ${n} 处 ⇒ 替换为 ${JSON.stringify(to).slice(0, 60)}`);
};
/** 整行替换（行尾随仓库演进会变，例如 `--no-open`）——锚行首、吃到行尾。 */
const repLine = (head, to) => {
  const re = new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm');
  const hits = src.match(new RegExp(re.source, 'gm')) ?? [];
  if (hits.length !== 1) { console.log(`PATCH-FAIL: 整行锚点命中 ${hits.length} 次（期望 1）: ${head}`); process.exit(3); }
  console.log(`PATCH ${MODE}(整行): ${JSON.stringify(hits[0]).slice(0, 110)} ⇒ ${JSON.stringify(to)}`);
  src = src.replace(re, to);
};
const OPEN_CALL = "(args?.open ?? true) ? openAppWindow(url) : 'not-opened'";
const TIMEOUT_LINE = '() => reject(new Error(`remote-wsl: web 未在 60s 内给出 URL\\n${this.stderrTail}`)),';
if (MODE === 'recorder') rep(OPEN_CALL, "(args?.open ?? true) ? (globalThis.__t55_url = url, 'recorded-t55') : 'not-opened'");
else if (MODE === 'exit') repLine('exec mise exec --', 'exit 7');
else { repLine('exec mise exec --', 'exec sleep 30'); rep('        60000,', '        1500,'); if (MODE === 'red-swallow') rep(TIMEOUT_LINE, "() => resolve('http://127.0.0.1:0/'),"); }
writeFileSync(F, src, 'utf8');

const mod = await import(`file:///${COPY}/src/index.ts`);
const tools = new Map();
mod.apply(
  { inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : undefined) }), get: () => undefined, effect: () => undefined },
  {
    distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
    profile: 'sdk', dshVersion: '', webPort: PORT, idleTimeoutMs: 120000, timeoutMs: 60000,
    desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
    proxyPort: 9910, backend: 'daemon', daemonPort: 8912, daemonPortTries: 2, daemonIdleMs: 1800000,
    daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
    useShellEnvironment: true, backgroundWarm: false,
  },
);
const tool = tools.get('wsl_open_ui');
const own = () => sh(`ls /tmp/dsh-rwsl-${process.pid}-* 2>/dev/null | wc -l`);
console.log(`OWN-WINPID=${process.pid}（调用前自己名下的 /tmp 脚本 = ${own()}）`);
const state0 = inspect('调用前');

const call = async (label, args) => {
  const t0 = Date.now();
  try {
    const out = String(await tool.execute(args, { signal: new AbortController().signal }));
    console.log(`[${label}] OK ${Date.now() - t0}ms :: ${out.split('\n').slice(0, 3).join(' | ').slice(0, 240)}`);
    return { ok: true, out };
  } catch (e) {
    console.log(`[${label}] THREW ${Date.now() - t0}ms :: ${String(e?.name)}: ${String(e?.message).replace(/\n/g, ' ⏎ ').slice(0, 260)}`);
    return { ok: false, out: String(e?.message ?? e), name: String(e?.name) };
  }
};

const started = await call(MODE === 'recorder' ? '①open:true（记录器）' : `②${MODE}`, MODE === 'recorder' ? { port: PORT, open: true } : { port: PORT, open: false });
if (MODE === 'recorder') {
  const rec = globalThis.__t55_url;
  console.log(`RECORDER url=${rec ?? '(未记录到)'}`);
  console.log(`ASSERT 记录器被走到且 URL 形状正确 = ${typeof rec === 'string' && new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?token=`).test(rec)}`);
} else if (MODE === 'exit') {
  console.log(`ASSERT 可读错误(非裸抛) = ${started.ok === false && started.name === 'Error' && /remote-wsl: web 进程退出（exit 7）/.test(started.out)}`);
} else if (MODE === 'timeout') {
  console.log(`ASSERT 可读错误(非裸抛) = ${started.ok === false && started.name === 'Error' && /remote-wsl: web 未在/.test(started.out)}`);
} else {
  console.log(`ASSERT 故意红（失败被吞掉 ⇒ 这里应为 false）= ${started.ok === false && /remote-wsl: web 未在/.test(started.out)}`);
}

// 追加测：失败后**同端口再调一次**（WebHost 已在 webHosts 里、且 start() 开头是 `if (this.child) return this.url`）
if (MODE === 'retry') {
  const second = await call('②retry 同端口第二次', { port: PORT, open: false });
  const usable = second.ok && new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?token=`, 'm').test(second.out);
  console.log(`ASSERT 第二次返回的是**可用的 http URL**（可用=正常重试；false 且报 OK ⇒ **静默假成功**，缺陷）= ${usable}`);
}

const afterFail = inspect('调用后（未清理）');
await call('收尾 stop:true', { port: PORT, stop: true });
const afterStop = inspect('stop 之后');
const d = (a, b) => ({ procs: b.procs - a.procs, listen: b.listen - a.listen, tmp: b.tmp - a.tmp });
const dFail = d(state0, afterFail);
const dStop = d(state0, afterStop);
console.log(`DELTA[调用后] procs=${dFail.procs} listen=${dFail.listen} tmp=${dFail.tmp}（本进程自己的 /tmp 脚本 = ${own()}）`);
console.log(`DELTA[stop 后] procs=${dStop.procs} listen=${dStop.listen} tmp=${dStop.tmp}`);
console.log(`ASSERT 本调用是否留下残留（procs/listen/tmp 任一 > 0）= ${dFail.procs > 0 || dFail.listen > 0 || dFail.tmp > 0}`);
console.log(`ASSERT 本调用的残留被 stop 清干净 = ${dStop.procs <= 0 && dStop.listen <= 0 && dStop.tmp <= 0}`);
writeFileSync(`${process.env.TEMP}\\t55-last-copy.txt`, COPY, 'utf8');
// ── T73 断言：用户全局 workspace.json 前后 sha 必须相同（不同 ⇒ 抛错，调用方按非零退出处理）──
dshGuard.assertUnchanged();
process.exit(0);
