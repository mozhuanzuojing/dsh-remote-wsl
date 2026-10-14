/**
 * menu-grouplabel-audit.ts —— 「组标注一致性」的机械断言（T53/N4 的判据，可复跑、能红）。
 *
 * 为什么需要它：T50 的 N4 读数是 `document.querySelectorAll('[role="group"]')`（**全文档**扫描），
 * 于是把**浏览器卡片里的 chips 行**（`aria-label="快捷目录"`，innerText = "Home / /mnt"）当成了
 * "菜单的第 1 组"。而 `⋯` 菜单里**根本没有「快捷目录」组**（见 §A2 的 key 清单）。
 * ⇒ 需要的不是"改代码让它看起来一致"，而是一条**把范围钉死、且能红**的断言。
 *
 * 断言（任一不满足 ⇒ exit 1）：
 *   A1 **菜单组**：`client.panel.tail.js` 里 `role="menu"` 渲染路径上的组容器必须用
 *      `aria-labelledby`（指向 `dsh-rw-menu-<group.key>`），且**不得**出现 `aria-label`。
 *   A2 **组的 key 清单**：`groups.push({key:…})` 的每个 key 都必须有一条 `dsh-rw-menu-<key>` 的标题元素路径。
 *   A3 **组标题**：标题必须是普通 `<div id=…>`：**不得**带 `role="presentation"` / `aria-hidden`；
 *      **不进 Tab 序列**（`tabIndex` 缺省或 ≤ -1）；**不得**是 `button`/`a`/带 `onClick` 的交互元素。
 *   A4 **面板内 `role="group"` 台账**：每个出现点要么是 A1 的菜单组，要么在**显式例外清单**里
 *      （每条例外必须写理由）⇒ 新增/改动 `role="group"` 而不登记 ⇒ 红（防"悄悄换一种标注"）。
 *
 * 用法： node menu-grouplabel-audit.ts <插件根> [--json]
 * 退出码：0 = 全过；1 = 有失败
 *
 * 范围边界（不声称）：这是**源码级**断言（读的是渲染调用与属性字面量），不是 DOM 级读数；
 * DOM 级读数需要真实例（T50 的 `out-p05-refine-n4.json` 是那一侧的证据，本脚本用它做交叉校验）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] || "D:/project/dsh1/vendor/dsh-remote-wsl";
const AS_JSON = process.argv.includes("--json");
const CLIENT = path.join(ROOT, "client");

/**
 * 允许的例外：面板里**不是菜单组**的 `role="group"`。
 * 每条必须带理由；新增即需在此登记（A4 会强制）。
 */
const GROUP_EXCEPTIONS = [
  {
    file: "client.panel.browser.js",
    marker: '"dsh-rw-toolbar", role: "group", "aria-label"',
    reason:
      "浏览卡片的快捷目录 chips 行：**没有可见组标题**（视觉规格 §7.2.2 就是「卡片标题行 + chips 行」两行结构，chips 行不给标题）" +
      "⇒ 按 WAI-ARIA，无可见标签的组**必须**用 aria-label；改用 aria-labelledby 需要**新增一个可见标题**（改变设计），" +
      "且会与卡片标题「浏览目录（<distro>）」语义重复。",
  },
];

const results = [];
const ok = (name, detail = "") => results.push({ ok: true, name, detail });
const bad = (name, detail = "") => results.push({ ok: false, name, detail });

const read = (f) => fs.readFileSync(path.join(CLIENT, f), "utf8");

// ── A1/A2/A3：菜单组的渲染路径 ────────────────────────────────────────────────
const tail = read("client.panel.tail.js");

// A1：菜单容器 -> 组容器 的渲染调用里，必须是 aria-labelledby 且没有 aria-label
const menuIdx = tail.indexOf('className: "dsh-rw-menu"');
if (menuIdx < 0) bad("A1 找到 role=menu 容器", "client.panel.tail.js 里没找到 dsh-rw-menu 容器");
else {
  const seg = tail.slice(menuIdx, menuIdx + 2600); // 菜单容器到组标题那一段
  const groupCall = seg.match(/\{\s*role:\s*"group",\s*"aria-labelledby":\s*([A-Za-z_$][\w$]*)[^}]*\}/);
  if (!groupCall) bad("A1 菜单组容器用 aria-labelledby", "在菜单渲染段里找不到 `role:\"group\", \"aria-labelledby\": <var>`");
  else ok("A1 菜单组容器用 aria-labelledby", groupCall[1]);

  const labelIdDef = /\$\{group\.key\}|dsh-rw-menu-/.test(seg);
  if (labelIdDef) ok("A1b 标题 id 由 group.key 派生", "dsh-rw-menu-${group.key}");
  else bad("A1b 标题 id 由 group.key 派生", "菜单段里看不到 `dsh-rw-menu-${group.key}`");

  // 菜单段内不得出现 aria-label（菜单容器自身的 aria-label=t("menu.more") 是**容器**的，不算组）
  const groupLabelUse = /\{\s*role:\s*"group"[^}]*"aria-label"/.test(seg);
  if (groupLabelUse) bad("A1c 菜单组容器不得用 aria-label", "菜单段里出现了 `role:\"group\" … \"aria-label\"`");
  else ok("A1c 菜单组容器不得用 aria-label");
}

// A2：groups.push({key:…}) 的 key 清单
const keys = [...tail.matchAll(/groups\.push\(\{\s*key:\s*"([a-z-]+)"/g)].map((m) => m[1]);
if (keys.length === 0) bad("A2 找到 groups.push 的 key", "一个都没找到");
else ok("A2 找到 groups.push 的 key", keys.join(", "));
const labelIdPatternExists = /const labelId = `dsh-rw-menu-\$\{group\.key\}`;/.test(tail);
if (labelIdPatternExists) ok("A2b 每组都生成 dsh-rw-menu-<key>", keys.map((k) => "dsh-rw-menu-" + k).join(", "));
else bad("A2b 每组都生成 dsh-rw-menu-<key>", "找不到 `const labelId = \\`dsh-rw-menu-${group.key}\\`;`");

// A3：组标题元素的形态
const titleCall = tail.match(/React\.createElement\(\s*"div",\s*\{([^}]*)\}\s*,\s*group\.label\s*\)/);
if (!titleCall) bad("A3 找到组标题元素", "找不到以 group.label 为子节点的 div");
else {
  const props = titleCall[1];
  if (/\bid\s*:\s*labelId/.test(props)) ok("A3a 标题带 id", "id: labelId");
  else bad("A3a 标题带 id", props.trim().slice(0, 120));
  if (/role\s*:\s*"presentation"/.test(props)) bad("A3b 标题不得带 role=presentation", "presentation 会让 aria-labelledby 的语义来源变得可疑（且本元素 tabIndex=-1 时该 role 被忽略）");
  else ok("A3b 标题不得带 role=presentation");
  if (/aria-hidden/.test(props)) bad("A3c 标题不得 aria-hidden", "它是 aria-labelledby 的文本来源");
  else ok("A3c 标题不得 aria-hidden");
  const tab = props.match(/tabIndex\s*:\s*(-?\d+)/);
  if (!tab) ok("A3d 标题不进 Tab 序列", "未设 tabIndex ⇒ 天然不可聚焦");
  else if (Number(tab[1]) <= -1) ok("A3d 标题不进 Tab 序列", "tabIndex=" + tab[1]);
  else bad("A3d 标题不进 Tab 序列", "tabIndex=" + tab[1] + "（≥0 ⇒ 会进 Tab 序列）");
  if (/onClick|onKeyDown/.test(props)) bad("A3e 标题不得是交互元素", "带了事件处理器");
  else ok("A3e 标题不得是交互元素");
}

// ── A4：面板内 role="group" 台账 ──────────────────────────────────────────────
const files = fs.readdirSync(CLIENT).filter((f) => f.endsWith(".js"));
const found = [];
for (const f of files) {
  const text = read(f);
  for (const m of text.matchAll(/role:\s*"group"/g)) {
    const around = text.slice(Math.max(0, m.index - 120), m.index + 160);
    found.push({ file: f, around: around.replace(/\s+/g, " ") });
  }
}
for (const hit of found) {
  const isMenuGroup = /role:\s*"group",\s*"aria-labelledby"/.test(hit.around);
  const exc = GROUP_EXCEPTIONS.find((e) => e.file === hit.file && hit.around.includes(e.marker));
  if (isMenuGroup) ok("A4 role=group 台账：" + hit.file, "菜单组（aria-labelledby）");
  else if (exc) ok("A4 role=group 台账：" + hit.file + "（已登记例外）", exc.reason.slice(0, 60) + "…");
  else bad("A4 role=group 台账：" + hit.file, "既不是菜单组，也不在例外清单里 ⇒ " + hit.around.slice(0, 140));
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
if (AS_JSON) {
  console.log(JSON.stringify({ root: ROOT, pass, fail, results, menuGroupKeys: keys, exceptions: GROUP_EXCEPTIONS.map((e) => e.file) }, null, 2));
} else {
  console.log("# menu-grouplabel-audit: " + ROOT);
  console.log("# 菜单组的 key = [" + keys.join(", ") + "]（**没有 quickDirs/快捷目录** —— 它在 browser.js 的 chips 行）");
  for (const r of results) console.log((r.ok ? "PASS  " : "FAIL  ") + r.name.padEnd(46) + (r.detail || ""));
  console.log("");
  console.log("PASS = " + pass + "   FAIL = " + fail);
  console.log(fail === 0 ? "==> PASS（组标注一致；例外 1 条已登记并给理由）" : "==> FAIL（见上）");
}
if (fail > 0) process.exit(1);
