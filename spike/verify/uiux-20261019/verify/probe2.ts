/** probe2.ts —— 补测：筛选清空时机（correct fixture）/ ⋯ 菜单 / 菜单不遮状态词 / ARIA。 */
import { openHarness } from "file:///D:/project/dsh1/_work/harness/drive.ts";
import { writeFile } from "node:fs/promises";
const LABEL = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "p2";
const OUT = "D:/project/dsh1/dsh-remote-wsl/spike/verify/uiux-20261019/verify/out";
const ev = (c: any, e: string) => c.evaluate(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsReady = "(async () => { const t0 = performance.now(); while (document.querySelectorAll('.dsh-rw-row').length === 0 && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 15)); return true; })()";
const out: any = {};

// ① 筛选命中"目录行"→ 点击进入 → 筛选是否清空
{
  const ctx = await openHarness({ entries: 120, width: 900, extraQuery: "latencyMs=60" });
  try {
    await ev(ctx, rowsReady);
    const before = await ev(ctx, "(() => ({ crumb: (document.querySelector('.dsh-rw-crumb--current')||{}).textContent, dirs: Array.from(document.querySelectorAll('.dsh-rw-row--dir')).map(r => r.getAttribute('data-path')).slice(0,3) }))()");
    await ctx.focus(".dsh-rw-search-input");
    await ctx.typeText("dir-0000");
    const filtered = await ev(ctx, "(() => ({ rows: document.querySelectorAll('.dsh-rw-row').length, dirs: Array.from(document.querySelectorAll('.dsh-rw-row--dir')).map(r=>r.getAttribute('data-path')), count: (document.querySelector('.dsh-rw-search-count')||{}).textContent }))()");
    await ev(ctx, "(() => { const r = document.querySelector('.dsh-rw-row--dir'); if (!r) return false; r.click(); return true; })()");
    await sleep(700); await ev(ctx, rowsReady);
    const after = await ev(ctx, "(() => ({ value: document.querySelector('.dsh-rw-search-input').value, crumb: (document.querySelector('.dsh-rw-crumb--current')||{}).textContent, rows: document.querySelectorAll('.dsh-rw-row').length, count: (document.querySelector('.dsh-rw-search-count')||{}).textContent }))()");
    out.filterClearOnNavigate = { before, filtered, after };
  } finally { await ctx.close(); }
}

// ② ⋯ 菜单：唯一性 / aria-expanded / 不遮状态词 / 菜单项命中盒 / Esc 焦点归还
{
  const ctx = await openHarness({ entries: 30, width: 900 });
  try {
    await ev(ctx, rowsReady);
    const pre = await ev(ctx, "(() => { const m = Array.from(document.querySelectorAll('[aria-haspopup=menu]')); return { count: m.length, labels: m.map(b => b.getAttribute('aria-label')), expanded: m.map(b => b.getAttribute('aria-expanded')) }; })()");
    await ev(ctx, "(() => { const b = document.querySelector('[aria-haspopup=menu]'); b.click(); return true; })()");
    await sleep(200);
    const open = await ev(ctx, "(() => { const menu = document.querySelector('.dsh-rw-menu'); const sw = document.querySelector('.dsh-rw-statusword'); const mr = menu ? menu.getBoundingClientRect() : null; const sr = sw ? sw.getBoundingClientRect() : null; const inter = (r1, r2) => r1 && r2 && r1.left < r2.right && r2.left < r1.right && r1.top < r2.bottom && r2.top < r1.bottom; const items = Array.from(document.querySelectorAll('.dsh-rw-menuitem')).map(i => { const r = i.getBoundingClientRect(); return { role: i.getAttribute('role'), h: Math.round(r.height), w: Math.round(r.width), label: (i.textContent||'').trim().slice(0,10) }; }); const groups = Array.from(document.querySelectorAll('[role=group]')).map(g => ({ labelledby: g.getAttribute('aria-labelledby'), label: g.getAttribute('aria-label') })); return { menuW: mr ? Math.round(mr.width) : null, overlapsStatusWord: inter(mr, sr), expanded: document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded'), items, groups, menuitemMinH: items.length ? Math.min(...items.map(i=>i.h)) : null }; })()");
    await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(200);
    const closed = await ev(ctx, "(() => ({ menu: !!document.querySelector('.dsh-rw-menu'), expanded: document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded'), focusIsMore: document.activeElement === document.querySelector('[aria-haspopup=menu]'), focusCls: String((document.activeElement||{}).className||'') }))()");
    out.menu = { pre, open, closed };
  } finally { await ctx.close(); }
}

// ③ 行内动作的 hover 占位（N4：不用 display:none，hover 前后几何不变）
{
  const ctx = await openHarness({ entries: 30, width: 900 });
  try {
    await ev(ctx, rowsReady);
    const before = await ev(ctx, "(() => { const r = document.querySelector('.dsh-rw-row'); const acts = r.querySelector('.dsh-rw-rowacts'); return { rowRect: Math.round(r.getBoundingClientRect().width), actW: Math.round(acts.getBoundingClientRect().width), disp: getComputedStyle(acts).display }; })()");
    await ev(ctx, "(() => { const r = document.querySelector('.dsh-rw-row'); r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); r.classList.add('hover-sim'); return true; })()");
    await sleep(150);
    const after = await ev(ctx, "(() => { const r = document.querySelector('.dsh-rw-row'); const acts = r.querySelector('.dsh-rw-rowacts'); const cs = getComputedStyle(acts); return { actW: Math.round(acts.getBoundingClientRect().width), disp: cs.display, vis: cs.visibility, opacity: cs.opacity }; })()");
    out.rowActionPlaceholder = { before, after };
  } finally { await ctx.close(); }
}

await writeFile(OUT + "/probe2-" + LABEL + ".json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 6000));
