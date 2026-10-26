/**
 * dsh-remote-wsl / search-provision —— **WSL 里按需/自动安装 Rust CLI 工具**。
 *
 * 用户要求（2026-10-23）：缺工具就自己装，装不上提示用户；把能用的 Rust 工具尽量都装上。
 *
 * 做法：
 *   1. 目录（{@link TOOLS}）列出仓库 + 二进制名（ripgrep、fd、ast-grep、sd、bat、tokei、difft、
 *      dust、procs、xh、hexyl、qsv、typos、taplo、just、delta、rga、hyperfine）；
 *   2. **从 GitHub Releases API 解析资产名**（不写死版本/后缀，适配各仓库命名差异），按
 *      linux/本机 arch/静态优先 选 tar.gz 或 zip；
 *   3. 下载（自动走宿主代理网关）→ 解压 → 复制到 `~/.local/bin`（**不用 sudo、不写系统目录**）；
 *   4. 失败返回可读原因 + 手动安装命令；调用方（工具/daemon）负责把提示带给用户，不静默降级。
 *
 * 只依赖 `node:` 内置；运行在 WSL 侧守护里。
 *
 * @module dsh-remote-wsl/search-provision
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * 工具目录。`bins` 是解压后可能出现的二进制名（各仓库不同），`repo` 用于调 GitHub API。
 * @type {Array<{id:string, repo:string, bins:string[], label:string}>}
 */
export const TOOLS = [
  { id: 'rg', repo: 'BurntSushi/ripgrep', bins: ['rg'], label: 'ripgrep 文本搜索' },
  { id: 'fd', repo: 'sharkdp/fd', bins: ['fd', 'fdfind'], label: 'fd 文件名搜索' },
  { id: 'ast-grep', repo: 'ast-grep/ast-grep', bins: ['sg', 'ast-grep'], label: 'ast-grep 结构化搜索/替换' },
  { id: 'sd', repo: 'chmln/sd', bins: ['sd'], label: 'sd 查找替换' },
  { id: 'bat', repo: 'sharkdp/bat', bins: ['bat', 'batcat'], label: 'bat 语法高亮预览' },
  { id: 'tokei', repo: 'XAMPPRocky/tokei', bins: ['tokei'], label: 'tokei 代码统计' },
  { id: 'difft', repo: 'Wilfred/difftastic', bins: ['difft'], label: 'difftastic 结构化 diff' },
  { id: 'dust', repo: 'bootandy/dust', bins: ['dust'], label: 'dust 磁盘占用' },
  { id: 'procs', repo: 'dalance/procs', bins: ['procs'], label: 'procs 进程查看' },
  { id: 'xh', repo: 'ducaale/xh', bins: ['xh'], label: 'xh HTTP 客户端' },
  { id: 'hexyl', repo: 'sharkdp/hexyl', bins: ['hexyl'], label: 'hexyl 十六进制查看' },
  { id: 'qsv', repo: 'dathere/qsv', bins: ['qsv'], label: 'qsv CSV 工具' },
  { id: 'typos', repo: 'crate-ci/typos', bins: ['typos'], label: 'typos 拼写检查' },
  { id: 'taplo', repo: 'tamasfe/taplo', bins: ['taplo'], label: 'taplo TOML 格式化/校验' },
  { id: 'just', repo: 'casey/just', bins: ['just'], label: 'just 任务运行器' },
  { id: 'delta', repo: 'dandavison/delta', bins: ['delta'], label: 'delta git diff 美化' },
  { id: 'rga', repo: 'phiresky/ripgrep-all', bins: ['rga'], label: 'rga 全格式搜索（PDF/压缩包）' },
  { id: 'hyperfine', repo: 'sharkdp/hyperfine', bins: ['hyperfine'], label: 'hyperfine 基准测试' },
];

/** 守护启动时后台预热的核心集合（其余按需装）。 */
export const CORE_TOOLS = ['rg', 'fd', 'ast-grep', 'sd', 'bat', 'tokei', 'dust', 'procs'];

/**
 * API 不可用（GitHub 未认证限流 60/小时、多人共享代理 IP 时很常见）时的**固定下载地址兜底**。
 * 这些 URL 已逐个用 `curl -r 0-0` 验证过（2026-10-23）；只有 x86_64，aarch64 仍走 API。
 * 资产名不随版本变化时可直接命中；版本过旧时若 404，会回落到"给用户手动安装提示"。
 */
const FALLBACK_X86_64 = {
  rg: { url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: '14.1.1' },
  fd: { url: 'https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v10.2.0' },
  'ast-grep': { url: 'https://github.com/ast-grep/ast-grep/releases/download/0.51.0/app-x86_64-unknown-linux-gnu.zip', kind: 'zip', tag: '0.51.0' },
  sd: { url: 'https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-x86_64-unknown-linux-gnu.tar.gz', kind: 'tar.gz', tag: 'v1.1.0' },
  bat: { url: 'https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v0.26.1' },
  tokei: { url: 'https://github.com/XAMPPRocky/tokei/releases/download/v12.1.2/tokei-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v12.1.2' },
  dust: { url: 'https://github.com/bootandy/dust/releases/download/v1.1.1/dust-v1.1.1-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v1.1.1' },
  procs: { url: 'https://github.com/dalance/procs/releases/download/v0.14.5/procs-v0.14.5-x86_64-linux.zip', kind: 'zip', tag: 'v0.14.5' },
  xh: { url: 'https://github.com/ducaale/xh/releases/download/v0.23.0/xh-v0.23.0-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v0.23.0' },
  hexyl: { url: 'https://github.com/sharkdp/hexyl/releases/download/v0.16.0/hexyl-v0.16.0-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v0.16.0' },
  difft: { url: 'https://github.com/Wilfred/difftastic/releases/download/0.65.0/difft-x86_64-unknown-linux-gnu.tar.gz', kind: 'tar.gz', tag: '0.65.0' },
  rga: { url: 'https://github.com/phiresky/ripgrep-all/releases/download/v0.10.6/ripgrep_all-v0.10.6-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v0.10.6' },
  taplo: { url: 'https://github.com/tamasfe/taplo/releases/download/0.9.3/taplo-linux-x86_64.gz', kind: 'gz', tag: '0.9.3' },
  qsv: { url: 'https://github.com/dathere/qsv/releases/download/0.135.0/qsv-0.135.0-x86_64-unknown-linux-musl.zip', kind: 'zip', tag: '0.135.0' },
  typos: { url: 'https://github.com/crate-ci/typos/releases/download/v1.29.7/typos-v1.29.7-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v1.29.7' },
  just: { url: 'https://github.com/casey/just/releases/download/1.38.0/just-1.38.0-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: '1.38.0' },
  delta: { url: 'https://github.com/dandavison/delta/releases/download/0.18.2/delta-0.18.2-x86_64-unknown-linux-gnu.tar.gz', kind: 'tar.gz', tag: '0.18.2' },
  hyperfine: { url: 'https://github.com/sharkdp/hyperfine/releases/download/v1.19.0/hyperfine-v1.19.0-x86_64-unknown-linux-musl.tar.gz', kind: 'tar.gz', tag: 'v1.19.0' },
};

const MANUAL = {
  rg: 'sudo apt install ripgrep',
  fd: 'sudo apt install fd-find',
  'ast-grep': 'npm i -g @ast-grep/cli   # 或 cargo install ast-grep',
  sd: 'cargo install sd',
  bat: 'sudo apt install bat',
  tokei: 'cargo install tokei',
  difft: 'cargo install difftastic',
  dust: 'cargo install du-dust',
  procs: 'cargo install procs',
  xh: 'cargo install xh',
  hexyl: 'cargo install hexyl',
  qsv: 'cargo install qsv',
  typos: 'cargo install typos-cli',
  taplo: 'cargo install taplo-cli',
  just: 'cargo install just',
  delta: 'cargo install git-delta',
  rga: 'cargo install ripgrep_all',
  hyperfine: 'cargo install hyperfine',
};

const execOk = (p) => {
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

/** 走 curl 取文本（GitHub API）。 */
function fetchText(url, proxy) {
  const args = ['-sSL', '--connect-timeout', '20', '--max-time', '120', '-w', '\n%{http_code}'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 150000 });
  const out = r.stdout ?? '';
  const cut = out.lastIndexOf('\n');
  const code = cut >= 0 ? out.slice(cut + 1).trim() : '';
  const body = cut >= 0 ? out.slice(0, cut) : out;
  if (r.status !== 0) return { ok: false, error: `curl exit ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
  if (code !== '200') return { ok: false, error: `HTTP ${code}: ${body.slice(0, 160)}` };
  return { ok: true, text: body };
}

/** 资产打分：linux + 本机架构 + 静态优先；排除校验/包管理器产物。 */
function scoreAsset(name, arch) {
  const n = name.toLowerCase();
  if (!/linux/.test(n)) return -1;
  if (!/\.(tar\.gz|tgz|zip|gz)$/.test(n)) return -1;
  if (/(sha256|sha512|\.sig|\.txt|\.json|\.sbom|\.deb|\.rpm|\.apk)/.test(n)) return -1;
  const archTokens = arch === 'aarch64' ? ['aarch64', 'arm64'] : ['x86_64', 'amd64'];
  if (!archTokens.some((t) => n.includes(t))) return -1;
  if (arch === 'x86_64' && /(aarch64|arm64|armv7|i686|i386)/.test(n)) return -1;
  if (arch === 'aarch64' && /(x86_64|amd64|i686|i386)/.test(n)) return -1;
  let score = 0;
  if (/musl/.test(n)) score += 4;
  if (/\.tar\.gz$/.test(n)) score += 3;
  if (/\.zip$/.test(n)) score += 1;
  if (/static/.test(n)) score += 2;
  return score;
}

/** 从 GitHub API 解析一个仓库的可下载资产。 */
export function resolveAsset(repo, { arch = archOf(), proxy = null } = {}) {
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = fetchText(api, proxy);
  if (!res.ok) return { ok: false, error: `GitHub API 失败（${api}）：${res.error}` };
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (e) {
    return { ok: false, error: `GitHub API 返回非 JSON：${String(e?.message ?? e).slice(0, 120)}` };
  }
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const ranked = assets
    .map((a) => ({ a, score: scoreAsset(String(a?.name ?? ''), arch) }))
    .filter((x) => x.score >= 0)
    .sort((x, y) => y.score - x.score);
  if (ranked.length === 0) return { ok: false, error: `没有匹配 linux/${arch} 的资产（共 ${assets.length} 个）` };
  const chosen = ranked[0].a;
  const name = String(chosen.name);
  return {
    ok: true,
    name,
    url: chosen.browser_download_url,
    tag: json.tag_name ?? null,
    kind: name.endsWith('.zip') ? 'zip' : name.endsWith('.tar.gz') || name.endsWith('.tgz') ? 'tar.gz' : 'gz',
  };
}

/**
 * 异步跑一条命令（下载/解压用）。**不能用 spawnSync**：守护是单进程，同步等待会把整个
 * 事件循环卡住——首次搜索/面板刷新会和几分钟的下载一起排队（2026-10-26 UX 复查）。
 * @returns `{code, error}`
 */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve({ code: null, error: e?.message ?? String(e) });
      return;
    }
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ code: null, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr.on('data', (c) => {
      stderr = (stderr + c).slice(-400);
    });
    child.on('error', (e) => finish({ code: null, error: e?.message ?? String(e) }));
    child.on('close', (code) => finish({ code, error: stderr.trim().slice(0, 200) }));
  });
}

async function download(url, outFile, proxy) {
  const args = ['-fsSL', '--connect-timeout', '20', '--max-time', '300', '--retry', '3', '--retry-delay', '2', '--retry-all-errors', '-o', outFile];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = await runCommand('curl', args, 320000);
  return r.code === 0 ? { ok: true } : { ok: false, error: `curl exit ${r.code}: ${r.error}` };
}

function findBinary(root, bins) {
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
      // 不要求解压后已有可执行位：zip 里的 `qsv` 就没有 exec 位（实测 2026-10-26），
      // 拷贝后统一 chmod 755，所以这里只按文件名认。
      else if (bins.includes(entry.name)) {
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          /* 忽略坏条目 */
        }
      }
    }
  }
  return null;
}

async function extract(file, kind, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (kind === 'tar.gz') {
    const r = await runCommand('tar', ['-xzf', file, '-C', dest], 120000);
    return r.code === 0 ? { ok: true } : { ok: false, error: `tar exit ${r.code}: ${r.error}` };
  }
  if (kind === 'zip') {
    if (!commandOf('unzip')) return { ok: false, error: '发行版里没有 unzip，无法解压 zip 资产' };
    const r = await runCommand('unzip', ['-q', '-o', file, '-d', dest], 120000);
    return r.code === 0 ? { ok: true } : { ok: false, error: `unzip exit ${r.code}: ${r.error}` };
  }
  const target = path.join(dest, 'payload');
  const r = await runCommand('bash', ['-c', `gzip -dc ${JSON.stringify(file)} > ${JSON.stringify(target)}`], 120000);
  return r.code === 0 ? { ok: true } : { ok: false, error: `gzip exit ${r.code}: ${r.error}` };
}

/**
 * 装一个工具到 installDir（默认 `~/.local/bin`）。
 * @param id - {@link TOOLS} 里的 id
 * @returns `{ok, path, version, asset, error}`
 */
/**
 * 解析一个工具的资产：先 GitHub API，失败（限流/网络/无资产）用固定兜底地址。
 * @returns 与 {@link resolveAsset} 同形，另带 `fallback:boolean`
 */
export function resolveAssetFor(id, { proxy = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}` };
  const api = resolveAsset(spec.repo, { proxy });
  if (api.ok) return { ...api, fallback: false };
  const arch = archOf();
  const fb = arch === 'x86_64' ? FALLBACK_X86_64[id] : null;
  if (fb) {
    const name = fb.url.split('/').pop();
    return { ok: true, name, url: fb.url, tag: fb.tag, kind: fb.kind, fallback: true, apiError: api.error };
  }
  return { ...api, fallback: false };
}

export async function installToolById(id, { installDir, proxy = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}` };
  const dir = installDir || path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const existing = spec.bins.map((b) => path.join(dir, b)).find((p) => execOk(p));
  if (existing) return { ok: true, path: existing, asset: 'cached' };
  const asset = resolveAssetFor(id, { proxy });
  if (!asset.ok) return { ok: false, error: asset.error };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-rwsl-${id}-`));
  try {
    const file = path.join(tmp, asset.name);
    const dl = await download(asset.url, file, proxy);
    if (!dl.ok) return { ok: false, error: `下载 ${asset.name} 失败：${dl.error}` };
    const extracted = path.join(tmp, 'x');
    const ex = await extract(file, asset.kind, extracted);
    if (!ex.ok) return { ok: false, error: `解压 ${asset.name} 失败：${ex.error}` };
    // 单文件 `.gz` 资产（如 taplo-linux-x86_64.gz）解压出来叫 payload，没有目录结构，
    // 直接按工具名落盘；tar.gz/zip 才去包里找匹配的二进制名。
    const payload = path.join(extracted, 'payload');
    const found = asset.kind === 'gz' && fs.existsSync(payload) ? payload : findBinary(extracted, spec.bins);
    if (!found) return { ok: false, error: `${asset.name} 里找不到 ${spec.bins.join('/')}` };
    const target = path.join(dir, asset.kind === 'gz' ? spec.bins[0] : path.basename(found));
    fs.copyFileSync(found, target);
    fs.chmodSync(target, 0o755);
    return { ok: true, path: target, version: asset.tag ?? null, asset: asset.name };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const cache = new Map();

/**
 * 确保一组工具可用（先 PATH、再已装目录、最后自动下载安装）。
 * @param ids - 工具 id 列表
 * @param options.autoInstall - 允许自动安装（默认 true）
 * @param options.ignorePath - 跳过 PATH 探测（探针用）
 * @returns `{tools:{[id]:{path,source,version}}, notes}`
 */
export async function ensureTools(ids, { autoInstall = true, installDir, proxy = null, ignorePath = false } = {}) {
  const key = `${ids.join(',')}|${installDir || ''}|${proxy || ''}|${autoInstall ? '1' : '0'}|${ignorePath ? '1' : '0'}`;
  if (cache.has(key)) return cache.get(key);
  const dir = installDir || path.join(os.homedir(), '.local', 'bin');
  const tools = {};
  const notes = [];
  for (const id of ids) {
    const spec = TOOLS.find((t) => t.id === id);
    if (!spec) {
      tools[id] = { path: null, source: 'unknown' };
      notes.push(`未知工具：${id}`);
      continue;
    }
    const onPath = ignorePath ? null : spec.bins.map((b) => commandOf(b)).find(Boolean) ?? null;
    if (onPath) {
      tools[id] = { path: onPath, source: 'path' };
      continue;
    }
    const preinstalled = spec.bins.map((b) => path.join(dir, b)).find((p) => execOk(p));
    if (preinstalled) {
      tools[id] = { path: preinstalled, source: 'installed-dir' };
      continue;
    }
    if (!autoInstall) {
      tools[id] = { path: null, source: 'missing' };
      notes.push(`${id} 未安装（已禁用自动安装）；手动安装：${MANUAL[id] ?? '见项目文档'}`);
      continue;
    }
    const installed = await installToolById(id, { installDir: dir, proxy });
    if (installed.ok) {
      tools[id] = { path: installed.path, source: 'installed', version: installed.version };
      notes.push(`已自动安装 ${id}${installed.version ? `@${installed.version}` : ''} → ${installed.path}`);
    } else {
      tools[id] = { path: null, source: 'failed' };
      notes.push(`${id} 自动安装失败（${installed.error}）；手动安装：${MANUAL[id] ?? '见项目文档'}`);
    }
  }
  const result = { tools, notes };
  cache.set(key, result);
  return result;
}

/** 搜索用：确保 rg/fd（保留旧名，语义不变）。 */
export async function ensureSearchTools(opts = {}) {
  const r = await ensureTools(['rg', 'fd'], opts);
  return {
    rg: { path: r.tools.rg?.path ?? null, source: r.tools.rg?.source },
    fd: { path: r.tools.fd?.path ?? null, source: r.tools.fd?.source },
    notes: r.notes,
  };
}

/** rg/fd 的绝对路径（daemon 注入给 search-rpc）。 */
export function toolPaths() {
  const last = [...cache.values()].at(-1);
  return { rg: last?.tools?.rg?.path ?? null, fd: last?.tools?.fd?.path ?? null };
}

/** 允许工具清单读取（`wsl_tools` 用）。 */
export function catalog() {
  return TOOLS.map((t) => ({ id: t.id, repo: t.repo, label: t.label, manual: MANUAL[t.id] ?? null }));
}
