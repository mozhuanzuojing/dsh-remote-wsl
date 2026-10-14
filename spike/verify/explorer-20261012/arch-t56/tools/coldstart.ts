/**
 * coldstart.ts —— T56②：**`initialize timeout 120000ms` 的冷/热启动判定**。
 *
 * 关键设计：**不碰共享缓存**（`~/.cache/pnpm/dlx` 现在 802 MB、是热的，删它会影响别人的守护）。
 * 冷态构造 = 在**副本**的启动脚本里前置一段 env，把 pnpm 的 dlx 缓存/全局目录指到**隔离空目录**：
 *   `export XDG_CACHE_HOME=/tmp/t56-cold/cache; export PNPM_HOME=/tmp/t56-cold/home; export npm_config_store_dir=/tmp/t56-cold/store`
 * ⇒ 首次必然重新物化（真冷），第二次起在隔离目录内是"半热"，再对比默认（共享热缓存）的多次运行。
 *
 * 每次测量：全新副本目录（避开 Node 模块缓存）+ 全新 key（不复用运行时）+ 测完**立刻 close**并查残留。
 * 用法：node --experimental-strip-types coldstart.ts [--root R] [--out J] [--runs 3]
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const OUT = arg('out', '');
const RUNS = Number(arg('runs', '3'));
const DISTRO = 'debian-u8-1';
const VERSION = '0.2.0-rc.2';
const TMP = tmpdir();
const COLD = '/tmp/t56-cold';
const WINPID = process.pid;

const baseCfg = (over: any = {}) => ({
  distro: DISTRO, wslHome: '/home/g', cwd: '/home/g', profile: 'sdk',
  provider: 'deepseek-official', model: 'deepseek-flash',
  timeoutMs: 120000, idleTimeoutMs: 120000, useShellEnvironment: true, proxyPort: 9910, ...over,
});

function copyDir(tag: string): string {
  const dir = join(TMP, `t56-cold-src-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'src'), dir, { recursive: true });
  return dir;
}
/** 冷态变异：在启动脚本最前面（`shellPreamble` 之后、`cd` 之前）插入隔离缓存 env，其余逐字不变。 */
function mutateCold(dir: string): void {
  const p = join(dir, 'in-host-runtime.ts');
  const t = readFileSync(p, 'utf8');
  const anchor = ')}cd "${cwd}" || { echo';
  if (!t.includes(anchor)) throw new Error('冷态变异锚点未命中（scriptFor 的脚本骨架变了？）');
  const env = `)}export XDG_CACHE_HOME=${COLD}/cache PNPM_HOME=${COLD}/home npm_config_store_dir=${COLD}/store\\ncd "\${cwd}" || { echo`;
  writeFileSync(p, t.replace(anchor, env), 'utf8');
}
async function measure(tag: string, cold: boolean) {
  const dir = copyDir(tag);
  if (cold) mutateCold(dir);
  const mod: any = await import(`file:///${dir}/in-host-runtime.ts`);
  const pool = mod.createInHostPool({ config: baseCfg(), version: { version: VERSION }, warmInBackground: () => {} });
  const t0 = Date.now();
  let outcome: any;
  try {
    const rt: any = await pool.getRuntime(`k-${tag}`);
    outcome = { ok: true, ms: Date.now() - t0, pid: rt.runtimePid };
    try { await rt.close(); } catch (e: any) { outcome.closeThrew = `${e?.name}`; }
  } catch (e: any) {
    outcome = { ok: false, ms: Date.now() - t0, error: `${e?.name}: ${String(e?.message).slice(0, 120)}` };
    const rt: any = pool.runtimes.get(`k-${tag}`);
    try { await rt?.close(); } catch { /* ignore */ }
  }
  return { tag, cold, ...outcome };
}
const wsl = (cmd: string) => {
  const p = join(TMP, `t56-wsl2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.sh`);
  writeFileSync(p, cmd + '\n', 'utf8');
  const unix = '/mnt/c/' + p.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/');
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', unix], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  try { rmSync(p, { force: true }); } catch { /* ignore */ }
  return String(r.stdout ?? '').trim();
};

// 冷态起点：确认隔离目录状态（no = 真空缓存）；同时记录共享缓存现状作对照
console.log(`隔离冷缓存 ${COLD} 现在存在？${wsl(`test -d ${COLD} && echo yes || echo no`)}`);
console.log(`共享 dlx 缓存（对照）：${wsl('du -sh ~/.cache/pnpm/dlx 2>/dev/null | cut -f1')}（热）`);

const results: any[] = [];
// 热态：默认共享缓存，重复 RUNS 次
for (let i = 1; i <= RUNS; i++) { const r = await measure(`hot${i}`, false); results.push(r); console.log(`热态#${i}: ${r.ms}ms ok=${r.ok}`); }
// 冷态：隔离空缓存，第 1 次真冷、第 2 次半热（同隔离目录）
const beforeSize = wsl(`du -sh ${COLD} 2>/dev/null | cut -f1`);
for (let i = 1; i <= 2; i++) { const r = await measure(`cold${i}`, true); results.push(r); console.log(`冷态#${i}: ${r.ms}ms ok=${r.ok}${r.error ? ' err=' + r.error : ''}`); }
const afterSize = wsl(`du -sh ${COLD} 2>/dev/null | cut -f1`);

const hot = results.filter((r) => !r.cold).map((r) => r.ms);
const cold = results.filter((r) => r.cold).map((r) => r.ms);
const stat = (a: number[]) => (a.length ? { n: a.length, min: Math.min(...a), max: Math.max(...a), median: [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] } : null);
const summary = { at: new Date().toISOString(), winpid: WINPID, hot: stat(hot), cold: stat(cold), coldCacheSizeBefore: beforeSize || '(不存在)', coldCacheSizeAfter: afterSize || '(不存在)', timeoutMs: 120000, results };
console.log(`\n热态分布：${JSON.stringify(summary.hot)}`);
console.log(`冷态分布：${JSON.stringify(summary.cold)}`);
console.log(`隔离冷缓存体积：${summary.coldCacheSizeBefore} → ${summary.coldCacheSizeAfter}（证明真的重新物化了）`);
console.log(`残留检查：/tmp dsh-rwsl-${WINPID}-* = ${wsl(`ls -1 /tmp/dsh-rwsl-${WINPID}-* 2>/dev/null | wc -l`)}`);
if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
process.exit(0);
