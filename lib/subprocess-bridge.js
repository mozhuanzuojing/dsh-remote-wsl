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
 *     `wsl.exe [-d <cwd 里的发行版>] [--cd <cwd 的 Linux 路径>] --exec bash -l`，
 *     宿主 cwd 改到 Windows 有效目录（Linux 侧由 --cd 决定）；
 *   - 其它 cwd 原样调用宿主实现。
 * 这样不改 controller、不依赖 isolate 作用域，也不影响 Windows 会话。
 *
 * ## 诚实边界
 * - 只按 **cwd** 判定 WSL 会话；WSL preset + Windows 盘符 cwd 的会话仍会走 Windows shell。
 * - `--cd` 只对 UNC 路径可用；没有 UNC 时 bash 从宿主 cwd 映射的 `/mnt/...` 开始。
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
import { parseWslUncPath } from './unc-path.js';
import { gitSpawnRewrite, translateGitEnv, nativeGitRewrite } from './git-route.js';
import { diag } from './diag.js';
/** Windows 侧合法 cwd（终端进程在这里启动，Linux 目录由 wsl.exe 决定）。 */
const WINDOWS_CWD = process.env.SystemRoot ?? 'C:\\Windows';
const SYSTEM32 = `${WINDOWS_CWD}\\System32`;
/** 宿主是否有可用的 Windows git（native git 路由前置；缺则回落 WSL git，避免 spawn ENOENT 回归）。 */
let _hasWinGit;
function hasWindowsGit() {
    if (_hasWinGit !== undefined)
        return _hasWinGit;
    _hasWinGit = false;
    if (process.platform !== 'win32')
        return false;
    try {
        for (const dir of String(process.env.PATH ?? '').split(';')) {
            if (!dir)
                continue;
            for (const name of ['git.exe', 'git.cmd', 'git.bat']) {
                try {
                    if (fs.existsSync(path.join(dir, name))) {
                        _hasWinGit = true;
                        return true;
                    }
                }
                catch {
                    /* ignore */
                }
            }
        }
    }
    catch {
        /* ignore */
    }
    return _hasWinGit;
}
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
        if (!isWslUncCwd(spec.cwd))
            return original.call(host, spec);
        diag('terminal-route', 'wsl bash cwd=' + String(spec.cwd));
        // UNC cwd 同时给出真实发行版与 Linux 路径：优先用 cwd 里的 distro（比配置更准），
        // 并把 Linux 路径作为 `--cd`；否则 bash 会落在宿主 cwd 映射出的 /mnt/c/Windows。
        const unc = parseWslUncPath(spec.cwd);
        const targetDistro = unc?.distro || distro;
        const argv = [
            wslExecutable(),
            ...(targetDistro ? ['-d', targetDistro] : []),
            ...(unc?.linuxPath ? ['--cd', unc.linuxPath] : []),
            '--exec',
            'bash',
            '-l',
        ];
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
    // git spawn 路由：仅重写"git + distro UNC cwd"的 spawn，其余原样透传；不碰 @deepseek-ai 内部类。
    const originalSpawn = typeof host.spawn === 'function' ? host.spawn : null;
    let wrappedSpawn = null;
    if (originalSpawn) {
        const wslPath = wslExecutable();
        wrappedSpawn = function spawnRoutedGit(spec = {}) {
            // 优先：/mnt 工作区的 git 用宿主 git.exe 以 D:\ 为 cwd 原生跑（免 9P）。
            let native;
            try {
                native = nativeGitRewrite({ argv: spec.argv, cwd: spec.cwd });
            }
            catch {
                native = undefined;
            }
            if (native !== undefined && hasWindowsGit()) {
                diag('git-route', 'native git ' + native.gitArgv.join(' ') + ' cwd=' + native.windowsCwd);
                // 不翻译 env：宿主 git 直接吃调用方的 Windows 语义。
                return originalSpawn.call(host, { ...spec, argv: native.gitArgv, cwd: native.windowsCwd, env: spec.env });
            }
            let rw;
            try {
                rw = gitSpawnRewrite({ argv: spec.argv, cwd: spec.cwd, wslPath });
            }
            catch {
                rw = undefined;
            }
            if (rw === undefined)
                return originalSpawn.call(host, spec);
            diag('git-route', 'git ' + rw.gitArgv.join(' ') + ' cwd=' + String(spec.cwd) + ' distro=' + rw.distro);
            const { env, wslenv } = translateGitEnv(spec.env);
            const baseWslenv = typeof spec.env?.WSLENV === 'string' ? spec.env.WSLENV.split(':').filter(Boolean) : [];
            const env2 = { ...env, WSLENV: [...baseWslenv, ...wslenv].join(':') };
            return originalSpawn.call(host, { ...spec, argv: rw.wslArgv, cwd: WINDOWS_CWD, env: env2 });
        };
        host.spawn = wrappedSpawn;
    }
    else {
        diag('git-route', 'skipped: host subprocess.spawn 不可用，git 路由未启用');
    }
    return () => {
        if (host.spawnTerminal === wrapped)
            host.spawnTerminal = original;
        if (wrappedSpawn !== null && host.spawn === wrappedSpawn)
            host.spawn = originalSpawn;
    };
}
/**
 * 在插件根 ctx 上安装 bridge（子服务可用后执行）。
 * @param {object} ctx - 插件 context
 * @param {object} [rawConfig] - 插件配置
 */
export function installSubprocessBridgeFromContext(ctx, rawConfig = {}) {
    if (!ctx || typeof ctx.inject !== 'function')
        return;
    ctx.inject(['subprocess'], (child) => {
        const host = typeof child.get === 'function' ? child.get('subprocess') : undefined;
        if (!host)
            return;
        try {
            const restore = installSubprocessBridge(host, rawConfig);
            if (typeof child.effect === 'function')
                child.effect(() => restore);
        }
        catch (e) {
            // 明确失败：写启动日志（桌面 GUI 看不到 stderr），不静默降级。
            try {
                const dir = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'remote-wsl');
                fs.mkdirSync(dir, { recursive: true });
                fs.appendFileSync(path.join(dir, 'startup.log'), `${new Date().toISOString()} subprocess bridge 安装失败：${e?.message ?? e}\n`);
            }
            catch {
                /* 日志失败不影响主流程 */
            }
        }
    });
}
