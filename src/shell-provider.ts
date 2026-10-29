/**
 * dsh-remote-wsl / shell-provider —— 在 WSL preset 的 **isolate realm** 里提供 `ctx.shell`。
 *
 * ## 为什么需要（HANDOFF 第九版 P0）
 * 宿主平面上的 `ctx.shell` 是 `dsh-bash-local`（或 Windows 上的 `dsh-pwsh-local`）：命令跑在
 * **Windows** 上。WSL preset 的文件工具已经原生（daemon 里 `node:fs`），但 `bash` 工具在 win32
 * 被禁用、终端仍是宿主 PTY ⇒ 模型只能靠 `wsl_exec` 一次一个 `wsl.exe`，没有持久 shell、没有 jobs。
 * 本模块把 `shell` 能力缝**在 preset 的隔离域里**换掉：组内 `tool-bash` 注入到的是这里的执行器，
 * 组外的宿主平面继续用原来的 shell（两边互不影响，靠 `isolate: { shell: true }`）。
 *
 * ## 契约（DSH 0.2.1-rc.3：`@deepseek-ai/dsh-shell` / `dsh-bash-local` / `dsh-tool-bash`）
 * 消费方只要求三件事：
 *   1. `resolve(request)` —— 把调用方的请求补全成完整 spec（workdir / timeoutMs / onExpiry / 上限）；
 *   2. `execute(spec)` —— 返回 **handle**：`status` / `exitCode` / `signal` / `observed.*.readFrom` /
 *      `done`（永不 reject）/ `readOutput()` / `kill()` / `result()`；
 *   3. `sandboxMode` —— **必须 `undefined`**：WSL 命令不受 Windows 文件沙箱约束；谎报
 *      `workspace-write` 会让 `tool-bash` 去要 `sandboxPolicy` 并向模型暴露一个假的提权通道。
 *
 * ## 执行模型（这一版的取舍，诚实记录）
 * 直接 `spawn('wsl.exe', ['-d', distro, '--exec', 'bash', script])`，**不经守护**：
 *   · 优点：不依赖 WSL 侧常驻守护（守护空闲会被回收）；每次命令干净的新 shell；失败面小。
 *   · 代价：每条命令一次 `wsl.exe` 启动（本机实测 ~40–90ms）。
 *   · 进程组回收：`wsl.exe` 被杀**不会**带走 Linux 侧进程（仓库已有实测教训，见 wsl-io.reapWsl），
 *     所以脚本用 `set -m` 把命令放进**以自身 pid 为 PGID 的独立进程组**，pid 写进
 *     `/tmp/<script>.pgid`；kill() 先在 WSL 里 `kill -TERM -- -PGID`，宽限后 `kill -KILL -- -PGID`，
 *     最后兜底杀 `wsl.exe`。正常结束时脚本自己按同一 PGID 收掉后台孤儿。
 *
 * ## 输出与上限
 * 每条流各留一份只增 Buffer；`readFrom(offset)` 按**字节偏移**增量返回，且只返回完整 UTF-8 码点
 * （不产生 U+FFFD）。超过上限后丢弃尾部并置 `lossy`（→ 工具面的 `truncated: true`）。
 * **这一版不落 spill 文件**：`readFrom` 不返回 `spillPath`（契约允许省略），spill 属后续增量。
 *
 * @module dsh-remote-wsl/shell-provider
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { normalizeConfig } from './config.ts';
import { shq } from './shell-quote.ts';
import { parseWslUncPath } from './unc-path.ts';

export const name = 'dsh-remote-wsl-shell';
export const inject = [];

/** 与 `dsh-bash-local` 同名的默认值（不复刻实现，只为让工具面行为一致；可用配置覆盖）。 */
const DEFAULTS = {
  timeoutMs: 120000,
  maxTimeoutMs: 600000,
  maxOutputBytes: 64 * 1024,
  graceMs: 3000,
};

/** 模型友好环境：关掉颜色/分页器（与 bash-local 的 ENV_OVERRIDES 一致）。 */
const ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `exit` 之后等待 stdio 排空的上限（`close` 通常紧跟；用户命令把后台进程拴在同一管道上时才用得到）。 */
const DRAIN_MS = 60;

/** 把任意错误变成一句人话。 */
function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  try {
    return String(error);
  } catch {
    return 'unprintable error';
  }
}

/** 取一个正数配置项，否则回落到默认（0/undefined/NaN 都算没配）。 */
function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 把调用方给的 workdir 翻译成 **WSL 内绝对路径**。
 *
 * 三种输入（WSL preset 会话的真实形态）：
 *   · UNC（`\\\\wsl.localhost\\<distro>\\home\\g` 或 `\\\\wsl$\\...`）—— 工作区在 9P 共享上时就是它；
 *   · Windows 路径（`D:\\project\\x`）→ `/mnt/d/project/x`（WSL2 默认 automount 根）；
 *   · Linux 绝对路径 —— 原样；相对路径 —— 相对 `cwd`（缺省 wslHome）拼接。
 *
 * @param value 调用方给的 workdir（可能 undefined）
 * @param cfg `normalizeConfig()` 的结果
 * @returns WSL 内绝对路径
 * @throws UNC 里的发行版与配置的 distro 不一致（跨发行版 cd 在本执行器里不成立，必须报错而不是猜）
 */
export function toLinuxWorkdir(value, cfg) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const fallback = cfg.cwd || cfg.wslHome || '/';
  if (raw.length === 0) return fallback;
  if (raw.includes('\0') || raw.includes('\n') || raw.includes('\r')) {
    throw new Error(`remote-wsl shell: workdir 含 NUL/换行，拒绝：${JSON.stringify(raw)}`);
  }
  const unc = parseWslUncPath(raw);
  if (unc) {
    if (cfg.distro && unc.distro !== cfg.distro) {
      throw new Error(
        `remote-wsl shell: workdir 指向发行版 "${unc.distro}"，但本执行器目标发行版是 "${cfg.distro}"（跨发行版执行不成立）`,
      );
    }
    return unc.linuxPath;
  }
  if (raw.startsWith('/')) return raw;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(raw);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].split('\\').join('/')}`;
  // 相对路径：相对 cwd 拼接（绝不落到进程 cwd —— 那是 Windows 目录，在 WSL 里不存在）
  return `${fallback.replace(/\/+$/, '')}/${raw.split('\\').join('/')}`;
}

/**
 * 有界增量读器：底层只增 Buffer；`readFrom(offset)` 从字节偏移解码，**只返回完整 UTF-8 码点**，
 * 因此连续读取不会产生替换字符，也不会重复/丢字节。
 * @param maxBytes 该流保留的字节上限（超出丢弃并置 lossy）
 */
function createStream(maxBytes) {
  const chunks = [];
  let total = 0;
  let dropped = 0;
  return {
    push(buf) {
      const room = maxBytes - total;
      if (room <= 0) {
        dropped += buf.length;
        return;
      }
      const take = buf.length <= room ? buf : buf.subarray(0, room);
      chunks.push(take);
      total += take.length;
      if (take.length < buf.length) dropped += buf.length - take.length;
    },
    bytes: () => Buffer.concat(chunks, total),
    get length() {
      return total;
    },
    get lossy() {
      return dropped > 0;
    },
    /** @returns `{text, nextOffset, lossy}`（nextOffset 永远落在码点边界） */
    readFrom(from) {
      const all = Buffer.concat(chunks, total);
      let start = Number.isFinite(from) && from > 0 ? Math.min(Math.floor(from), all.length) : 0;
      while (start > 0 && start < all.length && (all[start] & 0xc0) === 0x80) start -= 1;
      let end = all.length;
      // 末字节若是**不完整**码点，先不返回（下次数据到了再说）
      let lead = -1;
      for (let i = end - 1; i >= Math.max(0, end - 4); i -= 1) {
        if ((all[i] & 0xc0) !== 0x80) {
          lead = i;
          break;
        }
      }
      if (lead >= 0) {
        const b = all[lead];
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        if (lead + need > end) end = lead;
      }
      if (end < start) end = start;
      return { text: all.subarray(start, end).toString('utf8'), nextOffset: end, lossy: dropped > 0 };
    },
  };
}

/** WSL UNC 根（`\\wsl.localhost\<distro>`）。 */
const uncRoot = (distro) => `\\\\wsl.localhost\\${distro}`;
/** `/tmp/a.sh` → `\\wsl.localhost\<distro>\tmp\a.sh` */
const uncFile = (distro, linuxPath) => `${uncRoot(distro)}${linuxPath.split('/').join('\\')}`;

/**
 * 造一个 WSL shell 执行器（纯对象，不 import 任何 `@deepseek-ai/*`）。
 * @param options.config 插件配置（`normalizeConfig()` 会补默认值/自动探测目标）
 * @param options.spawn 注入的 spawn（测试用；默认 `node:child_process.spawn`）
 * @param options.now 注入的时钟（测试用）
 * @returns `ctx.shell` 的替代实现
 */
export function createWslShellProvider(options = {}) {
  // `options.cfg` 是**测试缝**：直接给已归一化的配置（跳过 auto-target 探测，避免单测真起 wsl.exe）。
  const cfg = options.cfg ?? normalizeConfig(options.config ?? {});
  const spawnImpl = options.spawn ?? nodeSpawn;
  const now = options.now ?? (() => Date.now());
  const io = options.io ?? fs;
  const graceMs = positive(cfg.shellGraceMs, DEFAULTS.graceMs);
  const maxOutputBytes = positive(cfg.shellMaxOutputBytes, DEFAULTS.maxOutputBytes);

  const tempPaths = () => {
    const token = `${process.pid}-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return {
      script: `/tmp/dsh-rwsl-shell-${token}.sh`,
      pgid: `/tmp/dsh-rwsl-shell-${token}.pgid`,
    };
  };

  /**
   * 生成 WSL 侧 wrapper 脚本。
   * 为什么不直接 `--exec bash -c <command>`：
   *   1. `cd`/env/错误文案要在 Linux 侧成句，且失败**必须非零退出**（不静默跑错目录）；
   *   2. 需要**独立进程组**才能回收整棵进程树 —— `set -m`（job control）让 `cmd &` 的作业拿到
   *      以自身 pid 为 PGID 的新进程组（实测 `ps -o pgid=` = 子 pid）；比 `setsid --wait` 干净：
   *      `setsid --wait` 在子进程被信号杀死时会往 stderr 打 `setsid: child … did not exit normally`
   *      并把退出码改写成信号号（实测 15），既脏又丢信息；`set -m` 保留 143 这种 bash 惯例码。
   *   3. 命令正常结束时，脚本用**同一个 PGID** 收掉后台孤儿（`kill -TERM -- -$pid`），不必再起 wsl.exe。
   */
  const buildScript = (spec, paths) => {
    const envEntries = Object.entries({ ...ENV_OVERRIDES, ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) }).filter(
      ([key, value]) => ENV_KEY.test(key) && value !== undefined && value !== null,
    );
    const envLines = envEntries.map(([key, value]) => `export ${key}=${shq(String(value))}`);
    const cdLine = `cd -- ${shq(spec.workdir)} || { echo ${shq(`remote-wsl shell: workdir 不存在或不可进入: ${spec.workdir}`)} >&2; exit 2; }`;
    const command = shq(spec.command);
    return [
      'set -uo pipefail',
      cdLine,
      ...envLines,
      'set -m',
      `bash -c ${command} &`,
      'pid=$!',
      `printf '%s' "$pid" > ${shq(paths.pgid)}`,
      'wait "$pid"; status=$?',
      // 正常结束时组里可能还留着后台子进程（`sleep 100 &`）；只清**本作业自己的**组
      'kill -TERM -- -"$pid" 2>/dev/null || true',
      'exit "$status"',
      '',
    ].join('\n');
  };

  /** 写脚本到 WSL /tmp（UNC 直写，不额外起进程；失败给出可诊断原因）。 */
  const writeScript = (distro, paths, body) => {
    io.writeFileSync(uncFile(distro, paths.script), body, { encoding: 'utf8', mode: 0o600 });
  };

  /** 删掉脚本与 pgid 记录（尽力而为；硬杀残留由插件既有的 sweepOwnTempFiles 兜底）。 */
  const removeTemp = (distro, paths) => {
    for (const linuxPath of [paths.script, paths.pgid]) {
      try {
        io.unlinkSync(uncFile(distro, linuxPath));
      } catch {
        /* 不存在即跳过 */
      }
    }
  };

  /** 在 WSL 里按进程组发信号（TERM / KILL 由调用方分两段发）。 */
  const signalGroup = (distro, paths, signal) => {
    const script = `PG=$(cat ${shq(paths.pgid)} 2>/dev/null || true); case "\${PG:-}" in ''|*[!0-9]*) exit 0;; esac; kill -${signal} -- -"$PG" 2>/dev/null || true`;
    try {
      const child = spawnImpl('wsl.exe', ['-d', distro, '--exec', 'bash', '-c', script], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      /* 回收是尽力而为：wsl.exe 自身会被兜底杀掉 */
    }
  };

  return {
    /** 不围栏：WSL 命令不受 Windows 文件沙箱约束（见文件头）。 */
    get sandboxMode() {
      return undefined;
    },

    /**
     * 补全请求（tool-bash 一定先调这里再 execute）。
     * @param request `{command, workdir?, timeoutMs?, onExpiry?, stdoutMaxBytes?, signal?, stdin?, env?, dshEnv?}`
     * @returns 完整 spec（workdir 已是 Linux 绝对路径）
     */
    resolve(request) {
      const command = String(request?.command ?? '');
      if (command.trim().length === 0) throw new Error('remote-wsl shell: command 不能为空');
      const workdir = toLinuxWorkdir(request?.workdir, cfg);
      const stdoutMaxBytes = positive(request?.stdoutMaxBytes, maxOutputBytes);
      const max = positive(cfg.shellMaxTimeoutMs, DEFAULTS.maxTimeoutMs);
      const base = positive(cfg.shellTimeoutMs, DEFAULTS.timeoutMs);
      const timeoutMs =
        Number.isFinite(request?.timeoutMs) && request.timeoutMs > 0
          ? Math.min(request.timeoutMs, max)
          : Math.min(base, max);
      return {
        command,
        workdir,
        timeoutMs,
        onExpiry: request?.onExpiry ?? 'kill',
        stdoutMaxBytes,
        ...(request?.signal ? { signal: request.signal } : {}),
        ...(request?.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request?.env !== undefined ? { env: request.env } : {}),
        ...(request?.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      };
    },

    /**
     * 起一条命令并返回 handle（**不等结束**；前台/后台由调用方是否 await `result()` 决定）。
     * @param spec `resolve()` 的返回值
     * @returns handle
     */
    async execute(spec) {
      const distro = String(cfg.distro ?? '').trim();
      if (!distro) {
        throw new Error(
          'remote-wsl shell: 目标发行版未解析（自动探测失败）。请在插件配置里显式设置 distro，或用 wsl_status({redetect:true}) 重探。',
        );
      }
      const paths = tempPaths();
      try {
        writeScript(distro, paths, buildScript(spec, paths));
      } catch (error) {
        throw new Error(
          `remote-wsl shell: 无法在发行版 "${distro}" 里写启动脚本（发行版没在跑？原始错误: ${messageOf(error)}）`,
        );
      }

      const stdout = createStream(spec.stdoutMaxBytes);
      const stderr = createStream(spec.stdoutMaxBytes);
      let killed = false;
      let timedOut = false;
      let aborted = false;
      let providerFailed = false;
      let spawnError;
      let settled = false;
      let exitCode = null;
      let exitSignal = null;
      let stdoutOffset = 0;
      let stderrOffset = 0;
      let terminateTimer = null;
      let drainTimer = null;
      let deadlineTimer = null;
      let onAbort = null;
      const finish = {};
      const done = new Promise((resolve) => {
        finish.resolve = resolve;
      });

      const settle = (code, signal) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (terminateTimer) clearTimeout(terminateTimer);
        if (drainTimer) clearTimeout(drainTimer);
        if (onAbort && spec.signal) {
          try {
            spec.signal.removeEventListener('abort', onAbort);
          } catch {
            /* ignore */
          }
        }
        // 正常结束时的组内孤儿由 wrapper 脚本自己收（见 buildScript）；只有我们主动 kill 才在这里补刀
        if (killed || timedOut || aborted) signalGroup(distro, paths, 'KILL');
        removeTemp(distro, paths);
        // 被我们杀掉的进程没有"自己的退出码"语义：与 dsh-bash-local 一致地报 null，
        // 让工具面用 killed/timedOut 分类，而不是把 bash 的 143 渲染成"命令失败"。
        const wasForced = killed || timedOut || aborted;
        exitCode = wasForced ? null : code;
        exitSignal = wasForced ? 'SIGTERM' : signal;
        proc.exitCode = exitCode;
        proc.signal = exitSignal;
        proc.status = wasForced || providerFailed ? 'killed' : 'completed';
        finish.resolve();
      };

      const proc = {
        status: 'running',
        exitCode: null,
        signal: null,
        observed: {
          stdout: { readFrom: (from) => stdout.readFrom(from) },
          stderr: { readFrom: (from) => stderr.readFrom(from) },
        },
        done,
        readOutput: () => {
          const out = stdout.readFrom(stdoutOffset);
          const err = stderr.readFrom(stderrOffset);
          stdoutOffset = out.nextOffset;
          stderrOffset = err.nextOffset;
          const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : '';
          return {
            delta: out.text + (err.text.length > 0 ? `${separator}[stderr]\n${err.text}` : ''),
            lossy: out.lossy || err.lossy,
          };
        },
        kill: () => {
          if (settled) return false;
          if (killed) return false;
          killed = true;
          signalGroup(distro, paths, 'TERM');
          terminateTimer = setTimeout(() => {
            signalGroup(distro, paths, 'KILL');
            try {
              child.kill('SIGKILL');
            } catch {
              /* 已退出 */
            }
          }, graceMs);
          terminateTimer.unref?.();
          return true;
        },
        result: () =>
          done.then(() => {
            if (spawnError) throw spawnError;
            return {
              exitCode,
              signal: exitSignal,
              timedOut,
              aborted,
              timeoutMs: spec.timeoutMs,
              stdout: { text: stdout.bytes().toString('utf8'), truncated: stdout.lossy },
              stderr: { text: stderr.bytes().toString('utf8'), truncated: stderr.lossy },
            };
          }),
      };

      let child;
      try {
        child = spawnImpl('wsl.exe', ['-d', distro, '--exec', 'bash', paths.script], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        spawnError = error;
        removeTemp(distro, paths);
        proc.status = 'killed';
        finish.resolve();
        return proc;
      }

      child.stdout?.on('data', (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.on?.('error', (error) => {
        spawnError ??= error;
        providerFailed = spawnError === error;
        stderr.push(Buffer.from(`\nremote-wsl shell: 无法启动 wsl.exe: ${messageOf(error)}`, 'utf8'));
        settle(1, null);
      });
      // `exit` 时 stdio 可能还没排空；`close` 才是"已退出且流关闭"。给一个有界排空窗口兜底。
      child.on?.('exit', (code, signal) => {
        drainTimer = setTimeout(() => settle(code, signal), DRAIN_MS);
        drainTimer.unref?.();
      });
      child.on?.('close', (code, signal) => settle(code, signal));

      try {
        child.stdin?.end(spec.stdin !== undefined ? String(spec.stdin) : undefined);
      } catch {
        /* ignore */
      }

      if (spec.onExpiry === 'kill' && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
        deadlineTimer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          proc.kill();
        }, spec.timeoutMs);
        deadlineTimer.unref?.();
      }
      if (spec.signal) {
        onAbort = () => {
          if (settled) return;
          aborted = true;
          proc.kill();
        };
        if (spec.signal.aborted) onAbort();
        else {
          try {
            spec.signal.addEventListener('abort', onAbort, { once: true });
          } catch {
            /* ignore */
          }
        }
      }

      return proc;
    },
  };
}

/**
 * 插件入口：把执行器注册成当前 realm 的 `shell` 服务。
 * 只应在 preset 的 `wsl-world` 隔离组里被挂载 —— 在宿主平面上挂它会抢掉 `dsh-bash-local`/`dsh-pwsh-local`。
 * @param ctx cordis 上下文
 * @param rawConfig 插件配置（与宿主平面同一份，`normalizeConfig()` 归一）
 */
export function apply(ctx, rawConfig = {}) {
  ctx.provide('shell', createWslShellProvider({ config: rawConfig }));
}
