/**
 * p06-assert.ts —— T54 的**成品图/读数断言**（读 out-p06-*.json，可红可绿，exit 1 = 有失败）。
 *
 * 用法： node p06-assert.ts <p06-final 目录>
 *
 * 断言（判据全部来自 docs/panel-visual-spec.md 的定稿值）：
 *   A1 底栏高 = 47（两主题，含 320 窄态）             §7.2.3 / §6.1
 *   A2 V1：面板内**参与点击**的元素 rect 宽高均 ≥24      §3.4.1
 *   A3 底栏状态词 scrollWidth === clientWidth（不被省略）§4.2-1
 *   A4 菜单外框宽 === 240                            §7.2.4
 *   A5 组标题在菜单底上的对比度 ≥ 4.5（两主题）          §7.2.4.1（Q6）
 *   A6 面板内 box-shadow 计数 === 0（阴影只在浮层）      §2.2-8 / §2.4（Q4）
 *   A7 菜单不遮底栏状态词                              §7.2.4
 *   A8 三/二组标注一致：每组 aria-labelledby + 目标存在 + 无 aria-label + tabIndex ≤ -1 + 无 role=presentation   §7.2.4（T53）
 *   A9 前置②：页面 chunk 逐字节 == 磁盘（trailer 判法）   T54 前置要求
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR) { console.error('usage: node p06-assert.ts <dir>'); process.exit(2); }
const rd = JSON.parse(fs.readFileSync(path.join(DIR, 'out-p06-readings.json'), 'utf8'));
const integ = JSON.parse(fs.readFileSync(path.join(DIR, 'out-p06-integrity.json'), 'utf8'));

const R = [];
const ok = (n, d = '') => R.push({ ok: true, n, d });
const bad = (n, d = '') => R.push({ ok: false, n, d });

for (const t of rd) {
  const th = t.theme;
  // A1
  if (t.ready.footerH === 47) ok(`A1 footerH=47 (${th})`); else bad(`A1 footerH=47 (${th})`, `实得 ${t.ready.footerH}`);
  if (t.narrow.footerH === 47) ok(`A1b narrow320 footerH=47 (${th})`); else bad(`A1b narrow320 footerH=47 (${th})`, `实得 ${t.narrow.footerH}`);
  // A2
  if (t.ready.under24Count === 0) ok(`A2 V1 命中区全 ≥24 (${th})`, `${t.ready.hitCount} 个可点元素`);
  else bad(`A2 V1 命中区全 ≥24 (${th})`, `${t.ready.under24Count} 个 <24：` + JSON.stringify(t.ready.under24));
  // A3
  if (t.ready.statusWord?.notElided === true) ok(`A3 状态词不被省略 (${th})`, `${t.ready.statusWord.scrollW}==${t.ready.statusWord.clientW}`);
  else bad(`A3 状态词不被省略 (${th})`, JSON.stringify(t.ready.statusWord));
  if (t.narrow.statusWord?.notElided === true) ok(`A3b 320 状态词不被省略 (${th})`); else bad(`A3b 320 状态词不被省略 (${th})`, JSON.stringify(t.narrow.statusWord));
  // A4
  if (t.menu.menuWidth === 240) ok(`A4 菜单外框宽=240 (${th})`); else bad(`A4 菜单外框宽=240 (${th})`, `实得 ${t.menu.menuWidth}`);
  // A5
  const c = t.menu.grouplabelContrastVsMenuBg;
  if (typeof c === 'number' && c >= 4.5) ok(`A5 组标题对比度 ≥4.5 (${th})`, String(c)); else bad(`A5 组标题对比度 ≥4.5 (${th})`, `实得 ${c}`);
  // A6
  if (t.ready.shadowCount === 0) ok(`A6 面板内 box-shadow = 0 (${th})`); else bad(`A6 面板内 box-shadow = 0 (${th})`, JSON.stringify(t.ready.shadows));
  // A7
  if (t.menu.menuOverlapsStatusWord === false) ok(`A7 菜单不遮状态词 (${th})`); else bad(`A7 菜单不遮状态词 (${th})`, String(t.menu.menuOverlapsStatusWord));
  // A8
  const g = t.menu.groups || [];
  const badGroups = g.filter((x) => !x.ariaLabelledby || !x.targetExists || (x.ariaLabel !== null && x.ariaLabel !== '') || !(x.targetTabIndex <= -1) || (x.targetRole === 'presentation'));
  if (g.length > 0 && badGroups.length === 0) ok(`A8 组标注一致 (${th})`, `${g.length} 组：` + g.map((x) => x.ariaLabelledby).join(', '));
  else bad(`A8 组标注一致 (${th})`, JSON.stringify(badGroups));
}
// A9
if (integ.allPass === true) ok('A9 页面 chunk == 磁盘（9 个逐字节）', `${integ.chunkCount} 个 chunk`);
else bad('A9 页面 chunk == 磁盘', JSON.stringify(integ.chunks));

const pass = R.filter((r) => r.ok).length, fail = R.filter((r) => !r.ok).length;
for (const r of R) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.n.padEnd(40) + (r.d ? ' — ' + r.d : ''));
console.log('');
console.log(`PASS = ${pass}   FAIL = ${fail}`);
console.log(fail === 0 ? '==> PASS' : '==> FAIL');
if (fail > 0) process.exit(1);
