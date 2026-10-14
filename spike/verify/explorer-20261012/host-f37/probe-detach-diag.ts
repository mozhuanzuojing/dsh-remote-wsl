// probe-detach-diag.mjs —— 诊断：为什么分离式后台进程不存活（把 LOG 打出来），并试几种"真分离"配方。
import { spawnSync } from 'node:child_process';
const D = 'debian-u8-1';
const TAG = `t15d${process.pid}`;
const MARK = `/tmp/${TAG}.marker`;
const LOG = `/tmp/${TAG}.log`;
const inner = `echo alive-$$ > ${MARK}; sleep 20`;
const probe = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String(r.stdout || '').replace(/\0/g, '').trim();
};
const forms = [
  ['A setsid nohup (原配方)', `setsid nohup bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`],
  ['B 纯 nohup 不 setsid', `nohup bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`],
  ['C setsid --fork', `setsid --fork bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`],
  ['D 双 fork 子 shell', `( setsid bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & ) ; echo LAUNCHED`],
  ['E systemd-run --user', `systemd-run --user --unit=${TAG} bash -c ${JSON.stringify(inner)} 2>&1 | head -2; echo LAUNCHED`],
  ['F 只 & 不重定向 stdin', `bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & echo LAUNCHED`],
  ['G disown', `bash -c ${JSON.stringify(inner)} </dev/null >${LOG} 2>&1 & disown; echo LAUNCHED`],
];
for (const [label, script] of forms) {
  probe(`rm -f ${MARK} ${LOG}`);
  const r = spawnSync('wsl.exe', ['-d', D, '-e', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  const so = String(r.stdout || '').replace(/\0/g, '').trim();
  const se = String(r.stderr || '').replace(/\0/g, '').split(/\r?\n/).filter((l) => l.trim() && !/WSL|localhost|NAT|wsl:/i.test(l)).join(' | ');
  await new Promise((res) => setTimeout(res, 1500));
  const marker = probe(`cat ${MARK} 2>/dev/null || echo NO_MARKER`);
  const logTxt = probe(`cat ${LOG} 2>/dev/null | head -3 || echo NO_LOG`);
  const live = probe(`pgrep -f 'sleep 20' | wc -l | tr -d ' '`);
  const pid = (marker.match(/alive-(\d+)/) || [])[1] || '';
  console.log(`### ${label}`);
  console.log(`    status=${r.status} stdout=${JSON.stringify(so)} stderr=${JSON.stringify(se)}`);
  console.log(`    marker=${JSON.stringify(marker)} | LOG=${JSON.stringify(logTxt)} | sleep存活=${live}`);
  if (pid) probe(`kill ${pid} 2>/dev/null; true`);
  probe(`rm -f ${MARK} ${LOG}`);
}
console.log('DONE');
