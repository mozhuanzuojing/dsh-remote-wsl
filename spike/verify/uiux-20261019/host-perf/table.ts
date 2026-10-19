/**
 * table.ts —— 从 out-before.json / out-after.json 生成报告用的 Markdown 对比表（机械生成，避免手抄）。
 * 用法：node table.ts out-before.json out-after.json
 */
import { readFileSync } from 'node:fs';

const [fa, fb] = process.argv.slice(2);
const A = JSON.parse(readFileSync(fa, 'utf8'));
const B = JSON.parse(readFileSync(fb, 'utf8'));
const idx = (d: any) => new Map(d.results.map((r: any) => [r.scenario, r]));
const ia = idx(A);
const ib = idx(B);

const rows: string[] = [];
rows.push('| 场景 | before 中位数 (min/max) | after 中位数 (min/max) | Δ | 提速 |');
rows.push('|---|---:|---:|---:|---:|');
for (const [name, a] of ia) {
  const b: any = ib.get(name);
  if (!b) continue;
  const delta = Math.round((a.ms.medianMs - b.ms.medianMs) * 10) / 10;
  const speed = b.ms.medianMs > 0 ? Math.round((a.ms.medianMs / b.ms.medianMs) * 10) / 10 : 'n/a';
  rows.push(
    '| ' + name + ' | ' + a.ms.medianMs + ' (' + a.ms.minMs + '/' + a.ms.maxMs + ') | ' + b.ms.medianMs + ' (' + b.ms.minMs + '/' + b.ms.maxMs + ') | ' +
      (delta > 0 ? '-' + delta : '+' + Math.abs(delta)) + 'ms | ' + speed + 'x |',
  );
}
console.log(rows.join('\n'));

console.log('\n--- listDistrosCallsPerSample ---');
for (const [name, a] of ia) {
  const b: any = ib.get(name);
  if (!b) continue;
  console.log(name + ': before=' + a.listDistrosCallsPerSample.join('/') + ' after=' + b.listDistrosCallsPerSample.join('/'));
}
console.log('\nlabels: ' + A.label + ' vs ' + B.label + ' | n=' + A.n + '/' + B.n + ' | generatedAt=' + A.generatedAt + ' / ' + B.generatedAt);
