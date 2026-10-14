/**
 * 只读扫描 2b：从 app.asar 解析 DSH 主题。
 * - 静态调色板（--dsw-static-*）：全局收集（优先 #hex 压缩形态）。
 * - alias token：分别从 light 块（`body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00)`）
 *   与 dark 块（`body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)`）取。
 * 用法： node resolve-theme-tokens.ts <asar> <token...>
 */
import { readFileSync } from "node:fs";

const asar = process.argv[2];
const want = process.argv.slice(3);
const text = readFileSync(asar).toString("latin1");

function decls(css) {
  const m = new Map();
  for (const d of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/g)) m.set(d[1], d[2].trim());
  return m;
}
function blockStartingAt(needle) {
  const i = text.indexOf(needle);
  if (i < 0) return null;
  const j = text.indexOf("}", i);
  return { at: i, css: text.slice(i, j + 1) };
}
/** 反向找包含 index 的规则块 start（最近的 '{'），并给出选择器。 */
function ruleContaining(index) {
  const open = text.lastIndexOf("{", index);
  const prevClose = text.lastIndexOf("}", index);
  if (open < 0 || open < prevClose) return null;
  const selStart = Math.max(text.lastIndexOf("}", open), text.lastIndexOf(";", open), text.lastIndexOf('"', open), 0);
  const close = text.indexOf("}", open);
  return { selector: text.slice(selStart + 1, open).trim(), css: text.slice(open + 1, close) };
}

const LIGHT_NEEDLE = "body{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-00)";
const DARK_NEEDLE = "body[data-ds-dark-theme]{--dsw-alias-bg-base:var(--dsw-static-neutral-bluish-950)";
const lightBlk = blockStartingAt(LIGHT_NEEDLE);
const darkBlk = blockStartingAt(DARK_NEEDLE);

// 静态调色板：全局（压缩 #hex 优先）
const statics = new Map();
for (const d of text.matchAll(/(--dsw-static-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) statics.set(d[1], d[2]);
for (const d of text.matchAll(/(--dsw-static-[a-z0-9-]+)\s*:\s*(rgb\([^)]*\))/g)) if (!statics.has(d[1])) statics.set(d[1], d[2]);

const light = decls(lightBlk ? lightBlk.css : "");
const dark = decls(darkBlk ? darkBlk.css : "");
const all = decls(text);

function resolve(map, name, depth = 0) {
  if (depth > 12) return "<cycle>";
  const raw = map.get(name) ?? (statics.has(name) ? statics.get(name) : undefined);
  if (raw === undefined) return "<undefined>";
  const vm = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*(?:,([\s\S]*))?\)$/);
  if (vm) {
    const inner = resolve(map, vm[1], depth + 1);
    if (inner === "<undefined>" && vm[2]) return vm[2].trim();
    return inner;
  }
  return raw;
}

console.log("# resolve-theme-tokens.ts  asar=" + asar);
console.log("# light block found@" + (lightBlk ? lightBlk.at : "NONE") + " decls=" + light.size +
  " | dark block found@" + (darkBlk ? darkBlk.at : "NONE") + " decls=" + dark.size +
  " | static palette entries=" + statics.size);
const sc = text.indexOf("--dsw-static-neutral-bluish-00:#fff");
if (sc >= 0) {
  const r = ruleContaining(sc);
  console.log("# static palette rule selector = " + JSON.stringify(r ? r.selector.slice(-80) : null));
}
console.log("");
console.log("TOKEN".padEnd(44) + "LIGHT".padEnd(38) + "DARK");
for (const t of want) {
  console.log(t.padEnd(44) + String(resolve(light, t)).padEnd(38) + resolve(dark, t));
}
