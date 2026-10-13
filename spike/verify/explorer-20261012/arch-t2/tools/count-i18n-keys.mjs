/**
 * count-i18n-keys.mjs —— 复核 `client/client.i18n.js` 的键数（T2 文档里出现的每个数字都要可复算）。
 *
 * 用法：node count-i18n-keys.mjs [repoRoot]
 * 输出：JSON（zh 键数 / en 键数 / 键集是否逐键配对 / 标注为「新增」的块内键数）
 */
import { readFileSync } from 'node:fs';

const root = (process.argv[2] ?? 'D:/project/dsh1/vendor/dsh-remote-wsl').replace(/\/+$/, '');
const src = readFileSync(`${root}/client/client.i18n.js`, 'utf8');

/** 取 `const <NAME> = {` 到下一个同缩进 `};` 之间的切片（并记录起始行号）。 */
function block(name) {
  const start = src.indexOf(`const ${name} = {`);
  if (start < 0) return null;
  const end = src.indexOf('\n\t\t};', start);
  if (end < 0) return null;
  const text = src.slice(start, end);
  const lineStart = src.slice(0, start).split('\n').length;
  return { text, lineStart };
}

/** 统计块内一级键（形如 `"a.b":`），并按"前一行注释里出现新增/T30"分组。 */
function keysOf(b) {
  const lines = b.text.split('\n');
  const keys = [];
  const marked = [];
  let mark = false;
  for (const line of lines) {
    if (/^\s*\/\//.test(line)) {
      mark = /新增|T\d\d/.test(line);
      continue;
    }
    const m = /^\s*"([^"]+)"\s*:/.exec(line);
    if (!m) continue;
    keys.push(m[1]);
    if (mark) marked.push(m[1]);
  }
  return { keys, marked };
}

const zh = block('ZH');
const en = block('EN');
if (!zh || !en) {
  console.log(JSON.stringify({ error: '找不到 const ZH/EN 块（文件结构变了 ⇒ 复算方式需更新）' }, null, 2));
  process.exit(2);
}
const Z = keysOf(zh), E = keysOf(en);
const zSet = new Set(Z.keys), eSet = new Set(E.keys);
const onlyZh = Z.keys.filter((k) => !eSet.has(k));
const onlyEn = E.keys.filter((k) => !zSet.has(k));

console.log(JSON.stringify({
  file: `${root}/client/client.i18n.js`,
  totalLines: src.split('\n').length,
  zh: { blockLine: zh.lineStart, keys: Z.keys.length, markedNew: Z.marked.length },
  en: { blockLine: en.lineStart, keys: E.keys.length, markedNew: E.marked.length },
  paired: onlyZh.length === 0 && onlyEn.length === 0,
  onlyZh, onlyEn,
}, null, 2));
