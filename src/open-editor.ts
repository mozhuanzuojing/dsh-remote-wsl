/**
 * dsh-remote-wsl / open-editor —— 把 WSL 路径交给本机 VS Code / Windows 资源管理器。
 *
 * 参考 zai-org/ZCode 的 packages/desktop/src/main/openInEditor.ts（2026-10-29 第三轮对比）：
 *   · VS Code 必须用 Remote-WSL URI，不能把 Linux 路径直接交给本机；
 *   · 目录用 `--folder-uri`、文件用 `--file-uri`；
 *   · 资源管理器优先 `\\wsl.localhost\<distro>\…`，老 Windows 回退 `\\wsl$\<distro>\…`。
 *
 * 本模块只做**纯函数**（URI/候选路径），实际 spawn 留在 explorer.ts，便于离线测试。
 */

/** Linux 路径 → VS Code Remote-WSL URI；每一段单独 encode，保留 `/` 分隔。 */
export function buildVsCodeWslUri(distro, linuxPath) {
  const raw = String(linuxPath ?? '/');
  const tail = raw
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `vscode-remote://wsl+${encodeURIComponent(String(distro ?? ''))}${tail ? `/${tail}` : '/'}`;
}

/** 资源管理器候选（wsl.localhost 优先，wsl$ 兜底）；路径含反斜杠时抛错，避免 Windows 解析歧义。 */
export function buildWslUncCandidates(primaryUnc, linuxPath) {
  const raw = String(linuxPath ?? '/');
  if (raw.includes('\\')) {
    throw new Error('cannot build a UNC path for a Linux path containing backslash');
  }
  const first = String(primaryUnc);
  const second = first.replace(/^\\\\wsl\.localhost\\/i, '\\\\wsl$\\');
  return first === second ? [first] : [first, second];
}

/** VS Code CLI 命令行参数：目录用 folder-uri，文件用 file-uri。 */
export function buildVsCodeOpenArgs(pathKind, uri) {
  return [pathKind === 'file' ? '--file-uri' : '--folder-uri', String(uri)];
}
