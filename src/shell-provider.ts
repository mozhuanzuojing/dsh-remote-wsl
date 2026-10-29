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
 * 每条流各留一份**尾部** Buffer（与 `dsh-bash-local` 的 "truncated to its tail" 一致）；`readFrom(offset)`
 * 按**全流累计字节偏移**增量返回，且只返回完整 UTF-8 码点（不产生 U+FFFD）。超过上限后丢头部并置
 * `lossy`（→ 工具面的 `truncated: true`），同时把**全文**落到 WSL `/tmp/dsh-rwsl-<winpid>-shell-*.out`，
 * `readFrom` / `result` 返回 `spillPath`（由插件既有 `/tmp` 清扫器回收）。
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
 * 有界增量读器：**留尾部、丢头部**（与 `dsh-bash-local` / bash 工具契约「Long output is truncated
 * to its tail」一致；初版留头丢尾，2026-10-29 review 修正）。
 *
 * `readFrom(offset)` 的 offset 是**全流累计字节偏移**（不是保留区内的下标）：保留区用 `start` 记录
 * 第一个保留字节的绝对偏移；调用方传入已被丢弃的偏移时，从 `start` 开始返回并置 `lossy`。
 * 解码只返回完整 UTF-8 码点，`nextOffset` 永远落在码点边界。
 * @param maxBytes 保留的尾部字节上限
 * @param spill 可选的全文落盘口（`{path, write(buf), append(buf)}`）；第一次溢出时把已收前缀写入
 */
function createStream(maxBytes, spill = null) {
  const chunks = [];
  /** 保留区第一个字节的绝对偏移（>0 ⇒ 头部已丢）。 */
  let start = 0;
  /** 全流已收字节数（绝对总量）。 */
  let total = 0;
  let spilling = false;
  let spillPath = null;
  let spillError = null;

  const writeSpill = (buf, append) => {
    if (!spill) return;
    try {
      if (append) spill.append(buf);
      else spill.write(buf);
      spillPath = spill.path;
    } catch (error) {
      spillError = messageOf(error);
    }
  };
  const trim = () => {
    let excess = total - start - maxBytes;
    while (excess > 0 && chunks.length > 0) {
      const first = chunks[0];
      if (first.length <= excess) {
        chunks.shift();
        start += first.length;
        excess -= first.length;
      } else {
        chunks[0] = first.subarray(excess);
        start += excess;
        excess = 0;
      }
    }
  };
  return {
    push(buf) {
      if (!spilling) {
        chunks.push(buf);
        total += buf.length;
        if (total > maxBytes && spill) {
          writeSpill(Buffer.concat(chunks), false); // 首次溢出：完整前缀落盘
          spilling = true;
        }
      } else {
        chunks.push(buf);
        total += buf.length;
        writeSpill(buf, true);
      }
      trim();
    },
    bytes: () => Buffer.concat(chunks, total - start),
    get length() {
      return total;
    },
    get lossy() {
      return start > 0;
    },
    get spillPath() {
      return spillPath;
    },
    get spillError() {
      return spillError;
    },
    /** @returns `{text, nextOffset, lossy, spillPath?}`（nextOffset 是**绝对**偏移，落在码点边界） */
    readFrom(from) {
      const all = Buffer.concat(chunks, total - start);
      const requested = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
      let begin = Math.max(requested, start) - start;
      while (begin > 0 && begin < all.length && (all[begin] & 0xc0) === 0x80) begin -= 1;
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
      if (end < begin) end = begin;
      return {
        text: all.subarray(begin, end).toString('utf8'),
        nextOffset: start + end,
        lossy: start > 0,
        ...(spillPath !== null ? { spillPath } : {}),
      };
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
  /** 活着的 handle：组合销毁时要按 `dsh-shell` 契约「stop and await」（见 apply 的 effect）。 */
  const live = new Set();

  const tempPaths = () => {
    // 文件名必须匹配插件既有清扫器 `find /tmp -name 'dsh-rwsl-<winPid>-*'`（wsl-io.sweepOwnTempFiles），
    // 否则宿主硬杀留下的脚本/溢出文件永远没人清。
    const token = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const base = `dsh-rwsl-${process.pid}-shell-${token}`;
    return {
      script: `/tmp/${base}.sh`,
      pgid: `/tmp/${base}.pgid`,
      stdout: `/tmp/${base}.out`,
      stderr: `/tmp/${base}.err`,
    };
  };

  /** 溢出全文落盘口（WSL /tmp；只在真的超过上限时创建；保留到插件下次清扫，供模型/用户读全文）。 */
  const spillTarget = (distro, linuxPath) => ({
    path: linuxPath,
    write: (buf) => io.writeFileSync(uncFile(distro, linuxPath), buf, { mode: 0o600 }),
    append: (buf) => io.appendFileSync(uncFile(distro, linuxPath), buf, { mode: 0o600 }),
  });

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

  /** 读一次 pgid 记录（WSL /tmp 的 UNC 直读）；没有/不是正整数 ⇒ null。 */
  const readPgid = (distro, paths) => {
    try {
      const raw = String(io.readFileSync(uncFile(distro, paths.pgid), 'utf8')).trim();
      if (!/^\d+$/.test(raw)) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  };

  /**
   * 在 WSL 里按进程组发信号（TERM / KILL 由调用方分两段发）。
   * 2026-10-29 review 修复：**不再从文件里读 PGID**，由调用方把读到的数字传进来。
   * 旧实现让 kill 脚本自己去 `cat` 文件：`settle()` 删文件与异步 kill 脚本读文件之间存在竞态，
   * 实测「超时（命令 trap TERM）/ 立即 kill」会留下孤儿 `sleep`（pgid 文件已被删 ⇒ 脚本读到空 ⇒ 一发信号都没发）。
   * @param pgid 目标进程组（调用方已从 pgid 文件读出并校验为正整数）
   * @param signal `TERM` | `KILL`
   */
  const signalGroup = (distro, pgid, signal) => {
    if (!Number.isSafeInteger(pgid) || pgid <= 0) return;
    const script = `kill -${signal} -- -${pgid} 2>/dev/null || true`;
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
      // 与 dsh-timeout.clampTimeout / dsh-bash-local.assertPositiveFinite 同语义：**显式给的非法值要抛**，
      // 不能静默回落默认值（那会让调用方以为自己的上限生效了）。
      if (request?.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
        throw new Error('remote-wsl shell: timeoutMs must be a positive finite number');
      }
      if (request?.stdoutMaxBytes !== undefined && (!Number.isFinite(request.stdoutMaxBytes) || request.stdoutMaxBytes <= 0)) {
        throw new Error('remote-wsl shell: stdoutMaxBytes must be a positive finite number');
      }
      const workdir = toLinuxWorkdir(request?.workdir, cfg);
      const max = positive(cfg.shellMaxTimeoutMs, DEFAULTS.maxTimeoutMs);
      const base = positive(cfg.shellTimeoutMs, DEFAULTS.timeoutMs);
      const timeoutMs = Math.min(request?.timeoutMs ?? base, max);
      const stdoutMaxBytes = request?.stdoutMaxBytes ?? maxOutputBytes;
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
        // 契约对齐（dsh-bash-local:103）：调用方给的 sandboxPolicy 原样带进 spec。
        // 本执行器 `sandboxMode=undefined`，tool-bash 不会传；带上是为了"换成别的调用方"时不丢字段。
        ...(request?.sandboxPolicy !== undefined ? { sandboxPolicy: request.sandboxPolicy } : {}),
      };
    },

    /**
     * 起一条命令并返回 handle（**不等结束**；前台/后台由调用方是否 await `result()` 决定）。
     * @param spec `resolve()` 的返回值
     * @returns handle
     */
    async execute(spec) {
      const startedAt = now();
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

      const stdout = createStream(spec.stdoutMaxBytes, spillTarget(distro, paths.stdout));
      // stderr 上限跟 `dsh-bash-local` 一样取 `maxOutputBytes`（不是调用方的 stdoutMaxBytes）：
      // 两者混用会让"把 stdout 调大"顺手把 stderr 也放大，与上游语义不一致。
      const stderr = createStream(maxOutputBytes, spillTarget(distro, paths.stderr));
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
      let pgidRetryTimer = null;
      let drainTimer = null;
      let deadlineTimer = null;
      let onAbort = null;
      /** 命令进程组（从 WSL /tmp 的 pgid 文件读出，turn 一次就缓存；kill 一发必须带上它）。 */
      let knownPgid = null;
      const currentPgid = () => {
        if (knownPgid !== null) return knownPgid;
        const read = readPgid(distro, paths);
        if (read !== null) knownPgid = read;
        return knownPgid;
      };
      const finish = {};
      const done = new Promise((resolve) => {
        finish.resolve = resolve;
      });

      const settle = (code, signal) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (terminateTimer) clearTimeout(terminateTimer);
        if (pgidRetryTimer) clearTimeout(pgidRetryTimer);
        if (drainTimer) clearTimeout(drainTimer);
        if (onAbort && spec.signal) {
          try {
            spec.signal.removeEventListener('abort', onAbort);
          } catch {
            /* ignore */
          }
        }
        // 正常结束时的组内孤儿由 wrapper 脚本自己收（见 buildScript）；只有我们主动 kill 才在这里补刀。
        // 2026-10-29 review：这里必须用**缓存的数字**（或再读一次）发 KILL —— 不能依赖 kill 脚本回头读文件，
        // settle 会立刻删掉它。
        if (killed || timedOut || aborted) {
          const pgid = currentPgid();
          if (pgid !== null) signalGroup(distro, pgid, 'KILL');
        }
        removeTemp(distro, paths);
        // 被我们杀掉的进程没有"自己的退出码"语义：与 dsh-bash-local 一致地报 null，
        // 让工具面用 killed/timedOut 分类，而不是把 bash 的 143 渲染成"命令失败"。
        const wasForced = killed || timedOut || aborted;
        exitCode = wasForced ? null : code;
        exitSignal = wasForced ? 'SIGTERM' : signal;
        proc.exitCode = exitCode;
        proc.signal = exitSignal;
        proc.status = wasForced || providerFailed ? 'killed' : 'completed';
        live.delete(proc);
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
          const pgid = currentPgid();
          if (pgid !== null) {
            signalGroup(distro, pgid, 'TERM');
          } else {
            // 命令可能还没把 PGID 写出来（wsl.exe 启动 ~100ms）：短轮询一次，
            // 否则"kill 太早"会既不杀命令、又在宽限后只杀 wsl.exe ⇒ Linux 侧留孤儿（实测）。
            pgidRetryTimer = setTimeout(() => {
              if (settled) return;
              const late = currentPgid();
              if (late !== null) signalGroup(distro, late, 'TERM');
            }, 120);
            pgidRetryTimer.unref?.();
          }
          terminateTimer = setTimeout(() => {
            const finalPgid = currentPgid();
            if (finalPgid !== null) signalGroup(distro, finalPgid, 'KILL');
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
            const spillNotes = [stdout.spillError, stderr.spillError]
              .filter((note) => typeof note === 'string' && note.length > 0)
              .map((note) => `remote-wsl shell: spill 写入失败：${note}\n`)
              .join('');
            return {
              exitCode,
              signal: exitSignal,
              timedOut,
              aborted,
              timeoutMs: spec.timeoutMs,
              stdout: {
                text: stdout.bytes().toString('utf8'),
                truncated: stdout.lossy,
                ...(stdout.spillPath !== null ? { spillPath: stdout.spillPath } : {}),
              },
              stderr: {
                text: stderr.bytes().toString('utf8') + spillNotes,
                truncated: stderr.lossy,
                ...(stderr.spillPath !== null ? { spillPath: stderr.spillPath } : {}),
              },
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

      // 超时从 execute() 入口起算（含写脚本/冷启动的准备期）——与 dsh-bash-local 的
      // "Expiry during preparation returns a settled timed-out handle" 对齐；剩余时间 ≤0 就直接杀。
      if (spec.onExpiry === 'kill' && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) {
        const remaining = spec.timeoutMs - (now() - startedAt);
        if (remaining <= 0) {
          timedOut = true;
          proc.kill();
        } else {
          deadlineTimer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            proc.kill();
          }, remaining);
          deadlineTimer.unref?.();
        }
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

      live.add(proc);
      return proc;
    },

    /**
     * 组合销毁时的收尾（`dsh-shell` 契约：still-running process 要被 stop 并 await）。
     * 只 kill 我们自己的 handle；不碰发行版里别的进程。
     * @returns 全部 handle settle 或 `graceMs + 2s` 超时后返回（不抛）
     */
    async shutdown() {
      const pending = [...live];
      if (pending.length === 0) return;
      for (const handle of pending) {
        try {
          handle.kill();
        } catch {
          /* ignore */
        }
      }
      const all = Promise.all(pending.map((handle) => handle.done.catch(() => undefined)));
      const timeout = new Promise((resolve) => setTimeout(resolve, graceMs + 2000));
      await Promise.race([all, timeout]);
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
  const provider = createWslShellProvider({ config: rawConfig });
  ctx.provide('shell', provider);
  // `dsh-shell` 契约：组合销毁时 still-running 的进程要被 stop 并 await（不能把孤儿留给发行版）。
  // cordis 的 effect 回调返回 disposer；这里 fire-and-forget 地跑 shutdown（内部自带超时，不抛）。
  ctx.effect(() => () => {
    void provider.shutdown();
  });
}
