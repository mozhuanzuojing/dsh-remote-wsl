/* measure-t42.js —— T42 六条修法的**浏览器内读数**（before/after 用同一份脚本，保证口径一致）。
 *
 * 用法（页面内，经 8925 的静态服务器取回后调用）：
 *   const fn = eval(get('measure-t42.js')); return await fn({ width: 320 });
 *
 * 只读：不点任何会写存储的动作（「添加为 WSL 工作区」**只数可见入口，不点**）。
 */
async ({ width = 0, serve = 'http://127.0.0.1:8925' } = {}) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = () => document.querySelector('[data-dsh-remote-wsl="panel"]');
  const q = (s) => Array.from(panel() ? panel().querySelectorAll(s) : []);
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, x: Math.round(r.x), y: Math.round(r.y) }; };

  // 相对亮度 / 对比度（WCAG）
  const lum = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (fg, bg) => {
    const a = lum(fg), b = lum(bg);
    if (a === null || b === null) return null;
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const effBg = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const bg = cs.backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return bg;
      n = n.parentElement;
    }
    return getComputedStyle(document.documentElement).backgroundColor || 'rgb(255,255,255)';
  };

  // 夹具：按 mode 控制 /remote-wsl/api
  const orig = window.fetch.bind(window);
  let mode = 'real';
  const snap = (running) => ({ ok: true, result: {
    distros: [{ name: 'debian-u8-1', default: true, reachable: true }],
    target: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g' },
    daemon: { running, slot: 8929, pid: running ? 4242 : undefined, port: 8929, version: '0.2.0-rc.2', keys: [], orphans: 0, others: [] },
    drift: { drifted: false }, workspaces: [], webHosts: [] } });
  window.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (mode === 'real' || !/remote-wsl\/api/.test(u)) return orig(input, init);
    let method = null;
    try { method = JSON.parse((init && init.body) || '{}').method; } catch {}
    if (mode === 'loading') return new Promise(() => {});
    if (method === 'explorer.listDir') {
      if (mode === 'listfail') return new Response(JSON.stringify({ ok: false, error: 'ENOENT: no such file or directory, scandir \\\\wsl.localhost\\debian-u8-1\\home\\g\\nope (ENOENT)' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, result: { path: '/home/g', entries: [{ name: 'proj', path: '/home/g/proj', kind: 'dir' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (mode === 'running') return new Response(JSON.stringify(snap(true)), { status: 200, headers: { 'content-type': 'application/json' } });
    if (mode === 'stopped') return new Response(JSON.stringify(snap(false)), { status: 200, headers: { 'content-type': 'application/json' } });
    if (mode === 'listfail') return new Response(JSON.stringify(snap(false)), { status: 200, headers: { 'content-type': 'application/json' } });
    return orig(input, init);
  };

  const remount = async (m, ms = 1800) => {
    mode = m;
    // ★ 320px 下 rail 是**图标态**（innerText 为空）⇒ 必须把 aria-label/title 一起纳入匹配，否则找不到自己的行。
    const nameOf = (b) => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim();
    const rows = () => Array.from(document.querySelectorAll('[class*="panelList"] button'));
    const ours = rows().find((b) => /远程资源管理器|remote-wsl/i.test(nameOf(b)));
    const other = rows().find((b) => !/远程资源管理器|remote-wsl/i.test(nameOf(b)));
    if (other) other.click();
    await sleep(400);
    if (ours) ours.click();
    await sleep(ms);
  };

  // ★ 首轮实测踩到：fresh 页面 rail 还没挂出来 ⇒ 全部读数 null。这里先等 rail（最多 30s），
  //   并在每次 remount 后确认面板真的在 DOM 里。
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !document.querySelector('[class*="panelList"] button')) await sleep(400);
  }
  const out = { url: location.href, theme: { attr: document.documentElement.getAttribute('data-theme') || null, colorScheme: getComputedStyle(document.documentElement).colorScheme }, width: window.innerWidth };

  // ── 先在"运行中"态取底栏/命中区/状态点 ──
  await remount('running', 2000);
  out.footerH = (() => { const f = panel() && panel().querySelector('.dsh-rw-status'); return f ? rectOf(f).h : null; })();
  out.statusText = (() => { const s = panel() && panel().querySelector('.dsh-rw-status'); return s ? s.innerText.replace(/\n+/g, ' | ') : null; })();
  const dotRunning = (() => { const d = panel() && panel().querySelector('.dsh-rw-dot'); return d ? rectOf(d) : null; })();
  // 命中区（V1）：可见、未 disabled 的交互元素
  const interactive = q('button,[role="button"],a[href],label').filter((el) => vis(el) && el.disabled !== true && el.getAttribute('aria-disabled') !== 'true');
  const small = interactive.map((el) => ({ cls: (el.className || '').toString().split(' ')[0] || el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 24), ...rectOf(el) })).filter((r) => r.w < 24 || r.h < 24);
  out.V1 = { interactiveCount: interactive.length, violating: small, violations: small.length, minW: Math.min(...interactive.map((e) => rectOf(e).w)), minH: Math.min(...interactive.map((e) => rectOf(e).h)) };
  // 相邻净距（现状 18，别弄坏）
  const inRow = interactive.map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.width > 0).sort((a, b) => a.r.x - b.r.x);
  let minGap = Infinity;
  for (let i = 1; i < inRow.length; i++) if (Math.abs(inRow[i].r.y - inRow[i - 1].r.y) < 4) minGap = Math.min(minGap, Math.round((inRow[i].r.x - (inRow[i - 1].r.x + inRow[i - 1].r.width)) * 100) / 100);
  out.adjacentGap = minGap === Infinity ? null : minGap;
  // 行高（列表行 ≥32）
  out.rowHeights = q('.dsh-rw-recent-row,.dsh-rw-entry,.dsh-rw-workspace').map((el) => rectOf(el).h).slice(0, 6);

  // 停止态：状态点外径（与运行态比较）
  await remount('stopped', 2000);
  const dotStopped = (() => { const d = panel() && panel().querySelector('.dsh-rw-dot'); return d ? rectOf(d) : null; })();
  out.dot = { running: dotRunning, stopped: dotStopped, equalOuter: dotRunning && dotStopped ? dotRunning.w === dotStopped.w && dotRunning.h === dotStopped.h : null };

  // ── N1：窄宽度下「添加为 WSL 工作区」可见入口计数（只数，不点） ──
  const countAddWs = () => {
    // ★ 首轮实测踩到：aria-label 里放的是**译文**不是 i18n 键 ⇒ 必须同时匹配中英译文。
    const addWsRe = /添加为 WSL 工作区|添加为工作区|Add as WSL workspace|Add workspace/i;
    const inHeader = q('button').filter((b) => vis(b) && addWsRe.test(((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.innerText || ''))));
    return { header: inHeader.length, headerLabels: inHeader.map((b) => ((b.innerText || '').trim() || (b.getAttribute('title') || '')).slice(0, 22)), total: inHeader.length };
  };
  out.N1 = { narrow: null };
  // 打开 ⋯ 菜单后计数（菜单项在 DOM 里只有在开时才有）
  const moreBtn = q('.dsh-rw-iconbtn').find((b) => /menu.more|更多/.test((b.getAttribute('aria-label') || '')));
  if (moreBtn) { moreBtn.click(); await sleep(400); }
  const menuAddWs = q('.dsh-rw-menuitem').filter((b) => vis(b) && /添加为 WSL 工作区|添加为工作区|Add as WSL workspace|Add workspace/i.test(b.innerText || ''));
  const menuGroups = q('.dsh-rw-group').map((g) => {
    const lb = g.getAttribute('aria-labelledby');
    const el = lb ? document.getElementById(lb) : null;
    return { role: g.getAttribute('role'), ariaLabelledby: lb, labelText: el ? (el.innerText || '').trim() : null, labelRole: el ? el.getAttribute('role') : null, labelTabIndex: el ? el.getAttribute('tabindex') : null, labelColor: el ? getComputedStyle(el).color : null, labelContrast: el ? contrast(getComputedStyle(el).color, effBg(el)) : null };
  });
  out.N4 = { groupCount: menuGroups.length, groups: menuGroups };
  out.N1 = { menuAddWsCount: menuAddWs.length, menuAddWsLabels: menuAddWs.map((b) => (b.innerText || '').trim().slice(0, 22)), totalVisibleAddWs: countAddWs().header + menuAddWs.length };
  if (moreBtn) { document.body.click(); await sleep(250); }

  // ── N5：加载态底栏分隔符计数 ──
  await remount('loading', 2200);
  const statusTextLoading = (() => { const s = panel() && panel().querySelector('.dsh-rw-status'); return s ? s.innerText.replace(/\n+/g, ' ') : null; })();
  out.N5 = { footerText: statusTextLoading, separatorCount: statusTextLoading ? (statusTextLoading.match(/·/g) || []).length : null };

  // ── N3：列目录失败（主句 + host 原文去处） ──
  await remount('listfail', 2200);
  const errBlock = panel() && panel().querySelector('.dsh-rw-error');
  out.N3 = errBlock ? {
    mainSentence: (errBlock.querySelector('.dsh-rw-error-title') || {}).innerText || null,
    inlineBody: errBlock.querySelector('.dsh-rw-error-body') ? errBlock.querySelector('.dsh-rw-error-body').innerText.slice(0, 60) : null,
    hasFold: !!errBlock.querySelector('details'),
    foldSummary: errBlock.querySelector('details summary') ? errBlock.querySelector('details summary').innerText.trim() : null,
    foldTextHead: errBlock.querySelector('details pre') ? errBlock.querySelector('details pre').innerText.slice(0, 70) : null,
    foldOpen: errBlock.querySelector('details') ? errBlock.querySelector('details').open : null,
    rawVisibleWithoutOpening: errBlock.querySelector('details') ? null : (errBlock.innerText.match(/wsl\.localhost|ENOENT/g) || []).length
  } : { error: 'no .dsh-rw-error block' };

  // 复位
  mode = 'real'; window.fetch = orig;
  await remount('real', 1600);
  out.restored = (() => { const s = panel() && panel().querySelector('.dsh-rw-status'); return s ? s.innerText.replace(/\n+/g, ' | ') : null; })();
  return out;
}
