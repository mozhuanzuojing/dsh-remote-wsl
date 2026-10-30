/**
 * dsh-remote-wsl / subprocess-provider —— WSL 世界的 `ctx.subprocess`（右侧栏 Terminal 的入口）。
 *
 * ## 它解决什么
 * 官方 `dsh-client-ui-sidebar-terminal` 的终端**不经过 `terminals` 注册表**：
 * `dsh-api-terminal-controller` 直接读会话的 `ctx.get("subprocess")`，再用
 * `terminalEnvironment()` / `resolveExecutable()` / `spawnTerminal()` 起 PTY。因此要让
 * 右侧栏 Terminal 跑发行版 bash，正确缝是**替换 `subprocess`**，不是挂 `terminals` 行。
 *
 * ## 契约（DSH 0.2.1-rc.3 的 controller 实际调用）
 * - `terminalEnvironment(signal)` → `{ platform:'linux', defaultShell:'/bin/bash' }`；
 * - `resolveExecutable(path, ...)` → 只暴露发行版 bash（Windows shell 候选也映射到 bash，
 *   于是 guide 里只出现一个 shell，而不是在 WSL 会话里列出 powershell/cmd）；
 * - `spawnTerminal(spec)` → 委托宿主 subprocess，把 argv 包装成
 *   `wsl.exe [-d <distro>] --exec bash -l`，cwd 用 Windows 侧有效目录（Linux cwd 由
 *   `--cd` 无法可靠从 UNC 映射时先省略），env 保留 `DSH_SESSION_ID` 等调用方变量。
 * 其余方法通过 Proxy 委托宿主服务，避免 isolate 后让其他消费者失去 subprocess。
 *
 * ## 诚实边界
 * - `cwd` 语义：官方 controller 传的是会话工作目录（UNC/盘符）。这里不把它翻译成
 *   `--cd`（映射规则不在本模块、失败会静默换目录），终端从发行版默认目录开始；
 *   agent 的 `bash`/`wsl_terminal` 仍带正确 cwd。
 * - 只实现 controller 的终端路径；不是完整 subprocess 实现，其余方法全部委托宿主。
 *
 * @module dsh-remote-wsl/subprocess-provider
 */

import { normalizeConfig } from './config.ts';
import { getHostSubprocess } from './subprocess-host.ts';

export const name = 'dsh-remote-wsl-subprocess';
export const inject = [];

/** 宿主 spawnTerminal 需要的 Windows cwd（发行版目录由 wsl.exe 自己决定）。 */
const WINDOWS_CWD = process.env.SystemRoot ?? 'C:\\Windows';
const SYSTEM32 = `${WINDOWS_CWD}\\System32`;

/**
 * 找一个可执行的 wsl.exe；System32 不存在时退回 PATH 上的 `wsl.exe`。
 * @returns {string}
 */
function wslExecutable() {
  return process.platform === 'win32' ? `${SYSTEM32}\\wsl.exe` : 'wsl.exe';
}

/**
 * 构造 WSL subprocess 代理。
 * @param {object} host - 宿主 `subprocess` 服务
 * @param {{distro?: string}} [cfg] - 插件配置（distro 空 = wsl.exe 默认发行版）
 * @returns {object} 可直接 `ctx.provide('subprocess', …)`
 */
export function createWslSubprocess(host, cfg = {}) {
  if (!host || typeof host.spawnTerminal !== 'function') {
    throw new Error('dsh-remote-wsl subprocess provider: host subprocess.spawnTerminal 不可用');
  }
  const distro = typeof cfg.distro === 'string' ? cfg.distro.trim() : '';
  const overrides = {
    async terminalEnvironment() {
      return { platform: 'linux', defaultShell: '/bin/bash' };
    },
    async resolveExecutable() {
      // controller 只关心 path 与 shellKind；任何候选都归一到发行版 bash。
      return '/bin/bash';
    },
    spawnTerminal(spec = {}) {
      const argv = [wslExecutable(), ...(distro ? ['-d', distro] : []), '--exec', 'bash', '-l'];
      const env = {
        ...(spec.env ?? {}),
        SystemRoot: WINDOWS_CWD,
        PATH: [SYSTEM32, process.env.PATH ?? ''].filter(Boolean).join(';'),
        TERM: spec.terminalType ?? 'xterm-256color',
      };
      return host.spawnTerminal({
        ...spec,
        argv,
        cwd: WINDOWS_CWD,
        env,
        rows: spec.rows ?? 24,
        cols: spec.cols ?? 80,
        terminalType: spec.terminalType ?? 'xterm-256color',
        graceMs: spec.graceMs ?? 1200,
      });
    },
  };
  // 其余 subprocess 方法（spawn/exec/…）行为不变：绑定宿主实例后转发。
  return new Proxy(host, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * 在 WSL 世界的 isolate realm 里提供 `subprocess`。
 * @param {object} ctx - cordis context
 * @param {object} [rawConfig] - 插件配置
 */
export function apply(ctx, rawConfig = {}) {
  const host = getHostSubprocess() ?? (typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined);
  if (!host) throw new Error('dsh-remote-wsl subprocess provider: 宿主 subprocess 不可用');
  const cfg = normalizeConfig(rawConfig);
  ctx.provide('subprocess', createWslSubprocess(host, cfg));
}
