/**
 * dsh-remote-wsl / variant-register —— 为每个健康的基础 preset 生成 `wsl-<mode>` 变体。
 *
 * 参考 dsh-wsl-workspace 的 variants 机制（MIT，v0.4.3 bdf94ba）：
 * 基础 preset 的 composition 文本经 `transformPresetForWsl()` 把 shell/fs/world 行替换成
 * 本插件的 WSL world，再用 js-yaml 解析回 `agentPresets.register()` 需要的 plugins 数组。
 *
 * 只注册本机 roster 实际发布的基础模式；没有 `readDocument`/`read` 或没有 `register` 的
 * 老宿主会明确返回空结果，不伪造变体。
 */
import { transformPresetForWsl } from './variants.ts';

const MODE_LABELS = Object.freeze({
  standard: { en: 'Standard mode', zh: '标准模式' },
  code: { en: 'Code mode', zh: 'PTC 模式' },
  ptc: { en: 'PTC mode', zh: 'PTC 模式' },
  minimal: { en: 'Minimal mode', zh: '极简模式' },
  cordis: { en: 'Creator mode', zh: '创造模式' },
});

const BASE_IDS = ['standard', 'ptc', 'code', 'minimal', 'cordis'];

function variantName(id) {
  const label = MODE_LABELS[id];
  return label ? `WSL · ${label.en}（${label.zh}）` : `WSL · ${id}`;
}

function variantDescription(id) {
  const label = MODE_LABELS[id];
  const display = label ? `${label.en}（${label.zh}）` : id;
  return `WSL execution world for ${display}: bash and file tools run inside the WSL distribution.`;
}

async function readComposition(presets, row) {
  if (typeof presets.readDocument === 'function') {
    const doc = await presets.readDocument(row.id);
    return { content: doc.content, name: doc.name };
  }
  if (typeof presets.read === 'function') return { content: await presets.read(row.id) };
  throw new Error('agentPresets: neither readDocument() nor read() is available');
}

/**
 * Parse the entry-list YAML dialect (including `!!js` tags) back to plugin rows.
 * js-yaml is deliberately imported lazily so a missing optional dependency fails
 * variants only, never the whole plugin.
 */
async function parseVariantComposition(content) {
  const ns = await import('js-yaml');
  const load = ns.load ?? ns.default?.load;
  const Type = ns.Type ?? ns.default?.Type;
  const JsonSchema = ns.JSON_SCHEMA ?? ns.default?.JSON_SCHEMA;
  if (typeof load !== 'function') throw new Error('js-yaml: no load() export');
  if (typeof Type !== 'function' || !JsonSchema || typeof JsonSchema.extend !== 'function') {
    throw new Error('js-yaml: entry-list schema API is unavailable');
  }
  const jsExpr = new Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  });
  const schema = JsonSchema.extend(jsExpr);
  const rows = load(content, { schema });
  if (!Array.isArray(rows)) throw new Error('transformed preset did not parse as an entry list');
  return rows;
}

/**
 * The official right-Sidebar terminal's WSL backend, as YAML rows appended to a
 * generated variant. The host owns the terminal registry and the xterm UI
 * (`@deepseek-ai/dsh-client-ui-sidebar-terminal`); this row only says *which
 * shell* that UI's PTY starts, so a WSL variant's Terminal tab is an interactive
 * `bash` inside the distribution rather than a Windows shell.
 * @param distro - explicit distribution; empty means the default distribution,
 *   in which case no `-d` arg is emitted (an empty `-d` is a wsl.exe error).
 * @param cwd - optional Linux working directory for the terminal's first shell.
 * @returns the entry-list rows for one `wsl-terminal` group.
 */
function terminalRows(distro, cwd) {
  const args = [
    ...(distro ? ['-d', distro] : []),
    ...(cwd ? ['--cd', cwd] : []),
    '--exec',
    'bash',
    '-l',
  ];
  return [
    '- id: wsl-terminal',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    terminals: true',
    '  config:',
    '    - id: pty',
    "      name: '@deepseek-ai/dsh-terminal'",
    '    - id: terminal-wsl',
    "      name: '@deepseek-ai/dsh-terminal-bash'",
    '      config:',
    '        backendType: wsl',
    '        shellDialect: bash',
    '        shellPath: wsl.exe',
    '        shellArgs:',
    ...args.map((arg) => `          - '${String(arg).replace(/'/g, "''")}'`),
    '        idleSilenceMs: 1200',
  ].join('\n');
}

/**
 * Publish all available WSL mode variants.
 * @param presets - the host's `agentPresets` service
 * @param log - optional line logger
 * @param options.distro - distribution passed to each variant's Terminal backend
 * @returns `{registered, skipped, failures}`
 */
export async function registerWslVariants(presets, log = () => {}, options = {}) {
  const registered = [];
  const skipped = [];
  const failures = [];
  if (!presets || typeof presets.list !== 'function' || typeof presets.register !== 'function') {
    return { registered, skipped, failures: ['agentPresets.register/list unavailable'] };
  }
  let rows;
  try {
    rows = await presets.list();
  } catch (e) {
    return { registered, skipped, failures: [`agentPresets.list failed: ${e?.message ?? e}`] };
  }
  const existing = new Set((Array.isArray(rows) ? rows : []).map((row) => row && row.id).filter(Boolean));
  const byId = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.id, row]));
  for (const id of BASE_IDS) {
    const source = byId.get(id);
    if (!source || source.broken) {
      skipped.push(id);
      continue;
    }
    const variantId = `wsl-${id}`;
    if (existing.has(variantId)) {
      skipped.push(variantId);
      continue;
    }
    try {
      const composition = await readComposition(presets, source);
      const transformed = transformPresetForWsl(
        composition.content,
        'dsh-remote-wsl/shell-provider',
        'dsh-remote-wsl/fs-provider',
        undefined,
        'dsh-remote-wsl/search-tool',
        undefined,
        undefined,
        { dropSubagentDelegation: true },
      );
      // 右侧栏终端后端：每个 WSL 变体都挂 wsl-terminal（宿主自带 terminal UI/注册表）。
      // 源预设若已带同名组则不重复（避免 loader 的 duplicate entry id）。
      const withTerminal = transformed.includes('id: wsl-terminal')
        ? transformed
        : `${transformed}\n${terminalRows(options.distro ?? '', options.cwd ?? '')}\n`;
      const plugins = await parseVariantComposition(withTerminal);
      await presets.register({
        id: variantId,
        name: variantName(id),
        description: variantDescription(id),
        plugins,
      });
      registered.push(variantId);
    } catch (e) {
      failures.push(`${variantId}: ${e?.message ?? e}`);
      log(`WSL variant ${variantId} 生成失败：${e?.message ?? e}`);
    }
  }
  return { registered, skipped, failures };
}
