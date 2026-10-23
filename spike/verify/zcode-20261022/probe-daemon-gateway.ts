#!/usr/bin/env node
/**
 * probe-daemon-gateway.ts —— 守护自己的网关/代理探测与宿主侧 wsl-proxy 的**防漂移**门禁。
 *
 * 背景（handoff-2026-10-22 §6.5）：`src/daemon.ts` 是**在 WSL 里**跑的独立脚本，不能 import
 * `src/wsl-proxy.ts`，于是它内部的网关片段是**逐字复制**过去的。复制就会漂移 ⇒ 本探针做三件事：
 *   1) **源码级逐字比对**：GATEWAY_DISCOVERY_LINES / parseGatewayOutput / isLoopback /
 *      isPrivateOrLinkLocal 与 wsl-proxy 的构件一致；探活超时 = 1s（原来是 3s）；
 *   2) **行为一致**：把 daemon.ts 里那几段**从源码里取出来求值**，用同一组候选输入跑，
 *      结果必须与 wsl-proxy 的 parseGatewayOutput 逐条相同；
 *   3) **真实 WSL**：把 daemon 自己的发现脚本原样跑一遍（debian-u8-1），得到 route=/resolv= 标注，
 *      并断言它与 wsl-proxy 的 shell 片段发现的是**同一个网关**。
 * 另加：mirrored 网络下**先试 loopback**（源码顺序）；daemon.ts 仍是可被 WSL 侧 node 执行的合法 JS 语法。
 *
 * 用法：node probe-daemon-gateway.ts [--distro <name>]
 * 产出：out-daemon-gateway.json；退出码 0=全过，1=有失败，3=环境不满足。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildGatewayShellLines, parseGatewayOutput, PROXY_PROBE_TIMEOUT_SEC } from '../../../src/wsl-proxy.ts';
import { readWslOutput } from '../../../src/wsl-io.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '../../..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const daemonSrc = fs.readFileSync(path.join(ROOT, 'src/daemon.ts'), 'utf8');
const proxySrc = fs.readFileSync(path.join(ROOT, 'src/wsl-proxy.ts'), 'utf8');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const normalizeSrc = (s) =>
  String(s ?? '')
    .replace(/^export\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 从源码里按名字取一个 function 声明（花括号配对；本组函数里没有字符串内花括号）。 */
function extractFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  // `async function foo()` 里的 `function` 不是声明开头 —— 把 `async ` 一起带上，否则 await 非法
  if (start >= 6 && src.slice(start - 6, start) === 'async ') start -= 6;
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// ── 1) 源码级逐字比对 ────────────────────────────────────────────────────────

const linesMatch = /const GATEWAY_DISCOVERY_LINES = (\[[\s\S]*?\n\]);/.exec(daemonSrc);
const daemonLines = linesMatch ? new Function('return ' + linesMatch[1])() : null;
// 2026-10-22 review 修：片段从"4 行发现"扩成"发现 + 来源戳 + 校验"，行数不再写死 4 ——
// 判据改成"与 wsl-proxy.buildGatewayShellLines() 逐行等长"（下一行的逐字相等才是真判据）。
const expectedLineCount = buildGatewayShellLines().split('\n').length;
check('daemon.ts 里有 GATEWAY_DISCOVERY_LINES', Array.isArray(daemonLines) && daemonLines.length === expectedLineCount, daemonLines ? daemonLines.length + ' 行 / 期望 ' + expectedLineCount : 'not found');
check(
  '网关发现片段与 wsl-proxy.buildGatewayShellLines() 逐字一致',
  Array.isArray(daemonLines) && daemonLines.join('\n') === buildGatewayShellLines(),
  daemonLines ? JSON.stringify(daemonLines.join('\n')) : 'not found',
);

const timeoutConst = /const PROXY_PROBE_TIMEOUT_MS = (\d+);/.exec(daemonSrc);
check('探活超时 3s ⇒ 1s', timeoutConst !== null && Number(timeoutConst[1]) === PROXY_PROBE_TIMEOUT_SEC * 1000, timeoutConst ? timeoutConst[1] + 'ms vs wsl-proxy ' + PROXY_PROBE_TIMEOUT_SEC + 's' : 'not found');

for (const name of ['parseGatewayOutput', 'isLoopback', 'isPrivateOrLinkLocal']) {
  const ours = extractFunction(daemonSrc, name);
  const theirs = extractFunction(proxySrc, name);
  check(
    `${name}() 与 wsl-proxy 逐字一致`,
    !!ours && !!theirs && normalizeSrc(ours) === normalizeSrc(theirs),
    ours ? normalizeSrc(ours).slice(0, 120) : 'not found',
  );
}

// ── 2) 把 daemon 的片段从源码取出来求值，行为必须与 wsl-proxy 一致 ──────────────

const factory = new Function(
  'isIP',
  [
    extractFunction(daemonSrc, 'parseGatewayOutput'),
    extractFunction(daemonSrc, 'isLoopback'),
    extractFunction(daemonSrc, 'isPrivateOrLinkLocal'),
    'return parseGatewayOutput;',
  ].join('\n'),
);
const daemonParse = factory(net.isIP);
check('daemon 片段可独立求值（无宿主依赖）', typeof daemonParse === 'function');

const MATRIX = [
  'route=172.24.16.1 resolv=10.255.255.254',
  'resolv=10.255.255.254',
  'resolv=8.8.8.8',
  'route=127.0.0.1 resolv=::1',
  '',
  'route=::1 resolv=fd00::1',
  'resolv=169.254.1.1',
  'resolv=fe80::1',
  'route=192.168.1.1',
  'resolv=1.2.3.4',
  'garbage 172.16.0.1',
];
const diffs = MATRIX.filter((input) => JSON.stringify(daemonParse(input)) !== JSON.stringify(parseGatewayOutput(input)));
check(
  '10+ 组候选输入：daemon 与 wsl-proxy 判定逐条相同',
  diffs.length === 0,
  'diffs=' + JSON.stringify(diffs) + ' 示例=' + JSON.stringify(daemonParse('route=172.24.16.1 resolv=10.255.255.254')),
);

// 探活：1 秒超时是真实行为（不是只有常量写对）
const probeFactory = new Function('net', 'PROXY_PROBE_TIMEOUT_MS', extractFunction(daemonSrc, 'probeTcp') + '\nreturn probeTcp;');
const probeTcp = probeFactory(net, PROXY_PROBE_TIMEOUT_SEC * 1000);
{
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const openPort = server.address().port;
  check('探活：命中本地监听 ⇒ true', (await probeTcp('127.0.0.1', openPort)) === true, 'port=' + openPort);
  server.close();
  const startedAt = Date.now();
  const unreachable = await probeTcp('192.0.2.1', openPort); // TEST-NET-1：SYN 被丢 ⇒ 只能等超时
  const elapsed = Date.now() - startedAt;
  check(
    '探活：不可达地址按 1s 超时返回 false（不再是 3s）',
    unreachable === false && elapsed >= 900 && elapsed <= 2500,
    'elapsed=' + elapsed + 'ms',
  );
}

// 网关脚本：发现+校验片段原样保留 + 只追加"用 GW_SRC 打戳"
{
  const scriptFactory = new Function('GATEWAY_DISCOVERY_LINES', extractFunction(daemonSrc, 'gatewayDiscoveryScript') + '\nreturn gatewayDiscoveryScript;');
  const discoveryScript = scriptFactory(daemonLines)();
  check('发现脚本以片段原文开头（逐字不动）', discoveryScript.startsWith(daemonLines.join('\n') + '\n'), JSON.stringify(discoveryScript.slice(0, 60)));
  // 2026-10-22 review 修：来源戳必须来自同一条命令里的 GW_SRC，不能再事后用 `ip route … | grep -q .` 猜
  // （`default dev eth0` 无 via 时会把 resolv 候选误标成 route，从而绕过私有/链路本地校验）。
  check('发现脚本用 GW_SRC 打戳（route=/resolv= 与取值同源）', discoveryScript.indexOf('GW_SRC') >= 0 && /printf "%s=%s" "\$\{GW_SRC:-resolv\}"/.test(discoveryScript), discoveryScript.split('\n').slice(-1)[0]);
  check('发现脚本不再事后猜来源（无 `ip route … | grep -q .`）', discoveryScript.indexOf('grep -q .') < 0);

  // mirrored 网络：先试 loopback，再退回网关
  const resolveSrc = extractFunction(daemonSrc, 'resolveProxyHost');
  check(
    'resolveProxyHost：先试 127.0.0.1 再退回网关',
    !!resolveSrc && resolveSrc.indexOf("'127.0.0.1'") >= 0 && resolveSrc.indexOf("'127.0.0.1'") < resolveSrc.indexOf('discoverGateway()'),
    resolveSrc ? 'order ok' : 'not found',
  );
  check('resolveProxyHost：代理端口 0 ⇒ 不探测', !!resolveSrc && resolveSrc.indexOf('disabled') >= 0);
}

// 旧写法不残留（防回退）
check('daemon.ts 不再用 execSync 抓 ip route', daemonSrc.indexOf('execSync') < 0);
check('daemon.ts 不再有 3s 探活默认值', !/ms = 3000/.test(daemonSrc) && daemonSrc.indexOf('PROXY_PROBE_TIMEOUT_MS') >= 0);
// 上一版实现的残尾（`gw` 变量 + 第二处 NODE_USE_ENV_PROXY）会覆盖新代理地址并抛 ReferenceError
check('daemon.ts 没有残留的 gw 变量', !/\bgw\b/.test(daemonSrc));
check('buildRuntimeEnv 只有一处设置代理环境变量', (daemonSrc.match(/NODE_USE_ENV_PROXY/g) || []).length === 1, 'x' + (daemonSrc.match(/NODE_USE_ENV_PROXY/g) || []).length);
check('formatHostForUrl 处理 IPv6 方括号', extractFunction(daemonSrc, 'formatHostForUrl') !== null && daemonSrc.indexOf('[${host}]') >= 0);

// ── 2b) 行为级：用假的 net.connect / 假 execFileSync 跑 buildRuntimeEnv 的三条分支 ──
// （Lead 要求：loopback 通 / loopback 不通但网关通 / 都不通；外加端口 0 与无网关）
{
  const probeTcpSrc = extractFunction(daemonSrc, 'probeTcp');
  const resolveSrc = extractFunction(daemonSrc, 'resolveProxyHost');
  const discoverSrc = extractFunction(daemonSrc, 'discoverGateway');
  const mkProbeTcp = (netImpl) => new Function('net', 'PROXY_PROBE_TIMEOUT_MS', probeTcpSrc + '\nreturn probeTcp;')(netImpl, PROXY_PROBE_TIMEOUT_SEC * 1000);
  const mkResolve = (probeTcpImpl, discoverImpl) =>
    new Function('probeTcp', 'discoverGateway', 'PROXY_PROBE_TIMEOUT_MS', resolveSrc + '\nreturn resolveProxyHost;')(probeTcpImpl, discoverImpl, PROXY_PROBE_TIMEOUT_SEC * 1000);

  /** 假 net：按 decide(host,port) 决定 connect/timeout/error，并记录探测顺序。 */
  const fakeNet = (decide) => {
    const calls = [];
    const impl = {
      isIP: net.isIP,
      connect: ({ host, port }) => {
        calls.push(host + ':' + port);
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.setTimeout = () => {};
        setImmediate(() => {
          const outcome = decide(host, port);
          if (outcome === 'connect') socket.emit('connect');
          else if (outcome === 'timeout') socket.emit('timeout');
          else socket.emit('error', new Error('ECONNREFUSED'));
        });
        return socket;
      },
    };
    return { impl, calls };
  };

  // 场景 1：mirrored 网络 —— loopback 通 ⇒ 用 127.0.0.1，**不去问网关**
  {
    const { impl, calls } = fakeNet(() => 'connect');
    let gatewayAsked = 0;
    const resolveProxyHost = mkResolve(mkProbeTcp(impl), () => {
      gatewayAsked += 1;
      return { host: '172.30.176.1', source: 'route' };
    });
    const picked = await resolveProxyHost(9910);
    check('分支①loopback 通 ⇒ 用 loopback 且不退回网关', picked.host === '127.0.0.1' && picked.source === 'loopback' && gatewayAsked === 0 && calls[0] === '127.0.0.1:9910', JSON.stringify(picked) + ' calls=' + JSON.stringify(calls));
  }
  // 场景 2：NAT 网络 —— loopback 不通、网关（ip route 的 via）通 ⇒ 用网关
  {
    const { impl, calls } = fakeNet((host) => (host === '172.30.176.1' ? 'connect' : 'timeout'));
    const resolveProxyHost = mkResolve(mkProbeTcp(impl), () => ({ host: '172.30.176.1', source: 'route' }));
    const picked = await resolveProxyHost(9910);
    check('分支②loopback 不通但网关通 ⇒ 用网关', picked.host === '172.30.176.1' && picked.source === 'route' && calls.length === 2 && calls[0] === '127.0.0.1:9910', JSON.stringify(picked) + ' calls=' + JSON.stringify(calls));
  }
  // 场景 3：都不通 ⇒ 直连（host null），来源如实标注
  {
    const { impl } = fakeNet(() => 'timeout');
    const resolveProxyHost = mkResolve(mkProbeTcp(impl), () => ({ host: '172.30.176.1', source: 'route' }));
    const picked = await resolveProxyHost(9910);
    check('分支③都不通 ⇒ 直连（host=null，来源 gateway-unreachable）', picked.host === null && picked.source === 'gateway-unreachable', JSON.stringify(picked));
  }
  // 场景 4：没有可用网关 ⇒ 直连（来源 no-gateway）
  {
    const { impl, calls } = fakeNet(() => 'timeout');
    const resolveProxyHost = mkResolve(mkProbeTcp(impl), () => ({ host: null, source: null }));
    const picked = await resolveProxyHost(9910);
    check('分支④无网关 ⇒ 直连（来源 no-gateway，只探了 loopback）', picked.host === null && picked.source === 'no-gateway' && calls.length === 1, JSON.stringify(picked));
  }
  // 场景 5：--proxy-port 0 ⇒ 完全不探测
  {
    const { impl, calls } = fakeNet(() => 'connect');
    const resolveProxyHost = mkResolve(mkProbeTcp(impl), () => ({ host: '172.30.176.1', source: 'route' }));
    const picked = await resolveProxyHost(0);
    check('分支⑤端口 0 ⇒ disabled 且零探测', picked.host === null && picked.source === 'disabled' && calls.length === 0, JSON.stringify(picked));
  }
  // 6) discoverGateway（daemon 版）用假 execFileSync：解析 route=/resolv=，且判据与宿主一致
  {
    const mkDiscover = (execImpl) =>
      new Function('execFileSync', 'parseGatewayOutput', 'gatewayDiscoveryScript', discoverSrc + '\nreturn discoverGateway;')(
        execImpl,
        daemonParse,
        () => 'GATEWAY-DISCOVERY-SCRIPT',
      );
    const discover = mkDiscover((cmd, args) => 'route=10.1.2.3 ');
    check('discoverGateway：route 候选被接受（source=route）', JSON.stringify(discover()) === '{"host":"10.1.2.3","source":"route"}', JSON.stringify(discover()));
    const discoverResolv = mkDiscover(() => 'resolv=10.255.255.254');
    check('discoverGateway：私有 resolv 候选被接受', JSON.stringify(discoverResolv()) === '{"host":"10.255.255.254","source":"resolv"}', JSON.stringify(discoverResolv()));
    const discoverPublic = mkDiscover(() => 'resolv=8.8.8.8');
    check('discoverGateway：公网 resolv 被拒', discoverPublic().host === null, JSON.stringify(discoverPublic()));
    const discoverThrow = mkDiscover(() => {
      throw new Error('bash missing');
    });
    check('discoverGateway：命令失败 ⇒ 无网关（不抛）', discoverThrow().host === null, JSON.stringify(discoverThrow()));
  }
}

// daemon.ts 仍是 WSL 侧 node 能直接执行的合法语法（类型可擦除）
{
  const syntax = spawnSync(process.execPath, ['--experimental-strip-types', '--check', path.join(ROOT, 'src/daemon.ts')], { encoding: 'utf8', windowsHide: true });
  check('daemon.ts 通过 node --experimental-strip-types --check', syntax.status === 0, 'exit=' + syntax.status + ' ' + String(syntax.stderr || '').split('\n').slice(-1)[0]);
}

// ── 3) 真实 WSL：daemon 的发现脚本原样执行，并与 wsl-proxy 的片段对照 ──────────

let names = [];
try {
  names = readWslOutput(execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', windowsHide: true }))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  names = [];
}
const REAL = arg('distro', names[0] || '');
const observations = { distro: REAL || null };
if (REAL) {
  const runBash = (script) => execFileSync('wsl.exe', ['-d', REAL, '--exec', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const scriptFactory = new Function('GATEWAY_DISCOVERY_LINES', extractFunction(daemonSrc, 'gatewayDiscoveryScript') + '\nreturn gatewayDiscoveryScript;');
  const discoveryScript = scriptFactory(daemonLines)();
  let daemonOut = '';
  try {
    daemonOut = String(runBash(discoveryScript)).trim();
  } catch (e) {
    daemonOut = 'ERR ' + String(e).slice(0, 120);
  }
  observations.daemonDiscoveryOutput = daemonOut;
  const parsed = daemonParse(daemonOut);
  check('真实 WSL：daemon 发现脚本产出带来源标注的候选', /^(route|resolv)=/.test(daemonOut) && !!parsed.host, daemonOut + ' ⇒ ' + JSON.stringify(parsed));

  let proxyOut = '';
  try {
    proxyOut = String(runBash(buildGatewayShellLines() + '\nprintf %s "${GATEWAY:-}"')).trim();
  } catch (e) {
    proxyOut = 'ERR ' + String(e).slice(0, 120);
  }
  observations.proxyFragmentOutput = proxyOut;
  check('真实 WSL：daemon 与 wsl-proxy 发现同一个网关', !!parsed.host && parsed.host === proxyOut, 'daemon=' + JSON.stringify(parsed.host) + ' proxy=' + JSON.stringify(proxyOut));

  // 守护脚本在 WSL 里真能起（Lead 要求的"写进 WSL 后能正常启动"）：
  // --linger-ms 1 + 无 key 无客户端 ⇒ 起来后立刻按寿命闸门**自退**，不留长期服务；
  // 端口 9101 故意避开 8911-8990 禁用段。
  {
    const linuxRoot = String(execFileSync('wsl.exe', ['-d', REAL, '--exec', 'wslpath', '-a', '-u', ROOT], { encoding: 'utf8', windowsHide: true })).trim();
    const stateDir = `/tmp/dsh-probe-daemon-${process.pid}`;
    const launch = [
      'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
      'exec node "$1" --port 9101 --meta-port 9101 --state-dir "$2" --no-shell-env --linger-ms 1 --proxy-port 0 --idle-ms 0',
    ].join('\n');
    const r = spawnSync('wsl.exe', ['-d', REAL, '--exec', 'bash', '-c', launch, '_', `${linuxRoot}/src/daemon.ts`, stateDir], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    const out = String(r.stdout ?? '') + String(r.stderr ?? '');
    observations.daemonStartupTail = out.split('\n').filter(Boolean).slice(-3).join(' | ');
    check(
      '真实 WSL：daemon.ts 由 WSL 侧 node 起得来（listening + 寿命闸门自退）',
      r.status === 0 && /listening 127\.0\.0\.1:9101/.test(out) && /自退/.test(out),
      'exit=' + r.status + ' ' + observations.daemonStartupTail,
    );
    try {
      runBash(`rm -rf ${JSON.stringify(stateDir)}`);
    } catch {
      /* 清理失败不影响判定（只是 /tmp 残留） */
    }
  }

  // 观测：这台机器的 WSL 网络模式（mirrored 时 loopback 才能命中宿主代理）
  try {
    observations.wslLoopbackToHostProxy =
      String(runBash('timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/9910" 2>/dev/null && echo reachable || echo unreachable')).trim();
  } catch {
    observations.wslLoopbackToHostProxy = 'probe-failed';
  }
  try {
    observations.wslNetworkingMode = String(runBash('command -v wslinfo >/dev/null 2>&1 && wslinfo --networking-mode || cat /proc/sys/kernel/osrelease')).trim();
  } catch {
    observations.wslNetworkingMode = 'probe-failed';
  }
} else {
  check('真实 WSL：有可用发行版（否则本组跳过 ⇒ 记未验证）', false, '没有运行中的发行版');
}

const summary = { generatedAt: new Date().toISOString(), observations, total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-daemon-gateway.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n观测: ' + JSON.stringify(observations));
console.log(summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);

