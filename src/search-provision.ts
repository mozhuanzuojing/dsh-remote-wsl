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
 * 2026-10-27 搜索层修复（F-12 / F-14 / F-22 / F-25）：
 *   · **探测/解析/下载全部异步**（`runAsync`：超时 + AbortSignal ⇒ SIGKILL 子进程）。旧实现用
 *     `spawnSync` + curl（最长 150s）解析资产，守护是单进程，同步等待会**卡住整个事件循环**：
 *     首次搜索要等安装，期间面板刷新和其它 RPC 一起排队。
 *   · **搜索路径不等待安装**（F-12）：{@link ensureSearchToolsNonBlocking} 只返回
 *     "就绪 / 正在安装 / 失败" 的状态快照，缺工具时把安装丢到**后台**，本次搜索立刻用搜索层
 *     自带的 GNU grep/find 兜底；装好后的下一次搜索自动用上 rg/fd。并发请求共享同一个安装
 *     Promise（in-flight 去重，F-25），不会重复下载。
 *   · **失败不永久缓存**（F-25）：成功结果缓存 10 分钟、失败只记 60 秒（过后允许重试），
 *     `force:true` 可立刻重试；失败始终通过 `tools[id].source === 'failed'` + `notes` 返回，
 *     不伪装成功。
 *   · **{@link toolPaths} 按工具 id 合并**（F-22）：旧实现取 `[...cache.values()].at(-1)`，
 *     "先装 rg、再装别的工具" 之后 rg 路径就丢了，搜索会白退回慢后端。
 *   · 兼容：`resolveAsset()` / `resolveAssetFor()` 保留**同步**签名，只服务 daemon 的
 *     `provision{ resolveOnly: true }` 诊断分支（daemon.ts 里那一行不在本模块写面内）。
 *     它内部仍是同步 curl；**搜索/安装热路径已完全不再调用它**。daemon 若把那一行改成
 *     `await resolveAssetForAsync(...)`，这两个同步入口即可整段删除。
 *
 * 只依赖 `node:` 内置；运行在 WSL 侧守护里。
 *
 * @module dsh-remote-wsl/search-provision
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

/** PATH 探测（`command -v`）结果缓存时长：装完二进制后最多 10 秒就能被看见（F-22 附带项）。 */
const PATH_PROBE_TTL_MS = 10_000;
/** 全量探测成功结果的缓存时长：用户可能删掉 ~/.local/bin 里的二进制，过一会儿重新确认。 */
const RESULT_SUCCESS_TTL_MS = 10 * 60_000;
/**
 * 失败重试闸门：搜索路径每来一次请求都重打 GitHub 会立刻触发未认证限流（60/小时），
 * 所以非阻塞入口在失败后 60 秒内只报告失败、不再起新的下载；过了 TTL 自动重试。
 * （失败**不永久缓存**：旧实现把失败结果永久写进 cache，一次网络抖动就永远装不上。）
 */
const FAILURE_RETRY_TTL_MS = 60_000;
/** 一次 curl 最多收多少字节（GitHub releases/latest 的 JSON 通常几百 KB）。 */
const FETCH_MAX_BYTES = 8 * 1024 * 1024;

const execOk = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultBinDir = () => path.join(os.homedir(), '.local', 'bin');

/** 一条命令的结果（异步实现，见 {@link runAsync}）。 */
const emptyRun = (error, timedOut = false) => ({ code: null, stdout: '', stderr: '', error, timedOut, truncated: false });

/**
 * 异步跑一条命令（探测/解析/下载/解压）。**不能用 spawnSync**：守护是单进程，同步等待会把整个
 * 事件循环卡住——首次搜索/面板刷新会和几分钟的下载一起排队（2026-10-26 UX 复查 / F-14）。
 * 超时或 AbortSignal 取消时 SIGKILL 子进程，避免留下悬挂的 curl/tar。
 * @returns `Promise<{code, stdout, stderr, error, timedOut, truncated}>`
 */
function runAsync(command, args, { timeoutMs = 120_000, maxBytes = 1024 * 1024, signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(emptyRun('aborted by caller'));
      return;
    }
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve(emptyRun(e?.message ?? String(e)));
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let settled = false;
    let aborted = false;
    let timer = null;
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    timer = setTimeout(() => {
      kill();
      finish({ ...emptyRun(`timed out after ${timeoutMs}ms`, true), stdout: Buffer.concat(out).toString('utf8') });
    }, timeoutMs);
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch {
      /* ignore */
    }
    child.stdout.on('data', (c) => {
      if (outBytes >= maxBytes) return;
      out.push(c);
      outBytes += c.length;
    });
    child.stderr.on('data', (c) => {
      if (err.length < 200) err.push(c);
    });
    child.on('error', (e) => finish(emptyRun(e?.message ?? String(e))));
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: aborted ? 'aborted by caller' : null,
        timedOut: false,
        truncated: outBytes >= maxBytes,
      });
    });
  });
}

/**
 * 代理参数可以是字符串，也可以是**惰性取值函数**：只有真要下载时才去探活宿主代理
 * （F-30：搜索路径不必每次都做 TCP 探活；就绪时一次调用都不做）。
 */
async function resolveProxyArg(proxy) {
  if (typeof proxy === 'function') {
    try {
      const value = await proxy();
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }
  return typeof proxy === 'string' && proxy ? proxy : null;
}

const pathProbeCache = new Map(); // bin -> {path, at}

/**
 * `command -v <bin>`（带 TTL 缓存）。旧实现用 spawnSync 且缓存永不失效：装完工具后探测仍然
 * 说"没有"（F-22 附带项）。异步 + 10s TTL 让新装的二进制在短时间内可见。
 */
async function commandOf(bin, { signal = null } = {}) {
  const hit = pathProbeCache.get(bin);
  if (hit && Date.now() - hit.at < PATH_PROBE_TTL_MS) return hit.path;
  const r = await runAsync('bash', ['-c', `command -v ${JSON.stringify(bin)} 2>/dev/null`], {
    timeoutMs: 5000,
    maxBytes: 64 * 1024,
    signal,
  });
  const first = (r.stdout || '').trim().split('\n')[0] || '';
  const found = r.code === 0 && first.startsWith('/') && execOk(first) ? first : null;
  pathProbeCache.set(bin, { path: found, at: Date.now() });
  return found;
}

let archCache = null;

/** 本机架构：`uname -m`（异步；失败时退回 `process.arch`，别因为探测失败就默认 x86_64）。 */
async function archOf({ signal = null } = {}) {
  if (archCache) return archCache;
  let machine = '';
  try {
    const r = await runAsync('uname', ['-m'], { timeoutMs: 5000, maxBytes: 4096, signal });
    machine = (r.stdout || '').trim();
  } catch {
    machine = '';
  }
  if (machine === 'aarch64' || machine === 'arm64') archCache = 'aarch64';
  else if (machine) archCache = 'x86_64';
  else archCache = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return archCache;
}

/** 走 curl 取文本（GitHub API）。异步：不能阻塞守护事件循环（F-14）。 */
async function fetchText(url, proxy, { signal = null, timeoutMs = 150_000 } = {}) {
  const args = ['-sSL', '--connect-timeout', '20', '--max-time', '120', '-w', '\n%{http_code}'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = await runAsync('curl', args, { timeoutMs, maxBytes: FETCH_MAX_BYTES, signal });
  if (r.error) return { ok: false, error: `curl ${r.error}` };
  const out = r.stdout ?? '';
  const cut = out.lastIndexOf('\n');
  const code = cut >= 0 ? out.slice(cut + 1).trim() : '';
  const body = cut >= 0 ? out.slice(0, cut) : out;
  if (r.code !== 0) return { ok: false, error: `curl exit ${r.code}: ${(r.stderr || '').slice(0, 200)}` };
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

/** 从 GitHub API 解析一个仓库的可下载资产（异步主实现）。 */
export async function resolveAssetAsync(repo, { arch = null, proxy = null, signal = null } = {}) {
  const targetArch = arch || (await archOf({ signal }));
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetchText(api, await resolveProxyArg(proxy), { signal });
  if (!res.ok) return { ok: false, error: `GitHub API 失败（${api}）：${res.error}` };
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (e) {
    return { ok: false, error: `GitHub API 返回非 JSON：${String(e?.message ?? e).slice(0, 120)}` };
  }
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const ranked = assets
    .map((a) => ({ a, score: scoreAsset(String(a?.name ?? ''), targetArch) }))
    .filter((x) => x.score >= 0)
    .sort((x, y) => y.score - x.score);
  if (ranked.length === 0) return { ok: false, error: `没有匹配 linux/${targetArch} 的资产（共 ${assets.length} 个）` };
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
 * 解析一个工具的资产（异步主实现）：先 GitHub API，失败（限流/网络/无资产）用固定兜底地址。
 * @returns 与 {@link resolveAssetAsync} 同形，另带 `fallback:boolean`
 */
export async function resolveAssetForAsync(id, { proxy = null, signal = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}`, fallback: false };
  const proxyUrl = await resolveProxyArg(proxy);
  const api = await resolveAssetAsync(spec.repo, { proxy: proxyUrl, signal });
  if (api.ok) return { ...api, fallback: false };
  const arch = archCache || (await archOf({ signal }));
  const fb = arch === 'x86_64' ? FALLBACK_X86_64[id] : null;
  if (fb) {
    const name = fb.url.split('/').pop();
    return { ok: true, name, url: fb.url, tag: fb.tag, kind: fb.kind, fallback: true, apiError: api.error };
  }
  return { ...api, fallback: false };
}

/** 同步入口（deprecated）：只给 daemon 的 `provision{resolveOnly:true}` 诊断分支用。 */
function fetchTextSync(url, proxy, { timeoutMs = 150_000 } = {}) {
  const args = ['-sSL', '--connect-timeout', '20', '--max-time', '120', '-w', '\n%{http_code}'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: FETCH_MAX_BYTES });
  const out = r.stdout ?? '';
  const cut = out.lastIndexOf('\n');
  const code = cut >= 0 ? out.slice(cut + 1).trim() : '';
  const body = cut >= 0 ? out.slice(0, cut) : out;
  if (r.error) return { ok: false, error: `curl ${r.error.message ?? String(r.error)}` };
  if (r.status !== 0) return { ok: false, error: `curl exit ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
  if (code !== '200') return { ok: false, error: `HTTP ${code}: ${body.slice(0, 160)}` };
  return { ok: true, text: body };
}

function archOfSync() {
  if (archCache) return archCache;
  try {
    const r = spawnSync('uname', ['-m'], { encoding: 'utf8', timeout: 5000 });
    const machine = (r.stdout || '').trim();
    if (machine === 'aarch64' || machine === 'arm64') archCache = 'aarch64';
    else if (machine) archCache = 'x86_64';
  } catch {
    /* 走下面的默认值 */
  }
  if (!archCache) archCache = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return archCache;
}

/** 同步版资产解析（deprecated，见文件头）。 */
export function resolveAsset(repo, { arch = archOfSync(), proxy = null } = {}) {
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = fetchTextSync(api, proxy);
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

/** 同步版 `resolveAssetFor`（deprecated，只给 daemon resolveOnly 诊断分支；见文件头）。 */
export function resolveAssetFor(id, { proxy = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}` };
  const api = resolveAsset(spec.repo, { proxy });
  if (api.ok) return { ...api, fallback: false };
  const arch = archOfSync();
  const fb = arch === 'x86_64' ? FALLBACK_X86_64[id] : null;
  if (fb) {
    const name = fb.url.split('/').pop();
    return { ok: true, name, url: fb.url, tag: fb.tag, kind: fb.kind, fallback: true, apiError: api.error };
  }
  return { ...api, fallback: false };
}

/** 已确认可用的工具路径（按 id 合并，F-22）：Path 探测/安装目录/后台安装成功都记这里。 */
const known = new Map(); // id -> {path, source, version, at}
/** 失败记录（带 TTL，F-25）：{error, at}；过期后允许重试。 */
const failures = new Map();
/** 正在跑的安装（in-flight 去重，F-25）：key = `${id}|${dir}`。 */
const installInFlight = new Map();
/** ensureTools 的结果缓存：key -> {result, at, complete}。 */
const resultCache = new Map();

function recordKnown(id, entry) {
  if (!entry?.path) return;
  known.set(id, { path: entry.path, source: entry.source ?? 'unknown', version: entry.version ?? null, at: Date.now() });
}

function recordKnownFromResult(result) {
  for (const [id, t] of Object.entries(result?.tools ?? {})) {
    if (t?.path) recordKnown(id, t);
  }
}

function failureOf(id) {
  const f = failures.get(id);
  if (!f) return null;
  if (Date.now() - f.at > FAILURE_RETRY_TTL_MS) {
    failures.delete(id);
    return null;
  }
  return f;
}

const isInstalling = (id, installDir) => installInFlight.has(`${id}|${installDir || defaultBinDir()}`);

/**
 * 定位一个工具（不安装）：已确认的 known 快路径 → PATH（带 TTL 缓存）→ 安装目录。
 * @returns `{path, source, version?}`；没找到时 `path:null, source:'missing'|'unknown'`
 */
async function locateTool(id, { installDir, ignorePath = false, signal = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { path: null, source: 'unknown' };
  const cached = known.get(id);
  if (cached?.path) {
    if (execOk(cached.path)) return { path: cached.path, source: cached.source, version: cached.version };
    known.delete(id); // 二进制被删/不可执行 ⇒ 别把死路径继续注入搜索后端
  }
  if (!ignorePath) {
    for (const bin of spec.bins) {
      const p = await commandOf(bin, { signal });
      if (p) {
        const entry = { path: p, source: 'path' };
        recordKnown(id, entry);
        return entry;
      }
    }
  }
  const dir = installDir || defaultBinDir();
  for (const bin of spec.bins) {
    const p = path.join(dir, bin);
    if (execOk(p)) {
      const entry = { path: p, source: 'installed-dir' };
      recordKnown(id, entry);
      return entry;
    }
  }
  return { path: null, source: 'missing' };
}

/** 起一次安装（in-flight 去重由 {@link installToolById} 保证：并发搜索只发一次下载）。 */
function startInstall(id, { installDir, proxy = null, signal = null } = {}) {
  const dir = installDir || defaultBinDir();
  const running = installInFlight.get(`${id}|${dir}`);
  if (running) return running;
  return installToolById(id, { installDir: dir, proxy, signal });
}

/**
 * 装一个工具到 installDir（默认 `~/.local/bin`）。
 * 下载/解析/解压全异步；同一 (id, dir) 的并发调用共享一个 Promise（不会重复下载）。
 * @returns `{ok, path, version, asset, fallback?, error?}`
 */
export async function installToolById(id, { installDir, proxy = null, signal = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}` };
  const dir = installDir || defaultBinDir();
  const existing = spec.bins.map((b) => path.join(dir, b)).find((p) => execOk(p));
  if (existing) {
    recordKnown(id, { path: existing, source: 'installed-dir' });
    return { ok: true, path: existing, asset: 'cached', source: 'installed-dir' };
  }
  const key = `${id}|${dir}`;
  const running = installInFlight.get(key);
  if (running) return running;
  const task = (async () => {
    let tmp = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const proxyUrl = await resolveProxyArg(proxy);
      const asset = await resolveAssetForAsync(id, { proxy: proxyUrl, signal });
      if (!asset.ok) {
        failures.set(id, { error: asset.error, at: Date.now() });
        return { ok: false, error: asset.error, fallback: false };
      }
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-rwsl-${id}-`));
      const file = path.join(tmp, asset.name);
      const dl = await download(asset.url, file, proxyUrl, signal);
      if (!dl.ok) {
        const error = `下载 ${asset.name} 失败：${dl.error}`;
        failures.set(id, { error, at: Date.now() });
        return { ok: false, error, fallback: !!asset.fallback };
      }
      // 换角度评审第 2 条：有校验文件就**必须**匹配（不匹配直接放弃安装）；没有就标 unverified，
      // 绝不把"没校验"伪装成"已验证"。
      let verified = 'unavailable';
      if (asset.checksumUrl) {
        const cs = await verifySha256(file, asset, proxyUrl, signal);
        if (!cs.ok) {
          const error = `校验 ${asset.name} 失败：${cs.error}`;
          failures.set(id, { error, at: Date.now() });
          return { ok: false, error, fallback: !!asset.fallback, verified: 'mismatch' };
        }
        verified = 'ok';
      }
      const extracted = path.join(tmp, 'x');
      const ex = await extract(file, asset.kind, extracted, signal);
      if (!ex.ok) {
        const error = `解压 ${asset.name} 失败：${ex.error}`;
        failures.set(id, { error, at: Date.now() });
        return { ok: false, error, fallback: !!asset.fallback };
      }
      // 单文件 `.gz` 资产（如 taplo-linux-x86_64.gz）解压出来叫 payload，没有目录结构，
      // 直接按工具名落盘；tar.gz/zip 才去包里找匹配的二进制名。
      const payload = path.join(extracted, 'payload');
      const found = asset.kind === 'gz' && fs.existsSync(payload) ? payload : findBinary(extracted, spec.bins);
      if (!found) {
        const error = `${asset.name} 里找不到 ${spec.bins.join('/')}`;
        failures.set(id, { error, at: Date.now() });
        return { ok: false, error, fallback: !!asset.fallback };
      }
      const target = path.join(dir, asset.kind === 'gz' ? spec.bins[0] : path.basename(found));
      fs.copyFileSync(found, target);
      fs.chmodSync(target, 0o755);
      const entry = { path: target, source: 'installed', version: asset.tag ?? null, verified };
      recordKnown(id, entry);
      failures.delete(id);
      return {
        ok: true,
        path: target,
        version: asset.tag ?? null,
        asset: asset.name,
        source: 'installed',
        fallback: !!asset.fallback,
        apiError: asset.apiError,
        // 'ok' = 发布页摘要匹配；'unavailable' = 上游没提供摘要（已知风险，可见）
        verified,
      };
    } catch (e) {
      const error = e?.message ?? String(e);
      failures.set(id, { error, at: Date.now() });
      return { ok: false, error, fallback: false };
    } finally {
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  })();
  installInFlight.set(key, task);
  const settle = () => {
    if (installInFlight.get(key) === task) installInFlight.delete(key);
  };
  task.then(settle, settle);
  return task;
}

async function download(url, outFile, proxy, signal = null) {
  const args = ['-fsSL', '--connect-timeout', '20', '--max-time', '300', '--retry', '3', '--retry-delay', '2', '--retry-all-errors', '-o', outFile];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = await runAsync('curl', args, { timeoutMs: 320_000, maxBytes: 64 * 1024, signal });
  if (r.error) return { ok: false, error: r.error };
  return r.code === 0 ? { ok: true } : { ok: false, error: `curl exit ${r.code}: ${(r.stderr || '').slice(0, 200)}` };
}

/**
 * 从校验文件正文里挑出指定文件的 sha256（纯函数，便于离线单测）。
 * 支持两种发布形态：`<hex>  <name>` 多行清单，以及只有单个 hex 的文件。
 * @param text 校验文件正文
 * @param fileName 目标资产文件名（可带路径，按 basename 比）
 * @returns 小写 hex，或 null（找不到）
 */
export function pickSha256(text, fileName) {
  const base = String(fileName ?? '').split('/').pop();
  const body = String(text ?? '');
  let sawNamed = false;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!m) continue;
    sawNamed = true;
    const name = m[2].split('/').pop();
    if (name === base) return m[1].toLowerCase();
  }
  // 清单格式里没有目标文件 ⇒ **不猜**（拿别的文件的摘要顶替只会得到"恒失败"，且掩盖上游改名）。
  if (sawNamed) return null;
  // 只有单个摘要值的文件（有些仓库只发布 `sha256sum` 单值文件）。
  const all = [...body.matchAll(/\b([0-9a-fA-F]{64})\b/g)].map((m) => m[1].toLowerCase());
  return all.length === 1 ? all[0] : null;
}

/**
 * 校验下载产物的 sha256（换角度评审第 2 条）。
 *
 * 为什么：插件会在用户机器上**自动下载并执行** GitHub Releases 里的二进制；旧实现把发布页上的
 * `*.sha256` / `SHA256SUMS` 当作噪音过滤掉，安装后只验"可执行位" —— 上游资产被替换或镜像劫持时，
 * 没有任何一层会察觉。这里用发布页自带的摘要做校验：有摘要就必须匹配，没有就如实标 `unavailable`。
 *
 * @returns `{ok:true}` 校验通过；`{ok:false, error}` 下载/解析/不匹配（调用方必须放弃安装）
 */
async function verifySha256(file, asset, proxy, signal = null) {
  const res = await fetchText(asset.checksumUrl, proxy, { signal, timeoutMs: 60_000 });
  if (!res.ok) return { ok: false, error: `下载校验文件失败：${res.error}` };
  const expected = pickSha256(res.text, asset.name);
  if (!expected) return { ok: false, error: `校验文件 ${asset.checksumName ?? ''} 里找不到 ${asset.name} 的摘要` };
  const actual = await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  if (String(actual).toLowerCase() !== expected) {
    return { ok: false, error: `sha256 不匹配：期望 ${expected.slice(0, 16)}… 实际 ${String(actual).slice(0, 16)}…（拒绝安装）` };
  }
  return { ok: true, expected };
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

async function extract(file, kind, dest, signal = null) {
  fs.mkdirSync(dest, { recursive: true });
  if (kind === 'tar.gz') {
    const r = await runAsync('tar', ['-xzf', file, '-C', dest], { timeoutMs: 120_000, maxBytes: 64 * 1024, signal });
    return r.code === 0 ? { ok: true } : { ok: false, error: `tar exit ${r.code}: ${r.error ?? r.stderr.trim().slice(0, 200)}` };
  }
  if (kind === 'zip') {
    if (!(await commandOf('unzip', { signal }))) return { ok: false, error: '发行版里没有 unzip，无法解压 zip 资产' };
    const r = await runAsync('unzip', ['-q', '-o', file, '-d', dest], { timeoutMs: 120_000, maxBytes: 64 * 1024, signal });
    return r.code === 0 ? { ok: true } : { ok: false, error: `unzip exit ${r.code}: ${r.error ?? r.stderr.trim().slice(0, 200)}` };
  }
  const target = path.join(dest, 'payload');
  const r = await runAsync('bash', ['-c', `gzip -dc ${JSON.stringify(file)} > ${JSON.stringify(target)}`], { timeoutMs: 120_000, maxBytes: 64 * 1024, signal });
  return r.code === 0 ? { ok: true } : { ok: false, error: `gzip exit ${r.code}: ${r.error ?? r.stderr.trim().slice(0, 200)}` };
}

/** 等一次安装（ensureTools/显式安装用；搜索路径不要用这个，见 {@link ensureSearchToolsNonBlocking}）。 */
async function ensureToolReady(id, { installDir, autoInstall = true, ignorePath = false, proxy = null, signal = null, force = false, failureGate = false } = {}) {
  const dir = installDir || defaultBinDir();
  const located = await locateTool(id, { installDir: dir, ignorePath, signal });
  if (located.path) {
    return { entry: { path: located.path, source: located.source, version: located.version ?? null }, note: null };
  }
  if (!autoInstall) {
    return { entry: { path: null, source: 'missing' }, note: `${id} 未安装（已禁用自动安装）；手动安装：${MANUAL[id] ?? '见项目文档'}` };
  }
  // awaiting 的调用通常是"明确要装"（wsl_tools install / 显式 provision）：失败后允许立刻重试。
  // 例外是 daemon 的搜索后台安装（ensureSearchTools ⇒ failureGate）：每次搜索都重打 GitHub 会触发
  // 未认证限流（60/小时），所以在失败后 60 秒内只回报失败、不再起新的下载。
  if (failureGate && !force) {
    const recent = failureOf(id);
    if (recent) {
      return { entry: { path: null, source: 'failed' }, note: `${id} 自动安装失败（${recent.error}）；手动安装：${MANUAL[id] ?? '见项目文档'}` };
    }
  }
  if (force) failures.delete(id);
  const installed = await startInstall(id, { installDir: dir, proxy, signal });
  if (installed.ok) {
    return {
      entry: { path: installed.path, source: 'installed', version: installed.version ?? null },
      note: `已自动安装 ${id}${installed.version ? `@${installed.version}` : ''} → ${installed.path}`,
    };
  }
  return { entry: { path: null, source: 'failed' }, note: `${id} 自动安装失败（${installed.error}）；手动安装：${MANUAL[id] ?? '见项目文档'}` };
}

const proxyKey = (proxy) => (typeof proxy === 'function' ? 'fn' : proxy || '');

/** 只缓存**全部就绪**的结果；有缺失/失败不缓存（F-25：失败不永久缓存，下次调用可重试）。 */
function cacheGet(key) {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_SUCCESS_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return hit.result;
}

/**
 * 确保一组工具可用（先 PATH、再已装目录、最后自动下载安装）。**会等安装完成**；
 * 搜索请求路径请用 {@link ensureSearchToolsNonBlocking}（F-12）。
 * @param ids - 工具 id 列表
 * @param options.autoInstall - 允许自动安装（默认 true）
 * @param options.ignorePath - 跳过 PATH 探测（探针用）
 * @param options.force - 忽略缓存/失败闸门，立刻重试（显式安装）
 * @param options.failureGate - 失败后 60s 内不再重试（daemon 的搜索后台安装用，防止每次搜索都打 GitHub）
 * @param options.signal - AbortSignal（取消正在跑的探测/下载）
 * @returns `{tools:{[id]:{path,source,version}}, notes}`
 */
export async function ensureTools(ids, { autoInstall = true, installDir, proxy = null, ignorePath = false, signal = null, force = false, failureGate = false } = {}) {
  const dir = installDir || defaultBinDir();
  const key = `${ids.join(',')}|${dir}|${proxyKey(proxy)}|${autoInstall ? '1' : '0'}|${ignorePath ? '1' : '0'}`;
  if (!force) {
    const hit = cacheGet(key);
    if (hit) {
      recordKnownFromResult(hit);
      // 命中缓存时不再重复"已自动安装 …"这类一次性提示（daemon 每次搜索都会 kick 一次，
      // 否则同样的成功提示会跟着每条搜索结果重复 10 分钟）。失败/缺失结果本来就不缓存。
      return { tools: hit.tools, notes: [] };
    }
  }
  const tools = {};
  const notes = [];
  for (const id of ids) {
    const spec = TOOLS.find((t) => t.id === id);
    if (!spec) {
      tools[id] = { path: null, source: 'unknown' };
      notes.push(`未知工具：${id}`);
      continue;
    }
    const { entry, note } = await ensureToolReady(id, { installDir: dir, autoInstall, ignorePath, proxy, signal, force, failureGate });
    tools[id] = entry;
    if (note) notes.push(note);
  }
  const result = { tools, notes };
  // 只有"全都拿到了"才缓存；有缺失/失败时下次调用会重新探测/重试（F-25：失败不永久缓存）。
  const complete = Object.values(tools).every((t) => !!t.path);
  if (complete) resultCache.set(key, { result, at: Date.now() });
  return result;
}

/** 搜索用：确保 rg/fd（保留旧名，语义不变：会等安装）。 */
export async function ensureSearchTools(opts = {}) {
  // failureGate：daemon 的搜索分支把这里当"后台安装"用（fire-and-forget，每次搜索调用一次）；
  // 失败后 60s 内不再重打 GitHub，避免未认证限流（F-25）。
  const r = await ensureTools(['rg', 'fd'], { failureGate: true, ...opts });
  return {
    rg: { path: r.tools.rg?.path ?? null, source: r.tools.rg?.source },
    fd: { path: r.tools.fd?.path ?? null, source: r.tools.fd?.source },
    notes: r.notes,
  };
}

/**
 * 搜索用（F-12）：**不等待安装**，只返回当前状态。缺 rg/fd 时把安装丢到后台（in-flight 去重），
 * 本次搜索立刻用 GNU grep/find 兜底；失败会在后续调用里以 `failed` + `notes` 出现，绝不静默。
 *
 * daemon 的 `op:'search'` 应当调用这个（而不是 `await ensureSearchTools`），然后
 * `setSearchToolPaths(toolPaths())` 再跑搜索。
 *
 * @param opts.autoInstall - 允许自动安装（默认 true）
 * @param opts.installDir - 安装目录（默认 `~/.local/bin`）
 * @param opts.proxy - 代理字符串，或返回代理的**惰性函数**（只有真要下载时才取值，F-30）
 * @returns `{rg, fd, installing: string[], notes: string[]}`；两个工具对象形如
 *          `{status:'ready'|'installing'|'failed'|'missing', path, source, version?, error?, manual?}`
 */
export async function ensureSearchToolsNonBlocking(opts = {}) {
  const installDir = opts.installDir || defaultBinDir();
  const autoInstall = opts.autoInstall !== false;
  const ignorePath = opts.ignorePath === true;
  const ids = ['rg', 'fd'];
  const status = {};
  for (const id of ids) {
    const located = await locateTool(id, { installDir, ignorePath, signal: opts.signal });
    if (located.path) {
      status[id] = { status: 'ready', path: located.path, source: located.source, version: located.version ?? null };
      continue;
    }
    const manual = MANUAL[id] ?? null;
    if (!autoInstall) {
      status[id] = { status: 'missing', path: null, source: 'missing', manual };
      continue;
    }
    if (isInstalling(id, installDir)) {
      status[id] = { status: 'installing', path: null, source: null };
      continue;
    }
    const recent = failureOf(id);
    if (recent) {
      status[id] = { status: 'failed', path: null, source: 'failed', error: recent.error, manual };
      continue;
    }
    // 后台安装：不 await。本次搜索用自带后端兜底，装好后的下一次搜索用上 rg/fd。
    startInstall(id, { installDir, proxy: opts.proxy, signal: opts.signal });
    status[id] = { status: 'installing', path: null, source: null };
  }
  const installing = ids.filter((id) => status[id].status === 'installing');
  const notes = [];
  for (const id of ids) {
    const st = status[id];
    if (st.status === 'failed') {
      notes.push(`${id} 自动安装失败（${st.error}）；本次搜索已回退到发行版自带后端；手动安装：${st.manual ?? '见项目文档'}`);
    }
  }
  return { ...status, installing, notes };
}

/**
 * 同步状态快照（不再探测）：给测试/诊断用，daemon 不需要。
 * @param installDir - 安装目录（默认 `~/.local/bin`），用于判断"该目录里是否有安装在进行"
 * @returns 与 {@link ensureSearchToolsNonBlocking} 同形
 */
export function searchToolsStatus(installDir) {
  const ids = ['rg', 'fd'];
  const status = {};
  for (const id of ids) {
    const cached = known.get(id);
    if (cached?.path && execOk(cached.path)) {
      status[id] = { status: 'ready', path: cached.path, source: cached.source, version: cached.version ?? null };
    } else if (isInstalling(id, installDir)) {
      status[id] = { status: 'installing', path: null, source: null };
    } else {
      const f = failures.get(id);
      status[id] = f
        ? { status: 'failed', path: null, source: 'failed', error: f.error, manual: MANUAL[id] ?? null }
        : { status: 'missing', path: null, source: 'missing', manual: MANUAL[id] ?? null };
    }
  }
  const installing = ids.filter((id) => status[id].status === 'installing');
  return { ...status, installing, notes: [] };
}

/**
 * rg/fd 的绝对路径（daemon 注入给 search-rpc）。
 * F-22：按 **工具 id 合并**所有探测/安装结果；旧实现取 `[...cache.values()].at(-1)`，
 * "先装 rg、再装别的工具"之后 rg 路径就丢了。死路径（二进制被删）在这里剔除。
 */
export function toolPaths() {
  const out = { rg: null, fd: null };
  for (const id of ['rg', 'fd']) {
    const entry = known.get(id);
    if (!entry?.path) continue;
    if (!execOk(entry.path)) {
      known.delete(id);
      continue;
    }
    out[id] = entry.path;
  }
  return out;
}

/** 允许工具清单读取（`wsl_tools` 用）。 */
export function catalog() {
  return TOOLS.map((t) => ({ id: t.id, repo: t.repo, label: t.label, manual: MANUAL[t.id] ?? null }));
}

/** 清空模块内缓存（测试/诊断用；生产代码不需要）。 */
export function resetToolCache() {
  known.clear();
  failures.clear();
  installInFlight.clear();
  resultCache.clear();
  pathProbeCache.clear();
  archCache = null;
}
