/**
 * shell-provider 单元回归（P0：WSL 原生 bash 的 `ctx.shell` 替代实现）。
 *
 * 为什么这些用例值得存在（不是"覆盖率凑数"）：
 *   · `ctx.shell` 的契约是**行为契约**（handle 字段、增量读、kill/超时结算、result 只 reject 基础设施错误），
 *     上游 `dsh-bash-local` 用 332 行实现它；我们换实现必须逐条对上，否则工具面会静默降级
 *     （例如 `readFrom` 重复返回 → 作业输出重复；`status` 不切 → 前端永远"运行中"）。
 *   · 所有用例**不碰真实 WSL**：spawn 与 fs 都注入（`options.spawn` / `options.io`），CI 上也能跑。
 *     真机集成在 `test/shell-provider-wsl.test.ts`（无 wsl.exe 时跳过）。
 *
 * 运行：`node --experimental-strip-types --test test/*.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWslShellProvider, toLinuxWorkdir } from '../src/shell-provider.ts';

const CONFIG = { distro: 'test-distro', wslHome: '/home/u', cwd: '/home/u' };

/** 显式配置 ⇒ `normalizeConfig` 不探测（不 spawn 真实 wsl.exe）。 */
const providerOf = (extra = {}, opts = {}) =>
  createWslShellProvider({ config: { ...CONFIG, shellGraceMs: 30, ...extra }, ...opts });

/** 假的子进程：EventEmitter + 三条 stdio + kill 语义。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    ended: false,
    data: undefined,
    end(value) {
      this.ended = true;
      this.data = value;
    },
  };
  child.kill = (signal) => {
    child.killedWith = signal;
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  child.unref = () => {};
  return child;
}

/** spawn 桩：按调用顺序记录 argv；`next()` 取下一次 spawn 的子进程。 */
function spawnStub(children) {
  const calls = [];
  const queue = [...children];
  const spawn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    const child = queue.shift();
    if (!child) throw new Error(`unexpected spawn: ${cmd} ${argv.join(' ')}`);
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** 只记录写入/删除的内存 io 桩（WSL 的 /tmp 用 UNC 路径，单测里不能真写）。 */
function ioStub() {
  const writes = new Map();
  const removed = [];
  return {
    writeFileSync(path, body, opts) {
      writes.set(path, { body: String(body), opts });
    },
    unlinkSync(path) {
      removed.push(path);
      writes.delete(path);
    },
    writes,
    removed,
  };
}

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 路径翻译 ───────────────────────────────────────────────────────────────────

test('toLinuxWorkdir：UNC / Windows 盘符 / Linux 绝对 / 相对 四种输入', () => {
  const cfg = { distro: 'test-distro', wslHome: '/home/u', cwd: '/home/u/proj' };
  assert.equal(toLinuxWorkdir('\\\\wsl.localhost\\test-distro\\home\\u\\a b', cfg), '/home/u/a b');
  assert.equal(toLinuxWorkdir('\\\\wsl$\\test-distro\\home\\u', cfg), '/home/u');
  assert.equal(toLinuxWorkdir('D:\\project\\x', cfg), '/mnt/d/project/x');
  assert.equal(toLinuxWorkdir('/opt/x', cfg), '/opt/x');
  assert.equal(toLinuxWorkdir('sub/dir', cfg), '/home/u/proj/sub/dir');
  assert.equal(toLinuxWorkdir(undefined, cfg), '/home/u/proj');
});

test('toLinuxWorkdir：跨发行版 UNC 必须报错（不猜、不静默改成当前发行版）', () => {
  const cfg = { distro: 'test-distro', wslHome: '/home/u', cwd: '/home/u' };
  assert.throws(() => toLinuxWorkdir('\\\\wsl.localhost\\other\\home\\u', cfg), /其他发行版|发行版 "other"/);
});

test('toLinuxWorkdir：NUL / 换行拒绝（路径是数据，不能变成第二个命令）', () => {
  const cfg = { distro: 'test-distro', wslHome: '/home/u', cwd: '/home/u' };
  assert.throws(() => toLinuxWorkdir('/tmp/a\0b', cfg), /NUL/);
  assert.throws(() => toLinuxWorkdir('/tmp/a\nb', cfg), /NUL|换行/);
});

// ── resolve ───────────────────────────────────────────────────────────────────

test('resolve：缺省超时/上限来自配置，显式 timeoutMs 被 maxTimeoutMs 夹紧', () => {
  const p = providerOf({ shellTimeoutMs: 5000, shellMaxTimeoutMs: 8000, shellMaxOutputBytes: 1024 });
  assert.equal(p.sandboxMode, undefined, 'WSL 执行器不得声称沙箱模式（否则 tool-bash 会索要 sandboxPolicy）');
  const base = p.resolve({ command: 'echo hi' });
  assert.equal(base.timeoutMs, 5000);
  assert.equal(base.onExpiry, 'kill');
  assert.equal(base.stdoutMaxBytes, 1024);
  assert.equal(base.workdir, '/home/u');
  assert.equal(p.resolve({ command: 'x', timeoutMs: 60000 }).timeoutMs, 8000);
  assert.equal(p.resolve({ command: 'x', timeoutMs: 10 }).timeoutMs, 10);
  assert.equal(p.resolve({ command: 'x', onExpiry: 'none' }).onExpiry, 'none');
});

test('resolve：空 command 直接拒绝（不把空串交给 bash）', () => {
  const p = providerOf();
  assert.throws(() => p.resolve({ command: '   ' }), /command 不能为空/);
});

// ── execute：脚本构造 ─────────────────────────────────────────────────────────

test('execute：启动脚本带 cd 守卫、独立进程组、环境覆盖，且命令是字面量', async () => {
  const io = ioStub();
  const child = fakeChild();
  const spawn = spawnStub([child]);
  const p = providerOf({}, { io, spawn });
  const spec = p.resolve({ command: `echo "$(id)"`, workdir: '/home/u/a b' });
  const proc = await p.execute(spec);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, 'wsl.exe');
  assert.deepEqual(spawn.calls[0].argv.slice(0, 3), ['-d', 'test-distro', '--exec']);
  const script = [...io.writes.values()].find((row) => row.body.includes('set -m')).body;
  assert.match(script, /^set -uo pipefail\n/);
  assert.match(script, /cd -- '\/home\/u\/a b' \|\| \{ echo '.*' >&2; exit 2; \}/);
  assert.match(script, /export NO_COLOR='1'/);
  assert.match(script, /export TERM='dumb'/);
  // 命令作为 `bash -c` 的位置参数（单引号），`$(id)` 必须保持字面量
  assert.match(script, /bash -c 'echo "\$\(id\)"' &/);
  // 作业自己的进程组：pid 写进 pgid 文件，退出时按 -pid 收孤儿
  assert.match(script, /printf '%s' "\$pid" > '\/tmp\/dsh-rwsl-shell-.*\.pgid'/);
  assert.match(script, /kill -TERM -- -"\$pid"/);
  child.emit('close', 0, null);
  await proc.result();
});

test('execute：spawn 的 argv 里不内联命令（避免 pwsh→wsl→bash 三层吃引号）', async () => {
  const io = ioStub();
  const child = fakeChild();
  const spawn = spawnStub([child]);
  const p = providerOf({}, { io, spawn });
  const proc = await p.execute(p.resolve({ command: 'echo 中文' }));
  const flat = spawn.calls[0].argv.join(' ');
  assert.doesNotMatch(flat, /中文/);
  assert.match(flat, /\/tmp\/dsh-rwsl-shell-.*\.sh/);
  child.emit('close', 0, null);
  await proc.result();
});

// ── execute：handle 行为契约 ──────────────────────────────────────────────────

test('execute：readFrom 增量、无重复；stderr 经 readOutput 以 [stderr] 合并', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({}, { io, spawn: spawnStub([child]) });
  const proc = await p.execute(p.resolve({ command: 'x' }));
  child.stdout.emit('data', Buffer.from('one\n'));
  const first = proc.observed.stdout.readFrom(0);
  assert.equal(first.text, 'one\n');
  child.stdout.emit('data', Buffer.from('two\n'));
  const second = proc.observed.stdout.readFrom(first.nextOffset);
  assert.equal(second.text, 'two\n', '第二次读不能重复 first 的内容');
  assert.equal(proc.observed.stdout.readFrom(second.nextOffset).text, '');
  child.stderr.emit('data', Buffer.from('warn'));
  const delta = proc.readOutput();
  assert.match(delta.delta, /two\n/);
  assert.match(delta.delta, /\[stderr\]\nwarn/);
  child.emit('close', 0, null);
  const result = await proc.result();
  assert.equal(result.stdout.text, 'one\ntwo\n');
  assert.equal(result.stderr.text, 'warn');
});

test('execute：UTF-8 多字节码点跨 data 事件时不被解成替换字符', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({}, { io, spawn: spawnStub([child]) });
  const proc = await p.execute(p.resolve({ command: 'x' }));
  const bytes = Buffer.from('中', 'utf8');
  child.stdout.emit('data', bytes.subarray(0, 1));
  const mid = proc.observed.stdout.readFrom(0);
  assert.equal(mid.text, '', '半截码点先不返回');
  child.stdout.emit('data', bytes.subarray(1));
  const done = proc.observed.stdout.readFrom(mid.nextOffset);
  assert.equal(done.text, '中');
  assert.doesNotMatch(done.text, /\uFFFD/);
  child.emit('close', 0, null);
  await proc.result();
});

test('execute：正常退出 → status=completed、exitCode 保留（非零不算 killed）', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({}, { io, spawn: spawnStub([child]) });
  const proc = await p.execute(p.resolve({ command: 'exit 3' }));
  assert.equal(proc.status, 'running');
  child.emit('close', 3, null);
  const result = await proc.result();
  assert.equal(proc.status, 'completed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(proc.exitCode, 3);
});

test('execute：kill() 先 TERM 进程组、宽限后 KILL 并兜底杀 wsl.exe；status=killed', async () => {
  const io = ioStub();
  const child = fakeChild();
  const cleanup = fakeChild();
  const spawn = spawnStub([child, cleanup, cleanup]);
  const p = providerOf({ shellGraceMs: 20 }, { io, spawn });
  const proc = await p.execute(p.resolve({ command: 'sleep 100' }));
  assert.equal(proc.kill(), true);
  assert.equal(proc.kill(), false, 'kill 必须幂等');
  assert.match(spawn.calls[1].argv.join(' '), /kill -TERM/);
  await flush(60);
  assert.equal(child.killedWith, 'SIGKILL', '宽限到点必须兜底杀 wsl.exe');
  const result = await proc.result();
  assert.equal(proc.status, 'killed');
  assert.equal(result.exitCode, null);
});

test('execute：超时 → timedOut=true、timeoutMs 原样回显、status=killed', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({ shellGraceMs: 10 }, { io, spawn: spawnStub([child, fakeChild(), fakeChild()]) });
  const proc = await p.execute(p.resolve({ command: 'sleep 5', timeoutMs: 15 }));
  const result = await proc.result();
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 15);
  assert.equal(proc.status, 'killed');
  assert.equal(result.aborted, false);
});

test('execute：abort signal → aborted=true、status=killed', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({ shellGraceMs: 10 }, { io, spawn: spawnStub([child, fakeChild(), fakeChild()]) });
  const controller = new AbortController();
  const proc = await p.execute(p.resolve({ command: 'sleep 5', signal: controller.signal }));
  controller.abort();
  const result = await proc.result();
  assert.equal(result.aborted, true);
  assert.equal(proc.status, 'killed');
});

test('execute：spawn error → done 不 reject、result() 带同一个错误 reject（契约要求）', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({}, { io, spawn: spawnStub([child]) });
  const proc = await p.execute(p.resolve({ command: 'x' }));
  const error = new Error('ENOENT wsl.exe');
  child.emit('error', error);
  await proc.done; // 永不 reject
  await assert.rejects(proc.result(), /ENOENT wsl\.exe/);
  assert.equal(proc.status, 'killed');
});

test('execute：输出超过上限 → 内容截断、truncated=true，但读偏移仍单调', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({ shellMaxOutputBytes: 8 }, { io, spawn: spawnStub([child]) });
  const proc = await p.execute(p.resolve({ command: 'x' }));
  child.stdout.emit('data', Buffer.from('aaaaaaaa'));
  child.stdout.emit('data', Buffer.from('bbbbbbbb'));
  child.emit('close', 0, null);
  const result = await proc.result();
  assert.equal(result.stdout.text, 'aaaaaaaa');
  assert.equal(result.stdout.truncated, true);
});

test('execute：stdin 透传并在无输入时也要关闭（否则读 stdin 的命令会挂死）', async () => {
  const io = ioStub();
  const child = fakeChild();
  const p = providerOf({}, { io, spawn: spawnStub([child]) });
  await p.execute(p.resolve({ command: 'cat', stdin: 'hello' }));
  assert.equal(child.stdin.ended, true);
  assert.equal(child.stdin.data, 'hello');

  const child2 = fakeChild();
  const p2 = providerOf({}, { io, spawn: spawnStub([child2]) });
  await p2.execute(p2.resolve({ command: 'cat' }));
  assert.equal(child2.stdin.ended, true);
  assert.equal(child2.stdin.data, undefined);
});

test('execute：目标发行版未解析 ⇒ 明确报错（不 spawn wsl.exe -d ""）', async () => {
  const io = ioStub();
  const spawn = spawnStub([]);
  // 用已归一化的 cfg 注入（空 distro），避开真实 auto-target 探测
  const p = createWslShellProvider({ cfg: { distro: '', wslHome: '/x', cwd: '/x' }, io, spawn });
  await assert.rejects(p.execute(p.resolve({ command: 'x' })), /发行版未解析|distro/);
  assert.equal(spawn.calls.length, 0);
});

test('execute：WSL /tmp 写不进去时给出可诊断原因（发行版没在跑）', async () => {
  const io = {
    writeFileSync() {
      throw new Error('UNKNOWN: unknown error');
    },
    unlinkSync() {},
  };
  const p = providerOf({}, { io, spawn: spawnStub([]) });
  await assert.rejects(p.execute(p.resolve({ command: 'x' })), /无法在发行版 "test-distro" 里写启动脚本/);
});
