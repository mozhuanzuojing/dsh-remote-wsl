/**
 * scripts/banner.ts —— **banner 的唯一生成器**（SVG 为主产物，WebP 由它光栅化）。
 *
 * 为什么要有它（2026-11-25 教训）：banner 原来是位图，里面的"工具数"和"DSH 版本"从导出那一刻
 * 就冻结了；加工具（7→9→10）和升 DSH（0.2.1-rc.3→0.2.2-rc.5）都得靠人记得回去改，改还只能抹像素
 * 重绘。现在这些事实**只从两处取**：
 *   · 工具数 ← `src/tool-catalog.ts` 的 `HOST_TOOLS`（与真实 `tools.register` 由 check-contract 校验）；
 *   · DSH 基线 ← `package.json` 的 `dsh.devBaseline`；
 *   · 插件版本 ← `package.json` 的 `version`。
 *
 * 用法：
 *   node scripts/banner.ts            # 生成 assets/banner.svg（+ 若给了 --render，再光栅化 webp）
 *   node scripts/banner.ts --check    # 只校验：现有 svg 是否与"按当前事实生成"一致（门禁用，不需要浏览器）
 *   node scripts/banner.ts --render   # 生成后调用 ego-browser + Pillow 产出 assets/banner.webp
 *
 * 设计约定：几何全部写在本文件的常量里（2172×724），文本里**只允许**出现由事实拼出的变量。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SVG_PATH = resolve(ROOT, 'assets/banner.svg');
const WEBP_PATH = resolve(ROOT, 'assets/banner.webp');

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const { HOST_TOOLS, zhCount } = await import(pathToFileURL(resolve(ROOT, 'src/tool-catalog.ts')).href);

const FACTS = {
  version: String(pkg.version),
  dshBaseline: String(pkg?.dsh?.devBaseline ?? ''),
  toolCount: HOST_TOOLS.length,
  toolCountZh: zhCount(HOST_TOOLS.length),
};
if (!FACTS.dshBaseline) {
  console.error('banner: package.json 缺少 dsh.devBaseline —— 拒绝生成（不猜版本）');
  process.exit(2);
}

const W = 2172;
const H = 724;
const FONT = 'Inter, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
const MONO = '"JetBrains Mono", "Cascadia Mono", Consolas, monospace';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 极简 SVG 元素助手（不引第三方库；只生成本文件需要的形状）。 */
const rect = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
const rrect = (x, y, w, h, r, fill, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}" ${extra}/>`;
const text = (x, y, s, size, fill, extra = '', font = FONT) =>
  `<text x="${x}" y="${y}" font-family="${font.replace(/"/g, "&quot;")}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;

function buildSvg() {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="dsh-remote-wsl：把 WSL 2 当作 DeepSeek Harness 的远端执行宿主">`,
  );
  // ── defs：底色渐变 / 光晕 / 点阵 ──
  parts.push(`<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#071A23"/><stop offset="0.45" stop-color="#101826"/><stop offset="1" stop-color="#0A1020"/>
  </linearGradient>
  <radialGradient id="glowTeal" cx="0.12" cy="0.18" r="0.62">
    <stop offset="0" stop-color="#0E4A5C" stop-opacity="0.55"/><stop offset="1" stop-color="#0E4A5C" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glowBlue" cx="0.86" cy="0.34" r="0.5">
    <stop offset="0" stop-color="#12325F" stop-opacity="0.55"/><stop offset="1" stop-color="#12325F" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="titleFade" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#F6F9FF"/><stop offset="0.62" stop-color="#EAF2FF"/><stop offset="1" stop-color="#9FC8F7"/>
  </linearGradient>
  <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
    <circle cx="1.4" cy="1.4" r="1" fill="#7FB6D0" fill-opacity="0.07"/>
  </pattern>
</defs>`);
  // ── 背景 ──
  parts.push(rect(0, 0, W, H, 'url(#bg)'));
  parts.push(rect(0, 0, W, H, 'url(#dots)'));
  parts.push(rect(0, 0, W, H, 'url(#glowTeal)'));
  parts.push(rect(0, 0, W, H, 'url(#glowBlue)'));

  // ── 左上角标签 ──
  parts.push(rrect(112, 96, 236, 36, 18, 'none', 'stroke="#2F6C86" stroke-width="1.4"'));
  parts.push(`<circle cx="134" cy="114" r="4.2" fill="#43C6EE"/>`);
  parts.push(text(152, 120, 'DEEPSEEK HARNESS PLUGIN', 14.5, '#9CC7DE', 'letter-spacing="2.1"'));

  // ── 主标题 ──
  parts.push(text(108, 300, 'dsh-remote-wsl', 104, 'url(#titleFade)', 'font-weight="700" letter-spacing="-2"'));

  // ── 副标题 ──
  parts.push(text(112, 374, '把 WSL 2 当作 DeepSeek Harness 的', 33, '#9FB3C4'));
  parts.push(text(112, 436, '远端执行宿主', 48, '#EAF1F8', 'font-weight="700"'));

  // ── 三枚特性胶囊 ──
  const chips = [
    { x: 112, w: 148, label: '持久会话' },
    { x: 276, w: 168, label: '跨宿主重连' },
    { x: 460, w: 196, label: '远程资源管理器' },
  ];
  for (const c of chips) {
    parts.push(rrect(c.x, 462, c.w, 46, 23, '#0B1423', 'stroke="#26405A" stroke-width="1.2"'));
    parts.push(text(c.x + c.w / 2, 492, c.label, 21, '#D7E3EC', 'text-anchor="middle"'));
  }

  // ── meta 行（版本由 package.json 注入）──
  parts.push(text(112, 556, `Windows 11 · WSL2 · DSH ${FACTS.dshBaseline} · 面板中英双语`, 18, '#5E697D'));

  // ── 底部一行（工具数由 tool-catalog 注入）──
  parts.push(text(112, 664, '关掉客户端 ≠ 会话结束', 22, '#57B6D8'));
  parts.push(text(470, 664, `${FACTS.toolCount} 个工具 · 常驻守护 · 版本对齐`, 20, '#7C8CA0'));

  // ── 右侧卡片 1/2 ──
  const card = (x: number, label: string, title: string, sub: string) => {
    parts.push(rrect(x, 116, 352, 142, 12, '#061A2B', 'stroke="#1E4460" stroke-width="1.2"'));
    parts.push(rect(x, 116, 3, 142, '#3FBFE8'));
    parts.push(`<circle cx="${x + 18}" cy="150" r="4.2" fill="#43C6EE"/>`);
    parts.push(text(x + 34, 156, label, 14, '#7FC4DE', 'letter-spacing="2.2"'));
    parts.push(text(x + 18, 202, title, 26, '#E8F1FA', 'font-weight="700"'));
    parts.push(text(x + 18, 232, sub, 15, '#7E93A6'));
  };
  card(1210, 'WINDOWS · DSH HOST', `面板 / ${FACTS.toolCountZh}个工具`, 'wsL.exe · 短命命令 · token 握手');
  card(1640, 'WSL2 · 常驻守护', 'SDK 运行时 / 文件世界', '每个 key+cwd 一个 · 关客户端仍在');

  // ── 卡片之间的箭头 ──
  parts.push(text(1568, 176, 'wsL.exe', 13, '#5F7C93'));
  parts.push('<path d="M1562 206 H1612" stroke="#3FBFE8" stroke-width="2" stroke-dasharray="6 5" fill="none"/>');
  parts.push('<path d="M1612 199 L1626 206 L1612 213 Z" fill="#3FBFE8"/>');

  // ── 连接虚线（卡片 → 终端卡）──
  parts.push('<path d="M1490 258 V308" stroke="#2E5E7A" stroke-width="1.4" stroke-dasharray="5 5"/>');
  parts.push('<path d="M1816 258 V308" stroke="#2E5E7A" stroke-width="1.4" stroke-dasharray="5 5"/>');

  // ── 终端卡 ──
  parts.push(rrect(1330, 308, 664, 200, 14, '#0D0C1B', 'stroke="#28405A" stroke-width="1.2"'));
  parts.push(`<circle cx="1362" cy="338" r="5" fill="#F26D6D"/><circle cx="1384" cy="338" r="5" fill="#F2C86D"/><circle cx="1406" cy="338" r="5" fill="#5FD08A"/>`);
  parts.push(text(1430, 343, 'key=rc1 · resident session', 14, '#8A93A6'));
  parts.push(
    text(1352, 402, '> wsL_agent task="记住数字 77"', 20, '#4FC3F7', '', MONO),
  );
  parts.push(text(1352, 444, '✓ 77 · sessionId kept · turns=2', 20, '#6BE39A', '', MONO));
  parts.push(text(1352, 482, 'daemon.8731.json · token 0600 · WSL 侧持有', 13, '#5A6B80'));

  // ── 右下角淡注释 ──
  parts.push(text(2060, 606, 'no remote-host flag required', 13, '#4C5A70', 'text-anchor="end"'));
  parts.push(text(2060, 628, 'versions pinned on both sides', 13, '#4C5A70', 'text-anchor="end"'));

  parts.push('</svg>');
  return parts.join('\n');
}

const svg = buildSvg();
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  const current = existsSync(SVG_PATH) ? readFileSync(SVG_PATH, 'utf8') : '';
  if (current !== svg) {
    console.error(
      'check:banner 失败 —— assets/banner.svg 与"按当前事实生成"的结果不一致。\n' +
        `事实：工具数=${FACTS.toolCount}（${FACTS.toolCountZh}）、DSH ${FACTS.dshBaseline}、插件 ${FACTS.version}\n` +
        '修法：node scripts/banner.ts --render（会重写 svg 并重新光栅化 webp），然后把两个文件一起提交。',
    );
    process.exit(1);
  }
  console.log(`check:banner PASS —— svg 与事实一致（${FACTS.toolCount} 个工具 / DSH ${FACTS.dshBaseline}）`);
} else {
  writeFileSync(SVG_PATH, svg, 'utf8');
  console.log(`wrote ${SVG_PATH} (${svg.length} bytes)`);
}

if (process.argv.includes('--render')) {
  // 1) Chromium 光栅化（ego-browser 已在用；只做像素，不做排版）
  const mjs = resolve(ROOT, 'scripts/rasterize-banner.mjs');
  // 注意：必须把整条命令拼成一个字符串走 shell —— 传 args 数组时 `-e` 里的 JS 会被吞掉引号，
  // 表现为 `await is not defined at [eval]:1`（2026-11-25 实测）。
  const egoCmd = `ego-browser nodejs -e "await import('${pathToFileURL(mjs).href}')"`;
  const r1 = spawnSync(egoCmd, { stdio: 'inherit', shell: true });
  if (r1.status !== 0) {
    console.error('banner: 光栅化失败（ego-browser）—— svg 已更新，webp 未更新');
    process.exit(r1.status ?? 1);
  }
  // 2) PNG → WebP（Pillow；尺寸对齐 2172×724）
  const py = process.env.DSH_PYTHON || 'python';
  const png = resolve(ROOT, '_banner.tmp.png');
  const code = [
    'from PIL import Image',
    `im = Image.open(r"${png}").convert("RGB")`,
    `im = im.resize((${W}, ${H}), Image.LANCZOS) if im.size != (${W}, ${H}) else im`,
    `im.save(r"${WEBP_PATH}", quality=95, method=6)`,
    `print("wrote ${WEBP_PATH.replace(/\\/g, '\\\\')}")`,
  ].join('\n');
  const r2 = spawnSync(py, ['-c', code], { stdio: 'inherit' });
  if (r2.status !== 0) {
    console.error('banner: PNG→WebP 失败（需要 Pillow：DSH_PYTHON 指向带 Pillow 的 python）');
    process.exit(r2.status ?? 1);
  }
}
