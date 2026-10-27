/**
 * dsh-remote-wsl / in-host-runtime —— **宿主逃生舱**（`backend='in-host'`）的运行时池
 * （架构债 T5/task-44 从 index.ts 逐字搬运；架构债 T1 起**共用** `sdk-runtime.ts` 的唯一实现）。
 *
 * 语义（与拆分前一致，见 README「常驻守护」）：运行时由**本宿主进程**持有 ⇒ 关客户端 = 丢会话；
 * 启动脚本由宿主拼（登录 shell env + `.pid`）落 `/tmp` 后 `wsl.exe -d <distro> -- bash <脚本>`；
 * 关停走 adapter 的 `closeHook`（`reapWsl` + 删脚本）—— 包装层被杀 ≠ Linux 侧退出。
 *
 * **必须 import 共享的 `SdkRuntime`**（禁止再复制实现）—— 差异全部经 `runtimeAdapter` 表达。
 *
 * @module dsh-remote-wsl/in-host-runtime
 */
import { spawn } from 'node:child_process';
import { SdkRuntime, allowBuildFlags, runtimeAdapter } from './sdk-runtime.ts';
import { cdPreamble } from './shell-quote.ts';
import { readLogViaWsl, reapWsl, removeScript, shellPreamble, writeScript } from './wsl-io.ts';

/**
 * 宿主形态（`backend='in-host'` 逃生舱）的运行时描述 —— 架构债 T1（task-34）去重的核心。
 *
 * 共享的 `SdkRuntime`（`sdk-runtime.ts`）默认是**守护形态**；这里只覆盖差异，逐条都能对上旧的内嵌副本：
 *  · 脚本由宿主拼（登录 shell env 前缀 + `.pid` 行，供 `reapWsl` 收 Linux 侧进程）并落 `/tmp`；
 *  · 起进程走 `wsl.exe -d <distro> -- bash <脚本>`（守护形态是 WSL 内 `bash -c`，有守护注入的 env）；
 *  · 关停 = 杀包装层 + `reapWsl`（守护形态杀**进程组**）；
 *  · 空正文走 `fallbackText`（读持久化日志）+ `idleTimeoutMs` 自回收（守护形态回报 `retryable`，绝不换 sessionId）；
 *  · 文案带 `remote-wsl: ` 前缀、`stderrTail` 8000、`prompt()` 结果形状是旧的那一套（`turn/runtimeRestarted`）。
 *
 * `state.script` 必须由 `spawnRuntime` 写、由 `closeHook` 读 —— 同一份引用，别各留一份。
 */
function inHostAdapter(cfg, lifecycle) {
  const state = { script: null };
  return runtimeAdapter({
    label: 'host',
    stderrTailLimit: 8000,
    initTimeoutMs: cfg.timeoutMs,
    guardStdinWrite: false,
    logSpawnError: false,
    sawAssistantRequiresText: false,
    requireAliveOnPrompt: false,
    quietLabels: { quiet: null, grace: null },
    fallbackMode: 'close-read-log',
    resultProfile: 'host',
    killMode: 'wrapper',
    closeResult: 'void',
    idleTimeoutMs: cfg.idleTimeoutMs,
    // 2026-10-27 审查 F-08：cwd 走 cdPreamble（单引号转义 + 失败立即 exit 2，旧实现裸插值可注入）。
    // 2026-10-27 审查 F-09：写唯一标记 `DSH_RWSL_MARK`（= 脚本基名），供 reapWsl 杀进程前验身份。
    scriptFor: ({ cwd, version, profile }) => `${shellPreamble(cfg, { withShellEnv: true })}${cdPreamble(cwd)}
# 记下 PID：exec 之后它就是 pnpm/node 主进程的 PID，供 reapWsl 主动回收
echo $$ > "\${0%.sh}.pid"
export DSH_RWSL_MARK="$(basename "\${0%.sh}" .sh)"
# 凭据走 ~/.dsh/.credentials.yaml 的 credentials seam，无需 export API key
exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${version} --profile ${profile}
`,
    spawnRuntime: ({ script }) => {
      state.script = writeScript(cfg.distro, script);
      const child = spawn('wsl.exe', ['-d', cfg.distro, '--exec', 'bash', state.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // 关停屏障：登记包装层，dispose 时等它退出（超时只 kill 自己记录的这个）
      if (lifecycle) lifecycle.track(child);
      return child;
    },
    closeHook: async () => {
      await reapWsl(cfg, state.script);
      removeScript(cfg.distro, state.script);
    },
    text: {
      requestClosed: () => 'remote-wsl: 运行时已关闭',
      promptClosed: () => 'remote-wsl: 运行时已关闭（上一轮走到了兜底路径，请重试）',
      requestTimeout: (method) => `remote-wsl: ${method} 超时`,
      noText: 'remote-wsl: 事件流与持久化日志都没有 assistant 正文；请重试（运行时已重启、id 会换新）',
    },
  });
}

/**
 * 建宿主侧运行时池：同一 `key` 复用同一个常驻运行时（多轮才有上下文 —— 上游拒绝跨进程复用 sessionId）。
 * 只在本宿主进程内有效；dispose 时由 index.ts 统一 `close()`（**不碰守护** —— 语义 #4）。
 */
export function createInHostPool({ config, version, warmInBackground, lifecycle }) {
  const runtimes = new Map(); // key -> SdkRuntime
  const starting = new Map(); // key -> Promise<SdkRuntime>（F-21：并发 getRuntime 单飞）
  const getRuntime = async (key, cwdOverride) => {
    const existing = runtimes.get(key);
    if (existing && !existing.closed) return existing;
    // F-21（2026-10-27 审查）：旧实现"先查 map、未命中就 await start() 再 set"，两个并发调用会各建
    // 一个运行时，后者覆盖 map、前者失去跟踪 ⇒ dispose 只关后一个，WSL 侧泄漏一个常驻进程。
    // 这里把**在飞的启动**也放进 map（Promise 占位），并发调用共享同一次启动。
    const inFlight = starting.get(key);
    if (inFlight) return inFlight;
    if (lifecycle) lifecycle.assertAlive(); // 关停开始后不再新建（否则新进程落在快照外）
    if (!version.version) {
      throw new Error('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');
    }
    warmInBackground(version); // 漂移时后台预热，不阻塞本次启动
    // cwd 在**运行时创建时**生效（它决定会话 cwd 与启动工作目录）；同一 key 复用时不重建
    const effCfg = cwdOverride ? { ...config, cwd: cwdOverride } : config;
    const promise = (async () => {
      const rt = new SdkRuntime({
        key,
        version: version.version,
        cwd: effCfg.cwd,
        profile: effCfg.profile,
        provider: effCfg.provider,
        model: effCfg.model,
        // 宿主形态原来拿 `cfg.timeoutMs` 当请求/单轮的默认超时（守护形态是 promptTimeoutMs=300000）
        promptTimeoutMs: effCfg.timeoutMs,
        quietMs: 3000,
        graceMs: 20000,
        // 逃生舱的兜底：事件流没有正文时停稳运行时、读持久化日志（守护形态**不**走这条 —— 语义 #6）
        fallbackText: ({ sessionId }) => readLogViaWsl(effCfg, sessionId, effCfg.cwd),
        adapter: inHostAdapter(effCfg, lifecycle),
      });
      runtimes.set(key, rt);
      try {
        await rt.start();
      } catch (e) {
        runtimes.delete(key);
        throw e;
      }
      return rt;
    })().finally(() => {
      starting.delete(key);
    });
    starting.set(key, promise);
    return promise;
  };
  return { runtimes, getRuntime };
}
