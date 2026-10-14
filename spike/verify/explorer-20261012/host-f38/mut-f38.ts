// mut-f38.mjs —— 故意红：去掉失败路径的启动脚本回收（F-38a）⇒ 残留断言必须红。
import { readFileSync, writeFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
let s = readFileSync(file, 'utf8');
const ON = '      if (removeLauncher(cfg, p)) notes.push(`回收启动脚本 launch.${p}.sh（该槽位未起来，避免残留）`);';
const OFF = '      if (false && removeLauncher(cfg, p)) notes.push(`MUTATION-RED: 回收已禁用`);';
if (mode === 'no-reclaim') {
  const n = s.split(ON).length - 1;
  if (n !== 1) { console.error(`锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(ON, OFF), 'utf8');
  console.log('RED: 已禁用失败路径的启动脚本回收');
} else {
  const n = s.split(OFF).length - 1;
  if (n !== 1) { console.error(`还原锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(OFF, ON), 'utf8');
  console.log('RESET: 已恢复回收逻辑');
}
