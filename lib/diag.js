/**
 * dsh-remote-wsl / diag —— 仅在 `DSH_REMOTE_WSL_DIAG=1` 时把"路由命中"追加到
 * `~/.dsh/remote-wsl/startup.log`（桌面 GUI 看不到 stderr）。关掉即零开销。
 * 用途：在真实 WSL 会话里**实证** fs 读/列路由与 git spawn 路由到底有没有命中。
 * @module dsh-remote-wsl/diag
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** 是否开启命中日志。 */
export function diagOn() {
    return process.env.DSH_REMOTE_WSL_DIAG === '1';
}
/** 追加一条命中日志；环境未开或写失败都静默（诊断不能影响主流程）。 */
export function diag(tag, message) {
    if (!diagOn())
        return;
    try {
        const dir = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'remote-wsl');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'startup.log'), `${new Date().toISOString()} [diag] ${tag}: ${message}\n`);
    }
    catch {
        /* ignore */
    }
}
