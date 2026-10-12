/* probe-stale.js —— 测项③：状态漂移（守护 idle 回收 / kill / 重启后界面是否停在陈旧值、多久自愈）。
 *
 * 依赖：instrument.js（rawFetch 做"地面真相"取数，绕过夹具/闸门）。
 * 关键纪律：
 *   - **前置**：开始采样前守护必须**确实在跑**（daemon.pid 非空），否则会得到 "not running == not running"
 *     的空集假绿（MATRIX §2 ③ 假绿①）；
 *   - 三层对照：面板 DOM / `POST /remote-wsl/api`（rawFetch）/ 宿主侧 `wsl_status`（由 runner 落盘）；
 *   - kill/restart 由 **runner（PowerShell）**对我的 8982 槽位执行，探针只负责采样与打点
 *     （`markEvent('daemon-stop')`），从而能算出 T_stale / T_selfheal / T_refresh。
 */
async ({ apiPath = '/remote-wsl/api', labelRe = '远程资源管理器|remote-wsl', sampleMs = 5000, durationMs = 120000 } = {}) => {
  const instr = window.__dsrw_instr__;
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
      await sleep(25);
    }
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const findOurs = () => {
    const re = new RegExp(labelRe, 'i');
    for (const el of Array.from(document.querySelectorAll('[class*="panelList"] button,[class*="panelList"] [role="button"],[class*="panelList"] [role="tab"]'))) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const name = [el.getAttribute('aria-label'), el.getAttribute('title'), (el.innerText || '').trim()].filter(Boolean).join(' ');
        if (re.test(name)) return { el, name };
      }
    }
    return null;
  };

  /** 地面真相：绕过包装层直接 POST（不受夹具/闸门影响） */
  const groundTruth = async () => {
    const t0 = now();
    try {
      const res = await instr.rawFetch(apiPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ method: 'explorer.snapshot', args: {} })
      });
      const txt = await res.text();
      let json = null;
      try {
        json = JSON.parse(txt);
      } catch {}
      const d = json && json.ok === true && json.result ? json.result.daemon : null;
      return {
        ok: json ? json.ok === true : false,
        httpStatus: res.status,
        ms: Math.round(now() - t0),
        daemon: d ? { running: d.running, slot: d.slot, pid: d.pid, version: d.version, keys: Array.isArray(d.keys) ? d.keys.length : null } : null,
        rawHead: txt.slice(0, 300),
        error: null
      };
    } catch (e) {
      return { ok: false, httpStatus: null, ms: Math.round(now() - t0), daemon: null, error: String(e && e.message ? e.message : e) };
    }
  };

  const panelDaemon = () => {
    const st = instr.panelState();
    const line = st.statusText ? st.statusText.text : null;
    const pid = line ? (line.match(/pid\s+(\d+)/) || [])[1] || null : null;
    const ver = line ? (line.match(/·\s*(v[\w.\-]+)/) || [])[1] || null : null;
    const keys = line ? (line.match(/keys\s+(\d+)/) || [])[1] || null : null;
    return {
      present: st.present,
      line,
      running: line === null ? null : !/未运行/.test(line) && /daemon/.test(line),
      pid: pid ? Number(pid) : null,
      version: ver,
      keys: keys ? Number(keys) : null,
      snapshotBadge: st.loadedBadge,
      loadingHint: st.loadingHint,
      errorVisible: st.errorVisible
    };
  };

  const sampleOnce = async () => {
    const panel = panelDaemon();
    const gt = await groundTruth();
    return { at: Math.round(now()), iso: new Date().toISOString(), panel, groundTruthApi: gt };
  };

  const S = { schema: 'dsrw-stale/1', installedAt: new Date().toISOString(), events: [], samples: [], running: false, done: false, error: null, refreshProbe: null };

  const open = async () => {
    const ours = findOurs();
    if (!ours) return { ok: false, error: 'rail-item-not-found' };
    if (document.querySelector(PANEL) === null) {
      ours.el.click();
      const r = await waitFor(() => document.querySelector(PANEL) !== null, 4000);
      if (!r.ok) return { ok: false, error: 'panel-did-not-appear', ms: r.ms };
    }
    await sleep(300); // 让首拉完成
    return { ok: true, panel: panelDaemon() };
  };

  const markEvent = (label, extra) => {
    const e = { label: String(label), at: Math.round(now()), iso: new Date().toISOString(), extra: extra || null };
    S.events.push(e);
    instr.mark('stale:' + e.label);
    return e;
  };

  /** 手动刷新自愈：点一次刷新，测"面板文本变化"的时延 */
  const clickRefresh = async ({ timeoutMs = 8000, textOf = null } = {}) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /刷新/.test((b.textContent || '').trim()));
    if (!btn) return { ok: false, error: 'refresh-button-not-found' };
    const pick = textOf || (() => {
      const p = panelDaemon();
      return [p.line, p.snapshotBadge].join('|');
    });
    const before = pick();
    const t0 = now();
    btn.click();
    const changed = await waitFor(() => pick() !== before, timeoutMs);
    const after = pick();
    const res = { ok: changed.ok, latencyMs: changed.ms, before, after, changed: before !== after, timeoutMs };
    S.refreshProbe = res;
    return res;
  };

  const start = async (opts = {}) => {
    if (S.running) return { ok: false, error: 'already-running' };
    Object.assign(S, { sampleMs: opts.sampleMs || sampleMs, durationMs: opts.durationMs || durationMs });
    S.running = true;
    S.done = false;
    S.samples = [];
    S.error = null;
    const opened = await open();
    if (!opened.ok) {
      S.running = false;
      S.error = 'open-failed:' + opened.error;
      return { ok: false, error: S.error };
    }
    markEvent('sample-start');
    (async () => {
      try {
        const t0 = now();
        while (now() - t0 < S.durationMs) {
          S.samples.push(await sampleOnce());
          await sleep(S.sampleMs);
        }
      } catch (e) {
        S.error = String(e && e.message ? e.message : e);
      } finally {
        S.done = true;
        S.running = false;
        markEvent('sample-end');
      }
    })();
    return { ok: true, ack: { sampleMs: S.sampleMs, durationMs: S.durationMs, opened } };
  };

  window.__dsrw_stale__ = {
    open,
    start,
    markEvent,
    sampleOnce,
    clickRefresh,
    panelDaemon,
    groundTruth,
    status: () => ({
      schema: S.schema,
      installedAt: S.installedAt,
      running: S.running,
      done: S.done,
      error: S.error,
      sampleMs: S.sampleMs,
      durationMs: S.durationMs,
      events: S.events,
      samples: S.samples,
      refreshProbe: S.refreshProbe,
      now: Math.round(now())
    })
  };
  return { ok: true, installed: true, api: Object.keys(window.__dsrw_stale__), opened: await open() };
}
