/**
 * daemon-protocol.ts —— T3 拆分自 `daemon-client.ts`（1068 行）的 **协议/IO 层**：路径与槽位元数据、进程扫描、WSL 脚本执行、TCP 调用与握手。
 *
 * 来源：`src/daemon-client.ts` @ sha256 cb420d25ef1bcf9535cbf2f3dbb3faad95fa0d5321b31d0ca798103de59dbed1（原文件已备份到
 * `spike/verify/explorer-20261012/arch-t3/backup/daemon-client.cb420d25.ts.bak`）。
 * **代码逐字搬移**（由 `arch-t3/tools/apply-split.ts` 按行区间生成），未改写实现。
 * 导出：路径/元数据/slot 发现/扫描/`wslRunScript`/`tcpCall`/`handshake`/`callDaemon`/`daemonPrompt`；`sleep` 额外导出供 lifecycle 复用。
 *
 * 零构建纪律：只用可擦除语法；相对导入带 `.ts`；只引 `node:` 内置与同目录相对模块。
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

// ── 原 daemon-client.ts 第 25-25 行 ──
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 原 daemon-client.ts 第 28-32 行 ──
export function unc(distro, linuxPath) {
  return `\\\\wsl.localhost\\${distro}\\${linuxPath.replace(/^\//, '').replace(/\//g, '\\')}`;
}

/** Windows 绝对路径 → WSL 的 /mnt/<drive> 路径（守护脚本自己就住在这个插件目录里）。 */

// ── 原 daemon-client.ts 第 33-39 行 ──
export function winToWsl(winPath) {
  const p = String(winPath).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : p;
}

/** 守护脚本的 WSL 路径 —— 从**本模块自己的位置**推导，插件被 link 到哪就在哪。 */

// ── 原 daemon-client.ts 第 40-43 行 ──
export function daemonScriptWsl() {
  return winToWsl(fileURLToPath(new URL('./daemon.ts', import.meta.url)));
}


// ── 原 daemon-client.ts 第 44-45 行 ──
export const stateDirLinux = (cfg) => `${cfg.wslHome}/.dsh/remote-wsl`;
/** 元数据按**槽位**分文件（槽位 = 启动时请求的端口）⇒ 两个守护并存互不覆盖元数据。 */

// ── 原 daemon-client.ts 第 46-46 行 ──
export const metaLinux = (cfg, slot = cfg.daemonPort) => `${stateDirLinux(cfg)}/daemon.${slot}.json`;

// ── 原 daemon-client.ts 第 47-53 行 ──
export const tokenLinux = (cfg, slot = cfg.daemonPort) => `${stateDirLinux(cfg)}/daemon.${slot}.token`;
/**
 * 启动脚本**按槽位分文件**（`launch.<slot>.sh`）。
 * 为什么不能是单文件：两个槽位同时启动会互相覆盖 —— task-4 实测出现过
 * "A 要 8759 却握手到 8760（`daemon.8759.json` 记 `port:8760`）、真正监听 8759 的守护**完全没有元数据**、
 * 终态 3 个守护而只请求 2 个"的竞态。写入还必须**原子**（tmp + rename）：直接写会让并发读者看到**半截脚本**。
 */

// ── 原 daemon-client.ts 第 54-54 行 ──
export const launchLinux = (cfg, slot = cfg.daemonPort) => `${stateDirLinux(cfg)}/launch.${slot}.sh`;

// ── 原 daemon-client.ts 第 55-60 行 ──
export const logLinux = (cfg) => `${stateDirLinux(cfg)}/daemon.log`;
/**
 * 过渡期兼容：单文件元数据（`daemon.json` / `daemon.token`）。
 * 为什么必须认它：旧版本的守护（或本插件升级前起的那个）仍可能活着并占着端口；
 * 不认它 ⇒ 新客户端会另起一个、而旧守护变成不可见的孤儿（占端口 + 占运行时）。
 */

// ── 原 daemon-client.ts 第 61-61 行 ──
export const legacyMetaLinux = (cfg) => `${stateDirLinux(cfg)}/daemon.json`;

// ── 原 daemon-client.ts 第 62-64 行 ──
export const legacyTokenLinux = (cfg) => `${stateDirLinux(cfg)}/daemon.token`;

/** 扫出所有槽位（配置端口排最前）——"发现已有守护"与 status 都不假设只有一个守护。 */

// ── 原 daemon-client.ts 第 65-81 行 ──
export function listDaemonSlots(cfg): number[] {
  let names: string[] = [];
  try {
    names = readdirSync(unc(cfg.distro, stateDirLinux(cfg)));
  } catch {
    return [];
  }
  const slots: number[] = [];
  for (const n of names) {
    const m = /^daemon\.(\d+)\.json$/.exec(n);
    if (m) slots.push(Number(m[1]));
  }
  const pref = Number(cfg.daemonPort) || 8731;
  return [...new Set(slots)].sort((a, b) => (a === pref ? -1 : b === pref ? 1 : a - b));
}

/** 读某个槽位的元数据（不传槽位 ⇒ 扫全部，返回第一个能解析的）。 */

// ── 原 daemon-client.ts 第 82-94 行 ──
export function readDaemonMeta(cfg, slot?: number) {
  const slots = slot ? [slot] : listDaemonSlots(cfg);
  for (const s of slots) {
    try {
      const m = JSON.parse(readFileSync(unc(cfg.distro, metaLinux(cfg, s)), 'utf8'));
      if (m && typeof m === 'object') return m;
    } catch {
      /* 试下一个槽位 */
    }
  }
  return null;
}


// ── 原 daemon-client.ts 第 95-108 行 ──
export function readDaemonToken(cfg, slot?: number) {
  const slots = slot ? [slot] : listDaemonSlots(cfg);
  for (const s of slots) {
    try {
      const t = readFileSync(unc(cfg.distro, tokenLinux(cfg, s)), 'utf8').trim();
      if (t) return t;
    } catch {
      /* 试下一个槽位 */
    }
  }
  return null;
}

/** 元数据 + token 必须来自**同一个槽位**（拿 A 的端口配 B 的 token 必然 unauthorized）。 */

// ── 原 daemon-client.ts 第 109-135 行 ──
export function readDaemonRecord(cfg, slot?: number) {
  const slots = slot ? [slot] : listDaemonSlots(cfg);
  for (const s of slots) {
    try {
      const meta = JSON.parse(readFileSync(unc(cfg.distro, metaLinux(cfg, s)), 'utf8'));
      const token = readFileSync(unc(cfg.distro, tokenLinux(cfg, s)), 'utf8').trim();
      if (meta && typeof meta === 'object' && token) return { slot: s, meta, token, legacy: false };
    } catch {
      /* 试下一个槽位 */
    }
  }
  if (!slot) {
    // 过渡期：单文件元数据里的守护也要被认出来（否则它会变成不可见的孤儿）
    try {
      const meta = JSON.parse(readFileSync(unc(cfg.distro, legacyMetaLinux(cfg)), 'utf8'));
      const token = readFileSync(unc(cfg.distro, legacyTokenLinux(cfg)), 'utf8').trim();
      if (meta && typeof meta === 'object' && token) {
        return { slot: Number(meta.port) || cfg.daemonPort, meta, token, legacy: true };
      }
    } catch {
      /* 没有旧记录 */
    }
  }
  return null;
}

/** 读守护日志尾部（诊断用；日志在 state 目录里，不落 /tmp）。 */

// ── 原 daemon-client.ts 第 136-149 行 ──
export function readDaemonLogTail(cfg, lines = 8) {
  try {
    return readFileSync(unc(cfg.distro, logLinux(cfg)), 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * **孤儿发现**：在跑、但元数据缺失（或元数据是陈的）的守护进程。
 * 判据是**双重身份**（照 task-9 要求）：cmdline 命中本插件的守护脚本（`daemon.ts` / `daemon.mjs`）
 * **且** 带 `--state-dir <本插件 state-dir>` —— 只认自己的，避免误杀别人的进程。
 * 为什么需要：元数据文件被清/没写成时，守护就成了"工具发现不了也回收不了"的孤儿（task-4 实测）。
 */

// ── 原 daemon-client.ts 第 150-195 行 ──
export function scanDaemonProcesses(cfg) {
  let stdout = '';
  try {
    stdout = wslRunScript(cfg, scanDaemonProcessesScript(cfg), 20000).stdout;
  } catch {
    return [];
  }
  return parseScanOutput(stdout);
}

/**
 * 异步版的进程扫描（2026-10-27 审查 F-15）：控制面（status / stop / ensure / snapshot）原先全走
 * `spawnSync('wsl.exe')`，单次 0.3–1s、超时 20s ⇒ **同步阻塞宿主事件循环**，表现为整个 DSH GUI 卡顿。
 * 这里提供等价的异步实现，调用方（daemon-lifecycle 的 async 函数）应优先用它。
 */
export async function scanDaemonProcessesAsync(cfg) {
  try {
    const r = await wslRunScriptAsync(cfg, scanDaemonProcessesScript(cfg), 20000);
    return parseScanOutput(r.stdout);
  } catch {
    return [];
  }
}

/** 扫描脚本（同步/异步共用，避免两份判据漂移）。 */
export function scanDaemonProcessesScript(cfg) {
  const state = stateDirLinux(cfg).replace(/'/g, `'\\''`);
  return [
    `S='${state}'`,
    'for d in /proc/[0-9]*; do',
    '  [ -r "$d/cmdline" ] || continue',
    `  c=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null) || continue`,
    '  case "$c" in *daemon.ts*|*daemon.mjs*) ;; *) continue ;; esac',
    `  case "$c" in *"--state-dir $S "*|*"--state-dir $S") ;; *) continue ;; esac`,
    `  p=$(printf '%s' "$c" | sed -n 's/.*--port \\([0-9]\\{1,\\}\\).*/\\1/p')`,
    `  m=$(printf '%s' "$c" | sed -n 's/.*--meta-port \\([0-9]\\{1,\\}\\).*/\\1/p')`,
    '  echo "${d#/proc/}|$p|$m"',
    'done',
    'true',
  ].join('\n');
}

/** 扫描输出解析（同步/异步共用）。 */
export function parseScanOutput(stdout) {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [pid, port, metaPort] = t.split('|');
    if (!/^\d+$/.test(pid)) continue;
    out.push({
      pid: Number(pid),
      port: port && /^\d+$/.test(port) ? Number(port) : null,
      metaPort: metaPort && /^\d+$/.test(metaPort) ? Number(metaPort) : null,
    });
  }
  return out;
}

/**
 * 在 WSL 里跑一段脚本 —— **必须 base64 管道进 bash**，不要写
 * `wsl.exe -d <distro> -- bash -c "<script>"`。
 *
 * 实测（2026-10-10 本机，task-9 排查）：后一种写法**不是 argv-exec**：命令串会先经过发行版的
 * **默认登录 shell**（本机是 zsh）展开一次 ⇒ `$var` 被外层吃掉、glob 被外层先展开。
 * 证据：`bash -c 'for x in a b c; do echo "x=[$x]"; done'` 打出 `x=[] x=[] x=[]`；
 * `bash -c 'i=5; echo "i=$i"'` 打出 `i=`；`$0` 报 `/usr/bin/zsh`。
 * base64 管道则把脚本原样交给 bash（同一脚本实测能正确扫出 `/proc` 里的守护进程）。
 */

// ── 原 daemon-client.ts 第 196-215 行 ──
export function wslRunScript(cfg, script, timeoutMs = 20000) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  try {
    const res = spawnSync('wsl.exe', ['-d', cfg.distro, '--exec', 'bash', '-c', `echo ${b64} | base64 -d | bash`], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
    });
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: String(res.stdout || ''),
      stderr: String(res.stderr || ''),
    };
  } catch (e) {
    return { ok: false, status: -1, stdout: '', stderr: e?.message ?? String(e) };
  }
}

/**
 * `wslRunScript` 的**异步版**（2026-10-27 审查 F-15）：控制面（status / stop / ensure / snapshot）
 * 原先全走 `spawnSync('wsl.exe')`，单次 0.3–1s、超时 20s ⇒ 同步阻塞宿主事件循环，整个 GUI 卡顿。
 * 语义保持一致（base64 → bash，stdout/stderr 全收）；超时按 `status: 124` 返回。
 */
export function wslRunScriptAsync(cfg, script, timeoutMs = 20000) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('wsl.exe', ['-d', cfg.distro, '--exec', 'bash', '-c', `echo ${b64} | base64 -d | bash`], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, status: -1, stdout: '', stderr: e?.message ?? String(e) });
      return;
    }
    const out = [];
    const err = [];
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: status === 0,
        status,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish(124);
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => {
      err.push(Buffer.from(String(e?.message ?? e)));
      finish(-1);
    });
    child.on('close', (code) => finish(code == null ? -1 : code));
  });
}

/**
 * 「端口上有没有人在听」的最小探针（2026-10-27 审查 F-18）。
 *
 * 判活不能只看 3s 的 status 应答：守护是单线程，provision/预热里 `spawnSync(curl)` 会把它按住
 * 几十秒 —— 于是"忙"被当成"死"，`daemonSnapshot` 把 pid 归进 orphans，`wsl_status` 再建议
 * `stop all=true`，用户照做就杀掉带会话的健康守护。连接能不能建立才是"进程还活着"的硬证据。
 */
export function tcpProbe(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let socket;
    let done = false;
    const finish = (open, kind, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      resolve({ open, kind, error });
    };
    const timer = setTimeout(() => finish(false, 'timeout', `probe timeout after ${timeoutMs}ms`), timeoutMs);
    try {
      socket = net.connect({ host: '127.0.0.1', port });
    } catch (e) {
      finish(false, 'refused', e?.message ?? String(e));
      return;
    }
    socket.once('connect', () => finish(true, 'open'));
    socket.once('error', (e) => finish(false, e?.code === 'ECONNREFUSED' ? 'refused' : 'error', e?.message ?? String(e)));
  });
}

// ── 并发启动锁（2026-10-27 审查 F-05）──────────────────────────────────────
//
// 为什么需要：`ensureDaemon` 没有互斥。两个宿主（或同一轮的两次并行工具调用）会同时判定
// "槽位无守护"，然后各自启动 —— 槽位的 token / launch 脚本 / 元数据是**三份共享文件**，后写者
// 覆盖先写者；接着"无元数据 ⇒ 先收掉"的分支会把另一个宿主刚起的、带着会话的健康守护杀掉。
//
// 为什么用**目录**（mkdir 原子）：EEXIST 就是原子的抢占判据，不需要额外时间戳比较；陈旧锁按
// mtime 判定（ensure 正常耗时远小于阈值），崩溃残留能自愈。

export const ensureLockLinux = (cfg, slot = cfg.daemonPort) => `${stateDirLinux(cfg)}/ensure.${slot}.lock`;

/** 抢占脚本（纯构造函数，便于用 bash 单测）：成功输出 `LOCKED`，否则 `BUSY`。 */
export function acquireEnsureLockScript(lockLinux, staleSeconds = 120) {
  const d = `'${String(lockLinux).replace(/'/g, `'\\''`)}'`;
  const mins = Math.max(1, Math.ceil(Number(staleSeconds) / 60));
  return [
    `d=${d}`,
    'if mkdir "$d" 2>/dev/null; then',
    '  date +%s > "$d/ts" 2>/dev/null || true',
    '  echo LOCKED',
    'else',
    `  if [ -n "$(find "$d" -maxdepth 0 -mmin +${mins} 2>/dev/null)" ]; then`,
    '    rm -rf "$d"',
    '    if mkdir "$d" 2>/dev/null; then date +%s > "$d/ts" 2>/dev/null || true; echo LOCKED; else echo BUSY; fi',
    '  else',
    '    echo BUSY',
    '  fi',
    'fi',
  ].join('\n');
}

/** 释放脚本（纯构造）。 */
export function releaseEnsureLockScript(lockLinux) {
  return `rm -rf -- '${String(lockLinux).replace(/'/g, `'\\''`)}'\ntrue`;
}

/** 尝试抢占一次（不等待）。 */
export async function tryAcquireEnsureLock(cfg, slot, { staleSeconds = 120 } = {}) {
  try {
    const r = await wslRunScriptAsync(cfg, acquireEnsureLockScript(ensureLockLinux(cfg, slot), staleSeconds), 15000);
    return /^LOCKED$/m.test(r.stdout);
  } catch {
    return false;
  }
}

/** 释放锁（幂等；失败只记不抛）。 */
export async function releaseEnsureLock(cfg, slot, log = () => {}) {
  try {
    await wslRunScriptAsync(cfg, releaseEnsureLockScript(ensureLockLinux(cfg, slot)), 15000);
  } catch (e) {
    log(`释放启动锁失败（忽略）: ${e?.message ?? String(e)}`);
  }
}

/** 只有清指定槽位的元数据/token（并发守护隔离：绝不动别的槽位）。`legacy` 时清单文件那两个。 */

// ── 原 daemon-client.ts 第 236-291 行 ──
/**
 * 一条连接发一串帧、取**第一条非 hello 帧**即返回。
 *
 * 显式契约（2026-10-27 审查 F-54）：**一条连接只发一个请求**。当前所有调用方每连接只发 hello + 一个
 * 请求，所以不必按 `id` 配对；如果将来要复用连接并发多请求，必须先改成按 `id` 配对回包，否则应答
 * 会静默错配（这个假设以前只存在于代码里，没有写下来）。
 */
export function tcpCall(port, frames, timeoutMs, { host = '127.0.0.1', skipHello = true } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let sock;
    const finish = (v) => {
      try {
        sock?.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ms: Date.now() - t0, ...v });
    };
    try {
      sock = net.connect({ host, port });
    } catch (e) {
      return finish({ ok: false, kind: 'refused', error: e?.message ?? String(e) });
    }
    sock.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => finish({ ok: false, kind: 'timeout', error: `no reply within ${timeoutMs}ms` }), timeoutMs);
    sock.once('connect', () => {
      for (const f of frames) sock.write(JSON.stringify(f) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          clearTimeout(timer);
          return finish({ ok: false, kind: 'garbage', error: `non-JSON reply: ${line.slice(0, 160)}` });
        }
        if (skipHello && m?.op === 'hello') continue; // 握手回包：继续等目标帧
        clearTimeout(timer);
        return finish({ ok: m?.ok !== false, msg: m });
      }
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, kind: e?.code === 'ECONNREFUSED' ? 'refused' : 'error', error: e?.message ?? String(e) });
    });
    sock.once('end', () => {
      clearTimeout(timer);
      finish({ ok: false, kind: 'closed', error: 'connection closed before reply' });
    });
  });
}

/**
 * 一次**真实握手**：`hello` + token ⇒ 拿回本守护的身份应答。
 * 这是 R11 要求的就绪判据：守护自己打印的 `listening` 不算数。
 */

// ── 原 daemon-client.ts 第 292-302 行 ──
export async function handshake(cfg, port, token, timeoutMs) {
  const r = await tcpCall(port, [{ op: 'hello', token, client: `win-pid-${process.pid}` }], timeoutMs, {
    skipHello: false,
  });
  if (r.msg?.ok === true && r.msg.op === 'hello') return { ok: true, kind: 'ok', info: r.msg, ms: r.ms };
  if (r.msg?.error === 'unauthorized') return { ok: false, kind: 'unauthorized', error: r.msg.error, ms: r.ms };
  if (r.msg) return { ok: false, kind: 'garbage', error: `unexpected reply: ${JSON.stringify(r.msg).slice(0, 160)}`, ms: r.ms };
  return { ok: false, kind: r.kind, error: r.error, ms: r.ms };
}

/** 已握手连接上的一次调用（status / prompt / shutdown）：一条连接上 hello + op。 */

// ── 原 daemon-client.ts 第 303-318 行 ──
export async function callDaemon(cfg, { port, token, req, timeoutMs }) {
  const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
  const r = await tcpCall(port, [{ op: 'hello', token, client: `win-pid-${process.pid}` }, req], timeoutMs);
  if (r.msg !== undefined) return r;
  return {
    ...r,
    ok: false,
    error: `守护调用失败(${r.kind}): ${r.error}（Windows 侧 ${hsTimeout}ms 握手判据）`,
  };
}

/**
 * 用 WSL 侧的一次性命令干掉指定 pid —— **先验身份再杀**。
 * 为什么必须验：元数据可能是陈的（守护早退出了），而 pid 会被复用；
 * 盲目 `kill -9 <陈旧 pid>` 会杀掉无关进程。判据 = `/proc/<pid>/cmdline` 里含 `daemon.ts`。
 */

// ── 原 daemon-client.ts 第 977-1012 行 ──
export async function daemonPrompt(cfg, { port, token, key, text, cwd, timeoutMs }) {
  const r = await callDaemon(cfg, {
    port,
    token,
    // P1：per-call cwd 走协议（守护按 key+cwd 分条目）——不再被静默忽略
    req: { op: 'prompt', id: 1, key, text, ...(cwd ? { cwd } : {}) },
    timeoutMs: Number(timeoutMs || cfg.timeoutMs || 300000),
  });
  if (r.msg) {
    return {
      ok: r.msg.ok === true,
      answer: r.msg.answer,
      sessionId: r.msg.sessionId,
      cwd: r.msg.cwd,
      turns: r.msg.turns,
      runtimePid: r.msg.runtimePid,
      completedBy: r.msg.completedBy,
      eventCount: r.msg.eventCount,
      retryable: r.msg.retryable,
      queueFull: r.msg.queueFull,
      error: r.msg.error,
      ms: r.ms,
    };
  }
  return { ok: false, kind: r.kind, error: r.error, retryable: true, ms: r.ms };
}

/**
 * **孤儿判定的唯一真相源**（F1）：把"哪些是活守护、哪些才是孤儿"一次算清。
 *
 * 判据：某个 /proc 里的守护进程，只要有一条**元数据记录能握手成功**（它有身份、有归属），就**不算**孤儿；
 * 只有"在跑但没有任何活元数据记录"的才算。为什么必须收敛到这一处：`index.ts` 的 `stop` 分支曾裸调
 * `scanDaemonProcesses()` ⇒ 把**别的槽位健健康康、有元数据的守护**报成"无元数据孤儿"，还建议 `all=true`，
 * 照做会**杀掉另一个 DSH 宿主正在用的守护**（task-11 F1 / task-12）。
 * `stop` / `status` / `ensure` 三处共用本函数，不许各写一份判定。
 */
