/**
 * dsh-remote-wsl / world-route —— **世界路由**：cwd 在 WSL 里的空白会话，自动落进 WSL 执行世界。
 *
 * ## 为什么必须有这一层（2026-11-24 根因）
 * 插件原来有两条并行通路：
 *  1. **WSL 执行世界**（`wsl` / `wsl-<mode>` preset）：`ctx.fs` 换成 WSL 原生 fs provider，
 *     `grep`/`glob` 换成守护侧的 `{op:'search'}`（**一次 RPC 扫完整棵树**）。
 *  2. **宿主平面 + UNC 桥**（standard preset 的会话）：文件读写被 `fs-unc-bridge` 逐条桥到守护，
 *     但 grep/glob 仍是宿主自带的 Windows ripgrep，走 `\\wsl.localhost\…` 的 9P 共享。
 *
 * 实测（本机）：在 UNC 路径上跑宿主自带的 grep/glob，守护 RPC 增量 = **0** —— 也就是说插件最强的
 * 那条通路（整树一次 op）对这类会话**根本没接线**；而 `op=fs` 的逐 op 往返又只有宿主平面在用。
 * 于是"把扫树下推到守护"这件事，前提是**会话得先进那个世界**。
 *
 * 本模块只做一件很窄的事：`agent/created` 时若成立下列**全部**条件，就用 `agentPresets.select()`
 * 把该会话切到 WSL 世界：
 *  · `source === 'startup'`（新建会话；resume/clear/compact 不动，避免改写在跑的会话）；
 *  · 会话 header 里**没有**已提交的 preset（用户显式选过 ⇒ 一律尊重，绝不覆盖）；
 *  · cwd 是本发行版的 WSL UNC 路径；
 *  · 宿主确实注册了可用的 WSL 预设。
 *
 * 失败只打一行 stderr、不抛（路由是优化，不是会话成立的前提）。
 *
 * @module dsh-remote-wsl/world-route
 */
import { normalizeConfig } from './config.ts';
import { parseUnc } from './fs-provider.ts';

export const name = 'dsh-remote-wsl-world-route';
export const inject = [];

/** 已经是 WSL 世界的 preset id 判定（`wsl` 与 `wsl-<mode>` 变体）。 */
export function isWslWorldPreset(id) {
  const v = String(id ?? '');
  return v === 'wsl' || v.startsWith('wsl-');
}

/**
 * 纯决策：该不该路由、路由到哪个 preset。
 *
 * @param facts.source - `agent/created` 的 source（`startup` 才路由）
 * @param facts.cwd - 会话 cwd（可能是 UNC / Windows 盘符 / POSIX）
 * @param facts.sessionPreset - 会话 header 里已提交的 preset（null/undefined = 还没选）
 * @param facts.registered - 宿主当前注册的 preset id 列表
 * @param facts.defaultPreset - 宿主默认 preset id（用来优先选同模式的 WSL 变体）
 * @param facts.distro - 本插件配置的发行版
 * @returns `{route, preset?, reason}`（reason 永远给得出，日志/测试都靠它）
 */
export function decideWorldRoute(facts) {
  const source = String(facts?.source ?? '');
  const cwd = String(facts?.cwd ?? '');
  const distro = String(facts?.distro ?? '');
  const sessionPreset = facts?.sessionPreset == null ? null : String(facts.sessionPreset);
  const registered = Array.isArray(facts?.registered) ? facts.registered.map(String) : [];
  const defaultPreset = facts?.defaultPreset == null ? null : String(facts.defaultPreset);

  if (source !== 'startup') return { route: false, reason: `source=${source || '未知'}（只处理 startup）` };
  if (!cwd) return { route: false, reason: '会话没有 cwd' };
  if (sessionPreset !== null && isWslWorldPreset(sessionPreset)) {
    return { route: false, reason: `已经是 WSL 世界（${sessionPreset}）` };
  }
  if (sessionPreset !== null) return { route: false, reason: `会话已显式选择 preset=${sessionPreset}（尊重用户选择）` };
  const unc = parseUnc(cwd);
  if (unc === null) return { route: false, reason: 'cwd 不是 WSL UNC 路径' };
  if (distro && unc.distro.toLowerCase() !== distro.toLowerCase()) {
    return { route: false, reason: `cwd 属于发行版 ${unc.distro}，本插件只服务 ${distro}` };
  }
  const has = (id) => registered.includes(id);
  const variant = defaultPreset ? `wsl-${defaultPreset}` : null;
  if (variant !== null && has(variant)) return { route: true, preset: variant, reason: `默认模式 ${defaultPreset} 的 WSL 变体` };
  if (has('wsl')) return { route: true, preset: 'wsl', reason: 'wsl 预设' };
  return { route: false, reason: '宿主没有注册可用的 WSL 预设（variants 生成失败？）' };
}

/**
 * 挂上世界路由。
 * @param ctx - cordis 上下文（需 `inject` / `on` / `get`）
 * @param rawConfig - 插件 config（`worldRoute: false` 可关）
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  if (config.worldRoute === false) return;
  if (typeof ctx?.inject !== 'function') return;

  ctx.inject(['agentPresets', 'sessions'], (child) => {
    const get = (key) => (typeof child?.get === 'function' ? child.get(key) : undefined);
    child.on('agent/created', async (payload) => {
      try {
        const agent = payload?.agent;
        const presets = get('agentPresets');
        const sessions = get('sessions');
        if (!agent || !presets || !sessions || typeof presets.select !== 'function') return;
        const session = sessions.get(agent.id);
        const header = session?.header;
        if (!header) return;
        // 先在便宜的条件上短路：不是 startup / cwd 不在本发行版 ⇒ 连 roster 都不查。
        if (String(payload?.source ?? '') !== 'startup') return;
        const unc = parseUnc(String(header.cwd ?? ''));
        if (unc === null || unc.distro.toLowerCase() !== String(config.distro).toLowerCase()) return;
        if (header.agentPreset) return; // 用户选过：直接放过（决策函数里也有同样的闸，双保险）

        let registered = [];
        try {
          const rows = await presets.list();
          registered = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string' && !r.broken).map((r) => r.id);
        } catch {
          return;
        }
        let defaultPreset = null;
        try {
          defaultPreset = (await presets.resolve())?.id ?? null;
        } catch {
          defaultPreset = null;
        }
        const decision = decideWorldRoute({
          source: payload?.source,
          cwd: header.cwd,
          sessionPreset: header.agentPreset ?? null,
          registered,
          defaultPreset,
          distro: config.distro,
        });
        if (!decision.route) return;
        await presets.select(agent, decision.preset);
        process.stderr.write(
          `remote-wsl: 世界路由 ⇒ 会话 ${String(agent.id)}（cwd=${String(header.cwd)}）落到 ${decision.preset}` +
            `（${decision.reason}）；grep/glob 因此走守护 {op:'search'}（一次扫一棵树）\n`,
        );
      } catch (e) {
        process.stderr.write(`remote-wsl: 世界路由失败（不影响会话）：${e?.message ?? String(e)}\n`);
      }
    });
  });
}
