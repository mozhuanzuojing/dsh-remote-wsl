#!/usr/bin/env node
/**
 * probe-wsl-proxy.ts —— 参考 ZCode 的 wslProxy 后，对「网关发现 + 代理探活片段」的回归。
 *
 * 关注三件事：
 *   1) 网关候选：ip route 的 default via 优先；没有时退回 /etc/resolv.conf 的 nameserver，
 *      但只接受私有/链路本地地址（不能把 8.8.8.8 当代理宿主）；
 *   2) 探活超时 1 秒（原来 3 秒：代理停着时每条 wsl_exec 白等 3 秒）；
 *   3) 片段在真实 WSL 里能跑：不报语法错、GATEWAY 非空。
 *
 * 用法：node probe-wsl-proxy.ts；产出 out-wsl-proxy.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGatewayOutput, buildGatewayShellLines, buildGatewayValidationLines, buildProxyEnvBlock, buildProxyProbeCommand, invalidateProxyCache, resolveWslProxy } from '../../../src/wsl-proxy.ts';
import { shellPreamble } from '../../../src/wsl-io.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

check('网关：route 优先', parseGatewayOutput('route=172.24.16.1 resolv=10.255.255.254').host === '172.24.16.1');
check('网关：无 route 时用私有 resolv', parseGatewayOutput('resolv=10.255.255.254').host === '10.255.255.254');
check('网关：拒绝公网 resolv', parseGatewayOutput('resolv=8.8.8.8').host === null);
check('网关：拒绝 loopback', parseGatewayOutput('route=127.0.0.1 resolv=::1').host === null);
check('网关：空输出', parseGatewayOutput('').host === null);

const lines = buildGatewayShellLines();
check('片段：含 ip route', lines.indexOf('ip route show default') >= 0);
check('片段：含 resolv.conf 回落', lines.indexOf('/etc/resolv.conf') >= 0);
// 2026-10-22 review 修：来源必须在取值同一条命令里打戳（GW_SRC），且校验下沉到 shell ——
// 原来"只接受私有/链路本地"只写在 parseGatewayOutput 里（生产路径没人调用），shell 片段不判。
check('片段：来源戳 GW_SRC 与取值同处（review 修）', lines.indexOf('GW_SRC=route') >= 0 && lines.indexOf('GW_SRC=resolv') >= 0, lines.split('\n').slice(1, 5).join(' / '));
check('片段：shell 侧拒绝 loopback（review 修）', /127\.\*\|::1\|localhost/.test(lines), lines.split('\n').find((l) => l.indexOf('127.*') >= 0) || '');
check('片段：shell 侧 resolv 只接受私有/链路本地（review 修）', /10\.\*\|192\.168\.\*\|172\.1\[6-9\]/.test(lines) && /169\.254\.\*/.test(lines), '');
const block = buildProxyEnvBlock(9910);
check('片段：探活超时 1 秒', block.indexOf('timeout 1 ') >= 0, block.split('\n')[0]);
check('片段：先试 WSL 自己的 loopback（mirrored 网络，review 修）', block.indexOf('/dev/tcp/127.0.0.1/9910') >= 0 && block.indexOf('/dev/tcp/127.0.0.1/9910') < block.indexOf('/dev/tcp/$GATEWAY/9910'), block.split('\n')[0]);
check('片段：导出 HTTPS_PROXY（网关分支）', block.indexOf('HTTPS_PROXY="http://$GATEWAY:9910"') >= 0);
check('片段：导出 HTTPS_PROXY（loopback 分支）', block.indexOf('HTTPS_PROXY="http://127.0.0.1:9910"') >= 0);
check('片段：两路都不可达 ⇒ 明确说直连', block.indexOf('都不可达') >= 0);
const probe = buildProxyProbeCommand('$GATEWAY', 9910);
check('探活命令：双引号让 GATEWAY 在外层展开', probe.indexOf('bash -c "exec 3<>/dev/tcp/$GATEWAY/9910"') >= 0, probe);

const preamble = shellPreamble({ proxyPort: 9910, cwd: '/home/g', distro: 'debian-u8-1' });
check('preamble：1 秒探活', preamble.indexOf('timeout 1 bash -c') >= 0);
check('preamble：不再有 3 秒探活', preamble.indexOf('timeout 3 bash') < 0);
check('preamble：含 resolv 回落', preamble.indexOf('/etc/resolv.conf') >= 0);

{
  let calls = 0;
  const run = async () => { calls += 1; return 'reachable 10.9.9.9'; };
  const first = await resolveWslProxy({ distro: 'inval', port: 9910, run });
  const second = await resolveWslProxy({ distro: 'inval', port: 9910, run });
  check('代理缓存：第二次命中不重复探测', calls === 1 && second.cached === true && first.host === '10.9.9.9', 'calls=' + calls);
  invalidateProxyCache('inval');
  await resolveWslProxy({ distro: 'inval', port: 9910, run });
  check('invalidateProxyCache 清掉缓存', calls === 2, 'calls=' + calls);
}

{
  const script = preamble + '\nprintf "GATEWAY=%s" "$GATEWAY"\n';
  let out = '';
  try {
    out = execFileSync('wsl.exe', ['-d', 'debian-u8-1', '--exec', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  } catch (e) {
    out = 'ERR ' + String(e).slice(0, 120);
  }
  check('真实 WSL：片段执行成功', out.indexOf('GATEWAY=') >= 0, out.trim().slice(0, 160));
  check('真实 WSL：GATEWAY 非空', /GATEWAY=\d+\.\d+\.\d+\.\d+/.test(out), out.trim().slice(0, 160));
}

// ── 2026-10-22 review 修：校验语义（真 bash 里跑 buildGatewayValidationLines）────────
// 为什么单独测校验：发现片段的第一行会真的去跑 `ip route`，覆盖掉预设值；校验片段只读 $GATEWAY/$GW_SRC，
// 可以独立喂候选。判据与 daemon 的 isPrivateOrLinkLocal / parseGatewayOutput 一致。
{
  // ⚠️ buildGatewayValidationLines() 返回**数组**，必须自己 join('\n') —— 直接字符串相加会被
  // Array#toString 用逗号拼起来（本轮实测踩过：bash 报 `syntax error near unexpected token 'in,'`）。
  const validator = buildGatewayValidationLines().join('\n');
  const runCase = (gateway, src) => {
    // 候选都是 IP 字面量，直接赋值（不加引号：`wsl.exe … -c` 走 CommandLineToArgvW，引号会被外层处理掉）。
    const script = 'GATEWAY=' + gateway + '; GW_SRC=' + src + '\n' + validator + '\nprintf %s "${GATEWAY:-}"';
    try {
      return execFileSync('wsl.exe', ['-d', 'debian-u8-1', '--exec', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    } catch (e) {
      return 'ERR ' + String(e).slice(0, 80);
    }
  };
  const cases: [string, string, string, string][] = [
    ['8.8.8.8', 'resolv', '', 'resolv 来源的公网 DNS 必须被拒（不能当代理宿主）'],
    ['172.30.176.1', 'resolv', '172.30.176.1', 'resolv 来源的私有网关保留'],
    ['192.168.1.1', 'resolv', '192.168.1.1', '192.168/16 保留'],
    ['169.254.1.1', 'resolv', '169.254.1.1', '链路本地保留'],
    ['127.0.0.1', 'route', '', 'loopback 一律拒绝（即使来源是 route）'],
    ['8.8.8.8', 'route', '8.8.8.8', 'route 来源按 ZCode 语义不要求私有（默认网关就是它）'],
    // 2026-10-23 review ⑤：字符集白名单 —— 不是 IP 字面量形状的一律丢弃（挡 shell 元字符与
    // IPv4-mapped 之类非规范形状；GATEWAY 会进 `bash -c "…/dev/tcp/$GATEWAY/9910"`）。
    ['zzz', 'route', '', '非 IP 字符集的候选一律拒绝（字符集白名单）'],
    ['zzz', 'resolv', '', '非 IP 字符集的候选一律拒绝（resolv 同样）'],
    ['fe80::1', 'resolv', 'fe80::1', 'IPv6 链路本地保留'],
    ['fd00::1', 'resolv', 'fd00::1', 'IPv6 ULA 保留'],
  ];
  for (const [gw, src, want, why] of cases) {
    const got = runCase(gw, src);
    check(`校验：${src}=${gw} ⇒ "${want}"（${why}）`, got === want, got === want ? got : got + ' ≠ ' + want);
  }
}

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-wsl-proxy.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
