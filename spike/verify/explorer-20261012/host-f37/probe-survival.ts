// probe-survival.ts —— 证"分离式启动"满足语义：Windows 包装层**立刻退出**，而 WSL 内进程**仍活着**。
// 用 Node spawn + argv 数组（避免 PowerShell 引号把脚本拆碎 —— 我第一次用 Start-Process 就踩了这个坑）。
import { spawn, spawnSync } from 'node:child_process';

const DISTRO = process.argv[2] || 'debian-u8-1';
const KEEP = 12;
const MARK = `/tmp/t15-survive-${process.pid}.txt`;
const LOGF = `/tmp/t15-survive-${process.pid}.log`;
const inner = `echo alive-$$ > ${MARK}; sleep ${KEEP}`;
const SCRIPT = `umask 077; setsid nohup bash -c ${JSON.stringify(inner)} </dev/null >${LOGF} 2>&1 & echo LAUNCHED`;

const wsl = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  return String(r.stdout || '').trim();
};

// 窗口快照（用 pwsh -Command + Hidden；不在 PowerShell 里拼参数，避免引号问题）
const snap = () => {
  const ps = `$w=@(Get-Process -EA SilentlyContinue|?{$_.MainWindowHandle -ne 0}|%{"$($_.Id):$($_.ProcessName):$($_.MainWindowTitle)"}); ` +
    `$t=@(Get-CimInstance Win32_Process -EA SilentlyContinue|?{$_.Name -in @('WindowsTerminal.exe','conhost.exe','OpenConsole.exe')}|%{$_.ProcessId}); ` +
    `"WINS=$($w.Count) TERMHOST=$($t -join ',')"`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').trim();
};

console.log(`distro=${DISTRO} keepAlive=${KEEP}s marker=${MARK}`);
console.log(`before: ${snap()}`);

const t0 = Date.now();
const child = spawn('wsl.exe', ['-d', DISTRO, '-e', 'bash', '-c', SCRIPT], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  detached: true,
});
let out = '';
child.stdout.on('data', (c) => (out += c));
await new Promise((res) => child.on('exit', res));
const livedMs = Date.now() - t0;
console.log(`wrapper: pid=${child.pid} lived=${livedMs}ms stdout=${JSON.stringify(out.replace(/\0/g, '').trim())}`);
console.log(`after wrapper exit: ${snap()}`);

await new Promise((r) => setTimeout(r, 2500));
const marker = wsl(`cat ${MARK} 2>/dev/null || echo NO_MARKER`);
const live = wsl(`pgrep -f 'sleep ${KEEP}' | head -3 | tr '\\n' ' '`);
console.log(`marker 内容 = ${JSON.stringify(marker)}   ← 证明内层脚本真的跑了`);
console.log(`wrapper 退出 2.5s 后，WSL 内 sleep 进程 = ${JSON.stringify(live || '(none)')}   ← 非空=守护类进程存活`);
console.log(`存活期窗口快照: ${snap()}`);

const alivePid = Number((marker.match(/alive-(\d+)/) || [])[1] || 0);
console.log('--- 清理：只 kill 我这次自己起的那个 pid（不用全局 pkill）---');
if (alivePid) console.log(wsl(`kill ${alivePid} 2>/dev/null; sleep 0.3; kill -0 ${alivePid} 2>/dev/null && echo STILL_ALIVE || echo KILLED`));
console.log(wsl(`pgrep -f 'sleep ${KEEP}' | wc -l | tr -d ' '`));
console.log(wsl(`rm -f ${MARK} ${LOGF}; echo CLEANED`));
