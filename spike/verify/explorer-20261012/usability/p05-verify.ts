/**
 * p05-verify.ts —— task-50：UX 残余项复验（V3 八宽度 / V7+M17 两主题×三背景 / N3 展开态 / M6·M7·M10·M11·M12④）
 * 前置证明（integrity）另跑：tools/check-client-rev.mjs + 页面 chunk == 磁盘 chunk（9 chunk）
 *
 * 用法：node p05-verify.ts --url <tokenUrl> --disk <%TEMP%副本> --out <p05-final> --phase <p>
 *   phase: integrity | probe | v3 | v7 | n3 | m6 | m7 | m10 | m11 | m12 | all
 * 纪律：headless Chrome + CDP；Emulation.setDeviceMetricsOverride 真改 innerWidth 并逐宽度回读
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const DISK = arg('--disk'); const OUT = arg('--out', '.'); const PHASE = arg('--phase', 'probe'); const CDP_PORT = arg('--cdp', '8965');
if (!URL_) { console.error('need --url'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

class C {
  ws: any; id = 0; pending = new Map<number, any>(); wsUrl: string;
  constructor(u: string) { this.wsUrl = u; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((res, rej) => { this.ws.addEventListener('open', () => res(), { once: true }); this.ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
    this.ws.addEventListener('message', (ev: any) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 40000); });
  }
  async ev(expr: string) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 240)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}

const RAIL = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;
const INITS: Record<string, string> = {
  // 加载态定格：snapshot 延迟 4s
  delay: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; const b = n && n.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof b === 'string' && b.indexOf('explorer.snapshot') >= 0) { return new Promise((res, rej) => setTimeout(() => of.apply(window, [i, n]).then(res, rej), 4000)); } } catch (e) {} return of.apply(this, arguments); }; })();`,
  // 错误态：路由 reject
  error: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; if (String(u).indexOf('/remote-wsl/api') >= 0) return Promise.reject(new TypeError('usab-injected: 路由不可达')); } catch (e) {} return of.apply(this, arguments); }; })();`,
  // 空态：distros 空
  empty: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; const b = n && n.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof b === 'string' && b.indexOf('explorer.snapshot') >= 0) { const p = { ok: true, result: { distros: [], workspaces: [], target: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g/project/dsh1' }, daemon: { running: false, keys: [], orphans: 0, others: [] }, drift: { drifted: false }, webHosts: [] } }; return Promise.resolve(new Response(JSON.stringify(p), { status: 200, headers: { 'content-type': 'application/json' } })); } } catch (e) {} return of.apply(this, arguments); }; })();`,
  // 多实例（非冲突）：别人的槽位
  othersOther: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; const b = n && n.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof b === 'string' && b.indexOf('explorer.snapshot') >= 0) { return of.apply(window, [i, n]).then((r) => r.json().then((j) => { if (j && j.ok && j.result && j.result.daemon) { j.result.daemon.others = [{ slot: 8731, pid: 944726, port: 8731, version: '0.2.0-rc.2' }, { slot: 8972, pid: 964933, port: 8972, version: '0.2.0-rc.2' }]; } return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); })); } } catch (e) {} return of.apply(this, arguments); }; })();`,
  // 多实例（真冲突）：与本实例同槽位
  othersConflict: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; const b = n && n.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof b === 'string' && b.indexOf('explorer.snapshot') >= 0) { return of.apply(window, [i, n]).then((r) => r.json().then((j) => { if (j && j.ok && j.result && j.result.daemon) { j.result.daemon.others = [{ slot: j.result.daemon.slot ?? 8962, pid: 111111, port: j.result.daemon.slot ?? 8962, version: '0.2.0-rc.2' }]; } return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); })); } } catch (e) {} return of.apply(this, arguments); }; })();`
};

async function load(cdp: C, w = 1280, h = 900, dark = false, init?: string, opts: { openPanel?: boolean; settle?: number } = {}) {
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  let sid: string | null = null;
  if (init) { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: init }); sid = r.identifier; }
  await cdp.send('Page.navigate', { url: URL_ }); await sleep(2600);
  if (sid) { try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch {} }
  if (opts.openPanel !== false) { await cdp.ev(RAIL); await sleep(opts.settle ?? 2400); }
}
async function shot(cdp: C, f: string) { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); const p = path.join(OUT, f); fs.writeFileSync(p, Buffer.from(r.data, 'base64')); return { file: f, bytes: fs.statSync(p).size }; }
async function forceHover(cdp: C, selector: string, on: boolean) {
  const doc = await cdp.send('DOM.getDocument', {});
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!q.nodeId) return false;
  await cdp.send('CSS.forcePseudoState', { nodeId: q.nodeId, forcedPseudoClasses: on ? ['hover'] : [] });
  return true;
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(3); }
const cdp = new C(page.webSocketDebuggerUrl); await cdp.connect();
const rep: any = { ts: new Date().toISOString(), phase: PHASE, url: URL_.replace(/token=[^&]+/, 'token=***') };

// ------------------------------------------------------------------ integrity
if (PHASE === 'integrity') {
  await load(cdp, 1280, 900, false);
  const rows = await cdp.ev(`(() => { const m = String(window.__DSH_BOOT__ && JSON.stringify(window.__DSH_BOOT__) || ''); const re = /\\{"id":"dsh-remote-wsl","url":"([^"]+)","rev":"([0-9a-f]+)"/g; const o = []; let x; while ((x = re.exec(m))) o.push({ url: x[1], rev: x[2] }); return JSON.stringify(o); })()`);
  const perf = await cdp.ev(`(() => JSON.stringify(performance.getEntriesByType('resource').map((e)=>e.name).filter((n)=>/\\/plugins\\/dsh-remote-wsl\\//.test(n))))()`);
  const urls = JSON.parse(perf || '[]') as string[];
  const fetches = await cdp.ev(`(async () => { const list = ${JSON.stringify(urls)}; const out = {}; for (const u of list) { const abs = new URL(u, location.href).href; const r = await fetch(abs, { cache: 'no-store' }); const buf = new Uint8Array(await r.arrayBuffer()); const text = new TextDecoder().decode(buf); const m = text.match(/\\n\\/\\/# sourceMappingURL=[^\\n]*\\n?$/); const body = m ? text.slice(0, text.length - m[0].length) : text; const enc = new TextEncoder(); const bb = enc.encode(body); let bin = ''; for (let i = 0; i < bb.length; i += 8192) bin += String.fromCharCode.apply(null, Array.from(bb.subarray(i, i + 8192))); const name = abs.split('/').pop().split('?')[0]; out[name] = { url: abs, status: r.status, servedBytes: buf.length, trailer: m ? m[0].trim() : null, bodyB64: btoa(bin) }; } return JSON.stringify(out); })()`);
  const parsed = JSON.parse(fetches || '{}');
  const cmp: any = {};
  for (const [name, v] of Object.entries(parsed) as any) {
    const diskPath = path.join(DISK, 'client', name);
    if (!fs.existsSync(diskPath)) { cmp[name] = { note: '磁盘无此文件', served: (v as any).servedBytes }; continue; }
    const diskBuf = fs.readFileSync(diskPath);
    const served = Buffer.from((v as any).bodyB64, 'base64');
    cmp[name] = { servedBytes: (v as any).servedBytes, diskBytes: diskBuf.length, appended: JSON.stringify(served.subarray(diskBuf.length).toString('utf8')), prefixMatch: served.subarray(0, diskBuf.length).equals(diskBuf) ? 'PASS' : 'FAIL', diskSha256: sha(diskBuf).slice(0, 16), trailer: (v as any).trailer };
  }
  rep.integrity = { entryRows: JSON.parse(rows || '[]'), chunkCount: urls.length, chunks: cmp, allPass: Object.values(cmp).every((c: any) => c.prefixMatch === 'PASS') };
}

// ------------------------------------------------------------------ probe
if (PHASE === 'probe') {
  await load(cdp, 1280, 900, false);
  rep.probe = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const t = (el)=> el ? ((el.innerText||'')+'').replace(/\\s+/g,' ').trim() : null;
    const classes = {}; Array.from(p.querySelectorAll('*')).forEach((el)=>{ String(el.className||'').split(/\\s+/).filter((c)=>c.startsWith('dsh-rw-')).forEach((c)=>{ classes[c]=(classes[c]||0)+1; }); });
    const dts = Array.from(p.querySelectorAll('details')).map((d)=>({ cls:String(d.className).slice(0,50), open:d.open, summary:t(d.querySelector('summary')), contentLen:(d.innerText||'').length }));
    return JSON.stringify({ panelTag: p.tagName.toLowerCase(), text: t(p).slice(0,1200), classes: Object.keys(classes).sort(), details: dts, lsKeys: Object.keys(localStorage) });
  })()`));
}

// ------------------------------------------------------------------ V3
if (PHASE === 'v3') {
  await load(cdp, 1280, 900, false);
  const widths = [320, 359, 360, 419, 420, 719, 720, 1280];
  rep.v3 = [];
  for (const w of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(420);
    rep.v3.push(JSON.parse(await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const all = Array.from(p.querySelectorAll('*'));
      const st = all.filter((el)=>/^远端守护(运行中|未运行|状态未知)$/.test(((el.innerText||'')+'').trim()) && el.children.length===0)[0] || null;
      let f = st; while (f && f.parentElement && f.parentElement !== p) f = f.parentElement;
      const kids = f ? Array.from(f.children).filter((k)=>k.getBoundingClientRect().width>0) : [];
      const info = kids.map((k)=>{ const r=k.getBoundingClientRect(); return { tag:k.tagName.toLowerCase(), text:((k.innerText||'')+'').trim().slice(0,22), w:Math.round(r.width), h:Math.round(r.height), centerY:Math.round((r.top+r.height/2)*10)/10 }; });
      const centers = Array.from(new Set(info.map((i)=>Math.round(i.centerY))));
      const menus = all.filter((el)=>el.tagName==='BUTTON' && el.getAttribute('aria-haspopup')==='menu');
      const mr = menus[0] ? menus[0].getBoundingClientRect() : null;
      return JSON.stringify({ requestedWidth: ${w}, innerWidth: window.innerWidth, footerH: f ? Math.round(f.getBoundingClientRect().height*10)/10 : null, footerScrollW: f?f.scrollWidth:null, footerClientW: f?f.clientWidth:null, childCount: info.length, distinctCenters: centers.length, singleLine: centers.length<=1, statusText: st ? ((st.innerText||'')+'').trim() : null, statusScrollW: st?st.scrollWidth:null, statusClientW: st?st.clientWidth:null, statusNotElided: st ? st.scrollWidth<=st.clientWidth : null, menuBtnCount: menus.length, menuBtnRect: mr?[Math.round(mr.width),Math.round(mr.height)]:null, children: info });
    })()`)));
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(400);
  rep.shot320 = await shot(cdp, 'v3-320-footer.png');
}

// ------------------------------------------------------------------ V7 + M17（两主题 × 三背景 + 形状通道 + 强制静息填充）
if (PHASE === 'v7') {
  rep.v7 = [];
  for (const dark of [false, true]) {
    await load(cdp, 1280, 900, dark);
    const read = async () => JSON.parse(await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const cur = p.querySelector('.dsh-rw-crumb--current, .dsh-rw-current');
      const cs = cur ? getComputedStyle(cur) : null;
      const foot = p.querySelector('footer'); const fbtn = foot ? Array.from(foot.querySelectorAll('button'))[0] : null;
      const menuBtn = p.querySelector('[aria-haspopup="menu"]');
      const row = p.querySelector('.dsh-rw-row');
      const bg = (el)=> el ? getComputedStyle(el).backgroundColor : null;
      return JSON.stringify({
        theme: getComputedStyle(document.documentElement).colorScheme,
        current: cur ? { cls: String(cur.className).slice(0,60), borderLeftWidth: cs.borderLeftWidth, borderLeftColor: cs.borderLeftColor, fontWeight: cs.fontWeight, bg: cs.backgroundColor } : null,
        footerBtn: fbtn ? { text:(fbtn.innerText||'').trim().slice(0,16), bg: bg(fbtn) } : null,
        menuBtn: menuBtn ? { bg: bg(menuBtn) } : null,
        row: row ? { cls: String(row.className).slice(0,40), bg: bg(row) } : null
      });
    })()`));
    const resting = await read();
    const probes: any[] = [];
    for (const [sel, label] of [['footer button', '底栏按钮'], ['[aria-haspopup="menu"]', '⋯ 菜单按钮'], ['.dsh-rw-row', '目录列表行']] as [string, string][]) {
      const before = await cdp.ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); return el?getComputedStyle(el).backgroundColor:null; })()`);
      const ok = await forceHover(cdp, sel, true);
      await sleep(160);
      const after = await cdp.ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); return el?getComputedStyle(el).backgroundColor:null; })()`);
      await forceHover(cdp, sel, false);
      probes.push({ label, sel, found: ok, restingBg: before, hoverBg: after, changed: before !== after });
    }
    // "强制置静息填充后仍可分辨"：把当前项的 background 钉成透明/静息色，再读竖条与字重
    const forced = JSON.parse(await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const cur = p.querySelector('.dsh-rw-crumb--current, .dsh-rw-current');
      if (!cur) return JSON.stringify({ found:false });
      const s = document.createElement('style'); s.id='usab-force-resting';
      s.textContent = '.dsh-rw-crumb--current,.dsh-rw-current{background:none !important;background-color:transparent !important}';
      document.head.appendChild(s);
      const cs = getComputedStyle(cur);
      return JSON.stringify({ found:true, bgForced: cs.backgroundColor, borderLeftWidth: cs.borderLeftWidth, fontWeight: cs.fontWeight, distinguishableWithoutFill: parseFloat(cs.borderLeftWidth)>=2 && parseInt(cs.fontWeight,10)>=600 });
    })()`));
    await cdp.ev(`(() => { const s=document.getElementById('usab-force-resting'); if(s) s.remove(); return true; })()`);
    await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const b=p.querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return true; })()`);
    await sleep(500);
    const menu = JSON.parse(await cdp.ev(`(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const groups = Array.from(document.querySelectorAll('[role="group"]'));
      const pop = document.querySelector('[role="menu"]');
      const popBg = pop ? getComputedStyle(pop).backgroundColor : null;
      const lab = groups.map((g)=>{ const id=g.getAttribute('aria-labelledby'); const el = id ? document.getElementById(id) : null; return el ? { text:(el.innerText||'').trim(), color:getComputedStyle(el).color } : { text:(g.getAttribute('aria-label')||''), color:null }; });
      return JSON.stringify({ itemCount: items.length, itemColors: items.map((el)=>({ text:(el.innerText||'').trim().slice(0,20), color:getComputedStyle(el).color })), groupCount: groups.length, groupLabels: lab, popBg });
    })()`));
    rep.v7.push({ dark, resting, probes, forced, menu });
    rep[`shot_menu_${dark ? 'dark' : 'light'}`] = await shot(cdp, `v7-menu-${dark ? 'dark' : 'light'}.png`);
  }
}

// ------------------------------------------------------------------ N3 展开态
if (PHASE === 'n3') {
  await load(cdp, 1280, 900, false);
  // 触发列表错误（坏路径）
  const act = await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const inp = p.querySelector('input[type="text"], input:not([type])');
    if (!inp) return 'input-not-found';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '/definitely/not/here-usab'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    const b = Array.from(p.querySelectorAll('button')).find((x)=>/跳转/.test(x.innerText||'')); if (!b) return 'jump-not-found'; b.click(); return 'jumped';
  })()`);
  await sleep(2500);
  const closed = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const ds = Array.from(p.querySelectorAll('details'));
    return JSON.stringify({ detailCount: ds.length, list: ds.map((d)=>({ open:d.open, summary:(d.querySelector('summary')?.innerText||'').trim().slice(0,40), innerTextLen:(d.innerText||'').length, contentChildCount: d.children.length })), panelText: (p.innerText||'').replace(/\\s+/g,' ').slice(0,400) });
  })()`));
  const opened = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const d = Array.from(p.querySelectorAll('details')).find((x)=>/技术细节|host|原文/i.test((x.querySelector('summary')?.innerText||''))) || p.querySelector('details');
    if (!d) return JSON.stringify({ found:false });
    d.open = true;
    const before = p.getBoundingClientRect();
    const body = d.querySelector('div,pre') || d;
    const main = p.querySelector('[class*="note"], [role="status"], [class*="error"]');
    return JSON.stringify({ found:true, open: d.open, summary:(d.querySelector('summary')?.innerText||'').trim().slice(0,40), contentText:(body.innerText||'').replace(/\\s+/g,' ').slice(0,600), contentLen:(body.innerText||'').length, contentRect:(()=>{const r=body.getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)];})(), panelH: Math.round(before.height), mainSentence: main ? ((main.innerText||'').replace(/\\s+/g,' ').trim().slice(0,200)) : null });
  })()`));
  await sleep(400);
  rep.n3 = { action: act, closed, opened, shot: await shot(cdp, 'n3-details-open.png') };
  // 单分隔符（N5）顺带核
  rep.n5 = await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const t=(p.innerText||'').replace(/\\s+/g,' '); return JSON.stringify({ doubleSeparator: /·\\s*·/.test(t), sample: t.match(/.{0,40}·\\s*·.{0,40}/)?.[0] ?? null }); })()`);
}

// ------------------------------------------------------------------ M6
if (PHASE === 'm6') {
  await load(cdp, 1280, 900, false, INITS.delay);
  await cdp.ev(RAIL); await sleep(900);
  const loading = JSON.parse(await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const t=(p.innerText||'').replace(/\\s+/g,' '); return JSON.stringify({ text:t.slice(0,300), hasFalseFailure: /失败|已撤下|数据不可用/.test(t) }); })()`));
  await load(cdp, 1280, 900, false, INITS.error);
  await sleep(1200);
  const errorState = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const t = (p.innerText||'').replace(/\\s+/g,' ');
    const rows = p.querySelectorAll('.dsh-rw-row').length;
    const hasDaemonFact = /远端守护(运行中|未运行)/.test(t);
    const retry = Array.from(p.querySelectorAll('button')).some((b)=>/重试/.test(b.innerText||'') || /重试/.test(b.getAttribute('aria-label')||''));
    return JSON.stringify({ text:t.slice(0,300), entryRows: rows, daemonFactShown: hasDaemonFact, retryPresent: retry, verdict: (!hasDaemonFact && retry) ? 'PASS(事实撤下+有重试)' : 'CHECK' });
  })()`));
  rep.m6 = { loading, errorState, verdict: (!loading.hasFalseFailure) ? 'PASS(加载态无失败文案)' : 'FAIL' };
}

// ------------------------------------------------------------------ M7
if (PHASE === 'm7') {
  await load(cdp, 1280, 900, false, INITS.empty);
  await sleep(1000);
  rep.m7 = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const t = (p.innerText||'').replace(/\\s+/g,' ');
    const cand = Array.from(p.querySelectorAll('div,section')).filter((el)=>/没有发现 WSL 发行版|没有返回任何发行版/.test(el.innerText||''));
    const box = cand.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0] || null;
    const btns = box ? Array.from(box.querySelectorAll('button')).map((b)=>((b.innerText||'')+'').trim().slice(0,20)) : [];
    return JSON.stringify({ text:t.slice(0,300), emptyBoxFound: !!box, emptyBoxButtons: btns, verdict: btns.length >= 1 ? 'PASS(空态有可点下一步)' : 'FAIL(空态无下一步)' });
  })()`));
}

// ------------------------------------------------------------------ M10
if (PHASE === 'm10') {
  const run = async (init: string) => {
    await load(cdp, 1280, 900, false, init); await sleep(1000);
    return JSON.parse(await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const clone = p.cloneNode(true); clone.querySelectorAll('details').forEach((d)=>d.remove());
      const main = ((clone.innerText||'')+'').replace(/\\s+/g,' ');
      const slotHits = main.match(/slot\\s*\\d+/gi) || [];
      const banner = /检测到另一个实例|同一槽位/.test(main) ? (main.match(/.{0,30}检测到另一个实例.{0,40}/)?.[0] ?? 'yes') : null;
      const otherBtns = Array.from(p.querySelectorAll('button')).filter((b)=>{ const s=(b.innerText||'')+(b.getAttribute('aria-label')||'')+(b.getAttribute('title')||''); return /8731|8972|其它|其他/.test(s); }).map((b)=>(b.innerText||'').trim().slice(0,20));
      return JSON.stringify({ mainSightSlotHits: slotHits, mainSightHasSlot: slotHits.length>0, conflictBanner: banner, buttonsTouchingOtherSlots: otherBtns, mainText: main.slice(0,400) });
    })()`));
  };
  rep.m10 = { nonConflict: await run(INITS.othersOther), conflict: await run(INITS.othersConflict) };
}

// ------------------------------------------------------------------ M11
if (PHASE === 'm11') {
  await load(cdp, 1280, 900, false);
  rep.m11 = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const ds = Array.from(p.querySelectorAll('details'));
    if (!ds.length) return JSON.stringify({ found:false });
    const d = ds[0];
    d.open = false;
    const closedFocusables = Array.from(d.querySelectorAll('button,a[href],input,select,[tabindex]')).filter((el)=>el.tabIndex >= 0 && el.getBoundingClientRect().width>0).length;
    const closedHidden = /hidden|none/.test(getComputedStyle(d.querySelector('div') || d).display);
    d.open = true;
    const openFocusables = Array.from(d.querySelectorAll('button,a[href],input,select,[tabindex]')).filter((el)=>el.tabIndex >= 0 && el.getBoundingClientRect().width>0).length;
    return JSON.stringify({ found:true, closedFocusables, closedContentDisplay: getComputedStyle(d.querySelector('div')||d).display, openFocusables, verdict: closedFocusables===0 ? 'PASS(收起时内部不可聚焦)' : 'FAIL' });
  })()`));
}

// ------------------------------------------------------------------ M12④
if (PHASE === 'm12') {
  await load(cdp, 1280, 900, false);
  const key = await cdp.ev(`(() => { const k = Object.keys(localStorage).find((x)=>/recent/i.test(x)); return k ?? null; })()`);
  const cleared = JSON.parse(await cdp.ev(`(() => {
    if (${JSON.stringify(key)} !== null) localStorage.setItem(${JSON.stringify(key)}, '[]');
    return JSON.stringify({ key: ${JSON.stringify(key)}, lsKeys: Object.keys(localStorage) });
  })()`));
  await load(cdp, 1280, 900, false);
  const after = JSON.parse(await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const t = (p.innerText||'').replace(/\\s+/g,' ');
    const rec = Array.from(p.querySelectorAll('*')).filter((el)=>/最近目录/.test((el.innerText||'')) && el.children.length<=2)[0] || null;
    const box = rec ? (rec.parentElement || rec) : null;
    return JSON.stringify({ hasRecentSection: /最近目录/.test(t), emptyHintPresent: /还没有最近目录|无最近目录|暂无/.test(t), recentBlockText: box ? ((box.innerText||'').replace(/\\s+/g,' ').trim().slice(0,120)) : null, note: 'recent 分区在折叠区内，未展开时可能不渲染' });
  })()`));
  rep.m12 = { key, cleared, after };
}

fs.writeFileSync(path.join(OUT, `out-p05-${PHASE}.json`), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep, null, 1).slice(0, 4500));
cdp.close();
