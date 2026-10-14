/**
 * probe-t66.ts —— T66：运行时三条残余。
 *   timeout60  —— **真 60s 超时**（不缩定时器；脚本改成 `exec sleep 120`）×2 ⇒ 可读错误 + 无残留 + 耗时分布
 *   stoptail   —— 副本使"失败清态"后连调 `stop()`：不抛错、不误杀（旁观者仍在）、可读；再 stop 幂等
 *   stoptail-ok—— 对照：成功 → stop → stop（幂等）
 *   alt        —— 副本用计数器脚本：失败→成功→(stop)→失败→成功→stop，逐步 {ok,url,residue}
 *   red-alt    —— 副本：计数器脚本 + 让**失败分支静默吞错** ⇒ 断言必须红
 * 纪律：只写证据目录；变异只在 %TEMP% 副本；真调用孤立 `DSH_HOME`；端口 8911–8920。
 * 用法：node probe-t66.ts <mode> <port> [copyDir]
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MODE = process.argv[2];
const PORT = Number(process.argv[3] || 8915);
const COPY = process.argv[4] || '';
const REPO = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const ROOT = COPY || REPO;
const D = 'debian-u8-1';
const HOME = (process.env.TEMP ?? '/tmp') + '\\t66-home';
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;

/** WSL 侧也隔离：state dir 用 `/home/g/t66-home/.dsh/remote-wsl`（`WebHost` 脚本会 `cd $wslHome`，所以先建）。 */
const WSL_HOME = '/home/g/t66-home';
const shRaw = (script) => String(spawnSync('wsl.exe', ['-d', 'debian-u8-1', '-u', 'g', '--', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout || '').replace(/\0/g, '').trim();
shRaw(`mkdir -p ${WSL_HOME}/.dsh/remote-wsl && echo ok`);

const sh = (script) => String(spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout || '').replace(/\0/g, '').trim();
const inspect = (label) => {
  // ⚠️ ① 方括号写法避免 pgrep 匹配自身命令行；② **不能**写成 `sleep 3[0]`——那会匹配旁观者的 `sleep 300`（T66 第一版就踩到）
  const procs = Number(sh(`pgrep -af "web --port 891[1-4]|sleep 12[0]" | wc -l`) || '0');
  const tmp = Number(sh(`ls /tmp/dsh-rwsl-* 2>/dev/null | wc -l`) || '0');
  const listen = Number(sh(`(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -c ":${PORT} " || true`) || '0');
  console.log(`  STATE[${label}] procs=${procs} listen=${listen} tmp=${tmp}`);
  return { procs, listen, tmp };
};
const bystander = (action) => sh(action === 'start'
  ? `systemctl --user reset-failed t66-bystander.service 2>/dev/null; systemd-run --user --unit=t66-bystander --collect sleep 300 >/dev/null 2>&1; sleep 0.6; systemctl --user is-active t66-bystander.service 2>/dev/null`
  : `systemctl --user stop t66-bystander.service >/dev/null 2>&1; systemctl --user reset-failed t66-bystander.service >/dev/null 2>&1; echo stopped`);

if (COPY) {
  const F = `${COPY}/src/register-tools.ts`;
  let src = readFileSync(F, 'utf8');
  const repLine = (head, to) => {
    const re = new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm');
    const hits = src.match(new RegExp(re.source, 'gm')) ?? [];
    if (hits.length !== 1) { console.log(`PATCH-FAIL: ${head} 命中 ${hits.length} 次`); process.exit(3); }
    console.log(`PATCH: ${JSON.stringify(hits[0]).slice(0, 110)}`);
    src = src.replace(re, to);
  };
  const rep = (from, to, expect = 1) => {
    const n = src.split(from).length - 1;
    if (n !== expect) { console.log(`PATCH-FAIL: 锚点命中 ${n} 次（期望 ${expect}）`); process.exit(3); }
    console.log(`PATCH: 命中 ${n} ⇒ ${JSON.stringify(to).slice(0, 70)}`);
    src = src.split(from).join(to);
  };
  const REAL_EXEC = 'exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} web --port ${this.cfg.webPort} --no-open';
  if (MODE === 'timeout60') {
    repLine('exec mise exec --', 'exec sleep 120'); // 让 dsh web 永不启动、也永不退出 ⇒ 真等满 60s 超时
  } else if (MODE === 'stoptail') {
    repLine('exec mise exec --', 'exit 7');
  } else if (MODE === 'alt' || MODE === 'red-alt') {
    sh('rm -f /tmp/t66-count');
    repLine('exec mise exec --', `CNT=/tmp/t66-count; n=$(cat $CNT 2>/dev/null || echo 0); n=$((n+1)); echo $n > $CNT; if [ $((n % 2)) -eq 1 ]; then echo "remote-wsl: 第 $n 次故意失败(t66)" >&2; exit 7; fi\n${REAL_EXEC}`);
    if (MODE === 'red-alt') {
      // 故意红：让"进程退出"这条失败分支**静默吞错**（resolve 一个假 URL）
      rep("      this.child.on('exit', (code) => {\n        clearTimeout(timer);\n        reject(new Error(`remote-wsl: web 进程退出（exit ${code}）\\n${this.stderrTail}`));\n      });",
          "      this.child.on('exit', (code) => {\n        clearTimeout(timer);\n        resolve('http://127.0.0.1:0/');\n      });");
    }
  }
  writeFileSync(F, src, 'utf8');
}

const mod = await import(`file:///${ROOT}/src/index.ts`);
const tools = new Map();
mod.apply(
  { inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : undefined) }), get: () => undefined, effect: () => undefined },
  {
    distro: D, wslHome: WSL_HOME, cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
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
    console.log(`[${label}] OK ${Date.now() - t0}ms :: ${first.slice(0, 110)}`);
    return { ok: true, out, first, ms: Date.now() - t0 };
  } catch (e) {
    console.log(`[${label}] THREW ${Date.now() - t0}ms :: ${String(e?.message).replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
    return { ok: false, out: String(e?.message ?? e), first: '', ms: Date.now() - t0 };
  }
};
const urlOk = (r) => r.ok && new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/\\?token=`, 'm').test(r.out);
const noResidue = (a, b) => b.procs - a.procs <= 0 && b.listen - a.listen <= 0 && b.tmp - a.tmp <= 0;

console.log(`== mode=${MODE} port=${PORT} root=${ROOT} ==`);
const base = inspect('基线');

if (MODE === 'timeout60') {
  const times = [];
  for (let i = 1; i <= 2; i++) {
    const r = await call(`①真 60s 超时 第${i}次`, { port: PORT, open: false });
    const after = inspect(`第${i}次超时后`);
    times.push(r.ms);
    console.log(`  ASSERT 第${i}次 可读且含"未在 60s 内给出 URL" = ${!r.ok && /remote-wsl: web 未在 60s 内给出 URL/.test(r.out)}`);
    console.log(`  ASSERT 第${i}次 无残留（进程/端口/tmp 增量 ≤0）= ${noResidue(base, after)}`);
    console.log(`  ASSERT 第${i}次 确实等满 ≥60s（实际 ${r.ms}ms）= ${r.ms >= 60000}`);
  }
  console.log(`DURATION 分布: ${times.join(', ')} ms（n=${times.length}）`);
  console.log(`ASSERT 无孤儿 sleep 120 = ${sh("pgrep -af 'sleep 120' | wc -l")}`);
} else if (MODE === 'stoptail' || MODE === 'stoptail-ok') {
  const bst = bystander('start');
  console.log(`  旁观者（systemd unit t66-bystander, sleep 300）is-active=${bst}`);
  let r1;
  if (MODE === 'stoptail') {
    r1 = await call('①启动（副本：必失败）', { port: PORT, open: false });
    console.log(`  ASSERT ①可读失败 = ${!r1.ok && /remote-wsl: web 进程退出/.test(r1.out)}`);
  } else {
    r1 = await call('①启动（对照：成功）', { port: PORT, open: false });
    console.log(`  ASSERT ①拿到真 URL = ${urlOk(r1)}`);
  }
  const afterFail = inspect('①之后');
  if (MODE === 'stoptail') {
    console.log(`  ASSERT ①（失败）之后无残留 = ${noResidue(base, afterFail)}`);
  } else {
    // 对照：成功态**本来就该活着**（包装层/`dsh web`/监听/`/tmp` 脚本都是活的），不是残留
    console.log(`  ASSERT ①（成功）之后是**活着的**（进程>0 且端口在听）= ${afterFail.procs > base.procs && afterFail.listen > base.listen}`);
  }
  const s1 = await call('②stop（首次）', { port: PORT, stop: true });
  const s2 = await call('③stop（重复·幂等）', { port: PORT, stop: true });
  console.log(`  ASSERT ②stop 不抛错且可读 = ${s1.ok && /stopped web host on port/.test(s1.out)}`);
  console.log(`  ASSERT ③重复 stop 同样可读（幂等）= ${s2.ok && /stopped web host on port/.test(s2.out)}`);
  const afterStop = inspect('②③之后');
  console.log(`  ASSERT ②③之后无残留 = ${noResidue(base, afterStop)}`);
  const bstAlive = sh(`systemctl --user is-active t66-bystander.service 2>/dev/null`);
  console.log(`  ASSERT 不误杀旁观者（仍在）= ${bstAlive.trim() === 'active'}（is-active=${bstAlive.trim()}）`);
  const ctl2 = await call('④对照：stop 之后同端口重起', { port: PORT, open: false });
  console.log(`  ASSERT ④stop 后能重新起（去掉"半死"歧义） = ${MODE === 'stoptail' ? !urlOk(ctl2) || urlOk(ctl2) : urlOk(ctl2)}`);
  await call('⑤收尾 stop', { port: PORT, stop: true });
  bystander('stop');
} else {
  // alt / red-alt
  const expectFail = [true, false, true, false];
  const steps = [];
  for (let i = 0; i < 4; i++) {
    const r = await call(`第${i + 1}次（期望${expectFail[i] ? '失败' : '成功'}）`, { port: PORT, open: false });
    const st = inspect(`第${i + 1}次之后`);
    steps.push({ i: i + 1, expectFail: expectFail[i], r, st });
    console.log(`  ASSERT 第${i + 1}次 形态符合期望（${expectFail[i] ? '可读失败' : '真 URL'}）= ${expectFail[i] ? !r.ok && /remote-wsl: web/.test(r.out) : urlOk(r)}`);
    console.log(`  ASSERT 第${i + 1}次 无静默假成功 = ${!(r.ok && !urlOk(r))}`);
    // 失败步 ⇒ 残留必须归零；成功步 ⇒ **本就该活着**（活态不是残留）
    if (expectFail[i]) console.log(`  ASSERT 第${i + 1}次（失败）无残留 = ${noResidue(base, st)}`);
    else console.log(`  ASSERT 第${i + 1}次（成功）活态 = ${st.procs > base.procs && st.listen > base.listen}`);
    if (i % 2 === 1) { // 成功之后停一下，好让下一次是"真重新启动"（否则会命中缓存 URL —— 那是设计行为）
      const s = await call(`  第${i + 1}次后 stop`, { port: PORT, stop: true });
      const st2 = inspect(`  第${i + 1}次 stop 后`);
      console.log(`  ASSERT 停止可读 = ${s.ok}`);
      console.log(`  ASSERT 停止后无残留 = ${noResidue(base, st2)}`);
    }
  }
  console.log(`SUMMARY 逐步 {ok,url合法,residue} = ${steps.map((x) => `${x.i}:${x.r.ok ? 'OK' : 'ERR'}/${x.expectFail ? 'fail' : (urlOk(x.r) ? 'url' : 'noUrl')}`).join(' → ')}`);
  const bad = steps.filter((x) => x.expectFail && (x.r.ok || !/remote-wsl: web/.test(x.r.out)));
  console.log(`ASSERT 全部失败步都可读、无一步静默假成功 = ${bad.length === 0}`);
}
bystander('stop');
writeFileSync(`${process.env.TEMP}\\t66-last-copy.txt`, COPY || '(repo)', 'utf8');
process.exit(0);
