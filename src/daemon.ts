#!/usr/bin/env node
/**
 * dsh-remote-wsl / daemon.mjs —— **WSL 侧常驻守护**：按 key 持有 dsh SDK 运行时，监听 127.0.0.1。
 *
 * ## 为什么存在（这是与 VS Code Remote-WSL 差距 #8/#9 的唯一出路）
 *
 * 上游事实（spike + task-2 双重复现）：sessionId 由客户端指定，服务端用它判重并且**落盘占用**——
 * 另一个进程（哪怕原持有者已经正常退出、运行时已消失）再用同一 id 一定收到
 * `JSON-RPC -32603: session "…" already exists`。于是"上下文"只可能活在**那个还活着的运行时进程**里。
 * 把运行时交给常驻守护持有之后，Windows 侧退化成"连上去发一条 prompt 的瘦客户端"，
 * 客户端进程可来可走 —— 这就是 reconnect 语义。
 *
 * ## 为什么是 TCP 127.0.0.1（而不是 Unix socket）
 * WSL2 localhost 转发实测可用（WSL 内绑 127.0.0.1，Windows 直接访问 localhost 命中）；
 * TCP 让两端各用各的 node（Windows 桌面 node / WSL mise node），Unix socket 则要求 Windows 侧能读它。
 *
 * ## 协议（NDJSON，一行一条；连接建立后**第一条必须是 hello**）
 *   → {"op":"hello","token":"<60位十六进制>","client":"win-pid-1234"}
 *   ← {"ok":true,"op":"hello","daemonPid":N,"version":"0.2.0-rc.2","port":8731,…}
 *   → {"op":"prompt","id":1,"key":"k1","text":"…"}
 *   ← {"ok":true,"id":1,"answer":"…","sessionId":"…","turns":2,"runtimePid":1234,"completedBy":"turn/end"}
 *   → {"op":"status","id":2} / {"op":"shutdown","id":3}
 * token 不符 ⇒ `{"ok":false,"error":"unauthorized"}` 并断开（本机任意进程都不能偷 prompt/shutdown）。
 *
 * ## 会话生命周期（Lead 定的语义 #1/#2）
 * 关客户端 **≠** 会话结束。会话只在三种情况结束：显式 `shutdown` / 空闲超过 `--idle-ms` /
 * 守护或运行时死亡。前两种是主动回收，第三种在下一次 prompt 时会拿到**新** sessionId（上下文已重置）。
 *
 * ## 为什么不写 /tmp（task-2 缺陷 #12）
 * 元数据、token、启动脚本、日志全部落 `--state-dir`（默认 `~/.dsh/remote-wsl`，目录 0700、文件 0600）；
 * 退出时清理 daemon.json / daemon.token / 启动脚本。**本守护不创建任何 /tmp/dsh-rwsl-* 文件。**
 *
 * @module dsh-remote-wsl/daemon
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { shellEnvSnippet } from './shell-env.ts';
import { PLUGIN_VERSION, PROTOCOL_VERSION } from './plugin-version.ts';
import { SdkRuntime } from './sdk-runtime.ts';
import { handleFsOp } from './fs-rpc.ts';
import { handleSearchOp, setSearchToolPaths } from './search-rpc.ts';
import { ensureSearchTools, ensureTools, catalog, resolveAssetFor, CORE_TOOLS, toolPaths } from './search-provision.ts';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

/**
 * 数值参数解析（2026-10-27 审查 F-53）：旧实现直接 `Number(...)`，`--port-tries abc` 会得到 NaN，
 * 于是 listen 循环一次都不跑、却照样打印 `listening …` 并写元数据（伪 listening）。参数非法必须
 * startup 失败并说清是哪个参数 —— 静默伪启动比崩溃更难查。
 *
 * 2026-10-27 换角度评审第 6 条：这里以前直接 `throw`，在模块顶层抛错只剩一段 Node 堆栈（落在
 * `launch-stderr.log` 里），可读性远不如 `[daemon]` 结构化日志。现在只**收集**错误，由 `main()`
 * 统一打印并 `exit(2)`。
 */
const configErrors: string[] = [];
const numArg = (name, dflt, min = 0) => {
  const raw = arg(name, String(dflt));
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    configErrors.push(`--${name} 需要数字，收到 ${JSON.stringify(raw)}`);
    return dflt;
  }
  if (n < min) {
    configErrors.push(`--${name} 必须 ≥ ${min}，收到 ${n}`);
    return min;
  }
  return n;
};

const HOME = process.env.HOME && !/[:\\]/.test(process.env.HOME) ? process.env.HOME : '/home/g';
const PORT_REQ = numArg('port', 8731, 1);
const PORT_TRIES = numArg('port-tries', 10, 1);
const VERSION = arg('version', '0.2.0-rc.2');
const CWD = arg('cwd', HOME);
const PROFILE = arg('profile', 'sdk');
const PROVIDER = arg('provider', 'deepseek-official');
const MODEL = arg('model', 'deepseek-flash');
const IDLE_MS = numArg('idle-ms', 1800000, 0);
/**
 * **寿命闸门**：无 key（没有会话要保）且无客户端连接，持续 `--linger-ms` 就自退。
 * 为什么与 idle 分开：idle 管"某个 key 的运行时"，闸门管"**守护自己**别永久赖着"。
 * 只在 `keys.size === 0` 时计时 ⇒ 永远不会因为闸门丢掉还活着的会话。0 = 关闭闸门。
 */
const LINGER_MS = numArg('linger-ms', 600000, 0);
const QUEUE_LIMIT = numArg('queue-limit', 4, 1);
const PROXY_PORT = numArg('proxy-port', 9910, 1);
const PROMPT_TIMEOUT_MS = numArg('prompt-timeout-ms', 300000, 1000);
const QUIET_MS = numArg('quiet-ms', 3000, 100);
const SHELL_ENV = !flag('no-shell-env');
/**
 * 协议硬上限（2026-10-27 审查 F-02）：帧在**鉴权之前**就开始累积，旧实现没有上限 ⇒ 任一能连到
 * `127.0.0.1:<port>` 的进程持续发不含换行的数据就能把守护撑到 OOM，而守护一死，它持有的
 * detached 运行时全部变成不可达孤儿（远端会话上下文对用户就是丢的）。这里给三道上限：
 * 单帧大小、连接数、连接空闲时长；hello 之前尤其只允许一个短帧。
 */
const MAX_FRAME_BYTES = numArg('max-frame-bytes', 1024 * 1024, 64 * 1024);
const MAX_CONNS = numArg('max-conns', 64, 1);
const SOCKET_IDLE_MS = numArg('socket-idle-ms', 120000, 5000);
const STATE_DIR = arg('state-dir', path.join(HOME, '.dsh', 'remote-wsl'));
const LAUNCHER = arg('launcher', '');
/**
 * 元数据**按"槽位"分文件**：槽位 = 启动时请求的端口（`--meta-port`，默认 = `--port`）。
 *
 * 为什么不是单个 `daemon.json`：两个守护并存时（我的验收 / 别人的夹具、或两个 DSH 会话做隔离验证）
 * 单文件会**互相覆盖**。文件也不按"实际监听端口"命名 —— WSL 侧端口被占时守护会 +1 迁移，
 * 那时调用方还不知道新端口；按**请求槽位**命名才能让客户端精确轮询自己那一个文件，
 * 真实端口写在 `port` 字段里（迁移可观测）。`--state-dir` 是另一个维度的完全隔离。
 */
const META_SLOT = String(arg('meta-port', String(PORT_REQ)));
const metaPath = () => path.join(STATE_DIR, `daemon.${META_SLOT}.json`);
const tokenPath = () => path.join(STATE_DIR, `daemon.${META_SLOT}.token`);
const LOG_FILE = path.join(STATE_DIR, 'daemon.log'); // 日志共享（有界 + 每行带 pid），不按槽分

const startedAt = Date.now();
const token = randomBytes(32).toString('hex');

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(STATE_DIR, 0o700);
} catch {
  /* 某些挂载（drvfs）不支持 chmod，忽略但下面写文件仍带 0600 */
}

/** 有界日志：state 目录里的 daemon.log（0600）；超过 256KB 就截断重建，避免无限增长。 */
function log(...parts) {
  const line = `[daemon pid=${process.pid} ${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try {
    const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (st && st.size > 256 * 1024) fs.writeFileSync(LOG_FILE, '', { mode: 0o600 });
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
  } catch {
    /* 日志失败不能影响守护 */
  }
  process.stderr.write(line);
}

// ── 环境只捕获一次（语义 #9）──────────────────────────────────────────────────

// ── 网关发现 / 代理可达性（2026-10-22，参考 ZCode `packages/server/src/remote/wslProxy.ts`）──
//
// ⚠️ 本文件是**在 WSL 里**跑的独立脚本（daemon-protocol.daemonScriptWsl() 把它交给 WSL 侧 node），
// **不能** import 宿主侧的 src/wsl-proxy.ts ⇒ 下面三块片段是从它**逐字复制**的：
//   · GATEWAY_DISCOVERY_LINES              ↔ wsl-proxy.buildGatewayShellLines()
//   · parseGatewayOutput()                 ↔ wsl-proxy.parseGatewayOutput()
//   · isLoopback() / isPrivateOrLinkLocal() ↔ 同名判据函数（wsl-proxy.ts 内部）
// 防漂移：spike/verify/zcode-20261022/probe-daemon-gateway.ts 逐字比对这三块，并用同一组候选输入
// 断言行为一致；任何一边改了另一边没改 ⇒ 门禁红。

/** wsl-proxy 里是 `import { isIP } from 'node:net'`；这里取同一个函数引用，保证下面三块能**逐字**一致。 */
const isIP = net.isIP;

/** 与 src/wsl-proxy.ts 的 buildGatewayShellLines() **逐字一致**（多行，join('\n')）。 */
const GATEWAY_DISCOVERY_LINES = [
  "GATEWAY=$(ip route show default 2>/dev/null | awk '$1 == \"default\" && $2 == \"via\" { print $3; exit }')",
  'GW_SRC=route',
  'if [ -z "${GATEWAY:-}" ] && [ -r /etc/resolv.conf ]; then',
  "  GATEWAY=$(awk '$1 == \"nameserver\" { print $2; exit }' /etc/resolv.conf)",
  '  GW_SRC=resolv',
  'fi',
  'case "${GATEWAY:-}" in',
  '  *[!0-9a-fA-F:.]*) GATEWAY= ;;',
  '  ""|127.*|::1|localhost) GATEWAY= ;;',
  '  *) if [ "${GW_SRC:-resolv}" = "resolv" ]; then',
  '       case "$GATEWAY" in',
  '         10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|169.254.*|fc*|fd*|FC*|FD*|fe[89ab]*|FE[89AB]*) : ;;',
  '         *) GATEWAY= ;;',
  '       esac',
  '     fi ;;',
  'esac',
];

/**
 * 发现脚本 = 上面的发现+校验块**逐字不动** + 只追加"打戳输出"。
 *
 * 2026-10-22 review 修：来源戳必须在**取值同一条命令里**打下（`GW_SRC`），不能再事后用
 * `ip route show default | grep -q .` 猜 —— 遇到 `default dev eth0`（无 via）这种路由时，
 * 会把实际来自 resolv 的公网候选误标成 `route=`，从而绕过"只接受私有/链路本地"的校验。
 */
function gatewayDiscoveryScript() {
  return [
    ...GATEWAY_DISCOVERY_LINES,
    'if [ -n "${GATEWAY:-}" ]; then printf "%s=%s" "${GW_SRC:-resolv}" "$GATEWAY"; fi',
  ].join('\n');
}

/** 网关候选（与 wsl-proxy 的判据一致：route 优先；resolv 只接受私有/链路本地）。 */
function discoverGateway() {
  let output = '';
  try {
    output = execFileSync('/bin/bash', ['-c', gatewayDiscoveryScript()], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
  } catch {
    return { host: null, source: null };
  }
  return parseGatewayOutput(output);
}

function parseGatewayOutput(output) {
  for (const token of String(output ?? '').trim().split(/\s+/).filter(Boolean)) {
    const match = /^(route|resolv)=(.+)$/.exec(token);
    const source = match ? match[1] : 'resolv';
    const candidate = (match ? match[2] : token).replace(/^\[|\]$/g, '');
    if (isIP(candidate) === 0) continue;
    if (isLoopback(candidate)) continue;
    if (source === 'route') return { host: candidate, source: 'route' };
    if (isPrivateOrLinkLocal(candidate)) return { host: candidate, source: 'resolv' };
  }
  return { host: null, source: null };
}

function isLoopback(address) {
  return address === '::1' || address === 'localhost' || (isIP(address) === 4 && address.startsWith('127.'));
}

function isPrivateOrLinkLocal(address) {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/u.test(lower);
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    address.startsWith('169.254.')
  );
}

/** 探活超时（毫秒）。ZCode 的 `buildWslProxyPortProbeCommand` 用 `timeout 1`；原来 3 秒 ⇒ 代理停着时白等。 */
const PROXY_PROBE_TIMEOUT_MS = 1000; // 与 src/wsl-proxy.ts 的 PROXY_PROBE_TIMEOUT_SEC = 1 对齐

function probeTcp(host, port, ms = PROXY_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const s = net.connect({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** IPv6 放进 URL 必须加方括号（resolv 的 nameserver 可能是 fd00::1 这类链路/私有地址）。 */
function formatHostForUrl(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

/**
 * 决定代理地址：**先试 loopback，再退回网关**（handoff §6.5 的统一）。
 *  · mirrored 网络模式（WSL2 `networkingMode=mirrored`）下宿主代理就在 WSL 的 127.0.0.1 上
 *    ⇒ 命中就直接用 loopback，**不该**强行换成网关地址；
 *  · NAT 模式才退回网关（ip route default via → /etc/resolv.conf nameserver 回落，私有/链路本地才算）。
 */
async function resolveProxyHost(port) {
  if (!(port > 0)) return { host: null, source: 'disabled' };
  if (await probeTcp('127.0.0.1', port)) return { host: '127.0.0.1', source: 'loopback' };
  const gateway = discoverGateway();
  if (gateway.host && (await probeTcp(gateway.host, port))) return { host: gateway.host, source: gateway.source };
  return { host: null, source: gateway.host ? 'gateway-unreachable' : 'no-gateway' };
}

function runBashCapture(script, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ stdout: Buffer.concat(out), stderr: err, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      err = (err + c).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err + e.message, error: e });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err });
    });
  });
}

/**
 * 捕获一次登录 shell 环境（对位 useShellEnvironment），并把 PATH / 代理拼好。
 * 之后每个运行时直接复用这个 env —— 这就是"环境注入只做一次"。
 */
async function buildRuntimeEnv() {
  let env = { ...process.env };
  if (SHELL_ENV) {
    const res = await runBashCapture(`${shellEnvSnippet({ enable: true })}env -0\n`, 12000);
    const parsed = {};
    for (const pair of res.stdout.toString('utf8').split('\0')) {
      const i = pair.indexOf('=');
      if (i > 0) parsed[pair.slice(0, i)] = pair.slice(i + 1);
    }
    if (Object.keys(parsed).length) {
      env = parsed;
      log(`登录 shell 环境已捕获(${Object.keys(parsed).length} 个变量)${res.timedOut ? ' [超时截断]' : ''}`);
    } else {
      log(`登录 shell 环境捕获失败，沿用默认环境: ${res.stderr.trim().split('\n').slice(-1)[0] ?? ''}`);
    }
  } else {
    log('--no-shell-env: 跳过登录 shell 环境注入');
  }
  const basePath = env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env = { ...env, PATH: `${HOME}/.local/bin:${HOME}/.local/share/mise/shims:${basePath}` };
  // 代理地址：先 loopback（mirrored 网络），再网关（ip route → resolv 回落）；两条都 1 秒探活。
  if (PROXY_PORT > 0) {
    const proxy = await resolveProxyHost(PROXY_PORT);
    if (proxy.host) {
      const address = `${formatHostForUrl(proxy.host)}:${PROXY_PORT}`;
      env.NODE_USE_ENV_PROXY = '1';
      env.HTTPS_PROXY = `http://${address}`;
      env.HTTP_PROXY = `http://${address}`;
      log(`主机代理 ${address} 可达（来源 ${proxy.source}，1s 探活）⇒ 走代理`);
    } else {
      log(`主机代理不可达（${proxy.source}，1s 探活）⇒ 直连`);
    }
  } else {
    log('--proxy-port 0 ⇒ 跳过代理探测（直连）');
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  return env;
}

// ── 元数据 / token（0600；退出时清理）─────────────────────────────────────────

function publicKeys() {
  return [...keys.values()].map((e) => ({
    key: e.key,
    cwd: e.cwd, // P1：每个条目（key+cwd）的生效工作目录
    sessionId: e.runtime?.sessionId ?? null,
    turns: e.turns,
    runtimePid: e.runtime?.runtimePid ?? null,
    startedAt: e.runtime?.startedAt ?? null,
    idleForMs: Date.now() - e.lastUsedAt,
    queued: e.queue.length,
  }));
}

function writeMeta(extra = {}) {
  const payload = {
    pid: process.pid,
    host: '127.0.0.1',
    /** 请求槽位（= 元数据文件名里的那一段）；两个守护并存时用它区分 */
    metaPort: META_SLOT,
    /** 实际监听端口（WSL 侧端口被占时会 +1，于是这两个值可能不同） */
    port: PORT,
    version: VERSION,
    // 换角度评审第 1 条：元数据里也带上，宿主在"守护没起来/握手失败"时仍能从文件判断版本。
    pluginVersion: PLUGIN_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    cwd: CWD,
    profile: PROFILE,
    idleMs: IDLE_MS,
    queueLimit: QUEUE_LIMIT,
    lingerMs: LINGER_MS,
    startedAt,
    keys: publicKeys(),
    retired: retired.slice(),
    ...extra,
  };
  try {
    const tmp = `${metaPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, metaPath());
    try {
      fs.chmodSync(metaPath(), 0o600);
    } catch {
      /* drvfs */
    }
    return true;
  } catch (e) {
    log(`写 ${metaPath()} 失败: ${e.message}`);
    return false;
  }
}

/** 只清**自己的**文件：绝不动别的槽位的元数据/token（并发守护隔离）。 */
function cleanupFiles() {
  for (const f of [metaPath(), `${metaPath()}.tmp`, tokenPath(), LAUNCHER]) {
    if (!f) continue;
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── key 表 / 运行时 ───────────────────────────────────────────────────────────

/** key -> { key, runtime, turns, queue: [{text,resolve}], running, lastUsedAt, idleTimer } */
const keys = new Map();
/**
 * 已回收的会话（F-17，2026-10-27 审查）：idle/运行时死亡会把条目从 `keys` 删掉，`sessionId` 也随之从
 * 元数据消失 —— 换一个宿主进程来续聊时 `knownSession=null`，于是**静默**开了新会话（连"上下文已重置"
 * 都提示不了）。这里保留有限条数的"退役记录"，让下一次调用能判断出"本来有会话、现在没了"。
 */
const retired = [];
const RETIRED_MAX = 32;
function retireSession(entry, reason) {
  if (!entry?.sessionId) return;
  retired.unshift({ key: entry.key, cwd: entry.cwd, sessionId: entry.sessionId, at: Date.now(), reason });
  if (retired.length > RETIRED_MAX) retired.length = RETIRED_MAX;
}
let runtimeEnv = null;
let shuttingDown = false;
let activeConns = 0;
let lingerTimer = null;

// ── 搜索工具安装 / 代理探测（2026-10-27 审查 F-12、F-30）──────────────────────────
//
// F-12：安装**不能**挡在搜索请求路径上 —— host 侧只等 60s，而 GitHub API(150s)/下载(320s)/解压(120s)
// 的上界远超它：首次搜索必然超时失败（而发行版自带的 GNU grep 本来就能用），用户重试还会再起一份安装。
// 现在改为「先按现有后端搜、安装在后台跑」；进度经 `provision` 字段如实带回（installing=true）。
let searchProvisionInFlight = null;
let lastSearchProvision = null;
function kickSearchProvision(autoInstall, proxy) {
  if (searchProvisionInFlight) {
    return { installing: true, ...(lastSearchProvision ?? { rg: 'installing', fd: 'installing', notes: [] }) };
  }
  searchProvisionInFlight = (async () => {
    try {
      const p = await ensureSearchTools({ autoInstall, proxy });
      setSearchToolPaths(toolPaths());
      lastSearchProvision = { rg: p.rg?.source ?? 'missing', fd: p.fd?.source ?? 'missing', notes: p.notes ?? [] };
      for (const note of lastSearchProvision.notes) process.stderr.write(`[daemon] tool provision: ${note}\n`);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      lastSearchProvision = { rg: 'unknown', fd: 'unknown', notes: [`安装失败（本次搜索使用已有后端）：${msg}`] };
      process.stderr.write(`[daemon] tool provision failed: ${msg}\n`);
    } finally {
      searchProvisionInFlight = null;
    }
  })();
  return { installing: true, ...(lastSearchProvision ?? { rg: 'installing', fd: 'installing', notes: [] }) };
}

// F-30：每次搜索都重新探活代理（最多 1–2s）没有意义 —— 结果带 TTL 缓存。
let proxyCacheForSearch = null;
async function proxyForSearch() {
  const ttlMs = 60000;
  if (proxyCacheForSearch && Date.now() - proxyCacheForSearch.at < ttlMs) return proxyCacheForSearch.host;
  let host = null;
  try {
    const resolved = await resolveProxyHost(PROXY_PORT);
    // IPv6 网关在 URL 里必须加方括号，否则 `http://fe80::1:9910` 不是合法 URL。
    if (resolved.host) {
      const h = resolved.host.includes(':') ? `[${resolved.host}]` : resolved.host;
      host = `http://${h}:${PROXY_PORT}`;
    }
  } catch {
    /* 探活失败 ⇒ 直连（与旧行为一致） */
  }
  proxyCacheForSearch = { at: Date.now(), host };
  return host;
}

/** 有客户端连着 / 还有 key ⇒ 取消闸门；两者都空才重新计时。 */
function clearLinger() {
  if (lingerTimer) clearTimeout(lingerTimer);
  lingerTimer = null;
}

function armLinger() {
  clearLinger();
  if (!(LINGER_MS > 0) || shuttingDown) return;
  if (activeConns > 0 || keys.size > 0) return; // 有会话要保 ⇒ 绝不因闸门退出
  lingerTimer = setTimeout(() => {
    if (shuttingDown) return;
    if (activeConns > 0 || keys.size > 0) return armLinger();
    log(`无 key 且无客户端 ${LINGER_MS}ms ⇒ 守护按寿命闸门自退`);
    void reapAllAndExit('linger');
  }, LINGER_MS);
  lingerTimer.unref?.();
}

/** 统一回收路径：shutdown op / SIGINT/SIGTERM / 寿命闸门 都走这里（回收运行时 + 清自己的元数据）。 */
async function reapAllAndExit(reason) {
  if (shuttingDown) return [];
  shuttingDown = true;
  clearLinger();
  // F-04（2026-10-27 审查）：收尾必须有**总时限** —— 多个运行时串行 close 可能超过 systemd 的
  // TimeoutStopSec，那时会被 SIGKILL 且什么都不清（元数据/令牌/运行时全留下）。20s 后强制退出，
  // 并在日志里留证；元数据保留 ⇒ 残留仍可被下一次 status/stop 发现。
  setTimeout(() => {
    log(`${reason} ⇒ 收尾超过 20s，强制退出（残留仍可被发现）`);
    process.exit(1);
  }, 20_000).unref?.();
  const reaped = publicKeys();
  log(`${reason} ⇒ 回收全部运行时并退出（${reaped.length} 个 key）`);
  for (const e of keys.values()) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    await e.runtime?.close().catch((err) => log(`close key=${e.key} 失败: ${err.message}`));
  }
  keys.clear();
  cleanupFiles();
  // 让 shutdown 的**回包先冲出去**再关服务器/退出：以前用 setImmediate 会和 write() 抢跑，
  // 客户端偶发看到 `connection closed before reply`（实测一次；虽然客户端有按 pid 兜底，但那是噪声）。
  setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  }, 250).unref?.();
  return reaped;
}

/**
 * 条目 id = `key` + **cwd**（P1）。为什么必须把 cwd 纳入身份：一个运行时的 cwd 在创建时就固定了
 * （它决定会话 cwd 与启动工作目录），而 `wsl_agent({cwd})` 是用户可见参数。
 * 以前守护把 cwd 钉死在 `--cwd` 上 ⇒ per-call cwd 被**静默忽略**（行为回退）。
 * 现在同一个 key 的不同 cwd 各持一个运行时（各自的 sessionId），而**同 key 同 cwd 仍然复用同一个**
 * ⇒ 跨宿主重连不受影响。返回值与元数据都会带上生效的 cwd，绝不静默。
 */
const entryId = (key, cwd) => `${key}\u0000${cwd}`;

function getEntry(key, cwd) {
  const id = entryId(key, cwd);
  let e = keys.get(id);
  if (e?.runtime && !e.runtime.alive) {
    log(`key=${key} cwd=${cwd} 运行时已退出(exit=${e.runtime.exitCode}) ⇒ 丢弃（上下文已重置）`);
    retireSession(e, 'runtime-exit');
    e.runtime = null;
    e.sessionId = null;
  }
  if (!e) {
    e = {
      id,
      key,
      cwd,
      runtime: null,
      sessionId: null,
      turns: 0,
      queue: [],
      running: false,
      lastUsedAt: Date.now(),
      idleTimer: null,
    };
    keys.set(id, e);
  }
  return e;
}

function armIdle(entry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  if (!(IDLE_MS > 0)) return;
  entry.idleTimer = setTimeout(async () => {
    entry.idleTimer = null;
    if (shuttingDown || !keys.has(entry.id)) return;
    // F-07（2026-10-27 审查）：正在跑的轮次或还有排队 ⇒ **重新计时**，绝不回收在跑的运行时。
    // 旧实现只在 pump 的 finally 里重置定时器，于是「上一轮结束后 29 分钟时开始新一轮」会在
    // 30 分钟边界被回收 —— 调用方拿到 retryable、上下文丢失，而 README 只写了"到期回收"。
    if (entry.running || entry.queue.length > 0) {
      log(`key=${entry.key} cwd=${entry.cwd} 空闲到期但仍有在跑/排队的轮次 ⇒ 延后回收`);
      armIdle(entry);
      return;
    }
    const rt = entry.runtime;
    // F-17：先记下"这个会话曾被回收"，再删条目 —— 换宿主进程续聊时才能判断出"上下文丢了"。
    retireSession(entry, 'idle');
    keys.delete(entry.id);
    log(`key=${entry.key} cwd=${entry.cwd} 空闲 ${IDLE_MS}ms ⇒ 回收运行时（上下文随之丢失）`);
    await rt?.close().catch(() => {});
    writeMeta();
    armLinger(); // 最后一个 key 被回收后开始计寿命（有 key 时闸门不计时）
  }, IDLE_MS);
  entry.idleTimer.unref?.();
}

async function ensureRuntime(entry) {
  if (entry.runtime?.alive) return entry.runtime;
  if (!runtimeEnv) runtimeEnv = await buildRuntimeEnv();
  const rt = new SdkRuntime({
    key: entry.key,
    version: VERSION,
    cwd: entry.cwd, // P1：按条目（key+cwd）各用自己的工作目录，不再钉死 --cwd
    profile: PROFILE,
    provider: PROVIDER,
    model: MODEL,
    promptTimeoutMs: PROMPT_TIMEOUT_MS,
    quietMs: QUIET_MS,
    env: runtimeEnv,
    log: (...a) => log(...a),
  });
  await rt.start();
  entry.runtime = rt;
  entry.sessionId = rt.sessionId;
  entry.turns = 0;
  return rt;
}

/** 同一 key 的并发 prompt：**FIFO 串行**，等待位超过上限就明确拒绝（SDK 无 cancel，不许变长尾）。 */
function enqueuePrompt(entry, text) {
  // F-07（2026-10-27 审查）：新请求到达 ⇒ 立刻取消 idle 计时（否则可能在轮次进行中触发回收）。
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  entry.lastUsedAt = Date.now();
  if (entry.queue.length >= QUEUE_LIMIT) {
    return Promise.resolve({
      ok: false,
      error:
        `queue full for key "${entry.key}" cwd=${entry.cwd} (limit ${QUEUE_LIMIT} waiting): ` +
        `上游 SDK 无 cancel，串行队列不接受更多并发；等当前轮结束后重试`,
      queueFull: true,
      retryable: true,
      queueDepth: entry.queue.length,
    });
  }
  return new Promise((resolve) => {
    entry.queue.push({ text, resolve });
    void pump(entry);
  });
}

async function pump(entry) {
  if (entry.running) return;
  entry.running = true;
  try {
    while (entry.queue.length) {
      const job = entry.queue.shift();
      entry.lastUsedAt = Date.now();
      writeMeta();
      try {
        const rt = await ensureRuntime(entry);
        const r = await rt.prompt(job.text);
        entry.turns = r.turns;
        entry.lastUsedAt = Date.now();
        job.resolve({
          ok: !r.retryable,
          answer: r.text,
          sessionId: r.sessionId,
          cwd: entry.cwd, // P1：把**生效的** cwd 回报给调用方（绝不静默）
          turns: r.turns,
          runtimePid: r.runtimePid,
          completedBy: r.completedBy,
          eventCount: r.eventCount,
          retryable: Boolean(r.retryable),
          // 语义 #6：没有正文时**不换**运行时、不改 sessionId，只回报"可重试"
          error: r.retryable
            ? `运行时没有产出 assistant 正文（completedBy=${r.completedBy}, events=${r.eventCount}）；` +
              `运行时保持不动，可直接重试（上下文未丢）`
            : undefined,
          queueDepth: entry.queue.length,
        });
      } catch (e) {
        job.resolve({ ok: false, error: e?.message ?? String(e), retryable: true, queueDepth: entry.queue.length });
      }
      writeMeta();
    }
  } finally {
    entry.running = false;
    armIdle(entry);
    writeMeta();
  }
}

// ── 协议 ──────────────────────────────────────────────────────────────────────

async function handle(req) {
  const id = req?.id ?? null;
  const op = req?.op;
  if (op === 'status') {
    return {
      ok: true,
      id,
      daemonPid: process.pid,
      host: '127.0.0.1',
      port: PORT,
      version: VERSION,
      // 换角度评审第 1 条：宿主必须能判断"守护是哪个插件版本、哪版协议"，否则升级后的错配只能靠猜。
      pluginVersion: PLUGIN_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      cwd: CWD,
      profile: PROFILE,
      idleMs: IDLE_MS,
      queueLimit: QUEUE_LIMIT,
      lingerMs: LINGER_MS,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      keys: publicKeys(),
    };
  }
  if (op === 'prompt') {
    const key = String(req.key ?? '').trim();
    if (!key) return { ok: false, id, error: 'prompt requires a non-empty "key"' };
    if (typeof req.text !== 'string' || !req.text.length) {
      return { ok: false, id, error: 'prompt requires a non-empty "text"' };
    }
    // P1：per-call cwd（可选）。缺省 = 守护启动时的 --cwd；不同 cwd ⇒ 不同运行时条目（各自 sessionId）。
    const cwd = typeof req.cwd === 'string' && req.cwd.trim() ? req.cwd.trim() : CWD;
    const entry = getEntry(key, cwd);
    const r = await enqueuePrompt(entry, req.text);
    return { id, cwd: entry.cwd, ...r };
  }
  if (op === 'shutdown') {
    const reaped = await reapAllAndExit('收到 shutdown');
    return { ok: true, id, reaped };
  }
  // 2026-10-23：探测/安装 Rust CLI 工具（探针与工具共用；安装只写指定目录，默认 ~/.local/bin）。
  // `args.list === true` 只报告清单不安装；`args.tools` 指定子集（缺省核心集合）。
  // 没显式给 proxy 时用宿主代理网关（NAT 下 GitHub 直连不通）。
  if (op === 'provision') {
    try {
      const args = req?.args ?? {};
      let proxy = typeof args.proxy === 'string' && args.proxy ? args.proxy : null;
      if (proxy === null && args.proxy !== false) {
        const resolved = await resolveProxyHost(PROXY_PORT).catch(() => ({ host: null }));
        proxy = resolved.host ? `http://${resolved.host}:${PROXY_PORT}` : null;
      }
      if (args.resolveOnly === true) {
        const ids = Array.isArray(args.tools) && args.tools.length > 0 ? args.tools : catalog().map((t) => t.id);
        const assets = {};
        for (const id of ids) {
          assets[id] = resolveAssetFor(id, { proxy });
        }
        return { ok: true, id, result: { assets, proxyUsed: proxy } };
      }
      if (args.list === true) {
        const ids = Array.isArray(args.tools) && args.tools.length > 0 ? args.tools : catalog().map((t) => t.id);
        const result = await ensureTools(ids, { autoInstall: false, installDir: args.installDir, proxy, ignorePath: args.ignorePath === true });
        return { ok: true, id, result: { ...result, catalog: catalog() } };
      }
      const ids = Array.isArray(args.tools) && args.tools.length > 0 ? args.tools : CORE_TOOLS;
      const result = await ensureTools(ids, {
        autoInstall: args.autoInstall !== false,
        installDir: typeof args.installDir === 'string' && args.installDir ? args.installDir : undefined,
        proxy,
        ignorePath: args.ignorePath === true,
      });
      return { ok: true, id, result };
    } catch (e) {
      return { ok: false, id, code: (e && e.code) || 'E_IO', error: (e && e.message) || String(e) };
    }
  }
  // 2026-10-23：搜索也走发行版（grep/find），不给 Windows ripgrep 喂 Linux 路径。
  // 体验优先：缺 rg/fd 就**自动装**（静态二进制到 ~/.local/bin，不用 sudo）；装失败也要退回慢后端
  // 并把原因/手动安装命令带给调用方（不许静默降级）。
  if (op === 'search') {
    try {
      // F-12（2026-10-27 审查）：安装不再阻塞本次搜索 —— 先用现有后端返回结果，安装在后台进行。
      // autoInstall 在 `req.args` 里（search-tool 把参数放在 args），不是 req 顶层。
      const provision = kickSearchProvision(req?.args?.autoInstall !== false, await proxyForSearch());
      // 冷启动第一次搜索前同步一次已装工具路径（否则会先用 GNU grep 兜底：结果正确但慢）。
      setSearchToolPaths(toolPaths());
      const result = await handleSearchOp(req);
      return { ok: true, id, result: { ...result, provision } };
    } catch (e) {
      return { ok: false, id, code: (e && e.code) || 'FS_IO_ERROR', error: (e && e.message) || String(e) };
    }
  }
  // 2026-10-23：文件操作走 WSL 原生 node:fs（宿主 ctx.fs provider 的 RPC 后端）。
  // 语义与 dsh-fs-local 对齐（见 src/fs-rpc.ts 头部）；错误带 FS_* 码（工具层据此渲染）。
  if (op === 'fs') {
    try {
      const result = await handleFsOp(req);
      return { ok: true, id, result };
    } catch (e) {
      return { ok: false, id, code: (e && e.code) || 'FS_IO_ERROR', error: (e && e.message) || String(e) };
    }
  }
  return { ok: false, id, error: `unknown op: ${String(op)}` };
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  // 连接级兜底（F-02）：半开连接不能永久占 fd，也不能永久阻止寿命闸门。
  socket.setTimeout(SOCKET_IDLE_MS, () => {
    log(`连接空闲 ${SOCKET_IDLE_MS}ms ⇒ 断开（实际使用不会这么久）`);
    socket.destroy();
  });
  // 有客户端连着 ⇒ 寿命闸门不计时（正在用的守护绝不自己退出）
  activeConns += 1;
  clearLinger();
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    activeConns -= 1;
    armLinger();
  };
  socket.on('close', release);
  let buf = '';
  let authed = false;
  let rejected = false; // 已判定拒绝（超大帧/鉴权失败）⇒ 后续数据直接丢弃，不再尝试写回
  let peer = 'unknown';
  const write = (obj) => {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(obj) + '\n');
    } catch {
      /* 客户端已走 */
    }
  };
  socket.on('data', (chunk) => {
    if (rejected) return;
    buf += chunk;
    // F-02：鉴权之前就开始累积 ⇒ 必须在累积当下判定上限（拿不到换行符也要能拒绝）。
    if (buf.length > MAX_FRAME_BYTES) {
      rejected = true;
      buf = '';
      log(`拒绝超大帧（已收 ${chunk.length}B 追加后超 ${MAX_FRAME_BYTES}B，authed=${authed}）⇒ 断开`);
      write({ ok: false, error: `frame too large (>${MAX_FRAME_BYTES} bytes)` });
      socket.end();
      return;
    }
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        write({ id: null, ok: false, error: 'invalid JSON request line' });
        continue;
      }
      if (!authed) {
        // 第一帧必须是 hello + 正确 token —— 本机任意进程都不能偷 prompt/shutdown
        if (req?.op !== 'hello') {
          rejected = true;
          log(`拒绝未握手连接（op=${String(req?.op)}）`);
          write({ ok: false, error: 'hello required as first frame' });
          socket.end();
          return;
        }
        if (req.token !== token) {
          rejected = true;
          log('拒绝 token 不符的连接');
          write({ ok: false, error: 'unauthorized' });
          socket.end();
          return;
        }
        authed = true;
        peer = String(req.client ?? 'unknown');
        write({
          ok: true,
          op: 'hello',
          daemonPid: process.pid,
          host: '127.0.0.1',
          port: PORT,
          version: VERSION,
          // 换角度评审第 1 条：hello 是宿主判断"能不能用新 op"的唯一时机。
          pluginVersion: PLUGIN_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          cwd: CWD,
          profile: PROFILE,
          idleMs: IDLE_MS,
          queueLimit: QUEUE_LIMIT,
          startedAt,
        });
        continue;
      }
      log(`recv op=${req?.op} id=${req?.id} key=${req?.key ?? '-'} peer=${peer}`);
      handle(req).then(write, (e) => write({ id: req?.id ?? null, ok: false, error: e?.message ?? String(e) }));
    }
  });
  // 客户端断开：**什么都不做** —— 这正是本功能的分水岭
  socket.on('end', () => log(`客户端断开（运行时保持存活）peer=${peer}`));
  socket.on('error', (e) => log(`socket 错误: ${e.message}`));
});

// F-02：连接数上限（超出由 Node 直接丢弃，不进入上面的 handler）。
server.maxConnections = MAX_CONNS;
server.on('drop', (data) => log(`连接数已达上限 ${MAX_CONNS} ⇒ 丢弃新连接（${JSON.stringify(data).slice(0, 160)}）`));

let PORT = PORT_REQ;

async function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
  // 体验优先：守护一起来就在后台补齐核心 CLI 工具（rg/fd/ast-grep/sd/bat/tokei/dust/procs 缺就装，
  // 静态二进制到 ~/.local/bin），用户第一次搜索/调用时通常已就绪；失败只记日志，不阻塞也不伪装成功。
  setTimeout(async () => {
    try {
      const resolved = await resolveProxyHost(PROXY_PORT).catch(() => ({ host: null }));
      const provision = await ensureTools(CORE_TOOLS, { autoInstall: true, proxy: resolved.host ? `http://${resolved.host}:${PROXY_PORT}` : null });
      setSearchToolPaths(toolPaths());
      for (const note of provision.notes ?? []) process.stderr.write(`[daemon] tool provision: ${note}\n`);
    } catch (e) {
      process.stderr.write(`[daemon] tool provision failed: ${(e && e.message) || String(e)}\n`);
    }
  }, 1500);
}

async function main() {
  // 换角度评审第 6 条：参数错误在 main() 里统一报（结构化日志 + exit 2），而不是模块顶层抛栈。
  if (configErrors.length) {
    for (const e of configErrors) log(`参数错误: ${e}`);
    log('FATAL: 启动参数非法 ⇒ 退出（未进入服务态）');
    process.exit(2);
  }
  fs.writeFileSync(tokenPath(), token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(tokenPath(), 0o600);
  } catch {
    /* drvfs */
  }
  for (let i = 0; i < PORT_TRIES; i++) {
    const candidate = PORT_REQ + i;
    try {
      await listenOn(candidate);
      PORT = candidate;
      if (i > 0) log(`端口 ${PORT_REQ} 在 WSL 侧被占（EADDRINUSE）⇒ 改用 ${PORT}`);
      break;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE') throw e;
      log(`WSL 侧 ${candidate} 已被占用（EADDRINUSE）⇒ 试 ${candidate + 1}`);
      if (i === PORT_TRIES - 1) throw new Error(`WSL 侧 ${PORT_REQ}..${candidate} 全被占用`);
    }
  }
  // F-52（2026-10-27 审查）：元数据写不出来 ⇒ 客户端**永远发现不了**这个守护（只能白等 20s 再判死）。
  // 那种"listen 成功却没有元数据"的半死状态比启动失败更难查，所以直接按启动失败处理。
  if (!writeMeta()) {
    log('FATAL: 元数据写入失败 ⇒ 不进入服务态（客户端将无法发现本守护）');
    cleanupFiles();
    process.exit(2);
  }
  log(`listening 127.0.0.1:${PORT} pid=${process.pid} dsh@${VERSION} cwd=${CWD} idleMs=${IDLE_MS} queue=${QUEUE_LIMIT} lingerMs=${LINGER_MS}`);
  // 起完就开始计寿命闸门（armLinger 内部：有 key 或有客户端时拒绝计时）
  armLinger();
  // 启动脚本已在 bash 里打开，可以安全删掉（本守护不把任何东西落在 /tmp）
  if (LAUNCHER) {
    try {
      fs.rmSync(LAUNCHER, { force: true });
      log(`已清理启动脚本 ${LAUNCHER}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * F-04（2026-10-27 审查）：第二次信号**不再**"立即 `return []` 然后 `process.exit(0)`" ——
 * 那会跳过 `rt.close()` 与 `cleanupFiles()`，把 detached 运行时变成永久孤儿（不在 /proc 身份扫描
 * 口径内、继续占模型配额），元数据/令牌也残留。现在：第一次信号走完整清理；第二次只增加一个
 * 10s 的强制退出兜底，清理照旧进行（有界，不会无限挂住）。
 */
let shutdownPromise = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shutdownPromise) {
      log(`收到 ${sig}（第 2 次）：收尾仍在进行 —— 保留清理，10s 后仍未退出才硬退`);
      setTimeout(() => process.exit(1), 10_000).unref?.();
      return;
    }
    shutdownPromise = reapAllAndExit(`收到 ${sig}`);
  });
}

/**
 * ★★ F-37（task-15）：**忽略 SIGHUP** —— 否则守护的寿命会被绑死在 Windows 侧包装层上。
 *
 * 实测（2026-10-12，本机 WSL）：`kill -HUP <daemon pid>` ⇒ 进程立刻消失、**没有** `收到 shutdown`
 * 之类的收尾日志（SIGHUP 的默认动作就是终止）；同理，**只杀 Windows 侧 `wsl.exe` 包装层**（宿主进程
 * 仍活着）也会让守护在 3s 内变成 `refused` —— 即"包装层一死，会话就结束"，这与本文件的头号语义
 * 「关客户端 **≠** 会话结束」直接冲突（设计稿 §1 / README 都把它写成卖点）。
 *
 * 为什么是忽略而不是"优雅收尾"：SIGHUP 在这里的语义是"控制终端/会话首进程没了"，**不是**有人要结束会话。
 * `nohup(1)` 的做法就是忽略它。会话的三种结束方式**一个都没变**：显式 `shutdown` op、空闲闸门
 * `--idle-ms`、寿命闸门 `--linger-ms`；`SIGINT`/`SIGTERM` 仍然走上面的优雅回收路径。
 *
 * ⚠️ 副作用（如实记录）：宿主进程被硬杀时，守护会**继续活着**（这正是要的），于是它会以"有元数据的
 * 活守护"身份被下一次 `daemonSnapshot()` 认出来并被复用；要收掉它得显式 `stop`（或等 idle/linger）。
 */
process.on('SIGHUP', () => {
  log('收到 SIGHUP（Windows 侧包装层/控制终端消失）⇒ 按"关客户端 ≠ 会话结束"忽略，会话继续');
});

main().catch((e) => {
  log(`FATAL: ${e?.message ?? String(e)}`);
  cleanupFiles();
  process.exit(2);
});
