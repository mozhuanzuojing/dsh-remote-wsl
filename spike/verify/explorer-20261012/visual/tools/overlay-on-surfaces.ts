/**
 * alpha 覆盖层在**三种背景**上的终值 + 两态可区分性（T27 第二轮约束 #2）。
 *
 * 为什么要单独算：`--dsw-alias-interactive-bg-hover/-active` 是 **alpha 色**，
 * 同一条 CSS 在 `sidebar-fill`（底栏）/ `bg-overlay`（菜单）/ `bg-layer-1`（列表）上
 * **合成出的终值不同** ⇒ "hover 与 active 可区分"（T27 §9.1-V7）必须逐背景各验一次，
 * 不能只验一次。
 *
 * 用法： node overlay-on-surfaces.mjs <asar>
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
const STATIC = new Map();
for (const d of text.matchAll(/(--dsw-static-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) STATIC.set(d[1], d[2]);
const THEME = {
  light: decls(blockStartingAt("body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00)") ?? ""),
  dark: decls(blockStartingAt("body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)") ?? ""),
};
function raw(theme, name, depth = 0) {
  if (depth > 12) return null;
  const v = THEME[theme].get(name) ?? STATIC.get(name);
  if (v === undefined) return null;
  const vm = v.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,([\s\S]*))?\)$/);
  if (vm) return raw(theme, vm[1], depth + 1) ?? (vm[2] ? vm[2].trim() : null);
  return v;
}
function parseColor(s) {
  if (!s) return null;
  let m = s.trim().match(/^#([0-9a-fA-F]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length === 6) h += "ff";
    if (h.length !== 8) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16) / 255];
  }
  m = s.trim().match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  }
  return null;
}
const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
function lum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };

const SURFACES = [
  { name: "bg-layer-1（列表行底）", token: "--dsw-alias-bg-layer-1" },
  { name: "specific-sidebar-fill（底栏/菜单外）", token: "--dsw-specific-sidebar-fill" },
  { name: "bg-overlay（⋯ 菜单/浮层底）", token: "--dsw-alias-bg-overlay" },
];

console.log("# overlay-on-surfaces.mjs —— alpha 覆盖层在三背景上的终值 + 可区分性（T27 第二轮约束 #2）");
console.log("# 判据：hover/active 相对**静息底**的可感知性（本文 §8.4-C4：不作对比度门禁，但要求「两态彼此可区分」）");
console.log("");

let worst = { d: Infinity, where: "" };
for (const theme of ["light", "dark"]) {
  console.log("===== " + theme.toUpperCase() + " =====");
  console.log(
    "背景".padEnd(34) + "静息".padEnd(10) + "hover".padEnd(10) + "active".padEnd(10) +
    "hover/静息".padEnd(12) + "active/静息".padEnd(13) + "active/hover".padEnd(13) +
    "正文/hover".padEnd(12) + "次要/active"
  );
  for (const s of SURFACES) {
    const base = parseColor(raw(theme, s.token));
    const b = base[3] < 1 ? over(base, parseColor(raw(theme, "--dsw-alias-bg-base"))) : base;
    const h = over(parseColor(raw(theme, "--dsw-alias-interactive-bg-hover")), b);
    const a = over(parseColor(raw(theme, "--dsw-alias-interactive-bg-active")), b);
    const t1 = parseColor(raw(theme, "--dsw-alias-label-primary"));
    const t2 = parseColor(raw(theme, "--dsw-alias-label-secondary"));
    const dHA = ratio(a, h);
    if (dHA < worst.d) worst = { d: dHA, where: theme + " / " + s.name };
    console.log(
      s.name.padEnd(34) + hex(b).padEnd(10) + hex(h).padEnd(10) + hex(a).padEnd(10) +
      ratio(h, b).toFixed(2).padEnd(12) + ratio(a, b).toFixed(2).padEnd(13) + dHA.toFixed(2).padEnd(13) +
      ratio(t1, h).toFixed(2).padEnd(12) + ratio(t2, a).toFixed(2)
    );
  }
  console.log("");
}
console.log("# 最弱的「active vs hover」= " + worst.d.toFixed(3) + "  @ " + worst.where);
console.log("# 说明：这一列才是 T27 §9.1-V7 在「同一控件上 hover→active」的可区分性依据；");
console.log("#       它天然很低（两个都是浅覆盖层），因此 §5.1 规定「当前/选中」**不靠填充**，");
console.log("#       而靠 2px brand-primary 竖条 + 600 字重（18.90:1 / 15.03:1，且灰度可辨）。");
