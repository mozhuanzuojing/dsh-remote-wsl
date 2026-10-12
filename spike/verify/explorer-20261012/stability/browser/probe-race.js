/* probe-race.js —— 测项②：快照竞态（旧响应覆盖新响应）/ 请求堆积 / loading 卡死。
 *
 * 依赖：instrument.js（记账 + 闸门）+ fixtures.js（带 marker 的合成快照）。
 * 为什么必须用 fixture：要判断"DOM 显示的是哪个请求的结果"，响应体里必须有**唯一 marker**；
 *   真实 snapshot 的 marker 只有一个（无法区分先后）。fixture 把 seq 写进
 *   `target.cwd='FIXTURE-SEQ-<n>'`（渲染在 `.dsh-rw-subtitle`）与 `daemon.version='fx-<n>'`（状态条）。
 *
 * 三条触发路径（逐个记录"是否真发出 ≥2 个并发"，<2 判 unknown，不许当"没竞态"）：
 *   T2a 同 tick 双触发：同一个任务里连发两次 click（复现用户双击 + 程序化并发）
 *   T2b 动作+刷新交叠：点"在新会话中打开"（refresh:true）与"刷新"交叠
 *   T2c 快速切换堆积：连点 rail 切走/切回，请求延迟 800ms，量在飞并发峰值
 *
 * 闸门语义：`arm({mode})` 设 instrument 的 gateFn —— 第 1 个 snapshot 请求慢、第 2 个快（inverted），
 *   或正序（forward，阴性对照 A4），或 never（卡死判定）。
 */
({ apiPath = '/remote-wsl/api', labelRe = '远程资源管理器|remote-wsl' } = {}) => {
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
  const findRefresh = () =>
    Array.from(document.querySelectorAll('button')).find((b) => /刷新/.test((b.textContent || '').trim())) || null;
  const findOpen = () =>
    Array.from(document.querySelectorAll('.dsh-rw-workspace button')).find((b) => /在新会话中打开/.test((b.textContent || '').trim())) || null;

  /** 从 DOM 读"当前显示的是哪个 seq 的结果" */
  const domMarker = () => {
    const st = instr.panelState();
    const sub = st.subtitle ? st.subtitle.text : '';
    const stat = st.statusText ? st.statusText.text : '';
    const m1 = sub.match(/FIXTURE-SEQ-(\d+)/);
    const m2 = stat.match(/\bfx-(\d+)/);
    return {
      subtitleText: sub.slice(0, 200),
      statusText: stat.slice(0, 200),
      seqFromSubtitle: m1 ? Number(m1[1]) : null,
      seqFromStatus: m2 ? Number(m2[1]) : null,
      refreshBtn: st.refreshBtn,
      loadingHint: st.loadingHint,
      errorVisible: st.errorVisible,
      retryBtn: st.retryBtn
    };
  };

  const S = { schema: 'dsrw-race/1', installedAt: new Date().toISOString(), armed: null, results: [], stuck: null, error: null, seenSeqs: [], callIndex: 0 };

  /** 闸门：按"第几个 snapshot 请求"决定延迟（相对序号，不受绝对 seq 影响） */
  const arm = ({ mode = 'inverted', slowMs = 1200, fastMs = 50 } = {}) => {
    S.seenSeqs = [];
    S.callIndex = 0;
    S.armed = { mode, slowMs, fastMs, at: Math.round(now()) };
    instr.setGateFn((seq, url) => {
      if (url.indexOf(apiPath) < 0) return 0;
      if (S.seenSeqs.indexOf(seq) < 0) {
        S.seenSeqs.push(seq);
        S.callIndex++;
      }
      const idx = S.seenSeqs.indexOf(seq) + 1;
      if (mode === 'never') return idx === 1 ? Number.POSITIVE_INFINITY : 0;
      if (mode === 'forward') return idx === 1 ? fastMs : slowMs;
      return idx === 1 ? slowMs : fastMs; // inverted（默认）
    });
    return S.armed;
  };
  const disarm = () => {
    instr.clearGate();
    S.armed = null;
    return true;
  };

  /** T2a：同一 tick 连发两次 click */
  const t2a = async ({ mode = 'inverted', settleMs = 3000 } = {}) => {
    arm({ mode });
    const btn = findRefresh();
    if (!btn) return { ok: false, error: 'refresh-button-not-found', dom: domMarker() };
    const before = instr.fetchSnapshot();
    const t0 = now();
    btn.click();
    btn.click(); // 同一个任务里第二次：若 React 尚未因 loading 禁用，就会真的发出第二个请求
    const afterClicks = instr.fetchSnapshot();
    // 等所有 api 请求交付（inverted 下慢的那个最后到）
    await waitFor(() => instr.fetchSnapshot().pendingApiCount === 0, settleMs + 4000);
    await sleep(settleMs);
    const end = instr.fetchSnapshot();
    const issued = end.apiSeqIssued - before.apiSeqIssued;
    const reqs = end.apiRequests.slice(-Math.max(issued, 1) * 2);
    const dom = domMarker();
    const lastIssued = end.lastApiSeqIssued;
    const deliveredOrder = end.apiRequests.filter((r) => r.deliveredAt !== null).map((r) => r.seq);
    const shown = dom.seqFromSubtitle !== null ? dom.seqFromSubtitle : dom.seqFromStatus;
    let verdict;
    if (issued < 2) verdict = 'not-reached'; // 没并发 ⇒ unknown，不许当"没竞态"
    else if (shown === null) verdict = 'unknown';
    else if (shown === lastIssued) verdict = 'no-stale-overwrite';
    else verdict = 'STALE-OVERWRITE'; // 显示了更早请求的结果 ⇒ 旧响应覆盖新响应
    const res = {
      path: 'T2a',
      mode,
      issuedRequests: issued,
      lastIssuedSeq: lastIssued,
      deliveredOrder,
      shownSeq: shown,
      expectedShownSeq: lastIssued,
      verdict,
      ms: Math.round(now() - t0),
      requests: reqs,
      dom,
      pendingPeakNote: 'unmount 后的残余在 T2c 里量',
      armed: S.armed
    };
    S.results.push(res);
    disarm();
    return res;
  };

  /** T2b：动作(refresh:true) 与 刷新 交叠 */
  const t2b = async ({ mode = 'inverted', settleMs = 3000 } = {}) => {
    arm({ mode });
    const open = findOpen();
    const btn = findRefresh();
    if (!open || !btn) return { ok: false, error: 'open-or-refresh-missing', hasOpen: !!open, hasRefresh: !!btn };
    const before = instr.fetchSnapshot();
    open.click(); // 触发 explorer.openSession → 成功后 refresh:true → load()
    await sleep(30);
    btn.click(); // 交叠第二个 snapshot
    await waitFor(() => instr.fetchSnapshot().pendingApiCount === 0, settleMs + 4000);
    await sleep(settleMs);
    const end = instr.fetchSnapshot();
    const issued = end.apiSeqIssued - before.apiSeqIssued;
    const dom = domMarker();
    const shown = dom.seqFromSubtitle !== null ? dom.seqFromSubtitle : dom.seqFromStatus;
    const verdict = issued < 2 ? 'not-reached' : shown === null ? 'unknown' : shown === end.lastApiSeqIssued ? 'no-stale-overwrite' : 'STALE-OVERWRITE';
    const res = { path: 'T2b', mode, issuedRequests: issued, lastIssuedSeq: end.lastApiSeqIssued, shownSeq: shown, verdict, dom, note: 'fixture 不合成 openSession（会返回 ok:false）⇒ 该路径可能拿不到 refresh:true；此时 issued 会暴露真相，不许当通过' };
    S.results.push(res);
    disarm();
    return res;
  };

  /** T2c：快速切换 20 次，量在飞峰值与卸载后残余 */
  const t2c = async ({ switches = 20, delayMs = 800 } = {}) => {
    arm({ mode: 'forward', slowMs: delayMs, fastMs: delayMs }); // 全部延迟，制造堆积
    const cands = rail();
    const ours = cands.find((c) => new RegExp(labelRe, 'i').test(c.name));
    const other = cands.find((c) => c !== ours);
    if (!ours || !other) return { ok: false, error: 'rail-missing' };
    let peak = 0;
    const timeline = [];
    ours.el.click();
    await waitFor(() => document.querySelector(PANEL) !== null, 4000);
    for (let i = 0; i < switches; i++) {
      other.el.click();
      await sleep(40);
      ours.el.click();
      const inflight = instr.fetchSnapshot().pendingApiCount;
      if (inflight > peak) peak = inflight;
      timeline.push({ i, inflight, at: Math.round(now()) });
      await sleep(40);
    }
    // 卸载并观察残余
    other.el.click();
    await waitFor(() => document.querySelector(PANEL) === null, 1500);
    await sleep(300);
    const residual = instr.fetchSnapshot().pendingApiCount;
    const res = { path: 'T2c', switches, delayMs, peakInFlight: peak, residualAfterUnmount300ms: residual, timeline, verdict: residual > 0 ? 'PILEUP-AFTER-UNMOUNT' : peak > 1 ? 'pileup-but-drained' : 'no-pileup' };
    S.results.push(res);
    disarm();
    return res;
  };

  /** 卡死：闸门 never → 点一次刷新 → 观察 loading 是否永久不退 */
  const stuck = async ({ seconds = 30, settleMs = 200 } = {}) => {
    arm({ mode: 'never' });
    const btn = findRefresh();
    if (!btn) return { ok: false, error: 'refresh-button-not-found' };
    const timeline = [];
    const t0 = now();
    btn.click();
    for (let i = 0; i * settleMs < seconds * 1000; i++) {
      await sleep(settleMs);
      const st = instr.panelState();
      timeline.push({
        t: Math.round(now() - t0),
        loadingHint: st.loadingHint,
        refresh: st.refreshBtn ? st.refreshBtn.text + (st.refreshBtn.disabled ? '(disabled)' : '') : null,
        errorVisible: st.errorVisible,
        retry: st.retryBtn ? st.retryBtn.text : null,
        pendingApi: instr.fetchSnapshot().pendingApiCount
      });
      if (i % 25 === 24 && i < 300) timeline.push({ t: Math.round(now() - t0), note: 'still-sampling' });
    }
    const last = timeline[timeline.length - 1] || {};
    const stillLoading = !!(last.loadingHint || (last.refresh && /刷新中/.test(last.refresh)));
    const noEscape = stillLoading && !last.retry && !(last.refresh && !/disabled/.test(last.refresh));
    const res = {
      path: 'stuck',
      seconds,
      verdict: stillLoading ? (noEscape ? 'LOADING-STUCK-NO-ESCAPE' : 'loading-stuck-but-has-escape') : 'loading-settled',
      timeline: timeline.filter((x) => !x.note),
      note: '闸门 never 模拟"host 永不返回"；red 判据见 MATRIX §2 ② (d)'
    };
    S.stuck = res;
    disarm();
    return res;
  };

  window.__dsrw_race__ = {
    arm,
    disarm,
    t2a,
    t2b,
    t2c,
    stuck,
    status: () => ({ schema: S.schema, armed: S.armed, armedSeqs: S.seenSeqs.slice(), results: S.results, stuck: S.stuck, error: S.error, instrument: instr.fetchSnapshot(), dom: domMarker() }),
    domMarker
  };
  return { ok: true, installed: true, api: Object.keys(window.__dsrw_race__), fixture: window.__dsrw_fx__ ? window.__dsrw_fx__.status() : null };
}
