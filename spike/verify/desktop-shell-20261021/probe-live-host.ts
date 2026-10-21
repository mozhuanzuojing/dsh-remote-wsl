#!/usr/bin/env node
/**
 * probe-live-host.ts —— 对**正在运行的** DSH 宿主打一发只读探针，记录两种来源形状的真实 HTTP 结果。
 *
 * 用法：
 *   node probe-live-host.ts [--port 59014] [--label before-restart|after-restart]
 *
 * 打的是 GET /remote-wsl/api（只回方法清单）与 POST {method:'explorer.__probe__'}（未知方法，
 * host 回 400 + 方法清单）——**两条都零副作用**，不会启动/停止任何守护、不会开工作区。
 *
 * 判读：
 *   · browser       形状（Origin 与 Host 同源 + Sec-Fetch-Site: same-origin）应当 200 / 400；
 *   · desktop-shell 形状（无 Origin、无 Sec-Fetch-Site，即 Electron 壳 forwardWebRequest 的转发结果）
 *     在 2026-10-21 修复前应 403，修复并**重启宿主**后应 200 / 400。
 *
 * 产物：out-live-host-<label>.json（本目录）
 * 退出码：0 = 两种形状都通过；1 = 有形状被判 403（未修复或宿主未重启）；3 = 连不上宿主。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const PORT = Number(opt('port', '59014'));
const LABEL = opt('label', 'after-restart');
const BASE = 'http://127.0.0.1:' + PORT + '/remote-wsl/api';
const JSON_CT = { 'content-type': 'application/json', accept: 'application/json' };

async function shot(name, init) {
  try {
    const r = await fetch(BASE, init);
    const text = await r.text();
    return { name, status: r.status, body: text.slice(0, 400) };
  } catch (e) {
    return { name, status: null, error: String(e && e.message ? e.message : e) };
  }
}

const shots = [
  await shot('browser-get', { method: 'GET', headers: { accept: 'application/json', origin: 'http://127.0.0.1:' + PORT, 'sec-fetch-site': 'same-origin' } }),
  await shot('desktop-shell-get', { method: 'GET', headers: { accept: 'application/json' } }),
  await shot('desktop-shell-probe-post', { method: 'POST', headers: Object.assign({}, JSON_CT), body: JSON.stringify({ method: 'explorer.__probe__', args: {} }) }),
];

const ok = (s) => s.status === 200 || s.status === 400;
const blocked = shots.filter((s) => s.status === 403);
const unreachable = shots.every((s) => s.status === null);
const summary = {
  label: LABEL,
  generatedAt: new Date().toISOString(),
  target: BASE,
  shots,
  verdict: unreachable ? 'UNREACHABLE' : blocked.length ? 'BLOCKED(' + blocked.map((b) => b.name).join(',') + ')' : 'OK',
};
writeFileSync(DIR + 'out-live-host-' + LABEL + '.json', JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 2));
process.exit(unreachable ? 3 : blocked.length ? 1 : 0);
