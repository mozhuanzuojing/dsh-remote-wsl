/**
 * 进程扫描结果的可区分性回归（2026-10-27 审查 **F-50**）。
 *
 * 缺陷：`scanDaemonProcesses()` / `scanDaemonProcessesAsync()` 原来是 `catch { return [] }` ——
 * 把「扫描失败」折叠成「没有守护进程」。调用方于是拿失败当证据：
 *   · `ensureDaemon` 据此删活守护的元数据（⇒ 隐形孤儿）；
 *   · `waitForSlotGone` 返回 `[]` ⇒ `stopDaemon` 认为「已停干净」⇒ 删元数据 + 报成功；
 *   · `stopAllDaemons` 得到 `remaining.length === 0` ⇒ `ok:true`（伪成功）；
 *   · `daemonSnapshot` 得到空 `orphans` ⇒ 上层说「没有孤儿」。
 *
 * 本文件锁住**判据本身**：`scanResultOf()` 是纯函数（喂假 runner，不需要 wsl.exe / /proc），
 * `scanDaemonProcessesAsync` 的 runner 可注入 ⇒ 整个文件在任何平台上都能确定性跑。
 *
 * 注意：**不 import `src/daemon.ts`**（它是可执行脚本，import 会真的起守护并写用户真实状态目录）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScanOutput, scanDaemonProcessesAsync, scanResultOf } from '../src/daemon-protocol.ts';

/** 只看结果的成功执行（stdout 由调用方给）。 */
const okRun = (stdout: string, stderr = '') => ({ ok: true, status: 0, stdout, stderr });
/** 失败执行：`ok:false` 是唯一判据，status/stderr 只影响可读性。 */
const failRun = (status: number, stderr = '', stdout = '') => ({ ok: false, status, stdout, stderr });

test('F-50 ①：扫描成功但输出为空 ⇒ ok:true 且 procs 为空（这才是真正的「没有进程」）', () => {
  const r = scanResultOf(okRun(''));
  assert.equal(r.ok, true);
  assert.deepEqual(r.procs, []);
  assert.equal(r.error, undefined, '成功路径不该带 error');
  // 只有空白行也算「真的没有进程」（扫描脚本自身以 `true` 收尾，正常输出就是空）
  assert.deepEqual(scanResultOf(okRun('\n\n  \n')).procs, []);
});

test('F-50 ②：runner 失败 ⇒ ok:false、procs 为空、error 可读 —— 必须与 ① 可区分', () => {
  const failed = scanResultOf(failRun(1, 'wsl.exe: 无法解析发行版名称\n'));
  assert.equal(failed.ok, false, '失败绝不能被折叠成成功');
  assert.deepEqual(failed.procs, [], '失败时 procs 恒为空（不许把半截 stdout 当结果）');
  assert.equal(typeof failed.error, 'string');
  assert.match(failed.error, /无法解析发行版名称/, 'error 必须带上 stderr 的可读原因');

  // ★ 核心断言：两者的 procs 一样是空数组，但 ok 必须不同 —— 调用方靠 ok 区分，不靠长度。
  const empty = scanResultOf(okRun(''));
  assert.deepEqual(empty.procs, failed.procs);
  assert.notEqual(empty.ok, failed.ok);
});

test('F-50 ②b：失败时即使 stdout 里有"看起来正常"的行，也一律不解析（超时/中断会留下半截输出）', () => {
  const r = scanResultOf(failRun(1, 'killed', '4242|8731|8731\n'));
  assert.equal(r.ok, false);
  assert.deepEqual(r.procs, [], '半截输出不是真相：ok:false ⇒ procs 必须为空');
});

test('F-50 ③：超时（status=124）也是失败，且错误文案点明「不能当成没有进程」', () => {
  const r = scanResultOf(failRun(124, ''));
  assert.equal(r.ok, false);
  assert.deepEqual(r.procs, []);
  assert.match(r.error, /超时/);
  assert.match(r.error, /124/);
  assert.match(r.error, /没有进程/, '文案要明确这是「未验证」而不是「没有进程」');
});

test('F-50 ③b：error 取 stderr **尾部**并截断到 ~200 字符（关键信息通常在最后一句）', () => {
  const head = 'A'.repeat(300);
  const tail = 'No such file or directory: /proc/self/cmdline';
  const r = scanResultOf(failRun(2, `${head}\n${tail}\n`));
  assert.equal(r.ok, false);
  assert.ok(r.error.length <= 260, `error 应被截断（实际 ${r.error.length} 字符）`);
  assert.ok(r.error.includes(tail), '尾部的原因必须保留（不是把头部截进来）');
  // 截断从**头部**切：300 个 A 只应留下尾部那 200 字符窗口里的那一截，不可能全带出来
  const aCount = (r.error.match(/A/g) ?? []).length;
  assert.ok(aCount < 200, `头部内容应被裁掉（实际保留了 ${aCount} 个 A，共 300 个）`);
  // 多行 stderr 压成一行：工具输出里一行才读得懂
  assert.ok(!r.error.includes('\n'), 'error 里不应有换行');
});

test('F-50 ④：成功路径仍按 parseScanOutput 过滤脏行（不改变既有解析语义）', () => {
  const noisy = ['garbage line', '', '123|8731|8731', 'pid=456 no pipes', '456||', '  789|9000|  '].join('\n');
  const r = scanResultOf(okRun(noisy));
  assert.equal(r.ok, true);
  assert.deepEqual(r.procs, parseScanOutput(noisy), '新结构不得改变既有解析语义');
  assert.deepEqual(r.procs, [
    { pid: 123, port: 8731, metaPort: 8731 },
    { pid: 456, port: null, metaPort: null },
    { pid: 789, port: 9000, metaPort: null },
  ]);
});

test('F-50 ⑤：scanDaemonProcessesAsync 的 runner 可注入 ⇒ 失败不会被吞成空数组（无需真实 WSL）', async () => {
  const cfg = { distro: 'fake-distro', wslHome: '/home/x', daemonPort: 8731 };

  const failed = await scanDaemonProcessesAsync(cfg, {
    run: async () => failRun(127, 'wsl.exe: command not found'),
  });
  assert.equal(failed.ok, false, 'runner 失败 ⇒ ok:false（旧实现在这里返回裸 []）');
  assert.deepEqual(failed.procs, []);
  assert.match(failed.error, /command not found/);

  const empty = await scanDaemonProcessesAsync(cfg, { run: async () => okRun('') });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.procs, []);

  const listed = await scanDaemonProcessesAsync(cfg, { run: async () => okRun('777|8731|8731\n') });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.procs, [{ pid: 777, port: 8731, metaPort: 8731 }]);
});

test('F-50 ⑥：runner 直接抛异常（spawn 失败）也不许吞成 []，必须 ok:false + 可读 error', async () => {
  const cfg = { distro: 'fake-distro', wslHome: '/home/x', daemonPort: 8731 };
  const r = await scanDaemonProcessesAsync(cfg, {
    run: async () => {
      throw new Error('spawn wsl.exe ENOENT');
    },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.procs, []);
  assert.match(r.error, /ENOENT/);
  assert.match(r.error, /无法执行/, '要说明是「脚本没跑起来」而不是「没有进程」');
});

// ── 调用方契约（F-50 的"失败 ≠ 空"必须在**返回值**上看得见）─────────────────────────
//
// 用一个**不存在的发行版**让扫描必然失败：这是唯一能离线复现「扫描失败」的真实路径
// （libuv 在 Linux 上没有 wsl.exe ⇒ status:null；有 WSL interop 时 ⇒ status:255）。
// 它不会启动守护、也不读写用户真实状态目录（UNC 目录读不到 ⇒ 无元数据记录）。

const brokenCfg = { distro: 'no-such-distro-xyz', wslHome: '/home/none', daemonPort: 8731, daemonHandshakeTimeoutMs: 400 };

test('F-50 ⑦：daemonSnapshot 扫描失败 ⇒ scan.ok=false / orphansVerified=false（orphans 空 ≠ 没有孤儿）', async () => {
  const { daemonSnapshot } = await import('../src/daemon-lifecycle.ts');
  const snap = await daemonSnapshot(brokenCfg);
  assert.equal(snap.scan?.ok, false, '快照必须把「扫描失败」暴露出来，不许静默');
  assert.equal(snap.orphansVerified, false, 'orphans 未经核实 ⇒ 上层不许当"0 个孤儿"');
  assert.deepEqual(snap.orphans, [], '空数组只是"已知部分"，权威性由 orphansVerified 表达');
  assert.equal(typeof snap.scan?.error, 'string', '失败原因必须可读');
  assert.ok(Array.isArray(snap.live) && Array.isArray(snap.dead) && Array.isArray(snap.busy), '既有字段形状不变');
});

test('F-50 ⑧：daemonStatus 在"无元数据 + 扫描失败"时不许断言「守护未运行」', async () => {
  const { daemonStatus } = await import('../src/daemon-lifecycle.ts');
  const st = await daemonStatus(brokenCfg);
  assert.equal(st.ok, false);
  assert.equal(st.scan?.ok, false, 'status 必须透传 scan 状态');
  assert.match(String(st.error), /无法排除/, '文案要说明"无法排除孤儿"，不能只说"守护未运行"');
  assert.match(String(st.error), /不是「确认没有守护在跑」|不是.*确认没有守护/, '明确区分"没有元数据"与"确认没在跑"');
});

test('F-50 ⑨：stopAllDaemons 扫描失败 ⇒ ok:false / verified:false / remainingCount=null（不是 0）', async () => {
  const { stopAllDaemons } = await import('../src/daemon-lifecycle.ts');
  const r = await stopAllDaemons(brokenCfg, { log: () => {} });
  assert.equal(r.ok, false, '扫描失败时绝不能返回 ok:true（旧实现 = 伪成功）');
  assert.equal(r.verified, false);
  assert.equal(r.scan?.ok, false);
  assert.equal(r.remainingCount, null, '剩余数量必须是"未知"，不能被读成 0');
  assert.deepEqual(r.remaining, []);
  assert.deepEqual(r.killed, [], '扫描失败 ⇒ 一个都没杀（连有哪些都不知道）');
  assert.match(String(r.error), /无法确认/);
});

