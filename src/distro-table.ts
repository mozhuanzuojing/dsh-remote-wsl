/**
 * dsh-remote-wsl / distro-table —— `wsl.exe -l -v` 的 NAME/STATE/VERSION 表**唯一解析实现**。
 *
 * 为什么独立成模块（2026-10-28 零配置改动）：这张表现在有两个消费方 ——
 *   · `src/explorer.ts`：要 STATE/默认标志/版本（面板的「在跑/默认/WSL1」徽标）；
 *   · `src/target-detect.ts`：要 `*` 那行的发行版名（零配置的默认目标）。
 * 两处各写一份必然漂移（本仓已经踩过同样的坑：`decodeWslOutput` 曾在 explorer 与 wsl-io 各一份
 * ⇒ 2026-10-22 合并到 `src/wsl-output.ts`）。所以这里只留一份，`explorer.ts` 保持**原名导出**
 * （`parseWslDistroTable`），既有导入方与探针不受影响。
 *
 * 解析口径（逐字沿用原实现，行为未改）：
 *  · 列之间是两个以上空格，发行版名可以含单个空格（例如 `Ubuntu 22.04 LTS`）；
 *  · 行尾是 VERSION，倒数第二列是 STATE，NAME 列首个 `*` 表示默认发行版；
 *  · 表头行（没有数字 VERSION）会被跳过；`*` 与名字之间可能还有空格。
 *
 * @module dsh-remote-wsl/distro-table
 */

/**
 * 解析 `wsl -l -v` 的表。
 * @param raw 已解码的文本（用 `readWslOutput()` 处理 buffer，不要自己按 utf8 读）
 * @returns `[{ name, isDefault, state, version }]`（`version` 只认 1/2，其它为 `null`）
 */
export function parseWslDistroTable(raw) {
  const rows = [];
  for (const line of String(raw ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const version = Number.parseInt(parts[parts.length - 1], 10);
    if (!Number.isFinite(version)) continue;
    const state = parts[parts.length - 2];
    const rawName = parts.slice(0, -2).join(' ').trim();
    const isDefault = rawName.startsWith('*');
    const name = rawName.replace(/^\*\s*/, '').trim();
    if (!name) continue;
    rows.push({ name, isDefault, state, version: version === 1 || version === 2 ? version : null });
  }
  return rows;
}
