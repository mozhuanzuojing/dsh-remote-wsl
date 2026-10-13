/**
 * p04-refine.ts —— task-40 定向补测（V1 行内动作命中区 / V3 底栏单行证明 / V7 形状通道与菜单 / #5 破坏性动作归位）
 * 用法：node p04-refine.ts --url <tokenUrl> --out <p04-final> --phase <v1|v3|v7|running>
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const OUT = arg('--out', '.'); const PHASE = arg('--phase', 'v1'); const CDP_PORT = arg('--cdp', '8965');
if (!URL_) { console.error('need --url'); process.exit(2); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  async ev(expr: string) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}

const RAIL = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;
const ready = async (c: C, w = 1280, h = 900) => {
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('DOM.enable'); await c.send('CSS.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL_ }); await sleep(2600);
  await c.ev(RAIL); await sleep(2500);
};
const forcedHover = async (c: C, selector: string, on: boolean) => {
  const doc = await c.send('DOM.getDocument', {});
  const q = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!q.nodeId) return false;
  await c.send('CSS.forcePseudoState', { nodeId: q.nodeId, forcedPseudoClasses: on ? ['hover'] : [] });
  return true;
};
const shot = async (c: C, f: string) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); const p = path.join(OUT, f); fs.writeFileSync(p, Buffer.from(r.data, 'base64')); return { file: f, bytes: fs.statSync(p).size }; };

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const cdp = new C(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await cdp.connect();
const rep: any = { ts: new Date().toISOString(), phase: PHASE };

if (PHASE === 'v1') {
  await ready(cdp, 1280, 900);
  await forcedHover(cdp, '.dsh-rw-row', true);
  await sleep(300);
  const data = await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const rows = Array.from(p.querySelectorAll('.dsh-rw-row')).filter((r)=>r.getBoundingClientRect().height>0);
    const out = { rowCount: rows.length, rowHeight: rows[0] ? Math.round(rows[0].getBoundingClientRect().height*10)/10 : null, rows: [] };
    for (const r of rows.slice(0, 3)) {
      const btns = Array.from(r.querySelectorAll('button')).map((b)=>{ const q=b.getBoundingClientRect(); const cs=getComputedStyle(b); return { aria:b.getAttribute('aria-label'), text:(b.innerText||'').trim().slice(0,20), w:Math.round(q.width*10)/10, h:Math.round(q.height*10)/10, top:Math.round(q.top*10)/10, left:Math.round(q.left*10)/10, visibility:cs.visibility, opacity:cs.opacity, display:cs.display }; });
      const rr = r.getBoundingClientRect();
      out.rows.push({ cls: String(r.className), rowRect: [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)], actionButtons: btns });
    }
    // 相邻行"命中盒"净距：用第一行与第二行 action 按钮的 top/height 之差
    if (rows.length >= 2) {
      const a = rows[0].querySelector('button'), b = rows[1].querySelector('button');
      if (a && b) { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); out.verticalNetGapBetweenRows = Math.round((rb.top - (ra.top + ra.height))*10)/10; }
    }
    // 行内相邻动作的水平净距
    if (rows[0]) {
      const bs = Array.from(rows[0].querySelectorAll('button')).map((b)=>b.getBoundingClientRect());
      out.horizontalGaps = bs.slice(1).map((r, i) => Math.round((r.left - (bs[i].left + bs[i].width))*10)/10);
    }
    return JSON.stringify(out);
  })()`);
  rep.v1 = JSON.parse(data || '{}');
  rep.v1.verdict = (rep.v1.rows ?? []).flatMap((r: any) => r.actionButtons).every((b: any) => b.w >= 24 && b.h >= 24) ? 'PASS(所有行内动作 ≥24×24)' : 'FAIL(存在 <24×24 的行内动作)';
  await forcedHover(cdp, '.dsh-rw-row', false);
  rep.shot = await shot(cdp, 'v1-row-hover-light.png');
}

if (PHASE === 'v3') {
  await ready(cdp, 1280, 900);
  const widths = [320, 359, 360, 419, 420, 719, 720, 1280];
  rep.v3 = [];
  for (const w of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(420);
    const d = await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const all = Array.from(p.querySelectorAll('*'));
      const statusEl = all.filter((el)=>/^远端守护(运行中|未运行|状态未知)$/.test(((el.innerText||'')+'').trim()) && el.children.length===0)[0] || null;
      // 真正的底栏 = 包住状态句的最近祖先，其父是面板 root
      let footer = statusEl; while (footer && footer.parentElement && footer.parentElement !== p) footer = footer.parentElement;
      const kids = footer ? Array.from(footer.children).filter((k)=>{ const r=k.getBoundingClientRect(); return r.width>0 && r.height>0; }) : [];
      const tops = Array.from(new Set(kids.map((k)=>Math.round(k.getBoundingClientRect().top))));
      const menuBtn = all.find((el)=>el.tagName==='BUTTON' && el.getAttribute('aria-haspopup')==='menu') || null;
      const mr = menuBtn ? menuBtn.getBoundingClientRect() : null;
      return JSON.stringify({ innerWidth: window.innerWidth, footerTag: footer ? footer.tagName.toLowerCase()+'.'+String(footer.className).slice(0,30) : null, footerH: footer ? Math.round(footer.getBoundingClientRect().height*10)/10 : null, childCount: kids.length, distinctChildTops: tops.length, singleLine: tops.length <= 1, statusText: statusEl ? ((statusEl.innerText||'')+'').trim() : null, statusScrollW: statusEl ? statusEl.scrollWidth : null, statusClientW: statusEl ? statusEl.clientWidth : null, statusNotElided: statusEl ? statusEl.scrollWidth <= statusEl.clientWidth : null, menuBtnPresent: !!menuBtn, menuBtnRect: mr ? [Math.round(mr.left),Math.round(mr.top),Math.round(mr.width),Math.round(mr.height)] : null, menuBtnVisible: mr ? (mr.width>0 && mr.height>0) : false });
    })()`);
    rep.v3.push({ requestedWidth: w, ...JSON.parse(d || '{}') });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  rep.shot320 = await shot(cdp, 'v3-320-footer.png');
}

if (PHASE === 'v7') {
  await ready(cdp, 1280, 900);
  const scan = await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const all = Array.from(p.querySelectorAll('*'));
    // 任何"形状通道"候选：左边框 ≥2px 或 字重 ≥600
    const bar = all.filter((el)=>{ const cs=getComputedStyle(el); return parseFloat(cs.borderLeftWidth)>=2 && el.getBoundingClientRect().width>0; }).map((el)=>({ tag:el.tagName.toLowerCase(), cls:String(el.className).slice(0,60), blw:getComputedStyle(el).borderLeftWidth, blc:getComputedStyle(el).borderLeftColor, text:((el.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,40) }));
    const bold = all.filter((el)=>{ const cs=getComputedStyle(el); return parseInt(cs.fontWeight,10)>=600 && el.getBoundingClientRect().width>0 && el.children.length===0 && ((el.innerText||'').trim().length>0); }).map((el)=>({ tag:el.tagName.toLowerCase(), cls:String(el.className).slice(0,60), fw:getComputedStyle(el).fontWeight, text:((el.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,40) }));
    // 面包屑末段（= 当前目录）
    const crumbs = Array.from(p.querySelectorAll('[class*="crumb"], nav[aria-label*="面"] *')).filter((el)=>el.children.length===0 && (el.innerText||'').trim());
    const lastCrumb = crumbs.length ? crumbs[crumbs.length-1] : null;
    const rows = Array.from(p.querySelectorAll('.dsh-rw-row'));
    return JSON.stringify({
      barCandidates: bar.slice(0,12), barCount: bar.length,
      boldCandidates: bold.slice(0,12), boldCount: bold.length,
      lastCrumb: lastCrumb ? { text:((lastCrumb.innerText||'')+'').trim(), fw:getComputedStyle(lastCrumb).fontWeight, color:getComputedStyle(lastCrumb).color, cls:String(lastCrumb.className).slice(0,60) } : null,
      rowStyles: rows.slice(0,3).map((r)=>({ cls:String(r.className).slice(0,50), blw:getComputedStyle(r).borderLeftWidth, fw:getComputedStyle(r).fontWeight, bg:getComputedStyle(r).backgroundColor })),
      pathInputValue: (p.querySelector('input')||{}).value ?? null
    });
  })()`);
  rep.v7scan = JSON.parse(scan || '{}');
  // 菜单内容（组标题/文字色/危险项是否红色）+ 菜单内文字色
  await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const b=Array.from(p.querySelectorAll('button')).find((x)=>x.getAttribute('aria-haspopup')==='menu'); if(b) b.click(); return !!b; })()`);
  await sleep(600);
  const menu = await cdp.ev(`(() => {
    const nodes = Array.from(document.querySelectorAll('[role="menu"], [role="group"], [role="menuitem"]'));
    const groups = nodes.filter((n)=>n.getAttribute('role')==='group');
    const items = nodes.filter((n)=>n.getAttribute('role')==='menuitem');
    const styles = (el)=>{ const cs=getComputedStyle(el); return { role:el.getAttribute('role'), label:el.getAttribute('aria-label'), text:((el.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,30), color:cs.color, fw:cs.fontWeight, h:Math.round(el.getBoundingClientRect().height) }; };
    return JSON.stringify({ present: nodes.length>0, groupCount: groups.length, itemCount: items.length, groupStyles: groups.map(styles), itemStyles: items.map(styles), menuRole: nodes.find((n)=>n.getAttribute('role')==='menu') ? 'menu' : null, labelledbyInGroups: groups.map((g)=>g.getAttribute('aria-labelledby')) });
  })()`);
  rep.menu = JSON.parse(menu || '{}');
  rep.shot = await shot(cdp, 'v7-menu-open-light.png');
}

if (PHASE === 'running') {
  await ready(cdp, 1280, 900);
  // 通过面板启动自有守护（8962），再看底栏与菜单里破坏性动作的位置
  const started = await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const b=Array.from(p.querySelectorAll('button')).find((x)=>/启动守护/.test(x.innerText||'')); if(!b) return 'start-btn-not-found'; b.click(); return 'clicked-start'; })()`);
  await sleep(8000);
  rep.started = started;
  rep.footerText = await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const all=Array.from(p.querySelectorAll('*')); const st=all.filter((el)=>/^远端守护/.test(((el.innerText||'')+'').trim()) && el.children.length===0)[0]; let f=st; while(f&&f.parentElement&&f.parentElement!==p) f=f.parentElement; return f ? ((f.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,300) : null; })()`);
  rep.footerButtons = await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const all=Array.from(p.querySelectorAll('*')); const st=all.filter((el)=>/^远端守护/.test(((el.innerText||'')+'').trim()) && el.children.length===0)[0]; let f=st; while(f&&f.parentElement&&f.parentElement!==p) f=f.parentElement; return f ? Array.from(f.querySelectorAll('button')).map((b)=>((b.innerText||'')+'').trim().slice(0,24)) : []; })()`);
  rep.shotReady = await shot(cdp, 'ready-daemon-running-light.png');
  await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const b=Array.from(p.querySelectorAll('button')).find((x)=>x.getAttribute('aria-haspopup')==='menu'); if(b) b.click(); return !!b; })()`);
  await sleep(600);
  rep.menuItemsRunning = await cdp.ev(`(() => Array.from(document.querySelectorAll('[role="menuitem"]')).map((el)=>((el.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,30)))()`);
  rep.shotMenu = await shot(cdp, 'menu-daemon-running-light.png');
}

if (PHASE === 'v3b') {
  await ready(cdp, 1280, 900);
  rep.v3b = [];
  for (const w of [320, 1280]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(420);
    const d = await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const f = p.querySelector('footer.dsh-rw-status');
      const fr = f.getBoundingClientRect();
      const kids = Array.from(f.children).filter((k)=>k.getBoundingClientRect().width>0);
      const info = kids.map((k)=>{ const r=k.getBoundingClientRect(); return { tag:k.tagName.toLowerCase(), cls:String(k.className).slice(0,40), text:((k.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,28), top:Math.round(r.top), h:Math.round(r.height), centerY:Math.round((r.top+r.height/2)*10)/10, w:Math.round(r.width) }; });
      const centers = Array.from(new Set(info.map((i)=>Math.round(i.centerY))));
      return JSON.stringify({ innerWidth: window.innerWidth, footerRect: [Math.round(fr.left),Math.round(fr.top),Math.round(fr.width),Math.round(fr.height)], footerCenterY: Math.round((fr.top+fr.height/2)*10)/10, childCount: info.length, distinctCenters: centers.length, singleLineByCenter: centers.length <= 1, children: info, footerText: ((f.innerText||'')+'').replace(/\\s+/g,' ').trim() });
    })()`);
    rep.v3b.push({ requestedWidth: w, ...JSON.parse(d || '{}') });
  }
}

if (PHASE === 'menu320') {
  await ready(cdp, 320, 800);
  const fw = await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); return JSON.stringify({ innerWidth: innerWidth, headerButtons: Array.from(p.querySelectorAll('button')).slice(0,6).map((b)=>({ text:((b.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,24), aria:b.getAttribute('aria-label'), w:Math.round(b.getBoundingClientRect().width), h:Math.round(b.getBoundingClientRect().height) })) }); })()`);
  rep.menu320 = JSON.parse(fw || '{}');
  await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const b=Array.from(p.querySelectorAll('button')).find((x)=>x.getAttribute('aria-haspopup')==='menu'); if(b) b.click(); return !!b; })()`);
  await sleep(600);
  const m = await cdp.ev(`(() => { const groups=Array.from(document.querySelectorAll('[role="group"]')); const items=Array.from(document.querySelectorAll('[role="menuitem"]')); return JSON.stringify({ groupCount: groups.length, groups: groups.map((g)=>({ label:g.getAttribute('aria-label'), labelledby:g.getAttribute('aria-labelledby'), text:((g.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,60) })), items: items.map((el)=>((el.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,26)) }); })()`);
  rep.menu320.menu = JSON.parse(m || '{}');
  rep.shot = await shot(cdp, 'menu-320-light.png');
}

fs.writeFileSync(path.join(OUT, `out-p04-refine-${PHASE}.json`), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep, null, 1).slice(0, 3500));
cdp.close();
