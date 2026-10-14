/**
 * 只读扫描 3：列出某个 DSH token 在**出厂 CSS 里的用法**（选择器 + 声明），
 * 用来给"这个 token 在该场景是否被官方这样用"提供先例证据。
 * 用法： node usage-of-token.ts <asar> <token> [maxHits]
 */
import { readFileSync } from "node:fs";

const asar = process.argv[2];
const token = process.argv[3];
const max = Number(process.argv[4] || 12);
const text = readFileSync(asar).toString("latin1");

const hits = [];
let from = 0;
for (;;) {
  const i = text.indexOf(token, from);
  if (i < 0) break;
  from = i + token.length;
  // 跳过定义处（`--token:`）
  const after = text.slice(i + token.length, i + token.length + 2);
  if (/^\s*:/.test(after)) continue;
  // 回退到声明起点（最近的 ';' '{' 或 '}'）
  let s = i;
  while (s > 0 && !";{}".includes(text[s - 1])) s--;
  let e = i;
  while (e < text.length && !";}".includes(text[e])) e++;
  const decl = text.slice(s, e + 1).replace(/\s+/g, " ").trim();
  // 再回退找选择器：最近一个 '{' 之前
  const open = text.lastIndexOf("{", s);
  let sel = "";
  if (open > 0) {
    const selStart = Math.max(text.lastIndexOf("}", open), text.lastIndexOf(";", open), text.lastIndexOf('"', open), text.lastIndexOf("`", open), 0);
    sel = text.slice(selStart + 1, open).replace(/\s+/g, " ").trim().slice(-260);
  }
  hits.push({ at: i, sel, decl: decl.slice(0, 220) });
}
// 去重
const seen = new Set();
const uniq = [];
for (const h of hits) {
  const k = h.sel + "||" + h.decl;
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(h);
}
console.log("# usage-of-token " + token + "  hits=" + hits.length + " unique=" + uniq.length);
for (const h of uniq.slice(0, max)) {
  console.log("--- @" + h.at + "\n  SEL : " + h.sel + "\n  DECL: " + h.decl);
}
