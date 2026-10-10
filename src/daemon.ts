#!/usr/bin/env node
/**
 * dsh-remote-wsl / daemon.mjs —— **WSL 侧常驻守护**：按 key 持有 dsh SDK 运行时，监听 127.0.0.1。
 *
 * ## 为什么存在（这是与 VS Code Remote-WSL 差距 #8/#9 的唯一出路）
 *
 * 上游事实（spike + task-2 双重复现）：sessionId 由客户端指定，服务端用它判重并且**落盘占用**——
 * 另一个进程（哪怕原持有者已经正常退出、运行时已消失）再用同一 id 一定收到
 * `JSON-RPC -32603: session "…" already exists`。于是"上下文"只可能活在**那个还活着的运行时进程**里。
 * 把运行时交给常驻守护持有之后，Windows 侧退化成"连上去发一条 prompt 的瘦客户端"，
 * 客户端进程可来可走 —— 这就是 reconnect 语义。
 *
 * ## 为什么是 TCP 127.0.0.1（而不是 Unix socket）
 * WSL2 localhost 转发实测可用（WSL 内绑 127.0.0.1，Windows 直接访问 localhost 命中）；
 * TCP 让两端各用各的 node（Windows 桌面 node / WSL mise node），Unix socket 则要求 Windows 侧能读它。
 *
 * ## 协议（NDJSON，一行一条；连接建立后**第一条必须是 hello**）
 *   → {"op":"hello","token":"<60位十六进制>","client":"win-pid-1234"}
 *   ← {"ok":true,"op":"hello","daemonPid":N,"version":"0.2.0-rc.2","port":8731,…}
 *   → {"op":"prompt","id":1,"key":"k1","text":"…"}
 *   ← {"ok":true,"id":1,"answer":"…","sessionId":"…","turns":2,"runtimePid":1234,"completedBy":"turn/end"}
 *   → {"op":"status","id":2} / {"op":"shutdown","id":3}
 * token 不符 ⇒ `{"ok":false,"error":"unauthorized"}` 并断开（本机任意进程都不能偷 prompt/shutdown）。
 *
 * ## 会话生命周期（Lead 定的语义 #1/#2）
 * 关客户端 **≠** 会话结束。会话只在三种情况结束：显式 `shutdown` / 空闲超过 `--idle-ms` /
 * 守护或运行时死亡。前两种是主动回收，第三种在下一次 prompt 时会拿到**新** sessionId（上下文已重置）。
 *
 * ## 为什么不写 /tmp（task-2 缺陷 #12）
 * 元数据、token、启动脚本、日志全部落 `--state-dir`（默认 `~/.dsh/remote-wsl`，目录 0700、文件 0600）；
 * 退出时清理 daemon.json / daemon.token / 启动脚本。**本守护不创建任何 /tmp/dsh-rwsl-* 文件。**
 *
 * @module dsh-remote-wsl/daemon
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { shellEnvSnippet } from './shell-env.ts';
import { SdkRuntime } from './sdk-runtime.ts';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

const HOME = process.env.HOME && !/[:\\]/.test(process.env.HOME) ? process.env.HOME : '/home/g';
const PORT_REQ = Number(arg('port', '8731'));
const PORT_TRIES = Math.max(1, Number(arg('port-tries', '10')));
const VERSION = arg('version', '0.2.0-rc.2');
const CWD = arg('cwd', HOME);
const PROFILE = arg('profile', 'sdk');
const PROVIDER = arg('provider', 'deepseek-official');
const MODEL = arg('model', 'deepseek-flash');
const IDLE_MS = Number(arg('idle-ms', '1800000'));
/**
 * **寿命闸门**：无 key（没有会话要保）且无客户端连接，持续 `--linger-ms` 就自退。
 * 为什么与 idle 分开：idle 管"某个 key 的运行时"，闸门管"**守护自己**别永久赖着"。
 * 只在 `keys.size === 0` 时计时 ⇒ 永远不会因为闸门丢掉还活着的会话。0 = 关闭闸门。
 */
const LINGER_MS = Number(arg('linger-ms', '600000'));
const QUEUE_LIMIT = Math.max(1, Number(arg('queue-limit', '4')));
const PROXY_PORT = Number(arg('proxy-port', '9910'));
const PROMPT_TIMEOUT_MS = Number(arg('prompt-timeout-ms', '300000'));
const QUIET_MS = Number(arg('quiet-ms', '3000'));
const SHELL_ENV = !flag('no-shell-env');
const STATE_DIR = arg('state-dir', path.join(HOME, '.dsh', 'remote-wsl'));
const LAUNCHER = arg('launcher', '');
/**
 * 元数据**按"槽位"分文件**：槽位 = 启动时请求的端口（`--meta-port`，默认 = `--port`）。
 *
 * 为什么不是单个 `daemon.json`：两个守护并存时（我的验收 / 别人的夹具、或两个 DSH 会话做隔离验证）
 * 单文件会**互相覆盖**。文件也不按"实际监听端口"命名 —— WSL 侧端口被占时守护会 +1 迁移，
 * 那时调用方还不知道新端口；按**请求槽位**命名才能让客户端精确轮询自己那一个文件，
 * 真实端口写在 `port` 字段里（迁移可观测）。`--state-dir` 是另一个维度的完全隔离。
 */
const META_SLOT = String(arg('meta-port', String(PORT_REQ)));
const metaPath = () => path.join(STATE_DIR, `daemon.${META_SLOT}.json`);
const tokenPath = () => path.join(STATE_DIR, `daemon.${META_SLOT}.token`);
const LOG_FILE = path.join(STATE_DIR, 'daemon.log'); // 日志共享（有界 + 每行带 pid），不按槽分

const startedAt = Date.now();
const token = randomBytes(32).toString('hex');

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(STATE_DIR, 0o700);
} catch {
  /* 某些挂载（drvfs）不支持 chmod，忽略但下面写文件仍带 0600 */
}

/** 有界日志：state 目录里的 daemon.log（0600）；超过 256KB 就截断重建，避免无限增长。 */
function log(...parts) {
  const line = `[daemon pid=${process.pid} ${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try {
    const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (st && st.size > 256 * 1024) fs.writeFileSync(LOG_FILE, '', { mode: 0o600 });
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
  } catch {
    /* 日志失败不能影响守护 */
  }
  process.stderr.write(line);
}

// ── 环境只捕获一次（语义 #9）──────────────────────────────────────────────────

function gateway() {
  try {
    return execSync(`ip route show default 2>/dev/null | awk '{print $3; exit}'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function probeTcp(host, port, ms = 3000) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function runBashCapture(script, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ stdout: Buffer.concat(out), stderr: err, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      err = (err + c).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err + e.message, error: e });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/**
 * 捕获一次登录 shell 环境（对位 useShellEnvironment），并把 PATH / 代理拼好。
 * 之后每个运行时直接复用这个 env —— 这就是"环境注入只做一次"。
 */
async function buildRuntimeEnv() {
  let env = { ...process.env };
  if (SHELL_ENV) {
    const res = await runBashCapture(`${shellEnvSnippet({ enable: true })}env -0\n`, 12000);
    const parsed = {};
    for (const pair of res.stdout.toString('utf8').split('\0')) {
      const i = pair.indexOf('=');
      if (i > 0) parsed[pair.slice(0, i)] = pair.slice(i + 1);
    }
    if (Object.keys(parsed).length) {
      env = parsed;
      log(`登录 shell 环境已捕获(${Object.keys(parsed).length} 个变量)${res.timedOut ? ' [超时截断]' : ''}`);
    } else {
      log(`登录 shell 环境捕获失败，沿用默认环境: ${res.stderr.trim().split('\n').slice(-1)[0] ?? ''}`);
    }
  } else {
    log('--no-shell-env: 跳过登录 shell 环境注入');
  }
  const basePath = env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env = { ...env, PATH: `${HOME}/.local/bin:${HOME}/.local/share/mise/shims:${basePath}` };
  const gw = gateway();
  if (PROXY_PORT > 0 && (await probeTcp(gw, PROXY_PORT))) {
    env.NODE_USE_ENV_PROXY = '1';
    env.HTTPS_PROXY = `http://${gw}:${PROXY_PORT}`;
    env.HTTP_PROXY = `http://${gw}:${PROXY_PORT}`;
    log(`主机代理 ${gw}:${PROXY_PORT} 可达 ⇒ 走代理`);
  } else {
    log(`主机代理 ${gw || '?'}:${PROXY_PORT} 不可达 ⇒ 直连`);
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  return env;
}

// ── 元数据 / token（0600；退出时清理）─────────────────────────────────────────

function publicKeys() {
  return [...keys.values()].map((e) => ({
    key: e.key,
    cwd: e.cwd, // P1：每个条目（key+cwd）的生效工作目录
    sessionId: e.runtime?.sessionId ?? null,
    turns: e.turns,
    runtimePid: e.runtime?.runtimePid ?? null,
    startedAt: e.runtime?.startedAt ?? null,
    idleForMs: Date.now() - e.lastUsedAt,
    queued: e.queue.length,
  }));
}

function writeMeta(extra = {}) {
  const payload = {
    pid: process.pid,
    host: '127.0.0.1',
    /** 请求槽位（= 元数据文件名里的那一段）；两个守护并存时用它区分 */
    metaPort: META_SLOT,
    /** 实际监听端口（WSL 侧端口被占时会 +1，于是这两个值可能不同） */
    port: PORT,
    version: VERSION,
    cwd: CWD,
    profile: PROFILE,
    idleMs: IDLE_MS,
    queueLimit: QUEUE_LIMIT,
    lingerMs: LINGER_MS,
    startedAt,
    keys: publicKeys(),
    ...extra,
  };
  try {
    const tmp = `${metaPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, metaPath());
    try {
      fs.chmodSync(metaPath(), 0o600);
    } catch {
      /* drvfs */
    }
  } catch (e) {
    log(`写 ${metaPath()} 失败: ${e.message}`);
  }
}

/** 只清**自己的**文件：绝不动别的槽位的元数据/token（并发守护隔离）。 */
function cleanupFiles() {
  for (const f of [metaPath(), `${metaPath()}.tmp`, tokenPath(), LAUNCHER]) {
    if (!f) continue;
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── key 表 / 运行时 ───────────────────────────────────────────────────────────

/** key -> { key, runtime, turns, queue: [{text,resolve}], running, lastUsedAt, idleTimer } */
const keys = new Map();
let runtimeEnv = null;
let shuttingDown = false;
let activeConns = 0;
let lingerTimer = null;

/** 有客户端连着 / 还有 key ⇒ 取消闸门；两者都空才重新计时。 */
function clearLinger() {
  if (lingerTimer) clearTimeout(lingerTimer);
  lingerTimer = null;
}

function armLinger() {
  clearLinger();
  if (!(LINGER_MS > 0) || shuttingDown) return;
  if (activeConns > 0 || keys.size > 0) return; // 有会话要保 ⇒ 绝不因闸门退出
  lingerTimer = setTimeout(() => {
    if (shuttingDown) return;
    if (activeConns > 0 || keys.size > 0) return armLinger();
    log(`无 key 且无客户端 ${LINGER_MS}ms ⇒ 守护按寿命闸门自退`);
    void reapAllAndExit('linger');
  }, LINGER_MS);
  lingerTimer.unref?.();
}

/** 统一回收路径：shutdown op / SIGINT/SIGTERM / 寿命闸门 都走这里（回收运行时 + 清自己的元数据）。 */
async function reapAllAndExit(reason) {
  if (shuttingDown) return [];
  shuttingDown = true;
  clearLinger();
  const reaped = publicKeys();
  log(`${reason} ⇒ 回收全部运行时并退出（${reaped.length} 个 key）`);
  for (const e of keys.values()) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    await e.runtime?.close().catch((err) => log(`close key=${e.key} 失败: ${err.message}`));
  }
  keys.clear();
  cleanupFiles();
  // 让 shutdown 的**回包先冲出去**再关服务器/退出：以前用 setImmediate 会和 write() 抢跑，
  // 客户端偶发看到 `connection closed before reply`（实测一次；虽然客户端有按 pid 兜底，但那是噪声）。
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  }, 250).unref?.();
  return reaped;
}

/**
 * 条目 id = `key` + **cwd**（P1）。为什么必须把 cwd 纳入身份：一个运行时的 cwd 在创建时就固定了
 * （它决定会话 cwd 与启动工作目录），而 `wsl_agent({cwd})` 是用户可见参数。
 * 以前守护把 cwd 钉死在 `--cwd` 上 ⇒ per-call cwd 被**静默忽略**（行为回退）。
 * 现在同一个 key 的不同 cwd 各持一个运行时（各自的 sessionId），而**同 key 同 cwd 仍然复用同一个**
 * ⇒ 跨宿主重连不受影响。返回值与元数据都会带上生效的 cwd，绝不静默。
 */
const entryId = (key, cwd) => `${key}\u0000${cwd}`;

function getEntry(key, cwd) {
  const id = entryId(key, cwd);
  let e = keys.get(id);
  if (e?.runtime && !e.runtime.alive) {
    log(`key=${key} cwd=${cwd} 运行时已退出(exit=${e.runtime.exitCode}) ⇒ 丢弃（上下文已重置）`);
    e.runtime = null;
    e.sessionId = null;
  }
  if (!e) {
    e = {
      id,
      key,
      cwd,
      runtime: null,
      sessionId: null,
      turns: 0,
      queue: [],
      running: false,
      lastUsedAt: Date.now(),
      idleTimer: null,
    };
    keys.set(id, e);
  }
  return e;
}

function armIdle(entry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (!(IDLE_MS > 0)) return;
  entry.idleTimer = setTimeout(async () => {
    if (shuttingDown || !keys.has(entry.id)) return;
    const rt = entry.runtime;
    keys.delete(entry.id);
    log(`key=${entry.key} cwd=${entry.cwd} 空闲 ${IDLE_MS}ms ⇒ 回收运行时（上下文随之丢失）`);
    await rt?.close().catch(() => {});
    writeMeta();
    armLinger(); // 最后一个 key 被回收后开始计寿命（有 key 时闸门不计时）
  }, IDLE_MS);
  entry.idleTimer.unref?.();
}

async function ensureRuntime(entry) {
  if (entry.runtime?.alive) return entry.runtime;
  if (!runtimeEnv) runtimeEnv = await buildRuntimeEnv();
  const rt = new SdkRuntime({
    key: entry.key,
    version: VERSION,
    cwd: entry.cwd, // P1：按条目（key+cwd）各用自己的工作目录，不再钉死 --cwd
    profile: PROFILE,
    provider: PROVIDER,
    model: MODEL,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    quietMs: QUIET_MS,
    env: runtimeEnv,
    log: (...a) => log(...a),
  });
  await rt.start();
  entry.runtime = rt;
  entry.sessionId = rt.sessionId;
  entry.turns = 0;
  return rt;
}

/** 同一 key 的并发 prompt：**FIFO 串行**，等待位超过上限就明确拒绝（SDK 无 cancel，不许变长尾）。 */
function enqueuePrompt(entry, text) {
  if (entry.queue.length >= QUEUE_LIMIT) {
    return Promise.resolve({
      ok: false,
      error:
        `queue full for key "${entry.key}" cwd=${entry.cwd} (limit ${QUEUE_LIMIT} waiting): ` +
        `上游 SDK 无 cancel，串行队列不接受更多并发；等当前轮结束后重试`,
      queueFull: true,
      retryable: true,
      queueDepth: entry.queue.length,
    });
  }
  return new Promise((resolve) => {
    entry.queue.push({ text, resolve });
    void pump(entry);
  });
}

async function pump(entry) {
  if (entry.running) return;
  entry.running = true;
  try {
    while (entry.queue.length) {
      const job = entry.queue.shift();
      entry.lastUsedAt = Date.now();
      writeMeta();
      try {
        const rt = await ensureRuntime(entry);
        const r = await rt.prompt(job.text);
        entry.turns = r.turns;
        entry.lastUsedAt = Date.now();
        job.resolve({
          ok: !r.retryable,
          answer: r.text,
          sessionId: r.sessionId,
          cwd: entry.cwd, // P1：把**生效的** cwd 回报给调用方（绝不静默）
          turns: r.turns,
          runtimePid: r.runtimePid,
          completedBy: r.completedBy,
          eventCount: r.eventCount,
          retryable: Boolean(r.retryable),
          // 语义 #6：没有正文时**不换**运行时、不改 sessionId，只回报"可重试"
          error: r.retryable
            ? `运行时没有产出 assistant 正文（completedBy=${r.completedBy}, events=${r.eventCount}）；` +
              `运行时保持不动，可直接重试（上下文未丢）`
            : undefined,
          queueDepth: entry.queue.length,
        });
      } catch (e) {
        job.resolve({ ok: false, error: e?.message ?? String(e), retryable: true, queueDepth: entry.queue.length });
      }
      writeMeta();
    }
  } finally {
    entry.running = false;
    armIdle(entry);
    writeMeta();
  }
}

// ── 协议 ──────────────────────────────────────────────────────────────────────

async function handle(req) {
  const id = req?.id ?? null;
  const op = req?.op;
  if (op === 'status') {
    return {
      ok: true,
      id,
      daemonPid: process.pid,
      host: '127.0.0.1',
      port: PORT,
      version: VERSION,
      cwd: CWD,
      profile: PROFILE,
      idleMs: IDLE_MS,
      queueLimit: QUEUE_LIMIT,
      lingerMs: LINGER_MS,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      keys: publicKeys(),
    };
  }
  if (op === 'prompt') {
    const key = String(req.key ?? '').trim();
    if (!key) return { ok: false, id, error: 'prompt requires a non-empty "key"' };
    if (typeof req.text !== 'string' || !req.text.length) {
      return { ok: false, id, error: 'prompt requires a non-empty "text"' };
    }
    // P1：per-call cwd（可选）。缺省 = 守护启动时的 --cwd；不同 cwd ⇒ 不同运行时条目（各自 sessionId）。
    const cwd = typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd.trim() : CWD;
    const entry = getEntry(key, cwd);
    const r = await enqueuePrompt(entry, req.text);
    return { id, cwd: entry.cwd, ...r };
  }
  if (op === 'shutdown') {
    const reaped = await reapAllAndExit('收到 shutdown');
    return { ok: true, id, reaped };
  }
  return { ok: false, id, error: `unknown op: ${String(op)}` };
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  // 有客户端连着 ⇒ 寿命闸门不计时（正在用的守护绝不自己退出）
  activeConns += 1;
  clearLinger();
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    activeConns -= 1;
    armLinger();
  };
  socket.on('close', release);
  let buf = '';
  let authed = false;
  let peer = 'unknown';
  const write = (obj) => {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(obj) + '\n');
    } catch {
      /* 客户端已走 */
    }
  };
  socket.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        write({ id: null, ok: false, error: 'invalid JSON request line' });
        continue;
      }
      if (!authed) {
        // 第一帧必须是 hello + 正确 token —— 本机任意进程都不能偷 prompt/shutdown
        if (req?.op !== 'hello') {
          log(`拒绝未握手连接（op=${String(req?.op)}）`);
          write({ ok: false, error: 'hello required as first frame' });
          socket.end();
          return;
        }
        if (req.token !== token) {
          log('拒绝 token 不符的连接');
          write({ ok: false, error: 'unauthorized' });
          socket.end();
          return;
        }
        authed = true;
        peer = String(req.client ?? 'unknown');
        write({
          ok: true,
          op: 'hello',
          daemonPid: process.pid,
          host: '127.0.0.1',
          port: PORT,
          version: VERSION,
          cwd: CWD,
          profile: PROFILE,
          idleMs: IDLE_MS,
          queueLimit: QUEUE_LIMIT,
          startedAt,
        });
        continue;
      }
      log(`recv op=${req?.op} id=${req?.id} key=${req?.key ?? '-'} peer=${peer}`);
      handle(req).then(write, (e) => write({ id: req?.id ?? null, ok: false, error: e?.message ?? String(e) }));
    }
  });
  // 客户端断开：**什么都不做** —— 这正是本功能的分水岭
  socket.on('end', () => log(`客户端断开（运行时保持存活）peer=${peer}`));
  socket.on('error', (e) => log(`socket 错误: ${e.message}`));
});

let PORT = PORT_REQ;

async function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  fs.writeFileSync(tokenPath(), token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath(), 0o600);
  } catch {
    /* drvfs */
  }
  for (let i = 0; i < PORT_TRIES; i++) {
    const candidate = PORT_REQ + i;
    try {
      await listenOn(candidate);
      PORT = candidate;
      if (i > 0) log(`端口 ${PORT_REQ} 在 WSL 侧被占（EADDRINUSE）⇒ 改用 ${PORT}`);
      break;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE') throw e;
      log(`WSL 侧 ${candidate} 已被占用（EADDRINUSE）⇒ 试 ${candidate + 1}`);
      if (i === PORT_TRIES - 1) throw new Error(`WSL 侧 ${PORT_REQ}..${candidate} 全被占用`);
    }
  }
  log(`listening 127.0.0.1:${PORT} pid=${process.pid} dsh@${VERSION} cwd=${CWD} idleMs=${IDLE_MS} queue=${QUEUE_LIMIT} lingerMs=${LINGER_MS}`);
  writeMeta();
  // 起完就开始计寿命闸门（armLinger 内部：有 key 或有客户端时拒绝计时）
  armLinger();
  // 启动脚本已在 bash 里打开，可以安全删掉（本守护不把任何东西落在 /tmp）
  if (LAUNCHER) {
    try {
      fs.rmSync(LAUNCHER, { force: true });
      log(`已清理启动脚本 ${LAUNCHER}`);
    } catch {
      /* ignore */
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void reapAllAndExit(`收到 ${sig}`).then(() => process.exit(0));
  });
}

main().catch((e) => {
  log(`FATAL: ${e?.message ?? String(e)}`);
  cleanupFiles();
  process.exit(2);
});
