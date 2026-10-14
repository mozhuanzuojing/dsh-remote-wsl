/**
 * census-dshhome.ts —— T70 的**普查器 + 顺序门禁**（可复跑，报告里的表由它生成）。
 *
 * 判定一个工具是否需要"孤立 `DSH_HOME` + 前后 sha 断言"：
 *   · 需要 = 它**在进程内 import 宿主入口 `src/index.ts`**（或读该文件路径常量后 import），或
 *     它**调 `apply()`**，或它**起宿主/实例**（`dsh … --profile … --port …`）。
 *   · 合规 = ① 设了 `DSH_HOME`（或用了共享护栏 `dsh-guard`）；② 有"用户全局 workspace.json 前后比 sha"
 *     的断言；③ **隔离发生在 import 宿主入口之前**（顺序也是语义：模块在 import 期就可能捕获存储根）。
 *
 * 用法：node --experimental-strip-types census-dshhome.ts [--root <explorerRoot>] [--json <out>] [--only <substr>] [--quiet]
 * 退出码：0 = 无"✗"项；1 = 有 ✗（缺隔离 / 隔离顺序在 import 之后）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl/spike/verify/explorer-20261012');
const JSONOUT = arg('json', '');
const ONLY = arg('only', '');
const QUIET = process.argv.includes('--quiet');

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'out' && !e.name.startsWith('.')) out.push(...walk(p)); }
    else if (/\.(ts|mjs|ps1)$/.test(e.name)) out.push(p);
  }
  return out;
};

type Row = {
  tool: string; hostEntry: boolean; applyCall: boolean; startsHost: boolean;
  setsDshHome: boolean; guard: boolean; shaAssert: boolean; orderOk: boolean | null;
  verdict: '✓ 合规' | '✗ 缺隔离（同病）' | '✗ 隔离在 import 之后（无效）' | '⚠ 有隔离但无前后 sha 断言' | 'N/A（不触 storages）';
};

const rows: Row[] = [];
type Ev = { tool: string; why: string[] };
const evidence: Ev[] = [];
for (const f of walk(ROOT).sort()) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  if (ONLY && !rel.includes(ONLY)) continue;
  if (/\.orig\.ts$/.test(rel)) continue; // 快照/备份文件不是工具
  const raw = readFileSync(f, 'utf8');
  // ⚠️ **先剥注释再判**（三处踩过的坑都记在这里）：
  //   ① 不剥注释 ⇒ 注释里提到 `dsh web` 就被当成"起实例"（首版误报了 splice-t1 / split-t5* / harness-t60）；
  //   ② 行注释正则若写成 `(^|[^:])//` ⇒ **`file:///…` 被当成注释**，import 行整条被抹 ⇒ 判成 N/A；
  //   ③ **顺序**：必须先剥行注释再剥块注释 —— 否则行注释里的 `src/**` 会给块注释"开一个头"，
  //      一直吃到后面某个 `*/`，把中间的 import/apply 全抹掉（smoke-e2e 就被这条坑判成 N/A）。
  const text = raw
    .replace(/(?<![:\/])\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*#[^\n]*/gm, '');
  const lines = text.split('\n');
  const ev: string[] = [];
  // 宿主入口：允许模板串里的 `${ROOT}`（所以中间段用"非引号非换行"而不是"非反引号"）
  const hostEntry = /(?:import\(|require\()\s*[^'"\n]*\/src\/index\.ts/.test(text) || /const\s+[A-Z_]*\s*=\s*['"][^'"]*\/src\/index\.ts['"]/.test(text);
  // 收紧：只认"像插件 apply"的调用（`.apply(ctx|childCtx|host|context|plugin…)`），避免 `String.apply` 之类
  const applyCall = /\.apply\(\s*(?:ctx|childCtx|host|context|plugin\w*|c)\b/.test(text);
  // 收紧：起**宿主/实例**要同时出现 profile 与 port（且是 dsh/web 语境）
  const startsHost = /(?:\bdsh(?:\.cmd)?\b[^\n]*--profile[^\n]*--port)|(?:--profile[^\n]*--port[^\n]*(?:--no-open|web))|(?:\bdsh web\b)/.test(text);
  const setsDshHome = /(process\.env\.DSH_HOME\s*=|\$env:DSH_HOME\s*=)/.test(text);
  const guard = /dsh-guard/.test(text);
  const shaAssert = /workspace\.json/.test(text) && /(sha256|sha\(|ShaBefore|ShaAfter|ShaDiff|前后)/i.test(text);
  let orderOk: boolean | null = null;
  if (hostEntry) {
    const importIdx = lines.findIndex((l) => /(?:import\(|require\().*\/src\/index\.ts/.test(l));
    const isoIdx = lines.findIndex((l) => /(process\.env\.DSH_HOME\s*=|isolateDshHome\()/.test(l));
    orderOk = isoIdx !== -1 && importIdx !== -1 ? isoIdx < importIdx : false;
  }
  if ((hostEntry || applyCall || startsHost) && !QUIET) {
    lines.forEach((l, i) => {
      if (/(?:import\(|require\()\s*[`'"][^`'"]*\/src\/index\.ts/.test(l)) ev.push(`${i + 1}: [宿主入口] ${l.trim().slice(0, 110)}`);
      else if (/\.apply\(\s*(?:ctx|childCtx|host|context|plugin\w*|c)\b/.test(l)) ev.push(`${i + 1}: [apply()] ${l.trim().slice(0, 110)}`);
      else if (/(?:\bdsh(?:\.cmd)?\b[^\n]*--profile[^\n]*--port)|(?:--profile[^\n]*--port[^\n]*(?:--no-open|web))|(?:\bdsh web\b)/.test(l)) ev.push(`${i + 1}: [起实例] ${l.trim().slice(0, 110)}`);
      else if (/(process\.env\.DSH_HOME\s*=|\$env:DSH_HOME\s*=)/.test(l)) ev.push(`${i + 1}: [设 DSH_HOME] ${l.trim().slice(0, 110)}`);
    });
    if (ev.length) evidence.push({ tool: rel, why: ev });
  }
  const needs = hostEntry || applyCall || startsHost;
  let verdict: Row['verdict'];
  if (!needs) verdict = 'N/A（不触 storages）';
  else if (!setsDshHome && !guard) verdict = '✗ 缺隔离（同病）';
  else if (orderOk === false) verdict = '✗ 隔离在 import 之后（无效）';
  else if (!shaAssert && !guard) verdict = '⚠ 有隔离但无前后 sha 断言';
  else verdict = '✓ 合规';
  rows.push({ tool: rel, hostEntry, applyCall, startsHost, setsDshHome, guard, shaAssert, orderOk, verdict });
}

if (!QUIET) {
  console.log(`普查根：${ROOT}`);
  console.log('');
  console.log('| 工具 | import 宿主入口 | apply() | 起实例 | 设 DSH_HOME | 共享护栏 | 前后 sha 断言 | 隔离在 import 前 | 判定 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const y = (b: boolean | null) => (b === null ? '—' : b ? '是' : '**否**');
    console.log(`| \`${r.tool}\` | ${y(r.hostEntry)} | ${y(r.applyCall)} | ${y(r.startsHost)} | ${y(r.setsDshHome)} | ${y(r.guard)} | ${y(r.shaAssert)} | ${y(r.orderOk)} | ${r.verdict} |`);
  }
}
const bad = rows.filter((r) => r.verdict.startsWith('✗'));
const warn = rows.filter((r) => r.verdict.startsWith('⚠'));
const ok = rows.filter((r) => r.verdict === '✓ 合规');
const na = rows.filter((r) => r.verdict.startsWith('N/A'));
console.log(`\n汇总：文件 ${rows.length} ｜ ✓ 合规 ${ok.length} ｜ ⚠ 无断言 ${warn.length} ｜ ✗ 待修 ${bad.length} ｜ N/A ${na.length}`);
if (bad.length) for (const r of bad) console.log(`  ✗ ${r.tool} — ${r.verdict}`);
if (process.argv.includes('--evidence')) {
  console.log('\n—— 命中证据（✗ / ⚠ 行的实际匹配行）——');
  for (const e of evidence) {
    const row = rows.find((r) => r.tool === e.tool);
    if (!row || row.verdict.startsWith('N/A')) continue;
    console.log(`\n### ${e.tool}  [${row.verdict}]`);
    for (const w of e.why.slice(0, 6)) console.log(`    ${w}`);
  }
}
if (JSONOUT) writeFileSync(JSONOUT, JSON.stringify({ at: new Date().toISOString(), root: ROOT, summary: { total: rows.length, ok: ok.length, warn: warn.length, bad: bad.length, na: na.length }, rows }, null, 2), 'utf8');
process.exit(bad.length ? 1 : 0);
