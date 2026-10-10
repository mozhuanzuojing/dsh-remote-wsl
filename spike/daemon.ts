#!/usr/bin/env node
/**
 * daemon.ts —— WSL 侧常驻的 dsh SDK **运行时守护**（在 WSL 里用 node 跑）。
 *
 * 解决的问题（GAP-AUDIT #8/#9 的自研出路）：
 *   Windows 插件现在是"每个宿主进程自己 spawn 一个 WSL 运行时"，宿主退出 ⇒ 运行时消失 ⇒
 *   同一个 sessionId 再也接不回来（跨进程复用被上游 `-32603 session already exists` 拒绝）。
 *   把运行时交给**常驻守护**持有之后，Windows 侧退化成"连上去发一条 prompt 的瘦客户端"，
 *   于是"关掉客户端再打开、继续同一会话"成立 —— 就是 VS Code Remote 的 reconnect 语义。
 *
 * 为什么是 TCP 127.0.0.1 而不是 Unix socket：
 *   WSL2 的 localhost 转发实测可用（WSL 内绑 127.0.0.1，Windows 直接访问 localhost 命中），
 *   而 Unix socket 需要 Windows 侧有能读它的客户端。TCP 让"两端各用各的语言/运行时"成为可能。
 *
 * 协议（NDJSON，一行一条）：
 *   请求  {"id":1,"op":"prompt","key":"k1","text":"..."}
 *         {"id":2,"op":"status"}
 *         {"id":3,"op":"shutdown"}
 *   成功  {"id":1,"ok":true,"answer":"...","sessionId":"...","turns":2,"runtimePid":1234,"completedBy":"turn/end"}
 *   失败  {"id":1,"ok":false,"error":"..."}
 *   （帧形状的**唯一权威定义**在 protocol.ts —— 纯类型模块，客户端也 import type 同一份）
 *
 * 关键语义（本 spike 的验收点）：
 *   · 客户端断开**不得**杀掉运行时；
 *   · 同一 key 的后续连接继续**同一 sessionId**（上下文保留）；
 *   · 不同 key 各自独立运行时；
 *   · 只有 `shutdown` 或空闲超过 `--idle-ms` 才回收。
 *
 * 用法：node daemon.ts [--port 8731] [--version 0.2.0-rc.2] [--cwd /home/g] [--idle-ms 1800000]
 *
 * 迁移说明（.mjs → .ts，零构建）：只用可擦除语法，Node 原生 type stripping 直接跑源码。
 */
import net from 'node:net';
import { SdkRuntime, homeDir } from './sdk-runtime.ts';
import type { DaemonKeyStatus, DaemonReadyLine, DaemonRequest, DaemonResponse } from './protocol.ts';

const argv = process.argv.slice(2);
function arg(name: string, dflt: string): string {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return dflt;
}

const PORT = Number(arg('port', '8731'));
const VERSION = arg('version', '0.2.0-rc.2');
const CWD = arg('cwd', '/home/g');
const IDLE_MS = Number(arg('idle-ms', '1800000'));
const PROFILE = arg('profile', 'sdk');
const PROVIDER = arg('provider', 'deepseek-official');
const MODEL = arg('model', 'deepseek-flash');
const PROXY_PORT = Number(arg('proxy-port', '9910'));
const PROMPT_TIMEOUT_MS = Number(arg('prompt-timeout-ms', '300000'));
const QUIET_MS = Number(arg('quiet-ms', '3000'));

const startedAt = Date.now();
/** 诊断一律走 stderr；stdout 只留一条机器可读的 listening 行。 */
const log = (...a: unknown[]): void =>
  process.stderr.write(`[daemon ${new Date().toISOString()}] ${a.join(' ')}\n`);

/**
 * 线上来的帧只保证"是合法 JSON"，不保证字段齐全/类型正确。
 * 用 Partial<DaemonRequest> 而不是 DaemonRequest：后者会谎称 key/text 一定存在，
 * 也会诱使后来者删掉 `req.key ?? ''` 这类判空 —— 而那些判空正是错误路径的现状。
 */
type IncomingRequest = Partial<DaemonRequest>;

/** keys: key -> 该 key 的运行时条目（守护内部形状；对外一律过 publicKey() 剥成可序列化视图）。 */
interface KeyEntry {
  key: string;
  runtime: SdkRuntime | null;
  turns: number;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 创建中的 promise：同一个 key 并发到达时复用同一次 start()（避免起两个运行时）。 */
  creating?: Promise<SdkRuntime> | null;
  /** 最近一次已知的 sessionId（runtime 起来前为 undefined）。 */
  sessionId?: string;
}

/** key -> { key, runtime, sessionId, turns, lastUsedAt } */
const keys = new Map<string, KeyEntry>();
let shuttingDown = false;

function publicKey(e: KeyEntry): DaemonKeyStatus {
  return {
    key: e.key,
    sessionId: e.runtime?.sessionId ?? null,
    turns: e.turns,
    runtimePid: e.runtime?.runtimePid ?? null,
    startedAt: e.runtime?.startedAt ?? null,
    idleForMs: Date.now() - e.lastUsedAt,
  };
}

function armIdle(entry: KeyEntry): void {
  if (!(IDLE_MS > 0)) return; // <=0 = 关闭空闲回收（调试用）
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(async () => {
    if (shuttingDown) return;
    log(`idle ${IDLE_MS}ms -> reaping key=${entry.key} session=${entry.runtime?.sessionId}`);
    keys.delete(entry.key);
    // 回收后同 key 再来会拿到**新** sessionId（上下文丢失）——这是 idle 回收的代价，写进 README
    await entry.runtime?.close().catch(() => {});
  }, IDLE_MS);
  entry.idleTimer.unref?.();
}

async function getRuntime(key: string): Promise<SdkRuntime> {
  let entry = keys.get(key);
  if (entry?.runtime && entry.runtime.exitCode !== undefined) {
    log(`runtime for key=${key} exited (code=${entry.runtime.exitCode}) -> dropping (context lost)`);
    keys.delete(key);
    entry = undefined;
  }
  if (!entry) {
    entry = { key, runtime: null, turns: 0, lastUsedAt: Date.now(), idleTimer: null };
    keys.set(key, entry);
  }
  if (!entry.runtime) {
    if (entry.creating) return entry.creating;
    const rt = new SdkRuntime({
      key,
      version: VERSION,
      cwd: CWD,
      profile: PROFILE,
      provider: PROVIDER,
      model: MODEL,
      proxyPort: PROXY_PORT,
      promptTimeoutMs: PROMPT_TIMEOUT_MS,
      quietMs: QUIET_MS,
      log: (...a: unknown[]) => log(...a),
    });
    entry.creating = rt
      .start()
      .then(() => {
        entry.runtime = rt;
        entry.sessionId = rt.sessionId;
        entry.creating = null;
        return rt;
      })
      .catch((e: Error) => {
        entry.creating = null;
        keys.delete(key);
        throw e;
      });
    return entry.creating;
  }
  return entry.runtime;
}

async function handle(req: IncomingRequest): Promise<DaemonResponse> {
  const id = req?.id ?? null;
  const op = req?.op;
  try {
    if (op === 'prompt') {
      const key = String(req.key ?? '').trim();
      if (!key) return { id, ok: false, error: 'prompt requires a non-empty "key"' };
      if (typeof req.text !== 'string' || !req.text.length) {
        return { id, ok: false, error: 'prompt requires a non-empty "text"' };
      }
      const rt = await getRuntime(key); // getRuntime 负责在 keys 里建条目（同一个 key 并发时复用同一个创建 promise）
      const entry = keys.get(key) as KeyEntry;
      entry.lastUsedAt = Date.now();
      const r = await rt.prompt(req.text);
      entry.turns = r.turns;
      entry.lastUsedAt = Date.now();
      armIdle(entry);
      if (!r.text.trim()) {
        return {
          id,
          ok: false,
          error: `runtime produced no assistant text (completedBy=${r.completedBy}, events=${r.eventCount})`,
          sessionId: r.sessionId,
          turns: r.turns,
          runtimePid: r.runtimePid,
          completedBy: r.completedBy,
        };
      }
      return {
        id,
        ok: true,
        answer: r.text,
        sessionId: r.sessionId,
        turns: r.turns,
        runtimePid: r.runtimePid,
        completedBy: r.completedBy,
        eventCount: r.eventCount,
      };
    }
    if (op === 'status') {
      return {
        id,
        ok: true,
        daemonPid: process.pid,
        daemonStartedAt: startedAt,
        uptimeMs: Date.now() - startedAt,
        port: PORT,
        version: VERSION,
        cwd: CWD,
        idleMs: IDLE_MS,
        keys: [...keys.values()].map(publicKey),
      };
    }
    if (op === 'shutdown') {
      log('shutdown requested -> reaping all runtimes');
      const reaped = [...keys.values()].map(publicKey);
      shuttingDown = true;
      for (const e of keys.values()) {
        if (e.idleTimer) clearTimeout(e.idleTimer);
        await e.runtime?.close().catch((err: Error) => log(`close error key=${e.key}: ${err.message}`));
      }
      keys.clear();
      setImmediate(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref?.();
      });
      return { id, ok: true, reaped };
    }
    return { id, ok: false, error: `unknown op: ${String(op)}` };
  } catch (e) {
    return { id, ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

async function reapAll(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`reaping all runtimes (${reason})`);
  for (const e of keys.values()) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    await e.runtime?.close().catch(() => {});
  }
  keys.clear();
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let buf = '';
  const write = (obj: DaemonResponse): void => {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(obj) + '\n');
    } catch {
      /* 客户端已走 */
    }
  };
  // setEncoding('utf8') 之后 chunk 运行时一定是 string（类型声明层面看不到这件事，故显式标注）
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: IncomingRequest;
      try {
        req = JSON.parse(line) as IncomingRequest;
      } catch {
        write({ id: null, ok: false, error: 'invalid JSON request line' });
        continue;
      }
      log(`recv op=${req?.op} id=${req?.id} key=${req?.key ?? '-'}`);
      handle(req).then(write, (e: Error) =>
        write({ id: req?.id ?? null, ok: false, error: e?.message ?? String(e) }),
      );
    }
  });
  // 客户端断开：**什么都不做** —— 这正是本 spike 与现状的分水岭
  socket.on('end', () => log('client disconnected (runtimes kept alive)'));
  socket.on('error', (e: Error) => log(`socket error: ${e.message}`));
});

server.on('error', (e: Error) => {
  log(`FATAL listen error: ${e.message}`);
  process.exit(2);
});

server.listen(PORT, '127.0.0.1', () => {
  const ready: DaemonReadyLine = {
    ok: true,
    event: 'listening',
    host: '127.0.0.1',
    port: PORT,
    pid: process.pid,
    version: VERSION,
    cwd: CWD,
    profile: PROFILE,
    idleMs: IDLE_MS,
    home: homeDir(),
  };
  process.stdout.write(JSON.stringify(ready) + '\n');
  log(`listening on 127.0.0.1:${PORT} pid=${process.pid} dsh@${VERSION} cwd=${CWD} idleMs=${IDLE_MS}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void reapAll(sig).then(() => process.exit(0));
  });
}
