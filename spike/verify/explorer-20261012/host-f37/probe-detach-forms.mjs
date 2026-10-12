// probe-detach-forms.mjs —— 逐形态验证"分离式"到底哪种写法能 (a) 不留窗口 且 (b) 内层真跑起来并存活。
import { spawnSync } from 'node:child_process';
const D = 'debian-u8-1';
const TAG = `t15f${process.pid}`;
const MARK = `/tmp/${TAG}.marker`;
const LOG = `/tmp/${TAG}.log`;
const inner = `echo alive-$$ > ${MARK}; sleep 15`;
const forms = [
  ['1 -e bash -c  echo 基线', ['-d', D, '-e', 'bash', '-c', 'echo HELLO']],
  ['2 -e bash -c  后台 echo', ['-d', D, '-e', 'bash', '-c', 'echo BG & echo FG']],
  ['3 -e bash -c  setsid+nohup+&', ['-d', D, '-e', 'bash', '-c', `setsid nohup bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`]],
  ['4 -e bash -c  umask;setsid+nohup+&', ['-d', D, '-e', 'bash', '-c', `umask 077; setsid nohup bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`]],
  ['5 -- bash -c  setsid+nohup+&', ['-d', D, '--', 'bash', '-c', `setsid nohup bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`]],
  ['6 -e bash -c  nohup only', ['-d', D, '-e', 'bash', '-c', `nohup bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`]],
  ['7 -e bash -c  setsid only', ['-d', D, '-e', 'bash', '-c', `setsid bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`]],
];
const probe = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String(r.stdout || '').replace(/\0/g, '').trim();
};
for (const [label, args] of forms) {
  probe(`rm -f ${MARK} ${LOG}`);
  const r = spawnSync('wsl.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const so = String(r.stdout || '').replace(/\0/g, '').trim();
  const se = String(r.stderr || '').replace(/\0/g, '').split(/\r?\n/).filter((l) => l.trim() && !/WSL|localhost|NAT|wsl:/i.test(l)).join(' | ');
  await new Promise((res) => setTimeout(res, 1200));
  const marker = probe(`cat ${MARK} 2>/dev/null || echo NO_MARKER`);
  const live = probe(`pgrep -f 'sleep 15' | wc -l | tr -d ' '`);
  const pid = (marker.match(/alive-(\d+)/) || [])[1] || '';
  console.log(`### ${label}`);
  console.log(`   status=${r.status} stdout=${JSON.stringify(so)} stderr=${JSON.stringify(se)}`);
  console.log(`   marker=${JSON.stringify(marker)}  sleep存活数=${live}`);
  if (pid) probe(`kill ${pid} 2>/dev/null; true`);
  probe(`rm -f ${MARK} ${LOG}`);
}
console.log('DONE');
