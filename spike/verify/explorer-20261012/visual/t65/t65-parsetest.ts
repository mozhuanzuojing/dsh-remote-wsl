import fs from "node:fs";
const txt = fs.readFileSync(process.argv[2], "utf8");
const lines = txt.split("\n");
console.log("总行数=" + lines.length);
console.log("第4行 repr=" + JSON.stringify(lines[3]));
console.log("第8行 repr=" + JSON.stringify(lines[7]));
let theme = ""; let hit = 0;
for (const line of lines) {
  if (/^===== LIGHT/.test(line)) { theme = "light"; console.log("进入 LIGHT 节"); continue; }
  if (/^===== DARK/.test(line)) { theme = "dark"; console.log("进入 DARK 节"); continue; }
  if (!theme || !line.trim()) continue;
  const tail = line.match(/([\d.]+)\s+(PASS|FAIL[^\s]*)\s*(?:#.*)?$/);
  const head = line.match(/^([^-]*?)\s+--/);
  if (hit < 3) console.log(`  theme=${theme} tail=${tail ? tail[1] + "/" + tail[2] : "NULL"} head=${head ? JSON.stringify(head[1]) : "NULL"}`);
  if (tail && head) hit++;
}
console.log("解析命中=" + hit);
