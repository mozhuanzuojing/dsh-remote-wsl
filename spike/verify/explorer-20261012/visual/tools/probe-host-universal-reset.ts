/** 取 app.asar 里"纯通配 box-sizing"命中的**前文**，判断它是不是全局重置（还是组件内后代选择器）。 */
import { readFileSync } from "node:fs";
const t = readFileSync(process.argv[2]).toString("latin1");
const re = /([^{};\`"]{0,110})\{[^{}]{0,140}box-sizing\s*:\s*border-box/g;
let i = 0;
for (const m of t.matchAll(re)) {
  const sel = m[1].trim();
  const parts = sel.split(",").map((x) => x.trim());
  if (!parts.every((p) => /^\*$|^\*::?(before|after)$/.test(p))) continue;
  const at = m.index;
  console.log("--- #" + ++i + " @" + at);
  console.log("  SEL(截断后) : " + JSON.stringify(sel));
  console.log("  前文 120B   : " + JSON.stringify(t.slice(Math.max(0, at - 120), at).replace(/\s+/g, " ")));
}
