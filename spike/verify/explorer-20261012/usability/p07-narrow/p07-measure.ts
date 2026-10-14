/**
 * p07-measure.ts —— task-63：320/359/360/419/420（+1280 对照）× light/dark 的**窄态换行**实测与断言。
 *
 * 用法： node p07-measure.ts --url <tokenUrl> --out <dir> --tag <before|after|red> [--cdp 8968]
 * 产出： out-p07-<tag>.json  +  ASSERT-p07-<tag>.txt（exit 1 = 有断言失败）
 *
 * 判据（"应当怎样"的可判形式）：
 *   N1 头部三行文本块（title / subtitle / meta-badge / meta-hint）**各 1 行**（`Range.getClientRects().length === 1`）
 *   N2 底栏「启动守护」按钮**文字 1 行**（同上）+ `scrollHeight <= clientHeight`
 *   N3 底栏 `scrollWidth === clientWidth`（无横向溢出）+ 外框高 **47** + 状态词不被省略（`scrollWidth === clientWidth`）
 *   N4 V1 命中盒**全部 ≥24×24**（WCAG 2.2 SC 2.5.8 硬底线，不许为不换行而压缩）
 *   N5 头部主按钮**仍带文字**（不许退化成纯图标；§9.5/Q3）
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const OUT = arg('--out', '.'); const TAG = arg('--tag', 'x'); const CDP_PORT = arg('--cdp', '8968');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = [320, 359, 360, 419, 420, 480, 560, 1280];

class C {
  ws: any; id = 0; pending = new Map<number, any>(); wsUrl: string;
  // 注意：Node 的 strip-only TS 模式**不支持参数属性**（`constructor(public x: string)`）⇒ 显式赋值
  constructor(wsUrl: string) { this.wsUrl = wsUrl; }
  async connect() { this.ws = new WebSocket(this.wsUrl); await new Promise<void>((res, rej) => { this.ws.addEventListener('open', () => res(), { once: true }); this.ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); }); this.ws.addEventListener('message', (ev: any) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  send(method: string, params: any = {}): Promise<any> { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 40000); }); }
  async ev(expr: string) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}

const RAIL = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;

const LIB = `
const _txt = (el) => el ? ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim() : null;
const _lineCount = (el) => { if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); const rects = Array.from(r.getClientRects()).filter((x)=>x.width > 0 && x.height > 0); if (rects.length === 0) return 0; const ys = Array.from(new Set(rects.map((x)=>Math.round(x.top)))); return ys.length; };
const _rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10, x: Math.round(r.x), y: Math.round(r.y) }; };
const _panel = () => document.querySelector('[data-dsh-remote-wsl="panel"]');
const _btnByText = (p, re) => Array.from(p.querySelectorAll('button')).find((b)=>{ const t=_txt(b); const al=b.getAttribute('aria-label')||''; return re.test(t||'') || re.test(al); });
const _elided = (el) => el ? (el.scrollWidth > el.clientWidth + 1) : null;
`;

async function load(cdp: C, w: number, h: number, dark: boolean) {
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  const r1 = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LIB });
  await cdp.send('Page.navigate', { url: URL_ }); await sleep(2500);
  try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: r1.identifier }); } catch {}
  // 首启模态（全新孤立 profile 会连弹"预览版说明"→"添加一个 API Key"）⇒ 循环点掉，优先"稍后/跳过"
  for (let i = 0; i < 4; i++) {
    const r = await cdp.ev(`(() => { const txt=(x)=>(((x.innerText||x.textContent||'')+'')).trim(); const c=Array.from(document.querySelectorAll('button,[role="button"]')).filter((x)=>/^(稍后配置|稍后再说|稍后|跳过|跳过配置|以后再说|Skip|Later|Not now|继续|我知道了|同意|Got it|Continue|OK|好的)$/.test(txt(x))); const s=c.find((x)=>/稍后|跳过|以后再说|Skip|Later|Not now/.test(txt(x))); const pick=s||c[0]; if(!pick) return 'none'; pick.click(); return txt(pick); })()`);
    if (!r || r === 'none') break;
    await sleep(700);
  }
  await cdp.ev(RAIL); await sleep(2200);
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const page = targets.find((t: any) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(3); }
const cdp = new C(page.webSocketDebuggerUrl); await cdp.connect();

const rows: any[] = [];
for (const dark of [false, true]) {
  for (const w of WIDTHS) {
    await load(cdp, w, 900, dark);
    const m = JSON.parse(await cdp.ev(`(() => {
      const p = _panel();
      const title = p.querySelector('.dsh-rw-title');
      const sub = p.querySelector('.dsh-rw-subtitle');
      const meta = p.querySelector('.dsh-rw-header-meta');
      const badge = p.querySelector('.dsh-rw-badge');
      const hint = p.querySelector('.dsh-rw-hint');
      const acts = p.querySelector('.dsh-rw-header-actions');
      const textCol = p.querySelector('.dsh-rw-header-text');
      const prim = p.querySelector('.dsh-rw-btn--primary');
      const stat = p.querySelector('.dsh-rw-status');
      const word = p.querySelector('.dsh-rw-statusword');
      const start = _btnByText(p, /启动|Start/);
      const extra = p.querySelector('.dsh-rw-extra');
      const upd = p.querySelector('.dsh-rw-updated');
      const kids = stat ? Array.from(stat.children).map((el)=>({ cls:String(el.className).slice(0,26), w:_rect(el).w, txt:(_txt(el)||'').slice(0,14), elided:_elided(el) })) : [];
      const hit = Array.from(p.querySelectorAll('button,[role="button"],a[href],label')).filter((el)=>!el.disabled && el.getAttribute('aria-disabled')!=='true').map((el)=>({ c:String(el.className).slice(0,34), t:(_txt(el)||'').slice(0,16), w:_rect(el).w, h:_rect(el).h }));
      const under24 = hit.filter((x)=>x.w < 24 || x.h < 24);
      const cs = (el) => el ? getComputedStyle(el) : null;
      return JSON.stringify({
        theme: getComputedStyle(document.documentElement).colorScheme, innerWidth: window.innerWidth,
        panelW: Math.round(p.getBoundingClientRect().width),
        lines: { title: _lineCount(title), subtitle: _lineCount(sub), meta: _lineCount(meta), badge: _lineCount(badge), hint: _lineCount(hint), primary: _lineCount(prim), start: _lineCount(start) },
        texts: { title: _txt(title), subtitle: _txt(sub), meta: _txt(meta), primary: _txt(prim), start: _txt(start) },
        titleWS: cs(title) ? cs(title).whiteSpace : null,
        panelW2: null,
        textColW: textCol ? _rect(textCol).w : null, actsW: acts ? _rect(acts).w : null,
        primaryRect: prim ? _rect(prim) : null, startRect: start ? _rect(start) : null,
        startScrollH: start ? start.scrollHeight : null, startClientH: start ? start.clientHeight : null,
        startWS: cs(start) ? cs(start).whiteSpace : null,
        // 是否被截断（省略号）：N1b 用它把"窄态换短文案"变成承重判据 —— 只靠 CSS nowrap 也能做到 1 行，
        // 但那样文案会被省略号吃掉；只有文案真的短了，scrollWidth 才等于 clientWidth。
        elided: { title: _elided(title), badge: _elided(badge), hint: _elided(hint), primary: _elided(prim), start: _elided(start) },
        footerH: stat ? _rect(stat).h : null,
        footerScrollW: stat ? stat.scrollWidth : null, footerClientW: stat ? stat.clientWidth : null,
        wordScrollW: word ? word.scrollWidth : null, wordClientW: word ? word.clientWidth : null,
        wordElided: _elided(word), extraElided: _elided(extra), extraTxt: _txt(extra), updVisible: !!upd,
        headerKids: kids,
        hitCount: hit.length, under24Count: under24.length, under24
      });
    })()`));
    rows.push({ tag: TAG, dark, reqW: w, ...m });
    console.log(`${TAG} ${dark ? 'dark ' : 'light'} ${String(w).padStart(4)}  panel=${m.panelW} title行=${m.lines.title} sub行=${m.lines.subtitle} meta行=${m.lines.meta} hint行=${m.lines.hint} start行=${m.lines.start} startW=${m.startRect ? m.startRect.w : null} footerH=${m.footerH} footer溢出=${m.footerScrollW !== m.footerClientW} word省略=${m.wordElided} extra省略=${m.extraElided} <24=${m.under24Count}`);
  }
}

// ── 视觉证据：窄态截图（320 / 359 × light/dark）──
if (argv.includes('--shot')) {
  const out: any[] = [];
  for (const dark of [false, true]) {
    for (const w of [320, 359]) {
      await load(cdp, w, 800, dark);
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const f = `p07-narrow${w}-${dark ? 'dark' : 'light'}.png`;
      fs.writeFileSync(path.join(OUT, f), Buffer.from(r.data, 'base64'));
      out.push({ file: f, bytes: fs.statSync(path.join(OUT, f)).size });
      console.log(`shot ${f} (${out[out.length - 1].bytes} B)`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'out-p07-shots.json'), JSON.stringify(out, null, 2));
  cdp.close();
  process.exit(0);
}

// ── 回归：菜单仍不遮底栏状态词（T63 改了底栏/头部 CSS ⇒ 必须复验）──
if (argv.includes('--menu')) {
  const mrows: any[] = [];
  for (const dark of [false, true]) {
    for (const w of [320, 420, 1280]) {
      await load(cdp, w, 900, dark);
      await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return b ? b.getAttribute('aria-expanded') : null; })()`);
      await sleep(450);
      const m = JSON.parse(await cdp.ev(`(() => {
        const p=_panel(); const menu=p.querySelector('.dsh-rw-menu'); const word=p.querySelector('.dsh-rw-statusword'); const foot=p.querySelector('.dsh-rw-status');
        const R=(el)=>{const r=el.getBoundingClientRect(); return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height};};
        const ov=(a,b)=>!(a.r<=b.l||b.r<=a.l||a.b<=b.t||b.b<=a.t);
        const mr=menu?R(menu):null, wr=word?R(word):null, fr=foot?R(foot):null;
        return JSON.stringify({ menuOpen: !!menu, menuW: mr?Math.round(mr.w*10)/10:null, footerH: fr?Math.round(fr.h*10)/10:null,
          menuOverlapsWord: (mr&&wr)?ov(mr,wr):null, menuOverlapsFooter: (mr&&fr)?ov(mr,fr):null,
          gapMenuBottomToFooterTop: (mr&&fr)?Math.round((fr.t-mr.b)*10)/10:null });
      })()`));
      mrows.push({ dark, reqW: w, ...m });
      console.log(`menu ${dark ? 'dark ' : 'light'} ${String(w).padStart(4)} menuW=${m.menuW} footerH=${m.footerH} 遮状态词=${m.menuOverlapsWord} 遮底栏=${m.menuOverlapsFooter} 间隙=${m.gapMenuBottomToFooterTop}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'out-p07-menu.json'), JSON.stringify(mrows, null, 2));
  const bads = mrows.filter((x) => x.menuOpen !== true || x.menuW !== 240 || x.menuOverlapsWord !== false || x.menuOverlapsFooter !== false || x.footerH !== 47);
  const fl = mrows.map((x) => (bads.includes(x) ? 'FAIL  ' : 'PASS  ') + `菜单回归 ${x.dark ? 'dark' : 'light'}/${x.reqW} menuW=${x.menuW} footerH=${x.footerH} 遮状态词=${x.menuOverlapsWord}`);
  fl.push('', `菜单回归：${mrows.length - bads.length}/${mrows.length} PASS`, bads.length === 0 ? '==> PASS' : '==> FAIL');
  fs.writeFileSync(path.join(OUT, 'ASSERT-p07-menu.txt'), fl.join('\n') + '\n');
  console.log('\n' + fl.slice(-3).join('\n'));
  cdp.close();
  process.exit(bads.length === 0 ? 0 : 1);
}

fs.writeFileSync(path.join(OUT, `out-p07-${TAG}.json`), JSON.stringify(rows, null, 2));

// ── 断言 ──
const R: any[] = [];
const ok = (n: string, d = '') => R.push({ ok: true, n, d });
const bad = (n: string, d = '') => R.push({ ok: false, n, d });
for (const r of rows) {
  const id = `${r.dark ? 'dark' : 'light'}/${r.reqW}`;
  const l = r.lines;
  if (l.title === 1 && l.subtitle === 1 && l.badge === 1 && l.hint === 1) ok(`N1 头部四块各 1 行 (${id})`, `title=${l.title} sub=${l.subtitle} badge=${l.badge} hint=${l.hint}`);
  else bad(`N1 头部四块各 1 行 (${id})`, `title=${l.title} sub=${l.subtitle} badge=${l.badge} hint=${l.hint}`);
  if (l.start === 1 && r.startScrollH <= r.startClientH) ok(`N2 启动按钮文字 1 行 (${id})`, `lines=${l.start} ${r.startScrollH}<=${r.startClientH} w=${r.startRect?.w}`);
  else bad(`N2 启动按钮文字 1 行 (${id})`, `lines=${l.start} ${r.startScrollH}<=${r.startClientH} w=${r.startRect?.w}`);
  if (r.footerScrollW === r.footerClientW && r.footerH === 47 && r.wordElided === false) ok(`N3 底栏不溢出/高47/状态词不省略 (${id})`, `${r.footerScrollW}==${r.footerClientW} h=${r.footerH}`);
  else bad(`N3 底栏不溢出/高47/状态词不省略 (${id})`, `scroll ${r.footerScrollW}/${r.footerClientW} h=${r.footerH} wordElided=${r.wordElided}`);
  if (r.under24Count === 0) ok(`N4 命中盒全 ≥24 (${id})`, `${r.hitCount} 个`);
  else bad(`N4 命中盒全 ≥24 (${id})`, JSON.stringify(r.under24));
  // N1b：标题/徽标/提示/按钮文字**既 1 行又不被 `…` 截断**（这条才让"窄态换短文案"承重；副标题按设计可截断，不在此列）
  const e = r.elided || {};
  if (e.title === false && e.badge === false && e.hint === false && e.start === false) ok(`N1b 标题/徽标/提示/按钮文字未被截断 (${id})`, `title=${e.title} badge=${e.badge} hint=${e.hint} start=${e.start}`);
  else bad(`N1b 标题/徽标/提示/按钮文字未被截断 (${id})`, `title=${e.title} badge=${e.badge} hint=${e.hint} start=${e.start}`);
  if ((r.texts.primary || '').trim().length > 0) ok(`N5 主按钮仍带文字 (${id})`, `'${r.texts.primary}'`);
  else bad(`N5 主按钮仍带文字 (${id})`, '空文本');
}
const pass = R.filter((x) => x.ok).length, fail = R.filter((x) => !x.ok).length;
const lines = R.map((x) => (x.ok ? 'PASS  ' : 'FAIL  ') + x.n.padEnd(46) + (x.d ? ' — ' + x.d : ''));
lines.push('', `PASS = ${pass}   FAIL = ${fail}`, fail === 0 ? '==> PASS' : '==> FAIL');
fs.writeFileSync(path.join(OUT, `ASSERT-p07-${TAG}.txt`), lines.join('\n') + '\n');
console.log('\n' + lines.slice(-3).join('\n'));
cdp.close();
if (fail > 0) process.exit(1);
