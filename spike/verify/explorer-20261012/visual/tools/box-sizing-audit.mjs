/**
 * box-sizing 陷阱审计（T43 对账脚本，可复跑）。
 *
 * 为什么需要它：宿主 DSH 的 CSS **没有全局 `box-sizing` 重置**（逐组件声明，见下），
 * 而插件里 `height:<N>px` + `padding` + `border` 的规则若**不显式**声明
 * `box-sizing:border-box`，浏览器按默认 `content-box` 解释 ⇒ 实际渲染高度
 * = N + 上下 padding + 上下 border，比规格写的 N 大。
 * 底栏 55 vs 规格 36 就是这个陷阱（36 + 9×2 + 1 = 55）。
 *
 * 用法：
 *   node box-sizing-audit.mjs <bundle.js|file.css> [classPrefix] [--host=<asar>]
 * 输出：
 *   ① 每个"声明了高度/宽度 + 有 padding 或 border + 没有 box-sizing:border-box"的规则
 *      → 列出「声明值 → 实际渲染值」；
 *   ② 有 --host 时，统计宿主 CSS 里的 box-sizing 重置形态（通配 / 表单控件 / 逐组件），
 *      用来证明"插件不能指望宿主兜底"。
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const hostArg = argv.find((a) => a.startsWith("--host="));
const tagsArg = argv.find((a) => a.startsWith("--tags="));
const pos = argv.filter((a) => !a.startsWith("--"));
const file = pos[0];
const prefix = pos[1] || "dsh-rw-";
if (!file) {
  console.error("usage: node box-sizing-audit.mjs <bundle.js|file.css> [classPrefix] [--host=<asar>] [--tags=.cls=tag,…]");
  process.exit(2);
}
/**
 * 选择器 → 元素标签。**必须来自对渲染代码的静态阅读**（本次：`client/client.panel.js`），
 * 因为"声明的 height 会不会被放大"取决于元素的 box-sizing 默认值：
 *   表单控件（button/input/select/textarea）由 UA 样式表给 border-box ⇒ 声明值 = 渲染值；
 *   footer/div/span 等**没有**兜底 ⇒ 声明值 + padding + border 才是渲染值。
 */
const TAG_DEFAULT = {
  ".dsh-rw-btn": "button",
  ".dsh-rw-btn--primary": "button",
  ".dsh-rw-btn--danger": "button",
  ".dsh-rw-chip": "button",
  ".dsh-rw-iconbtn": "button",
  ".dsh-rw-row": "button",
  ".dsh-rw-recent-row": "button",
  ".dsh-rw-menuitem": "button",
  ".dsh-rw-status": "footer",
  ".dsh-rw-dot": "span",
};
const TAGS = new Map(Object.entries(TAG_DEFAULT));
if (tagsArg) for (const kv of tagsArg.slice("--tags=".length).split(",")) { const [k, v] = kv.split("="); if (k && v) TAGS.set(k.trim(), v.trim()); }
const FORM_CTL = new Set(["button", "input", "select", "textarea"]);

const text = readFileSync(file, "utf8");

const ruleRe = new RegExp("\\." + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{}\"'`]*\\{[^{}]*\\}", "g");
const rules = [...text.matchAll(ruleRe)].map((m) => m[0]);

function px(decl, prop) {
  const m = decl.match(new RegExp("(?:^|[;{])" + prop + "\\s*:\\s*([\\d.]+)px"));
  return m ? parseFloat(m[1]) : null;
}
function padV(decl) {
  const m = decl.match(/(?:^|[;{])padding\s*:\s*([^;}]+)/);
  if (!m) {
    const t = px(decl, "padding-top");
    const b = px(decl, "padding-bottom");
    if (t === null && b === null) return null;
    return [t ?? 0, b ?? 0];
  }
  const v = m[1].trim().split(/\s+/).map((s) => (s.endsWith("px") ? parseFloat(s) : NaN));
  if (v.some((n) => Number.isNaN(n))) return "non-px";
  if (v.length === 1) return [v[0], v[0]];
  if (v.length === 2) return [v[0], v[0]];
  if (v.length === 3) return [v[0], v[2]];
  return [v[0], v[2]];
}
function borderV(decl) {
  let t = 0, b = 0;
  const sh = decl.match(/(?:^|[;{])border\s*:\s*([^;}]+)/);
  const bTop = decl.match(/(?:^|[;{])border-top\s*:\s*([^;}]+)/);
  const bBot = decl.match(/(?:^|[;{])border-bottom\s*:\s*([^;}]+)/);
  const w = (s) => {
    const m = s && s.match(/([\d.]+)px/);
    return m ? parseFloat(m[1]) : 0;
  };
  if (sh) { t = w(sh[1]); b = w(sh[1]); }
  if (bTop) t = w(bTop[1]);
  if (bBot) b = w(bBot[1]);
  return [t, b];
}

console.log("# box-sizing-audit: " + file + "   (class prefix ." + prefix + ")");
console.log("# 规则总数 = " + rules.length);
console.log("");
console.log("## ① content-box 陷阱（声明了 height/width，且有 padding 或 border，却未声明 box-sizing:border-box）");
console.log("SELECTOR".padEnd(30) + "元素".padEnd(9) + "声明".padEnd(7) + "渲染".padEnd(7) + "差额".padEnd(7) + "声明W".padEnd(7) + "判定");
let traps = 0, cands = 0;
for (const rule of rules) {
  const sel = rule.slice(0, rule.indexOf("{")).trim();
  const decl = rule.slice(rule.indexOf("{") + 1, rule.lastIndexOf("}"));
  const explicit = /box-sizing\s*:\s*border-box/.test(decl);
  const h = px(decl, "height");
  const w = px(decl, "width");
  const p = padV(decl);
  const b = borderV(decl);
  if (h === null && w === null) continue;
  const ah = h === null ? null : h + (p && p !== "non-px" ? p[0] + p[1] : 0) + b[0] + b[1];
  const aw = w === null ? null : w + (p && p !== "non-px" ? 0 : 0);
  const dh = ah === null || h === null ? 0 : ah - h;
  const baseSel = sel.split(/[,:]/)[0].trim();
  const tag = TAGS.get(baseSel) ?? TAGS.get(sel) ?? "?";
  let verdict;
  if (explicit) verdict = "OK(显式 border-box)";
  else if (h === null || dh === 0) verdict = "—";
  else if (FORM_CTL.has(tag)) { verdict = "候选（<" + tag + "> UA 兜底，需实测）"; cands++; }
  else { verdict = "**真陷阱（<" + tag + "> 无兜底）**"; traps++; }
  console.log(
    sel.slice(0, 29).padEnd(30) + tag.padEnd(9) +
    (h === null ? "—" : String(h)).padEnd(7) + (ah === null ? "—" : String(ah)).padEnd(7) +
    (dh ? "+" + dh : "0").padEnd(7) + (w === null ? "—" : String(w)).padEnd(7) + verdict
  );
}
console.log("");
console.log("真陷阱条数 = " + traps + "   候选（表单控件，需实测核对） = " + cands);
console.log("注：候选行的真假取决于元素是否吃到 UA 的 border-box。实测反推：T40 量到 `.dsh-rw-btn` 渲染 **28**（预测 38）、");
console.log("    `.dsh-rw-chip` 渲染 **24**（预测 26）⇒ 这两个 <button> 确为 border-box；而 `.dsh-rw-status`（<footer>）");
console.log("    渲染 **55**（预测 36）⇒ 无兜底。**兜底只属于表单控件，不是全局规则。**");

if (hostArg) {
  const asar = hostArg.slice("--host=".length);
  const t = readFileSync(asar).toString("latin1");
  const all = [...t.matchAll(/([^{};\`"]{0,110})\{[^{}]{0,140}box-sizing\s*:\s*border-box/g)].map((m) => m[1].trim());
  const onlyUniversal = all.filter((s) => {
    const parts = s.split(",").map((x) => x.trim());
    return parts.length > 0 && parts.every((p) => /^\*$|^\*::?(before|after)$/.test(p));
  });
  const formCtl = all.filter((s) => /(^|,)\s*(button|input|select|textarea)\s*(,|$|\[|:)/.test(s));
  console.log("");
  console.log("## ② 宿主的 box-sizing 重置形态（asar = " + asar + "）");
  console.log("声明 box-sizing:border-box 的规则数 = " + all.length);
  console.log("  纯通配形态 = " + onlyUniversal.length + "（注意：asar 含**多卷** CSS，其中 3 处形如 `*{…}` 的声明**无法证明作用于本面板**，" +
    "见 `probe-host-universal-reset.mjs` 的前文取证）");
  console.log("  表单控件选择器 = " + formCtl.length);
  console.log("  ⇒ **以实测为准**：`.dsh-rw-status`（`<footer>`）渲染 **55** ⇒ 该元素实际是 **content-box**，即「没有全局重置落到它头上」。");
  console.log("     而 `<button>` 渲染 28/24 = 声明值 ⇒ 表单控件有兜底。结论：**插件必须自己在每条 `height`+`padding` 规则上显式写 `box-sizing:border-box`**。");
}
