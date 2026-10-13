/**
 * split-t5.ts —— 架构债 T5（host-split）：把 `src/index.ts` 切成
 *   wsl-io.ts（WSL IO 原语 + 版本/pin 读写） / in-host-runtime.ts（逃生舱运行时池） /
 *   register-tools.ts（七个工具 + WebHost） ，index.ts 只留 DEFAULTS + apply wiring + registerExplorer。
 *
 * 为什么用脚本切：要搬 ~1000 行，**逐字搬运**（不重打一遍）才没有抄写漂移；每个区间都带**边界断言**，
 * 断言不过就什么都不写（exit 2）并把实际边界打出来。搬完由调用方 import 冒烟。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = process.argv[2]; // src 目录
const SRC = `${DIR}/index.ts`;
const lines = readFileSync(SRC, 'utf8').split('\n');
const at = (n) => lines[n - 1]; // 1-based
const L = (a, b) => lines.slice(a - 1, b).join('\n');

let bad = 0;
const need = (label, cond, detail) => { if (!cond) { bad++; console.error(`✗ ${label}: ${detail}`); } else console.log(`✓ ${label}`); };
const has = (a, b, s) => L(a, b).includes(s);

// ── 边界断言 ────────────────────────────────────────────────────────────────
need('keep-head [83..146]', at(83).includes('Stable Loader identity') && at(146).trim() === '};', `83=${JSON.stringify(at(83))} 146=${JSON.stringify(at(146))}`);
need('io [143..152] 含 DEFAULT_DESKTOP_RUNTIME_JSON + renderText', has(143, 152, 'DEFAULT_DESKTOP_RUNTIME_JSON') && at(152).includes('renderText ='), `143=${JSON.stringify(at(143))} 152=${JSON.stringify(at(152))}`);
need('io [154..258] WSL 文件/脚本工具', at(154).includes('WSL 文件/脚本工具') && has(154, 258, 'function writeScript') && has(154, 258, 'async function reapWsl'), `154=${JSON.stringify(at(154))} 258=${JSON.stringify(at(258))}`);
need('inhost [260..300] inHostAdapter', at(260) === 'function inHostAdapter(cfg) {' && has(260, 300, 'runtimeAdapter(') && at(300) === '}', `260=${JSON.stringify(at(260))} 300=${JSON.stringify(at(300))}`);
need('ver [302..360] 版本一致性', at(302).includes('版本一致性') && has(302, 360, 'function resolveVersion') && at(360) === '}', `302=${JSON.stringify(at(302))} 360=${JSON.stringify(at(360))}`);
need('io [362..583] 一次性 WSL 执行', at(362).includes('一次性 WSL 执行') && has(362, 583, 'function runWsl') && has(362, 583, 'async function readLogViaWsl') && at(583) === '}', `362=${JSON.stringify(at(362))} 583=${JSON.stringify(at(583))}`);
need('rt [585..590] 常驻 agent 段注释', at(585).includes('常驻远端 agent'), `585=${JSON.stringify(at(585))}`);
need('rt [592..737] WebHost + sweep + openAppWindow', at(592).includes('远端 UI') && has(592, 737, 'class WebHost') && has(592, 737, 'async function sweepStaleRuntimes') && has(592, 737, 'function openAppWindow') && at(737) === '}', `592=${JSON.stringify(at(592))} 737=${JSON.stringify(at(737))}`);
need('apply-head [739..868]', at(739).includes('插件本体') && has(739, 868, 'export function apply') && at(868).trim() === '', `739=${JSON.stringify(at(739))} 868=${JSON.stringify(at(868))}`);
need('getRuntime [869..896]', at(869).trim() === 'const getRuntime = async (key, cwdOverride) => {' && at(896) === '  };', `869=${JSON.stringify(at(869))} 896=${JSON.stringify(at(896))}`);
need('listDistros [898..906]', at(898).trim().startsWith('const listDistros') && at(906) === '  };', `898=${JSON.stringify(at(898))} 906=${JSON.stringify(at(906))}`);
need('tools [907..1458]', at(907).trim() === "ctx.inject(['tools'], (toolsCtx) => {" && at(1458) === '  });', `907=${JSON.stringify(at(907))} 1458=${JSON.stringify(at(1458))}`);
need('explorer [1460..1473]', at(1460).includes('人面（面板）host 数据面') && at(1473).trim() === '});', `1460=${JSON.stringify(at(1460))} 1473=${JSON.stringify(at(1473))}`);
need('disposer [1475..1491]', at(1475).includes('插件卸载时回收常驻进程') && at(1491) === '}', `1475=${JSON.stringify(at(1475))} 1491=${JSON.stringify(at(1491))}`);
if (bad) { console.error(`\n边界断言失败 ${bad} 条 ⇒ 不写任何文件`); process.exit(2); }

// ── 组装新模块 ──────────────────────────────────────────────────────────────
const addExports = (text, names) => {
  let out = text;
  for (const n of names) {
    const res = [
      [`function ${n}(`, `export function ${n}(`],
      [`async function ${n}(`, `export async function ${n}(`],
      [`const ${n} =`, `export const ${n} =`],
      [`class ${n} {`, `export class ${n} {`],
      [`const ${n}:`, `export const ${n}:`],
    ];
    let hit = false;
    for (const [from, to] of res) {
      if (out.includes(`\n${from}`)) { out = out.split(`\n${from}`).join(`\n${to}`); hit = true; }
      else if (out.startsWith(from)) { out = to + out.slice(from.length); hit = true; }
    }
    if (!hit) { console.error(`✗ addExports: 没找到 ${n} 的声明`); bad++; }
  }
  return out;
};

const wslIo = `/**
 * dsh-remote-wsl / wsl-io —— Windows ↔ WSL 的**低层 IO 原语**（架构债 T5 从 index.ts 拆出，逐字搬运）。
 *
 * 装什么：脚本落盘/回收、登录 shell 环境前缀、按 PID 回收 WSL 侧进程、一次性执行、临时文件清扫、
 * 路径互转（wslpath 包装）、持久化日志兜底读取，以及**版本/pin 的读写**（它们本质也是 WSL 家目录下的文件 IO）。
 *
 * 纪律（与拆分前一致）：
 * · 只用 \`node:\` 内置模块 + 仓库内相对 \`.ts\` 导入（\`link:\` 安装解析不到裸包）；
 * · 路径/脚本一律走 **argv 位置参数**或落文件 + \`bash <file>\`，不做字符串内联（\`$VAR\`/引号会被吃掉）；
 * · 这里**不 import** 任何工具注册/exporer 逻辑 ⇒ 没有环，且可单测。
 *
 * @module dsh-remote-wsl/wsl-io
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { shellEnvSnippet, parseLocalhostForwarding } from './shell-env.ts';
import { desktopRuntimeCandidates } from './version.ts';
import { stateDirLinux, unc } from './daemon-client.ts';

${L(143, 152)}

${L(154, 258)}

${L(302, 360)}

${L(362, 583)}
`;
const wslIoNames = ['writeScript', 'removeScript', 'shellPreamble', 'reapWsl', 'runWsl', 'sweepOwnTempFiles', 'wslPathConvert', 'readLogViaWsl', 'DEFAULT_DESKTOP_RUNTIME_JSON', 'sleep', 'renderText', 'desktopVersion', 'readPin', 'writePin', 'resolveVersion', 'WSLPATH_SCRIPT'];

const inHost = `/**
 * dsh-remote-wsl / in-host-runtime —— **宿主逃生舱**（\`backend='in-host'\`）的运行时池
 * （架构债 T5 从 index.ts 拆出，逐字搬运；架构债 T1 起共用 \`sdk-runtime.ts\` 的唯一实现）。
 *
 * 语义（与拆分前一致，见 README「常驻守护」一节）：
 * · 运行时由**本宿主进程**持有 ⇒ **关客户端 = 丢会话**（这是逃生舱的代价，默认后端是守护形态）；
 * · 启动脚本由宿主拼（登录 shell env + \`.pid\`）落 \`/tmp\`，再 \`wsl.exe -d <distro> -- bash <脚本>\`；
 * · 关停走 \`adaptor.closeHook\`（\`reapWsl\` + 删脚本）—— 包装层被杀不代表 Linux 侧退出。
 *
 * **必须 import 共享的 \`SdkRuntime\`**（禁止再复制一份实现）—— 差异全部经 \`runtimeAdapter\` 表达。
 *
 * @module dsh-remote-wsl/in-host-runtime
 */
import { spawn } from 'node:child_process';
import { SdkRuntime, runtimeAdapter } from './sdk-runtime.ts';
import { allowBuildFlags } from './sdk-runtime.ts';
import { removeScript, reapWsl, readLogViaWsl, shellPreamble, writeScript } from './wsl-io.ts';

${L(260, 300)}

/**
 * 建一个宿主侧运行时池：同一个 \`key\` 复用同一个常驻运行时（多轮才有上下文 —— 上游拒绝跨进程复用 sessionId）。
 * 只在本宿主进程内有效；dispose 时由 index.ts 统一 \`close()\`（**不碰守护**）。
 */
export function createInHostPool({ config, version, warmInBackground }) {
  const runtimes = new Map(); // key -> SdkRuntime
${L(869, 896).split('\n').join('\n')}
  return { runtimes, getRuntime };
}
`;
// getRuntime 本体里的 `runtimes` / `version` / `config` / `warmInBackground` / `readLogViaWsl` / `inHostAdapter`
// 都已经在工厂作用域里（同名），因此**逐字搬运即可**。

const registerTools = `/**
 * dsh-remote-wsl / register-tools —— **七个工具**的注册面 + \`dsh web\` 宿主（架构债 T5 从 index.ts 拆出，逐字搬运）。
 *
 * 工具名/参数/输出形状与拆分前**逐字一致**（\`wsl_status\` / \`wsl_exec\` / \`wsl_agent\` / \`wsl_daemon\` /
 * \`wsl_open_ui\` / \`wsl_sync_version\` / \`wsl_path\`）。本模块**只持有注册面**：所有状态（\`daemonState\` /
 * \`runtimes\` / \`webHosts\` / 版本解析 / 就绪判定）都由 \`deps\` 由 index.ts 的 wiring 注入 ——
 * 这样"谁能起进程"这件事仍然只有一个地方决定（index.ts）。
 *
 * @module dsh-remote-wsl/register-tools
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withModulePrefix } from './explorer.ts';
import { readDaemonMeta, stateDirLinux } from './daemon-client.ts';
import { runWsl, wslPathConvert, removeScript, writeScript, sleep, renderText } from './wsl-io.ts';

${L(592, 737)}

/**
 * 注册七个工具。\`deps\` 由 index.ts 的 apply 提供（拆分前它们是同一个闭包里的自由变量，
 * 这里改用**同名解构** ⇒ 下面七个 \`tools.register\` 的函数体逐字未改）。
 */
export function registerTools(deps) {
  const {
    ctx,
    config,
    version,
    resolveVersion,
    daemonState,
    logDaemon,
    machineLine,
    ensureDaemonReady,
    isTransportFailure,
    priorSessionFor,
    listDistros,
    getRuntime,
    runtimes,
    webHosts,
    ensureSwept,
    warmInBackground,
  } = deps;

${L(907, 1458)}
}
`;

const indexBody = `import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { shellEnvSnippet, parseLocalhostForwarding } from './shell-env.ts';
import { pickDesktopVersion, warmScript, dlxInventoryScript } from './version.ts';
import {
  ensureDaemon,
  stopDaemon,
  daemonPrompt,
  daemonStatus,
  daemonSnapshot,
  readDaemonMeta,
  stateDirLinux,
} from './daemon-client.ts';
import { registerExplorer, withModulePrefix } from './explorer.ts';
import { resolveVersion, writePin, runWsl, sweepOwnTempFiles, sleep } from './wsl-io.ts';
import { createInHostPool } from './in-host-runtime.ts';
import { registerTools } from './register-tools.ts';

${L(83, 146)}
${L(739, 868)}
  // ── 拆分接线（架构债 T5）──────────────────────────────────────────────────
  // 状态与判定仍**只在这里**创建（单一来源）；register-tools.ts 只拿注册面。
  const inHost = createInHostPool({ config, version, warmInBackground });
  const runtimes = inHost.runtimes; // 宿主逃生舱持有的运行时（dispose 时回收；**不含守护**）

  registerTools({
    ctx,
    config,
    version,
    resolveVersion,
    daemonState,
    logDaemon,
    machineLine,
    ensureDaemonReady,
    isTransportFailure,
    priorSessionFor,
    listDistros,
    getRuntime: inHost.getRuntime,
    runtimes,
    webHosts,
    ensureSwept,
    warmInBackground,
  });

${L(898, 906)}
${L(1460, 1473)}
${L(1475, 1491)}
`;

writeFileSync(`${DIR}/wsl-io.ts`, addExports(wslIo, wslIoNames), 'utf8');
writeFileSync(`${DIR}/in-host-runtime.ts`, inHost, 'utf8');
writeFileSync(`${DIR}/register-tools.ts`, registerTools, 'utf8');
writeFileSync(`${DIR}/index.ts`, indexBody, 'utf8');
if (bad) { console.error(`addExports 有 ${bad} 条失败`); process.exit(2); }
console.log(`\n写出：wsl-io.ts=${wslIo.split('\n').length} 行, in-host-runtime.ts=${inHost.split('\n').length} 行, register-tools.ts=${registerTools.split('\n').length} 行, index.ts=${indexBody.split('\n').length} 行`);
