/**
 * dsh-remote-wsl / tool-catalog —— **工具清单的唯一真相源**。
 *
 * 为什么需要它（2026-11-25 教训）：对外呈现里有三处"工具数量"：README 表格、README 正文/图里的
 * "N 个工具"、以及 banner 位图。它们各自手写，于是漂了两次：先是从 7 涨到 9 时图没改，
 * 后来加 `wsl_grep`/`wsl_glob` 时表里补了、`wsl_doctor` 却一直没进表（所以"九个工具"其实是十个）。
 * 现在三处数字都由本文件推导，并由 `scripts/check-contract.ts` 双向校验：
 *   · 本清单 ⇄ `src/*.ts` 里真实的 `tools.register({ name })`（多了少了都报）；
 *   · 本清单 ⇄ README 工具表的行名（文档漏写一行会被门禁拦住）。
 *
 * 注意两个作用域要分开数（别混成一个数字）：
 *   · HOST_TOOLS   —— 根插件（宿主平面）注册、任何会话都能看到的工具；
 *   · PRESET_TOOLS —— 只挂在 WSL 执行世界（`wsl` preset）里的工具（`grep`/`glob`/`wsl_tools`）。
 * 面板与 banner 上的"面板 / N 个工具"指的是 HOST_TOOLS。
 *
 * @module dsh-remote-wsl/tool-catalog
 */

/** 宿主平面工具（根插件注册；面板/banner 的"N 个工具"就是这个数）。 */
export const HOST_TOOLS = [
  { name: 'wsl_status', summary: '只读诊断：发行版 / 版本 / 漂移 / 守护 / 通道健康' },
  { name: 'wsl_exec', summary: '在 WSL 里跑一次性 bash（危险命令需审批）' },
  { name: 'wsl_agent', summary: '把任务交给 WSL 里的常驻 dsh（关客户端不丢会话）' },
  { name: 'wsl_daemon', summary: '守护状态 / 启动 / 停止 / 重启' },
  { name: 'wsl_open_ui', summary: '在 WSL 里起 dsh web 并开窗口' },
  { name: 'wsl_sync_version', summary: '对齐桌面与 WSL 侧版本 pin' },
  { name: 'wsl_path', summary: 'Windows ⇄ WSL 路径互转' },
  { name: 'wsl_grep', summary: '在发行版里 grep（一次 op 扫整棵树）' },
  { name: 'wsl_glob', summary: '在发行版里按 glob 列文件（一次 op）' },
  { name: 'wsl_doctor', summary: '只读体检：把探针聚合成 ready / degraded / blocked' },
] as const;

/** 只在 WSL 执行世界（preset）内注册的工具。 */
export const PRESET_TOOLS = [
  { name: 'grep', summary: 'WSL 内 grep（preset 作用域）' },
  { name: 'glob', summary: 'WSL 内 glob（preset 作用域）' },
  { name: 'wsl_tools', summary: '列出/安装 WSL 侧 Rust CLI 工具' },
] as const;

/** 宿主平面工具数（banner 与 README 正文都取这个值，不再手写）。 */
export const hostToolCount = () => HOST_TOOLS.length;

/** 中文数字（banner/正文用「十 个工具」这种写法）。 */
export const zhCount = (n) => {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  if (n >= 0 && n <= 10) return digits[n];
  if (n < 20) return `十${digits[n - 10]}`;
  return String(n);
};
