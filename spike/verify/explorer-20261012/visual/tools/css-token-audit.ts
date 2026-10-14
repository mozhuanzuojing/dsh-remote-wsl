/**
 * 面板视觉规格的**机械门禁**（两条硬约束，可进收尾脚本，退出码可判）。
 *
 * 用法：
 *   node css-token-audit.ts <bundle.js | file.css> [classPrefix] [选项]
 * 选项：
 *   --no-allow              关闭"闭集断言"（只查硬编码色）
 *   --allow=<t1,t2,…>       用自定义 allow-list 覆盖默认的 17 个
 *
 * 两条硬约束（任一不满足 ⇒ exit 非 0）：
 *   C1 **硬编码颜色 = 0**：扫 `#hex(3/4/6/8)`、`rgb()/rgba()`、`hsl()/hsla()`、
 *      `color()/lab()/lch()/oklab()/oklch()/hwb()`、以及 CSS 命名色
 *      （命名色两侧不得是标识符/连字符，避免误报 `white-space`）。
 *   C2 **token 闭集**：面板 CSS 里 `var(--dsw-…)` 引用的 token 集合必须 ⊆ 允许集
 *      （默认 = `docs/panel-visual-spec.md` §1.0 的 17 个）。
 *      —— 只证明"没有字面色"**不能**同时证明"没有第 18 个 token"，
 *         所以这两条必须分开断言（T27 第二轮约束 #3 / lead 裁决 Q1-①）。
 *
 * 另有 2 个**软**检查（不计入退出码，但要打印）：
 *   S1 `label-dimmed` 只允许出现在 `:disabled` / `::placeholder` 相关规则里
 *      （T27 第二轮约束 #1：它是"禁用/占位"专用色，不得用于"弱化仍然有效的信息"）。
 *
 * Q4（lead 裁决）的**窄豁免**：`box-shadow`（含 `-webkit-`）声明里的
 * **无 色 相** 半透明黑 `rgba(0,0,0,α)` / `#000αα`，且 α ∈ [0.04, 0.28]，**不计入 C1**。
 * 带色相的阴影、α 越界、以及 box-shadow 之外的任何字面色 —— 一律照样 FAIL。
 */
import { readFileSync } from "node:fs";

/** 规格 §1.0 的 17 个 token（闭集）。改这里必须同时改规格。 */
const ALLOW_DEFAULT = [
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-dimmed",
  "--dsw-alias-brand-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-idle-primary",
  "--dsw-specific-sidebar-fill",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-interactive-bg-active",
];

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const pos = argv.filter((a) => !a.startsWith("--"));
const file = pos[0];
const prefix = pos[1] || "dsh-rw-";
if (!file) {
  console.error("usage: node css-token-audit.ts <bundle.js|file.css> [classPrefix] [--no-allow] [--allow=t1,t2]");
  process.exit(2);
}
const allowFlag = flags.find((f) => f.startsWith("--allow="));
const ALLOW = new Set(allowFlag ? allowFlag.slice("--allow=".length).split(",").map((s) => s.trim()) : ALLOW_DEFAULT);
const enforceAllow = !flags.includes("--no-allow");

const text = readFileSync(file, "utf8");

// 1) 规则
const ruleRe = new RegExp("\\." + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[^{}\"'`]*\\{[^{}]*\\}", "g");
const rules = [...text.matchAll(ruleRe)].map((m) => m[0]);

// 2) token
const tokens = new Map();
for (const m of text.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)) tokens.set(m[1], (tokens.get(m[1]) || 0) + 1);

// 3) 字面量
const NAMED = "(?<![-\\w])(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|gold|navy|teal|olive|maroon|lime|aqua|cyan|magenta|fuchsia|transparent|currentcolor)(?![-\\w])";
const LITERALS = [
  { kind: "#hex(3/4/6/8)", re: /#[0-9a-fA-F]{3,8}\b/g },
  { kind: "rgb()/rgba()", re: /\brgba?\s*\(/g },
  { kind: "hsl()/hsla()", re: /\bhsla?\s*\(/g },
  { kind: "named-color", re: new RegExp(NAMED, "gi") },
  { kind: "color()/lab()/oklch()", re: /\b(?:color|lab|lch|oklab|oklch|hwb)\s*\(/g },
];
const findings = [];
for (const l of LITERALS) {
  for (const m of text.matchAll(l.re)) {
    const soft = /^(transparent|currentcolor)$/i.test(m[0]);
    findings.push({ kind: l.kind, value: m[0], soft, at: m.index });
  }
}

/**
 * Q4（lead 裁决）：**只**豁免"面板外浮层"的 `box-shadow` 里的**中性半透明黑**。
 *   - 位置：必须落在 `box-shadow`（含 `-webkit-` 前缀）声明里；
 *   - 颜色：必须是无色相的 `rgba(0,0,0,α)` 或 `#000`/`#000000` + α；
 *   - α：必须落在文档化区间 [0.04, 0.28]（规格 §2.4）。
 * 其它任何硬编码色（含 box-shadow 里的带色相阴影）一律**不豁免**。
 */
const SHADOW_ALPHA_MIN = 0.04;
const SHADOW_ALPHA_MAX = 0.28;
function declAt(i) {
  let s = i;
  while (s > 0 && !";{}".includes(text[s - 1])) s--;
  let e = i;
  while (e < text.length && !";}".includes(text[e])) e++;
  return text.slice(s, e);
}
function shadowNeutralAlpha(f) {
  const decl = declAt(f.at);
  if (!/^\s*(?:-webkit-)?box-shadow\s*:/.test(decl)) return null;
  const rest = text.slice(f.at);
  let alpha = null;
  // rgba()/rgb() 形态：通道必须全 0（无色相），第 4 个分量是 alpha
  const fn = rest.match(/^rgba?\(([^)]*)\)/i);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((s) => s.length > 0);
    const zero = (s) => /^0(?:\.0+)?%?$/.test(s);
    if (parts.length >= 4 && zero(parts[0]) && zero(parts[1]) && zero(parts[2])) {
      const a = parts[3];
      alpha = a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
    } else if (parts.length === 3 && zero(parts[0]) && zero(parts[1]) && zero(parts[2])) {
      alpha = 1;
    }
  }
  if (alpha === null) {
    // #hex 形态：#000α / #000000αα（α 在末位）
    const h = f.value.match(/^#(000|000000)([0-9a-fA-F]{1,2})$/);
    if (h) {
      let a = h[2];
      if (a.length === 1) a += a;
      alpha = parseInt(a, 16) / 255;
    } else if (/^#(000|000000)$/.test(f.value)) {
      alpha = 1;
    }
  }
  if (alpha === null) return null;
  return alpha >= SHADOW_ALPHA_MIN && alpha <= SHADOW_ALPHA_MAX ? alpha : -1;
}
const shadowOk = [];
const hard = [];
for (const f of findings) {
  if (f.soft) continue;
  const a = shadowNeutralAlpha(f);
  if (a !== null && a > 0) { shadowOk.push({ ...f, alpha: a }); continue; }
  hard.push(f);
}
const soft = findings.filter((f) => f.soft);

// 4) 闭集断言
const outOfSet = [...tokens.keys()].filter((t) => !ALLOW.has(t)).sort();

// 5) 软检查：label-dimmed 的使用域
const dimmedMisuse = [];
if (tokens.has("--dsw-alias-label-dimmed")) {
  for (const rule of rules) {
    if (!rule.includes("--dsw-alias-label-dimmed")) continue;
    const sel = rule.slice(0, rule.indexOf("{"));
    if (/:disabled|:placeholder|\[disabled|\[aria-disabled|::placeholder/.test(sel)) continue;
    dimmedMisuse.push(sel.trim().slice(0, 120));
  }
}

console.log("# css-token-audit: " + file);
console.log("# class prefix = ." + prefix + "   allow-list = " + (enforceAllow ? ALLOW.size + " tokens" : "OFF"));
console.log("rules                = " + rules.length);
console.log("distinct --dsw-* vars= " + tokens.size);
for (const [k, v] of [...tokens.entries()].sort()) {
  console.log("    " + String(v).padStart(3) + "x  " + k + (enforceAllow && !ALLOW.has(k) ? "   <== 集合外" : ""));
}
console.log("C1 hardcoded colors  = " + hard.length + (hard.length ? "  <== FAIL" : "  <== PASS"));
for (const f of hard.slice(0, 40)) console.log("    @" + f.at + "  " + f.kind + "  " + JSON.stringify(f.value));
console.log("C1 shadow 豁免（中性半透明黑，α∈[" + SHADOW_ALPHA_MIN + "," + SHADOW_ALPHA_MAX + "]）= " + shadowOk.length);
for (const f of shadowOk.slice(0, 40)) console.log("    @" + f.at + "  " + f.value + "  α=" + f.alpha.toFixed(3));
console.log("C1 soft keywords     = " + soft.length + " (transparent/currentColor，非硬编码色)");
console.log("C2 token set ⊆ allow = " + (outOfSet.length === 0 ? "PASS" : "FAIL") + (outOfSet.length ? "  集合外 " + outOfSet.length + " 个：" : ""));
for (const t of outOfSet) console.log("    " + t + "   (x" + tokens.get(t) + ")");
console.log("S1 label-dimmed 域   = " + (dimmedMisuse.length === 0 ? "OK（未使用，或只用于 :disabled/::placeholder）" : "注意：" + dimmedMisuse.length + " 处非禁用选择器"));
for (const s of dimmedMisuse.slice(0, 20)) console.log("    " + s);

const fail = hard.length > 0 || (enforceAllow && outOfSet.length > 0);
console.log(fail ? "==> EXIT 1（门禁不通过）" : "==> EXIT 0（门禁通过）");
if (fail) process.exit(1);
