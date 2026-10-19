/**
 * compare.ts —— 对照 before / after 两份 regression JSON：
 *   · A/B 组（错误路径、返回字段、HTTP 语义）必须**逐字相同**；
 *   · C/D 组（缓存与单飞）打印前后读数。
 * 用法：node compare.ts out-regression-before.json out-regression-after.json
 */
import { readFileSync } from 'node:fs';

const [fa, fb] = process.argv.slice(2);
const A = JSON.parse(readFileSync(fa, 'utf8'));
const B = JSON.parse(readFileSync(fb, 'utf8'));
const ca = A.checks;
const cb = B.checks;

const stable = (x: any) => JSON.stringify(x, Object.keys(x || {}).sort());
const deepSame = (x: any, y: any) => JSON.stringify(x) === JSON.stringify(y);

const shared = [
  'listDir_pathMissing',
  'listDir_argError',
  'listDir_argErrorNul',
  'listDir_okShape',
  'listDir_distroNotInList',
  'listDir_distroNotRunning',
  'snapshot_okShape',
  'http_noOrigin',
  'http_crossOrigin',
  'http_getMethods',
  'http_put',
  'http_badCtype',
  'http_unknownMethod',
  'http_listDirMissing',
  'http_listDirArg',
  'http_snapshotOk',
];

const diffs: any[] = [];
for (const key of shared) {
  if (!(key in ca) || !(key in cb)) {
    diffs.push({ key, reason: 'missing on one side', before: key in ca, after: key in cb });
    continue;
  }
  if (!deepSame(ca[key], cb[key])) diffs.push({ key, before: ca[key], after: cb[key] });
}

console.log('=== A/B 稳定性（必须 0 差异）===');
console.log('checked: ' + shared.length + ', diffs: ' + diffs.length);
if (diffs.length) console.log(JSON.stringify(diffs, null, 2));

console.log('\n=== 错误 code/文案（逐条对照）===');
for (const key of ['listDir_pathMissing', 'listDir_argError', 'listDir_distroNotInList', 'listDir_distroNotRunning']) {
  const a = ca[key] ?? {};
  const b = cb[key] ?? {};
  console.log(key + ':');
  console.log('  before: ok=' + a.ok + ' code=' + a.code + ' msg=' + JSON.stringify(a.message));
  console.log('  after : ok=' + b.ok + ' code=' + b.code + ' msg=' + JSON.stringify(b.message));
}

console.log('\n=== B HTTP 状态码 ===');
for (const key of Object.keys(ca).filter((k) => k.startsWith('http_'))) {
  console.log(key + ': ' + (ca[key]?.status ?? '?') + ' -> ' + (cb[key]?.status ?? '?') + (ca[key]?.status === cb[key]?.status ? '  same' : '  DIFF'));
}

console.log('\n=== C 缓存行为 ===');
console.log('before: ' + JSON.stringify(ca.cache, null, 2));
console.log('after : ' + JSON.stringify(cb.cache, null, 2));
console.log('\n=== C4 TTL 内状态变化（after 才可构造）===');
console.log('before: ' + JSON.stringify(ca.cacheStateWithinTtl));
console.log('after : ' + JSON.stringify(cb.cacheStateWithinTtl, null, 2));
console.log('\n=== C5 失败不缓存 ===');
console.log('before: ' + JSON.stringify(ca.failureNotCached));
console.log('after : ' + JSON.stringify(cb.failureNotCached, null, 2));
console.log('\n=== D 单飞 ===');
console.log('before: ' + JSON.stringify(ca.singleFlight));
console.log('after : ' + JSON.stringify(cb.singleFlight));
