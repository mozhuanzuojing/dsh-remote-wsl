/**
 * dsh-remote-wsl / daemon-conn —— 宿主到守护的**长连接**（一条连接多请求，按 `id` 配对应答）。
 *
 * ## 为什么要有这个文件（2026-11-24 根因）
 * 旧实现 `tcpCall()` 每个请求都 `net.connect` + `destroy`：**每 op 一条 TCP 连接**。一次文件密集的回合
 * 实测能到 1106 次 RPC / 8.3 秒（峰值 165/s），而 Windows 的客户端 socket 关闭后会占住本地临时端口
 * 约 120 秒（默认 `TcpTimedWaitDelay`）—— 本机动态端口范围只有 16384 个（49152–65535，`netsh` 实测）。
 * 实测：1200 次 connect→destroy 之后，Windows 侧到 8731 的 TIME_WAIT 有 4058 个；持续 130+ 连接/秒
 * 两分钟就能把池子耗光，此后**全机**新建连接都会拿到 `EADDRINUSE`（WinError 10048）。用户看到的
 * `connect EADDRINUSE 127.0.0.1:8731` 就是这么来的：**不是目的端口被占，是本机临时端口没了**。
 *
 * 守护侧本来就支持一条连接多帧（hello 之后 `data` 循环逐帧 `handle()`），所以这一层是纯宿主侧改动：
 * 复用一条连接 + 单调递增 `id` 配对回包 + 空闲关闭 + 断了自动重连。
 *
 * ## 语义边界
 *  · `prompt` **不走这里**：它可能跑几分钟，且语义上要求"一条连接只承载一次长任务"（见 daemon-protocol.ts
 *    的 `callDaemonOnce`）。本池只服务 `fs` / `search` / `status` 这类短请求。
 *  · 超时后**断开连接**：协议状态不可信，继续复用可能把迟到回包配给新请求。
 *  · `batch`（`{op:'fs', method:'batch'}`）是新协议（v5）能力；旧守护回 `unknown fs method` 时把该连接
 *    标记为 `batchUnsupported`，由调用方退回逐条发送（新宿主 + 旧守护仍可用）。
 *
 * @module dsh-remote-wsl/daemon-conn
 */
import net from 'node:net';
/** 空闲多久关连接（毫秒）。守护侧 `socket-idle-ms` 默认 120s，这里先关，避免被对面掐。 */
const IDLE_CLOSE_MS = Number(process.env.DSH_RWSL_POOL_IDLE_MS ?? 45000) || 45000;
/** 连接池：key = `host:port:token前 8 位`（token 换 ⇒ 守护换了 ⇒ 旧连接一定已死，不入同一个池）。 */
const pools = new Map();
/** 诊断计数（`wsl_status` / 测试用来证明"连接数不再随 op 增长"）。 */
const stats = {
    /** 池里新建过多少条 TCP 连接（整个宿主进程累计）。 */
    opened: 0,
    /** 复用命中的请求数。 */
    reused: 0,
    /** 因超时/错误被断开的连接数。 */
    dropped: 0,
    /** 通过 batch 帧发出去的请求数，以及省下的帧数。 */
    batched: 0,
    batchSaved: 0,
};
const logTo = () => { };
/** 池 key（token 只取前 8 位：够区分，不进日志）。 */
export function poolKey(port, token, host = '127.0.0.1') {
    return `${host}:${port}:${String(token ?? '').slice(0, 8)}`;
}
/** 当前连接池读数（测试与诊断用；纯读，不触发连接）。 */
export function poolStats() {
    return { ...stats, conns: pools.size };
}
/** 关掉所有池连接（插件卸载 / 测试收尾）。 */
export function disposePool(reason = 'dispose') {
    for (const conn of pools.values())
        conn.destroy('closed', reason);
    pools.clear();
}
class Conn {
    constructor(host, port, token, log = logTo) {
        this.host = host;
        this.port = port;
        this.token = token;
        this.log = log;
        this.key = poolKey(port, token, host);
        this.sock = null;
        this.ready = null;
        this.closed = true;
        this.destroyed = false;
        /** 旧守护不认识 `{op:'fs', method:'batch'}`（协议 v5）⇒ 粘住，不再试。 */
        this.batchUnsupported = false;
        this.pending = new Map();
        this.nextId = 1;
        this.idleTimer = null;
        this.helloInfo = null;
    }
    _clearIdle() {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
    _armIdle() {
        this._clearIdle();
        if (this.pending.size > 0 || this.closed)
            return;
        this.idleTimer = setTimeout(() => this.destroy('closed', 'idle'), IDLE_CLOSE_MS);
        // 别让空闲连接吊住宿主进程退出（DSH 退出时不该等 45s）。
        this.idleTimer.unref?.();
    }
    /** 建立连接并完成 hello 握手；已握手则直接返回。 */
    _connect(timeoutMs) {
        if (this.ready !== null)
            return this.ready;
        if (this.destroyed)
            return Promise.reject(new Error('connection disposed'));
        this.ready = new Promise((resolve, reject) => {
            let settled = false;
            const sock = net.connect({ host: this.host, port: this.port });
            this.sock = sock;
            sock.setEncoding('utf8');
            let buf = '';
            const helloTimer = setTimeout(() => fail(Object.assign(new Error('hello timeout'), { code: 'HELLO_TIMEOUT' })), Math.max(500, timeoutMs || 3000));
            helloTimer.unref?.();
            const fail = (e) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(helloTimer);
                this.ready = null;
                this.closed = true;
                try {
                    sock.destroy();
                }
                catch {
                    /* 已经死了 */
                }
                pools.delete(this.key);
                reject(e);
            };
            sock.once('connect', () => {
                stats.opened += 1;
                try {
                    sock.write(`${JSON.stringify({ op: 'hello', token: this.token, client: `win-pid-${process.pid}` })}\n`);
                }
                catch (e) {
                    fail(e);
                }
            });
            sock.on('data', (chunk) => {
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line)
                        continue;
                    let m;
                    try {
                        m = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (!settled) {
                        if (m?.op !== 'hello')
                            return fail(new Error('unexpected first frame'));
                        if (m.ok !== true)
                            return fail(Object.assign(new Error(String(m.error ?? 'unauthorized')), { code: 'UNAUTHORIZED' }));
                        settled = true;
                        clearTimeout(helloTimer);
                        this.closed = false;
                        this.helloInfo = m;
                        resolve(m);
                        return;
                    }
                    this._settle(m);
                }
            });
            sock.once('error', (e) => {
                if (!settled)
                    return fail(e);
                this.destroy(e?.code === 'ECONNRESET' ? 'closed' : 'error', e?.message ?? String(e));
            });
            sock.once('end', () => {
                if (!settled)
                    return fail(new Error('closed before hello'));
                this.destroy('closed', 'connection closed');
            });
            sock.once('close', () => {
                if (!settled)
                    return fail(new Error('closed before hello'));
                this.destroy('closed', 'connection closed');
            });
        });
        return this.ready;
    }
    _settle(m) {
        const p = this.pending.get(m?.id);
        if (p === undefined) {
            // 迟到/错配回包：绝不错配给别的请求（F-54：一条连接只发一个请求的旧假设已作废）。
            return;
        }
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ ms: Date.now() - p.t0, msg: m });
        this._armIdle();
    }
    /** 断开并按 kind 结算所有挂起请求（幂等）。 */
    destroy(kind = 'closed', error = 'connection closed') {
        this.closed = true;
        this._clearIdle();
        if (this.ready !== null)
            this.ready = null;
        const sock = this.sock;
        this.sock = null;
        if (sock !== null && !sock.destroyed) {
            try {
                sock.destroy();
            }
            catch {
                /* ignore */
            }
        }
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.resolve({ ms: Date.now() - p.t0, ok: false, kind, error });
        }
        this.pending.clear();
        if (pools.get(this.key) === this)
            pools.delete(this.key);
    }
    /**
     * 一次请求（含 hello 握手，只在需要时发生）。
     * @returns 与旧 `tcpCall` 同形：拿到回包 ⇒ `{ms, msg}`；传输失败 ⇒ `{ms, ok:false, kind, error}`。
     */
    async call(req, timeoutMs) {
        const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
        try {
            await this._connect(Math.min(budget, 3000));
        }
        catch (e) {
            return { ms: 0, ok: false, kind: e?.code === 'ECONNREFUSED' ? 'refused' : 'error', error: e?.message ?? String(e) };
        }
        const id = this.nextId++;
        return new Promise((resolve) => {
            const t0 = Date.now();
            const timer = setTimeout(() => {
                this.pending.delete(id);
                stats.dropped += 1;
                // 超时 ⇒ 协议状态不可信：断开重连，别让迟到回包错配。
                this.destroy('timeout', `no reply within ${budget}ms`);
                resolve({ ms: Date.now() - t0, ok: false, kind: 'timeout', error: `no reply within ${budget}ms` });
            }, budget);
            timer.unref?.();
            this.pending.set(id, { t0, timer, resolve });
            this._clearIdle();
            try {
                this.sock.write(`${JSON.stringify({ ...req, id })}\n`);
            }
            catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                resolve({ ms: Date.now() - t0, ok: false, kind: 'closed', error: e?.message ?? String(e) });
            }
        });
    }
    /** 一条连接上一次 batch 帧（多条只读 fs 调用）。 */
    async callBatch(calls, timeoutMs) {
        const r = await this.call({ op: 'fs', method: 'batch', args: { calls } }, timeoutMs);
        if (r.msg !== undefined && r.msg?.ok === false && /unknown fs method/i.test(String(r.msg?.error ?? ''))) {
            // 旧守护（协议 < 5）：粘住，交给调用方逐条发。
            this.batchUnsupported = true;
        }
        return r;
    }
}
/**
 * 池化调用：与 `callDaemon` 同形（同参同返回），只是复用连接。
 *
 * @param _cfg - 插件配置（本层不需要，保留与 `callDaemon` 一致的签名）
 * @param options.port / token / req / timeoutMs - 目标守护与请求
 */
export async function pooledCall(_cfg, { port, token, req, timeoutMs }) {
    const key = poolKey(port, token);
    let conn = pools.get(key);
    // 只换掉**真死**的连接：正在握手（ready !== null）的连接必须复用，否则并发调用会各建一条
    // （那就退回旧行为，批量也就没意义了）。
    if (conn === undefined || (conn.closed === true && conn.ready === null)) {
        conn = new Conn('127.0.0.1', port, token);
        pools.set(key, conn);
    }
    else {
        stats.reused += 1;
    }
    const r = await conn.call(req, timeoutMs);
    return { ...r, batchUnsupported: conn.batchUnsupported === true };
}
/**
 * 池化 batch：一次请求带走多条只读 fs 调用。
 * @returns `{ms, msg}`（`msg.result.results` 逐条成败）或传输失败形状；`batchUnsupported` 表示该守护不支持。
 */
export async function pooledCallBatch(_cfg, { port, token, calls, timeoutMs }) {
    const key = poolKey(port, token);
    let conn = pools.get(key);
    if (conn === undefined || (conn.closed === true && conn.ready === null)) {
        conn = new Conn('127.0.0.1', port, token);
        pools.set(key, conn);
    }
    else {
        stats.reused += 1;
    }
    if (conn.batchUnsupported === true)
        return { ms: 0, ok: false, kind: 'unsupported', error: 'daemon does not support fs batch', batchUnsupported: true };
    const r = await conn.callBatch(calls, timeoutMs);
    if (r.msg !== undefined) {
        stats.batched += calls.length;
        stats.batchSaved += Math.max(0, calls.length - 1);
    }
    return { ...r, batchUnsupported: conn.batchUnsupported === true };
}
