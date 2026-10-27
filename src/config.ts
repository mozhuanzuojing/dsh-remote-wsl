/**
 * dsh-remote-wsl / config —— **全插件唯一一份默认配置**。
 *
 * 为什么单独成文件（2026-10-27 换角度评审第 3 条）：默认值以前散在四处
 * （`index.ts` / `preset.ts` / `search-tool.ts` / `fs-provider.ts`），改一处漏三处；
 * 实锤例子：`fs-provider` 的 `readTextMaxBytes` 因为 `preset.ts` 只转发四个键而**部署不可调**。
 * 现在所有宿主侧模块都从 `normalizeConfig()` 取同一份合并结果，preset 也**原样转发全部键**。
 *
 * 注意：`distro` / `wslHome` / `cwd` 的默认值是作者机器上的值 —— README「配置」一节要求改成自己的。
 *
 * @module dsh-remote-wsl/config
 */

/** 默认配置（字段含义见 README「配置」与各消费方注释）。 */
export const DEFAULTS = {
  // ── 目标发行版 ───────────────────────────────────────────────────────────────
  distro: 'debian-u8-1',
  wslHome: '/home/g',
  cwd: '/home/g',

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
 * 合并默认值与调用方配置（浅合并；`raw` 非对象时忽略）。
 * @param raw 插件行 config / preset 子插件 config
 */
export function normalizeConfig(raw) {
  return { ...DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
}
