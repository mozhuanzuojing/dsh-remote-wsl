/**
 * probe-f56.ts —— T71：**独立复验** T62 的 F56-1..5（自写构造，不照抄作者脚本）。
 *
 * 用法：node probe-f56.ts <mode> <pluginRoot> [port]
 *   f56-1  spawn ENOENT（exe 名不存在）⇒ ①错误可读且**不伪装成 initialize 超时** ②`/tmp` 不残留
 *   f56-2  子进程非零退出（`cwd` 不存在 ⇒ 脚本 `cd … || exit 2`）⇒ **真因 + exitCode 上行**
 *   f56-3  同 key 再取（宿主逃生舱池）⇒ 可用或**明确报错**，绝不裸 `TypeError … reading 'stdin'`
 *   f56-4  真实运行时被杀死后 `prompt()` ⇒ 可读错误 + `closed===true && alive===false` + `lastTurnError`
 *   f56-5  真实运行时 `close()` ⇒ **真的发出 shutdown**（`onFrame` 里能看到 shutdown 应答）+ 耗时毫秒级
 */
import { mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const MODE = process.argv[2];
const ROOT = (process.argv[3] || 'D:/project/dsh1/vendor/dsh-remote-wsl').replace(/\\/g, '/');
const PORT = Number(process.argv[4] || 8911);
const HOME = (process.env.TEMP ?? '/tmp') + '\\t71-home';
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;
const WSL_HOME = '/home/g/t71-home';
const sh = (script) => String(spawnSync('wsl.exe', ['-d', 'debian-u8-1', '-u', 'g', '--', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).stdout || '').replace(/\0/g, '').trim();
sh(`mkdir -p ${WSL_HOME}/.dsh/remote-wsl`);

const sr = await import(`file:///${ROOT}/src/sdk-runtime.ts`);
const cfg = {
  distro: 'debian-u8-1', wslHome: WSL_HOME, cwd: '/home/g', profile: 'sdk', proxyPort: 9910,
  timeoutMs: 8000, idleTimeoutMs: 120000,
};
const tag = ROOT.includes('TEMP') ? ROOT.split('\\').pop() : 'repo';
console.log(`== mode=${MODE} root=${ROOT} tag=${tag} ==`);

if (MODE === 'f56-1') {
  // 用宿主形态 adapter + 一个**不存在的可执行名** ⇒ spawn 抛 ENOENT（脚本已被 writeScript 落到 /tmp ⇒ 才问得到残留）
  const wio = await import(`file:///${ROOT}/src/wsl-io.ts`);
  let hookCalls = 0;
  const before = Number(sh(`ls /tmp/dsh-rwsl-* 2>/dev/null | wc -l`) || '0');
  const rt = new sr.SdkRuntime({
    key: 't71-enoent', version: '0.2.0-rc.2', cwd: '/home/g', profile: 'sdk',
    promptTimeoutMs: 5000, initTimeoutMs: 5000, env: process.env, log: () => {},
    adapter: sr.runtimeAdapter({
      label: 'host',
      scriptFor: ({ cwd, version, profile }) => `cd "${cwd}" || exit 2\nexec mise exec -- pnpm dlx @deepseek-ai/dsh@${version} --profile ${profile}\n`,
      spawnRuntime: ({ script }) => {
        const p = wio.writeScript(cfg.distro, script);
        rt.__script = p;
        return spawn('__no_such_exe_t71__', ['-d', cfg.distro, '--', 'bash', p], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      },
      closeHook: async () => { hookCalls++; try { wio.removeScript(cfg.distro, rt.__script); } catch {} try { wio.reapWsl(cfg, rt.__script); } catch {} },
      resultProfile: 'host', killMode: 'wrapper', closeResult: 'void',
    }),
  });
  const t0 = Date.now();
  let err = null;
  try { await rt.start(); } catch (e) { err = String(e?.message ?? e); }
  const ms = Date.now() - t0;
  const after = Number(sh(`ls /tmp/dsh-rwsl-* 2>/dev/null | wc -l`) || '0');
  console.log(`F56-1 err=${JSON.stringify(err)} ms=${ms}`);
  console.log(`F56-1 含 ENOENT = ${/ENOENT|no such file/i.test(String(err))}`);
  console.log(`F56-1 伪装成超时 = ${/(timeout|超时)/i.test(String(err))}`);
  console.log(`F56-1 tmp before=${before} after=${after} 增量=${after - before}`);
  console.log(`F56-1 closeHook 调用次数=${hookCalls} closed=${rt.closed}（hook 没被调 ⇒ 收尾路径没走到；被调而文件还在 ⇒ removeScript 没删掉）`);
  await rt.close().catch(() => {});
  sh(`ls /tmp/dsh-rwsl-* 2>/dev/null | while read -r f; do wp=$(basename "$f" | sed -n 's/^dsh-rwsl-\\([0-9]*\\)-.*/\\1/p'); if [ -z "$wp" ] || [ ! -d "/proc/$wp" ]; then rm -f "$f" "\${f%.sh}.pid" 2>/dev/null; fi; done`);
  process.exit(0);
}

if (MODE === 'f56-2' || MODE === 'f56-3') {
  // 宿主逃生舱池：`cwd` 不存在 ⇒ 脚本 `exit 2`（非零退出）；同时验"同 key 再取"
  const ihr = await import(`file:///${ROOT}/src/in-host-runtime.ts`);
  const pool = ihr.createInHostPool({ config: { ...cfg, cwd: '/home/g/__no_such_dir_t71__' }, version: { version: '0.2.0-rc.2' }, warmInBackground: () => {} });
  let e1 = null;
  try { await pool.getRuntime(`t71-${MODE}`); } catch (e) { e1 = String(e?.message ?? e); }
  console.log(`F56-2 第1次 err=${JSON.stringify(e1)}`);
  console.log(`F56-2 含真因 exit 2 = ${/exit 2/.test(String(e1))}；含 exitCode/退出 = ${/(exit|退出)/.test(String(e1))}`);
  if (MODE === 'f56-3') {
    let e2 = null; let rt2 = null;
    try { rt2 = await pool.getRuntime(`t71-${MODE}`); } catch (e) { e2 = String(e?.message ?? e); }
    console.log(`F56-3 第2次（同 key）err=${JSON.stringify(e2)} rt2=${rt2 ? 'object' : 'null'}`);
    // 关键：如果池把"坏运行时"当可用对象返回，调 prompt 会炸裸 TypeError
    let t3 = null;
    if (rt2) { try { await rt2.prompt('x'); } catch (e) { t3 = `${e?.name}: ${e?.message}`; } }
    console.log(`F56-3 prompt() 结果=${JSON.stringify(t3)}`);
    console.log(`F56-3 出现裸 TypeError(reading 'stdin') = ${/TypeError.*stdin/.test(String(t3))}`);
    console.log(`F56-3 明确报错或可用 = ${t3 === null || !/TypeError/.test(String(t3))}`);
  }
  process.exit(0);
}

// f56-4 / f56-5：需要**真实**运行时（孤立 WSL home + 真 dsh）
const frames = [];
const mkRt = (key) => new sr.SdkRuntime({
  key, version: '0.2.0-rc.2', cwd: '/home/g', profile: 'sdk', promptTimeoutMs: 60000, quietMs: 3000, graceMs: 20000,
  initTimeoutMs: 120000, env: process.env, log: () => {}, onFrame: (l) => frames.push(l),
  adapter: sr.runtimeAdapter({
    label: 'host',
    stderrTailLimit: 8000, initTimeoutMs: 120000, guardStdinWrite: false, logSpawnError: false,
    sawAssistantRequiresText: false, requireAliveOnPrompt: false,
    quietLabels: { quiet: null, grace: null }, fallbackMode: 'close-read-log', resultProfile: 'host',
    killMode: 'wrapper', closeResult: 'void',
    scriptFor: ({ cwd, version, profile }) => {
      const wio = wioMod;
      return `${wio.shellPreamble(cfg, { withShellEnv: true })}cd "${cwd}" || exit 2\necho $$ > "\${0%.sh}.pid"\nexec mise exec -- pnpm dlx ${sr.allowBuildFlags()} @deepseek-ai/dsh@${version} --profile ${profile}\n`;
    },
    spawnRuntime: ({ script }) => {
      const wio = wioMod;
      const p = wio.writeScript(cfg.distro, script); rtScript = p;
      return spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', p], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    },
    closeHook: async () => { wioMod.reapWsl(cfg, rtScript); wioMod.removeScript(cfg.distro, rtScript); },
  }),
});
const wioMod = await import(`file:///${ROOT}/src/wsl-io.ts`);
let rtScript = null;

const rt = mkRt(`t71-${MODE}`);
console.log(`F56 ${MODE}: start 中（真 dsh，孤立 home=${WSL_HOME}）…`);
const ts = Date.now();
await rt.start();
console.log(`F56 ${MODE}: start OK ${Date.now() - ts}ms pid=${rt.runtimePid}`);

if (MODE === 'f56-4') {
  // 让运行时真的死掉，再发一轮 ⇒ 断言状态与实际一致
  try { rt.child.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1200));
  let perr = null;
  try { await rt.prompt('t71'); } catch (e) { perr = `${e?.name}: ${e?.message}`; }
  console.log(`F56-4 prompt 后 err=${JSON.stringify(perr)}`);
  console.log(`F56-4 closed=${rt.closed} alive=${rt.alive} exitCode=${rt.exitCode} lastTurnError=${JSON.stringify(rt.lastTurnError ?? null)}`);
  console.log(`F56-4 状态与实际一致（closed && !alive）= ${rt.closed === true && rt.alive === false}`);
  const c = await rt.close();
  console.log(`F56-4 close() => ${JSON.stringify(c)}`);
} else {
  const t0 = Date.now();
  const c = await rt.close();
  const ms = Date.now() - t0;
  const sentShutdown = frames.some((l) => /"id":\d+.*"result"/.test(l) || /shutdown/.test(l));
  console.log(`F56-5 close() 耗时 = ${ms}ms；frames=${frames.length}；含 shutdown 痕迹 = ${sentShutdown}`);
  console.log(`F56-5 close() 返回 = ${JSON.stringify(c)} exited字段=${c && typeof c === 'object' ? String('exited' in c) : 'n/a'}`);
}
process.exit(0);
