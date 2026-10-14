/**
 * escape-hatch.ts —— T56①：**宿主逃生舱（`backend='in-host'`）5 个失败分支**的构造与观测。
 *
 * ⚠️ v1 的教训（已修，写在这里防复发）：
 *   · **Node 的模块缓存按 URL** —— v1 每轮把 `src` 复制到**同一个** `%TEMP%\t56-src` 再 `import` 同一路径，
 *     于是**变异根本没生效**：分支 B/E 实际跑的是上一轮的模块（E1/E2 因此真起了运行时、还留下两组孤儿）。
 *   ⇒ 现在**每个分支一个独立副本目录**（URL 唯一），并在运行前断言变异锚点命中。
 *   · **收尾顺序** —— v1 先 `rm -f /tmp/dsh-rwsl-<pid>-*`（含 `.pid`）再收运行时 ⇒ `reapWsl` 失去句柄 ⇒
 *     留下两个孤儿 dsh 运行时（已手动按 cgroup/启动时间确认归属后清除）。现在**先 close 再验残留**。
 *
 * 三条构造原则：
 *  1. **不改 `src/**`**：变异只发生在 `%TEMP%\t56-src-*` 副本上；
 *  2. **优先零变异构造**：A=发行版名写错；D=`cwd` 指向不存在目录（脚本自带 `cd … || exit 2`）；
 *  3. **确定性 > 真实模型**：E 用内联 JSON-RPC 桩当"运行时"（只变异 `spawnRuntime` 一处）。
 *
 * 用法：node --experimental-strip-types escape-hatch.ts [--root R] [--out J] [--only A|B|C|D|E]
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const OUT = arg('out', '');
const ONLY = arg('only', '').toUpperCase();
const DISTRO = 'debian-u8-1';
const VERSION = '0.2.0-rc.2';
const WINPID = process.pid;
const STUB = join(tmpdir(), 't56-stub.cjs');
const TMP = tmpdir();

/** 确定性 JSON-RPC 桩：notext = 只回 reasoning（⇒ 空正文兜底）；rpcerr = prompt 回 JSON-RPC error。 */
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
    if (msg.method === 'initialize') { w({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 't56-stub' } } }); continue; }
    if (msg.method === 'session/prompt') {
      if (mode === 'rpcerr') { w({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'stub boom' } }); continue; }
      w({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'm1' } });
      w({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: 'stub-session', status: 'running' } });
      w({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'stub-session', event: { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'only thinking' }] } } } } });
      w({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'stub-session', event: { type: 'turn/end' } } });
      continue;
    }
    if (msg.method === 'shutdown') { w({ jsonrpc: '2.0', id: msg.id, result: {} }); setTimeout(() => process.exit(0), 20); continue; }
    w({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
setTimeout(() => process.exit(0), 90000);
`;

/** 泄漏探针（**只看 stdout**，别把 wsl.exe 的 NAT 提示混进来）。 */
const wslOut = (cmd: string, timeoutMs = 60000): string => {
  const p = join(TMP, `t56-wsl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.sh`);
  writeFileSync(p, cmd + '\n', 'utf8');
  const unix = '/mnt/c/' + p.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/');
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', unix], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
  return String(r.stdout ?? '').trim();
};
const myTmpNames = (): string[] => wslOut(`ls -1 /tmp/dsh-rwsl-${WINPID}-* 2>/dev/null`).split('\n').map((s) => s.trim()).filter(Boolean);
const strayWrap = (): number => Number((spawnSync('powershell.exe', ['-NoProfile', '-Command',
  `@(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.ParentProcessId -eq ${WINPID} }).Count`],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout ?? '0').trim());
/** WSL 侧仍活着的、属于本进程脚本的进程（按脚本名匹配，**不用 pkill**）。 */
const myWslRuntimes = (): string => wslOut(`ps -eo pid,etimes,cmd | grep "dsh-rwsl-${WINPID}-" | grep -v grep | awk '{print $1"("$2"s)"}' | tr '\\n' ' '`);

/** 每个分支一个**独立副本目录**（⇒ import URL 唯一，绕开 Node 模块缓存）。 */
function freshCopy(tag: string): string {
  const dir = join(TMP, `t56-src-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'src'), dir, { recursive: true });
  writeFileSync(STUB, STUB_SRC, 'utf8');
  return dir;
}
function mutate(dir: string, rel: string, from: string, to: string): void {
  const p = join(dir, rel);
  const t = readFileSync(p, 'utf8');
  if (!t.includes(from)) throw new Error(`变异锚点未命中：${rel} :: ${from.slice(0, 70)}`);
  writeFileSync(p, t.replace(from, to), 'utf8');
}
const baseCfg = (over: any = {}) => ({
  distro: DISTRO, wslHome: '/home/g', cwd: '/home/g', profile: 'sdk',
  provider: 'deepseek-official', model: 'deepseek-flash',
  timeoutMs: 120000, idleTimeoutMs: 120000, useShellEnvironment: true, proxyPort: 9910, ...over,
});
async function loadPool(dir: string, cfg: any) {
  const mod: any = await import(`file:///${dir}/in-host-runtime.ts`);
  return mod.createInHostPool({ config: cfg, version: { version: VERSION }, warmInBackground: () => {} });
}

const records: any[] = [];
async function branch(name: string, fn: (dir: string) => Promise<any>): Promise<void> {
  if (ONLY && !name.startsWith(ONLY)) return;
  console.log(`\n===== 分支 ${name} =====`);
  const tag = name.split('-')[0];
  let rec: any = { branch: name };
  const t0 = Date.now();
  const tmpBefore = myTmpNames();
  try { rec = { ...rec, ...(await fn(freshCopy(tag))) }; }
  catch (e: any) { rec.unexpected = `${e?.name}: ${e?.message}`; }
  rec.ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 300));
  rec.leak = { tmpFilesBefore: tmpBefore, tmpFilesAfter: myTmpNames(), strayWslExe: strayWrap(), wslRuntimes: myWslRuntimes() };
  records.push(rec);
  console.log(JSON.stringify(rec, null, 2));
}

// ── A：启动脚本失败（发行版名写错 ⇒ writeScript 自己的友好报错）+ A2：同 key 重取的表现 ──
await branch('A-启动脚本失败', async (dir) => {
  const pool = await loadPool(dir, baseCfg({ distro: '__t56_no_such_distro__' }));
  let first: any;
  try { await pool.getRuntime('k-A'); first = { verdict: '未抛错（意外）' }; }
  catch (e: any) { first = { threw: `${e.name}: ${e.message.slice(0, 200)}`, poolHolds: pool.runtimes.size }; }
  // A2：失败后**同一个 key** 再取一次 —— 池里的 rt 未被驱逐，看它会不会被交回给调用方
  let a2: any;
  try {
    const again: any = await pool.getRuntime('k-A');
    const rt: any = pool.runtimes.get('k-A');
    a2 = { reacquired: true, sameInstance: again === rt, closed: again.closed, alive: again.alive };
    try { await again.prompt('A2 probe'); a2.promptResult = '未抛错（意外）'; }
    catch (e: any) { a2.promptThrew = `${e.name}: ${String(e.message).slice(0, 200)}`; }
    try { await again.close(); a2.closeResult = 'resolved'; }
    catch (e: any) { a2.closeThrew = `${e.name}: ${String(e.message).slice(0, 160)}`; }
  } catch (e: any) { a2 = { reacquired: false, getRuntimeThrew: `${e.name}: ${String(e.message).slice(0, 160)}` }; }
  return { ...first, A2_sameKeyRetry: a2, tmpFilesAtObservation: myTmpNames() };
});

// ── B：起进程失败（二进制不存在）—— 只把 exe 名改成不存在的，其余照旧（含 writeScript）──
await branch('B-起进程失败', async (dir) => {
  mutate(dir, 'in-host-runtime.ts',
    `spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', state.script]`,
    `spawn('wsl.exe__t56_nope__', ['-d', cfg.distro, '--', 'bash', state.script]`);
  const pool = await loadPool(dir, baseCfg({ timeoutMs: 5000 }));
  try {
    const rt: any = await pool.getRuntime('k-B');
    const r = { verdict: '未抛错（意外）', alive: rt.alive, closed: rt.closed };
    try { await rt.close(); } catch { /* ignore */ }
    return r;
  } catch (e: any) {
    const rt: any = pool.runtimes.get('k-B');
    const r = { threw: `${e.name}: ${e.message.slice(0, 200)}`, poolHolds: !!rt, closed: rt?.closed, alive: rt?.alive, exitCode: rt?.exitCode, tmpFilesAtObservation: myTmpNames() };
    try { await rt?.close(); } catch { /* ignore */ }
    return r;
  }
});

// ── C：initialize 超时 —— 与缓存冷热**无关**的构造：让脚本先睡 8s 再 exec ──
await branch('C-initialize超时', async (dir) => {
  mutate(dir, 'in-host-runtime.ts', `# 记下 PID：exec 之后`, `sleep 8\n# 记下 PID：exec 之后`);
  const pool = await loadPool(dir, baseCfg({ timeoutMs: 2000 }));
  try { const rt = await pool.getRuntime('k-C'); return { verdict: '未超时（意外）', alive: rt.alive }; }
  catch (e: any) {
    const rt: any = pool.runtimes.get('k-C');
    let second: any;
    try { const again = await pool.getRuntime('k-C'); second = { sameInstance: again === rt, closed: again.closed, alive: again.alive }; }
    catch (e2: any) { second = { threwOnRetry: `${e2.name}: ${e2.message.slice(0, 160)}` }; }
    const observed = { threw: `${e.name}: ${e.message.slice(0, 200)}`, poolHolds: !!rt, closed: rt?.closed, alive: rt?.alive, runtimePid: rt?.runtimePid, secondGetRuntime: second, tmpFilesAtObservation: myTmpNames(), wslRuntimesAtObservation: myWslRuntimes() };
    try { await rt?.close(); } catch { /* ignore */ }
    return { ...observed, afterClose: { closed: rt?.closed, exitCode: rt?.exitCode } };
  }
});

// ── D：非零退出（cwd 不存在 ⇒ 脚本自带 `cd … || exit 2`）──
await branch('D-非零退出', async (dir) => {
  const pool = await loadPool(dir, baseCfg({ cwd: '/no/such/dir/t56', timeoutMs: 6000 }));
  try { const rt = await pool.getRuntime('k-D'); return { verdict: '未抛错（意外）', alive: rt.alive }; }
  catch (e: any) {
    const rt: any = pool.runtimes.get('k-D');
    await new Promise((r) => setTimeout(r, 900));
    const observed = { threw: `${e.name}: ${e.message.slice(0, 200)}`, closed: rt?.closed, alive: rt?.alive, exitCode: rt?.exitCode, stderrTail: String(rt?.stderrTail ?? '').replace(/\u0000/g, '').slice(-240) };
    try { await rt?.close(); } catch { /* ignore */ }
    return observed;
  }
});

// ── E：空正文（只回 reasoning）与 prompt() 形状异常（JSON-RPC error）—— 确定性桩 ──
for (const [label, mode] of [['E1-空正文', 'notext'], ['E2-prompt形状异常', 'rpcerr']] as Array<[string, string]>) {
  await branch(label, async (dir) => {
    mutate(dir, 'in-host-runtime.ts',
      `return spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', state.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });`,
      `return spawn(process.execPath, [${JSON.stringify(STUB)}, ${JSON.stringify(mode)}], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });`);
    const pool = await loadPool(dir, baseCfg({ timeoutMs: 15000, idleTimeoutMs: 600000 }));
    const rt: any = await pool.getRuntime(`k-${mode}`);
    try {
      const r = await rt.prompt('T56 stub turn');
      return { resolvedPromptShape: r };
    } catch (e: any) {
      return { promptThrew: `${e.name}: ${e.message.slice(0, 240)}`, closed: rt.closed, alive: rt.alive };
    } finally { try { await rt.close(); } catch { /* ignore */ } }
  });
}

const finalResidue = myTmpNames();
const finalStray = strayWrap();
console.log(`\n收尾：本进程 /tmp 残留 = ${JSON.stringify(finalResidue)}；本进程 wsl.exe 残留 = ${finalStray}`);
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), winpid: WINPID, records, finalResidue, finalStray }, null, 2), 'utf8');
const fails = records.filter((r) => r.unexpected).map((r) => r.branch);
process.exit(fails.length || finalResidue.length ? 1 : 0);
