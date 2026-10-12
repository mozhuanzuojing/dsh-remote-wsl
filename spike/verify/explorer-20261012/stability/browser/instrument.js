/* instrument.js —— task-7 稳定性读数的**唯一仪表层**（浏览器内，零依赖、不改被验对象）。
 *
 * 注入方式（二选一，报告必须写明实际用了哪条）：
 *   A) **首选**：页面加载前 —— chrome-devtools-mcp `navigate_page` 的 `initScript` 参数，
 *      传本文件全文（IIFE）。加载期监听器/定时器也能被记到。
 *   B) 兜底：页面加载后 —— `evaluate_script` / cua `page execute_javascript` 里执行 `(${本文件全文})`。
 *      此时加载期仪表有偏移，故所有"增长"判定改用**预热后 delta**口径（见 MATRIX §2 ①）。
 *
 * 幂等：重复注入返回既有句柄，不重复包装（避免二次包装导致读数翻倍）。
 *
 * 纪律（防"仪表自己泄漏"）：
 *   - 所有日志数组**硬上限**（见 CAP），到顶即停记（读数里回显 `capped:true`）；
 *   - 堆栈采样只留 2 帧、最多 STACK_MAX 条；
 *   - 不持有被观察 DOM 节点的强引用（只用 WeakRef / 计数），所以仪表本身不会造成 detached 保留。
 *
 * 暴露（window.__dsrw_instr__）：
 *   snapshot()                      → 一次性可 JSON 化的全量读数
 *   reset(withWarmupBaseline)       → 重置计数（用于"预热后基线"）；warmup=true 时把当前值记为基线
 *   mark(label)                     → 时间线打点
 *   setGatePlan(plan)               → {delayBySeq:{[seq]:ms}, never:[seq,...]} 由 fixtures 侧或本层直接设
 *   gateFn                          → 可被 fixtures.js 覆盖的函数 (seq,url)=>Promise|ms
 */
(() => {
  const KEY = '__dsrw_instr__';
  const VERSION = 1;
  if (window[KEY] && window[KEY].version === VERSION) return window[KEY].snapshot();

  const CAP = Object.freeze({
    fetchLog: 500,
    listenerSamples: 100,
    timerSamples: 100,
    marks: 200,
    mounts: 400
  });
  const STACK_MAX = 100;

  const now = () => performance.now();
  const iso = () => new Date().toISOString();

  /**
   * 包装失败的**显式**登记（2026-10-12 由 harness 抓到：listeners 包装抛错时被 try/catch 吞掉，
   * 读数仍是全零 ⇒ 与"无泄漏"长得一模一样，会给出**假绿**）。
   * 纪律：任何一类包装失败 ⇒ 该类指标的零值**不是证据**；analyzer 必须把该指标判 unknown。
   */
  const wrapErrors = { listeners: null, timers: null, fetch: null };

  // ---- 短栈（只留 2 帧；上限 STACK_MAX 条） ----
  let stackTaken = 0;
  const shortStack = () => {
    if (stackTaken >= STACK_MAX) return null;
    stackTaken++;
    try {
      return (new Error().stack || '').split('\n').slice(1, 4).map((s) => s.trim().slice(0, 160));
    } catch {
      return null;
    }
  };

  // ---- 监听器计数（add - remove 净额，按 targetKind|type） ----
  const listenerCounts = new Map(); // key -> {adds, removes}
  const listenerSamples = [];
  let listenerCap = Object.freeze({ adds: 0, removes: 0 });
  const kindOf = (t) => {
    try {
      if (t === window) return 'window';
      if (t === document) return 'document';
      if (t === document.body) return 'body';
      const tag = t && t.tagName ? String(t.tagName).toLowerCase() : t && t.constructor ? String(t.constructor.name) : typeof t;
      return 'other:' + tag;
    } catch {
      return 'unknown';
    }
  };
  const bump = (key, field) => {
    let e = listenerCounts.get(key);
    if (!e) {
      e = { adds: 0, removes: 0 };
      listenerCounts.set(key, e);
    }
    e[field]++;
  };
  try {
    const ET = window.EventTarget;
    const origAdd = ET.prototype.addEventListener;
    const origRemove = ET.prototype.removeEventListener;
    ET.prototype.addEventListener = function (type, fn, opts) {
      const k = kindOf(this) + '|' + String(type);
      bump(k, 'adds');
      listenerCap = { adds: listenerCap.adds + 1, removes: listenerCap.removes };
      if (listenerSamples.length < CAP.listenerSamples) {
        listenerSamples.push({ at: now(), key: k, stack: shortStack(), opts: opts === true ? 'capture' : typeof opts });
      }
      return origAdd.call(this, type, fn, opts);
    };
    ET.prototype.removeEventListener = function (type, fn, opts) {
      const k = kindOf(this) + '|' + String(type);
      bump(k, 'removes');
      listenerCap = { adds: listenerCap.adds, removes: listenerCap.removes + 1 };
      return origRemove.call(this, type, fn, opts);
    };
  } catch (e) {
    listenerCap = { adds: -1, removes: -1, error: String(e) };
    wrapErrors.listeners = String(e);
  }

  // ---- 定时器计数 ----
  const timers = new Map(); // id -> {kind, delay, startedAt, stack}
  const timerSamples = [];
  let timerSeq = 0;
  let timerStats = { scheduled: 0, cleared: 0, fired: 0 };
  const wrapTimer = (kind, orig, clearOrig) => {
    try {
      const wrapped = function (fn, delay, ...rest) {
        timerStats.scheduled++;
        // 分配一个我们自己的记账 id，同时保留原句柄（clear 时两种都要能对上）
        const id = ++timerSeq;
        const entry = { kind, delay: typeof delay === 'number' ? delay : null, startedAt: now(), stack: shortStack() };
        timers.set(id, entry);
        if (timerSamples.length < CAP.timerSamples) timerSamples.push({ id, at: entry.startedAt, kind, delay: entry.delay, stack: entry.stack });
        let handle;
        if (kind === 'raf') {
          handle = orig.call(window, function (t) {
            timers.delete(id);
            timerStats.fired++;
            return typeof fn === 'function' ? fn(t) : undefined;
          });
        } else {
          handle = orig.call(window, function () {
            if (kind === 'timeout') timers.delete(id);
            if (kind === 'interval') entry.fired = (entry.fired || 0) + 1;
            timerStats.fired++;
            return typeof fn === 'function' ? fn.apply(this, arguments) : undefined;
          }, delay, ...rest);
        }
        try {
          entry.handle = handle;
          handleIds.set(handle, id);
        } catch {}
        return handle;
      };
      return wrapped;
    } catch {
      return orig;
    }
  };
  const handleIds = new Map(); // 原句柄 -> 记账 id（clear 用）
  const restore = { timeout: null, interval: null, raf: null };
  /** 未包装的定时器：探针自己的等待必须用它，否则会污染"定时器净增长"读数 */
  const origTimers = {};
  try {
    const oST = window.setTimeout, oSI = window.setInterval, oRAF = window.requestAnimationFrame;
    const oCT = window.clearTimeout, oCI = window.clearInterval, oCAF = window.cancelAnimationFrame;
    origTimers.setTimeout = oST;
    origTimers.setInterval = oSI;
    origTimers.requestAnimationFrame = oRAF;
    origTimers.clearTimeout = oCT;
    origTimers.clearInterval = oCI;
    origTimers.cancelAnimationFrame = oCAF;
    window.setTimeout = wrapTimer('timeout', oST);
    window.setInterval = wrapTimer('interval', oSI);
    window.requestAnimationFrame = wrapTimer('raf', oRAF);
    restore.timeout = oST;
    restore.interval = oSI;
    restore.raf = oRAF;
    const clearWrap = (kind, orig) =>
      function (handle) {
        timerStats.cleared++;
        const id = handleIds.get(handle);
        if (id !== undefined) {
          timers.delete(id);
          handleIds.delete(handle);
        }
        return orig.call(window, handle);
      };
    window.clearTimeout = clearWrap('timeout', oCT);
    window.clearInterval = clearWrap('interval', oCI);
    window.cancelAnimationFrame = clearWrap('raf', oCAF);
  } catch (e) {
    timerStats = { scheduled: -1, cleared: -1, fired: -1, error: String(e) };
    wrapErrors.timers = String(e);
  }

  // ---- fetch 记账 + 在飞集合 + 响应闸门 ----
  const fetchLog = [];
  const pendingFetches = new Set();
  let fetchSeq = 0;
  let apiSeq = 0;
  const gate = { plan: null, fn: null };
  const gateDelayFor = async (seq, url) => {
    if (typeof gate.fn === 'function') {
      const r = await gate.fn(seq, url);
      return typeof r === 'number' ? r : 0;
    }
    const p = gate.plan;
    if (!p) return 0;
    if (Array.isArray(p.never) && p.never.indexOf(seq) >= 0) return Number.POSITIVE_INFINITY;
    if (p.delayBySeq && typeof p.delayBySeq[seq] === 'number') return p.delayBySeq[seq];
    if (typeof p.defaultDelay === 'number') return p.defaultDelay;
    return 0;
  };
  let fetchWrapError = null;
  let origFetchRef = null; // 未包装的原始 fetch：供"地面真相"取数用（绕过闸门与夹具）
  try {
    const origFetch = window.fetch;
    origFetchRef = origFetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const isApi = url.indexOf('/remote-wsl/api') >= 0;
      const rec = {
        id: ++fetchSeq,
        url: String(url).slice(0, 300),
        method,
        isApi,
        seq: isApi && method === 'POST' ? ++apiSeq : null,
        startedAt: now(),
        deliveredAt: null,
        status: null,
        error: null,
        source: 'network',
        callerAborted: false
      };
      pendingFetches.add(rec);
      if (fetchLog.length < CAP.fetchLog) fetchLog.push(rec);
      try {
        const fx = window.__dsrw_fx__;
        let res;
        if (fx && fx.enabled && isApi && typeof fx.respond === 'function') {
          rec.source = 'fixture';
          res = await fx.respond(rec, init);
        } else {
          res = await origFetch.call(window, input, init);
        }
        if (rec.seq !== null) {
          const d = await gateDelayFor(rec.seq, rec.url);
          // ★ S12（2026-10-12 实盘抓到的**两个假红**）：闸门原来**无视调用方的 AbortSignal**。
          //   真实网络下 `controller.abort()` 会让 fetch 立刻 reject；而我的闸门把 promise 无限挂住，
          //   于是 (a) 被 abort 的请求仍算"在飞" ⇒ 误报 PILEUP；(b) client.api.js 的 9s 超时 abort
          //   也没法让 UI 退出 loading ⇒ 误报"永久卡死"。这两个结论都会错怪 T3 的修复。
          //   修法：闸门必须像真请求一样**尊重 abort**（abort ⇒ 以 AbortError reject）。
          const signal = init && init.signal ? init.signal : null;
          const abortErr = () => new DOMException('The operation was aborted.', 'AbortError');
          if (d === Number.POSITIVE_INFINITY) {
            rec.gate = 'never';
            fetchLog.push({ id: rec.id, note: 'gate-never: 请求永不返回（但尊重 abort）', seq: rec.seq, at: now() });
            await new Promise((_resolve, reject) => {
              if (signal) {
                if (signal.aborted) return reject(abortErr());
                signal.addEventListener('abort', () => reject(abortErr()), { once: true });
              }
            });
          }
          if (d > 0) {
            rec.gateDelayMs = d;
            await new Promise((resolve, reject) => {
              const st = (origTimers.setTimeout || restore.timeout);
              // S10：必须显式 .call(window, …)，否则 "Illegal invocation"
              const handle = st.call(window, resolve, d);
              if (signal) {
                if (signal.aborted) {
                  try { (origTimers.clearTimeout || clearTimeout).call(window, handle); } catch {}
                  return reject(abortErr());
                }
                signal.addEventListener('abort', () => {
                  try { (origTimers.clearTimeout || clearTimeout).call(window, handle); } catch {}
                  reject(abortErr());
                }, { once: true });
              }
            });
          }
          // 调用方是否已 abort（用于区分"被取消"与"真堆积"）
          rec.callerAborted = !!(signal && signal.aborted);
          rec.deliveredAt = now();
        } else {
          rec.deliveredAt = now();
        }
        rec.status = res && typeof res.status === 'number' ? res.status : null;
        return res;
      } catch (e) {
        rec.error = String(e && e.message ? e.message : e).slice(0, 200);
        rec.deliveredAt = now();
        throw e;
      } finally {
        pendingFetches.delete(rec);
      }
    };
  } catch (e) {
    fetchWrapError = String(e);
    wrapErrors.fetch = String(e);
  }

  // ---- DOM 计数 ----
  const PANEL_SEL = '[data-dsh-remote-wsl="panel"]';
  const domCounts = () => {
    const panel = document.querySelector(PANEL_SEL);
    const pre = document.querySelector('.dsh-rw-pre');
    let preLen = null;
    if (pre) {
      try {
        preLen = (pre.textContent || '').length;
      } catch {
        preLen = null;
      }
    }
    return {
      domAll: document.getElementsByTagName('*').length,
      panelPresent: panel !== null,
      panelNodes: panel ? panel.getElementsByTagName('*').length : 0,
      rows: document.querySelectorAll('.dsh-rw-workspace').length,
      distroRows: document.querySelectorAll('.dsh-rw-distro').length,
      buttons: document.querySelectorAll('button').length,
      preTextLen: preLen
    };
  };

  // ---- 挂载/卸载观察（MutationObserver + presence 差分） ----
  const mounts = [];
  const rootRefs = [];
  const finalized = { count: 0 };
  let finReg = null;
  try {
    if (window.FinalizationRegistry) {
      finReg = new FinalizationRegistry(() => {
        finalized.count++;
      });
    }
  } catch {}
  let lastPresence = null;
  let obs = null;
  let observerError = null;
  let observerTarget = null;
  try {
    const check = () => {
      const el = document.querySelector(PANEL_SEL);
      const present = el !== null;
      if (present !== lastPresence) {
        const rec = { at: now(), iso: iso(), present, domAll: document.getElementsByTagName('*').length };
        if (mounts.length < CAP.mounts) mounts.push(rec);
        lastPresence = present;
        if (!present && el) {
          try {
            const r = new WeakRef(el);
            rootRefs.push(r);
            if (finReg) finReg.register(el, mounts.length);
          } catch {}
        }
      }
    };
    lastPresence = document.querySelector(PANEL_SEL) !== null;
    obs = new MutationObserver(() => check());
    // ★ S6：initScript（document_start）注入时 `document.documentElement` **可能还是 null**，
    //   `obs.observe(null, …)` 会抛 "parameter 1 is not of type 'Node'"，
    //   于是挂载/卸载观察**静默失效**（mounts 里只有一条 {error}）—— 我 15:54 的实盘就是这样：
    //   U1 的定性靠轮询侥幸拿到，但"每次切换应有 2 次 transition"的结构证据全死了。
    //   修法：优先 documentElement，取不到就退回 `document`（总是 Node），并**显式登记**错误。
    const target = document.documentElement || document;
    observerTarget = target === document ? 'document' : 'documentElement';
    obs.observe(target, { childList: true, subtree: true });
  } catch (e) {
    observerError = String(e);
    mounts.push({ error: observerError });
  }

  const marks = [];
  const state = { resetAt: now(), warmupBaseline: null };

  const listenerSnapshot = () => {
    const totals = { adds: 0, removes: 0, outstanding: 0 };
    const byKey = {};
    for (const [k, v] of listenerCounts) {
      totals.adds += v.adds;
      totals.removes += v.removes;
      byKey[k] = v.adds - v.removes;
    }
    totals.outstanding = totals.adds - totals.removes;
    return { totals, byKey, capped: listenerCap, samples: listenerSamples.slice(0, 20) };
  };

  const timerSnapshot = () => {
    const list = [...timers.entries()].map(([id, e]) => ({ id, kind: e.kind, delay: e.delay, ageMs: Math.round(now() - e.startedAt), fired: e.fired || 0, stack: e.stack }));
    return { outstanding: timers.size, list, stats: timerStats, samples: timerSamples.slice(0, 20) };
  };

  const fetchSnapshot = () => {
    const pend = [...pendingFetches].map((r) => ({ id: r.id, url: r.url, method: r.method, isApi: r.isApi, seq: r.seq, ageMs: Math.round(now() - r.startedAt), gate: r.gate || null, callerAborted: r.callerAborted === true }));
    const api = fetchLog.filter((r) => r.isApi && r.seq !== null);
    return {
      pending: pend,
      pendingCount: pend.length,
      pendingApiCount: pend.filter((p) => p.isApi).length,
      // S12: 被调用方 abort 的请求不算真堆积（真网络下它们会立刻 reject）
      pendingApiNotAborted: pend.filter((p) => p.isApi && !p.callerAborted).length,
      apiSeqIssued: apiSeq,
      apiRequests: api.map((r) => ({ seq: r.seq, startedAt: Math.round(r.startedAt), deliveredAt: r.deliveredAt === null ? null : Math.round(r.deliveredAt), status: r.status, gateDelayMs: r.gateDelayMs || 0, source: r.source, error: r.error, callerAborted: r.callerAborted === true })),
      lastApiSeqIssued: api.length ? api[api.length - 1].seq : null,
      lastApiSeqDelivered: api.filter((r) => r.deliveredAt !== null).length ? api.filter((r) => r.deliveredAt !== null).slice(-1)[0].seq : null,
      logCapped: fetchLog.length >= CAP.fetchLog,
      wrapError: fetchWrapError
    };
  };

  const heap = () => {
    try {
      const m = performance.memory;
      return m ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit } : null;
    } catch {
      return null;
    }
  };

  const api = {
    version: VERSION,
    installedAt: iso(),
    caps: CAP,
    /** 一次性可 JSON 化读数（判定只吃这个 + 原始时序） */
    snapshot() {
      return {
        schema: 'dsrw-instr/1',
        version: VERSION,
        installedAt: api.installedAt,
        now: Math.round(now()),
        url: location.href,
        /** 仪表上限（S7：原 `caps` 只挂在 api 对象上、不在 snapshot() 里 ⇒ 消费方读 s.caps 会 undefined） */
        caps: CAP,
        /**
         * 仪表健康：false ⇒ 该类的**零值不是证据**（analyzer 必须把该指标判 unknown）。
         * 见 wrapErrors 的说明（harness 抓到的"静默全零 = 假绿"缺陷）。
         */
        health: {
          listeners: wrapErrors.listeners === null,
          timers: wrapErrors.timers === null,
          fetch: wrapErrors.fetch === null,
          errors: { listeners: wrapErrors.listeners, timers: wrapErrors.timers, fetch: wrapErrors.fetch }
        },
        dom: domCounts(),
        listeners: listenerSnapshot(),
        timers: timerSnapshot(),
        fetch: fetchSnapshot(),
        mounts: mounts.slice(-40),
        mountTransitions: mounts.length,
        mountObserverError: observerError,
        mountObserverTarget: observerTarget,
        detachedObserved: rootRefs.length,
        finalizedApprox: finalized.count,
        heap: heap(),
        marks: marks.slice(-20),
        resetAt: Math.round(state.resetAt),
        warmupBaseline: state.warmupBaseline,
        ua: navigator.userAgent.slice(0, 120)
      };
    },
    /** 预热后基线：把当前值记为基线（后续 delta 判定用） */
    reset(warmup) {
      state.resetAt = now();
      state.warmupBaseline = warmup ? { at: Math.round(now()), dom: domCounts(), listeners: listenerSnapshot().totals, timers: timerSnapshot().outstanding, pending: fetchSnapshot().pendingCount } : null;
      return state.warmupBaseline;
    },
    mark(label) {
      const m = { at: Math.round(now()), iso: iso(), label: String(label).slice(0, 120) };
      marks.push(m);
      if (marks.length > CAP.marks) marks.shift();
      try {
        performance.mark('dsrw:' + m.label);
      } catch {}
      return m;
    },
    /** 传 {delayBySeq:{1:1200}, never:[3], defaultDelay:0} 或直接给 gateFn */
    setGatePlan(plan) {
      gate.plan = plan || null;
      return gate.plan;
    },
    setGateFn(fn) {
      gate.fn = typeof fn === 'function' ? fn : null;
      return gate.fn !== null;
    },
    clearGate() {
      gate.plan = null;
      gate.fn = null;
    },
    /**
     * **地面真相**取数：绕过包装层（不计账、不过闸门、不吃夹具）。
     * ③ 的三层对照（面板 DOM / POST API / wsl_status）里"POST API"这一层必须用它，
     * 否则会被 fixture 或闸门污染 ⇒ 自欺。
     */
    rawFetch(input, init) {
      const f = origFetchRef || window.fetch;
      return f.call(window, input, init);
    },
    /** 探针自己的等待用它（不计入定时器读数） */
    origTimers,
    rawDelay(ms) {
      const st = origTimers.setTimeout || window.setTimeout;
      return new Promise((r) => st.call(window, r, ms));
    },
    /** 面板状态文本（③ 用；抓不到给 null，绝不编） */
    panelState() {
      const root = document.querySelector(PANEL_SEL);
      const q = (sel) => {
        const el = document.querySelector(sel);
        return el ? { text: (el.textContent || '').trim().slice(0, 400), title: el.getAttribute('title') } : null;
      };
      return {
        present: root !== null,
        subtitle: q('.dsh-rw-subtitle'),
        statusText: q('.dsh-rw-status-text'),
        loadedBadge: (() => {
          const els = Array.from(document.querySelectorAll('.dsh-rw-badge'));
          const hit = els.map((e) => (e.textContent || '').trim()).find((t) => /^快照|^未取数/.test(t));
          return hit || null;
        })(),
        refreshBtn: (() => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) => /刷新/.test((b.textContent || '').trim()));
          return btn ? { text: (btn.textContent || '').trim(), disabled: btn.disabled === true } : null;
        })(),
        retryBtn: (() => {
          const btn = Array.from(document.querySelectorAll('.dsh-rw-error button')).find((b) => /重试/.test((b.textContent || '').trim()));
          return btn ? { text: (btn.textContent || '').trim(), disabled: btn.disabled === true } : null;
        })(),
        errorVisible: document.querySelector('.dsh-rw-error') !== null,
        loadingHint: (() => {
          const el = document.querySelector('.dsh-rw-hint');
          return el && /正在读取/.test(el.textContent || '') ? (el.textContent || '').trim().slice(0, 120) : null;
        })(),
        dom: domCounts()
      };
    },
    domCounts,
    /**
     * 面板列表条目（**布局无关**定位）。
     * 2026-10-12 实盘教训：web profile 的 `sidebar.panellist` 渲染成 `nav[class*=panelList]` 里的
     * **竖排行**（rows 宽 252×36），**不是** 96px 图标栏 ⇒ p0-verify 的 `left<96 && w<=96` 口径
     * 在实盘一个都找不到（railCount=0）。探针必须按「面板列表容器 + 可访问名」定位。
     */
    panelRows() {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const nameOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').trim()].filter(Boolean).join(' | ');
      const collect = (root) => {
        const out = [];
        for (const el of Array.from(root.querySelectorAll('button,[role="button"],[role="tab"],[role="listitem"],a[href]'))) {
          if (!vis(el)) continue;
          const r = el.getBoundingClientRect();
          out.push({ el, y: r.y, x: r.x, w: r.width, h: r.height, name: nameOf(el) });
        }
        return out.sort((a, b) => a.y - b.y);
      };
      for (const nav of Array.from(document.querySelectorAll('[class*="panelList"],[class*="panel-list"]'))) {
        const rows = collect(nav);
        if (rows.length) return rows;
      }
      const narrow = [];
      for (const el of Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],[role="listitem"],a[href]'))) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.left < 96 && r.width <= 96 && r.height <= 96) narrow.push({ el, y: r.y, x: r.left, w: r.width, h: r.height, name: nameOf(el) });
      }
      return narrow.sort((a, b) => a.y - b.y);
    },
    findRow(labelRe) {
      const re = labelRe instanceof RegExp ? labelRe : new RegExp(String(labelRe), 'i');
      return api.panelRows().find((r) => re.test(r.name)) || null;
    },
    otherRow(labelRe) {
      const ours = api.findRow(labelRe);
      return api.panelRows().find((r) => r !== ours) || null;
    },
    listenerSnapshot,
    timerSnapshot,
    fetchSnapshot,
    heap
  };
  window[KEY] = api;
  return api.snapshot();
})()
