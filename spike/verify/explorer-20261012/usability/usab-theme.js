/* usab-theme.js —— M9：light/dark 下的**可读性**（token 解析 + 对比度），不只是"两张图不一样"。
 *
 * 用法：chrome-devtools-mcp evaluate_script 的 function 参数（原样粘贴）。
 *   返回 { before, after, toggled, distinguishable, contrast: {...} }，落盘 out-14-theme-<mode>.json
 *
 * 与 task-4 的 theme-probe.js 的差别（避免只做重复劳动）：
 *   - task-4 问"两模式是否可区分/token 是否有值"（功能面）；
 *   - 本探针问"文字与背景的**对比度**够不够看"（人面）。两条都要，但判据不同。
 * 诚实原则：找不到主题切换控件 => toggled=false、after=null，调用方记 unknown，不许当通过。
 */
async () => {
  const parseColor = (s) => {
    const m = (s || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some((n) => Number.isNaN(n))) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (fg, bg) => {
    if (!fg || !bg) return null;
    const a = lum(fg), b = lum(bg);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  // 沿祖先链找第一个不透明背景（模拟真实观感）
  const effectiveBg = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement.parentElement) {
      const c = parseColor(getComputedStyle(cur).backgroundColor);
      if (c && c.a >= 0.95) return c;
      cur = cur.parentElement;
    }
    const c = parseColor(getComputedStyle(document.body).backgroundColor);
    return c || { r: 255, g: 255, b: 255, a: 1 };
  };

  const TOKENS = [
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
    '--dsw-alias-state-idle-primary', '--dsw-alias-brand-primary', '--dsw-specific-sidebar-fill'
  ];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const panelRoot = () => document.querySelector('[data-dsh-remote-wsl="panel"]') || (() => {
    const cands = Array.from(document.querySelectorAll('div,section,aside,main')).filter(vis).filter((el) => el.getBoundingClientRect().left > 40);
    cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    return cands[0] || document.body;
  })();

  const sample = () => {
    const root = panelRoot();
    const cs = getComputedStyle(root);
    const html = getComputedStyle(document.documentElement);
    const tokens = {};
    const missing = [];
    for (const t of TOKENS) {
      const v = cs.getPropertyValue(t).trim() || html.getPropertyValue(t).trim();
      tokens[t] = v;
      if (!v) missing.push(t);
    }
    // 逐类取样文本元素的对比度（这是"看得清吗"的直接证据）
    const targets = [];
    const add = (name, el) => {
      if (!el || !vis(el)) return;
      const fg = parseColor(getComputedStyle(el).color);
      const bg = effectiveBg(el);
      targets.push({ name, text: ((el.innerText || '') + '').replace(/\s+/g, ' ').trim().slice(0, 60), fg: getComputedStyle(el).color, bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`, contrast: ratio(fg, bg) });
    };
    add('title', root.querySelector('.dsh-rw-title'));
    add('subtitle', root.querySelector('.dsh-rw-subtitle'));
    add('distro-row', root.querySelector('.dsh-rw-distro-row'));
    add('badge', root.querySelector('.dsh-rw-badge'));
    add('workspace-label', root.querySelector('.dsh-rw-workspace-label'));
    add('workspace-path', root.querySelector('.dsh-rw-workspace-path'));
    add('action-link', root.querySelector('.dsh-rw-link'));
    add('status-text', root.querySelector('.dsh-rw-status-text'));
    add('hint', root.querySelector('.dsh-rw-hint'));
    add('empty', root.querySelector('.dsh-rw-empty'));
    add('error-title', root.querySelector('.dsh-rw-error-title'));

    return {
      at: new Date().toISOString(),
      theme: document.documentElement.getAttribute('data-theme') || document.documentElement.className || null,
      colorScheme: html.colorScheme,
      panelRoot: { tag: root.tagName.toLowerCase(), cls: String(root.className).slice(0, 160) },
      computed: { background: getComputedStyle(root).backgroundColor, color: getComputedStyle(root).color, fontSize: getComputedStyle(root).fontSize },
      tokens,
      tokensMissing: missing,
      contrast: targets,
      // WCAG：正文 ≥4.5 合格，大字/次要信息 ≥3 可接受；低于 3 一律记缺陷
      contrastBelow3: targets.filter((t) => t.contrast !== null && t.contrast < 3),
      contrastBelow45: targets.filter((t) => t.contrast !== null && t.contrast < 4.5)
    };
  };

  const before = sample();

  const cands = Array.from(document.querySelectorAll('button,[role="button"],[role="switch"],[role="menuitem"],a[href]'))
    .filter(vis)
    .map((el) => ({
      el,
      label: [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').trim().slice(0, 40)].filter(Boolean).join(' | '),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      pressed: el.getAttribute('aria-pressed') || el.getAttribute('aria-checked')
    }))
    .filter((c) => /theme|主题|深色|浅色|dark|light|外观|appearance/i.test(c.label));

  if (!cands.length) {
    return { before, after: null, toggled: false, toggleCand: null, distinguishable: null, reason: 'NO_TOGGLE_FOUND' };
  }
  const pick = cands[0];
  pick.el.click();
  const deadline = Date.now() + 2500;
  let after = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const s = sample();
    if (s.colorScheme !== before.colorScheme || s.computed.background !== before.computed.background) { after = s; break; }
  }
  if (!after) after = sample();
  const distinguishable = after.colorScheme !== before.colorScheme || after.computed.background !== before.computed.background;
  return {
    before,
    after,
    toggled: true,
    toggleCand: { label: pick.label, rect: pick.rect, pressed: pick.pressed, total: cands.length },
    distinguishable,
    reason: distinguishable ? 'OK' : 'TOGGLED_BUT_INDISTINGUISHABLE',
    tokensMissing: { before: before.tokensMissing, after: after.tokensMissing },
    contrastBelow3: { before: before.contrastBelow3, after: after.contrastBelow3 }
  };
}
