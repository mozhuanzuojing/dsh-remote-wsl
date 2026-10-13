/**
 * dsh-remote-wsl / version.js —— 「桌面版本真相源」与「WSL 侧供给片段」的纯函数内核。
 *
 * ## 为什么要把这几行从 index.js 抽出来
 *
 * 原实现（`lib/index.js` 的 `desktopVersion()`）把桌面 runtime.json 的路径**硬编码**成
 * `C:\Users\l\AppData\Local\Programs\DeepSeek Harness\...`（GAP-AUDIT §7 ①：
 * 「硬编码了用户路径，不可移植」）。硬编码的后果不是"报错"，而是**在别人的机器上静默
 * 解析不到版本**——`resolveVersion()` 返回 `version=null`，接着 `wsl_agent` / `wsl_open_ui`
 * 抛「无法确定 dsh 版本」，而用户完全看不出是路径写死的缘故。
 *
 * 所以这里改成**分层候选**：显式配置 → 环境变量 → 由 `process.execPath` 反推安装根 → 默认安装路径。
 * 桌面 host 的 execPath 就是 `<安装根>\DeepSeek Harness.exe`，因此"反推"这一层让插件
 * **跟着自己所在的安装走**，装到 D 盘、装成便携版、换用户名都不需要改代码。
 *
 * ## 为什么值得单独成文件
 *
 * 这些判断全是"输入 → 输出"，没有 IO、没有进程、没有 ctx：抽成纯函数后可以用假 env /
 * 假 execPath / 假 readFileSync 直接断言候选顺序与容错分支（真机只能证明 happy path）。
 * 本文件**只有四个导出**，且**导入本模块不产生任何副作用**（不读文件、不 spawn；
 * `ALLOW_BUILDS` 常量从 sdk-runtime.ts 复用，那边顶层同样无副作用）。
 *
 * ## 硬约定（违反就加载不了）
 *
 * ESM；只用 `node:` 内置模块；**不得 import 任何 `@deepseek-ai/*` 裸包**（link 安装的插件
 * 解析不到裸包，2026-10-10 实测 `failed to import`）。
 *
 * @module dsh-remote-wsl/version
 */

import { basename, dirname, join } from 'node:path';
// 架构债 T1（task-34）：`--allow-build` 清单**只留一份**（在 sdk-runtime.ts 里 export，这里 import）。
// 导入本模块仍然**不产生任何副作用**（sdk-runtime.ts 顶层只有常量与 class 声明，不读文件、不 spawn），
// 本文件的导出面也仍然只有四个函数。
import { ALLOW_BUILDS } from './sdk-runtime.ts';

/** `resources/runtime/primary-runtime/runtime.json` 相对安装根的尾段（集中一处，改一处即可）。 */
const RUNTIME_TAIL = ['resources', 'runtime', 'primary-runtime', 'runtime.json'];

/**
 * 片段里会被 bash 解释的取值只允许"无元字符"字符集。
 * 为什么必须卡：这些值最终要拼进 `bash -c` 文本，而 `--allow-build=` 这类长串里塞一个
 * `;` 或 `$( )` 就是注入面；卡住字符集比事后转义更不容易出错（也保证片段文本可被逐字断言）。
 */
const SAFE_TOKEN = /^[A-Za-z0-9@._+/-]+$/;
/** 路径额外允许空格与 `~`（Linux 家目录理论可含空格），但**不允许** `"`、`$`、反引号、换行。 */
const SAFE_PATH = /^[A-Za-z0-9@._+/\- ~]+$/;

/**
 * 校验一个将被拼进 bash 文本的取值；不合格就抛（宁可拒绝生成，也不生成一条会跑偏/被注入的命令）。
 * @param {unknown} value
 * @param {RegExp} re
 * @param {string} what 用于错误信息的人话描述
 * @returns {string}
 */
function safeToken(value, re, what) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error(`remote-wsl: ${what} 为空，拒绝生成片段`);
  if (!re.test(s)) throw new Error(`remote-wsl: ${what} 含会被 shell 解释的字符，拒绝生成片段: ${JSON.stringify(s)}`);
  return s;
}

/**
 * 读 env 里的一个键，**大小写不敏感**。
 * 为什么：Windows 的 `process.env` 本身大小写不敏感，但注入的假 env（单测）与
 * 某些启动器给的 env 可能写成 `LocalAppData`；这里统一抹平，免得"真机行、单测不行"。
 * @param {Record<string, unknown>} env
 * @param {string} name
 * @returns {string}
 */
function envGet(env, name) {
  if (!env || typeof env !== 'object') return '';
  const direct = env[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === want && typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 桌面 runtime.json 的**有序**候选路径。
 *
 * 顺序（先具体、后通用；先"用户说的"、后"我猜的"）：
 *   1. `configured`                          —— 插件 config 显式配置，用户意图最高
 *   2. `env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR` —— 框架/启动器注入的安装根
 *   3. 由 `execPath` 推导                     —— 插件跟着"自己所在的安装"走（可移植的关键一层）
 *   4. 默认安装路径                           —— 由 env 的 LOCALAPPDATA / ProgramFiles 拼出
 *
 * 推导规则（第 3 层）：
 *   · `execPath` 的 basename **以 node 开头**（CLI 场景，如 `.../dependencies/node/bin/node.exe`）
 *     ⇒ **跳过**：那是运行时自带的 node，不是桌面安装根，按它的目录反推会得到
 *     `.../bin/resources/runtime` 这种不存在的路径（2026-10-10 实测本机 execPath 正是这种）。
 *   · basename 去掉空格后含 `deepseekharness`（如 `DeepSeek Harness.exe`）⇒ 命中，取
 *     `<dirname>/resources/runtime/primary-runtime/runtime.json`。
 *   · 否则 basename 是 `*.exe` 时，还需 `existsSync(<dirname>/resources/runtime)` 为真才命中
 *     —— 这一条把"随便什么 exe 的旁边恰好有个 resources 目录"排除掉。`existsSync` 是**可选注入**：
 *     不注入时该分支恒不命中（函数保持纯，可单测），真机调用时传 `fs.existsSync`。
 *
 * 全程大小写不敏感去重（Windows 路径大小写不敏感，`C:\X` 与 `c:\x` 是同一个文件）。
 *
 * @param {{ env?: Record<string, unknown>, execPath?: string, configured?: string,
 *           existsSync?: ((p: string) => boolean) | null }} [input]
 * @returns {string[]} 候选路径（可能为空数组；顺序即尝试顺序）
 */
export function desktopRuntimeCandidates({ env = {}, execPath = '', configured = '', existsSync = null } = {}) {
  const out = [];
  /** 去重入队：同一路径（忽略大小写）只保留第一次出现的位置，**顺序即优先级**。 */
  const push = (p) => {
    if (typeof p !== 'string') return;
    const v = p.trim();
    if (!v) return;
    if (out.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    out.push(v);
  };

  // 1) 显式配置：用户写了就先用它（这条如果坏，才轮到猜出来的路径）
  push(typeof configured === 'string' ? configured : '');

  // 2) 环境变量：指向 primary-runtime 目录（不是 runtime.json 本身）
  const envDir = envGet(env, 'DSH_DESKTOP_PRIMARY_RUNTIME_DIR');
  if (envDir) push(join(envDir, 'runtime.json'));

  // 3) 由 execPath 推导安装根
  const exe = typeof execPath === 'string' ? basename(execPath) : '';
  const lower = exe.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  const isNodeRuntime = compact.startsWith('node'); // node / node.exe / node24.exe
  if (exe && !isNodeRuntime) {
    const dir = dirname(execPath);
    const named = compact.includes('deepseekharness');
    let siblingRuntime = false;
    if (!named && lower.endsWith('.exe') && typeof existsSync === 'function') {
      try {
        siblingRuntime = existsSync(join(dir, 'resources', 'runtime')) === true;
      } catch {
        siblingRuntime = false; // 探测失败按"不存在"处理，交给后面的候选
      }
    }
    if (named || siblingRuntime) push(join(dir, ...RUNTIME_TAIL));
  }

  // 4) 默认安装路径：从 env 拼，而不是写死某个用户名（写死 = 换台机器静默失效）
  const localAppData = envGet(env, 'LOCALAPPDATA');
  if (localAppData) push(join(localAppData, 'Programs', 'DeepSeek Harness', ...RUNTIME_TAIL));
  const programFiles = envGet(env, 'ProgramFiles');
  if (programFiles) push(join(programFiles, 'DeepSeek Harness', ...RUNTIME_TAIL));

  return out;
}

/**
 * 按候选顺序取桌面 dsh 版本。
 *
 * **绝不抛异常**：版本源是"可选的外部事实"，候选全坏的正确结果是
 * `{ version: null, source: null }` 让上层给出人话诊断，而不是让插件在 apply/工具调用里炸掉。
 * 每个候选的失败原因一律吞掉（缺文件 / 坏 JSON / 读权限 / desktopVersion 字段缺失或非字符串），
 * 直接试下一个 —— 因为**这些失败在语义上是同一件事**："这条源不可用"。
 *
 * @param {{ candidates?: string[], readFileSync?: (p: string, enc: string) => unknown }} [input]
 *        `readFileSync` 注入是为了单测容错分支；真机传 `node:fs` 的 `readFileSync`。
 * @returns {{ version: string | null, source: string | null }} `source` = 命中的那条候选路径
 */
export function pickDesktopVersion({ candidates = [], readFileSync: read = null } = {}) {
  if (typeof read !== 'function') return { version: null, source: null };
  const list = Array.isArray(candidates) ? candidates : [];
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim()) continue;
    try {
      const raw = read(p, 'utf8');
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
      const v = parsed && typeof parsed.desktopVersion === 'string' ? parsed.desktopVersion.trim() : '';
      if (v) return { version: v, source: p };
    } catch {
      /* 缺文件 / 坏 JSON / 读不动 —— 统一按"这条源不可用"处理，试下一个 */
    }
  }
  return { version: null, source: null };
}

/**
 * 生成"把这版 dsh 在 WSL 里物化到 pnpm dlx 缓存"的 bash 片段。
 *
 * 为什么需要它：`pnpm dlx` 第一次跑某版本要现下载依赖并编 native 包（冷启 ~5-7s）；
 * 桌面版本升级后 WSL 侧第一次调用会整段卡在这个冷启上。这个片段就是"预供给"（对应
 * vscode-server 的"按客户端 commit 下载 server"）：先按目标版本把包装好，之后真调用直接命中缓存。
 *
 * 三个实测坑（写死在这里，不再靠调用方记得）：
 *  1. **`--profile` 必带**：漏掉时 dsh 直接 `error: --profile <name> is required`，
 *     warm "看起来跑了"其实没成（已实测）。
 *  2. **非登录 shell 的 PATH 不含 `~/.local/bin`**（mise 装在那里）⇒ 必须先补 PATH，
 *     否则 `mise: command not found`。
 *  3. **`--dump-config` 只做装载、不跑会话**，最后 `> /dev/null` 丢弃输出、只留 `WARM-OK`
 *     作为成功哨兵（上层 `stdout.includes('WARM-OK')` 即判定预热成功）。
 *
 * 片段里**不含**代理探测/`set -e` 等 preamble：本函数只负责"这一段"，调用方按需在前面拼
 * `shellPreamble(cfg)`（见 index.js），保持这里可被逐字断言。
 *
 * @param {{ cfg?: { wslHome?: string, profile?: string }, version?: string }} [input]
 * @returns {string} 以换行结尾的 bash 片段
 */
export function warmScript({ cfg = {}, version } = {}) {
  const home = safeToken(cfg.wslHome, SAFE_PATH, 'cfg.wslHome');
  const profile = safeToken(cfg.profile, SAFE_TOKEN, 'cfg.profile');
  const v = safeToken(version, SAFE_TOKEN, 'version');
  const flags = ALLOW_BUILDS.map((p) => `--allow-build=${p}`).join(' ');
  return `set -uo pipefail
# 非登录 shell 的默认 PATH 不含 ~/.local/bin，而 mise 装在那里 ⇒ 必须显式补
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
cd "${home}" || { echo "remote-wsl: wslHome 不存在: ${home}" >&2; exit 2; }
mise exec -- pnpm dlx ${flags} @deepseek-ai/dsh@${v} --profile ${profile} --dump-config > /dev/null && echo WARM-OK
`;
}

/**
 * 生成"列出 WSL 里 dlx 已装过的 dsh 版本"的 bash 片段（stdout 每行一个版本号，无其它输出）。
 *
 * 布局来自 2026-10-10 在本机 `debian-u8-1` 的实测（不是猜的）：
 *
 *   ~/.cache/pnpm/dlx/<hash40>/<id>/{package.json, pnpm-lock.yaml, node_modules/}
 *   ~/.cache/pnpm/dlx/<hash40>/pkg -> <id>          # 符号链接，指向同一目录
 *   ~/.cache/pnpm/dlx/<hash40>/<id>/node_modules/@deepseek-ai/dsh -> ../.pacquet/@deepseek-ai+dsh@0.2.0-rc.2_<hash>/...
 *   ~/.cache/pnpm/dlx/<hash40>/<id>/node_modules/@deepseek-ai/dsh/package.json  →  "version": "0.2.0-rc.2"
 *
 * 两个由此得出的实现决定：
 *   · **取 `node_modules/@deepseek-ai/dsh/package.json` 的 `version`**，不取顶层
 *     `<id>/package.json` 的 `dependencies`（那里记的是用户请求的 spec，`dsh@latest` 这类
 *     写法会得到非版本号文本；已解析版本才在包自身 manifest 里）。
 *   · **`pkg` 是 `<id>` 的别名**，所以两层 glob 会把同一个包装数两遍 ⇒ 用 `sort -u`
 *     按版本号去重（需求本就是"每行一个版本号"，去重后正好一致）。
 *
 * `wslHome` 用来把缓存根**锚定到插件配置的家目录**（`wsl.exe -- bash -lc` 的 `$HOME` 通常
 * 就是它，但配置与 shell 不一致时锚点能让结果仍然正确），`$HOME` 与 `XDG_CACHE_HOME`
 * 作为并列候选根：**根不存在时无需特判** —— glob 不匹配就保持字面量，由 `[ -f ]` 直接跳过。
 *
 * @param {{ wslHome?: string }} [input]
 * @returns {string} 以换行结尾的 bash 片段
 */
export function dlxInventoryScript({ wslHome } = {}) {
  const home = typeof wslHome === 'string' && wslHome.trim() ? safeToken(wslHome, SAFE_PATH, 'wslHome') : '';
  const roots = [];
  const addRoot = (r) => {
    if (r && !roots.includes(r)) roots.push(r);
  };
  addRoot('${XDG_CACHE_HOME:-$HOME/.cache}/pnpm/dlx');
  if (home) addRoot(`${home}/.cache/pnpm/dlx`);
  addRoot('$HOME/.cache/pnpm/dlx');

  const loop = roots
    .map(
      (r) => `for f in "${r}"/*/*/node_modules/@deepseek-ai/dsh/package.json; do
  [ -f "$f" ] || continue
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$f" | head -n 1
done`,
    )
    .join('\n');

  // 整个循环组一起进 `sort -u`：`pkg` 是 `<id>` 的别名，同一版本会被 glob 命中两次。
  return `set -u
# 只输出"版本号"到 stdout：无命中时安静地什么都不输出（空 = 该版本还没在 WSL 里物化过）
{
${loop}
} | sort -u
`;
}
