/**
 * m1-visible-count.ts —— M1 检查器：统计**渲染可见文本**中某个 needle 的出现次数（默认 `dsh1`，期望恰 1）
 *
 * 为什么存在：M1「面板内可见 dsh1 恰 1 次」历轮都是临时手测，没有可复算门禁（T52 全仓搜索结论）。
 *
 * ── 可见性口径（本脚本的"可见"定义，逐条可判）──────────────────────────────
 *  1) 只取**文本节点**（TreeWalker SHOW_TEXT）。⇒ **属性值天然不计**：
 *     `aria-label` / `title` / `data-*` / `value` 不是文本节点，绝不会被计入。
 *  2) 排除**不可见祖先**：`script` / `style` / `noscript` / `template` / `[hidden]` /
 *     `[aria-hidden="true"]` / `[data-usab-hidden]`(测试用)。
 *  3) 排除**未展开的 `<details>` 内容**：若文本节点的某个 `<details>` 祖先 `open === false`
 *     且该节点不在这个 `<details>` 的 `<summary>` 子树内 ⇒ 视为未渲染/不可见。
 *  4) 排除**计算样式隐藏**：祖先链上任一元素 `display:none`、`visibility:hidden|collapse`。
 *  5) 排除**零尺寸**：文本节点所在元素 `getBoundingClientRect()` 的 w 或 h 为 0
 *     （含被折叠为 0 高度的容器）。`opacity:0` 也算不可见。
 *  6) 文本规范化：把空白折叠为单个空格后再匹配 needle（避免跨行拼接造成假阴/假阳）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node m1-visible-count.ts --url <tokenUrl> [--needle dsh1] [--expect 1]
 *        [--scope panel|entries] [--cdp 8965] [--json <out.json>] [--selftest]
 *   exit 0 = PASS（count == expect）｜1 = FAIL（count != expect）｜2 = 用法/环境错｜3 = 不可判定
 *   `--selftest`：真实读数之外再做两个**控制**（属性注入 ⇒ 仍应 PASS；注入第二处可见 ⇒ 应被检出为 2）
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   headless Chrome + CDP；脚本自身只读页面，不改仓库文件；`--json` 只写指定路径。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d = '') => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k: string) => argv.includes(k);
const URL_ = arg('--url');
const NEEDLE = arg('--needle', 'dsh1');
const EXPECT = Number(arg('--expect', '1'));
const SCOPE = arg('--scope', 'panel');
const CDP_PORT = arg('--cdp', '8965');
const JSON_OUT = arg('--json', '');
const SELFTEST = has('--selftest');
const PANEL_SEL = arg('--panel', '[data-dsh-remote-wsl="panel"]');
const ENTRIES_SEL = arg('--entries', '.dsh-rw-entries');
if (!URL_) { console.error('用法：node m1-visible-count.ts --url <tokenUrl> [--needle dsh1] [--expect 1] [--scope panel|entries] [--json out.json] [--selftest]'); process.exit(2); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class C {
  ws: any; id = 0; pending = new Map<number, any>(); wsUrl: string;
  constructor(u: string) { this.wsUrl = u; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((res, rej) => { this.ws.addEventListener('open', () => res(), { once: true }); this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true }); });
    this.ws.addEventListener('message', (ev: any) => { let m: any; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  }
  send(method: string, params: any = {}): Promise<any> { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, 30000); }); }
  async ev(e: string) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('页面内求值异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 240)); return r.result ? r.result.value : null; }
  close() { try { this.ws.close(); } catch {} }
}

/** 页面内计数函数（作为字符串注入；口径见文件头注释） */
const COUNT_FN = `
function usabCountVisibleText(rootSel, needle) {
  const root = document.querySelector(rootSel);
  if (!root) return { error: 'root-not-found:' + rootSel };
  const VISIBLY_HIDDEN_TAGS = ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'];
  const norm = (s) => String(s).replace(/\\s+/g, ' ').trim();
  const isHiddenByAncestors = (node) => {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.documentElement) {
      if (VISIBLY_HIDDEN_TAGS.includes(el.tagName)) return 'hidden-tag:' + el.tagName;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return 'attr-hidden';
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return 'display-none';
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility-hidden';
      if (parseFloat(cs.opacity) === 0) return 'opacity-0';
      // 未展开的 <details>：不在其 summary 子树内 ⇒ 内容未渲染
      if (el.tagName === 'DETAILS') {
        const d = el;
        const inSummary = !!(el.querySelector(':scope > summary') && el.querySelector(':scope > summary').contains(node));
        if (!d.open && !inSummary) return 'details-closed';
      }
      el = el.parentElement;
    }
    const box = (node.nodeType === 1 ? node : node.parentElement).getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return 'zero-size';
    return null;
  };
  const pathOf = (node) => {
    const parts = []; let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== root.parentElement) {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      else if (el.className && typeof el.className === 'string') { const c = el.className.trim().split(/\\s+/).slice(0,2).join('.'); if (c) s += '.' + c; }
      parts.unshift(s); el = el.parentElement;
    }
    return parts.join(' > ');
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = []; const excluded = []; let count = 0;
  let n;
  while ((n = walker.nextNode())) {
    const raw = n.nodeValue || '';
    if (!raw.includes(needle)) continue;
    const why = isHiddenByAncestors(n);
    const text = norm(raw);
    const occurrences = text.split(needle).length - 1;
    if (why) { excluded.push({ why, path: pathOf(n), snippet: text.slice(0, 60) }); continue; }
    count += occurrences;
    hits.push({ path: pathOf(n), snippet: text.length > 90 ? text.slice(0, 90) + '…' : text, occurrences });
  }
  return { root: rootSel, needle, count, hits, excluded };
}
`;

const cdpUrl = `http://127.0.0.1:${CDP_PORT}/json/list`;
let targets: any[];
try { targets = await (await fetch(cdpUrl)).json() as any[]; } catch (e: any) { console.error('[M1] 不可判定：CDP ' + cdpUrl + ' 不可达（' + e.message + '）'); process.exit(3); }
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('[M1] 不可判定：没有 page target'); process.exit(3); }
const cdp = new C(page.webSocketDebuggerUrl);
try { await cdp.connect(); } catch (e: any) { console.error('[M1] 不可判定：' + e.message); process.exit(3); }
await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp.send('Page.navigate', { url: URL_ });
await sleep(2600);
// 幂等开面板（面板开关状态会被持久化，点一次可能反而关掉）
for (let i = 0; i < 3; i++) {
  const okPanel = await cdp.ev(`(() => !!document.querySelector(${JSON.stringify(PANEL_SEL)}))()`);
  if (okPanel) break;
  await cdp.ev(`(() => { const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || ''))); if (b) b.click(); return !!b; })()`);
  await sleep(2000);
}
await sleep(900);

// 可选：点「上一级」N 次，把浏览位置移到父目录（M1 的"条目列表"场景：父目录里应有且仅有 1 个名为 needle 的条目）
const UP = Number(arg('--up', '0'));
for (let i = 0; i < UP; i++) {
  const clicked = await cdp.ev(`(() => { const p=document.querySelector(${JSON.stringify(PANEL_SEL)}); const b=Array.from(p.querySelectorAll('button')).find((x)=>/上一级/.test(x.innerText||'')||/上一级/.test(x.getAttribute('aria-label')||'')); if(!b) return false; b.click(); return true; })()`);
  if (!clicked) break;
  await sleep(1500);
}
if (UP > 0) await sleep(600);

await cdp.ev(COUNT_FN + '; window.__usabCount = usabCountVisibleText; true;');
const readScope = async (scopeSel: string) => JSON.parse(await cdp.ev(`(() => JSON.stringify(window.__usabCount(${JSON.stringify(scopeSel)}, ${JSON.stringify(NEEDLE)})))()`));

const rep: any = { ts: new Date().toISOString(), url: URL_.replace(/token=[^&]+/, 'token=***'), needle: NEEDLE, expect: EXPECT, scope: SCOPE, readings: {}, controls: null };

const panelReading = await readScope(PANEL_SEL);
const entriesReading = await readScope(ENTRIES_SEL);
rep.readings.panel = panelReading;
rep.readings.entries = entriesReading;
const primary = SCOPE === 'entries' ? entriesReading : panelReading;
if ((primary as any).error) { console.error('[M1] 不可判定：' + (primary as any).error); if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rep, null, 2)); cdp.close(); process.exit(3); }
const count = (primary as any).count;
const pass = count === EXPECT;
rep.verdict = pass ? `PASS(可见 ${NEEDLE} 恰 ${EXPECT} 次，scope=${SCOPE})` : `FAIL(可见 ${NEEDLE} ${count} 次 ≠ 期望 ${EXPECT}，scope=${SCOPE})`;

if (SELFTEST) {
  const controls: any = {};
  const scopeSel = SCOPE === 'entries' ? ENTRIES_SEL : PANEL_SEL;
  // ⚠️ 控制的基线必须是**实测到的 primary count**，不能是 --expect（否则控制自己会假红/假绿）
  // 控制 1（正例）：往**读数 scope 根**上塞 needle 属性 ⇒ 文本节点口径下**不应**计入
  await cdp.ev(`(() => { const r=document.querySelector(${JSON.stringify(scopeSel)}); r.setAttribute('data-usab-attr', '${NEEDLE} ${NEEDLE}'); r.setAttribute('title','${NEEDLE}'); const inp=document.querySelector(${JSON.stringify(PANEL_SEL)}).querySelector('input'); if(inp){ inp.setAttribute('data-path','/home/g/project/${NEEDLE}'); } return true; })()`);
  const afterAttr = await readScope(scopeSel);
  controls.attributeInjection = { count: afterAttr.count, baseline: count, ok: afterAttr.count === count, note: '属性值（aria-label/title/data-*）不是文本节点 ⇒ 不计入' };
  // 控制 2（负例）：往**读数 scope 根**里注入第二处**可见**文本 ⇒ 必须被检出（baseline+1）
  await cdp.ev(`(() => { const r=document.querySelector(${JSON.stringify(scopeSel)}); const d=document.createElement('div'); d.setAttribute('data-usab-red','1'); d.textContent='${NEEDLE}'; d.style.cssText='display:block;height:20px;width:80px'; r.appendChild(d); return true; })()`);
  const afterVisible = await readScope(scopeSel);
  controls.visibleInjection = { count: afterVisible.count, baseline: count, ok: afterVisible.count === count + 1, note: '注入第二处可见文本（注入到读数 scope 根内）⇒ 计数必须 +1' };
  // 清理注入
  await cdp.ev(`(() => { const p=document.querySelector(${JSON.stringify(PANEL_SEL)}); p.removeAttribute('data-usab-attr'); const d=p.querySelector('[data-usab-red]'); if(d) d.remove(); const inp=p.querySelector('input'); if(inp){ inp.removeAttribute('title'); inp.removeAttribute('data-path'); } return true; })()`);
  const restored = await readScope(SCOPE === 'entries' ? ENTRIES_SEL : PANEL_SEL);
  controls.afterCleanup = { count: restored.count, ok: restored.count === count };
  rep.controls = controls;
  rep.selftestVerdict = (controls.attributeInjection.ok && controls.visibleInjection.ok && controls.afterCleanup.ok) ? 'PASS(三项控制全部符合预期)' : 'FAIL(控制不符预期)';
}

if (JSON_OUT) { fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true }); fs.writeFileSync(JSON_OUT, JSON.stringify(rep, null, 2)); }
console.log(JSON.stringify(rep, null, 2));
cdp.close();
process.exit(pass ? 0 : 1);
