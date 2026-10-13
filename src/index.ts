/**
 * dsh-remote-wsl —— 把 WSL 发行版当作「远端执行宿主」的 DSH 插件（Remote-WSL for DSH）。
 *
 * ## 为什么是这个形状（而不是"让桌面壳连远端 host"）
 *
 * VS Code Remote-WSL 的做法是：Windows 只跑 UI，真正的 `vscode-server` 跑在 WSL 里，客户端连过去。
 * DSH **没有**这一步：桌面 Electron 壳的 host 是它从**本机打包运行时** spawn 出来的本地进程
 * （`dsh-desktop-host`），`hostUrl=ready.url`、`ws://127.0.0.1/*` 是硬过滤，也没有任何
 * `DSH_*`/flag 能指向远端（`--host 0.0.0.0` 被 CLI 明确拒绝）——2026-10-10 实测。
 *
 * 所以本插件不假装自己是"远程连接 UI"，而是把**同一件事的可用形态**做成一等公民：
 * 从 Windows 宿主侧驱动 WSL 那份 dsh，并把它需要的隔离（工具/MCP/skill/产出都在 WSL）与
 * **版本一致性**（跟随桌面版本）一起管起来。六个工具对应 VS Code 侧的概念：
 *
 *   · `wsl_status`        —— 连接/远端概况（发行版、桌面版本、pin、漂移、活着的运行时）
 *   · `wsl_exec`          —— 远端终端（在 WSL 里跑命令，cwd 是 Linux 路径）
 *   · `wsl_agent`         —— **常驻远端 agent**（WSL 自己的 skill/MCP/工具，SDK stdio JSON-RPC）
 *   · `wsl_daemon`        —— **远端会话生命周期**（status / start 幂等 / stop 显式结束 / restart 对齐版本）
 *   · `wsl_open_ui`       —— 远端 UI 窗口（WSL 跑 `dsh web`，Windows 开应用窗口）
 *   · `wsl_sync_version`  —— server 供应/版本对齐（对应 vscode-server 按客户端 commit 供给）
 *
 * ## 零运行时 `@deepseek-ai/*` 依赖（照 dsh-shadow 的约定，这是本地 link 插件能加载的前提）
 *
 * 用 `link:` 装进 profile 的插件，pnpm 不会装它的依赖，裸包名 `@deepseek-ai/...` 会
 * `failed to import`（2026-10-10 实测，本插件第一版就是这么挂的）。所有服务一律经
 * `ctx.get` / `ctx.inject` 读取，插件内部只用 Node 内置模块。
 *
 * ## 固化进来的三条实测教训
 *
 * 1. **代理先探测再使用**：主机代理会停/重启，硬 export 会让所有模型调用以 TRANSPORT 失败
 *    （实测：代理端口 connection refused 时，直连 api.deepseek.com 返回 401 = 可达）。
 * 2. **尾帧可能没有换行结尾**：按 `\n` 分帧的读取端会永远等不到最后一帧 ⇒ 完成信号
 *    （`turn/end`）不出现、调用挂死。静止窗口触发时先 flush 残余缓冲。
 * 3. **持久化日志是多帧 zstd**，而 Windows 自带 node 24 的 `zstdDecompressSync` 只解第一帧
 *    ⇒ 兜底读日志必须交给 WSL 侧的 node（26.x）。
 *
 * ## 能力边界（照抄上游事实，不在插件里假装有）
 *
 * · SDK 协议**无 cancel / 无 session-close**：放弃一轮 = 关掉运行时进程；
 * · **无 per-prompt 结果**：`session/prompt` 只回 `{messageId}`，完成判定必须客户端自定
 *   （本插件 = `turn/end` → `session.status:idle` → 静止窗口，三级兜底）；
 * · **跨进程复用同一 sessionId 被拒**（`-32603 session already exists`）⇒ 一个运行时配一个
 *   sessionId，运行时重启就换新 id；多轮只能发生在**同一个常驻运行时**内。
 *
 * @module dsh-remote-wsl
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
// 纯逻辑内核走**相对导入**（P1 拆出来的两个模块）。为什么必须是相对路径而不是包名：
// 本包以 `link:` 装进 profile，pnpm 不装它的依赖，任何 `@deepseek-ai/*` 或第三方裸包名都会
// `failed to import`（2026-10-10 实测）。`./shell-env.js` / `./version.js` 只用 node: 内置模块，
// 因此这样导入不引入任何解析风险。
import { shellEnvSnippet, parseLocalhostForwarding } from './shell-env.ts';
import { desktopRuntimeCandidates, pickDesktopVersion, warmScript, dlxInventoryScript } from './version.ts';
// 守护形态（默认）需要的五件事：启动/复用、显式停止、发一轮、读状态、读陈元数据。
// 全部是 Windows 侧动作 —— 就绪判据必须由 Windows 侧握手确认（见 daemon-client.ts 头部与 task-2 缺陷 #11）。
import {
  ensureDaemon,
  stopDaemon,
  daemonPrompt,
  daemonStatus,
  daemonSnapshot,
  readDaemonMeta,
  stateDirLinux,
} from './daemon-client.ts';
// 人面（侧栏面板）的 host 数据面：explorer.snapshot / openSession / daemon / fixPin。
// 它只**复用**下面这些已有实现（daemonSnapshot / ensureDaemon / stopDaemon / resolveVersion / writePin /
// listDistros / webHosts），不新开第二条扫描或孤儿判定路径 —— 见 explorer.ts 头部"分层"与 §8.6 同源纪律。
// `withModulePrefix`：F-38 同族收口（task-22）—— 上游 `ensureDaemon` 的聚合错误在组合条件下**已含** `remote-wsl:`
// 且落在**句中**（`远端守护… —— remote-wsl: …`），直接再拼一次就会出两份标记；helper 用 `includes` 守卫
// （`startsWith` 对句中标记永远不命中）。
import { registerExplorer, withModulePrefix } from './explorer.ts';

/** Stable Loader identity. */
export const name = 'dsh-remote-wsl';

/** 服务依赖由 `apply` 内显式 `ctx.inject(['tools'], …)` 处理，故为空（同 dsh-shadow）。 */
export const inject = [];

const DEFAULTS = {
  distro: 'debian-u8-1',
  /** WSL 侧家目录（版本 pin 与 session 日志都在它下面）。 */
  wslHome: '/home/g',
  /** 远端 agent 的工作目录（Linux 绝对路径）。 */
  cwd: '/home/g',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  profile: 'sdk',
  /** 空 = 跟随桌面版本（读 primary-runtime/runtime.json 的 desktopVersion）。 */
  dshVersion: '',
  webPort: 3082,
  /** 运行时空闲多久后回收（毫秒）。 */
  idleTimeoutMs: 600000,
  /** 单次工具调用的墙钟上限（毫秒）。 */
  timeoutMs: 600000,
  /** 桌面 runtime.json 的显式路径（留空则分层推导：见 lib/version.js 的 desktopRuntimeCandidates）。 */
  desktopRuntimeJson: '',
  /**
   * 是否把 WSL 登录 shell 环境注入**常驻进程**的启动脚本（对位 VS Code `remote.WSL.useShellEnvironment`）。
   * 默认 true（同 VS Code：`!1!==get(...)`）。只作用于 `wsl_agent` / `wsl_open_ui` 起的常驻进程，
   * `wsl_exec` 的一次性路径不注入（理由见 shellPreamble 与 wsl_exec 的 description）。
   */
  useShellEnvironment: true,
  /**
   * 检测到版本漂移（桌面版本 !== WSL pin）时，**后台**预热 WSL 侧的该版本。
   * 默认 true（对应 GAP-AUDIT §7 修正后的 #3：drift 自动 warm，但不得阻塞当前调用）。
   */
  backgroundWarm: true,
  /** 宿主机代理端口（用于"先探测再使用"）。 */
  proxyPort: 9910,
  /**
   * 远端 agent 的宿主形态：
   *  · `'daemon'`（默认）= 运行时由 **WSL 侧常驻守护**持有 ⇒ 客户端进程可来可走，跨进程/跨宿主复用上下文；
   *  · `'in-host'` = 旧形态（本宿主进程自己持有运行时）—— 逃生舱，保留原行为（含日志兜底）。
   */
  backend: 'daemon',
  /** 守护监听端口（127.0.0.1）。WSL 侧被占则 +1 探测；Windows 侧被占则由客户端换端口重试。 */
  daemonPort: 8731,
  /** 端口回退次数（Windows 命名空间里被别的属主占用时逐个试）。 */
  daemonPortTries: 3,
  /** 守护空闲回收（毫秒，默认 30 分钟）。**到期即回收运行时 ⇒ 上下文丢失**，不是"永久保持"。 */
  daemonIdleMs: 1800000,
  /** **寿命闸门**：守护在"无 key 且无客户端"持续这么久后自退（默认 10 分钟；0=关）。有会话时绝不触发。 */
  daemonLingerMs: 600000,
  /** 同一 key 的并发 prompt：守护内 FIFO 串行，这里是**等待位上限**，超出明确拒绝（上游 SDK 无 cancel）。 */
  daemonQueueLimit: 4,
  /** Windows 侧握手判据的超时（毫秒）。身份不符/端口被占必须在这个量级快速失败，绝不等 timeoutMs。 */
  daemonHandshakeTimeoutMs: 3000,
  /** 起守护后等"Windows 侧握手确认就绪"的上限（毫秒）。 */
  daemonStartTimeoutMs: 20000,
};

/** pnpm 拦截未审批的 lifecycle scripts；dsh 依赖的 native 包必须显式放行。 */
const ALLOW_BUILDS = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
];

/**
 * **最后兜底**候选：老实现写死的那个用户路径。
 * 为什么还留着：它不再是主路径（主路径由 lib/version.js 的 desktopRuntimeCandidates 分层推导），
 * 留着只为"env 被裁剪的服务态启动"这一种情况仍能自证；在别的机器上它必然不存在，代价只是一次
 * 失败的 readFileSync。**任何新逻辑都不得再依赖它**（不可移植，正是 GAP-AUDIT §7 ①要修的问题）。
 */
const DEFAULT_DESKTOP_RUNTIME_JSON =
  'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const renderText = (_args, value) => [{ type: 'text', text: String(value ?? '') }];

// ── WSL 文件/脚本工具 ────────────────────────────────────────────────────────

/** Linux 绝对路径 → 可从 Windows 直接读写的 UNC 路径。 */
function unc(distro, linuxPath) {
  return `\\\\wsl.localhost\\${distro}\\${linuxPath.replace(/^\//, '').replace(/\//g, '\\')}`;
}

/**
 * 把 bash 脚本写到 WSL 侧文件再执行。
 * 为什么不用内联：`pwsh → wsl.exe → bash` 三层会吃掉引号/`$`；而 base64 内联又会**占用 stdin**
 * （SDK 协议要从 stdin 读）。写成文件则两者都躲开。
 */
function writeScript(distro, body, ext = '.sh') {
  const token = `${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const linuxPath = `/tmp/dsh-rwsl-${token}${ext}`;
  try {
    writeFileSync(unc(distro, linuxPath), body, 'utf8');
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
function removeScript(distro, linuxPath) {
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
function shellPreamble(cfg, { withShellEnv = false } = {}) {
  const shellEnv = withShellEnv ? shellEnvSnippet({ enable: cfg.useShellEnvironment }) : '';
  return `set -uo pipefail
${shellEnv}# 非登录 shell 的默认 PATH 不含 ~/.local/bin，而 mise 装在那里 ⇒ 必须显式补
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
# 代理先探测再使用：主机代理会停/重启，硬 export 会让模型调用全 TRANSPORT 失败
GATEWAY=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
if [ -n "\${GATEWAY:-}" ] && timeout 3 bash -c "exec 3<>/dev/tcp/\${GATEWAY}/${cfg.proxyPort}" 2>/dev/null; then
  export NODE_USE_ENV_PROXY=1
  export HTTPS_PROXY="http://\${GATEWAY}:${cfg.proxyPort}"
  export HTTP_PROXY="http://\${GATEWAY}:${cfg.proxyPort}"
else
  echo "remote-wsl: 主机代理 \${GATEWAY:-?}:${cfg.proxyPort} 不可用 ⇒ 本次直连" >&2
fi
export NO_PROXY=127.0.0.1,localhost,::1
`;
}

const allowBuildFlags = () => ALLOW_BUILDS.map((p) => `--allow-build=${p}`).join(' ');

/**
 * 主动回收 WSL 侧进程。
 * 为什么必需：`child.kill()` 只杀掉 Windows 侧的 `wsl.exe` 包装层，**Linux 侧进程会变孤儿继续跑**
 * （2026-10-10 实测：一个探测用的 `dsh web --port 3082` 在包装层被杀后仍活了 1 小时）。
 * 启动脚本把自己（exec 后即 pnpm/node 主进程）的 PID 写进 .pid 文件，这里按 PID + 子进程回收。
 */
async function reapWsl(cfg, scriptLinux) {
  if (!scriptLinux) return;
  try {
    const pidFile = scriptLinux.replace(/\.sh$/, '.pid');
    await runWsl(
      cfg,
      `if [ -f ${pidFile} ]; then
  PID=$(cat ${pidFile} 2>/dev/null || true)
  if [ -n "\${PID:-}" ]; then
    pkill -TERM -P "$PID" 2>/dev/null || true
    kill -TERM "$PID" 2>/dev/null || true
  fi
  rm -f ${pidFile}
fi
true
`,
      { timeoutMs: 15000 },
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
function desktopVersion(cfg) {
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

function readPin(cfg) {
  try {
    return readFileSync(unc(cfg.distro, `${cfg.wslHome}/.dsh/.desktop-version-pin`), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writePin(cfg, version) {
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
function resolveVersion(cfg) {
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

// ── 一次性 WSL 执行（远端终端 / 状态探测 / 日志兜底读取）──────────────────────

/** 在 WSL 里跑一段 bash，收集 stdout/stderr/退出码。 */
function runWsl(cfg, script, opts = {}) {
  let file;
  try {
    file = writeScript(cfg.distro, script);
  } catch (e) {
    // 不抛：让调用方（wsl_exec / 状态探测 / 回收 / 日志兜底）拿到可读诊断而不是异常
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: e.message });
  }
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', cfg.distro, '--', 'bash', file], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      removeScript(cfg.distro, file);
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      resolve({ exitCode: code ?? 0, stdout, stderr });
    };
    const timer = opts.timeoutMs ? setTimeout(() => finish(124), opts.timeoutMs) : null;
    opts.signal?.addEventListener('abort', () => finish(130), { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      if (stdout.length < 200000) stdout += c;
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < 200000) stderr += c;
    });
    child.on('error', (e) => {
      stderr += `\nremote-wsl: 无法启动 wsl.exe: ${e.message}`;
      finish(1);
    });
    child.on('exit', (code) => finish(code));
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
async function sweepOwnTempFiles(cfg, winPid = process.pid) {
  try {
    await runWsl(
      cfg,
      `ls -1 /tmp/dsh-rwsl-${winPid}-* 2>/dev/null | xargs -r rm -f
true
`,
      { timeoutMs: 15000 },
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
const WSLPATH_SCRIPT = [
  'if ! command -v wslpath >/dev/null 2>&1; then echo "NOWSLPATH"; exit 4; fi',
  'p=$1',
  'o=$(wslpath -a -u -- "$p" 2>/dev/null); r=$?; printf "WSL %s %s\\n" "$r" "$(printf %s "$o" | base64 -w0)"',
  'o=$(wslpath -w -- "$p" 2>/dev/null); r=$?; printf "WIN %s %s\\n" "$r" "$(printf %s "$o" | base64 -w0)"',
].join('\n');

/**
 * 两种路径形态互转。只读、无副作用、不要求路径真实存在（`wslpath` 是纯字符串转换，已实测）。
 * 失败一律抛**可读**错误（空路径 / 发行版不存在或未运行 / `wslpath` 不可用），绝不静默回原串。
 */
function wslPathConvert(cfg, rawPath, direction) {
  const path = typeof rawPath === 'string' ? rawPath : rawPath == null ? '' : String(rawPath);
  if (!path.trim()) throw new Error('remote-wsl: wsl_path 需要非空 path（Windows 路径或 WSL 路径）');
  if (path.includes('\0')) throw new Error('remote-wsl: wsl_path 的 path 含 NUL 字符，拒绝执行');

  const res = spawnSync('wsl.exe', ['-d', cfg.distro, '-e', 'bash', '-c', WSLPATH_SCRIPT, '_', path], {
    encoding: 'utf8',
    windowsHide: true, // 纪律：不许弹可见窗口
    timeout: 20000,
  });
  const stderrTail = String(res.stderr || '')
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/WSL|localhost|NAT|wsl:/i.test(s))
    .slice(-1)[0];
  const stdout = String(res.stdout || '').replace(/\0/g, '');

  if (res.error) {
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
async function readLogViaWsl(cfg, sessionId, cwd) {
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

// ── 常驻远端 agent：SDK 通道（stdio JSON-RPC 2.0）─────────────────────────────

/** assistant/message 的正文：只取 message.content 里的 text 块（跳过 reasoning）。 */
function textOf(event) {
  const content = event?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 一个常驻的 WSL dsh SDK 运行时。**一个运行时一个 sessionId**：
 * 跨进程复用同一 id 会被服务端拒绝（`-32603 session already exists`，实测），
 * 所以多轮只能发生在本进程内；运行时一旦停掉，下次要换新 id。
 */
class SdkRuntime {
  constructor(cfg, version, key) {
    this.cfg = cfg;
    this.version = version;
    this.key = key;
    this.sessionId = `remote-wsl-${key}-${randomUUID()}`;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.events = [];
    this.stderrTail = '';
    this.closed = false;
    this.queue = Promise.resolve();
    this.turns = 0;
    this.idleTimer = null;
  }

  async start() {
    // 常驻进程 ⇒ 注入登录 shell 环境（用户 profile 里的 env 才进得来；一次性路径不注入，见 shellPreamble）
    const script = `${shellPreamble(this.cfg, { withShellEnv: true })}cd "${this.cfg.cwd}" || { echo "remote-wsl: cwd 不存在: ${this.cfg.cwd}" >&2; exit 2; }
# 记下 PID：exec 之后它就是 pnpm/node 主进程的 PID，供 reapWsl 主动回收
echo $$ > "\${0%.sh}.pid"
# 凭据走 ~/.dsh/.credentials.yaml 的 credentials seam，无需 export API key
exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} --profile ${this.cfg.profile}
`;
    this.script = writeScript(this.cfg.distro, script);
    this.child = spawn('wsl.exe', ['-d', this.cfg.distro, '--', 'bash', this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => this.pump(c));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c).slice(-8000);
    });
    this.exited = new Promise((res) => this.child.once('exit', (code) => res(code)));
    this.child.on('error', () => {
      this.closed = true;
    });
    await this.request('initialize', {
      cwd: this.cfg.cwd,
      provider: this.cfg.provider,
      model: this.cfg.model,
    });
  }

  request(method, params, timeoutMs = this.cfg.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('remote-wsl: 运行时已关闭'));
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`remote-wsl: ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  pump(chunk) {
    this.buf += chunk;
    this.drain();
  }

  drain() {
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.route(line);
    }
  }

  /** 尾帧可能没有换行结尾（实测丢帧症状）⇒ 静止时把残余缓冲当一帧处理。 */
  flushPartial() {
    if (!this.buf.trim()) return;
    this.buf += '\n';
    this.drain();
  }

  route(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'session.event' && msg.params?.sessionId === this.sessionId) {
      const ev = msg.params.event;
      this.events.push(ev);
      if (ev?.type === 'assistant/message') this.sawAssistant = true;
      if (ev?.type === 'turn/end') {
        this.completedBy = this.completedBy ?? 'turn/end';
        this.resolveTurn?.();
      } else this.armQuiet();
      return;
    }
    if (msg.method === 'session.status' && msg.params?.sessionId === this.sessionId) {
      if (msg.params.status === 'running') this.statusRunning = true;
      if (msg.params.status === 'idle' && this.statusRunning) {
        this.completedBy = this.completedBy ?? 'idle';
        this.resolveTurn?.();
      }
    }
  }

  /** 静止窗口：等 3s 没有任何事件就认为一轮结束（上游 README 明确要客户端自己定）。 */
  armQuiet() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.flushPartial();
      if (!this.sawAssistant && !this.graceUsed) {
        this.graceUsed = true; // 先给一次宽限，再放弃
        this.quietTimer = setTimeout(() => {
          this.flushPartial();
          this.resolveTurn?.();
        }, 20000);
        return;
      }
      this.resolveTurn?.();
    }, 3000);
  }

  /** 发一轮并等结果；同一运行时内可反复调用（上下文保持）。 */
  prompt(text) {
    const run = this.queue.then(() => this.#prompt(text));
    this.queue = run.catch(() => {}); // 串行化：失败不阻塞后续
    return run;
  }

  async #prompt(text) {
    if (this.closed) throw new Error('remote-wsl: 运行时已关闭（上一轮走到了兜底路径，请重试）');
    this.events = [];
    this.sawAssistant = false;
    this.completedBy = null;
    this.graceUsed = false;
    this.statusRunning = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.turnDone = new Promise((res) => {
      this.resolveTurn = res;
    });
    await this.request('session/prompt', {
      sessionId: this.sessionId,
      contentBlocks: [{ type: 'text', text }],
    });
    this.armQuiet();
    await Promise.race([this.turnDone, sleep(this.cfg.timeoutMs)]);
    if (this.quietTimer) clearTimeout(this.quietTimer);

    const msgs = this.events.filter((e) => e?.type === 'assistant/message');
    let finalText = msgs.length ? textOf(msgs[msgs.length - 1]) : '';
    if (!finalText.trim()) {
      // 事件流缺正文 ⇒ 只能停稳运行时（换新 id 重来），再从持久化日志取回
      await this.close();
      finalText = (await readLogViaWsl(this.cfg, this.sessionId, this.cfg.cwd)) ?? '';
      if (!finalText.trim()) {
        throw new Error('remote-wsl: 事件流与持久化日志都没有 assistant 正文；请重试（运行时已重启、id 会换新）');
      }
      this.completedBy = 'log-fallback';
    }
    this.turns += 1;
    this.armIdle();
    return {
      text: finalText,
      completedBy: this.completedBy ?? 'quiet',
      sessionId: this.sessionId,
      turn: this.turns,
      eventCount: this.events.length,
      runtimeRestarted: this.closed,
    };
  }

  armIdle() {
    if (this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, this.cfg.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.request('shutdown', undefined, 3000).catch(() => {});
    } catch {
      /* 已经走了 */
    }
    try {
      this.child.stdin.end();
    } catch {
      /* 已关闭 */
    }
    await Promise.race([this.exited, sleep(3000)]);
    try {
      this.child.kill();
    } catch {
      /* 已退出 */
    }
    await reapWsl(this.cfg, this.script); // 包装层被杀不代表 Linux 侧退出
    removeScript(this.cfg.distro, this.script);
  }
}

// ── 远端 UI：WSL 跑 `dsh web`，Windows 开应用窗口 ─────────────────────────────

class WebHost {
  constructor(cfg, version) {
    this.cfg = cfg;
    this.version = version;
    this.url = null;
    this.stderrTail = '';
  }

  async start() {
    if (this.child) return this.url;
    // 同 SdkRuntime：常驻进程才注入登录 shell 环境
    const script = `${shellPreamble(this.cfg, { withShellEnv: true })}cd "${this.cfg.wslHome}" || exit 2
echo $$ > "\${0%.sh}.pid"
exec mise exec -- pnpm dlx ${allowBuildFlags()} @deepseek-ai/dsh@${this.version} web --port ${this.cfg.webPort} --no-open
`;
    this.script = writeScript(this.cfg.distro, script);
    this.child = spawn('wsl.exe', ['-d', this.cfg.distro, '--', 'bash', this.script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c) => {
      this.stderrTail = (this.stderrTail + c).slice(-4000);
    });
    const url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`remote-wsl: web 未在 60s 内给出 URL\n${this.stderrTail}`)),
        60000,
      );
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => {
        buf += chunk;
        const m = buf.match(/https?:\/\/[^\s]*\?token=[A-Za-z0-9_-]+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      this.child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`remote-wsl: web 进程退出（exit ${code}）\n${this.stderrTail}`));
      });
    });
    this.url = url;
    this.child.stdout.removeAllListeners('data');
    this.child.stdout.resume(); // 起完就排空，避免管道回压
    return url;
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.url = null;
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    await reapWsl(this.cfg, this.script); // 必须：否则 WSL 里的 dsh web 会变孤儿继续占端口
    removeScript(this.cfg.distro, this.script);
    await sweepOwnTempFiles(this.cfg); // 本进程自有的 /tmp 一次性文件：按 winpid 收干净（task-9 #7）
  }
}

/**
 * 清理**陈旧/孤儿**的 in-host 运行时文件。
 *
 * 两类判据（P2 补齐第二类）：
 *  1. **属主宿主已死**（旧判据）：pid 文件名里带 Windows 宿主 PID（`dsh-rwsl-<winpid>-<ts>-<rand>.pid`），
 *     `process.kill(winPid, 0)` 判活 ⇒ 宿主崩了才清（不碰其它 DSH 窗口正在用的运行时）。
 *  2. **属主就是本进程、且文件里记的 linux 运行时 pid 已经死了**（新判据）：活宿主的陈旧文件不该拖到
 *     显式 `wsl_open_ui stop` / 卸载才收敛 —— "文件陈旧"的判据不该只看宿主死活。
 * 安全边界（Lead 定的纪律）：**绝不**碰"他人 winpid 且其宿主还活着"的文件；只对自己或已死的属主动手。
 */
async function sweepStaleRuntimes(cfg) {
  const listed = await runWsl(
    cfg,
    `for f in /tmp/dsh-rwsl-*.pid; do [ -f "$f" ] || continue; printf '%s %s\\n' "$f" "$(cat "$f" 2>/dev/null)"; done
true
`,
    { timeoutMs: 20000 },
  );
  const files = [];
  for (const line of listed.stdout.split('\n')) {
    const m = line.trim().match(/^(\/tmp\/dsh-rwsl-(\d+)-[^ ]*\.pid) (\d+)$/);
    if (!m) continue;
    files.push({ pidFile: m[1], winPid: Number(m[2]), linuxPid: Number(m[3]) });
  }
  if (!files.length) return 0;
  // 一次性批量探测 linux pid 是否还活着（每条一次 wsl.exe 太贵）
  const alive = new Set<number>();
  {
    const probes = files.map((f) => `kill -0 ${f.linuxPid} 2>/dev/null && echo "${f.linuxPid} alive" || true`).join('\n');
    const res = await runWsl(
      cfg,
      `${probes}
true
`,
      { timeoutMs: 20000 },
    );
    for (const line of res.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+) alive$/);
      if (m) alive.add(Number(m[1]));
    }
  }
  const hostAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e && e.code === 'EPERM'; // 存在但没权限 = 仍活着
    }
  };
  const stale = files.filter((f) =>
    f.winPid === process.pid ? !alive.has(f.linuxPid) : !hostAlive(f.winPid),
  );
  if (!stale.length) return 0;
  const script = stale
    .map(
      (s) => `pkill -TERM -P ${s.linuxPid} 2>/dev/null || true
kill -TERM ${s.linuxPid} 2>/dev/null || true
rm -f ${s.pidFile} ${s.pidFile.replace(/\.pid$/, '.sh')} ${s.pidFile.replace(/\.pid$/, '.mjs')}`,
    )
    .join('\n');
  await runWsl(cfg, `${script}
true
`, { timeoutMs: 20000 });
  return stale.length;
}

/** 在 Windows 侧把 URL 开成"应用窗口"（Edge/Chrome 的 --app），失败则退回默认浏览器。 */
function openAppWindow(url) {
  for (const browser of ['msedge', 'chrome']) {
    const res = spawnSync('cmd', ['/c', 'start', '', browser, `--app=${url}`], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (!res.error && res.status === 0) return 'app-window';
  }
  const fallback = spawnSync('cmd', ['/c', 'start', '', url], { windowsHide: true, stdio: 'ignore' });
  return !fallback.error && fallback.status === 0 ? 'default-browser' : 'failed';
}

// ── 插件本体 ─────────────────────────────────────────────────────────────────

/**
 * Mount the remote-WSL surface.
 * @param ctx agent-scoped services（只需 `tools`）
 * @param rawConfig 插件行的 config（未经 schema 归一，缺失键在此补默认值）
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  // 防御性判断：缺任一框架接口则整个插件无从工作（同 dsh-shadow 的前置判据）
  if (typeof ctx?.inject !== 'function' || typeof ctx?.get !== 'function') {
    throw new Error('remote-wsl: 宿主缺少 ctx.inject / ctx.get，插件无法挂载');
  }

  const runtimes = new Map(); // key -> SdkRuntime
  const webHosts = new Map(); // port -> WebHost
  const version = resolveVersion(config);
  let swept = null; // 孤儿清理只做一次（懒触发，不给宿主启动加成本）

  /** 首次工具调用时清一次孤儿运行时；失败不影响主流程。 */
  const ensureSwept = async () => {
    if (!swept) swept = sweepStaleRuntimes(config).catch(() => 0);
    await swept;
  };

  /** 已发起过后台预热的版本（同一版本只发起一次）。 */
  const warmed = new Set();

  /**
   * 版本漂移时**后台**预热 WSL 侧该版本 —— fire-and-forget：不 await、不抛、失败只打一行 stderr。
   *
   * 为什么必须是 fire-and-forget：预热是"为下一次调用省冷启"的优化，代价（pnpm dlx 冷启 5-7s、
   * 依赖网络/代理）本来就不该记在**当前**这次调用上；一旦 await，优化失败还会连带把工具调用
   * 变成失败（GAP-AUDIT §7 修正 #3：drift 自动 warm **不得**阻塞）。所以：
   *  · 触发点只放在**会用到该版本**的工具里（wsl_agent / wsl_open_ui / wsl_sync_version）；
   *    `wsl_status` 声明为只读、便宜，不在这里触发（读一次状态不该偷偷下载东西）。
   *  · 同一版本只发起一次：先同步入 Set 再起异步任务 ⇒ 并发调用也不会重复起；失败也不重试
   *    （否则每次调用都要白白打一次网络）。
   *  · 结果无论成败都落一行 stderr（可观测，且不进 stdout 以免污染工具返回值）。
   */
  const warmInBackground = (v) => {
    if (!config.backgroundWarm || !v || !v.drift || !v.version) return;
    if (warmed.has(v.version)) return;
    warmed.add(v.version); // 同步占位：并发调用不会重复起
    void (async () => {
      try {
        const res = await runWsl(config, `${shellPreamble(config)}${warmScript({ cfg: config, version: v.version })}`, {
          timeoutMs: 300000,
        });
        process.stderr.write(
          `remote-wsl: 后台预热 dsh@${v.version} ${
            res.stdout.includes('WARM-OK') ? 'ok' : `失败（exit ${res.exitCode}）`
          }\n`,
        );
      } catch (e) {
        // 到这一步已经是"没人 await 的分支"：连异常都不能漏出去（预热失败绝不能影响工具）
        process.stderr.write(`remote-wsl: 后台预热 dsh@${v.version} 失败: ${e?.message ?? String(e)}\n`);
      }
    })();
  };

  // ── 守护形态（默认）：运行时由 **WSL 侧常驻守护**持有 ──────────────────────────
  //
  // 语义 #1：关客户端 ≠ 会话结束。会话只在三种情况结束 —— 显式 stop（wsl_daemon action=stop）、
  // 空闲超时（daemonIdleMs，到期即丢上下文）、守护或运行时死亡。所以这里**不持有** runtimes，
  // 也不在 dispose 里杀守护（语义 #4）。
  const daemonState: {
    info: any;
    port: number | null;
    notes: string[];
    collisions: string[];
    lastSessionByKey: Map<string, string>;
  } = { info: null, port: null, notes: [], collisions: [], lastSessionByKey: new Map() };
  const logDaemon = (m: string) => process.stderr.write(`remote-wsl: ${m}\n`);

  /**
   * 机器可读行（F3）：四种动作（`start` / `restart` / `status` / `stop` / `stop --all`）**同一套字段**，
   * 缺项统一写 `-`。以前字段语义随动作变（`daemon=<pid>@<port>` vs `daemon=<slot>@<port>`、`version=-`），
   * 同一个 key 在不同动作里含义不同 ⇒ 脚本化会静默解析错。
   */
  const machineLine = (o: { slot?: unknown; pid?: unknown; port?: unknown; version?: unknown; extra?: string } = {}) =>
    `machine: slot=${o.slot ?? '-'} pid=${o.pid ?? '-'} port=${o.port ?? '-'} version=${o.version ?? '-'}` +
    (o.extra ? ` ${o.extra}` : '');

  /**
   * 确保"Windows 侧真实可达"的守护存在（幂等：已有就复用，绝不每次调用都起一个）。
   * 就绪判据来自 daemon-client 的 hello+token —— 守护自己打印的 `listening` 不算数（缺陷 #11）。
   */
  async function ensureDaemonReady({ restart = false } = {}) {
    if (!version.version) {
      throw new Error('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');
    }
    warmInBackground(version); // 漂移时后台预热，不阻塞本次启动
    const r = await ensureDaemon(config, { version: version.version, restart, log: logDaemon });
    daemonState.notes = r.notes ?? [];
    if (daemonState.notes.some((n) => /未通过|影子|占用|被拒|超时/.test(n))) daemonState.collisions = daemonState.notes;
    // task-22：上游 `r.error` 在组合条件下已含 `remote-wsl:`（落在句中）⇒ 用 `withModulePrefix` 守卫，
    // 不再无条件拼前缀（否则会得到两份 `remote-wsl:`）。非标记文案仍会被补上恰好一份。
    if (!r.ok) throw new Error(withModulePrefix(r.error));
    daemonState.info = r.info;
    daemonState.port = r.port;
    return r;
  }

  /**
   * 传输层失败（守护不在 / 半死不活）—— 与"op 返回 ok:false"必须分开：
   * 后者运行时还活着，语义 #6 明令**不许**重启（重启 = 换 sessionId = 毁上下文）。
   */
  function isTransportFailure(r: { ok?: boolean; queueFull?: boolean; kind?: string }) {
    return (
      !r?.ok &&
      !r?.queueFull &&
      (r?.kind === 'refused' || r?.kind === 'closed' || r?.kind === 'error' || r?.kind === 'timeout')
    );
  }

  /**
   * 这一次调用**之前**已知的 sessionId：先看本进程记忆，再看守护陈元数据（跨宿主进程时靠它）。
   * P1：身份是 **key+cwd**（守护按 cwd 分条目）—— 不按 cwd 匹配会把"另一个 cwd 的会话"误当成自己的。
   */
  const priorSessionFor = (key: string, cwd?: string) => {
    const effCwd = cwd ?? config.cwd;
    const mem = daemonState.lastSessionByKey.get(`${key}\u0000${effCwd}`);
    if (mem) return mem;
    const rec = (readDaemonMeta(config)?.keys ?? []).find(
      (k: any) => k.key === key && (k.cwd ?? config.cwd) === effCwd,
    );
    return rec?.sessionId ?? null;
  };

  const getRuntime = async (key, cwdOverride) => {
    const existing = runtimes.get(key);
    if (existing && !existing.closed) return existing;
    if (!version.version) {
      throw new Error('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');
    }
    warmInBackground(version); // 漂移时后台预热，不阻塞本次启动
    // cwd 在**运行时创建时**生效（它决定会话 cwd 与启动工作目录）；同一 key 复用时不重建
    const effCfg = cwdOverride ? { ...config, cwd: cwdOverride } : config;
    const rt = new SdkRuntime(effCfg, version.version, key);
    runtimes.set(key, rt);
    await rt.start();
    return rt;
  };

  const listDistros = () => {
    const res = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf8', windowsHide: true });
    return (res.stdout || '')
      .split('\n')
      .map((s) => s.replace(/\0/g, '').trim())
      .filter(Boolean);
  };

  // 服务就绪后才注册（Cordis 保证 tools 就绪时才回调）
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');
    if (!tools) return;

    tools.register({
      name: 'wsl_status',
      description:
        'Report the WSL remote-host picture: available distros, the DSH desktop version this Windows install runs, the version pinned inside WSL, any drift between them, the dsh versions already materialized in the WSL pnpm dlx cache, the shell-environment injection switch, the localhostForwarding setting that the WSL2 port forwarding depends on, and the resident remote runtimes this plugin holds. Read-only and cheap; call it before blaming the remote side.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (_args, exec) => {
        const distros = listDistros();
        const v = resolveVersion(config);
        // 孤儿运行时诊断（只数，不杀；真正的清理在首次有副作用的调用上做）。
        // F4：**不走内联 `wsl.exe … -- bash -lc "<串>"`** —— 那条路不是 argv-exec，串会先经过发行版的
        // 默认登录 shell（本机 zsh）展开，`$VAR`/glob 在到达 bash 前就失真。这里走 runWsl（落文件 +
        // `bash <file>`），并用 `find … -print | wc -l` 而不是裸 glob（glob 未匹配时会给出"假 0"）。
        let pidFiles = '0';
        {
          const res = await runWsl(config, 'find /tmp -maxdepth 1 -name "dsh-rwsl-*.pid" -print | wc -l\n', {
            timeoutMs: 20000,
            signal: exec?.signal,
          });
          pidFiles = (res.stdout || '').trim() || '0';
        }
        // ── 一次性探测：WSL ip + WSL 里已物化的 dlx dsh 版本 ──────────────────────
        // 两件事合成**一次** wsl.exe 调用：wsl.exe 的启动开销（约 1s）比分段探测本身贵，
        // 用一行哨兵分隔两段 stdout，解析仍是逐字的（哨兵没出现就说明整段没跑到）。
        const MARK = '__REMOTE_WSL_DLX_MARK__';
        let ip = '(未探测)';
        let dlx = '(未探测)';
        if (distros.includes(config.distro)) {
          const res = await runWsl(
            config,
            `${shellPreamble(config)}hostname -I
echo ${MARK}
${dlxInventoryScript({ wslHome: config.wslHome })}`,
            { timeoutMs: 40000, signal: exec?.signal },
          );
          const lines = res.stdout.split('\n').map((s) => s.trim());
          const at = lines.indexOf(MARK);
          if (at >= 0) {
            ip = lines.slice(0, at).filter(Boolean).join(' ');
            const versions = lines.slice(at + 1).filter(Boolean);
            dlx = versions.length ? versions.join(', ') : '(none)';
          } else {
            // 哨兵缺失 ⇒ 脚本没跑到。这里**不能**报 "none"（那是"确认没装"的意思，会臆造事实）
            ip = `(探测失败: ${res.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''})`;
            dlx = '(探测失败)';
          }
        }

        // ── localhostForwarding：读两个配置文件的**原文**，判定交给 lib/shell-env.js 的纯函数 ──
        // 为什么读原文而不在这里写解析：INI 的段/键大小写、`;`/`#` 注释、重复键取第一条、布尔只认
        // true/false/1/0 —— 这些 WSL 自己的语义已在 shell-env.js 里对着 WSL 源码核过，读侧不该有第二份。
        // 读不到就报 (unknown)：配置读不出来时"转发开着"是猜测，而猜错会让调用方静默连不上。
        const readCfgText = (p) => {
          if (!p) return { text: undefined, why: '路径未知' };
          try {
            return { text: readFileSync(p, 'utf8') };
          } catch (e) {
            return { text: undefined, why: e?.code ?? 'unreadable' };
          }
        };
        const winCfg = readCfgText(process.env.USERPROFILE ? join(process.env.USERPROFILE, '.wslconfig') : '');
        const distroCfg = readCfgText(unc(config.distro, '/etc/wsl.conf'));
        const lf = parseLocalhostForwarding({ wslconfigText: winCfg.text, wslConfText: distroCfg.text });
        const readWhat = [winCfg.text !== undefined ? '.wslconfig' : null, distroCfg.text !== undefined ? '/etc/wsl.conf' : null]
          .filter(Boolean)
          .join(' + ');
        const lfLine =
          lf.value !== null
            ? `${lf.value}  <- ${lf.source}（networkingMode=mirrored 时该键被忽略）`
            : readWhat
              ? `(未设置；WSL 默认 = true)  <- 读过 ${readWhat}`
              : `(unknown)  <- .wslconfig ${winCfg.why}；/etc/wsl.conf ${distroCfg.why}`;
        // ── 守护可见性（语义 #4 / #5）──────────────────────────────────────────
        // 显示 pid/端口/version/keys；版本与桌面/pin 不一致时**只报警**，绝不自动杀守护
        // （自动杀 = 无声中断用户正在进行的会话）。换版本走显式 wsl_daemon action=restart。
        const dstat: any =
          config.backend === 'in-host'
            ? { ok: false, kind: 'in-host', error: 'in-host 后端不使用守护' }
            : await daemonStatus(config);
        let daemonLine: string;
        let daemonAlarm: string | null = null;
        const orphanDaemons: any[] = Array.isArray(dstat.orphans) ? dstat.orphans : [];
        if (dstat.ok) {
          const info = dstat.info ?? {};
          const ks: any[] = Array.isArray(info.keys) ? info.keys : [];
          daemonLine =
            `running pid=${info.daemonPid} actualPort=${info.port} slot=${dstat.slot} version=${info.version} ` +
            `uptime=${Math.round((info.uptimeMs ?? 0) / 1000)}s idleMs=${info.idleMs} lingerMs=${info.lingerMs} keys=${ks.length} ` +
            `[${ks.map((k) => `${k.key}(turn ${k.turns}${k.queued ? `,q${k.queued}` : ''}${k.runtimePid ? `,pid${k.runtimePid}` : ''})`).join(', ') || '(none)'}]`;
          // 漂移报警（task-9 #3）：**显式 config.dshVersion / 桌面版本 / wsl pin 三者都要比**。
          // 只比后两者会漏判：`dshVersion:'0.1.0-fake'` 而守护跑 0.2.0-rc.2 时曾完全没有报警。
          const expects: Array<{ label: string; value: string }> = [];
          if (config.dshVersion) {
            expects.push({ label: `显式 config.dshVersion ${config.dshVersion}`, value: String(config.dshVersion) });
          }
          if (v.desktopVersion) expects.push({ label: `桌面 ${v.desktopVersion}`, value: v.desktopVersion });
          if (v.pin) expects.push({ label: `wsl pin ${v.pin}`, value: v.pin });
          const bad = expects.filter((e) => info.version !== e.value);
          if (bad.length) {
            daemonAlarm =
              `守护持有的 dsh@${info.version} 与 ${bad.map((b) => b.label).join(' / ')} 不一致 —— ` +
              `不自动重启（避免无声中断正在进行的会话）；要换版本请显式执行 wsl_daemon action=restart（配合 backgroundWarm 很快）`;
          }
        } else {
          daemonLine = `not running（${dstat.kind}: ${dstat.error}）`;
        }
        return [
          `distros: ${distros.join(', ') || '(none)'}`,
          `target: ${config.distro}  wslHome=${config.wslHome}  cwd=${config.cwd}`,
          `wsl ip: ${ip}`,
          `shell env injection (useShellEnvironment): ${config.useShellEnvironment === false ? 'off' : 'on'}（只注入常驻进程 wsl_agent / wsl_open_ui；wsl_exec 的一次性路径不注入）`,
          `localhost forwarding: ${lfLine}`,
          `desktop dsh version: ${v.desktopVersion ?? '(unknown)'}${v.desktopSource ? `  <- ${v.desktopSource}` : ''}`,
          `version this plugin uses: ${v.version ?? '(unresolved)'}`,
          `wsl pin: ${v.pin ?? '(none)'}`,
          `drift: ${v.drift ? `YES (desktop ${v.drift.desktop} / pin ${v.drift.pin})` : 'no'}`,
          `dlx dsh versions in WSL: ${dlx}`,
          `backend: ${config.backend === 'in-host' ? 'in-host（逃生舱：运行时由本宿主进程持有，关客户端即丢会话）' : 'daemon（默认：运行时由 WSL 侧常驻守护持有，关客户端 ≠ 会话结束）'}`,
          `daemon: ${daemonLine}`,
          ...(daemonAlarm ? [`daemon drift: ⚠️ ${daemonAlarm}`] : []),
          `daemon idle/linger/queue: idleMs=${config.daemonIdleMs}（到期回收运行时 ⇒ 上下文丢失）/ lingerMs=${config.daemonLingerMs}（无 key 且无客户端持续这么久 ⇒ 守护自退）/ queueLimit=${config.daemonQueueLimit}（同 key 并发 FIFO，超出明确拒绝）`,
          `daemon ports: configured=${config.daemonPort}(+${config.daemonPortTries} 回退) actual=${dstat.ok ? dstat.info?.port : '(未运行)'}${dstat.ok && dstat.slot != null ? ` slot=${dstat.slot}` : ''}`,
          `daemon state dir (WSL): ${stateDirLinux(config)}（元数据**按槽位**：daemon.<slot>.json / daemon.<slot>.token，0600；日志 daemon.log；本插件不把守护的东西落 /tmp）`,
          ...(orphanDaemons.length
            ? [
                `daemon orphans: ⚠️ ${orphanDaemons.length} 个守护在跑但无元数据（${orphanDaemons.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 wsl_daemon action=stop all=true 回收`,
              ]
            : []),
          ...(daemonState.collisions.length ? [`daemon port notes: ${daemonState.collisions.join(' | ')}`] : []),
          `resident runtimes (in-host backend only): ${[...runtimes.entries()].filter(([, r]) => !r.closed).map(([k, r]) => `${k}(turn ${r.turns})`).join(', ') || '(none)'}`,
          `web hosts: ${[...webHosts.keys()].join(', ') || '(none)'}`,
          `pid files in WSL /tmp: ${pidFiles}（>0 表示可能有 in-host 孤儿运行时；首次有副作用的调用会清）`,
        ].join('\n');
      },
    });

    tools.register({
      name: 'wsl_exec',
      description:
        'Run a bash command inside the WSL distro (the remote terminal). The process, its filesystem and its tools live in WSL; cwd is a Linux path. Returns exit code, stdout and stderr. ' +
        'The script runs under `set -uo pipefail`, so a pipeline whose reader exits early (e.g. `yes | head -c 1000`) surfaces the writer\'s SIGPIPE as exit 141 — that is bash semantics, not a plugin failure. ' +
        'This one-shot path deliberately does NOT inject the login shell environment (see useShellEnvironment): it is a fresh `bash <script>` per call, and injecting would charge every call an extra login shell and let the caller\'s own profile silently change what an explicitly written command does. The long-lived processes behind wsl_agent / wsl_open_ui do get that injection.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Bash command line to run inside WSL.' },
          cwd: { type: 'string', description: `Linux working directory (default ${config.cwd}).` },
          timeoutSec: { type: 'number', description: 'Wall-clock limit in seconds (default 120).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const command = String(args?.command ?? '').trim();
        if (!command) throw new Error('remote-wsl: wsl_exec 需要非空 command');
        await ensureSwept();
        const cwd = args?.cwd ? String(args.cwd) : config.cwd;
        const res = await runWsl(
          config,
          `${shellPreamble(config)}cd "${cwd}" || { echo "remote-wsl: cwd 不存在: ${cwd}" >&2; exit 2; }
${command}
`,
          { timeoutMs: (Number(args?.timeoutSec) || 120) * 1000, signal: exec?.signal },
        );
        return `exit ${res.exitCode}\n--- stdout ---\n${res.stdout.slice(0, 100000)}--- stderr ---\n${res.stderr.slice(0, 20000)}`;
      },
    });

    tools.register({
      name: 'wsl_agent',
      description:
        'Delegate a task to the resident WSL-side dsh agent (dsh --profile sdk over stdio JSON-RPC), held by a resident daemon inside WSL. Its tools, MCP servers, skills and file writes all happen in WSL, and it runs the same dsh version as this Desktop install. ' +
        'Closing the client does NOT end the session: the runtime lives in the daemon, so a later call — even from a different DSH host process — continues the SAME session and remembers earlier turns. ' +
        'A session ends only when (a) the daemon is stopped explicitly (wsl_daemon action=stop), (b) it has been idle for `daemonIdleMs` (default 30 minutes) and the idle reaper collected the runtime, or (c) the daemon/runtime died. In cases (b) and (c) the next turn gets a NEW sessionId and the reply says the context was reset. ' +
        'Concurrent prompts on the same `key` are serialized FIFO inside the daemon; beyond `daemonQueueLimit` (default 4) waiting turns are rejected explicitly, because upstream has no cancel. ' +
        'The per-call `cwd` really takes effect: the daemon keeps one runtime per (key, cwd) pair, so a new cwd starts its own session (its own sessionId) while the same key+cwd keeps reusing the same runtime; the reply always reports the effective `cwd=` and warns if it differs from the requested one.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task for the WSL-side agent.' },
          followUps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional further turns on the SAME runtime, in order (context is preserved).',
          },
          key: { type: 'string', description: 'Runtime-pool key; same key = same resident runtime (default "default").' },
          cwd: {
            type: 'string',
            description: `Linux working directory for the remote session (default ${config.cwd}). Takes effect when the runtime for this key is created; a reused runtime keeps its own cwd.`,
          },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const task = String(args?.task ?? '').trim();
        if (!task) throw new Error('remote-wsl: wsl_agent 需要非空 task');
        const key = args?.key ? String(args.key) : 'default';
        const turns = [task, ...(Array.isArray(args?.followUps) ? args.followUps.map(String) : [])];

        // ── 逃生舱：旧形态（本宿主进程持有运行时）──────────────────────────────
        if (config.backend === 'in-host') {
          await ensureSwept();
          const rt = await getRuntime(key, args?.cwd ? String(args.cwd) : undefined);
          let old = null;
          for (const t of turns) {
            if (exec?.signal?.aborted) throw new Error('remote-wsl: 已取消');
            old = await rt.prompt(t);
          }
          const oldMeta = `backend=in-host session=${rt.sessionId} cwd=${args?.cwd ? String(args.cwd) : config.cwd} completedBy=${old.completedBy} turns=${rt.turns} dsh@${version.version}` +
            (version.drift ? ` drift=desktop ${version.drift.desktop}/pin ${version.drift.pin}` : '');
          return `${old.text}\n\n[remote-wsl: ${oldMeta}]`;
        }

        // ── 默认：守护形态 ────────────────────────────────────────────────────
        await ensureSwept(); // 只清旧形态留下的 /tmp 孤儿；守护自己不落 /tmp
        // P1：per-call cwd 现在真的生效 —— 走协议交给守护，守护按 **key+cwd** 分运行时条目
        // （不同 cwd ⇒ 不同 sessionId；同 key 同 cwd 仍复用同一个 ⇒ 跨宿主重连不受影响）。
        const wantCwd = args?.cwd ? String(args.cwd) : undefined;
        const sessionKey = `${key}\u0000${wantCwd ?? config.cwd}`;
        // 必须在 ensureDaemonReady **之前**取：守护已死时它会清掉陈元数据，
        // 之后再取就拿不到"上一次的 sessionId"，也就无法知道自己丢了上下文。
        const priorSession = priorSessionFor(key, wantCwd);
        let ensured = await ensureDaemonReady();
        let knownSession = priorSession;
        const notesBefore = ensured.notes ?? [];
        // 复用失败但元数据存在 ⇒ 之前那个守护（及其会话）已经不在了
        const suspectReset = notesBefore.some((n) => /被拒|超时|影子|握手失败/.test(n));
        let last: any = null;
        let contextReset = false;
        let recovered = false;
        for (const t of turns) {
          if (exec?.signal?.aborted) throw new Error('remote-wsl: 已取消');
          let r: any = await daemonPrompt(config, {
            port: ensured.port,
            token: ensured.token,
            key,
            text: t,
            cwd: wantCwd,
            timeoutMs: Number(config.timeoutMs),
          });
          if (isTransportFailure(r)) {
            // 语义 #10：守护不可达 ⇒ 自动起守护 + 重试**一次**（并且绝不静默换上下文）
            logDaemon(`prompt 传输失败(kind=${r.kind}) ⇒ 自动恢复守护并重试一次：${r.error ?? ''}`);
            ensured = await ensureDaemonReady();
            recovered = true;
            r = await daemonPrompt(config, {
              port: ensured.port,
              token: ensured.token,
              key,
              text: t,
              cwd: wantCwd,
              timeoutMs: Number(config.timeoutMs),
            });
          }
          if (r.sessionId && knownSession && r.sessionId !== knownSession) contextReset = true;
          if (r.sessionId) {
            knownSession = r.sessionId;
            daemonState.lastSessionByKey.set(sessionKey, r.sessionId);
          }
          last = r;
          if (!r.ok || contextReset) break;
        }

        const resetNotice = contextReset
          ? `⚠️ 远端会话已重置（守护或运行时重启过）：本次回答**不含**之前轮次的上下文，之前让它记住的内容已丢失（新 sessionId=${last?.sessionId ?? '?'}）。\n\n`
          : suspectReset && !knownSession
            ? `⚠️ 之前那个远端守护已不可达，已自动重启；若此前存在会话，其上下文已丢失（本轮是全新会话）。\n\n`
            : '';
        // P1 防回归：请求了 cwd 但守护回报的生效 cwd 不同 ⇒ 明确告知（绝不静默）
        const cwdNotice =
          wantCwd && last?.cwd && last.cwd !== wantCwd
            ? `⚠️ 请求的 cwd=${wantCwd} **未生效**，守护实际用的是 cwd=${last.cwd}。\n\n`
            : '';

        if (!last?.ok) {
          // 语义 #6：守护形态下**不换运行时**（换了就毁上下文），如实回报可重试
          const why = last?.queueFull ? '并发超出队列上限' : last?.retryable ? '本轮没有产出正文' : '本轮失败';
          return `${resetNotice}${cwdNotice}[remote-wsl: ${why}；运行时保持不动，可直接重试 retryable=${last?.retryable === true}] ${last?.error ?? '(no error)'}`;
        }

        const meta =
          `backend=daemon session=${last.sessionId} cwd=${last.cwd ?? wantCwd ?? config.cwd} completedBy=${last.completedBy} turns=${last.turns} runtimePid=${last.runtimePid} ` +
          `daemon=${ensured.info?.daemonPid}@127.0.0.1:${ensured.port} dsh@${ensured.info?.version}` +
          (recovered ? ' recovered=once' : '') +
          (contextReset ? ' contextReset=yes' : '') +
          (version.drift ? ` drift=desktop ${version.drift.desktop}/pin ${version.drift.pin}` : '');
        return `${resetNotice}${cwdNotice}${last.answer}\n\n[remote-wsl: ${meta}]`;
      },
    });

    tools.register({
      name: 'wsl_daemon',
      description:
        'Manage the resident WSL-side daemon that holds the remote dsh runtimes. ' +
        'action=status reports pid/actual-listening-port/version/keys without starting anything, and also reports ORPHAN daemons (processes still running with no metadata, found by scanning /proc cmdline for this plugin\'s daemon inside this plugin\'s state dir); ' +
        'action=start is idempotent (reuses a live daemon, never starts a second one); ' +
        'action=stop explicitly ends every remote session (context lost) — stopping the daemon is one of the only three ways a session ends, alongside the idle timeout (`daemonIdleMs`) and a daemon/runtime death; add all=true to also reap orphan daemons and every other slot (the recovery path when status lists orphans); ' +
        'action=restart is how you align the daemon with a new desktop dsh version. The plugin never kills a daemon on its own, because that would silently interrupt a session. ' +
        'The daemon also self-exits after `daemonLingerMs` with no keys and no clients. ' +
        'Every reply carries one stable machine-readable line whose fields never change meaning: ' +
        '`machine: slot=<slot> pid=<pid> port=<port> version=<version> [extras]` — parse it with ' +
        '`^machine: slot=(\\S+) pid=(\\S+) port=(\\S+) version=(\\S+)( .*)?$`; unknown/not-running fields are `-`. ' +
        '(The pre-F3 format `daemon=<pid>@<port>` is gone; external scripts must use the new one.)',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'start', 'stop', 'restart'],
            description: 'What to do (default status).',
          },
          all: {
            type: 'boolean',
            description:
              'With action=stop: reap EVERY slot plus orphan daemons running without metadata (identity-checked via /proc/<pid>/cmdline, restricted to this plugin\'s state dir).',
          },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args) => {
        const action = String(args?.action ?? 'status');
        if (action === 'status') {
          const s: any = await daemonStatus(config);
          const info0 = s.info ?? {};
          const ks0: any[] = Array.isArray(info0.keys) ? info0.keys : [];
          const orphans0: any[] = Array.isArray(s.orphans) ? s.orphans : [];
          if (!s.ok) {
            return [
              `daemon: not running（${s.kind}: ${s.error}）`,
              machineLine({ extra: `orphans=${orphans0.length}` }),
              `state dir (WSL): ${stateDirLinux(config)}（元数据按槽位 daemon.<slot>.json / daemon.<slot>.token，0600）`,
              ...(orphans0.length
                ? [
                    `Orphans: ⚠️ ${orphans0.map((o) => `pid${o.pid}@${o.port}`).join(', ')}（在跑但无元数据）—— 用 wsl_daemon action=stop all=true 回收`,
                  ]
                : []),
            ].join('\n');
          }
          const info = s.info ?? {};
          const ks: any[] = Array.isArray(info.keys) ? info.keys : [];
          const orphans: any[] = Array.isArray(s.orphans) ? s.orphans : [];
          return [
            `daemon: pid=${info.daemonPid} actualPort=${info.port} slot=${s.slot} version=${info.version} cwd=${info.cwd} profile=${info.profile}`,
            machineLine({
              slot: s.slot,
              pid: info.daemonPid,
              port: info.port,
              version: info.version,
              extra: `keys=${ks.length} orphans=${orphans.length}`,
            }),
            `uptime=${Math.round((info.uptimeMs ?? 0) / 1000)}s idleMs=${info.idleMs} lingerMs=${info.lingerMs} queueLimit=${info.queueLimit}`,
            `keys (${ks.length}): ${
              ks
                .map(
                  (k) =>
                    `${k.key} session=${k.sessionId} turns=${k.turns} runtimePid=${k.runtimePid} idleForMs=${k.idleForMs}${k.queued ? ` queued=${k.queued}` : ''}`,
                )
                .join(' | ') || '(none)'
            }`,
            ...(orphans.length
              ? [
                  `Orphans: ⚠️ ${orphans.length} 个守护在跑但无元数据（${orphans.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 wsl_daemon action=stop all=true 回收`,
                ]
              : []),
            `ready 判据: 本次调用由 Windows 侧 hello+token 握手核实（${s.ms}ms），不是守护自己的 listening 日志`,
            `state (WSL): ${stateDirLinux(config)}/daemon.<slot>.json（0600）、daemon.<slot>.token（0600），slot=${s.slot}`,
          ].join('\n');
        }
        if (action === 'stop') {
          const all = args?.all === true;
          const r: any = await stopDaemon(config, { log: logDaemon, all });
          daemonState.info = null;
          daemonState.port = null;
          daemonState.lastSessionByKey.clear();
          if (all) {
            const killed: any[] = Array.isArray(r.killed) ? r.killed : [];
            const remaining: any[] = Array.isArray(r.remaining) ? r.remaining : [];
            const stoppedN = Array.isArray(r.stopped) ? r.stopped.length : 0;
            const reapedN = (r.stopped ?? []).reduce((n: number, x: any) => n + (Array.isArray(x?.reaped) ? x.reaped.length : 0), 0);
            return [
              `daemon stop --all: slots=${stoppedN} killedOrphans=${killed.length}（${killed.map((k) => `pid${k.pid}@${k.port}`).join(', ') || '(none)'}）remainingOrphans=${remaining.length}`,
              machineLine({
                slot: 'all',
                extra: `stopped=${stoppedN} killed=${killed.length} orphans_left=${remaining.length} reaped=${reapedN}`,
              }),
              `⚠️ 所有远端会话的上下文随之丢失 —— "显式停止"是会话结束的三种方式之一。`,
            ].join('\n');
          }
          const reaped: any[] = Array.isArray(r.reaped) ? r.reaped : [];
          // F1：孤儿口径与 status 完全同源（daemonSnapshot）—— 别的槽位**有元数据的健康守护不算孤儿**
          const snap: any = await daemonSnapshot(config);
          const orphansLeft: any[] = Array.isArray(snap.orphans) ? snap.orphans : [];
          return [
            `daemon stopped（transport=${r.transport ?? 'none'}）; reaped ${reaped.length} runtime(s): ` +
              `${reaped.map((k) => `${k.key}(turn ${k.turns})`).join(', ') || '(none)'}`,
            machineLine({
              slot: r.slot,
              pid: r.pid,
              port: r.port,
              version: r.version,
              extra: `reaped=${reaped.length} orphans_left=${orphansLeft.length}`,
            }),
            ...(orphansLeft.length
              ? [
                  `Orphans: ⚠️ 仍有 ${orphansLeft.length} 个守护在跑但无元数据（${orphansLeft.map((o) => `pid${o.pid}@${o.port}`).join(', ')}）—— 用 action=stop all=true`,
                ]
              : []),
            `⚠️ 会话上下文随之丢失 —— "显式停止"是会话结束的三种方式之一。`,
          ].join('\n');
        }
        if (action !== 'start' && action !== 'restart') {
          throw new Error(`remote-wsl: wsl_daemon 不认识 action=${action}（可选 status|start|stop|restart）`);
        }
        const r = await ensureDaemonReady({ restart: action === 'restart' });
        if (action === 'restart') daemonState.lastSessionByKey.clear();
        return [
          `daemon ${action}: ok port=${r.port} pid=${r.info?.daemonPid} version=${r.info?.version} reused=${r.reused === true}`,
          machineLine({
            slot: r.slot,
            pid: r.info?.daemonPid,
            port: r.port,
            version: r.info?.version,
            extra: `reused=${r.reused === true}`,
          }),
          // F-38c（task-19）：启动方式是**机器可读**的一行（`machine:` 行的字段语义保持冻结，不动它）。
          // mode: 'systemd'（无窗、独立） / 'compat-detached'（保活、可能弹窗） / 'reused'（复用既有守护）
          `launch: mode=${r.mode ?? '-'} warning=${r.warning ? r.warning : 'null'}`,
          `notes: ${(r.notes ?? []).join(' | ') || '(none)'}`,
          `元数据 (WSL): ${stateDirLinux(config)}/daemon.<slot>.json（slot=${r.slot ?? r.port}）`,
        ].join('\n');
      },
    });

    tools.register({
      name: 'wsl_open_ui',
      description:
        'Serve the DSH Web UI from inside WSL and open it in a Windows app window. This is the supported stand-in for "connect the Desktop shell to a remote host": the Desktop shell cannot attach to a remote host (its host is spawned locally), but the browser client can, because it talks to whatever origin served the page. Returns the launch URL (it carries a per-process token). ' +
        'While this host runs, the plugin keeps one one-shot launch script in WSL /tmp named /tmp/dsh-rwsl-<winpid>-*.sh (plus its .pid) — <winpid> is THIS Windows process, so files are never shared with another host. stop=true (or unloading the plugin) deletes this process\'s own /tmp files; a stale file of THIS host is also converged by the next side-effectful call once the linux runtime pid recorded in its .pid is dead (no need to wait for stop/dispose), and files of another host are never touched while that host is alive.',
      parameters: {
        type: 'object',
        properties: {
          port: { type: 'number', description: `Port inside WSL (default ${config.webPort}).` },
          open: { type: 'boolean', description: 'Open an app window on Windows (default true).' },
          stop: { type: 'boolean', description: 'Stop the web host on this port instead of starting it.' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args) => {
        const port = Number(args?.port) || config.webPort;
        if (!args?.stop) await ensureSwept();
        if (args?.stop) {
          const h = webHosts.get(port);
          if (h) {
            await h.stop();
            webHosts.delete(port);
          }
          await sweepOwnTempFiles(config); // 没有注册中的 host 时也清一次自己的 /tmp 一次性文件
          return `stopped web host on port ${port}`;
        }
        if (!version.version) throw new Error('remote-wsl: 无法确定 dsh 版本');
        warmInBackground(version); // 漂移时后台预热，不阻塞 web host 启动
        let host = webHosts.get(port);
        if (!host) {
          host = new WebHost({ ...config, webPort: port }, version.version);
          webHosts.set(port, host);
        }
        const url = await host.start();
        const how = (args?.open ?? true) ? openAppWindow(url) : 'not-opened';
        return `${url}\n(opened: ${how})`;
      },
    });

    tools.register({
      name: 'wsl_sync_version',
      description:
        'Align the WSL side with this Desktop install: read the Desktop dsh version, compare it with the version pinned inside WSL, optionally warm the WSL package cache for that exact version, and repair the pin. Upstream has no version negotiation across hosts, and a mismatched package only disables plugins silently, so this check has to be explicit.',
      parameters: {
        type: 'object',
        properties: {
          warm: { type: 'boolean', description: 'Also materialize that exact version in WSL (slower first time, faster later).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        await ensureSwept();
        const v = resolveVersion(config);
        warmInBackground(v); // 漂移时后台预热（与下面显式 warm 相互独立：这里不阻塞、也不改 pin）
        const lines = [
          `desktop version: ${v.desktopVersion ?? '(unknown)'}${v.desktopSource ? `  <- ${v.desktopSource}` : ''}`,
          `wsl pin before: ${v.pin ?? '(none)'}`,
        ];
        if (args?.warm && v.version) {
          const res = await runWsl(
            config,
            // 与后台预热共用 lib/version.js 的 warmScript（"三坑"只写一处：--profile 必带、
            // 非登录 shell 的 PATH、--dump-config + WARM-OK 哨兵），这里只多拼运行时的 shellPreamble
            `${shellPreamble(config)}${warmScript({ cfg: config, version: v.version })}`,
            { timeoutMs: 300000, signal: exec?.signal },
          );
          lines.push(
            `warm ${v.version}: ${
              res.stdout.includes('WARM-OK')
                ? 'ok'
                : `failed (exit ${res.exitCode}) ${res.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
            }`,
          );
        }
        const wrote = v.version ? writePin(config, v.version) : false;
        lines.push(`wsl pin after: ${v.version ?? '(unresolved)'}${wrote ? ' (written)' : ' (write failed)'}`);
        lines.push(`drift was: ${v.drift ? `YES (desktop ${v.drift.desktop} / pin ${v.drift.pin})` : 'no'}`);
        return lines.join('\n');
      },
    });

    // 第 7 个工具：路径互转。与 `dsh-wsl-tool` 的 `wsl-path` 是**同类能力**（那边用连字符，
    // 本插件沿用自己既有的 snake_case 命名）。纯字符串转换、只读、无副作用、不要求路径存在。
    tools.register({
      name: 'wsl_path',
      description:
        'Convert a path between Windows and WSL forms by wrapping the distro\'s own `wslpath` — the same capability as `dsh-wsl-tool`\'s `wsl-path`, under this plugin\'s existing snake_case naming. ' +
        'direction=to-wsl returns the WSL absolute path (`wslpath -a -u`), direction=to-windows returns the Windows path (`wslpath -w`), and the default `both` reports both forms, the exact command that ran, and which direction is effective for the input\'s shape. ' +
        'Read-only and cheap: it translates the string only — nothing is written, and the path does not have to exist. ' +
        'The path is passed as a positional argv argument (`-e bash -c \'wslpath -a -u -- "$1"\' _ <path>`), never interpolated into a shell string, so spaces, quotes and `$(...)` stay literal. ' +
        'Failures are explicit (empty path, unknown/not-running distro, missing wslpath); an unconvertible path is never silently echoed back.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Windows path (e.g. D:\\project\\net1 or \\\\wsl.localhost\\<distro>\\...) or WSL path (e.g. /mnt/d/project/net1).',
          },
          direction: {
            type: 'string',
            enum: ['to-wsl', 'to-windows', 'both'],
            description: 'Which conversion(s) to report (default both).',
          },
        },
        required: ['path'],
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args) => {
        const direction = args?.direction ? String(args.direction) : 'both';
        if (direction !== 'to-wsl' && direction !== 'to-windows' && direction !== 'both') {
          throw new Error(`remote-wsl: wsl_path 不认识 direction=${direction}（可选 to-wsl|to-windows|both）`);
        }
        return wslPathConvert(config, args?.path, direction);
      },
    });
  });

  // ── 人面（面板）host 数据面 ─────────────────────────────────────────────────
  // 数据面 = explorer.ts 的四个方法（名字见 EXPLORER_METHODS），传输层 = 它注册的
  // `POST/GET /remote-wsl/api`（同源 + 硬白名单；为什么不是设计稿 §4 的 `host.call` 见 explorer.ts 头部）。
  // 注入的全部是上面已有的实现，**没有新增扫描/判定逻辑**（daemon 段仍只来自 daemonSnapshot）。
  registerExplorer(ctx, {
    config,
    listDistros,
    resolveVersion,
    writePin,
    webHosts,
    // A1（task-23）：`explorer.addWorkspace` 要调 host 的 `workspaceRegistry`（T11 实测的服务名）。
    // 这里只给一个**取服务**的闭包：服务没挂上时返回 undefined，由 explorer.ts 侧给可读 503 + 一行降级日志。
    workspaceRegistry: () => (typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined),
  });

  // 插件卸载时回收常驻进程（idle 定时器之外的第二道保险）。
  // ⚠️ disposer 必须**可等待**：早前写成 `void rt.close()`（不 await），宿主/测试一退出就把清理
  // 截断，WSL 侧会留下 .sh/.pid（2026-10-10 实测）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => async () => {
      // 语义 #4：**不杀守护** —— 守护持有的就是"远端会话"，杀掉它等于把跨宿主复用一起杀掉。
      // 这里只回收**本宿主进程**持有的东西：in-host 逃生舱的运行时 + web host。
      // 要显式结束远端会话，请用 wsl_daemon action=stop（唯一有意的停止入口）。
      await Promise.allSettled([...runtimes.values()].map((rt) => rt.close()));
      await Promise.allSettled([...webHosts.values()].map((h) => h.stop()));
      await sweepOwnTempFiles(config); // 自有 /tmp 一次性文件（按 winpid）——不碰别人的
      if (config.backend !== 'in-host') {
        process.stderr.write('remote-wsl: 宿主退出；WSL 侧守护保持运行（关客户端 ≠ 会话结束）\n');
      }
    });
  }
}
