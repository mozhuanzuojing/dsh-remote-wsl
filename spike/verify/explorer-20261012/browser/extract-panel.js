/* extract-panel.js —— 浏览器内抽取（验收①②③⑤的**渲染面**证据）。
 *
 * 用法：整份文件是一个箭头函数表达式，可直接喂给：
 *   - chrome-devtools-mcp evaluate_script 的 `function` 参数（原样粘贴）
 *   - cua_driver_native page execute_javascript：`(${文件内容})()`
 *   输出 JSON 存为 out-07-panel-extract-<theme>.json
 *
 * 诚实原则：**抓不到就 null**。null 在比较器里 = unknown，绝不当通过。
 * 现阶段 T3 的 DOM 契约未知，故本抽取器只用"角色/位置/文本"这类通用信号；
 * 实盘若拿不到结构，就把 treeItems/rawText 落盘后据此细化再重跑（会记录在报告里）。
 */
() => {
  const out = {
    schema: 'panel-extract/1',
    capturedAt: new Date().toISOString(),
    url: location.href,
    theme: document.documentElement.getAttribute('data-theme') || document.documentElement.className || null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    railItems: [],
    railCount: 0,
    railText: '',
    activeRailItem: null,
    treeItems: null,
    rows: null,
    statusBar: null,
    webHosts: null,
    parseConfidence: 'low',
    domHints: {},
    rawText: ''
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const all = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis);
  const attrs = (el, pre) =>
    Object.fromEntries(
      Array.from(el.attributes || []).filter((a) => a.name.startsWith(pre)).map((a) => [a.name, a.value.slice(0, 120)])
    );

  // ---- 1) 侧栏 rail：最左一列的可点元素（不依赖 class 名） ----
  const rail = [];
  for (const el of all('button,[role="button"],[role="tab"],[role="listitem"],a[href]')) {
    const r = el.getBoundingClientRect();
    if (r.left < 96 && r.width <= 96 && r.height <= 96) {
      rail.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        text: (el.innerText || '').trim().slice(0, 120),
        ariaPressed: el.getAttribute('aria-pressed'),
        ariaCurrent: el.getAttribute('aria-current'),
        data: attrs(el, 'data-'),
        cls: (el.className || '').toString().slice(0, 200),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      });
    }
  }
  rail.sort((a, b) => a.rect.y - b.rect.y);
  out.railItems = rail;
  out.railCount = rail.length;
  out.railText = rail.map((x) => [x.ariaLabel, x.title, x.text].filter(Boolean).join(' ')).join(' | ');
  const active = rail.filter(
    (x) => x.ariaPressed === 'true' || x.ariaCurrent === 'true' || /active|selected|current/.test(x.cls)
  );
  out.activeRailItem = active.length ? active.map((x) => [x.ariaLabel, x.title, x.text].filter(Boolean).join(' ')) : null;

  // ---- 2) 主区域文本 ----
  const main = document.querySelector('main,[role="main"]') || document.body;
  out.rawText = (main.innerText || '').replace(/\r/g, '').slice(0, 24000);

  // ---- 3) 树（角色优先；拿不到 => null） ----
  const tree = all('[role="treeitem"],[role="option"],[role="row"]');
  if (tree.length) {
    out.treeItems = tree.map((el) => ({
      role: el.getAttribute('role'),
      ariaLevel: el.getAttribute('aria-level'),
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaSelected: el.getAttribute('aria-selected'),
      text: (el.innerText || '').trim().slice(0, 200),
      data: attrs(el, 'data-'),
      cls: (el.className || '').toString().slice(0, 160),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()
    })).sort((a, b) => a.rect.y - b.rect.y);
    out.domHints.treeSelector = '[role="treeitem"],[role="option"],[role="row"]';
  }

  // ---- 4) 状态条 / drift（从主区域文本正则；置信度低 => 保持 null） ----
  const lines = out.rawText.split('\n').map((s) => s.trim()).filter(Boolean);
  const daemonLine = lines.find((l) => /daemon/i.test(l) && /\d/.test(l)) || null;
  const pidM = daemonLine && daemonLine.match(/daemon[^\d]{0,8}(\d{2,7})/i);
  const portM = daemonLine && daemonLine.match(/(?:port|:)\s*(\d{3,5})\b/);
  const verM = daemonLine && daemonLine.match(/v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  const keysM = out.rawText.match(/keys?\s*[:=]?\s*(\d+)/i);
  const driftLine = lines.find((l) => /drift/i.test(l)) || null;
  const desktopM = out.rawText.match(/desktop\s*[=:]\s*([\w.\-]+)/i);
  const pinM = out.rawText.match(/pin\s*[=:]\s*([\w.\-]+)/i);
  if (pidM || portM || keysM || driftLine) {
    out.statusBar = {
      line: daemonLine,
      pid: pidM ? Number(pidM[1]) : null,
      port: portM ? Number(portM[1]) : null,
      version: verM ? verM[1] : null,
      keys: keysM ? Number(keysM[1]) : null,
      keysDetail: null,
      drift: { line: driftLine, drifted: driftLine ? /⚠|warn|yes|漂移|drift(?!\s*[:=]?\s*(no|none|false))/i.test(driftLine) : null, desktop: desktopM ? desktopM[1] : null, pin: pinM ? pinM[1] : null }
    };
    out.parseConfidence = 'medium';
  }
  const urls = Array.from(out.rawText.matchAll(/https?:\/\/127\.0\.0\.1:(\d{2,5})\b/g)).map((m) => Number(m[1]));
  if (urls.length) out.webHosts = Array.from(new Set(urls)).map((p) => ({ port: p }));
  out.domHints.mainSelector = main === document.body ? 'body(fallback)' : (main.tagName.toLowerCase() + (main.id ? '#' + main.id : ''));
  out.domHints.panelRootGuess = (() => {
    // 最右、最宽、且可见的容器（面板）——仅作提示，不作判据
    const cands = all('div,section,aside').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 260 && r.height > 200 && r.left > 40;
    });
    cands.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    if (!cands.length) return null;
    const el = cands[0]; const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 160), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  })();

  // rows 只在能明确区分 distro / workspace 时才给；否则 null（=> unknown，绝不当通过）
  out.rows = null;
  return out;
}
