/**
 * daemon-client.ts —— **薄 re-export 层**（T3 拆分后）。
 *
 * 本文件原来承载全部守护控制面（1068 行）；现按关注点拆成三个模块，**对外导出面逐一保持不变**：
 *   · `daemon-protocol.ts`  —— 路径/元数据/扫描/脚本执行/TCP 与握手
 *   · `daemon-launch.ts`    —— 启动脚本、systemd 主路径与 compat 回退、launcher 回收
 *   · `daemon-lifecycle.ts` —— ensure / stop / snapshot / status（唯一孤儿真相源）
 *
 * 为什么不直接用新路径：`src/explorer.ts` / `src/index.ts` / `src/selftest.ts` 都从
 * `./daemon-client.ts` 取符号，保持这个入口可避免与 T4/T5 抢文件，也把"导出面"钉成契约。
 *
 * 拆分来源：`daemon-client.ts` @ sha256 cb420d25ef1bcf9535cbf2f3dbb3faad95fa0d5321b31d0ca798103de59dbed1
 *   （备份：`spike/verify/explorer-20261012/arch-t3/backup/daemon-client.cb420d25.ts.bak`）
 * 纪律：只搬不改 —— `stopDaemon` 的 `ok:false` + `notes` 语义、`mode`/`warning` 与 F-38 告警文案、
 * 槽位/元数据文件布局**均未改动**（验收见 `arch-t3/REPORT-daemon-split.md`）。
 */

export {
  unc,
  winToWsl,
  daemonScriptWsl,
  stateDirLinux,
  metaLinux,
  tokenLinux,
  launchLinux,
  logLinux,
  legacyMetaLinux,
  legacyTokenLinux,
  listDaemonSlots,
  readDaemonMeta,
  readDaemonToken,
  readDaemonRecord,
  readDaemonLogTail,
  scanDaemonProcesses,
  wslRunScript,
  tcpCall,
  handshake,
  callDaemon,
  daemonPrompt,
} from './daemon-protocol.ts';

export {
  systemdUnit,
  writeLauncherWsl,
  removeLauncher,
  launchDaemon,
  configCompat,
} from './daemon-launch.ts';

export {
  ensureDaemon,
  stopDaemon,
  stopAllDaemons,
  daemonSnapshot,
  daemonStatus,
} from './daemon-lifecycle.ts';
