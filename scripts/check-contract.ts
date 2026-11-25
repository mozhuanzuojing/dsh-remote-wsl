/**
 * check-contract.ts —— 本仓**可跑、随包维护**的契约门禁（零依赖，Node 26 原生跑 .ts）。
 *
 * 为什么需要它：`spike/` 里的历史门禁（arch-t2/arch-t4/count-i18n-keys）按旧的多 chunk 布局写死
 * `client/client.api.js` 与 `vendor/dsh-remote-wsl`，本仓早已迁到 `src/client/*.ts` + 单文件
 * `lib/client.js`，`spike/` 又整体不入库 ⇒ 那三道门禁在本仓**直接 ABORT**（静默失效的护栏）。
 * 本脚本只读当前布局，覆盖它们真正想守的东西：
 *
 *   1. 方法表三面一致：`src/explorer.ts` 的 `EXPLORER_METHODS`（权威）
 *      ≡ `src/client/client.api.ts` 的 `METHODS` 投影（数量/顺序/前缀/无重复）；
 *   2. **bundle 同步**：每个方法名都出现在 `lib/client.js`（漏 `npm run build` ⇒ 面板跑的是旧方法表）；
 *   3. **i18n 契约**：`ZH`/`EN` 键集合逐键相等、块内无重复键、全文件同名字面量恰出现 2 次（中英各一）；
 *   4. **静态 key 可达**：`src/client/**` 里字面量 `t("...")` 用到的键必须在字典里（拼错键不会静默退化成键名）。
 *
 * 用法：node --experimental-strip-types scripts/check-contract.ts [--root <插件根>] [--quiet]
 * 退出码：0 全过；1 有断言失败；2 结构解析失败/环境不对（例如 lib/client.js 缺失）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argvRootIdx = process.argv.indexOf("--root");
const rootArg = argvRootIdx >= 0 && process.argv[argvRootIdx + 1] && !process.argv[argvRootIdx + 1].startsWith("--") ? process.argv[argvRootIdx + 1] : null;
const ROOT = rootArg ? resolve(rootArg) : dirname(dirname(fileURLToPath(import.meta.url)));
const QUIET = process.argv.includes("--quiet");
const fails = [];
const passes = [];
const must = (cond, label, detail) => {
  if (cond) passes.push(`PASS ${label}`);
  else fails.push(`FAIL ${label}${detail ? `  — ${detail}` : ""}`);
};

// ── 权威 A：host EXPLORER_METHODS ────────────────────────────────────────────
const explorerSrc = readFileSync(join(ROOT, "src/explorer.ts"), "utf8");
const aBlock = /export const EXPLORER_METHODS = \[([\s\S]*?)\]/.exec(explorerSrc);
if (!aBlock) {
  console.error("ABORT: 解析不到 src/explorer.ts 的 EXPLORER_METHODS（结构变了）");
  process.exit(2);
}
const HOST = [...aBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

// ── 投影 B：client METHODS（直接 import 投影源，避免再手抄一份正则）──────────
// 必须按 ROOT 定位：否则 `--root` 指向副本时仍读本仓的投影，负例实验会假绿。
const { EXPLORER_METHODS: CLIENT_MAP } = await import(pathToFileURL(join(ROOT, "src/client/client.api.ts")).href);
const CLIENT = Object.values(CLIENT_MAP);

must(HOST.length > 0, "host 方法表非空");
must(
  CLIENT.length === HOST.length && HOST.every((m, i) => m === CLIENT[i]),
  "client METHODS ≡ host EXPLORER_METHODS（数量 + 顺序逐项相等）",
  `host=${HOST.length} client=${CLIENT.length}`,
);
must(CLIENT.every((m) => m.startsWith("explorer.")), "client 方法名都以 explorer. 前缀");
must(new Set(HOST).size === HOST.length, "host 方法表无重复项");
must(new Set(CLIENT).size === CLIENT.length, "client 方法表无重复项");

// ── bundle 同步：lib/client.js 里必须能找到每个方法名 ────────────────────────
const bundlePath = join(ROOT, "lib/client.js");
if (!existsSync(bundlePath)) {
  console.error("ABORT: 缺少 lib/client.js（先 node build.ts）");
  process.exit(2);
}
const bundle = readFileSync(bundlePath, "utf8");
// 必须带引号边界：方法名是前缀关系（`explorer.diagnose` 是 `explorer.diagnoseX` 的子串），
// 直接 includes 会在"改坏了名字"时假绿。
const quoted = (m) => new RegExp(`["']${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
const missingInBundle = HOST.filter((m) => !quoted(m).test(bundle));
must(
  missingInBundle.length === 0,
  "lib/client.js 与 host 方法表同版本（每个方法名都在 bundle 内）",
  `bundle 里缺失：${missingInBundle.join(", ") || "—"}；若刚改过方法表，请 node build.ts`,
);

// ── i18n 契约 ────────────────────────────────────────────────────────────────
const i18nPath = join(ROOT, "src/client/client.i18n.ts");
const i18nSrc = readFileSync(i18nPath, "utf8");
const blockOf = (name) => {
  const start = i18nSrc.indexOf(`const ${name} = {`);
  if (start < 0) return null;
  const end = i18nSrc.indexOf("\n\t\t};", start);
  if (end < 0) return null;
  return i18nSrc.slice(start, end);
};
const zhBlock = blockOf("ZH");
const enBlock = blockOf("EN");
if (zhBlock === null || enBlock === null) {
  console.error("ABORT: 解析不到 client.i18n.ts 的 const ZH/EN 块（结构变了）");
  process.exit(2);
}
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
/** 块内的 `"key":` 字面量 —— 注意：扁平行会一行放多个键（kpi.* / status.* 就是这么排的），不能用"行首锚点"。 */
const keysIn = (text) => {
  const keys = [];
  const counter = new Map();
  for (const m of stripComments(text).matchAll(/"([A-Za-z0-9_.-]+)"\s*:/g)) {
    keys.push(m[1]);
    counter.set(m[1], (counter.get(m[1]) || 0) + 1);
  }
  return { keys, counter };
};
const Z = keysIn(zhBlock);
const E = keysIn(enBlock);
const onlyZh = Z.keys.filter((k) => !E.keys.includes(k));
const onlyEn = E.keys.filter((k) => !Z.keys.includes(k));
must(onlyZh.length === 0 && onlyEn.length === 0, "i18n 中英键集合逐键相等", `仅中文：${onlyZh.join(", ") || "—"}；仅英文：${onlyEn.join(", ") || "—"}`);
const dupInBlock = [...Z.counter].filter(([, n]) => n > 1).map(([k]) => k).concat([...E.counter].filter(([, n]) => n > 1).map(([k]) => k));
must(dupInBlock.length === 0, "i18n 每个语言块内无重复键", dupInBlock.join(", ") || "—");
const globalCount = new Map();
for (const k of [...Z.keys, ...E.keys]) globalCount.set(k, (globalCount.get(k) || 0) + 1);
const notPaired = [...globalCount].filter(([, n]) => n !== 2).map(([k, n]) => `${k}×${n}`);
must(notPaired.length === 0, "i18n 每个键全文件恰出现 2 次（中英各一）", notPaired.join(", ") || "—");

// ── 静态 key 可达：t("...") 的键必须在字典里 ────────────────────────────────
const walkTs = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
};
const clientFiles = walkTs(join(ROOT, "src/client"));
const known = new Set([...Z.keys, ...E.keys]);
const unknownKeys = new Map();
for (const file of clientFiles) {
  const code = readFileSync(file, "utf8");
  for (const m of code.matchAll(/\bt\(\s*"([^"]+)"\s*[,)]/g)) {
    const key = m[1];
    if (!key.includes(".")) continue; // 只查带命名空间的键
    if (!known.has(key)) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      unknownKeys.set(`${rel}:${key}`, true);
    }
  }
}
must(unknownKeys.size === 0, "client 里字面量 t(\"…\") 用到的键都在 i18n 字典里", [...unknownKeys.keys()].join(", ") || "—");

// ── 分发形态契约（2026-11-24）：main / exports 必须指向**存在的构建产物**，不许再指 .ts ──
// 为什么：Node 拒绝 `node_modules` 里的 `.ts`（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
// 入口指回 `src/*.ts` 会让 npm 安装形态当场加载失败；而本仓所有测试都 import `../src/*.ts`，
// **永远不会**发现这件事 —— 只有这条断言会把"改回 TS 入口"拦在提交前。
const pkgJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const entryTargets = [["main", pkgJson.main], ...Object.entries(pkgJson.exports ?? {})];
const badEntries = [];
for (const [key, value] of entryTargets) {
  if (typeof value !== "string") {
    badEntries.push(`${key} → 非字符串入口（不支持的条件导出）`);
    continue;
  }
  if (!value.startsWith("./")) {
    badEntries.push(`${key} → ${value}（必须是包内相对路径）`);
    continue;
  }
  if (value.endsWith(".ts")) badEntries.push(`${key} → ${value}（node_modules 里的 .ts 加载不了）`);
  if (!existsSync(join(ROOT, value))) badEntries.push(`${key} → ${value}（文件不存在，先 npm run build）`);
}
must(badEntries.length === 0, "main / exports 指向存在的 .js 构建产物", badEntries.join("; ") || "—");

// 守护脚本必须能解析到安装形态（lib/daemon.js 随包发布），否则 WSL 侧同样栽在 node_modules 的 .ts 上
must(existsSync(join(ROOT, "lib/daemon.js")), "lib/daemon.js 已构建（WSL 侧守护的安装形态）", "");

// ── 工具清单契约（2026-11-25）：catalog ≡ 真实注册 ≡ README 工具表 ──
// 为什么：对外呈现里的"N 个工具"曾经三处各写一遍（README 正文、表格、banner 位图），漂了两次
// （7→9 时图没改；加 wsl_grep/glob 时补了表、wsl_doctor 却一直没进表）。现在三者必须同时成立。
const { HOST_TOOLS, PRESET_TOOLS } = await import(pathToFileURL(join(ROOT, "src/tool-catalog.ts")).href);
const catalogNames = new Set([...HOST_TOOLS, ...PRESET_TOOLS].map((t: { name: string }) => t.name));

const registered = new Set<string>();
for (const file of readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
  const code = readFileSync(join(ROOT, "src", file), "utf8");
  for (const m of code.matchAll(/tools\.register\(\{\s*\n?\s*name:\s*'([a-z_]+)'/g)) registered.add(m[1]);
}
const missingInCatalog = [...registered].filter((n) => !catalogNames.has(n));
const missingInCode = [...catalogNames].filter((n) => !registered.has(n));
must(
  missingInCatalog.length === 0 && missingInCode.length === 0,
  "tool-catalog 与真实 tools.register 一一对应",
  [missingInCatalog.length ? `代码有但清单没写: ${missingInCatalog.join(", ")}` : "", missingInCode.length ? `清单有但代码没注册: ${missingInCode.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ") || "—",
);

const readme = readFileSync(join(ROOT, "README.md"), "utf8");
// 只取「工具表」那一节：从 `### N 个工具` 到下一个 `## ` 之前（否则会把配置表里的 profile/backend 也算进来）
const tableSectionMatch = /^### [^\n]*工具\s*$([\s\S]*?)(?=^## )/m.exec(readme);
const tableNames = tableSectionMatch ? [...tableSectionMatch[1].matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]) : [];
const hostNames = HOST_TOOLS.map((t: { name: string }) => t.name);
const tableMissing = hostNames.filter((n: string) => !tableNames.includes(n));
const tableExtra = tableNames.filter((n: string) => !hostNames.includes(n));
must(
  tableMissing.length === 0 && tableExtra.length === 0,
  `README 工具表 = 清单里的 ${hostNames.length} 个宿主工具`,
  [tableMissing.length ? `表格缺: ${tableMissing.join(", ")}` : "", tableExtra.length ? `表格多: ${tableExtra.join(", ")}` : ""].filter(Boolean).join("; ") || "—",
);

// ── 输出 ────────────────────────────────────────────────────────────────────
if (!QUIET) for (const p of passes) console.log(p);
for (const f of fails) console.log(f);
console.log(`\n结果：${fails.length === 0 ? "PASS" : `FAIL(${fails.length})`} ｜ 断言 ${passes.length + fails.length} 条 ｜ root=${ROOT}`);
process.exit(fails.length === 0 ? 0 : 1);
