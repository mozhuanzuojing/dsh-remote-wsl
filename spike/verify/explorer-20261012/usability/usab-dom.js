/* usab-dom.js —— 可用性评估的**控件级**抽取器（M2/M3/M4/M6/M7/M8/M10 的证据来源）。
 *
 * 用法：整份文件是一个箭头函数表达式，可直接喂给：
 *   - chrome-devtools-mcp evaluate_script 的 `function` 参数（原样粘贴；`filePath` 落盘）
 *   - cua_driver_native page execute_javascript：`(${文件内容})()`
 *   输出 JSON 存为 out-12-dom-controls.json（另见 out-13-states.json 由本文件 states 段拆出）。
 *
 * 诚实原则：**抓不到就 null**；null = unknown，绝不当通过。
 * 不依赖被验实现的 class 名做唯一判据：class 只作提示，主判据是「可见文本 / aria / 位置 / 角色」。
 */
() => {
  const out = {
    schema: 'usab-dom/1',
    capturedAt: new Date().toISOString(),
    url: location.href,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    theme: document.documentElement.getAttribute('data-theme') || document.documentElement.className || null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,

    // —— 侧栏 rail（M2/D1：图标可辨识性）——
    rail: { items: null, count: null, active: null, unnamed: null },

    // —— 面板本体 ——
    panel: { present: null, rootRect: null, title: null, subtitle: null },

    // —— 控件级全量清单（M2/M3/M6）——
    controls: null,
    controlsSummary: null,

    // —— hover-only（title-only）控件（M2）——
    titleOnlyControls: null,

    // —— 术语暴露（M3）——
    terminology: null,

    // —— 状态面（M4/M5/M8）——
    states: {
      loading: null,
      error: { present: null, text: null, hasNextStep: null, meta: null },
      empty: { present: null, text: null, hasActionableStep: null },
      actionNote: { present: null, tone: null, text: null },
      daemonOff: null,
      drift: null,
      distroFilter: { selectValue: null, selectDisabled: null, selectTitle: null, targetBadge: null }
    },

    // —— 反馈几何（M7）——
    feedback: { noteRect: null, lastActionRect: null, deltaY: null, sameViewport: null },

    // —— 键盘顺序（M10）——
    focusables: null,

    rawText: '',
    parseConfidence: 'low',
    domHints: {}
  };

  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const all = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const txt = (el) => ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
  const attrs = (el, pre) =>
    Object.fromEntries(
      Array.from(el.attributes || []).filter((a) => a.name.startsWith(pre)).map((a) => [a.name, a.value.slice(0, 200)])
    );

  // ---------------- 1) 侧栏 rail ----------------
  const railSel = 'button,[role="button"],[role="tab"],[role="listitem"],a[href],[role="radio"],[role="menuitem"]';
  const railItems = [];
  for (const el of all(railSel)) {
    const r = el.getBoundingClientRect();
    if (r.left < 96 && r.width <= 96 && r.height <= 96) {
      railItems.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        text: txt(el).slice(0, 120),
        // 可访问名来源判定：aria-label > innerText > title（title 是**最弱**来源，hover 才可见）
        accessibleNameFrom: el.getAttribute('aria-label') ? 'aria-label' : txt(el) ? 'text' : el.getAttribute('title') ? 'title' : 'NONE',
        ariaPressed: el.getAttribute('aria-pressed'),
        ariaCurrent: el.getAttribute('aria-current'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        hasSvg: !!el.querySelector('svg'),
        svgAriaHidden: (() => { const s = el.querySelector('svg'); return s ? s.getAttribute('aria-hidden') : null; })(),
        svgTitle: (() => { const t = el.querySelector('svg title'); return t ? txt(t) : null; })(),
        cls: (el.className || '').toString().slice(0, 200),
        data: attrs(el, 'data-'),
        rect: rect(el)
      });
    }
  }
  railItems.sort((a, b) => a.rect.y - b.rect.y);
  out.rail.items = railItems;
  out.rail.count = railItems.length;
  out.rail.unnamed = railItems.filter((x) => x.accessibleNameFrom === 'NONE' || x.accessibleNameFrom === 'title');
  const activeRail = railItems
    .filter((x) => x.ariaPressed === 'true' || x.ariaCurrent === 'true' || /active|selected|current/.test(x.cls))
    .map((x) => ({ name: x.ariaLabel || x.title || x.text, from: x.accessibleNameFrom }));
  out.rail.active = activeRail.length ? activeRail : null;

  // ---------------- 2) 面板本体定位 ----------------
  // 主判据：data-dsh-remote-wsl 或「远程资源管理器」标题文本；class 只作提示。
  let panelRoot = document.querySelector('[data-dsh-remote-wsl="panel"]');
  if (!panelRoot) {
    const cands = all('section,div[role="region"],aside').filter((el) => /远程资源管理器/.test(txt(el).slice(0, 400)));
    cands.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    panelRoot = cands[0] || null;
  }
  if (panelRoot) {
    out.panel.present = true;
    out.panel.rootRect = rect(panelRoot);
    out.panel.title = (panelRoot.querySelector('.dsh-rw-title') ? txt(panelRoot.querySelector('.dsh-rw-title')) : null) || (/远程资源管理器/.test(txt(panelRoot)) ? '远程资源管理器(by text)' : null);
    out.panel.subtitle = panelRoot.querySelector('.dsh-rw-subtitle') ? txt(panelRoot.querySelector('.dsh-rw-subtitle')) : null;
    out.domHints.panelRoot = panelRoot.tagName.toLowerCase() + (panelRoot.className ? '.' + String(panelRoot.className).split(' ').join('.') : '');
  } else {
    out.panel.present = false;
  }

  out.rawText = (panelRoot ? txt(panelRoot) : txt(document.querySelector('main,[role="main"]') || document.body)).slice(0, 24000);

  // ---------------- 3) 控件级全量清单（面板内） ----------------
  const scope = panelRoot || document.body;
  const controls = [];
  for (const el of Array.from(scope.querySelectorAll('button,select,input,textarea,a[href],[role="button"],[role="treeitem"],[role="option"],[role="switch"],[role="checkbox"],details>summary,[tabindex]'))) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const labelText = txt(el);
    const aria = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    const tag = el.tagName.toLowerCase();
    const typeish = tag + (el.getAttribute('type') ? ':' + el.getAttribute('type') : '');
    const nameFrom = aria ? 'aria-label' : labelText ? 'text' : title ? 'title' : 'NONE';
    controls.push({
      tag: typeish,
      role: el.getAttribute('role'),
      text: labelText.slice(0, 160),
      ariaLabel: aria,
      title,
      accessibleNameFrom: nameFrom,
      // title-only：可见文本为空（或仅图标/emoji）且无 aria-label，唯一解释来源是 title
      titleOnly: nameFrom === 'title',
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      cursor: cs.cursor,
      color: cs.color,
      background: cs.backgroundColor,
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaSelected: el.getAttribute('aria-selected'),
      tabIndex: el.tabIndex,
      cls: (el.className || '').toString().slice(0, 200),
      rect: rect(el),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight
    });
  }
  controls.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  out.controls = controls;
  out.titleOnlyControls = controls.filter((c) => c.titleOnly);
  out.controlsSummary = {
    total: controls.length,
    enabled: controls.filter((c) => !c.disabled).length,
    disabled: controls.filter((c) => c.disabled).length,
    titleOnly: out.titleOnlyControls.length,
    unnamed: controls.filter((c) => c.accessibleNameFrom === 'NONE').length,
    byNameSource: controls.reduce((acc, c) => ((acc[c.accessibleNameFrom] = (acc[c.accessibleNameFrom] || 0) + 1), acc), {}),
    // 完成基准场景要用的控件是否 title-only（A1/A3 的具体控件由报告逐条判定）
    titleOnlyList: out.titleOnlyControls.map((c) => ({ tag: c.tag, text: c.text, title: c.title, rect: c.rect }))
  };

  // ---------------- 4) 术语暴露（M3） ----------------
  const TERMS = ['explorer\\.snapshot', '/remote-wsl/api', 'snapshot', 'wsl_status', '\\bslot\\b', '\\bpin\\b', 'drift', 'orphans', '\\bkeys\\b', 'daemon', '\\bweb\\s*\\d{3,5}', '\\bkind\\b', '\\bcwd\\b'];
  const mainSight = (() => {
    // 主视线 = 面板内除 <details> 之外、且位于视口内的文本
    const clone = scope.cloneNode(true);
    clone.querySelectorAll('details').forEach((d) => d.remove());
    return ((clone.innerText || clone.textContent || '') + '').replace(/\s+/g, ' ').trim();
  })();
  const termHit = (hay, where) =>
    TERMS.map((t) => {
      const re = new RegExp(t, 'gi');
      const m = hay.match(re);
      return m ? { term: t, count: m.length, where } : null;
    }).filter(Boolean);
  out.terminology = {
    // 分三档：主视线（最严重）/ 折叠区（可接受）/ title（hover-only，中等）
    mainSightHits: termHit(mainSight, 'main-sight'),
    allTextHits: termHit(out.rawText, 'all-text'),
    titleHits: termHit(controls.map((c) => c.title).filter(Boolean).join(' | '), 'title'),
    mainSightText: mainSight.slice(0, 4000)
  };

  // ---------------- 5) 状态面（M4/M5/M8） ----------------
  const s = out.states;
  // loading：句子里含"正在读取/正在加载"
  const loadingEl = all('div').find((el) => /正在读取|正在加载/.test(txt(el)) && txt(el).length < 200) || null;
  s.loading = { present: !!loadingEl, text: loadingEl ? txt(loadingEl) : null };

  const errEl = scope.querySelector('[role="alert"].dsh-rw-error, .dsh-rw-error');
  if (errEl) {
    const t = txt(errEl);
    s.error = {
      present: true,
      text: t.slice(0, 2000),
      meta: errEl.querySelector('.dsh-rw-error-meta') ? txt(errEl.querySelector('.dsh-rw-error-meta')) : null,
      // 有无下一步：存在可点的重试/出口按钮，或文本里含可照做的命令
      hasNextStep: !!errEl.querySelector('button:not([disabled])') || /wsl\.exe|wsl --install|重试|运行\s*`/.test(t),
      nextStepKind: errEl.querySelector('button:not([disabled])') ? 'button' : /wsl|重试/.test(t) ? 'text' : 'none'
    };
  } else s.error = { present: false, text: null, meta: null, hasNextStep: null, nextStepKind: null };

  const emptyEl = scope.querySelector('.dsh-rw-empty') || all('div').find((el) => /没有发现 WSL 发行版/.test(txt(el)));
  if (emptyEl) {
    const t = txt(emptyEl);
    s.empty = { present: true, text: t.slice(0, 1200), hasActionableStep: /wsl\.exe|wsl --install|请|重试|安装|运行/.test(t) };
  } else s.empty = { present: false, text: null, hasActionableStep: null };

  const noteEl = scope.querySelector('.dsh-rw-note');
  if (noteEl) {
    s.actionNote = {
      present: true,
      tone: noteEl.className.indexOf('note--error') >= 0 ? 'error' : 'info',
      role: noteEl.getAttribute('role'),
      text: txt(noteEl).slice(0, 1200),
      hasRetry: !!noteEl.querySelector('button'),
      dismissible: !!noteEl.querySelector('button[aria-label*="关闭"],.dsh-rw-note button')
    };
  } else s.actionNote = { present: false, tone: null, role: null, text: null, hasRetry: null, dismissible: null };

  const dot = scope.querySelector('.dsh-rw-dot');
  const statusTextEl = scope.querySelector('.dsh-rw-status-text');
  s.daemonOff = {
    dotClass: dot ? String(dot.className) : null,
    statusText: statusTextEl ? txt(statusTextEl) : null,
    hasStartButton: !!(scope.querySelector('.dsh-rw-status') && Array.from(scope.querySelectorAll('.dsh-rw-status button')).some((b) => /启动守护/.test(txt(b)))),
    titleOnDot: dot ? dot.getAttribute('title') : null
  };
  const driftEl = scope.querySelector('.dsh-rw-drift');
  s.drift = driftEl ? { present: true, text: txt(driftEl), title: driftEl.getAttribute('title'), hasFixButton: !!driftEl.querySelector('button') } : { present: false, text: null, title: null, hasFixButton: null };

  const sel = scope.querySelector('select.dsh-rw-select, select');
  s.distroFilter = {
    selectValue: sel ? sel.value : null,
    selectDisabled: sel ? sel.disabled : null,
    selectTitle: sel && sel.parentElement ? sel.parentElement.getAttribute('title') : null,
    optionCount: sel ? sel.options.length : null,
    options: sel ? Array.from(sel.options).map((o) => o.textContent.trim()) : null,
    targetBadge: (() => {
      const b = Array.from(scope.querySelectorAll('.dsh-rw-badge')).find((x) => /当前目标/.test(txt(x)));
      return b ? txt(b) : null;
    })(),
    // 树里被标记为「当前目标」的那一行（与下拉值是否可区分）
    targetRow: (() => {
      const row = Array.from(scope.querySelectorAll('.dsh-rw-distro-row')).find((x) => /当前目标/.test(txt(x)));
      return row ? txt(row).slice(0, 200) : null;
    })()
  };

  // ---------------- 6) 反馈几何（M7） ----------------
  const lastAction =
    Array.from(scope.querySelectorAll('button')).reverse().find((b) => /打开中|复制中/.test(txt(b))) ||
    (s.actionNote.text ? Array.from(scope.querySelectorAll('button')).find((b) => /在新会话中打开|复制路径/.test(txt(b))) : null);
  out.feedback = {
    noteRect: noteEl ? rect(noteEl) : null,
    lastActionRect: lastAction ? rect(lastAction) : null,
    deltaY: noteEl && lastAction ? Math.round(rect(noteEl).y - rect(lastAction).y) : null,
    sameViewport: noteEl && lastAction ? rect(noteEl).y >= 0 && rect(noteEl).y + rect(noteEl).h <= window.innerHeight : null,
    noteInViewport: noteEl ? rect(noteEl).y >= 0 && rect(noteEl).y + rect(noteEl).h <= window.innerHeight : null
  };

  // ---------------- 7) 键盘可达性（M10，静态面） ----------------
  out.focusables = controls
    .filter((c) => c.tabIndex >= 0)
    .map((c) => ({ tag: c.tag, text: c.text.slice(0, 60), title: c.title, rect: c.rect, visible: true }));
  out.domHints.notes = [
    'focusables = 静态可 Tab 候选；真实 Tab 顺序请用 out-23-focus-order.txt 逐步 activeElement 记录',
    'treeitem/option 角色缺失时，树行的键盘可达性只能靠 Tab 实测判定'
  ];

  out.parseConfidence = panelRoot ? (controls.length ? 'high' : 'medium') : 'low';
  return out;
}
