/**
 * extract-css.ts —— 从 client/index.js 里把**面板 CSS 数组**原样抠出来，落成 .css 文件。
 *
 * 为什么需要：T52 要量 `.dsh-rw-menu` 的真实渲染宽度，而插件 CSS 是**手写在 JS 数组里的字符串**。
 * 抠出来之后：① 可以在真实 Chromium 里加载同一份 CSS 做机制实测；② 可以做"CJK 是否落在注释里"等静态检查。
 *
 * 用法： node extract-css.ts <client/index.js> <输出.css>
 * 退出码：0 成功；1 解析失败（会打印原因）
 */
import fs from "node:fs";

const [, , entry, outFile] = process.argv;
if (!entry || !outFile) {
  console.error("usage: node extract-css.ts <client/index.js> <out.css>");
  process.exit(2);
}
const src = fs.readFileSync(entry, "utf8");

const start = src.indexOf("const CSS = [");
if (start < 0) { console.error("找不到 `const CSS = [`"); process.exit(1); }
const end = src.indexOf("].join(", start);
if (end < 0) { console.error("找不到 `].join(`"); process.exit(1); }

let inner = src.slice(start + "const CSS = [".length, end);
inner = inner.replace(/^[ \t]*\/\/.*$/gm, "");   // 去掉 JS 行注释（CSS 里没有 //，安全）
inner = inner.replace(/,[ \t\r\n]*$/, "");       // 去掉尾逗号
let arr;
try {
  arr = JSON.parse("[" + inner + "]");
} catch (e) {
  console.error("数组解析失败：" + e.message);
  process.exit(1);
}
const css = arr.join("\n");
fs.writeFileSync(outFile, css, "utf8");
const lines = css.split("\n").length;
console.log("rules = " + arr.length + "   lines = " + lines + "   bytes = " + Buffer.byteLength(css, "utf8"));
console.log("out = " + outFile);
