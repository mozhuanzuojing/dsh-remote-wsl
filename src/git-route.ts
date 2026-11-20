/**
 * dsh-remote-wsl / git-route —— 把 **workspace-changes 的 git snapshot spawn** 重写进 distro。
 *
 * ## 为什么
 * `workspace-changes` 用 host git 在 workspace cwd 里跑 `git add --all / write-tree /
 * ls-files / diff-tree / cat-file ...` 做变更快照。WSL 工作区经 9p 共享，`git add --all` 是
 * 全工作树扫描（元数据最重的操作），9p 上极慢；且 host 侧 git 对 `\\wsl.localhost` 需要
 * `safe.directory` 白名单，未配就报 "dubious ownership"。
 *
 * ## 做法（纯函数，易测）
 * 仅当 **program 是 git** 且 **cwd 是某 distro 的 UNC** 且 **不是 discovery 调用**
 * （`--show-toplevel/--absolute-git-dir/--git-path` 会打印绝对路径供调用方按 UNC 解析，
 * 在 distro 里返回 Linux 路径会污染解析）时，才把 spawn 重写成一次性
 * `wsl.exe -d <distro> --cd <linuxCwd> --exec git ...`，并把调用方的 `GIT_*` 环境按路径
 * 坐标翻译（UNC→Linux、`D:\`→`/mnt/d`），随 `WSLENV` 透传。discovery 调用保持 host git
 * （host 有 git 时它原生答 UNC；缺 git 的机器维持现状，不在本模块范围）。
 *
 * 不引入任何 `@deepseek-ai/*` 内部类：只产出 `{ wslArgv, cwd, env }` 供上层运行时包装使用。
 *
 * @module dsh-remote-wsl/git-route
 */
import { parseWslUncPath } from './unc-path.ts';
import { toWindowsPath } from './native-mount.ts';

const GIT_PROGRAM = 'git';
const DISCOVERY_FLAGS = ['--show-toplevel', '--absolute-git-dir', '--git-path'];

/** program 是否 git（含路径/`.exe`）。 */
export function isGitProgram(program: unknown): boolean {
  if (typeof program !== 'string' || program.length === 0) return false;
  const base = program.slice(Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\')) + 1);
  return base.toLowerCase().replace(/\.exe$/u, '') === GIT_PROGRAM;
}

/** argv 是否带 discovery 绝对路径参数。 */
function namesDiscovery(argv: readonly unknown[]): boolean {
  return argv.some((arg) => typeof arg === 'string' && DISCOVERY_FLAGS.includes(arg));
}

/** Windows 盘符路径 → WSL 的 `/mnt/<drive>/...`；非盘符路径返回 undefined。 */
export function windowsToLinuxMount(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^([A-Za-z]):[\\/](.*)$/u.exec(value);
  if (m === null) return undefined;
  const rest = m[2].replace(/\\/gu, '/');
  return `/mnt/${m[1].toLowerCase()}/${rest}`;
}

/** 单个 `GIT_*` 值 → distro 坐标；UNC→Linux、盘符→/mnt；其它原样。 */
function translateSinglePathValue(value: string): string {
  const unc = parseWslUncPath(value);
  if (unc !== null && typeof unc.linuxPath === 'string') return unc.linuxPath.length > 0 ? unc.linuxPath : '/';
  const mounted = windowsToLinuxMount(value);
  return mounted === undefined ? value : mounted;
}

export function translateGitEnvValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // 多路径列表（Windows 用 `;` 分隔）：逐段翻译后用 POSIX 的 `:` 连接；任一段非路径则整体原样。
  if (value.indexOf(';') >= 0) {
    const parts = value.split(';');
    let changed = false;
    const mapped = parts.map((part) => {
      const t = translateSinglePathValue(part);
      if (t !== part) changed = true;
      return t;
    });
    if (changed) return mapped.join(':');
  }
  return translateSinglePathValue(value);
}

/** 翻译 git spawn 的环境；返回要随 WSLENV 透传的键名。 */
export function translateGitEnv(env: Record<string, string | undefined> | undefined): { env: Record<string, string | undefined>; wslenv: string[] } {
  const out: Record<string, string | undefined> = {};
  const names: string[] = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    out[name] = name.startsWith('GIT_') ? (translateGitEnvValue(value) as string | undefined) : value;
    if (name.startsWith('GIT_')) names.push(name);
  }
  return { env: out, wslenv: names };
}

/** 一个 git spawn 是否应进 distro；是则给出重写（否则 undefined=保持 host）。 */
export function gitSpawnRewrite(input: { argv?: readonly string[]; cwd?: string; wslPath: string }): { distro: string; linuxCwd: string; gitArgv: string[]; wslArgv: string[] } | undefined {
  const argv = input.argv;
  if (!Array.isArray(argv) || !isGitProgram(argv[0])) return undefined;
  if (namesDiscovery(argv)) return undefined;
  const named = parseWslUncPath(input.cwd);
  if (named === null) return undefined;
  const linuxCwd = typeof named.linuxPath === 'string' && named.linuxPath.length > 0 ? named.linuxPath : '/';
  const gitArgv = [GIT_PROGRAM, ...argv.slice(1)];
  return {
    distro: named.distro,
    linuxCwd,
    gitArgv,
    wslArgv: [input.wslPath, '-d', named.distro, '--cd', linuxCwd, '--exec', ...gitArgv],
  };
}

/**
 * `/mnt/<盘符>` 工作区的 git：**用宿主 git.exe 直接以 `D:\…` 为 cwd 原生跑**——不进 WSL、不碰
 * drvfs/9P（`git add --all` 是全工作树扫描，9P 上最慢）。
 *
 * 返回 `undefined` = 非 `/mnt` 工作区：ext4 UNC 交给 {@link gitSpawnRewrite} 走 WSL；Windows cwd 原样。
 * env **不翻译**（宿主 git 直接吃调用方的 Windows 语义）。
 */
export function nativeGitRewrite(input: { argv?: readonly string[]; cwd?: string }): { windowsCwd: string; gitArgv: string[] } | undefined {
  const argv = input.argv;
  if (!Array.isArray(argv) || !isGitProgram(argv[0])) return undefined;
  const named = parseWslUncPath(input.cwd);
  if (named === null) return undefined;
  const win = toWindowsPath(named.linuxPath);
  if (win === null) return undefined;
  return { windowsCwd: win, gitArgv: [GIT_PROGRAM, ...argv.slice(1)] };
}
