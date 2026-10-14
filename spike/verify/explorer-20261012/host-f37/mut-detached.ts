// mut-detached.ts —— 把 daemon-client 的 spawn 选项在两个形态间切换（故意红 / A-B 回归对照用）。
// 用法：node mut-detached.ts <file> on|off    on = 加回 detached:true（旧配置）, off = 去掉（新配置）
import { readFileSync, writeFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
let s = readFileSync(file, 'utf8');
const WITH = `    windowsHide: true, // 必须保留：没有它 conhost 也会分配控制台
    detached: true,`;
const WITHOUT = `    windowsHide: true, // 必须保留：没有它 conhost 也会分配控制台`;
if (mode === 'on') {
  if (s.includes(WITH)) { console.log('已处于 detached:true'); process.exit(0); }
  if (!s.includes(WITHOUT)) { console.error('锚点未命中（off 态）'); process.exit(2); }
  writeFileSync(file, s.replace(WITHOUT, WITH), 'utf8');
  console.log('已切到 detached:true（旧配置）');
} else {
  if (s.includes(WITHOUT) && !s.includes(WITH)) { console.log('已处于无 detached（新配置）'); process.exit(0); }
  if (!s.includes(WITH)) { console.error('锚点未命中（on 态）'); process.exit(2); }
  writeFileSync(file, s.replace(WITH, WITHOUT), 'utf8');
  console.log('已切到无 detached（新配置）');
}
