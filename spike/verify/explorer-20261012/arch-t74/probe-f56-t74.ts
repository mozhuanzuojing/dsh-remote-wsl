/**
 * probe-f56-t74.ts —— T74：补 T71 未能判定的两条（**自写构造**，不照抄 T71/T62 的脚本）。
 *
 * 用法：
 *   node probe-f56-t74.ts f56-1b <srcDirRoot>          # ① `/tmp` 残留：**按本进程 winpid 精确计数**
 *   node probe-f56-t74.ts f56-5  <srcDirRoot> --stub    # ② 真 await shutdown 回包（桩：答 initialize、**不答 shutdown**）
 *   node probe-f56-t74.ts f56-5  <srcDirRoot> --real    # ② 真 dsh（对照）
 *
 * <srcDirRoot> = 含 sdk-runtime.ts / wsl-io.ts 的目录（%TEMP% 副本，两态各一份）。
 *
 * 背景：F56-1..4 的正确 pre-fix 基线 = `9c5829a^`(=598543c)；F56-5 = `815f2c8^`。
 * F56-5 的病根（815f2c8 的 3 增 1 删）：`close()` 里 `this.closed = true` 写在 `await request('shutdown')`
 * **之前** ⇒ `request()` 见 `closed` **立刻 reject**（不是等 3s 超时）⇒ **shutdown 帧从来没发出去过**。
 * ⇒ 判据不该只看耗时，要看 **stdin 里到底有没有写出 shutdown 帧**（本探针直接截 `child.stdin.write`）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const MODE = process.argv[2];
const SRCDIR = (process.argv[3] || '').replace(/\\/g, '/');
const FLAG = process.argv[4] || '';
if (!MODE || !SRCDIR) { console.log('usage: node probe-f56-t74.ts <f56-1b|f56-5> <srcDirRoot> [--stub|--real]'); process.exit(2); }

const WINPID = process.pid;                       // ← writeScript 用的就是它：`/tmp/dsh-rwsl-<winpid>-*`
const DISTRO = 'debian-u8-1';
const WSL_HOME = '/home/g/t74-home';              // WSL 侧隔离（与用户/他人隔离）
const HOME = (process.env.TEMP ?? '/tmp') + '\\t74-home';   // Windows 侧隔离
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;

const sh = (script) => String(spawnSync('wsl.exe', ['-d', DISTRO, '-u', 'g', '--', 'bash', '-c', script],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout || '').replace(/\0/g, '').trim();
sh(`mkdir -p ${WSL_HOME}/.dsh/remote-wsl`);
const MINE = () => sh(`ls -1 /tmp/dsh-rwsl-${WINPID}-* 2>/dev/null`);

const sr = await import(`file:///${SRCDIR}/sdk-runtime.ts`);
const wio = await import(`file:///${SRCDIR}/wsl-io.ts`);
const cfg = { distro: DISTRO, wslHome: WSL_HOME, cwd: '/home/g', profile: 'sdk', proxyPort: 9910, timeoutMs: 8000, idleTimeoutMs: 120000 };
const cfgMeta = { ...cfg, config: cfg };
console.log(`== t74 mode=${MODE} flag=${FLAG} src=${SRCDIR} winpid=${WINPID} ==`);

// ───────────────────────────────────────── ① F56-1②：按 winpid 精确计残留
if (MODE === 'f56-1b') {
  const before = MINE();
  let hookCalls = 0;
  const rt = new sr.SdkRuntime({
    key: 't74-enoent', version: '0.2.0-rc.2', cwd: '/home/g', profile: 'sdk',
    promptTimeoutMs: 5000, initTimeoutMs: 5000, env: process.env, log: () => {},
    adapter: sr.runtimeAdapter({
      label: 'host',
      scriptFor: () => `cd /home/g || exit 2\necho t74 >/dev/null\n`,
      spawnRuntime: ({ script }) => {
        const p = wio.writeScript(DISTRO, script);      // ← 脚本落到 /tmp/dsh-rwsl-<本进程 winpid>-*
        rt.__script = p;
        // 不存在的可执行名 ⇒ spawn 抛 ENOENT（脚本已经写下去了，所以"残留"才有意义）
        return spawn('__no_such_exe_t74__', ['-d', DISTRO, '--', 'bash', p], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      },
      closeHook: async () => { hookCalls++; try { wio.removeScript(DISTRO, rt.__script); } catch (e) { console.log(`F56-1② removeScript 抛错: ${e?.message}`); } try { await wio.reapWsl(cfgMeta, rt.__script); } catch (e) { console.log(`F56-1② reapWsl 抛错: ${e?.message}`); } },
      resultProfile: 'host', killMode: 'wrapper', closeResult: 'void',
    }),
  });
  const t0 = Date.now();
  let err = null;
  try { await rt.start(); } catch (e) { err = String(e?.message ?? e); }
  const ms = Date.now() - t0;
  const after = MINE();
  console.log(`F56-1② err=${JSON.stringify(err)} ms=${ms}`);
  console.log(`F56-1② 含 ENOENT = ${/ENOENT|no such file/i.test(String(err))}`);
  console.log(`F56-1② [本进程 winpid=${WINPID}] before=${before ? before.split('\n').filter(Boolean).length : 0} 个 ${JSON.stringify(before)}`);
  console.log(`F56-1② [本进程 winpid=${WINPID}] after =${after ? after.split('\n').filter(Boolean).length : 0} 个 ${JSON.stringify(after)}`);
  console.log(`F56-1② **属于本进程的脚本残留 = ${after ? after.split('\n').filter(Boolean).length : 0}**（0 = 启动失败后没泄漏）`);
  console.log(`F56-1② hookCalls=${hookCalls} closed=${rt.closed} __script=${JSON.stringify(rt.__script ?? null)}`);
  // 隔离"hook 没跑" vs "removeScript 无效"：探针自己再删一次
  if (rt.__script) { try { wio.removeScript(DISTRO, rt.__script); } catch (e) { console.log(`F56-1② 显式 removeScript 抛错: ${e?.message}`); } }
  const afterExplicit = MINE();
  console.log(`F56-1② 探针显式 removeScript 后残留 = ${afterExplicit ? afterExplicit.split('\n').filter(Boolean).length : 0} 个`);
  await rt.close().catch(() => {});
  const afterClose = MINE();
  console.log(`F56-1② close() 后残留 = ${afterClose ? afterClose.split('\n').filter(Boolean).length : 0} 个`);
  if (rt.__script) { try { await wio.sweepOwnTempFiles(cfgMeta, WINPID); } catch {} }
  const afterSweep = MINE();
  console.log(`F56-1② sweepOwnTempFiles(按 winpid) 后残留 = ${afterSweep ? afterSweep.split('\n').filter(Boolean).length : 0} 个`);
  process.exit(0);
}

// ───────────────────────────────────────── ② F56-5：close() 是否真发出 shutdown + 耗时
const frames = [];
const writes = [];
const mkRt = (key, spawnRuntime) => new sr.SdkRuntime({
  key, version: '0.2.0-rc.2', cwd: '/home/g', profile: 'sdk',
  promptTimeoutMs: 60000, quietMs: 3000, graceMs: 20000, initTimeoutMs: 15000,
  env: process.env, log: () => {}, onFrame: (l) => frames.push(l),
  adapter: sr.runtimeAdapter({
    label: 'host', resultProfile: 'host', killMode: 'wrapper', closeResult: 'void',
    scriptFor: ({ cwd, version, profile }) =>
      `${wio.shellPreamble(cfgMeta, { withShellEnv: true })}cd "${cwd}" || exit 2\n` +
      `echo $$ > "\${0%.sh}.pid"\nexec mise exec -- pnpm dlx ${sr.allowBuildFlags()} @deepseek-ai/dsh@${version} --profile ${profile}\n`,
    spawnRuntime,
    closeHook: async () => { try { if (rtScript) { wio.reapWsl(cfgMeta, rtScript); wio.removeScript(DISTRO, rtScript); } } catch {} },
  }),
});
let rtScript = null;

// 截 stdin 写入：这是"shutdown 到底发没发出去"的直接证据
const tapStdin = (child) => {
  const orig = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...rest) => { try { writes.push(String(chunk)); } catch {} return orig(chunk, ...rest); };
  return child;
};

if (FLAG === '--stub') {
  // 桩：**答 initialize**（否则 start() 超时），**故意不答 shutdown** ⇒ 「真 await 回包」的那类夹具
  const stub = `
    let buf='';
    process.stdin.on('data',(d)=>{ buf+=d; let i;
      while((i=buf.indexOf('\\n'))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1);
        if(!line.trim()) continue; let m; try{ m=JSON.parse(line); }catch{ continue; }
        if(m.method==='initialize'){ process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{serverInfo:{name:'t74-stub'}}})+'\\n'); }
        // shutdown：**故意不回**
      } });
    process.stdin.resume();
    setInterval(()=>{},1000);
  `;
  const rt = mkRt('t74-stub', () => tapStdin(spawn(process.execPath, ['-e', stub], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })));
  await rt.start();
  console.log(`F56-5(stub) start OK`);
  const t0 = Date.now();
  const c = await rt.close();
  const ms = Date.now() - t0;
  const sent = writes.some((w) => /"method":"shutdown"/.test(w));
  console.log(`F56-5(stub) close() 耗时 = ${ms}ms`);
  console.log(`F56-5(stub) **stdin 写出 shutdown = ${sent}**（writes=${writes.length} 帧）`);
  console.log(`F56-5(stub) writes=${JSON.stringify(writes.map((w) => (JSON.parse(w).method ?? 'reply')))}`);
  console.log(`F56-5(stub) close() 返回 = ${JSON.stringify(c)}`);
  process.exit(0);
}

if (FLAG === '--real') {
  const rt = mkRt('t74-real', ({ script }) => {
    const p = wio.writeScript(DISTRO, script); rtScript = p;
    return tapStdin(spawn('wsl.exe', ['-d', DISTRO, '--', 'bash', p], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  });
  const ts = Date.now();
  await rt.start();
  console.log(`F56-5(real) start OK ${Date.now() - ts}ms pid=${rt.runtimePid}`);
  const t0 = Date.now();
  const c = await rt.close();
  const ms = Date.now() - t0;
  const sent = writes.some((w) => /"method":"shutdown"/.test(w));
  console.log(`F56-5(real) close() 耗时 = ${ms}ms`);
  console.log(`F56-5(real) **stdin 写出 shutdown = ${sent}**（writes=${writes.length} 帧）`);
  console.log(`F56-5(real) frames=${frames.length}；含 shutdown 应答/痕迹 = ${frames.some((l) => /shutdown/.test(l))}`);
  console.log(`F56-5(real) close() 返回 = ${JSON.stringify(c)}`);
  process.exit(0);
}

console.log('f56-5 需要 --stub 或 --real');
process.exit(2);
