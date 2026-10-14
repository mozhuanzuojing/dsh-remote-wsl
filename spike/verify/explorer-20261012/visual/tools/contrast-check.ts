/**
 * 对比度计算器（WCAG 2.x 相对亮度 / 对比度）。
 * 输入：app.asar（解析 DSH 真实 token 取值）+ 一份 pair 列表。
 * 用法： node contrast-check.mjs <asar>
 * 输出：每组的 fg/bg 解析值、hex、对比度、4.5:1(正文) / 3:1(非文本) 判定。
 *
 * alpha 合成：DSH 多数颜色带 alpha（如 border-l1 = #0000000a）。要判"边框 vs 背景"必须
 * 先按 src-over 合成到背景上，本脚本做这一步（composite()）。
 */
import { readFileSync } from "node:fs";

const asar = process.argv[2];
const text = readFileSync(asar).toString("latin1");

function decls(css) {
  const m = new Map();
  for (const d of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/g)) m.set(d[1], d[2].trim());
  return m;
}
function blockStartingAt(needle) {
  const i = text.indexOf(needle);
  if (i < 0) return null;
  return text.slice(i, text.indexOf("}", i) + 1);
}
const LIGHT = decls(blockStartingAt("body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00)") ?? "");
const DARK = decls(blockStartingAt("body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)") ?? "");
const STATIC = new Map();
for (const d of text.matchAll(/(--dsw-static-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) STATIC.set(d[1], d[2]);
for (const d of text.matchAll(/(--dsw-static-[a-z0-9-]+)\s*:\s*(rgb\([^)]*\))/g)) if (!STATIC.has(d[1])) STATIC.set(d[1], d[2]);

const THEME = { light: LIGHT, dark: DARK };
function raw(theme, name, depth = 0) {
  if (depth > 12) return null;
  const map = THEME[theme];
  const v = map.get(name) ?? STATIC.get(name);
  if (v === undefined) return null;
  const vm = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,([\s\S]*))?\)$/);
  if (vm) return raw(theme, vm[1], depth + 1) ?? (vm[2] ? vm[2].trim() : null);
  return v;
}

function parseColor(s) {
  if (!s) return null;
  s = s.trim();
  let m = s.match(/^#([0-9a-fA-F]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    if (h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  }
  return null;
}
const rgba = (c) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3].toFixed(3)})`;
/** src-over：把 fg(可能带 alpha) 合成到不透明 bg 上 */
function composite(fg, bg) {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}
function lum(c) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** 组：{id, fgToken, bgToken, kind:'text'|'nontext', note} */
const GROUPS = [
  { id: "G1 正文", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "面板主体文案" },
  { id: "G1b 正文/底栏", fg: "--dsw-alias-label-primary", bg: "--dsw-specific-sidebar-fill", kind: "text", note: "底栏状态条" },
  { id: "G2 次要文字", fg: "--dsw-alias-label-secondary", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "路径/说明" },
  { id: "G2b 次要/底栏", fg: "--dsw-alias-label-secondary", bg: "--dsw-specific-sidebar-fill", kind: "text", note: "底栏小字" },
  { id: "G3 三级/禁用文字", fg: "--dsw-alias-label-tertiary", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "提示占位" },
  { id: "G4 链接/焦点环", fg: "--dsw-alias-state-business-primary", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "DSH 默认焦点环色" },
  { id: "G4b 链接", fg: "--dsw-alias-link", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "行内动作文字" },
  { id: "G5 success 点", fg: "--dsw-alias-state-success-primary", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "守护运行中" },
  { id: "G5b success 文字", fg: "--dsw-alias-state-success-primary", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "若把状态色当文字" },
  { id: "G6 error 文字", fg: "--dsw-alias-state-error-primary", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "错误标题" },
  { id: "G6b error 文字/底栏", fg: "--dsw-alias-state-error-primary", bg: "--dsw-specific-sidebar-fill", kind: "text", note: "" },
  { id: "G7 warn 文字", fg: "--dsw-alias-state-warn-primary", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "漂移告警（现状用的就是它）" },
  { id: "G7b warn-label 文字", fg: "--dsw-alias-state-warn-label", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "候选替代" },
  { id: "G7c warn-label/warn-tertiary", fg: "--dsw-alias-state-warn-label", bg: "--dsw-alias-state-warn-tertiary", kind: "text", note: "候选替代（底色徽标）" },
  { id: "G8 idle 点", fg: "--dsw-alias-state-idle-primary", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "已停止/未运行" },
  { id: "G9 边框 l1 vs layer-1", fg: "--dsw-alias-border-l1", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "分隔线" },
  { id: "G9b 边框 l2 vs layer-1", fg: "--dsw-alias-border-l2", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "控件描边" },
  { id: "G9c 边框 l2 vs bg-base", fg: "--dsw-alias-border-l2", bg: "--dsw-alias-bg-base", kind: "nontext", note: "输入框描边" },
  { id: "G10 危险按钮 hover", fg: "--dsw-alias-bg-layer-1", bg: "--dsw-alias-state-error-primary", kind: "text", note: "error 底 + layer-1 字" },
  { id: "G11 正文/overlay", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-bg-overlay", kind: "text", note: "hover/选中填充" },
  { id: "G11b 次要/overlay", fg: "--dsw-alias-label-secondary", bg: "--dsw-alias-bg-overlay", kind: "text", note: "" },
  { id: "G12 次要/nav-hover", fg: "--dsw-alias-label-secondary", bg: "--dsw-specific-sidebar-nav-item-hover", kind: "text", note: "侧栏行 hover" },
  { id: "G13 正文/nav-active", fg: "--dsw-alias-label-primary", bg: "--dsw-specific-sidebar-nav-item-active", kind: "text", note: "侧栏行选中" },
  { id: "G14 brand(单色) 正文", fg: "--dsw-alias-brand-primary", bg: "--dsw-alias-bg-layer-1", kind: "text", note: "brand 其实是单色强调" },
  { id: "G15 焦点环 vs sidebar-fill", fg: "--dsw-alias-state-business-primary", bg: "--dsw-specific-sidebar-fill", kind: "nontext", note: "底栏内控件焦点环" },
  { id: "G16 焦点环 vs overlay", fg: "--dsw-alias-state-business-primary", bg: "--dsw-alias-bg-overlay", kind: "nontext", note: "选中行上的焦点环" },
  // —— 第二轮：替代方案与边界 ——
  { id: "A1 边框 l3 vs layer-1", fg: "--dsw-alias-border-l3", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "更重的描边" },
  { id: "A2 边框 l4 vs layer-1", fg: "--dsw-alias-border-l4", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "最重描边" },
  { id: "A3 success点/success-tertiary", fg: "--dsw-alias-state-success-primary", bg: "--dsw-alias-state-success-tertiary", kind: "nontext", note: "绿点画在绿底徽标上" },
  { id: "A4 success点/layer-2", fg: "--dsw-alias-state-success-primary", bg: "--dsw-alias-bg-layer-2", kind: "nontext", note: "深底上的绿点" },
  { id: "A5 error点/layer-2", fg: "--dsw-alias-state-error-primary", bg: "--dsw-alias-bg-layer-2", kind: "nontext", note: "" },
  { id: "A6 warn点/warn-tertiary", fg: "--dsw-alias-state-warn-primary", bg: "--dsw-alias-state-warn-tertiary", kind: "nontext", note: "" },
  { id: "A7 idle点/layer-2", fg: "--dsw-alias-state-idle-primary", bg: "--dsw-alias-bg-layer-2", kind: "nontext", note: "" },
  { id: "A8 正文/success-tertiary", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-state-success-tertiary", kind: "text", note: "绿底徽标上的字" },
  { id: "A9 正文/warn-tertiary", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-state-warn-tertiary", kind: "text", note: "黄底徽标上的字" },
  { id: "A10 label-tertiary/sidebar-fill", fg: "--dsw-alias-label-tertiary", bg: "--dsw-specific-sidebar-fill", kind: "text", note: "底栏三级字" },
  { id: "A11 危险按钮静态描边", fg: "--dsw-alias-state-error-primary", bg: "--dsw-alias-bg-layer-2", kind: "nontext", note: "描边+字色" },
  { id: "A12 正文/idle 禁用底", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-bg-layer-2", kind: "text", note: "" },
  { id: "A13 焦点环/interactive-hover", fg: "--dsw-alias-state-business-primary", bg: "--dsw-alias-interactive-bg-hover", kind: "nontext", note: "hover 填充上的焦点环(合成)" },
  { id: "A14 焦点环/interactive-active", fg: "--dsw-alias-state-business-primary", bg: "--dsw-alias-interactive-bg-active", kind: "nontext", note: "active 填充上的焦点环(合成)" },
  { id: "A15 正文/interactive-hover", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-interactive-bg-hover", kind: "text", note: "" },
  { id: "A16 次要/interactive-active", fg: "--dsw-alias-label-secondary", bg: "--dsw-alias-interactive-bg-active", kind: "text", note: "" },
  { id: "A17 正文/nav-active", fg: "--dsw-alias-label-primary", bg: "--dsw-specific-sidebar-nav-item-active", kind: "text", note: "" },
  { id: "A18 焦点环/menu-surface", fg: "--dsw-alias-state-business-primary", bg: "--dsw-specific-menu", kind: "nontext", note: "⋯ 菜单上的焦点环" },
  { id: "A19 正文/menu-surface", fg: "--dsw-alias-label-primary", bg: "--dsw-specific-menu", kind: "text", note: "⋯ 菜单文字" },
  { id: "A20 次要/menu-surface", fg: "--dsw-alias-label-secondary", bg: "--dsw-specific-menu", kind: "text", note: "" },
  // —— 第三轮：浮层（bg-overlay）上的焦点环与文字（决定"双色焦点指示"是否必要） ——
  { id: "R1 焦点环/popover", fg: "--dsw-alias-state-business-primary", bg: "--dsw-alias-bg-overlay", kind: "nontext", note: "=G16，dark 2.49 不达标" },
  { id: "R2 内圈 hairline vs 焦点环", fg: "--dsw-alias-bg-layer-1", bg: "--dsw-alias-state-business-primary", kind: "nontext", note: "双色焦点指示：内圈 layer-1 与蓝环的对比" },
  { id: "R3 正文/popover", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-bg-overlay", kind: "text", note: "菜单项文字" },
  { id: "R4 次要/popover", fg: "--dsw-alias-label-secondary", bg: "--dsw-alias-bg-overlay", kind: "text", note: "菜单项次要文字（dark 预计不达标）" },
  { id: "R5 禁用/popover", fg: "--dsw-alias-label-dimmed", bg: "--dsw-alias-bg-overlay", kind: "text", note: "禁用项（WCAG 1.4.3 豁免，仅记录）" },
  { id: "R6 正文/inset(bg-base)", fg: "--dsw-alias-label-primary", bg: "--dsw-alias-bg-base", kind: "text", note: "输入框内文字" },
  { id: "R7 border-l2 vs bg-base(dark)", fg: "--dsw-alias-border-l2", bg: "--dsw-alias-bg-base", kind: "nontext", note: "输入框描边（dark 主题）" },
  { id: "R8 hover 填充 vs layer-1", fg: "--dsw-alias-interactive-bg-hover", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "hover 是否可感知（1.0=不可见）" },
  { id: "R9 active 填充 vs layer-1", fg: "--dsw-alias-interactive-bg-active", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "选中填充是否可感知" },
  { id: "R10 popover 面 vs layer-1", fg: "--dsw-alias-bg-overlay", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "浮层面与内容面的可感知差异" },
  { id: "R11 sidebar-fill vs layer-1", fg: "--dsw-specific-sidebar-fill", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "chrome 面与内容面的可感知差异" },
  { id: "R12 layer-2 vs layer-1", fg: "--dsw-alias-bg-layer-2", bg: "--dsw-alias-bg-layer-1", kind: "nontext", note: "嵌套面差异（light 预计 1.00）" },
];

console.log("# contrast-check.mjs — WCAG 2.x（相对亮度），DSH token 实测取值（app.asar 解析）");
console.log("# 判据：正文 ≥4.5:1；大字(≥18.66px粗/24px) ≥3:1；非文本(UI 边界/图形) ≥3:1");
console.log("");
for (const theme of ["light", "dark"]) {
  console.log("===== " + theme.toUpperCase() + " =====");
  console.log("组".padEnd(26) + "fg".padEnd(40) + "bg".padEnd(40) + "ratio".padEnd(8) + "OK?");
  for (const g of GROUPS) {
    const fgRaw = raw(theme, g.fg), bgRaw = raw(theme, g.bg);
    const fgC = parseColor(fgRaw), bgC = parseColor(bgRaw);
    if (!fgC || !bgC) { console.log(g.id.padEnd(26) + "UNRESOLVED " + fgRaw + " / " + bgRaw); continue; }
    const baseC = parseColor(raw(theme, "--dsw-alias-bg-base")) ?? [255, 255, 255, 1];
    const bgOpaque = bgC[3] < 1 ? composite(bgC, baseC) : bgC;
    const fgOnBg = composite(fgC, bgOpaque);
    const r = ratio(fgOnBg, bgOpaque);
    const need = g.kind === "text" ? 4.5 : 3;
    const ok = r >= need ? "PASS" : "FAIL(<" + need + ")";
    console.log(g.id.padEnd(26) + (g.fg + "=" + fgRaw).padEnd(40) + (g.bg + "=" + bgRaw).padEnd(40) + r.toFixed(2).padEnd(8) + ok + "  # " + g.note);
  }
  console.log("");
}
