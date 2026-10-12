/* probe-mount-cycle.js —— 测项①：挂载/卸载 ≥20 次的净增长探针（浏览器内状态机）。
 *
 * 为什么是状态机：20 轮循环 ≈ 20–40s，若在一次工具调用里 await 会超时并丢样本。
 * 用法：
 *   install/start：`(${本文件内容})({cycles:20, warmup:2})` → 立即返回 ack
 *   轮询：        `(${本文件内容Quiet?})` 不行 —— 用 window.__dsrw_cycle__.status()（同一页面里 eval 一行）
 *   取数：        `window.__dsrw_cycle__.status()` / `.stop()`
 *
 * 第 1 步（start 之前可单独调）先做 **U1 定性**：切走再切回到底是不是真的卸载重建。
 * 若 keep-alive（节点留驻），则"挂载/卸载"动作不成立 ⇒ 探针把 mode 记为 'switch-only'，
 * 报告里必须改口径（测的是"切换 N 次"），绝不许把 keep-alive 的恒定读数写成"无泄漏"。
 *
 * 强制红 A2：`armLeak(true)` 会在**每一轮结束**额外挂 1 个 document 监听器 + 1 个 setInterval
 * （只加在注入层，不改被验对象），用来证明仪表与分析器能抓到人造泄漏。
 */
async ({ cycles = 20, warmup = 2, gapMs = 150, unmountWaitMs = 1500, labelRe = '远程资源管理器|remote-wsl|remote_wsl' } = {}) => {
  const instr = window.__dsrw_instr__;
  if (!instr) return { ok: false, error: 'instrument-missing', hint: '先注入 browser/instrument.js' };
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
      await sleep(25);
    }
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  /** rail 候选：最左一列的可点元素（与 p0-verify 的 extract-panel 同口径，便于交叉复核） */
  const railCandidates = () => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll('[class*="panelList"] button,[class*="panelList"] [role="button"],[class*="panelList"] [role="tab"]'))) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        out.push({ el, y: r.y, name: [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').trim()].filter(Boolean).join(' ') });
      }
    }
    out.sort((a, b) => a.y - b.y);
    return out;
  };
  const findOurs = () => {
    const re = new RegExp(labelRe, 'i');
    const hits = railCandidates().filter((c) => re.test(c.name));
    return hits.length ? hits[0] : null;
  };
  const findOther = () => {
    const ours = findOurs();
    const rest = railCandidates().filter((c) => c !== ours);
    return rest.length ? rest[0] : null;
  };

  const sample = () => {
    const s = instr.snapshot();
    return {
      at: Math.round(now()),
      domAll: s.dom.domAll,
      panelPresent: s.dom.panelPresent,
      panelNodes: s.dom.panelNodes,
      rows: s.dom.rows,
      preTextLen: s.dom.preTextLen,
      listenersOutstanding: s.listeners.totals.outstanding,
      listenersAdds: s.listeners.totals.adds,
      listenersRemoves: s.listeners.totals.removes,
      timersOutstanding: s.timers.outstanding,
      apiInFlight: s.fetch.pendingApiCount,
      apiSeqIssued: s.fetch.apiSeqIssued,
      heapUsed: s.heap ? s.heap.usedJSHeapSize : null,
      mountTransitions: s.mountTransitions,
      detachedObserved: s.detachedObserved,
      instrCapped: { listeners: s.listeners.capped.adds >= s.caps.listenerSamples, fetch: s.fetch.logCapped }
    };
  };

  const S = {
    schema: 'dsrw-cycle/1',
    startedAt: new Date().toISOString(),
    mode: null, // 'mount-unmount' | 'switch-only' | 'unknown'
    running: false,
    done: false,
    cycles: [],
    target: { cycles, warmup, gapMs, unmountWaitMs },
    classify: null,
    leakArmed: false,
    leakObjects: null,
    notes: [],
    error: null
  };

  /** U1 定性：ours → 出现；other → 是否消失 */
  const classify = async () => {
    const ours = findOurs();
    if (!ours) {
      S.classify = { railFound: false, railCandidates: railCandidates().map((c) => c.name.slice(0, 60)) };
      S.mode = 'unknown';
      return S.classify;
    }
    ours.el.click();
    const appeared = await waitFor(() => document.querySelector(PANEL) !== null, 4000);
    const others = findOther();
    let disappeared = { ok: false, ms: null };
    if (others) {
      const before = instr.snapshot().mountTransitions;
      others.el.click();
      const stored = await waitFor(() => document.querySelector(PANEL) === null, unmountWaitMs);
      const after = instr.snapshot().mountTransitions;
      disappeared = { ok: stored.ok, ms: stored.ms, mountTransitionsDelta: after - before };
    }
    S.classify = {
      railFound: true,
      railName: ours.name.slice(0, 80),
      appeared,
      othersFound: others !== null,
      disappeared,
      mountTransitionsNow: instr.snapshot().mountTransitions
    };
    S.mode = !appeared.ok ? 'unknown' : disappeared.ok ? 'mount-unmount' : 'switch-only';
    // 回到"面板已打开"的状态，便于 start 从已知状态开始
    ours.el.click();
    await waitFor(() => document.querySelector(PANEL) !== null, 4000);
    return S.classify;
  };

  const armLeak = (on) => {
    if (on && !S.leakObjects) {
      const fn = () => {};
      S.leakObjects = { listener: fn, timers: [], add: () => document.addEventListener('click', fn), timer: () => setInterval(() => {}, 1000) };
    }
    S.leakArmed = on === true;
    return { leakArmed: S.leakArmed };
  };

  const oneCycle = async (i) => {
    const ours = findOurs();
    const other = findOther();
    if (!ours || !other) throw new Error('rail item not found (ours=' + !!ours + ', other=' + !!other + ')');
    const row = { i, t: Math.round(now()), steps: {} };
    // --- 挂载 ---
    ours.el.click();
    const mounted = await waitFor(() => document.querySelector(PANEL) !== null, 4000);
    row.steps.mountWaitMs = mounted.ms;
    row.steps.mounted = mounted.ok;
    await sleep(gapMs);
    row.afterMount = sample();
    // --- 卸载（或仅切换）---
    const beforeTransitions = instr.snapshot().mountTransitions;
    other.el.click();
    const gone = await waitFor(() => document.querySelector(PANEL) === null, unmountWaitMs);
    row.steps.unmountWaitMs = gone.ms;
    row.steps.unmounted = gone.ok;
    row.steps.mountTransitionsDelta = instr.snapshot().mountTransitions - beforeTransitions;
    await sleep(gapMs);
    row.afterUnmount = sample();
    if (S.leakArmed && S.leakObjects) {
      S.leakObjects.add();
      S.leakObjects.timers.push(S.leakObjects.timer());
      row.leakInjected = true;
    }
    // --- 回到已打开，给下一轮一个确定起点（这一步的读数不算进判定）---
    ours.el.click();
    await waitFor(() => document.querySelector(PANEL) !== null, 4000);
    await sleep(gapMs);
    return row;
  };

  const start = async (opts = {}) => {
    if (S.running) return { ok: false, error: 'already-running', status: status() };
    Object.assign(S.target, opts);
    S.running = true;
    S.done = false;
    S.cycles = [];
    S.error = null;
    instr.mark('cycle-start');
    try {
      if (!S.classify) await classify();
      // 预热（首轮必然偏高：chunk 首次加载 + <style> 注入 + React 首渲染）——单独记，不参与判定
      const warm = [];
      for (let w = 0; w < S.target.warmup; w++) warm.push(await oneCycle(-(w + 1)));
      S.warmupSamples = warm;
      instr.reset(true); // 预热后基线
      for (let i = 1; i <= S.target.cycles; i++) {
        S.cycles.push(await oneCycle(i));
      }
      S.done = true;
    } catch (e) {
      S.error = String(e && e.message ? e.message : e);
    } finally {
      S.running = false;
      instr.mark('cycle-end');
    }
    return { ok: S.error === null, status: status() };
  };

  const status = () => ({
    schema: S.schema,
    startedAt: S.startedAt,
    mode: S.mode,
    running: S.running,
    done: S.done,
    error: S.error,
    notes: S.notes,
    classify: S.classify,
    leakArmed: S.leakArmed,
    target: S.target,
    warmupSamples: S.warmupSamples || [],
    cycles: S.cycles,
    baseline: instr.snapshot().warmupBaseline,
    /** 仪表健康：false ⇒ 对应指标的零值不是证据（analyzer 会据此判 unknown） */
    instrumentHealth: instr.snapshot().health,
    instrument: { caps: instr.caps, now: instr.snapshot().dom }
  });

  const stop = () => {
    S.running = false;
    return status();
  };

  window.__dsrw_cycle__ = {
    classify,
    start,
    stop,
    status,
    sample,
    armLeak,
    railCandidates: () => railCandidates().map((c) => ({ y: Math.round(c.y), name: c.name.slice(0, 80) })),
    state: S
  };
  return { ok: true, installed: true, api: Object.keys(window.__dsrw_cycle__), classify: await classify(), mode: S.mode };
}
