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
import { runWsl, wslPathConvert, sweepOwnTempFiles, readLogViaWsl, shellPreamble, writeScript, removeScript, sleep, renderText, resolveVersion, readPin, writePin } from './wsl-io.ts';

// ── 远端 UI：WSL 跑 `dsh web`，Windows 开应用窗口 ─────────────────────────────

export class WebHost {
  constructor(cfg, version) {
    this.cfg = cfg;
    this.version = version;
    this.url = null;
    this.stderrTail = '';
  }

  async start() {
    if (this.child) return this.url;
    // 同 SdkRuntime：常驻进程才注入登录 shell 环境
    const script = `${shellPreamble(this.cfg, { withShellEnv: true })}cd "${this.cfg.wslHome}" || exit 2
echo $$ > "\${0%.sh}.pid"
exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} web --port ${this.cfg.webPort} --no-open
`;
    this.script = writeScript(this.cfg.distro, script);
    this.child = spawn('wsl.exe', ['-d', this.cfg.distro, '--', 'bash', this.script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c).slice(-4000);
    });
    const url = await new Promise((resolve, reject) => {
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
    this.url = url;
    this.child.stdout.removeAllListeners('data');
    this.child.stdout.resume(); // 起完就排空，避免管道回压
    return url;
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
  const script = stale
    .map(
      (s) => `pkill -TERM -P ${s.linuxPid} 2>/dev/null || true
kill -TERM ${s.linuxPid} 2>/dev/null || true
rm -f ${s.pidFile} ${s.pidFile.replace(/\.pid$/, '.sh')} ${s.pidFile.replace(/\.pid$/, '.mjs')}`,
    )
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
 * 注册七个工具。`deps` 由 index.ts 的 apply 提供（拆分前它们是同一闭包里的自由变量；这里改用**同名解构**
 * ⇒ 下面七个 `tools.register` 的函数体逐字未改）。
 */
export function registerTools(deps) {
  const {
    ctx, config, version, resolveVersion, daemonState, logDaemon, machineLine, ensureDaemonReady,
    isTransportFailure, priorSessionFor, listDistros, getRuntime, runtimes, webHosts, ensureSwept, warmInBackground,
  } = deps;

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');
    if (!tools) return;

    tools.register({
      name: 'wsl_status',
      description:
        'Report the WSL remote-host picture: available distros, the DSH desktop version this Windows install runs, the version pinned inside WSL, any drift between them, the dsh versions already materialized in the WSL pnpm dlx cache, the shell-environment injection switch, the localhostForwarding setting that the WSL2 port forwarding depends on, and the resident remote runtimes this plugin holds. Read-only and cheap; call it before blaming the remote side.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (_args, exec) => {
        const distros = listDistros();
        const v = resolveVersion(config);
        // 孤儿运行时诊断（只数，不杀；真正的清理在首次有副作用的调用上做）。
        // F4：**不走内联 `wsl.exe … -- bash -lc "<串>"`** —— 那条路不是 argv-exec，串会先经过发行版的
        // 默认登录 shell（本机 zsh）展开，`$VAR`/glob 在到达 bash 前就失真。这里走 runWsl（落文件 +
        // `bash <file>`），并用 `find … -print | wc -l` 而不是裸 glob（glob 未匹配时会给出"假 0"）。
        let pidFiles = '0';
        {
          const res = await runWsl(config, 'find /tmp -maxdepth 1 -name "dsh-rwsl-*.pid" -print | wc -l\n', {
            timeoutMs: 20000,
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
        if (distros.includes(config.distro)) {
          const res = await runWsl(
            config,
            `${shellPreamble(config)}hostname -I
echo ${MARK}
${dlxInventoryScript({ wslHome: config.wslHome })}`,
            { timeoutMs: 40000, signal: exec?.signal },
          );
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
        const distroCfg = readCfgText(unc(config.distro, '/etc/wsl.conf'));
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
          config.backend === 'in-host'
            ? { ok: false, kind: 'in-host', error: 'in-host 后端不使用守护' }
            : await daemonStatus(config);
        let daemonLine: string;
        let daemonAlarm: string | null = null;
        const orphanDaemons: any[] = Array.isArray(dstat.orphans) ? dstat.orphans : [];
        if (dstat.ok) {
          const info = dstat.info ?? {};
          const ks: any[] = Array.isArray(info.keys) ? info.keys : [];
          daemonLine =
            `running pid=${info.daemonPid} actualPort=${info.port} slot=${dstat.slot} version=${info.version} ` +
            `uptime=${Math.round((info.uptimeMs ?? 0) / 1000)}s idleMs=${info.idleMs} lingerMs=${info.lingerMs} keys=${ks.length} ` +
            `[${ks.map((k) => `${k.key}(turn ${k.turns}${k.queued ? `,q${k.queued}` : ''}${k.runtimePid ? `,pid${k.runtimePid}` : ''})`).join(', ') || '(none)'}]`;
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
        } else {
          daemonLine = `not running（${dstat.kind}: ${dstat.error}）`;
        }
        return [
          `distros: ${distros.join(', ') || '(none)'}`,
          `target: ${config.distro}  wslHome=${config.wslHome}  cwd=${config.cwd}`,
          `wsl ip: ${ip}`,
          `shell env injection (useShellEnvironment): ${config.useShellEnvironment === false ? 'off' : 'on'}（只注入常驻进程 wsl_agent / wsl_open_ui；wsl_exec 的一次性路径不注入）`,
          `localhost forwarding: ${lfLine}`,
          `desktop dsh version: ${v.desktopVersion ?? '(unknown)'}${v.desktopSource ? `  <- ${v.desktopSource}` : ''}`,
          `version this plugin uses: ${v.version ?? '(unresolved)'}`,
          `wsl pin: ${v.pin ?? '(none)'}`,
          `drift: ${v.drift ? `YES (desktop ${v.drift.desktop} / pin ${v.drift.pin})` : 'no'}`,
          `dlx dsh versions in WSL: ${dlx}`,
          `backend: ${config.backend === 'in-host' ? 'in-host（逃生舱：运行时由本宿主进程持有，关客户端即丢会话）' : 'daemon（默认：运行时由 WSL 侧常驻守护持有，关客户端 ≠ 会话结束）'}`,
          `daemon: ${daemonLine}`,
          ...(daemonAlarm ? [`daemon drift: ⚠️ ${daemonAlarm}`] : []),
          `daemon idle/linger/queue: idleMs=${config.daemonIdleMs}（到期回收运行时 ⇒ 上下文丢失）/ lingerMs=${config.daemonLingerMs}（无 key 且无客户端持续这么久 ⇒ 守护自退）/ queueLimit=${config.daemonQueueLimit}（同 key 并发 FIFO，超出明确拒绝）`,
          `daemon ports: configured=${config.daemonPort}(+${config.daemonPortTries} 回退) actual=${dstat.ok ? dstat.info?.port : '(未运行)'}${dstat.ok && dstat.slot != null ? ` slot=${dstat.slot}` : ''}`,
          `daemon state dir (WSL): ${stateDirLinux(config)}（元数据**按槽位**：daemon.<slot>.json / daemon.<slot>.token，0600；日志 daemon.log；本插件不把守护的东西落 /tmp）`,
          ...(orphanDaemons.length
            ? [
                `daemon orphans: ⚠️ ${orphanDaemons.length} 个守护在跑但无元数据（${orphanDaemons.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 wsl_daemon action=stop all=true 回收`,
              ]
            : []),
          ...(daemonState.collisions.length ? [`daemon port notes: ${daemonState.collisions.join(' | ')}`] : []),
          `resident runtimes (in-host backend only): ${[...runtimes.entries()].filter(([, r]) => !r.closed).map(([k, r]) => `${k}(turn ${r.turns})`).join(', ') || '(none)'}`,
          `web hosts: ${[...webHosts.keys()].join(', ') || '(none)'}`,
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
          cwd: { type: 'string', description: `Linux working directory (default ${config.cwd}).` },
          timeoutSec: { type: 'number', description: 'Wall-clock limit in seconds (default 120).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const command = String(args?.command ?? '').trim();
        if (!command) throw new Error('remote-wsl: wsl_exec 需要非空 command');
        await ensureSwept();
        const cwd = args?.cwd ? String(args.cwd) : config.cwd;
        const res = await runWsl(
          config,
          `${shellPreamble(config)}cd "${cwd}" || { echo "remote-wsl: cwd 不存在: ${cwd}" >&2; exit 2; }
${command}
`,
          { timeoutMs: (Number(args?.timeoutSec) || 120) * 1000, signal: exec?.signal },
        );
        return `exit ${res.exitCode}\n--- stdout ---\n${res.stdout.slice(0, 100000)}--- stderr ---\n${res.stderr.slice(0, 20000)}`;
      },
    });

    tools.register({
      name: 'wsl_agent',
      description:
        'Delegate a task to the resident WSL-side dsh agent (dsh --profile sdk over stdio JSON-RPC), held by a resident daemon inside WSL. Its tools, MCP servers, skills and file writes all happen in WSL, and it runs the same dsh version as this Desktop install. ' +
        'Closing the client does NOT end the session: the runtime lives in the daemon, so a later call — even from a different DSH host process — continues the SAME session and remembers earlier turns. ' +
        'A session ends only when (a) the daemon is stopped explicitly (wsl_daemon action=stop), (b) it has been idle for `daemonIdleMs` (default 30 minutes) and the idle reaper collected the runtime, or (c) the daemon/runtime died. In cases (b) and (c) the next turn gets a NEW sessionId and the reply says the context was reset. ' +
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
            description: `Linux working directory for the remote session (default ${config.cwd}). Takes effect when the runtime for this key is created; a reused runtime keeps its own cwd.`,
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
          // 语义 #6：守护形态下**不换运行时**（换了就毁上下文），如实回报可重试
          const why = last?.queueFull ? '并发超出队列上限' : last?.retryable ? '本轮没有产出正文' : '本轮失败';
          return `${resetNotice}${cwdNotice}[remote-wsl: ${why}；运行时保持不动，可直接重试 retryable=${last?.retryable === true}] ${last?.error ?? '(no error)'}`;
        }

        const meta =
          `backend=daemon session=${last.sessionId} cwd=${last.cwd ?? wantCwd ?? config.cwd} completedBy=${last.completedBy} turns=${last.turns} runtimePid=${last.runtimePid} ` +
          `daemon=${ensured.info?.daemonPid}@127.0.0.1:${ensured.port} dsh@${ensured.info?.version}` +
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
          const s: any = await daemonStatus(config);
          const info0 = s.info ?? {};
          const ks0: any[] = Array.isArray(info0.keys) ? info0.keys : [];
          const orphans0: any[] = Array.isArray(s.orphans) ? s.orphans : [];
          if (!s.ok) {
            return [
              `daemon: not running（${s.kind}: ${s.error}）`,
              machineLine({ extra: `orphans=${orphans0.length}` }),
              `state dir (WSL): ${stateDirLinux(config)}（元数据按槽位 daemon.<slot>.json / daemon.<slot>.token，0600）`,
              ...(orphans0.length
                ? [
                    `Orphans: ⚠️ ${orphans0.map((o) => `pid${o.pid}@${o.port}`).join(', ')}（在跑但无元数据）—— 用 wsl_daemon action=stop all=true 回收`,
                  ]
                : []),
            ].join('\n');
          }
          const info = s.info ?? {};
          const ks: any[] = Array.isArray(info.keys) ? info.keys : [];
          const orphans: any[] = Array.isArray(s.orphans) ? s.orphans : [];
          return [
            `daemon: pid=${info.daemonPid} actualPort=${info.port} slot=${s.slot} version=${info.version} cwd=${info.cwd} profile=${info.profile}`,
            machineLine({
              slot: s.slot,
              pid: info.daemonPid,
              port: info.port,
              version: info.version,
              extra: `keys=${ks.length} orphans=${orphans.length}`,
            }),
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
            `ready 判据: 本次调用由 Windows 侧 hello+token 握手核实（${s.ms}ms），不是守护自己的 listening 日志`,
            `state (WSL): ${stateDirLinux(config)}/daemon.<slot>.json（0600）、daemon.<slot>.token（0600），slot=${s.slot}`,
          ].join('\n');
        }
        if (action === 'stop') {
          const all = args?.all === true;
          const r: any = await stopDaemon(config, { log: logDaemon, all });
          daemonState.info = null;
          daemonState.port = null;
          daemonState.lastSessionByKey.clear();
          if (all) {
            const killed: any[] = Array.isArray(r.killed) ? r.killed : [];
            const remaining: any[] = Array.isArray(r.remaining) ? r.remaining : [];
            const stoppedN = Array.isArray(r.stopped) ? r.stopped.length : 0;
            const reapedN = (r.stopped ?? []).reduce((n: number, x: any) => n + (Array.isArray(x?.reaped) ? x.reaped.length : 0), 0);
            return [
              `daemon stop --all: slots=${stoppedN} killedOrphans=${killed.length}（${killed.map((k) => `pid${k.pid}@${k.port}`).join(', ') || '(none)'}）remainingOrphans=${remaining.length}`,
              machineLine({
                slot: 'all',
                extra: `stopped=${stoppedN} killed=${killed.length} orphans_left=${remaining.length} reaped=${reapedN}`,
              }),
              `⚠️ 所有远端会话的上下文随之丢失 —— "显式停止"是会话结束的三种方式之一。`,
            ].join('\n');
          }
          const reaped: any[] = Array.isArray(r.reaped) ? r.reaped : [];
          // F1：孤儿口径与 status 完全同源（daemonSnapshot）—— 别的槽位**有元数据的健康守护不算孤儿**
          const snap: any = await daemonSnapshot(config);
          const orphansLeft: any[] = Array.isArray(snap.orphans) ? snap.orphans : [];
          return [
            `daemon stopped（transport=${r.transport ?? 'none'}）; reaped ${reaped.length} runtime(s): ` +
              `${reaped.map((k) => `${k.key}(turn ${k.turns})`).join(', ') || '(none)'}`,
            machineLine({
              slot: r.slot,
              pid: r.pid,
              port: r.port,
              version: r.version,
              extra: `reaped=${reaped.length} orphans_left=${orphansLeft.length}`,
            }),
            ...(orphansLeft.length
              ? [
                  `Orphans: ⚠️ 仍有 ${orphansLeft.length} 个守护在跑但无元数据（${orphansLeft.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 action=stop all=true`,
                ]
              : []),
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
          host = new WebHost({ ...config, webPort: port }, version.version);
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
                : `failed (exit ${res.exitCode}) ${res.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
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
