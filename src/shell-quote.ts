/**
 * shell-quote —— 把**数据**安全地送进 bash 的最小工具集（纯函数、零依赖、零构建）。
 *
 * 为什么单独成文件（2026-10-27 审查）：
 *  · F-08：`cwd` 来自调用方（模型/工具参数），它是**数据**而不是脚本文本。旧实现把它裸插值进
 *    `cd "${cwd}"` 与诊断 `echo "…"` ⇒ 引号闭合/`$()` 可注入，且 `cd` 失败后仍可能 exit 0、
 *    命令静默跑在错误目录。这里统一用单引号 + `'\''` 转义（POSIX 下唯一可靠的写法）。
 *  · F-09：清理/回收要杀 WSL 侧进程时，pid 从文件读回，可能已被复用。判据 = 启动脚本写入的
 *    唯一标记 `DSH_RWSL_MARK=<脚本基名>`（跨重启不重合）；旧脚本没有该标记时退回「cmdline 含
 *    `@deepseek-ai/dsh`」的弱判据。两者都不符 ⇒ **只删文件、不发信号**。
 *
 * 纪律：这里的每个函数只做字符串构造，不执行任何东西 —— 便于单测（见 README「验证」）。
 *
 * @module dsh-remote-wsl/shell-quote
 */

/** POSIX 单引号转义：结果在 shell 里是一个**字面量参数**，不展开 `$`/反引号/分号。 */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * `cd <cwd>` 的安全前缀：失败**立刻** exit 2（绝不静默落在别的目录继续跑）。
 * @param cwd Linux 绝对路径（数据）
 */
export const cdPreamble = (cwd) =>
  `cd ${shq(cwd)} || { echo ${shq(`remote-wsl: cwd 不存在: ${cwd}`)} >&2; exit 2; }`;

/**
 * 「只在确认是自己起的进程时才发信号」的 shell 片段。
 *
 * @param pidExpr shell 变量表达式（如 `$p` / `$PID`，由调用方保证是数字来源）
 * @param mark 唯一标记（= 启动脚本基名，含随机后缀）
 * @returns 一段 `if …; then kill; elif …; then kill; fi`（不符合时什么都不做）
 */
export function killIfOwnedScript(pidExpr, mark) {
  const want = shq(`DSH_RWSL_MARK=${mark}`);
  const lines = [
    `if [ -r "/proc/${pidExpr}/environ" ] && tr '\\0' '\\n' < "/proc/${pidExpr}/environ" | grep -Fxq ${want}; then`,
    `  pkill -TERM -P "${pidExpr}" 2>/dev/null || true`,
    `  kill -TERM "${pidExpr}" 2>/dev/null || true`,
    `elif [ -r "/proc/${pidExpr}/cmdline" ] && tr '\\0' ' ' < "/proc/${pidExpr}/cmdline" | grep -Fq '@deepseek-ai/dsh'; then`,
    `  pkill -TERM -P "${pidExpr}" 2>/dev/null || true`,
    `  kill -TERM "${pidExpr}" 2>/dev/null || true`,
    `fi`,
  ];
  return lines.join('\n');
}
