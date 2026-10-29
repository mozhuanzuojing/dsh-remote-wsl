/**
 * dsh-remote-wsl / probe-unc-bridge —— 可复现的真实 WSL `/mnt` 读桥探针。
 *
 * 用法（在 Windows 侧、仓库根目录）：
 *   node --experimental-strip-types scripts/probe-unc-bridge.ts \
 *     "\\\\wsl.localhost\\debian-u8-1\\mnt\\d\\path\\to\\file"
 *
 * 它用真实的 `createWslFileSystem()`（WSL daemon + fs-rpc）验证：宿主 fs 的
 * resolve/stat/readText 对 /mnt 会报 EPERM 时，fs-unc-bridge 的 resolve/stat/readText
 * 能走 WSL 并读到内容。不修改任何文件；需要 WSL 侧已有可用凭据/守护启动条件。
 */
import { attachUncBridge } from '../src/fs-unc-bridge.ts';
import { createWslFileSystem, parseUnc } from '../src/fs-provider.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node --experimental-strip-types scripts/probe-unc-bridge.ts <wsl-unc-path> [cwd]');
  process.exit(2);
}
const parsed = parseUnc(file);
if (!parsed) {
  console.error('not a \\\\wsl.localhost\\... UNC path:', file);
  process.exit(2);
}
const distro = parsed.distro;
const cwd = process.argv[3] || `\\\\wsl.localhost\\${distro}\\home\\g`;
const eperm = () => Object.assign(new Error(`EPERM: operation not permitted: ${file}`), { code: 'EPERM' });

// 模拟最坏情况的宿主 fs-local：/mnt 上 resolve/stat/read 全部 EPERM。
const host = {
  resolve: async () => { throw eperm(); },
  stat: async () => { throw eperm(); },
  readText: async () => { throw eperm(); },
  writeText: async () => { throw new Error('probe does not write'); },
  editText: async () => { throw new Error('probe does not edit'); },
};
const wsl = createWslFileSystem({ distro, wslHome: process.env.WSL_HOME || '/home/g', cwd: process.env.WSL_HOME || '/home/g', dshVersion: process.env.DSH_PROBE_VERSION || undefined });
attachUncBridge(host, { distro, wslFs: wsl });

const target = await host.resolve(file, { cwd });
const stat = await host.stat(target);
const text = await host.readText(target);
console.log(JSON.stringify({ target, stat, textHead: String(text).slice(0, 120) }, null, 2));
