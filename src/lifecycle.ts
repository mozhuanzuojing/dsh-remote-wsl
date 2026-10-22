/**
 * dsh-remote-wsl / lifecycle —— 关停屏障。
 *
 * 参考 zai-org/ZCode 的 Remote Host 释放纪律（docs/wsl-remote-workspace-design.md）：
 *  · beginShutdown() 之后拒绝再新建运行时 —— 否则新进程落在快照之外，永远没人回收；
 *  · 只跟踪**本插件 spawn 的 wsl.exe 包装层**，退出时自动摘除（不按进程名扫、不碰别人的进程）；
 *  · settle() 等它们退出；超时只 kill 自己记录的那些 —— **绝不** wsl --terminate / --shutdown
 *    （那是发行版级操作，会杀掉用户在同一发行版里的其他任务）。
 */

export function createLifecycle() {
  const children = new Set();
  let shuttingDown = false;
  let generation = 0;

  /** 新建运行时的入口先过这一关；关停开始后抛 E_SHUTDOWN（而不是静默启动一个没人收的进程）。 */
  const assertAlive = () => {
    if (!shuttingDown) return;
    const error = new Error('remote-wsl: 插件正在关停，拒绝新建运行时');
    error.code = 'E_SHUTDOWN';
    throw error;
  };

  /** 登记一个子进程；返回的 release 可提前摘除（exit 时会自动摘）。 */
  const track = (child) => {
    if (!child || typeof child.once !== 'function') return () => {};
    if (child.exitCode !== null || child.signalCode !== null) return () => {}; // 已退出：不登记（否则 settle 会白等）
    children.add(child);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      children.delete(child);
      if (typeof child.off === 'function') child.off('exit', release);
    };
    child.once('exit', release);
    return release;
  };

  /** 进入关停态（幂等；返回递增的代次，便于日志区分）。 */
  const beginShutdown = () => {
    shuttingDown = true;
    generation += 1;
    return generation;
  };

  /**
   * 等所有被跟踪的子进程退出。
   * @param timeoutMs - 宽限时间；超时后只 kill 本模块记录的进程
   * @returns { waitedMs, killed, remaining, timedOut }
   */
  const settle = async (timeoutMs = 5000) => {
    const startedAt = Date.now();
    const snapshot = [...children];
    const waitAll = Promise.all(
      snapshot.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', () => resolve());
          }),
      ),
    );
    let timedOut = false;
    await Promise.race([
      waitAll,
      new Promise((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs),
      ),
    ]);
    let killed = 0;
    if (timedOut) {
      for (const child of [...children]) {
        try {
          child.kill();
          killed += 1;
        } catch {
          /* 已经退出 */
        }
      }
    }
    return { waitedMs: Date.now() - startedAt, killed, remaining: children.size, timedOut };
  };

  return { assertAlive, track, beginShutdown, settle, isShuttingDown: () => shuttingDown, size: () => children.size };
}
