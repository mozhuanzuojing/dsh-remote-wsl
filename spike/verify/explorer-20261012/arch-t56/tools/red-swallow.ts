/**
 * red-swallow.ts —— T56③：**故意红 ≥1**。在副本上把某个失败分支改成"静默吞错"，
 * 断言必须变红；**字节还原**后必须复绿（证明断言真的在测那条分支，而不是恒绿）。
 *
 * 变异点：`createInHostPool.getRuntime` 里的 `await rt.start();`
 *   → `try { await rt.start(); } catch { /* swallow *\/ }`
 * 断言：分支 A（启动脚本失败：发行版名写错）**必须**抛错。
 *   · 变异版：吞掉错误 ⇒ 断言"未抛错" ⇒ **红**（exit 1）
 *   · 还原版：抛友好错误 ⇒ 断言通过 ⇒ **绿**（exit 0）
 *
 * 用法：node --experimental-strip-types red-swallow.ts [--root R] [--out J]
 */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const OUT = arg('out', '');
const TMP = tmpdir();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function assertBranchAThrows(dir: string): Promise<{ ok: boolean; detail: string }> {
  const mod: any = await import(`file:///${dir}/in-host-runtime.ts`);
  const cfg = {
    distro: '__t56_no_such_distro__', wslHome: '/home/g', cwd: '/home/g', profile: 'sdk',
    provider: 'deepseek-official', model: 'deepseek-flash', timeoutMs: 5000, idleTimeoutMs: 5000,
    useShellEnvironment: true, proxyPort: 9910,
  };
  const pool = mod.createInHostPool({ config: cfg, version: { version: '0.2.0-rc.2' }, warmInBackground: () => {} });
  try { const rt: any = await pool.getRuntime('k-red'); return { ok: false, detail: `未抛错（拿到 runtime，alive=${rt.alive}，child=${rt.child === undefined ? 'undefined' : 'obj'}）` }; }
  catch (e: any) { return { ok: true, detail: `${e.name}: ${String(e.message).slice(0, 120)}` }; }
}

const records: any[] = [];
for (const mode of ['mutated', 'restored'] as Array<'mutated' | 'restored'>) {
  const dir = join(TMP, `t56-red-src-${mode}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, 'src'), dir, { recursive: true });
  const target = join(dir, 'in-host-runtime.ts');
  const original = readFileSync(target, 'utf8');
  const before = sha(original);
  if (mode === 'mutated') {
    const anchor = '    await rt.start();';
    if (!original.includes(anchor)) throw new Error('红测变异锚点未命中：await rt.start();');
    writeFileSync(target, original.replace(anchor, '    try { await rt.start(); } catch { /* T56 红测：静默吞错 */ }'), 'utf8');
  } else {
    writeFileSync(target, original, 'utf8'); // 字节还原（副本内）
  }
  const after = sha(readFileSync(target, 'utf8'));
  const res = await assertBranchAThrows(dir);
  // 本轮"故意红"的判定：mutated 必须 **不抛错**（=断言会红）；restored 必须 抛错（=断言复绿）
  const expected = mode === 'mutated' ? res.ok === false : res.ok === true;
  records.push({ mode, shaBefore: before, shaAfter: after, bytesIdenticalToOriginal: mode === 'restored' ? before === after : false, assertionSawThrow: res.ok, detail: res.detail, verdict: expected ? '符合预期' : '不符合预期' });
  console.log(`[${mode}] sha=${after.slice(0, 12)} 断言看到抛错=${res.ok} ⇒ ${expected ? '符合预期 ✓' : '不符合预期 ✗'}  ${res.detail}`);
}
// 原始文件的 sha（作为"还原 = 逐字节回到原样"的参照）
const srcSha = sha(readFileSync(join(ROOT, 'src/in-host-runtime.ts'), 'utf8'));
const redVerdict = records[0].assertionSawThrow === false && records[1].assertionSawThrow === true;
console.log(`\n还原后副本 sha == 真实现 sha : ${records[1].shaAfter === srcSha}（真实现 ${srcSha.slice(0, 12)}）`);
console.log(redVerdict
  ? '结果：PASS —— 吞错版让断言失效（红），还原版断言恢复（绿）⇒ 断言确实在测这条分支'
  : '结果：FAIL —— 红/绿对照不成立');
if (OUT) writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), srcSha, records, redVerdict }, null, 2), 'utf8');
process.exit(redVerdict ? 0 : 1);
