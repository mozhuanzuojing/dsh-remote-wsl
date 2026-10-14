/**
 * syntax-check.ts —— T73 的**只解析、不执行**语法检查（改了 20 个文件后必须确认没把文件改坏）。
 *
 * 为什么不能直接 import 它们：这些工具**一跑就有副作用**（起宿主 / 起守护 / 写盘）。所以：
 *   · `.ts`：用 `node:vm` 的 `SourceTextModule` **只解析**（需要 `--experimental-vm-modules`）；
 *   · `.ps1`：交给 PowerShell 的 `Parser::ParseFile`（同样只解析，不执行）—— 那部分在 pwsh 里跑。
 *
 * 用法：node --experimental-vm-modules --experimental-strip-types syntax-check.ts --files a.ts,b.ts
 * 退出码：0 = 全部解析通过；1 = 有语法错误（打印文件名 + 错误）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const FILES = arg('files', '').split(',').map((s) => s.trim()).filter(Boolean);
if (!FILES.length) { console.error('用法：--files a.ts,b.ts'); process.exit(2); }
const require_ = createRequire(import.meta.url);
const vm: any = require_('node:vm');
const nodeModule: any = require_('node:module');
if (!vm.SourceTextModule) { console.error('✗ 需要 --experimental-vm-modules'); process.exit(2); }
// ⚠️ 量具自己的坑：`vm.SourceTextModule` 解析的是 **JS** ⇒ 直接喂 `.ts` 会把 `interface`/类型注解
// 报成 "Unexpected strict mode reserved word"（首跑就把 probe-ground-truth.ts 误判成坏了）。
// 正确顺序：先用 Node 自带的 `stripTypeScriptTypes` 剥掉类型，再解析。
const stripTs = (code: string): string => (typeof nodeModule.stripTypeScriptTypes === 'function'
  ? nodeModule.stripTypeScriptTypes(code, { mode: 'strip' })
  : code);

let bad = 0;
for (const f of FILES) {
  const abs = resolve(f);
  try {
    new vm.SourceTextModule(stripTs(readFileSync(abs, 'utf8')), { identifier: abs }); // 只解析，不 link、不 evaluate
    console.log(`  [OK  ] ${f}`);
  } catch (e: any) {
    bad++;
    console.log(`  [FAIL] ${f} — ${e?.name}: ${String(e?.message).slice(0, 200)}`);
  }
}
console.log(bad ? `\n结果：FAIL(${bad}/${FILES.length})` : `\n结果：PASS（${FILES.length} 个文件全部可解析）`);
process.exit(bad ? 1 : 0);
