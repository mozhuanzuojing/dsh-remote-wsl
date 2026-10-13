/**
 * p04-verify.ts —— task-40：§9.4 四项复验 + P0.4 成品截图（headless CDP，不弹可见窗口）
 *
 * 用法（node 26 原生跑 TS，无需安装）：
 *   node p04-verify.ts --url <tokenUrl> --disk <副本目录> --out <p04-final目录> --phase <integrity|shots|v1v3|v7|all>
 *
 * 设计要点
 *   · 视口用 `Emulation.setDeviceMetricsOverride`（**真改** `window.innerWidth`，与 resize_page 不同）——
 *     每个宽度都回读 `innerWidth` 作为"视口真变了"的证据。
 *   · hover 用 `CSS.forcePseudoState` 强制 `:hover`（不依赖真实的鼠标位置），读数来自 `getComputedStyle`。
 *   · chunk 一致性（契约 §11）：页面实际用过的 chunk URL 从 `performance.getEntriesByType('resource')` 取，
 *     逐条 `fetch(url, {cache:'no-store'})` 取 serve 字节 → 去掉 `sourceMappingURL` trailer → sha256，
 *     与**磁盘文件** sha256 对比。
 *   · 所有输出落盘 JSON，截图落盘 PNG；任何"拿不到"都写成 null/不可得，不猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

type Args = { url: string; disk: string; out: string; phase: string; cdpPort: string };
const argv = process.argv.slice(2);
const arg = (k: string, d?: string): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : (d ?? ''); };
const A: Args = {
  url: arg('--url'), disk: arg('--disk'), out: arg('--out', '.'), phase: arg('--phase', 'all'), cdpPort: arg('--cdp', '8965')
};
if (!A.url || !A.disk) { console.error('需要 --url 与 --disk'); process.exit(2); }
fs.mkdirSync(A.out, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

class CDP {
  ws: any; id = 0; pending = new Map<number, any>();
  wsUrl: string;
  constructor(wsUrl: string) { this.wsUrl = wsUrl; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', (e: any) => rej(new Error('ws error ' + (e?.message ?? ''))), { once: true });
    });
    this.ws.addEventListener('message', (ev: any) => {
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    });
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, 45000);
    });
  }
  async evalJs(expr: string) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result ? r.result.value : null;
  }
  close() { try { this.ws.close(); } catch {} }
}

const RAIL_CLICK = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;
const PANEL_READY = `(() => { const p = document.querySelector('[data-dsh-remote-wsl="panel"]'); return !!(p && !/正在读取|读取中/.test((p.innerText||''))); })()`;

const INITS: Record<string, string> = {
  delay: `(() => { const of = window.fetch; window.fetch = function (input, init) { try { const u = typeof input === 'string' ? input : (input && input.url) || ''; const body = init && init.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof body === 'string' && body.indexOf('explorer.snapshot') >= 0) { return new Promise((res, rej) => setTimeout(() => of.apply(window, [input, init]).then(res, rej), 4000)); } } catch (e) {} return of.apply(this, arguments); }; })();`,
  others: `(() => { const of = window.fetch; window.fetch = function (input, init) { try { const u = typeof input === 'string' ? input : (input && input.url) || ''; const body = init && init.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof body === 'string' && body.indexOf('explorer.snapshot') >= 0) { return of.apply(window, [input, init]).then((r) => r.json().then((j) => { if (j && j.ok && j.result && j.result.daemon) { j.result.daemon.others = [ { slot: 8731, pid: 944726, port: 8731, version: '0.2.0-rc.2' }, { slot: 8972, pid: 964933, port: 8972, version: '0.2.0-rc.2' } ]; } return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); })); } } catch (e) {} return of.apply(this, arguments); }; })();`
};

async function newPage(cdp: CDP, w: number, h: number, dark: boolean, init?: string) {
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  let sid: string | null = null;
  if (init) { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: init }); sid = r.identifier; }
  await cdp.send('Page.navigate', { url: A.url });
  await sleep(2600);
  if (sid) { try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch {} }
}

async function shot(cdp: CDP, file: string) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(A.out, file);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  return { file, bytes: fs.statSync(f).size };
}

const report: any = { ts: new Date().toISOString(), url: A.url.replace(/token=[^&]+/, 'token=***'), disk: A.disk, phases: {} };

const targets = await (await fetch(`http://127.0.0.1:${A.cdpPort}/json/list`)).json() as any[];
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(3); }
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.connect();

// ---------------------------------------------------------------- integrity
if (A.phase === 'integrity' || A.phase === 'all') {
  await newPage(cdp, 1280, 900, false);
  await cdp.evalJs(RAIL_CLICK);
  await sleep(2500);
  const boot = await cdp.evalJs(`(() => { try { const b = window.__DSH_BOOT__; return JSON.stringify(b).slice(0, 4000); } catch (e) { return 'ERR:' + e.message; } })()`);
  const rows = await cdp.evalJs(`(() => { const m = String(window.__DSH_BOOT__ && JSON.stringify(window.__DSH_BOOT__) || ''); const re = /\\{"id":"dsh-remote-wsl","url":"([^"]+)","rev":"([0-9a-f]+)"/g; const out = []; let x; while ((x = re.exec(m))) out.push({ url: x[1], rev: x[2] }); return JSON.stringify(out); })()`);
  // 页面实际用过的 plugins 资源（含 chunk）
  const perf = await cdp.evalJs(`(() => { const out = performance.getEntriesByType('resource').map((e)=>e.name).filter((n)=>/\\/plugins\\//.test(n)); return JSON.stringify(out); })()`);
  // 逐条：serve 字节（no-store）→ 去 trailer → sha256；与磁盘对比
  const chunks = ['client.api.js', 'client.i18n.js', 'client.icon.js', 'client.panel.js'];
  const urls = JSON.parse(perf || '[]') as string[];
  const chunkUrls: Record<string, string | null> = {};
  for (const c of chunks) chunkUrls[c] = urls.find((u) => u.includes(c)) ?? null;
  const integrity = await cdp.evalJs(`(async () => {
    const urls = ${JSON.stringify(chunkUrls)};
    const out = {};
    for (const [name, u] of Object.entries(urls)) {
      if (!u) { out[name] = { url: null, note: '页面资源里没找到该 chunk（可能未被加载）' }; continue; }
      const abs = new URL(u, location.href).href;
      const r = await fetch(abs, { cache: 'no-store' });
      const buf = new Uint8Array(await r.arrayBuffer());
      const text = new TextDecoder().decode(buf);
      const trailerMatch = text.match(/\\n\\/\\/# sourceMappingURL=[^\\n]*\\n?$/);
      const trailer = trailerMatch ? trailerMatch[0] : null;
      const body = trailer ? text.slice(0, text.length - trailer.length) : text;
      const enc = new TextEncoder();
      const digest = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))).map((b)=>b.toString(16).padStart(2,'0')).join('');
      const bodyBytes = enc.encode(body);
      let bin = ''; for (let i = 0; i < bodyBytes.length; i += 8192) { bin += String.fromCharCode.apply(null, Array.from(bodyBytes.subarray(i, i + 8192))); }
      out[name] = { url: abs.replace(/token=[^&]+/, 'token=***'), status: r.status, servedBytes: buf.length, trailerLine: trailer ? trailer.trim() : null, servedBodyBytes: bodyBytes.length, servedBodySha256: await digest(body), servedFullSha256: await digest(text), servedBodyB64: btoa(bin) };
    }
    return JSON.stringify(out);
  })()`);
  const parsed = JSON.parse(integrity || '{}');
  for (const c of chunks) {
    const diskPath = path.join(A.disk, 'client', c);
    const diskBuf = fs.readFileSync(diskPath);
    const e = parsed[c] ?? {};
    const served = e.servedBodyB64 ? Buffer.from(e.servedBodyB64, 'base64') : null;
    let cmp: any = { note: '未取到 serve 正文，无法逐字节比较' };
    if (served) {
      const isDiskExact = served.equals(diskBuf);
      const diskPlusNl = Buffer.concat([diskBuf, Buffer.from('\n')]);
      const isDiskPlusNl = served.equals(diskPlusNl);
      // 首个分歧偏移
      let div = -1;
      const n = Math.min(served.length, diskBuf.length);
      for (let i = 0; i < n; i++) { if (served[i] !== diskBuf[i]) { div = i; break; } }
      if (div === -1 && served.length !== diskBuf.length) div = n;
      cmp = {
        isDiskExact, isDiskPlusNl,
        // 契约 §11 的精确口径：「磁盘内容 == serve 内容前缀 − 一行 sourceMappingURL trailer」
        // ⇒ 判据是 **serve 正文以磁盘字节为前缀**（byte-identical prefix），余下是平台插的分隔符
        prefixMatch: served.subarray(0, diskBuf.length).equals(diskBuf),
        appendedBeforeTrailer: JSON.stringify(served.subarray(diskBuf.length).toString('utf8')),
        deltaBytes: served.length - diskBuf.length,
        firstDivergenceOffset: div,
        servedTail: JSON.stringify(served.subarray(Math.max(0, served.length - 24)).toString('utf8')),
        diskTail: JSON.stringify(diskBuf.subarray(Math.max(0, diskBuf.length - 24)).toString('utf8')),
        match: served.subarray(0, diskBuf.length).equals(diskBuf) ? 'PASS' : 'FAIL'
      };
    }
    const { servedBodyB64, ...rest } = e as any;
    parsed[c] = { ...rest, diskBytes: diskBuf.length, diskSha256: sha(diskBuf), compact: cmp };
  }
  report.phases.integrity = { entryRows: JSON.parse(rows || '[]'), pluginResourceUrls: urls.map((u) => u.replace(/token=[^&]+/, 'token=***')), chunks: parsed, bootHead: String(boot).slice(0, 600) };
}

// ---------------------------------------------------------------- shots
if (A.phase === 'shots' || A.phase === 'all') {
  const shots: any[] = [];
  for (const dark of [false, true]) {
    await newPage(cdp, 1280, 900, dark);
    await cdp.evalJs(RAIL_CLICK);
    await sleep(2500);
    shots.push(await shot(cdp, `ready-${dark ? 'dark' : 'light'}.png`));
    // 打开 ⋯ 菜单
    const opened = await cdp.evalJs(`(() => { const p = document.querySelector('[data-dsh-remote-wsl="panel"]'); const b = Array.from(p.querySelectorAll('button')).find((x)=>/更多|more/i.test((x.getAttribute('aria-label')||'')) || (x.getAttribute('aria-haspopup')==='menu')); if (!b) return 'menu-btn-not-found'; b.click(); return 'opened'; })()`);
    await sleep(500);
    shots.push(await shot(cdp, `menu-${dark ? 'dark' : 'light'}.png`));
    report.phases[`menuOpen_${dark ? 'dark' : 'light'}`] = opened;
  }
  // narrow 320
  for (const dark of [false, true]) {
    await newPage(cdp, 320, 800, dark);
    await cdp.evalJs(RAIL_CLICK);
    await sleep(2500);
    shots.push(await shot(cdp, `narrow320-${dark ? 'dark' : 'light'}.png`));
    report.phases[`narrow320_${dark ? 'dark' : 'light'}_innerWidth`] = await cdp.evalJs('window.innerWidth');
  }
  // loading（定格：延迟夹具 + 立刻截图）
  await newPage(cdp, 1280, 900, false, INITS.delay);
  await cdp.evalJs(RAIL_CLICK);
  await sleep(900);
  shots.push(await shot(cdp, 'loading.png'));
  report.phases.loadingText = await cdp.evalJs(`(() => { const p = document.querySelector('[data-dsh-remote-wsl="panel"]'); return p ? (p.innerText||'').replace(/\\s+/g,' ').slice(0,300) : null; })()`);
  // 多实例：先看真实 others[]，为空则用夹具
  await newPage(cdp, 1280, 900, false);
  await cdp.evalJs(RAIL_CLICK);
  await sleep(2000);
  const realOthers = await cdp.evalJs(`(async () => { const r = await fetch('/remote-wsl/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'explorer.snapshot', args: {} }), cache: 'no-store' }); const j = await r.json(); return JSON.stringify({ others: (j && j.result && j.result.daemon && j.result.daemon.others) || null }); })()`);
  const othersParsed = JSON.parse(realOthers || '{}');
  if (othersParsed.others && othersParsed.others.length) {
    shots.push(await shot(cdp, 'multi-instance-real.png'));
    report.phases.multiInstance = { mode: 'real', others: othersParsed.others };
  } else {
    await newPage(cdp, 1280, 900, false, INITS.others);
    await cdp.evalJs(RAIL_CLICK);
    await sleep(2200);
    shots.push(await shot(cdp, 'multi-instance-fixture.png'));
    report.phases.multiInstance = { mode: 'fixture(页面内 fetch 夹具；本机 others[] 为空：' + JSON.stringify(othersParsed.others) + ')', others: 'injected 8731/8972' };
  }
  // error-badpath：在路径输入里填一个不存在的绝对路径 → 跳转 → listDir 失败
  await newPage(cdp, 1280, 900, false);
  await cdp.evalJs(RAIL_CLICK);
  await sleep(2200);
  const bad = await cdp.evalJs(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const inp = p.querySelector('input[type="text"], input:not([type])');
    if (!inp) return 'input-not-found';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '/definitely/not/here-usab');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = Array.from(p.querySelectorAll('button')).find((b)=>/跳转/.test(b.innerText||''));
    if (!btn) return 'jump-not-found';
    btn.click();
    return 'jumped';
  })()`);
  await sleep(2500);
  shots.push(await shot(cdp, 'error-badpath.png'));
  report.phases.errorBadpath = { action: bad, text: await cdp.evalJs(`(() => { const p = document.querySelector('[data-dsh-remote-wsl="panel"]'); return p ? (p.innerText||'').replace(/\\s+/g,' ').slice(0,600) : null; })()`) };
  report.phases.shots = shots;
}

// ---------------------------------------------------------------- v1v3
if (A.phase === 'v1v3' || A.phase === 'all') {
  // V1：行内动作命中区
  await newPage(cdp, 1280, 900, false);
  await cdp.evalJs(RAIL_CLICK);
  await sleep(2500);
  // 让行内动作显现（hover 生效用 CSS.forcePseudoState，另见 v7）；先只量 rect（可能存在但透明）
  const v1 = await cdp.evalJs(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const btns = Array.from(p.querySelectorAll('button')).filter((b)=>{ const t=(b.innerText||'').trim(); return t && !/刷新|跳转|更多/.test(t) && b.getBoundingClientRect().width>0; });
    const rows = Array.from(p.querySelectorAll('[class*="row"], li, [role="listitem"]')).filter((r)=>r.getBoundingClientRect().height>0);
    const rects = btns.map((b)=>{ const r=b.getBoundingClientRect(); return { text:(b.innerText||'').trim().slice(0,30), aria:b.getAttribute('aria-label'), w:Math.round(r.width*10)/10, h:Math.round(r.height*10)/10, top:Math.round(r.top*10)/10, left:Math.round(r.left*10)/10, visibility:getComputedStyle(b).visibility, opacity:getComputedStyle(b).opacity }; });
    return JSON.stringify({ buttonCount: rects.length, rects, rowCount: rows.length });
  })()`);
  const v1p = JSON.parse(v1 || '{}');
  // 相邻净距：按 top 排序后相邻 gap
  const sorted = (v1p.rects ?? []).slice().sort((a: any, b: any) => a.top - b.top);
  const gaps: any[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push({ from: sorted[i - 1].text, to: sorted[i].text, gapPx: Math.round((sorted[i].top - (sorted[i - 1].top + sorted[i - 1].h)) * 10) / 10 });
  report.phases.v1 = { ...v1p, verticalGaps: gaps, verdictMinSize: (v1p.rects ?? []).every((r: any) => r.w >= 24 && r.h >= 24) ? 'PASS' : 'CHECK(有控件小于 24×24 或未显现)' };

  // V3：8 个宽度
  const widths = [320, 359, 360, 419, 420, 719, 720, 1280];
  const v3: any[] = [];
  await newPage(cdp, 1280, 900, false);
  await cdp.evalJs(RAIL_CLICK);
  await sleep(2500);
  for (const w of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(450);
    const m = await cdp.evalJs(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const f = p.querySelector('footer') || p.lastElementChild;
      const t = (el)=> el ? ((el.innerText||'')+'').replace(/\\s+/g,' ').trim() : null;
      const cands = Array.from(f.querySelectorAll('span,div')).filter((el)=>/远端守护|守护/.test(el.innerText||'') );
      const statusEl = cands.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0] || null;
      const fr = f.getBoundingClientRect();
      return JSON.stringify({ innerWidth: window.innerWidth, footerH: Math.round(fr.height*10)/10, footerScrollW: f.scrollWidth, footerClientW: f.clientWidth, footerScrollH: f.scrollHeight, footerClientH: f.clientHeight, noWrap: f.scrollWidth <= f.clientWidth, statusText: t(statusEl), statusScrollW: statusEl ? statusEl.scrollWidth : null, statusClientW: statusEl ? statusEl.clientWidth : null, statusNotElided: statusEl ? statusEl.scrollWidth <= statusEl.clientWidth : null, statusComputed: statusEl ? getComputedStyle(statusEl).textOverflow + '|' + getComputedStyle(statusEl).whiteSpace : null });
    })()`);
    v3.push({ requestedWidth: w, ...JSON.parse(m || '{}') });
  }
  report.phases.v3 = v3;
}

// ---------------------------------------------------------------- v7
if (A.phase === 'v7' || A.phase === 'all') {
  await newPage(cdp, 1280, 900, false);
  await cdp.evalJs(RAIL_CLICK);
  await sleep(2500);
  const res = await cdp.evalJs(`(async () => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const bg = (el)=> el ? getComputedStyle(el).backgroundColor : null;
    // 找目录列表的一行（可点行）与"当前项"
    const rows = Array.from(p.querySelectorAll('[class*="entry"],[class*="row"],li,[role="option"],[role="listitem"]')).filter((r)=>r.getBoundingClientRect().height>0);
    const current = rows.find((r)=>{ const cs=getComputedStyle(r); return parseFloat(cs.borderLeftWidth)>=2 || parseFloat(cs.fontWeight)>=600; }) || null;
    const footer = p.querySelector('footer') || p.lastElementChild;
    const footerBtn = Array.from(footer.querySelectorAll('button'))[0] || null;
    const menuBtn = Array.from(p.querySelectorAll('button')).find((b)=>b.getAttribute('aria-haspopup')==='menu') || null;
    // 强制 hover 读数（用 DOM.getDocument/querySelector + CSS.forcePseudoState 更严谨，这里先给静息读数）
    const out = {
      rowCount: rows.length,
      currentRow: current ? { tag: current.tagName.toLowerCase(), cls: String(current.className).slice(0,80), borderLeftWidth: getComputedStyle(current).borderLeftWidth, borderLeftColor: getComputedStyle(current).borderLeftColor, fontWeight: getComputedStyle(current).fontWeight, backgroundColor: getComputedStyle(current).backgroundColor } : null,
      firstRow: rows[0] ? { cls: String(rows[0].className).slice(0,80), borderLeftWidth: getComputedStyle(rows[0]).borderLeftWidth, fontWeight: getComputedStyle(rows[0]).fontWeight, backgroundColor: getComputedStyle(rows[0]).backgroundColor } : null,
      footer: { bg: bg(footer), btn: footerBtn ? { text:(footerBtn.innerText||'').trim().slice(0,20), bg: bg(footerBtn) } : null },
      menuBtn: menuBtn ? { aria: menuBtn.getAttribute('aria-label'), bg: bg(menuBtn) } : null
    };
    return JSON.stringify(out);
  })()`);
  // 用 CSS.forcePseudoState 强制 hover 三处背景，并读 hover 后背景
  const forced = await cdp.send('DOM.getDocument', {});
  const root = forced.root.nodeId;
  const hoverProbe = async (selector: string, label: string) => {
    const q = await cdp.send('DOM.querySelector', { nodeId: root, selector });
    if (!q.nodeId) return { label, selector, found: false };
    const before = await cdp.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el).backgroundColor : null; })()`);
    await cdp.send('CSS.forcePseudoState', { nodeId: q.nodeId, forcedPseudoClasses: ['hover'] });
    await sleep(150);
    const after = await cdp.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el).backgroundColor : null; })()`);
    await cdp.send('CSS.forcePseudoState', { nodeId: q.nodeId, forcedPseudoClasses: [] });
    return { label, selector, found: true, restingBg: before, hoverBg: after, changed: before !== after };
  };
  const probes: any[] = [];
  probes.push(await hoverProbe('[data-dsh-remote-wsl="panel"] footer button', '底栏按钮(sidebar-fill 底)'));
  probes.push(await hoverProbe('[aria-haspopup="menu"]', '⋯ 菜单按钮(底栏底)'));
  const firstRowSel = await cdp.evalJs(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const rs=Array.from(p.querySelectorAll('[class*="entry"],[class*="row"],li,[role="option"]')).filter((r)=>r.getBoundingClientRect().height>0); if(!rs.length) return null; const r=rs[0]; if(!r.className) return null; return '.' + String(r.className).split(' ').filter(Boolean).join('.'); })()`);
  if (firstRowSel) probes.push(await hoverProbe(firstRowSel, '目录列表行(bg-layer-1 底)'));
  report.phases.v7 = { resting: JSON.parse(res || '{}'), forcedHover: probes };
}

fs.writeFileSync(path.join(A.out, A.phase === 'all' ? 'out-p04-verify.json' : `out-p04-${A.phase}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1).slice(0, 6000));
cdp.close();
