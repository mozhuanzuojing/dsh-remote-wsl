/**
 * dsh-remote-wsl / doctor —— 只读诊断闭环 v1：把已有探针的事实聚合成
 * `verdict(ready|degraded|blocked) + 逐项 check + 修复命令`，用于"点名问题、少来回"。
 *
 * 纯函数：facts 由调用方（`wsl_doctor` 工具）用现有探针填充，本模块不触网/不起进程，
 * 便于单测。只读、不修；给出可执行补救（调用哪个工具/改哪个配置）。
 *
 * @module dsh-remote-wsl/doctor
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  remedy?: string[];
}
export interface DoctorFacts {
  platform?: string;
  distrosReadFailed?: boolean;
  distros?: string[] | null;
  targetIssue?: string | null;
  targetMissing?: boolean;
  distro?: string | null;
  wslHome?: string | null;
  cwd?: string | null;
  versionResolved?: string | null;
  versionIssue?: string | null;
  drift?: { drifted?: boolean; desktop?: string; pin?: string } | null;
  daemon?: { present?: boolean; running?: boolean; reachable?: boolean; detail?: string } | null;
  proxy?: { reachable?: boolean | null; host?: string | null; port?: number | null } | null;
  memory?: { totalMB?: number; freeMB?: number; swapUsedPct?: number } | null;
  configWarnings?: string[];
}
export interface DoctorReport {
  verdict: 'ready' | 'degraded' | 'blocked';
  checks: DoctorCheck[];
  text: string;
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '·' };
const VL: Record<DoctorReport['verdict'], string> = { ready: '就绪', degraded: '可用（有警告）', blocked: '被阻塞' };

/** 聚合事实为诊断报告（纯函数）。 */
export function doctorReport(facts: DoctorFacts = {}): DoctorReport {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // 1) 平台
  const platform = String(facts.platform ?? '');
  add(platform === 'win32'
    ? { id: 'platform', status: 'ok', title: '平台', detail: 'win32' }
    : { id: 'platform', status: 'fail', title: '平台', detail: `当前 ${platform || '未知'}，本插件仅支持 Windows 桌面 + WSL2`, remedy: ['在 Windows 版 DSH 桌面里使用本插件'] });

  // 2) 发行版列表
  if (facts.distrosReadFailed || (Array.isArray(facts.distros) && facts.distros.length === 0)) {
    add({ id: 'distros', status: 'fail', title: 'WSL 发行版', detail: '读不到任何发行版（WSL 未安装 / wsl.exe 不可用 / 未安装发行版）', remedy: ['wsl.exe --install', 'wsl.exe -l -v（确认 VERSION 2）'] });
  } else if (Array.isArray(facts.distros)) {
    add({ id: 'distros', status: 'ok', title: 'WSL 发行版', detail: `${facts.distros.length} 个：${facts.distros.join(', ')}` });
  } else {
    add({ id: 'distros', status: 'skip', title: 'WSL 发行版', detail: '未探测' });
  }

  // 3) 目标（distro/wslHome/cwd）
  if (facts.targetIssue) {
    add({ id: 'target', status: 'fail', title: '目标', detail: String(facts.targetIssue), remedy: ['在 cordis.patch.yml 设置 distro / wslHome / cwd', '或调用 wsl_status {redetect:true} 重新自动探测'] });
  } else if (facts.targetMissing) {
    add({ id: 'target', status: 'fail', title: '目标', detail: `配置的发行版 "${facts.distro ?? ''}" 不在列表中`, remedy: ['改正 cordis.patch.yml 的 distro', '或 wsl_status {redetect:true}'] });
  } else {
    add({ id: 'target', status: 'ok', title: '目标', detail: `distro=${facts.distro ?? '(自动)'} · wslHome=${facts.wslHome ?? '(自动)'} · cwd=${facts.cwd ?? '(自动)'}` });
  }

  // 4) DSH 版本解析
  if (facts.versionIssue) {
    add({ id: 'version', status: 'fail', title: 'DSH 版本', detail: String(facts.versionIssue), remedy: ['在 cordis.patch.yml 设置 dshVersion（或确保 desktop runtime.json 可读）'] });
  } else if (!facts.versionResolved) {
    add({ id: 'version', status: 'warn', title: 'DSH 版本', detail: '未能解析桌面版本', remedy: ['设置 dshVersion'] });
  } else {
    add({ id: 'version', status: 'ok', title: 'DSH 版本', detail: facts.versionResolved });
  }

  // 5) 版本漂移
  if (facts.drift && facts.drift.drifted === true) {
    add({ id: 'drift', status: 'warn', title: '版本漂移', detail: `desktop ${facts.drift.desktop ?? '?'} ≠ pin ${facts.drift.pin ?? '?'}`, remedy: ['调用 wsl_sync_version 对齐（或面板「版本」卡点「同步」）'] });
  } else if (facts.drift && facts.drift.drifted === false) {
    add({ id: 'drift', status: 'ok', title: '版本漂移', detail: '已与 pin 对齐' });
  } else {
    add({ id: 'drift', status: 'skip', title: '版本漂移', detail: '未探测' });
  }

  // 6) 守护
  if (facts.daemon === null || facts.daemon === undefined) {
    add({ id: 'daemon', status: 'skip', title: '守护', detail: '未探测' });
  } else if (facts.daemon.present === false) {
    add({ id: 'daemon', status: 'warn', title: '守护', detail: '未运行（按需启动；首用会自动拉起）', remedy: ['调用 wsl_daemon {action:"start"} 或直接跑一次 wsl_exec 触发'] });
  } else if (facts.daemon.reachable === false) {
    add({ id: 'daemon', status: 'fail', title: '守护', detail: `守护在但不可达：${facts.daemon.detail ?? ''}`, remedy: ['wsl_daemon {action:"restart"}', '检查代理/端口'] });
  } else if (facts.daemon.running === false) {
    add({ id: 'daemon', status: 'warn', title: '守护', detail: `已登记但未运行：${facts.daemon.detail ?? ''}`, remedy: ['wsl_daemon {action:"start"}'] });
  } else {
    add({ id: 'daemon', status: 'ok', title: '守护', detail: facts.daemon.detail ?? '运行中' });
  }

  // 7) 代理
  if (facts.proxy && facts.proxy.reachable === false) {
    add({ id: 'proxy', status: 'warn', title: '代理', detail: `不可达（${facts.proxy.host ?? '?'}:${facts.proxy.port ?? '?'}）`, remedy: ['检查 Windows 侧代理/端口，或重开面板刷新'] });
  } else if (facts.proxy && facts.proxy.reachable === true) {
    add({ id: 'proxy', status: 'ok', title: '代理', detail: `${facts.proxy.host ?? '?'}:${facts.proxy.port ?? '?'}` });
  } else {
    add({ id: 'proxy', status: 'skip', title: '代理', detail: '未探测/发行版未运行' });
  }

  // 7.5) WSL 内存 / swap（2026-11-20 真机：swap 100% + free 534MB ⇒ 守护瞬断、重启也起不来）
  if (facts.memory === null || facts.memory === undefined) {
    add({ id: 'memory', status: 'skip', title: 'WSL 内存', detail: '未探测' });
  } else if ((facts.memory.swapUsedPct ?? 0) >= 95 || (facts.memory.freeMB ?? 999) < 300) {
    add({
      id: 'memory',
      status: 'fail',
      title: 'WSL 内存',
      detail: `内存紧张：free ${facts.memory.freeMB ?? '?'}MB · swap ${facts.memory.swapUsedPct ?? '?'}%（total ${facts.memory.totalMB ?? '?'}MB）—— 守护/文件读会瞬断，重启守护也可能失败`,
      remedy: [
        'wsl --shutdown 清 VM（会杀掉发行版内所有进程）',
        '在 %UserProfile%\\.wslconfig 设 [wsl2] memory=10GB / swap=4GB（默认 memory 是宿主 ~50%）',
        'wsl -d <distro> --exec free -m 自查；ps -eo rss,comm --sort=-rss | head 看谁吃内存',
      ],
    });
  } else {
    add({ id: 'memory', status: 'ok', title: 'WSL 内存', detail: `free ${facts.memory.freeMB ?? '?'}MB · swap ${facts.memory.swapUsedPct ?? 0}%` });
  }

  // 8) 配置告警
  for (const [i, w] of (facts.configWarnings ?? []).entries()) {
    add({ id: 'config:' + i, status: 'warn', title: '配置', detail: String(w) });
  }

  const verdict: DoctorReport['verdict'] = checks.some((c) => c.status === 'fail') ? 'blocked' : checks.some((c) => c.status === 'warn') ? 'degraded' : 'ready';
  const lines = [`WSL 诊断：${VL[verdict]}`];
  for (const c of checks) {
    if (c.status === 'skip') continue;
    lines.push(`[${ICON[c.status]}] ${c.title}：${c.detail}`);
    for (const r of c.remedy ?? []) lines.push(`     → ${r}`);
  }
  const blocked = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  lines.push(`— ${blocked} 项阻塞 · ${warned} 项警告 · ${checks.filter((c) => c.status === 'ok').length} 项正常`);
  return { verdict, checks, text: lines.join('\n') };
}
