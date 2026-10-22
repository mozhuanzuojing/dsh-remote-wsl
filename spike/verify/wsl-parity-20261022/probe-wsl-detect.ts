#!/usr/bin/env node
/**
 * probe-wsl-detect.ts —— 参考 ZCode（zai-org/ZCode）的 WSL 检测实现后，对我们解析层的回归。
 *
 * 覆盖三件事（都是 ZCode 踩过的坑）：
 *   1) wsl.exe 输出常是 UTF-16LE，按 UTF-8 读会夹满 NUL ⇒ decodeWslOutput 要按 NUL 判码；
 *   2) 发行版名可以含单个空格（"Ubuntu 22.04 LTS"），必须用「两个以上空格」切列；
 *   3) 一律用 wsl.exe --exec（不是 --）：-- 会把整段命令交给默认 shell -c，引号/变量会被提前展开。
 *
 * 用法：node probe-wsl-detect.ts；产出 out-wsl-detect.json；退出码 0=全过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeWslOutput, parseWslDistroTable } from '../../../src/explorer.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// 1) UTF-16LE 解码
{
  const buf = Buffer.from('  NAME  STATE  VERSION\r\ndebian-u8-1  Running  2\r\n', 'utf16le');
  const text = decodeWslOutput(buf);
  check('UTF-16LE：没有 NUL 残留', text.indexOf('\u0000') < 0, JSON.stringify(text).slice(0, 80));
  check('UTF-16LE：能解出名字', text.indexOf('debian-u8-1') >= 0);
}

// 2) 含空格的发行版名 + 默认标记 + 表头过滤
{
  const table = [
    '  NAME                   STATE           VERSION',
    '* Ubuntu 22.04 LTS       Running         2',
    '  Debian GNU/Linux       Stopped         1',
    '',
  ].join('\n');
  const rows = parseWslDistroTable(table);
  check('解析：跳过表头', rows.length === 2, 'rows=' + rows.length);
  check('解析：名字含空格', rows[0] && rows[0].name === 'Ubuntu 22.04 LTS', rows[0] && rows[0].name);
  check('解析：默认标记', rows[0] && rows[0].isDefault === true);
  check('解析：状态与版本', rows[0] && rows[0].state === 'Running' && rows[0].version === 2, JSON.stringify(rows[0]));
  check('解析：WSL1 版本', rows[1] && rows[1].version === 1 && rows[1].name === 'Debian GNU/Linux', JSON.stringify(rows[1]));
}

// 3) 真实 wsl.exe -l -v（buffer 读取 ⇒ 解码 ⇒ 解析）
{
  let text = '';
  try {
    const buf = execFileSync('wsl.exe', ['-l', '-v'], { encoding: 'buffer', windowsHide: true });
    text = decodeWslOutput(buf);
  } catch (e) {
    check('真实 wsl -l -v：可执行', false, String(e).slice(0, 120));
  }
  const rows = text ? parseWslDistroTable(text) : [];
  check('真实 wsl -l -v：至少解析出 1 个发行版', rows.length >= 1, 'rows=' + rows.length);
  const first = rows[0];
  check('真实 wsl -l -v：名字无 NUL/空白污染', !!first && /^[\x20-\x7e\u4e00-\u9fa5]+$/.test(first.name), first && JSON.stringify(first.name));
  check('真实 wsl -l -v：版本是 1 或 2', !!first && (first.version === 1 || first.version === 2), first && String(first.version));
}

// 4) --exec 语义：变量不被外层 shell 提前展开
{
  let out = '';
  try {
    out = execFileSync('wsl.exe', ['-d', 'debian-u8-1', '--exec', 'bash', '-c', 'printf "%s" "$HOME"'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) {
    out = 'ERR ' + String(e).slice(0, 80);
  }
  check('--exec：$HOME 在 bash 内展开', out.startsWith('/home/'), JSON.stringify(out));
}

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-wsl-detect.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
