/**
 * dsh-remote-wsl / search-tool —— **WSL 内搜索**的模型面工具：`grep` 与 `glob`。
 *
 * 为什么不挂 `@deepseek-ai/dsh-tool-fs-search`：它 spawn 的是打包的 **Windows** ripgrep，
 * 模型给的是 Linux 路径（`/home/g/...`），在它眼里不成立。这里把自己的两个工具注册进
 * WSL 执行世界（preset 的 isolate realm 或 headless 的宿主平面），执行体走 daemon 的
 * `{op:'search'}` —— grep/find 都在发行版里跑。
 *
 * 注册形态照抄本插件已有的七个工具（`tools.register({name, description, parameters,
 * output:{schema, render: renderText}, execute})`）——不 import `@deepseek-ai/dsh-tools`
 * （link: 安装拿不到裸包，见 README「零运行时依赖」）。
 *
 * 2026-10-27 搜索层修复（工具面）：
 *   · F-12：daemon 现在会在后台装 rg/fd，`provision` 可能返回 `installing` / `failed`。
 *     这里把状态翻成模型能读的提示（"本次用慢后端兜底、稍后重试更快"），失败带手动安装命令，
 *     不再让"工具正在装/装失败"变成用户看不见的噪声。
 *   · F-13：描述不再承诺三个后端都支持的 PCRE 语法；后端 stderr 以 `[grep warnings]` 形式回给模型，
 *     避免 GNU grep 后端静默返回 "no matches" 的假阴性。
 *   · F-23：描述写明 .git/node_modules 跳过、但 .gitignore **不**生效（rg/fd 加 --no-ignore，
 *     与 GNU grep/find 对齐），别让模型以为忽略规则是稳定的。
 *
 * @module dsh-remote-wsl/search-tool
 */
import { parseUnc, createWslRpc } from './fs-provider.ts';
import { renderText } from './wsl-io.ts';

import { normalizeConfig } from './config.ts';
export const name = 'dsh-remote-wsl-search';
export const inject = [];



/** 把模型给的路径解析成发行版内绝对路径：优先走 realm 的 ctx.fs，其次自己按 UNC/cwd 推导。 */
async function resolveLinuxPath(ctx, config, rawPath, exec) {
  const cwd = exec?.agent?.session?.header?.cwd ?? config.cwd;
  const fsSvc = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined;
  if (fsSvc && typeof fsSvc.resolve === 'function') {
    const target = await fsSvc.resolve(rawPath ?? cwd, { cwd });
    return String(target.targetKey);
  }
  const raw = String(rawPath ?? cwd ?? '/').trim();
  const unc = parseUnc(raw);
  if (unc !== null) {
    if (unc.distro !== config.distro) throw new Error(`remote-wsl search: 路径属于发行版 "${unc.distro}"，只服务 "${config.distro}"`);
    return unc.linuxPath;
  }
  if (raw.startsWith('/')) return raw;
  const baseUnc = parseUnc(String(cwd ?? ''));
  if (baseUnc !== null) return `${baseUnc.linuxPath.replace(/\/$/, '')}/${raw}`;
  throw new Error(`remote-wsl search: 无法解析相对路径 "${raw}"（cwd=${String(cwd)} 不是 WSL 路径）`);
}

/**
 * daemon 返回的 provision 状态 → 给模型的提示（F-12）。
 * 兼容两种形状：
 *   · 新：`{rg:{status,path,source,error?,manual?}, fd:{...}, installing:[...], notes:[...]}`
 *   · 旧：`{rg:'path'|'missing', fd:'...', notes:['已自动安装 …']}`
 */
export function provisionHint(provision) {
  if (!provision || typeof provision !== 'object') return '';
  const lines = [];
  const installing = Array.isArray(provision.installing) ? provision.installing.filter((id) => typeof id === 'string') : [];
  const isNewShape = Array.isArray(provision.installing) || ['rg', 'fd'].some((id) => provision[id] && typeof provision[id] === 'object');
  if (isNewShape) {
    for (const id of ['rg', 'fd']) {
      const st = provision[id];
      if (!st || typeof st !== 'object') continue;
      if (st.status === 'failed') {
        lines.push(
          `[search tools] ${id} auto-install failed: ${String(st.error ?? 'unknown error')}${st.manual ? ` — manual install: ${st.manual}` : ''}`,
        );
      } else if (st.status === 'missing' && st.manual) {
        lines.push(`[search tools] ${id} is not installed and auto-install is disabled — manual install: ${st.manual}`);
      }
    }
    if (installing.length > 0) {
      lines.push(
        `[search tools] installing ${installing.join(', ')} in the background; this search used the slower fallback backend. Re-run in ~30s for faster, tool-consistent results.`,
      );
    }
    return lines.length ? `\n${lines.join('\n')}` : '';
  }
  // 兼容 daemon 的 `kickSearchProvision` 形状（daemon.ts 2026-10-27）：
  //   安装中：{installing:true, rg:'installing', fd:'installing', notes:[]}
  //   完成后：{installing:true, rg:'path'|'installed'|'installed-dir'|'missing'|'failed', fd:…, notes:[…]}
  // 注意 `installing` 布尔只表示"这次调用顺手 kick 了一次"，不能据此报"正在安装"（就绪时也会是 true）。
  const pending = ['rg', 'fd'].filter((id) => provision[id] === 'installing');
  if (pending.length > 0) {
    lines.push(
      `[search tools] installing ${pending.join(', ')} in the background; this search used the slower fallback backend. Re-run in ~30s for faster, tool-consistent results.`,
    );
  }
  const notes = Array.isArray(provision.notes) ? provision.notes.filter((n) => typeof n === 'string' && n) : [];
  if (notes.length > 0) lines.push(`[search tools] ${notes.join(' | ')}`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/** 后端 stderr / 模式归一化警告（F-13）：显式告诉模型"结果可能不完整"，别让它从空结果里猜。 */
export function warningHint(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((w) => typeof w === 'string' && w.trim()) : [];
  if (warnings.length === 0) return '';
  return `\n[search warnings] backend/pattern warnings — results may be incomplete (simplify the pattern or use fixed_string if unsure):\n${warnings
    .map((w) => `- ${w}`)
    .join('\n')}`;
}

/** 模式被归一化（`\d`→`[0-9]`、前置 `(?i)`→ `-i`）时说明一下，便于模型理解行为差异（F-13）。 */
function normalizedHint(result) {
  const normalized = result?.normalized;
  if (typeof normalized !== 'string' || !normalized) return '';
  return `\n[grep] pattern translated for backend portability: ${normalized}`;
}

const hintsOf = (result) => `${provisionHint(result?.provision)}${normalizedHint(result)}${warningHint(result)}`;

const grepDescription = [
  'Search file contents inside the WSL distribution (recursive, line-numbered, skips binary files, .git and node_modules).',
  'Use this instead of a Windows-side search: paths are Linux paths and the search runs inside the distribution.',
  '`pattern` is a regular expression: POSIX ERE, plus the portable shorthands \\d \\w \\s and a leading (?i), which are translated so every backend (ripgrep / ugrep / GNU grep) behaves the same.',
  'Other PCRE-only constructs (lookaround, (?:...), backreferences) are not portable: they are passed through, and backend warnings are reported in the result — do not assume an empty result means the pattern was valid.',
  'Set fixed_string to search literal text (no translation). Ignore files are NOT honored: .git and node_modules are always skipped, and the result set is the same on every backend.',
  'Results are capped; narrow `path` or the pattern when truncated.',
].join(' ');

const globDescription = [
  'List files inside the WSL distribution matching a glob pattern (fd/find + glob match inside the distribution).',
  '`*` does not cross path separators, `**` crosses directory levels (when it is a whole path segment), `?` matches one character, `[abc]` is a character class and `[!abc]`/`[^abc]` negates it.',
  'A pattern without "/" matches base names. .git and node_modules are skipped; ignore files (.gitignore etc.) are NOT honored, so fd and find return the same set. Results are capped.',
].join(' ');

/**
 * 注册 grep/glob 两个工具。
 * @param ctx - cordis 上下文（注入 `tools`）
 * @param rawConfig - `distro` / `daemonPort` / `wslHome` / `cwd`
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const rpc = createWslRpc(config);
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = typeof toolsCtx.get === 'function' ? toolsCtx.get('tools') : undefined;
    if (!tools || typeof tools.register !== 'function') {
      process.stderr.write('remote-wsl: tools 服务不可用，WSL 搜索工具未注册\n');
      return;
    }

    tools.register({
      name: 'grep',
      description: grepDescription,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression (POSIX ERE; \\d \\w \\s and a leading (?i) are translated for portability). Required.' },
          path: { type: 'string', description: 'Directory or file to search (WSL path, UNC, or relative to the session cwd). Defaults to the session cwd.' },
          fixed_string: { type: 'boolean', description: 'Treat the pattern as literal text instead of a regular expression (no shorthand translation).' },
          ignore_case: { type: 'boolean', description: 'Case-insensitive match (equivalent to a leading (?i)).' },
          max_matches: { type: 'integer', description: 'Cap on returned matches (default 500).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const path = await resolveLinuxPath(ctx, config, args.path, exec);
        const r = await rpc.call('search', 'grep', {
          pattern: String(args.pattern ?? ''),
          path,
          fixedString: args.fixed_string === true,
          ignoreCase: args.ignore_case === true,
          maxMatches: args.max_matches,
          autoInstall: config.searchAutoInstall !== false,
        }, exec?.signal);
        const matches = Array.isArray(r?.matches) ? r.matches : [];
        const hints = hintsOf(r);
        if (matches.length === 0) return `no matches for ${JSON.stringify(String(args.pattern ?? ''))} in ${path}${hints}`;
        const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        const via = r?.backend ? ` via ${r.backend}` : '';
        const head = `${matches.length} match(es) in ${path}${via}${r?.truncated ? ' (truncated)' : ''}`;
        return `${head}\n${lines.join('\n')}${hints}`;
      },
    });

    tools.register({
      name: 'glob',
      description: globDescription,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts or src/*.js. Required.' },
          path: { type: 'string', description: 'Root directory (WSL path, UNC, or relative to the session cwd). Defaults to the session cwd.' },
          max_results: { type: 'integer', description: 'Cap on returned paths (default 1000).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const path = await resolveLinuxPath(ctx, config, args.path, exec);
        const r = await rpc.call('search', 'glob', {
          pattern: String(args.pattern ?? ''),
          path,
          maxResults: args.max_results,
          autoInstall: config.searchAutoInstall !== false,
        }, exec?.signal);
        const files = Array.isArray(r?.files) ? r.files : [];
        const hint = `${provisionHint(r?.provision)}${warningHint(r)}`;
        if (files.length === 0) return `no files match ${JSON.stringify(String(args.pattern ?? ''))} under ${path}${hint}`;
        const via = r?.backend ? ` via ${r.backend}` : '';
        return `${files.length} file(s) under ${path}${via}${r?.truncated ? ' (truncated)' : ''}\n${files.join('\n')}${hint}`;
      },
    });
    tools.register({
      name: 'wsl_tools',
      description: [
        'List or install the Rust command-line tools available inside the WSL distribution (ripgrep, fd, ast-grep/sg, sd, bat, tokei, difftastic/difft, dust, procs, xh, hexyl, qsv, typos, taplo, just, delta, rga, hyperfine).',
        'action="list" reports which ones are already available (PATH or auto-installed under ~/.local/bin) with their paths.',
        'action="install" downloads the requested tool from GitHub Releases into ~/.local/bin without sudo; failures return the reason plus the manual install command.',
        'These binaries are then usable from wsl_exec/bash as well as the dedicated grep/glob tools.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"list" (default) or "install".' },
          tool: { type: 'string', description: 'Tool id to install when action="install" (e.g. ast-grep, sd, bat).' },
        },
      },
      output: { schema: { type: 'string' }, render: renderText },
      execute: async (args, exec) => {
        const action = String(args.action ?? 'list');
        if (action === 'install') {
          const id = String(args.tool ?? '').trim();
          if (!id) throw new Error('wsl_tools: action="install" requires tool="<id>"');
          const r = await rpc.call('provision', '', { tools: [id], autoInstall: config.searchAutoInstall !== false }, exec?.signal);
          const entry = r?.tools?.[id];
          const notes = Array.isArray(r?.notes) ? r.notes : [];
          const head = entry?.path ? `installed ${id} → ${entry.path} (${entry.source})` : `could not install ${id}`;
          return `${head}\n${notes.join('\n')}`.trim();
        }
        const r = await rpc.call('provision', '', { list: true, autoInstall: false }, exec?.signal);
        const rows = [];
        for (const item of r?.catalog ?? []) {
          const t = r?.tools?.[item.id];
          const state = t?.path ? `✅ ${t.source} ${t.path}` : '❌ missing';
          rows.push(`${item.id.padEnd(12)} ${state}`);
        }
        const notes = Array.isArray(r?.notes) ? r.notes : [];
        return `Rust CLI tools in WSL:\n${rows.join('\n')}${notes.length ? `\n\n${notes.join('\n')}` : ''}`;
      },
    });
  });
}
