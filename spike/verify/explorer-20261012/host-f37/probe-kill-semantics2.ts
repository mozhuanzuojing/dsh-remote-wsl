// probe-kill-semantics2.ts —— 用"脚本文件"形态（与真实现同构：写脚本 + bash <file>）测后台存活语义。
// 判据：tick 文件行数。0=没起来 / 1=起来即被杀 / 多=真存活。完全避开多层引号。
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const D = 'debian-u8-1';
const TAG = `t15s${process.pid}`;
const SH_WSL = `/tmp/${TAG}.sh`;
const TICK_WSL = `/tmp/${TAG}.tick`;
const SH_UNC = `\\\\wsl.localhost\\${D}\\tmp\\${TAG}.sh`;

// 脚本内容：每条 tick 都带自己的 pid（便于判断是否同一进程）
const body = `echo "start pid=$$ at $(date +%H:%M:%S.%N)" >> ${TICK_WSL}
for i in 1 2 3 4 5 6 7 8; do echo "tick-$i pid=$$ $(date +%H:%M:%S.%N)" >> ${TICK_WSL}; sleep 0.5; done
echo "end pid=$$ at $(date +%H:%M:%S.%N)" >> ${TICK_WSL}
`;
writeFileSync(SH_UNC, body, { mode: 0o600 });

const probe = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String(r.stdout || '').replace(/\0/g, '').trim();
};

const forms = [
  ['1 前台 bash <script>（现状形态）', `bash ${SH_WSL}`],
  ['2 后台 &', `bash ${SH_WSL} </dev/null >/dev/null 2>&1 & echo LAUNCHED`],
  ['3 setsid 后台', `setsid bash ${SH_WSL} </dev/null >/dev/null 2>&1 & echo LAUNCHED`],
  ['4 setsid nohup 后台', `setsid nohup bash ${SH_WSL} </dev/null >/dev/null 2>&1 & echo LAUNCHED`],
  ['5 systemd-run --user', `systemd-run --user --unit=${TAG} bash ${SH_WSL} >/dev/null 2>&1; echo LAUNCHED`],
];

for (const [label, script] of forms) {
  probe(`rm -f ${TICK_WSL}`);
  const t0 = Date.now();
  const child = spawn('wsl.exe', ['-d', D, '-e', 'bash', '-c', script], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true });
  await new Promise((res) => child.on('exit', res));
  const livedMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 2500));
  const ticks = probe(`test -f ${TICK_WSL} && wc -l < ${TICK_WSL} | tr -d ' ' || echo FILE_MISSING`);
  const first = probe(`head -1 ${TICK_WSL} 2>/dev/null`);
  const last = probe(`tail -1 ${TICK_WSL} 2>/dev/null`);
  const alivePid = probe(`tail -1 ${TICK_WSL} 2>/dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'`);
  console.log(`### ${label}`);
  console.log(`    wrapper 存活 ${livedMs}ms；退出 2.5s 后 ticks=${ticks}（0/1=被掐 / 多=存活）`);
  console.log(`    first=${JSON.stringify(first)}`);
  console.log(`    last =${JSON.stringify(last)}`);
  if (alivePid) probe(`kill ${alivePid} 2>/dev/null; true`);
  probe(`systemctl --user stop ${TAG} 2>/dev/null; rm -f ${TICK_WSL} ${SH_WSL}; true`);
}
console.log('DONE');
