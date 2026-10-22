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
import { parseGatewayOutput, buildGatewayShellLines, buildProxyEnvBlock, buildProxyProbeCommand, invalidateProxyCache, resolveWslProxy } from '../../../src/wsl-proxy.ts';
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
const block = buildProxyEnvBlock(9910);
check('片段：探活超时 1 秒', block.indexOf('timeout 1 ') >= 0, block.split('\n')[0]);
check('片段：导出 HTTPS_PROXY', block.indexOf('HTTPS_PROXY="http://$GATEWAY:9910"') >= 0);
check('片段：代理不可达走直连', block.indexOf('不可用') >= 0);
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

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-wsl-proxy.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
