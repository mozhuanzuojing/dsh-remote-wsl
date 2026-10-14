/**
 * t64-narrow.ts —— T64 测量器
 *   phase=m11    ：M11 新旧判据在「收起/展开」两态的对照读数
 *                  旧判据 = 收起时内部可聚焦元素数 = 0（预期两态同值 ⇒ 无区分力）
 *                  新判据 = 收起时正文子节点不存在/不可见（offsetParent===null 或零尺寸），展开后存在且可见
 *   phase=narrow ：窄态行盒（N1/N1b/N2/N4）在 320/359/420 的原始读数，可指定 --locale zh|en
 *                  en 用 CDP Emulation.setLocaleOverride + navigator.language 覆盖构造（并回读面板实际语言）
 * 用法：node t64-narrow.ts --url <tokenUrl> --out <dir> --phase m11|narrow [--locale zh|en]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg('--url'); const OUT = arg('--out', '.'); const PHASE = arg('--phase', 'm11');
const LOCALE = arg('--locale', 'zh'); const CDP_PORT = arg('--cdp', '8965');
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
  send(method: string, params: any = {}): Promise<any> { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000); }); }
  async ev(e: string) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}
const RAIL = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;

async function load(cdp: C, w: number, h: number, locale: string, init?: string) {
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  try { await cdp.send('Emulation.setLocaleOverride', { locale: locale === 'en' ? 'en-US' : 'zh-CN' }); } catch {}
  let sid: string | null = null;
  // ⚠️ en 构造：**只用** CDP 的 setLocaleOverride（早期版本同时 defineProperty(navigator,'language')
  //    会打断 SPA 启动 ⇒ 面板根本不渲染、读数全空；这里去掉那个副作用，并回读实际语言判断是否生效）
  const src = (init || '');
  if (src) { const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src }); sid = r.identifier; }
  await cdp.send('Page.navigate', { url: URL_ }); await sleep(2600);
  if (sid) { try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sid }); } catch {} }
  for (let i = 0; i < 3; i++) {
    const has = await cdp.ev(`(() => !!document.querySelector('[data-dsh-remote-wsl="panel"]'))()`);
    if (has) break;
    await cdp.ev(RAIL); await sleep(2000);
  }
  await sleep(800);
}

/** 通用：一行盒判定 + 省略判定 + 命中盒（⚠️ 只算**可见**控件：菜单收起时的 items 也在 DOM 里，不能算） */
const MEASURE = `(() => {
  const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
  if (!p) return JSON.stringify({ panelGone: true });
  const pr = p.getBoundingClientRect();
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return el.offsetParent !== null && r.width > 0 && r.height > 0; };
  const lineBoxes = (el) => { if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };
  const isElided = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { text: (el.innerText||'').trim().slice(0,30), textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace, scrollW: el.scrollWidth, clientW: el.clientWidth, elided: el.scrollWidth > el.clientWidth + 1 }; };
  const allBtns = Array.from(p.querySelectorAll('button')).map((b)=>({ label:(b.innerText||'').trim().slice(0,26), aria:(b.getAttribute('aria-label')||'').slice(0,26), visible: visible(b), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), inHeader: !!b.closest('.dsh-rw-header-actions'), inMenu: !!b.closest('[role="menu"]'), inFooter: !!b.closest('.dsh-rw-status') }));
  const visBtns = allBtns.filter((b)=>b.visible);
  const headerBtn = Array.from(p.querySelectorAll('.dsh-rw-header-actions button, .dsh-rw-header button')).find(visible) || null;
  const labelOf = (b) => b ? ((b.innerText||'').trim() || (b.getAttribute('aria-label')||'').trim()) : null;
  const hint = Array.from(p.querySelectorAll('.dsh-rw-hint, .dsh-rw-header-meta span, .dsh-rw-header-meta div')).find(visible) || null;
  const status = p.querySelector('.dsh-rw-statusword');
  const extra = p.querySelector('.dsh-rw-extra');
  return JSON.stringify({
    panelWidth: Math.round(pr.width), locale: document.documentElement.lang || null,
    headerBtnLabel: labelOf(headerBtn),
    hintText: hint ? (hint.innerText||'').trim().slice(0,40) : null,
    statusText: status ? (status.innerText||'').trim() : null,
    extraPresent: !!extra, extraHiddenClass: extra ? /hidden/.test(String(extra.className)) : null,
    visibleButtonLabels: visBtns.map((b)=>b.label + (b.aria ? '|' + b.aria.slice(0,14) : '')),
    N1: { btnLines: lineBoxes(headerBtn), hintLines: lineBoxes(hint), statusLines: lineBoxes(status) },
    N1b: { btn: isElided(headerBtn), hint: isElided(hint), status: isElided(status) },
    N2: headerBtn ? { scrollH: headerBtn.scrollHeight, clientH: headerBtn.clientHeight, singleLine: headerBtn.scrollHeight <= headerBtn.clientHeight + 1 } : null,
    N4: { allVisibleOk: visBtns.every((b)=>b.w>=24 && b.h>=24), count: visBtns.length, acts: visBtns.map((b)=>({ label:b.label.slice(0,18), w:b.w, h:b.h, ok:b.w>=24 && b.h>=24 })) },
    allButtons: allBtns
  });
})()`;

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const cdp = new C(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await cdp.connect();
const rep: any = { ts: new Date().toISOString(), phase: PHASE, locale: LOCALE };

if (PHASE === 'm11') {
  await load(cdp, 1280, 900, 'zh');
  const judge = `(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    if (!p) return JSON.stringify({ panelGone: true });
    const d = p.querySelector('details.dsh-rw-fold');
    if (!d) return JSON.stringify({ found:false });
    const body = Array.from(d.children).find((c)=>c.tagName !== 'SUMMARY') || null;
    const oldCriterion = Array.from(d.querySelectorAll('button,a[href],input,select,[tabindex]')).filter((e)=>e.tabIndex>=0 && e.getBoundingClientRect().height>0).length;
    const newCriterion = !body ? 'absent' : ((body.offsetParent === null || body.getBoundingClientRect().height === 0) ? 'not-visible' : 'visible');
    return JSON.stringify({ found:true, summary:(d.querySelector('summary')?.innerText||'').trim(), open:d.open, bodyExists:!!body, bodyH: body?Math.round(body.getBoundingClientRect().height):null, bodyOffsetParentNull: body? body.offsetParent===null : null, bodyTextLen: body?((body.innerText||'').trim().length):null, oldCriterion_focusables: oldCriterion, newCriterion });
  })()`;
  const forceFold = `(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); if(!p) return 'panel-gone'; const d=p.querySelector('details.dsh-rw-fold'); if(!d) return 'fold-gone'; d.open = true; return 'ok'; })()`;
  rep.nativeFold = { closed: JSON.parse(await cdp.ev(judge)) };
  rep.nativeFold.forceResult = await cdp.ev(forceFold);
  await sleep(500);
  rep.nativeFold.forcedOpen = JSON.parse(await cdp.ev(judge));
  // 可展开的折叠：失败态「技术细节（host 原文）」
  await load(cdp, 1280, 900, 'zh');
  await cdp.ev(`(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); if(!p) return 'panel-gone'; const inp=p.querySelector('input[type="text"], input:not([type])'); if(!inp) return 'input-gone'; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(inp,'/definitely/not/here-usab'); inp.dispatchEvent(new Event('input',{bubbles:true})); const b=Array.from(p.querySelectorAll('button')).find((x)=>/跳转/.test(x.innerText||'')); if(b) b.click(); return 'jumped'; })()`);
  await sleep(2500);
  const noteJudge = `(() => {
    const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
    if (!p) return JSON.stringify({ panelGone: true });
    const d = Array.from(p.querySelectorAll('details')).find((x)=>/技术细节/.test(x.querySelector('summary')?.innerText||''));
    if (!d) return JSON.stringify({ found:false });
    const body = Array.from(d.children).find((c)=>c.tagName !== 'SUMMARY') || null;
    const oldCriterion = Array.from(d.querySelectorAll('button,a[href],input,select,[tabindex]')).filter((e)=>e.tabIndex>=0 && e.getBoundingClientRect().height>0).length;
    const newCriterion = !body ? 'absent' : ((body.offsetParent === null || body.getBoundingClientRect().height === 0) ? 'not-visible' : 'visible');
    return JSON.stringify({ found:true, open:d.open, bodyExists:!!body, bodyH: body?Math.round(body.getBoundingClientRect().height):null, bodyOffsetParentNull: body? body.offsetParent===null : null, bodyTextLen: body?((body.innerText||'').trim().length):null, oldCriterion_focusables: oldCriterion, newCriterion });
  })()`;
  const forceNote = `(() => { const p=document.querySelector('[data-dsh-remote-wsl="panel"]'); if(!p) return 'panel-gone'; const d=Array.from(p.querySelectorAll('details')).find((x)=>/技术细节/.test(x.querySelector('summary')?.innerText||'')); if(!d) return 'fold-gone'; d.open = true; return 'ok'; })()`;
  rep.noteFold = { closed: JSON.parse(await cdp.ev(noteJudge)) };
  rep.noteFold.forceResult = await cdp.ev(forceNote);
  await sleep(600);
  rep.noteFold.opened = JSON.parse(await cdp.ev(noteJudge));
  rep.verdict = {
    oldCriterion: `收起=${rep.noteFold.closed.oldCriterion_focusables} 展开=${rep.noteFold.opened.oldCriterion_focusables} ⇒ ${rep.noteFold.closed.oldCriterion_focusables === rep.noteFold.opened.oldCriterion_focusables ? '同值/无区分力（反例成立）' : '有区分力'}`,
    newCriterion: `收起=${rep.noteFold.closed.newCriterion} 展开=${rep.noteFold.opened.newCriterion} ⇒ ${rep.noteFold.closed.newCriterion !== rep.noteFold.opened.newCriterion ? '相反结论/有区分力' : '无区分力'}`
  };
}

if (PHASE === 'narrow') {
  rep.narrow = [];
  for (const w of [320, 359, 420]) {
    await load(cdp, w, 900, LOCALE);
    rep.narrow.push({ requestedWidth: w, innerWidth: await cdp.ev('window.innerWidth'), ...JSON.parse(await cdp.ev(MEASURE)) });
  }
  rep.note = LOCALE === 'en' ? 'en 由 CDP setLocaleOverride + navigator.language 覆盖构造；面板实际语言见 langSample（若仍为中文则说明该构造对该面板无效，需换手段）' : 'zh-CN 基线';
}

fs.writeFileSync(path.join(OUT, `out-t64-${PHASE}-${LOCALE}.json`), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep, null, 1).slice(0, 3000));
cdp.close();
