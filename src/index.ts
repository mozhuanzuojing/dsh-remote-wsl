/**
 * dsh-remote-wsl —— Cordis 插件入口（架构债 T5/task-44 拆分后**只留 wiring**）。
 *
 * 本文件现在只有三件事：
 *  1. `DEFAULTS`（配置面）与 `name`/`inject`；
 *  2. `apply` 里**创建状态 + 组装依赖**（守护状态、版本解析、运行时池、web host 表），并把它们交给
 *     `registerTools`（七个工具）与 `registerExplorer`（面板数据面）——**"谁能起进程/动槽位"只在这里决定**；
 *  3. disposer：只回收**本宿主进程**持有的东西（in-host 运行时 + web host + 自有 /tmp 一次性文件），
 *     **绝不杀守护**（语义 #4：守护持有的是远端会话，杀它 = 把跨宿主复用一起杀掉）。
 *
 * 拆出去的模块：`wsl-io.ts`（低层 WSL IO + 版本/pin）、`in-host-runtime.ts`（宿主逃生舱运行时池）、
 * `register-tools.ts`（七个工具 + `dsh web` 宿主）、`explorer.ts`（面板数据面）、`daemon-client.ts`（守护客户端）。
 *
 * @module dsh-remote-wsl
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { shellEnvSnippet } from './shell-env.ts';
import { warmScript, dlxInventoryScript, pickDesktopVersion } from './version.ts';
import {
  ensureDaemon, stopDaemon, daemonPrompt, daemonStatus, daemonSnapshot, readDaemonMeta, stateDirLinux,
} from './daemon-client.ts';
import { registerExplorer, withModulePrefix } from './explorer.ts';
import { resolveVersion, writePin, runWsl, sweepOwnTempFiles, shellPreamble, sleep } from './wsl-io.ts';
import { createInHostPool } from './in-host-runtime.ts';
import { registerTools, sweepStaleRuntimes } from './register-tools.ts';

/** Stable Loader identity. */
export const name = 'dsh-remote-wsl';

/** 服务依赖由 `apply` 内显式 `ctx.inject(['tools'], …)` 处理，故为空（同 dsh-shadow）。 */
export const inject = [];

const DEFAULTS = {
  distro: 'debian-u8-1',
  /** WSL 侧家目录（版本 pin 与 session 日志都在它下面）。 */
  wslHome: '/home/g',
  /** 远端 agent 的工作目录（Linux 绝对路径）。 */
  cwd: '/home/g',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  profile: 'sdk',
  /** 空 = 跟随桌面版本（读 primary-runtime/runtime.json 的 desktopVersion）。 */
  dshVersion: '',
  webPort: 3082,
  /** 运行时空闲多久后回收（毫秒）。 */
  idleTimeoutMs: 600000,
  /** 单次工具调用的墙钟上限（毫秒）。 */
  timeoutMs: 600000,
  /** 桌面 runtime.json 的显式路径（留空则分层推导：见 lib/version.js 的 desktopRuntimeCandidates）。 */
  desktopRuntimeJson: '',
  /**
   * 是否把 WSL 登录 shell 环境注入**常驻进程**的启动脚本（对位 VS Code `remote.WSL.useShellEnvironment`）。
   * 默认 true（同 VS Code：`!1!==get(...)`）。只作用于 `wsl_agent` / `wsl_open_ui` 起的常驻进程，
   * `wsl_exec` 的一次性路径不注入（理由见 shellPreamble 与 wsl_exec 的 description）。
   */
  useShellEnvironment: true,
  /**
   * 检测到版本漂移（桌面版本 !== WSL pin）时，**后台**预热 WSL 侧的该版本。
   * 默认 true（对应 GAP-AUDIT §7 修正后的 #3：drift 自动 warm，但不得阻塞当前调用）。
   */
  backgroundWarm: true,
  /** 宿主机代理端口（用于"先探测再使用"）。 */
  proxyPort: 9910,
  /**
   * 远端 agent 的宿主形态：
   *  · `'daemon'`（默认）= 运行时由 **WSL 侧常驻守护**持有 ⇒ 客户端进程可来可走，跨进程/跨宿主复用上下文；
   *  · `'in-host'` = 旧形态（本宿主进程自己持有运行时）—— 逃生舱，保留原行为（含日志兜底）。
   */
  backend: 'daemon',
  /** 守护监听端口（127.0.0.1）。WSL 侧被占则 +1 探测；Windows 侧被占则由客户端换端口重试。 */
  daemonPort: 8731,
  /** 端口回退次数（Windows 命名空间里被别的属主占用时逐个试）。 */
  daemonPortTries: 3,
  /** 守护空闲回收（毫秒，默认 30 分钟）。**到期即回收运行时 ⇒ 上下文丢失**，不是"永久保持"。 */
  daemonIdleMs: 1800000,
  /** **寿命闸门**：守护在"无 key 且无客户端"持续这么久后自退（默认 10 分钟；0=关）。有会话时绝不触发。 */
  daemonLingerMs: 600000,
  /** 同一 key 的并发 prompt：守护内 FIFO 串行，这里是**等待位上限**，超出明确拒绝（上游 SDK 无 cancel）。 */
  daemonQueueLimit: 4,
  /** Windows 侧握手判据的超时（毫秒）。身份不符/端口被占必须在这个量级快速失败，绝不等 timeoutMs。 */
  daemonHandshakeTimeoutMs: 3000,
  /** 起守护后等"Windows 侧握手确认就绪"的上限（毫秒）。 */
  daemonStartTimeoutMs: 20000,
};

// ── 插件本体 ─────────────────────────────────────────────────────────────────

/**
 * Mount the remote-WSL surface.
 * @param ctx agent-scoped services（只需 `tools`）
 * @param rawConfig 插件行的 config（未经 schema 归一，缺失键在此补默认值）
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  // 防御性判断：缺任一框架接口则整个插件无从工作（同 dsh-shadow 的前置判据）
  if (typeof ctx?.inject !== 'function' || typeof ctx?.get !== 'function') {
    throw new Error('remote-wsl: 宿主缺少 ctx.inject / ctx.get，插件无法挂载');
  }

  const webHosts = new Map(); // port -> WebHost
  const version = resolveVersion(config);
  let swept = null; // 孤儿清理只做一次（懒触发，不给宿主启动加成本）

  /** 首次工具调用时清一次孤儿运行时；失败不影响主流程。 */
  const ensureSwept = async () => {
    if (!swept) swept = sweepStaleRuntimes(config).catch(() => 0);
    await swept;
  };

  /** 已发起过后台预热的版本（同一版本只发起一次）。 */
  const warmed = new Set();

  /**
   * 版本漂移时**后台**预热 WSL 侧该版本 —— fire-and-forget：不 await、不抛、失败只打一行 stderr。
   *
   * 为什么必须是 fire-and-forget：预热是"为下一次调用省冷启"的优化，代价（pnpm dlx 冷启 5-7s、
   * 依赖网络/代理）本来就不该记在**当前**这次调用上；一旦 await，优化失败还会连带把工具调用
   * 变成失败（GAP-AUDIT §7 修正 #3：drift 自动 warm **不得**阻塞）。所以：
   *  · 触发点只放在**会用到该版本**的工具里（wsl_agent / wsl_open_ui / wsl_sync_version）；
   *    `wsl_status` 声明为只读、便宜，不在这里触发（读一次状态不该偷偷下载东西）。
   *  · 同一版本只发起一次：先同步入 Set 再起异步任务 ⇒ 并发调用也不会重复起；失败也不重试
   *    （否则每次调用都要白白打一次网络）。
   *  · 结果无论成败都落一行 stderr（可观测，且不进 stdout 以免污染工具返回值）。
   */
  const warmInBackground = (v) => {
    if (!config.backgroundWarm || !v || !v.drift || !v.version) return;
    if (warmed.has(v.version)) return;
    warmed.add(v.version); // 同步占位：并发调用不会重复起
    void (async () => {
      try {
        const res = await runWsl(config, `${shellPreamble(config)}${warmScript({ cfg: config, version: v.version })}`, {
          timeoutMs: 300000,
        });
        process.stderr.write(
          `remote-wsl: 后台预热 dsh@${v.version} ${
            res.stdout.includes('WARM-OK') ? 'ok' : `失败（exit ${res.exitCode}）`
          }\n`,
        );
      } catch (e) {
        // 到这一步已经是"没人 await 的分支"：连异常都不能漏出去（预热失败绝不能影响工具）
        process.stderr.write(`remote-wsl: 后台预热 dsh@${v.version} 失败: ${e?.message ?? String(e)}\n`);
      }
    })();
  };

  // ── 守护形态（默认）：运行时由 **WSL 侧常驻守护**持有 ──────────────────────────
  //
  // 语义 #1：关客户端 ≠ 会话结束。会话只在三种情况结束 —— 显式 stop（wsl_daemon action=stop）、
  // 空闲超时（daemonIdleMs，到期即丢上下文）、守护或运行时死亡。所以这里**不持有** runtimes，
  // 也不在 dispose 里杀守护（语义 #4）。
  const daemonState: {
    info: any;
    port: number | null;
    notes: string[];
    collisions: string[];
    lastSessionByKey: Map<string, string>;
  } = { info: null, port: null, notes: [], collisions: [], lastSessionByKey: new Map() };
  const logDaemon = (m: string) => process.stderr.write(`remote-wsl: ${m}\n`);

  /**
   * 机器可读行（F3）：四种动作（`start` / `restart` / `status` / `stop` / `stop --all`）**同一套字段**，
   * 缺项统一写 `-`。以前字段语义随动作变（`daemon=<pid>@<port>` vs `daemon=<slot>@<port>`、`version=-`），
   * 同一个 key 在不同动作里含义不同 ⇒ 脚本化会静默解析错。
   */
  const machineLine = (o: { slot?: unknown; pid?: unknown; port?: unknown; version?: unknown; extra?: string } = {}) =>
    `machine: slot=${o.slot ?? '-'} pid=${o.pid ?? '-'} port=${o.port ?? '-'} version=${o.version ?? '-'}` +
    (o.extra ? ` ${o.extra}` : '');

  /**
   * 确保"Windows 侧真实可达"的守护存在（幂等：已有就复用，绝不每次调用都起一个）。
   * 就绪判据来自 daemon-client 的 hello+token —— 守护自己打印的 `listening` 不算数（缺陷 #11）。
   */
  async function ensureDaemonReady({ restart = false } = {}) {
    if (!version.version) {
      throw new Error('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');
    }
    warmInBackground(version); // 漂移时后台预热，不阻塞本次启动
    const r = await ensureDaemon(config, { version: version.version, restart, log: logDaemon });
    daemonState.notes = r.notes ?? [];
    if (daemonState.notes.some((n) => /未通过|影子|占用|被拒|超时/.test(n))) daemonState.collisions = daemonState.notes;
    // task-22：上游 `r.error` 在组合条件下已含 `remote-wsl:`（落在句中）⇒ 用 `withModulePrefix` 守卫，
    // 不再无条件拼前缀（否则会得到两份 `remote-wsl:`）。非标记文案仍会被补上恰好一份。
    if (!r.ok) throw new Error(withModulePrefix(r.error));
    daemonState.info = r.info;
    daemonState.port = r.port;
    return r;
  }

  /**
   * 传输层失败（守护不在 / 半死不活）—— 与"op 返回 ok:false"必须分开：
   * 后者运行时还活着，语义 #6 明令**不许**重启（重启 = 换 sessionId = 毁上下文）。
   */
  function isTransportFailure(r: { ok?: boolean; queueFull?: boolean; kind?: string }) {
    return (
      !r?.ok &&
      !r?.queueFull &&
      (r?.kind === 'refused' || r?.kind === 'closed' || r?.kind === 'error' || r?.kind === 'timeout')
    );
  }

  /**
   * 这一次调用**之前**已知的 sessionId：先看本进程记忆，再看守护陈元数据（跨宿主进程时靠它）。
   * P1：身份是 **key+cwd**（守护按 cwd 分条目）—— 不按 cwd 匹配会把"另一个 cwd 的会话"误当成自己的。
   */
  const priorSessionFor = (key: string, cwd?: string) => {
    const effCwd = cwd ?? config.cwd;
    const mem = daemonState.lastSessionByKey.get(`${key}\u0000${effCwd}`);
    if (mem) return mem;
    const rec = (readDaemonMeta(config)?.keys ?? []).find(
      (k: any) => k.key === key && (k.cwd ?? config.cwd) === effCwd,
    );
    return rec?.sessionId ?? null;
  };

  // ── 拆分接线（架构债 T5/task-44）────────────────────────────────────────────
  // 状态与判定**只在这里**创建（单一来源）；register-tools.ts 只拿注册面。
  const inHost = createInHostPool({ config, version, warmInBackground });
  const runtimes = inHost.runtimes; // 宿主逃生舱持有的运行时（dispose 时回收；**不含守护**）

  const listDistros = () => {
    const res = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return (res.stdout || '')
      .split('\n')
      .map((s) => s.replace(/\0/g, '').trim())
      .filter(Boolean);
  };

  registerTools({
    ctx, config, version, resolveVersion, daemonState, logDaemon, machineLine, ensureDaemonReady,
    isTransportFailure, priorSessionFor, listDistros, getRuntime: inHost.getRuntime, runtimes, webHosts,
    ensureSwept, warmInBackground,
  });

  // ── 人面（面板）host 数据面 ─────────────────────────────────────────────────
  // 数据面 = explorer.ts 的四个方法（名字见 EXPLORER_METHODS），传输层 = 它注册的
  // `POST/GET /remote-wsl/api`（同源 + 硬白名单；为什么不是设计稿 §4 的 `host.call` 见 explorer.ts 头部）。
  // 注入的全部是上面已有的实现，**没有新增扫描/判定逻辑**（daemon 段仍只来自 daemonSnapshot）。
  registerExplorer(ctx, {
    config,
    listDistros,
    resolveVersion,
    writePin,
    webHosts,
    // A1（task-23）：`explorer.addWorkspace` 要调 host 的 `workspaceRegistry`（T11 实测的服务名）。
    // 这里只给一个**取服务**的闭包：服务没挂上时返回 undefined，由 explorer.ts 侧给可读 503 + 一行降级日志。
    workspaceRegistry: () => (typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined),
  });
  // 插件卸载时回收常驻进程（idle 定时器之外的第二道保险）。
  // ⚠️ disposer 必须**可等待**：早前写成 `void rt.close()`（不 await），宿主/测试一退出就把清理
  // 截断，WSL 侧会留下 .sh/.pid（2026-10-10 实测）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      // 语义 #4：**不杀守护** —— 守护持有的就是"远端会话"，杀掉它等于把跨宿主复用一起杀掉。
      // 这里只回收**本宿主进程**持有的东西：in-host 逃生舱的运行时 + web host。
      // 要显式结束远端会话，请用 wsl_daemon action=stop（唯一有意的停止入口）。
      await Promise.allSettled([...runtimes.values()].map((rt) => rt.close()));
      await Promise.allSettled([...webHosts.values()].map((h) => h.stop()));
      await sweepOwnTempFiles(config); // 自有 /tmp 一次性文件（按 winpid）——不碰别人的
      if (config.backend !== 'in-host') {
        process.stderr.write('remote-wsl: 宿主退出；WSL 侧守护保持运行（关客户端 ≠ 会话结束）\n');
      }
    });
  }
}
