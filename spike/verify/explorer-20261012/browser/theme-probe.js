/* theme-probe.js —— 验收④「主题 light/dark 各一次正常（token 双份）」。
 *
 * 采样面（不依赖 class 名）：
 *   - html 的 colorScheme / data-theme / class
 *   - 面板根（最右最宽的可见容器）的实际计算色
 *   - 面板显式声明的 CSS 变量（--dsw-*）在**当前模式**下的解析值
 *
 * 做法：先采样一次 → 找一个真实的主题控件点它 → 轮询直到 colorScheme/背景色变化 → 再采样。
 *      找不到真实控件 => 不切、返回 toggled=false（调用方必须记 unknown，不许当通过）。
 *
 * 返回：{ before:{...}, after:{...}|null, toggled:boolean, toggleCand:null|{...}, distinguishable:boolean|null, tokensMissing:{before:[],after:[]} }
 */
async () => {
  const CS = ['color-scheme', 'background-color', 'color', 'border-top-color'];
  const TOKENS = [
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2',
    '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-specific-sidebar-fill'
  ];
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 100 && r.height > 100 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const panelRoot = () => {
    const cands = Array.from(document.querySelectorAll('div,section,aside,main')).filter(vis).filter((el) => el.getBoundingClientRect().left > 40);
    cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    return cands[0] || document.body;
  };
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
    return {
      at: new Date().toISOString(),
      htmlClass: document.documentElement.className || null,
      dataTheme: document.documentElement.getAttribute('data-theme'),
      colorScheme: html.colorScheme,
      panelRoot: { tag: root.tagName.toLowerCase(), cls: (root.className || '').toString().slice(0, 160) },
      computed: Object.fromEntries(CS.map((k) => [k, cs.getPropertyValue(k).trim()])),
      tokens,
      tokensMissing: missing
    };
  };
  const before = sample();

  // 找真实主题控件：aria-label/title/文本命中主题词，且不是我们的面板
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
  const toggleCand = { label: pick.label, rect: pick.rect, pressed: pick.pressed, total: cands.length };
  pick.el.click();

  const deadline = Date.now() + 2500;
  let after = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const s = sample();
    if (s.colorScheme !== before.colorScheme || s.computed['background-color'] !== before.computed['background-color']) { after = s; break; }
  }
  if (!after) after = sample();
  const distinguishable =
    after.colorScheme !== before.colorScheme || after.computed['background-color'] !== before.computed['background-color'];
  return {
    before, after, toggled: true, toggleCand, distinguishable,
    reason: distinguishable ? 'OK' : 'TOGGLED_BUT_INDISTINGUISHABLE',
    tokensMissing: { before: before.tokensMissing, after: after.tokensMissing }
  };
}
