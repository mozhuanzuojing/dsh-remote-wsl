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
import { asConfigText, noHomeMessage, resolveAutoTarget, resetTargetDetection, NO_DISTRO_MESSAGE } from './target-detect.ts';

export { NO_DISTRO_REASON, NO_HOME_REASON, NO_DISTRO_MESSAGE, REDETECT_HINT, noHomeMessage, resetTargetDetection } from './target-detect.ts';

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
 * 归一化时**显式配置的原值**（探测前）。为什么必须单独记：
 * 归一后的 `distro`/`wslHome` 已经填过探测结果，直接拿它重算会把"自动探测值"当成"显式配置"，
 * 于是「会话内重新探测」（`refreshAutoTarget`）永远不再探测 —— 正是 A-P2-E 要修的坑。
 *
 * Symbol ⇒ 不参与 JSON；`{...cfg}` 展开会带上（preset 转发时原值跟着走，重算语义一致）。
 */
const AUTO_TARGET_SOURCE = Symbol('dsh-remote-wsl/auto-target-source');

/**
 * 归一化时**修正过**的配置项（例如 `provider: ''` 被回落默认值）。
 *
 * 为什么单独记（A-P2-D / 复核 S3-8）：回落本身是对的（不让空串流进守护），但**静默**回落会让用户
 * 以为配置生效了。挂在配置对象上，由 `wsl_status` 显式打印；Symbol ⇒ 不参与 JSON。
 */
const CONFIG_WARNINGS = Symbol('dsh-remote-wsl/config-warnings');

/**
 * 取归一化时修正过的项（没有 ⇒ `[]`）。
 * @param config `normalizeConfig()` 的返回值
 */
export function configWarnings(config) {
  const value = config && typeof config === 'object' ? config[CONFIG_WARNINGS] : null;
  return Array.isArray(value) ? value.slice() : [];
}

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
  // A-P2-D（2026-10-28 复核）：`provider: ''` / `model: ' '` 以前会原样传到守护（`??` 对空串不生效），
  // initialize 收到空 provider 的行为取决于上游。这里与 distro/wslHome 同一套归一：空/纯空白 ⇒ 显式回落默认值；
  // 回落**不静默**（S3-8）：记进 configWarnings()，由 wsl_status 打出来（`'auto'` 也会被 asConfigText 归一成空）。
  const warnings = [];
  const providerText = asConfigText(merged.provider);
  const modelText = asConfigText(merged.model);
  const profileText = asConfigText(merged.profile);
  if (!providerText) warnings.push(`provider 为空/纯空白或 'auto' ⇒ 已回落默认值 ${DEFAULTS.provider}`);
  if (!modelText) warnings.push(`model 为空/纯空白或 'auto' ⇒ 已回落默认值 ${DEFAULTS.model}`);
  if (!profileText) warnings.push(`profile 为空/纯空白或 'auto' ⇒ 已回落默认值 ${DEFAULTS.profile}`);
  const provider = providerText || DEFAULTS.provider;
  const model = modelText || DEFAULTS.model;
  const profile = profileText || DEFAULTS.profile;
  const probe = typeof opts?.probe === 'function' ? opts.probe : null;
  const resolved = resolveAutoTarget(merged, probe ? { probe } : {});
  const source = {
    distro: asConfigText(merged.distro),
    wslHome: asConfigText(merged.wslHome),
    cwd: asConfigText(merged.cwd),
  };
  const config = { ...merged, provider, model, profile };
  // 目标赋值 + 探测结论记账与 refreshAutoTarget 共用一处（applyResolvedTarget；复核 standards-S4）。
  // 行为变化（评审 P2-5，已在 README/docs §5 记录）：显式配了 `wslHome` 但没配 `cwd` 的用户，
  // 有效 cwd 会从旧的 `/home/g` 变成自己的家目录。这是修正，但旧守护报告的 cwd 会因此不同 ⇒
  // `configCompat` 判**结构性不兼容**，需要显式 `wsl_daemon action=restart` 一次（会丢当前会话上下文）。
  applyResolvedTarget(config, source, resolved);
  // 记录**探测前**的显式原值：`refreshAutoTarget()` 只能按它重算，否则会把探测结果误当显式配置。
  config[AUTO_TARGET_SOURCE] = source;
  config[CONFIG_WARNINGS] = warnings;
  return config;
}

/**
 * 把**解析后的目标**应用到配置对象，并登记探测结论（`normalizeConfig` 与 `refreshAutoTarget` 共用）。
 *
 * 复核 standards-S4：原来这两处各写一份「赋值 + `TARGET_DETECTION` 记账 + `cwd` 回退」，
 * 将来目标多一个派生键就必须两处同改（Shotgun Surgery 的入口）。收成一处。
 *
 * 显式值优先（`resolveAutoTarget` 已保证）；`cwd` 空 ⇒ 跟随解析出的 `wslHome`（旧默认值是作者机器的 `/home/g`）。
 *
 * @param config 目标配置对象（非对象/undefined 时只计算不写回）
 * @param source **探测前**的显式原值（`{distro,wslHome,cwd}`）
 * @param resolved `resolveAutoTarget()` 的返回值
 * @returns 生效的目标 + `autoNeeded`（false ⇒ 纯显式配置）
 */
function applyResolvedTarget(config, source, resolved) {
  const autoNeeded = !source.distro || !source.wslHome;
  const target = {
    distro: resolved.distro,
    wslHome: resolved.wslHome,
    cwd: source.cwd || resolved.wslHome,
  };
  if (config && typeof config === 'object') {
    config.distro = target.distro;
    config.wslHome = target.wslHome;
    config.cwd = target.cwd;
    // 显式配置 ⇒ 显式写 `null`：`merged` 里可能带着上一手转发来的结论（preset 展开），不能沿用。
    config[TARGET_DETECTION] = autoNeeded ? { ...resolved, at: Date.now() } : null;
  }
  return { ...target, autoNeeded };
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

/**
 * **会话内重新探测**目标（A-P2-E，2026-10-28 独立复核补修）。
 *
 * ## 为什么需要它
 *
 * 探测结论是**进程级缓存**（成功与失败都缓存，见 `target-detect.ts` 文件头），并在启动期冻结进配置
 * 对象。如果 DSH 启动那一刻 WSL 冷启动/卡住，首次探测失败 ⇒ 本进程所有入口都报"没有目标"，以前
 * 只能重启 DSH。现在 `wsl_status({ redetect: true })` 可以：清掉进程缓存 → 按**显式配置原值**重算
 * 一次 → 把结果**原地写回同一份配置对象**（所有宿主侧消费方持有同一个引用，下一次调用就读到新值）。
 *
 * ## 边界（如实记录）
 *
 * · 只影响**宿主侧**消费方（`wsl_exec` / `wsl_agent` / `wsl_status` / 面板 / daemon）；
 *   `wsl` agent preset 的文件/搜索子插件拿的是**注册时的配置快照**，仍需重启 DSH 才会跟随 ——
 *   工具输出里会明说，不把"部分生效"说成"全部生效"。
 * · **显式配置永远不被覆盖**：`distro` / `wslHome` / `cwd` 里用户写死的值原样保留。
 * · **纯显式配置**（`distro` + `wslHome` 都写死）：不探测、也**不清缓存** —— 只核对现状，值原样不动。
 * · 重探是同步 `spawnSync`（最坏 8s + 10s），只在用户显式要求时发生，不在普通调用路径上加成本。
 *
 * @param config `normalizeConfig()` 的返回值（**原地更新**；传普通对象时按当前值当显式配置重算）
 * @param opts.probe 测试缝（同 `normalizeConfig`）：给了就不起真的 `wsl.exe`。注意**自动探测**时进程缓存
 *   仍会被清（这是重探语义的一半，不清就会读到"失败也缓存到进程结束"的旧结论）；显式配置时不动缓存。
 * @returns `{ ok, problem, notes, previous, current, changed, auto }` —— `ok:false` 时 `problem` 可操作
 */
export function refreshAutoTarget(config, opts = {}) {
  const source =
    (config && typeof config === 'object' && config[AUTO_TARGET_SOURCE]) || {
      distro: asConfigText(config?.distro),
      wslHome: asConfigText(config?.wslHome),
      cwd: asConfigText(config?.cwd),
    };
  const probe = typeof opts?.probe === 'function' ? opts.probe : null;
  // 只有"真的需要探测"时才清缓存：显式配置不重探，也不该影响别处（例如 preset 再 apply）的缓存。
  // 关键：不清就会原样读到「失败也缓存到进程结束」的旧结论 —— 这是重探语义的一半。
  const autoNeeded = !source.distro || !source.wslHome;
  if (autoNeeded) resetTargetDetection();
  const resolved = resolveAutoTarget({ distro: source.distro, wslHome: source.wslHome }, probe ? { probe } : {});
  const previous = {
    distro: config?.distro ?? '',
    wslHome: config?.wslHome ?? '',
    cwd: config?.cwd ?? '',
  };
  // 赋值 + 探测结论记账与 normalizeConfig 共用 applyResolvedTarget（复核 standards-S4）。
  const applied = applyResolvedTarget(config, source, resolved);
  const current = { distro: applied.distro, wslHome: applied.wslHome, cwd: applied.cwd };
  return {
    ok: !resolved.problem,
    problem: resolved.problem,
    notes: resolved.notes,
    previous,
    current,
    changed: previous.distro !== current.distro || previous.wslHome !== current.wslHome || previous.cwd !== current.cwd,
    auto: applied.autoNeeded,
  };
}
