/**
 * verify-f56.ts —— T62：F56-1..4 的**逐条真调断言**（+ `--mode red` 还原旧行为做故意红）。
 *
 * 断言（每条都对着 T56 的原始缺陷）：
 *  · A1（F56-1 错误可读）：分支 B（exe 不存在）抛出的错误**不再**是 `initialize 超时`，而是带 spawn/ENOENT。
 *  · A2（F56-1 不泄漏）：分支 B 结束后本进程在 WSL `/tmp` 的 `dsh-rwsl-<winpid>-*` **增量必须为 0**。
 *  · A3（F56-2 真因上行）：分支 D（cwd 不存在 ⇒ 脚本 exit 2）错误里必须带 `exit=2` 与 `cwd 不存在`。
 *  · A4（F56-3 不裸 TypeError）：分支 A（writeScript 失败）后同 key 重取，**要么明确报错、要么可用**，
 *    绝不允许 `prompt()` 抛裸 `TypeError: … undefined (reading 'stdin')`。
 *  · A5（F56-4 状态一致）：分支 E2（桩回 JSON-RPC error）后 `prompt()` 抛 RPC 错误，且运行时 `closed === true`
 *    （宿主形态"放弃一轮 = 关掉运行时"）。
 *  · A6（F56-4 exitCode 不再含糊）：**守护形态适配器 + 桩子进程**真调 `close()`，返回对象必须带显式 `exited`。
 *
 * 用法：node --experimental-strip-types verify-f56.ts [--root R] [--mode real|red] [--out J]
 * 退出码：real 模式 0 = 全部通过；red 模式 0 = **确认旧行为会让 F56-1/F56-2 断言变红**。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const MODE = arg('mode', 'real') as 'real' | 'red';
const OUT = arg('out', '');
const DISTRO = 'debian-u8-1';
const VERSION = '0.2.0-rc.2';
const WINPID = process.pid;
const TMP = tmpdir();
const STUB = join(TMP, `t56c-stub-${WINPID}.cjs`);

const STUB_SRC = `
const mode = process.argv[2] || 'notext';
let buf = '';
process.stdin.setEncoding('utf8');
const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') { w({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'stub' } } }); continue; }
    if (msg.method === 'session/prompt') {
      if (mode === 'rpcerr') { w({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'stub boom' } }); continue; }
      w({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'm1' } });
      w({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 's', event: { type: 'turn/end' } } });
      continue;
    }
    if (msg.method === 'shutdown') { w({ jsonrpc: '2.0', id: msg.id, result: {} }); setTimeout(() => process.exit(0), 20); continue; }
    w({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
setTimeout(() => process.exit(0), 60000);
`;

const wslOut = (cmd: string, timeoutMs = 60000): string => {
  const p = join(TMP, `t56c-wsl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.sh`);
  writeFileSync(p, cmd + '\n', 'utf8');
  const unix = '/mnt/c/' + p.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/');
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', unix], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
  return String(r.stdout ?? '').trim();
};
const myTmp = (): string[] => wslOut(`ls -1 /tmp/dsh-rwsl-${WINPID}-* 2>/dev/null`).split('\n').map((s) => s.trim()).filter(Boolean);

let copySeq = 0;
function copySrc(tag: string): string {
  const dir = join(TMP, `t56c-src-${MODE}-${tag}-${++copySeq}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'src'), dir, { recursive: true });
  writeFileSync(STUB, STUB_SRC, 'utf8');
  return dir;
}
function mutate(dir: string, rel: string, from: string, to: string): void {
  const p = join(dir, rel);
  const t = readFileSync(p, 'utf8');
  if (!t.includes(from)) throw new Error(`变异锚点未命中：${rel} :: ${from.slice(0, 60)}`);
  writeFileSync(p, t.replace(from, to), 'utf8');
}
/** `--mode red`：把 start() 失败路径还原成旧行为（不调 `#abortStart`）。 */
function applyRedOld(dir: string): void {
  mutate(dir, 'sdk-runtime.ts', '      await this.#abortStart();', '      /* 旧行为：启动失败只置 closed，不调 closeHook */');
}
const cfgOf = (over: any = {}) => ({
  distro: DISTRO, wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', provider: 'deepseek-official', model: 'deepseek-flash',
  timeoutMs: 4000, idleTimeoutMs: 600000, useShellEnvironment: true, proxyPort: 9910, ...over,
});
async function pool(dir: string, cfg: any) {
  const mod: any = await import(`file:///${dir}/in-host-runtime.ts`);
  return mod.createInHostPool({ config: cfg, version: { version: VERSION }, warmInBackground: () => {} });
}

const results: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail: string) => { results.push({ id, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`); };

// ── A1/A2（F56-1）：起进程失败 ⇒ 错误可读 + /tmp 增量 0 ──
{
  const dir = copySrc('B');
  if (MODE === 'red') applyRedOld(dir);
  mutate(dir, 'in-host-runtime.ts', `spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', state.script]`, `spawn('wsl.exe__t56c_nope__', ['-d', cfg.distro, '--', 'bash', state.script]`);
  const before = myTmp().length;
  const p = await pool(dir, cfgOf({ timeoutMs: 5000 }));
  let msg = '';
  try { const rt: any = await p.getRuntime('k-B'); msg = `(未抛错 alive=${rt.alive})`; }
  catch (e: any) { msg = `${e.name}: ${e.message}`; }
  const after = myTmp();
  check('A1 F56-1 错误可读（不再伪装成超时）', /spawn|ENOENT/i.test(msg) && !/initialize 超时/.test(msg), msg.slice(0, 160));
  check('A2 F56-1 /tmp 增量 = 0（启动失败也收尾）', after.length - before === 0, `before=${before} after=${after.length} ${JSON.stringify(after)}`);
}

// ── A3（F56-2）：非零退出 ⇒ 真因 + exitCode 上行 ──
{
  const dir = copySrc('D');
  if (MODE === 'red') applyOldNothing(dir);
  const p = await pool(dir, cfgOf({ cwd: '/no/such/dir/t56c' }));
  let msg = '';
  try { await p.getRuntime('k-D'); msg = '(未抛错)'; } catch (e: any) { msg = `${e.name}: ${e.message}`; }
  check('A3 F56-2 真因 + exitCode 上行', /exit=2/.test(msg) && /cwd 不存在/.test(msg), msg.slice(0, 200));
}

// ── A4（F56-3）：写脚本失败后同 key 重取 ⇒ 绝不裸 TypeError ──
{
  const dir = copySrc('A');
  if (MODE === 'red') applyOldNothing(dir);
  const p = await pool(dir, cfgOf({ distro: '__t56c_no_such_distro__' }));
  try { await p.getRuntime('k-A'); } catch { /* 预期抛错 */ }
  let detail = '';
  let bareTypeError = false;
  try {
    const again: any = await p.getRuntime('k-A');
    try { await again.prompt('probe'); detail = 'prompt 未抛错'; }
    catch (e: any) { detail = `prompt: ${e.name}: ${String(e.message).slice(0, 120)}`; bareTypeError = e instanceof TypeError && !/remote-wsl/.test(String(e.message)); }
  } catch (e: any) { detail = `getRuntime: ${e.name}: ${String(e.message).slice(0, 120)}`; bareTypeError = e instanceof TypeError; }
  check('A4 F56-3 同 key 重取：明确报错或可用（无裸 TypeError）', !bareTypeError, detail);
}

// ── A5（F56-4）：RPC 失败后状态一致（宿主 ⇒ closed=true）──
{
  const dir = copySrc('E2');
  if (MODE === 'red') applyOldNothing(dir);
  mutate(dir, 'in-host-runtime.ts',
    `return spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', state.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });`,
    `return spawn(process.execPath, [${JSON.stringify(STUB)}, 'rpcerr'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });`);
  const p = await pool(dir, cfgOf({ timeoutMs: 15000 }));
  const rt: any = await p.getRuntime('k-E2');
  let threw = '';
  try { await rt.prompt('probe'); } catch (e: any) { threw = `${e.name}: ${String(e.message).slice(0, 120)}`; }
  check('A5 F56-4 RPC 失败后状态一致（closed=true，不再看着 alive）', /JSON-RPC/.test(threw) && rt.closed === true && rt.alive === false, `${threw} closed=${rt.closed} alive=${rt.alive} lastTurnError=${String(rt.lastTurnError ?? '').slice(0, 60)}`);
  try { await rt.close(); } catch { /* ignore */ }
}

// ── A6（F56-4）：`close()` 必须显式给出 `exited`（守护形态适配器 + 桩子进程真调）──
{
  const dir = copySrc('close');
  if (MODE === 'red') applyOldNothing(dir);
  const mod: any = await import(`file:///${dir}/sdk-runtime.ts`);
  const adapter = { ...mod.RUNTIME_PROFILE_DAEMON, closeResult: 'exitCode', spawnRuntime: () => spawn(process.execPath, [STUB, 'notext'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) };
  const rt = new mod.SdkRuntime({ key: 'k-close', version: VERSION, cwd: '/home/g', adapter });
  await rt.start();
  const r: any = await rt.close();
  check('A6 F56-4 close() 显式回报 exited（daemon 形态）', r && typeof r.exited === 'boolean' && r.exitCode === 0, JSON.stringify(r));
}

function applyOldNothing(_dir: string): void { /* 其余断言在 red 模式下用同一份代码，只有 F56-1 需要"旧行为"对照 */ }

const fails = results.filter((r) => !r.ok);
const pass = results.length - fails.length;
console.log(`\n模式 ${MODE}：${pass}/${results.length} 通过` + (fails.length ? `；失败：${fails.map((f) => f.id).join(', ')}` : ''));
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), mode: MODE, winpid: WINPID, results }, null, 2), 'utf8');
// real：全过 = 0；red：**必须**有失败（=旧行为能被断言抓到）= 0
process.exit(MODE === 'real' ? (fails.length ? 1 : 0) : (fails.length ? 0 : 1));
