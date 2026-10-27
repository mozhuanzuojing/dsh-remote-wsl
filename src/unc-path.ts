/**
 * dsh-remote-wsl / unc-path —— WSL UNC 路径的**反解**。
 *
 * 参考：zai-org/ZCode 的 packages/ui/src/lib/wslUncWorkspace.ts（2026-10-22 对照）。
 *
 * 为什么需要：插件一直只**正向**拼 UNC（daemon-protocol.unc()）给 Windows 侧读写用，没有反向解析。
 * 一旦路径以 UNC 形式进来（用户从资源管理器/工作区列表粘贴、或 DSH 侧把工作区路径回传），
 * 我们要么当它非法，要么拼出双层 UNC 前缀。
 *
 * 两种服务名前缀都接受：wsl.localhost（现代）与 wsl$（旧版/兼容）。
 * 反斜杠/正斜杠都接受；distro 名可以含空格。
 */

const WSL_UNC_SERVERS = ['wsl.localhost', 'wsl$'];
const BACKSLASH = '\\';

/** 解析 WSL UNC 路径；不是 WSL UNC 时返回 null。 */
export function parseWslUncPath(value) {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) return null;
  const normalized = raw.split(BACKSLASH).join('/');
  if (!normalized.startsWith('//')) return null;
  const parts = normalized.slice(2).split('/');
  const server = (parts.shift() ?? '').toLowerCase();
  if (WSL_UNC_SERVERS.indexOf(server) < 0) return null;
  const distro = (parts.shift() ?? '').trim();
  if (distro.length === 0) return null;
  const linuxPath = '/' + parts.join('/');
  return { distro, linuxPath, originalPath: value };
}

/** 是否是 WSL UNC 路径。 */
export function isWslUncPath(value) {
  return parseWslUncPath(value) !== null;
}

/**
 * 正向拼 UNC（wsl.localhost 形式）。与 daemon-protocol.unc() 的产物一致。
 *
 * 为什么含 `\` 的路径必须拒绝（2026-10-27 审查 F-23）：Linux 文件名允许反斜杠，Windows 把它当**路径
 * 分隔符**；拼进 UNC 后 `/home/g/a\..\..\etc/passwd` 会在 Windows 侧解析成完全不同的文件。
 * UNC 语法没有表达文件名内 `\` 的转义手段，所以只能报错 —— 宁可不给路径，也不给一条错路径。
 */
export function wslUncPath(distro, linuxPath) {
  const raw = String(linuxPath ?? '');
  if (raw.includes(BACKSLASH)) {
    throw new Error(
      `cannot build a UNC path for "${raw}": a backslash inside a Linux file name would be parsed as a path separator on Windows`,
    );
  }
  const tail = raw.split('/').filter(Boolean).join(BACKSLASH);
  return '\\\\wsl.localhost\\' + distro + '\\' + tail;
}
