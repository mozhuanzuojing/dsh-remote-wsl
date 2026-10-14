// probe-kill-semantics.mjs —— 区分"后台进程从没起来" vs "起来了但包装层退出时被 WSL 杀掉"。
// 判据：后台进程每 0.5s 往文件追加一行时间戳；包装层退出后看行数：
//   0 行 = 从没起来 / 1 行 = 起来后被立刻杀 / N 行 = 真存活。
import { spawn, spawnSync } from 'node:child_process';
const D = 'debian-u8-1';
const TAG = `t15k${process.pid}`;
const OUT = `/tmp/${TAG}.tick`;
const probe = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String(r.stdout || '').replace(/\0/g, '').trim();
};
// ★ 必须用模板字符串（反引号）：我第一次用单引号 ⇒ `${OUT}` 没被插值，shell 里是未定义变量，全线假 0。
const inner = `for i in $(seq 1 8); do date +%H:%M:%S.%N >> ${OUT}; sleep 0.5; done`;
const forms = [
  ['1 前台（现状形态）', `bash -c ${JSON.stringify(inner)}`], // 前台：wrapper 活到最后
  ['2 后台 &', `bash -c ${JSON.stringify(inner)} </dev/null >/dev/null 2>&1 & echo LAUNCHED`],
  ['3 setsid 后台', `setsid bash -c ${JSON.stringify(inner)} </dev/null >/dev/null 2>&1 & echo LAUNCHED`],
  ['4 nohup+setsid 后台', `setsid nohup bash -c ${JSON.stringify(inner)} </dev/null >/dev/null 2>&1 & echo LAUNCHED`],
  ['5 systemd-run --user', `systemd-run --user --unit=${TAG}u bash -c ${JSON.stringify(inner)} >/dev/null 2>&1; echo LAUNCHED`],
];
for (const [label, script] of forms) {
  probe(`rm -f ${OUT}`);
  const args = ['-d', D, '-e', 'bash', '-c', script];
  const t0 = Date.now();
  const child = spawn('wsl.exe', args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true });
  await new Promise((res) => child.on('exit', res));
  const livedMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 2500));
  const ticks = probe(`wc -l < ${OUT} 2>/dev/null | tr -d ' ' || echo MISSING`);
  const alive = probe(`pgrep -f 'seq 1 8' | wc -l | tr -d ' '`);
  console.log(`### ${label}`);
  console.log(`    wrapper 存活 ${livedMs}ms；包装层退出 2.5s 后：ticks=${ticks}（0=没起来 / 1=起来即被杀 / 多=真存活） seq进程=${alive}`);
  // 清理：只收我自己的（systemd 单元/后台进程）
  probe(`pkill -f '${TAG}' 2>/dev/null; pkill -f "seq 1 8" 2>/dev/null; systemctl --user stop ${TAG}u 2>/dev/null; rm -f ${OUT}; true`);
}
console.log('DONE');
