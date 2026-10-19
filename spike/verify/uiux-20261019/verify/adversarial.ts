/**
 * adversarial.ts —— task-2（T-B）独立对抗性复核：不信任"已跑过的门禁"，逐项自己复算。
 * 用法：DSH_RW_REPO=<repo> node --experimental-strip-types adversarial.ts --label verify
 * 写作用域：本目录（spike/verify/uiux-20261019/verify/）；不改 client/**、src/**。
 */
import { openHarness } from "file:///D:/project/dsh1/_work/harness/drive.ts";
import { writeFile, mkdir } from "node:fs/promises";

const LABEL = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "verify";
const OUTDIR = "D:/project/dsh1/dsh-remote-wsl/spike/verify/uiux-20261019/verify/out";
const out: any = { label: LABEL, repo: process.env.DSH_RW_REPO || "?", at: new Date().toISOString() };
const ev = (ctx: any, expr: string) => ctx.evaluate(expr);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsReady = "(async () => { const t0 = performance.now(); while (document.querySelectorAll('.dsh-rw-row').length === 0 && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 15)); return true; })()";
const calls = (ctx: any) => ev(ctx, "window.__harness.calls.slice()");
const countOf = (list: any[], method: string) => list.filter((c) => c.method === method).length;

const HIT_PROBE = "(() => { const panel = document.querySelector('[data-dsh-remote-wsl=panel]') || document; const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }; const all = Array.from(panel.querySelectorAll('button,[role=button],a[href],input,summary,[tabindex]:not([tabindex=\"-1\"])')).filter(vis); return { interactive: all.length, small: all.map(el => ({ tag: el.tagName, cls: String(el.className).split(' ')[0], label: (el.getAttribute('aria-label') || '').slice(0, 24), ...rect(el) })).filter(r => r.w < 24 || r.h < 24) }; })()";

const LAYOUT = "(() => { const q = (s) => document.querySelector(s); const rect = (el) => el ? { w: Math.round(el.getBoundingClientRect().width * 10) / 10, h: Math.round(el.getBoundingClientRect().height * 10) / 10 } : null; const footer = q('.dsh-rw-status'); const kids = footer ? Array.from(footer.children).filter(e => e.getBoundingClientRect().width > 0).map(e => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)) : []; const word = q('.dsh-rw-statusword'); const more = Array.from(document.querySelectorAll('.dsh-rw-iconbtn,[aria-haspopup=menu]')).filter(e => e.getBoundingClientRect().width > 0); const row = q('.dsh-rw-row'); return { footerH: footer ? rect(footer).h : null, footerChildCenters: Array.from(new Set(kids)), footerSingleLine: new Set(kids).size <= 1, statusWord: word ? { text: word.textContent.trim().slice(0, 20), truncated: word.scrollWidth > word.clientWidth + 1, rect: rect(word) } : null, moreButtons: more.map(e => ({ tag: e.tagName, cls: String(e.className).split(' ')[0], label: e.getAttribute('aria-label'), expanded: e.getAttribute('aria-expanded'), ...rect(e) })), moreCount: more.length, rowH: row ? rect(row).h : null, panelOverflow: (() => { const p = q('[data-dsh-remote-wsl=panel]'); return p ? p.scrollWidth - p.clientWidth : null; })(), docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, entriesTabIndex: (q('.dsh-rw-entries') || {}).tabIndex }; })()";

async function layout(entries: number, width: number) {
  const ctx = await openHarness({ entries, width });
  try {
    await ev(ctx, rowsReady);
    const main = await ev(ctx, LAYOUT);
    const hit = await ev(ctx, HIT_PROBE);
    const lines = await ev(ctx, "(() => { const lines = (el, lh) => el ? Math.round(el.getBoundingClientRect().height / lh) : null; const q = (s) => document.querySelector(s); return { titleLines: lines(q('.dsh-rw-title'), 20), subtitleLines: lines(q('.dsh-rw-subtitle'), 16), searchRect: q('.dsh-rw-search-input') ? { w: Math.round(q('.dsh-rw-search-input').getBoundingClientRect().width), h: Math.round(q('.dsh-rw-search-input').getBoundingClientRect().height) } : null, btnLines: Array.from(document.querySelectorAll('.dsh-rw-btn')).filter(b => b.getBoundingClientRect().width > 0).map(b => ({ text: b.textContent.trim().slice(0, 10), h: Math.round(b.getBoundingClientRect().height) })) }; })()");
    const errors = await ev(ctx, "window.__harness.errors.slice()");
    await ctx.screenshot(LABEL + "-adv-" + width);
    return { width, entries, main, hit, lines, errors };
  } finally { await ctx.close(); }
}

/** 一次"进入目录"动作的 host 调用增量（含按钮/行点击/键盘 Enter 三条路径）。 */
async function interactions() {
  const ctx = await openHarness({ entries: 60, width: 900, extraQuery: "latencyMs=60" });
  try {
    await ev(ctx, rowsReady);
    const res: any = {};
    const snap = async () => countOf(await calls(ctx), "explorer.listDir");
    const crumb = () => ev(ctx, "(document.querySelector('.dsh-rw-crumb--current') || {}).textContent || null");
    // ① 行点击（目录行）
    let before = await snap(); let c0 = await crumb();
    await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row')).find(x => x.classList.contains('dsh-rw-row--dir')); r.click(); return true; })()");
    await sleep(400); await ev(ctx, rowsReady);
    res.rowClick = { listDirDelta: (await snap()) - before, moved: (await crumb()) !== c0 };
    // ② 回到上一级（键盘 Backspace）
    await ev(ctx, "(() => { const e = document.querySelector('.dsh-rw-entries'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); return true; })()");
    await sleep(400); await ev(ctx, rowsReady);
    // ③ 行内「进入」按钮
    before = await snap(); c0 = await crumb();
    await ev(ctx, "(() => { const b = Array.from(document.querySelectorAll('.dsh-rw-row--dir .dsh-rw-link'))[0]; if (!b) return false; b.click(); return true; })()");
    await sleep(400); await ev(ctx, rowsReady);
    res.enterButton = { listDirDelta: (await snap()) - before, moved: (await crumb()) !== c0 };
    // ④ 行内「复制」按钮（不得导航）
    await ev(ctx, "(() => { window.__copyCalls = 0; const patch = { writeText: async () => { window.__copyCalls++; } }; try { Object.defineProperty(navigator, 'clipboard', { value: patch, configurable: true }); } catch (e) {} return true; })()");
    before = await snap(); c0 = await crumb();
    await ev(ctx, "(() => { const b = Array.from(document.querySelectorAll('.dsh-rw-row .dsh-rw-link')).find(x => /复制|Copy|copy/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; })()");
    await sleep(250);
    res.copyButton = { listDirDelta: (await snap()) - before, moved: (await crumb()) !== c0, copyCalls: await ev(ctx, "window.__copyCalls || 0") };
    // ⑤ 文件行点击（不得导航）
    before = await snap(); c0 = await crumb();
    res.fileRowClick = await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row')).find(x => !x.classList.contains('dsh-rw-row--dir')); if (!r) return { noFileRow: true }; const b = document.querySelector('.dsh-rw-crumb--current'); r.click(); return { clicked: true, crumbBefore: b ? b.textContent : null }; })()");
    await sleep(250);
    res.fileRowClick.listDirDelta = (await snap()) - before;
    res.fileRowClick.moved = (await crumb()) !== c0;
    res.errors = await ev(ctx, "window.__harness.errors.slice()");
    return res;
  } finally { await ctx.close(); }
}

/** 可信键盘（CDP Input）：Enter 双触发 / 焦点移动 / 剪贴板写入次数。 */
async function keyboard() {
  const ctx = await openHarness({ entries: 40, width: 900, extraQuery: "latencyMs=40" });
  try {
    await ev(ctx, rowsReady);
    await ev(ctx, "(() => { window.__copyCalls = 0; try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { window.__copyCalls++; } }, configurable: true }); } catch (e) {} const e = document.querySelector('.dsh-rw-entries'); e.focus(); return true; })()");
    const press = async (key: string, vk: number) => {
      await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(120);
    };
    const active = () => ev(ctx, "(() => { const a = document.activeElement; const r = a.getBoundingClientRect(); return { idx: a.getAttribute('data-index'), cls: a.className, path: a.getAttribute('data-path'), top: Math.round(r.top) }; })()");
    const res: any = { steps: [] };
    // 单次 ArrowDown 是否只前进一格（若行/容器两个 handler 各跑一次，会跳两格 ⇒ 暴露）
    await press("ArrowDown", 40); res.steps.push({ after: await active() });
    await press("ArrowDown", 40); res.steps.push({ after: await active() });
    await press("End", 35); res.steps.push({ after: await active() });
    res.endIdx = (await active()).idx;
    // 文件行 Enter：剪贴板应只写一次（行 handler + 容器 handler 会各跑一次 ⇒ 可能 2 次）
    let before = countOf(await calls(ctx), "explorer.listDir");
    await press("Enter", 13);
    await sleep(200);
    res.fileEnter = { copyCalls: await ev(ctx, "window.__copyCalls || 0"), listDirDelta: countOf(await calls(ctx), "explorer.listDir") - before };
    // 目录行 Enter：listDir 应只 +1（单飞吸收重复导航）
    await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row--dir'))[0]; const idx = r.getAttribute('data-index'); const list = document.querySelector('.dsh-rw-entries'); list.focus(); const row = document.querySelector('[data-index=\"' + idx + '\"]'); if (row) { row.focus(); } return idx; })()");
    await sleep(80);
    before = countOf(await calls(ctx), "explorer.listDir");
    await press("Enter", 13);
    await sleep(500);
    res.dirEnter = { listDirDelta: countOf(await calls(ctx), "explorer.listDir") - before };
    res.errors = await ev(ctx, "window.__harness.errors.slice()");
    return res;
  } finally { await ctx.close(); }
}

/** 筛选：清空时机 / 无匹配 / 计数 / 键盘不再指向已消失的行。 */
async function filter() {
  const ctx = await openHarness({ entries: 120, width: 900, extraQuery: "latencyMs=60" });
  try {
    await ev(ctx, rowsReady);
    const res: any = {};
    await ctx.focus(".dsh-rw-search-input");
    await ctx.typeText("file-0001");
    res.typing = await ev(ctx, "(() => ({ rows: document.querySelectorAll('.dsh-rw-row').length, count: (document.querySelector('.dsh-rw-search-count') || {}).textContent, value: document.querySelector('.dsh-rw-search-input').value }))()");
    // 过滤器下进入目录：筛选应被清空（否则新目录可能被旧筛选显示成空）
    await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row')).find(x => x.classList.contains('dsh-rw-row--dir')); if (r) r.click(); return true; })()");
    await sleep(500); await ev(ctx, rowsReady);
    res.afterNavigate = await ev(ctx, "(() => ({ value: document.querySelector('.dsh-rw-search-input').value, rows: document.querySelectorAll('.dsh-rw-row').length, crumb: (document.querySelector('.dsh-rw-crumb--current') || {}).textContent }))()");
    // 无匹配态
    await ctx.focus(".dsh-rw-search-input");
    await ctx.typeText("zzz-nope");
    res.noMatch = await ev(ctx, "(() => ({ rows: document.querySelectorAll('.dsh-rw-row').length, empty: (document.querySelector('.dsh-rw-empty') || {}).innerText || null, clearBtn: !!document.querySelector('.dsh-rw-empty .dsh-rw-btn') }))()");
    // Esc 清空 + 焦点回筛选框
    await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(200);
    res.afterEsc = await ev(ctx, "(() => ({ value: document.querySelector('.dsh-rw-search-input').value, rows: document.querySelectorAll('.dsh-rw-row').length, focusCls: String((document.activeElement || {}).className || '') }))()");
    res.errors = await ev(ctx, "window.__harness.errors.slice()");
    return res;
  } finally { await ctx.close(); }
}

/** 缓存命中 / force 刷新 / TTL。 */
async function cache() {
  const ctx = await openHarness({ entries: 40, width: 900, extraQuery: "latencyMs=300" });
  try {
    await ev(ctx, rowsReady);
    const n = async () => countOf(await calls(ctx), "explorer.listDir");
    const clickDir = async () => { await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row')).find(x => x.classList.contains('dsh-rw-row--dir')); r.click(); return true; })()"); await sleep(700); await ev(ctx, rowsReady); };
    const up = async () => { await ev(ctx, "(() => { const e = document.querySelector('.dsh-rw-entries'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); return true; })()"); await sleep(700); await ev(ctx, rowsReady); };
    const res: any = {};
    let before = await n(); await clickDir(); res.firstEnter = (await n()) - before;
    await up();
    before = await n(); await clickDir(); res.secondEnter = (await n()) - before;   // 期望 0（缓存命中）
    // force：刷新按钮（header 的 iconbtn）应绕缓存重新 listDir
    before = await n();
    await ev(ctx, "(() => { const b = Array.from(document.querySelectorAll('.dsh-rw-iconbtn')).find(x => /刷新|重新|refresh|Refresh/.test((x.getAttribute('aria-label') || '') + (x.getAttribute('title') || ''))); if (!b) return false; b.click(); return true; })()");
    await sleep(900);
    res.forceRefreshListDelta = (await n()) - before;
    res.refreshClicked = await ev(ctx, "(() => { const b = Array.from(document.querySelectorAll('.dsh-rw-iconbtn')).find(x => /刷新|重新|refresh|Refresh/.test((x.getAttribute('aria-label') || '') + (x.getAttribute('title') || ''))); return b ? (b.getAttribute('aria-label') || b.getAttribute('title')) : null; })()");
    res.errors = await ev(ctx, "window.__harness.errors.slice()");
    return res;
  } finally { await ctx.close(); }
}

/** ★ 竞态：刷新（alsoList 走 load 的 setBrowse）与"进入缓存目录"交错 ⇒ 列表是否被旧目录覆盖。 */
async function raceRefreshVsNavigate() {
  const ctx = await openHarness({ entries: 40, width: 900, extraQuery: "latencyMs=400" });
  try {
    await ev(ctx, rowsReady);
    const crumb = () => ev(ctx, "(document.querySelector('.dsh-rw-crumb--current') || {}).textContent || null");
    const input = () => ev(ctx, "(document.querySelector('.dsh-rw-path-input') || {}).value || null");
    const firstRow = () => ev(ctx, "(document.querySelector('.dsh-rw-row .dsh-rw-rowname') || {}).textContent || null");
    // 先访问一次子目录，制造"缓存命中"条件
    const dirName = await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row--dir'))[0]; r.click(); return r.getAttribute('data-path'); })()");
    await sleep(1000); await ev(ctx, rowsReady);
    await ev(ctx, "(() => { const e = document.querySelector('.dsh-rw-entries'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); return true; })()");
    await sleep(1000); await ev(ctx, rowsReady);
    const crumbBefore = await crumb();
    // 刷新（携带 path=cwd，走 load 的 setBrowse）→ 立刻点进缓存目录
    await ev(ctx, "(() => { const b = Array.from(document.querySelectorAll('.dsh-rw-iconbtn')).find(x => /刷新|重新|refresh/.test((x.getAttribute('aria-label') || '') + (x.getAttribute('title') || ''))); b.click(); return true; })()");
    await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row--dir'))[0]; r.click(); return true; })()");
    await sleep(1500);
    const after = { crumb: await crumb(), pathInput: await input(), firstRow: await firstRow() };
    await sleep(1500);
    const settled = { crumb: await crumb(), pathInput: await input(), firstRow: await firstRow() };
    return { dirName, crumbBefore, after, settled, consistent: after.crumb === after.pathInput, settledConsistent: settled.crumb === settled.pathInput, errors: await ev(ctx, "window.__harness.errors.slice()") };
  } finally { await ctx.close(); }
}

/** 自动刷新：同一次"回到窗口"是否双发（visibilitychange + focus 各一次）。 */
async function autoRefresh() {
  const ctx = await openHarness({ entries: 30, width: 900 });
  try {
    await ev(ctx, rowsReady);
    const before = countOf(await calls(ctx), "explorer.snapshot");
    const fired = await ev(ctx, "(() => { const real = Date.now; Date.now = () => real() + 120000; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); Date.now = real; return true; })()");
    await sleep(700);
    const after = countOf(await calls(ctx), "explorer.snapshot");
    // 60s 节流：紧接着再发一次 focus，不应再刷
    await ev(ctx, "window.dispatchEvent(new Event('focus'))");
    await sleep(500);
    const after2 = countOf(await calls(ctx), "explorer.snapshot");
    return { snapshotDeltaOnReturn: after - before, snapshotDeltaSecondFocus: after2 - after, fired, errors: await ev(ctx, "window.__harness.errors.slice()") };
  } finally { await ctx.close(); }
}

/** 大目录 + 筛选 + 滚动记忆。 */
async function virtual() {
  const ctx = await openHarness({ entries: 5000, width: 900 });
  try {
    await ev(ctx, rowsReady);
    const res: any = {};
    res.initial = await ev(ctx, "(() => ({ rows: document.querySelectorAll('.dsh-rw-row').length, dom: document.querySelectorAll('*').length, scrollH: (document.querySelector('.dsh-rw-body') || {}).scrollHeight }))()");
    // 滚到底 → 末行可见
    await ev(ctx, "(() => { const b = document.querySelector('.dsh-rw-body'); b.scrollTop = b.scrollHeight; return true; })()");
    await sleep(400);
    res.bottom = await ev(ctx, "(() => ({ rows: document.querySelectorAll('.dsh-rw-row').length, last: (Array.from(document.querySelectorAll('.dsh-rw-row')).pop() || {}).getAttribute('data-path') }))()");
    // 滚到底后筛选：窗口/结果是否正常
    await ctx.focus(".dsh-rw-search-input");
    await ctx.typeText("file-0499");
    await sleep(300);
    res.filterAfterScroll = await ev(ctx, "(() => ({ rows: document.querySelectorAll('.dsh-rw-row').length, count: (document.querySelector('.dsh-rw-search-count') || {}).textContent, first: (document.querySelector('.dsh-rw-row') || {}).getAttribute('data-path'), bodyScrollTop: (document.querySelector('.dsh-rw-body') || {}).scrollTop }))()");
    // 清空筛选后回到全量
    await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(400);
    res.afterEsc = await ev(ctx, "(() => ({ rows: document.querySelectorAll('.dsh-rw-row').length, scrollTop: Math.round((document.querySelector('.dsh-rw-body') || {}).scrollTop || 0) }))()");
    // 滚动记忆：进入子目录再 Backspace 回来，scrollTop 是否恢复
    const top = await ev(ctx, "(() => { const b = document.querySelector('.dsh-rw-body'); b.scrollTop = 3000; return Math.round(b.scrollTop); })()");
    await sleep(300);
    await ev(ctx, "(() => { const e = document.querySelector('.dsh-rw-entries'); e.focus(); return true; })()");
    await ev(ctx, "(() => { const r = Array.from(document.querySelectorAll('.dsh-rw-row')).find(x => x.classList.contains('dsh-rw-row--dir')); if (r) r.click(); return true; })()");
    await sleep(600); await ev(ctx, rowsReady);
    await ev(ctx, "(() => { const e = document.querySelector('.dsh-rw-entries'); e.focus(); e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); return true; })()");
    await sleep(800);
    res.scrollMemory = { setTo: top, restored: await ev(ctx, "Math.round((document.querySelector('.dsh-rw-body') || {}).scrollTop || 0)") };
    res.errors = await ev(ctx, "window.__harness.errors.slice()");
    return res;
  } finally { await ctx.close(); }
}

/** chunk 加载失败（删掉 list.js 的请求）⇒ 是否给用户可见错误，而不是白屏。 */
async function chunkFailure() {
  const ctx = await openHarness({ entries: 30, width: 900 });
  try {
    const res: any = { enabled: true };
    await ctx.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*client.panel.list.js*" }] });
    ctx.cdp.on("Fetch.requestPaused", (p: any) => { ctx.cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }).catch(() => {}); });
    await ctx.cdp.send("Page.reload");
    await sleep(2500);
    res.domText = await ev(ctx, "(() => (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400))()");
    res.bootError = await ev(ctx, "window.__harness && window.__harness.bootError ? String(window.__harness.bootError).slice(0, 300) : null");
    res.hasErrorCard = await ev(ctx, "!!document.querySelector('.dsh-rw-error')");
    res.stage = await ev(ctx, "window.__harness ? window.__harness.stage : null");
    res.errors = await ev(ctx, "window.__harness ? window.__harness.errors.slice(-5) : null");
    return res;
  } catch (e) {
    return { enabled: false, error: String(e) };
  } finally { await ctx.close(); }
}

await mkdir(OUTDIR, { recursive: true });
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
async function run(name: string, fn: () => Promise<any>) {
  if (only && only !== name) return;
  try {
    out[name] = await fn();
  } catch (e) {
    out[name] = { THREW: String((e && (e as any).stack) || e).slice(0, 600) };
  }
  console.log("DONE", name, JSON.stringify(out[name]).slice(0, 700));
}
await run("layout1280", () => layout(400, 1280));
await run("layout320", () => layout(40, 320));
await run("interactions", interactions);
await run("keyboard", keyboard);
await run("filter", filter);
await run("cache", cache);
await run("race", raceRefreshVsNavigate);
await run("autoRefresh", autoRefresh);
await run("virtual", virtual);
await run("chunkFailure", chunkFailure);

await writeFile(OUTDIR + "/adversarial-" + LABEL + ".json", JSON.stringify(out, null, 2));
console.log("WROTE", OUTDIR + "/adversarial-" + LABEL + ".json");
