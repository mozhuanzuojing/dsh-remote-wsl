/**
 * guard-red.ts —— T70 的**故意红（零风险版）**：真文件一个字节都不碰。
 *
 * 为什么这样红：本任务明令"绝不再写真实 `~/.dsh/storages/workspace.json`"，而"去掉隔离 ⇒ 断言红"这种
 * 传统红测**必须**去写真文件才能演示 —— 所以换成两条**等价且零副作用**的构造：
 *   ① **替身文件**：把护栏观察的路径用 `T70_WATCH_WS` 指到 `%TEMP%` 的替身，先证明"替身没变 ⇒ 断言过"，
 *      再改动替身 ⇒ **断言必须抛**（= 断言真的有牙）；
 *   ② **顺序门禁**：在 `%TEMP%` 造一棵最小树放**修好的** `smoke-e2e.ts` 副本 ⇒ 普查判 ✓（exit 0）；
 *      把 `isolateDshHome(...)` 那行**挪到 `import src/index.ts` 之后** ⇒ 普查必须判 ✗（exit 1）；
 *      字节还原 ⇒ 复绿（exit 0）。这直接测"隔离必须发生在 import 之前"这条判据。
 *
 * 用法：node --experimental-strip-types guard-red.ts [--root <repoRoot>]
 * 退出码：0 = 两条都按预期（有牙）；1 = 有一条没红（量具没牙）
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateDshHome } from './dsh-guard.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const TMP = tmpdir();
const results: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail: string) => { results.push({ id, ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`); };

// ── ① 替身文件：证明"前后 sha 断言"真的有牙 ──────────────────────────────────
{
  const decoy = join(TMP, `t70-decoy-${process.pid}.json`);
  writeFileSync(decoy, '{"v":"A"}', 'utf8');
  process.env.T70_WATCH_WS = decoy;
  const g1 = isolateDshHome('t70-red-decoy');
  let firedWhenUnchanged = false;
  try { g1.assertUnchanged(); } catch { firedWhenUnchanged = true; }
  check('①-a 替身未变 ⇒ 断言通过（不误报）', !firedWhenUnchanged, `decoy=${decoy}`);
  writeFileSync(decoy, '{"v":"B"}', 'utf8'); // 模拟"某工具改写了用户文件"
  let firedWhenChanged = false;
  try { g1.assertUnchanged(); } catch (e: any) { firedWhenChanged = true; console.log(`       断言抛出的原文：${String(e?.message).slice(0, 120)}`); }
  check('①-b 替身被改写 ⇒ 断言必须抛（有牙）', firedWhenChanged, `sha 前=${g1.shaBefore?.slice(0, 12)} 现=${g1.shaNow()?.slice(0, 12)}`);
  writeFileSync(decoy, '{"v":"A"}', 'utf8'); // 字节还原替身
  const g2 = isolateDshHome('t70-red-decoy2');
  let okAfterRestore = true;
  try { g2.assertUnchanged(); } catch { okAfterRestore = false; }
  check('①-c 替身字节还原 ⇒ 复绿', okAfterRestore, '（还原后新护栏的前后 sha 相同）');
  g1.cleanup(); g2.cleanup();
  rmSync(decoy, { force: true });
  delete process.env.T70_WATCH_WS;
}

// ── ② 顺序门禁：副本上"把隔离挪到 import 之后" ⇒ 普查必须判 ✗ ────────────────
{
  const tree = join(TMP, `t70-red-tree-${process.pid}`);
  const toolDir = join(tree, 'arch-t3', 'tools');
  const census = join(ROOT, 'spike/verify/explorer-20261012/arch-t58/tools/census-dshhome.ts');
  const src = join(ROOT, 'spike/verify/explorer-20261012/arch-t3/tools/smoke-e2e.ts');
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(toolDir, { recursive: true });
  cpSync(src, join(toolDir, 'smoke-e2e.ts'));
  const runCensus = (): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', census, '--root', tree, '--quiet'], { encoding: 'utf8', windowsHide: true });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const base = runCensus();
  check('②-a 修好的副本 ⇒ 普查判 ✓（exit 0）', base.status === 0, `exit=${base.status} ${(base.out.split('\n').find((l) => l.includes('汇总')) ?? '').trim()}`);
  // 变异：把 guard 调用行挪到 index.ts 动态 import 之后
  const target = join(toolDir, 'smoke-e2e.ts');
  const text = readFileSync(target, 'utf8');
  const guardLineRe = /^const guard = isolateDshHome\('t70-smoke-e2e'\);$/m;
  const m = guardLineRe.exec(text);
  const gl = m?.[0] ?? '';
  if (!gl) throw new Error('红测锚点未命中：guard 调用行');
  const without = text.replace(gl + '\n', '');
  const importLineIdx = without.split('\n').findIndex((l) => /await import\(.*\/src\/index\.ts/.test(l));
  const arr = without.split('\n');
  arr.splice(importLineIdx + 1, 0, gl); // ← 挪到 import 之后（=错误顺序）
  writeFileSync(target, arr.join('\n'), 'utf8');
  const red = runCensus();
  const redLine = red.out.split('\n').find((l) => l.includes('✗') && l.includes('smoke-e2e')) ?? red.out.split('\n').find((l) => l.includes('✗')) ?? '';
  check('②-b 隔离挪到 import 之后 ⇒ 普查判 ✗（exit 1）', red.status === 1 && /隔离在 import 之后/.test(red.out), `exit=${red.status} ${redLine.trim()}`);
  writeFileSync(target, text, 'utf8'); // 字节还原
  const green = runCensus();
  check('②-c 字节还原 ⇒ 复绿（exit 0）', green.status === 0 && readFileSync(target, 'utf8') === text, `exit=${green.status}`);
  rmSync(tree, { recursive: true, force: true });
}

const fails = results.filter((r) => !r.ok);
console.log(`\n红测：${results.length - fails.length}/${results.length} 符合预期` + (fails.length ? `；未红：${fails.map((f) => f.id).join(', ')}` : ''));
process.exit(fails.length ? 1 : 0);
