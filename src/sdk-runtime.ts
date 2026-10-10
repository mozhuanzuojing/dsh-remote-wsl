/**
 * dsh-remote-wsl / sdk-runtime —— 一个常驻 WSL dsh SDK 运行时的 stdio JSON-RPC 客户端。
 *
 * 这份实现就是 `lib/index.js` 里原 `SdkRuntime` 的抽取版（行为不变），多出来的一件事是：
 * **env 由调用方注入**（守护在启动时只捕获/构造一次登录 shell 环境，然后给每个运行时复用），
 * 对位语义 #9「环境注入只做一次」。
 *
 * 固化进来的三条实测教训（与 lib/index.js 同源，此处不重新推导）：
 *  1. 非登录 shell 的 PATH 不含 `~/.local/bin`（mise 装在那里）⇒ 由调用方在 env 里补；
 *  2. 事件流尾帧可能没有 `\n` 结尾 ⇒ 静止窗口触发时先把残余缓冲当一帧 flush，再判完成；
 *  3. 主机代理先探测再使用 ⇒ 由守护启动时探测一次并把结果放进 env。
 *
 * 协议事实（2026-10-10 实测，spike 与 task-2 双重复现）：
 *  · `initialize` 只回 `{serverInfo}`，**不回 sessionId** —— sessionId 由客户端指定；
 *  · `session/prompt` 只回 `{messageId}`，**无 per-prompt 结果** ⇒ 完成判定必须客户端自定；
 *  · **无 cancel / 无 session-close**；放弃一轮 = 关掉运行时；
 *  · 跨进程复用同一 sessionId 被上游拒绝（`-32603 session "…" already exists`，且落盘占用
 *    在持有者消失后依然存在）⇒ 多轮只能发生在**同一个常驻运行时**内。
 *
 * @module dsh-remote-wsl/sdk-runtime
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** pnpm 拦截未审批的 lifecycle scripts；dsh 依赖的 native 包必须显式放行。 */
export const ALLOW_BUILDS = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
];

export const allowBuildFlags = () => ALLOW_BUILDS.map((p) => `--allow-build=${p}`).join(' ');

/** 单引号转义，供 `bash -c` 里安全内联路径。 */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 从 `assistant/message` 事件里取纯文本（reasoning 块必须丢掉，否则答案里会混思维链）。 */
export function textOfAssistantEvent(ev) {
  const blocks = ev?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

export class SdkRuntime {
  constructor({
    key,
    version,
    cwd,
    profile = 'sdk',
    provider = 'deepseek-official',
    model = 'deepseek-flash',
    promptTimeoutMs = 300000,
    quietMs = 3000,
    graceMs = 20000,
    sessionId,
    env,
    log = () => {},
    onFrame = () => {},
    /**
     * 可选的"没有正文"兜底（**只给 backend='in-host' 的逃生舱**用）。
     * 守护侧不传：语义 #6 禁止"停稳运行时 + 读 zstd 日志换新 sessionId"（会毁掉上下文）。
     * 传了就要自己负责副作用（旧实现是 close 运行时再读日志），返回值 `{text, completedBy}` 或 null。
     */
    fallbackText = null,
  } = {}) {
    this.key = key;
    this.version = version;
    this.cwd = cwd;
    this.profile = profile;
    this.provider = provider;
    this.model = model;
    this.promptTimeoutMs = promptTimeoutMs;
    this.quietMs = quietMs;
    this.graceMs = graceMs;
    this.env = env ?? process.env;
    this.log = log;
    this.onFrame = onFrame;
    this.sessionId = sessionId ?? `remote-wsl-${key}-${randomUUID()}`;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.events = [];
    this.stderrTail = '';
    this.closed = false;
    this.queue = Promise.resolve();
    this.turns = 0;
    this.startedAt = null;
    this.exitCode = undefined;
  }

  /** 运行时进程链的根 PID（`bash -c` 里 `exec mise …` ⇒ 这个 pid 就是 mise/pnpm 那层）。 */
  get runtimePid() {
    return this.child?.pid ?? null;
  }

  get alive() {
    return Boolean(this.child) && this.exitCode === undefined && !this.closed;
  }

  async start() {
    const script = [
      `cd ${shq(this.cwd)} || { echo "remote-wsl: cwd 不存在: ${this.cwd}" >&2; exit 2; }`,
      `exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} --profile ${this.profile}`,
      '',
    ].join('\n');
    this.log(`spawning runtime key=${this.key} dsh@${this.version} cwd=${this.cwd}`);
    this.child = spawn('/bin/bash', ['-c', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      // detached ⇒ 自成进程组：回收时 kill(-pid) 连带 pnpm/node 全树，
      // 这正是 lib/index.js 记录的"包装层被杀、Linux 侧进程变孤儿"那个坑的解。
      detached: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.on('error', (e) => {
      this.closed = true;
      this.log(`runtime spawn error key=${this.key}: ${e.message}`);
    });
    this.child.stdout.on('data', (c) => this.pump(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c).slice(-4000);
    });
    this.exited = new Promise((res) => this.child.once('exit', (code) => {
      this.exitCode = code;
      res(code);
    }));
    await this.request('initialize', { cwd: this.cwd, provider: this.provider, model: this.model }, 120000);
    this.startedAt = Date.now();
    this.log(`runtime ready key=${this.key} pid=${this.runtimePid} session=${this.sessionId}`);
    return this;
  }

  request(method, params, timeoutMs = this.promptTimeoutMs) {
    if (this.closed) return Promise.reject(new Error('runtime closed'));
    const id = this.nextId++;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
      return Promise.reject(new Error(`stdin write failed: ${e.message}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  pump(chunk) {
    this.buf += chunk;
    this.drain();
  }

  drain() {
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) {
        this.onFrame(line);
        this.route(line);
      }
    }
  }

  /** 坑②：尾帧可能没有换行结尾 ⇒ 静止时把残余缓冲当一帧处理，否则完成信号永远等不到。 */
  flushPartial() {
    if (!this.buf.trim()) return;
    this.buf += '\n';
    this.drain();
  }

  route(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行（pnpm 的横幅等）忽略
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'session.event' && msg.params?.sessionId === this.sessionId) {
      const ev = msg.params.event;
      this.events.push(ev);
      if (ev?.type === 'assistant/message' && textOfAssistantEvent(ev).trim()) this.sawAssistant = true;
      if (ev?.type === 'turn/end') {
        this.completedBy = this.completedBy ?? 'turn/end';
        this.resolveTurn?.();
      } else {
        this.armQuiet();
      }
      return;
    }
    if (msg.method === 'session.status' && msg.params?.sessionId === this.sessionId) {
      if (msg.params.status === 'running') this.statusRunning = true;
      if (msg.params.status === 'idle' && this.statusRunning) {
        this.completedBy = this.completedBy ?? 'idle';
        this.resolveTurn?.();
      }
    }
  }

  /** 静止窗口：上游无 per-prompt 结果，只能客户端自己定（三级兜底：turn/end → idle → quiet）。 */
  armQuiet() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.flushPartial(); // 先 flush，再判完成 —— 顺序反了就会丢掉最后一帧
      if (!this.sawAssistant && !this.graceUsed) {
        this.graceUsed = true;
        this.quietTimer = setTimeout(() => {
          this.flushPartial();
          this.completedBy = this.completedBy ?? 'quiet-after-grace';
          this.resolveTurn?.();
        }, this.graceMs);
        return;
      }
      this.completedBy = this.completedBy ?? 'quiet';
      this.resolveTurn?.();
    }, this.quietMs);
  }

  /** 同一运行时内可反复调用（上下文保持）；串行化，失败不阻塞后续轮。 */
  prompt(text) {
    const run = this.queue.then(() => this.#prompt(text));
    this.queue = run.catch(() => {});
    return run;
  }

  async #prompt(text) {
    // SDK 无 cancel：上一轮走到兜底路径后运行时必须重建，否则后续轮会挂死
    if (this.closed || !this.alive) throw new Error('runtime closed');
    this.events = [];
    this.sawAssistant = false;
    this.completedBy = null;
    this.graceUsed = false;
    this.statusRunning = false;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.turnDone = new Promise((res) => {
      this.resolveTurn = res;
    });
    await this.request('session/prompt', {
      sessionId: this.sessionId,
      contentBlocks: [{ type: 'text', text }],
    });
    this.armQuiet();
    await Promise.race([this.turnDone, sleep(this.promptTimeoutMs)]);
    if (this.quietTimer) clearTimeout(this.quietTimer);

    const msgs = this.events.filter((e) => e?.type === 'assistant/message');
    const finalText = msgs.length ? textOfAssistantEvent(msgs[msgs.length - 1]) : '';
    this.turns += 1;
    // 语义 #6：守护形态下**禁止**沿用"停稳运行时 + 读 zstd 日志换新 sessionId"的老兜底
    // （那会毁掉上下文）。这里如实回报"没有正文 + 可重试"，运行时保持不动。
    return {
      text: finalText,
      retryable: !finalText.trim(),
      completedBy: this.completedBy ?? 'timeout',
      sessionId: this.sessionId,
      turns: this.turns,
      runtimePid: this.runtimePid,
      eventCount: this.events.length,
      stderrTail: this.stderrTail.slice(-500),
    };
  }

  async close() {
    if (this.closed) return { alreadyClosed: true, exitCode: this.exitCode };
    this.closed = true;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    try {
      await this.request('shutdown', undefined, 3000);
    } catch {
      /* 运行时可能已经走了 */
    }
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    await Promise.race([this.exited, sleep(3000)]);
    // 关键：杀**进程组**，不是只杀包装层（否则 pnpm/node 变孤儿继续跑、还抢模型配额）
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      if (this.exitCode !== undefined) break;
      try {
        process.kill(-this.child.pid, sig);
      } catch {
        /* ESRCH = 已经退了 */
      }
      await Promise.race([this.exited, sleep(2000)]);
    }
    return { exitCode: this.exitCode };
  }
}
