#!/usr/bin/env node
/**
 * client.ts —— Windows 侧的**瘦客户端**：连一次、发一条、打印原始 JSON 响应、退出。
 *
 * 它的存在就是被验证的对象：进程退出后，守护进程与它持有的运行时必须还活着，
 * 下一次调用同一个 `key` 必须继续**同一个 sessionId**（上下文保留 = reconnect 成立）。
 *
 * 用法：
 *   node client.ts --host 127.0.0.1 --port 8731 --key k1 --text "记住数字 7，只回 ACK"
 *   node client.ts --port 8731 --status
 *   node client.ts --port 8731 --shutdown
 *
 * stdout：**原始响应行**（一行 JSON，未加工）；诊断走 stderr。
 * 退出码：0 = ok:true；1 = ok:false；2 = 传输层失败（连不上/超时/断流）。
 *
 * 迁移说明（.mjs → .ts，零构建）：请求/响应帧类型直接复用 protocol.ts（import type，零运行时）。
 */
import net from 'node:net';
import type { DaemonOp, DaemonRequest, DaemonResponse } from './protocol.ts';

const argv = process.argv.slice(2);
function arg(name: string, dflt?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return dflt;
}
const has = (name: string): boolean => argv.includes(`--${name}`);

const HOST = arg('host', '127.0.0.1')!;
const PORT = Number(arg('port', '8731'));
const ID = Number(arg('id', '1'));
const KEY = arg('key', '')!;
// 注意保持 `undefined`（而不是 ''）：prompt 分支靠 `typeof TEXT !== 'string'` 区分"没给 --text"
const TEXT = arg('text');
const TIMEOUT_MS = Number(arg('timeout-ms', '300000'));
const STATUS = has('status');
const SHUTDOWN = has('shutdown');

/** socket 的 'error' 事件是带 errno 的 Error（ECONNREFUSED 就在 code 上）。 */
interface ErrnoLike extends Error {
  code?: string;
}

const op: DaemonOp = SHUTDOWN ? 'shutdown' : STATUS ? 'status' : 'prompt';
const req: DaemonRequest = { id: ID, op };
if (op === 'prompt') {
  if (!KEY) {
    process.stdout.write(JSON.stringify({ id: ID, ok: false, error: 'prompt requires --key' }) + '\n');
    process.exit(1);
  }
  if (typeof TEXT !== 'string' || !TEXT.length) {
    process.stdout.write(JSON.stringify({ id: ID, ok: false, error: 'prompt requires --text' }) + '\n');
    process.exit(1);
  }
  req.key = KEY;
  req.text = TEXT;
}

const done = (line: string, code: number): never => {
  process.stdout.write(line.endsWith('\n') ? line : line + '\n');
  process.exit(code);
};

const sock = net.connect({ host: HOST, port: PORT });
sock.setEncoding('utf8');
let buf = '';
let settled = false;

const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
  if (settled) return;
  settled = true;
  try {
    sock.destroy();
  } catch {
    /* ignore */
  }
  done(JSON.stringify({ id: ID, ok: false, error: `transport: timeout after ${TIMEOUT_MS}ms (op=${op})` }), 2);
}, TIMEOUT_MS);

sock.on('connect', () => {
  process.stderr.write(`[client] connected ${HOST}:${PORT} op=${op}${KEY ? ` key=${KEY}` : ''}\n`);
  sock.write(JSON.stringify(req) + '\n');
});

// setEncoding('utf8') ⇒ 运行时 chunk 是 string（类型声明看不到这一点，显式标注）
sock.on('data', (chunk: string) => {
  buf += chunk;
  const nl = buf.indexOf('\n');
  if (nl < 0) return;
  const line = buf.slice(0, nl);
  buf = buf.slice(nl + 1);
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  process.stderr.write(`[client] response received, exiting (daemon+runtime must outlive me)\n`);
  let ok = false;
  try {
    ok = (JSON.parse(line) as DaemonResponse)?.ok === true;
  } catch {
    /* 原样打印，让调用方看到坏帧 */
  }
  sock.end();
  done(line, ok ? 0 : 1);
});

sock.on('end', () => {
  if (settled) return;
  if (buf.trim()) {
    settled = true;
    clearTimeout(timer);
    done(buf.trim(), 0); // 尾帧无换行：当一帧收下
    return;
  }
  settled = true;
  clearTimeout(timer);
  done(JSON.stringify({ id: ID, ok: false, error: 'transport: connection closed before any response' }), 2);
});

sock.on('error', (e: ErrnoLike) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  done(JSON.stringify({ id: ID, ok: false, error: `transport: ${e.code ?? ''} ${e.message}`.trim() }), 2);
});
