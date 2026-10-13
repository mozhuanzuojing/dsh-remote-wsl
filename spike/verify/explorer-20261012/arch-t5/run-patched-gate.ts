/**
 * run-patched-gate.ts —— **T5 时代的诊断脚本，现已转为薄运行器**。
 *
 * 原来的用途：证明 "T2 的 `check-docs-methods.mjs` 之所以 FAIL，是因为它把'工具名权威'硬编码在
 * `src/index.ts`（T5 拆分后那 7 个 `name: 'wsl_*'` 搬到了 `src/register-tools.ts`）"。
 * 做法是复制一份护栏、只改"在哪读工具名"这一处，再跑。
 *
 * ⚠️ **该诊断已过期**：T2 的护栏后来改成「扫 `src/**` + 把权威锚在 `tools.register` 这个语义上」，
 * 并按命名规则更名为 `arch-t2/tools/check-docs-methods.ts`（**判据一个字未改**）。
 * ⇒ "复制 + 打补丁"两步**已无意义**（要补的那个缺陷不存在了；补丁锚点 `src/index.ts` 也不存在），
 *   而且它会因为旧路径 `.mjs` 已不存在而**直接跑不起来**。
 * ⇒ 本脚本改为**薄运行器**：直接用 `--root` 跑真护栏并透传退出码。**历史证据不删**：
 *   当时那份补丁副本的输出仍留在同目录 `out-10-gate-docs-patched.txt`（11/11 PASS，历史件）。
 *
 * ★ **位置无关纪律（T45 立，通用）**：护栏与工具的"**权威来源 / 引用路径"不得写死到具体文件**。
 *   本仓已踩过两次：(1) T2 护栏把工具名读死在 `src/index.ts` ⇒ T5 搬文件后它报 `工具数 = 7 — 实得 0`；
 *   (2) 该护栏更名 `.mjs → .ts` ⇒ 两处调用方（含本脚本）失效。
 *   ⇒ 本脚本的路径**全部由自身位置推导**（不写死仓根），仓根可用 `--root` 覆盖；
 *     将来凡是新增护栏/工具，**"位置无关"要作为验收项之一**。
 *
 * 用法：node --experimental-strip-types run-patched-gate.ts [--root <repoRoot>]
 * 退出码：0 = 护栏全过；1 = 护栏有失败项；2 = 找不到护栏（引用路径变了）
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };

// 本文件在 <repo>/spike/verify/explorer-20261012/arch-t5/ ⇒ 上溯 4 级 = 仓根（位置无关）
const HERE = dirname(fileURLToPath(import.meta.url));
const DERIVED_ROOT = resolve(HERE, '..', '..', '..', '..');
const ROOT = resolve(arg('root', DERIVED_ROOT));
const GATE = resolve(HERE, '..', 'arch-t2', 'tools', 'check-docs-methods.ts');

if (!existsSync(GATE)) {
  console.error(`✗ 找不到护栏：${GATE}`);
  console.error('  该路径由本脚本自身位置推导（arch-t5/../arch-t2/tools/check-docs-methods.ts）——若护栏又改名/搬家，请更新这一处推导，不要改成写死仓根的绝对路径。');
  process.exit(2);
}
console.log(`护栏 = ${GATE}`);
console.log(`仓根 = ${ROOT}（${process.argv.includes('--root') ? '来自 --root' : '由脚本位置推导'}）`);

const r = spawnSync(process.execPath, [GATE, '--root', ROOT], { encoding: 'utf8' });
process.stdout.write(String(r.stdout || ''));
process.stderr.write(String(r.stderr || ''));
console.log(`\n护栏 exit=${r.status}（0 = 全过）`);
process.exit(r.status ?? 1);
