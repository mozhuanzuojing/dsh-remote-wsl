/** t65-debug.ts —— 查 token 到底定义在哪个元素上（我的 _tok 取空了） */
import fs from "node:fs";
const argv = process.argv.slice(2);
const arg = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = arg("--url"); const CDP_PORT = arg("--cdp", "8968");
class C {
  ws: any; id = 0; pending = new Map<number, any>(); wsUrl: string;
  constructor(u: string) { this.wsUrl = u; }
  async connect() { this.ws = new WebSocket(this.wsUrl); await new Promise<void>((res, rej) => { this.ws.addEventListener("open", () => res(), { once: true }); this.ws.addEventListener("error", () => rej(new Error("ws")), { once: true }); }); this.ws.addEventListener("message", (ev: any) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  send(method: string, params: any = {}): Promise<any> { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 40000); }); }
  async ev(e: string) { const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as any[];
const page = targets.find((t: any) => t.type === "page");
const cdp = new C(page.webSocketDebuggerUrl); await cdp.connect();
await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await cdp.send("Page.navigate", { url: URL_ }); await new Promise((r) => setTimeout(r, 2600));
for (let i = 0; i < 4; i++) { const r = await cdp.ev(`(() => { const t=(x)=>(((x.innerText||'')+'')).trim(); const c=Array.from(document.querySelectorAll('button')).filter((x)=>/^(稍后配置|继续)$/.test(t(x))); if(!c.length) return 'none'; c[0].click(); return 'ok'; })()`); if (r === "none") break; await new Promise((r2) => setTimeout(r2, 700)); }
await cdp.ev(`(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label')||'') + (x.innerText||''))); if (b) b.click(); return true; })()`);
await new Promise((r) => setTimeout(r, 2000));
const out = await cdp.ev(`(() => {
  const names = ['--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-label-primary','--dsw-specific-sidebar-fill','--dsw-alias-border-l2'];
  const get = (el) => { const cs = getComputedStyle(el); const o = {}; for (const n of names) o[n] = cs.getPropertyValue(n); return o; };
  const p = document.querySelector('[data-dsh-remote-wsl="panel"]');
  // 沿父链找第一个带 token 的元素
  let n = p, found = null, hops = 0;
  while (n && hops < 12) { const v = getComputedStyle(n).getPropertyValue('--dsw-alias-bg-base'); if (v && v.trim()) { found = { tag: n.tagName, cls: String(n.className).slice(0,40), hops, val: v }; break; } n = n.parentElement; hops++; }
  return JSON.stringify({ panelFound: !!p, html: get(document.documentElement), body: get(document.body), panel: p ? get(p) : null, firstWithToken: found, panelColor: p ? getComputedStyle(p).color : null, dark: document.body.getAttribute('data-ds-dark-theme') !== null, bodyClass: document.body.className });
})()`);
console.log(JSON.stringify(JSON.parse(out), null, 2));
cdp.close();
