/**
 * 只读扫描：从 DSH 安装目录的 app.asar 里取出**主题 token 的定义**（名称 + light/dark 取值）。
 * 用法： node scan-asar.mjs < путь-к-asar > [tokenPrefix]
 * 不做任何写入、不装包、不改 asar。
 */
import { readFileSync } from "node:fs";

const asar = process.argv[2];
const prefix = process.argv[3] || "--dsw-";
const buf = readFileSync(asar);
const text = buf.toString("latin1"); // 按字节处理，ASCII 安全

const names = new Map();
for (const m of text.matchAll(/--dsw-[a-z0-9-]+/g)) {
  names.set(m[0], (names.get(m[0]) || 0) + 1);
}
console.log("== unique token names: " + names.size + " ==");
for (const [k, v] of [...names.entries()].sort()) console.log(v + "\t" + k);

console.log("\n== definition contexts (raw, 260B window) ==");
const seen = new Set();
for (const m of text.matchAll(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[a-z0-9-]*\\s*:", "g"))) {
  const s = Math.max(0, m.index - 120);
  const e = Math.min(text.length, m.index + 260);
  const chunk = text.slice(s, e).replace(/[^\x20-\x7e]/g, ".");
  const name = m[0];
  const key = name + "|" + chunk.slice(0, 60);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log("--- @" + m.index + " " + name + "\n" + chunk + "\n");
}
