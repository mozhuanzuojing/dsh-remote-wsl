// probe-escape.ts —— 关键对照：
// E1 非 detached 的长驻 wsl.exe 是否会随 Node 父进程退出而死？（脱离插件，独立验证环境行为）
// E2 detached:true + 全 'ignore' stdio 是否仍弹 WindowsTerminal？
// E3 systemd-run 在 WSL 里是否真能托管一个长驻进程（决定它能不能当修法）。
import { spawn, spawnSync } from 'node:child_process';
const D = 'debian-u8-1';
const TAG = `t15e${process.pid}`;
const MODE = process.argv[2];
const PROBE = `pgrep -f 'sleep 120' | wc -l | tr -d ' '`;

const wslProbe = (script) => {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const r = spawnSync('wsl.exe', ['-d', D, '-u', 'g', '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return String(r.stdout || '').replace(/\0/g, '').trim();
};
const windowsSnapshot = () => {
  const ps = `$w=@(Get-Process -EA SilentlyContinue|?{$_.MainWindowHandle -ne 0}|%{"$($_.Id):$($_.ProcessName)"}); ` +
    `$t=@(Get-CimInstance Win32_Process -Filter "Name='WindowsTerminal.exe'" -EA SilentlyContinue|%{$_.ProcessId}); ` +
    `"WINS=$($w.Count) [$($w -join ',')] WT=$($t.Count) [$($t -join ',')]"`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  return String(r.stdout || '').trim();
};

if (MODE === 'parent-exit') {
  // E1：子进程形态 → 父进程退出 → 3s 后看子进程还在不在（用 pid 精确判断，不靠 pgrep 模式）
  const variant = process.argv[3] || 'nodetach';
  const opts = variant === 'nodetach' ? { windowsHide: true } : { windowsHide: true, detached: true };
  const child = spawn('wsl.exe', ['-d', D, '--', 'bash', '-c', 'sleep 120'], { stdio: ['ignore', 'ignore', 'ignore'], ...opts });
  console.log(`spawned variant=${variant} pid=${child.pid} opts=${JSON.stringify(opts)}`);
  // 父进程立刻退出（模拟"关客户端"）
  process.exit(0);
} else if (MODE === 'check-pid') {
  const pid = Number(process.argv[3]);
  const ps = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -EA SilentlyContinue; if ($p) { "ALIVE $($p.Name) created=$($p.CreationDate)" } else { "DEAD" }`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  console.log(String(r.stdout || '').trim());
} else if (MODE === 'e2') {
  // E2：detached + 全 ignore stdio，看窗口
  console.log(`before: ${windowsSnapshot()}`);
  const child = spawn('wsl.exe', ['-d', D, '--', 'bash', '-c', 'sleep 8'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true });
  console.log(`spawned pid=${child.pid} (stdio 全 ignore + detached)`);
  await new Promise((r) => setTimeout(r, 3500));
  console.log(`during: ${windowsSnapshot()}`);
  await new Promise((res) => child.on('exit', res));
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`after:  ${windowsSnapshot()}`);
} else if (MODE === 'e3') {
  // E3：systemd-run --user 能否真托管长驻进程
  console.log('user bus: ' + wslProbe('echo XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR; systemctl --user is-system-running 2>&1 | head -1'));
  const unit = `${TAG}.service`;
  const r = wslProbe(`systemd-run --user --unit=${TAG} --collect bash -c 'sleep 120' 2>&1; sleep 1; systemctl --user is-active ${TAG}.service 2>&1; pgrep -f 'sleep 120' | wc -l | tr -d ' '`);
  console.log(`systemd-run 结果: ${JSON.stringify(r)}`);
  console.log(`之后仍活着: ${wslProbe(`sleep 1; systemctl --user is-active ${TAG}.service 2>&1; pgrep -f 'sleep 120' | wc -l | tr -d ' '`)}`);
  console.log(`清理: ${wslProbe(`systemctl --user stop ${TAG}.service 2>&1; systemctl --user reset-failed ${TAG}.service 2>&1; echo done`)}`);
} else {
  console.log('usage: probe-escape.ts parent-exit <nodetach|detach> | check-pid <pid> | e2 | e3');
}
