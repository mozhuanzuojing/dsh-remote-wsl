/* n4-readings.js —— T53：读 ⋯ 菜单**三组**的标注属性（作用域限定到 `.dsh-rw-menu`，这正是 T50 判红的根因所在）。
 *
 * T50 的复验把**整个面板**里的 `[role=group]` 一起枚举，于是把「chips 工具条」
 * （`browser.js`：`{className:"dsh-rw-toolbar", role:"group", "aria-label": t("browser.chipsAria")}`，
 * 文本 = `Home / /mnt`）当成了"菜单第 1 组" ⇒ 误判"第 1 组用 aria-label"。
 * 本脚本**同时**输出「菜单组」与「面板里其它 role=group」两类，好让断言能把两者分开。
 */
async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = () => document.querySelector('[data-dsh-remote-wsl="panel"]');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

  // 等 rail（320 窄态是图标态 ⇒ innerText 为空，必须连 aria-label/title 一起匹配）
  const nameOf = (b) => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim();
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !document.querySelector('[class*="panelList"] button')) await sleep(400);
  }

  // 夹具：target.cwd=/home/g，listDir 返回子目录 ⇒ 点进去后 cwd≠target ⇒ primaryIsSession=true ⇒ 窄态出现「工作区」组（三组齐全）
  const orig = window.fetch.bind(window);
  let mode = 'fixture';
  const snap = { ok: true, result: {
    distros: [{ name: 'debian-u8-1', default: true, reachable: true }],
    target: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g' },
    daemon: { running: true, slot: 8929, pid: 4242, port: 8929, version: '0.2.0-rc.2', keys: [], orphans: 0, others: [] },
    drift: { drifted: false }, workspaces: [], webHosts: [] } };
  window.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    if (mode === 'real' || !/remote-wsl\/api/.test(u)) return orig(input, init);
    let method = null;
    try { method = JSON.parse((init && init.body) || '{}').method; } catch {}
    if (method === 'explorer.listDir') return new Response(JSON.stringify({ ok: true, result: { path: '/home/g', entries: [{ name: 'proj', path: '/home/g/proj', kind: 'dir' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(snap), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const remount = async (ms = 2000) => {
    const rows = () => Array.from(document.querySelectorAll('[class*="panelList"] button'));
    const ours = rows().find((b) => /远程资源管理器|remote-wsl/i.test(nameOf(b)));
    const other = rows().find((b) => !/远程资源管理器|remote-wsl/i.test(nameOf(b)));
    if (other) other.click(); await sleep(400);
    if (ours) ours.click(); await sleep(ms);
  };
  await remount(2200);

  // 进入子目录（让 cwd ≠ target）——只点「进入」行内动作，不碰任何写存储的动作
  const enterBtn = Array.from(panel() ? panel().querySelectorAll('button') : []).find((b) => /进入|open|进入目录/i.test(nameOf(b)));
  if (enterBtn) { enterBtn.click(); await sleep(1800); }
  const entered = { cwdText: (() => { const c = panel() && panel().querySelector('.dsh-rw-cwd, .dsh-rw-path, .dsh-rw-crumb--current'); return c ? (c.innerText || '').trim() : null; })(), clicked: !!enterBtn };

  // 打开 ⋯ 菜单
  const moreBtn = Array.from(panel() ? panel().querySelectorAll('.dsh-rw-iconbtn') : []).find((b) => /更多|more/i.test(nameOf(b)));
  if (moreBtn) { moreBtn.click(); await sleep(500); }

  const describe = (g) => {
    const lb = g.getAttribute('aria-labelledby');
    const target = lb ? document.getElementById(lb) : null;
    return {
      role: g.getAttribute('role'),
      ariaLabelledby: lb,
      ariaLabel: g.getAttribute('aria-label'),
      labelTargetExists: lb ? !!target : null,
      labelTargetText: target ? (target.innerText || '').trim() : null,
      labelTargetRole: target ? target.getAttribute('role') : null,
      labelTargetTabIndexAttr: target ? target.getAttribute('tabindex') : null,
      labelTargetTabIndexProp: target ? target.tabIndex : null,
      labelTargetVisible: target ? target.getBoundingClientRect().width > 0 : null,
      groupText: (g.innerText || '').replace(/\n+/g, ' ').trim().slice(0, 60),
      rect: rect(g)
    };
  };
  const scopedMenuGroups = Array.from(document.querySelectorAll('[data-dsh-remote-wsl="panel"] .dsh-rw-menu .dsh-rw-group')).map(describe);
  const otherRoleGroups = Array.from(document.querySelectorAll('[data-dsh-remote-wsl="panel"] [role="group"]'))
    .filter((g) => !g.classList.contains('dsh-rw-group'))
    .map((g) => ({ cls: (g.className || '').toString(), role: g.getAttribute('role'), ariaLabel: g.getAttribute('aria-label'), ariaLabelledby: g.getAttribute('aria-labelledby'), text: (g.innerText || '').replace(/\n+/g, ' ').trim().slice(0, 40), rect: rect(g) }));

  // 组标题是否可聚焦：试 focus() 后看是否真的拿到焦点
  const titleFocus = scopedMenuGroups.map((g) => {
    const lb = g.ariaLabelledby; const el = lb ? document.getElementById(lb) : null;
    if (!el) return null;
    const before = document.activeElement;
    el.focus();
    const took = document.activeElement === el;
    if (before && before.focus) before.focus();
    return { id: lb, tookFocus: took, tabIndexProp: el.tabIndex, tabIndexAttr: el.getAttribute('tabindex') };
  });

  // 菜单是否遮底栏状态词
  const menuEl = panel() && panel().querySelector('.dsh-rw-menu');
  const statusWordEl = panel() && panel().querySelector('.dsh-rw-statusword');
  const footerEl = panel() && panel().querySelector('.dsh-rw-status');
  const geom = {
    menu: menuEl ? rect(menuEl) : null,
    statusWord: statusWordEl ? rect(statusWordEl) : null,
    footer: footerEl ? rect(footerEl) : null,
    menuOverlapsStatusWord: menuEl && statusWordEl ? overlap(rect(menuEl), rect(statusWordEl)) : null,
    menuOverlapsFooter: menuEl && footerEl ? overlap(rect(menuEl), rect(footerEl)) : null
  };

  // 关菜单 + 复位夹具
  if (moreBtn) { document.body.click(); await sleep(300); }
  mode = 'real'; window.fetch = orig;

  return {
    width: window.innerWidth,
    entered,
    moreFound: !!moreBtn,
    menuGroupCount: scopedMenuGroups.length,
    scopedMenuGroups,
    titleFocus,
    otherRoleGroups,
    geom,
    ts: new Date().toISOString()
  };
}
