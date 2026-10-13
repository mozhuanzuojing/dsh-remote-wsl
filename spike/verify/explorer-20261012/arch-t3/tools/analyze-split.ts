/**
 * analyze-split.ts —— T3（daemon-client 拆分）的**依赖分析器**。
 *
 * 为什么需要它：拆分靠肉眼判断 import 一定会漏（本仓是"零构建 TS + 相对 .ts"，
 * **缺 import 不会在语法期报错**，只会在运行时 ReferenceError）。所以先用静态分析把
 * "每个目标模块的代码块引用了哪些**在别的块里声明**的标识符"算出来，据此写 import。
 *
 * 用法：
 *   node --experimental-strip-types analyze-split.ts [--file <daemon-client.ts>]
 * 输出：
 *   1) 每个模块的跨模块引用（→ 应写进该模块的 import 列表）
 *   2) 引用了但"哪儿都没声明、也不是已知全局"的标识符（→ 潜在拼写错/漏声明，必须为空）
 *   3) 未被任何块覆盖的行数（>5 行就要人工看一眼，防漏块）
 */
import { readFileSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const FILE = arg('file', 'D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');

type Mod = 'protocol' | 'launch' | 'lifecycle';
/** 块表：[名字, 起, 止, 目标模块]（1-based，含端点；依据首跑 grep 的顶层定义行号） */
const BLOCKS: Array<[string, number, number, Mod]> = [
  ['sleep', 25, 25, 'protocol'],
  ['unc', 28, 32, 'protocol'],
  ['winToWsl', 33, 39, 'protocol'],
  ['daemonScriptWsl', 40, 43, 'protocol'],
  ['stateDirLinux', 44, 45, 'protocol'],
  ['metaLinux', 46, 46, 'protocol'],
  ['tokenLinux', 47, 53, 'protocol'],
  ['launchLinux', 54, 54, 'protocol'],
  ['logLinux', 55, 60, 'protocol'],
  ['legacyMetaLinux', 61, 61, 'protocol'],
  ['legacyTokenLinux', 62, 64, 'protocol'],
  ['listDaemonSlots', 65, 81, 'protocol'],
  ['readDaemonMeta', 82, 94, 'protocol'],
  ['readDaemonToken', 95, 108, 'protocol'],
  ['readDaemonRecord', 109, 135, 'protocol'],
  ['readDaemonLogTail', 136, 149, 'protocol'],
  ['scanDaemonProcesses', 150, 195, 'protocol'],
  ['wslRunScript', 196, 215, 'protocol'],
  ['removeMetaFiles', 216, 235, 'lifecycle'],
  ['tcpCall', 236, 291, 'protocol'],
  ['handshake', 292, 302, 'protocol'],
  ['callDaemon', 303, 318, 'protocol'],
  ['killWslPid', 319, 328, 'launch'],
  ['launchScript', 329, 361, 'launch'],
  ['SYSTEMD_LAUNCH_SCRIPT', 362, 378, 'launch'],
  ['systemdUnit', 379, 381, 'launch'],
  ['ensureStateDir', 382, 404, 'launch'],
  ['WRITE_LAUNCHER_SCRIPT', 405, 418, 'launch'],
  ['writeLauncherWsl', 419, 440, 'launch'],
  ['removeLauncher', 441, 449, 'launch'],
  ['launchDaemon', 450, 602, 'launch'],
  ['configCompat', 603, 618, 'launch'],
  ['ownDaemonsOnPorts', 619, 624, 'lifecycle'],
  ['recordForPid', 625, 641, 'lifecycle'],
  ['ensureDaemon', 642, 854, 'lifecycle'],
  ['waitForSlotGone', 855, 874, 'lifecycle'],
  ['stopDaemon', 875, 943, 'lifecycle'],
  ['stopAllDaemons', 944, 976, 'lifecycle'],
  ['daemonPrompt', 977, 1012, 'protocol'],
  ['daemonSnapshot', 1013, 1039, 'lifecycle'],
  ['daemonStatus', 1040, 1068, 'lifecycle'],
];

/** 已知全局/关键字/内建（出现这些不算"未声明"）。 */
const GLOBALS = new Set(`process Buffer console Math JSON Number String Boolean Array Object Promise Set Map Date RegExp Error TypeError URL URLSearchParams TextEncoder TextDecoder
setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone globalThis require module exports
if else for while do return function async await try catch finally throw new typeof instanceof in of delete void yield class extends super this null undefined true false
let const var import export from default switch case break continue
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent atob btoa
arguments eval JSON
string number boolean any void unknown never object symbol bigint Record Partial Readonly Omit Pick Exclude Extract NonNullable ReturnType Parameters Iterable Array Promise
_ $ __filename __dirname`.split(/\s+/).filter(Boolean));

/** 从形参文本里抽标识符（去掉类型注解与默认值；解构 {} 里的名字照样算形参）。 */
function addParamNames(text: string, out: Set<string>): void {
  // 去类型注解：`name: Type` → `name`（只在形参文本里做，安全）
  const noTypes = text.replace(/:\s*[A-Za-z_$][\w$.<>\[\]|,\s]*(?=[,)}=]|$)/g, (m) => (m.includes('=>') ? m : ''));
  for (const seg of noTypes.split(/[,{}()[\]]+/)) {
    const head = seg.split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(head)) out.add(head);
  }
}
function paramsOf(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) addParamNames(m[1], out);
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?::\s*[^=]*)?\s*=>/g)) addParamNames(m[1], out);
  // 单参数箭头 `x =>`
  for (const m of code.matchAll(/(?:^|[\s,;[(])([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
  return out;
}

const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');
const sliceOf = (s: number, e: number) => lines.slice(s - 1, e).join('\n');

/** 去掉注释与字符串字面量，降低误报。 */
function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

const declsByBlock = new Map<string, Set<string>>();
const blockOfName = new Map<string, string>();
for (const [name, s, e] of BLOCKS) {
  const code = strip(sliceOf(s, e));
  const names = new Set<string>([name]);
  for (const m of code.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:^|\s)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:async\s+)?\(?\s*\{?([\w$,\s:]+)\}?\s*\)?\s*=>/g)) { /* 形参不登记 */ void m; }
  declsByBlock.set(name, names);
  for (const n of names) if (!blockOfName.has(n)) blockOfName.set(n, name);
}

// 每个模块：引用集合
const refsByMod = new Map<Mod, Set<string>>();
for (const mod of ['protocol', 'launch', 'lifecycle'] as Mod[]) refsByMod.set(mod, new Set());
const declaredInMod = new Map<Mod, Set<string>>();
for (const mod of ['protocol', 'launch', 'lifecycle'] as Mod[]) declaredInMod.set(mod, new Set());
for (const [name, , , mod] of BLOCKS) for (const n of declsByBlock.get(name)!) declaredInMod.get(mod)!.add(n);

for (const [name, s, e, mod] of BLOCKS) {
  const code = strip(sliceOf(s, e));
  const local = new Set([...declsByBlock.get(name)!, ...paramsOf(code)]);
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?=[({[]|\)|\.|,|;|\s|$)/g)) {
    const id = m[1];
    if (local.has(id) || GLOBALS.has(id)) continue;
    refsByMod.get(mod)!.add(id);
  }
}

console.log(`文件：${FILE}  ｜ 顶层块 ${BLOCKS.length} 个 ｜ 行数 ${lines.length}`);
console.log('');
for (const mod of ['protocol', 'launch', 'lifecycle'] as Mod[]) {
  const declaredElsewhere = new Set<string>();
  const unknown: string[] = [];
  for (const id of refsByMod.get(mod)!) {
    const owner = blockOfName.get(id);
    if (!owner) { unknown.push(id); continue; }
    const ownerMod = BLOCKS.find((b) => b[0] === owner)![3];
    if (ownerMod !== mod) declaredElsewhere.add(`${id}  ← (${ownerMod})`);
  }
  console.log(`### ${mod}`);
  console.log(`  本地声明：${[...declaredInMod.get(mod)!].sort().join(', ')}`);
  console.log(`  **需 import**：${declaredElsewhere.size ? [...declaredElsewhere].sort().join('; ') : '(无)'}`);
  console.log(`  未声明且非全局（应为空）：${unknown.length ? unknown.sort().join(', ') : '(空) ✓'}`);
  console.log('');
}

// 覆盖检查
const covered = new Set<number>();
for (const [, s, e] of BLOCKS) for (let i = s; i <= e; i++) covered.add(i);
const uncover = [];
for (let i = 1; i <= lines.length; i++) if (!covered.has(i) && lines[i - 1].trim() !== '') uncover.push(i);
console.log(`未覆盖的**非空**行（应只有文件头注释/import 与块间空行）：${uncover.length ? uncover.join(',') : '(无)'}`);
