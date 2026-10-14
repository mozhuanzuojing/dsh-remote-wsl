/**
 * check-n4-menugroups.ts —— T53：`⋯` 菜单组标注一致性断言（副本制、可复跑）。
 *
 * 为什么这么写：T50 独立复验判「N4 第 1 组用 aria-label」**是量具伪红** ——
 * 它的枚举把**整个面板**里的 `[role=group]` 一起算，于是把目录卡的 **chips 工具条**
 * （`client/client.panel.browser.js`：`{className:"dsh-rw-toolbar", role:"group", "aria-label": t("browser.chipsAria")}`，
 * 文本 `Home / /mnt`）当成了"菜单第 1 组"。本断言**只认菜单作用域** `.dsh-rw-menu .dsh-rw-group`，
 * 并把作用域外的 `role=group` 单独列出（豁免 + 判据），因此不会重演那类伪红。
 *
 * 用法：node check-n4-menugroups.ts <readings.json>     （Node 26 直跑，无构建）
 * exit：0 = 全过；1 = 有断言不过；2 = 用法/读取错误
 */
import fs from "node:fs";

type MenuGroup = {
	role: string | null;
	ariaLabelledby: string | null;
	ariaLabel: string | null;
	labelTargetExists: boolean | null;
	labelTargetText: string | null;
	labelTargetRole: string | null;
	labelTargetTabIndexProp: number | null;
	labelTargetVisible: boolean | null;
	groupText: string;
};
type OtherGroup = { cls: string; role: string | null; ariaLabel: string | null; ariaLabelledby: string | null; text: string };
type Readings = {
	innerWidth: number;
	readings: {
		width: number;
		entered: { cwdText: string | null; clicked: boolean };
		menuGroupCount: number;
		scopedMenuGroups: MenuGroup[];
		titleFocus: { id: string; tookFocus: boolean; tabIndexProp: number }[];
		otherRoleGroups: OtherGroup[];
		geom: { menuOverlapsStatusWord: boolean | null; menuOverlapsFooter: boolean | null; footer: { h: number } | null };
	};
};

const file = process.argv[2];
if (!file) {
	console.error("用法：node check-n4-menugroups.ts <readings.json>");
	process.exit(2);
}
let data: Readings;
try {
	data = JSON.parse(fs.readFileSync(file, "utf8")) as Readings;
} catch (e) {
	console.error(`读不到/解析不了读数文件：${file}\n${(e as Error).message}`);
	process.exit(2);
}

const R = data.readings;
const results: { ok: boolean; name: string; detail: string }[] = [];
const ok = (name: string, detail = "") => results.push({ ok: true, name, detail });
const bad = (name: string, detail = "") => results.push({ ok: false, name, detail });

// A1 菜单组数量（窄态进入子目录后应为 3：工作区/守护/诊断；宽态 2：守护/诊断）
if (R.menuGroupCount >= 2) ok("A1 菜单组数量 ≥2", `menuGroupCount=${R.menuGroupCount}（width=${R.width}，entered=${R.entered.clicked}）`);
else bad("A1 菜单组数量 ≥2", `实得 ${R.menuGroupCount}`);

// A2 每一组：role=group + aria-labelledby 指向**存在且可见**的标题 + **不再有** aria-label
const offenders: string[] = [];
for (const [i, g] of R.scopedMenuGroups.entries()) {
	const problems: string[] = [];
	if (g.role !== "group") problems.push(`role=${g.role}`);
	if (g.ariaLabel !== null) problems.push(`ariaLabel=${JSON.stringify(g.ariaLabel)}（菜单组不该有）`);
	if (!g.ariaLabelledby) problems.push("ariaLabelledby 空");
	if (g.labelTargetExists !== true) problems.push("aria-labelledby 指向的 id 不存在");
	if (g.labelTargetVisible !== true) problems.push("组标题不可见");
	if (!g.labelTargetText) problems.push("组标题无文本");
	if (problems.length) offenders.push(`#${i + 1}(${g.ariaLabelledby ?? "?"}): ${problems.join("; ")}`);
}
if (offenders.length === 0) ok("A2 每组都是 aria-labelledby + 可见标题，且无 aria-label", `${R.scopedMenuGroups.length} 组全过`);
else bad("A2 每组都是 aria-labelledby + 可见标题，且无 aria-label", offenders.join(" | "));

// A2b 组标题**不得**带 role="presentation"（T53/visual-designer 的修复点：带 tabindex 时该 role 被规范忽略，
// 是一条误导性 no-op；视觉规格 §7.2.4 也要求"普通 <div id>"）。DOM 侧：getAttribute('role') 应为 null。
const roleOffenders = R.scopedMenuGroups
	.map((g, i) => ({ i, role: g.labelTargetRole, id: g.ariaLabelledby }))
	.filter((x) => x.role !== null && x.role !== undefined);
if (roleOffenders.length === 0) ok("A2b 组标题不带 role=presentation", `三组标题 getAttribute('role') 均为 null`);
else bad("A2b 组标题不带 role=presentation", roleOffenders.map((x) => `#${x.i + 1}(${x.id}) role=${x.role}`).join(", "));

// A3 一致性：所有菜单组的标注签名只有一种
const sig = (g: MenuGroup) => [g.role, g.ariaLabel === null ? "noLabel" : "hasLabel", g.ariaLabelledby ? "labelledby" : "noLabelledby", g.labelTargetExists ? "targetOk" : "targetMissing", g.labelTargetVisible ? "targetVisible" : "targetHidden"].join("/");
const sigs = [...new Set(R.scopedMenuGroups.map(sig))];
if (sigs.length === 1) ok("A3 三组标注签名一致", sigs[0]);
else bad("A3 三组标注签名一致", `出现 ${sigs.length} 种：${sigs.join("  ||  ")}`);

// A4 组标题不可聚焦（不进 Tab 序列）
const focusable = R.titleFocus.filter((t) => t.tookFocus || t.tabIndexProp !== -1);
if (focusable.length === 0) ok("A4 组标题不可聚焦", `tabIndex 全为 -1 且 focus() 均未取得焦点（${R.titleFocus.length} 个）`);
else bad("A4 组标题不可聚焦", focusable.map((t) => `${t.id}(tabIndex=${t.tabIndexProp},tookFocus=${t.tookFocus})`).join(", "));

// A5 伪红护栏：作用域外的 role=group（chips 工具条）**不算菜单组**，且必须能被作用域区分开
const confused = R.otherRoleGroups.filter((g) => /dsh-rw-group/.test(g.cls));
if (confused.length === 0) {
	ok("A5 作用域外 role=group 可区分（豁免有判据）", R.otherRoleGroups.map((g) => `${g.cls}[role=${g.role},aria-label=${JSON.stringify(g.ariaLabel)},text="${g.text}"] → 非菜单组，不计入 A2/A3`).join(" ; ") || "（无）");
} else bad("A5 作用域外 role=group 可区分", `有组同时带 dsh-rw-group 类 ⇒ 作用域无法区分：${confused.map((g) => g.cls).join(", ")}`);

// A6 菜单不遮底栏状态词 / 底栏高度仍是 47
if (R.geom.menuOverlapsStatusWord === false && R.geom.menuOverlapsFooter === false) ok("A6 菜单不遮底栏状态词/底栏", `overlapsStatusWord=${R.geom.menuOverlapsStatusWord} overlapsFooter=${R.geom.menuOverlapsFooter} footerH=${R.geom.footer?.h}`);
else bad("A6 菜单不遮底栏状态词/底栏", JSON.stringify(R.geom));
if (R.geom.footer?.h === 47) ok("A6b footerH=47（T42/R1 未回退）");
else bad("A6b footerH=47（T42/R1 未回退）", `实得 ${R.geom.footer?.h}`);

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  —— " + r.detail : ""}`);
const fails = results.filter((r) => !r.ok);
console.log(`\ncheck-n4-menugroups: ${results.length - fails.length}/${results.length} PASS  （读数 ${file}）`);
process.exit(fails.length ? 1 : 0);
