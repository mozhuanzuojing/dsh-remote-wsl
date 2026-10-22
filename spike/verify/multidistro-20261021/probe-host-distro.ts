#!/usr/bin/env node
/**
 * probe-host-distro.ts —— host 半「按请求换发行版」的行为断言（只读，不碰守护/不写任何东西）。
 *
 * 覆盖三件事：
 *   1) 未知发行版 ⇒ E_ARG（不静默回落默认发行版）；
 *   2) 已登记但未运行的发行版 ⇒ listDir 的 E_UNAVAILABLE 文案点名的是**那个**发行版；
 *   3) 真实发行版 ⇒ snapshot/listDir 的 target/listDir.distro 都是被请求的那一个。
 *
 * 用真依赖（真的 wsl.exe 探测）但只调只读方法：snapshot / listDir。
 * 用法：node probe-host-distro.ts [--real <本机真实发行版>]
 * 产出：out-host-distro.json；退出码 0=全过，1=有失败，3=环境不满足。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createExplorerHandlers } from '../../../src/explorer.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };

let names = [];
try {
  names = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8' }).split('\n').map((s) => s.replace(/\0/g, '').trim()).filter(Boolean);
} catch { names = []; }
const REAL = arg('real', names[0] || '');
if (!REAL) { console.error('环境不满足：本机没有可用的 WSL 发行版'); process.exit(3); }

const FAKE = 'probe-no-such-distro';
const WSL1 = 'probe-wsl1-distro';
const config = {
  distro: REAL,
  wslHome: '/home/g',
  cwd: '/home/g',
  daemonPort: 8972,
  timeoutMs: 60000,
  proxyPort: 9910,
  dshVersion: '',
};

const handlers = createExplorerHandlers({
  config,
  listDistros: () => names.concat([FAKE, WSL1]),
  distroStateProbe: () => ({ defaultName: REAL, running: new Set([REAL]), versions: new Map([[WSL1, 1], [REAL, 2]]), ok: true }),
  resolveVersion: () => ({ version: '0.0.0-probe', pin: null, desktopVersion: null, drift: null }),
  writePin: () => true,
  webHosts: new Map(),
  sessionController: () => ({ create: async (req) => ({ sessionId: 'session-probe', cwd: req.cwd }) }),
});

const results = [];
const run = async (name, fn) => {
  try {
    const value = await fn();
    results.push({ name, ok: true, value });
  } catch (e) {
    results.push({ name, ok: false, code: e && e.code ? e.code : null, message: e && e.message ? String(e.message) : String(e) });
  }
  return results[results.length - 1];
};

const call = async (fn) => {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, code: e && e.code ? e.code : null, message: e && e.message ? String(e.message) : String(e) }; }
};

const unknown = await call(() => handlers.handlers['explorer.snapshot']({ distro: 'definitely-not-a-distro' }));
results.push({ name: '未知发行版：拒绝且 E_ARG', ok: unknown.ok === false && unknown.code === 'E_ARG', detail: String(unknown.code) });
results.push({ name: '未知发行版：文案点名请求名', ok: unknown.ok === false && String(unknown.message).indexOf('definitely-not-a-distro') >= 0, detail: String(unknown.message || '').slice(0, 120) });

const fakeList = await call(() => handlers.handlers['explorer.listDir']({ path: '/', distro: FAKE }));
results.push({ name: '未运行发行版：listDir 503', ok: fakeList.ok === false && fakeList.code === 'E_UNAVAILABLE', detail: String(fakeList.code) });
results.push({ name: '未运行发行版：文案点名那个发行版', ok: fakeList.ok === false && String(fakeList.message).indexOf(FAKE) >= 0, detail: String(fakeList.message || '').slice(0, 160) });

const realList = await call(() => handlers.handlers['explorer.listDir']({ path: '/home', distro: REAL }));
results.push({ name: '真实发行版：listDir 回显 distro', ok: realList.ok === true && !!realList.value && realList.value.distro === REAL, detail: realList.ok ? String(realList.value && realList.value.distro) : String(realList.message).slice(0, 120) });

const snapReal = await call(() => handlers.handlers['explorer.snapshot']({ distro: REAL }));
results.push({ name: '真实发行版：target.distro 一致', ok: snapReal.ok === true && !!snapReal.value && !!snapReal.value.target && snapReal.value.target.distro === REAL, detail: snapReal.ok ? String(snapReal.value && snapReal.value.target && snapReal.value.target.distro) : String(snapReal.message).slice(0, 160) });
results.push({ name: '真实发行版：distros 含运行态字段', ok: snapReal.ok === true && Array.isArray(snapReal.value.distros) && snapReal.value.distros.every((d) => typeof d.reachable === 'boolean'), detail: snapReal.ok ? JSON.stringify(snapReal.value.distros).slice(0, 160) : '' });

const snapFake = await call(() => handlers.handlers['explorer.snapshot']({ distro: FAKE }));
results.push({ name: '未运行发行版：snapshot 不抛、target 仍是它', ok: snapFake.ok === true && !!snapFake.value && !!snapFake.value.target && snapFake.value.target.distro === FAKE, detail: snapFake.ok ? String(snapFake.value && snapFake.value.target && snapFake.value.target.distro) : String(snapFake.message).slice(0, 160) });
const newOk = await call(() => handlers.handlers['explorer.newSession']({ path: '/home', distro: REAL }));
results.push({ name: 'newSession：返回 DSH sessionId', ok: newOk.ok === true && newOk.value && newOk.value.sessionId === 'session-probe', detail: newOk.ok ? String(newOk.value.sessionId) : String(newOk.message).slice(0, 120) });
results.push({ name: 'newSession：cwd 是该发行版的 UNC', ok: newOk.ok === true && newOk.value && String(newOk.value.cwd).indexOf('wsl.localhost') >= 0 && String(newOk.value.cwd).indexOf(REAL) >= 0, detail: newOk.ok ? String(newOk.value.cwd) : '' });
const newBad = await call(() => handlers.handlers['explorer.newSession']({ path: '/home', distro: 'definitely-not-a-distro' }));
results.push({ name: 'newSession：未知发行版 E_ARG', ok: newBad.ok === false && newBad.code === 'E_ARG', detail: String(newBad.code) });
const newEvil = await call(() => handlers.handlers['explorer.newSession']({ path: '/home/../etc', distro: REAL }));
results.push({ name: 'newSession：拒绝 .. 路径', ok: newEvil.ok === false && newEvil.code === 'E_ARG', detail: String(newEvil.code) });

const v1 = await call(() => handlers.handlers['explorer.newSession']({ path: '/home', distro: WSL1 }));
results.push({ name: 'WSL1 发行版：拒绝', ok: v1.ok === false && v1.code === 'E_ARG', detail: String(v1.code) });
results.push({ name: 'WSL1 发行版：文案说明仅支持 WSL2', ok: v1.ok === false && String(v1.message).indexOf('WSL2') >= 0, detail: String(v1.message || '').slice(0, 120) });

const summary = { generatedAt: new Date().toISOString(), real: REAL, fake: FAKE, total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-host-distro.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
