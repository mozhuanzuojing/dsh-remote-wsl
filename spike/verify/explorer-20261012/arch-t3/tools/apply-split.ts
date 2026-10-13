/**
 * apply-split.ts —— T3 的**机械拆分器**（把 `src/daemon-client.ts` 按行区间搬进三个模块）。
 *
 * 为什么用脚本而不是手改：搬块必须**逐字不变**（本次拆分的全部风险都在"顺手改了什么"）。
 * 脚本只做三件事：① 备份旧版（含 SHA256）；② 把块按行区间原样写进对应新文件；③ 把
 * `daemon-client.ts` 换成**只 re-export 原有 31 个符号**的薄层。
 *
 * 用法：node --experimental-strip-types apply-split.ts [--dry]
 * 输出：三个新 src 文件 + 新 daemon-client.ts + backup/daemon-client.<sha8>.ts.bak
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const SRC = `${ROOT}/src/daemon-client.ts`;
const OUT = `${ROOT}/spike/verify/explorer-20261012/arch-t3`;

const src = readFileSync(SRC, 'utf8');
const lines = src.split('\n');
/**
 * 块内**唯一允许的改动**：给两个跨模块复用、但原本私有的符号补 `export`
 * （`sleep` 被 lifecycle 用、`killWslPid` 被 lifecycle 用）。
 * 除此之外**逐字搬移**——实现体一行都不改。
 */
const FORCE_EXPORT: Record<string, [RegExp, string]> = {
  sleep: [/^const sleep = /m, 'export const sleep = '],
  killWslPid: [/^function killWslPid\(/m, 'export function killWslPid('],
};
const slice = (s: number, e: number, name?: string) => {
  let code = lines.slice(s - 1, e).join('\n');
  if (name && FORCE_EXPORT[name]) {
    const [re, to] = FORCE_EXPORT[name];
    if (!re.test(code)) throw new Error(`FORCE_EXPORT 未命中：${name}（块变了？）`);
    code = code.replace(re, to);
  }
  return code;
};
const sha = createHash('sha256').update(src).digest('hex');

/** [名字, 起, 止]（1-based 含端点；来自 analyze-split.ts 的块表） */
const PROTOCOL: Array<[string, number, number]> = [
  ['sleep', 25, 25], ['unc', 28, 32], ['winToWsl', 33, 39], ['daemonScriptWsl', 40, 43],
  ['stateDirLinux', 44, 45], ['metaLinux', 46, 46], ['tokenLinux', 47, 53], ['launchLinux', 54, 54],
  ['logLinux', 55, 60], ['legacyMetaLinux', 61, 61], ['legacyTokenLinux', 62, 64],
  ['listDaemonSlots', 65, 81], ['readDaemonMeta', 82, 94], ['readDaemonToken', 95, 108],
  ['readDaemonRecord', 109, 135], ['readDaemonLogTail', 136, 149], ['scanDaemonProcesses', 150, 195],
  ['wslRunScript', 196, 215], ['tcpCall', 236, 291], ['handshake', 292, 302], ['callDaemon', 303, 318],
  ['daemonPrompt', 977, 1012],
];
const LAUNCH: Array<[string, number, number]> = [
  ['killWslPid', 319, 328], ['launchScript', 329, 361], ['SYSTEMD_LAUNCH_SCRIPT', 362, 378],
  ['systemdUnit', 379, 381], ['ensureStateDir', 382, 404], ['WRITE_LAUNCHER_SCRIPT', 405, 418],
  ['writeLauncherWsl', 419, 440], ['removeLauncher', 441, 449], ['launchDaemon', 450, 602],
  ['configCompat', 603, 618],
];
const LIFECYCLE: Array<[string, number, number]> = [
  ['removeMetaFiles', 216, 235], ['ownDaemonsOnPorts', 619, 624], ['recordForPid', 625, 641],
  ['ensureDaemon', 642, 854], ['waitForSlotGone', 855, 874], ['stopDaemon', 875, 943],
  ['stopAllDaemons', 944, 976], ['daemonSnapshot', 1013, 1039], ['daemonStatus', 1040, 1068],
];

/** 原有 31 个对外符号（薄 re-export 必须一个不少；`killWslPid`/`sleep` 是新增的**模块内**导出，不进这里）。 */
const PUBLIC = {
  protocol: ['unc', 'winToWsl', 'daemonScriptWsl', 'stateDirLinux', 'metaLinux', 'tokenLinux', 'launchLinux', 'logLinux', 'legacyMetaLinux', 'legacyTokenLinux', 'listDaemonSlots', 'readDaemonMeta', 'readDaemonToken', 'readDaemonRecord', 'readDaemonLogTail', 'scanDaemonProcesses', 'wslRunScript', 'tcpCall', 'handshake', 'callDaemon', 'daemonPrompt'],
  launch: ['systemdUnit', 'writeLauncherWsl', 'removeLauncher', 'launchDaemon', 'configCompat'],
  lifecycle: ['ensureDaemon', 'stopDaemon', 'stopAllDaemons', 'daemonSnapshot', 'daemonStatus'],
} as const;

const header = (mod: string, what: string, imports: string[], note: string) => `/**
 * ${mod} —— T3 拆分自 \`daemon-client.ts\`（1068 行）${what}
 *
 * 来源：\`src/daemon-client.ts\` @ sha256 ${sha}（原文件已备份到
 * \`spike/verify/explorer-20261012/arch-t3/backup/daemon-client.${sha.slice(0, 8)}.ts.bak\`）。
 * **代码逐字搬移**（由 \`arch-t3/tools/apply-split.ts\` 按行区间生成），未改写实现。
 * ${note}
 *
 * 零构建纪律：只用可擦除语法；相对导入带 \`.ts\`；只引 \`node:\` 内置与同目录相对模块。
 */
${imports.join('\n')}`;

const P_IMPORTS = [
  "import { spawnSync } from 'node:child_process';",
  "import { readFileSync, readdirSync } from 'node:fs';",
  "import { fileURLToPath } from 'node:url';",
  "import net from 'node:net';",
];
const L_IMPORTS = [
  "import { spawn, spawnSync } from 'node:child_process';",
  "import { chmodSync, closeSync, mkdirSync, openSync, rmSync } from 'node:fs';",
  "import { daemonScriptWsl, launchLinux, stateDirLinux, unc, wslRunScript } from './daemon-protocol.ts';",
];
const C_IMPORTS = [
  "import { readdirSync, rmSync } from 'node:fs';",
  "import { callDaemon, handshake, legacyMetaLinux, legacyTokenLinux, listDaemonSlots, metaLinux, readDaemonLogTail, readDaemonRecord, scanDaemonProcesses, sleep, stateDirLinux, tokenLinux, unc } from './daemon-protocol.ts';",
  "import { configCompat, killWslPid, launchDaemon, removeLauncher } from './daemon-launch.ts';",
];

const mk = (mod: string, blocks: Array<[string, number, number]>, hdr: string, order?: string[]) => {
  const byName = new Map(blocks.map((b) => [b[0], b]));
  const seq = order ?? blocks.map((b) => b[0]);
  return hdr + '\n\n' + seq.map((n) => {
    const b = byName.get(n);
    if (!b) throw new Error(`块缺失: ${n} in ${mod}`);
    return `// ── 原 daemon-client.ts 第 ${b[1]}-${b[2]} 行 ──\n${slice(b[1], b[2], n)}`;
  }).join('\n\n') + '\n';
};

const protocolSrc = mk('daemon-protocol.ts', PROTOCOL,
  header('daemon-protocol.ts', '的 **协议/IO 层**：路径与槽位元数据、进程扫描、WSL 脚本执行、TCP 调用与握手。', P_IMPORTS,
    '导出：路径/元数据/slot 发现/扫描/`wslRunScript`/`tcpCall`/`handshake`/`callDaemon`/`daemonPrompt`；`sleep` 额外导出供 lifecycle 复用。'),
  PROTOCOL.map((b) => b[0]));

// launch 需要 `daemonScriptWsl`（launchScript 用它拼启动脚本）；killWslPid 供 lifecycle 复用
const launchSrc = mk('daemon-launch.ts', LAUNCH,
  header('daemon-launch.ts', '的 **启动层**：启动脚本/unit/systemd 主路径与 compat 回退、launcher 写盘与回收、版本兼容判定。', L_IMPORTS,
    '导出：`systemdUnit`/`writeLauncherWsl`/`removeLauncher`/`launchDaemon`/`configCompat`；`killWslPid` 额外导出供 lifecycle 复用（**不进** daemon-client 的对外面）。'),
  LAUNCH.map((b) => b[0]));

const lifecycleSrc = mk('daemon-lifecycle.ts', LIFECYCLE,
  header('daemon-lifecycle.ts', '的 **生命周期层**：ensure/stop/snapshot/status 与孤儿判定（`daemonSnapshot` 仍是唯一孤儿真相源）。', C_IMPORTS,
    '导出：`ensureDaemon`/`stopDaemon`/`stopAllDaemons`/`daemonSnapshot`/`daemonStatus`；`removeMetaFiles`/`ownDaemonsOnPorts`/`recordForPid`/`waitForSlotGone` 保持模块内私有。'),
  LIFECYCLE.map((b) => b[0]));

const clientSrc = `/**
 * daemon-client.ts —— **薄 re-export 层**（T3 拆分后）。
 *
 * 本文件原来承载全部守护控制面（1068 行）；现按关注点拆成三个模块，**对外导出面逐一保持不变**：
 *   · \`daemon-protocol.ts\`  —— 路径/元数据/扫描/脚本执行/TCP 与握手
 *   · \`daemon-launch.ts\`    —— 启动脚本、systemd 主路径与 compat 回退、launcher 回收
 *   · \`daemon-lifecycle.ts\` —— ensure / stop / snapshot / status（唯一孤儿真相源）
 *
 * 为什么不直接用新路径：\`src/explorer.ts\` / \`src/index.ts\` / \`src/selftest.ts\` 都从
 * \`./daemon-client.ts\` 取符号，保持这个入口可避免与 T4/T5 抢文件，也把"导出面"钉成契约。
 *
 * 拆分来源：\`daemon-client.ts\` @ sha256 ${sha}
 *   （备份：\`spike/verify/explorer-20261012/arch-t3/backup/daemon-client.${sha.slice(0, 8)}.ts.bak\`）
 * 纪律：只搬不改 —— \`stopDaemon\` 的 \`ok:false\` + \`notes\` 语义、\`mode\`/\`warning\` 与 F-38 告警文案、
 * 槽位/元数据文件布局**均未改动**（验收见 \`arch-t3/REPORT-daemon-split.md\`）。
 */

export {
${PUBLIC.protocol.map((s) => `  ${s},`).join('\n')}
} from './daemon-protocol.ts';

export {
${PUBLIC.launch.map((s) => `  ${s},`).join('\n')}
} from './daemon-launch.ts';

export {
${PUBLIC.lifecycle.map((s) => `  ${s},`).join('\n')}
} from './daemon-lifecycle.ts';
`;

mkdirSync(`${OUT}/backup`, { recursive: true });
if (!DRY) {
  copyFileSync(SRC, `${OUT}/backup/daemon-client.${sha.slice(0, 8)}.ts.bak`);
  writeFileSync(`${ROOT}/src/daemon-protocol.ts`, protocolSrc);
  writeFileSync(`${ROOT}/src/daemon-launch.ts`, launchSrc);
  writeFileSync(`${ROOT}/src/daemon-lifecycle.ts`, lifecycleSrc);
  writeFileSync(SRC, clientSrc);
}
console.log(`原文件 sha256 = ${sha}  size=${src.length}`);
console.log(`备份 → ${OUT}/backup/daemon-client.${sha.slice(0, 8)}.ts.bak ${DRY ? '(dry, 未写)' : ''}`);
for (const [f, s] of [['daemon-protocol.ts', protocolSrc], ['daemon-launch.ts', launchSrc], ['daemon-lifecycle.ts', lifecycleSrc], ['daemon-client.ts', clientSrc]] as Array<[string, string]>) {
  console.log(`${f}: ${s.split('\n').length} 行 / ${s.length} B`);
}
void statSync; void writeFileSync;
