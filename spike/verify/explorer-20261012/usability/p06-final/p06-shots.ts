/**
 * p06-shots.ts —— task-54：在**当前 HEAD（70c697d）**的实例上重拍面板成品图（light+dark 各 6 张）
 *                 + 补 dark 逐项读数 + 前置两条证明（rev 门禁由 p06-boot 之外单独跑；本脚本做 trailer 逐 chunk 比对）。
 *
 * 用法： node p06-shots.ts --url <tokenUrl> --out <dir> --disk <vendorDir> [--cdp 8968] [--phase integrity|shots|readings|all]
 * 依赖：无（Node 内置 ws；headless Chrome 已由外部以 --remote-debugging-port 起好）
 *
 * 纪律：只读页面 + 只截图；不改被验对象；夹具（delay/error/running）通过 Page.addScriptToEvaluateOnNewDocument 注入，
 *       并在输出里标注 `fixture: true`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const OUT = arg('--out', '.'); const DISK = arg('--disk', ''); const CDP_PORT = arg('--cdp', '8968'); const PHASE = arg('--phase', 'all');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

class C {
  ws: any; id = 0; pending = new Map<number, any>(); wsUrl: string;
  constructor(u: string) { this.wsUrl = u; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((res, rej) => { this.ws.addEventListener('open', () => res(), { once: true }); this.ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
    this.ws.addEventListener('message', (ev: any) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  }
  send(method: string, params: any = {}): Promise<any> { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 40000); }); }
  async ev(expr: string) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 240)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}

const RAIL = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;

const INITS: Record<string, string> = {
  // loading 定格：把 explorer.snapshot 延迟 5s
  delay: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; const b = n && n.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof b === 'string' && b.indexOf('explorer.snapshot') >= 0) { return new Promise((res, rej) => setTimeout(() => of.apply(window, [i, n]).then(res, rej), 5000)); } } catch (e) {} return of.apply(this, arguments); }; })();`,
  // 守护运行中（夹具：改写 snapshot.daemon.running=true + 两个会话键）
  running: `(() => { const of = window.fetch; window.fetch = function (i, n) { try { const u = typeof i === 'string' ? i : (i && i.url) || ''; const b = n && n.body; if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof b === 'string' && b.indexOf('explorer.snapshot') >= 0) { return of.apply(window, [i, n]).then((r) => r.json().then((j) => { if (j && j.ok && j.result && j.result.daemon) { j.result.daemon.running = true; j.result.daemon.keys = ['p06-session-a', 'p06-session-b']; j.result.daemon.orphans = 0; j.result.daemon.others = []; } if (j && j.ok && j.result && j.result.drift) { j.result.drift.drifted = false; } return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); })); } } catch (e) {} return of.apply(this, arguments); }; })();`,
};

async function load(cdp: C, w = 1280, h = 900, dark = false, init?: string, opts: { openPanel?: boolean; settle?: number } = {}) {
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  // ① 每次都注入**帮助函数库**（顶层 const ⇒ 全局词法作用域，后续 Runtime.evaluate 可见）
  const rLib = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LIB });
  let sid: string | null = null;
  if (init) { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: init }); sid = r.identifier; }
  await cdp.send('Page.navigate', { url: URL_ }); await sleep(2600);
  if (sid) { try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch {} }
  try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: rLib.identifier }); } catch {}
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

// 页面内共用小工具：对比度 + 元素快照
const LIB = `
const _rgb = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
const _lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const _over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const _ratio = (fgs, bgs, base) => { const fg0 = _rgb(fgs), bg0 = _rgb(bgs); if (!fg0 || !bg0) return null; const b = (_rgb(base) && bg0.a < 1) ? _over(bg0, _rgb(base)) : bg0; const f = _over(fg0, b); const l1 = _lum(f), l2 = _lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
const _rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, x: Math.round(r.x), y: Math.round(r.y), bottom: Math.round(r.bottom) }; };
const _txt = (el) => el ? ((el.innerText || '') + '').replace(/\\s+/g, ' ').trim() : null;
const _panel = () => document.querySelector('[data-dsh-remote-wsl="panel"]');
`;

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(3); }
const cdp = new C(page.webSocketDebuggerUrl); await cdp.connect();
const rep: any = { ts: new Date().toISOString(), phase: PHASE, url: URL_.replace(/token=[^&]+/, 'token=***'), disk: DISK };

// ─────────────────────────────────────────────── ② 前置：页面加载的 chunk == 磁盘（trailer 判法）
if (PHASE === 'integrity' || PHASE === 'all') {
  await load(cdp, 1280, 900, false);
  const perf = await cdp.ev(`(() => JSON.stringify(performance.getEntriesByType('resource').map((e)=>e.name).filter((n)=>/\\/plugins\\/dsh-remote-wsl\\//.test(n))))()`);
  const urls = JSON.parse(perf || '[]') as string[];
  const fetches = await cdp.ev(`(async () => { const list = ${JSON.stringify(urls)}; const out = {}; for (const u of list) { const abs = new URL(u, location.href).href; const r = await fetch(abs, { cache: 'no-store' }); const buf = new Uint8Array(await r.arrayBuffer()); const text = new TextDecoder().decode(buf); const m = text.match(/\\n\\/\\/# sourceMappingURL=[^\\n]*\\n?$/); const body = m ? text.slice(0, text.length - m[0].length) : text; const enc = new TextEncoder(); const bb = enc.encode(body); let bin = ''; for (let i = 0; i < bb.length; i += 8192) bin += String.fromCharCode.apply(null, Array.from(bb.subarray(i, i + 8192))); const name = abs.split('/').pop().split('?')[0]; out[name] = { url: abs, status: r.status, servedBytes: buf.length, trailer: m ? m[0].trim() : null, bodyB64: btoa(bin) }; } return JSON.stringify(out); })()`);
  const parsed = JSON.parse(fetches || '{}');
  const cmp: any = {};
  for (const [name, v] of Object.entries(parsed) as any) {
    const diskPath = path.join(DISK, 'client', name);
    if (!fs.existsSync(diskPath)) { cmp[name] = { note: '磁盘无此文件', served: v.servedBytes }; continue; }
    const diskBuf = fs.readFileSync(diskPath);
    const served = Buffer.from(v.bodyB64, 'base64');
    cmp[name] = { servedBytes: v.servedBytes, diskBytes: diskBuf.length, appended: JSON.stringify(served.subarray(diskBuf.length).toString('utf8')), prefixMatch: served.subarray(0, diskBuf.length).equals(diskBuf) ? 'PASS' : 'FAIL', diskSha256_16: sha(diskBuf).slice(0, 16), trailer: v.trailer };
  }
  rep.integrity = { chunkCount: urls.length, chunks: cmp, allPass: Object.values(cmp).every((c: any) => c.prefixMatch === 'PASS') };
  fs.writeFileSync(path.join(OUT, 'out-p06-integrity.json'), JSON.stringify(rep.integrity, null, 2));
}

// ─────────────────────────────────────────────── ① 12 张成品图（6 场景 × light/dark）
if (PHASE === 'shots' || PHASE === 'all') {
  const SHOTS: any[] = [];
  for (const dark of [false, true]) {
    const th = dark ? 'dark' : 'light';
    // 1) ready
    await load(cdp, 1280, 900, dark);
    SHOTS.push({ ...(await shot(cdp, `p06-ready-${th}.png`)), scene: 'ready', theme: th, fixture: false });
    // 2) menu 打开
    await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return true; })()`);
    await sleep(500);
    SHOTS.push({ ...(await shot(cdp, `p06-menu-${th}.png`)), scene: 'menu', theme: th, fixture: false });
    // 3) narrow 320
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    SHOTS.push({ ...(await shot(cdp, `p06-narrow320-${th}.png`)), scene: 'narrow320', theme: th, fixture: false });
    // 4) loading（夹具：snapshot 延迟 5s；只等 1.2s ⇒ 定格在加载态）
    await load(cdp, 1280, 900, dark, INITS.delay, { settle: 1200 });
    SHOTS.push({ ...(await shot(cdp, `p06-loading-${th}.png`)), scene: 'loading', theme: th, fixture: true });
    // 5) error-badpath（真实交互：填入不存在的路径并跳转）
    await load(cdp, 1280, 900, dark);
    const BAD = `/home/g/__p06_no_such_dir_${th}__`;
    await cdp.ev(`(() => { const p=_panel(); const inp=p.querySelector('.dsh-rw-path-input'); if(!inp) return 'no-input'; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(inp, ${JSON.stringify(BAD)}); inp.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()`);
    await sleep(200);
    await cdp.ev(`(() => { const p=_panel(); const b=Array.from(p.querySelectorAll('button')).find((x)=>/跳转/.test(_txt(x)||'')); if(b){ b.click(); return 'jumped'; } return 'no-jump-btn'; })()`);
    await sleep(1800);
    SHOTS.push({ ...(await shot(cdp, `p06-error-badpath-${th}.png`)), scene: 'error-badpath', theme: th, fixture: false });
    // 6) 守护运行中（夹具：改写 snapshot.daemon）
    await load(cdp, 1280, 900, dark, INITS.running);
    SHOTS.push({ ...(await shot(cdp, `p06-running-${th}.png`)), scene: 'running', theme: th, fixture: true });
  }
  rep.shots = SHOTS;
  fs.writeFileSync(path.join(OUT, 'out-p06-shots.json'), JSON.stringify(SHOTS, null, 2));
}

// ─────────────────────────────────────────────── dark/light 逐项读数
if (PHASE === 'readings' || PHASE === 'all') {
  const all: any[] = [];
  for (const dark of [false, true]) {
    const th = dark ? 'dark' : 'light';
    // —— ready（1280）：V1 逐元素 rect + footerH + 状态词 + box-shadow 计数
    await load(cdp, 1280, 900, dark);
    await forceHover(cdp, '.dsh-rw-row', true);   // 行内动作 hover 才显形
    await sleep(250);
    const ready = JSON.parse(await cdp.ev(`(() => {
      const p = _panel();
      const hit = Array.from(p.querySelectorAll('button,[role="button"],a[href],label')).filter((el)=>!el.disabled && el.getAttribute('aria-disabled')!=='true').map((el)=>({ cls:String(el.className).slice(0,40), txt:(_txt(el)||'').slice(0,18), rect:_rect(el) }));
      const under24 = hit.filter((x)=>x.rect.w < 24 || x.rect.h < 24);
      const foot = p.querySelector('footer');
      const st = Array.from(p.querySelectorAll('*')).find((el)=>/^远端守护(运行中|未运行|状态未知)$/.test((_txt(el)||'')) && el.children.length===0);
      const shadows = Array.from(p.querySelectorAll('*')).map((el)=>({ cls:String(el.className).slice(0,44), s:getComputedStyle(el).boxShadow })).filter((x)=>x.s && x.s!=='none');
      const menuBtn = p.querySelector('[aria-haspopup="menu"]');
      return JSON.stringify({
        theme: getComputedStyle(document.documentElement).colorScheme,
        footerH: foot ? Math.round(foot.getBoundingClientRect().height*10)/10 : null,
        statusWord: st ? { text:(_txt(st)||''), scrollW: st.scrollWidth, clientW: st.clientWidth, notElided: st.scrollWidth <= st.clientWidth } : null,
        menuBtnRect: menuBtn ? _rect(menuBtn) : null,
        hitCount: hit.length, under24Count: under24.length, under24,
        shadowCount: shadows.length, shadows,
        rowCount: p.querySelectorAll('.dsh-rw-row').length,
        panelText: (_txt(p)||'').slice(0, 320)
      });
    })()`));
    await forceHover(cdp, '.dsh-rw-row', false);
    // —— menu：菜单宽 / 组标题对比度 / 组标注
    await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return true; })()`);
    await sleep(450);
    const menu = JSON.parse(await cdp.ev(`(() => {
      const p = _panel();
      const m = p.querySelector('.dsh-rw-menu');
      const groups = m ? Array.from(m.querySelectorAll('[role="group"]')).map((g)=>{
        const id = g.getAttribute('aria-labelledby'); const el = id ? document.getElementById(id) : null;
        const cs = el ? getComputedStyle(el) : null;
        return { ariaLabel:g.getAttribute('aria-label'), ariaLabelledby:id, targetExists: !!el, targetText: _txt(el), targetTabIndex: el ? el.tabIndex : null, targetRole: el ? el.getAttribute('role') : null, targetColor: cs?cs.color:null, fontSize: cs?cs.fontSize:null };
      }) : [];
      const bg = m ? getComputedStyle(m).backgroundColor : null;
      const base = getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor;
      const grpContrast = (m && groups[0] && groups[0].targetColor) ? _ratio(groups[0].targetColor, bg, base) : null;
      const items = m ? Array.from(m.querySelectorAll('[role="menuitem"]')).map((it)=>({ txt:(_txt(it)||'').slice(0,20), h: Math.round(it.getBoundingClientRect().height*10)/10, color:getComputedStyle(it).color })) : [];
      const foot = p.querySelector('footer');
      const st = Array.from(p.querySelectorAll('*')).find((el)=>/^远端守护(运行中|未运行|状态未知)$/.test((_txt(el)||'')) && el.children.length===0);
      const overlap = (a,b)=> !(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top);
      const fw = st ? st.getBoundingClientRect() : null;
      const mr = m ? m.getBoundingClientRect() : null;
      return JSON.stringify({
        theme: getComputedStyle(document.documentElement).colorScheme,
        menuRect: mr ? _rect(m) : null, menuWidth: mr ? Math.round(mr.width*10)/10 : null,
        menuBg: bg, groupCount: groups.length, groups,
        grouplabelContrastVsMenuBg: grpContrast,
        itemCount: items.length, items,
        menuOverlapsStatusWord: (mr && fw) ? overlap(mr, fw) : null,
        footerH: foot ? Math.round(foot.getBoundingClientRect().height*10)/10 : null
      });
    })()`));
    // —— narrow 320：footerH + 状态词 + ⋯ rect
    await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return true; })()`); // 关菜单
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const narrow = JSON.parse(await cdp.ev(`(() => {
      const p=_panel(); const foot=p.querySelector('footer');
      const st=Array.from(p.querySelectorAll('*')).find((el)=>/^远端守护(运行中|未运行|状态未知)$/.test((_txt(el)||'')) && el.children.length===0);
      const mb=p.querySelector('[aria-haspopup="menu"]');
      return JSON.stringify({ theme:getComputedStyle(document.documentElement).colorScheme, innerWidth: window.innerWidth,
        footerH: foot?Math.round(foot.getBoundingClientRect().height*10)/10:null,
        footerNoWrap: foot? foot.scrollWidth <= foot.clientWidth : null,
        statusWord: st?{ text:_txt(st), scrollW:st.scrollWidth, clientW:st.clientWidth, notElided: st.scrollWidth<=st.clientWidth }:null,
        menuBtnRect: mb?_rect(mb):null });
    })()`));
    all.push({ theme: th, ready, menu, narrow });
  }
  rep.readings = all;
  fs.writeFileSync(path.join(OUT, 'out-p06-readings.json'), JSON.stringify(all, null, 2));
}

// ⚠️ 不要写成 `out-p06-${PHASE}.json`：PHASE=readings 时会把上面写好的**数组**覆盖成这个包装对象
//    （T54 自查踩到：断言脚本因此拿到非数组 ⇒ 抛错当成了"红"）。包装对象一律单独文件名。
fs.writeFileSync(path.join(OUT, `out-p06-run-${PHASE}.json`), JSON.stringify(rep, null, 2));
console.log(JSON.stringify({ phase: PHASE, integrityAllPass: rep.integrity?.allPass, shots: rep.shots?.length, themes: rep.readings?.map((r: any) => ({ theme: r.theme, footerH: r.ready.footerH, under24: r.ready.under24Count, menuWidth: r.menu.menuWidth, grpContrast: r.menu.grouplabelContrastVsMenuBg, shadows: r.ready.shadowCount, statusNotElided: r.ready.statusWord?.notElided, narrowFooterH: r.narrow.footerH, narrowMenuBtn: r.narrow.menuBtnRect })) }, null, 1));
cdp.close();
