#!/usr/bin/env node
/**
 * probe-search-wsl.ts —— WSL 内搜索（grep/glob）的真机回归 + **后端选择**证据（2026-10-23）。
 *
 * 走 `createWslRpc()`（与 search-tool 同一个调用器）直接向 daemon 发 `{op:'search'}`：
 *   · grep 后端优先级 ripgrep → ugrep → GNU grep（本机 WSL 有 ripgrep 14.1.1）；
 *   · glob 后端 fd/fdfind → find（本机 WSL 有 fdfind）。
 * 判据：结果正确 + `backend` 字段是首选的快工具 + 固定串/忽略大小写/无命中/glob 通配符都对。
 *
 * 用法：node probe-search-wsl.ts；产物 out-search-wsl.json；退出码 0=全过，1=有失败。
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
  timeoutMs: 60000,
};
const ROOT = `/tmp/dsh-search-probe-${process.pid}`;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const wsl = (script) => execFileSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', script], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();

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
const search = (method, args) => rpc.call('search', method, args);

try {
  // 造夹具：一个 .txt 命中、一个忽略大小写命中、一个二进制、一个 gitignored 目录
  wsl(`rm -rf ${ROOT}; mkdir -p ${ROOT}/sub ${ROOT}/.hidden; printf 'needle alpha\\nBeta line\\n' > ${ROOT}/a.txt; printf 'needle here\\n' > ${ROOT}/sub/b.md; printf 'NEEDLE upper\\n' > ${ROOT}/c.txt; printf '\\x00\\x01needle' > ${ROOT}/bin.dat; printf 'ignored\\n' > ${ROOT}/.hidden/h.txt`);

  const r1 = await search('grep', { pattern: 'needle', path: ROOT });
  check('G1 命中 2 个文本文件（二进制不算）', Array.isArray(r1.matches) && r1.matches.length === 2, JSON.stringify(r1.matches?.map((m) => m.path)));
  check('G2 grep 后端是 ripgrep（有就首选）', r1.backend === 'ripgrep', `backend=${r1.backend}`);
  check('G3 行号与文本正确', r1.matches?.some((m) => m.line === 1 && m.text.includes('needle here')), JSON.stringify(r1.matches?.[0]));

  const r2 = await search('grep', { pattern: 'NEEDLE', path: ROOT, ignoreCase: true });
  check('G4 ignoreCase 生效（3 条：a.txt/b.md/c.txt）', r2.matches?.length === 3, `n=${r2.matches?.length}`);

  const r3 = await search('grep', { pattern: 'a.t', path: ROOT, fixedString: true });
  check('G5 fixedString 按字面量（不把 . 当任意字符）', Array.isArray(r3.matches) && r3.matches.length === 0, `n=${r3.matches?.length}`);

  const r4 = await search('grep', { pattern: 'zzz-not-there', path: ROOT });
  check('G6 无命中返回空数组（不是错误）', Array.isArray(r4.matches) && r4.matches.length === 0, JSON.stringify(r4));

  const r5 = await search('glob', { pattern: '*.txt', path: ROOT });
  check('L1 glob `*.txt` 只匹配一层（a.txt/c.txt/.hidden/h.txt，不含 sub/b.md）', r5.files?.length === 3 && r5.files.every((f) => f.endsWith('.txt') && !f.includes('/sub/')), JSON.stringify(r5.files));
  check('L2 glob 后端是 fd（有就首选）', r5.backend === 'fd', `backend=${r5.backend}`);

  const r6 = await search('glob', { pattern: '**/*.md', path: ROOT });
  check('L3 `**/*.md` 跨目录', r6.files?.length === 1 && r6.files[0].endsWith('sub/b.md'), JSON.stringify(r6.files));

  const r7 = await search('glob', { pattern: 'b.md', path: ROOT });
  check('L4 无斜杠模式按 basename 匹配', r7.files?.length === 1 && r7.files[0].endsWith('sub/b.md'), JSON.stringify(r7.files));
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
  probe: 'probe-search-wsl',
  generatedAt: new Date().toISOString(),
  target: { distro: DISTRO, daemonPort: CONFIG.daemonPort },
  checks: results,
  passed: results.length - failed.length,
  total: results.length,
  failures: failed.map((f) => `${f.name}: ${f.detail}`),
};
fs.writeFileSync(path.join(DIR, 'out-search-wsl.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: summary.passed, total: summary.total, failures: summary.failures }, null, 2));
process.exit(failed.length ? 1 : 0);
