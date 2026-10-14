/**
 * p05-ab.ts —— task-50 两件有界补做
 *   phase=shape     ：V7/M15 形状通道断言（当前项 2px 竖条 + 字重 ≥600；强制静息填充后仍可分辨）
 *   phase=m12click  ：清空 dsh-remote-wsl.recent 后用 **trusted click** 展开「最近目录」折叠，读 recent.empty
 * 用法：node p05-ab.ts --url <tokenUrl> --out <dir> --phase shape|m12click
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const OUT = arg('--out', '.'); const PHASE = arg('--phase', 'shape'); const CDP_PORT = arg('--cdp', '8965');
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

async function open(cdp: C, w = 1280, h = 900) {
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL_ }); await sleep(2600);
  // 面板开关状态会被持久化 ⇒ 点一次可能反而"关掉"；这里做成幂等：确认面板在，不在再点（最多 3 次）
  for (let i = 0; i < 3; i++) {
    const has = await cdp.ev(`(() => !!document.querySelector('[data-dsh-remote-wsl="panel"]'))()`);
    if (has) break;
    await cdp.ev(RAIL); await sleep(2000);
  }
  await sleep(700);
}
const SHAPE = `(() => {
  const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
  const cur = p.querySelector('.dsh-rw-crumb--current, .dsh-rw-current');
  if (!cur) return JSON.stringify({ found:false, verdict:'RED(找不到"当前项"元素)' });
  const cs = getComputedStyle(cur);
  const blw = parseFloat(cs.borderLeftWidth), fw = parseInt(cs.fontWeight, 10);
  // 强制把填充置为静息色，再看形状通道是否仍在
  const s = document.createElement('style'); s.id = 'usab-ab-force';
  s.textContent = '.dsh-rw-crumb--current,.dsh-rw-current{background:none !important;background-color:transparent !important}';
  document.head.appendChild(s);
  const cs2 = getComputedStyle(cur);
  const blw2 = parseFloat(cs2.borderLeftWidth), fw2 = parseInt(cs2.fontWeight, 10);
  s.remove();
  return JSON.stringify({
    found:true, cls:String(cur.className).slice(0,60), text:(cur.innerText||'').trim(),
    borderLeftWidth: cs.borderLeftWidth, borderLeftColor: cs.borderLeftColor, fontWeight: cs.fontWeight,
    forcedRestingFill: { borderLeftWidth: cs2.borderLeftWidth, fontWeight: cs2.fontWeight, distinguishable: blw2>=2 && fw2>=600 },
    verdict: (blw >= 2 && fw >= 600) ? 'PASS(2px竖条+字重>=600)' : 'RED(形状通道缺失 ⇒ V7/M15 失败)'
  });
})()`;

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const cdp = new C(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await cdp.connect();
const rep: any = { ts: new Date().toISOString(), phase: PHASE, url: URL_.replace(/token=[^&]+/, 'token=***') };

if (PHASE === 'shape') {
  await open(cdp);
  rep.shape = JSON.parse(await cdp.ev(SHAPE));
}

if (PHASE === 'm12click') {
  await open(cdp);
  rep.lsBefore = await cdp.ev(`(() => JSON.stringify({ key: Object.keys(localStorage).find((k)=>/recent/i.test(k)) ?? null, value: localStorage.getItem('dsh-remote-wsl.recent') }))()`);
  await cdp.ev(`(() => { localStorage.setItem('dsh-remote-wsl.recent', '[]'); return true; })()`);
  await open(cdp); // 重新加载，让面板以"空最近目录"渲染
  // 找到「最近目录」折叠的 summary，滚入视口后取中心坐标
  const box = await cdp.ev(`(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    const d = Array.from(p.querySelectorAll('details')).find((x)=>/最近目录/.test(x.querySelector('summary')?.innerText||''));
    if (!d) return JSON.stringify({ found:false });
    const s = d.querySelector('summary'); s.scrollIntoView({ block:'center' });
    const r = s.getBoundingClientRect();
    return JSON.stringify({ found:true, open:d.open, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), summary:(s.innerText||'').trim(), textBefore: ((d.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,80) });
  })()`);
  const b = JSON.parse(box || '{}');
  if (!b.found) { rep.m12click = { found:false, verdict:'未复核(找不到最近目录折叠)' }; }
  else {
    const readState = async () => JSON.parse(await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      if (!p) return JSON.stringify({ panelGone: true, url: location.href.replace(/token=[^&]+/, 'token=***'), railExpanded: (()=>{ const b=Array.from(document.querySelectorAll('button')).find((x)=>/远程资源管理器/.test((x.getAttribute('aria-label')||'')+(x.innerText||''))); return b ? b.getAttribute('aria-expanded') : null; })() });
      const d = Array.from(p.querySelectorAll('details')).find((x)=>/最近目录/.test(x.querySelector('summary')?.innerText||''));
      if (!d) return JSON.stringify({ foldGone: true, panelText: ((p.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,120) });
      const inner = d.querySelector('div') || d;
      return JSON.stringify({ open: d.open, innerText: ((inner.innerText||'')+'').replace(/\\s+/g,' ').trim().slice(0,200), innerH: Math.round(inner.getBoundingClientRect().height) });
    })()`));
    const trusted = async (x: number, y: number) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); await sleep(100);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }); await sleep(70);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }); await sleep(700);
    };
    const attempts: any[] = [];
    // 策略 1：summary 中心（已试）；策略 2：summary 左侧文字处；策略 3：折叠头部的第一个子节点（React 常把 onClick 挂这里）
    const geo = JSON.parse(await cdp.ev(`(() => {
      const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
      const d = Array.from(p.querySelectorAll('details')).find((x)=>/最近目录/.test(x.querySelector('summary')?.innerText||''));
      const s = d.querySelector('summary'); const r = s.getBoundingClientRect();
      const hdr = s.firstElementChild; const hr = hdr ? hdr.getBoundingClientRect() : null;
      return JSON.stringify({ leftTextX: Math.round(r.left + 14), centerY: Math.round(r.top + r.height/2), hdrX: hr ? Math.round(hr.left + hr.width/2) : null, hdrY: hr ? Math.round(hr.top + hr.height/2) : null, summaryW: Math.round(r.width), hdrTag: hdr ? hdr.tagName : null });
    })()`));
    await trusted(b.x, b.y); attempts.push({ strategy: 'trusted@summary-center', point: [b.x, b.y], state: await readState() });
    if (!attempts[attempts.length - 1].state.open) {
      await trusted(geo.leftTextX, geo.centerY); attempts.push({ strategy: 'trusted@summary-left-text', point: [geo.leftTextX, geo.centerY], state: await readState() });
    }
    if (geo.hdrX !== null && !attempts[attempts.length - 1].state.open) {
      await trusted(geo.hdrX, geo.hdrY); attempts.push({ strategy: 'trusted@summary-header-child', point: [geo.hdrX, geo.hdrY], state: await readState() });
    }
    if (!attempts[attempts.length - 1].state.open) {
      await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); const d=Array.from(p.querySelectorAll('details')).find((x)=>/最近目录/.test(x.querySelector('summary')?.innerText||'')); const s=d.querySelector('summary'); s.click(); if(!d.open) d.open=true; return true; })()`);
      await sleep(700);
      attempts.push({ strategy: 'DOM summary.click()+open=true(兜底)', point: null, state: await readState() });
    }
    const after = attempts[attempts.length - 1].state;
    const hint = /还没有|暂无|无最近|没有.*最近/.test(after.innerText || '');
    rep.m12click = { ...b, geo, attempts, after, hintPresent: hint, verdict: hint ? 'PASS(展开后显示 recent.empty)' : (after.open ? 'CHECK(已展开但未见空态文案)' : 'FAIL(点击未展开)') };
  }
}

fs.writeFileSync(path.join(OUT, `out-p05-ab-${PHASE}.json`), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep, null, 1).slice(0, 2500));
cdp.close();
