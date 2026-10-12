/* extract-dsh-rw.js —— 针对**实测 DOM 契约**的精确抽取器（A1/A2/A3/A5/⑥ 的渲染面证据）。
 *
 * 实测（2026-10-12，frozen rev cc5a610f9149）：
 *   · 侧栏 panel 列表：`button.<hash>_panelRow`，aria-label = {插件, 远程资源管理器}；选中项 aria-current="page"
 *   · 面板根 `.dsh-rw-root`：`.dsh-rw-title` / `.dsh-rw-distro-row` / `.dsh-rw-distro-name` / `.dsh-rw-badge`
 *     / `.dsh-rw-workspace`(`-label`,`-path`) / `.dsh-rw-status-text` / `.dsh-rw-raw`
 *   · 状态条文本形态：`daemon slot 8932 · :8932 · pid 899039 · 0.2.0-rc.2 · keys 0`
 * 类名带构建哈希前缀 ⇒ 一律**按后缀匹配**（panelRow / dsh-rw-*），不用整串。
 * 诚实原则：抽不到就 null（比较器判 unknown），绝不猜。
 */
() => {
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const txt = el => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null);
  const one = sel => document.querySelector(sel);
  const anySuffix = suf => Array.from(document.querySelectorAll('*')).filter(el => (el.className || '').toString().split(/\s+/).some(c => c.endsWith(suf)));

  const rail = anySuffix('_panelRow').filter(vis).map((el, i) => ({
    index: i,
    ariaLabel: el.getAttribute('aria-label'),
    ariaCurrent: el.getAttribute('aria-current'),
    text: txt(el),
    y: Math.round(el.getBoundingClientRect().y)
  })).sort((a, b) => a.y - b.y);

  const root = one('.dsh-rw-root');
  const out = {
    schema: 'dsh-rw-extract/1',
    capturedAt: new Date().toISOString(),
    url: location.href,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    railItems: rail,
    railLabelsInOrder: rail.map(x => x.ariaLabel),
    panelPresent: !!root,
    activeRailItem: rail.filter(x => x.ariaCurrent === 'page').map(x => x.ariaLabel),
    railHasOurEntry: rail.some(x => x.ariaLabel === '远程资源管理器'),
    panelTitle: txt(one('.dsh-rw-title')),
    panelSubtitle: txt(one('.dsh-rw-subtitle')),
    rows: null,
    statusBar: null,
    webHosts: null,
    sameSourceClaim: false,
    rawSnapshotShown: txt(one('.dsh-rw-raw')),
    rawText: ''
  };
  if (!root) return out;

  out.rawText = ['.dsh-rw-header', '.dsh-rw-body', '.dsh-rw-status']
    .map(s => txt(one(s))).filter(Boolean).join(' \n ');
  out.sameSourceClaim = /同源/.test(out.rawText || '');

  // 行：distro（名字 + 徽标）与 workspace（label + path）；抓不到就保持 null
  const dRows = Array.from(document.querySelectorAll('.dsh-rw-distro-row')).filter(vis);
  const wRows = Array.from(document.querySelectorAll('.dsh-rw-workspace')).filter(vis);
  if (dRows.length || wRows.length) {
    out.rows = [];
    for (const r of dRows) {
      const name = txt(r.querySelector('.dsh-rw-distro-name'));
      const badges = Array.from(r.querySelectorAll('.dsh-rw-badge')).map(b => txt(b)).filter(Boolean);
      out.rows.push({ kind: 'distro', name: name || null, default: badges.some(b => /默认/.test(b)), reachable: badges.some(b => /运行中|可达/.test(b)), badges, text: txt(r) });
    }
    for (const r of wRows) {
      out.rows.push({ kind: 'workspace', label: txt(r.querySelector('.dsh-rw-workspace-label')), path: txt(r.querySelector('.dsh-rw-workspace-path')), distro: null, text: txt(r) });
    }
  }

  // 状态条：`daemon slot 8932 · :8932 · pid 899039 · 0.2.0-rc.2 · keys 0`
  const st = txt(one('.dsh-rw-status-text'));
  if (st) {
    const mSlot = st.match(/slot\s+(\d+)/i), mPort = st.match(/:(\d{3,5})\b/), mPid = st.match(/pid\s+(\d+)/i), mVer = st.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/), mKeys = st.match(/keys\s+(\d+)/i);
    out.statusBar = {
      line: st,
      pid: mPid ? Number(mPid[1]) : null,
      port: mPort ? Number(mPort[1]) : null,
      slot: mSlot ? Number(mSlot[1]) : null,
      version: mVer ? mVer[1] : null,
      keys: mKeys ? Number(mKeys[1]) : null,
      keysDetail: [],
      drift: null
    };
  }
  const urls = Array.from((out.rawText || '').matchAll(/https?:\/\/127\.0\.0\.1:(\d{2,5})\b/g)).map(m => Number(m[1]));
  out.webHosts = urls.length ? Array.from(new Set(urls)).map(p => ({ port: p })) : [];
  return out;
}
