/**
 * 零依赖语法门禁（`npm run check`）。
 *
 * 为什么不用 tsc：本仓是**零构建**（只用可擦除语法、不引入运行时/构建依赖），为一个语法门禁引入
 * TypeScript 依赖会破坏 "link: 安装即可用" 的约束。这里做两件可离线、零依赖的事：
 *  1. `src/**\/*.ts` 用 Node 内置的 `stripTypeScriptTypes` 解析（语法错会抛）；
 *  2. `client/**\/*.js` 用 `node --check` 校验（client 是无构建的普通 JS）。
 *
 * 运行：`node --experimental-strip-types scripts/check-syntax.ts`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, filter: (name: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, filter));
    else if (filter(name)) out.push(full);
  }
  return out;
}

let failed = 0;

const tsFiles = walk(join(root, 'src'), (n) => n.endsWith('.ts'));
for (const file of tsFiles) {
  try {
    stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' });
  } catch (e: any) {
    failed++;
    console.error(`✗ ${relative(root, file)}: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

const jsFiles = walk(join(root, 'client'), (n) => n.endsWith('.js'));
for (const file of jsFiles) {
  try {
    execFileSync('node', ['--check', file], { stdio: 'pipe' });
  } catch (e: any) {
    failed++;
    console.error(`✗ ${relative(root, file)}: ${String(e?.stderr ?? e?.message ?? e).split('\n')[0]}`);
  }
}

console.log(`checked ${tsFiles.length} TS + ${jsFiles.length} JS files`);
if (failed) {
  console.error(`${failed} file(s) failed`);
  process.exit(1);
}
console.log('syntax OK');
