/* perturb-snapshot.init.js —— 强制红 R3（best-effort）：在**页面内**扰动 explorer.snapshot 的 distro 列表。
 *
 * 目的是证明「面板数字跟真相源联动」这条断言有区分力 —— 不改被验对象（src/ client/ 均只读），
 * 只在页面加载前包一层网络层。
 *
 * 用 chrome-devtools-mcp navigate_page 的 initScript / cua 的 init script 注入（页面加载前执行）。
 * 拦截点（按可达性尝试，全部记录到 window.__probeX）：
 *   1) WebSocket.prototype.send / onmessage —— host.call 若走 WS JSON-RPC
 *   2) window.fetch —— 若走 HTTP
 * 扰动规则：任何 message/data 里出现 "distros" 的 JSON → 去掉最后一项，并追加一个假名字 "PERTURBED-XX"。
 *
 * 若两个拦截点都没命中（hits=0），必须在报告里写 unknown，并把 R3 退化为
 * 「抽取层掉项 + rawText 独立复核」（见 MATRIX.md §2 R3 的降级方案）。
 */
(() => {
  const X = (window.__probeX = { installedAt: new Date().toISOString(), wsSent: 0, wsRecv: 0, fetch: 0, perturbed: 0, samples: [], hits: 0 });
  const FAKE = 'PERTURBED-XX';
  const perturb = (s) => {
    try {
      const o = JSON.parse(s);
      const walk = (n) => {
        if (!n || typeof n !== 'object') return n;
        if (Array.isArray(n)) return n.map(walk);
        const out = {};
        for (const k of Object.keys(n)) {
          if (k === 'distros' && Array.isArray(n[k])) {
            const v = n[k].slice(0, Math.max(0, n[k].length - 1));
            v.push({ name: FAKE, default: false, reachable: false });
            out[k] = v; X.perturbed++; continue;
          }
          out[k] = walk(n[k]);
        }
        return out;
      };
      const r = JSON.stringify(walk(o));
      return r;
    } catch { return s; }
  };
  const looksJson = (s) => typeof s === 'string' && s.length > 2 && /[{[]/.test(s) && /distros/.test(s);

  try {
    const WS = window.WebSocket;
    if (WS) {
      const origSend = WS.prototype.send;
      WS.prototype.send = function (data) {
        X.wsSent++;
        try {
          const s = typeof data === 'string' ? data : '';
          if (looksJson(s)) { X.hits++; X.samples.push({ dir: 'send', head: s.slice(0, 200) }); return origSend.call(this, perturb(s)); }
        } catch {}
        return origSend.call(this, data);
      };
      // 收方向：包 addEventListener 与 onmessage 两种用法
      const origAdd = WS.prototype.addEventListener;
      WS.prototype.addEventListener = function (type, fn, opts) {
        if (type === 'message' && typeof fn === 'function') {
          const wrapped = function (ev) {
            X.wsRecv++;
            try {
              const s = typeof ev.data === 'string' ? ev.data : '';
              if (looksJson(s)) { X.hits++; X.samples.push({ dir: 'recv', head: s.slice(0, 200) }); const p = perturb(s); if (p !== s) return fn(new MessageEvent('message', { data: p })); }
            } catch {}
            return fn(ev);
          };
          return origAdd.call(this, type, wrapped, opts);
        }
        return origAdd.call(this, type, fn, opts);
      };
    }
  } catch (e) { X.wsError = String(e); }

  try {
    const of = window.fetch;
    window.fetch = async function (...args) {
      X.fetch++;
      const res = await of.apply(this, args);
      try {
        const ct = res.headers.get('content-type') || '';
        if (/json/i.test(ct)) {
          const txt = await res.clone().text();
          if (looksJson(txt)) { X.hits++; const p = perturb(txt); return new Response(p, { status: res.status, statusText: res.statusText, headers: res.headers }); }
        }
      } catch {}
      return res;
    };
  } catch (e) { X.fetchError = String(e); }
  return X;
})()
