/**
 * build-menu-harness.mjs —— 用插件**真实的 CSS 文本** + 最小 DOM 拼出两个自检 HTML。
 *
 * 产出两份（同一份 CSS，只有 DOM 不同）：
 *   A) `harness-menu-<tag>.html`  —— 只测 `.dsh-rw-menu` 的**外框宽**（声明 240 是内容盒还是边框盒）
 *   B) `harness-layout-<tag>.html` —— 复刻真实嵌套（菜单是 `.dsh-rw-status`（position:relative）的**子节点**）
 *      测量：① 菜单宽 ② 菜单与底栏**状态词**的矩形交集面积 ③ 菜单底边到 footer 顶边的间隙
 *
 * ⚠️ 两份测的都是**机制**（同一份 CSS 文本 + 最小 DOM，真实 Chromium），**不是** DSH 实例内的面板 DOM。
 *    报告须据此标注"机制实测 / 实例内未测"。
 *
 * 用法： node build-menu-harness.mjs <panel.css> <tag> <输出目录>
 */
import fs from "node:fs";
import path from "node:path";

const [, , cssFile, tag, outDir] = process.argv;
if (!cssFile || !tag || !outDir) {
  console.error("usage: node build-menu-harness.mjs <panel.css> <tag:before|after|red> <outDir>");
  process.exit(2);
}
const css = fs.readFileSync(cssFile, "utf8");

// 该规则用到的 token 给具体值（未定义 var 只影响颜色，不影响布局；这里仍给上以便观察）
const tokens = `:root{
  --dsw-alias-bg-overlay:#e9ecf2; --dsw-alias-border-l2:#999; --dsw-alias-border-l1:#ccc;
  --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-base:#fff; --dsw-alias-label-primary:#0f1115;
  --dsw-alias-label-secondary:#61666b; --dsw-alias-label-dimmed:#e1e5ee;
  --dsw-alias-brand-primary:#0f1115; --dsw-specific-sidebar-fill:#f9fafb;
  --dsw-alias-interactive-bg-hover:rgba(38,49,72,.06); --dsw-alias-interactive-bg-active:rgba(38,49,72,.10);
  --dsw-alias-state-success-primary:#22c55e; --dsw-alias-state-idle-primary:#d4d4d4;
  --dsw-alias-state-error-primary:#ec1313; --dsw-alias-state-warn-primary:#f59e0b;
  --dsw-focus-ring-color:#4176e6;
}`;

const head = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>T52 harness (${tag})</title>
<style>
${tokens}
*{margin:0}
html,body{height:100%}
body{font:13px/1.5 -apple-system,"Segoe UI",sans-serif;background:#fff;color:#0f1115}
#panel{display:flex;flex-direction:column;height:100vh;min-height:0}
#body{flex:1;min-height:0;overflow:auto;padding:8px}
</style>
<style id="plugin-css">
${css}
</style>
</head><body>`;

const menuInner = `
      <div class="dsh-rw-group" role="group" aria-labelledby="g-daemon">
        <div class="dsh-rw-grouplabel" id="g-daemon">守护</div>
        <div class="dsh-rw-menuitem" role="menuitem" tabindex="0">重启远端守护…</div>
        <div class="dsh-rw-menuitem" role="menuitem" tabindex="0">停止远端守护…</div>
      </div>
      <div class="dsh-rw-menusep"></div>
      <div class="dsh-rw-menuitem" role="menuitem" tabindex="0">查看诊断信息</div>`;

const footer = (withMenu) => `
  <footer class="dsh-rw-status" role="status" id="footer">
    <span class="dsh-rw-dot dsh-rw-dot--stopped" aria-hidden="true"></span>
    <span class="dsh-rw-statusword" id="statusword">远端守护未运行</span>
    <span class="dsh-rw-extra">会话 0 个</span>
    <span class="dsh-rw-spacer"></span>
    <button type="button" class="dsh-rw-iconbtn" id="trigger" aria-label="更多操作" aria-haspopup="menu" aria-expanded="${withMenu}">⋯</button>
    ${withMenu ? `<div class="dsh-rw-menu" id="target" role="menu" aria-label="更多操作">${menuInner}</div>` : ""}
  </footer>`;

// A) 宽度专用（菜单挂在 stage 里，避免祖先影响）
const htmlA = head + `
<div id="panel">
  <div id="body">
    <div style="position:relative;height:400px">
      <div class="dsh-rw-menu" id="target" role="menu" aria-label="更多操作">${menuInner}</div>
    </div>
  </div>
  ${footer(false)}
</div>
<script>
window.__measure = () => {
  const el = document.getElementById('target'), r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  return { kind:'width', width:r.width, height:r.height, boxSizing:cs.boxSizing, declaredWidth:cs.width,
           paddingX:(parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight)),
           borderX:(parseFloat(cs.borderLeftWidth)+parseFloat(cs.borderRightWidth)) };
};
</script>
</body></html>`;

// B) 布局专用（复刻真实嵌套：菜单是 footer 的子节点；footer 是 position:relative）
const htmlB = head + `
<div id="panel">
  <div id="body"><div style="height:200px">列表占位</div></div>
  ${footer(true)}
</div>
<script>
window.__measure = () => {
  const menu = document.getElementById('target').getBoundingClientRect();
  const word = document.getElementById('statusword').getBoundingClientRect();
  const foot = document.getElementById('footer').getBoundingClientRect();
  const trig = document.getElementById('trigger').getBoundingClientRect();
  const ix = Math.max(0, Math.min(menu.right, word.right) - Math.max(menu.left, word.left));
  const iy = Math.max(0, Math.min(menu.bottom, word.bottom) - Math.max(menu.top, word.top));
  return {
    kind:'layout',
    menuWidth: menu.width, menuHeight: menu.height,
    menuBottom: menu.bottom, footerTop: foot.top,
    gapMenuBottomToFooterTop: foot.top - menu.bottom,
    statusWordRect: { left: word.left, top: word.top, right: word.right, bottom: word.bottom },
    overlapWithStatusWordArea: ix * iy,
    menuCoversTrigger: !(menu.bottom <= trig.top || menu.top >= trig.bottom || menu.right <= trig.left || menu.left >= trig.right),
    viewport: { w: innerWidth, h: innerHeight }
  };
};
</script>
</body></html>`;

const a = path.join(outDir, `harness-menu-${tag}.html`);
const b = path.join(outDir, `harness-layout-${tag}.html`);
fs.writeFileSync(a, htmlA, "utf8");
fs.writeFileSync(b, htmlB, "utf8");
console.log("A = " + a + "  bytes=" + Buffer.byteLength(htmlA));
console.log("B = " + b + "  bytes=" + Buffer.byteLength(htmlB));
