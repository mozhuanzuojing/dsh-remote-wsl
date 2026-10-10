/**
 * sdk-runtime.ts —— 在 WSL 内按 key 持有一个 dsh SDK 运行时的最小客户端。
 *
 * 这不是新协议：它就是 `dsh-remote-wsl` 的 lib/index.js `SdkRuntime` 抽出的一条腿，
 * 差别只有一个 —— **运行时的持有者从"Windows 宿主进程"变成"WSL 侧常驻守护进程"**，
 * 于是"客户端断开"不再等于"运行时消失"。这是本 spike 要验证的全部内容。
 *
 * 固化进来的三条实测教训（与 lib/index.js 同源，此处不重新推导）：
 *  1. 非登录 shell 的 PATH 不含 `~/.local/bin`（mise 装在那里）⇒ 子进程 env 里显式补；
 *  2. 事件流尾帧可能没有 `\n` 结尾 ⇒ 静止窗口触发时先把残余缓冲当一帧 flush，再判完成；
 *  3. 主机代理先探测再使用（`/dev/tcp` 等价物 = 一次 3s TCP 连接尝试）⇒ 不可用就直连，
 *     硬 export 会让所有模型调用以 TRANSPORT 失败。
 *
 * 迁移说明（.mjs → .ts，零构建）：本文件只加**可擦除**类型（type/interface/注解/as/!），
 * 不引入 enum / namespace / 装饰器 —— Node 原生 type stripping 直接跑源码，无 tsc、无 dist。
 * 相对导入必须带 `.ts` 扩展名（Node 的解析规则，不是风格偏好）。
 *
 * @module spike/sdk-runtime
 */
import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

/** pnpm 拦截未审批的 lifecycle scripts；dsh 依赖的 native 包必须显式放行（同 lib/index.js）。 */
export const ALLOW_BUILDS: string[] = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
];

export const allowBuildFlags = (): string => ALLOW_BUILDS.map((p) => `--allow-build=${p}`).join(' ');

// ────────────────────────────────────────────────────────────────────────────
// 类型：JSON-RPC 帧 / SDK 事件 / 运行时选项与结果
// 全部用 interface + 可选字段描述"线上真实形状"，不做过度建模 —— 这些帧来自外部进程，
// 谁也不能保证字段齐全，可选字段 + 运行时判空才是与实现一致的写法。
// ────────────────────────────────────────────────────────────────────────────

/** 子进程 env 的形状（不引 @types/node 的 ProcessEnv，保持本文件可独立阅读）。 */
export type Env = Record<string, string | undefined>;

/** 日志口子：诊断一律走它（daemon 把它接到 stderr），默认空实现。 */
export type LogFn = (...a: unknown[]) => void;

/** setTimeout 句柄类型：用 ReturnType 取，避免依赖 @types/node 的 NodeJS.Timeout。 */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** spawn 的返回类型：同上，用 ReturnType 而不是 @types/node 的 ChildProcess。 */
export type SpawnedChild = ReturnType<typeof spawn>;

/** JSON-RPC 2.0 **请求**帧（本模块只发请求，不发通知）。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 错误对象（`-32603` 就是从这里冒出来的）。 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * 入站一帧的**宽松**形状：响应帧有 id 无 method，通知帧有 method 无 id。
 * 为什么用"可选字段"而不是联合类型：route() 里做的正是运行时分派
 * （`id !== undefined && method === undefined`），联合类型会逼出一堆只为取悦编译器的收窄代码，
 * 反而容易把原来的判空顺序改错。
 */
export interface JsonRpcFrame {
  jsonrpc?: '2.0';
  id?: number;
  method?: string;
  params?: {
    sessionId?: string;
    event?: SessionEvent;
    status?: string;
  };
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * SDK 事件的最小形状：本 spike 只用到两件事 ——
 *  `type`（判 assistant/message 与 turn/end），以及 assistant/message 里 content 的 text 块。
 * 不把整个 SDK 事件类型搬进来：那是上游契约，抄一份只会随上游漂移。
 */
export interface SessionEvent {
  type?: string;
  data?: {
    message?: {
      content?: Array<{ type?: string; text?: string }>;
    };
  };
}

/** 一轮 prompt 的完成判据来源（三级兜底 + 超时）。 */
export type CompletedBy = 'turn/end' | 'idle' | 'quiet' | 'quiet-after-grace' | 'timeout';

/** `prompt()` 的返回结构：daemon 直接把它摊平进 DaemonResponse。 */
export interface PromptResult {
  /** 最后一条 assistant/message 的纯文本（reasoning 块已丢弃）。 */
  text: string;
  completedBy: CompletedBy;
  sessionId: string;
  /** 本运行时已完成的轮数（跨进程累加，是"没换运行时"的硬证据）。 */
  turns: number;
  /** 运行时进程链根 PID；未起为 null。 */
  runtimePid: number | null;
  eventCount: number;
  stderrTail: string;
}

/** `close()` 的结果：要么本来就关着，要么带上最终退出码。 */
export interface CloseResult {
  alreadyClosed?: boolean;
  /** undefined = 没等到退出（可能已被 SIGKILL/被 idle 回收）；null = 被信号杀死。 */
  exitCode?: number | null;
}

/** `new SdkRuntime({...})` 的入参。默认值全部保留在构造函数解构里，这里只描述形状。 */
export interface SdkRuntimeOptions {
  key: string;
  version?: string;
  cwd?: string;
  profile?: string;
  provider?: string;
  model?: string;
  proxyPort?: number;
  promptTimeoutMs?: number;
  quietMs?: number;
  /** 静止窗口"没见到 assistant 文本"时的宽限再等时长（三级兜底的第三级）。 */
  graceMs?: number;
  /** 由**客户端**指定；不传则 `remote-wsl-<key>-<uuid>`。 */
  sessionId?: string;
  log?: LogFn;
  /** 每一帧原始 NDJSON 都会先过这里（repro-conflict 用它打印证据）。 */
  onFrame?: (line: string) => void;
}

/** `buildRuntimeEnv({...})` 的入参。 */
export interface BuildRuntimeEnvOptions {
  home?: string;
  proxyPort?: number;
  log?: LogFn;
}

/** pending 表里的一项：把 JSON-RPC 响应交回对应的 request() promise。 */
interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** WSL 侧家目录：wsl.exe 会把 Windows 的 HOME 漏进来（实测 `HOME=C:Usersl`），故不信任 env。 */
export function homeDir(): string {
  const h = process.env.HOME;
  if (!h || h.includes(':') || h.includes('\\')) return '/home/g';
  return h;
}

/** 单引号转义，供 `bash -c` 里安全内联路径。 */
export function shq(s: unknown): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function defaultGateway(): string {
  try {
    return execSync(`ip route show default 2>/dev/null | awk '{print $3; exit}'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** 3s 内能否连上 host:port —— 对应 lib/index.js 的 `timeout 3 bash -c "exec 3<>/dev/tcp/…"`。 */
export function probeTcp(host: string, port: number, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const s = net.connect({ host, port });
    const done = (v: boolean): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/**
 * 构造运行时的 env：PATH 补丁 + 代理先探测再使用。
 * 凭据**不**进 env —— 走 `~/.dsh/.credentials.yaml` 的 credentials seam（不 export、不复制任何 key）。
 */
export async function buildRuntimeEnv({
  home = homeDir(),
  proxyPort = 9910,
  log = () => {},
}: BuildRuntimeEnvOptions = {}): Promise<Env> {
  const env: Env = {
    ...process.env,
    PATH: `${home}/.local/bin:${home}/.local/share/mise/shims:${process.env.PATH ?? ''}`,
  };
  const gw = defaultGateway();
  const usable = await probeTcp(gw, proxyPort);
  if (usable) {
    env.NODE_USE_ENV_PROXY = '1';
    env.HTTPS_PROXY = `http://${gw}:${proxyPort}`;
    env.HTTP_PROXY = `http://${gw}:${proxyPort}`;
    log(`proxy ${gw}:${proxyPort} reachable -> via proxy`);
  } else {
    log(`host proxy ${gw || '?'}:${proxyPort} unreachable -> direct`);
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  return env;
}

/** 从 `assistant/message` 事件里取纯文本（reasoning 块必须丢掉，否则答案里会混思维链）。 */
export function textOfAssistantEvent(ev: SessionEvent | null | undefined): string {
  const blocks = ev?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/**
 * 一个常驻的 WSL dsh SDK 运行时。**一个运行时一个 sessionId**：
 * 跨进程复用同一 id 被服务端拒绝（`-32603 session "…" already exists`，见 repro-conflict.ts 实测），
 * 所以"多轮上下文"只能靠**不换运行时**来实现 —— 正是守护进程存在的理由。
 */
export class SdkRuntime {
  // 字段声明只为类型可读性：type stripping 后它们退化成 `key;` 这样的空字段声明，
  // 而构造函数/start() 一定会重新赋值，故运行时行为与不声明字段完全一致。
  key: string;
  version: string;
  cwd: string;
  profile: string;
  provider: string;
  model: string;
  proxyPort: number;
  promptTimeoutMs: number;
  quietMs: number;
  graceMs: number;
  log: LogFn;
  onFrame: (line: string) => void;
  sessionId: string;
  pending: Map<number, PendingEntry>;
  nextId: number;
  buf: string;
  events: SessionEvent[];
  stderrTail: string;
  closed: boolean;
  /** prompt 串行队列：同一个运行时内可反复调用，但同一时刻只跑一轮。 */
  queue: Promise<unknown>;
  turns: number;
  startedAt: number | null;
  /**
   * undefined = 还没退出；number = 正常退出码；**null = 被信号杀死**。
   * null 必须与 undefined 区分开：上游靠 `exitCode !== undefined` 判"运行时没了"，
   * 把 null 归一成 undefined 会让被 kill 的运行时被当成还活着（迁移时踩过一次）。
   */
  exitCode: number | null | undefined;
  child?: SpawnedChild;
  /** spawn 后立刻挂上的 exit promise，close() 与 ARM 逻辑都靠它等退出。 */
  exited?: Promise<number | null>;
  sawAssistant?: boolean;
  completedBy?: CompletedBy | null;
  statusRunning?: boolean;
  graceUsed?: boolean;
  quietTimer?: TimerHandle;
  turnDone?: Promise<void>;
  resolveTurn?: () => void;

  constructor({
    key,
    version = '0.2.0-rc.2',
    cwd = '/home/g',
    profile = 'sdk',
    provider = 'deepseek-official',
    model = 'deepseek-flash',
    proxyPort = 9910,
    promptTimeoutMs = 300000,
    quietMs = 3000,
    graceMs = 20000,
    sessionId,
    log = () => {},
    onFrame = () => {},
    // 保留迁移前的 `= {}` 默认：允许 `new SdkRuntime()` 无参构造（那时 key 为 undefined）。
    // 接口里 key 是必填，所以只把这个**默认值**标注成该类型；`as` 可擦除，type stripping 后就是 `= {}`。
  }: SdkRuntimeOptions = {} as SdkRuntimeOptions) {
    this.key = key;
    this.version = version;
    this.cwd = cwd;
    this.profile = profile;
    this.provider = provider;
    this.model = model;
    this.proxyPort = proxyPort;
    this.promptTimeoutMs = promptTimeoutMs;
    this.quietMs = quietMs;
    this.graceMs = graceMs;
    this.log = log;
    this.onFrame = onFrame;
    // sessionId 由**客户端**指定（initialize 不回 id，实测 result 只有 serverInfo）。
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
  get runtimePid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<this> {
    const env = await buildRuntimeEnv({ proxyPort: this.proxyPort, log: this.log });
    const script = [
      `cd ${shq(this.cwd)} || { echo "remote-wsl-spike: cwd missing: ${this.cwd}" >&2; exit 2; }`,
      `exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} --profile ${this.profile}`,
      '',
    ].join('\n');
    this.log(`spawning runtime key=${this.key} dsh@${this.version} cwd=${this.cwd}`);
    // 用局部 const 持有子进程：this.child 从赋值到 close() 之间不会再被改写，行为等价，
    // 但类型上不必对每个属性访问都写一次非空断言。
    const child = spawn('/bin/bash', ['-c', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      // detached ⇒ 自成进程组：回收时 kill(-pid) 连带 pnpm/node 全树，
      // 这正是 lib/index.js 里"wsl.exe 包装层被杀、Linux 侧进程变孤儿"那个坑的解。
      detached: true,
    });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.on('error', (e) => {
      this.closed = true;
      this.log(`runtime spawn error: ${e.message}`);
    });
    child.stdout!.on('data', (c: string) => this.pump(c));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      this.stderrTail = (this.stderrTail + c).slice(-4000);
    });
    this.exited = new Promise((res) => child.once('exit', (code) => {
      this.exitCode = code;
      res(code);
    }));
    await this.request('initialize', { cwd: this.cwd, provider: this.provider, model: this.model }, 120000);
    this.startedAt = Date.now();
    this.log(`runtime ready key=${this.key} pid=${this.runtimePid} session=${this.sessionId}`);
    return this;
  }

  request(method: string, params: unknown, timeoutMs: number = this.promptTimeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('runtime closed'));
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    try {
      this.child!.stdin!.write(JSON.stringify(frame) + '\n');
    } catch (e) {
      return Promise.reject(new Error(`stdin write failed: ${(e as Error).message}`));
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

  pump(chunk: string): void {
    this.buf += chunk;
    this.drain();
  }

  drain(): void {
    let nl: number;
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
  flushPartial(): void {
    if (!this.buf.trim()) return;
    this.buf += '\n';
    this.drain();
  }

  route(line: string): void {
    let msg: JsonRpcFrame;
    try {
      msg = JSON.parse(line) as JsonRpcFrame;
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
      this.events.push(ev as SessionEvent);
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
  armQuiet(): void {
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
  prompt(text: string): Promise<PromptResult> {
    const run = this.queue.then(() => this.#prompt(text));
    this.queue = run.catch(() => {});
    return run;
  }

  async #prompt(text: string): Promise<PromptResult> {
    if (this.closed) throw new Error('runtime closed');
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
    return {
      text: finalText,
      completedBy: this.completedBy ?? 'timeout',
      sessionId: this.sessionId,
      turns: this.turns,
      runtimePid: this.runtimePid,
      eventCount: this.events.length,
      stderrTail: this.stderrTail.slice(-500),
    };
  }

  async close(): Promise<CloseResult> {
    if (this.closed) return { alreadyClosed: true };
    this.closed = true;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    try {
      await this.request('shutdown', undefined, 3000);
    } catch {
      /* 运行时可能已经走了 */
    }
    try {
      this.child?.stdin?.end();
    } catch {
      /* ignore */
    }
    await Promise.race([this.exited, sleep(3000)]);
    // 关键：杀**进程组**，不是只杀包装层（否则 pnpm/node 变孤儿继续跑、还抢模型配额）
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      let alive = this.exitCode === undefined;
      if (!alive) break;
      try {
        process.kill(-(this.child!.pid as number), sig);
      } catch {
        /* ESRCH = 已经退了 */
      }
      await Promise.race([this.exited, sleep(2000)]);
      alive = this.exitCode === undefined;
      if (!alive) break;
    }
    return { exitCode: this.exitCode };
  }
}
