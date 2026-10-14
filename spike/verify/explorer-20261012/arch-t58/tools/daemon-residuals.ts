/**
 * daemon-residuals.ts —— T67：daemon 域残余三条，**全部在孤立 state 目录里验**。
 *
 * 隔离原理：`stateDirLinux(cfg) = ${cfg.wslHome}/.dsh/remote-wsl`，且 `scanDaemonProcesses` 只认
 * cmdline 里带 `--state-dir <该目录>` 的进程 ⇒ 把 `wslHome` 指到 `/tmp/t67-*` 就等于**另开一个世界**：
 * 真实 `~/.dsh/remote-wsl` 里别人的守护既不会被停、也不会被算进 `remaining`。
 *
 * 三条：
 *  1. **legacy 单文件记录**（`daemon.json`/`daemon.token`）：种一个（元数据在 + 进程在）⇒ `stop --all` ⇒ 被识别/被停/文件被清。
 *  2. **`remaining>0 ⇒ ok:false`**：把目标 SIGSTOP（兜底 `killWslPid` **只发 TERM**）⇒ 断言 `ok:false` + `remaining` 非空 + 可读原因，
 *     并给 `explorer.daemon{stop}` 的**透传**读数。
 *  3. **连续两次 `--all`** + **重建最小 iso 目录**（两个目录各一守护）证明可重复性。
 *
 * 用法：node --experimental-strip-types daemon-residuals.ts [--root R] [--mode real|red] [--only 1|2|3] [--out J]
 * 退出码：real 0 = 三条全过；red 0 = 确认"把 ok 硬编码 true"会让断言变红。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const MODE = arg('mode', 'real') as 'real' | 'red';
const ONLY = arg('only', '');
const OUT = arg('out', '');
const DISTRO = 'debian-u8-1';
const VERSION = '0.2.0-rc.2';
const WINPID = process.pid;
const TMP = tmpdir();
const REAL_HOME = '/home/g';
/** 孤立世界（每个 world 一个 state 目录；端口只在 8915–8918 内） */
const W = { legacy: { home: '/tmp/t67-legacy', port: 8915 }, remaining: { home: '/tmp/t67-remaining', port: 8916 }, isoA: { home: '/tmp/t67-iso-a', port: 8917 }, isoB: { home: '/tmp/t67-iso-b', port: 8918 } };

// ★★ 纪律（T67 必须）：本脚本会在**进程内** `import src/index.ts` 并 `apply()`（分支 2 的 explorer 透传）。
// 若此时用**默认 DSH_HOME**，就会去碰用户全局 `~/.dsh/storages/workspace.json`（T46 A5 踩过的缝，我在
// T67 首轮**又踩了一次**：15:10:50 那次重建）。所以：**import 之前**先把 `DSH_HOME` 指到孤立目录，
// 并且**前后比 sha** 作为断言。
const ISO_HOME = join(TMP, `t67-dsh-home-${WINPID}`);
rmSync(ISO_HOME, { recursive: true, force: true });
mkdirSync(join(ISO_HOME, 'storages'), { recursive: true });
process.env.DSH_HOME = ISO_HOME;
const GLOBAL_WS = join(homedir(), '.dsh', 'storages', 'workspace.json');
const globalWsSha = (): string | null => { try { return createHash('sha256').update(readFileSync(GLOBAL_WS)).digest('hex'); } catch { return null; } };
const wsShaBefore = globalWsSha();
console.log(`[纪律] 孤立 DSH_HOME = ${ISO_HOME}；用户全局 workspace.json sha(前) = ${wsShaBefore?.slice(0, 16) ?? '(无)'}`);

const wslOut = (cmd: string, timeoutMs = 60000): string => {
  const p = join(TMP, `t67-wsl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.sh`);
  writeFileSync(p, cmd + '\n', 'utf8');
  const unix = '/mnt/c/' + p.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/');
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', unix], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
  return String(r.stdout ?? '').trim();
};
const cfgOf = (w: { home: string; port: number }) => ({
  distro: DISTRO, wslHome: w.home, cwd: '/home/g', profile: 'sdk',
  provider: 'deepseek-official', model: 'deepseek-flash',
  daemonPort: w.port, daemonPortTries: 1, timeoutMs: 60000, daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000, daemonIdleMs: 1800000, daemonQueueLimit: 4, useShellEnvironment: true,
  backend: 'daemon', proxyPort: 9910, webPort: 8919,
});
const stateDir = (w: { home: string }) => `${w.home}/.dsh/remote-wsl`;
const ls = (w: { home: string }) => wslOut(`ls -la ${stateDir(w)} 2>/dev/null | tail -n +2 | awk '{print $5" "$9}' | sort`);
const readFileWsl = (w: { home: string }, name: string) => wslOut(`cat ${stateDir(w)}/${name} 2>/dev/null`);

let srcDir = join(ROOT, 'src');
function prepareRedCopy(): string {
  const dir = join(TMP, `t67-red-src-${WINPID}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'src'), dir, { recursive: true });
  const f = join(dir, 'daemon-lifecycle.ts');
  const t = readFileSync(f, 'utf8');
  const from = 'return { ok: remaining.length === 0, stopped, killed, remaining };';
  if (!t.includes(from)) throw new Error('红测变异锚点未命中（stopAllDaemons 返回行变了？）');
  writeFileSync(f, t.replace(from, 'return { ok: true, stopped, killed, remaining };'), 'utf8'); // 旧缺陷复现：ok 硬编码 true
  console.log(`[红测] 副本已变异：stopAllDaemons 返回行 ok 硬编码 true`);
  return dir;
}
/** 字节取证：副本 vs 真实现的 sha256（`--mode real` 下应完全相同 ⇒ "字节还原"）*/
const shaOfFile = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function printShaEvidence(dir: string, label: string): void {
  const rel = 'daemon-lifecycle.ts';
  const a = shaOfFile(join(dir, rel));
  const b = shaOfFile(join(ROOT, 'src', rel));
  console.log(`[sha] ${label} 副本=${a.slice(0, 16)} 真实现=${b.slice(0, 16)} ⇒ 逐字节相同 = ${a === b}`);
}

const DC = await import(`file:///${MODE === 'red' ? prepareRedCopy() : srcDir}/daemon-client.ts`);
printShaEvidence(MODE === 'red' ? join(TMP, `t67-red-src-${WINPID}`) : srcDir, MODE === 'red' ? '红测（应变）' : 'real（应还原一致）');
const results: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail: string) => { results.push({ id, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`); };
const say = (s: string) => console.log(s);

const realScanBefore = DC.scanDaemonProcesses(cfgOf({ home: REAL_HOME, port: 8915 }));
const realLsBefore = ls({ home: REAL_HOME });

// ── 分支 1：legacy 单文件记录 ──────────────────────────────────────────────────
if (!ONLY || ONLY === '1') {
  say('\n===== 分支 1：legacy 单文件记录（daemon.json）=====');
  const cfg = cfgOf(W.legacy);
  wslOut(`rm -rf ${W.legacy.home}`);
  const ens: any = await DC.ensureDaemon(cfg, { version: VERSION });
  check('1.1 孤立世界里起了真守护', ens?.ok === true && ens?.mode === 'systemd', JSON.stringify({ ok: ens?.ok, slot: ens?.slot, pid: ens?.info?.daemonPid, mode: ens?.mode }));
  const pid = Number(ens?.info?.daemonPid);
  // 手工把槽位记录"降级"成 legacy 单文件记录（daemon.json / daemon.token），删掉槽位文件
  const meta = readFileWsl(W.legacy, `daemon.${W.legacy.port}.json`);
  const token = readFileWsl(W.legacy, `daemon.${W.legacy.port}.token`);
  wslOut(`cd ${stateDir(W.legacy)} && cp daemon.${W.legacy.port}.json daemon.json && cp daemon.${W.legacy.port}.token daemon.token && rm -f daemon.${W.legacy.port}.json daemon.${W.legacy.port}.token && ls -1`);
  const lsLegacy = ls(W.legacy);
  const rec: any = DC.readDaemonRecord(cfg);
  const scan1: any[] = DC.scanDaemonProcesses(cfg);
  check('1.2 legacy 记录被识别（legacy=true 且 port 对得上）', rec?.legacy === true && Number(rec?.meta?.port) === W.legacy.port, JSON.stringify({ legacy: rec?.legacy, slot: rec?.slot, port: rec?.meta?.port, hasToken: !!rec?.token }));
  check('1.3 元数据在 + 进程在（身份扫描看得见）', scan1.some((p: any) => p.pid === pid), JSON.stringify(scan1));
  say(`  种 legacy 前/后的 state 目录：\n    改前(槽位文件) meta=${meta.length}B token=${token.length}B\n    改后: ${lsLegacy.replace(/\n/g, ' | ')}`);
  const stop: any = await DC.stopDaemon(cfg, { all: true, log: (m: string) => say(`    (stop) ${m}`) });
  await new Promise((r) => setTimeout(r, 500));
  const lsAfter = ls(W.legacy);
  const scanAfter: any[] = DC.scanDaemonProcesses(cfg);
  check('1.4 stop --all 认出并停掉了 legacy 守护', stop?.ok === true && stop?.stopped?.some((s: any) => s?.ok === true), JSON.stringify({ ok: stop?.ok, stopped: stop?.stopped?.map((s: any) => ({ ok: s.ok, slot: s.slot, legacy: s.legacy, port: s.port })), remaining: stop?.remaining?.length }));
  check('1.5 legacy 文件被清（daemon.json / daemon.token 都不在了）', !lsAfter.includes('daemon.json') && !lsAfter.includes('daemon.token'), `after=[${lsAfter.replace(/\n/g, ' | ')}]`);
  check('1.6 进程真的没了（身份扫描为空）', scanAfter.length === 0, JSON.stringify(scanAfter));
}

// ── 分支 2：remaining>0 ⇒ ok:false（SIGSTOP 造"杀不死"）────────────────────────
if (!ONLY || ONLY === '2') {
  say('\n===== 分支 2：remaining>0 ⇒ ok:false =====');
  const cfg = cfgOf(W.remaining);
  wslOut(`rm -rf ${W.remaining.home}`);
  const ens: any = await DC.ensureDaemon(cfg, { version: VERSION });
  const pid = Number(ens?.info?.daemonPid);
  check('2.0 孤立世界里起了真守护', ens?.ok === true, JSON.stringify({ ok: ens?.ok, pid }));
  wslOut(`kill -STOP ${pid} && sleep 0.3 && cat /proc/${pid}/stat | awk '{print "state="$3}'`);
  const stoppedPid = wslOut(`ps -o pid,stat= -p ${pid} 2>/dev/null | tr -s ' '`);
  const stop: any = await DC.stopDaemon(cfg, { all: true, log: (m: string) => say(`    (stop) ${m}`) });
  check('2.1 SIGSTOP 后 stop --all 判 ok:false', stop?.ok === false, `ok=${stop?.ok}`);
  check('2.2 remaining 非空且带 pid/port', Array.isArray(stop?.remaining) && stop.remaining.length > 0 && stop.remaining.every((r: any) => Number.isFinite(r.pid)), JSON.stringify(stop?.remaining));
  const readable = (stop?.stopped ?? []).map((s: any) => s?.error).filter(Boolean);
  check('2.3 可读原因（stopped[].error / alivePids）', readable.length > 0, `alivePids=${JSON.stringify((stop?.stopped ?? []).flatMap((s: any) => s?.alivePids ?? []))} reason=${String(readable[0] ?? '').slice(0, 150)}`);
  say(`  完整 JSON：${JSON.stringify(stop).slice(0, 700)}`);

  // 调用方透传：explorer.daemon{action:'stop', slot}
  const tools = new Map<string, any>();
  const services = new Map<string, any>();
  const routes = new Map<string, any>();
  services.set('webServer', { register(r: any) { const k = `${r.kind}:${r.path}`; if (routes.has(k)) throw new Error('dup'); routes.set(k, r); return () => routes.delete(k); } });
  const childCtx: any = { get: (k: string) => (k === 'tools' ? { register: (t: any) => tools.set(t.name, t) } : services.get(k)), set: (k: string, v: unknown) => void services.set(k, v), provide: (k: string, v: unknown) => void services.set(k, v) };
  const ctx: any = { ...childCtx, inject: (_d: string[], cb: (c: unknown) => unknown) => cb(childCtx), effect: (fn: () => unknown) => { const d = fn(); return typeof d === 'function' ? d : undefined; }, plugin: () => {} };
  const idx: any = await import(`file:///${ROOT}/src/index.ts`);
  idx.apply(ctx, cfg);
  const handler = [...routes.values()][0].handler;
  const call = async (method: string, args: unknown) => {
    const res: any = { statusCode: null, headers: {}, bodyText: '', setHeader() {}, end(b: unknown) { this.bodyText = b == null ? '' : String(b); } };
    const req: any = { method: 'POST', headers: { host: `127.0.0.1:${cfg.webPort}`, origin: `http://127.0.0.1:${cfg.webPort}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method, args })); } };
    await handler(req, res);
    let json: any = null; try { json = JSON.parse(res.bodyText); } catch { /* keep */ }
    return { status: res.statusCode, json, text: res.bodyText };
  };
  const es = await call('explorer.daemon', { action: 'stop', slot: W.remaining.port });
  const r2 = es.json?.result ?? es.json;
  check('2.4 explorer.daemon{stop} 透传 ok:false + notes 非空', r2?.ok === false && Array.isArray(r2?.notes) && r2.notes.length > 0, JSON.stringify({ status: es.status, ok: r2?.ok, notes: (r2?.notes ?? []).map((n: string) => n.slice(0, 90)) }));
  say(`  explorer.daemon{stop,slot=${W.remaining.port}} 原始 JSON：${JSON.stringify(r2).slice(0, 600)}`);

  // 收尾：CONT + KILL，再 stop 一次必须 ok:true
  wslOut(`kill -CONT ${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null; sleep 1; echo done`);
  const stop2: any = await DC.stopDaemon(cfg, { all: true });
  check('2.5 解除 STOP 后 stop --all 收干净（ok:true + remaining 空）', stop2?.ok === true && (stop2?.remaining ?? []).length === 0, JSON.stringify({ ok: stop2?.ok, remaining: stop2?.remaining?.length, stopped: stop2?.stopped?.length }));
  say(`  状态：${stoppedPid}`);
}

// ── 分支 3：连续两次 --all + 重建最小 iso 目录（可重复性）──────────────────────
if (!ONLY || ONLY === '3') {
  say('\n===== 分支 3：连续两次 --all + 重建最小 iso 目录 =====');
  const cfg = cfgOf(W.remaining);
  const a: any = await DC.stopDaemon(cfg, { all: true });
  const b: any = await DC.stopDaemon(cfg, { all: true });
  check('3.1 第二次 --all 是空集且 ok:true（无副作用）', b?.ok === true && (b?.stopped ?? []).length === 0 && (b?.killed ?? []).length === 0 && (b?.remaining ?? []).length === 0, JSON.stringify({ first: { ok: a?.ok, stopped: a?.stopped?.length }, second: { ok: b?.ok, stopped: b?.stopped?.length, killed: b?.killed?.length, remaining: b?.remaining?.length } }));
  // 重建最小版：两个孤立目录，各一个守护
  for (const w of [W.isoA, W.isoB]) {
    wslOut(`rm -rf ${w.home}`);
    const e: any = await DC.ensureDaemon(cfgOf(w), { version: VERSION });
    check(`3.2 iso 目录 ${w.home} 起守护（port ${w.port}）`, e?.ok === true, JSON.stringify({ ok: e?.ok, pid: e?.info?.daemonPid, slot: e?.slot }));
  }
  for (const w of [W.isoA, W.isoB]) {
    const s: any = await DC.stopDaemon(cfgOf(w), { all: true });
    check(`3.3 iso 目录 ${w.home} stop --all 收干净`, s?.ok === true && (s?.remaining ?? []).length === 0, JSON.stringify({ ok: s?.ok, remaining: s?.remaining?.length }));
  }
  // 第二个完整循环（重建 → 停）证明可重复
  wslOut(`rm -rf ${W.isoA.home}`);
  const e2: any = await DC.ensureDaemon(cfgOf(W.isoA), { version: VERSION });
  const s2: any = await DC.stopDaemon(cfgOf(W.isoA), { all: true });
  check('3.4 第二轮循环可重复（重建 → 停 成功）', e2?.ok === true && s2?.ok === true, JSON.stringify({ ensureOk: e2?.ok, stopOk: s2?.ok }));
}

// ── 隔离核对：真实 state 目录与"别人的守护"必须一字未变 ────────────────────────
const realScanAfter = DC.scanDaemonProcesses(cfgOf({ home: REAL_HOME, port: 8915 }));
const realLsAfter = ls({ home: REAL_HOME });
const wsShaAfter = globalWsSha();
check('ISO-3 用户全局 `storages/workspace.json` 未被触碰（前后 sha 相同）', wsShaBefore === wsShaAfter, `before=${wsShaBefore?.slice(0, 16)} after=${wsShaAfter?.slice(0, 16)}`);
check('ISO-1 真实 ~/.dsh/remote-wsl 目录未变', realLsBefore === realLsAfter, `before=[${realLsBefore.replace(/\n/g, ' | ')}] after=[${realLsAfter.replace(/\n/g, ' | ')}]`);
check('ISO-2 真实世界里"他人的守护"未被停/未被算进 remaining', JSON.stringify(realScanBefore) === JSON.stringify(realScanAfter), `before=${JSON.stringify(realScanBefore)} after=${JSON.stringify(realScanAfter)}`);
const orphanTmp = wslOut(`ls -1 /tmp/dsh-rwsl-* 2>/dev/null | wc -l`);
say(`\n收尾读数：我的 /tmp 脚本 = ${orphanTmp}；孤立目录 = ${wslOut('ls -d /tmp/t67-* 2>/dev/null | tr "\\n" " "')}`);

// ── 清理孤立世界 ──
wslOut(`rm -rf ${Object.values(W).map((w) => w.home).join(' ')}`);
const fails = results.filter((r) => !r.ok);
const pass = results.length - fails.length;
console.log(`\n模式 ${MODE}：${pass}/${results.length} 通过` + (fails.length ? `；失败：${fails.map((f) => f.id).join(', ')}` : ''));
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), mode: MODE, winpid: WINPID, realScanBefore, realLsBefore, results }, null, 2), 'utf8');
process.exit(MODE === 'real' ? (fails.length ? 1 : 0) : (fails.length ? 0 : 1));
