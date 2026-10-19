/** probe4.ts —— 高度预算：筛选行占了多少、列表可见行数 vs 冻结规格 §6.1 的 18 行。 */
import { openHarness } from "file:///D:/project/dsh1/_work/harness/drive.ts";
const ev = (c: any, e: string) => c.evaluate(e);
const rowsReady = "(async () => { const t0 = performance.now(); while (document.querySelectorAll('.dsh-rw-row').length === 0 && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 15)); return true; })()";
const GEO = "(() => { const r = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; }; const entries = document.querySelector('.dsh-rw-entries'); const eh = entries ? entries.getBoundingClientRect().height : 0; return { card: r('.dsh-rw-card'), head: r('.dsh-rw-cardhead'), toolbar: r('.dsh-rw-toolbar'), crumbs: r('.dsh-rw-crumbs'), form: r('.dsh-rw-form'), search: r('.dsh-rw-search'), entries: r('.dsh-rw-entries'), footer: r('.dsh-rw-status'), body: r('.dsh-rw-body'), rows: document.querySelectorAll('.dsh-rw-row').length, rowsVisible: Math.floor(eh / 34) }; })()";
for (const w of [1280, 900, 320]) {
  const ctx = await openHarness({ entries: 100, width: w });
  try {
    await ev(ctx, rowsReady);
    console.log(w, JSON.stringify(await ev(ctx, GEO)));
  } finally { await ctx.close(); }
}