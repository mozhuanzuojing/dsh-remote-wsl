/**
 * dsh-remote-wsl / target-detect —— 「零配置」目标探测：默认发行版 + 该发行版登录用户的 `$HOME`。
 *
 * ## 为什么有这个模块（2026-10-28）
 *
 * `src/config.ts` 的 `DEFAULTS` 曾经写死作者机器上的 `distro: 'debian-u8-1'` / `wslHome: '/home/g'`。
 * 换一台机器装上本插件，第一件事就是「未知发行版」——**默认值即缺陷**（README 只能要求用户手改配置来
 * 遮住它）。现在这两项默认是**空 = 自动探测**，探测顺序（与 HANDOFF 的建议一致）：
 *
 *   1. **显式配置永远优先**：`distro` 非空就不再问 `wsl -l -v`；`wslHome` 非空就不再问 `$HOME`。
 *   2. `wsl.exe -l -v` 里 NAME 列带 `*` 的那一行 = WSL 的默认发行版（**只认这个标记**）。
 *   3. 用 `wsl.exe -d <默认发行版> --exec sh -c 'printf %s "$HOME"'` 问该发行版的登录用户家目录
 *      （`sh` 不行再试 `bash`）。
 *   4. 任一步拿不到 ⇒ **留空**，由 `config.ts` 的 `targetProblem()` 给出可操作报错。
 *      **不静默猜**：没有 `*` 行就不挑「唯一那个」（用户可能就想让它明确失败并去配置），
 *      读到空/相对/带空白的 `$HOME` 也按失败处理（带空白的家目录拼进 bash 脚本会失真）。
 *
 * ## 代价（如实记录，不藏）
 *
 * · 探测是**同步** `spawnSync`（`normalizeConfig()` 是同步 API，且拒绝把空串漏给几十个消费方）。
 *   实测本机 `wsl -l -v` ≈150ms、`$HOME` ≈150ms；只在**没有显式配置**时发生，且按进程缓存。
 * · 第 3 步在发行版**未运行**时会被 WSL 拉起（任何 `wsl -d` 都这样，WSL 自身行为）。想完全避免：
 *   把 `distro` + `wslHome` 都显式写进 `cordis.patch.yml`（README「配置」）。
 * · 成功结论**按进程缓存**（改 `wsl --setdefault` 后需重启 DSH，或显式配置）；失败只短暂缓存，
 *   用户装好发行版后无需重启即可重试成功。
 *
 * @module dsh-remote-wsl/target-detect
 */
import { spawnSync } from 'node:child_process';

import { readWslOutput } from './wsl-output.ts';
import { parseWslDistroTable } from './distro-table.ts';

/** `wsl -l -v` 的超时（毫秒）：只读列表，正常 ~150ms；给足冷启动余量。 */
export const DISTRO_TABLE_TIMEOUT_MS = 8000;

/**
 * `printf %s "$HOME"` 的超时（毫秒）：首次运行可能要拉起发行版，给得比列表宽。
 *
 * 为什么不是 20s：探测发生在 `normalizeConfig()`（= 插件 apply，宿主启动路径）里，是**同步**的。
 * 上限就是"最坏情况拖慢启动多久"—— 8s（列表）+ 10s（家目录）= 18s 封顶；再宽就不该了。
 * WSL 真卡死时插件本来也用不了，但这不该让宿主启动无限期挂着。
 */
export const HOME_PROBE_TIMEOUT_MS = 10000;

/** 失败结论的短缓存（毫秒）：只挡住同一轮启动里反复探测，不把一次瞬时故障放大成长期假阴性。 */
export const NEGATIVE_CACHE_MS = 5000;

/** 面板/工具用的**机器可读**失败原因（客户端不必解析中文）。 */
export const NO_DISTRO_REASON = 'no-distro';
export const NO_HOME_REASON = 'no-wsl-home';

/** 探测不到默认发行版时的可操作报错（已含 `remote-wsl: ` 前缀）。 */
export const NO_DISTRO_MESSAGE =
  'remote-wsl: 未能自动探测到 WSL 默认发行版（`wsl.exe -l -v` 里没有带 `*` 的行，或 wsl.exe 不可用）。' +
  '请在 cordis.patch.yml 里显式配置 distro（README「配置」一节），或用 `wsl --set-default <发行版>` 指定默认发行版。';

/**
 * 探测到发行版但读不到 `$HOME` 时的可操作报错。
 * @param distro 已确定的发行版名
 */
export function noHomeMessage(distro) {
  return (
    `remote-wsl: 已确定发行版 "${distro}"，但读不到它的登录用户 $HOME` +
    `（\`wsl -d ${distro} --exec sh -c 'printf %s "$HOME"'\` 失败或输出不是绝对路径）。` +
    '请在 cordis.patch.yml 里显式配置 wslHome（README「配置」一节）。'
  );
}

/**
 * 默认发行版是 WSL1 时的报错（本插件只支持 WSL2：UNC / 守护 / fs provider 都依赖 WSL2）。
 * @param distro 默认发行版名
 */
export function wsl1Message(distro) {
  return (
    `remote-wsl: 默认发行版 "${distro}" 是 WSL1；本插件只支持 WSL2` +
    `（可先执行 wsl --set-version ${distro} 2 升级；或配置另一个 WSL2 发行版）。`
  );
}

/**
 * `wsl -l -v` 超时的报错。
 *
 * 为什么要单列：超时与"没有默认发行版"是两回事，而启动日志只打印 `problem` 这一行 —— 不写清
 * "是超时"，用户会去查发行版列表而不是查 WSL 卡启动。
 * @param timeoutMs 该次探测的墙钟上限
 */
export function noDistroTimeoutMessage(timeoutMs) {
  return (
    `remote-wsl: 探测默认发行版超时（\`wsl.exe -l -v\` ${timeoutMs}ms 未返回；WSL 可能在冷启动或卡住）。` +
    'WSL 恢复后重启 DSH 会自动重试；或在 cordis.patch.yml 里显式配置 distro / wslHome 完全跳过探测。'
  );
}

/**
 * 配置里的「目标字符串」归一：非字符串/空白 ⇒ `''`；`'auto'`（大小写不敏感）⇒ `''`（= 自动探测）。
 * @param value 配置值
 */
export function asConfigText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^auto$/i.test(text) ? '' : text;
}

/**
 * `spawnSync` 的探测结果（**只读**：探测阶段不许有副作用，除了 WSL 自己会拉起的发行版）。
 * @typedef {{ status: number | null, stdout: Buffer | string, stderr: Buffer | string, error: any | null }} ProbeResult
 */

/**
 * 生产用的运行器：真的去起 `wsl.exe`（同步）。
 *
 * 为什么 `encoding: 'buffer'`：`wsl.exe -l -v` 是 UTF-16LE，按 utf8 读会夹满 NUL；
 * 交给 `src/wsl-output.ts` 的判码逻辑（含 NUL ⇒ utf16le）统一处理，不在探测这层另写一份。
 *
 * @param args wsl.exe 的参数（不含可执行文件本身）
 * @param timeoutMs 墙钟上限
 * @returns ProbeResult（**不抛**：spawn 失败放进 `error` 字段，由调用方给出可读结论）
 */
export function spawnWslProbe(args, timeoutMs) {
  let res;
  try {
    res = spawnSync('wsl.exe', args, {
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      timeout: timeoutMs,
    });
  } catch (e) {
    return { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: e ?? new Error('spawnSync threw') };
  }
  return {
    status: typeof res.status === 'number' ? res.status : null,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: res.stderr ?? Buffer.alloc(0),
    error: res.error ?? null,
  };
}

/** 只取 stderr/stdout 最后一条非空行（拼诊断用，别把整段输出塞进错误）。 */
function lastLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/**
 * 从 `printf %s "$HOME"` 的输出里取家目录；不合法一律返回 `''`（**不猜**）。
 *
 * 判据：必须是绝对路径；不含空白（含空白的家目录拼进 `cd "<home>"` 之外的脚本片段会失真）；
 * 去掉尾部 `/`（`/` 本身保留）。
 * @param raw 命令输出（已解码/未解码都可）
 */
export function pickHome(raw) {
  const text = String(raw ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!text.startsWith('/')) return '';
  if (/\s/.test(text)) return '';
  const trimmed = text.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * 探测默认发行版（**纯函数**：唯一副作用来自传入的 `probe`）。
 * @param probe 运行器（生产传 `spawnWslProbe`，测试传假实现）
 * @returns `{ distro, notes, problem }` —— 失败时 `distro === ''` 且 `problem` 可读
 */
export function detectDefaultDistro(probe) {
  const notes = [];
  let res;
  try {
    res = probe(['-l', '-v'], DISTRO_TABLE_TIMEOUT_MS);
  } catch (e) {
    notes.push(`wsl.exe 探测抛错: ${e?.message ?? String(e)}`);
    return { distro: '', notes, problem: NO_DISTRO_MESSAGE };
  }
  if (!res) {
    notes.push('wsl.exe 探测没有返回结果');
    return { distro: '', notes, problem: NO_DISTRO_MESSAGE };
  }
  if (res.error) {
    const code = res.error.code ? ` (${res.error.code})` : '';
    notes.push(`wsl.exe 不可用${code}: ${String(res.error.message ?? '').trim()}`);
    // 超时 ≠ 没有默认发行版：单独说清楚（启动日志只打印这一行）。
    const problem = String(res.error.code ?? '') === 'ETIMEDOUT' ? noDistroTimeoutMessage(DISTRO_TABLE_TIMEOUT_MS) : NO_DISTRO_MESSAGE;
    return { distro: '', notes, problem };
  }
  const rows = parseWslDistroTable(readWslOutput(res.stdout ?? ''));
  const def = rows.find((row) => row.isDefault) ?? null;
  if (!def) {
    const stderrTail = lastLine(readWslOutput(res.stderr ?? ''));
    notes.push(
      rows.length
        ? `wsl -l -v 里没有带 * 的默认发行版（发现：${rows.map((row) => row.name).join('、')}）`
        : `wsl -l -v 没有给出任何发行版${stderrTail ? `（stderr: ${stderrTail}）` : ''}`,
    );
    return { distro: '', notes, problem: NO_DISTRO_MESSAGE };
  }
  if (def.version === 1) {
    notes.push(`默认发行版 "${def.name}" 的 VERSION 列是 1（WSL1）`);
    return { distro: '', notes, problem: wsl1Message(def.name) };
  }
  notes.push(`默认发行版 "${def.name}"（wsl -l -v 的 * 行）`);
  return { distro: def.name, notes, problem: null };
}

/**
 * 探测某个发行版的登录用户 `$HOME`（**纯函数**）。
 *
 * 先 `sh` 后 `bash`：两者都不必存在于裁剪过的发行版里，但总得先试一个。
 * **只在"这个 shell 本身不能用"时换下一个**（exit ≠ 0）；`spawnSync` 报了 error（超时/起不来）
 * 或 shell 正常退出但输出不合法时**立即停** —— 换一个 shell 只会把启动阻塞翻倍，而结论不会变。
 * 失败原因会带最后一行 stderr —— 不把"读不到"糊成"没有家目录"。
 *
 * @param probe 运行器
 * @param distro 发行版名（非空；空则直接返回 NO_DISTRO_MESSAGE）
 * @returns `{ home, notes, problem }` —— 失败时 `home === ''`
 */
export function detectDistroHome(probe, distro) {
  const name = asConfigText(distro);
  const notes = [];
  if (!name) return { home: '', notes, problem: NO_DISTRO_MESSAGE };
  let why = '';
  for (const shell of ['sh', 'bash']) {
    let res;
    try {
      res = probe(['-d', name, '--exec', shell, '-c', 'printf %s "$HOME"'], HOME_PROBE_TIMEOUT_MS);
    } catch (e) {
      why = `探测抛错: ${e?.message ?? String(e)}`;
      break;
    }
    if (!res) {
      why = '探测没有返回结果';
      break;
    }
    if (res.error) {
      const code = res.error.code ? ` (${res.error.code})` : '';
      why = `wsl.exe 不可用${code}: ${String(res.error.message ?? '').trim()}`;
      break;
    }
    const home = pickHome(readWslOutput(res.stdout ?? ''));
    const stderrTail = lastLine(readWslOutput(res.stderr ?? ''));
    if (home) {
      notes.push(`$HOME = ${home}（wsl -d ${name} --exec ${shell}）`);
      return { home, notes, problem: null };
    }
    if (res.status === 0) {
      // shell 跑了、输出却不是可用绝对路径 ⇒ 换 shell 也不会变好（不是"缺 sh"那种情况）
      why = `exit 0 但输出不是可用的绝对路径${stderrTail ? `（stderr: ${stderrTail}）` : ''}`;
      break;
    }
    why = `exit ${res.status ?? '?'}${stderrTail ? `: ${stderrTail}` : ''}（该 shell 不可用）`;
  }
  notes.push(`读 $HOME 失败：${why || '未知原因'}`);
  return { home: '', notes, problem: noHomeMessage(name) };
}

// ── 进程内缓存（只缓存**成功**结论；失败最多挡住 NEGATIVE_CACHE_MS）──────────────
//
// 为什么必须缓存：`normalizeConfig()` 在启动期会被调多次（index / preset / 子插件），
// 每次探测都是同步 spawn ⇒ 不缓存就是 2-4 次白付的 150-300ms。
// 为什么不缓存失败到天荒地老：用户装好 WSL / `wsl --set-default` 之后，插件不该要求重启才认得。

let distroMemo = null; // { distro, notes, problem, at }
const homeMemos = new Map(); // distro -> { home, notes, problem, at }

/**
 * 带缓存地探测默认发行版（生产路径）。
 * @param probe 运行器（生产默认 `spawnWslProbe`）
 */
export function detectDefaultDistroCached(probe = spawnWslProbe) {
  if (distroMemo !== null && (distroMemo.distro || Date.now() - distroMemo.at < NEGATIVE_CACHE_MS)) return distroMemo;
  const result = { ...detectDefaultDistro(probe), at: Date.now() };
  distroMemo = result;
  return result;
}

/**
 * 带缓存地探测某发行版的 `$HOME`（生产路径）。
 * @param distro 发行版名
 * @param probe 运行器
 */
export function detectDistroHomeCached(distro, probe = spawnWslProbe) {
  const key = asConfigText(distro);
  const hit = homeMemos.get(key);
  if (hit !== undefined && (hit.home || Date.now() - hit.at < NEGATIVE_CACHE_MS)) return hit;
  const result = { ...detectDistroHome(probe, key), at: Date.now() };
  homeMemos.set(key, result);
  return result;
}

/** 丢掉探测缓存（测试与「重新探测」用；生产里没有会**主动**调用它的路径）。 */
export function resetTargetDetection() {
  distroMemo = null;
  homeMemos.clear();
}

/**
 * 按「显式配置 → 默认发行版 → 该发行版的 `$HOME`」解析目标，**纯函数**（不给 `probe` 时走缓存的生产探测）。
 *
 * @param merged 已与 `DEFAULTS` 合并的配置（`distro` / `wslHome` 可为空或 `'auto'`）
 * @param opts.probe **测试缝**：给了就完全不用缓存、不起真的 wsl.exe
 * @returns `{ distro, wslHome, notes, problem }`
 */
export function resolveAutoTarget(merged = {}, opts = {}) {
  const probe = typeof opts?.probe === 'function' ? opts.probe : null;
  const notes = [];
  let distro = asConfigText(merged?.distro);
  let wslHome = asConfigText(merged?.wslHome);
  if (!distro) {
    const found = probe ? detectDefaultDistro(probe) : detectDefaultDistroCached();
    notes.push(...found.notes);
    distro = found.distro;
    if (!distro) return { distro: '', wslHome, notes, problem: found.problem ?? NO_DISTRO_MESSAGE };
  }
  if (!wslHome) {
    const found = probe ? detectDistroHome(probe, distro) : detectDistroHomeCached(distro);
    notes.push(...found.notes);
    wslHome = found.home;
    if (!wslHome) return { distro, wslHome: '', notes, problem: found.problem ?? noHomeMessage(distro) };
  }
  return { distro, wslHome, notes, problem: null };
}
