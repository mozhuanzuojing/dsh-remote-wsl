// mut-setsid.mjs —— 把启动脚本的 exec 行在 `exec node` 与 `exec setsid --fork node` 之间切换（试 setsid 托管）。
import { readFileSync, writeFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
const s = readFileSync(file, 'utf8');
const A = '`exec node ${JSON.stringify(daemonScriptWsl())}';
const B = '`exec setsid --fork node ${JSON.stringify(daemonScriptWsl())}';
if (mode === 'on') {
  if (!s.includes(A)) { console.error('锚点未命中(exec node)'); process.exit(2); }
  writeFileSync(file, s.replace(A, B), 'utf8');
  console.log('已切到 exec setsid --fork node');
} else {
  if (!s.includes(B)) { console.error('锚点未命中(setsid)'); process.exit(2); }
  writeFileSync(file, s.replace(B, A), 'utf8');
  console.log('已切回 exec node');
}
