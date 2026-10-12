/* click-rail-icon.js —— 点侧栏 rail 上的目标图标（走 MCP 的可信输入优先；本文件是"定位 + 兜底 DOM click"）。
 *
 * 用法：先设置 needle（两种驱动都支持）：
 *   chrome-devtools-mcp: evaluate_script(() => { window.__probeNeedle = '远程资源管理器'; return true; })
 *   cua page:            execute_javascript  'window.__probeNeedle = "远程资源管理器"; true'
 * 然后执行本文件（箭头函数表达式 / IIFE）。
 *
 * 返回：{ found, needle, matched:[...], clicked:boolean, rect|null }
 * 纪律：优先把 rect 交给驱动做**可信输入**点击（Input.dispatchMouseEvent）；只有驱动不可用时才用 el.click()，
 *       并在报告里注明用的是 DOM click（证明的是派发，不是控件激活）。
 */
() => {
  const needle = window.__probeNeedle || '远程资源管理器';
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const matches = [];
  for (const el of Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],[role="listitem"],a[href]')).filter(vis)) {
    const r = el.getBoundingClientRect();
    if (!(r.left < 96 && r.width <= 96 && r.height <= 96)) continue;
    const label = [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').trim()].filter(Boolean).join(' | ');
    if (label.includes(needle)) {
      matches.push({
        el,
        label,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        ariaPressed: el.getAttribute('aria-pressed'),
        cls: (el.className || '').toString().slice(0, 120)
      });
    }
  }
  if (!matches.length) return { found: false, needle, matched: [], clicked: false, rect: null };
  const m = matches[0];
  const cx = m.rect.x + m.rect.w / 2, cy = m.rect.y + m.rect.h / 2;
  m.el.click(); // 兜底；调用方应优先用 rect 做可信输入点击
  return {
    found: true, needle,
    matched: matches.map((x) => x.label),
    clicked: true,
    rect: m.rect,
    clickPoint: { x: Math.round(cx), y: Math.round(cy) },
    ariaPressedBefore: m.ariaPressed,
    via: 'dom_event_fallback'
  };
}
