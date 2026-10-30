/**
 * dsh-remote-wsl / subprocess-host —— 跨 isolate realm 取宿主 `subprocess` 的只读注册表。
 *
 * 为什么需要：官方右侧栏 Terminal 由 `dsh-api-terminal-controller` 驱动，它调用
 * `agent.ctx.get("subprocess").spawnTerminal(...)`。WSL 世界把 `subprocess` 隔离并替换成
 * 本插件的 provider 后，provider 仍要**委托**宿主的真实 subprocess（PTY/进程实现）——
 * 但 isolate realm 里拿不到父平面的服务实例。根插件在 apply 时登记一个 getter，
 * provider（同进程、同模块图）在 apply 时读取它。
 *
 * @module dsh-remote-wsl/subprocess-host
 */

/** @type {(() => unknown) | null} */
let resolver = null;

/**
 * 登记宿主 `subprocess` 的惰性读取器。
 * @param {(() => unknown) | null} fn - 返回宿主 subprocess 服务（不可用时返回 undefined）。
 */
export function setHostSubprocessResolver(fn) {
  resolver = typeof fn === 'function' ? fn : null;
}

/**
 * 读取宿主 `subprocess`；未登记或读取抛错都返回 undefined（由调用方明确报错）。
 * @returns {unknown}
 */
export function getHostSubprocess() {
  if (resolver === null) return undefined;
  try {
    return resolver();
  } catch {
    return undefined;
  }
}
