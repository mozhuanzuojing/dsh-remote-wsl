/**
 * daemon-launch.ts —— T3 拆分自 `daemon-client.ts`（1068 行）的 **启动层**：启动脚本/unit/systemd 主路径与 compat 回退、launcher 写盘与回收、版本兼容判定。
 *
 * 来源：`src/daemon-client.ts` @ sha256 cb420d25ef1bcf9535cbf2f3dbb3faad95fa0d5321b31d0ca798103de59dbed1（原文件已备份到
 * `spike/verify/explorer-20261012/arch-t3/backup/daemon-client.cb420d25.ts.bak`）。
 * **代码逐字搬移**（由 `arch-t3/tools/apply-split.ts` 按行区间生成），未改写实现。
 * 导出：`systemdUnit`/`writeLauncherWsl`/`removeLauncher`/`launchDaemon`/`configCompat`；`killWslPid` 额外导出供 lifecycle 复用（**不进** daemon-client 的对外面）。
 *
 * 零构建纪律：只用可擦除语法；相对导入带 `.ts`；只引 `node:` 内置与同目录相对模块。
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, statSync, truncateSync } from 'node:fs';
import { daemonScriptWsl, launchLinux, stateDirLinux, unc, wslRunScript, wslRunScriptAsync } from './daemon-protocol.ts';
import { PLUGIN_VERSION, PROTOCOL_VERSION } from './plugin-version.ts';

// ── 原 daemon-client.ts 第 319-328 行 ──
export function killWslPid(cfg, pid) {
  if (!Number.isFinite(Number(pid))) return;
  const p = Number(pid);
  const script =
    `if [ -r /proc/${p}/cmdline ] && tr '\\0' ' ' < /proc/${p}/cmdline | grep -q 'daemon\\.ts'; then ` +
    `kill -TERM ${p} 2>/dev/null || true; fi`;
  wslRunScript(cfg, script, 10000);
}

/**
 * `killWslPid` 的异步版（2026-10-27 审查 F-15）：控制面不再同步阻塞宿主事件循环。
 * 身份判据保持一致（cmdline 里必须有 `daemon.ts`；见 F-09 的说明，`ensure` 路径也只用它兜底）。
 */
export async function killWslPidAsync(cfg, pid, signal = 'TERM') {
  if (!Number.isFinite(Number(pid))) return;
  const p = Number(pid);
  const sig = signal === 'KILL' ? 'KILL' : 'TERM'; // 白名单：只允许这两种（绝不把任意字符串拼进 shell）
  const script =
    `if [ -r /proc/${p}/cmdline ] && tr '\\0' ' ' < /proc/${p}/cmdline | grep -q 'daemon\\.ts'; then ` +
    `kill -${sig} ${p} 2>/dev/null || true; fi`;
  await wslRunScriptAsync(cfg, script, 10000);
}

/** 启动脚本（落 state 目录，0600；守护起来后会自己删掉）——绝不落 /tmp。 */

// ── 原 daemon-client.ts 第 329-361 行 ──
function launchScript(cfg, port, version) {
  return [
    'set -uo pipefail',
    // F31（task-8）：`launch-stderr.log` 是**Windows 侧** `openSync(..., 'a', 0o600)` 建的，而经 UNC
    // （9p/drvfs）的 chmod **实测不生效**（改前 0644、改了还是 0644；同目录 daemon.log 是 0600）。
    // 所以由 **WSL 侧**在守护起来之前显式收紧：只改 mode，**不动内容、不动属主**。
    `chmod 600 ${JSON.stringify(`${stateDirLinux(cfg)}/launch-stderr.log`)} 2>/dev/null || true`,
    'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
    `cd ${JSON.stringify(cfg.wslHome)} 2>/dev/null || true`,
    `exec node ${JSON.stringify(daemonScriptWsl())} --port ${port} --meta-port ${port} --version ${version} --cwd ${JSON.stringify(cfg.cwd)} ` +
      `--idle-ms ${Number(cfg.daemonIdleMs ?? 1800000)} --queue-limit ${Number(cfg.daemonQueueLimit ?? 4)} ` +
      `--profile ${JSON.stringify(cfg.profile ?? 'sdk')} --proxy-port ${Number(cfg.proxyPort ?? 9910)} ` +
      `--linger-ms ${Number(cfg.daemonLingerMs ?? 600000)} ` +
      // F-55（2026-10-27 审查）：把 `useShellEnvironment` 真正接到守护启动参数上。以前这个开关只在
      // in-host / wsl_open_ui 生效，daemon 后端恒注入，而 `wsl_status` 又按配置回显 —— 配置与行为矛盾。
      `${cfg.useShellEnvironment === false ? '--no-shell-env ' : ''}` +
      `--state-dir ${JSON.stringify(stateDirLinux(cfg))} --launcher ${JSON.stringify(launchLinux(cfg, port))}`,
    '',
  ].join('\n');
}

/**
 * ★★ F-37 双约束（task-17）：WSL 侧 **systemd-run --user** 的启动脚本。
 *
 * 为什么必须这样：`detached` 与 `windowsHide` 在 Windows 上互斥（前者给 job breakaway + DETACHED_PROCESS
 * ⇒ wsl.exe 申请新控制台 ⇒ Win11+WT 开窗），所以"直接 spawn wsl.exe"这一条路上，约束 (a) 无窗 与
 * (b) 守护脱离宿主生死 **不可兼得**。改成"Windows 侧只发一条短命令、把守护交给 WSL 的用户 systemd"后：
 *   · Windows 侧 `wsl.exe` 是**短命**的（≈0.5s）⇒ 按 T15 的四态矩阵，短命形态**不开窗**（(a) ✓）；
 *   · 守护是 systemd 的 unit（`Type=simple`，进程归 user manager）⇒ 与 Windows 侧任何进程的生死**解耦**（(b) ✓）。
 *
 * 纪律：
 *   · 所有可变数据（启动脚本路径 / unit 名 / stderr 日志路径）都走 **argv 位置参数**（`"$1" "$2" "$3"`），
 *     脚本里没有任何字符串拼接 —— 与 `wsl_path` 同一条安全纪律；
 *   · **同槽位重入**：先 `stop` + `reset-failed`（清掉 inactive/failed 残留），再起，避免 unit 冲突静默失败；
 *   · 只有真的拿到 `SYSTEMD_OK` 才算成功；任何失败都把原因（systemd-run 的输出）回给调用方去**降级并告警**。
 */

// ── 原 daemon-client.ts 第 362-378 行 ──
const SYSTEMD_LAUNCH_SCRIPT = [
  'set -uo pipefail',
  'L="$1"; U="$2"; E="$3"',
  'if ! command -v systemd-run >/dev/null 2>&1; then echo "SYSTEMD_FAIL: 找不到 systemd-run（发行版可能未启用 systemd）"; exit 7; fi',
  'systemctl --user stop "$U" >/dev/null 2>&1 || true',
  'systemctl --user reset-failed "$U" >/dev/null 2>&1 || true',
  'if out=$(systemd-run --user --unit="$U" --collect --quiet \\',
  '    --property=StandardOutput=append:"$E" --property=StandardError=append:"$E" \\',
  '    bash "$L" 2>&1); then',
  '  echo "SYSTEMD_OK"',
  'else',
  '  echo "SYSTEMD_FAIL: ${out:-（systemd-run 无输出）}"',
  '  exit 7',
  'fi',
].join('\n');

/** 用户 systemd 里的 unit 名：**按槽位确定性命名**（同槽位重入靠它；也便于收尾清理）。 */

// ── 原 daemon-client.ts 第 379-381 行 ──
export const systemdUnit = (port) => `dsh-rwsl-${port}.service`;

/** 元数据/脚本目录必须先存在（Windows 侧通过 UNC 建，避免第一次启动时 WSL 侧还没有目录）。 */

// ── 原 daemon-client.ts 第 382-404 行 ──
function ensureStateDir(cfg) {
  try {
    mkdirSync(unc(cfg.distro, stateDirLinux(cfg)), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 起一个守护进程。**不做就绪判断** —— 就绪永远由调用方用 Windows 侧握手确认。
 * @returns {{ok:boolean, error?:string}}
 */
/**
 * ★★ F-38b（task-19）：**在 WSL 侧**写启动脚本，`umask 077` ⇒ **创建即 0600**。
 *
 * 为什么要改：原来走 UNC（`writeFileSync` + `chmodSync`），而 **UNC/9p 上 `chmodSync` 静默无效**
 * （T15/T17 已实测；F31 也是同一个坑），于是**没被执行的**启动脚本会以 **0644** 留在状态目录里
 * （T18 在 `DSH_REMOTE_WSL_SYSTEMD=on` + 托管失败 + 端口回退的场景实测到 `launch.8936.sh/launch.8937.sh`
 * 为 `-rw-r--r--`）。在 WSL 侧 `umask 077` 创建 + 显式 `chmod 600` 是 Linux 语义，**真的生效**。
 *
 * 脚本内容经 **base64 作为 argv 位置参数**传入（不含任何 shell 元字符，安全）。
 */

// ── 原 daemon-client.ts 第 405-418 行 ──
const WRITE_LAUNCHER_SCRIPT = [
  'set -uo pipefail',
  'P="$1"; B="$2"',
  'umask 077',
  'printf %s "$B" | base64 -d > "$P" || { echo "LAUNCHER_WRITE_FAIL"; exit 8; }',
  'chmod 600 "$P" 2>/dev/null || true',
  'echo LAUNCHER_OK',
].join('\n');

/**
 * WSL 侧落启动脚本。返回 `{ok, error?}`。
 * 原子性说明：这里直接 `>` 截断写（不再是 UNC 上的 tmp+rename）；写入期间脚本**不会**被任何进程执行
 * —— 只有写完（拿到 LAUNCHER_OK）之后调用方才去 `systemd-run` / `spawn`，所以不存在"读到半截脚本"的窗口。
 */

// ── 原 daemon-client.ts 第 419-440 行 ──
export function writeLauncherWsl(cfg, launcherWslPath, body) {
  const r = spawnSync(
    'wsl.exe',
    ['-d', cfg.distro, '-e', 'bash', '-c', WRITE_LAUNCHER_SCRIPT, '_', launcherWslPath, Buffer.from(body, 'utf8').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
  const stdout = String(r.stdout || '').replace(/\0/g, '');
  if (r.status === 0 && stdout.includes('LAUNCHER_OK')) return { ok: true };
  const tail =
    String(r.stderr || '')
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/WSL|localhost|NAT|wsl:/i.test(s))
      .slice(-1)[0] || '';
  return { ok: false, error: `WSL 侧写启动脚本失败（exit ${r.status}${stdout.includes('LAUNCHER_WRITE_FAIL') ? ', LAUNCHER_WRITE_FAIL' : ''}）${tail ? `：${tail}` : ''}` };
}

/**
 * 回收**指定槽位**的启动脚本（失败路径用；成功路径靠守护起来后自删）。
 * `force:true` ⇒ 不存在也不报错；UNC 删除在 9p 上可用（与 chmod 不同）。
 */

// ── 原 daemon-client.ts 第 441-449 行 ──
export function removeLauncher(cfg, port) {
  try {
    rmSync(unc(cfg.distro, launchLinux(cfg, port)), { force: true });
    return true;
  } catch {
    return false;
  }
}


// ── 原 daemon-client.ts 第 450-602 行 ──
export function launchDaemon(cfg, port, version, log = () => {}) {
  if (!ensureStateDir(cfg)) {
    return { ok: false, error: `无法创建 WSL 侧状态目录 ${stateDirLinux(cfg)}（发行版 "${cfg.distro}" 是否在跑？）` };
  }
  const body = launchScript(cfg, port, version);
  // ★ F-38b：WSL 侧创建（umask 077 ⇒ 0600）。三条路径（systemd 主 / compat 回退 / 端口回退）共用这一处。
  const written = writeLauncherWsl(cfg, launchLinux(cfg, port), body);
  if (!written.ok) {
    return { ok: false, error: `${written.error}（启动脚本 ${launchLinux(cfg, port)}）` };
  }
  // 守护要活过本宿主进程；守护自己的诊断走 state 目录里的 daemon.log。
  // ⚠️ spawn 必须跑**同一个槽位**的脚本（`launchLinux(cfg, port)`）：这里曾经写成 `launchLinux(cfg)`
  // （默认回落到 cfg.daemonPort）⇒ 回退槽位写的是 launch.8752.sh、跑的却是 launch.8751.sh，
  // 于是"回退槽位元数据永远不出现 + 脚本泄漏"。包装层 stderr 也落文件，避免再次静默。
  //
  // ★★ F-37（task-15）：**这里绝对不能加 `detached: true`** —— 它是"起守护弹可见控制台窗口"的根因。
  // 2026-10-12 本机 A/B 实测（spawn 选项矩阵，长驻 `wsl.exe -d <d> -- bash -c 'sleep 8'`）：
  //   · { windowsHide:true }                  → 无带窗口进程、**无 WindowsTerminal**
  //   · { detached:true }                     → 出现 `WindowsTerminal`（标题 `C:\Program Files\WSL\wsl.exe`）
  //   · { windowsHide:true, detached:true }   → 同样出现（**windowsHide 挡不住**，这是本次的旧配置）
  //   · {}（都不加）                          → 无带窗口进程
  //   机理：`detached` 让 libuv 用 DETACHED_PROCESS 起子进程（**没有控制台**）；`wsl.exe` 是控制台子系统
  //   程序 ⇒ 它申请**新控制台**，而 Win11 的默认终端应用是 Windows Terminal ⇒ WT 接管并**开一个可见窗口**
  //   （WT 不遵守 CREATE_NO_WINDOW/hidden）。短命形态（`wsl -l -v` 约 0.3s）不会开窗，是因为握手还没完成
  //   进程就退了 —— 这也是"为什么只有起守护才弹窗"的解释。归属判据见报告：`WindowsTerminal` 的父是
  //   **svchost.exe**（默认终端 host 机制），不是我们的 wsl.exe ⇒ 只能靠**启动时间同秒 + A/B 对照**判定。
  // 为什么不能改成"WSL 侧 setsid/nohup 分离 + 包装层立刻退出"（task-15 的候选 ④）：本机实测**不可行** ——
  //   `wsl.exe -e bash -c 'bash <脚本> &'` / `setsid` / `setsid nohup` / `systemd-run --user` 四种写法，
  //   包装层 0.45s 就退了，而脚本连**第一行都没执行**（tick 文件都不存在）；只有**前台**跑（包装层活到脚本
  //   结束，4.5s、10 行 tick 全写）才真的跑完 ⇒ 本机 WSL 会回收 `wsl.exe` 会话里的后台进程。
  //   加上"包装层被杀 ≠ Linux 侧进程死"是本仓已实测的另一条事实（index.ts reapWsl 注释），
  //   所以包装层继续前台活到守护结束是**必须**的，唯一要做的就是把 detached 去掉。
  let stderrFd = null;
  const stderrLogLocal = unc(cfg.distro, `${stateDirLinux(cfg)}/launch-stderr.log`);
  try {
    // F31（task-8）：本目录其余文件都是 0600，只有这个文件因为 `openSync(..., 'a')` 的默认
    // 0666&~umask 变成了 0644（reliability 实测 `-rw-r--r--`）。这里创建时就给 0600；
    // 对**已存在**的旧文件再显式 chmod 一次（只改 mode，**不动内容、不动属主**）。
    // 2026-10-26：`launch-stderr.log` 只 append、从不回卷，实测攒到 1.5MB。启动新守护前
    // 超过 1MB 就清空（里面只有包装层 stderr 诊断，没有凭据；daemon.log 自己另有 256KB 上限）。
    try {
      if (statSync(stderrLogLocal).size > 1024 * 1024) truncateSync(stderrLogLocal, 0);
    } catch {
      /* 文件不存在或不可写：忽略，开 append 时按需创建 */
    }
    stderrFd = openSync(stderrLogLocal, 'a', 0o600);
    try {
      chmodSync(stderrLogLocal, 0o600);
    } catch {
      /* drvfs 上 chmod 可能无效；文件里只有包装层 stderr，没有密钥 */
    }
  } catch {
    stderrFd = null;
  }
  const launcherLinux = launchLinux(cfg, port);
  const unit = systemdUnit(port);
  /** WSL 侧路径（systemd 的 `append:` 属性要用 Linux 路径，不是 UNC）。 */
  const stderrLogLinuxPath = `${stateDirLinux(cfg)}/launch-stderr.log`;

  /** 统一的 fd 收尾（systemd 路径不把 fd 交给任何子进程；兼容路径要交给包装层）。 */
  const closeStderrFd = () => {
    if (stderrFd !== null) {
      try {
        closeSync(stderrFd);
      } catch {
        /* 子进程已持有该 fd */
      }
    }
  };

  /**
   * 回退路径（task-17 要求"必须实现且不许静默"）：Windows 侧直接 spawn `wsl.exe -- bash <launch>`
   * 并 `detached:true` ⇒ (b) 保住（父死子活），(a) **可能不满足**（Win11 + WT 下可能弹窗）。
   * 因此调用方会把它作为告警带回（`warning`），并由 `ensureDaemon` 推进 notes ⇒ 工具输出里可见。
   */
  const spawnCompat = (why) => {
    // ★ 防御（T17 回退面测试实测踩到）：这个 fd 可能**已经被关掉**（本函数会在 systemd 尝试之后被调用）。
    //   拿已关闭的 fd 号去 spawn 会抛 `EBADF` ⇒ 回退路径自己先崩，比不动手更糟。失败就退回 'ignore'。
    let child;
    try {
      child = spawn('wsl.exe', ['-d', cfg.distro, '--exec', 'bash', launcherLinux], {
        stdio: ['ignore', 'ignore', stderrFd ?? 'ignore'],
        windowsHide: true,
        detached: true, // ★ 这一条是 (b) 的代价来源：job breakaway 必须的，但它同时带来 DETACHED_PROCESS
      });
    } catch (e) {
      log(`兼容启动的 spawn 失败（stdio 里可能含已关闭的 fd）: ${e?.message ?? String(e)}；改用 ignore 重试`);
      child = spawn('wsl.exe', ['-d', cfg.distro, '--exec', 'bash', launcherLinux], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
        detached: true,
      });
    }
    closeStderrFd();
    child.on('error', (e) => log(`启动守护失败（spawn）: ${e.message}`));
    child.on('exit', (code) => {
      if (code !== 0) log(`守护启动包装层退出 code=${code}（详见 launch-stderr.log）`);
    });
    child.unref();
    const warning =
      `⚠️ 未能由 systemd 托管守护（${why}）⇒ 已回退到**兼容启动**：守护仍可脱离客户端存活（约束 b 保住），` +
      `但在 Win11 + Windows Terminal 下**可能弹出一个可见控制台窗口**（约束 a 不保证）。` +
      `建议在发行版 /etc/wsl.conf 里打开 \`[boot] systemd=true\`，执行 \`wsl --shutdown\` 重启发行版后再用（那样既无窗、又独立）。`;
    log(warning);
    return { ok: true, launcher: launcherLinux, mode: 'compat-detached', warning, systemdError: why };
  };

  /** 主路径：WSL 侧 systemd-run --user（短命包装层 ⇒ 无窗；unit 归 systemd ⇒ 与 Windows 侧解耦）。 */
  const trySystemd = () => {
    // ⚠️ 这里**不能**先 closeStderrFd()：systemd 失败时还要走 spawnCompat，而它需要这个 fd
    //    （先关掉会让回退 spawn 抛 EBADF —— T17 回退面测试就抓到了这个 bug）。成功/显式失败后再关。
    const r = spawnSync(
      'wsl.exe',
      ['-d', cfg.distro, '-e', 'bash', '-c', SYSTEMD_LAUNCH_SCRIPT, '_', launcherLinux, unit, stderrLogLinuxPath],
      { encoding: 'utf8', windowsHide: true, timeout: 25000 }, // 短命包装层：非 detached + windowsHide = 无窗
    );
    const stdout = String(r.stdout || '').replace(/\0/g, '');
    const stderrTail =
      String(r.stderr || '')
        .replace(/\0/g, '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !/WSL|localhost|NAT|wsl:/i.test(s))
        .slice(-1)[0] || '';
    if (r.status === 0 && stdout.includes('SYSTEMD_OK')) {
      log(`守护已由 systemd 托管（unit=${unit}）：Windows 侧包装层短命 ⇒ 无窗口；unit 归用户 systemd ⇒ 与 Windows 侧生死解耦`);
      return { ok: true, launcher: launcherLinux, mode: 'systemd', unit, warning: null };
    }
    const why = ((stdout.match(/SYSTEMD_FAIL:\s*(.*)/) || [])[1] || stderrTail || `systemd-run 失败（exit ${r.status}）`)
      .trim()
      .slice(0, 300);
    return { ok: false, why };
  };

  const mode = String(process.env.DSH_REMOTE_WSL_SYSTEMD ?? 'auto').toLowerCase();
  if (mode === 'off') return spawnCompat('DSH_REMOTE_WSL_SYSTEMD=off（显式关闭 systemd 托管）');
  const attempt = trySystemd();
  if (attempt.ok) {
    closeStderrFd(); // systemd 自己 append 到该文件；我们的 fd 不再需要
    return attempt;
  }
  if (mode === 'on') {
    closeStderrFd();
    return {
      ok: false,
      error: `remote-wsl: DSH_REMOTE_WSL_SYSTEMD=on 但 systemd 托管失败（${attempt.why}）；按显式配置**不**回退`,
      mode: 'systemd-required',
      warning: null,
      launcher: launchLinux(cfg, port), // 交给调用方在失败路径回收（F-38a）
    };
  }
  return spawnCompat(attempt.why);
}

/**
 * 配置相容性检查（task-9 追加 D）：复用已有守护前必须比对**关键参数**，不许静默忽略调用方的配置。
 *  · `hard`   = 结构性不兼容（cwd / profile）：复用会让"会话跑在错误的工作目录/插件集"上 ⇒ 明确报错。
 *  · `soft`   = 可容忍但不该静默（idleMs / queueLimit / lingerMs）：复用并**显式回报**（可用 restart 应用新值）。
 *  · `version`= 版本不一致：只报警 + 显式 restart（语义 #5：绝不自动杀，避免无声中断会话）。
 */

// ── 原 daemon-client.ts 第 603-618 行 ──
export function configCompat(cfg, info, wantedVersion) {
  const hard: string[] = [];
  const soft: string[] = [];
  if (info?.cwd && cfg?.cwd && info.cwd !== cfg.cwd) hard.push(`cwd ${info.cwd}≠${cfg.cwd}`);
  if (info?.profile && cfg?.profile && info.profile !== cfg.profile) hard.push(`profile ${info.profile}≠${cfg.profile}`);
  if (info?.idleMs != null && Number(info.idleMs) !== Number(cfg.daemonIdleMs)) soft.push(`idleMs ${info.idleMs}≠${cfg.daemonIdleMs}`);
  if (info?.queueLimit != null && Number(info.queueLimit) !== Number(cfg.daemonQueueLimit)) soft.push(`queueLimit ${info.queueLimit}≠${cfg.daemonQueueLimit}`);
  if (info?.lingerMs != null && Number(info.lingerMs) !== Number(cfg.daemonLingerMs)) soft.push(`lingerMs ${info.lingerMs}≠${cfg.daemonLingerMs}`);

  // 换角度评审第 1 条：插件/协议版本错配。守护是 detached 的，宿主升级后旧守护继续活着是**常态**；
  // 旧守护不认识新 op（fs.readChunk）、也缺新 meta 字段，必须让调用方看到"restart 后生效"，
  // 而不是让用户对着 unknown method 猜。
  const protocolDaemon = Number.isFinite(Number(info?.protocolVersion)) ? Number(info.protocolVersion) : null;
  const plugin = {
    daemon: info?.pluginVersion ? String(info.pluginVersion) : null,
    host: PLUGIN_VERSION,
    protocolDaemon,
    protocolHost: PROTOCOL_VERSION,
  };
  if (protocolDaemon != null && protocolDaemon > PROTOCOL_VERSION) {
    // 宿主比守护旧：宿主可能读不懂守护的新字段 ⇒ 不允许静默复用。
    hard.push(`守护协议 v${protocolDaemon} 高于宿主 v${PROTOCOL_VERSION}（宿主比守护旧，需先升级宿主或 restart 守护）`);
  } else if (protocolDaemon == null) {
    soft.push(`守护未上报协议版本（旧插件 pluginVersion=${plugin.daemon ?? 'unknown'}）⇒ 新功能（流式读取等）在 restart 前不可用`);
  } else if (protocolDaemon < PROTOCOL_VERSION) {
    soft.push(`守护协议 v${protocolDaemon} < 宿主 v${PROTOCOL_VERSION}（守护插件 ${plugin.daemon ?? 'unknown'} / 宿主 ${plugin.host}）⇒ 新功能在 restart 前不可用`);
  } else if (plugin.daemon && plugin.daemon !== plugin.host) {
    soft.push(`守护插件版本 ${plugin.daemon} ≠ 宿主 ${plugin.host} ⇒ 建议 wsl_daemon action=restart 对齐`);
  }

  return {
    hard,
    soft,
    plugin,
    version: wantedVersion && info?.version && info.version !== wantedVersion ? { daemon: info.version, wanted: wantedVersion } : null,
  };
}

/** 本插件**自己的**守护进程里，占了这两个端口之一的那些（按 /proc 身份扫描，不看元数据）。 */
