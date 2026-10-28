/**
 * dsh-remote-wsl / wsl-io —— Windows ↔ WSL 的**低层 IO 原语** + 版本/pin 读写
 * （架构债 T5/task-44 从 index.ts **逐字搬运**，行为未改）。
 *
 * 装什么：脚本落盘/回收、登录 shell 环境前缀、按 PID 回收 WSL 侧进程、一次性执行、自有临时文件清扫、
 * 路径互转（`wslpath` 包装）、持久化日志兜底读取、以及 `desktopVersion`/`readPin`/`writePin`/`resolveVersion`。
 *
 * 纪律（与拆分前一致）：只用 `node:` 内置 + 仓库内相对 `.ts` 导入；脚本一律**落文件**再 `bash <file>`（不内联，
 * 否则 `$VAR`/引号在 `pwsh → wsl.exe → bash` 三层里会被吃掉）；本模块不 import 工具注册/explorer ⇒ 无环。
 *
 * 2026-10-22（task-1，对照 ZCode `packages/server/src/remote/wsl-backend.ts`）补三条纪律：
 *  · **spawn 前双检**：每个异步探测之后、真正 spawn 之前再问一次关停屏障（ZCode 的 assertNotDisposed）；
 *  · **短命子进程也归属 lifecycle**：`runWsl` 的 wsl.exe 一律 `lifecycle.track()`，settle 才等得到
 *    （handoff-2026-10-22 §5.3 遗留项）；
 *  · **输出解码**：NUL ⇒ utf16le 否则 utf8（ZCode decodeWslOutput），再归一去 NUL/BOM/CR
 *    （ZCode normalizeWslOutput）。原来按 utf8 流式读，UTF-16LE 的 wsl.exe 输出会夹满 NUL。
 *
 * @module dsh-remote-wsl/wsl-io
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { shellEnvSnippet } from './shell-env.ts';
import { buildGatewayShellLines, buildProxyEnvBlock } from './wsl-proxy.ts';
import { desktopRuntimeCandidates, pickDesktopVersion } from './version.ts';
import { stateDirLinux, unc } from './daemon-client.ts';
import { activeLifecycle } from './lifecycle.ts';
import { killIfOwnedScript, shq } from './shell-quote.ts';
import { targetProblem } from './config.ts';
import { NO_DISTRO_MESSAGE } from './target-detect.ts';

/**
 * **最后兜底**候选：老实现写死的那个用户路径。
 * 为什么还留着：它不再是主路径（主路径由 lib/version.js 的 desktopRuntimeCandidates 分层推导），
 * 留着只为"env 被裁剪的服务态启动"这一种情况仍能自证；在别的机器上它必然不存在，代价只是一次
 * 失败的 readFileSync。**任何新逻辑都不得再依赖它**（不可移植，正是 GAP-AUDIT §7 ①要修的问题）。
 */
export const DEFAULT_DESKTOP_RUNTIME_JSON =
  'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const renderText = (_args, value) => [{ type: 'text', text: String(value ?? '') }];

// ── wsl.exe 输出解码（参考 ZCode wsl-backend.ts:50-67）────────────────────────
//
// 实现已抽到 `src/wsl-output.ts`（2026-10-22 review：原来 explorer.ts 与 wsl-io.ts 各一份，
// 只靠探针断言行为一致 —— 那是重复实现）。这里 import 供本模块使用，并 re-export 保持导出面不变。

import { WSL_EXEC_MAX_BUFFER, decodeWslOutput, normalizeWslOutput, readWslOutput } from './wsl-output.ts';

export { WSL_EXEC_MAX_BUFFER, decodeWslOutput, normalizeWslOutput, readWslOutput };

/**
 * ZCode 的 double-check 纪律：**异步探测 / 配置解析之后、真正 spawn 之前**再问一次关停屏障。
 * 为什么要这一步：异步期间 dispose 屏障可能已经合上，迟到的 spawn 会落在 settle 的快照之外
 * （`packages/server/src/remote/wsl-backend.ts:330-337` 的 `assertNotDisposed()` 两次调用）。
 */
export const shutdownRejection = 'remote-wsl: 插件正在关停，拒绝新建 WSL 进程（E_SHUTDOWN）';

// ── WSL 文件/脚本工具 ────────────────────────────────────────────────────────

/**
 * 把 bash 脚本写到 WSL 侧文件再执行。
 * 为什么不用内联：`pwsh → wsl.exe → bash` 三层会吃掉引号/`$`；而 base64 内联又会**占用 stdin**
 * （SDK 协议要从 stdin 读）。写成文件则两者都躲开。
 */
export function writeScript(distro, body, ext = '.sh') {
  // 2026-10-28（零配置）：自动探测失败时 `cfg.distro` 是空串 —— 此时 UNC 会变成
  // `\\wsl.localhost\\\tmp\…`，裸 Node 报 `UNKNOWN: unknown error`。这里先把根因说清楚。
  if (!String(distro ?? '').trim()) throw new Error(NO_DISTRO_MESSAGE);
  const token = `${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const linuxPath = `/tmp/dsh-rwsl-${token}${ext}`;
  try {
    // F-30（2026-10-27 审查）：脚本内容含**完整用户命令**与代理/PATH 前缀，默认 0644 会让同机其它
    // WSL 用户在执行期间读到它（实测旧代码得到 -rw-r--r--）。显式 0600。
    writeFileSync(unc(distro, linuxPath), body, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    // 发行版名写错 / 该发行版没在跑时，裸 Node 报的是 `UNKNOWN: unknown error, open '\\wsl.localhost\<name>\tmp\...'`
    // —— 完全不可诊断（2026-10-10 对抗性审核实测）。这里换成可操作的错误。
    throw new Error(
      `remote-wsl: 无法写入发行版 "${distro}" 的 /tmp（UNC \\\\wsl.localhost\\${distro} 不可用）。` +
        `用 \`wsl -l -v\` 确认发行版名、并确认它在运行。原始错误: ${e && e.message ? e.message : String(e)}`,
    );
  }
  return linuxPath;
}

/** 连带清掉同名兄弟文件（`.pid` 记录、`.mjs` 兜底脚本），避免 /tmp 残留。 */
export function removeScript(distro, linuxPath) {
  if (!linuxPath) return;
  const base = linuxPath.replace(/\.(sh|mjs)$/, '');
  for (const p of new Set([linuxPath, `${base}.pid`, `${base}.mjs`, `${base}.sh`])) {
    try {
      unlinkSync(unc(distro, p));
    } catch {
      /* 不存在即跳过 */
    }
  }
}

/**
 * 生成 WSL 侧启动脚本的公共前缀：PATH 修复 + 代理探测 + 回环绕过。
 *
 * `withShellEnv` 只在**常驻进程**的启动脚本（SdkRuntime / WebHost）里为真。为什么一次性路径不给：
 *  1. 注入要额外起一个登录 shell（`bash -lc` + `timeout 5`），一次性命令每次调用都付这份延迟，
 *     而 `wsl_agent` / `wsl_open_ui` 只付一次；
 *  2. `wsl_exec` 的契约是"跑我写的这条命令"。把用户 profile 里的 env 掺进来，会让同一条命令
 *     在不同机器上得到不同结果，而调用方看不见这层变化。
 * 注入位置是硬要求：紧跟 `set -uo pipefail`，且在 PATH 补丁与代理探测**之前**（顺序依据见
 * lib/shell-env.js —— 本片段刻意不碰 PATH，覆盖调用方自己的顺序会打破 PATH 补丁的意图）。
 */
export function shellPreamble(cfg, { withShellEnv = false } = {}) {
  const shellEnv = withShellEnv ? shellEnvSnippet({ enable: cfg.useShellEnvironment }) : '';
  return `set -uo pipefail
${shellEnv}# 非登录 shell 的默认 PATH 不含 ~/.local/bin，而 mise 装在那里 ⇒ 必须显式补
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
# 代理先探测再使用：主机代理会停/重启，硬 export 会让模型调用全 TRANSPORT 失败
${buildGatewayShellLines()}
${buildProxyEnvBlock(cfg.proxyPort)}
export NO_PROXY=127.0.0.1,localhost,::1
`;
}

/**
 * 主动回收 WSL 侧进程。
 * 为什么必需：`child.kill()` 只杀掉 Windows 侧的 `wsl.exe` 包装层，**Linux 侧进程会变孤儿继续跑**
 * （2026-10-10 实测：一个探测用的 `dsh web --port 3082` 在包装层被杀后仍活了 1 小时）。
 * 启动脚本把自己（exec 后即 pnpm/node 主进程）的 PID 写进 .pid 文件，这里按 PID + 子进程回收。
 */
export async function reapWsl(cfg, scriptLinux) {
  if (!scriptLinux) return;
  try {
    const pidFile = scriptLinux.replace(/\.sh$/, '.pid');
    // 2026-10-27 审查 F-09：pid 是从文件读回来的，可能已被复用（运行时就绪前就崩溃/重启过）。
    // 判据与 `sweepStaleRuntimes` 同源（`killIfOwnedScript`）：环境里的唯一标记优先，旧脚本退回
    // 「cmdline 含 @deepseek-ai/dsh」；两者都不符就**只删残留文件、绝不发信号**。
    const mark = String(scriptLinux).replace(/^.*\//, '').replace(/\.sh$/, '');
    await runWsl(
      cfg,
      `if [ -f ${shq(pidFile)} ]; then
  PID=$(cat ${shq(pidFile)} 2>/dev/null || true)
  if [ -n "\${PID:-}" ]; then
${killIfOwnedScript('$PID', mark)}
  fi
  rm -f ${shq(pidFile)}
fi
true
`,
      { timeoutMs: 15000, allowDuringShutdown: true }, // 收尾命令：beginShutdown 之后仍必须能跑
    );
  } catch {
    /* 回收失败不能影响主流程（例如发行版已被关掉） */
  }
}

// ── 版本一致性（对应 vscode-server 的"按客户端版本供给"）──────────────────────

/**
 * 桌面 dsh 版本的真相源 —— 文件名/形状不变（`{version, source}`），但候选**不再是写死的路径**：
 * 分层顺序（显式配置 → env → 由 process.execPath 反推安装根 → env 拼出的默认安装路径）全部由
 * lib/version.js 的 `desktopRuntimeCandidates` 负责，这里只做"注入真 IO + 垫最后一条兜底"两件事。
 *
 * 为什么保留 `{version, source}` 形状：`resolveVersion` 的 pin 比较与 drift 语义完全建立在
 * `desktop.version` / `desktop.source` 上，换形状会把版本一致性（本插件最硬的那条保证）一起改掉。
 *
 * `pickDesktopVersion` 绝不抛：候选全坏 ⇒ `{version:null, source:null}`，由上层给人话诊断
 * （"读不到版本"不是异常，是"这个源不可用"）。
 */
export function desktopVersion(cfg) {
  const candidates = desktopRuntimeCandidates({
    env: process.env,
    execPath: process.execPath, // 桌面 host 的 execPath 就是 <安装根>\DeepSeek Harness.exe ⇒ 跟着自己的安装走
    configured: cfg.desktopRuntimeJson,
    existsSync, // 仅第 3 层的 `.exe` 兄弟目录判据用得到；不注入则该分支恒不命中
  });
  // 兜底垫底（去重：本机 LOCALAPPDATA 推导出的就是同一条，避免白读一次文件）
  if (!candidates.some((p) => p.toLowerCase() === DEFAULT_DESKTOP_RUNTIME_JSON.toLowerCase())) {
    candidates.push(DEFAULT_DESKTOP_RUNTIME_JSON);
  }
  return pickDesktopVersion({ candidates, readFileSync });
}

export function readPin(cfg) {
  try {
    return readFileSync(unc(cfg.distro, `${cfg.wslHome}/.dsh/.desktop-version-pin`), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writePin(cfg, version) {
  try {
    const p = unc(cfg.distro, `${cfg.wslHome}/.dsh/.desktop-version-pin`);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, version + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 本次要用的 dsh 版本 + 与 pin 的漂移情况。 */
export function resolveVersion(cfg) {
  const desktop = desktopVersion(cfg);
  const pin = readPin(cfg);
  const version = cfg.dshVersion || desktop.version || pin || null;
  return {
    version,
    desktopVersion: desktop.version,
    desktopSource: desktop.source,
    pin,
    drift: desktop.version && pin !== desktop.version ? { desktop: desktop.version, pin } : null,
  };
}

// ── 流收集 / 终止原因（F-32 / F-33）：纯函数，可在 Windows 侧离线单测 ──────────
//
// 为什么把这两段逻辑抠出来：它们原来埋在 `runWsl` 的 spawn 闭包里 —— 要验证"截断是否被标记"
// 与"124 到底是超时还是命令自己的退出码"，就只能真起 wsl.exe（Windows 侧还跑不了 bash）。
// 抠成纯函数后，`test/wsl-io-termination.test.ts` 直接 import 断言，不需要任何进程。

/**
 * 单条流（stdout / stderr 各算一条）的收集上限（字节）。
 * 超限后**保留头部、丢弃尾部**，但由 `truncated` 如实上报（F-32 之前是静默丢尾）。
 */
export const WSL_STREAM_MAX_BYTES = 200000;

/**
 * `exit` 之后等 stdio 真正关闭（`close`）的**静默窗口**（毫秒）：上游每来一块数据就重置一次。
 * 为什么需要：在 `exit` 里立刻结算，会把「还没派发完的尾部输出」当成完整结果交出去（F-32 的
 * 第二个静默丢尾口）；Node 文档明写 `exit` 触发时 stdio 流可能仍然打开。
 * 为什么是重置式：大输出（900KB 实测）收尾本身要时间，固定窗口可能在数据还在流时就到点。
 */
export const WSL_STDIO_DRAIN_MS = 30;

/**
 * 静默窗口的**总上限**（毫秒，从 `exit` 起算）。
 * 为什么必须有：用户脚本可能把后台进程留在同一个管道上（`sleep 20 & echo x`），那玩意儿不写数据
 * 也不退出 ⇒ 静默窗口会一直重置→结算被无限拖延→最后触发 timeoutMs 变成**假超时**。
 * 有这条上限，最坏情况是 `exit` 后再等 1s，绝不会把一次正常结束拖成超时。
 */
export const WSL_STDIO_DRAIN_MAX_MS = 1000;

/**
 * 把一块输出追加进收集器：**不超过上限**，并如实报告这一块是否被丢弃。
 *
 * 修的是 F-32 的两个面：
 *  1. 旧写法 `if (outBytes >= 200000) return;` 到达上限后**静默丢尾** —— 调用方把截断的输出当完整
 *     结果，最关键的尾部错误信息（报错几乎总在最后）无声消失；
 *  2. 不能用 `total >= limit` **反推**截断：一条完整输出正好 200000 字节（一个字都没丢）会被误报成
 *     "已截断"，于是人对"结果可信不可信"的判断直接失真。这里只在**真丢过字节**时置 `dropped`。
 *
 * 逐块保留：放不下整块时只留前缀，并回退到 UTF-8 字符边界（否则会解码出半个字符 → U+FFFD）。
 *
 * @param chunks 已收集的分片（`Buffer[]`；本函数**不改动**入参，保持纯函数）
 * @param total 已收集字节数
 * @param chunk 新到的分片（`Buffer` / `string`）
 * @param limit 上限（字节）；≤0 表示一个字节都不收
 * @returns `{ chunks, total, dropped }` —— `dropped` 为真表示**这一块**有字节被丢弃
 */
export function capAppend(chunks, total, chunk, limit) {
  const list = Array.isArray(chunks) ? chunks : [];
  const used = Math.max(Number(total) || 0, 0);
  const cap = Math.max(Number(limit) || 0, 0);
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
  if (buf.length === 0) return { chunks: list, total: used, dropped: false };
  const room = cap - used;
  // 已经满了（或上限为 0）：整块丢弃，但**必须报**
  if (room <= 0) return { chunks: list, total: used, dropped: true };
  if (buf.length <= room) return { chunks: [...list, buf], total: used + buf.length, dropped: false };
  // 放不下整块 ⇒ 只留前缀；若切点落在多字节字符中间（0b10xxxxxx 续接字节），回退到字符起始字节
  let cut = room;
  let guard = 0;
  while (cut > 0 && guard < 3 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
    guard += 1;
  }
  const kept = cut > 0 ? buf.subarray(0, cut) : null;
  return { chunks: kept ? [...list, kept] : list, total: used + (kept ? kept.length : 0), dropped: true };
}

/**
 * 一次执行的**终止原因**：由我们自己的标记决定，**绝不从退出码反推断**（F-33）。
 *
 * 为什么必须分开：旧实现用 `finish(124)` 表示超时、`finish(130)` 表示调用方中断，于是
 * 「命令自己 exit 124」（`timeout(1)` 的既有约定）「命令自己 exit 130」（Ctrl-C）与「插件把它杀了」
 * 在返回值里**完全一样**，调用方只能打印 `exit 124`，人和上层逻辑都判断不出到底谁的错。
 * 现在 `timedOut` / `aborted` 是独立布尔（只有 `runWsl` 的定时器与 abort 监听能置位），退出码
 * 只负责填 `exitCode` / `killedBySignal`。
 *
 * 判定优先级（`timedOut` > `aborted` > 退出码）：前两者是我们自己的动作，永远压过退出码。
 * 两者同时为真在 `runWsl` 里不可能发生（`finish` 只结算一次），这里排序只为让结果确定可测。
 *
 * @param {{ code?: number|null, signalCode?: string|null, timedOut?: boolean, aborted?: boolean }} t
 * @returns `{ exitCode, killedBy: 'timeout'|'abort'|'signal'|'exit', killedBySignal }`
 *   - `'exit'`    进程自己结束 —— **`exitCode` 是 124/130 也仍然是我们没杀它**；
 *   - `'timeout'` 我们的定时器到点（`exitCode` 沿用 124，老调用方按 124 判超时的路径不变）；
 *   - `'abort'`   调用方的 AbortSignal（`exitCode` 沿用 130）；
 *   - `'signal'`  子进程被信号结束（`killedBySignal` 给信号名；`exitCode` 沿用旧的 1 ——
 *                 老调用方把 `null` 当成功，这是 2026-10-23 真 child 探针修过的伪成功，不能退回）。
 */
export function terminationOf({ code = null, signalCode = null, timedOut = false, aborted = false } = {}) {
  // 我们的标记优先：命令自己 exit 124 且没超时 ⇒ 走到下面的 'exit' 分支（F-33 的根因就在这里）
  if (timedOut === true) return { exitCode: 124, killedBy: 'timeout', killedBySignal: null };
  if (aborted === true) return { exitCode: 130, killedBy: 'abort', killedBySignal: null };
  if (code !== null && code !== undefined) return { exitCode: code, killedBy: 'exit', killedBySignal: null };
  if (signalCode) return { exitCode: 1, killedBy: 'signal', killedBySignal: signalCode };
  // 既无退出码也无信号（Node 文档说 exit 事件二者必有一个，这里只兜住异常形态）：旧写法给 0，保留
  return { exitCode: 0, killedBy: 'exit', killedBySignal: null };
}

/**
 * 「**根本没有跑起来**」的终态（关停拒绝 / 脚本落盘失败）。字段形状与真跑完**完全一致**，
 * 免得调用方在两条提前返回路径上读到 `undefined` 再自己猜。
 * `killedBy: null` = 没有进程存在过，谈不上终止方式（这是唯一会给出 null 的路径）。
 */
function notStartedResult(exitCode, stderr) {
  return {
    exitCode,
    stdout: '',
    stderr,
    timedOut: false,
    aborted: false,
    truncated: { stdout: false, stderr: false },
    killedBy: null,
    killedBySignal: null,
  };
}

// ── 一次性 WSL 执行（远端终端 / 状态探测 / 日志兜底读取）──────────────────────

/**
 * 在 WSL 里跑一段 bash，收集 stdout/stderr/退出码 **与结构化的终止原因**。
 *
 * 三条纪律（2026-10-22 对照 ZCode）：
 *  · **spawn 前双检**：进入关停态后不再新建进程（返回 127 + 可读原因；本函数契约是"永不抛"）。
 *    `opts.allowDuringShutdown` 只给**收尾路径**用（reapWsl / 自有临时文件清扫）——它们必须在
 *    beginShutdown 之后继续跑，否则包装层被杀、Linux 侧进程会变孤儿。
 *  · **登记**：spawn 出来的短命 wsl.exe 也进 lifecycle，settle 才会等它退出（handoff §5.3）。
 *  · **解码**：先收 Buffer，收尾时按 NUL 判码 + 去 NUL/BOM/CR（ZCode normalizeWslOutput）。
 *
 * 返回形状（F-32 / F-33，2026-10-27）：
 *   `{ exitCode, stdout, stderr, timedOut, aborted, truncated:{stdout,stderr}, killedBy, killedBySignal }`
 *   · 旧字段 `exitCode/stdout/stderr` 语义**未变** ⇒ 老调用方不用改；
 *   · `timedOut`/`aborted` 只由**我们自己的**定时器与 abort 监听置位，不由 124/130 反推；
 *   · `truncated.*` 只在该流**真的丢过字节**时为真（到上限但没溢出 ⇒ false）；
 *   · `killedBy === null` 仅表示"没起进程"（关停拒绝 / 脚本落盘失败）。
 */
export function runWsl(cfg, script, opts = {}) {
  const lifecycle = activeLifecycle();
  if (!opts.allowDuringShutdown && lifecycle && lifecycle.isShuttingDown()) {
    return Promise.resolve(notStartedResult(127, shutdownRejection));
  }
  // 2026-10-28（零配置）：目标没解析出来（自动探测失败）时先给可读根因，不要走到
  // `wsl.exe -d ""` 那一步 —— 那时的报错只会在 UNC/spawn 层变成不可诊断的 errno。
  // 本函数契约是"永不抛"，所以照样用 127 + 可读原因，让每个工具都能把它原样回给调用方。
  const targetIssue = targetProblem(cfg);
  if (targetIssue) return Promise.resolve(notStartedResult(127, targetIssue));
  let file;
  try {
    file = writeScript(cfg.distro, script);
  } catch (e) {
    // 不抛：让调用方（wsl_exec / 状态探测 / 回收 / 日志兜底）拿到可读诊断而不是异常
    return Promise.resolve(notStartedResult(127, e.message));
  }
  // F-33 的第三个形态：**进来之前**就已取消的 signal。`addEventListener('abort')` 对"事件已经发生
  // 过的 signal"不会再触发，旧写法于是**照常 spawn 并把结果当"命令自己退出"**返回 —— 取消被静默
  // 吞掉，与"命令自己 exit 130"混为一谈。没有进程存在过 ⇒ `killedBy: null`，但 `aborted` 必须为真。
  if (opts.signal && opts.signal.aborted) {
    removeScript(cfg.distro, file);
    return Promise.resolve({ ...notStartedResult(130, ''), aborted: true });
  }
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', cfg.distro, '--exec', 'bash', file], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // 归属：短命子进程也登记（exit/error/close 任一会自动摘除）
    if (lifecycle) lifecycle.track(child);
    // 流收集状态：`capAppend` 是纯函数，这里只持有它返回的最新快照（total 与 chunks 必须同进同退）
    let out = { chunks: [], total: 0 };
    let err = { chunks: [], total: 0 };
    // F-32：截断**只按"真的丢过字节"**置位（`capAppend.dropped`），不拿 `长度 >= 上限` 反推 ——
    // 正好 200000 字节的完整输出不能被误报成截断。
    const truncated = { stdout: false, stderr: false };
    let done = false;
    // F-33：这两个标记只由**我们自己**的动作置位（定时器 / abort 监听），退出码不参与推断
    let timedOut = false;
    let aborted = false;
    // `exit` 之后的排空状态（理由见下面 `child.on('exit')` 处）
    let drainTimer = null;
    let drainDeadline = 0;
    /** 已收到 `exit` 时的退出码/信号 —— 排空窗口到点就用它们结算（不能再用 null）。 */
    let exitInfo = null;
    /** 重置静默窗口：上游每来一块数据就续一次，但总时长被 `drainDeadline` 卡住。 */
    const armDrain = () => {
      if (!exitInfo || done) return;
      if (drainTimer) clearTimeout(drainTimer);
      const left = Math.max(drainDeadline - Date.now(), 0);
      drainTimer = setTimeout(() => finish(exitInfo.code, exitInfo.signal), Math.min(WSL_STDIO_DRAIN_MS, left));
    };
    const onAbort = () => {
      aborted = true;
      finish(null, null);
    };
    const finish = (code, signalCode) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      try {
        opts.signal?.removeEventListener?.('abort', onAbort);
      } catch {
        /* ignore */
      }
      removeScript(cfg.distro, file);
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      // 被信号结束（settle 的 kill 分支）时 Node 给的是 `code=null + signal='SIGTERM'`：
      // 旧写法 `code ?? 0` 会把它记成**成功**（空 stdout + exitCode 0 = 伪成功，2026-10-23 真 child 探针
      // probe-real-child-settle 实测 codes=0,0 才发现）。`terminationOf` 里保留"信号 ⇒ exitCode 1"。
      const term = terminationOf({ code, signalCode, timedOut, aborted });
      resolve({
        exitCode: term.exitCode,
        stdout: readWslOutput(Buffer.concat(out.chunks)),
        stderr: readWslOutput(Buffer.concat(err.chunks)),
        timedOut,
        aborted,
        truncated: { stdout: truncated.stdout, stderr: truncated.stderr },
        killedBy: term.killedBy,
        killedBySignal: term.killedBySignal,
      });
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true; // 先置标记再收尾：finish 里读到的就是"我们杀它是因为超时"
          finish(null, null);
        }, opts.timeoutMs)
      : null;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => {
      const r = capAppend(out.chunks, out.total, c, WSL_STREAM_MAX_BYTES);
      out = { chunks: r.chunks, total: r.total };
      if (r.dropped) truncated.stdout = true;
      armDrain(); // `exit` 之后仍在来数据 ⇒ 尾部还没收完，续静默窗口
    });
    child.stderr.on('data', (c) => {
      const r = capAppend(err.chunks, err.total, c, WSL_STREAM_MAX_BYTES);
      err = { chunks: r.chunks, total: r.total };
      if (r.dropped) truncated.stderr = true;
      armDrain();
    });
    child.on('error', (e) => {
      // 自带诊断也走同一条收集路径（数量极少，但仍要保证 total 与 chunks 一致）
      const note = capAppend(err.chunks, err.total, Buffer.from(`\nremote-wsl: 无法启动 wsl.exe: ${e.message}`, 'utf8'), WSL_STREAM_MAX_BYTES);
      err = { chunks: note.chunks, total: note.total };
      if (note.dropped) truncated.stderr = true;
      finish(1, null);
    });
    // 为什么不在 `exit` 里立刻结算（F-32 的第二个静默丢尾口）：Node 文档明写「`exit` 触发时 stdio 流
    // 可能仍然打开」，此时 `Buffer.concat` 拿到的是**还没派发完**的尾部 —— 与 200KB 上限同一类缺陷
    // （最关键的尾部报错最先没），而且这次连长度都到不了上限，调用方无从察觉。`close` = 已退出且
    // stdio 已关闭，那才是全部输出。
    // 但 `close` 也可能**永不到来**：用户脚本把后台进程留在同一管道上（`sleep 20 & echo x`）时管道
    // 不关。所以 `exit` 之后起一个**有界排空窗口**：默认 30ms 静默即结算，每来一块数据续一次，
    // 总时长封顶 WSL_STDIO_DRAIN_MAX_MS —— 既把尾部收干净，又不会把正常结束拖成假超时。
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      drainDeadline = Date.now() + WSL_STDIO_DRAIN_MAX_MS;
      armDrain();
    });
    child.on('close', (code, signal) => finish(code, signal));
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
}

/**
 * 清掉**本进程自己**写在 /tmp 的一次性启动脚本（文件名里带 Windows 宿主 pid）。
 *
 * 为什么需要（task-9 #7）：常驻路径（`wsl_open_ui` 的 WebHost）在**运行期间**必然有
 * `/tmp/dsh-rwsl-<winpid>-*.sh/.pid`；正常 `stop:true`/插件卸载时 `removeScript` 会清掉，
 * 但宿主被硬杀（崩溃/任务管理器结束）时 disposer 根本不跑，文件就留下了。
 * 这里在每次 `stop`/卸载时按 **winpid** 再扫一遍 —— 名字里的 winpid 就是安全边界：
 * **只删自己的**，绝不碰别人的 /tmp 文件（禁全局 pkill / 禁删他人文件的纪律）。
 * 硬杀之后仍会留下的那一份，由下一次有副作用的调用的 `sweepStaleRuntimes` 按 winpid 判活清理。
 */
export async function sweepOwnTempFiles(cfg, winPid = process.pid) {
  try {
    await runWsl(
      cfg,
      // F-31（2026-10-27 审查）：旧实现 `ls -1 … | xargs -r rm -f` 按**空白分词**，文件名里有空格时
      // 第二段会被当成另一个路径递给 rm（含相对 `..` 可以越出 /tmp）。改成 find -exec（参数是路径，不分词）。
      `find /tmp -maxdepth 1 -name 'dsh-rwsl-${winPid}-*' -exec rm -f -- {} +
true
`,
      { timeoutMs: 15000, allowDuringShutdown: true }, // 收尾命令：beginShutdown 之后仍必须能跑
    );
  } catch {
    /* 清理失败不能影响主流程 */
  }
}

// ── 路径互转（Windows ↔ WSL）：包一层发行版自带的 wslpath ─────────────────────
//
// ★★ 安全硬要求：**path 是用户输入**，永远只作为 **argv 位置参数** 传进 bash，
//    绝不拼进脚本串。实测（2026-10-12，本机 debian-u8-1，见 _t12-host/out-A6-argv-forms.txt）：
//      · `wsl.exe -d <d> -e bash -c '<script>' _ <path>`  → **真 argv 透传**：含空格/引号/`$(id)`/反引号
//        的路径原样成为 bash 的 `$1`（`ARG=[...]` 逐字相等，`$(id)` 未被求值）；
//      · `wsl.exe -d <d> -- bash -c '<script>' _ <path>`  → **参数被丢弃**（`$1` 为空）⇒ 不得使用此形态
//        （这也解释了本仓 F4 那条教训：`--` 形态不是 argv-exec）；
//      · 把路径拼进脚本串（`... -c "wslpath -a -u '$path'"`）→ 脚本被外层 shell 破坏（exit 2）。
//    所以下面脚本里**只有固定的 `"$1"`**；路径经 `spawnSync` 的 args 数组进入，`windowsHide: true`
//    （不弹可见窗口）。
export const WSLPATH_SCRIPT = [
  'if ! command -v wslpath >/dev/null 2>&1; then echo "NOWSLPATH"; exit 4; fi',
  'p=$1',
  'o=$(wslpath -a -u -- "$p" 2>/dev/null); r=$?; printf "WSL %s %s\\n" "$r" "$(printf %s "$o" | base64 -w0)"',
  'o=$(wslpath -w -- "$p" 2>/dev/null); r=$?; printf "WIN %s %s\\n" "$r" "$(printf %s "$o" | base64 -w0)"',
].join('\n');

/**
 * 两种路径形态互转。只读、无副作用、不要求路径真实存在（`wslpath` 是纯字符串转换，已实测）。
 * 失败一律抛**可读**错误（空路径 / 发行版不存在或未运行 / `wslpath` 不可用），绝不静默回原串。
 */
export function wslPathConvert(cfg, rawPath, direction) {
  const path = typeof rawPath === 'string' ? rawPath : rawPath == null ? '' : String(rawPath);
  if (!path.trim()) throw new Error('remote-wsl: wsl_path 需要非空 path（Windows 路径或 WSL 路径）');
  if (path.includes('\0')) throw new Error('remote-wsl: wsl_path 的 path 含 NUL 字符，拒绝执行');
  // 2026-10-28（零配置）：目标解析失败时直接说根因；否则 `wsl.exe -d ""` 的报错不可诊断。
  const targetIssue = targetProblem(cfg);
  if (targetIssue) throw new Error(targetIssue);
  // 关停屏障（ZCode 的 spawn 前双检）：dispose 之后进来的工具调用不再起新的 wsl.exe。
  const lifecycle = activeLifecycle();
  if (lifecycle) lifecycle.assertAlive();

  const res = spawnSync('wsl.exe', ['-d', cfg.distro, '-e', 'bash', '-c', WSLPATH_SCRIPT, '_', path], {
    encoding: 'buffer', // NUL ⇒ utf16le（ZCode 判码），不再按 utf8 硬读
    maxBuffer: WSL_EXEC_MAX_BUFFER,
    windowsHide: true, // 纪律：不许弹可见窗口
    timeout: 20000,
  });
  const stderrTail = normalizeWslOutput(decodeWslOutput(res.stderr))
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/WSL|localhost|NAT|wsl:/i.test(s))
    .slice(-1)[0];
  const stdout = normalizeWslOutput(decodeWslOutput(res.stdout));

  if (res.error) {
    // F-57（2026-10-27 审查）：`spawnSync` 超时给的是 `error.code === 'ETIMEDOUT'`，旧实现一律报
    // "无法启动 wsl.exe" ⇒ 用户去查安装，而真实原因是 WSL 冷启动/超时。分开说清楚。
    const code = (res.error as any).code;
    if (code === 'ETIMEDOUT') {
      throw new Error(`remote-wsl: wsl_path 超时（20s 内 wsl.exe 未返回；WSL 可能在冷启动或卡住）。请稍后重试，或先 wsl_status 看发行版是否在运行。`);
    }
    throw new Error(`remote-wsl: wsl_path 无法启动 wsl.exe: ${res.error.message}`);
  }
  if (/^NOWSLPATH$/m.test(stdout) || res.status === 4) {
    throw new Error(
      `remote-wsl: 发行版 "${cfg.distro}" 里没有 wslpath（它由 WSL 提供，通常在任何发行版里都有；` +
        `若被裁剪请改用 wsl_exec 自行转换）`,
    );
  }
  const conv = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(WSL|WIN) (\d+) (\S*)$/.exec(line.trim());
    if (!m) continue;
    let value = '';
    try {
      value = Buffer.from(m[3], 'base64').toString('utf8');
    } catch {
      value = '';
    }
    conv[m[1]] = { rc: Number(m[2]), value };
  }
  if (!conv.WSL && !conv.WIN) {
    // 一个结果都拿不到 ⇒ 最常见的两类原因：发行版名不对/没在运行，或 wsl.exe 本身不可用
    throw new Error(
      `remote-wsl: 在发行版 "${cfg.distro}" 里执行 wslpath 失败（exit ${res.status}）` +
        `${stderrTail ? `：${stderrTail}` : ''}。请用 \`wsl -l -v\` 确认发行版名并确认它在运行。`,
    );
  }

  const looksWindows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
  const looksWsl = path.startsWith('/');
  const shape = looksWindows ? 'Windows' : looksWsl ? 'WSL' : 'unknown';
  const want = direction === 'to-wsl' ? ['to-wsl'] : direction === 'to-windows' ? ['to-windows'] : ['to-wsl', 'to-windows'];
  const picked = want.map((d) => ({ dir: d, ...(conv[d === 'to-wsl' ? 'WSL' : 'WIN'] ?? { rc: null, value: '' }) }));
  if (picked.every((p) => p.rc !== 0)) {
    throw new Error(
      `remote-wsl: wsl_path 转换失败（${picked.map((p) => `${p.dir} rc=${p.rc ?? '?'}`).join('、')}）` +
        `；path=${JSON.stringify(path)}。若路径形态与 direction 不匹配请改用另一个方向或省略 direction。`,
    );
  }
  // ★ 形态感知：`wslpath` 对**同形态**输入不是恒等变换 —— 实测 `wslpath -w 'D:\a\b'` 会把反斜杠当转义
  // 吃掉（`Dab`）、`wslpath -a -u /mnt/d/x` 会得到 `/mnt/d/mnt/d/x`。所以问错方向的**值**不回显
  // （但如实说明为什么），免得把垃圾当结果交给调用方。
  const meaningful = (d) => (d === 'to-wsl' ? shape !== 'WSL' : shape !== 'Windows') || shape === 'unknown';
  const lines = [`path: ${path}`, `direction: ${direction}（输入形态: ${shape}）`];
  for (const p of picked) {
    if (p.rc !== 0) {
      lines.push(`${p.dir.padEnd(11)}: (转换失败 rc=${p.rc})`);
    } else if (meaningful(p.dir)) {
      lines.push(`${p.dir.padEnd(11)}: ${p.value}${shape !== 'unknown' ? '   <- 生效' : '   <- 生效（输入形态未知，按原样尝试）'}`);
    } else {
      lines.push(
        `${p.dir.padEnd(11)}: (不回显：输入已是 ${shape} 形态；wslpath 对同形态输入会把反斜杠/前缀当转义处理，` +
          `该值无意义。需要另一种形态请用 ${shape === 'Windows' ? 'to-wsl' : 'to-windows'}。)`,
      );
    }
  }
  // 实际执行的命令（逐条列全，不用 "a / b" 这种拼出来的假命令）
  lines.push('commands executed (path 走位置参数 argv，无字符串拼接):');
  for (const d of want) {
    const flag = d === 'to-wsl' ? 'wslpath -a -u -- "$1"' : 'wslpath -w -- "$1"';
    lines.push(`  wsl.exe -d ${cfg.distro} -e bash -c '${flag}' _ ${JSON.stringify(path)}`);
  }
  return lines.join('\n');
}

/**
 * 从持久化 session 日志取回正文（事件流偶发丢尾帧时的兜底）。
 * 必须交给 **WSL 侧 node**：日志是多帧 zstd，Windows 自带 node 24 只解第一帧（实测）。
 */
export async function readLogViaWsl(cfg, sessionId, cwd) {
  const mangled = `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`;
  const logPath = `${cfg.wslHome}/.dsh/sessions/${mangled}/${sessionId}/session.v4.jsonl.zstd`;
  const js = `import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
try {
  const raw = zstdDecompressSync(readFileSync(${JSON.stringify(logPath)})).toString('utf8');
  const msgs = raw.split('\\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type === 'assistant/message');
  const text = (msgs.length ? (msgs[msgs.length - 1].data.message.content || []) : [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('');
  process.stdout.write(JSON.stringify({ text }));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String(e && e.message) }));
}
`;
  const jsLinux = writeScript(cfg.distro, js, '.mjs');
  try {
    const res = await runWsl(
      cfg,
      `set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
mise exec -- node ${jsLinux} 2>/dev/null
`,
      { timeoutMs: 60000 },
    );
    const parsed = JSON.parse(res.stdout.trim() || '{}');
    return parsed.text && parsed.text.trim() ? parsed.text : null;
  } catch {
    return null;
  } finally {
    removeScript(cfg.distro, jsLinux);
  }
}
