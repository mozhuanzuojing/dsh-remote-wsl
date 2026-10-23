#!/usr/bin/env node
/**
 * probe-fs-wsl.ts —— **WSL 执行世界**的 ctx.fs provider 真机回归（2026-10-23）。
 *
 * 目标：证明 DSH 的文件操作可以**在 WSL 内**执行，而不是走 `\\wsl.localhost\…` 的 9P 共享
 * （用户报障：`write` 在 UNC 上 `GetFileSecurityW EIO`）。
 *
 * 做法：直接构造 `createWslFileSystem()`（与 preset 里挂的是同一个工厂），对它逐个方法调用；
 * 底层是 `src/fs-rpc.ts` 经 **WSL 侧守护**（真 node:fs）执行。所有落盘结果再用 `wsl.exe` 从
 * WSL 内独立复核一遍（不是同一个进程自证）。
 *
 * 判据：
 *   A 解析：Linux 路径 / UNC / 相对路径(UNC cwd) 都能解析；processPath 回 UNC；
 *   B 读写：create/update/readText/版本变化；replaceIfVersion 过期 ⇒ FS_STALE_VERSION；
 *     createIfAbsent 已存在 ⇒ FS_NOT_OBSERVED；mode 保留；
 *   C 编辑：唯一替换、非唯一拒绝、replaceAll；
 *   D 字节：二进制 readBytes 往返、readText 拒绝二进制；
 *   E 目录/链接：listDir 条目类型、symlink 的 stat(跟随)/lstat(不跟随)；
 *   F 独立复核：WSL 内 `cat`/`stat` 看到的字节与权限与 provider 报的一致；
 *   G 架构：provider 源码不 import node:fs（文件字节不经宿主盘）。
 *
 * 用法：node probe-fs-wsl.ts
 * 产物：out-fs-wsl.json；退出码 0=全过，1=有失败，2=前置失败（守护起不来）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWslFileSystem, parseUnc } from '../../../src/fs-provider.ts';
import { ensureDaemon, stopDaemon } from '../../../src/daemon-client.ts';
import { resolveVersion } from '../../../src/wsl-io.ts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DISTRO = 'debian-u8-1';
const CONFIG = {
  distro: DISTRO,
  wslHome: '/home/g',
  cwd: '/home/g',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  dshVersion: '',
  daemonPort: 8731,
  daemonPortTries: 3,
  daemonIdleMs: 1800000,
  daemonLingerMs: 600000,
  daemonQueueLimit: 4,
  daemonHandshakeTimeoutMs: 3000,
  daemonStartTimeoutMs: 20000,
  timeoutMs: 60000,
};
const ROOT = `/tmp/dsh-fs-probe-${process.pid}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  return !!ok;
};
const evidence = {};

const wsl = (script) =>
  execFileSync('wsl.exe', ['-d', DISTRO, '--exec', 'bash', '-c', script], { encoding: 'utf8', timeout: 30000, windowsHide: true }).trim();

const codeOf = async (fn) => {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (e) {
    return String(e?.code ?? e?.message ?? e);
  }
};

const version = resolveVersion(CONFIG);
if (!version.version) {
  console.error('无法确定 dsh 版本（desktop runtime.json）');
  process.exit(2);
}

// 起守护（记录是不是本探针起的；只停自己起的那个）
let ensured;
try {
  ensured = await ensureDaemon(CONFIG, { version: version.version, log: () => {} });
} catch (e) {
  console.error('ensureDaemon 抛错: ' + (e?.message ?? String(e)));
  process.exit(2);
}
evidence.daemon = { started: ensured.started === true, reused: ensured.reused === true, port: ensured.port, pid: ensured.info?.daemonPid ?? null };
if (!ensured.ok) {
  console.error('守护起不来: ' + (ensured.error ?? 'unknown'));
  process.exit(2);
}

const impl = createWslFileSystem(CONFIG);

try {
  // ── A 解析 ────────────────────────────────────────────────────────────────
  const tFile = await impl.resolve(`${ROOT}/a.txt`, { cwd: '/home/g' });
  check('A1 Linux 绝对路径解析', tFile.targetKey === `${ROOT}/a.txt`, JSON.stringify(tFile));
  const tUnc = await impl.resolve(`\\\\wsl.localhost\\${DISTRO}\\home\\g`, {});
  check('A2 UNC 反解成发行版内路径', tUnc.targetKey === '/home/g', JSON.stringify(tUnc));
  const tRel = await impl.resolve('sub/b.txt', { cwd: `\\\\wsl.localhost\\${DISTRO}${ROOT.replace(/\//g, '\\')}` });
  check('A3 相对路径 + UNC cwd', tRel.targetKey === `${ROOT}/sub/b.txt`, JSON.stringify(tRel));
  check('A4 processPath 回 UNC', impl.processPath(tFile) === `\\\\wsl.localhost\\${DISTRO}\\tmp\\dsh-fs-probe-${process.pid}\\a.txt`, impl.processPath(tFile));
  check('A5 processPathFromHostPath 只认本发行版', impl.processPathFromHostPath(`\\\\wsl.localhost\\${DISTRO}\\home\\g`) === '/home/g' && impl.processPathFromHostPath('C:\\Windows') === undefined, '');
  check('A6 parseUnc 两种前缀', parseUnc('\\\\wsl$\\debian-u8-1\\home')?.linuxPath === '/home' && parseUnc('\\\\wsl.localhost\\debian-u8-1')?.linuxPath === '/', '');

  // ── B 写 / 读 / 版本 ──────────────────────────────────────────────────────
  const mk = await impl.writeText(tFile, 'hello\n', { kind: 'createIfAbsent' });
  check('B1 createIfAbsent 新建（operation=create）', mk.operation === 'create' && typeof mk.version === 'string', JSON.stringify(mk));
  const read1 = await impl.readText(tFile);
  check('B2 readText 读到同一内容', read1 === 'hello\n', JSON.stringify(read1));
  const st1 = await impl.stat(tFile);
  check('B3 stat 版本与写回一致', st1?.version === mk.version && st1?.type === 'file' && st1?.size === 6, JSON.stringify(st1));

  const up = await impl.writeText(tFile, 'hello world\n', { kind: 'replaceIfVersion', version: mk.version });
  check('B4 replaceIfVersion 命中时更新、版本变化', up.operation === 'update' && up.version !== mk.version, JSON.stringify(up));
  check(
    'B5 过期版本 ⇒ FS_STALE_VERSION',
    (await codeOf(() => impl.writeText(tFile, 'nope\n', { kind: 'replaceIfVersion', version: mk.version }))) === 'FS_STALE_VERSION',
    '',
  );
  check(
    'B6 createIfAbsent 撞已有文件 ⇒ FS_NOT_OBSERVED',
    (await codeOf(() => impl.writeText(tFile, 'x', { kind: 'createIfAbsent' }))) === 'FS_NOT_OBSERVED',
    '',
  );
  check('B7 内容未被失败写入污染', (await impl.readText(tFile)) === 'hello world\n', '');

  // ── C 编辑 ────────────────────────────────────────────────────────────────
  await impl.writeText(tFile, 'aaa bbb aaa\n', { kind: 'replaceIfVersion', version: (await impl.stat(tFile)).version });
  const ed1 = await impl.editText(tFile, { oldString: 'bbb', newString: 'ccc', replaceAll: false });
  check('C1 唯一字面量替换', (await impl.readText(tFile)) === 'aaa ccc aaa\n' && typeof ed1.version === 'string', JSON.stringify(ed1).slice(0, 120));
  check(
    'C2 非唯一匹配且 replaceAll=false ⇒ 拒绝',
    (await codeOf(() => impl.editText(tFile, { oldString: 'aaa', newString: 'x', replaceAll: false }))) !== 'NO_ERROR',
    '',
  );
  const ed2 = await impl.editText(tFile, { oldString: 'aaa', newString: 'z', replaceAll: true });
  check('C3 replaceAll 全替换', (await impl.readText(tFile)) === 'z ccc z\n' && typeof ed2.version === 'string', '');

  // ── D 字节 / 二进制 ──────────────────────────────────────────────────────
  const bin = Buffer.from([0, 1, 2, 255, 254, 10]);
  const binTarget = await impl.resolve(`${ROOT}/bin.dat`, { cwd: '/home/g' });
  await impl.writeText(binTarget, '');
  wsl(`printf '\\x00\\x01\\x02\\xff\\xfe\\x0a' > ${ROOT}/bin.dat`);
  const bytes = await impl.readBytes(binTarget, undefined, 1024);
  check('D1 readBytes 二进制往返一致', Buffer.compare(Buffer.from(bytes), bin) === 0, `len=${bytes.length}`);
  check('D2 readText 拒绝二进制', (await codeOf(() => impl.readText(binTarget))) === 'FS_BINARY', '');

  // ── E 目录 / 符号链接 / mode ──────────────────────────────────────────────
  await impl.writeText(await impl.resolve(`${ROOT}/sub/nested.txt`, { cwd: '/home/g' }), 'nested\n');
  const listing = await impl.listDir(await impl.resolve(ROOT, { cwd: '/home/g' }));
  const names = listing.map((e) => `${e.name}:${e.type}`).sort();
  check('E1 listDir 条目与类型', names.includes('a.txt:file') && names.includes('bin.dat:file') && names.includes('sub:directory'), names.join(','));
  wsl(`ln -sf ${ROOT}/a.txt ${ROOT}/link.txt`);
  const follow = await impl.stat(await impl.resolve(`${ROOT}/link.txt`, { cwd: '/home/g' }));
  const noFollow = await impl.lstat(`${ROOT}/link.txt`, { cwd: '/home/g' });
  check('E2 stat 跟随 / lstat 不跟随', follow?.type === 'file' && noFollow?.type === 'other', `follow=${follow?.type} lstat=${noFollow?.type}`);
  wsl(`chmod 600 ${ROOT}/a.txt`);
  await impl.writeText(await impl.resolve(`${ROOT}/a.txt`, { cwd: '/home/g' }), 'mode-kept\n', { kind: 'replaceIfVersion', version: (await impl.stat(await impl.resolve(`${ROOT}/a.txt`, { cwd: '/home/g' }))).version });
  // mode 不在 FileSystem 的 stat 契约里（只有 version/type/size），所以从 WSL 内独立看
  const modeAfter = wsl(`stat -c '%a' ${ROOT}/a.txt`);
  check('E3 改写保留既有 mode(600)', modeAfter === '600', `mode=${modeAfter}`);

  // ── F 用 WSL 内命令独立复核（不是同一个进程自证）──────────────────────────
  const cat = wsl(`cat ${ROOT}/a.txt`);
  check('F1 WSL 内 cat 看到 provider 写入的字节', cat === 'mode-kept', JSON.stringify(cat).slice(0, 60));
  const statOut = wsl(`stat -c '%a:%U' ${ROOT}/a.txt`);
  check('F2 WSL 内 stat 看到 mode 与属主', statOut === '600:g' || statOut === '600:root', statOut);
  check('F3 文件在 ext4（/tmp）而非 /mnt', wsl(`stat -c '%d' ${ROOT}/a.txt`) !== wsl(`stat -c '%d' /mnt/d`), '');

  // ── S 沙箱围栏（review 发现：旧实现忽略第 5 个参数 sandboxPolicy）───────────
  const sandboxTarget = await impl.resolve(`${ROOT}/sandboxed.txt`, { cwd: '/home/g' });
  check(
    'S1 read-only 策略拒绝写入（FS_SANDBOX_DENIED）',
    (await codeOf(() => impl.writeText(sandboxTarget, 'x', null, undefined, { mode: 'read-only' }))) === 'FS_SANDBOX_DENIED',
    '',
  );
  check(
    'S2 workspace-write：工作区根内允许',
    await (async () => {
      try {
        await impl.writeText(sandboxTarget, 'ok\n', null, undefined, {
          mode: 'workspace-write',
          workspaceRoot: `\\\\wsl.localhost\\${DISTRO}${ROOT.replace(/\//g, '\\')}`,
        });
        return true;
      } catch {
        return false;
      }
    })(),
    '',
  );
  const escapeTarget = await impl.resolve('/var/tmp/dsh-fs-probe-escape.txt', { cwd: '/home/g' });
  check(
    'S3 workspace-write：工作区外拒绝（/var/tmp）',
    (await codeOf(() => impl.writeText(escapeTarget, 'x', null, undefined, { mode: 'workspace-write', workspaceRoot: '/home/g' }))) === 'FS_SANDBOX_DENIED',
    '',
  );

  // ── W 轮询观察 ────────────────────────────────────────────────────────────
  let watchFired = 0;
  const closeWatch = await impl.watch(sandboxTarget, () => {
    watchFired += 1;
  });
  await new Promise((r) => setTimeout(r, 600));
  wsl(`echo changed >> ${ROOT}/sandboxed.txt`);
  await new Promise((r) => setTimeout(r, 1400));
  closeWatch();
  check('W1 watch 在文件变化后回调（轮询近似）', watchFired >= 1, `fired=${watchFired}`);

  // ── G 架构断言：provider 不直接读宿主文件 ────────────────────────────────
  const src = fs.readFileSync(path.join(DIR, '../../../src/fs-provider.ts'), 'utf8');
  check('G1 provider 源码不 import node:fs（字节不经宿主盘）', !/from 'node:fs'/.test(src) && !/require\('node:fs'\)/.test(src), '');
  check('G2 provider 走 `{op:\'fs\'}` RPC', src.includes("rpc.call('fs'"), '');
} finally {
  // 清理 + 只停本探针起的守护
  try {
    wsl(`rm -rf ${ROOT}`);
  } catch {
    /* 清理失败不掩盖判据 */
  }
  if (evidence.daemon?.started) {
    try {
      await stopDaemon(CONFIG);
    } catch {
      /* 停不掉就留给寿命闸门 */
    }
  }
}

const failed = results.filter((r) => !r.ok);
const summary = {
  probe: 'probe-fs-wsl',
  generatedAt: new Date().toISOString(),
  target: { distro: DISTRO, root: ROOT, daemonPort: CONFIG.daemonPort },
  version: version.version,
  evidence,
  checks: results,
  passed: results.length - failed.length,
  total: results.length,
  failures: failed.map((f) => `${f.name}: ${f.detail}`),
};
fs.writeFileSync(path.join(DIR, 'out-fs-wsl.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ passed: summary.passed, total: summary.total, failures: summary.failures }, null, 2));
process.exit(failed.length ? 1 : 0);
