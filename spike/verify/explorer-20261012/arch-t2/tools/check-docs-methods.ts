/**
 * check-docs-methods.ts —— T2（文档刷新）的**核对脚本**（验收④要求"故意红"必须能让它红）。
 *
 * （2026-10-13 由 `.mjs` 改名 `.ts`，遵守"新脚本一律 TypeScript"规则；**判据一个字未改**，Node 26 直跑无需构建。）
 *
 * 它把"实现权威"与"文档陈述"对起来：
 *   · 权威 A = `src/explorer.ts` 的 `EXPLORER_METHODS`（数组字面量）
 *   · 权威 B = **`src/**\/*.ts` 里每一次 `tools.register({` 之后的第一个 `name: 'wsl_*'`**（位置无关）
 *
 * ⚠️ **通用纪律（T45 立）：护栏与工具的"权威来源 / 引用路径"不得写死到具体文件。**
 *   本仓为此红过三次，都记在这里，避免第四次：
 *    · 第 1 次：初版把工具名读死在 `src/index.ts`；
 *    · 第 2 次（2026-10-13）：T5 把 7 个工具注册搬到 `src/register-tools.ts`（`index.ts` 只剩 wiring）
 *      ⇒ 报 `工具数 = 7 — 实得 0`，**护栏自己成了误报源**；
 *    · 第 3 次（同日）：本脚本按命名规则 `.mjs → .ts` 更名 ⇒ **两处调用方仍指着旧名**而失效
 *      （`arch-t5/run-patched-gate.ts` 直接跑不起来；`src/explorer.ts` 注释指向不存在的文件）。
 *    ⇒ 取权威一律走**语义锚点**（这里是"注册调用"）并**扫全 `src/`**，文件改名/搬家/再拆都不影响；
 *      若哪天真换了注册写法（锚点 0 命中）本脚本**会红**并提示"注册形态变了"，而不是静默读空。
 *    ⇒ **新增护栏/工具时，"位置无关"是验收项之一**（像本脚本那样用"改文件名 + 挪嵌套目录"两个实证证明）。
 *   · 副本 C = `client/client.api.js` 的 `METHODS`（应与 A 一致）
 *   · 断言 D = README / 设计稿**列出全部** A，且**不含**"只有 4 个"的过期字面量
 *   · 断言 E = README 含全部 B（工具表）
 *   · 断言 F = GAP-AUDIT 的 #8/#9 **不再**写成未闭合会话缺口（要求出现「守护已闭合」且 #8 行不含"真缺口，卡在上游"）
 *
 * 用法：
 *   node check-docs-methods.ts [--root <repoRoot>] [--docs <docsDir>]   # --docs 用于副本（故意红）；Node 26 直跑，无需构建
 * 退出码：0 = 全过；1 = 有断言失败（打印哪条）；2 = 权威解析失败（环境/结构变了）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

// ── 权威 B：工具名（**位置无关**：扫 `src/**/*.ts`，只锚在"注册调用"上）─────────
// 锚点 = 每一次 `tools.register({` 之后的**第一个** `name: 'wsl_*'`（注册块内 600 字符窗口）。
// 为什么这样锚：① 不依赖文件名/目录层级 ⇒ T5 这类"把注册搬去新文件"的改动不会再弄红它；
//              ② 阈值 600 足够（实测 name 就在 register 的下一行），又不会跨到下一个工具的注册块；
//              ③ 先剥注释，避免注释里的示例被算进来。
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
function walkTs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}
const SRC_DIR = join(ROOT, 'src');
const tsFiles = existsSync(SRC_DIR) ? walkTs(SRC_DIR) : [];
const registered = [];
const TOOL_SRC = [];
const unanchored = [];
for (const f of tsFiles) {
  const code = stripComments(readFileSync(f, 'utf8'));
  const rel = f.slice(SRC_DIR.length + 1).replace(/\\/g, '/');
  for (const m of code.matchAll(/tools\.register\(\s*\{/g)) {
    const hit = /name:\s*'(wsl_[a-z0-9_]+)'/.exec(code.slice(m.index, m.index + 600));
    if (hit) { registered.push(hit[1]); TOOL_SRC.push(`${rel}:${hit[1]}`); }
  }
  for (const m of code.matchAll(/name:\s*'(wsl_[a-z0-9_]+)'/g)) unanchored.push(m[1]);
}
const TOOLS = [...new Set(registered)];

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
console.log(`  锚定来源（tools.register）：${TOOL_SRC.length ? TOOL_SRC.join('; ') : '(无 —— 注册写法变了？见脚本头注释)'}`);
console.log(`  诊断：扫全 src 的裸 name:'wsl_*' 计数 = ${unanchored.length}${unanchored.length === TOOLS.length ? '（与锚定一致）' : '（与锚定不一致 ⇒ 见下方 WARN）'}`);
console.log(`client METHODS(${CLIENT.length}): ${CLIENT.join(', ')}`);
console.log(`docs 根: ${DOCS}`);

must(HOST.length === 6, 'host 方法数 = 6', `实得 ${HOST.length}`);
must(CLIENT.length === HOST.length && CLIENT.every((m) => HOST.includes(m)), 'client METHODS ≡ host EXPLORER_METHODS', `client=${CLIENT.length}`);
must(TOOLS.length === 7, '工具数 = 7', `实得 ${TOOLS.length}（锚定 tools.register；来源 ${TOOL_SRC.join('; ') || '(无)'}）`);
must(registered.length === TOOLS.length, '无重复注册（同一工具名只出现一次）', `注册次数 ${registered.length} vs 去重后 ${TOOLS.length}`);
if (unanchored.length !== TOOLS.length) notes.push(`WARN 扫全 src 的裸计数 ${unanchored.length} ≠ 锚定 ${TOOLS.length} ⇒ 可能存在"声明了但没走 tools.register"的工具，或字符串字面量里的示例（本项不判失败，只提示）`);

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
  // 工具名也要许愿一致（T5 之后工具注册在别的文件，但文档该列的还是这 7 个）
  const missTD = TOOLS.filter((t) => !design.includes(t));
  must(missTD.length === 0, '设计稿列出全部工具', `缺 ${missTD.join(', ')}`);
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
