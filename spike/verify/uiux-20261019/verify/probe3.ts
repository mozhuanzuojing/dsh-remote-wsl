/** probe3.ts —— ⋯ 菜单的真实指针/键盘行为（焦点入菜单、Esc 关闭并归还焦点、Tab 关闭）。 */
import { openHarness } from "file:///D:/project/dsh1/_work/harness/drive.ts";
import { writeFile } from "node:fs/promises";
const LABEL = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "p3";
const OUT = "D:/project/dsh1/dsh-remote-wsl/spike/verify/uiux-20261019/verify/out";
const ev = (c: any, e: string) => c.evaluate(e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsReady = "(async () => { const t0 = performance.now(); while (document.querySelectorAll('.dsh-rw-row').length === 0 && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 15)); return true; })()";
const out: any = {};

async function trustClick(ctx: any, selector: string) {
  const box = await ev(ctx, "(() => { const b = document.querySelector('" + selector + "'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  if (!box) return false;
  await ctx.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await ctx.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  return true;
}
async function press(ctx: any, key: string, vk: number) {
  await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await ctx.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(150);
}

{
  const ctx = await openHarness({ entries: 30, width: 900 });
  try {
    await ev(ctx, rowsReady);
    await trustClick(ctx, "[aria-haspopup=menu]");
    await sleep(250);
    const opened = await ev(ctx, "(() => { const a = document.activeElement; return { menu: !!document.querySelector('.dsh-rw-menu'), expanded: document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded'), focusTag: a.tagName, focusRole: a.getAttribute('role'), focusText: (a.textContent||'').trim().slice(0,12), focusCls: String(a.className||'') }; })()");
    await press(ctx, "ArrowDown", 40);
    const afterDown = await ev(ctx, "(() => ({ focusRole: document.activeElement.getAttribute('role'), text: (document.activeElement.textContent||'').trim().slice(0,12) }))()");
    await press(ctx, "Escape", 27);
    const afterEsc = await ev(ctx, "(() => { const a = document.activeElement; return { menu: !!document.querySelector('.dsh-rw-menu'), expanded: document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded'), focusIsMore: a === document.querySelector('[aria-haspopup=menu]'), focusCls: String(a.className||'') }; })()");
    // 再开一次，测试 Tab 是否关闭菜单
    await trustClick(ctx, "[aria-haspopup=menu]");
    await sleep(200);
    await press(ctx, "Tab", 9);
    const afterTab = await ev(ctx, "(() => ({ menu: !!document.querySelector('.dsh-rw-menu'), expanded: document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded'), focusCls: String((document.activeElement||{}).className||'') }))()");
    out.menuKeyboard = { opened, afterDown, afterEsc, afterTab };
  } finally { await ctx.close(); }
}
await writeFile(OUT + "/probe3-" + LABEL + ".json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
