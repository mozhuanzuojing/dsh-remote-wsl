/**
 * t65-contrast.ts —— task-65：在**当前 HEAD 的真实例**上复算 WCAG 对比度（dark+light）、补拍 320 菜单/hover、
 *                    并给 `box-sizing-audit` 的 2 条候选做逐条裁定。
 *
 * 用法： node t65-contrast.ts --url <tokenUrl> --out <dir> --disk <vendorDir> [--cdp 8968] [--phase integrity|contrast|shots|boxes|red|all]
 *
 * 与静态工具的分工：
 *   · `visual/tools/contrast-check.ts`（静态）= 从 app.asar 解析 **token 声明值** 再算 —— 仍是"旧值"基线；
 *   · 本脚本（实测）= 在同一实例里读 `getComputedStyle` 的**实际计算值**，并且：
 *       ① token 组（58）按静态工具**同一套 GROUPS**（从源码解析，避免手抄）在**实时取值**上重算；
 *       ② 元素级（真 DOM）另外取"**沿父链合成后的实际背景**"，而不是只取声明值。
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg("--url"); const OUT = arg("--out", "."); const DISK = arg("--disk", ""); const CDP_PORT = arg("--cdp", "8968"); const PHASE = arg("--phase", "all");
const TOOLS = path.join(OUT, "..", "tools");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 从静态工具源码解析 GROUPS（避免手抄 58 条）──
const src = fs.readFileSync(path.join(TOOLS, "contrast-check.ts"), "utf8");
const GROUPS = [...src.matchAll(/\{\s*id:\s*"([^"]+)",\s*fg:\s*"([^"]+)",\s*bg:\s*"([^"]+)",\s*kind:\s*"([^"]+)"/g)]
  .map((m) => ({ id: m[1], fg: m[2], bg: m[3], kind: m[4] }));
if (GROUPS.length === 0) { console.error("GROUPS 解析失败"); process.exit(2); }

class C {
  ws: any; id = 0; pending = new Map<number, any>(); wsUrl: string;
  constructor(wsUrl: string) { this.wsUrl = wsUrl; }
  async connect() { this.ws = new WebSocket(this.wsUrl); await new Promise<void>((res, rej) => { this.ws.addEventListener("open", () => res(), { once: true }); this.ws.addEventListener("error", () => rej(new Error("ws")), { once: true }); }); this.ws.addEventListener("message", (ev: any) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  send(method: string, params: any = {}): Promise<any> { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 40000); }); }
  async ev(expr: string) { const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 220)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}

const RAIL = `(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (!b) return 'rail-not-found'; b.click(); return 'clicked'; })()`;

// 页面内工具：颜色解析 / src-over 合成 / WCAG / **沿父链合成背景**
const LIB = `
// ⚠️ token 的 computed 值是 **hex**（如 #ffffff1f），元素 color 才是 rgb()/rgba() ⇒ 解析器必须两种都吃
// （T65 自查踩到：只认 rgb() 时 58 组全被判 unresolved，而"不达标 0"看起来像全过 ⇒ 假绿）
const _p = (s) => {
  const t = String(s||'').trim();
  const hm = t.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hm) { let h = hm[1]; if (h.length===3) h = h.split('').map((c)=>c+c).join(''); if (h.length===4) h = h.split('').map((c)=>c+c).join('');
    if (h.length!==6 && h.length!==8) return null; if (h.length===6) h += 'ff';
    return { r:parseInt(h.slice(0,2),16), g:parseInt(h.slice(2,4),16), b:parseInt(h.slice(4,6),16), a:parseInt(h.slice(6,8),16)/255 }; }
  const m = t.match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
  const a=m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
  return { r:a[0], g:a[1], b:a[2], a:(a.length>3?a[3]:1) };
};
const _hex = (c) => c ? ('#' + [c.r,c.g,c.b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('') + (c.a!==undefined? '/'+c.a.toFixed(2):'')) : null;
const _over = (f,b) => !f ? b : !b ? f : ({ r:f.r*f.a+b.r*(1-f.a), g:f.g*f.a+b.g*(1-f.a), b:f.b*f.a+b.b*(1-f.a), a:1 });
const _lum = (c) => { const g=(v)=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*g(c.r)+0.7152*g(c.g)+0.0722*g(c.b); };
// ⚠️ 返回**未取整**的比值：先 round 再跟 4.5 比会把 4.4955 判成 PASS（T65 自查踩到，G6/G10 两个"判定翻转"就是这么来的）
const _ratio = (f,b) => { if(!f||!b) return null; const l1=_lum(f), l2=_lum(b); const hi=Math.max(l1,l2), lo=Math.min(l1,l2); return (hi+0.05)/(lo+0.05); };
const _r2 = (x) => x === null || x === undefined ? null : Math.round(x*100)/100;
/** 沿父链求**实际生效背景**：从元素往上收集带 alpha 的 background-color，遇到不透明即停，再自外向内 src-over */
const _effBg = (el) => {
  const chain = []; let n = el;
  while (n && n.nodeType === 1) { const c=_p(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { chain.push(c); if (c.a >= 0.999) break; } n = n.parentElement; }
  let base = chain.length && chain[chain.length-1].a >= 0.999 ? chain[chain.length-1] : null;
  if (!base) { const hb=_p(getComputedStyle(document.documentElement).backgroundColor), bb=_p(getComputedStyle(document.body).backgroundColor);
    base = (bb && bb.a>=0.999) ? bb : (hb && hb.a>=0.999) ? hb : {r:255,g:255,b:255,a:1}; }
  for (let i = chain.length-1; i >= 0; i--) base = _over(chain[i], base);
  return base;
};
const _tok = (name) => { const v = getComputedStyle(document.body).getPropertyValue(name).trim() || getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v; };
const _txt = (el) => el ? ((el.innerText||el.textContent||'')+'').replace(/\\s+/g,' ').trim() : null;
const _panel = () => document.querySelector('[data-dsh-remote-wsl="panel"]');
const _rect = (el) => { const r=el.getBoundingClientRect(); return {w:Math.round(r.width*10)/10,h:Math.round(r.height*10)/10}; };
`;

async function load(cdp: C, w = 1280, h = 900, dark = false) {
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  const r1 = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LIB });
  await cdp.send("Page.navigate", { url: URL_ }); await sleep(2500);
  try { await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: r1.identifier }); } catch {}
  for (let i = 0; i < 4; i++) {
    const r = await cdp.ev(`(() => { const txt=(x)=>(((x.innerText||x.textContent||'')+'')).trim(); const c=Array.from(document.querySelectorAll('button,[role="button"]')).filter((x)=>/^(稍后配置|稍后再说|稍后|跳过|跳过配置|以后再说|Skip|Later|Not now|继续|我知道了|同意|Got it|Continue|OK|好的)$/.test(txt(x))); const s=c.find((x)=>/稍后|跳过|以后再说|Skip|Later|Not now/.test(txt(x))); const pick=s||c[0]; if(!pick) return 'none'; pick.click(); return txt(pick); })()`);
    if (!r || r === "none") break;
    await sleep(700);
  }
  await cdp.ev(RAIL); await sleep(2200);
}
async function shot(cdp: C, f: string) { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, f), Buffer.from(r.data, "base64")); return fs.statSync(path.join(OUT, f)).size; }
async function forceHover(cdp: C, selector: string, on = true) {
  return forcePseudo(cdp, selector, on ? ["hover"] : []);
}
/** 用 CDP 强制伪类（hover / focus / focus-visible / active）——比 el.focus() 可靠：:focus-visible 不会因脚本聚焦而命中 */
async function forcePseudo(cdp: C, selector: string, classes: string[]) {
  const doc = await cdp.send("DOM.getDocument", {});
  const q = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  if (!q.nodeId) return false;
  await cdp.send("CSS.forcePseudoState", { nodeId: q.nodeId, forcedPseudoClasses: classes });
  return true;
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const page = targets.find((t: any) => t.type === "page");
if (!page) { console.error("no page target"); process.exit(3); }
const cdp = new C(page.webSocketDebuggerUrl); await cdp.connect();
const rep: any = { ts: new Date().toISOString(), head: null, url: URL_.replace(/token=[^&]+/, "token=***") };

// ═══ 前置：页面 chunk == 磁盘（trailer 判法）═══
if (PHASE === "integrity" || PHASE === "all") {
  await load(cdp, 1280, 900, false);
  const urls = JSON.parse(await cdp.ev(`(() => JSON.stringify(performance.getEntriesByType('resource').map((e)=>e.name).filter((n)=>/\\/plugins\\/dsh-remote-wsl\\//.test(n))))()`) || "[]");
  const parsed = JSON.parse(await cdp.ev(`(async () => { const list=${JSON.stringify(urls)}; const out={}; for (const u of list) { const abs=new URL(u, location.href).href; const r=await fetch(abs,{cache:'no-store'}); const buf=new Uint8Array(await r.arrayBuffer()); const text=new TextDecoder().decode(buf); const m=text.match(/\\n\\/\\/# sourceMappingURL=[^\\n]*\\n?$/); const body=m?text.slice(0,text.length-m[0].length):text; const bb=new TextEncoder().encode(body); let bin=''; for(let i=0;i<bb.length;i+=8192) bin+=String.fromCharCode.apply(null,Array.from(bb.subarray(i,i+8192))); out[abs.split('/').pop().split('?')[0]]={ servedBytes:buf.length, trailer:m?m[0].trim():null, b64:btoa(bin) }; } return JSON.stringify(out); })()`) || "{}");
  const cmp: any = {};
  for (const [name, vv] of Object.entries(parsed) as any) {
    const dp = path.join(DISK, "client", name);
    if (!fs.existsSync(dp)) { cmp[name] = { note: "磁盘无此文件" }; continue; }
    const db = fs.readFileSync(dp); const served = Buffer.from(vv.b64, "base64");
    cmp[name] = { diskBytes: db.length, servedBytes: vv.servedBytes, prefixMatch: served.subarray(0, db.length).equals(db) ? "PASS" : "FAIL", appended: JSON.stringify(served.subarray(db.length).toString("utf8")), trailer: vv.trailer };
  }
  rep.integrity = { chunkCount: urls.length, allPass: Object.values(cmp).every((c: any) => c.prefixMatch === "PASS"), chunks: cmp };
  fs.writeFileSync(path.join(OUT, "out-t65-integrity.json"), JSON.stringify(rep.integrity, null, 2));
  console.log(`integrity: ${rep.integrity.chunkCount} chunk, allPass=${rep.integrity.allPass}`);
}

// ═══ ① 对比度：58 组 token（实测值）+ 元素级（沿父链合成背景）═══
const ELEMENT_TARGETS = [
  { name: "标题 .dsh-rw-title", sel: ".dsh-rw-title", kind: "text" },
  { name: "副标题 .dsh-rw-subtitle", sel: ".dsh-rw-subtitle", kind: "text" },
  { name: "头部提示 .dsh-rw-hint", sel: ".dsh-rw-hint", kind: "text" },
  { name: "徽标 .dsh-rw-badge", sel: ".dsh-rw-badge", kind: "text" },
  { name: "底栏状态词 .dsh-rw-statusword", sel: ".dsh-rw-statusword", kind: "text" },
  { name: "底栏会话数 .dsh-rw-extra", sel: ".dsh-rw-extra", kind: "text" },
  { name: "底栏更新时间 .dsh-rw-updated", sel: ".dsh-rw-updated", kind: "text" },
  { name: "卡片标题 .dsh-rw-cardhead", sel: ".dsh-rw-cardhead", kind: "text" },
  { name: "主按钮文字 .dsh-rw-btn--primary", sel: ".dsh-rw-btn--primary", kind: "text" },
  { name: "普通按钮文字 .dsh-rw-btn", sel: ".dsh-rw-btn", kind: "text" },
  { name: "chip 文字 .dsh-rw-chip", sel: ".dsh-rw-chip", kind: "text" },
  { name: "面包屑 .dsh-rw-crumb", sel: ".dsh-rw-crumb", kind: "text" },
  { name: "行内动作 .dsh-rw-link", sel: ".dsh-rw-link", kind: "text" },
  { name: "输入框文字 .dsh-rw-path-input", sel: ".dsh-rw-path-input", kind: "text" },
  // 非文本：状态点要看**边框色**（stopped 是空心点：background = bg-base，状态色在 border 上）
  { name: "状态点(空心/停止) border .dsh-rw-dot", sel: ".dsh-rw-dot", kind: "nontext-border" },
  // 非文本：跳过 --primary（填充按钮的 border 与 fill 同色，是设计，不是可感知边界）
  { name: "按钮描边(非主) .dsh-rw-btn:not(--primary)", sel: ".dsh-rw-btn:not(.dsh-rw-btn--primary)", kind: "nontext-border" },
  { name: "卡片描边 .dsh-rw-card", sel: ".dsh-rw-card", kind: "nontext-border" },
  { name: "输入框描边 .dsh-rw-path-input", sel: ".dsh-rw-path-input", kind: "nontext-border" },
];

if (PHASE === "contrast" || PHASE === "all") {
  const out: any[] = [];
  for (const dark of [false, true]) {
    await load(cdp, 1280, 900, dark);
    // ①a token 组：实时取值 + 与静态同法合成
    const tokRes = JSON.parse(await cdp.ev(`(() => {
      const names = ${JSON.stringify([...new Set(GROUPS.flatMap((g) => [g.fg, g.bg]))])};
      const vals = {}; for (const n of names) vals[n] = _tok(n);
      const base = _p(_tok('--dsw-alias-bg-base')) || {r:255,g:255,b:255,a:1};
      const res = ${JSON.stringify(GROUPS)}.map((g) => {
        const fg=_p(vals[g.fg]), bg=_p(vals[g.bg]);
        if (!fg || !bg) return { id:g.id, unresolved:true, fgRaw:vals[g.fg]||null, bgRaw:vals[g.bg]||null };
        const bgOpaque = bg.a < 1 ? _over(bg, base) : bg;
        const fgOn = _over(fg, bgOpaque);
        return { id:g.id, kind:g.kind, fgRaw:vals[g.fg], bgRaw:vals[g.bg], fgHex:_hex(fg), bgHex:_hex(bg), bgOpaqueHex:_hex(bgOpaque), ratio:_ratio(fgOn, bgOpaque) };
      });
      return JSON.stringify({ colorScheme: getComputedStyle(document.documentElement).colorScheme, tokens: vals, res });
    })()`));
    // ①b 元素级：真实元素 + 沿父链合成背景
    const elRes = JSON.parse(await cdp.ev(`(() => {
      const p = _panel();
      const list = ${JSON.stringify(ELEMENT_TARGETS)};
      const res = list.map((t) => {
        const el = p ? p.querySelector(t.sel) : null;
        if (!el) return { name:t.name, sel:t.sel, kind:t.kind, missing:true };
        const cs = getComputedStyle(el);
        const bg = _effBg(el);
        let fg = _p(cs.color), fgKind = 'color';
        if (t.kind === 'nontext') { fg = _p(cs.backgroundColor); fgKind = 'background-color'; }
        if (t.kind === 'nontext-border') { fg = _p(cs.borderTopColor); fgKind = 'border-color'; }
        const fgOn = _over(fg, bg);
        return { name:t.name, sel:t.sel, kind:t.kind, text:(_txt(el)||'').slice(0,24), fontSize:cs.fontSize, fontWeight:cs.fontWeight,
          fgKind, fgRaw: (t.kind==='text'?cs.color: t.kind==='nontext'?cs.backgroundColor:cs.borderTopColor), fgHex:_hex(fg), bgHex:_hex(bg),
          bgChainNote: (()=>{ let n=el, hops=0, chain=[]; while(n && n.nodeType===1 && hops<6){ const c=_p(getComputedStyle(n).backgroundColor); chain.push(String(n.className||n.tagName).slice(0,22)+'='+_hex(c)); if(c&&c.a>=0.999) break; n=n.parentElement; hops++; } return chain; })(),
          ratio:_ratio(fgOn, bg) };
      });
      return JSON.stringify({ colorScheme: getComputedStyle(document.documentElement).colorScheme, res });
    })()`));
    // ①c 焦点环（3:1，非文本）：用 CDP 强制 `:focus-visible`，取 outline / box-shadow 的**实际颜色**再与生效背景比
    const focus: any = { probes: [] };
    for (const [label, sel, needOpen] of [["底栏主按钮", ".dsh-rw-status .dsh-rw-btn", false], ["行内动作", ".dsh-rw-link", false], ["路径输入框", ".dsh-rw-path-input", false], ["菜单项(浮层上)", ".dsh-rw-menu .dsh-rw-menuitem", true]] as [string, string, boolean][]) {
      if (needOpen) { await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b && b.getAttribute('aria-expanded')!=='true') b.click(); return true; })()`); await sleep(400); }
      else { await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b && b.getAttribute('aria-expanded')==='true') b.click(); return true; })()`); }
      const applied = await forcePseudo(cdp, sel, ["focus", "focus-visible"]);
      await sleep(120);
      const probe = JSON.parse(await cdp.ev(`(() => {
        const p=_panel(); const el=p.querySelector(${JSON.stringify(sel)});
        if (!el) return JSON.stringify({ missing:true });
        const cs=getComputedStyle(el), bg=_effBg(el);
        const oc=_p(cs.outlineColor), ow=parseFloat(cs.outlineWidth)||0;
        const ringOn = cs.outlineStyle!=='none' && ow>0;
        // box-shadow 里的第一个颜色（内圈 hairline / 双色焦点指示）
        const sm=(cs.boxShadow||'').match(/rgba?\\([^)]+\\)|#[0-9a-fA-F]{3,8}/);
        const sc = sm ? _p(sm[0]) : null;
        return JSON.stringify({ outlineColor:cs.outlineColor, outlineWidth:cs.outlineWidth, outlineStyle:cs.outlineStyle, outlineOffset:cs.outlineOffset,
          boxShadow:cs.boxShadow, bgHex:_hex(bg),
          ringRatio: ringOn ? _ratio(_over(oc,bg), bg) : null,
          shadowColor: sm?sm[0]:null, shadowRatio: (sc && cs.boxShadow!=='none') ? _ratio(_over(sc,bg), bg) : null,
          // 双色焦点指示（T43 裁决）：内圈 hairline 与蓝环之间的对比 —— 两者不必各自 ≥3（浮层上做不到），但**两色之间**要能分辨
          pairRatio: (sc && oc) ? _ratio(_over(sc,bg), _over(oc,bg)) : null });
      })()`));
      await forcePseudo(cdp, sel, []);
      focus.probes.push({ label, sel, applied, ...probe });
    }
    // 悬浮/选中填充是否可感知（R8/R9 的实例版）
    focus.hoverFill = JSON.parse(await cdp.ev(`(() => {
      const p=_panel(); const row=p.querySelector('.dsh-rw-row'); if(!row) return JSON.stringify({missing:true});
      const cs=getComputedStyle(row), bg=_effBg(row); return JSON.stringify({ rowBg:cs.backgroundColor, effBg:_hex(bg) });
    })()`));
    out.push({ dark, tokenGroups: tokRes, elements: elRes, focus });
    const failT = tokRes.res.filter((r: any) => !r.unresolved && r.ratio < (r.kind === "text" ? 4.5 : 3));
    const failE = elRes.res.filter((r: any) => !r.missing && r.ratio !== null && r.ratio < (r.kind === "text" ? 4.5 : 3));
    console.log(`${dark ? "dark " : "light"} token组: ${tokRes.res.length}（不达标 ${failT.length}）· 元素级: ${elRes.res.length}（不达标 ${failE.length}）· 焦点环=${focus.ringRatio ?? "n/a"}`);
    for (const f of failT) console.log(`   TOKEN-FAIL ${f.id}  ratio=${f.ratio}  need<${f.kind === "text" ? 4.5 : 3}  ${f.fgRaw} on ${f.bgRaw}`);
    for (const f of failE) console.log(`   ELEM-FAIL  ${f.name}  ratio=${f.ratio}  fg=${f.fgRaw} bg=${f.bgHex}  ${f.bgChainNote ? "" : ""}`);
  }
  rep.contrast = out;
  fs.writeFileSync(path.join(OUT, "out-t65-contrast.json"), JSON.stringify(out, null, 2));
}

// ═══ ② 截图：320 菜单 + hover 态 ═══
if (PHASE === "shots" || PHASE === "all") {
  const shots: any[] = [];
  for (const dark of [false, true]) {
    const th = dark ? "dark" : "light";
    // 320 菜单
    await load(cdp, 320, 800, dark);
    await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return true; })()`);
    await sleep(450);
    shots.push({ file: `t65-menu320-${th}.png`, bytes: await shot(cdp, `t65-menu320-${th}.png`), scene: "menu320", theme: th });
    // hover：V1 行（1280，强制 hover）
    await load(cdp, 1280, 900, dark);
    await forceHover(cdp, ".dsh-rw-row", true); await sleep(300);
    shots.push({ file: `t65-hover-row-${th}.png`, bytes: await shot(cdp, `t65-hover-row-${th}.png`), scene: "hover-row", theme: th });
    await forceHover(cdp, ".dsh-rw-row", false);
    // hover：底栏按钮
    const okFoot = await forceHover(cdp, ".dsh-rw-status .dsh-rw-btn", true); await sleep(300);
    shots.push({ file: `t65-hover-footer-${th}.png`, bytes: await shot(cdp, `t65-hover-footer-${th}.png`), scene: "hover-footer", theme: th, hoverApplied: okFoot });
    await forceHover(cdp, ".dsh-rw-status .dsh-rw-btn", false);
    // hover：菜单项
    await cdp.ev(`(() => { const b=_panel().querySelector('[aria-haspopup="menu"]'); if(b) b.click(); return true; })()`);
    await sleep(400);
    const okMenu = await forceHover(cdp, ".dsh-rw-menu .dsh-rw-menuitem", true); await sleep(300);
    shots.push({ file: `t65-hover-menuitem-${th}.png`, bytes: await shot(cdp, `t65-hover-menuitem-${th}.png`), scene: "hover-menuitem", theme: th, hoverApplied: okMenu });
    await forceHover(cdp, ".dsh-rw-menu .dsh-rw-menuitem", false);
  }
  rep.shots = shots;
  fs.writeFileSync(path.join(OUT, "out-t65-shots.json"), JSON.stringify(shots, null, 2));
  console.log("shots: " + shots.map((s) => `${s.scene}/${s.theme}(${s.bytes}B)`).join(" "));
}

// ═══ ③ box-sizing 候选裁定 ═══
if (PHASE === "boxes" || PHASE === "all") {
  const out: any[] = [];
  for (const dark of [false, true]) {
    await load(cdp, 1280, 900, dark);
    const r = JSON.parse(await cdp.ev(`(() => {
      const p = _panel();
      const pick = (cls) => Array.from(p.querySelectorAll(cls)).map((el) => {
        const cs = getComputedStyle(el); const rc = el.getBoundingClientRect();
        return { cls, tag: el.tagName.toLowerCase(), declaredW: cs.width, declaredH: cs.height, boxSizing: cs.boxSizing,
          paddingX: parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight), paddingY: parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom),
          borderX: parseFloat(cs.borderLeftWidth)+parseFloat(cs.borderRightWidth), borderY: parseFloat(cs.borderTopWidth)+parseFloat(cs.borderBottomWidth),
          renderedW: Math.round(rc.width*10)/10, renderedH: Math.round(rc.height*10)/10,
          contentExpectedW: cs.boxSizing === 'border-box' ? parseFloat(cs.width) : parseFloat(cs.width)+parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight)+parseFloat(cs.borderLeftWidth)+parseFloat(cs.borderRightWidth),
          isFormControl: ['button','input','select','textarea'].includes(el.tagName.toLowerCase()),
          text:(_txt(el)||'').slice(0,14) };
      });
      return JSON.stringify({ buttons: pick('.dsh-rw-btn'), chips: pick('.dsh-rw-chip'), iconbtns: pick('.dsh-rw-iconbtn') });
    })()`));
    out.push({ dark, ...r });
  }
  rep.boxes = out;
  fs.writeFileSync(path.join(OUT, "out-t65-boxes.json"), JSON.stringify(out, null, 2));
  const b = out[0].buttons[0], c = out[0].chips[0];
  console.log(`boxes: .dsh-rw-btn tag=${b.tag} box-sizing=${b.boxSizing} 声明 ${b.declaredW}x${b.declaredH} → 渲染 ${b.renderedW}x${b.renderedH}（padding ${b.paddingX}/${b.paddingY} border ${b.borderX}/${b.borderY}）`);
  console.log(`       .dsh-rw-chip tag=${c.tag} box-sizing=${c.boxSizing} 声明 ${c.declaredW}x${c.declaredH} → 渲染 ${c.renderedW}x${c.renderedH}（padding ${c.paddingX}/${c.paddingY} border ${c.borderX}/${c.borderY}）`);
}

// ⚠️ 不要把本阶段的数组写到 `out-t65-<phase>.json` —— 末尾的 rep 汇总会把它覆盖掉
//    （T54 踩过同一个坑：断言脚本因此拿到包装对象 ⇒ 崩了却像"红"）
fs.writeFileSync(path.join(OUT, `out-t65-run-${PHASE}.json`), JSON.stringify(rep, null, 2));
cdp.close();
