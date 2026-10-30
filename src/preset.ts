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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from './config.ts';
import { registerWslVariants } from './variant-register.ts';
export const name = 'dsh-remote-wsl-preset';
export const inject = [];

/**
 * `wsl` preset 的**唯一权威 id**（2026-10-29 Standards review：之前 `'wsl'` 字面量散在 preset/explorer/
 * client 三处）。宿主侧消费者（`explorer.newSession` 的 `agentPreset`）从这里 import；client 半是手写
 * 独立 bundle、拿不到 TS 模块，只能保留字面量并由 `test/explorer-new-session.test.ts` 锁住一致性。
 */
export const WSL_PRESET_ID = 'wsl';

// 2026-10-24：preset 行名必须用**包内子路径**，不能用绝对文件路径。
// 实测（隔离实例 `/api/agentPresets/list`）：绝对路径 `D:/.../src/fs-provider.ts` 在 preset 的
// EntryTree 里 import 失败，两行都显示 "never started" ⇒ preset 标记 broken、UI 下拉里看不到。
// 包内子路径由 profile 的模块解析器按 node_modules 解析，和宿主平面加载 `dsh-remote-wsl` 同一条路。
const PROVIDER_PATH = 'dsh-remote-wsl/fs-provider';
const SEARCH_TOOL_PATH = 'dsh-remote-wsl/search-tool';
// 原生 shell（P0）：组内 `ctx.shell` 换成 WSL 执行器，`tool-bash` 因此在 win32 也可用（见 shell-provider.ts）。
const SHELL_PROVIDER_PATH = 'dsh-remote-wsl/shell-provider';



/**
 * 造 `wsl` preset 的子插件列表（标准 preset 的静态拷贝 + WSL 世界组）。
 * @param cfg - 插件的 distro/daemonPort 等配置
 * @returns `agentPresets.register()` 用的 plugins 数组
 */
export function buildWslPresetPlugins(cfg) {
  const wslCfg = normalizeConfig(cfg);
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: 'You are a coding agent powered by the {{model}} model.' },
    },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    {
      // WSL 执行世界：`fs` 与 `shell` 都在这个隔离组里被换掉（组外宿主平面不受影响）。
      // 2026-10-29（P0）：`tool-bash` 从宿主平面挪进来 —— 它注入的 `shell` 必须是组内的 WSL 执行器；
      // `tool-pwsh` 不再挂（它同样走 `ctx.shell`，在 WSL 世界里会变成"叫 PowerShell 却跑 bash"的谎话）。
      id: 'wsl-world',
      name: 'cordis:group',
      group: true,
      isolate: { fs: true, shell: true },
      config: [
        {
          id: 'fs-wsl',
          name: PROVIDER_PATH,
          // 换角度评审第 3 条：**全量转发**（旧实现只转 4 个键 ⇒ readTextMaxBytes 等配置到不了子插件）。
          config: { ...wslCfg },
        },
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
        // WSL 内搜索：grep/glob 由 daemon 在发行版里执行（Windows ripgrep 对 Linux 路径不成立）。
        {
          id: 'search-wsl',
          name: SEARCH_TOOL_PATH,
          // 换角度评审第 3 条：**全量转发**（旧实现只转 4 个键 ⇒ readTextMaxBytes 等配置到不了子插件）。
          config: { ...wslCfg },
        },
        // 原生 bash：执行发生在 WSL 里（每条命令一次 wsl.exe；进程组回收见 shell-provider.ts 文件头）。
        {
          id: 'shell-wsl',
          name: SHELL_PROVIDER_PATH,
          config: { ...wslCfg },
        },
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
        // 2026-10-30 吸收 dsh-ssh-ops：WSL preset 内的 bash 危险命令也要宿主审批。
        // 只在 WSL 组内挂载，标准 preset 的本地 bash 不受影响。
        {
          id: 'wsl-command-policy',
          name: 'dsh-remote-wsl/command-policy',
          config: { toolNames: ['bash'], commandPolicy: wslCfg.commandPolicy },
        },
        {
          // 2026-10-30：官方右侧栏终端的 WSL 后端。DSH 自带 terminal 注册表与 PTY UI；
          // 这里只提供“用 wsl.exe 启动发行版 bash”的 terminal 类型，不自行实现 xterm。
          id: 'wsl-terminal',
          name: 'cordis:group',
          group: true,
          isolate: { terminals: true },
          config: [
            { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
            {
              id: 'terminal-wsl',
              name: '@deepseek-ai/dsh-terminal-bash',
              config: {
                backendType: 'wsl',
                shellDialect: 'bash',
                shellPath: 'wsl.exe',
                // distro 为空 = 自动探测/默认发行版；此时不能传 `-d ''`（wsl.exe 会报错）。
                shellArgs: [
                  ...(wslCfg.distro ? ['-d', wslCfg.distro] : []),
                  ...(wslCfg.cwd ? ['--cd', wslCfg.cwd] : []),
                  '--exec',
                  'bash',
                  '-l',
                ],
                idleSilenceMs: 1200,
              },
            },
          ],
        },
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
 * 同时把结论追加到 `~/.dsh/remote-wsl/startup.log`：桌面 GUI 没有 stderr 日志，
 * 落文件后「运行中的 host 到底加载了哪版代码、preset 注册成没成」才能被离线验证。
 * @param ctx - cordis 上下文（注入 `agentPresets`）
 * @param rawConfig - 插件配置
 */
/** 注册状态（内存态，供 `wsl_status` 这类宿主工具读取；不影响行为）。 */
export const presetState = { phase: 'idle', plugins: 0, broken: null };

/** @returns 当前 preset 注册状态快照。 */
export function presetStatus() {
  return { ...presetState };
}

export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);
  const plugins = buildWslPresetPlugins(cfg);
  presetState.phase = 'registering';
  presetState.plugins = plugins.length;
  logStartup(`apply 进入（codeTag=preset-log-v1，plugins=${plugins.length}）`);
  ctx.inject(['agentPresets'], (child) => {
    const presets = typeof child.get === 'function' ? child.get('agentPresets') : undefined;
    if (!presets || typeof presets.register !== 'function') {
      presetState.phase = 'unavailable';
      logStartup('agentPresets 服务不可用（该 DSH 版本不支持运行时注册 preset），WSL preset 未注册');
      return;
    }
    let disposed = false;
    let unregister = null;
    child.effect(() => {
      presets
        .register({
          id: WSL_PRESET_ID,
          name: 'WSL（远程执行世界）',
          description:
            '文件工具、grep/glob 与 bash 都在 WSL 发行版内原生执行（不经过 \\\\wsl.localhost 的 9P 共享）；终端（PTY）仍由宿主提供。',
          order: 9,
          plugins,
        })
        .then(async (un) => {
          unregister = un;
          if (disposed) {
            void un();
            return;
          }
          // 注册成功 ≠ 可用：mount 失败会记在 list() 的 `broken` 字段里（UI 会隐藏该 preset）。
          // 启动日志必须把这一点写出来，否则"已注册"会掩盖"点不到"。
          let broken;
          try {
            const rows = typeof presets.list === 'function' ? await presets.list() : [];
            broken = Array.isArray(rows) ? rows.find((row) => row && row.id === 'wsl')?.broken : undefined;
          } catch {
            broken = undefined;
          }
          logStartup(
            broken
              ? 'WSL preset 注册但有 broken（id=wsl，plugins=' + plugins.length + '）：' + String(broken).replace(/\n/g, ' | ')
              : 'WSL preset 已注册（id=wsl，plugins=' + plugins.length + '）',
          );
          presetState.phase = 'registered';
          presetState.broken = broken ?? null;
          // 2026-10-30：为 roster 中健康的基础模式生成 wsl-<mode> 变体。失败只记录，不影响
          // 现有 `wsl` preset（用户仍可用标准 WSL 世界）。
          void registerWslVariants(presets, logStartup, { distro: cfg.distro, cwd: cfg.cwd }).then((result) => {
            if (result.registered.length) logStartup(`WSL 模式变体已注册：${result.registered.join(', ')}`);
            if (result.failures.length) logStartup(`WSL 模式变体失败：${result.failures.join(' | ')}`);
          }).catch((e) => logStartup(`WSL 模式变体异常：${e?.message ?? e}`));
        })
        .catch((e) => {
          presetState.phase = 'failed';
          presetState.broken = e && e.message ? e.message : String(e);
          logStartup('WSL preset 注册失败：' + (e && e.message ? e.message : String(e)));
        });
      return () => {
        disposed = true;
        if (unregister) void unregister();
      };
    });
  });
}

/** 追加一行启动诊断到 `~/.dsh/remote-wsl/startup.log`（stderr 在桌面 GUI 里看不到）。 */
function logStartup(line) {
  try {
    const dir = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'remote-wsl');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'startup.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志写不进去不影响注册 */
  }
  try {
    process.stderr.write(`remote-wsl: ${line}\n`);
  } catch {
    /* stderr 可能已关闭 */
  }
}
