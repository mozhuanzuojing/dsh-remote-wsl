#!/usr/bin/env node
/**
 * probe-search-provision.ts —— **WSL 里自动安装 Rust CLI 工具**的真机回归（2026-10-23）。
 *
 * 走 daemon 的 `{op:'provision'}`（与 `wsl_tools` 工具同一套 `ensureTools`），测真实 WSL 侧行为：
 *   1. 目录里 18 个工具的 GitHub Release **资产都能解析**（API 可用、选型规则对）；
 *   2. 缺工具时**真的装**（ast-grep、sd 实测下载解压到 /tmp，不用 sudo）+ `--version` 能跑；
 *   3. `list` 只报告不安装，清单里能看到 source/missing；
 *   4. `autoInstall:false` ⇒ 不装，给「手动安装」提示；
 *   5. 坏代理 ⇒ `failed` + 原因，不抛、不假装成功。
 *
 * 只写 /tmp 临时目录并清理。用法：node probe-search-provision.ts
 * 产物 out-search-provision.json；退出码 0=全过，1=有失败，2=前置失败。
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
  timeoutMs: 600000,
};
const ROOT = `/tmp/dsh-prov-${process.pid}`;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const wsl = (script) => execFileSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', script], { encoding: 'utf8', timeout: 600000, windowsHide: true }).trim();

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
const evidence = {};
try {
  wsl(`rm -rf ${ROOT}; mkdir -p ${ROOT}/one ${ROOT}/two ${ROOT}/three`);

  // 1) 18 个工具的资产解析（只调 API，不下载）
  const resolved = await provision({ resolveOnly: true });
  const assets = resolved?.assets ?? {};
  const ids = Object.keys(assets);
  evidence.assets = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v?.ok ? `${v.name} @${v.tag}` : `FAIL: ${v?.error}`]));
  const bad = ids.filter((id) => !assets[id]?.ok);
  check('T1 目录里所有工具的 Release 资产都能解析', ids.length >= 18 && bad.length === 0, `ok=${ids.length - bad.length}/${ids.length} bad=${bad.join(',')}`);

  // 2) 真的装两个（一个 zip、一个 tar.gz），验证 --version
  const installed = await provision({ tools: ['ast-grep', 'sd'], installDir: `${ROOT}/one`, ignorePath: true });
  evidence.installed = installed;
  check('T2 自动安装 ast-grep（zip 资产）成功', installed?.tools?.['ast-grep']?.source === 'installed', JSON.stringify(installed?.tools?.['ast-grep']));
  check('T3 自动安装 sd（tar.gz 资产）成功', installed?.tools?.sd?.source === 'installed', JSON.stringify(installed?.tools?.sd));
  const astPath = installed?.tools?.['ast-grep']?.path;
  const sdPath = installed?.tools?.sd?.path;
  check('T4 装出来的 sg/ast-grep 能跑 --version', !!astPath && /\d+\.\d+/.test(wsl(`${astPath} --version 2>&1 | head -1`)), astPath ?? '');
  check('T5 装出来的 sd 能跑 --version', !!sdPath && /\d+\.\d+/.test(wsl(`${sdPath} --version 2>&1 | head -1`)), sdPath ?? '');

  // 3) list 只报告不安装
  const list = await provision({ list: true, installDir: `${ROOT}/two`, ignorePath: true });
  const listIds = (list?.catalog ?? []).map((c) => c.id);
  const missing = listIds.filter((id) => !list?.tools?.[id]?.path);
  const listDirFiles = wsl(`find ${ROOT}/two -type f 2>/dev/null | wc -l`);
  check('T6 list 返回全量目录（≥18）且不下载', listIds.length >= 18 && listDirFiles === '0', `ids=${listIds.length} files=${listDirFiles} missing=${missing.length}`);

  // 4) 不允许安装 ⇒ 提示手动安装
  const noInstall = await provision({ tools: ['bat'], installDir: `${ROOT}/three`, ignorePath: true, autoInstall: false });
  check('T7 autoInstall:false 不装 + 给手动安装提示', noInstall?.tools?.bat?.source === 'missing' && (noInstall?.notes ?? []).some((n) => /手动安装/.test(n)), JSON.stringify(noInstall?.notes ?? []));

  // 5) 坏代理 ⇒ 明确失败
  const failed = await provision({ tools: ['xh'], installDir: `${ROOT}/three`, proxy: 'http://127.0.0.1:1', ignorePath: true });
  check('T8 下载失败 ⇒ failed + 原因（不抛、不假装成功）', failed?.tools?.xh?.source === 'failed' && (failed?.notes ?? []).some((n) => /自动安装失败/.test(n)), JSON.stringify(failed?.notes ?? []).slice(0, 200));
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

const failedChecks = results.filter((r) => !r.ok);
const summary = {
  probe: 'probe-search-provision',
  generatedAt: new Date().toISOString(),
  target: { distro: DISTRO, daemonPort: CONFIG.daemonPort },
  evidence,
  checks: results,
  passed: results.length - failedChecks.length,
  total: results.length,
  failures: failedChecks.map((f) => `${f.name}: ${f.detail}`),
};
fs.writeFileSync(path.join(DIR, 'out-search-provision.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: summary.passed, total: summary.total, failures: summary.failures }, null, 2));
process.exit(failedChecks.length ? 1 : 0);
