/**
 * box-sizing 陷阱审计（T43 新增 / **T49 补强红能力**）
 *
 * 为什么需要它：宿主 DSH 的 CSS **没有全局 `box-sizing` 重置**（逐组件声明），
 * 而 `height:<N>px` + `padding` + `border` 的规则若不按 **生效值** 拿到
 * `box-sizing:border-box`，浏览器按 `content-box` 解释 ⇒ 渲染高度
 * = N + 上下 padding + 上下 border，比声明大。底栏 55 vs 规格 36 就是这个陷阱。
 *
 * ── 判据（T49 修定）──────────────────────────────────────────────────────────
 * **按层叠后的生效值判定**，而不是"这条规则的声明里是否出现过 box-sizing"：
 *   1. 以**同一选择器**为粒度，把该选择器的所有规则**按源码顺序**合并；
 *   2. 同一属性：`!important` 胜普通声明（与顺序无关）；同等重要性下**后出现者胜**；
 *   3. `padding` / `border` 走简写 + 长写（`padding-top` 等）的逐边覆盖模型；
 *   4. 只有**生效值**是 `border-box` 才算安全；否则用「生效 height/width + 逐边 padding/border」算渲染尺寸并判陷阱。
 *
 * **旧判据为什么不够（附反例）**：旧判据逐条规则独立看"自己的声明里有没有 `border-box`" ⇒
 *   - `.x{box-sizing:border-box;height:20px;padding:4px}` + `.x{box-sizing:content-box}`
 *     ⇒ 旧判据报 **OK（假绿）**（反例：`fixtures/neg2-append-override.css`）；
 *   - `.x{box-sizing:content-box;height:20px;padding:4px}` + `.x{box-sizing:border-box}`
 *     ⇒ 旧判据报 **陷阱（假红）**（反例：`fixtures/pos2-append-safe.css`）。
 *   两个反例都在 `fixtures/` 里，可用 `--judge=old` 当场复现。
 *
 * ── 已知范围边界（不声称）──────────────────────────────────────────────────
 *   ✗ 跨选择器的**优先级**（specificity）比较：不同选择器互相覆盖不建模（需要完整 CSS 引擎）；
 *   ✗ `@media` / `@supports` 内的条件生效；
 *   ✗ 宿主或其它 `<style>` 后插入的覆盖（本仓已核实只有 1 处注入点 + 去重守卫）。
 *   本工具只声称一条可复算的判据："**同一选择器内、按源码顺序 + `!important` 的生效值**"。
 *
 * 用法：
 *   node box-sizing-audit.ts <bundle.js|file.css> [classPrefix] [选项]
 * 选项：
 *   --host=<asar>        附报宿主的 box-sizing 重置形态
 *   --tags=.cls=tag,…    指定选择器 → 元素标签（表单控件有 UA 兜底 ⇒ 记为"候选"而非"真陷阱"）
 *   --judge=old          用**旧判据**跑（只为 A/B 反例取证）
 *   --no-fail            即使有真陷阱也 exit 0（默认：有真陷阱 ⇒ **exit 1**）
 *   --strict             把"候选"也算失败
 *
 * 夹具可用注释 pragma 声明元素标签：`@tag .dsh-rw-x=button` 或 `@tag footer`（整文件默认），写在注释里即可。
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name) => argv.find((a) => a.startsWith("--" + name + "="));
const pos = argv.filter((a) => !a.startsWith("--"));
const file = pos[0];
const prefix = pos[1] || "dsh-rw-";
if (!file) {
  console.error("usage: node box-sizing-audit.ts <bundle.js|file.css> [classPrefix] [--host=<asar>] [--tags=…] [--judge=old] [--no-fail] [--strict]");
  process.exit(2);
}
const JUDGE = opt("judge") ? opt("judge").slice("--judge=".length) : "new";
const FAIL_ON_TRAP = !flag("no-fail");
const STRICT = flag("strict");

/** 选择器 → 元素标签（默认取自对 `client/client.panel.js` 的静态阅读）。 */
const TAGS = new Map(Object.entries({
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
}));
const tagsArg = opt("tags");
if (tagsArg) for (const kv of tagsArg.slice("--tags=".length).split(",")) { const [k, v] = kv.split("="); if (k && v) TAGS.set(k.trim(), v.trim()); }
const FORM_CTL = new Set(["button", "input", "select", "textarea"]);

const text0 = readFileSync(file, "utf8");

// 夹具 pragma（写在注释里，**必须在剥注释之前**）：@tag .dsh-rw-x=button   /   @tag footer（整文件默认）
let DEFAULT_TAG = "?";
for (const m of text0.matchAll(/@tag\s+([^\s*]+)/g)) {
  const spec = m[1].trim();
  if (spec.includes("=")) { const [s, t] = spec.split("="); TAGS.set(s.trim(), t.trim()); }
  else DEFAULT_TAG = spec;
}
/** 剥掉 `/* … *␣/` 注释再做结构解析 —— 否则注释里出现的类名会被误当成选择器（T49 自查踩到）。 */
const text = text0.replace(/\/\*[\s\S]*?\*\//g, "");

// ── 解析：规则 → 选择器列表 + 声明块（保持源码顺序）─────────────────────────────
const ruleRe = new RegExp("\\." + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{}\"'`]*\\{[^{}]*\\}", "g");
const rules = [...text.matchAll(ruleRe)].map((m, i) => ({
  i,
  sel: m[0].slice(0, m[0].indexOf("{")).trim(),
  decl: m[0].slice(m[0].indexOf("{") + 1, m[0].lastIndexOf("}")),
}));
const ruleCount = rules.length;

// ── 声明解析 ────────────────────────────────────────────────────────────────
function decls(declText) {
  const out = [];
  for (const part of declText.split(";")) {
    const c = part.indexOf(":");
    if (c < 0) continue;
    const prop = part.slice(0, c).trim().toLowerCase();
    let value = part.slice(c + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    value = value.replace(/!\s*important\s*$/i, "").trim();
    if (prop) out.push({ prop, value, important });
  }
  return out;
}
const px = (v) => { const m = String(v ?? "").match(/^(-?[\d.]+)px$/); return m ? parseFloat(m[1]) : null; };
const num = (v) => (v === "0" ? 0 : px(v));
const STYLE_KW = /(solid|dashed|dotted|double|groove|ridge|inset|outset)/i;
const SIDES = { top: "bT", right: "bR", bottom: "bB", left: "bL" };

/** 把一条声明写进状态（含简写展开）。`!important` 一旦生效，普通声明不得覆盖它。 */
function apply(state, d, ruleIndex) {
  const set = (key, value, extra = {}) => {
    const cur = state[key];
    if (cur && cur.important && !d.important) return;
    state[key] = { value, important: d.important, ruleIndex, ...extra };
  };
  const { prop, value, important } = d;
  if (prop === "box-sizing") return set("boxSizing", value);
  if (prop === "height") return set("height", value);
  if (prop === "width") return set("width", value);
  if (prop === "padding") {
    const vs = value.split(/\s+/);
    if (vs.length < 1 || vs.length > 4 || vs.some((v) => num(v) === null)) return;
    const [t, r = t, b = t, l = r] = vs.map(num);
    set("padT", t); set("padR", r); set("padB", b); set("padL", l);
    return;
  }
  const mp = prop.match(/^padding-(top|right|bottom|left)$/);
  if (mp) { const v = num(value); if (v === null) return; return set({ top: "padT", right: "padR", bottom: "padB", left: "padL" }[mp[1]], v); }
  if (prop === "border" || SIDES[prop.replace("border-", "")]) {
    const w = px((value.match(/(-?[\d.]+)px/) || [])[0] ?? "");
    const styleNone = /(^|\s)(none|hidden)(\s|$)/.test(value);
    const styleKnown = STYLE_KW.test(value) || styleNone;
    const targets = prop === "border" ? ["bT", "bR", "bB", "bL"] : [SIDES[prop.replace("border-", "")]];
    for (const s of targets) set(s, styleNone ? 0 : w === null ? 0 : w, { styleKnown, styleNone });
    return;
  }
  if (prop === "border-width") {
    const vs = value.split(/\s+/).map(num);
    if (vs.some((v) => v === null)) return;
    const [t, r = t, b = t, l = r] = vs;
    set("bT", t, { styleKnown: false }); set("bR", r, { styleKnown: false }); set("bB", b, { styleKnown: false }); set("bL", l, { styleKnown: false });
    return;
  }
  const mw = prop.match(/^border-(top|right|bottom|left)-width$/);
  if (mw) { const v = num(value); if (v === null) return; return set(SIDES[mw[1]], v, { styleKnown: false }); }
  if (prop === "border-style") {
    const none = /(^|\s)(none|hidden)(\s|$)/.test(value);
    for (const s of ["bT", "bR", "bB", "bL"]) set(s, none ? 0 : state[s]?.value ?? 0, { styleKnown: true, styleNone: none });
  }
}

/** 求某个选择器的层叠生效状态；并记录**每一条** box-sizing 声明（含落败的），用于暴露"追加覆盖"。 */
function effective(selector) {
  const state = {};
  const boxHistory = [];
  for (const r of rules) {
    if (!r.sel.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const d of decls(r.decl)) {
      apply(state, d, r.i);
      if (d.prop === "box-sizing") {
        const won = state.boxSizing && state.boxSizing.ruleIndex === r.i && String(state.boxSizing.value) === d.value;
        boxHistory.push({ ruleIndex: r.i, value: d.value, important: d.important, won });
      }
    }
  }
  return { state, boxHistory };
}

/** 新判据：一个选择器一条结论。 */
function judgeNew(selector) {
  const { state, boxHistory } = effective(selector);
  const tag = TAGS.get(selector) ?? DEFAULT_TAG;
  const bs = state.boxSizing ? String(state.boxSizing.value).trim().toLowerCase() : null;
  const declH = num(state.height?.value);
  const declW = num(state.width?.value);
  const padT = state.padT?.value ?? 0, padB = state.padB?.value ?? 0, padR = state.padR?.value ?? 0, padL = state.padL?.value ?? 0;
  const side = (k) => (state[k] ? (state[k].styleNone ? 0 : state[k].value ?? 0) : 0);
  const bT = side("bT"), bB = side("bB"), bR = side("bR"), bL = side("bL");
  const styleUnknown = ["bT", "bB", "bR", "bL"].some((k) => state[k] && state[k].styleKnown === false && (state[k].value ?? 0) > 0);
  // border-box 生效时，渲染尺寸 = 声明尺寸（padding/border 向内挤），不能报"声明 + padding"
  const rendering = declH === null ? null : bs === "border-box" ? declH : declH + padT + padB + bT + bB;
  const renderingW = declW === null ? null : bs === "border-box" ? declW : declW + padL + padR + bL + bR;
  // **只有真的被放大才算陷阱**：无 padding/border 时声明值 = 渲染值，不构成缺陷（T49 自查踩到的过报）
  const dH = rendering === null ? 0 : rendering - declH;
  const dW = renderingW === null ? 0 : renderingW - declW;
  const axes = [
    dH > 0 ? "高 " + declH + "→" + rendering : null,
    dW > 0 ? "宽 " + declW + "→" + renderingW : null,
  ].filter(Boolean).join("；");

  let verdict, kind;
  if (bs === "border-box") { verdict = "OK(border-box 生效)"; kind = "ok"; }
  else if (declH === null && declW === null) { verdict = "—"; kind = "skip"; }
  else if (dH <= 0 && dW <= 0) { verdict = "—（无 padding/border，声明值 = 渲染值）"; kind = "skip"; }
  else if (FORM_CTL.has(tag)) { verdict = "候选（<" + tag + "> UA 兜底，需实测）"; kind = "cand-form"; }
  else if (styleUnknown) { verdict = "候选（只给了边框宽度、样式未知 ⇒ 未必占位）"; kind = "cand-style"; }
  else { verdict = "**真陷阱（" + axes + "；生效 " + (bs === null ? "无 box-sizing" : bs) + "）**"; kind = "trap"; }
  return { selector, tag, bs, bsWinner: state.boxSizing ?? null, boxHistory, declH, rendering, declW, renderingW, dH, dW, axes, verdict, kind };
}

/** 旧判据（T43 版）：逐条规则独立看"自己的声明里有没有 border-box"。仅用于 A/B 反例取证。 */
function judgeOld() {
  const num1 = (s, prop) => {
    const m = s.match(new RegExp("(?:^|[;{])\\s*" + prop + "\\s*:\\s*(-?[\\d.]+)px"));
    return m ? Number(m[1]) : null;
  };
  const rows = [];
  for (const r of rules) {
    const d = r.decl;
    const explicit = /box-sizing\s*:\s*border-box/.test(d);
    const h = num1(d, "height");
    const w = num1(d, "width");
    if (h === null && w === null) continue;
    const pads = (d.match(/(?:^|[;{])\s*padding\s*:\s*([^;}]+)/) || [])[1];
    let pt = 0, pb = 0;
    if (pads) { const vs = pads.trim().split(/\s+/).map(num); if (!vs.some((v) => v === null)) { pt = vs[0]; pb = vs[2] ?? vs[0]; } }
    const bt = num1(d, "border-top"), bb = num1(d, "border-bottom"), bs = num1(d, "border");
    const border = (bt ?? 0) + (bb ?? 0) + (bs !== null ? bs * 2 : 0);
    const rh = h === null ? null : h + pt + pb + border;
    const tag = TAGS.get(r.sel) ?? DEFAULT_TAG;
    let verdict;
    if (explicit) verdict = "OK(显式 border-box)";
    else if (FORM_CTL.has(tag)) verdict = "候选（<" + tag + "> UA 兜底，需实测）";
    else verdict = "**真陷阱（<" + tag + "> 无兜底）**";
    rows.push({ sel: r.sel, tag, h, rh, verdict, ruleIndex: r.i });
  }
  return rows;
}

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log("# box-sizing-audit: " + file);
console.log("# class prefix ." + prefix + "   规则数 = " + ruleCount + "   judge = " + JUDGE + "   默认标签 = " + DEFAULT_TAG);
console.log("");

let traps = 0, cands = 0, oks = 0, skipped = 0;

if (JUDGE === "old") {
  console.log("## 旧判据（逐条规则独立；**只看这条规则自己有没有 box-sizing**）");
  console.log("RULE#".padEnd(7) + "SELECTOR".padEnd(30) + "声明".padEnd(7) + "渲染".padEnd(7) + "判定");
  for (const r of judgeOld()) {
    if (r.verdict.startsWith("**")) traps++;
    console.log(String(r.ruleIndex).padEnd(7) + r.sel.slice(0, 29).padEnd(30) + (r.h === null ? "—" : String(r.h)).padEnd(7) + (r.rh === null ? "—" : String(r.rh)).padEnd(7) + r.verdict);
  }
} else {
  const seen = new Set(), order = [];
  for (const r of rules) for (const s of r.sel.split(",").map((x) => x.trim())) if (s && !seen.has(s)) { seen.add(s); order.push(s); }

  console.log("## 新判据（**同一选择器的层叠生效值**：源码顺序 + `!important`；简写/长写逐边覆盖）");
  console.log("SELECTOR".padEnd(28) + "元素".padEnd(8) + "生效box-sizing".padEnd(17) + "来自".padEnd(6) + "声明H".padEnd(7) + "渲染H".padEnd(7) + "声明W".padEnd(7) + "渲染W".padEnd(7) + "覆盖".padEnd(7) + "判定");
  const results = order.map((s) => ({ s, v: judgeNew(s) }));
  for (const { s, v } of results) {
    if (v.kind === "trap") traps++;
    else if (v.kind === "cand-form" || v.kind === "cand-style") cands++;
    else if (v.kind === "ok") oks++;
    else skipped++;
    if (v.kind === "skip") continue;
    const bsShown = (v.bs ?? "—") + (v.bsWinner && v.bsWinner.important ? " !imp" : "");
    const from = v.bsWinner ? "#" + v.bsWinner.ruleIndex : "—";
    const override = v.boxHistory.length > 1 ? "是(" + v.boxHistory.length + ")" : "—";
    console.log(
      s.slice(0, 27).padEnd(28) + String(v.tag).padEnd(8) + bsShown.padEnd(17) + from.padEnd(6) +
      (v.declH === null ? "—" : String(v.declH)).padEnd(7) + (v.rendering === null ? "—" : String(v.rendering)).padEnd(7) +
      (v.declW === null ? "—" : String(v.declW)).padEnd(7) + (v.renderingW === null ? "—" : String(v.renderingW)).padEnd(7) +
      override.padEnd(7) + v.verdict
    );
  }
  console.log("");
  console.log("真陷阱数 = " + traps + "   候选 = " + cands + "   OK = " + oks + "   无尺寸声明(跳过) = " + skipped);
  const overridden = results.filter((r) => r.v.boxHistory.length > 1);
  console.log(overridden.length
    ? "**检测到 box-sizing 的追加覆盖** " + overridden.length + " 个：" + overridden.map((r) => r.s + "(" + r.v.boxHistory.length + "条 ⇒ 生效 " + r.v.bs + ")").join("，")
    : "未检测到 box-sizing 的追加覆盖（每个选择器的 box-sizing 只声明一次）");
}

const hostArg = opt("host");
if (hostArg) {
  const asar = hostArg.slice("--host=".length);
  const t = readFileSync(asar).toString("latin1");
  const all = [...t.matchAll(/([^{};\`"]{0,110})\{[^{}]{0,140}box-sizing\s*:\s*border-box/g)].map((m) => m[1].trim());
  const onlyUniversal = all.filter((s) => { const p = s.split(",").map((x) => x.trim()); return p.length > 0 && p.every((q) => /^\*$|^\*::?(before|after)$/.test(q)); });
  console.log("");
  console.log("## ② 宿主的 box-sizing 重置形态（asar = " + asar + "）");
  console.log("声明 box-sizing:border-box 的规则数 = " + all.length + "；纯通配形态 = " + onlyUniversal.length + "（asar 含多卷 CSS，无法证明作用于本面板）");
  console.log("  ⇒ **以实测为准**：`.dsh-rw-status` 曾是 36 → 渲染 55 ⇒ content-box；`<button>` 渲染 = 声明值 ⇒ 表单控件有兜底。");
}

const fail = traps > 0 || (STRICT && cands > 0);
console.log("");
console.log("==> " + (fail ? "FAIL（真陷阱 " + traps + " 条" + (STRICT ? " / 候选 " + cands + " 条" : "") + "）" : "PASS（真陷阱 0 条" + (cands ? "；候选 " + cands + " 条需人工核对" : "") + "）") + (FAIL_ON_TRAP ? "" : "   [--no-fail ⇒ 退出码 0]"));
if (fail && FAIL_ON_TRAP) process.exit(1);
