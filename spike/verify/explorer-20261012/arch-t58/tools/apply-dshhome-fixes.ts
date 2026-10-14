/**
 * apply-dshhome-fixes.ts —— T73 的**幂等 codemod**：给 T70 普查出的 20 个工具补
 * "孤立 `DSH_HOME`（或只补断言）+ 收尾前后 sha 断言"。
 *
 * 设计要点（为什么这么做）：
 *  · **只在两个位置插入**：① 文件**最上面**（跳过起始块注释）插入"护栏 import + 隔离调用" ——
 *    这样**必然早于任何 `import src/**`**（顺序门禁要求），且即使是函数体内的动态 import 也安全；
 *    ② 在**最后一个 `process.exit(` 之前**（没有则文件末尾）插入断言 —— 一处覆盖整条出口。
 *  · `.ps1`：① 在 param 块结束处插 `[switch]$UseUserHome`（没有 param 块就用 `[CmdletBinding()]` 后）＋
 *    紧跟一段"默认孤立 home + 记 before sha"；② 在最后一个 `exit` 前（没有则末尾）插"比 after sha，不同即 exit 9"。
 *  · 每次插入都**断言锚点命中**（锚点变了就报错退出，绝不静默半改）；`--dry` 只预览。
 *
 * 用法：node --experimental-strip-types apply-dshhome-fixes.ts [--root <explorerRoot>] [--dry] [--only <relSubstr>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl/spike/verify/explorer-20261012');
const DRY = process.argv.includes('--dry');
const ONLY = arg('only', '');

type TsEntry = [rel: string, guardPath: string, mode: 'isolate' | 'assert-only'];
const TS: TsEntry[] = [
  // ── 12 个 ✗ 里的 .ts（9 个）：import 前隔离 + 收尾断言 ──
  ['arch-t1/probe-parity-t1.ts', '../../arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['arch-t1/probe-runtime-smoke-t1.ts', '../../arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['arch-t5/probe-t5.ts', '../../arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['host-f38/probe-tool-line.ts', '../../arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['host-prefix/probe-t22.ts', '../../arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['probe-ground-truth.ts', './arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['probe-wsl-path.ts', './arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['reliability/inject-b-adapter.ts', '../arch-t58/tools/dsh-guard.ts', 'isolate'],
  ['reliability/inject-delta.ts', '../arch-t58/tools/dsh-guard.ts', 'isolate'],
  // ── 8 个 ⚠ 里的 .ts（4 个）：已自己设 home，只补断言 ──
  ['arch-t55/probe-t55.ts', '../../arch-t58/tools/dsh-guard.ts', 'assert-only'],
  ['arch-t55/probe-t60.ts', '../../arch-t58/tools/dsh-guard.ts', 'assert-only'],
  ['arch-t55/probe-t66.ts', '../../arch-t58/tools/dsh-guard.ts', 'assert-only'],
  ['arch-t5/probe-openui.ts', '../../arch-t58/tools/dsh-guard.ts', 'assert-only'],
];
/** `.ps1`：`host` = 默认改孤立 home + 加 `-UseUserHome`；`assert-only` = 只补前后 sha 断言 */
const PS1: Array<[rel: string, kind: 'host' | 'assert-only']> = [
  ['boot-testhost.ps1', 'host'],
  ['stability/boot-stabhost.ps1', 'host'],
  ['reliability/inject-a-daemon-kill.ps1', 'host'],
  ['usability/p04-boot.ps1', 'host'],
  ['usability/usab-run.ps1', 'host'],
  ['usability/ux-boot.ps1', 'host'],
  ['boot-iso-host.ps1', 'assert-only'],
];

const toolName = (rel: string) => rel.replace(/[\\/]/g, '-').replace(/\.(ts|ps1)$/, '');
const summary: Array<{ file: string; added: number; where: string }> = [];
function must(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

// ── .ts：最上面插"护栏 import + 隔离/观察"，最后一个 process.exit 前插断言 ──
function fixTs(rel: string, guardPath: string, mode: 'isolate' | 'assert-only'): void {
  const f = join(ROOT, rel);
  const src = readFileSync(f, 'utf8');
  if (src.includes('dsh-guard.ts')) { console.log(`  [skip] ${rel}（已接入护栏）`); return; }
  const lines = src.split('\n');
  // ① 跳过起始块注释/空行/`#!`，插在最上面
  let top = 0;
  if (/^#!/.test(lines[0] ?? '')) top = 1;
  while (top < lines.length && /^\s*$/.test(lines[top])) top++;
  if (/^\s*\/\*/.test(lines[top] ?? '')) { let i = top; while (i < lines.length && !/\*\//.test(lines[i])) i++; top = i + 1; }
  const guardBlock = mode === 'isolate'
    ? [
        `// ── T73：**必须在任何 import src/** 之前**隔离 DSH_HOME**，并在收尾比对用户全局 workspace.json 前后 sha ──`,
        `import { isolateDshHome } from '${guardPath}';`,
        `const dshGuard = isolateDshHome('${toolName(rel)}');`,
        ``,
      ]
    : [
        `// ── T73：本工具自己设了孤立 DSH_HOME；这里补"用户全局 workspace.json 前后 sha"闭环 ──`,
        `import { watchGlobalWorkspace } from '${guardPath}';`,
        `const dshGuard = watchGlobalWorkspace();`,
        ``,
      ];
  const exitIdxs = lines.map((l, i) => (/^\s*process\.exit\(/.test(l) ? i : -1)).filter((i) => i >= 0);
  const insertAt = exitIdxs.length ? exitIdxs[exitIdxs.length - 1] : lines.length;
  const assertBlock = [
    `// ── T73 断言：用户全局 workspace.json 前后 sha 必须相同（不同 ⇒ 抛错，调用方按非零退出处理）──`,
    `dshGuard.assertUnchanged();`,
  ];
  must(insertAt > top, `${rel}：断言插入点(${insertAt}) 必须在顶部(${top})之后`);
  const out = [...lines.slice(0, top), ...guardBlock, ...lines.slice(top, insertAt), ...assertBlock, ...lines.slice(insertAt)];
  if (!DRY) writeFileSync(f, out.join('\n'), 'utf8');
  summary.push({ file: rel, added: guardBlock.length + assertBlock.length, where: `顶部第 ${top + 1} 行前 + 第 ${insertAt + 1} 行前（最后一个 process.exit）` });
  console.log(`  [ts:${mode}] ${rel}  +${guardBlock.length + assertBlock.length} 行`);
}

// ── .ps1：param 块加 -UseUserHome（host 类，**必须先补逗号**：PowerShell param 块不认换行分隔）＋ 头部隔离块 ＋ 收尾断言 ──
function fixPs1(rel: string, kind: 'host' | 'assert-only'): void {
  const f = join(ROOT, rel);
  const src = readFileSync(f, 'utf8');
  if (src.includes('[T73]')) { console.log(`  [skip] ${rel}（已接入 T73 块）`); return; }
  const lines = src.split('\n');
  const paramStart = lines.findIndex((l) => /^\s*param\s*\(/.test(l));
  let paramEnd = -1;
  if (paramStart >= 0) for (let i = paramStart + 1; i < lines.length; i++) { if (/^\s*\)\s*$/.test(lines[i])) { paramEnd = i; break; } }
  const cbIdx = lines.findIndex((l) => /\[CmdletBinding\(\)\]/.test(l));
  must(paramEnd >= 0 || cbIdx >= 0, `${rel}：找不到 param 块或 [CmdletBinding()]`);
  const assertAt = ps1AssertIndex(lines);          // ← 第一个顶层 return/exit 之前（见该函数注释）
  const headerAt = paramEnd >= 0 ? paramEnd + 1 : cbIdx + 1;

  const header = [
    ``,
    `# ── T73：默认**孤立** DSH_HOME（-UseUserHome 才用真实 home）＋ 用户全局 workspace.json 前后 sha 对照 ──`,
    `$script:T73Ws = Join-Path $env:USERPROFILE '.dsh\\storages\\workspace.json'`,
    `$script:T73ShaBefore = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }`,
    ...(kind === 'host'
      ? [`if (-not $UseUserHome) {`,
         `  $env:DSH_HOME = Join-Path $env:TEMP '${toolName(rel)}-home'`,
         `  New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_HOME 'storages') | Out-Null`,
         `}`,
         `Write-Host "[T73] DSH_HOME=$env:DSH_HOME（UseUserHome=$([bool]$UseUserHome)） sha(前)=$($script:T73ShaBefore.Substring(0,[Math]::Min(16,$script:T73ShaBefore.Length)))"`]
      : [`Write-Host "[T73] 本脚本自带隔离，DSH_HOME=$env:DSH_HOME；sha(前)=$($script:T73ShaBefore.Substring(0,[Math]::Min(16,$script:T73ShaBefore.Length)))"`]),
  ];
  const assertBlock = [
    `# ── T73 断言：用户全局 workspace.json 前后 sha 相同 ──`,
    `$script:T73ShaAfter = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }`,
    `if ($script:T73ShaAfter -ne $script:T73ShaBefore) { Write-Host "[T73] 失败：用户全局 workspace.json 被改写（$($script:T73ShaBefore) -> $($script:T73ShaAfter)）"; exit 9 }`,
    `Write-Host "[T73] 用户全局 workspace.json sha 前后相同 = True"`,
  ];

  // 从后往前插，避免行号顺移
  let added = 0;
  lines.splice(assertAt, 0, ...assertBlock); added += assertBlock.length;
  lines.splice(headerAt, 0, ...header); added += header.length;
  if (kind === 'host' && paramEnd >= 0) {
    let last = paramEnd - 1;
    while (last > paramStart && /^\s*$/.test(lines[last])) last--;
    if (!/,\s*$/.test(lines[last])) lines[last] = `${lines[last]},`;   // ← PowerShell 要求逗号分隔
    lines.splice(paramEnd, 0, '  [switch]$UseUserHome');
    added += 1;
  }
  if (!DRY) writeFileSync(f, lines.join('\n'), 'utf8');
  summary.push({ file: rel, added, where: `param 块后第 ${headerAt + 1} 行前 + 第 ${assertAt + 1} 行前（最后一个 exit）` });
  console.log(`  [ps1:${kind}] ${rel}  +${added} 行`);
}

/**
 * `.ps1` 的**断言行该放哪**：第一个**顶层** `return`/`exit` 之前（没有则文件末尾）。
 * ⚠️ 首版按"最后一个 `exit`"定位 ⇒ `boot-iso-host.ps1` 的断言被插到 `return $p.Id` **之后**（不可达）。
 * 顶层 = 行首无缩进，避免误插到 `switch` 分支里的 `exit`。
 */
function ps1AssertIndex(lines: string[]): number {
  const idx = lines.findIndex((l) => /^(return|exit)\b/.test(l));
  return idx >= 0 ? idx : lines.length;
}
const PS1_ASSERT_RE = /^# ── T73 断言：用户全局 workspace\.json 前后 sha 相同 ──$/;
/** 搬迁已插入的断言行（修首版的不可达问题）：删掉旧块，按新规则重插。 */
function relocatePs1Assert(rel: string): void {
  const f = join(ROOT, rel);
  const lines = readFileSync(f, 'utf8').split('\n');
  const at = lines.findIndex((l) => PS1_ASSERT_RE.test(l));
  if (at < 0) { console.log(`  [skip] ${rel}（找不到断言行）`); return; }
  const block = lines.splice(at, 4);                       // comment + 3 行
  must(block[block.length - 1].includes('前后相同'), `${rel}：断言行块形状不符`);
  const target = ps1AssertIndex(lines);
  lines.splice(target, 0, ...block);
  if (!DRY) writeFileSync(f, lines.join('\n'), 'utf8');
  console.log(`  [ps1:relocate] ${rel}  断言行 ${at + 1} → 第 ${target + 1} 行前`);
}

const TS_HDR_RE = /^# ── T73：默认\*\*孤立\*\* DSH_HOME/;
/** 刷新 host 类 `.ps1` 的头块：补**覆盖 `$DshHome`**（T73 复跑发现的第二处漏洞）。 */
function refreshHostHeader(rel: string): void {
  const f = join(ROOT, rel);
  const lines = readFileSync(f, 'utf8').split('\n');
  const at = lines.findIndex((l) => TS_HDR_RE.test(l));
  if (at < 0) { console.log(`  [skip] ${rel}（无 host 头块）`); return; }
  let end = at;
  while (end < lines.length && !/^Write-Host "\[T73\] DSH_HOME=/.test(lines[end])) end++;
  must(end > at, `${rel}：头块没找到收尾 Write-Host`);
  const header = [
    `# ── T73：默认**孤立** DSH_HOME（-UseUserHome 才用真实 home）＋ 用户全局 workspace.json 前后 sha 对照 ──`,
    `$script:T73Ws = Join-Path $env:USERPROFILE '.dsh\\storages\\workspace.json'`,
    `$script:T73ShaBefore = if (Test-Path $script:T73Ws) { (Get-FileHash $script:T73Ws -Algorithm SHA256).Hash } else { '<none>' }`,
    `if (-not $UseUserHome) {`,
    `  $env:DSH_HOME = Join-Path $env:TEMP '${toolName(rel)}-home'`,
    `  New-Item -ItemType Directory -Force -Path (Join-Path $env:DSH_HOME 'storages') | Out-Null`,
    `  # ⚠️ 有些脚本另有 \`param([string]$DshHome = $env:DSH_HOME)\`：它的默认值在**本块之前**就求值成用户 home，`,
    `  #    会让脚本后面按用户 home 拼 profile 路径（T73 复跑实测：boot-testhost 因此去用户目录找 profile）⇒ 一并覆盖。`,
    `  if (Get-Variable -Name DshHome -Scope 0 -ErrorAction SilentlyContinue) { $DshHome = $env:DSH_HOME }`,
    `}`,
    `Write-Host "[T73] DSH_HOME=$env:DSH_HOME（UseUserHome=$([bool]$UseUserHome)） sha(前)=$($script:T73ShaBefore.Substring(0,[Math]::Min(16,$script:T73ShaBefore.Length)))"`,
  ];
  lines.splice(at, end - at + 1, ...header);
  if (!DRY) writeFileSync(f, lines.join('\n'), 'utf8');
  console.log(`  [ps1:refresh-header] ${rel}  头块 ${end - at + 1} 行 → ${header.length} 行（含 $DshHome 覆盖）`);
}

for (const [rel, gp, mode] of TS) { if (!ONLY || rel.includes(ONLY)) fixTs(rel, gp, mode); }
for (const [rel, kind] of PS1) { if (!ONLY || rel.includes(ONLY)) fixPs1(rel, kind); }
if (process.argv.includes('--refresh-header-host')) {
  console.log('\n刷新 host 类 .ps1 头块（补 $DshHome 覆盖）：');
  for (const [rel, kind] of PS1) { if (kind === 'host' && (!ONLY || rel.includes(ONLY))) refreshHostHeader(rel); }
}
if (process.argv.includes('--relocate-assert')) {
  console.log('\n搬迁 .ps1 断言行（修"不可达"版）：');
  for (const [rel] of PS1) { if (!ONLY || rel.includes(ONLY)) relocatePs1Assert(rel); }
}
console.log(`\n改动 ${summary.length} 个文件${DRY ? '（dry-run，未写盘）' : ''}：`);
for (const s of summary) console.log(`  ${s.file}  +${s.added} 行  ← ${s.where}`);
