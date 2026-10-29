/**
 * shell-provider **真机集成**回归（P0：WSL 原生 bash）。
 *
 * 与 `test/shell-provider.test.ts` 的分工：那边用假 spawn/假 io 锁**契约形状**；这里在真发行版里锁
 * "命令真的跑在 Linux 侧"这一条（假 spawn 永远证明不了的事）：
 *   · `uname -s` = Linux（不是 Windows 的 MINGW/MSYS）；
 *   · 退出码、stderr、workdir、env（含空格值）、stdin、输出上限；
 *   · 超时与 kill 真的**结束**进程（不是只把 handle 标成 killed）。
 *
 * 跳过条件：非 win32（CI 的 ubuntu 跑不了 WSL）或 `wsl.exe` 不可用 ⇒ 整组 skip（不是假通过）。
 *
 * 运行：`node --experimental-strip-types --test test/*.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createWslShellProvider } from '../src/shell-provider.ts';
import { normalizeConfig } from '../src/config.ts';

/** 本机能不能真的起 WSL（决定整组 skip 还是真跑）。 */
function wslUsable() {
  if (process.platform !== 'win32') return { ok: false, reason: '非 win32：没有 wsl.exe' };
  try {
    execFileSync('wsl.exe', ['--exec', 'true'], { timeout: 15000, stdio: 'ignore' });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `wsl.exe 不可用：${error && error.message ? error.message : String(error)}` };
  }
}

const WSL = wslUsable();
const skip = WSL.ok ? false : `跳过真机用例：${WSL.reason}`;

/** 真配置（自动探测 distro/wslHome/cwd；探测失败会留空，下面的用例会因此失败——而不是静默跳过）。 */
const cfg = WSL.ok ? normalizeConfig({}) : null;
const provider = () => createWslShellProvider({ cfg });

test('真实 WSL：uname -s 是 Linux（命令确实跑在发行版里）', { skip }, async () => {
  const p = provider();
  const proc = await p.execute(p.resolve({ command: 'uname -s' }));
  const result = await proc.result();
  assert.equal(result.exitCode, 0, JSON.stringify(result.stderr));
  assert.match(result.stdout.text.trim(), /^Linux$/);
  assert.equal(proc.status, 'completed');
  assert.equal(result.stdout.truncated, false);
});

test('真实 WSL：退出码/ stderr / workdir 原样回传', { skip }, async () => {
  const p = provider();
  const proc = await p.execute(
    p.resolve({ command: 'echo out; echo err >&2; exit 7', workdir: '/' }),
  );
  const result = await proc.result();
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout.text.trim(), 'out');
  assert.equal(result.stderr.text.trim(), 'err');
  assert.equal(proc.status, 'completed');
});

test('真实 WSL：workdir 真的生效（pwd 是翻译后的 Linux 路径）', { skip }, async () => {
  const p = provider();
  const proc = await p.execute(p.resolve({ command: 'pwd', workdir: '/tmp' }));
  const result = await proc.result();
  assert.equal(result.stdout.text.trim(), '/tmp');
});

test('真实 WSL：env（含空格/引号）与 stdin 都到达 Linux 侧', { skip }, async () => {
  const p = provider();
  const spec = p.resolve({ command: 'printf "%s|%s" "$DSH_PROBE" "$(cat)"', dshEnv: { DSH_PROBE: `a b'c` }, stdin: 'pipe-data' });
  const result = await (await p.execute(spec)).result();
  assert.equal(result.exitCode, 0, JSON.stringify(result.stderr));
  assert.equal(result.stdout.text, `a b'c|pipe-data`);
});

test('真实 WSL：超时会真的结束命令（不是只改 handle 状态）', { skip }, async () => {
  const p = provider();
  const started = Date.now();
  const proc = await p.execute(p.resolve({ command: 'sleep 30', timeoutMs: 300 }));
  const result = await proc.result();
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 300);
  assert.equal(proc.status, 'killed');
  assert.ok(elapsed < 15000, `超时后 ${elapsed}ms 才结算（应当远小于 15s）`);
});

test('真实 WSL：kill() 结束进程组（后台子进程不留在发行版里）', { skip }, async () => {
  const p = provider();
  // 命令自己再起一个后台 sleep：只杀 wsl.exe 的话它会变孤儿
  const marker = `dsh-rwsl-kill-probe-${Date.now()}`;
  const proc = await p.execute(
    p.resolve({ command: `sleep 30 & echo started; wait`, env: { DSH_KILL_MARKER: marker } }),
  );
  // 等命令真的起来
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(proc.kill(), true);
  const result = await proc.result();
  assert.equal(proc.status, 'killed');
  assert.equal(result.exitCode, null);
  // 发行版里不应该再有这个 sleep（给 3s 宽限）
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(await countExactProcess('sleep 30'), 0, 'kill 之后仍有 sleep 30 存活');
});

/** 统计发行版里 cmdline **完全等于**给定字符串的进程数（避免 pgrep 把外层 bash 的命令行也算进来）。 */
async function countExactProcess(args) {
  const check = await (
    await provider().execute(provider().resolve({ command: `ps -eo args= | grep -cx '${args}' || true` }))
  ).result();
  const count = Number.parseInt(check.stdout.text.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

test('真实 WSL：超时 + 命令 trap 了 TERM 时也必须用 KILL 回收（无孤儿）', { skip }, async () => {
  // 2026-10-29 review 回归：旧实现让 kill 脚本回头 `cat` pgid 文件，settle 先删文件 ⇒ 一发信号都没发，
  // 「trap "" TERM; sleep 41」在超时后留下孤儿。现在 pgid 由调用方读出并随脚本传参。
  const p = provider();
  const proc = await p.execute(p.resolve({ command: `bash -c 'trap "" TERM; sleep 41'`, timeoutMs: 250 }));
  const result = await proc.result();
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 3500)); // 宽限 3s 之后
  assert.equal(await countExactProcess('sleep 41'), 0, '超时后仍有 trap TERM 的 sleep 41 存活');
});

test('真实 WSL：命令刚起就 kill（pgid 文件可能还没写）也不留孤儿', { skip }, async () => {
  // 2026-10-29 review 回归：kill 太早 ⇒ 旧实现只杀 wsl.exe，Linux 侧 sleep 变孤儿。
  const p = provider();
  const proc = await p.execute(p.resolve({ command: 'sleep 47' }));
  assert.equal(proc.kill(), true);
  const result = await proc.result();
  assert.equal(proc.status, 'killed');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await countExactProcess('sleep 47'), 0, '立即 kill 后仍有 sleep 47 存活');
});

test('真实 WSL：输出上限生效且标 truncated', { skip }, async () => {
  const p = createWslShellProvider({ cfg: { ...cfg, shellMaxOutputBytes: 200 } });
  const proc = await p.execute(p.resolve({ command: `head -c 5000 /dev/zero | tr '\\0' 'x'` }));
  const result = await proc.result();
  assert.equal(result.stdout.text.length, 200);
  assert.equal(result.stdout.truncated, true);
});
