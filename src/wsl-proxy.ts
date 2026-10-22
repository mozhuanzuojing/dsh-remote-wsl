/**
 * dsh-remote-wsl / wsl-proxy —— WSL 侧「宿主代理可达性」的探测片段。
 *
 * 参考：zai-org/ZCode 的 packages/server/src/remote/wslProxy.ts（2026-10-22 对照）。
 *
 * 背景：Windows 侧的代理（默认 127.0.0.1:9910）在 WSL2 里不能直接用 —— WSL2 的 loopback 是它自己的。
 * 要么换成宿主网关地址（ip route show default 的 via），要么在镜像网络模式下才是 127.0.0.1。
 * ZCode 的做法给了两个我们之前没有的点：
 *   1. 网关候选不只看 ip route，还回落到 /etc/resolv.conf 的 nameserver（只接受私有/链路本地地址）；
 *   2. 探活给 1 秒超时（我们原来 3 秒，代理停掉时每条 wsl_exec 都白等 3 秒）。
 *
 * 本模块只做纯函数 + 片段拼装，不发起进程；实际执行点在 wsl-io.shellPreamble（每条 WSL 命令的前缀）
 * 和 daemon.ts（常驻守护启动时探一次）。
 */
import { isIP } from 'node:net';

/** 探活超时（秒）。宿主代理停着时，这个值直接等于每条命令的额外延迟。 */
export const PROXY_PROBE_TIMEOUT_SEC = 1;

/** shell 侧网关发现：先 ip route 的 default via，再退回 /etc/resolv.conf 的 nameserver。 */
export function buildGatewayShellLines() {
  return [
    "GATEWAY=$(ip route show default 2>/dev/null | awk '$1 == \"default\" && $2 == \"via\" { print $3; exit }')",
    'if [ -z "${GATEWAY:-}" ] && [ -r /etc/resolv.conf ]; then',
    "  GATEWAY=$(awk '$1 == \"nameserver\" { print $2; exit }' /etc/resolv.conf)",
    'fi',
  ].join('\n');
}

/** /dev/tcp 探活命令（bash 内建；timeout 包一层避免挂死）。host 可以是 $GATEWAY 这样的 shell 变量。 */
export function buildProxyProbeCommand(host, port, timeoutSec = PROXY_PROBE_TIMEOUT_SEC) {
  const target = host.indexOf(':') >= 0 && host.indexOf('${') < 0 ? '[' + host + ']' : host;
  return 'timeout ' + timeoutSec + ' bash -c "exec 3<>/dev/tcp/' + target + '/' + port + '"';
}

/** 解析网关候选输出（纯函数，给测试与将来的 host 侧解析用）。 */
export function parseGatewayOutput(output) {
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

/** 拼接导出代理环境变量的 shell 片段（与 shellPreamble 里的行为一致）。 */
export function buildProxyEnvBlock(port, hostVar = '$GATEWAY', timeoutSec = PROXY_PROBE_TIMEOUT_SEC) {
  const name = hostVar.replace(/^\$/, '');
  const address = hostVar + ':' + port;
  return [
    'if [ -n "${' + name + ':-}" ] && ' + buildProxyProbeCommand(hostVar, port, timeoutSec) + ' 2>/dev/null; then',
    '  export NODE_USE_ENV_PROXY=1',
    '  export HTTPS_PROXY="http://' + address + '"',
    '  export HTTP_PROXY="http://' + address + '"',
    'else',
    '  echo "remote-wsl: 主机代理 ' + address + ' 不可用 ⇒ 本次直连" >&2',
    'fi',
  ].join('\n');
}


/** 拼一次性探测脚本：发现网关 + 探活，输出 `reachable <host>` / `unreachable <host>`。 */
export function buildProxyProbeScript(port, timeoutSec = PROXY_PROBE_TIMEOUT_SEC) {
  return [
    buildGatewayShellLines(),
    'if [ -n "\${GATEWAY:-}" ] && ' + buildProxyProbeCommand('$GATEWAY', port, timeoutSec) + ' 2>/dev/null; then',
    '  printf "reachable %s" "$GATEWAY"',
    'else',
    '  printf "unreachable %s" "\${GATEWAY:-}"',
    'fi',
  ].join('\n');
}

/** 解析探测脚本的输出。 */
export function parseProxyProbeOutput(output) {
  const match = /^(reachable|unreachable)\s+(\S*)$/.exec(String(output ?? '').trim());
  if (!match) return { reachable: null, host: null };
  return { reachable: match[1] === 'reachable', host: match[2] || null };
}

/** 进程内缓存：同一发行版+端口在 TTL 内不重复探测；不可达用更短 TTL（代理可能刚起来）。 */
const proxyCache = new Map();

/**
 * 解析某发行版看到的宿主代理（异步，带缓存与并发去重）。
 * @param options.distro - 发行版名
 * @param options.port - 代理端口；0/空 ⇒ 不探测
 * @param options.run - 在 WSL 里执行脚本并返回 stdout 的函数
 * @param options.ttlMs - 可达时的缓存时长（默认 5 分钟）
 * @param options.negativeTtlMs - 不可达时的缓存时长（默认 30 秒）
 */
export async function resolveWslProxy({ distro, port, run, ttlMs = 300000, negativeTtlMs = 30000 }) {
  if (!port) return { host: null, port: 0, reachable: null, cached: false };
  const key = distro + ':' + port;
  const now = Date.now();
  const entry = proxyCache.get(key);
  if (entry && entry.value !== undefined && entry.expiresAt > now) return { ...entry.value, cached: true };
  if (entry && entry.promise) return entry.promise;
  const promise = (async () => {
    let output = '';
    try {
      output = await run(buildProxyProbeScript(port));
    } catch {
      output = '';
    }
    const parsed = parseProxyProbeOutput(output);
    const value = { host: parsed.host, port, reachable: parsed.reachable };
    proxyCache.set(key, { value, expiresAt: Date.now() + (parsed.reachable === true ? ttlMs : negativeTtlMs) });
    return value;
  })();
  proxyCache.set(key, { promise, expiresAt: 0 });
  return promise;
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
