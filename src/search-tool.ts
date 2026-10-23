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
 * @module dsh-remote-wsl/search-tool
 */
import { parseUnc, createWslRpc } from './fs-provider.ts';
import { renderText } from './wsl-io.ts';

export const name = 'dsh-remote-wsl-search';
export const inject = [];

const DEFAULTS = { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', daemonPort: 8731, searchAutoInstall: true };

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

const grepDescription = [
  'Search file contents inside the WSL distribution with GNU grep (recursive, line-numbered, skips binary files and .git/node_modules).',
  'Use this instead of a Windows-side search: paths are Linux paths and the search runs inside the distribution.',
  '`pattern` is an extended regular expression by default (POSIX ERE: \\d, \\w, \\b, (?i) work; lookaround and backreferences do not).',
  'Set fixed_string to search literal text. Results are capped; narrow `path` or the pattern when truncated.',
].join(' ');

const globDescription = [
  'List files inside the WSL distribution matching a glob pattern (find + glob match inside the distribution).',
  '`*` does not cross path separators, `**` does, `?` matches one character, `[abc]` is a character class.',
  'A pattern without "/" matches base names. .git and node_modules are skipped. Results are capped.',
].join(' ');

/**
 * 注册 grep/glob 两个工具。
 * @param ctx - cordis 上下文（注入 `tools`）
 * @param rawConfig - `distro` / `daemonPort` / `wslHome` / `cwd`
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
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
          pattern: { type: 'string', description: 'POSIX ERE (or literal text when fixed_string is true). Required.' },
          path: { type: 'string', description: 'Directory or file to search (WSL path, UNC, or relative to the session cwd). Defaults to the session cwd.' },
          fixed_string: { type: 'boolean', description: 'Treat the pattern as literal text instead of a regular expression.' },
          ignore_case: { type: 'boolean', description: 'Case-insensitive match.' },
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
        const noteLines = Array.isArray(r?.provision?.notes) && r.provision.notes.length ? `\n[search tools] ${r.provision.notes.join(' | ')}` : '';
        if (matches.length === 0) return `no matches for ${JSON.stringify(String(args.pattern ?? ''))} in ${path}${noteLines}`;
        const lines = matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        const via = r?.backend ? ` via ${r.backend}` : '';
        const head = `${matches.length} match(es) in ${path}${via}${r?.truncated ? ' (truncated)' : ''}`;
        return `${head}\n${lines.join('\n')}${noteLines}`;
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
        const noteLines = Array.isArray(r?.provision?.notes) && r.provision.notes.length ? `\n[search tools] ${r.provision.notes.join(' | ')}` : '';
        if (files.length === 0) return `no files match ${JSON.stringify(String(args.pattern ?? ''))} under ${path}${noteLines}`;
        const via = r?.backend ? ` via ${r.backend}` : '';
        return `${files.length} file(s) under ${path}${via}${r?.truncated ? ' (truncated)' : ''}\n${files.join('\n')}${noteLines}`;
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
