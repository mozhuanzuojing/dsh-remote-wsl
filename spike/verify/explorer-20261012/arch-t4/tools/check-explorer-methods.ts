/**
 * check-explorer-methods.ts —— T4（方法表单源）的**比对 / 再生成**工具。
 *
 * 背景：方法名的**唯一权威**是 host 的 `src/explorer.ts` → `EXPLORER_METHODS`；client 半是
 * **零构建手写 bundle**，不能 import host、也不能跑生成器，所以 `client/client.api.js` 里只能留
 * 一份**字面量投影**。本工具就是那道"投影不许漂"的机器门禁（跨任务门禁
 * `arch-t2/tools/check-docs-methods.ts` 另有 **13 条**断言（2026-10-13 由 `.mjs` 更名，判据未改），其中一条也断言 client ≡ host）。
 *
 * 用法（Node 26 原生跑 .ts，无需构建）：
 *   node check-explorer-methods.ts                 # --check（默认）：不一致 ⇒ exit 1
 *   node check-explorer-methods.ts --print         # 打印应从 host 派生的 client METHODS 片段
 *   node check-explorer-methods.ts --root <repo>   # 指向副本（故意红用）
 *   node check-explorer-methods.ts --quiet         # 只输出结论行
 *
 * 退出码：0 = 全过；1 = 有断言失败；2 = 权威/投影解析失败（结构变了）。
 *
 * 为什么不是 .mjs：用户级硬规则要求"新脚本一律 TypeScript"；本文件因此用 .ts，
 * 但**不含任何类型检查依赖**（只用可擦除类型标注），`node <file>.ts` 直接可跑。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type Outcome = { pass: string[]; fail: string[] };

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const ROOT = flag('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const QUIET = has('quiet');
const PRINT = has('print');

const outcome: Outcome = { pass: [], fail: [] };
const must = (cond: boolean, label: string, detail?: string): void => {
  if (cond) outcome.pass.push(`PASS ${label}`);
  else outcome.fail.push(`FAIL ${label}${detail ? ' — ' + detail : ''}`);
};

// ── 权威 A：host EXPLORER_METHODS ───────────────────────────────────────────────
const explorerPath = join(ROOT, 'src/explorer.ts');
if (!existsSync(explorerPath)) {
  console.log(`ABORT: 找不到 ${explorerPath}`);
  process.exit(2);
}
const explorerSrc = readFileSync(explorerPath, 'utf8');
const aBlock = /export const EXPLORER_METHODS = \[([\s\S]*?)\]/.exec(explorerSrc);
if (!aBlock) {
  console.log('ABORT: 解析不到 EXPLORER_METHODS（结构变了）');
  process.exit(2);
}
const HOST = [...aBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

// ── 投影 C：client METHODS ─────────────────────────────────────────────────────
const apiPath = join(ROOT, 'client/client.api.js');
if (!existsSync(apiPath)) {
  console.log(`ABORT: 找不到 ${apiPath}`);
  process.exit(2);
}
const apiSrc = readFileSync(apiPath, 'utf8');
const cBlock = /const METHODS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(apiSrc);
if (!cBlock) {
  console.log('ABORT: 解析不到 client METHODS（结构变了）');
  process.exit(2);
}
const clientEntries = [...cBlock[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)].map((m) => ({ key: m[1], value: m[2] }));
const CLIENT = clientEntries.map((e) => e.value);

if (!QUIET) {
  console.log(`权威   src/explorer.ts EXPLORER_METHODS (${HOST.length}): ${HOST.join(', ')}`);
  console.log(`投影   client/client.api.js METHODS   (${CLIENT.length}): ${CLIENT.join(', ')}`);
}

// ── 断言 ───────────────────────────────────────────────────────────────────────
must(HOST.length > 0, 'host 方法表非空');
must(
  CLIENT.length === HOST.length && HOST.every((m) => CLIENT.includes(m)),
  'client METHODS ≡ host EXPLORER_METHODS（集合相等）',
  `host=${HOST.length} client=${CLIENT.length}，多=${
    CLIENT.filter((m) => !HOST.includes(m)).join(',') || '无'
  } 少=${HOST.filter((m) => !CLIENT.includes(m)).join(',') || '无'}`,
);
const orderDrift = HOST.filter((m, i) => CLIENT[i] !== m);
must(orderDrift.length === 0, 'client METHODS 顺序与 host 一致', `首个漂移项：${orderDrift[0] ?? '—'}`);
must(CLIENT.every((m) => m.startsWith('explorer.')), 'client 方法名都以 explorer. 前缀');
must(new Set(HOST).size === HOST.length, 'host 方法表无重复项');
must(new Set(CLIENT).size === CLIENT.length, 'client 方法表无重复项');

// 每个投影项都要有一个**可调用包装**（防止"表里有、api 上没有"的半死面）
const missingWrappers = clientEntries.filter((e) => !new RegExp(`\\b${e.key}\\s*\\(`).test(apiSrc)).map((e) => e.key);
must(missingWrappers.length === 0, '每个 METHODS 键都有一个可调用包装', `缺包装：${missingWrappers.join(', ') || '—'}`);

// 投影视图必须**派生**自 METHODS（不是又抄一份）
must(/const METHOD_NAMES = Object\.freeze\(Object\.values\(METHODS\)\)/.test(apiSrc), 'client 用 METHOD_NAMES 从 METHODS 派生（未再抄一份）');

// ── --print：把 host 派生出的 client 片段打出来（漂移时的修复动作）──
if (PRINT) {
  const width = Math.max(...HOST.map((m) => m.replace('explorer.', '').length));
  console.log('\n--- 从 host 派生（粘贴回 client/client.api.js 的 METHODS 块）---');
  console.log('\t\tconst METHODS = Object.freeze({');
  for (const m of HOST) {
    const key = m.replace('explorer.', '');
    console.log(`\t\t\t${key.padEnd(width)}: "${m}",`);
  }
  console.log('\t\t});');
  console.log('--- 结束 ---');
}

if (!QUIET) {
  for (const p of outcome.pass) console.log(p);
}
for (const f of outcome.fail) console.log(f);
console.log(`\n结果：${outcome.fail.length === 0 ? 'PASS' : `FAIL(${outcome.fail.length})`} ｜ 断言 ${outcome.pass.length + outcome.fail.length} 条 ｜ root=${ROOT}`);
process.exit(outcome.fail.length === 0 ? 0 : 1);
