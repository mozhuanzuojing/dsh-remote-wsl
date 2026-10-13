/**
 * 只读扫描 4：从 app.asar 里的 **token 注册表**（每条形如
 *   { name: "--dsw-alias-…", description: "…", valueType: "CSS color", requiresLightAndDark: true, cssVariable: "…" }）
 * 抠出官方描述——用来给"这个 token 官方是干什么用的"提供权威依据（比我口头解释可靠）。
 * 用法： node token-descriptors.mjs <asar> [nameFilterRegex]
 */
import { readFileSync } from "node:fs";

const asar = process.argv[2];
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
const text = readFileSync(asar).toString("latin1");

const re = /name:\s*"(--dsw-[a-z0-9-]+)"\s*,\s*description:\s*"([^"]*)"\s*,\s*valueType:\s*"([^"]*)"\s*,\s*requiresLightAndDark:\s*(true|false)/g;
const rows = new Map();
for (const m of text.matchAll(re)) rows.set(m[1], { desc: m[2], type: m[3], ld: m[4] });
// 宽松第二遍：字段顺序不同也抓（只取 name…description 相邻对）
const loose = /name:\s*"(--dsw-[a-z0-9-]+)"[^{}]{0,120}?description:\s*"([^"]*)"/g;
for (const m of text.matchAll(loose)) if (!rows.has(m[1])) rows.set(m[1], { desc: m[2], type: "?", ld: "?" });

console.log("# token registry entries found = " + rows.size);
const keys = [...rows.keys()].filter((k) => !filter || filter.test(k)).sort();
for (const k of keys) {
  const r = rows.get(k);
  console.log(k.padEnd(48) + " light+dark=" + (r.ld === "true" ? "YES" : "no ") + "  " + r.desc);
}
