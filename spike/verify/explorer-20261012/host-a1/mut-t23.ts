// mut-t23.mjs —— 故意红：把"已登记则复用"改成"无条件 create"（跳过 resolveByPath 命中分支）。
import { readFileSync, writeFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
let s = readFileSync(file, 'utf8');
const GUARD = '    if (existingId) {';
const MUT = '    if (false && existingId) { // MUTATION-RED-T23';
if (mode === 'no-reuse') {
  const n = s.split(GUARD).length - 1;
  if (n !== 1) { console.error(`锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(GUARD, MUT), 'utf8');
  console.log('RED: 已改成"无条件 create"（跳过已存在复用分支）');
} else {
  const n = s.split(MUT).length - 1;
  if (n !== 1) { console.error(`还原锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(MUT, GUARD), 'utf8');
  console.log('RESET: 已恢复"已存在则复用"');
}
