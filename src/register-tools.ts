/**
 * dsh-remote-wsl / register-tools —— **七个工具**的注册面 + `dsh web` 宿主（T5/task-44 从 index.ts 逐字搬运）。
 *
 * 工具名/参数/输出形状与拆分前**逐字一致**：`wsl_status` / `wsl_exec` / `wsl_agent` / `wsl_daemon` /
 * `wsl_open_ui` / `wsl_sync_version` / `wsl_path`。本模块只持有**注册面**：状态（`daemonState`/`runtimes`/
 * `webHosts`/就绪判定/版本解析）全部经 `deps` 注入 —— "谁能起进程"仍只有 index.ts 一处决定。
 *
 * @module dsh-remote-wsl/register-tools
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { shellEnvSnippet, parseLocalhostForwarding } from './shell-env.ts';
import { desktopRuntimeCandidates, pickDesktopVersion, warmScript, dlxInventoryScript } from './version.ts';
import {
  ensureDaemon, stopDaemon, daemonPrompt, daemonStatus, daemonSnapshot, readDaemonMeta, stateDirLinux, unc,
} from './daemon-client.ts';
import { withModulePrefix } from './explorer.ts';
import { presetStatus } from './preset.ts';
import { targetProblem, configDetection, refreshAutoTarget, REDETECT_HINT, configWarnings } from './config.ts';
import { routeMismatch } from './daemon-launch.ts';
// T47（P0 修复，**只加这一行 import，逻辑一行未改**）：`WebHost.start()` 的脚本里有
// `exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@<v> web --port <p>`。
// 根因链：T1 把 `ALLOW_BUILDS`/`allowBuildFlags` 唯一化到 `src/sdk-runtime.ts`；T5 把「七个工具的注册面」
// 从 index.ts 拆到本文件时**漏了这一行 import** ⇒ 零构建 TS **import 期不报错**，真调 `wsl_open_ui`
// 的启动路径才抛 `ReferenceError: allowBuildFlags is not defined`（同型第三次：T3 的 `spawn`、T5 的 `wsl-io.ts`）。
import { allowBuildFlags } from './sdk-runtime.ts';
import { cdPreamble, killIfOwnedScript, shq } from './shell-quote.ts';
import { PLUGIN_VERSION, PROTOCOL_VERSION } from './plugin-version.ts';
// T47：`reapWsl` 是 `WebHost.stop()` 用的（杀包装层后必须收回 WSL 侧的 `dsh web`，否则它变孤儿继续占端口）。
// 与上一行同型：T5 拆分时漏了 import，`{stop:true}` 真调（**已起过一个 web host** 之后）才炸 ReferenceError。
import { runWsl, wslPathConvert, sweepOwnTempFiles, readLogViaWsl, shellPreamble, writeScript, removeScript, reapWsl, sleep, renderText, resolveVersion, readPin, writePin } from './wsl-io.ts';

// ── 远端 UI：WSL 跑 `dsh web`，Windows 开应用窗口 ─────────────────────────────

export class WebHost {
  constructor(cfg, version, lifecycle = null, internals = {}) {
    this.cfg = cfg;
    this.version = version;
    // 关停屏障（参考 ZCode 的 dispose 纪律）：dispose 开始后不再起新 host；起了的登记给 settle 等退出。
    this.lifecycle = lifecycle;
    this.spawnImpl = typeof internals.spawn === 'function' ? internals.spawn : spawn;
    this.url = null;
    this.stderrTail = '';
  }

  async start() {
    // ★ T60 根因修复：**只有"真的起来了"（url 有值）才算可用态、才允许早退**。
    //   原来是 `if (this.child) return this.url;` —— 失败时 `child` 已置、`url` 仍空，而宿主把它留在
    //   `webHosts` 里 ⇒ 同端口第二次调用 **0ms 返回 null 且报 OK**（静默假成功，T55 抓到）。
    //   现在：可用 ⇒ 复用；上次失败留下的半死状态（child 有、url 无）⇒ 先收干净再**重新真起**。
    if (this.url) return this.url;
    if (this.child) await this.#discardFailedAttempt();
    if (this.lifecycle) this.lifecycle.assertAlive(); // 关停开始后拒绝起新 web host
    // 同 SdkRuntime：常驻进程才注入登录 shell 环境
    // 2026-10-27 审查 F-09：写唯一的 `DSH_RWSL_MARK`（= 脚本基名，带随机后缀），供 `reapWsl` /
    // `sweepStaleRuntimes` 在发信号之前核对「这个 pid 确实是本插件起的那个进程」，避免 pid 复用误杀。
    // cwd 走 shq：配置值也不裸插值（纵深防御）。
    const script = `${shellPreamble(this.cfg, { withShellEnv: true })}${cdPreamble(this.cfg.wslHome)}
echo $$ > "\${0%.sh}.pid"
export DSH_RWSL_MARK="$(basename "\${0%.sh}" .sh)"
exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} web --port ${this.cfg.webPort} --no-open
`;
    this.script = writeScript(this.cfg.distro, script);
    this.child = this.spawnImpl('wsl.exe', ['-d', this.cfg.distro, '--exec', 'bash', this.script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (this.lifecycle) this.lifecycle.track(this.child);
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c).slice(-4000);
    });
    let url;
    try {
      url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`remote-wsl: web 未在 60s 内给出 URL\n${this.stderrTail}`)),
        60000,
      );
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        buf += chunk;
        const m = buf.match(/https?:\/\/[^\s]*\?token=[A-Za-z0-9_-]+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      this.child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`remote-wsl: web 进程退出（exit ${code}）\n${this.stderrTail}`));
      });
      });
    } catch (e) {
      // 失败**不**留半死对象/残留：清 child+script+WSL 侧进程+/tmp 脚本，再原样上抛可读错误
      await this.#discardFailedAttempt();
      throw e;
    }
    if (!url) {
      await this.#discardFailedAttempt();
      throw new Error('remote-wsl: web 启动未返回 URL（内部状态不一致）');
    }
    this.url = url;
    this.child.stdout.removeAllListeners('data');
    this.child.stdout.resume(); // 起完就排空，避免管道回压
    return url;
  }

  /**
   * 丢掉一次**失败尝试**留下的状态：半死的 `wsl.exe` 包装层、WSL 侧 `dsh web`、`/tmp` 一次性脚本。
   *
   * 为什么需要（T60 根因）：`start()` 原先把 `this.child` 当成"可用"的判据，失败时 `child` 已置、
   * `url` 仍空 ⇒ 同端口重试直接返回空 URL。把状态清回初始，重试就会**真的重新启动**（或再次给出可读错误），
   * 同时不留孤儿与 `/tmp` 残留（T55 曾测到"失败路径不自清"）。
   */
  async #discardFailedAttempt() {
    const child = this.child;
    this.child = null;
    this.url = null;
    try {
      child?.kill();
    } catch {
      /* 已退出 */
    }
    await reapWsl(this.cfg, this.script); // 包装层被杀 ≠ Linux 侧退出（T55 实测：超时态会留孤儿）
    removeScript(this.cfg.distro, this.script);
    this.script = null;
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.url = null;
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    await reapWsl(this.cfg, this.script); // 必须：否则 WSL 里的 dsh web 会变孤儿继续占端口
    removeScript(this.cfg.distro, this.script);
    await sweepOwnTempFiles(this.cfg); // 本进程自有的 /tmp 一次性文件：按 winpid 收干净（task-9 #7）
  }
}

/**
 * 清理**陈旧/孤儿**的 in-host 运行时文件。
 *
 * 两类判据（P2 补齐第二类）：
 *  1. **属主宿主已死**（旧判据）：pid 文件名里带 Windows 宿主 PID（`dsh-rwsl-<winpid>-<ts>-<rand>.pid`），
 *     `process.kill(winPid, 0)` 判活 ⇒ 宿主崩了才清（不碰其它 DSH 窗口正在用的运行时）。
 *  2. **属主就是本进程、且文件里记的 linux 运行时 pid 已经死了**（新判据）：活宿主的陈旧文件不该拖到
 *     显式 `wsl_open_ui stop` / 卸载才收敛 —— "文件陈旧"的判据不该只看宿主死活。
 * 安全边界（Lead 定的纪律）：**绝不**碰"他人 winpid 且其宿主还活着"的文件；只对自己或已死的属主动手。
 */
export async function sweepStaleRuntimes(cfg) {
  const listed = await runWsl(
    cfg,
    `for f in /tmp/dsh-rwsl-*.pid; do [ -f "$f" ] || continue; printf '%s %s\\n' "$f" "$(cat "$f" 2>/dev/null)"; done
true
`,
    { timeoutMs: 20000 },
  );
  const files = [];
  for (const line of listed.stdout.split('\n')) {
    const m = line.trim().match(/^(\/tmp\/dsh-rwsl-(\d+)-[^ ]*\.pid) (\d+)$/);
    if (!m) continue;
    files.push({ pidFile: m[1], winPid: Number(m[2]), linuxPid: Number(m[3]) });
  }
  if (!files.length) return 0;
  // 一次性批量探测 linux pid 是否还活着（每条一次 wsl.exe 太贵）
  const alive = new Set<number>();
  {
    const probes = files.map((f) => `kill -0 ${f.linuxPid} 2>/dev/null && echo "${f.linuxPid} alive" || true`).join('\n');
    const res = await runWsl(
      cfg,
      `${probes}
true
`,
      { timeoutMs: 20000 },
    );
    for (const line of res.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+) alive$/);
      if (m) alive.add(Number(m[1]));
    }
  }
  const hostAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e && e.code === 'EPERM'; // 存在但没权限 = 仍活着
    }
  };
  const stale = files.filter((f) =>
    f.winPid === process.pid ? !alive.has(f.linuxPid) : !hostAlive(f.winPid),
  );
  if (!stale.length) return 0;
  // 身份闸（2026-10-27 审查 F-09）：pid 可能已被复用（宿主崩溃 + WSL 重启/长时间运行），旧实现
  // 直接 `kill -TERM <pid>` 并连带 `pkill -P`（还完全不引号）⇒ 会误杀无关进程，文件名还能注入命令。
  // 现在：① 先核对进程环境里的唯一标记 `DSH_RWSL_MARK`（启动脚本写入，跨重启不重合）；
  //       ② 旧脚本（本提交之前起的）没有该标记时，退回「cmdline 含 @deepseek-ai/dsh」的弱判据；
  //       ③ 都不符就**只删残留文件、不发信号**；所有路径单引号转义。
  const script = stale
    .map((s) => {
      const mark = s.pidFile.replace(/^.*\//, '').replace(/\.pid$/, '');
      const sh = s.pidFile.replace(/\.pid$/, '.sh');
      const mjs = s.pidFile.replace(/\.pid$/, '.mjs');
      return [`p=${s.linuxPid}`, killIfOwnedScript('$p', mark), `rm -f ${shq(s.pidFile)} ${shq(sh)} ${shq(mjs)}`].join('\n');
    })
    .join('\n');
  await runWsl(cfg, `${script}
true
`, { timeoutMs: 20000 });
  return stale.length;
}

/** 在 Windows 侧把 URL 开成"应用窗口"（Edge/Chrome 的 --app），失败则退回默认浏览器。 */
export function openAppWindow(url) {
  for (const browser of ['msedge', 'chrome']) {
    const res = spawnSync('cmd', ['/c', 'start', '', browser, `--app=${url}`], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (!res.error && res.status === 0) return 'app-window';
  }
  const fallback = spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
  return !fallback.error && fallback.status === 0 ? 'default-browser' : 'failed';
}

/**
 * 把 `runWsl` 的**结构化**终止原因翻成一行可读事实（F-33，2026-10-27 第三轮）。
 *
 * 为什么不直接打印 `exit ${exitCode}`：命令自己 `exit 124`（`timeout(1)` 的既有约定）与
 * 「插件超时把它杀了」在退出码上**完全一样**，只看码就会把责任判错。`killedBy` 由我们自己的
 * 定时器 / 中断监听置位（见 `wsl-io.terminationOf`），是唯一可信来源。
 *
 * @param res `runWsl` 的返回值（老调用方可能没有 `killedBy`，按"命令自己退出"降级展示）
 */
function describeWslTermination(res) {
  const code = res?.exitCode;
  const kind = res?.killedBy;
  if (kind === 'timeout') {
    return `exit ${code}（**超时终止**：墙钟上限到点后由插件杀掉，不是命令自己的退出码；WSL 侧可能仍有残留进程，必要时用 wsl_exec 复核）`;
  }
  if (kind === 'abort') return `exit ${code}（**调用方中断**：本次调用被取消，命令是被插件杀掉的）`;
  if (kind === 'signal') return `exit ${code}（**被信号 ${res?.killedBySignal ?? '未知'} 终止**）`;
  if (kind === null) return `exit ${code}（**未能启动**：见 stderr）`;
  return `exit ${code}`;
}

/**
 * `wsl_status` 的 WSL 命令通道健康度（纯函数，便于单测）。
 *
 * 为什么要单独报：daemon TCP 还活着 ≠ 新 `wsl.exe` 进程能跑。实测 WSL VM 卡住/OOM 时，
 * `wsl.exe --exec` 会一直不返回，而既有 daemon socket 仍能握手；只看 daemon 会把问题误报成
 * 「守护正常」。这里把 `killedBy` 结构化事实翻成可操作结论，并明确插件**不会**自动杀 WSL/守护。
 *
 * @param res `runWsl` 的返回值；`null`/`undefined` = 没有探测
 */
export function wslExecHealthNote(res) {
  if (!res) return 'not-probed';
  const kind = res?.killedBy;
  if (kind === 'timeout') {
    return '⚠️ timeout（wsl.exe 新进程超时；daemon 可能仍 running，疑似 WSL VM/资源卡住；先 wsl --shutdown 后重试，插件不会自动杀）';
  }
  if (kind === 'abort') return '⚠️ aborted（本次状态查询被取消）';
  if (kind === 'signal') return `⚠️ signal ${res?.killedBySignal ?? 'unknown'}（wsl.exe 被信号终止）`;
  if (kind === null) return '⚠️ not-started（wsl.exe 未启动，见 stderr）';
  const code = res?.exitCode;
  if (code !== 0) {
    const tail = String(res?.stderr ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    return `⚠️ exit ${code}${tail ? `（${tail}）` : ''}`;
  }
  return 'ok';
}

/**
 * 把「会话内重探」的结果渲染成输出行（**纯函数**，便于单测；A-P2-E / 复核 S2-4、S3-3、S5）。
 *
 * 单独抽出来的理由：`wsl_status.execute` 已经很长，重探渲染与路线告警是两件无关的事（Divergent Change）；
 * 且这部分有分支语义（显式配置 / 换发行版 / 失败），值得直接断言而不是靠整段输出正则。
 *
 * @param result `refreshAutoTarget()` 的返回值（或测试桩）；`null` ⇒ 不渲染任何行
 * @param config 归一后的配置（取更新后的 distro/wslHome/cwd）
 * @returns 输出行数组（空数组 = 没有重探）
 */
export function renderRedetectResult(result, config) {
  if (!result) return [];
  if (result.ok !== true) {
    return [`redetect: ⚠️ 重新探测仍失败：${result.problem ?? '未知原因'}（可稍后重试；显式配置 distro/wslHome 可完全跳过探测）`];
  }
  if (result.auto === false) {
    return ['redetect: ℹ️ 目标来自**显式配置**（distro/wslHome 都已指定）⇒ 无需重探；本次未发起 wsl.exe，值未变'];
  }
  const lines = [
    `redetect: ✅ 已重新探测：distro=${config.distro} wslHome=${config.wslHome} cwd=${config.cwd}` +
      `${result.changed ? '（已更新配置）' : '（与之前相同）'}；宿主侧工具（wsl_exec / wsl_agent / 面板）立即生效。` +
      `⚠️ wsl 预设的文件/搜索子插件是**注册时快照**，需重启 DSH 才跟随新目标。`,
  ];
  const prevDistro = result.previous?.distro ?? '';
  const nextDistro = result.current?.distro ?? '';
  if (prevDistro && nextDistro && prevDistro !== nextDistro) {
    lines.push(
      `redetect: ⚠️ 目标发行版已从 "${prevDistro}" 换到 "${nextDistro}"：旧发行版里若有守护，` +
        `它的元数据与 /proc 孤儿扫描都不在新目标内 ⇒ 既不会被复用、也不会被 stop/orphan 扫到。` +
        `如需收尾，先显式配回旧 distro 再 wsl_daemon action=stop；否则接受它自行退出（仍有 key 时不会自退）。`,
    );
  }
  return lines;
}

/**
 * 注册七个工具。`deps` 由 index.ts 的 apply 提供（拆分前它们是同一闭包里的自由变量；这里改用**同名解构**
 * ⇒ 下面七个 `tools.register` 的函数体逐字未改）。
 */
export function registerTools(deps) {
  const {
    ctx, config, version, resolveVersion, daemonState, logDaemon, machineLine, ensureDaemonReady,
    isTransportFailure, priorSessionFor, listDistros, listDistrosAsync, getRuntime, runtimes, webHosts, ensureSwept, warmInBackground,
  } = deps;
  // A-P2-E（2026-10-28 复核补修）：会话内重新探测目标。默认走 config.refreshAutoTarget（原地更新
  // 同一个 config 对象，所有宿主侧消费方立即读到新值）；测试可注入桩替换，避免依赖本机 WSL 状态。
  const redetectTarget = typeof deps?.redetectTarget === 'function' ? deps.redetectTarget : () => refreshAutoTarget(config);

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');
    if (!tools) return;

    tools.register({
      name: 'wsl_status',
      description:
        'Report the WSL remote-host picture: available distros, the DSH desktop version this Windows install runs, the version pinned inside WSL, any drift between them, the dsh versions already materialized in the WSL pnpm dlx cache, the shell-environment injection switch, the localhostForwarding setting that the WSL2 port forwarding depends on, the resident remote runtimes this plugin holds, and the effective WSL identity (actual distro/user/home/platform/arch). Read-only and cheap; call it before blaming the remote side. Pass `redetect: true` to re-run target auto-detection in-session (clears the process-wide cache and re-probes; explicit distro/wslHome are never overwritten).',
      parameters: {
        type: 'object',
        properties: {
          redetect: {
            type: 'boolean',
            description:
              'Re-run target auto-detection once **in this session** and apply it (clears the process-wide detection cache, then re-probes the default distro + $HOME). ' +
              'Use it when the target is unresolved because WSL was cold/hung at DSH startup — no DSH restart needed for host-side tools (wsl_exec / wsl_agent / wsl_status / panel). ' +
              'Explicit distro/wslHome/cwd are never overwritten. Note: the `wsl` agent preset snapshots its config at registration, so its file/search tools still need a DSH restart.',
          },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        // A-P2-E（2026-10-28 复核补修）：显式要求时先重探一次 —— 必须发生在 targetProblem() 之前，
        // 否则整段输出仍按旧的空目标跳过所有 WSL 探测。
        const redetectResult = args?.redetect === true ? redetectTarget() : null;
        const cfgWarnings = configWarnings(config);
        // F-15（2026-10-27 审查）：状态查询不再用同步 spawnSync（会阻塞宿主事件循环）；异步版失败
        // 时返回空数组，这里如实标成「读不到」而不是"没有发行版"。
        const distros = listDistrosAsync ? await listDistrosAsync() : listDistros();
        const distrosReadFailed = Array.isArray(distros) && distros.length === 0;
        // 2026-10-28（零配置）：目标现在可能是自动探测的结论。探测失败时先把根因算出来 ——
        // 后面的 WSL 探测一律跳过（否则会在"空发行版"上白白 spawn 一串 wsl.exe，报出无关错误）。
        const targetIssue = targetProblem(config);
        // 读**本份配置自带**的探测结论（不是"最近一次探测"）：热重载/多份配置时不会张冠李戴。
        const detection = configDetection(config);
        // F-43（2026-10-27 审查）：配置的目标发行版不在列表里时，旧实现只是"调用会失败"，状态输出不标红。
        const targetMissing = !targetIssue && Array.isArray(distros) && distros.length > 0 && !distros.includes(config.distro);
        const v = resolveVersion(config);
        // 孤儿运行时诊断（只数，不杀；真正的清理在首次有副作用的调用上做）。
        // F4：**不走内联 `wsl.exe … -- bash -lc "<串>"`** —— 那条路不是 argv-exec，串会先经过发行版的
        // 默认登录 shell（本机 zsh）展开，`$VAR`/glob 在到达 bash 前就失真。这里走 runWsl（落文件 +
        // `bash <file>`），并用 `find … -print | wc -l` 而不是裸 glob（glob 未匹配时会给出"假 0"）。
        let pidFiles = '0';
        if (targetIssue) {
          pidFiles = '(跳过：目标发行版未确定)';
        } else {
          const res = await runWsl(config, 'find /tmp -maxdepth 1 -name "dsh-rwsl-*.pid" -print | wc -l\n', {
            timeoutMs: 8000,
            signal: exec?.signal,
          });
          pidFiles = (res.stdout || '').trim() || '0';
        }
        // ── 一次性探测：WSL ip + WSL 里已物化的 dlx dsh 版本 ──────────────────────
        // 两件事合成**一次** wsl.exe 调用：wsl.exe 的启动开销（约 1s）比分段探测本身贵，
        // 用一行哨兵分隔两段 stdout，解析仍是逐字的（哨兵没出现就说明整段没跑到）。
        const MARK = '__REMOTE_WSL_DLX_MARK__';
        let ip = '(未探测)';
        let dlx = '(未探测)';
        let identity = targetIssue ? '(跳过：目标发行版未确定)' : '(未探测)';
        let wslExecNote = targetIssue ? '(跳过：目标发行版未确定)' : '(未探测)';
        if (!targetIssue && distros.includes(config.distro)) {
          const res = await runWsl(
            config,
            `${shellPreamble(config)}hostname -I
echo ${MARK}
${dlxInventoryScript({ wslHome: config.wslHome })}`,
            { timeoutMs: 12000, signal: exec?.signal },
          );
          wslExecNote = wslExecHealthNote(res);
          const lines = res.stdout.split('\n').map((s) => s.trim());
          const at = lines.indexOf(MARK);
          if (at >= 0) {
            ip = lines.slice(0, at).filter(Boolean).join(' ');
            const versions = lines.slice(at + 1).filter(Boolean);
            dlx = versions.length ? versions.join(', ') : '(none)';
          } else {
            // 哨兵缺失 ⇒ 脚本没跑到。这里**不能**报 "none"（那是"确认没装"的意思，会臆造事实）
            ip = `(探测失败: ${res.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''})`;
            dlx = '(探测失败)';
            if (wslExecNote === 'ok') wslExecNote = '⚠️ 输出不完整（缺少哨兵，不能当成"没有"）';
          }
          // ZCode 对照（2026-10-29 第三轮）：不只报配置值，报**实际** WSL 身份/平台/架构；
          // 便于发现 root/default user 差异和 arm64 工具供给问题。单独一次调用，异常不阻断状态主体。
          // 若上面已经 timeout，再发一次 wsl.exe 只会白等：明确跳过并保留根因。
          if (res.killedBy === 'timeout') {
            identity = '(跳过：WSL 命令通道超时)';
          } else {
            const idRes = await runWsl(
              config,
              `${shellPreamble(config)}printf '%s\\n' "\${WSL_DISTRO_NAME:-}"
id -un
printf '%s\\n' "$HOME"
uname -s
uname -m
`,
              { timeoutMs: 5000, signal: exec?.signal },
            );
            const idHealth = wslExecHealthNote(idRes);
            if (idHealth !== 'ok') wslExecNote = idHealth;
            const idLines = idRes.stdout.split('\n').map((s) => s.trim());
            if (idRes.exitCode === 0 && idLines.length >= 5) {
              const [actualDistro, actualUser, actualHome, platform, arch] = idLines;
              identity =
                `distro=${actualDistro || config.distro} user=${actualUser || '(unknown)'} ` +
                `home=${actualHome || config.wslHome || '(unresolved)'} platform=${platform || '(unknown)'} arch=${arch || '(unknown)'}`;
            } else {
              identity = `(探测失败: ${idRes.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${idRes.exitCode}`})`;
            }
          }
        }

        // ── localhostForwarding：读两个配置文件的**原文**，判定交给 lib/shell-env.js 的纯函数 ──
        // 为什么读原文而不在这里写解析：INI 的段/键大小写、`;`/`#` 注释、重复键取第一条、布尔只认
        // true/false/1/0 —— 这些 WSL 自己的语义已在 shell-env.js 里对着 WSL 源码核过，读侧不该有第二份。
        // 读不到就报 (unknown)：配置读不出来时"转发开着"是猜测，而猜错会让调用方静默连不上。
        const readCfgText = (p) => {
          if (!p) return { text: undefined, why: '路径未知' };
          try {
            return { text: readFileSync(p, 'utf8') };
          } catch (e) {
            return { text: undefined, why: e?.code ?? 'unreadable' };
          }
        };
        const winCfg = readCfgText(process.env.USERPROFILE ? join(process.env.USERPROFILE, '.wslconfig') : '');
        // 目标未确定时 `unc('', …)` 会拼出 `\\wsl.localhost\\\etc\wsl.conf` —— 那不是"读不到配置"，
        // 而是"根本不知道读哪个发行版"，所以直接说明，不去读一个不存在的 UNC。
        const distroCfg = config.distro ? readCfgText(unc(config.distro, '/etc/wsl.conf')) : { text: undefined, why: '目标发行版未确定' };
        const lf = parseLocalhostForwarding({ wslconfigText: winCfg.text, wslConfText: distroCfg.text });
        const readWhat = [winCfg.text !== undefined ? '.wslconfig' : null, distroCfg.text !== undefined ? '/etc/wsl.conf' : null]
          .filter(Boolean)
          .join(' + ');
        const lfLine =
          lf.value !== null
            ? `${lf.value}  <- ${lf.source}（networkingMode=mirrored 时该键被忽略）`
            : readWhat
              ? `(未设置；WSL 默认 = true)  <- 读过 ${readWhat}`
              : `(unknown)  <- .wslconfig ${winCfg.why}；/etc/wsl.conf ${distroCfg.why}`;
        // ── 守护可见性（语义 #4 / #5）──────────────────────────────────────────
        // 显示 pid/端口/version/keys；版本与桌面/pin 不一致时**只报警**，绝不自动杀守护
        // （自动杀 = 无声中断用户正在进行的会话）。换版本走显式 wsl_daemon action=restart。
        const dstat: any =
          targetIssue
            // 目标未确定：`daemonStatus` 的"没有守护"结论会误导（它其实什么都没扫）。直接给原因。
            ? { ok: false, kind: 'no-target', error: targetIssue }
            : config.backend === 'in-host'
              ? { ok: false, kind: 'in-host', error: 'in-host 后端不使用守护' }
              : await daemonStatus(config);
        let daemonLine: string;
        let daemonAlarm: string | null = null;
        let daemonPluginAlarm: string | null = null;
        // A-P1-A（2026-10-28 复核）：用户必须能一眼看出"守护实际在用什么 provider/model"。
        let daemonRouteAlarm: string | null = null;
        const orphanDaemons: any[] = Array.isArray(dstat.orphans) ? dstat.orphans : [];
        if (dstat.ok) {
          const info = dstat.info ?? {};
          const ks: any[] = Array.isArray(info.keys) ? info.keys : [];
          daemonLine =
            `running pid=${info.daemonPid} actualPort=${info.port} slot=${dstat.slot} version=${info.version} ` +
            `plugin=${info.pluginVersion ?? 'unknown'} protocol=v${info.protocolVersion ?? 0} ` +
            `provider=${info.provider ?? 'unknown'} model=${info.model ?? 'unknown'} ` +
            `uptime=${Math.round((info.uptimeMs ?? 0) / 1000)}s idleMs=${info.idleMs} lingerMs=${info.lingerMs} keys=${ks.length} ` +
            `[${ks.map((k) => `${k.key}(turn ${k.turns}${k.queued ? `,q${k.queued}` : ''}${k.runtimePid ? `,pid${k.runtimePid}` : ''})`).join(', ') || '(none)'}]`;
          // A-P1-A：配置与守护的 provider/model 必须当场比对 —— 复用旧守护时这里就是唯一的可见面。
          // 判定收口在 daemon-launch.routeMismatch（复核 S3-6），这里只按 kind 选文案。
          const route = routeMismatch(info, config);
          if (route.kind === 'unreported') {
            daemonRouteAlarm =
              `守护没有上报实际 provider/model（0.3.4 之前的旧守护）⇒ 无法校验本次配置（${route.host.provider ?? '?'}/${route.host.model ?? '?'}）` +
              `是否生效；执行 wsl_daemon action=restart 后状态里会显示实际生效值`;
          } else if (route.kind === 'mismatch') {
            daemonRouteAlarm =
              `守护实际 provider/model = ${route.daemon.provider}/${route.daemon.model}，本次配置 = ${route.host.provider ?? '?'}/${route.host.model ?? '?'}` +
              ` —— **配置改了但守护还是旧进程**（不自动重启，避免无声中断正在进行的会话）；执行 wsl_daemon action=restart 才会用新值` +
              `（会丢当前会话上下文）`;
          }
          // 漂移报警（task-9 #3）：**显式 config.dshVersion / 桌面版本 / wsl pin 三者都要比**。
          // 只比后两者会漏判：`dshVersion:'0.1.0-fake'` 而守护跑 0.2.0-rc.2 时曾完全没有报警。
          const expects: Array<{ label: string; value: string }> = [];
          if (config.dshVersion) {
            expects.push({ label: `显式 config.dshVersion ${config.dshVersion}`, value: String(config.dshVersion) });
          }
          if (v.desktopVersion) expects.push({ label: `桌面 ${v.desktopVersion}`, value: v.desktopVersion });
          if (v.pin) expects.push({ label: `wsl pin ${v.pin}`, value: v.pin });
          const bad = expects.filter((e) => info.version !== e.value);
          if (bad.length) {
            daemonAlarm =
              `守护持有的 dsh@${info.version} 与 ${bad.map((b) => b.label).join(' / ')} 不一致 —— ` +
              `不自动重启（避免无声中断正在进行的会话）；要换版本请显式执行 wsl_daemon action=restart（配合 backgroundWarm 很快）`;
          }
          // 换角度评审第 1 条：插件/协议版本错配。守护是 detached 的 ⇒ 宿主升级后旧守护仍活着是常态；
          // 旧守护不认识 fs.readChunk、也没有 meta.retired，必须让用户看到"restart 后才生效"。
          const daemonProtocol = Number.isFinite(Number(info.protocolVersion)) ? Number(info.protocolVersion) : null;
          if (info.pluginVersion && info.pluginVersion !== PLUGIN_VERSION) {
            daemonPluginAlarm =
              `守护插件 ${info.pluginVersion}（协议 v${daemonProtocol ?? 0}）≠ 宿主 ${PLUGIN_VERSION}（协议 v${PROTOCOL_VERSION}）` +
              ` —— 新功能（流式读取、退役会话提示等）在 restart 前不可用；执行 wsl_daemon action=restart 对齐`;
          } else if (daemonProtocol == null || daemonProtocol < PROTOCOL_VERSION) {
            daemonPluginAlarm =
              `守护没有上报协议版本（旧插件）或协议更旧（v${daemonProtocol ?? 0} < v${PROTOCOL_VERSION}）` +
              ` —— 新功能在 restart 前不可用；执行 wsl_daemon action=restart 对齐`;
          }
        } else if (dstat.kind === 'no-target') {
          // 2026-10-28（零配置）：目标未确定 ⇒ 没扫过任何东西，不能写成 "not running"（那是结论）。
          daemonLine = `（跳过：目标发行版未确定 ⇒ 未检查守护；${String(dstat.error ?? '').replace(/^remote-wsl: /, '')}）`;
        } else if (dstat.kind === 'busy') {
          // F-18（2026-10-27 审查）：端口可连但 3s 内没应答 ⇒ 「忙」，不是「死」。绝不能提示 stop all，
          // 那会杀掉带会话的健康守护（守护是单线程，安装工具/预热时会长时间不应答）。
          daemonLine = `busy（端口可连接但 ${config.daemonHandshakeTimeoutMs}ms 内没有应答；可能正在安装工具/预热）—— **不是死**，稍后重试即可；不要据此执行 stop all；若持续如此再 wsl_daemon action=restart`;
        } else {
          daemonLine = `not running（${dstat.kind}: ${dstat.error}）`;
        }
        const ps = presetStatus();
        const presetLine =
          ps.phase === 'registered'
            ? ps.broken
              ? `注册但 broken（UI 不可选）：${String(ps.broken).replace(/\n/g, ' | ')}`
              : `已注册（id=wsl，plugins=${ps.plugins}）`
            : ps.phase === 'failed'
              ? `注册失败：${ps.broken ?? 'unknown'}`
              : ps.phase === 'unavailable'
                ? '不可用（该 DSH 版本不支持运行时注册 preset）'
                : ps.phase === 'registering'
                  ? '注册中'
                  : '未初始化（插件未加载？）';
        return [
          `plugin: dsh-remote-wsl@${PLUGIN_VERSION}（版本 = 本仓 package.json；升级/回滚见 README）`,
          ...(cfgWarnings.length
            ? [`config: ⚠️ ${cfgWarnings.join('；')}（已按默认值继续运行；要真正生效请改 cordis.patch.yml）`]
            : []),
          `distros: ${distros.join(', ') || (distrosReadFailed ? '(读不到：wsl.exe -l -q 失败，不等于“没有发行版”)' : '(none)')}`,
          ...(targetIssue
            ? [`target ⚠️: ${targetIssue}`]
            : targetMissing
              ? [
                  `target ⚠️: 配置的发行版 "${config.distro}" **不在上面的 distros 列表里** —— 所有 WSL 调用都会失败。改 cordis.patch.yml 的 distro（README「配置」一节）。`,
                ]
              : []),
          ...(detection && !detection.problem && detection.notes.length
            ? [`target auto-detected: ${detection.notes.join('；')}（显式配置 distro/wslHome 可完全跳过探测）`]
            : []),
          `target: ${config.distro || '(未解析)'}  wslHome=${config.wslHome || '(未解析)'}  cwd=${config.cwd || '(未解析)'}`,
          `identity: ${identity}`,
          `wsl exec: ${wslExecNote}`,
          ...renderRedetectResult(redetectResult, config),
          `wsl ip: ${ip}`,
          `shell env injection (useShellEnvironment): ${config.useShellEnvironment === false ? 'off' : 'on'}（只注入常驻进程 wsl_agent / wsl_open_ui；wsl_exec 的一次性路径不注入）`,
          `localhost forwarding: ${lfLine}`,
          `desktop dsh version: ${v.desktopVersion ?? '(unknown)'}${v.desktopSource ? `  <- ${v.desktopSource}` : ''}`,
          `version this plugin uses: ${v.version ?? '(unresolved)'}`,
          `wsl pin: ${v.pin ?? '(none)'}`,
          `drift: ${v.drift ? `YES (desktop ${v.drift.desktop} / pin ${v.drift.pin})` : 'no'}`,
          `dlx dsh versions in WSL: ${dlx}`,
          // 换角度评审第 7 条：把"缓存里有几个版本/可清理"显式说出来，避免磁盘只增不减还没人知道。
          ...(dlx && !/^\(/.test(String(dlx)) && String(dlx).split(',').filter((x) => x.trim()).length > 1
            ? [
                `dlx cache: WSL 里物化了 ${String(dlx).split(',').filter((x) => x.trim()).length} 个 dsh 版本（老版本可在 ~/.npm/_npx 清理；不影响插件，下次用到会重下）`,
              ]
            : []),
          `backend: ${config.backend === 'in-host' ? 'in-host（逃生舱：运行时由本宿主进程持有，关客户端即丢会话）' : 'daemon（默认：运行时由 WSL 侧常驻守护持有，关客户端 ≠ 会话结束）'}`,
          `daemon: ${daemonLine}`,
          ...(daemonAlarm ? [`daemon drift: ⚠️ ${daemonAlarm}`] : []),
          ...(daemonPluginAlarm ? [`daemon plugin: ⚠️ ${daemonPluginAlarm}`] : []),
          ...(daemonRouteAlarm ? [`daemon route: ⚠️ ${daemonRouteAlarm}`] : []),
          `daemon idle/linger/queue: idleMs=${config.daemonIdleMs}（到期回收运行时 ⇒ 上下文丢失）/ lingerMs=${config.daemonLingerMs}（无 key 且无客户端持续这么久 ⇒ 守护自退）/ queueLimit=${config.daemonQueueLimit}（同 key 并发 FIFO，超出明确拒绝）`,
          `daemon ports: configured=${config.daemonPort}(+${config.daemonPortTries} 回退) actual=${dstat.ok ? dstat.info?.port : dstat.kind === 'no-target' ? '(未检查：目标未确定)' : '(未运行)'}${dstat.ok && dstat.slot != null ? ` slot=${dstat.slot}` : ''}`,
          // 2026-10-28（零配置·评审 P2-3）：`stateDirLinux({wslHome:''})` 会拼出 `/.dsh/remote-wsl`
          // —— 那是**伪造路径**，用户会照着复制。目标未解析时如实说"未解析"。
          `daemon state dir (WSL): ${config.wslHome ? stateDirLinux(config) : '(未解析：wslHome 未确定)'}（元数据**按槽位**：daemon.<slot>.json / daemon.<slot>.token，0600；日志 daemon.log；本插件不把守护的东西落 /tmp）`,
          ...(orphanDaemons.length
            ? [
                `daemon orphans: ⚠️ ${orphanDaemons.length} 个守护在跑但无元数据（${orphanDaemons.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 wsl_daemon action=stop all=true 回收`,
              ]
            : []),
          // F-50（2026-10-27 审查）：扫描失败 ≠ 没有孤儿。以前这里因为 orphans 恒为空而静默不打印，
          // 读的人会把「没扫到」当成「一个都没有」，进而放心跳过 stop all（或反过来照提示乱杀）。
          ...(dstat.scan && dstat.scan.ok === false
            ? [
                `daemon scan: ⚠️ /proc 进程扫描失败（${dstat.scan.error ?? '未知原因'}）⇒ 孤儿列表**未核实**` +
                  `（上面的数量只是"已知部分"，不能读成 0）；不要据此执行 stop all，稍后重试 wsl_status`,
              ]
            : []),
          ...(daemonState.collisions.length ? [`daemon port notes: ${daemonState.collisions.join(' | ')}`] : []),
          `resident runtimes (in-host backend only): ${[...runtimes.entries()].filter(([, r]) => !r.closed).map(([k, r]) => `${k}(turn ${r.turns})`).join(', ') || '(none)'}`,
          `web hosts: ${[...webHosts.keys()].join(', ') || '(none)'}`,
          `wsl preset: ${presetLine}`,
          `pid files in WSL /tmp: ${pidFiles}（>0 表示可能有 in-host 孤儿运行时；首次有副作用的调用会清）`,
        ].join('\n');
      },
    });

    tools.register({
      name: 'wsl_exec',
      description:
        'Run a bash command inside the WSL distro (the remote terminal). The process, its filesystem and its tools live in WSL; cwd is a Linux path. Returns exit code, stdout and stderr. ' +
        'The script runs under `set -uo pipefail`, so a pipeline whose reader exits early (e.g. `yes | head -c 1000`) surfaces the writer\'s SIGPIPE as exit 141 — that is bash semantics, not a plugin failure. ' +
        'This one-shot path deliberately does NOT inject the login shell environment (see useShellEnvironment): it is a fresh `bash <script>` per call, and injecting would charge every call an extra login shell and let the caller\'s own profile silently change what an explicitly written command does. The long-lived processes behind wsl_agent / wsl_open_ui do get that injection.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command line to run inside WSL.' },
          cwd: { type: 'string', description: `Linux working directory (default ${config.cwd || '(未解析：目标未确定)'}).` },
          timeoutSec: { type: 'number', description: 'Wall-clock limit in seconds (default 120).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const command = String(args?.command ?? '').trim();
        if (!command) throw new Error('remote-wsl: wsl_exec 需要非空 command');
        await ensureSwept();
        const cwd = args?.cwd ? String(args.cwd) : config.cwd;
        // 2026-10-27 审查 F-08：cwd 是**数据**，不是脚本文本 —— 旧实现裸插值（`cd "${cwd}"`）会被
        // 引号闭合/`$()` 注入，且 `cd` 失败后仍可能 exit 0、命令静默跑在错误目录。统一走 cdPreamble。
        const res = await runWsl(
          config,
          `${shellPreamble(config)}${cdPreamble(cwd)}
${command}
`,
          { timeoutMs: (Number(args?.timeoutSec) || 120) * 1000, signal: exec?.signal },
        );
        // F-32（2026-10-27 审查）：截断必须**可见**。旧实现静默 slice ⇒ 调用方把被截断的输出当完整结果，
        // 尾部的错误信息（往往是最关键的）被无声丢掉。
        //
        // 第三轮（2026-10-27）把两层截断分开说，因为它们的含义完全不同：
        //  · 流层：`runWsl` 每流 200000 字节上限，**尾部已被丢弃**（`res.truncated.*` 是真值，不再靠长度猜）；
        //  · 展示层：为了让工具输出可读，这里再按字符数切到 100000 / 20000。
        // 旧写法用 `res.stdout.length >= 100000` 判断展示层，同时把流层那层吞掉 —— 只有一层标注，且可能漏报。
        const streamOutTrunc = res.truncated?.stdout
          ? `\n…[流层截断：stdout 超过 runWsl 的 200000 字节上限，**尾部已丢弃**]\n`
          : '';
        const streamErrTrunc = res.truncated?.stderr
          ? `\n…[流层截断：stderr 超过 runWsl 的 200000 字节上限，**尾部已丢弃**]\n`
          : '';
        const outTrunc = res.stdout.length > 100000 ? `\n…[stdout 只保留前 100000 字符]\n` : '';
        const errTrunc = res.stderr.length > 20000 ? `\n…[stderr 只保留前 20000 字符]\n` : '';
        return `${describeWslTermination(res)}${streamOutTrunc}${streamErrTrunc}\n--- stdout ---\n${res.stdout.slice(0, 100000)}${outTrunc}--- stderr ---\n${res.stderr.slice(0, 20000)}${errTrunc}`;
      },
    });

    tools.register({
      name: 'wsl_agent',
      description:
        'Delegate a task to the resident WSL-side dsh agent (dsh --profile sdk over stdio JSON-RPC), held by a resident daemon inside WSL. Its tools, MCP servers, skills and file writes all happen in WSL, and it runs the same dsh version as this Desktop install. ' +
        'Closing the client does NOT end the session: the runtime lives in the daemon, so a later call — even from a different DSH host process — continues the SAME session and remembers earlier turns. ' +
        'A session ends only when (a) the daemon is stopped explicitly (wsl_daemon action=stop), (b) it has been idle for `daemonIdleMs` (default 30 minutes) and the idle reaper collected the runtime, or (c) the daemon/runtime died. In cases (b) and (c) the next turn gets a NEW sessionId and the reply says the context was reset. ' +
        'Timeouts are NOT retried automatically: the request may already be executing in the daemon and side effects may have happened, so verify the remote state before retrying (a daemon that is unreachable but still listening will also NOT self-restart; use wsl_daemon action=restart). ' +
        'Concurrent prompts on the same `key` are serialized FIFO inside the daemon; beyond `daemonQueueLimit` (default 4) waiting turns are rejected explicitly, because upstream has no cancel. ' +
        'The per-call `cwd` really takes effect: the daemon keeps one runtime per (key, cwd) pair, so a new cwd starts its own session (its own sessionId) while the same key+cwd keeps reusing the same runtime; the reply always reports the effective `cwd=` and warns if it differs from the requested one.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task for the WSL-side agent.' },
          followUps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional further turns on the SAME runtime, in order (context is preserved).',
          },
          key: { type: 'string', description: 'Runtime-pool key; same key = same resident runtime (default "default").' },
          cwd: {
            type: 'string',
            description: `Linux working directory for the remote session (default ${config.cwd || '(未解析：目标未确定)'}). Takes effect when the runtime for this key is created; a reused runtime keeps its own cwd.`,
          },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const task = String(args?.task ?? '').trim();
        if (!task) throw new Error('remote-wsl: wsl_agent 需要非空 task');
        const key = args?.key ? String(args.key) : 'default';
        const turns = [task, ...(Array.isArray(args?.followUps) ? args.followUps.map(String) : [])];

        // ── 逃生舱：旧形态（本宿主进程持有运行时）──────────────────────────────
        if (config.backend === 'in-host') {
          await ensureSwept();
          const rt = await getRuntime(key, args?.cwd ? String(args.cwd) : undefined);
          let old = null;
          for (const t of turns) {
            if (exec?.signal?.aborted) throw new Error('remote-wsl: 已取消');
            old = await rt.prompt(t);
          }
          const oldMeta = `backend=in-host session=${rt.sessionId} cwd=${args?.cwd ? String(args.cwd) : config.cwd} completedBy=${old.completedBy} turns=${rt.turns} dsh@${version.version}` +
            (key === 'default' ? ' key=default(⚠️ 共享默认 key：不同对话/项目请显式传 key)' : '') +
            (version.drift ? ` drift=desktop ${version.drift.desktop}/pin ${version.drift.pin}` : '');
          return `${old.text}\n\n[remote-wsl: ${oldMeta}]`;
        }

        // ── 默认：守护形态 ────────────────────────────────────────────────────
        await ensureSwept(); // 只清旧形态留下的 /tmp 孤儿；守护自己不落 /tmp
        // P1：per-call cwd 现在真的生效 —— 走协议交给守护，守护按 **key+cwd** 分运行时条目
        // （不同 cwd ⇒ 不同 sessionId；同 key 同 cwd 仍复用同一个 ⇒ 跨宿主重连不受影响）。
        const wantCwd = args?.cwd ? String(args.cwd) : undefined;
        const sessionKey = `${key}\u0000${wantCwd ?? config.cwd}`;
        // 必须在 ensureDaemonReady **之前**取：守护已死时它会清掉陈元数据，
        // 之后再取就拿不到"上一次的 sessionId"，也就无法知道自己丢了上下文。
        const priorSession = priorSessionFor(key, wantCwd);
        let ensured = await ensureDaemonReady();
        let knownSession = priorSession;
        const notesBefore = ensured.notes ?? [];
        // 复用失败但元数据存在 ⇒ 之前那个守护（及其会话）已经不在了
        const suspectReset = notesBefore.some((n) => /被拒|超时|影子|握手失败/.test(n));
        let last: any = null;
        let contextReset = false;
        let recovered = false;
        for (const t of turns) {
          if (exec?.signal?.aborted) throw new Error('remote-wsl: 已取消');
          let r: any = await daemonPrompt(config, {
            port: ensured.port,
            token: ensured.token,
            key,
            text: t,
            cwd: wantCwd,
            timeoutMs: Number(config.timeoutMs),
          });
          if (isTransportFailure(r)) {
            // 语义 #10：守护不可达 ⇒ 自动起守护 + 重试**一次**（并且绝不静默换上下文）
            logDaemon(`prompt 传输失败(kind=${r.kind}) ⇒ 自动恢复守护并重试一次：${r.error ?? ''}`);
            ensured = await ensureDaemonReady();
            recovered = true;
            r = await daemonPrompt(config, {
              port: ensured.port,
              token: ensured.token,
              key,
              text: t,
              cwd: wantCwd,
              timeoutMs: Number(config.timeoutMs),
            });
          }
          if (r.sessionId && knownSession && r.sessionId !== knownSession) contextReset = true;
          if (r.sessionId) {
            knownSession = r.sessionId;
            daemonState.lastSessionByKey.set(sessionKey, r.sessionId);
          }
          last = r;
          if (!r.ok || contextReset) break;
        }

        const resetNotice = contextReset
          ? `⚠️ 远端会话已重置（守护或运行时重启过）：本次回答**不含**之前轮次的上下文，之前让它记住的内容已丢失（新 sessionId=${last?.sessionId ?? '?'}）。\n\n`
          : suspectReset && !knownSession
            ? `⚠️ 之前那个远端守护已不可达，已自动重启；若此前存在会话，其上下文已丢失（本轮是全新会话）。\n\n`
            : '';
        // P1 防回归：请求了 cwd 但守护回报的生效 cwd 不同 ⇒ 明确告知（绝不静默）
        const cwdNotice =
          wantCwd && last?.cwd && last.cwd !== wantCwd
            ? `⚠️ 请求的 cwd=${wantCwd} **未生效**，守护实际用的是 cwd=${last.cwd}。\n\n`
            : '';

        if (!last?.ok) {
          // F-10（2026-10-27 审查）：超时**不自动重发** —— 请求可能已经送达并在守护里继续执行，
          // 重发会让同一个有副作用的操作跑两遍（守护无幂等键）。如实告知，让调用方先核实再决定。
          if (last?.kind === 'timeout') {
            return `${resetNotice}${cwdNotice}[remote-wsl: 本轮**没有拿到结果**（守护在 ${config.timeoutMs}ms 内未回包）。` +
              `请求可能已经送达并仍在守护里执行 —— **未自动重发**（避免同一个有副作用的操作被执行两遍）。` +
              `请先确认远端是否已经产生效果（文件/命令输出），再决定是否重试。]`;
          }
          // 语义 #6：守护形态下**不换运行时**（换了就毁上下文），如实回报可重试
          //
          // 2026-10-28 真机实测补：原来不管 retryable 是什么都写「可直接重试」，于是上游 401 那种
          // 「重试只会再失败一次」的情况也被告知"可直接重试" —— 与人看到 errorCode 后的判断自相矛盾。
          // 现在按 retryable 分叉：可重试就说可重试；不可重试就直说"别急着重试，先修上游条件"。
          const why = last?.queueFull ? '并发超出队列上限' : last?.retryable ? '本轮没有产出正文' : '本轮失败';
          const retryHint =
            last?.retryable === true
              ? '运行时保持不动，可直接重试'
              : '运行时保持不动，但**不要原样重试**（重试只会再失败一次）；先按下面的原因修好上游条件，同一 key 仍可续上上下文';
          return `${resetNotice}${cwdNotice}[remote-wsl: ${why}；${retryHint} retryable=${last?.retryable === true}] ${last?.error ?? '(no error)'}`;
        }

        const meta =
          `backend=daemon session=${last.sessionId} cwd=${last.cwd ?? wantCwd ?? config.cwd} completedBy=${last.completedBy} turns=${last.turns} runtimePid=${last.runtimePid} ` +
          `daemon=${ensured.info?.daemonPid}@127.0.0.1:${ensured.port} dsh@${ensured.info?.version}` +
          // F-16（2026-10-27 审查）：默认 key 是**共享单例** —— 不同对话都不传 key 就会共用同一条运行时与上下文。
          (key === 'default' ? ' key=default(⚠️ 共享默认 key：不同对话/项目请显式传 key，否则会串上下文)' : '') +
          (recovered ? ' recovered=once' : '') +
          (contextReset ? ' contextReset=yes' : '') +
          (version.drift ? ` drift=desktop ${version.drift.desktop}/pin ${version.drift.pin}` : '');
        return `${resetNotice}${cwdNotice}${last.answer}\n\n[remote-wsl: ${meta}]`;
      },
    });

    tools.register({
      name: 'wsl_daemon',
      description:
        'Manage the resident WSL-side daemon that holds the remote dsh runtimes. ' +
        'action=status reports pid/actual-listening-port/version/keys without starting anything, and also reports ORPHAN daemons (processes still running with no metadata, found by scanning /proc cmdline for this plugin\'s daemon inside this plugin\'s state dir); ' +
        'action=start is idempotent (reuses a live daemon, never starts a second one); ' +
        'action=stop explicitly ends every remote session (context lost) — stopping the daemon is one of the only three ways a session ends, alongside the idle timeout (`daemonIdleMs`) and a daemon/runtime death; add all=true to also reap orphan daemons and every other slot (the recovery path when status lists orphans); ' +
        'action=restart is how you align the daemon with a new desktop dsh version. The plugin never kills a daemon on its own, because that would silently interrupt a session. ' +
        'The daemon also self-exits after `daemonLingerMs` with no keys and no clients. ' +
        'Every reply carries one stable machine-readable line whose fields never change meaning: ' +
        '`machine: slot=<slot> pid=<pid> port=<port> version=<version> [extras]` — parse it with ' +
        '`^machine: slot=(\\S+) pid=(\\S+) port=(\\S+) version=(\\S+)( .*)?$`; unknown/not-running fields are `-`. ' +
        '(The pre-F3 format `daemon=<pid>@<port>` is gone; external scripts must use the new one.)',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'start', 'stop', 'restart'],
            description: 'What to do (default status).',
          },
          all: {
            type: 'boolean',
            description:
              'With action=stop: reap EVERY slot plus orphan daemons running without metadata (identity-checked via /proc/<pid>/cmdline, restricted to this plugin\'s state dir).',
          },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args) => {
        const action = String(args?.action ?? 'status');
        if (action === 'status') {
          // 2026-10-28（零配置·评审 B1）：目标未确定时 `daemonStatus` 只能扫出空数组，最后会给出
          // 「not running」这种**结论**（而实际什么都没扫），还会把 `/.dsh/remote-wsl` 这种伪造路径
          // 打给用户去复制。与 `stop` 分支同样处理：直接回根因，不做状态判断。
          const statusIssue = targetProblem(config);
          // A-P2-E：可操作入口已由 target-detect 的文案统一携带（`REDETECT_HINT`），这里不再另写一份。
          if (statusIssue) return statusIssue;
          const s: any = await daemonStatus(config);
          const info0 = s.info ?? {};
          const ks0: any[] = Array.isArray(info0.keys) ? info0.keys : [];
          const orphans0: any[] = Array.isArray(s.orphans) ? s.orphans : [];
          // F-50（第三轮）：`scan.ok === false` ⇒ 本次**没有**进程表证据。孤儿数（可能是 0）只是
          // "已知部分"，机器行也必须把它标成 unknown，别让脚本把 0 当成"确认没有孤儿"。
          const scanFailed = s.scan?.ok === false;
          const orphansCount = scanFailed ? 'unknown' : String(orphans0.length);
          const scanWarn = scanFailed
            ? `scan: ⚠️ /proc 进程扫描失败（${s.scan?.error ?? '未知原因'}）⇒ 孤儿列表**未核实**（不是"0 个"）；不要据此执行 stop all`
            : null;
          if (!s.ok) {
            // F-18：`busy` 是「端口可连但没应答」，与「没在跑」必须分开 —— 前者的正确动作是"稍后重试"，
            // 而不是 stop all（那会杀掉带会话的守护）。
            const busyList: any[] = Array.isArray(s.busy) ? s.busy : [];
            if (s.kind === 'busy') {
              return [
                `daemon: busy（${busyList.map((b) => `slot=${b.slot} port=${b.meta?.port ?? b.slot} pid=${b.meta?.pid ?? '?'}`).join(', ') || '端口可连接'}）`,
                machineLine({ extra: `busy=${busyList.length} orphans=${orphansCount} scan=${scanFailed ? 'failed' : 'ok'}` }),
                `含义: 守护进程活着、端口可连接，但 ${config.daemonHandshakeTimeoutMs}ms 内没有应答（单线程守护可能正在安装工具/预热）。**不是死**，不要执行 stop all；稍后重试 wsl_status 即可。`,
                ...(scanWarn ? [scanWarn] : []),
                `state dir (WSL): ${stateDirLinux(config)}（元数据按槽位 daemon.<slot>.json / daemon.<slot>.token，0600）`,
              ].join('\n');
            }
            return [
              `daemon: not running（${s.kind}: ${s.error}）`,
              machineLine({ extra: `orphans=${orphansCount} scan=${scanFailed ? 'failed' : 'ok'}` }),
              `state dir (WSL): ${stateDirLinux(config)}（元数据按槽位 daemon.<slot>.json / daemon.<slot>.token，0600）`,
              ...(orphans0.length
                ? [
                    `Orphans: ⚠️ ${orphans0.map((o) => `pid${o.pid}@${o.port}`).join(', ')}（在跑但无元数据）—— 用 wsl_daemon action=stop all=true 回收`,
                  ]
                : []),
              ...(scanWarn ? [scanWarn] : []),
            ].join('\n');
          }
          const info = s.info ?? {};
          const ks: any[] = Array.isArray(info.keys) ? info.keys : [];
          const orphans: any[] = Array.isArray(s.orphans) ? s.orphans : [];
          // A-P1-A：`wsl_daemon status` 是排障第一入口 —— 实际 provider/model 与配置必须同时出现。
          const route = routeMismatch(info, config);
          const routeWarn =
            route.kind === 'unreported'
              ? `route: ⚠️ 守护未上报 provider/model（0.3.4 之前的旧守护）⇒ 无法校验本次配置 ${route.host.provider ?? '?'}/${route.host.model ?? '?'}；wsl_daemon action=restart 后可核对`
              : route.kind === 'mismatch'
                ? `route: ⚠️ 守护实际 ${route.daemon.provider}/${route.daemon.model} ≠ 本次配置 ${route.host.provider ?? '?'}/${route.host.model ?? '?'} —— 配置改了但守护还是旧进程；执行 wsl_daemon action=restart 生效（会丢当前会话上下文）`
                : null;
          return [
            `daemon: pid=${info.daemonPid} actualPort=${info.port} slot=${s.slot} version=${info.version} plugin=${info.pluginVersion ?? 'unknown'} protocol=v${info.protocolVersion ?? 0} cwd=${info.cwd} profile=${info.profile} provider=${info.provider ?? 'unknown'} model=${info.model ?? 'unknown'}`,
            machineLine({
              slot: s.slot,
              pid: info.daemonPid,
              port: info.port,
              version: info.version,
              extra: `keys=${ks.length} orphans=${orphansCount} scan=${scanFailed ? 'failed' : 'ok'}`,
            }),
            ...(routeWarn ? [routeWarn] : []),
            ...(info.protocolVersion == null || Number(info.protocolVersion) < PROTOCOL_VERSION || (info.pluginVersion && info.pluginVersion !== PLUGIN_VERSION)
              ? [
                  `versions: ⚠️ 守护插件 ${info.pluginVersion ?? 'unknown'} / 协议 v${info.protocolVersion ?? 0}，宿主 ${PLUGIN_VERSION} / 协议 v${PROTOCOL_VERSION} —— 新功能在 restart 前不可用（wsl_daemon action=restart）`,
                ]
              : []),
            `uptime=${Math.round((info.uptimeMs ?? 0) / 1000)}s idleMs=${info.idleMs} lingerMs=${info.lingerMs} queueLimit=${info.queueLimit}`,
            `keys (${ks.length}): ${
              ks
                .map(
                  (k) =>
                    `${k.key} session=${k.sessionId} turns=${k.turns} runtimePid=${k.runtimePid} idleForMs=${k.idleForMs}${k.queued ? ` queued=${k.queued}` : ''}`,
                )
                .join(' | ') || '(none)'
            }`,
            ...(orphans.length
              ? [
                  `Orphans: ⚠️ ${orphans.length} 个守护在跑但无元数据（${orphans.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 wsl_daemon action=stop all=true 回收`,
                ]
              : []),
            ...(scanWarn ? [scanWarn] : []),
            `ready 判据: 本次调用由 Windows 侧 hello+token 握手核实（${s.ms}ms），不是守护自己的 listening 日志`,
            `state (WSL): ${stateDirLinux(config)}/daemon.<slot>.json（0600）、daemon.<slot>.token（0600），slot=${s.slot}`,
          ].join('\n');
        }
        if (action === 'stop') {
          const all = args?.all === true;
          // 2026-10-28（零配置）：目标未确定时 stop 的语义根本不成立（读不到元数据、也扫不了
          // `/proc`）。直接回根因，不要让它落进下面的 "结果未验证 / 元数据按 P1 保留" 分支 ——
          // 那句话会让人以为"确实有元数据、只是没验"，而实际是"连目标都不知道"。
          const stopIssue = targetProblem(config);
          if (stopIssue) return stopIssue;
          const r: any = await stopDaemon(config, { log: logDaemon, all });
          // 2026-10-27 审查 F-03：`stopDaemon` 在「守护仍在」时返回 ok:false + alivePids 并**保留**
          // 元数据；旧实现完全不看它，照样打印 `daemon stopped` 还清空会话记忆 ⇒ 伪成功，而且之后
          // 连旧 sessionId 都拿不到（contextReset 也提示不了）。失败必须如实返回、**不动**会话记忆。
          //
          // ★ F-50（第三轮）：失败有两种，**不能混成一句**：
          //   · `verified === true` ⇒ 扫描证实守护仍在（alivePids 有值）⇒「仍在运行」；
          //   · `verified === false` ⇒ 扫描失败、**无法确认**（alivePids 恒空，但那不是 0）
          //     ⇒「结果未验证」。旧文案会把后者也写成"仍在运行（没有 pid）"，等于用未验证冒充结论。
          const alivePids: number[] = Array.isArray(r.alivePids) ? r.alivePids : [];
          if (all) {
            const killed: any[] = Array.isArray(r.killed) ? r.killed : [];
            const remaining: any[] = Array.isArray(r.remaining) ? r.remaining : [];
            const stoppedN = Array.isArray(r.stopped) ? r.stopped.length : 0;
            const reapedN = (r.stopped ?? []).reduce((n: number, x: any) => n + (Array.isArray(x?.reaped) ? x.reaped.length : 0), 0);
            const verified = r.verified !== false;
            // F-50：只有 verified 时 `remainingCount` 才是数字；未验证时它是 null（未知，不是 0）。
            const remainingCount = verified ? remaining.length : null;
            const subFailures = Number(r.subFailures) || 0;
            const lines = [
              `daemon stop --all: slots=${stoppedN} killedOrphans=${killed.length}（${killed.map((k) => `pid${k.pid}@${k.port}`).join(', ') || '(none)'}）` +
                `remainingOrphans=${remainingCount === null ? '未知（扫描失败）' : remainingCount}` +
                `${subFailures ? ` subFailures=${subFailures}` : ''}`,
              machineLine({
                slot: 'all',
                extra: `stopped=${stoppedN} killed=${killed.length} orphans_left=${remainingCount === null ? 'unknown' : remainingCount} reaped=${reapedN} scan=${verified ? 'ok' : 'failed'}`,
              }),
            ];
            if (r.ok === false) {
              lines.push(
                verified
                  ? `⚠️ 未清干净：${subFailures ? `${subFailures} 个槽位的 stop 自己失败了（元数据已按 P1 保留）` : `${remainingCount} 个本方守护仍在（收敛窗口内未退出）`}`
                  : `⚠️ **结果未验证**：/proc 进程扫描失败（${r.scan?.error ?? '未知原因'}）⇒ 剩余守护数量**未知**（不是 0）；未回收任何孤儿进程，元数据按 P1 保留`,
              );
              if (r.error) lines.push(`detail: ${String(r.error)}`);
            }
            lines.push(`⚠️ 所有远端会话的上下文随之丢失 —— "显式停止"是会话结束的三种方式之一。`);
            if (r.ok !== false) {
              daemonState.info = null;
              daemonState.port = null;
              daemonState.lastSessionByKey.clear();
            }
            return lines.join('\n');
          }
          if (r.ok === false) {
            const unverified = r.verified === false;
            return [
              unverified
                ? `daemon stop **结果未验证**（transport=${r.transport ?? 'none'}）：拿不到 /proc 扫描证据，` +
                  `无法确认本方守护是否已退出（alivePids 为空**不代表** 0）。` +
                  `元数据已按 P1 保留 ⇒ 它仍是可发现的，可稍后重试 stop，或用 action=status 复核。`
                : `daemon stop 未完成（transport=${r.transport ?? 'none'}）：守护仍在运行` +
                  (alivePids.length ? `（pid ${alivePids.join('、')}）` : '') +
                  `；元数据已保留 ⇒ 它仍是可发现的，可再次 stop 或 action=stop all=true。`,
              machineLine({
                slot: r.slot,
                pid: r.pid,
                port: r.port,
                version: r.version,
                extra: `stopped=false verified=${unverified ? 'false' : 'true'} alive=${alivePids.length ? alivePids.join('|') : '-'}`,
              }),
              ...(r.error ? [`detail: ${String(r.error)}`] : []),
            ].join('\n');
          }
          daemonState.info = null;
          daemonState.port = null;
          daemonState.lastSessionByKey.clear();
          const reaped: any[] = Array.isArray(r.reaped) ? r.reaped : [];
          // F1：孤儿口径与 status 完全同源（daemonSnapshot）—— 别的槽位**有元数据的健康守护不算孤儿**
          const snap: any = await daemonSnapshot(config);
          const orphansLeft: any[] = Array.isArray(snap.orphans) ? snap.orphans : [];
          const snapVerified = snap.scan?.ok !== false;
          return [
            `daemon stopped（transport=${r.transport ?? 'none'}）; reaped ${reaped.length} runtime(s): ` +
              `${reaped.map((k) => `${k.key}(turn ${k.turns})`).join(', ') || '(none)'}`,
            machineLine({
              slot: r.slot,
              pid: r.pid,
              port: r.port,
              version: r.version,
              extra: `reaped=${reaped.length} orphans_left=${snapVerified ? orphansLeft.length : 'unknown'}`,
            }),
            ...(snapVerified && orphansLeft.length
              ? [
                  `Orphans: ⚠️ 仍有 ${orphansLeft.length} 个守护在跑但无元数据（${orphansLeft.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 action=stop all=true`,
                ]
              : []),
            // F-50：stop 成功只说明**本槽位**停干净了；孤儿复核失败时必须说出来，别让人以为全局干净。
            ...(snapVerified
              ? []
              : [`Orphans: ⚠️ 未能核实（/proc 扫描失败：${snap.scan?.error ?? '未知原因'}）—— 不代表没有孤儿`]),
            `⚠️ 会话上下文随之丢失 —— "显式停止"是会话结束的三种方式之一。`,
          ].join('\n');
        }
        if (action !== 'start' && action !== 'restart') {
          throw new Error(`remote-wsl: wsl_daemon 不认识 action=${action}（可选 status|start|stop|restart）`);
        }
        const r = await ensureDaemonReady({ restart: action === 'restart' });
        if (action === 'restart') daemonState.lastSessionByKey.clear();
        return [
          `daemon ${action}: ok port=${r.port} pid=${r.info?.daemonPid} version=${r.info?.version} reused=${r.reused === true}`,
          machineLine({
            slot: r.slot,
            pid: r.info?.daemonPid,
            port: r.port,
            version: r.info?.version,
            extra: `reused=${r.reused === true}`,
          }),
          // F-38c（task-19）：启动方式是**机器可读**的一行（`machine:` 行的字段语义保持冻结，不动它）。
          // mode: 'systemd'（无窗、独立） / 'compat-detached'（保活、可能弹窗） / 'reused'（复用既有守护）
          `launch: mode=${r.mode ?? '-'} warning=${r.warning ? r.warning : 'null'}`,
          `notes: ${(r.notes ?? []).join(' | ') || '(none)'}`,
          `元数据 (WSL): ${stateDirLinux(config)}/daemon.<slot>.json（slot=${r.slot ?? r.port}）`,
        ].join('\n');
      },
    });

    tools.register({
      name: 'wsl_open_ui',
      description:
        'Serve the DSH Web UI from inside WSL and open it in a Windows app window. This is the supported stand-in for "connect the Desktop shell to a remote host": the Desktop shell cannot attach to a remote host (its host is spawned locally), but the browser client can, because it talks to whatever origin served the page. Returns the launch URL (it carries a per-process token). ' +
        'While this host runs, the plugin keeps one one-shot launch script in WSL /tmp named /tmp/dsh-rwsl-<winpid>-*.sh (plus its .pid) — <winpid> is THIS Windows process, so files are never shared with another host. stop=true (or unloading the plugin) deletes this process\'s own /tmp files; a stale file of THIS host is also converged by the next side-effectful call once the linux runtime pid recorded in its .pid is dead (no need to wait for stop/dispose), and files of another host are never touched while that host is alive.',
      parameters: {
        type: 'object',
        properties: {
          port: { type: 'number', description: `Port inside WSL (default ${config.webPort}).` },
          open: { type: 'boolean', description: 'Open an app window on Windows (default true).' },
          stop: { type: 'boolean', description: 'Stop the web host on this port instead of starting it.' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args) => {
        const port = Number(args?.port) || config.webPort;
        if (!args?.stop) await ensureSwept();
        if (args?.stop) {
          const h = webHosts.get(port);
          if (h) {
            await h.stop();
            webHosts.delete(port);
          }
          await sweepOwnTempFiles(config); // 没有注册中的 host 时也清一次自己的 /tmp 一次性文件
          return `stopped web host on port ${port}`;
        }
        if (!version.version) throw new Error('remote-wsl: 无法确定 dsh 版本');
        warmInBackground(version); // 漂移时后台预热，不阻塞 web host 启动
        let host = webHosts.get(port);
        if (!host) {
          host = new WebHost({ ...config, webPort: port }, version.version, deps.lifecycle ?? null);
          webHosts.set(port, host);
        }
        const url = await host.start();
        const how = (args?.open ?? true) ? openAppWindow(url) : 'not-opened';
        return `${url}\n(opened: ${how})`;
      },
    });

    tools.register({
      name: 'wsl_sync_version',
      description:
        'Align the WSL side with this Desktop install: read the Desktop dsh version, compare it with the version pinned inside WSL, optionally warm the WSL package cache for that exact version, and repair the pin. Upstream has no version negotiation across hosts, and a mismatched package only disables plugins silently, so this check has to be explicit.',
      parameters: {
        type: 'object',
        properties: {
          warm: { type: 'boolean', description: 'Also materialize that exact version in WSL (slower first time, faster later).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        await ensureSwept();
        // 2026-10-28（零配置·评审 P2-1）：这是"配置 + 版本"诊断动作，没有目标时 pin 路径与预热脚本
        // 文本都无从谈起。旧路径会把内部不变量（`cfg.wslHome 为空`）漏给用户，或把 pin 写入静默变成
        // `(write failed)`。直接回同一条可操作报错。
        const syncIssue = targetProblem(config);
        if (syncIssue) return syncIssue;
        const v = resolveVersion(config);
        warmInBackground(v); // 漂移时后台预热（与下面显式 warm 相互独立：这里不阻塞、也不改 pin）
        const lines = [
          `desktop version: ${v.desktopVersion ?? '(unknown)'}${v.desktopSource ? `  <- ${v.desktopSource}` : ''}`,
          `wsl pin before: ${v.pin ?? '(none)'}`,
        ];
        if (args?.warm && v.version) {
          const res = await runWsl(
            config,
            // 与后台预热共用 lib/version.js 的 warmScript（"三坑"只写一处：--profile 必带、
            // 非登录 shell 的 PATH、--dump-config + WARM-OK 哨兵），这里只多拼运行时的 shellPreamble
            `${shellPreamble(config)}${warmScript({ cfg: config, version: v.version })}`,
            { timeoutMs: 300000, signal: exec?.signal },
          );
          lines.push(
            `warm ${v.version}: ${
              res.stdout.includes('WARM-OK')
                ? 'ok'
                : `failed (${res.killedBy && res.killedBy !== 'exit' ? res.killedBy : `exit ${res.exitCode}`}) ${res.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
            }`,
          );
        }
        const wrote = v.version ? writePin(config, v.version) : false;
        lines.push(`wsl pin after: ${v.version ?? '(unresolved)'}${wrote ? ' (written)' : ' (write failed)'}`);
        lines.push(`drift was: ${v.drift ? `YES (desktop ${v.drift.desktop} / pin ${v.drift.pin})` : 'no'}`);
        return lines.join('\n');
      },
    });

    // 第 7 个工具：路径互转。与 `dsh-wsl-tool` 的 `wsl-path` 是**同类能力**（那边用连字符，
    // 本插件沿用自己既有的 snake_case 命名）。纯字符串转换、只读、无副作用、不要求路径存在。
    tools.register({
      name: 'wsl_path',
      description:
        'Convert a path between Windows and WSL forms by wrapping the distro\'s own `wslpath` — the same capability as `dsh-wsl-tool`\'s `wsl-path`, under this plugin\'s existing snake_case naming. ' +
        'direction=to-wsl returns the WSL absolute path (`wslpath -a -u`), direction=to-windows returns the Windows path (`wslpath -w`), and the default `both` reports both forms, the exact command that ran, and which direction is effective for the input\'s shape. ' +
        'Read-only and cheap: it translates the string only — nothing is written, and the path does not have to exist. ' +
        'The path is passed as a positional argv argument (`-e bash -c \'wslpath -a -u -- "$1"\' _ <path>`), never interpolated into a shell string, so spaces, quotes and `$(...)` stay literal. ' +
        'Failures are explicit (empty path, unknown/not-running distro, missing wslpath); an unconvertible path is never silently echoed back.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Windows path (e.g. D:\\project\\net1 or \\\\wsl.localhost\\<distro>\\...) or WSL path (e.g. /mnt/d/project/net1).',
          },
          direction: {
            type: 'string',
            enum: ['to-wsl', 'to-windows', 'both'],
            description: 'Which conversion(s) to report (default both).',
          },
        },
        required: ['path'],
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args) => {
        const direction = args?.direction ? String(args.direction) : 'both';
        if (direction !== 'to-wsl' && direction !== 'to-windows' && direction !== 'both') {
          throw new Error(`remote-wsl: wsl_path 不认识 direction=${direction}（可选 to-wsl|to-windows|both）`);
        }
        return wslPathConvert(config, args?.path, direction);
      },
    });
  });
}
