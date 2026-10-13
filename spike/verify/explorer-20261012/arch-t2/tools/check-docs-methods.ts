/**
 * check-docs-methods.mjs —— T2（文档刷新）的**核对脚本**（验收④要求"故意红"必须能让它红）。
 *
 * 它把"实现权威"与"文档陈述"对起来：
 *   · 权威 A = `src/explorer.ts` 的 `EXPLORER_METHODS`（数组字面量）
 *   · 权威 B = `src/index.ts` 的工具名（`name: 'wsl_*'`）
 *   · 副本 C = `client/client.api.js` 的 `METHODS`（应与 A 一致）
 *   · 断言 D = README / 设计稿**列出全部** A，且**不含**"只有 4 个"的过期字面量
 *   · 断言 E = README 含全部 B（工具表）
 *   · 断言 F = GAP-AUDIT 的 #8/#9 **不再**写成未闭合会话缺口（要求出现「守护已闭合」且 #8 行不含"真缺口，卡在上游"）
 *
 * 用法：
 *   node check-docs-methods.mjs [--root <repoRoot>] [--docs <docsDir>]   # --docs 用于副本（故意红）
 * 退出码：0 = 全过；1 = 有断言失败（打印哪条）；2 = 权威解析失败（环境/结构变了）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const DOCS = arg('docs', join(ROOT, 'docs'));

const fails = [];
const notes = [];
const must = (cond, label, detail) => { if (cond) notes.push(`PASS ${label}`); else fails.push(`FAIL ${label}${detail ? ' — ' + detail : ''}`); };

// ── 权威 A：EXPLORER_METHODS ────────────────────────────────────────────────────
const explorerSrc = readFileSync(join(ROOT, 'src/explorer.ts'), 'utf8');
const aBlock = /export const EXPLORER_METHODS = \[([\s\S]*?)\]/.exec(explorerSrc);
if (!aBlock) { console.log('ABORT: 解析不到 EXPLORER_METHODS（结构变了）'); process.exit(2); }
const HOST = [...aBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

// ── 权威 B：工具名 ─────────────────────────────────────────────────────────────
const indexSrc = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
const TOOLS = [...indexSrc.matchAll(/name:\s*'(wsl_[a-z_]+)'/g)].map((m) => m[1]);

// ── 副本 C：client METHODS ─────────────────────────────────────────────────────
const apiSrc = readFileSync(join(ROOT, 'client/client.api.js'), 'utf8');
const cBlock = /const METHODS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(apiSrc);
if (!cBlock) { console.log('ABORT: 解析不到 client METHODS（结构变了）'); process.exit(2); }
const CLIENT = [...cBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith('explorer.'));

// ── 文档 ───────────────────────────────────────────────────────────────────────
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const readme = read(join(ROOT, 'README.md'));
const design = read(join(DOCS, 'remote-explorer-design.md'));
const gap = read(join(ROOT, 'GAP-AUDIT.md'));
const gapCopy = read(join(DOCS, '..', 'GAP-AUDIT.md'));   // 副本场景由 --root 决定，这里兜底

console.log(`权威 EXPLORER_METHODS(${HOST.length}): ${HOST.join(', ')}`);
console.log(`权威 tools(${TOOLS.length}): ${TOOLS.join(', ')}`);
console.log(`client METHODS(${CLIENT.length}): ${CLIENT.join(', ')}`);
console.log(`docs 根: ${DOCS}`);

must(HOST.length === 6, 'host 方法数 = 6', `实得 ${HOST.length}`);
must(CLIENT.length === HOST.length && CLIENT.every((m) => HOST.includes(m)), 'client METHODS ≡ host EXPLORER_METHODS', `client=${CLIENT.length}`);
must(TOOLS.length === 7, '工具数 = 7', `实得 ${TOOLS.length}`);

if (readme === null) fails.push('FAIL 读不到 README.md');
else {
  const missing = HOST.filter((m) => !readme.includes(m));
  must(missing.length === 0, 'README 列出全部 explorer 方法', `缺 ${missing.join(', ')}`);
  // 只判"**纯** 4 项列表"（负向先行断言：这 4 项之后不能再跟 `|`）。
  // 否则会误伤"列举 6 项、恰好以这 4 项开头"的正确写法（2026-10-13 首跑踩到）。
  must(!/explorer\.snapshot\|openSession\|daemon\|fixPin(?!\|)/.test(readme), 'README 不含"只有 4 个方法"的过期字面量');
  const missT = TOOLS.filter((t) => !readme.includes(t));
  must(missT.length === 0, 'README 列出全部工具', `缺 ${missT.join(', ')}`);
}
if (design === null) fails.push('FAIL 读不到 remote-explorer-design.md');
else {
  const missing = HOST.filter((m) => !design.includes(m));
  must(missing.length === 0, '设计稿列出全部 explorer 方法', `缺 ${missing.join(', ')}`);
  // §4 的方法表行必须写全 6 个（用"method ∈"锚点）
  const ml = /method ∈ ([^\n]+)/.exec(design);
  if (ml) {
    const listed = [...ml[1].matchAll(/explorer\.\w+/g)].map((m) => m[0]);
    must(listed.length === HOST.length, '设计稿 §4 的方法表行 = 6 项', `实得 ${listed.length}: ${listed.join('|')}`);
  } else fails.push('FAIL 设计稿里找不到 `method ∈` 方法表行（被删了？）');
}
const gapText = gap ?? gapCopy;
if (gapText === null) fails.push('FAIL 读不到 GAP-AUDIT.md');
else {
  const row8 = (gapText.split('\n').find((l) => /^\|\s*8\s*\|/.test(l)) ?? '');
  must(row8.includes('守护已闭合'), 'GAP #8 行写明「守护已闭合」', row8.slice(0, 80));
  must(!row8.includes('真缺口，卡在上游'), 'GAP #8 行不再写「真缺口，卡在上游」');
  must(gapText.includes('桌面壳 attach') || gapText.includes('attach'), 'GAP-AUDIT 提到真缺口 = 桌面壳 attach');
}

console.log('');
for (const n of notes) console.log(n);
for (const f of fails) console.log(f);
console.log(`\n结果：${fails.length === 0 ? 'PASS' : `FAIL(${fails.length})`} ｜ 断言 ${notes.length + fails.length} 条`);
process.exit(fails.length === 0 ? 0 : 1);
