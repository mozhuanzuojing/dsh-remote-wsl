/**
 * dsh-remote-wsl / search-provision —— **在发行版里自动装搜索工具**（ripgrep / fd）。
 *
 * 为什么需要（用户要求 2026-10-23）：本机 WSL 有 `rg`/`fdfind`，但别的发行版不一定有。
 * 搜索优先用快工具（ripgrep、fd），缺了就不该静默退回慢的 grep/find —— 要么装，要么**明确提示**
 * 用户手动装。所以这里实现：
 *   1. 先 `command -v` 探测（`rg` / `fd` / `fdfind`）；
 *   2. 缺了且允许自动装 ⇒ 从 GitHub Releases 拉**静态 musl 二进制**，只写 `~/.local/bin`（**不用 sudo**）；
 *   3. 失败（网络/无 curl/无 tar）⇒ 返回 `notes[]`（可读原因 + 手动安装命令），搜索仍用回落后端，不假装成功。
 *
 * 只依赖 `node:` 内置；跑在 WSL 侧守护里（daemon import 它）。
 *
 * @module dsh-remote-wsl/search-provision
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 固定版本 + 静态二进制资产名（musl 不依赖发行版 glibc 版本）。 */
const PINS = {
  rg: {
    version: '14.1.1',
    bin: 'rg',
    assets: (arch) => [
      `ripgrep-14.1.1-${arch === 'aarch64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-musl'}.tar.gz`,
    ],
    manual: 'sudo apt install ripgrep   # Debian/Ubuntu；或 dnf install ripgrep',
  },
  fd: {
    version: 'v10.2.0',
    bin: 'fd',
    assets: (arch) => [
      `fd-v10.2.0-${arch === 'aarch64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'}.tar.gz`,
    ],
    manual: 'sudo apt install fd-find   # Debian/Ubuntu（二进制名 fdfind）',
  },
};

const exists = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const commandOf = (bin) => {
  const r = spawnSync('bash', ['-c', `command -v ${bin} 2>/dev/null`], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n')[0] : null;
};

const archOf = () => {
  const r = spawnSync('uname', ['-m'], { encoding: 'utf8', timeout: 5000 });
  return (r.stdout || '').trim() === 'aarch64' ? 'aarch64' : 'x86_64';
};

/** 用 curl 或 wget 下载；代理存在时走 `--proxy` / `https_proxy`。 */
function download(url, outFile, proxy) {
  if (commandOf('curl')) {
    const args = ['-fsSL', '--connect-timeout', '20', '--max-time', '300', '--retry', '3', '--retry-delay', '2', '--retry-all-errors', '-o', outFile];
    if (proxy) args.push('--proxy', proxy);
    args.push(url);
    const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 320000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: `curl exit ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
  }
  if (commandOf('wget')) {
    const args = ['-q', '-T', '180', '-O', outFile];
    if (proxy) args.push('-e', `https_proxy=${proxy}`);
    args.push(url);
    const r = spawnSync('wget', args, { encoding: 'utf8', timeout: 200000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: `wget exit ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
  }
  return { ok: false, error: '发行版里没有 curl 也没有 wget，无法下载' };
}

/** 从解压目录里找可执行文件（发布包目录名随版本变化，按文件名找）。 */
function findBinary(root, binName) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === binName && exists(full)) return full;
    }
  }
  return null;
}

/**
 * 装一个工具到 installDir（默认 `~/.local/bin`），返回绝对路径。
 * @returns `{ok, path, version, error}`
 */
export function installTool(name, { installDir, proxy } = {}) {
  const spec = PINS[name];
  if (!spec) return { ok: false, error: `unknown tool: ${name}` };
  const dir = installDir || path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const existing = path.join(dir, spec.bin);
  if (exists(existing)) return { ok: true, path: existing, version: spec.version, cached: true };
  const arch = archOf();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-rwsl-${name}-`));
  const errors = [];
  for (const asset of spec.assets(arch)) {
    const url = `https://github.com/${name === 'rg' ? 'BurntSushi/ripgrep' : 'sharkdp/fd'}/releases/download/${spec.version}/${asset}`;
    const tgz = path.join(tmp, asset);
    const dl = download(url, tgz, proxy);
    if (!dl.ok) {
      errors.push(`${asset}: ${dl.error}`);
      continue;
    }
    const extractDir = path.join(tmp, 'x');
    fs.mkdirSync(extractDir, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', tgz, '-C', extractDir], { encoding: 'utf8', timeout: 60000 });
    if (tar.status !== 0) {
      errors.push(`${asset}: tar exit ${tar.status}: ${(tar.stderr || '').slice(0, 120)}`);
      continue;
    }
    const found = findBinary(extractDir, spec.bin);
    if (!found) {
      errors.push(`${asset}: 解压后找不到 ${spec.bin}`);
      continue;
    }
    fs.copyFileSync(found, existing);
    fs.chmodSync(existing, 0o755);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return { ok: true, path: existing, version: spec.version };
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
  return { ok: false, error: errors.join(' | ') || '下载失败' };
}

/** 进程内缓存：同一安装目录只跑一次（自动安装可能很慢，不能每次搜索都试）。 */
const provisionCache = new Map();

/**
 * 确保搜索工具可用。
 * @param options.autoInstall - 允许自动安装（默认 true）
 * @param options.installDir - 安装目录（默认 `~/.local/bin`）
 * @param options.proxy - `http://host:port`（宿主代理网关；没有就直连）
 * @param options.ignorePath - 跳过 PATH 探测（只给探针模拟"发行版里没有"用）
 * @returns `{rg, fd, notes}`：绝对路径或 null + 可读提示（失败原因 / 手动安装命令）
 */
export function ensureSearchTools({ autoInstall = true, installDir, proxy, ignorePath = false } = {}) {
  const key = `${installDir || ''}|${proxy || ''}|${autoInstall ? '1' : '0'}|${ignorePath ? '1' : '0'}`;
  if (provisionCache.has(key)) return provisionCache.get(key);
  const notes = [];
  const resolve = (name) => {
    const spec = PINS[name];
    // PATH 上的名字：rg；fd 在 Debian 叫 fdfind（ignorePath 只给探针用：模拟"发行版里没有"）
    for (const candidate of ignorePath ? [] : name === 'fd' ? ['fd', 'fdfind'] : ['rg']) {
      const found = commandOf(candidate);
      if (found) return { path: found, source: 'path', backend: candidate };
    }
    if (!autoInstall) {
      notes.push(`${name} 未安装且已禁用自动安装；手动安装：${spec.manual}`);
      return { path: null, source: 'missing' };
    }
    const installed = installTool(name, { installDir, proxy });
    if (installed.ok) {
      notes.push(`已自动安装 ${name}@${installed.version} → ${installed.path}`);
      return { path: installed.path, source: 'installed' };
    }
    notes.push(`${name} 自动安装失败（${installed.error}）；搜索会回落到较慢的后端。手动安装：${spec.manual}`);
    return { path: null, source: 'failed' };
  };
  const rg = resolve('rg');
  const fd = resolve('fd');
  const result = { rg, fd, notes };
  provisionCache.set(key, result);
  return result;
}

/** 探测结果 → 给 search-rpc 用的绝对路径（null = 用 PATH 上的名字）。 */
export function toolPaths() {
  const last = [...provisionCache.values()].at(-1);
  return { rg: last?.rg?.path ?? null, fd: last?.fd?.path ?? null };
}
