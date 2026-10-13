/**
 * split-t5b.ts —— T5 host-split 切分器（最终版）。逐字搬运 + 边界断言；断言不过就什么都不写。
 * 区间（1-based，含）：
 *   index KEEP: [83..141] head | [739..868] apply head | [898..906] listDistros | [1460..1473] registerExplorer | [1475..1491] disposer
 *   wsl-io:     [142..152] DEFAULT_DESKTOP_RUNTIME_JSON+sleep+renderText | [154..246] WSL 文件/脚本工具 | [302..360] 版本一致性 | [362..583] 一次性 WSL 执行
 *   in-host:    [248..300] inHostAdapter | [869..896] getRuntime（包进 createInHostPool）
 *   tools:      [592..737] WebHost+sweepStaleRuntimes+openAppWindow | [907..1458] 七个 tools.register
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = process.argv[2]; // 原始（未拆分的）index.ts 快照 —— 必须来自 git HEAD，不能用已经拆过的
const DIR = process.argv[3]; // 输出目录（src/）
const lines = readFileSync(SRC, 'utf8').split('\n');
const at = (n) => lines[n - 1];
const L = (a, b) => lines.slice(a - 1, b).join('\n');
let bad = 0;
const need = (l, c, d) => { if (!c) { bad++; console.error(`✗ ${l}: ${d}`); } else console.log(`✓ ${l}`); };
/** 从 from 行起找第一处匹配的行号（用于"结束行"这类容易差一的边界）。 */
const findEnd = (from, re) => { for (let i = from; i < from + 40; i++) if (re.test(at(i))) return i; return -1; };

need('head [83..141]', at(83).includes('Stable Loader identity') && at(141).trim() === '', `${JSON.stringify(at(83))} / ${JSON.stringify(at(141))}`);
need('io [142..152]', at(142) === '/**' && L(142, 152).includes('DEFAULT_DESKTOP_RUNTIME_JSON') && at(152).includes('renderText ='), `${JSON.stringify(at(142))} / ${JSON.stringify(at(152))}`);
need('io [154..246]', at(154).includes('WSL 文件/脚本工具') && L(154, 246).includes('function writeScript') && L(154, 246).includes('async function reapWsl') && at(246) === '}', `${JSON.stringify(at(154))} / ${JSON.stringify(at(246))}`);
need('rt [248..300]', at(248) === '/**' && at(260) === 'function inHostAdapter(cfg) {' && at(300) === '}', `${JSON.stringify(at(248))} / ${JSON.stringify(at(300))}`);
need('io [302..360]', at(302).includes('版本一致性') && L(302, 360).includes('function resolveVersion') && at(360) === '}', `${JSON.stringify(at(302))} / ${JSON.stringify(at(360))}`);
need('io [362..583]', at(362).includes('一次性 WSL 执行') && L(362, 583).includes('function runWsl') && L(362, 583).includes('async function readLogViaWsl') && at(583) === '}', `${JSON.stringify(at(362))} / ${JSON.stringify(at(583))}`);
need('tools [592..737]', at(592).includes('远端 UI') && L(592, 737).includes('class WebHost') && L(592, 737).includes('async function sweepStaleRuntimes') && L(592, 737).includes('function openAppWindow') && at(737) === '}', `${JSON.stringify(at(592))} / ${JSON.stringify(at(737))}`);
need('apply [739..868]', at(739).includes('插件本体') && L(739, 868).includes('export function apply') && at(868) === '', `${JSON.stringify(at(739))} / ${JSON.stringify(at(868))}`);
// 753 = `const runtimes = new Map()`（拆分后由 in-host-runtime 的池持有 ⇒ 这一行必须从 index 去掉，否则重复声明）
need('runtimes 行 [753]', at(753).trim().startsWith('const runtimes = new Map()') && at(754).trim().startsWith('const webHosts'), `${JSON.stringify(at(753))} / ${JSON.stringify(at(754))}`);
need('getRuntime [869..896]', at(869).trim() === 'const getRuntime = async (key, cwdOverride) => {' && at(896) === '  };', `${JSON.stringify(at(869))} / ${JSON.stringify(at(896))}`);
const listEnd = findEnd(898, /^ {2}\};$/);
need(`listDistros [898..${listEnd}]`, at(898).trim().startsWith('const listDistros') && listEnd > 898, `${JSON.stringify(at(898))} / ${JSON.stringify(at(listEnd))}`);
need('tools [907..1458]', at(907).trim() === "ctx.inject(['tools'], (toolsCtx) => {" && at(1458) === '  });', `${JSON.stringify(at(907))} / ${JSON.stringify(at(1458))}`);
need('explorer [1460..1473]', at(1460).includes('人面（面板）host 数据面') && at(1473).trim() === '});', `${JSON.stringify(at(1460))} / ${JSON.stringify(at(1473))}`);
need('disposer [1475..1491]', at(1475).includes('插件卸载时回收常驻进程') && at(1491) === '}', `${JSON.stringify(at(1475))} / ${JSON.stringify(at(1491))}`);
if (bad) { console.error(`\n断言失败 ${bad} 条 ⇒ 不写任何文件`); process.exit(2); }

const exp = (text, names) => {
  let out = text;
  for (const n of names) {
    let hit = false;
    for (const [from, to] of [
      [`\nfunction ${n}(`, `\nexport function ${n}(`],
      [`\nasync function ${n}(`, `\nexport async function ${n}(`],
      [`\nconst ${n} =`, `\nexport const ${n} =`],
      [`\nclass ${n} {`, `\nexport class ${n} {`],
    ]) { if (out.includes(from)) { out = out.split(from).join(to); hit = true; } }
    if (!hit && !new RegExp(`(^|\\n)export (async )?(function|const|class) ${n}\\b`).test(out)) { console.error(`✗ export ${n} 未命中`); bad++; }
  }
  return out;
};

// ── wsl-io.ts ───────────────────────────────────────────────────────────────
const wslIo = `/**
 * dsh-remote-wsl / wsl-io —— Windows ↔ WSL 的**低层 IO 原语** + 版本/pin 读写
 * （架构债 T5/task-44 从 index.ts **逐字搬运**，行为未改）。
 *
 * 装什么：脚本落盘/回收、登录 shell 环境前缀、按 PID 回收 WSL 侧进程、一次性执行、自有临时文件清扫、
 * 路径互转（\`wslpath\` 包装）、持久化日志兜底读取、以及 \`desktopVersion\`/\`readPin\`/\`writePin\`/\`resolveVersion\`。
 *
 * 纪律（与拆分前一致）：只用 \`node:\` 内置 + 仓库内相对 \`.ts\` 导入；脚本一律**落文件**再 \`bash <file>\`（不内联，
 * 否则 \`$VAR\`/引号在 \`pwsh → wsl.exe → bash\` 三层里会被吃掉）；本模块不 import 工具注册/explorer ⇒ 无环。
 *
 * @module dsh-remote-wsl/wsl-io
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { shellEnvSnippet } from './shell-env.ts';
import { desktopRuntimeCandidates, pickDesktopVersion } from './version.ts';
import { stateDirLinux, unc } from './daemon-client.ts';

${L(142, 152)}

${L(154, 246)}

${L(302, 360)}

${L(362, 583)}
`;

// ── in-host-runtime.ts ──────────────────────────────────────────────────────
const inHost = `/**
 * dsh-remote-wsl / in-host-runtime —— **宿主逃生舱**（\`backend='in-host'\`）的运行时池
 * （架构债 T5/task-44 从 index.ts 逐字搬运；架构债 T1 起**共用** \`sdk-runtime.ts\` 的唯一实现）。
 *
 * 语义（与拆分前一致，见 README「常驻守护」）：运行时由**本宿主进程**持有 ⇒ 关客户端 = 丢会话；
 * 启动脚本由宿主拼（登录 shell env + \`.pid\`）落 \`/tmp\` 后 \`wsl.exe -d <distro> -- bash <脚本>\`；
 * 关停走 adapter 的 \`closeHook\`（\`reapWsl\` + 删脚本）—— 包装层被杀 ≠ Linux 侧退出。
 *
 * **必须 import 共享的 \`SdkRuntime\`**（禁止再复制实现）—— 差异全部经 \`runtimeAdapter\` 表达。
 *
 * @module dsh-remote-wsl/in-host-runtime
 */
import { spawn } from 'node:child_process';
import { SdkRuntime, allowBuildFlags, runtimeAdapter } from './sdk-runtime.ts';
import { readLogViaWsl, reapWsl, removeScript, shellPreamble, writeScript } from './wsl-io.ts';

${L(248, 300)}

/**
 * 建宿主侧运行时池：同一 \`key\` 复用同一个常驻运行时（多轮才有上下文 —— 上游拒绝跨进程复用 sessionId）。
 * 只在本宿主进程内有效；dispose 时由 index.ts 统一 \`close()\`（**不碰守护** —— 语义 #4）。
 */
export function createInHostPool({ config, version, warmInBackground }) {
  const runtimes = new Map(); // key -> SdkRuntime
${L(869, 896)}
  return { runtimes, getRuntime };
}
`;

// ── register-tools.ts ───────────────────────────────────────────────────────
const tools = `/**
 * dsh-remote-wsl / register-tools —— **七个工具**的注册面 + \`dsh web\` 宿主（T5/task-44 从 index.ts 逐字搬运）。
 *
 * 工具名/参数/输出形状与拆分前**逐字一致**：\`wsl_status\` / \`wsl_exec\` / \`wsl_agent\` / \`wsl_daemon\` /
 * \`wsl_open_ui\` / \`wsl_sync_version\` / \`wsl_path\`。本模块只持有**注册面**：状态（\`daemonState\`/\`runtimes\`/
 * \`webHosts\`/就绪判定/版本解析）全部经 \`deps\` 注入 —— "谁能起进程"仍只有 index.ts 一处决定。
 *
 * @module dsh-remote-wsl/register-tools
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { shellEnvSnippet, parseLocalhostForwarding } from './shell-env.ts';
import { desktopRuntimeCandidates, pickDesktopVersion, warmScript, dlxInventoryScript } from './version.ts';
import {
  ensureDaemon, stopDaemon, daemonPrompt, daemonStatus, daemonSnapshot, readDaemonMeta, stateDirLinux, unc,
} from './daemon-client.ts';
import { withModulePrefix } from './explorer.ts';
import { runWsl, wslPathConvert, sweepOwnTempFiles, readLogViaWsl, shellPreamble, writeScript, removeScript, sleep, renderText, resolveVersion, readPin, writePin } from './wsl-io.ts';

${L(592, 737)}

/**
 * 注册七个工具。\`deps\` 由 index.ts 的 apply 提供（拆分前它们是同一闭包里的自由变量；这里改用**同名解构**
 * ⇒ 下面七个 \`tools.register\` 的函数体逐字未改）。
 */
export function registerTools(deps) {
  const {
    ctx, config, version, resolveVersion, daemonState, logDaemon, machineLine, ensureDaemonReady,
    isTransportFailure, priorSessionFor, listDistros, getRuntime, runtimes, webHosts, ensureSwept, warmInBackground,
  } = deps;

${L(907, 1458)}
}
`;

// ── index.ts（只剩 wiring）──────────────────────────────────────────────────
const index = `/**
 * dsh-remote-wsl —— Cordis 插件入口（架构债 T5/task-44 拆分后**只留 wiring**）。
 *
 * 本文件现在只有三件事：
 *  1. \`DEFAULTS\`（配置面）与 \`name\`/\`inject\`；
 *  2. \`apply\` 里**创建状态 + 组装依赖**（守护状态、版本解析、运行时池、web host 表），并把它们交给
 *     \`registerTools\`（七个工具）与 \`registerExplorer\`（面板数据面）——**"谁能起进程/动槽位"只在这里决定**；
 *  3. disposer：只回收**本宿主进程**持有的东西（in-host 运行时 + web host + 自有 /tmp 一次性文件），
 *     **绝不杀守护**（语义 #4：守护持有的是远端会话，杀它 = 把跨宿主复用一起杀掉）。
 *
 * 拆出去的模块：\`wsl-io.ts\`（低层 WSL IO + 版本/pin）、\`in-host-runtime.ts\`（宿主逃生舱运行时池）、
 * \`register-tools.ts\`（七个工具 + \`dsh web\` 宿主）、\`explorer.ts\`（面板数据面）、\`daemon-client.ts\`（守护客户端）。
 *
 * @module dsh-remote-wsl
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { shellEnvSnippet } from './shell-env.ts';
import { warmScript, dlxInventoryScript, pickDesktopVersion } from './version.ts';
import {
  ensureDaemon, stopDaemon, daemonPrompt, daemonStatus, daemonSnapshot, readDaemonMeta, stateDirLinux,
} from './daemon-client.ts';
import { registerExplorer, withModulePrefix } from './explorer.ts';
import { resolveVersion, writePin, runWsl, sweepOwnTempFiles, shellPreamble, sleep } from './wsl-io.ts';
import { createInHostPool } from './in-host-runtime.ts';
import { registerTools, sweepStaleRuntimes } from './register-tools.ts';

${L(83, 141)}
${L(739, 752)}
${L(754, 868)}
  // ── 拆分接线（架构债 T5/task-44）────────────────────────────────────────────
  // 状态与判定**只在这里**创建（单一来源）；register-tools.ts 只拿注册面。
  const inHost = createInHostPool({ config, version, warmInBackground });
  const runtimes = inHost.runtimes; // 宿主逃生舱持有的运行时（dispose 时回收；**不含守护**）

${L(898, listEnd)}

  registerTools({
    ctx, config, version, resolveVersion, daemonState, logDaemon, machineLine, ensureDaemonReady,
    isTransportFailure, priorSessionFor, listDistros, getRuntime: inHost.getRuntime, runtimes, webHosts,
    ensureSwept, warmInBackground,
  });

${L(1460, 1473)}
${L(1475, 1491)}
`;

const outs = {
  'wsl-io.ts': exp(wslIo, ['DEFAULT_DESKTOP_RUNTIME_JSON', 'sleep', 'renderText', 'writeScript', 'removeScript', 'shellPreamble', 'reapWsl', 'desktopVersion', 'readPin', 'writePin', 'resolveVersion', 'runWsl', 'sweepOwnTempFiles', 'WSLPATH_SCRIPT', 'wslPathConvert', 'readLogViaWsl']),
  'in-host-runtime.ts': inHost,
  'register-tools.ts': exp(tools, ['WebHost', 'sweepStaleRuntimes', 'openAppWindow']),
  'index.ts': index,
};
if (bad) { console.error(`\n有 ${bad} 条失败 ⇒ 不写文件`); process.exit(2); }
for (const [f, t] of Object.entries(outs)) writeFileSync(`${DIR}/${f}`, t, 'utf8');
console.log('\n写出：' + Object.entries(outs).map(([f, t]) => `${f}=${t.split('\n').length} 行`).join(', '));
