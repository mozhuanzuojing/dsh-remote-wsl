// mut-t17.ts —— T17 故意红/回退实验的精确变异。
//  red-a : 把主路径强制走"兼容 spawn（detached:true）"= 直接 detached spawn（旧弹窗形态）
//  red-b : red-a 再**去掉** detached = T15 的"无 detached"回归形态（存活应红）
//  reset : 还原
import { readFileSync, writeFileSync } from 'node:fs';
const [file, mode] = process.argv.slice(2);
const MODE_LINE = "  const mode = String(process.env.DSH_REMOTE_WSL_SYSTEMD ?? 'auto').toLowerCase();";
const MODE_MUT = "  const mode = 'off'; // MUTATION-RED-A（强制走 compat/detached 回退形态）";
const DET_LINE = '      detached: true, // ★ 这一条是 (b) 的代价来源：job breakaway 必须的，但它同时带来 DETACHED_PROCESS';
const DET_MUT = '      detached: false, // MUTATION-RED-B（去掉 detached = T15 回归形态）';
let s = readFileSync(file, 'utf8');
const rep = (from, to) => {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.error(`锚点命中 ${n} 处（期望 1）：${from.slice(0, 60)}…`); process.exit(2); }
  s = s.replace(from, to);
};
if (mode === 'red-a') {
  rep(MODE_LINE, MODE_MUT);
  writeFileSync(file, s, 'utf8');
  console.log('RED-A: 主路径已强制为 compat(detached:true) spawn');
} else if (mode === 'red-b') {
  rep(MODE_LINE, MODE_MUT);
  rep(DET_LINE, DET_MUT);
  writeFileSync(file, s, 'utf8');
  console.log('RED-B: 主路径 = compat 且去掉 detached（T15 回归形态）');
} else if (mode === 'nosystemd') {
  // 回退面：在**真源码**上把 systemd-run 换成不存在的命令 ⇒ auto 模式必须"识别→回退→告警→守护真活"
  rep("command -v systemd-run >/dev/null 2>&1", "command -v systemd-run-DOES-NOT-EXIST >/dev/null 2>&1");
  rep('if out=$(systemd-run --user', 'if out=$(systemd-run-DOES-NOT-EXIST --user');
  writeFileSync(file, s, 'utf8');
  console.log('NOSYSTEMD: 已把 systemd-run 换成不存在的命令（模拟发行版未启用 systemd）');
} else if (mode === 'reset-nosystemd') {
  rep("command -v systemd-run-DOES-NOT-EXIST >/dev/null 2>&1", "command -v systemd-run >/dev/null 2>&1");
  rep('if out=$(systemd-run-DOES-NOT-EXIST --user', 'if out=$(systemd-run --user');
  writeFileSync(file, s, 'utf8');
  console.log('RESET-NOSYSTEMD: 已还原');
} else {
  if (s.includes(MODE_MUT)) rep(MODE_MUT, MODE_LINE);
  if (s.includes(DET_MUT)) rep(DET_MUT, DET_LINE);
  writeFileSync(file, s, 'utf8');
  console.log('RESET: 已还原');
}
