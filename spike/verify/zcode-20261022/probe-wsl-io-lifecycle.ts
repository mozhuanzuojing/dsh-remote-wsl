#!/usr/bin/env node
/**
 * probe-wsl-io-lifecycle.ts —— runWsl 的短命子进程纳入关停屏障 + 输出解码（真实 WSL，只读/短命命令）。
 *
 * 覆盖（handoff-2026-10-22 §5.3 遗留项 + ZCode wsl-backend 的三条纪律）：
 *   1) runWsl spawn 的 wsl.exe 立刻进 lifecycle（settle 能等它），退出后自动摘除；
 *   2) settle 确实等它自然退出（不 kill），resolved 结果仍然正确；
 *   3) settle 宽限到点会 kill 它（只 kill 自己登记的），remaining 归零；
 *   4) 关停态下 runWsl 拒绝 spawn（exit 127 + E_SHUTDOWN 文案），且归属表不增；
 *   5) 收尾路径（allowDuringShutdown）在关停态仍能跑 —— reapWsl / 临时文件清扫靠它；
 *   6) wslPathConvert 的 spawn 前双检（关停后抛 E_SHUTDOWN）；
 *   7) 解码：NUL ⇒ utf16le 否则 utf8，并去 NUL/BOM/CR；与 explorer.decodeWslOutput 行为一致；
 *   8) 源码级接线（track / isShuttingDown / allowDuringShutdown / assertAlive 在 spawnSync 前）。
 *
 * 用法：node probe-wsl-io-lifecycle.ts [--distro <name>]
 * 产出：out-wsl-io-lifecycle.json；退出码 0=全过，1=有失败，3=环境不满足（没有运行中的发行版）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLifecycle, activeLifecycle } from '../../../src/lifecycle.ts';
import {
  runWsl,
  readWslOutput,
  decodeWslOutput,
  normalizeWslOutput,
  wslPathConvert,
  WSL_EXEC_MAX_BUFFER,
} from '../../../src/wsl-io.ts';
import { decodeWslOutput as explorerDecodeWslOutput } from '../../../src/explorer.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

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
if (!REAL) {
  console.error('环境不满足：本机没有可用的 WSL 发行版');
  process.exit(3);
}
const cfg = { distro: REAL, wslHome: '/home/g', cwd: '/home/g', proxyPort: 9910 };
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const wsl = (script) => execFileSync('wsl.exe', ['-d', REAL, '--exec', 'bash', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();

// 观测（不进判据）：WSL 侧 node 版本、WSL 的 loopback 能否直连宿主代理、ip route 网关
const observations = {};
try {
  observations.wslNodeVersion = wsl('export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"; node --version 2>/dev/null || echo none');
} catch (e) {
  observations.wslNodeVersion = 'error: ' + String(e).slice(0, 80);
}
try {
  const rc = wsl('timeout 1 bash -c "exec 3<>/dev/tcp/127.0.0.1/9910" 2>/dev/null && echo reachable || echo unreachable');
  observations.wslLoopbackToHostProxy = rc;
} catch {
  observations.wslLoopbackToHostProxy = 'probe-failed';
}
try {
  observations.wslDefaultRoute = wsl("ip route show default 2>/dev/null | head -1");
} catch {
  observations.wslDefaultRoute = 'probe-failed';
}

// 1) runWsl 的短命子进程被登记，settle 等它自然退出（宽限给足 3s ⇒ 不 kill）
{
  const lifecycle = createLifecycle();
  const startedAt = Date.now();
  const pending = runWsl(cfg, 'sleep 0.05\nprintf ok\n', { timeoutMs: 20000 });
  check('runWsl spawn 后立刻进归属表', activeLifecycle() === lifecycle && lifecycle.size() === 1, 'size=' + lifecycle.size());
  const report = await lifecycle.settle(5000, { graceTimeoutMs: 3000, killWaitTimeoutMs: 250 });
  const res = await pending;
  check(
    'settle 等到它自然退出（不 kill）',
    report.timedOut === false && report.killed === 0 && report.remaining === 0 && Date.now() - startedAt >= 40,
    JSON.stringify(report),
  );
  check('runWsl 结果仍正确（stdout/exitCode）', res.exitCode === 0 && res.stdout.trim() === 'ok', JSON.stringify(res).slice(0, 200));
  check('退出后自动摘除', lifecycle.size() === 0);
}

// 2) settle 宽限到点会 kill 自己登记的子进程（短命命令不该拖住关停）
{
  const lifecycle = createLifecycle();
  const pending = runWsl(cfg, 'sleep 2\n', { timeoutMs: 30000 });
  const startedAt = Date.now();
  const report = await lifecycle.settle(5000, { graceTimeoutMs: 150, killWaitTimeoutMs: 500 });
  const elapsed = Date.now() - startedAt;
  await pending; // 等 runWsl 自己结算（包装层被 kill ⇒ exit）
  check(
    'settle 宽限后 kill 掉短命子进程（forced=true，kill 后干净退出 ⇒ timedOut=false）',
    report.forced === true && report.timedOut === false && report.killed === 1 && report.remaining === 0 && elapsed < 3000,
    'elapsed=' + elapsed + ' ' + JSON.stringify(report),
  );
}

// 3) 关停态：runWsl 拒绝 spawn（127 + E_SHUTDOWN），归属表不增
{
  const lifecycle = createLifecycle();
  lifecycle.beginShutdown();
  const startedAt = Date.now();
  const res = await runWsl(cfg, 'printf should-not-run\n', { timeoutMs: 5000 });
  const elapsed = Date.now() - startedAt;
  check(
    '关停后 runWsl 拒绝并返回 E_SHUTDOWN',
    res.exitCode === 127 && /E_SHUTDOWN/.test(res.stderr) && res.stdout === '' && elapsed < 100,
    'exit=' + res.exitCode + ' ms=' + elapsed,
  );
  check('关停后 runWsl 不 spawn（归属表不增）', lifecycle.size() === 0, 'size=' + lifecycle.size());

  // 4) 收尾路径仍能跑（reapWsl / 临时文件清扫依赖它）
  const cleanup = await runWsl(cfg, 'printf cleanup-ok\n', { timeoutMs: 15000, allowDuringShutdown: true });
  check('收尾路径 allowDuringShutdown 仍能执行', cleanup.exitCode === 0 && cleanup.stdout.trim() === 'cleanup-ok', JSON.stringify(cleanup).slice(0, 160));

  // 5) wslPathConvert 的 spawn 前双检
  let pathCode = null;
  try {
    wslPathConvert(cfg, '/home', 'to-windows');
  } catch (e) {
    pathCode = e && e.code;
  }
  check('wslPathConvert：关停后抛 E_SHUTDOWN', pathCode === 'E_SHUTDOWN', String(pathCode));
}

// 6) 解码：NUL ⇒ utf16le 否则 utf8；去 NUL/BOM/CR
{
  const lifecycle = createLifecycle();
  const res = await runWsl(cfg, "printf 'A\\r\\nB\\n'", { timeoutMs: 15000 });
  check('runWsl 输出归一去 CR（A\\r\\nB ⇒ A\\nB）', res.stdout === 'A\nB\n', JSON.stringify(res.stdout));
  const uni = await runWsl(cfg, "printf '中文✓\\n'", { timeoutMs: 15000 });
  check('runWsl 输出 UTF-8 中文正确', uni.stdout === '中文✓\n', JSON.stringify(uni.stdout));
  check('UTF-16LE 缓冲按 NUL 判码', decodeWslOutput(Buffer.from('A中', 'utf16le')) === 'A中', JSON.stringify(decodeWslOutput(Buffer.from('A中', 'utf16le'))));
  check('normalize 去 BOM/NUL/CR', normalizeWslOutput('\uFEFFx\u0000y\r') === 'xy', JSON.stringify(normalizeWslOutput('\uFEFFx\u0000y\r')));
  const samples = [Buffer.from('plain-utf8 中文'), Buffer.from('A中', 'utf16le'), Buffer.from('\uFEFF bom\r\n', 'utf8')];
  const same = samples.every((b) => readWslOutput(b) === explorerDecodeWslOutput(b));
  check('与 explorer.decodeWslOutput 行为一致（3 个样本）', same, samples.map((b, i) => i + ':' + JSON.stringify(readWslOutput(b))).join(' '));
  check('WSL_EXEC_MAX_BUFFER = 8MB', WSL_EXEC_MAX_BUFFER === 8 * 1024 * 1024, String(WSL_EXEC_MAX_BUFFER));
  // ★ 已知边界（如实钉住，不包装成能力）：ZCode 的启发式是"含 NUL ⇒ UTF-16LE"，
  //   所以**UTF-8 流里出现裸 NUL**（例如 `printf 'a\0b'`）会被判成 UTF-16LE 而解坏。
  //   本仓与 ZCode 行为一致；这条断言的作用是让该边界一改就红，而不是假装它能解。
  const nulInUtf8 = readWslOutput(Buffer.from('a\u0000b', 'utf8'));
  check('已知边界：UTF-8 流含裸 NUL 会被判成 UTF-16LE（与 ZCode 同一启发式）', nulInUtf8 !== 'ab', JSON.stringify(nulInUtf8));
}

// 7) 超时路径仍是 124，且超时后归属被摘除
{
  const lifecycle = createLifecycle();
  const res = await runWsl(cfg, 'sleep 3\n', { timeoutMs: 300 });
  check('runWsl 超时仍返回 124', res.exitCode === 124, 'exit=' + res.exitCode);
  await new Promise((r) => setTimeout(r, 50));
  check('超时 kill 后归属摘除', lifecycle.size() === 0, 'size=' + lifecycle.size());
}

// 8) 源码级接线
{
  const src = fs.readFileSync(path.join(DIR, '../../../src/wsl-io.ts'), 'utf8');
  check('源码：runWsl 内 track 子进程', /if \(lifecycle\) lifecycle\.track\(child\);/.test(src));
  check('源码：spawn 前问关停屏障', src.indexOf('lifecycle.isShuttingDown()') >= 0);
  check('源码：收尾路径豁免', (src.match(/allowDuringShutdown: true/g) || []).length >= 2, 'allowDuringShutdown:true x' + (src.match(/allowDuringShutdown: true/g) || []).length);
  check('源码：wslPathConvert 在 spawnSync 前 assertAlive', /lifecycle\.assertAlive\(\)[\s\S]{0,300}spawnSync\('wsl\.exe'/.test(src));
  check('源码：不再按 utf8 流式解码', src.indexOf("setEncoding('utf8')") < 0);
  check('源码：spawnSync 用 buffer + 8MB 上限', /encoding: 'buffer', \/\/ NUL ⇒ utf16le[\s\S]{0,120}maxBuffer: WSL_EXEC_MAX_BUFFER/.test(src));
}

const summary = {
  generatedAt: new Date().toISOString(),
  distro: REAL,
  observations,
  total: results.length,
  pass: results.filter((r) => r.ok).length,
  fail: results.filter((r) => !r.ok).length,
  results,
};
fs.writeFileSync(path.join(DIR, 'out-wsl-io-lifecycle.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n观测: ' + JSON.stringify(observations));
console.log(summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
