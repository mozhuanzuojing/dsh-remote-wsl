#!/usr/bin/env node
/**
 * probe-search-provision.ts —— **WSL 里自动安装搜索工具**的真机回归（2026-10-23）。
 *
 * 走 daemon 的 `{op:'provision'}`（与搜索工具同一套 `ensureSearchTools`），所以测的就是真实
 * WSL 侧行为（不是 Windows 上的 bash/curl）：
 *   1. 缺 rg/fd 时**自动装**静态 musl 二进制到指定目录（不用 sudo、不写系统目录）；
 *   2. 装好的 `rg --version` / `fd --version` 能跑；
 *   3. `autoInstall:false` ⇒ 不装，但给「手动安装」提示（提示用户，不静默）；
 *   4. 坏代理 ⇒ `source:failed` + 失败原因，不抛、不假装成功。
 *
 * 只写 /tmp 下的临时目录并清理。用法：node probe-search-provision.ts
 * 产物 out-search-provision.json；退出码 0=全过，1=有失败，2=前置失败（守护起不来）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWslRpc } from '../../../src/fs-provider.ts';
import { ensureDaemon, stopDaemon } from '../../../src/daemon-client.ts';
import { resolveVersion } from '../../../src/wsl-io.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DISTRO = 'debian-u8-1';
const CONFIG = {
  distro: DISTRO,
  wslHome: '/home/g',
  cwd: '/home/g',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  dshVersion: '',
  daemonPort: 8731,
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonLingerMs: 600000,
  daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  timeoutMs: 300000,
};
const ROOT = `/tmp/dsh-prov-${process.pid}`;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const wsl = (script) => execFileSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', script], { encoding: 'utf8', timeout: 300000, windowsHide: true }).trim();

function proxyUrl() {
  try {
    const gw = wsl("(ip route show default 2>/dev/null | awk '$1==\"default\"&&$2==\"via\"{print $3;exit}'); if [ -z \"$gw\" ]; then awk '$1==\"nameserver\"{print $2;exit}' /etc/resolv.conf; fi").trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(gw)) return `http://${gw}:9910`;
  } catch {
    /* 直连 */
  }
  return null;
}

const version = resolveVersion(CONFIG);
if (!version.version) {
  console.error('无法确定 dsh 版本');
  process.exit(2);
}
let ensured;
try {
  ensured = await ensureDaemon(CONFIG, { version: version.version, log: () => {} });
} catch (e) {
  console.error('ensureDaemon 抛错: ' + (e?.message ?? String(e)));
  process.exit(2);
}
if (!ensured.ok) {
  console.error('守护起不来: ' + (ensured.error ?? 'unknown'));
  process.exit(2);
}

const rpc = createWslRpc(CONFIG);
const provision = (args) => rpc.call('provision', '', args);
const proxy = proxyUrl();
const evidence = { proxy };
try {
  wsl(`rm -rf ${ROOT}; mkdir -p ${ROOT}`);

  // 1) 真的装（忽略 PATH，模拟发行版里没有）
  const first = await provision({ installDir: `${ROOT}/one`, proxy, ignorePath: true });
  evidence.first = first;
  check('P1 缺工具时自动安装 rg+fd（不用 sudo，装到临时目录）', first?.rg?.source === 'installed' && first?.fd?.source === 'installed', JSON.stringify({ rg: first?.rg?.source, fd: first?.fd?.source }));
  check('P2 装出来的 rg 能跑 --version', /ripgrep/.test(wsl(`${first.rg.path} --version 2>&1 | head -1`)), '');
  check('P3 装出来的 fd 能跑 --version', /\bfd\b/.test(wsl(`${first.fd.path} --version 2>&1 | head -1`)), '');
  check('P4 note 里写明"已自动安装"', (first?.notes ?? []).some((n) => /已自动安装/.test(n)), JSON.stringify(first?.notes ?? []));

  // 2) 不许装 ⇒ 不装但给手动安装提示
  const noInstall = await provision({ installDir: `${ROOT}/two`, proxy, ignorePath: true, autoInstall: false });
  check('P5 autoInstall:false 不安装', noInstall?.rg?.path === null && noInstall?.fd?.path === null, '');
  check('P6 给「手动安装」提示（提示用户，不静默）', (noInstall?.notes ?? []).some((n) => /手动安装/.test(n)), JSON.stringify(noInstall?.notes ?? []));

  // 3) 坏代理 ⇒ 失败要明说，不抛
  const failed = await provision({ installDir: `${ROOT}/three`, proxy: 'http://127.0.0.1:1', ignorePath: true });
  check('P7 下载失败 ⇒ source:failed + 原因（不抛、不假装成功）', failed?.rg?.source === 'failed' && (failed?.notes ?? []).some((n) => /自动安装失败/.test(n)), JSON.stringify(failed?.notes ?? []).slice(0, 220));
} finally {
  try {
    wsl(`rm -rf ${ROOT}`);
  } catch {
    /* 清理失败不掩盖判据 */
  }
  if (ensured.started === true) {
    try {
      await stopDaemon(CONFIG);
    } catch {
      /* 留给寿命闸门 */
    }
  }
}

const failed = results.filter((r) => !r.ok);
const summary = {
  probe: 'probe-search-provision',
  generatedAt: new Date().toISOString(),
  target: { distro: DISTRO, daemonPort: CONFIG.daemonPort },
  evidence,
  checks: results,
  passed: results.length - failed.length,
  total: results.length,
  failures: failed.map((f) => `${f.name}: ${f.detail}`),
};
fs.writeFileSync(path.join(DIR, 'out-search-provision.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: summary.passed, total: summary.total, failures: summary.failures, proxy }, null, 2));
process.exit(failed.length ? 1 : 0);
