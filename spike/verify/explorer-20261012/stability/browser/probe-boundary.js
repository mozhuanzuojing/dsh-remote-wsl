/* probe-boundary.js —— 测项④：≥200 行树 / 极长路径名的首屏渲染耗时与 DOM 规模。
 *
 * 依赖：instrument.js + fixtures.js（夹具喂 explorer.snapshot）。**不**改被验对象。
 * 预登记阈值（MATRIX §2 ④，开工前已定，看数前不许改）：
 *   夹具A（1×200 行 / 60 字符路径）：挂载 ≤300ms 且无 >100ms 长任务
 *   夹具C（60×200 行）：挂载 ≤1500ms
 *   折叠切换重渲染 ≤150ms
 *
 * 计时口径：`performance.now()` + MutationObserver 的**首次真实 DOM 变异**（不用 setTimeout(0) 当"渲染完成"）。
 * 每次测量都落原始读数（含 rows 断言，rows≠期望即 unknown）。
 */
({ labelRe = '远程资源管理器|remote-wsl' } = {}) => {
  const instr = window.__dsrw_instr__;
  const fx = window.__dsrw_fx__;
  if (!instr) return { ok: false, error: 'instrument-missing' };

  const PANEL = '[data-dsh-remote-wsl="panel"]';
  const now = () => performance.now();
  const sleep = (ms) => instr.rawDelay(ms);
  const waitFor = async (fn, timeoutMs) => {
    const t0 = now();
    for (;;) {
      let v = null;
      try {
        v = fn();
      } catch {}
      if (v) return { ok: true, ms: Math.round(now() - t0) };
      if (now() - t0 > timeoutMs) return { ok: false, ms: Math.round(now() - t0) };
      await sleep(20);
    }
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const rail = () => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll('[class*="panelList"] button,[class*="panelList"] [role="button"],[class*="panelList"] [role="tab"]'))) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ el, y: r.y, name: [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').trim()].filter(Boolean).join(' ') });
    }
    return out.sort((a, b) => a.y - b.y);
  };
  const findOurs = () => {
    const re = new RegExp(labelRe, 'i');
    return rail().find((c) => re.test(c.name)) || null;
  };
  const findOther = () => {
    const ours = findOurs();
    return rail().find((c) => c !== ours) || null;
  };

  // ---- 长任务采集（buffered；不支持则记 null，不编） ----
  const longs = [];
  let longtaskSupported = null;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longs.push({ startTime: Math.round(e.startTime), duration: Math.round(e.duration) });
    });
    po.observe({ type: 'longtask', buffered: true });
    longtaskSupported = true;
  } catch (e) {
    longtaskSupported = false;
  }
  const longsSince = (t0) => longs.filter((l) => l.startTime >= t0 - 5);

  /** MutationObserver 计时：等到 selector 首次出现（或 subtree 有 childList 变异） */
  const waitMutation = (selector, timeoutMs, t0) =>
    new Promise((resolve) => {
      let done = false;
      const obs = new MutationObserver(() => {
        if (done) return;
        const el = document.querySelector(selector);
        if (el) {
          done = true;
          obs.disconnect();
          resolve({ ok: true, ms: Math.round(now() - t0), at: Math.round(now()) });
        }
      });
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      } catch {}
      const st = instr.origTimers.setTimeout || window.setTimeout;
      st.call(window, () => {
        if (done) return;
        done = true;
        try {
          obs.disconnect();
        } catch {}
        resolve({ ok: false, ms: Math.round(now() - t0), at: Math.round(now()) });
      }, timeoutMs);
    });

  const domNow = () => instr.domCounts();

  const S = { schema: 'dsrw-boundary/1', installedAt: new Date().toISOString(), results: [], error: null, longtaskSupported };

  const measureMount = async (fixtureName, expectRows) => {
    if (!fx || !fx.enabled) return { ok: false, error: 'fixture-not-installed', hint: '先跑 browser/fixtures.js' };
    fx.reinstall(fixtureName);
    // ★ 夹具构造必须在计时窗外：warm() 先造好大数组并测出 pretty-print 体积，
    //   否则"造 12000 行 + stringify"的开销会被算成面板的渲染成本（自查抓到的计时污染）。
    const fixtureWarm = fx.warm(fixtureName);
    const ours = findOurs();
    const other = findOther();
    if (!ours || !other) return { ok: false, error: 'rail-missing' };
    // 先切走（保证是"重挂载"，而不是复用已挂载的实例）
    other.el.click();
    await waitFor(() => document.querySelector(PANEL) === null, 2000);
    await sleep(200);
    // 触发挂载
    const t0 = now();
    const longsBefore = longs.length;
    ours.el.click();
    const appear = await waitMutation(PANEL, 5000, t0);
    const tree = await waitMutation('.dsh-rw-tree', 5000, t0);
    await sleep(400); // settle，让 React 完成提交
    const tSettle = Math.round(now() - t0);
    const dom = domNow();
    const rowsAsserted = dom.rows === expectRows;
    const lt = longsSince(t0);
    const ltTotal = lt.reduce((a, b) => a + b.duration, 0);
    const ltMax = lt.reduce((a, b) => Math.max(a, b.duration), 0);
    return {
      ok: appear.ok && tree.ok,
      fixture: fixtureName,
      expectRows,
      rowsAsserted,
      fixtureWarm,
      tPanelAppearMs: appear.ms,
      tTreeAppearMs: tree.ms,
      tSettleMs: tSettle,
      dom,
      nodesPerRow: dom.rows > 0 ? Math.round((dom.panelNodes / dom.rows) * 100) / 100 : null,
      preTextLen: dom.preTextLen,
      longtask: { supported: longtaskSupported, count: lt.length, totalMs: ltTotal, maxMs: ltMax, items: lt.slice(0, 10) },
      raw: { longsIndexBefore: longsBefore, at: Math.round(now()) }
    };
  };

  /** 折叠切换重渲染（暴露每次 render 都重算 JSON.stringify 的代价） */
  const measureRerender = async () => {
    const row = Array.from(document.querySelectorAll('.dsh-rw-distro-row'))[0];
    if (!row) return { ok: false, error: 'distro-row-missing' };
    await sleep(300);
    const t0 = now();
    const p = waitMutation('.dsh-rw-tree', 4000, t0);
    row.click();
    const r = await p;
    await sleep(250);
    const lt = longsSince(t0);
    return { ok: r.ok, tRerenderMs: r.ms, longtask: { count: lt.length, totalMs: lt.reduce((a, b) => a + b.duration, 0), maxMs: lt.reduce((a, b) => Math.max(a, b.duration), 0) }, dom: domNow() };
  };

  /** 滚动 20 帧的帧间隔（rAF 抖动代理） */
  const measureScroll = async ({ frames = 20, step = 240 } = {}) => {
    const body = document.querySelector('.dsh-rw-body');
    if (!body) return { ok: false, error: 'body-missing' };
    const intervals = [];
    const st = instr.origTimers.requestAnimationFrame || window.requestAnimationFrame;
    await new Promise((resolve) => {
      let last = null;
      let n = 0;
      const tick = (ts) => {
        if (last !== null) intervals.push(Math.round(ts - last));
        last = ts;
        body.scrollTop = body.scrollTop + step;
        if (++n >= frames) return resolve();
        st.call(window, tick);
      };
      st.call(window, tick);
    });
    const sorted = intervals.slice().sort((a, b) => a - b);
    return {
      ok: true,
      frames: intervals.length,
      medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      intervals
    };
  };

  /** 预登记判定（阈值写死在代码里 = 可复算） */
  const verdictFor = (mount) => {
    const th = { A: { mountMs: 300, longtaskMs: 100 }, B: { mountMs: 300, longtaskMs: 100 }, C: { mountMs: 1500, longtaskMs: 100 }, FIXED: { mountMs: 300, longtaskMs: 100 }, TINY: { mountMs: 300, longtaskMs: 100 } }[mount.fixture] || { mountMs: 1500, longtaskMs: 100 };
    if (!mount.ok) return 'unknown';
    if (!mount.rowsAsserted) return 'unknown'; // 行数没到 ⇒ 夹具没生效，不许当通过
    const pass = mount.tSettleMs <= th.mountMs && mount.longtask.maxMs <= th.longtaskMs;
    return pass ? 'pass' : 'red';
  };

  const run = async ({ fixture = 'A', expectRows = null, rerender = true, scroll = true } = {}) => {
    const spec = fx ? fx.spec : null;
    // ★ 真实 DOM 行数 = **当前 active distro** 的路径数（client.panel.js 的 activeWorkspaces 只渲染当前 distro），
    //   不是 workspaces 总数。夹具 C 的 12000 条里只有 200 条进 DOM —— 这里很容易把断言写错。
    const exp = expectRows !== null ? expectRows : fx && fx.spec ? fx.spec.rows : 200;
    const mount = await measureMount(fixture, exp);
    const rr = rerender ? await measureRerender() : null;
    const sc = scroll ? await measureScroll() : null;
    const res = {
      fixture,
      spec,
      mount,
      rerender: rr,
      scroll: sc,
      verdict: verdictFor(mount),
      rerenderVerdict: rr && rr.ok ? (rr.tRerenderMs <= 150 ? 'pass' : 'red') : 'unknown',
      thresholds: { mountMs: { A: 300, B: 300, C: 1500 }, longtaskMs: 100, rerenderMs: 150 },
      note: 'expectRows = 当前 active distro 的行数（夹具 C 共 12000 条路径，但只有 200 条进 DOM）；mount.fixtureWarm.prettyBytes = 面板 <pre> 里那份 JSON 的 pretty-print 体积（**每个 render 都会重算**）',
      at: Math.round(now())
    };
    S.results.push(res);
    return res;
  };

  window.__dsrw_bound__ = {
    run,
    measureMount,
    measureRerender,
    measureScroll,
    longs: () => longs.slice(),
    status: () => ({ schema: S.schema, results: S.results, error: S.error, longtaskSupported, fixture: fx ? fx.status() : null, dom: domNow() })
  };
  return { ok: true, installed: true, api: Object.keys(window.__dsrw_bound__), fixtureInstalled: fx ? fx.enabled : false, longtaskSupported };
}
