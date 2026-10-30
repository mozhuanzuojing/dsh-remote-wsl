/**
 * dsh-remote-wsl / subprocess-bridge —— 让官方右侧栏 Terminal 在 WSL 会话里跑发行版 bash。
 *
 * ## 为什么是 bridge，而不是 preset 里的 subprocess provider
 * 实测（2026-10-30，WSL · Standard mode 会话）：`dsh-api-terminal-controller` 的
 * `agent.ctx.get("subprocess")` 拿到的是**宿主 Windows subprocess**，preset 里
 * `isolate: {subprocess:true}` 的 provider 只对同组插件可见，没有覆盖 controller 读取的
 * 那个服务。于是右侧栏仍起 `cmd.exe`，并因 cwd 是 UNC 报“UNC 路径不受支持”。
 *
 * ## 做法
 * 在插件根 apply 里拿到宿主唯一的 `subprocess` 实例，包一层 `spawnTerminal`：
 *   - `spec.cwd` 是 `\\wsl.localhost\…` / `\\wsl$\…`（WSL 会话的工作区）⇒ 换成
 *     `wsl.exe [-d <distro>] --exec bash -l`，cwd 改到 Windows 有效目录；
 *   - 其它 cwd 原样调用宿主实现。
 * 这样不改 controller、不依赖 isolate 作用域，也不影响 Windows 会话。
 *
 * ## 诚实边界
 * - 只按 **cwd** 判定 WSL 会话；WSL preset + Windows 盘符 cwd 的会话仍会走 Windows shell。
 * - controller 的 shell 发现仍走宿主 `terminalEnvironment`，所以终端标签可能显示
 *   `cmd.exe`/`PowerShell`，内容却是发行版 bash（外观与事实不一致）。
 * - 这是对宿主服务实例的运行时包装；宿主若冻结该实例或更换 API，bridge 会明确失败
 *   （启动日志），不会静默假装。
 *
 * @module dsh-remote-wsl/subprocess-bridge
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Windows 侧合法 cwd（终端进程在这里启动，Linux 目录由 wsl.exe 决定）。 */
const WINDOWS_CWD = process.env.SystemRoot ?? 'C:\\Windows';
const SYSTEM32 = `${WINDOWS_CWD}\\System32`;

/**
 * wsl.exe 的绝对路径；非 Windows 退回 PATH 上的名字（仅测试用）。
 * @returns {string}
 */
function wslExecutable() {
  return process.platform === 'win32' ? `${SYSTEM32}\\wsl.exe` : 'wsl.exe';
}

/**
 * 是否是 WSL 的 UNC 工作区 cwd。
 * @param {unknown} cwd
 * @returns {boolean}
 */
export function isWslUncCwd(cwd) {
  return typeof cwd === 'string' && /^\\\\wsl(?:\.localhost|\$)\\/i.test(cwd);
}

/**
 * 包装宿主 `subprocess.spawnTerminal`。
 * @param {object} host - 宿主 subprocess 服务实例
 * @param {{distro?: string}} [cfg]
 * @returns {() => void} 恢复原方法的 disposer
 */
export function installSubprocessBridge(host, cfg = {}) {
  if (!host || typeof host.spawnTerminal !== 'function') {
    throw new Error('dsh-remote-wsl subprocess bridge: 宿主 subprocess.spawnTerminal 不可用');
  }
  const original = host.spawnTerminal;
  const distro = typeof cfg.distro === 'string' ? cfg.distro.trim() : '';
  const wrapped = function spawnTerminalFromWsl(spec = {}) {
    if (!isWslUncCwd(spec.cwd)) return original.call(host, spec);
    const argv = [wslExecutable(), ...(distro ? ['-d', distro] : []), '--exec', 'bash', '-l'];
    const env = {
      ...(spec.env ?? {}),
      SystemRoot: WINDOWS_CWD,
      PATH: [SYSTEM32, process.env.PATH ?? ''].filter(Boolean).join(';'),
      TERM: spec.terminalType ?? 'xterm-256color',
    };
    return original.call(host, {
      ...spec,
      argv,
      cwd: WINDOWS_CWD,
      env,
      rows: spec.rows ?? 24,
      cols: spec.cols ?? 80,
      terminalType: spec.terminalType ?? 'xterm-256color',
      graceMs: spec.graceMs ?? 1200,
    });
  };
  host.spawnTerminal = wrapped;
  return () => {
    if (host.spawnTerminal === wrapped) host.spawnTerminal = original;
  };
}

/**
 * 在插件根 ctx 上安装 bridge（子服务可用后执行）。
 * @param {object} ctx - 插件 context
 * @param {object} [rawConfig] - 插件配置
 */
export function installSubprocessBridgeFromContext(ctx, rawConfig = {}) {
  if (!ctx || typeof ctx.inject !== 'function') return;
  ctx.inject(['subprocess'], (child) => {
    const host = typeof child.get === 'function' ? child.get('subprocess') : undefined;
    if (!host) return;
    try {
      const restore = installSubprocessBridge(host, rawConfig);
      if (typeof child.effect === 'function') child.effect(() => restore);
    } catch (e) {
      // 明确失败：写启动日志（桌面 GUI 看不到 stderr），不静默降级。
      try {
        const dir = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'remote-wsl');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          path.join(dir, 'startup.log'),
          `${new Date().toISOString()} subprocess bridge 安装失败：${e?.message ?? e}\n`,
        );
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  });
}
