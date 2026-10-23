/**
 * dsh-remote-wsl / preset —— 注册 **WSL 执行世界** 的 agent preset（`wsl`）。
 *
 * ## 为什么需要 preset（而不是直接改宿主 `ctx.fs`）
 * `fs` 是单例服务：cordis 不允许第二个 `provide` 抢名字，宿主平面上的 `fs-sandbox` 也无法从
 * 插件侧替换。官方给的路子是 **agent preset 的 isolate realm**：
 *
 *   - id: wsl-world
 *     name: cordis:group
 *     group: true
 *     isolate: { fs: true }
 *     config: [ fs-wsl（本插件的 provider）, tool-fs ]
 *
 * `agentPresets.register({id, name, description, plugins})` 在运行时注册这样一份声明（见
 * `@deepseek-ai/dsh-agent-preset-registry` 的 register），本文件就是这么做的。
 *
 * ## 与标准 preset 的关系（诚实记录代价）
 * 子插件列表是**标准 preset 的静态拷贝**（`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
 * 2026-10-23 的形状），只做了两处替换：去掉 `tool-fs` / `tool-fs-search`，换成 `wsl-world` 组里的
 * `fs-wsl` + `tool-fs`。代价：上游给标准 preset 增删行时，这份拷贝不会自动跟随（README/报告已记）。
 * `tool-fs-search` 暂不挂：它 spawn Windows ripgrep，Linux 路径在它眼里不成立；WSL 内搜索待阶段三。
 *
 * @module dsh-remote-wsl/preset
 */
import { fileURLToPath } from 'node:url';

export const name = 'dsh-remote-wsl-preset';
export const inject = [];

const PROVIDER_PATH = fileURLToPath(new URL('./fs-provider.ts', import.meta.url));

const DEFAULTS = {
  distro: 'debian-u8-1',
  wslHome: '/home/g',
  cwd: '/home/g',
  daemonPort: 8731,
};

/**
 * 造 `wsl` preset 的子插件列表（标准 preset 的静态拷贝 + WSL 世界组）。
 * @param cfg - 插件的 distro/daemonPort 等配置
 * @returns `agentPresets.register()` 用的 plugins 数组
 */
export function buildWslPresetPlugins(cfg) {
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: 'You are a coding agent powered by the {{model}} model.' },
    },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
    {
      id: 'wsl-world',
      name: 'cordis:group',
      group: true,
      isolate: { fs: true },
      config: [
        {
          id: 'fs-wsl',
          name: PROVIDER_PATH,
          config: {
            distro: String(cfg.distro ?? DEFAULTS.distro),
            wslHome: String(cfg.wslHome ?? DEFAULTS.wslHome),
            cwd: String(cfg.cwd ?? DEFAULTS.cwd),
            daemonPort: Number(cfg.daemonPort ?? DEFAULTS.daemonPort),
          },
        },
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      ],
    },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    {
      id: 'planning',
      name: 'cordis:group',
      group: true,
      isolate: { planMode: true },
      config: [
        {
          id: 'plan-mode',
          name: '@deepseek-ai/dsh-plan-mode',
          config: {
            section:
              'You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Explore first with non-mutating reads. Do not edit or write files while planning.',
          },
        },
      ],
    },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
        { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true } },
        { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    { id: 'tool-plugin-manager', name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true },
    { id: 'tool-plugin-market', name: '@deepseek-ai/dsh-plugin-market/tools', disabled: true },
  ];
}

/**
 * 注册 preset；服务不在（老版本 DSH）时**明确打一行**，不静默跳过。
 * @param ctx - cordis 上下文（注入 `agentPresets`）
 * @param rawConfig - 插件配置
 */
export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const plugins = buildWslPresetPlugins(cfg);
  ctx.inject(['agentPresets'], (child) => {
    const presets = typeof child.get === 'function' ? child.get('agentPresets') : undefined;
    if (!presets || typeof presets.register !== 'function') {
      process.stderr.write('remote-wsl: agentPresets 服务不可用（该 DSH 版本不支持运行时注册 preset），WSL preset 未注册\n');
      return;
    }
    let disposed = false;
    let unregister = null;
    child.effect(() => {
      presets
        .register({
          id: 'wsl',
          name: 'WSL（远程执行世界）',
          description: '文件工具在 WSL 发行版内原生执行（不经过 \\\\wsl.localhost 的 9P 共享）；bash/终端仍由宿主工具提供。',
          order: 9,
          plugins,
        })
        .then((un) => {
          unregister = un;
          if (disposed) void un();
          else process.stderr.write('remote-wsl: WSL preset 已注册（id=wsl，plugins=' + plugins.length + '）\n');
        })
        .catch((e) => {
          process.stderr.write('remote-wsl: WSL preset 注册失败：' + (e && e.message ? e.message : String(e)) + '\n');
        });
      return () => {
        disposed = true;
        if (unregister) void unregister();
      };
    });
  });
}
