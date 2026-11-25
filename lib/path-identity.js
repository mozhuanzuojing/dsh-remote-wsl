/**
 * dsh-remote-wsl / path-identity —— 插件内部**唯一路径身份**：`{distro, linuxPath}`。
 *
 * 为什么需要（ADR：docs/2026-11-21-path-identity.md）：
 *   · 9P/UNC 字符串是**边界 wire format**，不是身份。用 UNC 当内部身份会引入
 *     Windows 语义（ADS `a:b`、尾点/尾空格、保留名、`\` 分隔符）、"同一文件两个键"、以及
 *     安全判定被字符串重解析。
 *   · 归属方原生：WSL 侧字节归 WSL（身份=Linux 路径），Windows 卷（`/mnt/x`）在边界才映射成 `X:\`。
 *
 * 本模块**只做纯转换**，不碰 fs、不读配置、不发请求；调用方在边界处使用：
 *   进：`identityFromWire(hostPath, distro)`（host fs 的 `targetKey` / 会话 cwd / 用户输入）
 *   出：`wireFromIdentity(id)`（给 DSH 宿主 fs 的 `targetKey`）/ `nativeWireFromIdentity(id)`（给 Windows 命令）
 */
import path from 'node:path';
import { parseWslUncPath, wslUncPath } from './unc-path.js';
import { toWindowsPath } from './native-mount.js';
import { buildVsCodeWslUri } from './open-editor.js';
/** 归一化 Linux 绝对路径：折叠 `//`、消解 `.`/`..`、保证前导 `/`、去掉尾部 `/`（根除外）。 */
export function normalizeLinuxPath(input) {
    const raw = String(input ?? '');
    if (raw === '')
        return '/';
    const abs = raw.startsWith('/') ? raw : `/${raw}`;
    const normalized = path.posix.normalize(abs);
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/';
}
/**
 * 从 wire 形式解析身份（Wi 形式 = UNC `\\wsl.localhost\<distro>\…`、或 POSIX 绝对路径）。
 * · 传了 `distro` 且 UNC 的发行版不一致 → null（跨发行版必须交回原 host）；
 * · Windows 盘符 / 相对路径 / 空 → null。
 */
export function identityFromWire(value, distro) {
    const want = String(distro ?? '');
    const unc = parseWslUncPath(value);
    if (unc !== null) {
        if (want && unc.distro.toLowerCase() !== want.toLowerCase())
            return null;
        return { distro: unc.distro, linuxPath: normalizeLinuxPath(unc.linuxPath) };
    }
    const raw = String(value ?? '').trim();
    if (raw.length === 0)
        return null;
    if (/^[A-Za-z]:[\\/]/.test(raw))
        return null;
    if (!raw.startsWith('/'))
        return null;
    return { distro: want, linuxPath: normalizeLinuxPath(raw) };
}
/** 身份 → 给 DSH 宿主 fs 服务的 `targetKey`（UNC）。路径含 `\` 会抛（UNC 无法无歧义表达）。 */
export function wireFromIdentity(id) {
    return wslUncPath(id.distro, id.linuxPath);
}
/** 身份 → Windows 原生盘符（仅 `/mnt/<letter>/…`）；不可原生映射返回 null（调用方回落 RPC）。 */
export function nativeWireFromIdentity(id) {
    return toWindowsPath(id.linuxPath);
}
/** 身份 → 用户/模型可见的显示路径（Linux 绝对路径）。 */
export function displayFromIdentity(id) {
    return id.linuxPath;
}
/** 身份 → VS Code Remote-WSL URI（`vscode-remote://wsl+<distro>/<encoded>`）。 */
export function vscodeUriFromIdentity(id) {
    return buildVsCodeWslUri(id.distro, id.linuxPath);
}
/** 身份是否落在 Windows 卷（`/mnt/<letter>`）——即"归 Windows 原生读"。 */
export function isWindowsVolumeIdentity(id) {
    return toWindowsPath(id.linuxPath) !== null;
}
