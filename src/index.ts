/**
 * dsh-remote-wsl —— Cordis 插件入口（架构债 T5/task-44 拆分后**只留 wiring**）。
 *
 * 本文件现在只有三件事：
 *  1. 配置面（默认值已收敛到 `./config.ts`）与 `name`/`inject`；
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
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { shellEnvSnippet } from './shell-env.ts';
import { warmScript, dlxInventoryScript, pickDesktopVersion } from './version.ts';
import {
  ensureDaemon, stopDaemon, daemonPrompt, daemonStatus, daemonSnapshot, readDaemonMeta, stateDirLinux,
} from './daemon-client.ts';
import { decodeWslOutput, registerExplorer, withModulePrefix } from './explorer.ts';
import { activeLifecycle, adoptPreviousLifecycle, createLifecycle } from './lifecycle.ts';
import { resolveVersion, writePin, runWsl, sweepOwnTempFiles, shellPreamble, sleep } from './wsl-io.ts';
import { createInHostPool } from './in-host-runtime.ts';
import { registerTools, sweepStaleRuntimes } from './register-tools.ts';
import { apply as applyWslPreset } from './preset.ts';

import { normalizeConfig } from './config.ts';
/** Stable Loader identity. */
export const name = 'dsh-remote-wsl';

/** 服务依赖由 `apply` 内显式 `ctx.inject(['tools'], …)` 处理，故为空（同 dsh-shadow）。 */
export const inject = [];



// ── 插件本体 ─────────────────────────────────────────────────────────────────

/**
 * Mount the remote-WSL surface.
 * @param ctx agent-scoped services（只需 `tools`）
 * @param rawConfig 插件行的 config（未经 schema 归一，缺失键在此补默认值）
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
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
   *
   * F-05（2026-10-27 审查）：**同进程内必须单飞**。旧实现每次工具调用都直接 `await ensureDaemon`，
   * 同一轮的两个并行调用会同时进入"没有守护 ⇒ 启动"分支、各自起一个（跨进程那侧由
   * daemon-lifecycle 的启动锁兜住）。`restart` 不走单飞：先等在飞的那次结束，再显式重启。
   */
  let ensureInFlight: Promise<any> | null = null;
  async function ensureDaemonReady({ restart = false } = {}) {
    if (restart) {
      const prior = ensureInFlight;
      ensureInFlight = null;
      if (prior) {
        try {
          await prior;
        } catch {
          /* 旧的那次失败与本次 restart 无关 */
        }
      }
    } else if (ensureInFlight) {
      return ensureInFlight;
    }
    const run = (async () => {
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
    })();
    ensureInFlight = run;
    try {
      return await run;
    } finally {
      if (ensureInFlight === run) ensureInFlight = null;
    }
  }

  /**
   * 传输层失败（守护不在 / 半死不活）—— 与"op 返回 ok:false"必须分开：
   * 后者运行时还活着，语义 #6 明令**不许**重启（重启 = 换 sessionId = 毁上下文）。
   *
   * F-10（2026-10-27 审查）：`timeout` **不算**传输失败。请求可能已经送达并在守护里跑（单轮上限
   * 300s、排队更久），此时"自动重发同一个 prompt"会**重复执行**同一个有副作用的操作，而守护
   * 没有幂等键。只有"连不上 / 连接在拿到应答前就断了"才重试一次（此时请求大概率没被处理）。
   */
  function isTransportFailure(r: { ok?: boolean; queueFull?: boolean; kind?: string }) {
    return !r?.ok && !r?.queueFull && (r?.kind === 'refused' || r?.kind === 'closed');
  }

  /**
   * 这一次调用**之前**已知的 sessionId：先看本进程记忆，再看守护陈元数据（跨宿主进程时靠它）。
   * P1：身份是 **key+cwd**（守护按 cwd 分条目）—— 不按 cwd 匹配会把"另一个 cwd 的会话"误当成自己的。
   */
  const priorSessionFor = (key: string, cwd?: string) => {
    const effCwd = cwd ?? config.cwd;
    const mem = daemonState.lastSessionByKey.get(`${key}\u0000${effCwd}`);
    if (mem) return mem;
    const meta = readDaemonMeta(config);
    const rec = (meta?.keys ?? []).find((k: any) => k.key === key && (k.cwd ?? config.cwd) === effCwd);
    if (rec?.sessionId) return rec.sessionId;
    // F-17（2026-10-27 审查）：条目已经被 idle 回收/运行时死亡清掉 ⇒ 读守护留下的「退役记录」，
    // 让调用方能识别出"本来有会话、现在没了"，从而打印 contextReset，而不是静默开一个新会话。
    const dead = (meta?.retired ?? []).find((r: any) => r.key === key && (r.cwd ?? config.cwd) === effCwd);
    return dead?.sessionId ?? null;
  };

  // ── 拆分接线（架构债 T5/task-44）────────────────────────────────────────────
  // 状态与判定**只在这里**创建（单一来源）；register-tools.ts 只拿注册面。
  // 关停屏障（参考 ZCode 的 Remote Host dispose 纪律）：dispose 开始后拒绝新建运行时，并等自己 spawn 的包装层退出。
  // 2026-10-23 review ⑥：热重载时旧实例可能留下没人等的包装层（旧 disposer 没跑完/没跑）⇒ 新建前
  // 先把上一份屏障认领掉（幂等；只结算它自己登记的子进程）。
  const previousLifecycle = activeLifecycle();
  const lifecycle = createLifecycle();
  if (previousLifecycle) {
    const adopted = adoptPreviousLifecycle(previousLifecycle);
    if (adopted) {
      adopted.catch((error) => {
        process.stderr.write('remote-wsl: 认领旧关停屏障失败（忽略）: ' + (error && error.message ? error.message : String(error)) + '\n');
      });
    }
  }
  const inHost = createInHostPool({ config, version, warmInBackground, lifecycle });
  const runtimes = inHost.runtimes; // 宿主逃生舱持有的运行时（dispose 时回收；**不含守护**）

  const listDistros = () => {
    const res = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return (res.stdout || '')
      .split('\n')
      .map((s) => s.replace(/\0/g, '').trim())
      .filter(Boolean);
  };

  // 异步版 `wsl -l -q`（面板数据面用）：不阻塞 host 事件循环；失败按「读不到」返回空数组。
  const listDistrosAsync = () =>
    new Promise<string[]>((resolve) => {
      execFile(
        'wsl.exe',
        ['-l', '-q'],
        { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 8000 },
        (error, stdout) => {
          if (error) {
            resolve([]);
            return;
          }
          resolve(String(decodeWslOutput(stdout)).split('\n').map((name) => name.trim()).filter(Boolean));
        },
      );
    });

  registerTools({
    ctx, config, version, resolveVersion, daemonState, logDaemon, machineLine, ensureDaemonReady,
    isTransportFailure, priorSessionFor, listDistros, listDistrosAsync, getRuntime: inHost.getRuntime, runtimes, webHosts,
    ensureSwept, warmInBackground, lifecycle,
  });

  // ── 人面（面板）host 数据面 ─────────────────────────────────────────────────
  // 数据面 = explorer.ts 的四个方法（名字见 EXPLORER_METHODS），传输层 = 它注册的
  // `POST/GET /remote-wsl/api`（同源 + 硬白名单；为什么不是设计稿 §4 的 `host.call` 见 explorer.ts 头部）。
  // 注入的全部是上面已有的实现，**没有新增扫描/判定逻辑**（daemon 段仍只来自 daemonSnapshot）。
  registerExplorer(ctx, {
    config,
    listDistros,
    listDistrosAsync,
    resolveVersion,
    writePin,
    webHosts,
    // A1（task-23）：`explorer.addWorkspace` 要调 host 的 `workspaceRegistry`（T11 实测的服务名）。
    // 这里只给一个**取服务**的闭包：服务没挂上时返回 undefined，由 explorer.ts 侧给可读 503 + 一行降级日志。
    workspaceRegistry: () => (typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined),
    // 2026-10-22：面板「在此目录新建会话」= 真正的 DSH 会话（sessionController.create({cwd})）。
    sessionController: () => (typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined),
  });

  // 2026-10-23：注册 WSL 执行世界的 agent preset（`wsl`）。文件工具通过它的 isolate realm
  // 挂上本插件的 `ctx.fs` provider（src/fs-provider.ts），读写走 WSL 原生 node:fs，不碰 9P。
  // 服务不可用时 preset.ts 会明确打一行，不静默跳过。
  applyWslPreset(ctx, config);
  // 插件卸载时回收常驻进程（idle 定时器之外的第二道保险）。
  // ⚠️ disposer 必须**可等待**：早前写成 `void rt.close()`（不 await），宿主/测试一退出就把清理
  // 截断，WSL 侧会留下 .sh/.pid（2026-10-10 实测）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      // 语义 #4：**不杀守护** —— 守护持有的就是"远端会话"，杀掉它等于把跨宿主复用一起杀掉。
      // 这里只回收**本宿主进程**持有的东西：in-host 逃生舱的运行时 + web host。
      // 要显式结束远端会话，请用 wsl_daemon action=stop（唯一有意的停止入口）。
      lifecycle.beginShutdown();
      await Promise.allSettled([...runtimes.values()].map((rt) => rt.close()));
      await Promise.allSettled([...webHosts.values()].map((h) => h.stop()));
      // 等本插件 spawn 的 wsl.exe 包装层退出；超时只 kill 自己记录的（绝不动发行版）
      const trackedAtDispose = lifecycle.size();
      const settled = await lifecycle.settle(5000);
      // 诊断行（2026-10-23 宿主退出 e2e 探针要的证据面）：settle 的五个字段只有 in-process 才看得见，
      // 而"真宿主 dispose 有没有误判超时/有没有等到自己的包装层"必须能从进程外部（stderr）判定。
      // 只在显式打开时输出：正常用户不该看到这行噪音；探针用 DSH_REMOTE_WSL_DIAG=1 起隔离实例。
      if (process.env.DSH_REMOTE_WSL_DIAG === '1') {
        process.stderr.write(
          'remote-wsl: 关停结算 tracked=' +
            trackedAtDispose +
            ' waitedMs=' +
            settled.waitedMs +
            ' killed=' +
            settled.killed +
            ' remaining=' +
            settled.remaining +
            ' timedOut=' +
            settled.timedOut +
            ' forced=' +
            settled.forced +
            '\n',
        );
      }
      if (settled.timedOut) {
        process.stderr.write(
          'remote-wsl: 关停超时；已 kill 自己 spawn 的包装层 ' +
            settled.killed +
            ' 个（发行版与守护不动，剩余 ' +
            settled.remaining +
            '）\n',
        );
      }
      await sweepOwnTempFiles(config); // 自有 /tmp 一次性文件（按 winpid）——不碰别人的
      if (config.backend !== 'in-host') {
        process.stderr.write('remote-wsl: 宿主退出；WSL 侧守护保持运行（关客户端 ≠ 会话结束）\n');
      }
    });
  }
}
