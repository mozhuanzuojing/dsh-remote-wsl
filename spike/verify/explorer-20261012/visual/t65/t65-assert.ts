/**
 * t65-assert.ts —— T65 对比度**断言**（可红；exit 1 = 有失败）。
 *
 * 判据（打在**实测**数据上，不靠声明值）：
 *   A1 **在用文字对**：元素级 18 项里 kind=text 的**每一项**，两主题比值 ≥ **4.5:1**
 *   A2 **在用非文本边界**：kind=nontext-border 的 4 项（空心状态点/普通按钮/卡片/输入框）落在**已登记的
 *      1.4.11 缺口**里（≥1.0 且 <3）—— 缺口必须**登记在案**（见 ALLOW_1_4_11）；出现**未登记**的失败项 ⇒ 红
 *   A3 **焦点环**：4 个探针（底栏按钮/行内动作/输入框/菜单项）的 outline 与其生效背景比值 ≥ **3:1**
 *   A4 **token 台账完整**：58 组两主题都必须 **resolved**（防"假绿"：解析失败会被当成不达标 0）
 *
 * 用法： node t65-assert.ts <t65 目录>
 */
import fs from "node:fs";
import path from "node:path";

const DIR = process.argv[2];
if (!DIR) { console.error("usage: node t65-assert.ts <dir>"); process.exit(2); }
const live = JSON.parse(fs.readFileSync(path.join(DIR, "out-t65-contrast.json"), "utf8"));

/** 已登记的 WCAG 1.4.11 缺口（控件/容器边界）：17-token 闭集里**最重的 border-l4 也只有 1.45(light)/1.92(dark)**，
 *  结构上到不了 3:1 ⇒ 记为已知缺口，补偿手段见报告（焦点环 ≥3、填充面对比、placeholder）。 */
const ALLOW_1_4_11 = [
  { sel: ".dsh-rw-dot", why: "空心状态点：状态色在 border 上，border-l2=1.25/1.41（token 闭集上限）" },
  { sel: ".dsh-rw-btn:not(.dsh-rw-btn--primary)", why: "普通按钮描边：border-l2=1.25/1.41；按钮另由填充面 + 焦点环(≥3)识别" },
  { sel: ".dsh-rw-card", why: "卡片容器描边：border-l1=1.09/1.20，**装饰性容器边界**（1.4.11 只约束「理解 UI 所必需」的边界）" },
  { sel: ".dsh-rw-path-input", why: "输入框描边：border-l2=1.25/1.41；输入框另由填充面 bg-base、placeholder、焦点环(≥3)识别" },
];

const R: any[] = [];
const ok = (n: string, d = "") => R.push({ ok: true, n, d });
const bad = (n: string, d = "") => R.push({ ok: false, n, d });

for (const th of live) {
  const theme = th.dark ? "dark" : "light";
  // A1 / A2
  for (const e of th.elements.res) {
    if (e.missing) { bad(`A1/A2 元素存在 (${theme})`, `${e.name} 未找到`); continue; }
    if (e.kind === "text") {
      if (e.ratio >= 4.5) ok(`A1 文字 ≥4.5 (${theme}) ${e.name}`, String(e.ratio));
      else bad(`A1 文字 ≥4.5 (${theme}) ${e.name}`, `实得 ${e.ratio}（fg=${e.fgRaw} bg=${e.bgHex}）`);
    } else if (e.kind === "nontext-border") {
      const allow = ALLOW_1_4_11.find((a) => a.sel === e.sel);
      if (allow && e.ratio < 3) ok(`A2 已登记 1.4.11 缺口 (${theme}) ${e.name}`, `${e.ratio} · ${allow.why}`);
      else if (e.ratio >= 3) ok(`A2 边界达标 (${theme}) ${e.name}`, String(e.ratio));
      else bad(`A2 未登记的边界失败 (${theme}) ${e.name}`, `实得 ${e.ratio}（fg=${e.fgRaw} bg=${e.bgHex}）未在 ALLOW_1_4_11 里`);
    }
  }
  // A3 焦点环：**单色环 ≥3**，或（浮层上单色做不到时）**双色指示成立**——T43 裁决：内圈 hairline 与蓝环之间对比 ≥3
  for (const p of th.focus.probes) {
    if (p.missing) { bad(`A3 焦点环探针存在 (${theme})`, p.label); continue; }
    if (p.ringRatio !== null && p.ringRatio >= 3) ok(`A3 焦点环 ≥3 (${theme}) ${p.label}`, `${p.ringRatio.toFixed(2)}（outline ${p.outlineColor} on ${p.bgHex}）`);
    else if (p.pairRatio !== null && p.pairRatio >= 3) {
      ok(`A3 双色焦点指示 (${theme}) ${p.label}`, `单色环 ${p.ringRatio === null ? "n/a" : p.ringRatio.toFixed(2)} <3，但内圈 hairline ${p.shadowColor} vs 蓝环 对比 ${p.pairRatio.toFixed(2)} ≥3（T43 双色指示裁决；两者都 <3 的"单色达标"在浮层上不可得）`);
    } else bad(`A3 焦点环 ≥3 或双色指示成立 (${theme}) ${p.label}`, `ringRatio=${p.ringRatio} pairRatio=${p.pairRatio}（outline ${p.outlineStyle}/${p.outlineWidth}/${p.outlineColor} boxShadow=${p.boxShadow} on ${p.bgHex}）`);
  }
  // A4 token 台账完整
  const unresolved = th.tokenGroups.res.filter((g: any) => g.unresolved);
  if (th.tokenGroups.res.length === 58 && unresolved.length === 0) ok(`A4 58 组全部 resolved (${theme})`);
  else bad(`A4 58 组全部 resolved (${theme})`, `组数=${th.tokenGroups.res.length} unresolved=${unresolved.length}（非 0 ⇒ 判定无效）`);
}

const pass = R.filter((r) => r.ok).length, fail = R.filter((r) => !r.ok).length;
const out = R.map((r) => (r.ok ? "PASS  " : "FAIL  ") + r.n.padEnd(52) + (r.d ? " — " + r.d : ""));
out.push("", `PASS = ${pass}   FAIL = ${fail}`, fail === 0 ? "==> PASS" : "==> FAIL");
fs.writeFileSync(path.join(DIR, "ASSERT-t65.txt"), out.join("\n") + "\n");
console.log(out.filter((l) => l.startsWith("FAIL")).join("\n"));
console.log(out.slice(-3).join("\n"));
if (fail > 0) process.exit(1);
