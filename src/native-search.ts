/**
 * dsh-remote-wsl / native-search —— `/mnt/<drive>` 的**原生搜索**（Windows rg.exe，免 9P）。
 *
 * 为什么不复用 search-rpc 直接跑：search-rpc 是"在发行版里跑 rg/fd"，对 `/mnt` 目标即 drvfs/9P。
 * 但对 `/mnt` 而言，搜的其实是 Windows 卷：用**宿主的 Windows ripgrep** 在 `D:\…` 上跑就是原生。
 *
 * 复用已测语义（不重写解析/匹配）：
 *   · grep 参数与 `search-rpc.grepBackends` 的 ripgrep 候选**逐字相同**（同一组 -n / --no-heading /
 *     --color never / --with-filename / --hidden / --no-ignore / --null，以及排除 .git、node_modules、
 *     .svn 三个目录的 --glob，末尾 `-e pattern -- root`），输出用 `parseGrepOutput` 解析，再把每条
 *     的 Windows 路径换回 `/mnt/…`。两处主后端都是 ripgrep，故结果一致。
 *   · glob 用 `rg --files --hidden --no-ignore`（+ 同款排除 .git/node_modules/.svn）枚举，再用
 *     `search-rpc.globToRegExp` 与 `path.posix.relative` 做**同一套**匹配/相对路径判定。
 *
 * 找不到可用的 Windows rg.exe（非 Windows / 未安装）时，`resolveWindowsRg()` 返回 null，调用方回落 WSL 搜索。
 *
 * @module dsh-remote-wsl/native-search
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { winToLinux, toWindowsPath } from './native-mount.ts';
import { parseGrepOutput, globToRegExp, GREP_MAX_MATCHES, GLOB_MAX_RESULTS, GLOB_MAX_SCAN } from './search-rpc.ts';

/** 定位 Windows ripgrep：环境变量覆盖 → DSH 打包的 @vscode/ripgrep-win32-x64 → 从 execPath 上溯。 */
let rgCache: string | null | undefined;
let rgProbed = false;

export function resolveWindowsRg(): string | null {
  if (process.platform !== 'win32') return null;
  if (rgProbed) return rgCache ?? null;
  rgProbed = true;
  const cands: string[] = [];
  const env = String(process.env.DSH_REMOTE_WSL_RG ?? '').trim();
  if (env) cands.push(env);
  const rel = ['app.asar.unpacked', 'dsh', 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe'];
  const rp = (process as any).resourcesPath;
  if (typeof rp === 'string' && rp) cands.push(path.join(rp, ...rel));
  try {
    let d = path.dirname(process.execPath);
    for (let i = 0; i < 5 && d; i++) {
      cands.push(path.join(d, 'resources', ...rel));
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  } catch {
    /* ignore */
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) {
        rgCache = c;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  return rgCache ?? null;
}

export function _resetRgCache(): void {
  rgProbed = false;
  rgCache = undefined;
}

function runCapture(cmd: string, args: string[], opts: { maxBytes: number; timeoutMs?: number; signal?: any }): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean; aborted: boolean }> {
  const { maxBytes, timeoutMs = 60000, signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { code: 'E_CANCELLED' }));
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    const errChunks: Buffer[] = [];
    let errTotal = 0;
    let done = false;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(reject, Object.assign(new Error(`${path.basename(cmd)} timed out`), { code: 'E_CANCELLED' }));
    }, timeoutMs);
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener?.('abort', onAbort);
    function finish(fn: any, v: any) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        /* ignore */
      }
      fn(v);
    }
    const outStream = child.stdout;
    const errStream = child.stderr;
    outStream.on('data', (b: Buffer) => {
      if (total >= maxBytes) {
        truncated = true;
        return;
      }
      total += b.length;
      if (total > maxBytes) truncated = true;
      chunks.push(b);
    });
    errStream.on('data', (b: Buffer) => {
      errTotal += b.length;
      if (errTotal < 32768) errChunks.push(b);
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) =>
      finish(resolve, {
        code,
        stdout: Buffer.concat(chunks, Math.min(total, maxBytes)).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        truncated,
        aborted: signal?.aborted === true,
      }),
    );
  });
}

const RG_EXCLUDES = ['--glob', '!**/.git/**', '--glob', '!**/node_modules/**', '--glob', '!**/.svn/**'];

/** 原生 grep `/mnt`：参数/解析与 WSL ripgrep 后端一致；返回 `{matches:[{path:linux,line,text}],...}` 或 null（无 rg）。 */
export async function nativeGrep(args: { pattern: string; rootLinux: string; fixedString?: boolean; ignoreCase?: boolean; maxMatches?: number; signal?: any }): Promise<any | null> {
  if (String(args.pattern ?? '').length === 0) return null; // 空模式交回 WSL（会报 E_ARG）；rg `-e ''` 会匹配全部行
  const rg = resolveWindowsRg();
  if (!rg) return null;
  const rootWin = toWindowsPath(args.rootLinux);
  if (rootWin === null) return null;
  const argv = [
    '-n', '--no-heading', '--color', 'never', '--with-filename', '--hidden', '--no-ignore', '--null',
    ...RG_EXCLUDES,
    ...(args.fixedString ? ['-F'] : []),
    ...(args.ignoreCase ? ['-i'] : []),
    '-e', String(args.pattern ?? ''), '--', rootWin,
  ];
  const r = await runCapture(rg, argv, { maxBytes: 512 * 1024, signal: args.signal });
  if (r.aborted) throw Object.assign(new Error('grep aborted'), { code: 'E_CANCELLED' });
  if (r.code !== 0 && r.code !== 1) throw new Error(`ripgrep(win) exit ${r.code}: ${String(r.stderr).slice(0, 300)}`);
  const limit = Math.max(1, Math.min(Number(args.maxMatches) || GREP_MAX_MATCHES, GREP_MAX_MATCHES));
  const parsed = parseGrepOutput(r.stdout, { truncated: r.truncated, limit });
  const matches = parsed.matches.map((m: any) => ({ path: winToLinux(m.path) ?? m.path, line: m.line, text: m.text }));
  const warnings: string[] = [];
  const se = String(r.stderr ?? '').trim();
  if (se) warnings.push(`ripgrep(win): ${se.slice(0, 300)}`);
  return { matches, truncated: parsed.truncated, total: matches.length, tool: 'grep', backend: 'ripgrep(win)', warnings };
}

/** 原生 glob `/mnt`：rg --files 枚举 + 与 globOp 同一套 globToRegExp 匹配；返回 `{files:[linux],...}` 或 null。 */
export async function nativeGlob(args: { pattern: string; rootLinux: string; maxResults?: number; signal?: any }): Promise<any | null> {
  if (String(args.pattern ?? '').trim().length === 0) return null; // 空模式交回 WSL（E_ARG）
  const rg = resolveWindowsRg();
  if (!rg) return null;
  const rootWin = toWindowsPath(args.rootLinux);
  if (rootWin === null) return null;
  const pattern = String(args.pattern ?? '');
  const argv = ['--files', '--hidden', '--no-ignore', ...RG_EXCLUDES, '--', rootWin];
  const r = await runCapture(rg, argv, { maxBytes: 8 * 1024 * 1024, signal: args.signal });
  if (r.aborted) throw Object.assign(new Error('glob aborted'), { code: 'E_CANCELLED' });
  if (r.code !== 0 && r.code !== 1) throw new Error(`ripgrep(win) --files exit ${r.code}: ${String(r.stderr).slice(0, 300)}`);
  const re = globToRegExp(pattern);
  const limit = Math.max(1, Math.min(Number(args.maxResults) || GLOB_MAX_RESULTS, GLOB_MAX_RESULTS));
  let listing = r.stdout;
  if (r.truncated) {
    const cut = listing.lastIndexOf('\n');
    listing = cut >= 0 ? listing.slice(0, cut + 1) : '';
  }
  const files: string[] = [];
  let scanned = 0;
  for (const absWin of listing.split('\n')) {
    if (absWin.length === 0) continue;
    if (++scanned > GLOB_MAX_SCAN) return { files, truncated: true, scanned, tool: 'glob', backend: 'rg-files(win)', warnings: [] };
    const absLin = winToLinux(absWin);
    if (absLin === null) continue;
    const rel = path.posix.relative(args.rootLinux, absLin);
    const subject = pattern.includes('/') ? rel : path.posix.basename(rel);
    if (!re.test(subject)) continue;
    files.push(absLin);
    if (files.length >= limit) return { files, truncated: true, scanned, tool: 'glob', backend: 'rg-files(win)', warnings: [] };
  }
  files.sort();
  return { files, truncated: r.truncated || false, scanned, tool: 'glob', backend: 'rg-files(win)', warnings: [] };
}
