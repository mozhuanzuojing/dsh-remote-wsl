/**
 * 测试环境探测：这台机器上有没有**真正能执行脚本**的 bash。
 *
 * 为什么不能只跑 `bash -c true`：Windows 上 `bash.exe` 常是 WSL 的存根
 * （`C:\Users\<user>\AppData\Local\Microsoft\WindowsApps\bash.exe`），它对
 * `bash -c true` 会"静默成功"，但换成一个脚本文件参数就失败。用 `-c true`
 * 探测会误判为可用，那些 `{ skip: !hasBash }` 的保护就形同虚设，测试会在没有
 * bash 的机器上假装失败（或假通过）。
 *
 * 这里换成**真正落盘一个脚本再执行**，与生产用法的形态一致。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 探测 bash 是否能执行一个脚本文件，而不是只会响应 `-c`。
 *
 * @returns 能执行返回 true；任何失败（未安装、WSL 存根、超时）都返回 false
 */
export function detectUsableBash(): boolean {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-rw-bashprobe-'));
    const file = join(dir, 'probe.sh');
    // 脚本形式与 cdPreamble 等用例的真实用法一致：bash <file>。
    writeFileSync(file, 'printf %s "$HOME"\n');
    const out = String(execFileSync('bash', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    return out.trim().startsWith('/');
  } catch {
    return false;
  } finally {
    if (dir !== null) {
      try {
        execFileSync('rm', ['-rf', dir], { stdio: 'ignore' });
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}
