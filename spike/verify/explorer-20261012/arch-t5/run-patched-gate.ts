/**
 * run-patched-gate.ts —— 诊断 + 证明：T2 的 check-docs-methods.mjs 之所以 FAIL，是因为它把"工具名权威"
 * 硬编码在 `src/index.ts`（T5 拆分后那 7 个 `name: 'wsl_*'` 搬到了 `src/register-tools.ts`）。
 *
 * 本脚本**不改**那个文件（它属 T2 的产物），而是把它复制一份、只改"在哪读工具名"这一处，再跑一次：
 * 期望 11/11 PASS —— 用来向 lead/owner 证明"护栏本身没问题，只是权威路径要跟着 T5 的拆分走"。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = 'D:/project/dsh1/vendor/dsh-remote-wsl';
const src = `${ROOT}/spike/verify/explorer-20261012/arch-t2/tools/check-docs-methods.mjs`;
const out = 'D:/project/net1/_t5-split/check-docs-methods.patched.mjs';
let t = readFileSync(src, 'utf8');

const before = t;
// ① 把 ROOT 固定成绝对路径（副本在仓外，原来的相对推导会指错）
t = t.replace(/const ROOT = [^;]+;/, `const ROOT = '${ROOT}';`);
// ② 工具名权威：index.ts → register-tools.ts（T5 拆分后的位置）
t = t.replace(/readFileSync\(join\(ROOT, 'src\/index\.ts'\), 'utf8'\)/g, "readFileSync(join(ROOT, 'src/register-tools.ts'), 'utf8')");
if (t === before) { console.error('✗ 没改到任何一处（锚点变了？）'); process.exit(2); }
writeFileSync(out, t, 'utf8');
console.log(`已生成补丁副本：${out}`);
console.log(`  改动：ROOT 绝对化 + 工具名权威 src/index.ts → src/register-tools.ts`);
const r = spawnSync('node', [out], { encoding: 'utf8' });
process.stdout.write(String(r.stdout || ''));
process.stderr.write(String(r.stderr || ''));
console.log(`\n补丁副本 exit=${r.status}（期望 0 = 11/11 PASS）`);
