#!/usr/bin/env node
/**
 * probe-render.ts —— B1/B2 的**真实渲染实测**（真 dsh web 实例 + headless Chrome + CDP）。
 *
 * 为什么必须真浏览器：B2 要的判据是**几何量**（横向溢出 scrollWidth/clientWidth、标题行数、
 * 主按钮命中盒是否被挤出面板）。元素树断言（probe-badge / probe-narrow）只能证明"渲染出什么
 * 元素"，证明不了"排到多宽"。本轮结论里的 320/360 数字全部来自本脚本。
 *
 * 判据（可判形式）：
 *   L1 面板根 `.dsh-rw-root`：`scrollWidth === clientWidth`（无横向溢出），`documentElement` 同。
 *   L2 头部 `.dsh-rw-header` / 头部文字列 `.dsh-rw-header-text` / 元信息行 `.dsh-rw-header-meta`
 *      / 底栏 `.dsh-rw-status` / 主体 `.dsh-rw-body`：全部 `scrollWidth === clientWidth`。
 *   L3 标题 `.dsh-rw-title`：`Range.getClientRects()` 去重后 **1 行**且 `scrollWidth<=clientWidth`
 *      （没被 `…` 吃掉 —— 窄态换短文案的承重判据）。
 *   L4 主按钮 `.dsh-rw-btn--primary`：命中盒 ≥24×24、文字非空、**完整落在面板右边界内**、
 *      文字 1 行。
 *   B1 代理徽标 `.dsh-rw-proxy`：三态（up/down/unknown）各自由快照驱动渲染；`data-proxy-state`
 *      与可见状态一致；徽标文字 **1 行**；徽标完整落在面板内；`aria-label` 与 `title` 非空；
 *      不可达态两者都含 `host:port`（"给出代理地址"）；可见文字取自字典（逐字比对 zh/en 两版）。
 *      三态由**页面内 fetch mock** 改写快照 `proxy.reachable` 得到（不改插件、不改宿主）。
 *
 * 用法（先 `pwsh -File boot.ps1 -Mode Start`）：
 *   node probe-render.ts --cdp 9333 --out . --tag before [--badge] [--shot]
 * 产出：out-render-<tag>.json（原始读数）+ ASSERT-render-<tag>.txt（断言）
 * 退出码：0 全过；1 有断言失败；3 面板没渲染出来 / CDP 不可达。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DIR, '../../..')
const CLIENT = path.join(ROOT, 'client')

const argv = process.argv.slice(2)
const arg = (k: string, d = ''): string => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const has = (k: string) => argv.includes(k)
const CDP_PORT = Number(arg('--cdp', '9333'))
const TAG = arg('--tag', 'x')
const CHECK_BADGE = has('--badge')
const SHOT = has('--shot')
const MOCK = { host: '192.0.2.7', port: 9910 }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// WIDTHS：视口宽 → 面板实宽 = 视口 − 56（rail）。任务点名的 320/360 两档按**视口**量（264/304），
// 同时补齐"面板实宽 320/360"（视口 376/416）与 420/1280 对照。
const WIDTHS = [320, 360, 376, 416, 420, 480, 1280]

// ── 字典（用于逐字核对徽标可见文案；直接装载真 chunk，不复制一份文案）───────────────
function loadChunk(file: string) {
  const registry = new Map<string, any>()
  const sandbox: any = {
    window: { __ModuleLoader__: { load(def: any) { registry.set(def.chunk, def.factory) } } },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', documentElement: { lang: 'zh-CN' } },
    console, setTimeout, clearTimeout, Promise, Symbol, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  const code = fs.readFileSync(path.join(CLIENT, file), 'utf8')
  vm.runInNewContext(code, sandbox, { filename: file })
  const factory = registry.get(file)
  if (!factory) throw new Error('chunk not registered: ' + file)
  return factory((spec: string) => { throw new Error('unexpected require: ' + spec) })
}
const DICTS = loadChunk('client.i18n.js').DICTS

// ── CDP 客户端 ────────────────────────────────────────────────────────────────
class Cdp {
  ws: any
  id = 0
  pending = new Map<number, any>()
  wsUrl: string
  constructor(wsUrl: string) { this.wsUrl = wsUrl }
  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true })
      this.ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
    })
    this.ws.addEventListener('message', (ev: any) => {
      let m: any
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 300))) : p.resolve(m.result)
      }
    })
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)) } }, 40000)
    })
  }
  async ev(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result ? r.result.value : null
  }
  close() { try { this.ws.close() } catch {} }
}

const LIB = `
const _txt=(el)=>el?((el.innerText||el.textContent||'')+'').replace(/\\s+/g,' ').trim():null;
const _lines=(el)=>{if(!el)return null;const r=document.createRange();r.selectNodeContents(el);const rects=Array.from(r.getClientRects()).filter(x=>x.width>0&&x.height>0);if(!rects.length)return 0;return Array.from(new Set(rects.map(x=>Math.round(x.top)))).length;};
const _rect=(el)=>{const r=el.getBoundingClientRect();return {w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10,x:Math.round(r.left*10)/10,y:Math.round(r.top*10)/10,right:Math.round(r.right*10)/10,bottom:Math.round(r.bottom*10)/10};};
const _ov=(el)=>el?{scrollW:el.scrollWidth,clientW:el.clientWidth,overflow:el.scrollWidth>el.clientWidth+1,rect:_rect(el)}:null;
const _elided=(el)=>el?el.scrollWidth>el.clientWidth+1:null;
const _panel=()=>document.querySelector('[data-dsh-remote-wsl="panel"]');
const RAIL=()=>Array.from(document.querySelectorAll('nav button, button')).find((x)=>/远程资源管理器|Remote Explorer/.test((x.getAttribute('aria-label')||'')+(x.innerText||'')));
`

const MOCK_SRC = `(() => {
  if (window.__rwslOrigFetch) return 'already';
  const orig = window.fetch.bind(window);
  window.__rwslOrigFetch = orig;
  window.__rwslMockState = null;
  const MOCK = ${JSON.stringify(MOCK)};
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    const res = await orig(input, init);
    if (!url.includes('/remote-wsl/api') || !window.__rwslMockState) return res;
    try {
      const json = await res.clone().json();
      if (json && json.ok && json.result && json.result.proxy) {
        // 地址也一起钉死：否则"不可达文案里带 host:port"这条只能按运行环境里的真实地址判，不可复现
        json.result.proxy.host = MOCK.host;
        json.result.proxy.port = MOCK.port;
        json.result.proxy.reachable = window.__rwslMockState === 'up' ? true : window.__rwslMockState === 'down' ? false : null;
        return new Response(JSON.stringify(json), { status: res.status, headers: { 'content-type': 'application/json' } });
      }
    } catch (e) {}
    return res;
  };
  return 'installed';
})()`

const MEASURE = `(() => {
  const p=_panel(); if(!p) return JSON.stringify({missing:true});
  const q=(s)=>p.querySelector(s);
  const header=q('.dsh-rw-header'), textCol=q('.dsh-rw-header-text'), meta=q('.dsh-rw-header-meta');
  const acts=q('.dsh-rw-header-actions'), title=q('.dsh-rw-title'), sub=q('.dsh-rw-subtitle');
  const prim=q('.dsh-rw-btn--primary');
  const refresh=acts?Array.from(acts.querySelectorAll('button')).filter(b=>!b.classList.contains('dsh-rw-btn--primary'))[0]:null;
  const proxy=q('.dsh-rw-proxy'), proxyText=q('.dsh-rw-proxy-text');
  const footer=q('.dsh-rw-status'), bodyEl=q('.dsh-rw-body'), card=q('.dsh-rw-card');
  const entries=q('.dsh-rw-entries');
  const pRect=_rect(p);
  const metaRows = meta ? Array.from(new Set(Array.from(meta.children).map(c=>Math.round(c.getBoundingClientRect().top)))) .length : null;
  const pc = proxy ? getComputedStyle(proxy) : null;
  const proxyDot = proxy ? proxy.querySelector('.dsh-rw-dot') : null;
  const dotC = proxyDot ? getComputedStyle(proxyDot) : null;
  const daemonEl = q('.dsh-rw-daemon');
  const dc = daemonEl ? getComputedStyle(daemonEl) : null;
  // 2026-10-23 review ①：徽标/药丸的**文字**对比度必须可算 ⇒ 取所在行的实际背景色。
  const headerBg = header ? getComputedStyle(header).backgroundColor : null;
  // 越界/溢出定位：找出右边界超出面板的元素（最多 8 个）与自身横向溢出的非滚动容器
  const offenders = [];
  const all = p.querySelectorAll('*');
  for (const el of all) {
    if (el.getClientRects().length === 0) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const selfOverflow = el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && cs.overflowX !== 'hidden';
    const out = r.right > pRect.right + 0.5;
    if (out || selfOverflow) {
      offenders.push({ cls: String(el.className || el.tagName).slice(0, 46), w: Math.round(r.width * 10) / 10, right: Math.round(r.right * 10) / 10, selfOverflow, out });
    }
    if (offenders.length >= 12) break;
  }
  const footerKids = footer ? Array.from(footer.children).map((c)=>({ cls:String(c.className||c.tagName).slice(0,30), w:_rect(c).w, txt:(_txt(c)||'').slice(0,16) })) : null;
  return JSON.stringify({
    innerWidth: window.innerWidth,
    panelW: Math.round(pRect.w),
    panel: _ov(p),
    page: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, bodyScrollW: document.body.scrollWidth },
    header: _ov(header), headerText: _ov(textCol), headerMeta: _ov(meta), headerActions: _ov(acts),
    metaRows,
    offenders, footerKids,
    title: { lines: _lines(title), elided: _elided(title), text: _txt(title), rect: title?_rect(title):null },
    subtitle: { lines: _lines(sub), elided: _elided(sub), rect: sub?_rect(sub):null },
    primary: prim ? { rect: _rect(prim), lines: _lines(prim), text: _txt(prim), inside: (_rect(prim).x >= pRect.x - 0.5) && (_rect(prim).right <= pRect.right + 0.5), belowFold: _rect(prim).bottom > window.innerHeight } : null,
    refresh: refresh ? { rect: _rect(refresh), aria: refresh.getAttribute('aria-label') } : null,
    proxy: proxy ? {
      rect: _rect(proxy), lines: _lines(proxyText), text: _txt(proxyText), fullText: _txt(proxy),
      state: proxy.getAttribute('data-proxy-state'), cls: String(proxy.className),
      aria: proxy.getAttribute('aria-label'), title: proxy.getAttribute('title'), role: proxy.getAttribute('role'),
      color: pc ? pc.color : null, borderColor: pc ? pc.borderColor : null,
      dotColor: dotC ? dotC.backgroundColor : null,
      bg: headerBg,
      inside: (_rect(proxy).x >= pRect.x - 0.5) && (_rect(proxy).right <= pRect.right + 0.5),
      dotCls: (q('.dsh-rw-proxy .dsh-rw-dot') || {}).className || null
    } : null,
    daemon: daemonEl ? { color: dc.color, borderColor: dc.borderColor, bg: headerBg } : null,
    footer: _ov(footer), footerH: footer?_rect(footer).h:null,
    body: _ov(bodyEl), card: _ov(card), entries: _ov(entries)
  });
})()`

// ── 连接 ─────────────────────────────────────────────────────────────────────
let page: any = null
for (let i = 0; i < 40; i += 1) {
  try {
    const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as any[]
    page = list.find((t) => t.type === 'page') || null
    if (page) break
  } catch {}
  await sleep(500)
}
if (!page) { console.log('FAIL: CDP 不可达或没有 page target（先跑 boot.ps1 -Mode Start）'); process.exit(3) }
const cdp = new Cdp(page.webSocketDebuggerUrl)
await cdp.connect()
await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable')

/** 打开面板 + 等快照就绪（标题出现即可量几何；徽标要等 factsVisible）。 */
async function ensurePanel() {
  await cdp.ev(`(() => { const b=RAIL(); if(b) b.click(); return !!b; })()`)
  for (let i = 0; i < 40; i += 1) {
    const ready = await cdp.ev(`(() => { const p=_panel(); return !!(p && p.querySelector('.dsh-rw-title') && p.querySelector('.dsh-rw-header-actions')); })()`)
    if (ready) return true
    await sleep(500)
  }
  return false
}

// 首启模态（全新隔离 home 会弹"开始使用 / 配置 API Key"）⇒ 先点"稍后/跳过"，再关掉剩下的对话框
// （隔离实例没有账号 ⇒ 面板背后永远压着一层"开始使用"；不关掉会挡住截图与列表区域的可见性判读）
async function dismissModals() {
  for (let i = 0; i < 5; i += 1) {
    const r = await cdp.ev(`(() => {
      const txt=(x)=>(((x.innerText||x.textContent||'')+'')).trim();
      const c=Array.from(document.querySelectorAll('button,[role="button"]')).filter((x)=>/^(稍后配置|稍后再说|稍后|跳过|跳过配置|以后再说|Skip|Later|Not now|继续|我知道了|同意|Got it|Continue|OK|好的)$/.test(txt(x)));
      const s=c.find((x)=>/稍后|跳过|以后再说|Skip|Later|Not now/.test(txt(x)));
      const pick=s||c[0]; if(!pick) return 'none'; pick.click(); return txt(pick);
    })()`)
    if (!r || r === 'none') break
    await sleep(700)
  }
  for (let i = 0; i < 3; i += 1) {
    const has = await cdp.ev(`!!document.querySelector('[role="dialog"], dialog[open]')`)
    if (!has) break
    const closed = await cdp.ev(`(() => {
      const d = document.querySelector('[role="dialog"], dialog[open]');
      if (!d) return 'no-dialog';
      const b = Array.from(d.querySelectorAll('button')).find((x)=>/关闭|Close|Dismiss/.test(x.getAttribute('aria-label')||'') || String(x.className).indexOf('close') >= 0);
      if (!b) return 'no-close-button';
      b.click(); return 'clicked';
    })()`)
    if (closed === 'no-close-button') {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    await sleep(500)
  }
}

await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: LIB })
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.navigate', { url: page.url })
await sleep(2600)
await dismissModals()
if (!(await ensurePanel())) { console.log('FAIL: 面板没渲染出来（rail 点不开 / 插件未装载）'); process.exit(3) }
const mockInstalled = await cdp.ev(MOCK_SRC)
console.log('fetch mock =', mockInstalled)

const rows: any[] = []
async function setState(state: string) {
  await cdp.ev(`window.__rwslMockState = ${JSON.stringify(state)}`)
  // 触发一次真实快照请求（refresh 按钮 = 头部动作区最后一个非主按钮）
  const clicked = await cdp.ev(`(() => {
    const p=_panel(); const acts=p.querySelector('.dsh-rw-header-actions');
    const btn=Array.from(acts.querySelectorAll('button')).filter(b=>!b.classList.contains('dsh-rw-btn--primary'))[0];
    if(!btn) return 'no-refresh'; btn.click(); return 'clicked';
  })()`)
  if (clicked !== 'clicked') return false
  const want = state === 'up' ? 'up' : state === 'down' ? 'down' : 'unknown'
  for (let i = 0; i < 24; i += 1) {
    await sleep(400)
    const got = await cdp.ev(`(() => { const el=document.querySelector('[data-dsh-remote-wsl="panel"] [data-proxy-state]'); return el ? el.getAttribute('data-proxy-state') : null; })()`)
    if (got === want) return true
  }
  return false
}

for (const w of WIDTHS) {
  const states = w === 420 ? ['unknown'] : ['up', 'down', 'unknown']
  for (const state of states) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(350)
    const okState = await setState(state)
    const raw = await cdp.ev(MEASURE)
    let m: any
    try { m = JSON.parse(raw) } catch { m = { parseError: String(raw).slice(0, 200) } }
    rows.push({ tag: TAG, reqW: w, state, stateReached: okState, ...m })
    console.log(`${TAG} w=${String(w).padStart(4)} state=${String(m.proxy ? m.proxy.state : '-').padEnd(7)} panelW=${m.panelW} title行=${m.title?.lines} 主按钮w=${m.primary?.rect?.w} 徽标='${m.proxy?.text}' 徽标行=${m.proxy?.lines} 面板溢出=${m.panel?.overflow} 头部溢出=${m.header?.overflow} 底栏溢出=${m.footer?.overflow}`)
  }
}

// ── 截图（320/360 两档，down 态：最长的"不可达 host:port"文案）──
if (SHOT) {
  const shots: any[] = []
  for (const w of [320, 360]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    await setState('down')
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const f = `shot-${TAG}-${w}-down.png`
    fs.writeFileSync(path.join(DIR, f), Buffer.from(r.data, 'base64'))
    shots.push({ file: f, bytes: fs.statSync(path.join(DIR, f)).size })
    console.log('shot', f, shots[shots.length - 1].bytes, 'B')
  }
  fs.writeFileSync(path.join(DIR, `out-shots-${TAG}.json`), JSON.stringify(shots, null, 2) + '\n', 'utf8')
}

fs.writeFileSync(path.join(DIR, `out-render-${TAG}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), cdpPort: CDP_PORT, widthList: WIDTHS, badgeChecked: CHECK_BADGE, mock: MOCK, rows }, null, 2) + '\n', 'utf8')

// ── 断言 ─────────────────────────────────────────────────────────────────────
const R: { ok: boolean; n: string; d: string }[] = []
const ok = (n: string, d = '') => R.push({ ok: true, n, d })
const bad = (n: string, d = '') => R.push({ ok: false, n, d })
const zhText = (k: string, v?: any) => interpolate(DICTS.zh[k] ?? '', v)
const enText = (k: string, v?: any) => interpolate(DICTS.en[k] ?? '', v)
function interpolate(tpl: string, vars?: any) {
  if (!vars) return tpl
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => (vars[k] === undefined ? '{' + k + '}' : String(vars[k])))
}

// ── 对比度（WCAG 2.x 相对亮度）——2026-10-23 review ① 用真实渲染色算，不靠眼睛 ──────────────
const parseRgb = (s: string | null): [number, number, number] | null => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(s ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const relLum = (rgb: [number, number, number]) => {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}
const contrast = (fg: string | null, bg: string | null): number | null => {
  const a = parseRgb(fg), b = parseRgb(bg)
  if (!a || !b) return null
  const la = relLum(a), lb = relLum(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

for (const r of rows) {
  const id = `w=${r.reqW}/panel=${r.panelW}/${r.state}`
  if (r.missing) { bad(`L0 面板存在 (${id})`, 'missing'); continue }
  const noOverflow = [
    ['面板', r.panel], ['头部', r.header], ['头部文字列', r.headerText], ['元信息行', r.headerMeta],
    ['底栏', r.footer], ['主体', r.body], ['卡片', r.card],
  ] as [string, any][]
  const bads = noOverflow.filter(([, v]) => !v || v.overflow).map(([k, v]) => `${k}:${v ? v.scrollW + '>' + v.clientW : 'null'}`)
  if (bads.length === 0 && r.page.scrollW <= r.page.clientW + 1) ok(`L1/L2 无横向溢出 (${id})`, `page ${r.page.scrollW}/${r.page.clientW}, panel ${r.panel.scrollW}/${r.panel.clientW}`)
  else bad(`L1/L2 无横向溢出 (${id})`, bads.join(' ') + ` page ${r.page.scrollW}/${r.page.clientW}`)
  if (r.title.lines === 1 && r.title.elided === false) ok(`L3 标题 1 行且未被省略 (${id})`, `'${r.title.text}'`)
  else bad(`L3 标题 1 行且未被省略 (${id})`, `lines=${r.title.lines} elided=${r.title.elided}`)
  if (r.primary && r.primary.inside && r.primary.rect.w >= 24 && r.primary.rect.h >= 24 && r.primary.lines === 1 && String(r.primary.text || '').length > 0 && !r.primary.belowFold)
    ok(`L4 主按钮可见/命中盒≥24/文字1行/不越界 (${id})`, `w=${r.primary.rect.w} h=${r.primary.rect.h} '${r.primary.text}'`)
  else bad(`L4 主按钮可见/命中盒≥24/文字1行/不越界 (${id})`, JSON.stringify(r.primary))
  if (!CHECK_BADGE) continue
  const p = r.proxy
  if (!p) { bad(`B1-1 徽标存在 (${id})`, 'null'); continue }
  if (p.state === r.state) ok(`B1-1 徽标三态与快照一致 (${id})`, `state=${p.state} cls=${p.cls}`)
  else bad(`B1-1 徽标三态与快照一致 (${id})`, `want=${r.state} got=${p.state}`)
  if (p.lines === 1) ok(`B1-2 徽标文字 1 行（窄态不折行） (${id})`, `'${p.text}'`)
  else bad(`B1-2 徽标文字 1 行（窄态不折行） (${id})`, `lines=${p.lines} text='${p.text}'`)
  if (p.inside) ok(`B1-3 徽标在面板内 (${id})`, `x=${p.rect.x} right=${p.rect.right}`)
  else bad(`B1-3 徽标在面板内 (${id})`, JSON.stringify(p.rect))
  if (p.aria && p.title && p.aria.length > 4 && p.title.length > 4) ok(`B1-4 徽标有 aria-label 与 title (${id})`, p.aria.slice(0, 70))
  else bad(`B1-4 徽标有 aria-label 与 title (${id})`, JSON.stringify({ aria: p.aria, title: p.title }))
  if (p.role === 'img') ok(`B1-5 徽标 role=img（可被 AT 读成单一对象） (${id})`, 'img')
  else bad(`B1-5 徽标 role=img (${id})`, String(p.role))
  // 颜色：三态必须取到宿主 token 且互不相同（颜色只是第三冗余，但必须有）
  if (p.color && p.color !== 'rgb(0, 0, 0)') ok(`B1-6 徽标取到宿主 token 颜色 (${id})`, `${p.color} / border ${p.borderColor}`)
  else bad(`B1-6 徽标取到宿主 token 颜色 (${id})`, String(p.color))
  // 可见文案：**窄/宽两档分别**逐字对齐字典（窄态短键、宽态长键；用错档也算失败）
  const narrowPanel = r.panelW < 420
  const expectAny = (state: 'up' | 'down' | 'unknown') => {
    const longs: string[] = []
    const shorts = [zhText(`proxy.${state}Short`), enText(`proxy.${state}Short`)]
    if (state === 'down') longs.push(zhText('proxy.downAt', { endpoint: `${MOCK.host}:${MOCK.port}` }), enText('proxy.downAt', { endpoint: `${MOCK.host}:${MOCK.port}` }))
    else longs.push(zhText(`proxy.${state}`), enText(`proxy.${state}`))
    return narrowPanel ? { want: shorts, wantName: '短文案' } : { want: longs, wantName: '完整文案' }
  }
  const exp = expectAny(r.state as 'up' | 'down' | 'unknown')
  if (exp.want.includes(p.text)) ok(`B1-7 ${r.state} 态文案取自字典且档位正确（面板 ${r.panelW}${narrowPanel ? '<' : '≥'}420 ⇒ ${exp.wantName}） (${id})`, `'${p.text}'`)
  else bad(`B1-7 ${r.state} 态文案取自字典且档位正确（面板 ${r.panelW}${narrowPanel ? '<' : '≥'}420 ⇒ ${exp.wantName}） (${id})`, `'${p.text}' ∉ ${JSON.stringify(exp.want)}`)
  if (r.state === 'down') {
    const hasEndpoint = (s: string) => String(s || '').includes(`${MOCK.host}:${MOCK.port}`)
    if (hasEndpoint(p.aria) && hasEndpoint(p.title)) ok(`B1-8 不可达态 aria/title 给出代理地址 (${id})`, `${MOCK.host}:${MOCK.port}`)
    else bad(`B1-8 不可达态 aria/title 给出代理地址 (${id})`, JSON.stringify({ aria: p.aria, title: p.title }))
    if (narrowPanel && !hasEndpoint(p.text)) ok(`B1-8b 窄态可见文字让位给短词（地址仍在 aria/title） (${id})`, `'${p.text}'`)
    else if (!narrowPanel && hasEndpoint(p.text)) ok(`B1-8c 宽态可见文字直接给出代理地址 (${id})`, `'${p.text}'`)
    else bad(`B1-8b/c 不可达态可见文字与档位不符 (${id})`, `panel=${r.panelW} text='${p.text}'`)
  }
  // 2026-10-23 review ①：文字对比度（WCAG AA 正文 4.5:1）。状态色只允许出现在圆点/边框上，
  // 文字必须是 label-primary/secondary —— 否则浅色主题下琥珀/绿只有 2.1–2.3:1。
  const crBadge = contrast(p.color, p.bg)
  if (crBadge !== null && crBadge >= 4.5) ok(`B1-11 徽标文字对比度 ≥4.5:1 (${id})`, `${p.color} on ${p.bg} = ${crBadge.toFixed(2)}`)
  else bad(`B1-11 徽标文字对比度 ≥4.5:1 (${id})`, `${p.color} on ${p.bg} = ${crBadge === null ? 'n/a' : crBadge.toFixed(2)}`)
  if (r.daemon) {
    const crDaemon = contrast(r.daemon.color, r.daemon.bg)
    if (crDaemon !== null && crDaemon >= 4.5) ok(`B1-12 守护药丸文字对比度 ≥4.5:1 (${id})`, `${r.daemon.color} on ${r.daemon.bg} = ${crDaemon.toFixed(2)}`)
    else bad(`B1-12 守护药丸文字对比度 ≥4.5:1 (${id})`, `${r.daemon.color} on ${r.daemon.bg} = ${crDaemon === null ? 'n/a' : crDaemon.toFixed(2)}`)
  }
}

// 三态**状态色**互不相同（同一视口下）——2026-10-23 review ① 起，状态色改由圆点/边框承载（文字走
// label-primary/secondary 保对比度），所以这里比 borderColor 与 dotColor 两个通道，不再比文字色。
{
  const byW = new Map<number, any[]>()
  for (const r of rows) { if (!byW.has(r.reqW)) byW.set(r.reqW, []); byW.get(r.reqW)!.push(r) }
  for (const [w, list] of byW) {
    const ups = list.find((x) => x.state === 'up' && x.proxy)
    const downs = list.find((x) => x.state === 'down' && x.proxy)
    const unks = list.find((x) => x.state === 'unknown' && x.proxy)
    if (!ups || !downs || !unks) continue
    const borders = [ups.proxy.borderColor, downs.proxy.borderColor, unks.proxy.borderColor]
    if (new Set(borders).size === 3) ok(`B1-9 三态边框色互不相同 (w=${w})`, borders.join(' | '))
    else bad(`B1-9 三态边框色互不相同 (w=${w})`, borders.join(' | '))
    const dotColors = [ups.proxy.dotColor, downs.proxy.dotColor, unks.proxy.dotColor]
    if (new Set(dotColors).size === 3) ok(`B1-9b 三态圆点色互不相同（状态色通道） (w=${w})`, dotColors.join(' | '))
    else bad(`B1-9b 三态圆点色互不相同 (w=${w})`, dotColors.join(' | '))
    const dots = [ups.proxy.dotCls, downs.proxy.dotCls, unks.proxy.dotCls]
    if (new Set(dots).size === 3) ok(`B1-10 三态圆点形状/种类互不相同（形状通道） (w=${w})`, dots.join(' | '))
    else bad(`B1-10 三态圆点互不相同 (w=${w})`, dots.join(' | '))
  }
}

const pass = R.filter((x) => x.ok).length
const fail = R.length - pass
const lines = R.map((x) => (x.ok ? 'PASS  ' : 'FAIL  ') + x.n.padEnd(56) + (x.d ? ' — ' + x.d : ''))
lines.push('', `读数来源：out-render-${TAG}.json（${rows.length} 条：${WIDTHS.join('/')} × 三态）`, `PASS = ${pass}   FAIL = ${fail}`, fail === 0 ? '==> PASS' : '==> FAIL')
fs.writeFileSync(path.join(DIR, `ASSERT-render-${TAG}.txt`), lines.join('\n') + '\n', 'utf8')
console.log('\n' + lines.slice(-4).join('\n'))
cdp.close()
process.exit(fail === 0 ? 0 : 1)
