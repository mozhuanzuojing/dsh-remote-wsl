/**
 * dsh-remote-wsl / wsl-output —— `wsl.exe` 输出的**唯一解码实现**（2026-10-22 review 后从两处合并）。
 *
 * 为什么独立成模块：`src/explorer.ts`（`wsl -l -v` 表）与 `src/wsl-io.ts`（`runWsl` / `wslpath`）
 * 原来各有一份等价实现，只靠探针断言"行为一致"维持 —— 那是**重复实现**，改一边忘另一边就会漂。
 * 现在两边都从这里取；`explorer.decodeWslOutput` 与 `wsl-io.decodeWslOutput` 保留为 re-export
 * （导出面不变，index.ts 与既有探针不受影响）。
 *
 * 判据来自 ZCode（`packages/server/src/remote/wsl-detect.ts`）：
 *   1. `wsl.exe -l -v` 在 Windows 上常返回 **UTF-16LE**，按 UTF-8 解码会夹满 `\0`；
 *      用"含 NUL ⇒ utf16le"的启发式同时兼容两种编码；
 *   2. 再去掉 NUL / 开头 BOM / 全部 CR，得到干净文本。
 *
 * ⚠️ 已知边界（与 ZCode 同一启发式，如实记录）：UTF-8 输出里若出现**裸 NUL**（例如 `printf 'a\0b'`），
 * 会被误判成 UTF-16LE。我们的 WSL 命令输出不含裸 NUL，故不加探形逻辑；
 * 边界由 `spike/verify/zcode-20261022/probe-wsl-io-lifecycle.ts` 钉住。
 *
 * @module dsh-remote-wsl/wsl-output
 */

/** execFile/spawnSync 的 stdout 缓冲上限（ZCode `WSL_EXEC_MAX_BUFFER`）。 */
export const WSL_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

/** 含 NUL ⇒ UTF-16LE，否则 UTF-8（ZCode `decodeWslOutput`）。 */
export function decodeWslOutput(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  if (buffer.length === 0) return '';
  return buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8');
}

/** 去 NUL / 开头 BOM / 全部 CR（ZCode `normalizeWslOutput`）。 */
export function normalizeWslOutput(raw) {
  return String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '');
}

/** 一次性把 `wsl.exe` 的 Buffer/文本输出变成干净文本（decode + normalize）。 */
export function readWslOutput(input) {
  return normalizeWslOutput(decodeWslOutput(input));
}
