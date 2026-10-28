/**
 * dsh-remote-wsl / config —— **全插件唯一一份默认配置**。
 *
 * 为什么单独成文件（2026-10-27 换角度评审第 3 条）：默认值以前散在四处
 * （`index.ts` / `preset.ts` / `search-tool.ts` / `fs-provider.ts`），改一处漏三处；
 * 实锤例子：`fs-provider` 的 `readTextMaxBytes` 因为 `preset.ts` 只转发四个键而**部署不可调**。
 * 现在所有宿主侧模块都从 `normalizeConfig()` 取同一份合并结果，preset 也**原样转发全部键**。
 *
 * ### 2026-10-28：`distro` / `wslHome` 改为「空 = 自动探测」
 *
 * 旧默认值是作者机器上的 `debian-u8-1` / `/home/g` —— 换一台机器装上插件，第一条命令就报
 * 「未知发行版」，README 只能要求用户手改配置来掩盖。默认值本身是缺陷，所以：
 *
 *   · `distro: ''` ⇒ 取 `wsl.exe -l -v` 里带 `*` 的默认发行版；
 *   · `wslHome: ''` ⇒ 问该发行版的登录用户 `$HOME`；
 *   · `cwd: ''` ⇒ 跟随解析出来的 `wslHome`；
 *   · 显式配置**永远优先**（此时一个 `wsl.exe` 都不会起）；探测失败**留空**并给出可操作报错，
 *     绝不回落到作者机器的值（那正是要修掉的「静默猜」）。探测实现见 `src/target-detect.ts`。
 *
 * 字段含义见 README「配置」与各消费方注释。
 *
 * @module dsh-remote-wsl/config
 */
import { asConfigText, noHomeMessage, resolveAutoTarget, NO_DISTRO_MESSAGE } from './target-detect.ts';

export { NO_DISTRO_REASON, NO_HOME_REASON, NO_DISTRO_MESSAGE, noHomeMessage, resetTargetDetection } from './target-detect.ts';

/** 默认配置（`distro` / `wslHome` / `cwd` 空 = 自动探测，见文件头）。 */
export const DEFAULTS = {
  // ── 目标发行版 ───────────────────────────────────────────────────────────────
  /** 空（或 `auto`）= 取 `wsl -l -v` 里带 `*` 的默认发行版；显式配置永远优先。 */
  distro: '',
  /** 空（或 `auto`）= 问 `distro` 里登录用户的 `$HOME`。 */
  wslHome: '',
  /** 空（或 `auto`）= 跟随解析出来的 `wslHome`。 */
  cwd: '',

  // ── 远端 agent ──────────────────────────────────────────────────────────────
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  profile: 'sdk',
  /** 空 = 跟随桌面版本（读 primary-runtime/runtime.json 的 desktopVersion）。 */
  dshVersion: '',
  desktopRuntimeJson: '',
  /** 宿主机代理端口（先探测再使用；探测失败不阻断直连）。 */
  proxyPort: 9910,
  /** 是否把 WSL 登录 shell 环境注入**常驻进程**（wsl_agent 守护后端 / wsl_open_ui / in-host）。 */
  useShellEnvironment: true,
  /** 版本漂移时后台预热 WSL 侧该版本（不阻塞当前调用）。 */
  backgroundWarm: true,
  /** 远端 agent 的宿主形态：'daemon'（默认，跨宿主复用）或 'in-host'（逃生舱）。 */
  backend: 'daemon',

  // ── 超时 ────────────────────────────────────────────────────────────────────
  /** 单次工具调用的墙钟上限（毫秒）。 */
  timeoutMs: 600000,
  /** fs provider 单次 RPC 的上限（毫秒）；比工具级超时短，失败要快。 */
  fsTimeoutMs: 60000,
  /** 运行时空闲多久后回收（毫秒）。 */
  idleTimeoutMs: 600000,

  // ── 守护 ────────────────────────────────────────────────────────────────────
  daemonPort: 8731,
  /** 端口回退次数（Windows 命名空间里被别的属主占用时逐个试）。 */
  daemonPortTries: 3,
  /** 守护空闲回收（毫秒）。**到期即回收运行时 ⇒ 上下文丢失**。 */
  daemonIdleMs: 1800000,
  /** 寿命闸门：无 key 且无客户端持续这么久后自退（0=关）。有会话时绝不触发。 */
  daemonLingerMs: 600000,
  /** 同一 key 的并发 prompt 等待位上限（超出明确拒绝；上游 SDK 无 cancel）。 */
  daemonQueueLimit: 4,
  /** Windows 侧握手判据的超时（毫秒）。 */
  daemonHandshakeTimeoutMs: 3000,
  /** 起守护后等"Windows 侧握手确认就绪"的上限（毫秒）。 */
  daemonStartTimeoutMs: 20000,
  /** 并发启动锁最多等多久（毫秒）。 */
  daemonLockWaitMs: 45000,

  // ── 文件世界 ────────────────────────────────────────────────────────────────
  /** readText 的字节上限：宿主 readText 区间 <10MiB，16MiB 覆盖并留余量；更大的走真流式。 */
  readTextMaxBytes: 16 * 1024 * 1024,

  // ── 搜索 / 远程 UI ──────────────────────────────────────────────────────────
  /** 缺 rg/fd 时是否自动安装（装失败会把原因与手动命令带回来，不静默降级）。 */
  searchAutoInstall: true,
  /** `wsl_open_ui` 在 WSL 里起的 web 端口。 */
  webPort: 3082,
};

/**
 * 探测结论挂在**配置对象自己身上**的键（Symbol ⇒ 不参与 `JSON.stringify`，也不会污染配置面；
 * 但 `{...cfg}` 展开会照常带上它 —— preset 把解析好的配置转发给子插件时，结论跟着走）。
 *
 * 为什么不用模块级"最近一次探测"：同一个进程里可能先后 `apply()` 多份配置（热重载、预设子插件、
 * 单测），模块级状态会把**上一份配置**的结论当成这一份的 —— 实测出现过「显式配置
 * `distro: no-such-distro-xyz`，日志却打印自动探测到的 `debian-u8-1`」这种误导。
 */
const TARGET_DETECTION = Symbol('dsh-remote-wsl/target-detection');

/**
 * 取这份配置自带的探测结论（不是它探测出来的 ⇒ `null`）。
 * @param config `normalizeConfig()` 的返回值（其它来源的普通对象返回 `null`）
 */
export function configDetection(config) {
  const value = config && typeof config === 'object' ? config[TARGET_DETECTION] : null;
  return value ?? null;
}

/**
 * 合并默认值与调用方配置，并**解析目标**（`distro` / `wslHome` / `cwd`）。
 *
 * @param raw 插件行 config / preset 子插件 config（`raw` 非对象时忽略）
 * @param opts.probe **测试缝**（同 `resolveAutoTarget`）：给了就用它探测、不碰真实 `wsl.exe`、
 *                   也不用进程内缓存。生产路径（index/preset/子插件/工具）**都不传**。
 * @returns 归一后的配置：`distro`/`wslHome`/`cwd` 已尽量填好；探测失败时可能是 `''`
 *          （调用方用 `targetProblem()` 拿到可操作报错，**不要自己拼提示**）
 */
export function normalizeConfig(raw, opts = {}) {
  const merged = { ...DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  const autoNeeded = !asConfigText(merged.distro) || !asConfigText(merged.wslHome);
  const probe = typeof opts?.probe === 'function' ? opts.probe : null;
  const resolved = resolveAutoTarget(merged, probe ? { probe } : {});
  const config = {
    ...merged,
    distro: resolved.distro,
    wslHome: resolved.wslHome,
    // 显式 cwd 优先；否则跟随解析出来的 wslHome（旧默认值是 `'/home/g'` —— 同样是作者机器的值）。
    //
    // 行为变化（评审 P2-5，已在 README/docs §5 记录）：显式配了 `wslHome` 但没配 `cwd` 的用户，
    // 有效 cwd 会从旧的 `/home/g` 变成自己的家目录。这是修正，但旧守护报告的 cwd 会因此不同 ⇒
    // `configCompat` 判**结构性不兼容**，需要显式 `wsl_daemon action=restart` 一次（会丢当前会话上下文）。
    cwd: asConfigText(merged.cwd) || resolved.wslHome,
  };
  // 显式配置 ⇒ 显式写 `null`：`merged` 里可能带着上一手转发来的结论（preset 展开），不能沿用。
  config[TARGET_DETECTION] = autoNeeded ? { ...resolved, at: Date.now() } : null;
  return config;
}

/**
 * 目标是否可用的**唯一判据**（探测失败的可操作说明都在这里，别的模块不要另写一份）。
 *
 * 两个消费面的分工：
 *   · 抛错型（`assertConfigTarget`）：工具/守护/provider 这类"没有目标就什么也做不了"的入口；
 *   · 报告型（返回字符串）：`wsl_status`、`index.ts` 的启动日志、面板的 `failArg(...)` 错误。
 *
 * @param config 归一后的配置
 * @returns `null` = 可用；否则是可读的、已含 `remote-wsl: ` 前缀的说明
 */
export function targetProblem(config) {
  return targetProblemFrom(config, configDetection(config));
}

/**
 * `targetProblem()` 的**纯函数**内核（探测结论由调用方传入）—— 单测可直接驱动，不依赖本机 WSL 状态。
 *
 * 为什么要把探测结论作为参数：只有"这份配置确实来自那次探测"时才能用更精确的文案
 * （例如"默认发行版是 WSL1"）。结论与配置对不上（陈旧/来自别的 distro）就退回通用文案，
 * 不把上一次的残影当成当前事实。
 *
 * @param config 归一后的配置
 * @param detection `configDetection(config)` 形状的结论，或 `null`
 */
export function targetProblemFrom(config, detection) {
  const distro = asConfigText(config?.distro);
  const home = asConfigText(config?.wslHome);
  if (!distro) {
    if (detection && !asConfigText(detection.distro) && detection.problem) return detection.problem;
    return NO_DISTRO_MESSAGE;
  }
  if (!home) {
    if (detection && asConfigText(detection.distro) === distro && detection.problem) return detection.problem;
    return noHomeMessage(distro);
  }
  return null;
}

/**
 * 抛错型判据：目标不可用时抛**可操作**错误（`targetProblem()` 的字符串）。
 * @param config 归一后的配置
 * @returns 原样的 `config`（便于链式使用）
 */
export function assertConfigTarget(config) {
  const problem = targetProblem(config);
  if (problem) throw new Error(problem);
  return config;
}
