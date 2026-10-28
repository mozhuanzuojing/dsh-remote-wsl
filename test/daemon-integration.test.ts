/**
 * 守护生命周期集成测试（HANDOFF：「集成测试只覆盖纯函数，核心守护生命周期零测试」）。
 *
 * ## 为什么要 spawn 子进程，而不是 `import('../src/daemon.ts')`
 * `src/daemon.ts` 是**可执行脚本**：模块顶层就会解析 `--xxx` 参数、`mkdirSync` 状态目录、
 * `main()` 里起 TCP 服务。直接 import 会在**测试进程自己**里真的起一个守护，并写用户真实的
 * `~/.dsh/remote-wsl` —— 既污染用户环境，也没法让每条用例独立控制自己的实例。
 * 所以这里一律用 `process.execPath` + `--experimental-strip-types` 起**子进程**（不写死 `node`、
 * 不依赖 bash / wsl.exe，Windows 与 Linux 都能跑），并强制三件事：
 *   1. `--state-dir` 指向 `os.tmpdir()` 下的独立临时目录（helper 里有断言，用例结束删净）；
 *   2. `--port` 先 `bind(0)` 拿一个空闲端口再关掉（绝不碰用户守护的 8731）；
 *   3. `--port-tries 1` 保证端口精确 —— 端口被占就失败，不许静默 +1 迁到别人的端口上。
 *
 * ## 协议契约（`src/daemon.ts` 头部注释）
 * NDJSON，连接建立后第一帧必须是 `{"op":"hello","token":"<64 位 hex>"}`；错误 token / 首帧非 hello
 * / 超大帧都会回一帧错误并断开，而**守护本身必须存活**。
 *
 * ## 覆盖的行为
 * 1. hello + token 握手：`ok:true`、`op:'hello'`、`pluginVersion`、`protocolVersion`（v0.2.0 版本握手契约）
 * 2. 错误 token ⇒ `unauthorized`，且守护仍存活（随后正确 token 能握手）
 * 3. 首帧不是 hello ⇒ `hello required as first frame`
 * 4. 超大帧（`--max-frame-bytes 65536`）⇒ `frame too large`，且守护仍存活
 * 5. `status` op ⇒ `daemonPid` / `port` 与真实子进程一致
 * 6. SIGTERM ⇒ 干净退出（元数据 + token 删除、`daemon.log` 保留、exit 0）
 * 7. 二次 SIGTERM 不跳过清理（F-04 回归）
 * 8. 非法数值参数 ⇒ 非 0 退出且不写元数据（F-53 伪 listening 回归）
 * 9. （附加，跨平台）`shutdown` op 走同一条回收路径 ⇒ 同样清理干净（Windows 上没有可捕获信号，
 *    这条让 Windows 也真的验到「回收 + 清理」）
 *
 * ## 跳过策略
 * 只允许**环境性**跳过，且一律走显式 `t.skip(原因)`：node 不支持类型擦除 / 无法 spawn / 端口被占 /
 * Windows 没有可捕获的 POSIX 信号。断言失败绝不吞成跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { PROTOCOL_VERSION } from '../src/plugin-version.ts';

const DAEMON_TS = fileURLToPath(new URL('../src/daemon.ts', import.meta.url));
const PKG_VERSION = String(JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version);
/** 只作为守护自报的 `--version`：与插件版本**故意不同**，用来验证两者不会互相冒充。 */
const TEST_VERSION = '0.2.1-rc.3';
const REAL_TMP = realpathSync(tmpdir());

/**
 * 运行 .ts 需要的 flag：Node ≥ 23 默认支持类型擦除，更早的版本必须显式 `--experimental-strip-types`。
 * 先用一次 `-e` 探测，探测不到就整份用例显式 skip（而不是让 8 条用例各失败一次）。
 */
const STRIP_FLAGS = (() => {
  const works = (flags: string[]) => {
    try {
      const r = spawnSync(process.execPath, [...flags, '-e', 'process.exit(0)'], { stdio: 'ignore', timeout: 30_000 });
      return r.status === 0;
    } catch {
      return false;
    }
  };
  if (works(['--experimental-strip-types'])) return ['--experimental-strip-types'];
  if (works([])) return [];
  return null;
})();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取一个**当前空闲**的本地端口：bind(0) 让内核分配，再立刻关掉。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('内核没给出空闲端口'))));
    });
  });
}

/** 端口是否有人监听（用于「守护存活」断言）。 */
function tcpReachable(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 端口能不能被自己绑上（F-53：证明守护没有留下「半死的监听 socket」）。 */
async function assertPortFree(port: number, label: string): Promise<void> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', (e: any) =>
      reject(new Error(`${label}：端口 ${port} 仍被监听（${e?.code ?? e?.message}）⇒ 说明有伪 listening 残留`))
    );
    srv.listen(port, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

function readTextSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 轮询等待（不睡固定值）：probe 返回真值即成功，超时抛出带名字的错误。 */
async function waitFor(
  what: string,
  probe: () => unknown,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 5;
  const started = Date.now();
  let lastErr: any = null;
  for (;;) {
    let ok = false;
    try {
      ok = Boolean(await probe());
    } catch (e: any) {
      lastErr = e;
    }
    if (ok) return;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`等待「${what}」超时（${timeoutMs}ms）${lastErr ? `：${lastErr?.message ?? lastErr}` : ''}`);
    }
    await delay(Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - started))));
  }
}

/** 等子进程退出（`exit` 事件，而不是 sleep）。返回 false 表示超时仍活着。 */
function waitExit(child: any, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    let timer: any = null;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', () => finish(true));
    child.once('close', () => finish(true));
  });
}

/** `--state-dir` 必须在 os.tmpdir() 下：这是「绝不碰用户真实状态目录 ~/.dsh/remote-wsl」的硬保证。 */
function assertStateDirIsolated(stateDir: string): void {
  const real = realpathSync(stateDir);
  const prefix = REAL_TMP.endsWith(sep) ? REAL_TMP : REAL_TMP + sep;
  assert.ok(
    real === REAL_TMP || real.startsWith(prefix),
    `state-dir 必须落在 os.tmpdir() 下（实际 ${real}，tmpdir=${REAL_TMP}）—— 不允许碰用户真实状态目录`
  );
}

type DaemonProc = {
  child: any;
  stateDir: string;
  port: number;
  metaPath: string;
  tokenPath: string;
  logPath: string;
  meta: any;
  token: string;
  stderr: string;
  spawnError: any;
};

type StartOpts = { extra?: string[]; portTries?: string };

function daemonArgs(stateDir: string, port: number, opts: StartOpts = {}): string[] {
  return [
    ...(STRIP_FLAGS as string[]),
    DAEMON_TS,
    '--port', String(port),
    '--port-tries', opts.portTries ?? '1',
    '--state-dir', stateDir,
    '--meta-port', String(port),
    '--version', TEST_VERSION,
    '--cwd', stateDir,
    // 寿命闸门关掉：用例自己控制收尾，别让守护中途自退（0 = 关闭）
    '--linger-ms', '0',
    // 不需要登录 shell 环境 / 宿主代理：少一条对 /bin/bash 与用户代理的依赖（Windows 上没有 /bin/bash）
    '--no-shell-env',
    '--proxy-port', '1',
    // 第三轮：守护启动 1.5s 后会后台补齐核心 CLI 工具（此前那段代码在 `return` 之后、从未执行；
    // 已修到 main() 里）。测试要**零网络**确定性运行 ⇒ 用 --no-provision 关掉，避免在干净
    // 环境（CI/新机器）里跑到下载。按需安装路径不受影响，另有专门用例覆盖。
    '--no-provision',
    ...(opts.extra ?? []),
  ];
}

/**
 * 起一个完全隔离的守护并等它就绪（`daemon.<slot>.json` 出现 + TCP 可连 + 元数据自洽）。
 *
 * 失败时带上子进程 stderr 与日志行抛出（可诊断）；**只有环境性原因**才 t.skip 并返回 null。
 */
async function startDaemon(t: any, opts: StartOpts = {}): Promise<DaemonProc | null> {
  if (!STRIP_FLAGS) {
    t.skip(`当前 node ${process.version} 不能直接运行 .ts（需要 --experimental-strip-types 或 Node ≥ 23）`);
    return null;
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-rw-it-'));
  assertStateDirIsolated(stateDir);

  let port: number;
  try {
    port = await freePort();
  } catch (e: any) {
    rmSync(stateDir, { recursive: true, force: true });
    t.skip(`拿不到 127.0.0.1 上的空闲端口（${e?.message ?? e}）`);
    return null;
  }
  assert.notEqual(port, 8731, '取到的空闲端口不能是用户守护的默认端口');

  const proc: DaemonProc = {
    child: null,
    stateDir,
    port,
    metaPath: join(stateDir, `daemon.${port}.json`),
    tokenPath: join(stateDir, `daemon.${port}.token`),
    logPath: join(stateDir, 'daemon.log'),
    meta: null,
    token: '',
    stderr: '',
    spawnError: null,
  };
  proc.child = spawn(process.execPath, daemonArgs(stateDir, port, opts), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.child.once('error', (e: any) => {
    proc.spawnError = e;
  });
  proc.child.stderr.on('data', (c: any) => {
    proc.stderr = (proc.stderr + String(c)).slice(-8000);
  });
  // 必须消费 stdout/stderr：否则管道缓冲满了子进程会被自己的日志阻塞
  proc.child.stdout.resume();

  try {
    await waitFor(`守护就绪（${proc.metaPath} 出现且 127.0.0.1:${port} 可连）`, async () => {
      if (proc.spawnError) throw proc.spawnError;
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        throw new Error(`进程在就绪前退出（exit=${proc.child.exitCode} signal=${proc.child.signalCode}）`);
      }
      if (!existsSync(proc.metaPath)) return false;
      return tcpReachable(port, 800);
    });
    proc.meta = JSON.parse(readFileSync(proc.metaPath, 'utf8'));
    proc.token = readFileSync(proc.tokenPath, 'utf8').trim();
    // 就绪自检：元数据必须是**这个**子进程、**这个**端口写的（否则后面所有断言都在验错对象）
    assert.equal(proc.meta.pid, proc.child.pid, '元数据 pid 与子进程不一致（可能是别的守护写的）');
    assert.equal(proc.meta.port, port, `实际监听端口 ${proc.meta.port} ≠ 请求端口 ${port}（--port-tries 1 下不许迁移）`);
    return proc;
  } catch (e: any) {
    const diag = [
      `守护未能就绪：${e?.message ?? e}`,
      `state-dir=${stateDir}`,
      `子进程 stderr（尾部）:\n${proc.stderr || '(空)'}`,
      `daemon.log（尾部）:\n${readTextSafe(proc.logPath).slice(-2000) || '(空)'}`,
    ].join('\n');
    await stopDaemon(proc);
    if (proc.spawnError) {
      t.skip(`无法 spawn 子进程（${proc.spawnError?.code ?? proc.spawnError?.message}）：当前环境不允许起守护`);
      return null;
    }
    // 端口在「取出空闲端口 → 守护 bind」之间被别人抢走，是环境问题而不是守护缺陷 ⇒ 显式跳过
    if (/全被占用|EADDRINUSE/.test(proc.stderr)) {
      t.skip(`端口 ${port} 在用例准备期间被其它进程占用（EADDRINUSE）—— 环境性问题，未验证本条`);
      return null;
    }
    throw new Error(diag);
  }
}

/** finally 里的收尾：SIGTERM → 有界等待 → SIGKILL 兜底 → 删临时目录（幂等）。 */
async function stopDaemon(proc: DaemonProc | null): Promise<void> {
  if (!proc) return;
  const child = proc.child;
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
      if (!(await waitExit(child, 8000))) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        await waitExit(child, 5000);
      }
    }
  } finally {
    try {
      rmSync(proc.stateDir, { recursive: true, force: true });
    } catch {
      /* Windows 上个别时刻会短暂占用；留待系统清理 */
    }
  }
}

/**
 * 一条 NDJSON 连接：`nextJson()` 按行配对收包，`closed` 反映对端是否已断开。
 * 不依赖 socket 的 'connect' 时机之外的东西 —— 建连后立刻可用。
 */
function openConn(port: number, timeoutMs = 5000) {
  return new Promise<any>((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setEncoding('utf8');
    let buf = '';
    let closed = false;
    const lines: string[] = [];
    const waiters: Array<(line: string | null) => void> = [];
    const closeWaiters: Array<(v: boolean) => void> = [];

    const settleClose = () => {
      closed = true;
      while (waiters.length) waiters.shift()?.(null);
      while (closeWaiters.length) closeWaiters.shift()?.(true);
    };
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const w = waiters.shift();
        if (w) w(line);
        else lines.push(line);
      }
    });
    sock.on('close', settleClose);
    sock.on('error', settleClose);

    const conn = {
      send(obj: any) {
        sock.write(JSON.stringify(obj) + '\n');
      },
      sendRaw(text: string) {
        sock.write(text);
      },
      nextLine(ms = 5000, what = '一帧'): Promise<string> {
        const queued = lines.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        if (closed) return Promise.reject(new Error(`连接已关闭，未能收到${what}`));
        return new Promise<string>((res, rej) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              sock.destroy();
            } catch {
              /* ignore */
            }
            rej(new Error(`等待${what}超时（${ms}ms）`));
          }, ms);
          waiters.push((line) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (line === null) rej(new Error(`连接已关闭，未能收到${what}`));
            else res(line);
          });
        });
      },
      async nextJson(ms = 5000, what = '一帧'): Promise<any> {
        const line = await conn.nextLine(ms, what);
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`收到非 JSON 行（${what}）：${JSON.stringify(line.slice(0, 200))}`);
        }
      },
      whenClosed(ms = 5000): Promise<boolean> {
        if (closed) return Promise.resolve(true);
        return new Promise<boolean>((res) => {
          closeWaiters.push(res);
          setTimeout(() => res(closed), ms);
        });
      },
      destroy() {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
      },
      get closed() {
        return closed;
      },
    };
    sock.once('connect', () => resolve(conn));
    sock.once('error', (e: any) => {
      reject(new Error(`连接 127.0.0.1:${port} 失败：${e?.message ?? e}`));
    });
  });
}

/** 握手辅助：返回 hello 回包。 */
async function handshake(conn: any, token: string, client = 'integration-test'): Promise<any> {
  conn.send({ op: 'hello', token, client });
  const hello = await conn.nextJson(5000, 'hello 回包');
  assert.equal(hello.ok, true, `hello 握手必须成功：${JSON.stringify(hello).slice(0, 200)}`);
  assert.equal(hello.op, 'hello');
  return hello;
}

// ── 1) hello + token 握手 + 版本握手契约 ────────────────────────────────────────

test('hello + token 握手成功：ok/op/pluginVersion/protocolVersion 全部到位（v0.2.0 版本握手契约）', async (t) => {
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const meta = proc.meta;
    // 元数据契约：宿主在「守护没起来/握手失败」时只能读这个文件判断版本
    assert.equal(meta.pid, proc.child.pid);
    assert.equal(meta.host, '127.0.0.1');
    assert.equal(meta.port, proc.port);
    assert.equal(String(meta.metaPort), String(proc.port), '元数据槽位必须等于 --meta-port');
    assert.equal(meta.version, TEST_VERSION, '--version 必须原样回显');
    assert.equal(meta.pluginVersion, PKG_VERSION, '元数据必须带插件版本');
    assert.equal(meta.protocolVersion, PROTOCOL_VERSION, '元数据必须带协议版本');
    assert.equal(meta.cwd, proc.stateDir, '--cwd 必须原样生效（也证明隔离参数被真正接受）');
    assert.equal(meta.profile, 'sdk');
    assert.equal(meta.lingerMs, 0, '--linger-ms 0 必须关闭寿命闸门');
    assert.equal(meta.idleMs, 1800000, '未传 --idle-ms 时应是默认 30 分钟');
    assert.equal(meta.queueLimit, 4, '未传 --queue-limit 时应是默认 4');
    assert.deepEqual(meta.keys, [], '干净启动时没有 key');
    assert.deepEqual(meta.retired, [], '干净启动时没有退役会话');

    assert.match(proc.token, /^[0-9a-f]{64}$/, 'token 文件必须是 64 位十六进制（32 字节）');

    const conn = await openConn(proc.port);
    conns.push(conn);
    const hello = await handshake(conn, proc.token);
    assert.equal(hello.daemonPid, proc.child.pid, 'hello 必须自报真实 pid');
    assert.equal(hello.port, proc.port, 'hello 必须自报真实端口');
    assert.equal(hello.host, '127.0.0.1');
    assert.equal(hello.version, TEST_VERSION);
    // 版本握手契约：缺任一字段，宿主就无法判断「新宿主 + 旧守护」这个必然出现的组合
    assert.equal(hello.pluginVersion, PKG_VERSION, 'hello 必须回报插件版本');
    assert.equal(hello.protocolVersion, PROTOCOL_VERSION, 'hello 必须回报协议版本');
    assert.equal(hello.cwd, proc.stateDir);
    assert.equal(hello.profile, 'sdk');
    assert.equal(hello.idleMs, 1800000);
    assert.equal(hello.queueLimit, 4);
    assert.equal(typeof hello.startedAt, 'number');
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 2) 错误 token ─────────────────────────────────────────────────────────────

test('错误 token 被拒（unauthorized）且守护仍存活', async (t) => {
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const bad = await openConn(proc.port);
    conns.push(bad);
    bad.send({ op: 'hello', token: 'deadbeef'.repeat(8), client: 'bad-token' });
    const rej = await bad.nextJson(5000, 'unauthorized 拒绝帧');
    assert.equal(rej.ok, false, '错误 token 绝不能拿到 ok:true');
    assert.equal(rej.error, 'unauthorized');
    assert.equal(rej.op, undefined, '拒绝帧不许伪装成 hello 成功');
    // 被判定拒绝后守护主动断开这条连接
    assert.equal(await bad.whenClosed(5000), true, '错误 token 之后守护必须断开该连接');

    // 守护仍存活：进程没退、端口仍可连、正确 token 仍能握手
    assert.equal(proc.child.exitCode, null, '拒绝一个连接不能把守护弄死');
    assert.equal(proc.child.signalCode, null, '拒绝一个连接不能把守护弄死');
    assert.equal(await tcpReachable(proc.port, 2000), true, '拒绝后端口仍必须可连');
    const good = await openConn(proc.port);
    conns.push(good);
    const hello = await handshake(good, proc.token, 'after-bad-token');
    assert.equal(hello.daemonPid, proc.child.pid);
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 3) 首帧不是 hello ─────────────────────────────────────────────────────────

test('首帧不是 hello 被拒（hello required as first frame），守护仍存活', async (t) => {
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const conn = await openConn(proc.port);
    conns.push(conn);
    // 未握手直接要 status：本机任意进程都不能偷 prompt/shutdown，所以必须整条连接拒绝
    conn.send({ op: 'status', id: 1 });
    const rej = await conn.nextJson(5000, '首帧拒绝帧');
    assert.equal(rej.ok, false);
    assert.equal(rej.error, 'hello required as first frame');
    assert.equal(rej.id, undefined, '未握手不允许拿到任何 op 的应答');
    assert.equal(await conn.whenClosed(5000), true, '首帧不是 hello 必须断开');

    assert.equal(proc.child.exitCode, null);
    const good = await openConn(proc.port);
    conns.push(good);
    const hello = await handshake(good, proc.token, 'after-no-hello');
    assert.equal(hello.daemonPid, proc.child.pid);
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 4) 超大帧（F-02）─────────────────────────────────────────────────────────

test('超大帧被拒（--max-frame-bytes 65536）且守护仍存活', async (t) => {
  const proc = await startDaemon(t, { extra: ['--max-frame-bytes', '65536'] });
  if (!proc) return;
  const conns: any[] = [];
  try {
    const conn = await openConn(proc.port);
    conns.push(conn);
    // 不含换行的垃圾：上限必须在**累积当下**判定，不能等换行（F-02 的 OOM 攻击面）
    conn.sendRaw('x'.repeat(70_000));
    const rej = await conn.nextJson(8000, 'frame too large 拒绝帧');
    assert.equal(rej.ok, false);
    assert.match(String(rej.error), /frame too large/, '必须明确拒绝超大帧');
    assert.match(String(rej.error), /65536/, '错误信息必须带上真实上限（可诊断）');
    conn.destroy();

    // 守护仍存活：超大帧那条连接没把服务器带走，正确握手仍必须成功
    assert.equal(proc.child.exitCode, null, '拒绝超大帧不能把守护弄死');
    const good = await openConn(proc.port);
    conns.push(good);
    const hello = await handshake(good, proc.token, 'after-oversize');
    assert.equal(hello.daemonPid, proc.child.pid);
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 5) status op ─────────────────────────────────────────────────────────────

test('status op：daemonPid/port/version 与真实子进程一致，id 原样回显', async (t) => {
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const conn = await openConn(proc.port);
    conns.push(conn);
    await handshake(conn, proc.token);
    conn.send({ op: 'status', id: 7 });
    const st = await conn.nextJson(5000, 'status 回包');
    assert.equal(st.ok, true);
    assert.equal(st.id, 7, '响应必须原样带回请求 id（配对依据）');
    assert.equal(st.daemonPid, proc.child.pid, 'status 的 daemonPid 必须是真实监听进程');
    assert.equal(st.port, proc.port);
    assert.equal(st.host, '127.0.0.1');
    assert.equal(st.version, TEST_VERSION);
    assert.equal(st.pluginVersion, PKG_VERSION);
    assert.equal(st.protocolVersion, PROTOCOL_VERSION);
    assert.equal(st.cwd, proc.stateDir);
    assert.equal(st.lingerMs, 0);
    assert.ok(Number.isInteger(st.uptimeMs) && st.uptimeMs >= 0, 'uptimeMs 必须是非负整数');
    assert.deepEqual(st.keys, [], '还没有 prompt ⇒ key 列表必须为空');
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 6) SIGTERM 干净退出 ──────────────────────────────────────────────────────

test('SIGTERM 干净退出：exit 0、元数据与 token 删除、daemon.log 保留', async (t) => {
  if (process.platform === 'win32') {
    t.skip(
      'Windows 没有可捕获的 POSIX 信号：child.kill(SIGTERM/SIGINT) 走 TerminateProcess 硬杀（实测 7ms、' +
        'signal=SIGTERM、元数据/token 残留），daemon 的 SIGTERM 处理器根本不执行 ⇒ 本条只能在 WSL/Linux 验证。' +
        '同一回收路径（reapAllAndExit）另有 shutdown op 用例在 Windows 上真跑'
    );
    return;
  }
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const conn = await openConn(proc.port);
    conns.push(conn);
    await handshake(conn, proc.token);
    // 先断开客户端：server.close() 的回调只在连接全关后触发，否则要多等 1.5s 兜底
    conn.destroy();
    await waitFor('客户端连接断开', () => conn.closed, { timeoutMs: 5000 });

    assert.equal(existsSync(proc.metaPath), true, '退出前元数据应在');
    assert.equal(existsSync(proc.tokenPath), true, '退出前 token 应在');

    assert.equal(proc.child.kill('SIGTERM'), true, 'SIGTERM 必须能送达');
    assert.equal(await waitExit(proc.child, 15_000), true, 'SIGTERM 后必须在有界时间内退出');
    assert.equal(proc.child.exitCode, 0, '优雅收尾必须 exit 0');
    assert.equal(proc.child.signalCode, null, '不能被信号打死（那说明处理器没跑完）');

    assert.equal(existsSync(proc.metaPath), false, '退出后元数据必须被清理');
    assert.equal(existsSync(proc.tokenPath), false, '退出后 token 必须被清理');
    assert.equal(existsSync(proc.logPath), true, 'daemon.log 必须保留（收尾日志是唯一事后证据）');
    const log = readTextSafe(proc.logPath);
    assert.match(log, /收到 SIGTERM/, '日志必须留下收到 SIGTERM 的证据');
    assert.match(log, /回收全部运行时并退出/, '日志必须留下进入回收路径的证据');
    assert.match(log, /listening 127\.0\.0\.1:/, '日志必须留下成功监听的证据');
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 7) 二次 SIGTERM 不跳过清理（F-04 回归）──────────────────────────────────

test('二次 SIGTERM 仍完成清理（F-04 回归）', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 没有可捕获的 POSIX 信号（child.kill 是 TerminateProcess 硬杀），无法构造「收尾进行中再来一次信号」；请在 WSL/Linux 跑');
    return;
  }
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const conn = await openConn(proc.port);
    conns.push(conn);
    await handshake(conn, proc.token);
    // 故意保持连接开着：server.close(cb) 要等连接关闭 ⇒ 收尾会留下 ≥250ms 的可见窗口，
    // 第二次信号才一定落在「收尾进行中」（F-04 那条路径），而不是打在已经退出的进程上。
    assert.equal(proc.child.kill('SIGTERM'), true);
    await waitFor('第一次信号进入收尾', () => /回收全部运行时并退出/.test(readTextSafe(proc.logPath)), {
      timeoutMs: 8000,
      intervalMs: 5,
    });
    assert.equal(proc.child.kill('SIGTERM'), true, '第二次 SIGTERM 必须在收尾窗口内送达（进程应仍活着）');
    await waitFor('日志记录第二次信号', () => /第 2 次/.test(readTextSafe(proc.logPath)), {
      timeoutMs: 8000,
      intervalMs: 5,
    });

    for (const c of conns) c.destroy();
    assert.equal(await waitExit(proc.child, 15_000), true, '二次信号后仍必须在有界时间内退出');
    // 二次信号会额外挂一个 10s 硬退兜底（exit 1）；正常收尾应在它之前完成 ⇒ exit 0
    assert.equal(proc.child.exitCode, 0, '二次信号后仍应走完整收尾（若走到 10s 硬退兜底会是 exit 1）');
    assert.equal(existsSync(proc.metaPath), false, 'F-04：二次信号不许跳过元数据清理');
    assert.equal(existsSync(proc.tokenPath), false, 'F-04：二次信号不许跳过 token 清理');
    assert.match(readTextSafe(proc.logPath), /第 2 次/, '第二次信号必须被识别为「收尾中再来一次」');
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 8) 非法数值参数 fail-fast（F-53 回归）───────────────────────────────────

test('非法数值参数 fail-fast：--port-tries abc ⇒ exit 2 且不写元数据（F-53 伪 listening 回归）', async (t) => {
  if (!STRIP_FLAGS) {
    t.skip(`当前 node ${process.version} 不能直接运行 .ts`);
    return;
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-rw-it-'));
  assertStateDirIsolated(stateDir);
  let child: any = null;
  try {
    const port = await freePort();
    child = spawn(process.execPath, daemonArgs(stateDir, port, { portTries: 'abc' }), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let spawnError: any = null;
    child.once('error', (e: any) => {
      spawnError = e;
    });
    child.stderr.on('data', (c: any) => {
      stderr = (stderr + String(c)).slice(-8000);
    });
    child.stdout.resume();

    const exited = await waitExit(child, 20_000);
    if (spawnError) {
      t.skip(`无法 spawn 子进程（${spawnError?.code ?? spawnError?.message}）：当前环境不允许起守护`);
      return;
    }
    assert.equal(exited, true, '参数非法必须在有界时间内退出（不许挂住）');
    assert.equal(child.exitCode, 2, `F-53：参数非法必须 exit 2，实际 exit=${child.exitCode} signal=${child.signalCode}`);

    const metaPath = join(stateDir, `daemon.${port}.json`);
    assert.equal(existsSync(metaPath), false, 'F-53：参数非法时绝不能写元数据（否则客户端会把它当成活守护）');
    assert.equal(existsSync(join(stateDir, `daemon.${port}.token`)), false, '参数非法时也不该发 token');

    const log = readTextSafe(join(stateDir, 'daemon.log'));
    assert.match(log, /参数错误/, '必须有结构化参数错误日志');
    assert.match(log, /--port-tries/, '错误信息必须点名是哪个参数');
    assert.doesNotMatch(log, /listening 127\.0\.0\.1:/, 'F-53：参数非法时绝不能打印/记录伪 listening');
    // 端口确实没人监听（能自己绑上）⇒ 没有半死的监听 socket
    await assertPortFree(port, 'F-53');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ── 9) shutdown op（附加：Windows 上唯一能真验「回收 + 清理」的路径）───────────

test('shutdown op：同一条回收路径，元数据与 token 也被清理（跨平台）', async (t) => {
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const conn = await openConn(proc.port);
    conns.push(conn);
    await handshake(conn, proc.token);
    conn.send({ op: 'shutdown', id: 3 });
    const reply = await conn.nextJson(8000, 'shutdown 回包');
    assert.equal(reply.ok, true, `shutdown 必须成功：${JSON.stringify(reply).slice(0, 200)}`);
    assert.equal(reply.id, 3, 'shutdown 响应必须带回请求 id');
    assert.ok(Array.isArray(reply.reaped), 'shutdown 必须回报被回收的 key 列表（空也应是数组）');

    for (const c of conns) c.destroy();
    assert.equal(await waitExit(proc.child, 15_000), true, 'shutdown 后必须退出');
    assert.equal(proc.child.exitCode, 0, 'shutdown 是正常收尾 ⇒ exit 0');
    assert.equal(existsSync(proc.metaPath), false, 'shutdown 也必须清元数据');
    assert.equal(existsSync(proc.tokenPath), false, 'shutdown 也必须清 token');
    assert.match(readTextSafe(proc.logPath), /收到 shutdown/, '日志必须留下收到 shutdown 的证据');
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

// ── 10) A-P1-A：守护身份必须上报实际 provider/model（三处一致）───────────────

test('守护身份：provider/model/useShellEnvironment/proxyPort 在 meta / hello / status 三处一致（A-P1-A）', async (t) => {
  const proc = await startDaemon(t, { extra: ['--provider', 'test-provider', '--model', 'test/model-x'] });
  if (!proc) return;
  const conns: any[] = [];
  try {
    // 元数据：宿主在"没握手成功"时只能靠它判断守护身份
    assert.equal(proc.meta.provider, 'test-provider');
    assert.equal(proc.meta.model, 'test/model-x');
    assert.equal(proc.meta.useShellEnvironment, false, '集成测试带 --no-shell-env，必须如实上报 false');
    assert.equal(proc.meta.proxyPort, 1);

    const conn = await openConn(proc.port);
    conns.push(conn);
    const hello = await handshake(conn, proc.token);
    assert.equal(hello.provider, 'test-provider', 'hello 必须回报实际 provider（复用核对点）');
    assert.equal(hello.model, 'test/model-x', 'hello 必须回报实际 model');
    assert.equal(hello.useShellEnvironment, false);
    assert.equal(hello.proxyPort, 1);

    conn.send({ op: 'status', id: 11 });
    const st = await conn.nextJson(5000, 'status 回包');
    assert.equal(st.ok, true);
    assert.equal(st.provider, 'test-provider');
    assert.equal(st.model, 'test/model-x');
    assert.equal(st.useShellEnvironment, false);
    assert.equal(st.proxyPort, 1);
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});

test('prompt op：宿主 provider/model 与守护不一致 ⇒ 明确拒绝且不创建一个 key（A-P1-A 最后一道闸门）', async (t) => {
  const proc = await startDaemon(t);
  if (!proc) return;
  const conns: any[] = [];
  try {
    const conn = await openConn(proc.port);
    conns.push(conn);
    await handshake(conn, proc.token);
    conn.send({
      op: 'prompt',
      id: 12,
      key: 'route-guard',
      text: 'hello',
      provider: 'some-other-provider',
      model: 'some/other-model',
    });
    const reply = await conn.nextJson(8000, 'prompt 拒绝回包');
    assert.equal(reply.ok, false, 'provider 不一致必须失败，绝不能拿旧守护静默跑一轮');
    assert.match(reply.error, /provider\/model/);
    assert.match(reply.error, /action=restart/, '错误里必须给出可操作动作');
    assert.equal(reply.retryable, false, '方向错误的请求不许被标成"可重试"（重试仍会打到旧守护）');
    assert.deepEqual(reply.configMismatch, {
      daemon: { provider: 'deepseek-official', model: 'deepseek-flash' },
      requested: { provider: 'some-other-provider', model: 'some/other-model' },
    });

    // 拒绝发生在进队列之前：不能留下 key 条目（否则会误导后续 status/会话续聊）
    conn.send({ op: 'status', id: 13 });
    const st = await conn.nextJson(5000, 'status 回包');
    assert.equal(st.ok, true);
    assert.deepEqual(st.keys, [], '被拒绝的 prompt 不得创建 key');
  } finally {
    for (const c of conns) c.destroy();
    await stopDaemon(proc);
  }
});
