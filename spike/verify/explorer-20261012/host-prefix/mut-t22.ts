// mut-t22.ts —— 故意红：把调用点临时换成"无条件删前缀"（等价于 helper 被改成只删不守）。
// 期望：一个**无标记**失败路径的"含 remote-wsl:"断言必须变红（证明只能守卫、不能删）。
import { readFileSync, writeFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
let s = readFileSync(file, 'utf8');
const GUARD = 'if (!r.ok) throw new Error(withModulePrefix(r.error));';
const STRIP = "if (!r.ok) throw new Error(String(r.error).replace(/^remote-wsl:\\s*/, '')); // MUTATION-RED-T22";
if (mode === 'strip') {
  const n = s.split(GUARD).length - 1;
  if (n !== 1) { console.error(`锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(GUARD, STRIP), 'utf8');
  console.log('RED: 调用点已换成"无条件删前缀"');
} else {
  const n = s.split(STRIP).length - 1;
  if (n !== 1) { console.error(`还原锚点命中 ${n} 处（期望 1）`); process.exit(2); }
  writeFileSync(file, s.replace(STRIP, GUARD), 'utf8');
  console.log('RESET: 已恢复 withModulePrefix 守卫');
}
