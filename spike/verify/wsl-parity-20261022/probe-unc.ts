#!/usr/bin/env node
/**
 * probe-unc.ts —— WSL UNC 反解（参考 ZCode 的 wslUncWorkspace）。
 *
 * 覆盖：两种服务名前缀、反斜杠/正斜杠、含空格的发行版名、根路径、非 UNC 拒绝，以及正向拼接的往返一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWslUncPath, isWslUncPath, wslUncPath } from '../../../src/unc-path.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const BS = String.fromCharCode(92);
const uncOf = (distro, linuxPath = '') => BS + BS + 'wsl.localhost' + BS + distro + (linuxPath ? BS + linuxPath.slice(1).split('/').join(BS) : BS);

const a = parseWslUncPath(uncOf('debian-u8-1', '/home/g'));
check('现代前缀：反解 distro', a && a.distro === 'debian-u8-1', JSON.stringify(a));
check('现代前缀：反解 linuxPath', a && a.linuxPath === '/home/g', a && a.linuxPath);
const legacy = parseWslUncPath(BS + BS + 'wsl$' + BS + 'Ubuntu 22.04 LTS' + BS + 'home' + BS + 'g');
check('旧前缀 wsl$ + 含空格发行版', legacy && legacy.distro === 'Ubuntu 22.04 LTS' && legacy.linuxPath === '/home/g', JSON.stringify(legacy));
const fwd = parseWslUncPath('//wsl.localhost/debian-u8-1/home');
check('正斜杠形式', fwd && fwd.distro === 'debian-u8-1' && fwd.linuxPath === '/home', JSON.stringify(fwd));
const root = parseWslUncPath(uncOf('debian-u8-1'));
check('根路径', root && root.distro === 'debian-u8-1' && root.linuxPath === '/', JSON.stringify(root));
check('非 UNC：Linux 路径', parseWslUncPath('/home/g') === null);
check('非 UNC：普通共享', parseWslUncPath(BS + BS + 'server' + BS + 'share') === null);
check('非 UNC：只有服务名', parseWslUncPath(BS + BS + 'wsl.localhost' + BS) === null);
check('isWslUncPath 一致', isWslUncPath(uncOf('d', '/x')) === true && isWslUncPath('/x') === false);
const built = wslUncPath('debian-u8-1', '/home/g');
const round = parseWslUncPath(built);
check('正向拼接 → 反解往返一致', round && round.distro === 'debian-u8-1' && round.linuxPath === '/home/g', built);

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-unc.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
