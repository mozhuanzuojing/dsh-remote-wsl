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
 * ── 单一实现（架构债 T1，task-34）─────────────────────────────────────────────
 *
 * **`src/` 里 `SdkRuntime` 这个类只有这一份定义。** 两个调用方共用它，靠 `adapter` 描述差异：
 *  · **守护形态**（`daemon.ts`，默认 = `RUNTIME_PROFILE_DAEMON`，即抽取前的逐字行为）：
 *    在 **WSL 内** `spawn('/bin/bash', ['-c', script], { detached: true })`，`env` 由守护注入；
 *    `close()` 杀**进程组**；`prompt()` 空正文时回报 `retryable`（语义 #6：绝不为了拿正文去换 sessionId）。
 *  · **宿主形态**（`index.ts` 的 `backend='in-host'` 逃生舱）：脚本由宿主拼（登录 shell env + `.pid`）、
 *    落 `/tmp` 后 `spawn('wsl.exe', …)`；`close()` 杀包装层 + 回调 `reapWsl`；空正文时走
 *    `fallbackText`（读持久化日志）并带 `idleTimeoutMs` 自回收。
 *
 * 差异**全部**在 adapter 里（消息文案 / 超时 / 尾巴长度 / 结果投影 / 关停方式 / 启动方式），
 * 类里没有一个 `if (mode === …)` 的特判散在各处 —— 这样"唯一实现"不是靠复制粘贴维持的。
 *
 * @module dsh-remote-wsl/sdk-runtime
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cdPreamble, shq } from './shell-quote.ts';

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

/**
 * 单引号转义，供 `bash -c` 里安全内联路径。
 *
 * 2026-10-27 审查 F-08：实现移到 `shell-quote.ts`（与 `cdPreamble`/`killIfOwnedScript` 同源），
 * 这里保留同名 re-export，既有 import（in-host-runtime / register-tools）不用改。
 */
export { shq };

/** 从 `assistant/message` 事件里取纯文本（reasoning 块必须丢掉，否则答案里会混思维链）。 */
export function textOfAssistantEvent(ev) {
  const blocks = ev?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 守护形态的运行时描述（**默认值 = 抽取前的逐字行为**）。
 * 宿主形态用 `runtimeAdapter({ … })` 覆盖它，只为"两处调用方都能保持自己原有的对外形状"。
 */
export const RUNTIME_PROFILE_DAEMON = {
  label: 'daemon',
  /** `stderrTail` 保留长度（守护回报里带这个字段；宿主形态不回报）。 */
  stderrTailLimit: 4000,
  /** `initialize` 的超时。 */
  initTimeoutMs: 120000,
  /** `stdin.write` 是否包 try/catch（守护形态包 ⇒ 失败变 rejected promise；宿主形态原来不包）。 */
  guardStdinWrite: true,
  /** spawn 失败时是否打日志（宿主形态原来只置 closed）。 */
  logSpawnError: true,
  /** 判定 `sawAssistant` 时是否要求正文非空（守护形态要求；宿主形态只看事件类型）。 */
  sawAssistantRequiresText: true,
  /** `prompt()` 的入口检查是否连"进程已死"一起拒（守护形态是；宿主形态原来只看 `closed`）。 */
  requireAliveOnPrompt: true,
  /** 静止窗口结束时要写的 `completedBy` 标签；null = 不写（宿主形态原来不写）。 */
  quietLabels: { quiet: 'quiet', grace: 'quiet-after-grace' },
  /** 空正文时的兜底：`retryable`（守护）或 `close-read-log`（宿主：停稳运行时 + 读持久化日志）。 */
  fallbackMode: 'retryable',
  /** `prompt()` 的返回形状投影：`daemon` / `host`（两者都已经被各自的调用方与文档固化）。 */
  resultProfile: 'daemon',
  /** 关停方式：`process-group`（守护：`kill(-pid)` 连带 pnpm/node）或 `wrapper`（宿主：杀 wsl.exe + 回调）。 */
  killMode: 'process-group',
  /** `close()` 的返回值：`exitCode`（守护）或 `void`（宿主）。 */
  closeResult: 'exitCode',
  /** 启动脚本构造（宿主形态必填：要拼登录 shell env 前缀与 `.pid` 行）。null = 用内置脚本。 */
  scriptFor: null,
  /** 起进程（宿主形态必填：落 `/tmp` 脚本 + `spawn('wsl.exe', …)`）。 */
  spawnRuntime: null,
  /** 关停尾巴（宿主形态：`reapWsl` + 删脚本）。 */
  closeHook: null,
  /** 空闲自回收（宿主形态：`cfg.idleTimeoutMs`）；0 = 不做。 */
  idleTimeoutMs: 0,
  /**
   * 一轮 `session/prompt` 被**上游拒绝**（JSON-RPC error / 写 stdin 失败）时，是否顺手把运行时关掉。
   * 守护形态保持 `false`：语义 #6 只要求"空正文不换 sessionId"，一次请求失败不该牺牲已有上下文。
   * 宿主逃生舱在 `runtimeAdapter()` 里默认 `true` —— 它自己的文档语义本就是"放弃一轮 = 关掉运行时"。
   */
  closeOnPromptError: false,
  /** 文案。 */
  text: {
    requestClosed: () => 'runtime closed',
    promptClosed: () => 'runtime closed',
    stdinWriteFailed: (m) => `stdin write failed: ${m}`,
    requestTimeout: (method, ms) => `${method} timeout after ${ms}ms`,
    spawnError: (key, m) => `runtime spawn error key=${key}: ${m}`,
    /** 进程在 `initialize` 完成前就退出（非零退出 / 坏 cwd 等）——必须带 exitCode 与 stderr 尾巴上行。 */
    startExited: (code, tail) => `runtime exited during initialize (exit=${code})${tail ? `: ${tail}` : ''}`,
    noText: null,
  },
};

/** 以守护形态为底座做浅覆盖（`text` / `quietLabels` 逐键合并，避免调用方写全量）。 */
export const runtimeAdapter = (overrides = {}) => ({
  ...RUNTIME_PROFILE_DAEMON,
  // 宿主逃生舱的默认：一轮被上游拒绝 ⇒ 关掉运行时（它的兜底路径本来就是"停稳运行时再读日志"）。
  // 守护形态不受影响（`RUNTIME_PROFILE_DAEMON.closeOnPromptError === false`）。
  closeOnPromptError: true,
  ...overrides,
  quietLabels: { ...RUNTIME_PROFILE_DAEMON.quietLabels, ...(overrides.quietLabels ?? {}) },
  text: { ...RUNTIME_PROFILE_DAEMON.text, ...(overrides.text ?? {}) },
});

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
    /** 运行形态描述（默认守护形态；宿主形态由调用方覆盖，见 `runtimeAdapter`）。 */
    adapter = RUNTIME_PROFILE_DAEMON,
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
    this.ad = adapter;
    this.fallbackText = fallbackText;
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
    /** spawn 的 `'error'`（ENOENT / EACCES…）——用来把真实原因回抛，而不是伪装成 `initialize 超时`。 */
    this.spawnError = null;
    /** 上一轮 `session/prompt` 的失败原因（失败后运行时状态不再"看着一切正常"）。 */
    this.lastTurnError = null;
  }

  /** 运行时进程链的根 PID（`bash -c` 里 `exec mise …` ⇒ 这个 pid 就是 mise/pnpm 那层）。 */
  get runtimePid() {
    return this.child?.pid ?? null;
  }

  get alive() {
    return Boolean(this.child) && this.exitCode === undefined && !this.closed;
  }

  /** 守护形态的内置启动脚本（宿主形态由 adapter.scriptFor 提供）。 */
  #defaultScript() {
    return [
      // 2026-10-27 审查 F-08：cwd 走 cdPreamble（单引号转义 + 失败立即 exit 2，不再裸插值）。
      cdPreamble(this.cwd),
      `exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} --profile ${this.profile}`,
      '',
    ].join('\n');
  }

  async start() {
    const script = this.ad.scriptFor ? this.ad.scriptFor({ cwd: this.cwd, version: this.version, profile: this.profile }) : this.#defaultScript();
    this.log(`spawning runtime key=${this.key} dsh@${this.version} cwd=${this.cwd}`);
    // 失败信号：spawn 的 `'error'`（ENOENT/EACCES）与"initialize 期间就退出"（非零退出/坏 cwd）。
    // 这两条以前都没有出口 ⇒ 真实原因被 `initialize 超时` 盖住（F56-1 的一半 / F56-2）。
    let rejectSpawn;
    const spawnFailure = new Promise((_, rej) => { rejectSpawn = rej; });
    spawnFailure.catch(() => {}); // race 若是别的分支先赢，这里绝不能变成 unhandled rejection
    let exitedDuringInit;
    try {
      this.child = this.ad.spawnRuntime
        ? this.ad.spawnRuntime({ script, self: this })
        : spawn('/bin/bash', ['-c', script], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.env,
            // detached ⇒ 自成进程组：回收时 kill(-pid) 连带 pnpm/node 全树，
            // 这正是 lib/index.js 记录的"包装层被杀、Linux 侧进程变孤儿"那个坑的解。
            detached: true,
          });
      this.child.stdout.setEncoding('utf8');
      this.child.on('error', (e) => {
        this.spawnError = e;
        this.closed = true;
        if (this.ad.logSpawnError) this.log(this.ad.text.spawnError(this.key, e.message));
        rejectSpawn(new Error(this.ad.text.spawnError(this.key, e.message)));
      });
      this.child.stdout.on('data', (c) => this.pump(c));
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (c) => {
        this.stderrTail = (this.stderrTail + c).slice(-this.ad.stderrTailLimit);
      });
      this.exited = new Promise((res) => this.child.once('exit', (code) => {
        this.exitCode = code;
        res(code);
      }));
      exitedDuringInit = this.exited.then((code) => {
        throw new Error(this.ad.text.startExited(code, this.stderrTail.slice(-300)));
      });
      exitedDuringInit.catch(() => {}); // 起成功之后再退出属于正常关停，不该变成 unhandled
      await Promise.race([
        this.request('initialize', { cwd: this.cwd, provider: this.provider, model: this.model }, this.ad.initTimeoutMs),
        spawnFailure,
        exitedDuringInit,
      ]);
    } catch (e) {
      // 根因修复（F56-1 / F56-3）：**启动失败必须收尾并收敛状态**。
      // 以前 spawn 失败只置 `closed`，而 `close()` 见 `closed` 就 early-return ⇒ closeHook
      // （宿主形态 = `reapWsl` + `removeScript`）从不执行 ⇒ `/tmp/dsh-rwsl-*.sh` 永久残留；
      // 且 `closed` 的语义在此被"混用"，池的复用判据 `!existing.closed` 也拦不住别的失败形态。
      await this.#abortStart();
      throw e;
    }
    this.startedAt = Date.now();
    this.log(`runtime ready key=${this.key} pid=${this.runtimePid} session=${this.sessionId}`);
    return this;
  }

  /**
   * 启动失败的**统一收尾**（幂等、绝不抛）：
   *  · 状态收敛：`closed = true` ⇒ ① 后续 `prompt()`/`request()` 走"已关闭"的**友好文案**（不再是裸
   *    `TypeError: … undefined (reading 'stdin')`）；② 运行时池的复用判据 `!existing.closed` 生效
   *    ⇒ **坏运行时会自然被驱逐、同 key 重取会重建**（F56-3，不需要改池）。
   *  · 资源回收：关 stdin、杀包装层/进程组、跑 adapter 的 `closeHook`（宿主形态 = `reapWsl` +
   *    `removeScript` ⇒ `/tmp/dsh-rwsl-*.sh` 不再残留，F56-1）；也顺带把 WSL 侧已起的进程收掉。
   */
  async #abortStart() {
    this.closed = true;
    const child = this.child;
    try { child?.stdin?.end(); } catch { /* ignore */ }
    try { if (child?.pid) child.kill(); } catch { /* 已退出 */ }
    if (child?.pid && this.ad.killMode === 'process-group') {
      // 关键：杀**进程组**（守护形态 bash 是 detached 的组长），只杀包装层会留孤儿
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ESRCH = 已经退了 */ }
    }
    try { await this.ad.closeHook?.({ self: this }); } catch { /* 回收失败也要把真实错误抛给调用方 */ }
  }

  request(method, params, timeoutMs = this.promptTimeoutMs) {
    if (this.closed) return Promise.reject(new Error(this.ad.text.requestClosed()));
    const id = this.nextId++;
    if (this.ad.guardStdinWrite) {
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        return Promise.reject(new Error(this.ad.text.stdinWriteFailed(e.message)));
      }
    } else {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.ad.text.requestTimeout(method, timeoutMs)));
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
      const hasText = this.ad.sawAssistantRequiresText ? textOfAssistantEvent(ev).trim() : true;
      if (ev?.type === 'assistant/message' && hasText) this.sawAssistant = true;
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
    const { quiet, grace } = this.ad.quietLabels;
    this.quietTimer = setTimeout(() => {
      this.flushPartial(); // 先 flush，再判完成 —— 顺序反了就会丢掉最后一帧
      if (!this.sawAssistant && !this.graceUsed) {
        this.graceUsed = true;
        this.quietTimer = setTimeout(() => {
          this.flushPartial();
          if (grace !== null) this.completedBy = this.completedBy ?? grace;
          this.resolveTurn?.();
        }, this.graceMs);
        return;
      }
      if (quiet !== null) this.completedBy = this.completedBy ?? quiet;
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
    if (this.closed || (this.ad.requireAliveOnPrompt && !this.alive)) throw new Error(this.ad.text.promptClosed());
    this.events = [];
    this.sawAssistant = false;
    this.completedBy = null;
    this.graceUsed = false;
    this.statusRunning = false;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.turnDone = new Promise((res) => {
      this.resolveTurn = res;
    });
    try {
      await this.request('session/prompt', {
        sessionId: this.sessionId,
        contentBlocks: [{ type: 'text', text }],
      });
    } catch (e) {
      // F56-4：这一轮被上游**拒绝**（JSON-RPC error / 写 stdin 失败）时，运行时状态不能再"看着一切正常"。
      //  · 记下失败原因（失败后不再假装这一轮没发生）；
      //  · 宿主逃生舱（`runtimeAdapter()` 的默认）按自己的语义"放弃一轮 = 关掉运行时"收尾 ⇒ `closed=true`，
      //    状态与实际一致；
      //  · 守护形态保持不动（语义 #6：不因为一次失败就去换 sessionId、丢上下文）——由 caller 决定重试或丢弃。
      this.lastTurnError = e?.message ?? String(e);
      if (this.ad.closeOnPromptError) { try { await this.close(); } catch { /* ignore */ } }
      throw e;
    }
    this.armQuiet();
    await Promise.race([this.turnDone, sleep(this.promptTimeoutMs)]);
    if (this.quietTimer) clearTimeout(this.quietTimer);

    const msgs = this.events.filter((e) => e?.type === 'assistant/message');
    let finalText = msgs.length ? textOfAssistantEvent(msgs[msgs.length - 1]) : '';
    if (!finalText.trim() && this.ad.fallbackMode === 'close-read-log') {
      // 宿主逃生舱：事件流缺正文 ⇒ 只能停稳运行时（换新 id 重来），再从持久化日志取回
      await this.close();
      finalText = (await this.fallbackText?.({ sessionId: this.sessionId, cwd: this.cwd })) ?? '';
      if (!finalText.trim() && this.ad.text.noText) throw new Error(this.ad.text.noText);
      if (finalText.trim()) this.completedBy = 'log-fallback';
    }
    this.turns += 1;
    if (this.ad.idleTimeoutMs > 0) this.armIdle();
    if (this.ad.resultProfile === 'host') {
      return {
        text: finalText,
        completedBy: this.completedBy ?? 'quiet',
        sessionId: this.sessionId,
        turn: this.turns,
        eventCount: this.events.length,
        runtimeRestarted: this.closed,
      };
    }
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

  /** 宿主逃生舱的空闲自回收（守护形态由守护的 idle 闸门负责，这里不装定时器）。 */
  armIdle() {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, this.ad.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async close() {
    if (this.closed) {
      return this.ad.closeResult === 'void' ? undefined : { alreadyClosed: true, exitCode: this.exitCode, exited: this.exitCode !== undefined };
    }
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // ⚠️ 顺序是**语义**的一部分（F56-5，T62 修）：以前先 `this.closed = true` 再 `request('shutdown')`，
    // 而 `request()` 见 `closed` 立刻 reject ⇒ **这条优雅关闭从来没发出去过**（每一步都静默走 kill 路径）。
    try {
      await this.request('shutdown', undefined, 3000);
    } catch {
      /* 运行时可能已经走了 */
    }
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    await Promise.race([this.exited, sleep(3000)]);
    if (this.ad.killMode === 'wrapper') {
      // 宿主形态：child 是 Windows 侧的 wsl.exe 包装层，杀它的进程组没有意义（也不是我们想杀的）
      try {
        this.child.kill();
      } catch {
        /* 已退出 */
      }
      await this.ad.closeHook?.({ self: this });
      return this.ad.closeResult === 'void' ? undefined : { exitCode: this.exitCode, exited: this.exitCode !== undefined };
    }
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
    // F56-4：`exitCode: null` 以前无法区分"正常退出码为空"与"3 秒内没等到退出"⇒ 补一个显式 `exited`。
    return { exitCode: this.exitCode, exited: this.exitCode !== undefined };
  }
}
