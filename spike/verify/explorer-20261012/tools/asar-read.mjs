/* asar-read.mjs —— 零依赖的 asar 读取器（只为**取证**，不修改任何东西）。
 *
 * 为什么自己写：`app.asar` 是 121MB 的单文件归档（Electron 虚拟目录），普通 Node 的 fs 读不进去；
 * 而 task-37 明令**不许 npm/pnpm install**（`npx asar` 会装包）。asar 格式本身很简单，够用：
 *   [0..3]  uint32 = 4
 *   [4..7]  uint32 = pickle 头长度 H
 *   [8..H+8] pickle: 前 4 字节 = JSON 字符串长度 L，随后 L 字节 = 目录树 JSON
 *   文件内容区起点 base = 8 + H；每个文件条目的 offset 相对 base
 *
 * 用法：
 *   node asar-read.mjs list   <asar> <子串过滤>          # 列出匹配的条目（含 size）
 *   node asar-read.mjs cat    <asar> <条目路径> [起始行] [行数]
 *   node asar-read.mjs grep   <asar> <正则> [路径过滤] [最多命中数] [上下文行数]
 */
import fs from 'node:fs';

const [, , cmd, asarPath, a1, a2, a3, a4] = process.argv;
if (!cmd || !asarPath) {
  console.error('用法: node asar-read.mjs <list|cat|grep> <asar> [...]');
  process.exit(2);
}

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const pickleSize = head.readUInt32LE(4);
const pickle = Buffer.alloc(pickleSize);
fs.readSync(fd, pickle, 0, pickleSize, 8);
// Pickle 布局：pickle[0..3] = payload 长度；payload[0..3] = 字符串长度；随后才是 JSON。
// （原先用 pickle.readUInt32LE(0) 当字符串长度 ⇒ 偏 4 字节 ⇒ JSON.parse 失败）
const jsonLen = pickle.readUInt32LE(4);
const jsonText = pickle.subarray(8, 8 + jsonLen).toString('utf8');
let tree;
try { tree = JSON.parse(jsonText); } catch (e) { console.error('asar 头解析失败：' + e.message.slice(0, 200) + ' | head=' + jsonText.slice(0, 120)); process.exit(3); }
const BASE = 8 + pickleSize;

/** 把目录树摊平成 { 路径: {offset,size} } */
const files = new Map();
const walk = (node, prefix) => {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (val.files) walk(val, p);
    else files.set(p, { offset: Number(val.offset), size: Number(val.size), unpacked: val.unpacked === true });
  }
};
walk(tree, '');

const readEntry = (p) => {
  const e = files.get(p);
  if (!e) return null;
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, BASE + e.offset);
  return buf;
};

if (cmd === 'list') {
  const filter = a1 || '';
  const hits = [...files.keys()].filter((p) => p.includes(filter));
  console.log(`# 条目总数=${files.size}  匹配 "${filter}" = ${hits.length}`);
  for (const p of hits.slice(0, 200)) console.log(`${String(files.get(p).size).padStart(9)}  ${p}`);
} else if (cmd === 'cat') {
  const buf = readEntry(a1);
  if (!buf) { console.error(`没有该条目: ${a1}`); process.exit(1); }
  const start = a2 ? Math.max(0, Number(a2) - 1) : 0;
  const count = a3 ? Number(a3) : 400;
  const lines = buf.toString('utf8').split('\n');
  console.log(`# ${a1}  总行数=${lines.length}`);
  lines.slice(start, start + count).forEach((l, i) => console.log(`${String(start + i + 1).padStart(5)}| ${l.slice(0, 400)}`));
} else if (cmd === 'grep') {
  const re = new RegExp(a1, 'i');
  const pathFilter = a2 || '';
  const maxHits = a3 ? Number(a3) : 20;
  const ctx = a4 ? Number(a4) : 0;
  let hits = 0;
  for (const [p, meta] of files) {
    if (pathFilter && !p.includes(pathFilter)) continue;
    if (meta.size > 4 * 1024 * 1024) continue; // 跳过大文件（二进制/巨型 bundle）
    let text;
    try { text = readEntry(p).toString('utf8'); } catch { continue; }
    if (!re.test(text)) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      console.log(`\n--- ${p}:${i + 1} (size=${meta.size})`);
      for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) console.log(`${String(k + 1).padStart(6)}| ${lines[k].slice(0, 400)}`);
      if (++hits >= maxHits) { console.log(`\n# 命中上限 ${maxHits} 已到`); process.exit(0); }
    }
  }
  console.log(`\n# 命中 ${hits} 处`);
} else {
  console.error(`未知命令: ${cmd}`);
  process.exit(2);
}
