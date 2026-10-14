/**
 * t65-diff.ts —— 静态值（T28/T43：`contrast-check.ts` 解析 app.asar）vs **实测值**（T65：真实例 getComputedStyle）。
 *
 * 用法： node t65-diff.ts <t65 目录>
 * 产出： out-t65-diff.json + out-t65-diff.txt（markdown 表，含 |Δ|>0.01 的漂移标记）
 */
import fs from "node:fs";
import path from "node:path";

const DIR = process.argv[2];
if (!DIR) { console.error("usage: node t65-diff.ts <dir>"); process.exit(2); }

const staticTxt = fs.readFileSync(path.join(DIR, "out-t65-static-contrast.txt"), "utf8");
const live = JSON.parse(fs.readFileSync(path.join(DIR, "out-t65-contrast.json"), "utf8"));

/** 静态输出： "===== LIGHT =====" 分节；每行 id … --tok=val … --tok=val … 比值 verdict */
const parseStatic = (txt0: string) => {
  // ⚠️ 必须先归一化行尾：PowerShell 写出来的是 CRLF，而 JS 正则的 `.` **不匹配 `\r`** ⇒
  //    `…PASS  # note$` 永远匹配不上（T65 自查踩到：116 行全判"缺值"）
  const txt = txt0.replace(/\r\n?/g, "\n");
  const out: any = { light: {}, dark: {} };
  let theme = "";
  for (const line of txt.split("\n")) {
    if (/^===== LIGHT/.test(line)) { theme = "light"; continue; }
    if (/^===== DARK/.test(line)) { theme = "dark"; continue; }
    if (!theme) continue;
    // 定宽列**不能**用固定偏移：id 超过 26 码元时 padEnd 不截断 ⇒ 整行右移。
    // 稳妥切法：判定在**行尾**（`ratio.padEnd(8) + verdict + "  # note"`），比值紧挨判定之前 ⇒ 从行尾往前取。
    const vmatch = line.match(/(PASS|FAIL\(<\d+\))\s*(?:#.*)?$/);
    if (!vmatch || vmatch.index === undefined) continue;
    const ratioM = line.slice(0, vmatch.index).match(/(\d+\.\d{2})\s*$/);
    const idM = line.match(/^(.*?)--dsw-/);
    if (!ratioM || !idM) continue;
    const id = idM[1].trim();
    if (!id) continue;
    out[theme][id] = { ratio: parseFloat(ratioM[1]), verdict: vmatch[1], fgRaw: null, bgRaw: null };
  }
  return out;
};
const st = parseStatic(staticTxt);

const rows: any[] = [];
for (const th of live) {
  const theme = th.dark ? "dark" : "light";
  for (const g of th.tokenGroups.res) {
    const s = st[theme][g.id];
    rows.push({
      theme, id: g.id, kind: g.kind,
      staticRatio: s ? s.ratio : null, liveRatio: g.unresolved ? null : g.ratio,
      delta: s && !g.unresolved ? Math.round((g.ratio - s.ratio) * 100) / 100 : null,
      staticVerdict: s ? s.verdict : null,
      liveFg: g.fgRaw ?? null, liveBg: g.bgRaw ?? null,
      staticFg: s ? s.fgRaw : null, staticBg: s ? s.bgRaw : null,
      need: g.kind === "text" ? 4.5 : 3,
    });
  }
}
const drift = rows.filter((r) => r.delta !== null && Math.abs(r.delta) > 0.01);
const verdictFlip = rows.filter((r) => r.staticVerdict && r.liveRatio !== null && (r.staticVerdict === "PASS") !== (r.liveRatio >= r.need));
const missing = rows.filter((r) => r.liveRatio === null || r.staticRatio === null);

fs.writeFileSync(path.join(DIR, "out-t65-diff.json"), JSON.stringify({ rows, drift, verdictFlip, missing }, null, 2));

const md: string[] = [];
md.push("| 主题 | 组 | kind | 静态比值 | 实测比值 | Δ | 静态判定 | 实测判定 |");
md.push("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const liveVerdict = r.liveRatio === null ? "UNRESOLVED" : r.liveRatio >= r.need ? "PASS" : `FAIL(<${r.need})`;
  md.push(`| ${r.theme} | ${r.id} | ${r.kind} | ${r.staticRatio ?? "—"} | ${r.liveRatio ?? "—"} | ${r.delta ?? "—"} | ${r.staticVerdict ?? "—"} | ${liveVerdict} |`);
}
fs.writeFileSync(path.join(DIR, "out-t65-diff.txt"), md.join("\n") + "\n");
console.log(`行数=${rows.length}  漂移(|Δ|>0.01)=${drift.length}  判定翻转=${verdictFlip.length}  缺值=${missing.length}`);
for (const d of drift) console.log(`   DRIFT ${d.theme}/${d.id} 静态=${d.staticRatio} 实测=${d.liveRatio} Δ=${d.delta}`);
for (const v of verdictFlip) console.log(`   FLIP  ${v.theme}/${v.id} 静态=${v.staticVerdict} 实测=${v.liveRatio} need=${v.need}`);
for (const m of missing) console.log(`   MISS  ${m.theme}/${m.id} 静态=${m.staticRatio} 实测=${m.liveRatio}`);
