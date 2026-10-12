/* usab-instrument.js —— 页面内探针：客观计数（M1 动作数 / M6 真实请求）。
 *
 * 用法（chrome-devtools-mcp evaluate_script 的 function 参数，原样粘贴，**可重复调用**）：
 *   第 1 次调用：安装探针（true 捕获阶段监听 click/keydown + 包装 fetch），返回初始计数。
 *   第 2..N 次：返回累计计数 —— 与人工步骤记录（out-20-steps.txt）互相印证。
 *   `__USAB__.reset()` 可清零（在 evaluate_script 里直接写 `() => (__USAB__.reset(), __USAB__.snapshot())`）。
 *
 * 为什么要探针：任务数"动作数"必须**机器可复算**，否则"我数了 5 步"不可证伪。
 */
() => {
  if (!window.__USAB__) {
    const st = {
      installedAt: new Date().toISOString(),
      clicks: [],      // {t, target, text, title, ariaLabel, trusted}
      keys: [],        // {t, key, ctrl, meta, shift, target}
      requests: [],    // {t, method, url, body}
      errors: []       // window error / unhandledrejection
    };
    const describe = (el) => {
      if (!el) return null;
      const t = (el.tagName || '').toLowerCase();
      const text = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return {
        tag: t,
        text,
        title: el.getAttribute ? el.getAttribute('title') : null,
        ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
        cls: el.className ? String(el.className).slice(0, 120) : null,
        // 命中我们关心的控件时给出可读标识（不做判据，只做定位）
        role: el.getAttribute ? el.getAttribute('role') : null
      };
    };
    document.addEventListener(
      'click',
      (e) => {
        st.clicks.push({ t: new Date().toISOString(), target: describe(e.target), trusted: e.isTrusted === true, x: Math.round(e.clientX), y: Math.round(e.clientY) });
      },
      true
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
        st.keys.push({ t: new Date().toISOString(), key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, target: describe(e.target) });
      },
      true
    );
    // 包装 fetch：记录 UI 真实发出的请求（含请求体）——用于证明"停止 slot 有无确认""有没有 all= 类动作"
    const of = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        const method = (init && init.method) || (input && input.method) || 'GET';
        let body = (init && init.body) || null;
        if (body && typeof body !== 'string') body = '[non-string]';
        st.requests.push({ t: new Date().toISOString(), method, url: String(url), body: body === null ? null : String(body).slice(0, 800) });
      } catch (e) {
        st.requests.push({ t: new Date().toISOString(), method: '?', url: '?', body: 'hook-error:' + String(e) });
      }
      return of.apply(this, arguments);
    };
    window.addEventListener('error', (e) => st.errors.push({ t: new Date().toISOString(), kind: 'error', message: String(e.message).slice(0, 400) }));
    window.addEventListener('unhandledrejection', (e) => st.errors.push({ t: new Date().toISOString(), kind: 'rejection', message: String((e.reason && e.reason.message) || e.reason).slice(0, 400) }));
    st.reset = () => { st.clicks.length = 0; st.keys.length = 0; st.requests.length = 0; st.errors.length = 0; st.installedAt = new Date().toISOString(); };
    st.snapshot = () => ({
      schema: 'usab-instrument/1',
      installedAt: st.installedAt,
      now: new Date().toISOString(),
      clickCount: st.clicks.length,
      keyCount: st.keys.length,
      // 只统计"有语义的键"（可打印字符按 1 次动作计，与矩阵口径一致）
      printableKeyCount: st.keys.filter((k) => k.key && k.key.length === 1).length,
      specialKeys: st.keys.filter((k) => k.key && k.key.length > 1).map((k) => k.key),
      clicks: st.clicks,
      keys: st.keys,
      requests: st.requests,
      errors: st.errors
    });
    window.__USAB__ = st;
  }
  return window.__USAB__.snapshot();
}
