/**
 * dsh-remote-wsl / daemon-client —— **Windows 侧**的守护客户端（发现 / 启动 / 握手 / 调用）。
 *
 * 三条来自独立验证的硬要求落在这里：
 *
 * 1. **就绪判据必须由 Windows 侧确认**（task-2 缺陷 #11）。WSL 与 Windows 是**不同的网络命名空间**：
 *    Windows 侧先占了 8731 时，WSL 里的守护照样 bind 成功、日志照打 `listening`、进程不退，
 *    而 Windows 客户端连到的是**别的属主**（实测挂死 6s；默认 300s 就是 5 分钟假死）。
 *    所以这里的"ready"**不是**守护自己的日志，而是：客户端发出 hello+token 并拿到**符合本守护身份**的应答。
 *    握手默认 3s 超时（`daemonHandshakeTimeoutMs`）⇒ 身份不符立刻可读报错，绝不等 300s。
 * 2. **端口发现与回退**：元数据落 WSL 侧 `~/.dsh/remote-wsl/daemon.json`（0600），token 落
 *    `daemon.token`（0600）；端口被占则 `+1` 探测并记实际端口；Windows 侧被占则清掉那个"影子守护"后换端口。
 * 3. **客户端健壮性**（语义 #10）：`ECONNREFUSED` ⇒ 自动起守护 + 重试**一次**；
 *    若因此换了 sessionId，调用方必须**明确告知上下文已重置**（不许静默）。
 *
 * 只用 `node:` 内置模块 + 相对导入（link 装进 profile 的插件解析不到裸包名）。
 *
 * @module dsh-remote-wsl/daemon-client
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Windows 侧看到 WSL 文件的 UNC 前缀（与 lib/index.js 同一套约定）。 */
export function unc(distro, linuxPath) {
  return `\\\\wsl.localhost\\${distro}\\${linuxPath.replace(/^\//, '').replace(/\//g, '\\')}`;
}

/** Windows 绝对路径 → WSL 的 /mnt/<drive> 路径（守护脚本自己就住在这个插件目录里）。 */
export function winToWsl(winPath) {
  const p = String(winPath).replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : p;
}

/** 守护脚本的 WSL 路径 —— 从**本模块自己的位置**推导，插件被 link 到哪就在哪。 */
export function daemonScriptWsl() {
  return winToWsl(fileURLToPath(new URL('./daemon.ts', import.meta.url)));
}

export const stateDirLinux = (cfg) => `${cfg.wslHome}/.dsh/remote-wsl`;
/** 元数据按**槽位**分文件（槽位 = 启动时请求的端口）⇒ 两个守护并存互不覆盖元数据。 */
export const metaLinux = (cfg, slot = cfg.daemonPort) => `${stateDirLinux(cfg)}/daemon.${slot}.json`;
export const tokenLinux = (cfg, slot = cfg.daemonPort) => `${stateDirLinux(cfg)}/daemon.${slot}.token`;
/**
 * 启动脚本**按槽位分文件**（`launch.<slot>.sh`）。
 * 为什么不能是单文件：两个槽位同时启动会互相覆盖 —— task-4 实测出现过
 * "A 要 8759 却握手到 8760（`daemon.8759.json` 记 `port:8760`）、真正监听 8759 的守护**完全没有元数据**、
 * 终态 3 个守护而只请求 2 个"的竞态。写入还必须**原子**（tmp + rename）：直接写会让并发读者看到**半截脚本**。
 */
export const launchLinux = (cfg, slot = cfg.daemonPort) => `${stateDirLinux(cfg)}/launch.${slot}.sh`;
export const logLinux = (cfg) => `${stateDirLinux(cfg)}/daemon.log`;
/**
 * 过渡期兼容：单文件元数据（`daemon.json` / `daemon.token`）。
 * 为什么必须认它：旧版本的守护（或本插件升级前起的那个）仍可能活着并占着端口；
 * 不认它 ⇒ 新客户端会另起一个、而旧守护变成不可见的孤儿（占端口 + 占运行时）。
 */
export const legacyMetaLinux = (cfg) => `${stateDirLinux(cfg)}/daemon.json`;
export const legacyTokenLinux = (cfg) => `${stateDirLinux(cfg)}/daemon.token`;

/** 扫出所有槽位（配置端口排最前）——"发现已有守护"与 status 都不假设只有一个守护。 */
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
export function scanDaemonProcesses(cfg) {
  const state = stateDirLinux(cfg).replace(/'/g, `'\\''`);
  const script = [
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
  let stdout = '';
  try {
    stdout = wslRunScript(cfg, script, 20000).stdout;
  } catch {
    return [];
  }
  const out: Array<{ pid: number; port: number | null; metaPort: number | null }> = [];
  for (const line of String(stdout).split('\n')) {
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
export function wslRunScript(cfg, script, timeoutMs = 20000) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  try {
    const res = spawnSync('wsl.exe', ['-d', cfg.distro, '--', 'bash', '-c', `echo ${b64} | base64 -d | bash`], {
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

/** 只有清指定槽位的元数据/token（并发守护隔离：绝不动别的槽位）。`legacy` 时清单文件那两个。 */
function removeMetaFiles(cfg, slot = cfg.daemonPort, legacy = false) {
  const paths = legacy
    ? [legacyMetaLinux(cfg), `${legacyMetaLinux(cfg)}.tmp`, legacyTokenLinux(cfg)]
    : [metaLinux(cfg, slot), `${metaLinux(cfg, slot)}.tmp`, tokenLinux(cfg, slot)];
  for (const p of paths) {
    try {
      rmSync(unc(cfg.distro, p), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 一次连接、一次交换：写若干帧，读到"目标帧"即为结果。
 * `skipHello`（默认 true）：跳过协议里的 hello 回包，等真正的 op 结果；
 * 握手场景必须传 false —— 那时 hello 回包**就是**结果（否则只能靠超时判定，白等 3s）。
 * 超时是**快速失败**的关键：对端是陌生属主时它不会按协议回话，只能靠超时判定。
 * @returns {Promise<{ok:boolean, msg?:object, kind:string, error?:string, ms:number}>}
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
function killWslPid(cfg, pid) {
  if (!Number.isFinite(Number(pid))) return;
  const p = Number(pid);
  const script =
    `if [ -r /proc/${p}/cmdline ] && tr '\\0' ' ' < /proc/${p}/cmdline | grep -q 'daemon\\.ts'; then ` +
    `kill -TERM ${p} 2>/dev/null || true; fi`;
  wslRunScript(cfg, script, 10000);
}

/** 启动脚本（落 state 目录，0600；守护起来后会自己删掉）——绝不落 /tmp。 */
function launchScript(cfg, port, version) {
  return [
    'set -uo pipefail',
    'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
    `cd ${JSON.stringify(cfg.wslHome)} 2>/dev/null || true`,
    `exec node ${JSON.stringify(daemonScriptWsl())} --port ${port} --meta-port ${port} --version ${version} --cwd ${JSON.stringify(cfg.cwd)} ` +
      `--idle-ms ${Number(cfg.daemonIdleMs ?? 1800000)} --queue-limit ${Number(cfg.daemonQueueLimit ?? 4)} ` +
      `--profile ${JSON.stringify(cfg.profile ?? 'sdk')} --proxy-port ${Number(cfg.proxyPort ?? 9910)} ` +
      `--linger-ms ${Number(cfg.daemonLingerMs ?? 600000)} ` +
      `--state-dir ${JSON.stringify(stateDirLinux(cfg))} --launcher ${JSON.stringify(launchLinux(cfg, port))}`,
    '',
  ].join('\n');
}

/** 元数据/脚本目录必须先存在（Windows 侧通过 UNC 建，避免第一次启动时 WSL 侧还没有目录）。 */
function ensureStateDir(cfg) {
  try {
    mkdirSync(unc(cfg.distro, stateDirLinux(cfg)), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 起一个守护进程。**不做就绪判断** —— 就绪永远由调用方用 Windows 侧握手确认。
 * @returns {{ok:boolean, error?:string}}
 */
export function launchDaemon(cfg, port, version, log = () => {}) {
  if (!ensureStateDir(cfg)) {
    return { ok: false, error: `无法创建 WSL 侧状态目录 ${stateDirLinux(cfg)}（发行版 "${cfg.distro}" 是否在跑？）` };
  }
  const local = unc(cfg.distro, launchLinux(cfg, port));
  const body = launchScript(cfg, port, version);
  // 原子写：先写 `launch.<slot>.sh.tmp` 再 rename ⇒ 并发/半截脚本都不会被 bash 读到
  try {
    const tmp = `${local}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, local);
  } catch {
    try {
      writeFileSync(local, body, { mode: 0o600 }); // rename 在个别 9p 挂载上不可用 ⇒ 退回直写
    } catch (e) {
      return { ok: false, error: `无法写入启动脚本 ${local}: ${e.message}` };
    }
  }
  try {
    chmodSync(local, 0o600);
  } catch {
    /* drvfs 上 chmod 可能无效；文件里没有密钥 */
  }
  // 守护要活过本宿主进程 ⇒ detached + unref；守护自己的诊断走 state 目录里的 daemon.log。
  // ⚠️ spawn 必须跑**同一个槽位**的脚本（`launchLinux(cfg, port)`）：这里曾经写成 `launchLinux(cfg)`
  // （默认回落到 cfg.daemonPort）⇒ 回退槽位写的是 launch.8752.sh、跑的却是 launch.8751.sh，
  // 于是"回退槽位元数据永远不出现 + 脚本泄漏"。包装层 stderr 也落文件，避免再次静默。
  let stderrFd = null;
  try {
    stderrFd = openSync(unc(cfg.distro, `${stateDirLinux(cfg)}/launch-stderr.log`), 'a');
  } catch {
    stderrFd = null;
  }
  const child = spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', launchLinux(cfg, port)], {
    stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
    windowsHide: true,
    detached: true,
  });
  if (stderrFd !== null) {
    try {
      closeSync(stderrFd);
    } catch {
      /* 子进程已持有该 fd */
    }
  }
  child.on('error', (e) => log(`启动守护失败（spawn）: ${e.message}`));
  child.on('exit', (code) => {
    if (code !== 0) log(`守护启动包装层退出 code=${code}（详见 launch-stderr.log）`);
  });
  child.unref();
  return { ok: true, launcher: launchLinux(cfg, port) };
}

/**
 * 配置相容性检查（task-9 追加 D）：复用已有守护前必须比对**关键参数**，不许静默忽略调用方的配置。
 *  · `hard`   = 结构性不兼容（cwd / profile）：复用会让"会话跑在错误的工作目录/插件集"上 ⇒ 明确报错。
 *  · `soft`   = 可容忍但不该静默（idleMs / queueLimit / lingerMs）：复用并**显式回报**（可用 restart 应用新值）。
 *  · `version`= 版本不一致：只报警 + 显式 restart（语义 #5：绝不自动杀，避免无声中断会话）。
 */
export function configCompat(cfg, info, wantedVersion) {
  const hard: string[] = [];
  const soft: string[] = [];
  if (info?.cwd && cfg?.cwd && info.cwd !== cfg.cwd) hard.push(`cwd ${info.cwd}≠${cfg.cwd}`);
  if (info?.profile && cfg?.profile && info.profile !== cfg.profile) hard.push(`profile ${info.profile}≠${cfg.profile}`);
  if (info?.idleMs != null && Number(info.idleMs) !== Number(cfg.daemonIdleMs)) soft.push(`idleMs ${info.idleMs}≠${cfg.daemonIdleMs}`);
  if (info?.queueLimit != null && Number(info.queueLimit) !== Number(cfg.daemonQueueLimit)) soft.push(`queueLimit ${info.queueLimit}≠${cfg.daemonQueueLimit}`);
  if (info?.lingerMs != null && Number(info.lingerMs) !== Number(cfg.daemonLingerMs)) soft.push(`lingerMs ${info.lingerMs}≠${cfg.daemonLingerMs}`);
  return {
    hard,
    soft,
    version: wantedVersion && info?.version && info.version !== wantedVersion ? { daemon: info.version, wanted: wantedVersion } : null,
  };
}

/** 本插件**自己的**守护进程里，占了这两个端口之一的那些（按 /proc 身份扫描，不看元数据）。 */
function ownDaemonsOnPorts(cfg, ports) {
  const want = new Set(ports.map(Number));
  return scanDaemonProcesses(cfg).filter((p) => (p.port != null && want.has(p.port)) || (p.metaPort != null && want.has(p.metaPort)));
}

/** 元数据里记的 pid 恰好是某进程的那些记录（用于判断"占着端口的是不是一个有元数据的活守护"）。 */
function recordForPid(cfg, pid) {
  for (const slot of listDaemonSlots(cfg)) {
    const rec = readDaemonRecord(cfg, slot);
    if (rec && Number(rec.meta?.pid) === Number(pid)) return rec;
  }
  return null;
}

/**
 * 确保有一个**在 Windows 侧真实可达**的守护。
 *
 * 语义 #8（单实例幂等）：**只复用调用方自己槽位（`cfg.daemonPort`）的守护**，不碰别的槽位
 * （task-9 追加 D：以前"复用同状态目录里任意活守护"会静默忽略调用方配的端口/idle）。
 * 缺陷 #11：就绪判据 = Windows 侧 hello+token 拿到身份应答；失败则清影子守护 + 换端口（`daemonPortTries` 次）。
 * task-9 追加 A/B：请求槽位上若已有**本插件**的守护（有元数据的活守护 ⇒ 复用；无元数据的孤儿 ⇒ 先收掉），
 * 绝不允许"又起一个、把上一个留在那儿" —— 那正是"3 守护/2 请求""slot≠actualPort""孤儿占端口"的同族根因。
 */
export async function ensureDaemon(cfg, { version, restart = false, noReuse = false, log = () => {} }: any = {}) {
  const notes = [];
  const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
  const wantSlot = Number(cfg.daemonPort) || 8731;
  const adopt = (rec, hs, reused) => {
    const compat = configCompat(cfg, hs.info, version);
    return {
      ok: true,
      port: hs.info.port,
      slot: rec.slot,
      info: hs.info,
      token: rec.token,
      meta: rec.meta,
      reused,
      started: !reused,
      notes,
      versionMismatch: compat.version,
      configHardMismatch: compat.hard,
      configSoftMismatch: compat.soft,
    };
  };

  if (!restart && !noReuse) {
    // 1) 只认**自己槽位**的记录（+ 过渡期单文件记录，且它必须就监听在配置端口上）
    const candidates: any[] = [];
    const slotRec = readDaemonRecord(cfg, wantSlot);
    if (slotRec) candidates.push(slotRec);
    const legacy = readDaemonRecord(cfg);
    if (legacy?.legacy && Number(legacy.meta?.port) === wantSlot) candidates.push(legacy);
    for (const rec of candidates) {
      const hs = await handshake(cfg, rec.meta?.port ?? rec.slot, rec.token, hsTimeout);
      if (hs.ok) {
        const compat = configCompat(cfg, hs.info, version);
        if (compat.hard.length) {
          // 结构性不兼容 ⇒ 明确报错（不静默复用、也不偷偷另起一个占着别人会话的守护）
          return {
            ok: false,
            notes,
            error:
              `远端守护（槽位 ${rec.slot} / 端口 ${hs.info.port}）与本次配置**结构性不兼容**：${compat.hard.join('、')}。` +
              `复用会让会话跑在错误的工作目录/插件集上。请显式执行 wsl_daemon action=restart 以新配置重启，或改用另一个 config.daemonPort。`,
          };
        }
        if (hs.info.port !== wantSlot) {
          notes.push(`请求槽位 ${wantSlot} 在 WSL 侧被占：该守护实际监听 ${hs.info.port}（元数据 daemon.${rec.slot}.json）`);
        }
        notes.push(`复用自己槽位 ${rec.slot} 的守护：端口 ${hs.info.port}，Windows 侧握手 ${hs.ms}ms 通过`);
        if (compat.soft.length) notes.push(`注意：守护参数与本次配置不同（${compat.soft.join('、')}）—— 已复用，未静默忽略；要应用新值请 wsl_daemon action=restart`);
        return adopt(rec, hs, true);
      }
      const why = hs.kind === 'timeout' ? `握手 ${hs.ms}ms 超时（该端口可能被 Windows 侧别的属主占用）` : hs.kind === 'refused' ? '连接被拒（守护已死，元数据是陈的）' : `握手失败(${hs.kind}: ${hs.error})`;
      notes.push(`自己槽位 ${rec.slot} 复用失败：${why}`);
      log(`daemon reuse failed on own slot ${rec.slot}: ${why}`);
      if (rec.meta?.pid) killWslPid(cfg, rec.meta.pid);
      removeMetaFiles(cfg, rec.slot, rec.legacy);
    }
    // 2) 别的槽位的活守护：**只报告、绝不复用**（否则等于静默忽略调用方配的端口）
    for (const slot of listDaemonSlots(cfg)) {
      if (Number(slot) === wantSlot) continue;
      const rec = readDaemonRecord(cfg, slot);
      if (!rec) continue;
      const hs = await handshake(cfg, rec.meta?.port ?? slot, rec.token, hsTimeout);
      if (hs.ok) {
        notes.push(`另有守护在槽位 ${slot}（端口 ${hs.info.port}）—— 不属于本次配置（daemonPort=${wantSlot}），未复用、未打扰`);
      } else {
        killWslPid(cfg, rec.meta?.pid);
        removeMetaFiles(cfg, slot, rec.legacy);
        notes.push(`清理了失联的槽位 ${slot}`);
      }
    }
  } else {
    const stopped = await stopDaemon(cfg, { log, slot: wantSlot }).catch((e) => ({ ok: false, error: e?.message }));
    notes.push(`restart: 已停本槽位守护（${stopped?.reaped?.length ?? 0} 个运行时被回收）`);
  }

  const tries = Math.max(1, Number(cfg.daemonPortTries) || 3);
  const tried = [];
  let last = notes.join('；');
  for (let i = 0; i < tries; i++) {
    const port = wantSlot + i;
    tried.push(port);

    // ★ A/B 修复：起之前先看这个槽位/端口上有没有**本插件自己的**守护在跑
    const occupants = ownDaemonsOnPorts(cfg, [port]);
    for (const o of occupants) {
      const rec = recordForPid(cfg, o.pid);
      if (rec) {
        const hs0 = await handshake(cfg, rec.meta?.port ?? rec.slot, rec.token, hsTimeout);
        if (hs0.ok) {
          // 身份相符的活守护 ⇒ 复用它，**绝不起第二个**
          notes.push(`槽位 ${port} 上已有身份相符的活守护 pid=${o.pid}（端口 ${hs0.info.port}）⇒ 复用，未起第二个`);
          return adopt(rec, hs0, true);
        }
      }
      notes.push(`槽位 ${port} 上发现**无元数据/失联**的本插件守护 pid=${o.pid} ⇒ 先收掉再起（不留孤儿）`);
      killWslPid(cfg, o.pid);
    }
    if (occupants.length) await sleep(900); // 等它退出，让端口真的空出来（否则守护会 +1 迁移）

    // 清掉**陈旧元数据**（文件在、但上面那个 pid 已经不在进程表里）：否则下面的轮询会一直握到一个死 pid，
    // 白等满 daemonStartTimeoutMs（实测过：进程表里没有它，但文件还在 ⇒ 20s 假等）。
    const stale = readDaemonRecord(cfg, port);
    if (stale) {
      const livePids = new Set(scanDaemonProcesses(cfg).map((p) => p.pid));
      if (!livePids.has(Number(stale.meta?.pid))) {
        notes.push(`清掉槽位 ${port} 的陈旧元数据（记录里的 pid ${stale.meta?.pid} 已不在进程表）`);
        removeMetaFiles(cfg, port);
      }
    }

    const launched = launchDaemon(cfg, port, version, log);
    if (!launched.ok) {
      last = launched.error;
      notes.push(`端口 ${port}: ${launched.error}`);
      continue;
    }
    const deadline = Date.now() + Number(cfg.daemonStartTimeoutMs ?? 20000);
    let hs = null;
    while (Date.now() < deadline) {
      await sleep(250);
      const rec = readDaemonRecord(cfg, port);
      if (!rec) continue;
      hs = await handshake(cfg, rec.meta.port ?? port, rec.token, hsTimeout);
      if (hs.ok) {
        if (hs.info.port !== port) {
          // 守护在 WSL 侧做了 +1 迁移：必须说清楚（并在可能时指出占用者）
          const holder = scanDaemonProcesses(cfg).filter((p) => p.port === port);
          notes.push(
            `WSL 侧端口 ${port} 已被占（${holder.length ? `占用者 pid=${holder.map((h) => h.pid).join(',')}` : '非本插件进程'}）⇒ 守护实际监听 ${hs.info.port}`,
          );
        }
        notes.push(`槽位 ${port} 由 Windows 侧握手确认就绪（实际端口 ${hs.info.port}，${hs.ms}ms）`);
        return adopt({ slot: port, meta: rec.meta, token: rec.token }, hs, false);
      }
      if (hs.kind === 'refused') {
        // 元数据存在但守护已死（pid 不在进程表）⇒ 清掉再等新守护写自己的，别把 20s 白等在一个死 pid 上
        const livePids = new Set(scanDaemonProcesses(cfg).map((p) => p.pid));
        if (!livePids.has(Number(rec.meta?.pid))) removeMetaFiles(cfg, port);
        continue;
      }
      if (hs.kind === 'timeout' || hs.kind === 'unauthorized' || hs.kind === 'garbage') break;
    }
    const why = hs ? `${hs.kind}（${hs.ms}ms）` : '元数据未出现';
    notes.push(`槽位 ${port} 未通过 Windows 侧就绪判据：${why}`);
    log(`slot ${port} not ready from Windows side: ${why}`);
    const rec2 = readDaemonRecord(cfg, port);
    if (rec2?.meta?.pid) killWslPid(cfg, rec2.meta.pid);
    // 兜底：即使元数据没写成，也按 /proc 身份扫描把这个端口上的自家守护收掉
    for (const o of ownDaemonsOnPorts(cfg, [port])) killWslPid(cfg, o.pid);
    if (rec2 || ownDaemonsOnPorts(cfg, [port]).length) await sleep(700);
    removeMetaFiles(cfg, port);
    if (launched.launcher) {
      try {
        rmSync(unc(cfg.distro, launched.launcher), { force: true }); // 没起来的启动脚本别leak（守护起来会自删）
      } catch {
        /* ignore */
      }
    }
    last = `槽位 ${port} ${why}`;
  }

  const tail = readDaemonLogTail(cfg, 6);
  return {
    ok: false,
    notes,
    tried,
    error:
      `远端守护在 Windows 侧不可达：试过端口 ${tried.join(', ')} —— ${last}。` +
      `这些端口在 Windows 命名空间里可能被别的程序占用（WSL 侧 bind 成功不代表 Windows 侧能连上）。` +
      `请释放其中一个端口，或把 config.daemonPort 指到别的端口。` +
      (tail ? `\ndaemon.log 尾部:\n${tail}` : ''),
  };
}

/**
 * 显式停止守护（语义 #4：这是会话结束的三种方式之一）。
 *
 * **默认只停调用方自己槽位（`cfg.daemonPort`）**，不传 slot 时**绝不**去遍历别人的槽位
 * （task-9 追加 C：以前"自己槽位缺失就顺手停别人"是危险脚枪）。要停全部/含孤儿，用显式 `all: true`。
 */
export async function stopDaemon(cfg, { log = () => {}, slot, all = false }: any = {}) {
  if (all) return stopAllDaemons(cfg, { log });
  const wantSlot = Number(slot ?? cfg.daemonPort) || 8731;
  let rec = readDaemonRecord(cfg, wantSlot);
  if (!rec) {
    const legacy = readDaemonRecord(cfg);
    if (legacy?.legacy && Number(legacy.meta?.port) === wantSlot) rec = legacy; // 过渡期单文件记录，且确实是我这个端口
  }
  if (!rec) {
    return { ok: true, alreadyStopped: true, reaped: [], slot: wantSlot, note: `自己槽位 ${wantSlot} 没有守护（未去停别的槽位）` };
  }
  const port = rec.meta?.port ?? rec.slot;
  const r = await callDaemon(cfg, {
    port,
    token: rec.token,
    req: { op: 'shutdown', id: 1 },
    timeoutMs: Math.max(Number(cfg.daemonHandshakeTimeoutMs ?? 3000), 5000),
  });
  log(`daemon shutdown on slot ${rec.slot} (port ${port}): ok=${r.ok} ${r.error ?? ''}`);
  if (!r.ok) killWslPid(cfg, rec.meta?.pid); // 守护已死/端口被占 ⇒ 按 pid 兜底（验身份后）
  removeMetaFiles(cfg, rec.slot, rec.legacy);
  return {
    ok: true,
    port,
    slot: rec.slot,
    // F3：机器行统一字段 ⇒ 这里把"停之前"的身份一起带回去（守护已经没了，事后查不到）
    pid: rec.meta?.pid ?? null,
    version: rec.meta?.version ?? null,
    reaped: r.msg?.reaped ?? [],
    transport: r.ok ? 'shutdown' : r.kind,
  };
}

/**
 * **`stop --all`**：停掉所有槽位的守护 + 过渡期单文件记录 + **无元数据的孤儿**（身份扫描发现）。
 * 这是"工具能自己收干净"的保证：task-4 的竞态曾留下"发现不了也回收不了、只能人工按 pid 杀"的孤儿。
 */
export async function stopAllDaemons(cfg, { log = () => {} }: any = {}) {
  const stopped = [];
  for (const slot of listDaemonSlots(cfg)) stopped.push(await stopDaemon(cfg, { log, slot }));
  const legacyRec = readDaemonRecord(cfg);
  if (legacyRec?.legacy) stopped.push(await stopDaemon(cfg, { log }));
  const found = scanDaemonProcesses(cfg);
  const killed = [];
  for (const p of found) {
    killWslPid(cfg, p.pid); // 内部仍按 cmdline 验身份
    killed.push(p);
  }
  if (killed.length) await sleep(900);
  // 顺手清掉遗留的启动脚本（目录是我们自己的；守护活着的话它早已自删）
  try {
    for (const n of readdirSync(unc(cfg.distro, stateDirLinux(cfg)))) {
      if (/^launch\.[0-9]+\.sh(\.tmp)?$/.test(n)) {
        try {
          rmSync(unc(cfg.distro, `${stateDirLinux(cfg)}/${n}`), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  const remaining = scanDaemonProcesses(cfg);
  return { ok: remaining.length === 0, stopped, killed, remaining };
}

/**
 * 发一轮 prompt（**单次尝试**，不做恢复）——恢复策略在 index.js 里（它才知道上下文是否重置）。
 */
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
export async function daemonSnapshot(cfg) {
  const hsTimeout = Number(cfg.daemonHandshakeTimeoutMs ?? 3000);
  const slots = listDaemonSlots(cfg);
  const records = (slots.length ? slots.map((s) => readDaemonRecord(cfg, s)) : [readDaemonRecord(cfg)]).filter(Boolean);
  const live: any[] = [];
  const dead: any[] = [];
  const livePids = new Set<number>();
  for (const rec of records) {
    const r = await callDaemon(cfg, {
      port: rec.meta?.port ?? rec.slot,
      token: rec.token,
      req: { op: 'status', id: 1 },
      timeoutMs: hsTimeout,
    });
    if (r.msg?.ok) {
      live.push({ slot: rec.slot, legacy: rec.legacy, meta: rec.meta, token: rec.token, info: r.msg, ms: r.ms });
      if (r.msg.daemonPid) livePids.add(Number(r.msg.daemonPid));
    } else {
      dead.push({ slot: rec.slot, legacy: rec.legacy, meta: rec.meta, kind: r.kind, error: r.error, ms: r.ms });
    }
  }
  const procs = scanDaemonProcesses(cfg);
  const orphans = procs.filter((p) => !livePids.has(p.pid));
  return { slots, records, live, dead, livePids, procs, orphans };
}

/** 读守护状态（read-only，用于 wsl_status / wsl_daemon status；不触发启动；多守护并存 + 正确孤儿口径）。 */
export async function daemonStatus(cfg) {
  const snap = await daemonSnapshot(cfg);
  const { orphans, slots, live, dead, records } = snap;
  if (live.length) {
    const first = live[0]; // listDaemonSlots 已把 cfg.daemonPort 排最前 ⇒ 优先报调用方自己槽位
    return {
      ok: true,
      info: first.info,
      meta: first.meta,
      slot: first.slot,
      legacy: first.legacy,
      ms: first.ms,
      slots,
      live,
      orphans,
    };
  }
  if (!records.length && !orphans.length) return { ok: false, kind: 'absent', error: '没有守护元数据（守护未运行）' };
  const last = dead[dead.length - 1];
  return {
    ok: false,
    kind: last?.kind ?? 'orphan-only',
    error: last?.error ?? `只有无元数据的孤儿守护在跑（${orphans.length} 个）`,
    meta: last?.meta,
    slot: last?.slot,
    orphans,
    live: [],
  };
}
