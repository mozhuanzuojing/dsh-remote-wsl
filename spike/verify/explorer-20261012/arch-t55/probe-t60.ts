/**
 * probe-t60.ts —— T60：`WebHost.start()` 失败后同端口重试**不得**再出现 `OK + null`。
 *
 * 模式：
 *   success    —— 真仓库：成功三态回归（start → 真 URL → stop → 再 start）
 *   once       —— 副本：让**第一次**启动失败（marker + exit 7），第二次必须**真重启成功**
 *   alwaysfail —— 副本：每次都 `exit 7` ⇒ 两次都必须**可读报错**，且失败后**无残留**
 *   red        —— 副本：`register-tools.ts` 换回 **HEAD（修复前）**版本 ⇒ 第二次应复现 `OK 0ms :: null`（断言红）
 *
 * 纪律：真调用一律**孤立 `DSH_HOME`**；变异只在 `%TEMP%` 副本；端口 8911–8920。
 * 用法：node probe-t60.ts <mode> <port> [copyDir]
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MODE = process.argv[2];
const PORT = Number(process.argv[3] || 8915);
const COPY = process.argv[4] || '';
const REPO = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const ROOT = COPY || REPO;
const D = 'debian-u8-1';
const HOME = (process.env.TEMP ?? '/tmp') + '\\t60-home';
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;

const sh = (script) => String(spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).stdout || '').replace(/\0/g, '').trim();
const inspect = (label) => {
  const procs = Number(sh(`pgrep -af "dsh.*web --port ${PORT}|sleep 30" | wc -l`) || '0');
  const tmp = Number(sh(`ls /tmp/dsh-rwsl-* 2>/dev/null | wc -l`) || '0');
  const listen = Number(sh(`(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c ":${PORT} " || true`) || '0');
  console.log(`STATE[${label}] procs=${procs} listen=${listen} tmp=${tmp}`);
  return { procs, listen, tmp };
};

if (COPY) {
  const F = `${COPY}/src/register-tools.ts`;
  let src = readFileSync(F, 'utf8');
  const repLine = (head, to) => {
    const re = new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm');
    const hits = src.match(new RegExp(re.source, 'gm')) ?? [];
    if (hits.length !== 1) { console.log(`PATCH-FAIL: ${head} 命中 ${hits.length} 次`); process.exit(3); }
    console.log(`PATCH: ${JSON.stringify(hits[0]).slice(0, 120)}`);
    src = src.replace(re, to);
  };
  if (MODE === 'once') {
    sh(`rm -f /tmp/t60-once-${PORT}`);
    repLine('exec mise exec --', `if [ ! -f /tmp/t60-once-${PORT} ]; then touch /tmp/t60-once-${PORT}; echo "remote-wsl: 首次故意失败(exit 7)" >&2; exit 7; fi\nexec mise exec -- pnpm dlx \${allowBuildFlags()} @deepseek-ai/dsh@\${this.version} web --port \${this.cfg.webPort} --no-open`);
  } else if (MODE === 'alwaysfail') {
    repLine('exec mise exec --', 'exit 7');
  }
  writeFileSync(F, src, 'utf8');
}

const mod = await import(`file:///${ROOT}/src/index.ts`);
const tools = new Map();
mod.apply(
  { inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : undefined) }), get: () => undefined, effect: () => undefined },
  {
    distro: D, wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
    profile: 'sdk', dshVersion: '', webPort: PORT, idleTimeoutMs: 120000, timeoutMs: 60000,
    desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
    proxyPort: 9910, backend: 'daemon', daemonPort: 8912, daemonPortTries: 2, daemonIdleMs: 1800000,
    daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
    useShellEnvironment: true, backgroundWarm: false,
  },
);
const tool = tools.get('wsl_open_ui');
const call = async (label, args) => {
  const t0 = Date.now();
  try {
    const out = String(await tool.execute(args, { signal: new AbortController().signal }));
    const first = out.split('\n')[0];
    console.log(`[${label}] OK ${Date.now() - t0}ms :: ${first.slice(0, 120)}`);
    return { ok: true, out, first };
  } catch (e) {
    console.log(`[${label}] THREW ${Date.now() - t0}ms :: ${String(e?.message).replace(/\n/g, ' ⏎ ').slice(0, 160)}`);
    return { ok: false, out: String(e?.message ?? e) };
  }
};
const urlOk = (r) => r.ok && new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?token=`, 'm').test(r.out);
const bogus = (r) => r.ok && !urlOk(r); // 报 OK 但 URL 不是可用 URL ⇒ 静默假成功

console.log(`== mode=${MODE} port=${PORT} root=${ROOT} ==`);
if (MODE === 'success') {
  const s1 = await call('①start', { port: PORT, open: false });
  const st = await call('②stop', { port: PORT, stop: true });
  const s2 = await call('③start again', { port: PORT, open: false });
  await call('④stop', { port: PORT, stop: true });
  console.log(`ASSERT 成功三态：①真 URL=${urlOk(s1)} ②stop ok=${st.ok} ③再起真 URL=${urlOk(s2)}`);
  console.log(`ASSERT 无静默假成功 = ${!bogus(s1) && !bogus(s2)}`);
} else {
  const before = inspect('调用前');
  const c1 = await call('①第一次', { port: PORT, open: false });
  const afterFail = inspect('第一次失败后（未 stop）');
  const d1 = { procs: afterFail.procs - before.procs, listen: afterFail.listen - before.listen, tmp: afterFail.tmp - before.tmp };
  console.log(`DELTA[第一次失败后] procs=${d1.procs} listen=${d1.listen} tmp=${d1.tmp}`);
  console.log(`ASSERT 第一次必须失败且可读 = ${!c1.ok && /remote-wsl: web (进程退出|未在)/.test(c1.out)}`);
  console.log(`ASSERT 第一次不是静默假成功 = ${!bogus(c1)}`);
  console.log(`ASSERT 失败后无残留（进程/端口/tmp 增量都为 0） = ${d1.procs <= 0 && d1.listen <= 0 && d1.tmp <= 0}`);
  const c2 = await call('②同端口第二次', { port: PORT, open: false });
  console.log(`ASSERT 第二次**绝不** OK+null（静默假成功）= ${!bogus(c2)}`);
  if (MODE === 'once') {
    console.log(`ASSERT 第二次真的重启成功（拿到真 URL）= ${urlOk(c2)}`);
  } else if (MODE === 'alwaysfail') {
    console.log(`ASSERT 第二次仍可读报错（不是假成功）= ${!c2.ok && /remote-wsl: web/.test(c2.out)}`);
  } else if (MODE === 'red') {
    console.log(`ASSERT 【红态期望为 false】第二次没有静默假成功 = ${!bogus(c2)}`);
  }
  await call('③收尾 stop:true', { port: PORT, stop: true });
  const afterStop = inspect('stop 后');
  const d2 = { procs: afterStop.procs - before.procs, listen: afterStop.listen - before.listen, tmp: afterStop.tmp - before.tmp };
  console.log(`DELTA[stop 后] procs=${d2.procs} listen=${d2.listen} tmp=${d2.tmp}`);
}
process.exit(0);
