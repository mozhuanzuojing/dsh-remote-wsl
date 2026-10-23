/**
 * dsh-remote-wsl / lifecycle —— 关停屏障。
 *
 * 参考 zai-org/ZCode 的 Remote Host 释放纪律（docs/wsl-remote-workspace-design.md）。
 * 2026-10-22 对照 `packages/server/src/remote/wsl-backend.ts:427-507` 补齐三段我们原来没有的机制：
 *
 *  · **释放宽限**：ZCode 的 `disposeAndWait()` 先对每个自己 spawn 的 child 做 `stdin.end()`（优雅），
 *    等宽限 `graceTimeoutMs`（默认 300ms）；到点还没退出的**才** `kill()`，kill 后再等
 *    `killWaitTimeoutMs`（默认 250ms）确认退出。我们原来"超时就 kill 且不等退出"——子进程的收尾
 *    （删脚本、落日志）经常被截断。
 *  · **幂等**：ZCode 用 `disposeInFlight` 保证 disposeAndWait 只跑一次；这里 `settle()` 同样缓存
 *    in-flight promise —— index 的 disposer 与关窗/卸载路径可能各调一次，重复调用只执行一遍。
 *  · **归属**：ZCode 的 `ownedChildren` Map 用 `exit`/`error`/`close` **三个事件**都结算；我们原来只认
 *    `exit`，`error`（spawn 失败）时会漏摘，settle 白等满一个超时。
 *  · **晚订阅丢事件**（ZCode `packages/server/src/remote/closeEvent.ts` 的 createCloseEventController）：
 *    子进程可能在调用方订阅 close **之前**就瞬间退出，控制器会把 code 记下来、对晚到的订阅者补发一次。
 *    我们的等价做法更简单：`track()` 当场就建 settled promise（finish 只 resolve 一次），
 *    `settle()` 直接 await 这些 promise ⇒ "快照之后、挂监听之前退出"的窗口根本不存在。
 *
 * 不变的三条底线：
 *  1. `beginShutdown()` 之后拒绝再新建运行时（否则新进程落在快照之外，永远没人回收）；
 *  2. 只跟踪**本插件 spawn 的 wsl.exe 包装层**，settle 超时也只 kill 自己登记的 —— 不按进程名扫；
 *  3. **绝不** `wsl --terminate` / `--shutdown`（发行版级操作，会杀掉用户同一发行版里的其他任务）。
 *
 * 总预算不变：`settle(5000)` 仍然是"最多 5 秒"——宽限与 kill 后等待都从这份预算里扣
 * （宽限 = `min(graceTimeoutMs, timeoutMs)`，kill 后等待 = `min(killWaitTimeoutMs, 剩余预算)`）。
 */

/** 优雅退出宽限期（毫秒）——ZCode `disposeAndWait` 的 `graceTimeoutMs` 默认值 300。 */
export const DEFAULT_GRACE_TIMEOUT_MS = 300;
/** kill 之后确认退出的等待（毫秒）——ZCode 的 `killWaitTimeoutMs` 默认值 250。 */
export const DEFAULT_KILL_WAIT_TIMEOUT_MS = 250;
/** settle 的默认总预算（毫秒）——index.ts 的 disposer 显式传 5000。 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 5000;

/**
 * 进程内的"当前关停屏障"。
 *
 * 为什么是模块级单例（而不是把 lifecycle 一路当形参传下去）：`wsl-io.runWsl()` 的调用点散布在
 * `register-tools / index / daemon-*`（本轮写域之外）——短命子进程要全部纳入 settle，只能在 wsl-io
 * 内部取到同一个屏障。本插件在一个宿主进程里**只有一个** lifecycle（index.ts 的 apply 各建一个），
 * 所以"最新创建的那个"就是"当前那个"。代价：同进程内并存多个插件实例时，只有最新的那份收到短命
 * 子进程登记 —— 这在测试/探针里无害（每个探针自建一份并按需显式 set），真实宿主里不会发生。
 */
let ambientLifecycle = null;

/** 取当前关停屏障（可能为 null：探针/单测直接调 wsl-io 时没有插件实例）。 */
export function activeLifecycle() {
  return ambientLifecycle;
}

/** 显式设置当前关停屏障（探针 / 将来多实例隔离用；传 null 表示摘掉）。 */
export function setAmbientLifecycle(lifecycle) {
  ambientLifecycle = lifecycle ?? null;
  return ambientLifecycle;
}

/**
 * 认领「上一个插件实例遗留的关停屏障」。
 *
 * 为什么需要（2026-10-23 review ⑥）：`ambientLifecycle` 是进程级单例，`createLifecycle()` 会把"当前"
 * 指向新实例；而 `runWsl` 的短命子进程是登记在**创建那一刻**的实例上的。如果宿主做了插件热重载
 * （cordis 重新 apply，而旧实例的 disposer 没跑完/压根没跑），旧实例 spawn 的 wsl.exe 包装层就再也没人
 * 等 —— 新实例的 `settle()` 看不见它们。这里在 apply 时把旧实例显式关停并结算：幂等（旧实例已关停则
 * 直接返回 null），且只作用于**旧实例自己登记的**子进程（仍不按进程名扫、不 terminate 发行版）。
 *
 * @param previous - 上一个实例的 lifecycle（可为 null）
 * @returns 结算 promise，或 null（没有可认领的旧实例）
 */
export function adoptPreviousLifecycle(previous) {
  if (!previous || typeof previous.beginShutdown !== 'function' || typeof previous.settle !== 'function') return null;
  if (typeof previous.isShuttingDown === 'function' && previous.isShuttingDown()) return null;
  previous.beginShutdown();
  return previous.settle(1000);
}

export function createLifecycle() {
  /** child -> { closed, resolveClosed }：归属表。exit/error/close 任一事件都会结算并摘除。 */
  const children = new Map();
  let shuttingDown = false;
  let generation = 0;
  /** settle 的 in-flight promise（幂等：ZCode 的 disposeInFlight 同义）。 */
  let settleInFlight = null;

  /** 新建运行时的入口先过这一关；关停开始后抛 E_SHUTDOWN（而不是静默启动一个没人收的进程）。 */
  const assertAlive = () => {
    if (!shuttingDown) return;
    const error = new Error('remote-wsl: 插件正在关停，拒绝新建运行时');
    error.code = 'E_SHUTDOWN';
    throw error;
  };

  /**
   * 登记一个子进程；返回的 release 可提前摘除（exit/error/close 都会自动摘）。
   * 已退出（或已登记过）的 child 不登记 —— 否则 settle 会白等一个超时。
   */
  const track = (child) => {
    if (!child || typeof child.once !== 'function') return () => {};
    if (children.has(child)) return () => {};
    if (child.exitCode !== null || child.signalCode !== null) return () => {}; // 已退出：不登记
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const state = { closed, resolveClosed, settled: false };
    const finish = () => {
      if (state.settled) return;
      state.settled = true;
      children.delete(child);
      if (typeof child.off === 'function') {
        child.off('exit', finish);
        child.off('error', finish);
        child.off('close', finish);
      }
      state.resolveClosed();
    };
    children.set(child, state);
    // ZCode 的 trackOwnedChild 同样认三个事件：spawn 失败时只有 error，没有 exit。
    child.once('exit', finish);
    child.once('error', finish);
    child.once('close', finish);
    return finish;
  };

  /** 进入关停态（幂等；返回递增的代次，便于日志区分）。 */
  const beginShutdown = () => {
    shuttingDown = true;
    generation += 1;
    return generation;
  };

  /** 优雅收尾：先关 stdin（wsl.exe 包装层读到 EOF 会自己收尾，Linux 侧可继续把脚本跑完）。 */
  const endOwnedChildInput = (child) => {
    const stdin = child && child.stdin;
    if (!stdin || stdin.writableEnded || typeof stdin.end !== 'function') return;
    try {
      stdin.end();
    } catch {
      /* stdin 已异常关闭：直接进入 kill fallback */
    }
  };

  /**
   * 等一个已登记的 child 结算；返回是否已结算（exit / error / close 任一都算）。
   *
   * 为什么用**登记时**就建好的 settled promise，而不是在 settle() 里临时 `once('exit')`：
   * ZCode 的 `closeEvent.ts`（createCloseEventController）记录过「晚订阅丢事件」——远端命令可能在
   * 调用方订阅 `onClose` **之前**就瞬间退出。旧写法 settle() 里"先快照 children、再逐个挂 once('exit')"，
   * 于是**在快照与挂监听之间退出的 child 的 exit 永远收不到**，只能白等到总预算耗尽（表现=关停卡住）。
   * 现在 track() 时就建好 `closed` promise（finish **只 resolve 一次**），已结算的 child 立即返回 true。
   */
  const raceClose = (state, timeoutMs) => {
    if (state.settled) return Promise.resolve(true);
    if (!(timeoutMs > 0)) return Promise.resolve(false);
    let timer = null;
    return Promise.race([
      state.closed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };

  /**
   * 等所有被跟踪的子进程退出（幂等：重复调用返回同一个 in-flight promise）。
   *
   * @param timeoutMs - 总预算（默认 5000，index.ts 显式传 5000 ⇒ 语义不变）
   * @param options.graceTimeoutMs - 优雅退出宽限（默认 300）
   * @param options.killWaitTimeoutMs - kill 后确认退出的等待（默认 250）
   * @returns { waitedMs, killed, remaining, timedOut, forced }
   *   - **timedOut = 总预算耗尽**：settle 返回时**仍有**本模块登记的 child 没退出（`remaining > 0`）。
   *     index.ts 的 disposer 就按它打「关停超时」——必须只在**真的没关干净**时为真；
   *     子进程只是超过 300ms 才退（随后在 kill 等待里干净退出）**不算**超时，否则是伪失败日志。
   *   - **forced = 真的走进了 kill 分支**（宽限期没等到它自己退出）。探针/报告用这个判断"是否强制释放"。
   *   - killed = 本次 kill 的**本模块登记**子进程数（绝不按进程名扫）。
   */
  const settle = (timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS, options = {}) => {
    if (settleInFlight) return settleInFlight;
    const startedAt = Date.now();
    const budget = Math.max(Number(timeoutMs) || 0, 0);
    const graceTimeoutMs = Math.min(Math.max(Number(options.graceTimeoutMs ?? DEFAULT_GRACE_TIMEOUT_MS) || 0, 0), budget);
    const killWaitBudget = Math.max(Number(options.killWaitTimeoutMs ?? DEFAULT_KILL_WAIT_TIMEOUT_MS) || 0, 0);
    const entries = [...children.entries()];

    // ① 优雅：先同步关掉每个自己 spawn 的 child 的 stdin（对应 ZCode disposeAndWait 的第一段）
    for (const [child] of entries) endOwnedChildInput(child);

    settleInFlight = (async () => {
      // ② 宽限期：等它们自己退出（已结算的 child 立即返回，不会因为"订阅晚于退出"而白等）
      const closedInGrace = await Promise.all(entries.map(([, state]) => raceClose(state, graceTimeoutMs)));
      const forced = closedInGrace.some((closed) => !closed);
      let killed = 0;
      if (forced) {
        // ③ 只 kill 归属表里**仍在**的那些（不按进程名扫、不 terminate 发行版）
        for (const [child] of entries) {
          if (!children.has(child)) continue;
          try {
            child.kill();
            killed += 1;
          } catch {
            /* 已经退出 */
          }
        }
        // ④ kill 后再等一小段确认退出 —— 等待长度从总预算里扣，5s 上限不变
        const remainingBudget = Math.max(budget - (Date.now() - startedAt), 0);
        await Promise.all(entries.map(([, state]) => raceClose(state, Math.min(killWaitBudget, remainingBudget))));
      }
      const remaining = children.size;
      return {
        waitedMs: Date.now() - startedAt,
        killed,
        remaining,
        // 总预算耗尽 = 返回时还有登记未退出（index.ts 的「关停超时」日志按这个判）
        timedOut: remaining > 0,
        // 是否强制释放过（宽限期没等到 ⇒ kill 分支）；与 timedOut 解耦，不能混用
        forced,
      };
    })();
    return settleInFlight;
  };

  const lifecycle = {
    assertAlive,
    track,
    beginShutdown,
    settle,
    isShuttingDown: () => shuttingDown,
    size: () => children.size,
    generation: () => generation,
  };
  // 自动成为"当前关停屏障"：wsl-io 的短命子进程据此登记（理由见文件头 ambientLifecycle 注释）。
  setAmbientLifecycle(lifecycle);
  return lifecycle;
}
