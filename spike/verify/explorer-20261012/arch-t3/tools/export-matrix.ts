/**
 * export-matrix.ts —— T3 的**导出矩阵对照器**（拆前/拆后逐符号）。
 *
 * 判据：`daemon-client.ts` 的对外面必须**逐一不变**（符号存在 + typeof 相同 + 函数 arity 相同），
 * 且**不应凭空多出**符号（本次拆分新增的 `sleep`/`killWslPid` 只应存在于各自的模块里）。
 *
 * 用法：node --experimental-strip-types export-matrix.ts [--target <模块路径>] [--strict-surface]
 * 退出码：0 = 全部符合；1 = 缺符号/类型或 arity 不符；2 = 多出符号（仅 --strict-surface 时判 1）
 */
import { writeFileSync } from 'node:fs';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const TARGET = arg('target', 'D:/project/dsh1/vendor/dsh-remote-wsl/src/daemon-client.ts');
const STRICT = process.argv.includes('--strict-surface');
const OUT = arg('out', '');

/** 原有 31 个对外符号（拆分前的实测清单，见 out-01-analyze.txt 与首跑 grep）。 */
const EXPECTED = [
  'unc', 'winToWsl', 'daemonScriptWsl', 'stateDirLinux', 'metaLinux', 'tokenLinux', 'launchLinux', 'logLinux',
  'legacyMetaLinux', 'legacyTokenLinux', 'listDaemonSlots', 'readDaemonMeta', 'readDaemonToken',
  'readDaemonRecord', 'readDaemonLogTail', 'scanDaemonProcesses', 'wslRunScript', 'tcpCall', 'handshake',
  'callDaemon', 'daemonPrompt',
  'systemdUnit', 'writeLauncherWsl', 'removeLauncher', 'launchDaemon', 'configCompat',
  'ensureDaemon', 'stopDaemon', 'stopAllDaemons', 'daemonSnapshot', 'daemonStatus',
];

const mod: Record<string, unknown> = await import(`file:///${TARGET}`);
const rows = EXPECTED.map((name) => {
  const v = mod[name];
  return { name, present: v !== undefined, typeof: typeof v, arity: typeof v === 'function' ? (v as (...a: unknown[]) => unknown).length : null };
});
const missing = rows.filter((r) => !r.present || (r.typeof !== 'function' && r.typeof !== 'object'));
const extra = Object.keys(mod).filter((k) => !EXPECTED.includes(k));

const report = {
  at: new Date().toISOString(), target: TARGET, expectedCount: EXPECTED.length,
  presentCount: rows.filter((r) => r.present).length, missing: missing.map((m) => m.name),
  extra, strictSurface: STRICT, rows,
};
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
console.log(`target=${TARGET}`);
console.log(`期望 ${EXPECTED.length} 个符号；实到 ${report.presentCount}；缺 ${missing.length ? missing.map((m) => m.name).join(', ') : '(无)'}`);
console.log(`多出的符号（${extra.length}）：${extra.length ? extra.join(', ') : '(无)'}`);
for (const r of rows) console.log(`  ${r.present ? 'OK  ' : 'MISS'} ${r.name.padEnd(22)} typeof=${r.typeof}${r.arity !== null ? ` arity=${r.arity}` : ''}`);
const fail = missing.length > 0 || (STRICT && extra.length > 0);
console.log(fail ? `\n结果：FAIL` : `\n结果：PASS`);
process.exit(fail ? 1 : 0);
