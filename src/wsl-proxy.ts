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

/**
 * 网关**发现**片段：route 优先、resolv 回落，并在取值的同一条命令里打来源戳 `GW_SRC`。
 *
 * 这是 `buildGatewayShellLines()` 的前半段；单独导出是为了让探针能**只跑校验**（后半段）而不受
 * 真实 `ip route` 影响 —— 见 `spike/verify/wsl-parity-20261022/probe-wsl-proxy.ts` 的"校验语义"一节。
 */
export function buildGatewayDiscoveryLines() {
  return [
    "GATEWAY=$(ip route show default 2>/dev/null | awk '$1 == \"default\" && $2 == \"via\" { print $3; exit }')",
    'GW_SRC=route',
    'if [ -z "${GATEWAY:-}" ] && [ -r /etc/resolv.conf ]; then',
    "  GATEWAY=$(awk '$1 == \"nameserver\" { print $2; exit }' /etc/resolv.conf)",
    '  GW_SRC=resolv',
    'fi',
  ];
}

/**
 * 网关**校验**片段：先卡字符集（只允许 IP 字面量字符），再判 loopback，最后按来源判私有/链路本地。
 * 判据与 `parseGatewayOutput()` / `src/daemon.ts` 的 `isPrivateOrLinkLocal()` 一致。
 *
 * 2026-10-23 review ⑤：字符集白名单。`GATEWAY` 会进 `bash -c "…/dev/tcp/$GATEWAY/9910"`（双引号里
 * 仍会展开 `$(...)`），而 `route` 来源此前只挡了 loopback、不过字符集 —— 万一 `ip route` 输出被替换/含
 * 异常字节，就多了一条注入面。这里先把它限制成 `[0-9a-fA-F:.]`（IPv4/IPv6 字面量够用），挡掉一切
 * shell 元字符与 IPv4-mapped 之类非规范形状。
 */
export function buildGatewayValidationLines() {
  return [
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
}

/**
 * shell 侧网关发现 + 校验（发现片段 + 校验片段）。**本文件是唯一来源**；`src/daemon.ts` 在 WSL 里跑、
 * 不能 import 宿主模块，逐字复制同一段，由 `spike/verify/zcode-20261022/probe-daemon-gateway.ts`
 * 的源码级比对防漂移。
 *
 * 2026-10-22 review 修两处（此前只有 `parseGatewayOutput` 带校验，而它在生产路径上没人调用）：
 *  1. **来源在取值同一条命令里打戳**（`GW_SRC=route|resolv`）。原来 daemon 事后用
 *     `ip route show default | grep -q .` 猜来源 —— 遇到 `default dev eth0` 这种**没有 via** 的默认路由时，
 *     会把实际来自 resolv 的候选（可能是 8.8.8.8 这类公网 DNS）误标成 `route`，从而跳过下面的校验；
 *  2. **校验下沉到 shell**：loopback 一律拒绝；`resolv` 来源只接受私有/链路本地
 *     （与 `parseGatewayOutput` / daemon 的判据一致）。
 */
export function buildGatewayShellLines() {
  return [...buildGatewayDiscoveryLines(), ...buildGatewayValidationLines()].join('\n');
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

/**
 * 拼接导出代理环境变量的 shell 片段（`shellPreamble` 用）。
 *
 * 顺序与 `daemon.ts` 的 `resolveProxyHost()`、ZCode 的 `resolveRuntimeProxy()` 一致：
 * **先试 WSL 自己的 127.0.0.1**（mirrored 网络模式下宿主代理就在这里，命中就不该换成网关），
 * 再退回上面校验过的网关。两条都不通 ⇒ 明确打一行 stderr 说明"本次直连"，不静默。
 */
export function buildProxyEnvBlock(port, timeoutSec = PROXY_PROBE_TIMEOUT_SEC) {
  const loop = '127.0.0.1:' + port;
  return [
    // F-56（2026-10-27 审查）：IPv6 网关在 bash 的 `/dev/tcp` 与 URL 里**都必须加方括号**。
    // 旧实现只对"编译期已知的字面量"加括号，`$GATEWAY` 这种运行期变量永远裸着 ⇒ 纯 IPv6 网关下
    // 探活必然失败、代理被判"不可达"而静默直连。这里在运行期归一成 GW_HOST，后续统一用它。
    'GW_HOST=""',
    'if [ -n "${GATEWAY:-}" ]; then',
    '  case "$GATEWAY" in *:*) GW_HOST="[$GATEWAY]" ;; *) GW_HOST="$GATEWAY" ;; esac',
    'fi',
    'if ' + buildProxyProbeCommand('127.0.0.1', port, timeoutSec) + ' 2>/dev/null; then',
    '  export NODE_USE_ENV_PROXY=1',
    '  export HTTPS_PROXY="http://' + loop + '"',
    '  export HTTP_PROXY="http://' + loop + '"',
    'elif [ -n "$GW_HOST" ] && ' + buildProxyProbeCommand('$GW_HOST', port, timeoutSec) + ' 2>/dev/null; then',
    '  export NODE_USE_ENV_PROXY=1',
    '  export HTTPS_PROXY="http://$GW_HOST:' + port + '"',
    '  export HTTP_PROXY="http://$GW_HOST:' + port + '"',
    'else',
    '  echo "remote-wsl: 主机代理 ' + loop + ' 与 ${GATEWAY:-<网关未知>}:' + port + ' 都不可达 ⇒ 本次直连" >&2',
    'fi',
  ].join('\n');
}


/** 拼一次性探测脚本：发现网关 + 探活（同样先 loopback 再网关），输出 `reachable <host>` / `unreachable <host>`。 */
export function buildProxyProbeScript(port, timeoutSec = PROXY_PROBE_TIMEOUT_SEC) {
  return [
    buildGatewayShellLines(),
    'GW_HOST=""',
    'if [ -n "\${GATEWAY:-}" ]; then',
    '  case "$GATEWAY" in *:*) GW_HOST="[$GATEWAY]" ;; *) GW_HOST="$GATEWAY" ;; esac',
    'fi',
    'if ' + buildProxyProbeCommand('127.0.0.1', port, timeoutSec) + ' 2>/dev/null; then',
    '  printf "reachable %s" "127.0.0.1"',
    'elif [ -n "$GW_HOST" ] && ' + buildProxyProbeCommand('$GW_HOST', port, timeoutSec) + ' 2>/dev/null; then',
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
export function invalidateProxyCache(distro) {
  if (!distro) {
    proxyCache.clear();
    return;
  }
  const prefix = distro + ':';
  for (const key of [...proxyCache.keys()]) if (key.startsWith(prefix)) proxyCache.delete(key);
}

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
