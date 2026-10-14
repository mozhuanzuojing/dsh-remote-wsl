// variant-runner.ts —— F-37 A/B：逐个"起守护形态"跑一次，打印包装层 pid 与时间戳（JSON 一行）。
// 每个长驻形态都让 WSL 侧留一个 ~8s 的 sleep，便于在"存活期间"枚举窗口。
// 这些是**替身命令**（不碰真守护）；真形态在最终验证里用真 launch 脚本跑。
import { spawn } from 'node:child_process';

const VARIANT = process.argv[2];
const DISTRO = process.argv[3] || 'debian-u8-1';
const KEEPALIVE = process.argv[4] || '8';

const forms = {
  // ① 短命（对照）
  'short-listv': { args: ['-l', '-v'], opts: { windowsHide: true, detached: true } },
  'short-true': { args: ['-d', DISTRO, '--', 'bash', '-c', 'true'], opts: { windowsHide: true, detached: true } },
  // ② 长驻：`-- bash` 形态（= 现行实现的形状）
  'long-dash': { args: ['-d', DISTRO, '--', 'bash', '-c', `sleep ${KEEPALIVE}`], opts: { windowsHide: true, detached: true } },
  // ③ 长驻：`-e bash` 形态
  'long-e': { args: ['-d', DISTRO, '-e', 'bash', '-c', `sleep ${KEEPALIVE}`], opts: { windowsHide: true, detached: true } },
  // ④ 长驻：**去掉** windowsHide/detached（隔离这两个选项是否相关）
  'long-nohide': { args: ['-d', DISTRO, '--', 'bash', '-c', `sleep ${KEEPALIVE}`], opts: { windowsHide: false } },
  // ⑤ 候选修法：Windows 侧 wsl.exe 立刻退出，WSL 内 setsid+nohup 分离
  'detach-inwsl': {
    args: ['-d', DISTRO, '-e', 'bash', '-c', `umask 077; setsid nohup sleep ${KEEPALIVE} </dev/null >/dev/null 2>&1 & echo LAUNCHED-$!`],
    opts: { windowsHide: true, detached: true },
  },
  // ⑥ Windows 侧标志隔离矩阵（长驻 sleep，只改 spawn 选项）
  'w-hide-only': { args: ['-d', DISTRO, '--', 'bash', '-c', `sleep ${KEEPALIVE}`], opts: { windowsHide: true } },
  'w-detach-only': { args: ['-d', DISTRO, '--', 'bash', '-c', `sleep ${KEEPALIVE}`], opts: { detached: true } },
  'w-neither': { args: ['-d', DISTRO, '--', 'bash', '-c', `sleep ${KEEPALIVE}`], opts: {} },
  'w-hide-detach': { args: ['-d', DISTRO, '--', 'bash', '-c', `sleep ${KEEPALIVE}`], opts: { windowsHide: true, detached: true } },
};

const spec = forms[VARIANT];
if (!spec) {
  console.log(JSON.stringify({ variant: VARIANT, error: 'unknown variant' }));
  process.exit(2);
}
const t0 = Date.now();
const child = spawn('wsl.exe', spec.args, { stdio: ['ignore', 'pipe', 'pipe'], ...spec.opts });
let out = '';
let err = '';
child.stdout?.on('data', (c) => (out += c));
child.stderr?.on('data', (c) => (err += c));
const rec = { variant: VARIANT, wrapperPid: child.pid, spawnAt: new Date(t0).toISOString().slice(11, 23) };
child.on('exit', (code) => {
  rec.exitAt = new Date().toISOString().slice(11, 23);
  rec.livedMs = Date.now() - t0;
  rec.exitCode = code;
  rec.stdoutTail = out.trim().slice(-120);
  rec.stderrTail = err.replace(/\0/g, '').split(/\r?\n/).filter((l) => l.trim() && !/WSL|localhost|NAT/i.test(l)).slice(-1)[0] || '';
  console.log(JSON.stringify(rec));
});
child.on('error', (e) => {
  rec.error = e.message;
  console.log(JSON.stringify(rec));
  process.exit(1);
});
