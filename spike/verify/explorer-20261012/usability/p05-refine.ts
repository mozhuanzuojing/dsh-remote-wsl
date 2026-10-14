/**
 * p05-refine.ts —— task-50 定向补测（API 方法表 / M7 真空态 / M10 真冲突 / M11 可见性 / M12④ / N4 组标注）
 * 用法：node p05-refine.ts --url <tokenUrl> --out <dir> --phase <api|m7|m10c|m11b|m12b|n4>
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const OUT = arg('--out', '.'); const PHASE = arg('--phase', 'api'); const CDP_PORT = arg('--cdp', '8965');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class C {
  ws: any; id = 0; pending = new Map<number, any>(); wsUrl: string;
  constructor(u: string) { this.wsUrl = u; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((res, rej) => { this.ws.addEventListener('open', () => res(), { once: true }); this.ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
    this.ws.addEventListener('message', (ev: any) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  }
  send(method: string, params: any = {}): Promise<any> { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 40000); }); }
  async ev(e: string) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}
const RAIL = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;

// 夹具：listDir 返回空 entries / daemon 真冲突（running=true 且 others 同槽位）
const INITS: Record<string, string> = {
  log: `(() => { window.__P05LOG__ = []; const of = window.fetch; window.fetch = function (i, n) { try { const b = n && n.body; if (typeof b === 'string') window.__P05LOG__.push({ body: b.slice(0, 200), t: Date.now() }); } catch (e) {} return of.apply(this, arguments).then((r) => { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof (n && n.body) === 'string') { const j = JSON.parse(n.body); r.clone().json().then((jj) => { window.__P05LOG__.push({ method: j.method, args: j.args, respKeys: jj && jj.result ? Object.keys(jj.result) : (jj && jj.methods ? ['methods'] : Object.keys(jj || {})) }); }).catch(() => {}); } } catch (e) {} return r; }); })();`,
  emptyDir: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const b = n && n.body; if (typeof b === 'string' && /listDir|listdir|dir\\.list/i.test(b)) { const j = JSON.parse(b); return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { path: j.args && j.args.path, entries: [], truncated: false } }), { status: 200, headers: { 'content-type': 'application/json' } })); } } catch (e) {} return of.apply(this, arguments); }; })();`,
  conflict: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const b = n && n.body; if (typeof b === 'string' && b.indexOf('explorer.snapshot') >= 0) { return of.apply(window, [i, n]).then((r) => r.json().then((j) => { if (j && j.ok && j.result && j.result.daemon) { j.result.daemon.running = true; j.result.daemon.pid = 424242; j.result.daemon.slot = j.result.daemon.slot ?? 8962; j.result.daemon.port = j.result.daemon.slot; j.result.daemon.others = [{ slot: j.result.daemon.slot, pid: 999999, port: j.result.daemon.slot, version: '0.2.0-rc.2' }]; } return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); })); } } catch (e) {} return of.apply(this, arguments); }; })();`
};

async function load(cdp: C, init?: string, dark = false, w = 1280, h = 900, openPanel = true) {
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  let sid: string | null = null;
  if (init) { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: init }); sid = r.identifier; }
  await cdp.send('Page.navigate', { url: URL_ }); await sleep(2600);
  if (sid) { try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch {} }
  if (openPanel) { await cdp.ev(RAIL); await sleep(2400); }
}
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const cdp = new C(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await cdp.connect();
const rep: any = { ts: new Date().toISOString(), phase: PHASE };

if (PHASE === 'api') {
  await load(cdp, INITS.log);
  await sleep(1200);
  rep.api = JSON.parse(await cdp.ev(`(() => JSON.stringify(window.__P05LOG__ || []))()`));
}

if (PHASE === 'm7') {
  await load(cdp, INITS.emptyDir);
  await sleep(1200);
  rep.m7 = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const t = (el)=>el?((el.innerText||'')+'').replace(/\\s+/g,' ').trim():null;
    const body = p.querySelector('.dsh-rw-body') || p;
    const entries = body.querySelectorAll('.dsh-rw-row').length;
    const emptyHints = ['此目录为空','没有可见','隐藏文件','没有条目','空的'].filter((k)=>(body.innerText||'').includes(k));
    const btns = Array.from(body.querySelectorAll('button')).map((b)=>t(b).slice(0,18));
    return JSON.stringify({ entryRows: entries, emptyHintKeywordsFound: emptyHints, bodyText: t(body).slice(0,400), bodyButtons: btns, verdict: entries===0 ? (btns.length>0 || emptyHints.length>0 ? 'PASS(空目录有提示/可点下一步)' : 'FAIL(空目录无提示无下一步)') : 'FIXTURE-NOT-APPLIED(仍有条目)' });
  })()`));
}

if (PHASE === 'm10c') {
  await load(cdp, INITS.conflict);
  await sleep(1200);
  rep.m10c = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const clone = p.cloneNode(true); clone.querySelectorAll('details').forEach((d)=>d.remove());
    const main = ((clone.innerText||'')+'').replace(/\\s+/g,' ');
    const slot = main.match(/slot\\s*\\d+/gi) || [];
    const banner = Array.from(p.querySelectorAll('*')).find((el)=>/检测到另一个实例|同一槽位|冲突/.test(el.innerText||'') && el.children.length<=2);
    return JSON.stringify({ mainSightSlotHits: slot, bannerText: banner ? ((banner.innerText||'').replace(/\\s+/g,' ').trim().slice(0,160)) : null, footerText: (p.querySelector('.dsh-rw-status')||{}).innerText || null, verdict: slot.length===0 ? 'PASS(主视线无 slot)' : 'FAIL(主视线出现 slot)' });
  })()`));
}

if (PHASE === 'm11b') {
  await load(cdp);
  rep.m11b = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const d = p.querySelector('details.dsh-rw-fold');
    if (!d) return JSON.stringify({ found:false });
    d.open = false;
    const inner = d.querySelector('div') || d;
    const closed = { display: getComputedStyle(inner).display, h: Math.round(inner.getBoundingClientRect().height), visible: inner.getBoundingClientRect().height>0, focusables: Array.from(d.querySelectorAll('button,a[href],input,[tabindex]')).filter((e)=>e.tabIndex>=0 && e.getBoundingClientRect().height>0).length, textLen: (inner.innerText||'').trim().length };
    d.open = true;
    const opened = { display: getComputedStyle(inner).display, h: Math.round(inner.getBoundingClientRect().height), visible: inner.getBoundingClientRect().height>0, focusables: Array.from(d.querySelectorAll('button,a[href],input,[tabindex]')).filter((e)=>e.tabIndex>=0 && e.getBoundingClientRect().height>0).length, textLen: (inner.innerText||'').trim().length };
    return JSON.stringify({ found:true, summary:(d.querySelector('summary')?.innerText||'').trim(), closed, opened, verdict: (!closed.visible || closed.textLen===0) ? 'PASS(收起时不渲染/不可聚焦)' : 'CHECK(收起时内容仍可见)' });
  })()`));
}

if (PHASE === 'm12b') {
  await load(cdp);
  const cleared = await cdp.ev(`(() => { localStorage.setItem('dsh-remote-wsl.recent', '[]'); return JSON.stringify({ now: localStorage.getItem('dsh-remote-wsl.recent') }); })()`);
  await load(cdp);
  rep.m12b = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const fold = Array.from(p.querySelectorAll('details')).find((d)=>/最近目录/.test(d.querySelector('summary')?.innerText||''));
    if (!fold) return JSON.stringify({ found:false });
    const before = { open: fold.open, text: ((fold.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,120) };
    fold.open = true;
    const inner = fold.querySelector('div') || fold;
    const after = { open: fold.open, h: Math.round(inner.getBoundingClientRect().height), text: ((inner.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,200) };
    return JSON.stringify({ found:true, before, after, hintPresent: /还没有|暂无|无最近|还没有最近目录/.test(after.text), verdict: /还没有|暂无|无最近/.test(after.text) ? 'PASS(显示 recent.empty)' : (after.text.length>0 ? 'CHECK(展开后有内容但非空态提示)' : 'FAIL(空态无提示)') });
  })()`));
  rep.m12bCleared = cleared;
}

if (PHASE === 'n4') {
  await load(cdp);
  await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const b=p.querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return true; })()`);
  await sleep(600);
  rep.n4 = JSON.parse(await cdp.ev(`(() => {
    const groups = Array.from(document.querySelectorAll('[role="group"]'));
    return JSON.stringify(groups.map((g)=>{ const id=g.getAttribute('aria-labelledby'); const el=id?document.getElementById(id):null; return { ariaLabel:g.getAttribute('aria-label'), ariaLabelledby:id, targetExists: !!el, targetText: el?((el.innerText||'')+'').trim():null, groupText:((g.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,40) }; }));
  })()`));
}

fs.writeFileSync(path.join(OUT, `out-p05-refine-${PHASE}.json`), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep, null, 1).slice(0, 3000));
cdp.close();
