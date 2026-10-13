/**
 * splice-t1.ts —— 架构债 T1（task-34）：从 `src/index.ts` 删掉重复的 `textOf` + 内嵌 `class SdkRuntime`。
 *
 * 为什么要脚本：这一段 ~240 行，手工 edit 的 old_string 容易出错；这里按**两个段落标记**精确切片，
 * 切完立刻做结构断言（标记各只出现一次 / 删掉的区间必须以 `class SdkRuntime {` 开头 / 区间里恰好一个裸 `}` 收尾）。
 * 不改任何其它内容（切完打印前后行数与删除区间，供报告留痕）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = process.argv[2];
const START = '// ── 常驻远端 agent：SDK 通道（stdio JSON-RPC 2.0）';
const END = '// ── 远端 UI：WSL 跑 `dsh web`，Windows 开应用窗口';
const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');

const startHits = lines.map((l, i) => (l.startsWith(START) ? i : -1)).filter((i) => i >= 0);
const endHits = lines.map((l, i) => (l.startsWith(END) ? i : -1)).filter((i) => i >= 0);
if (startHits.length !== 1 || endHits.length !== 1) {
  console.error(`标记命中异常：start=${startHits.length} end=${endHits.length}`);
  process.exit(2);
}
const s = startHits[0];
const e = endHits[0];
if (e <= s) { console.error('标记顺序异常'); process.exit(2); }
const removed = lines.slice(s, e);
const hasClass = removed.some((l) => l === 'class SdkRuntime {');
const hasTextOf = removed.some((l) => l.startsWith('function textOf(event)'));
const closers = removed.filter((l) => l === '}').length;
if (!hasClass || !hasTextOf) { console.error(`删除区间没有包含两处目标：class=${hasClass} textOf=${hasTextOf}`); process.exit(2); }
if (removed[removed.length - 1] !== '') { console.error(`区间末尾不是空行：${JSON.stringify(removed[removed.length - 1])}`); process.exit(2); }

const replacement = [
  '// ── 常驻远端 agent：SDK 通道（stdio JSON-RPC 2.0）─────────────────────────────',
  '//',
  '// 架构债 T1（task-34）：这里原来内嵌了第二份 `class SdkRuntime` + `textOf` + `ALLOW_BUILDS` + `unc`。',
  '// 现在**唯一实现**在 `src/sdk-runtime.ts`（`class SdkRuntime` 在 src/ 里只有那一处定义），本文件改为',
  '// `import { SdkRuntime, runtimeAdapter, … }`；宿主逃生舱（`backend=\'in-host\'`）的差异（脚本拼法/',
  '// 起进程/关停/文案/结果投影）通过 `inHostAdapter(cfg)` 覆盖 —— 见 sdk-runtime.ts 头部"单一实现"。',
  '',
];
const out = [...lines.slice(0, s), ...replacement, ...lines.slice(e)].join('\n');
writeFileSync(FILE, out, 'utf8');
console.log(`删除行数 = ${removed.length}（其中 class 声明=${hasClass} textOf=${hasTextOf} 裸 } 行=${closers}）`);
console.log(`行数：${lines.length} → ${out.split('\n').length}`);
console.log(`删除区间首行: ${removed[0]}`);
console.log(`删除区间末行: ${JSON.stringify(removed[removed.length - 1])}`);
