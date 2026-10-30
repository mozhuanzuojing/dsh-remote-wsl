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

function variantName(id) {
  const label = MODE_LABELS[id];
  return label ? `WSL · ${label.en}（${label.zh}）` : `WSL · ${id}`;
}

function variantDescription(id) {
  const label = MODE_LABELS[id];
  const display = label ? `${label.en}（${label.zh}）` : id;
  return `WSL execution world for ${display}: bash and file tools run inside the WSL distribution.`;
}

/** `!!js` 表达式目前只被解析成占位对象；变体无法求值，宁可明确失败也不注册一个坏 preset。 */
function containsJsExpr(value) {
  if (Array.isArray(value)) return value.some(containsJsExpr);
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, '__jsExpr')) return true;
  return Object.values(value).some(containsJsExpr);
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
 * Publish all available WSL mode variants.
 * @param presets - the host's `agentPresets` service
 * @param log - optional line logger
 * @returns `{registered, skipped, failures, dispose}`（dispose 释放本次注册的变体）
 */
export async function registerWslVariants(presets, log = () => {}) {
  const registered = [];
  const skipped = [];
  const failures = [];
  const disposers = [];
  if (!presets || typeof presets.list !== 'function' || typeof presets.register !== 'function') {
    return { registered, skipped, failures: ['agentPresets.register/list unavailable'], dispose: async () => {} };
  }
  let rows;
  try {
    rows = await presets.list();
  } catch (e) {
    return { registered, skipped, failures: [`agentPresets.list failed: ${e?.message ?? e}`], dispose: async () => {} };
  }
  const existing = new Set((Array.isArray(rows) ? rows : []).map((row) => row && row.id).filter(Boolean));
  const roster = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && typeof row.id === 'string' && row.id !== 'wsl' && !row.id.startsWith('wsl-') && !row.broken,
  );
  for (const source of roster) {
    const id = source.id;
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
      const plugins = await parseVariantComposition(transformed);
      if (containsJsExpr(plugins)) throw new Error('源 preset 含 !!js 表达式，变体暂不支持求值');
      const dispose = await presets.register({
        id: variantId,
        name: variantName(id),
        description: variantDescription(id),
        plugins,
      });
      if (typeof dispose === 'function') disposers.push(dispose);
      registered.push(variantId);
    } catch (e) {
      failures.push(`${variantId}: ${e?.message ?? e}`);
      log(`WSL variant ${variantId} 生成失败：${e?.message ?? e}`);
    }
  }
  return {
    registered,
    skipped,
    failures,
    /** 释放本次注册的变体（插件重载/卸载时调用，避免陈旧变体残留）。 */
    dispose: async () => {
      for (const dispose of disposers.splice(0)) {
        try {
          await dispose();
        } catch {
          /* 单个取消失败不阻塞其余清理 */
        }
      }
    },
  };
}
