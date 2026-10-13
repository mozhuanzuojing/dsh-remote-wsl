// mut-t25.mjs —— 故意红 / "改前等价" 变异：去掉"移除元数据前的复核"（= 恢复成无条件 removeMetaFiles）。
import { readFileSync, writeFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
let s = readFileSync(file, 'utf8');
const GUARD = '  if (survivors.length) {';
const MUT = '  if (false && survivors.length) { // MUTATION-RED-T25（等价于改前的无条件 removeMetaFiles）';
if (mode === 'no-guard') {
  const n = s.split(GUARD).length - 1;
  if (n !== 1) { console.error(`锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(GUARD, MUT), 'utf8');
  console.log('RED: 已去掉"移除元数据前的复核"（回到改前语义）');
} else {
  const n = s.split(MUT).length - 1;
  if (n !== 1) { console.error(`还原锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(MUT, GUARD), 'utf8');
  console.log('RESET: 已恢复复核');
}
