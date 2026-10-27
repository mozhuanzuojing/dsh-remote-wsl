/**
 * `listDir` 符号链接语义回归（2026-10-27 第三轮，HANDOFF 遗留项「listDir 符号链接」）。
 *
 * 为什么要这份测试：旧实现用 `lstat` ⇒ 符号链接一律报 `other`，与上游 `dsh-fs-local` 的
 * `listDirectory()` 不一致 —— 上游是「子项身份 = realpath(链接目标)」+「元数据 = stat(跟随链接)」，
 * 所以 `ln -s /etc d` 在上游是 `directory`、在本插件旧实现里是 `other`（面板显示成未知、
 * tool-fs 的按类型过滤会漏掉它）。这里对着**真实文件系统**把四条语义钉住：
 *   1. 链接到目录 ⇒ `directory`；链接到文件 ⇒ `file`（跟随链接）；
 *   2. 子项身份是**链接目标**（`targetKey` = realpath），不是链接自身；
 *   3. 悬空链接 ⇒ `other` 且**不丢条目**，身份退回链接自身；
 *   4. 普通文件/目录的身份不变，条目按名称排序。
 *
 * 平台：符号链接在 Windows 上需要管理员/开发者模式，做不到就**显式跳过**（给出原因），
 * 绝不让「跑不了」变成「静默通过」。CI（ubuntu-latest）与 WSL 里都真跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { listDirOp } from '../src/fs-rpc.ts';

/** 建一棵临时树；符号链接建不出来就返回 null（调用方显式 skip）。 */
function makeTree(): { root: string; outside: string; cleanup: () => void } | null {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-rw-listdir-')));
  const root = posix.join(base, 'root');
  const outside = posix.join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(posix.join(root, 'plain.txt'), 'hello\n');
  mkdirSync(posix.join(root, 'plainDir'));
  writeFileSync(posix.join(outside, 'target.txt'), 'outside\n');
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  try {
    symlinkSync(posix.join(root, 'plain.txt'), posix.join(root, 'link-to-file'));
    symlinkSync(posix.join(root, 'plainDir'), posix.join(root, 'link-to-dir'));
    symlinkSync(posix.join(base, 'does-not-exist'), posix.join(root, 'dangling'));
  } catch {
    cleanup();
    return null;
  }
  return { root, outside, cleanup };
}

// 注意：fs-rpc 的 listDirOp 要求**绝对 Linux 路径**。Windows 上临时目录是 `C:\…`，
// 直接传会命中 assertLinuxAbsolute 的「path must be absolute inside the distribution」。
// 所以这条测试只在 POSIX（Linux/WSL/CI）上跑；Windows 上必须显式跳过而不是假装通过。
const tree = process.platform === 'win32' ? null : makeTree();
const skipOnWindows =
  process.platform === 'win32'
    ? 'Windows 上 fs-rpc 的 Linux 绝对路径断言与符号链接权限都不成立；该路径由 WSL/CI(Linux) 覆盖'
    : tree === null
      ? '本机不允许创建符号链接（权限/文件系统限制），无法验证链接语义'
      : false;

test('listDir：符号链接跟随目标 —— 链接到目录=directory、链接到文件=file（上游语义）', { skip: skipOnWindows }, async () => {
  const r = await listDirOp({ path: tree!.root });
  const byName = new Map(r.entries.map((e: any) => [e.name, e]));
  assert.equal(byName.get('link-to-dir')?.type, 'directory', '`ln -s <dir>` 必须是 directory（旧实现错报 other）');
  assert.equal(byName.get('link-to-file')?.type, 'file', '`ln -s <file>` 必须是 file（旧实现错报 other）');
});

test('listDir：子项身份是链接目标（realpath），不是链接自身', { skip: skipOnWindows }, async () => {
  const r = await listDirOp({ path: tree!.root });
  const byName = new Map(r.entries.map((e: any) => [e.name, e]));
  assert.equal(byName.get('link-to-dir')?.targetKey, posix.join(tree!.root, 'plainDir'));
  assert.equal(byName.get('link-to-file')?.targetKey, posix.join(tree!.root, 'plain.txt'));
  // 普通条目身份就是自己（不做无意义的 realpath 改写）
  assert.equal(byName.get('plain.txt')?.targetKey, posix.join(tree!.root, 'plain.txt'));
});

test('listDir：悬空链接报 other 且不丢条目，身份退回链接自身', { skip: skipOnWindows }, async () => {
  const r = await listDirOp({ path: tree!.root });
  const dangling: any = r.entries.find((e: any) => e.name === 'dangling');
  assert.ok(dangling, '悬空链接必须仍然出现在列表里（丢条目会让用户看不到自己建的链接）');
  assert.equal(dangling.type, 'other');
  assert.equal(dangling.targetKey, posix.join(tree!.root, 'dangling'), '解析不出目标时身份必须退回链接自身');
});

test('listDir：版本令牌与 size 来自 stat（file 有 size，directory 没有），条目按名排序', { skip: skipOnWindows }, async () => {
  const r = await listDirOp({ path: tree!.root });
  const names = r.entries.map((e: any) => e.name);
  assert.deepEqual(names, [...names].sort(), '条目必须按名称稳定排序');
  const file: any = r.entries.find((e: any) => e.name === 'plain.txt');
  assert.equal(file.size, 6);
  // 版本令牌 = dev:ino:size:mtimeNs:ctimeNs（5 段）；链接到文件时令牌必须是**目标**的令牌，
  // 否则 replaceIfVersion 之类的「是否变过」判断会拿错基线。
  assert.match(file.version, /^\d+:\d+:\d+:\d+:\d+$/);
  const linkToFile: any = r.entries.find((e: any) => e.name === 'link-to-file');
  assert.equal(linkToFile.version, file.version, '链接与其目标的版本令牌必须相同（身份一致）');
  const dir: any = r.entries.find((e: any) => e.name === 'plainDir');
  assert.equal(dir.size, undefined, '目录不该报 size');
  assert.equal(typeof r.version, 'string', '目录自身也必须有版本令牌');
});

test('listDir：非目录 ⇒ 明确失败（不返回空列表冒充"空目录"）', { skip: skipOnWindows }, async () => {
  await assert.rejects(
    () => listDirOp({ path: posix.join(tree!.root, 'plain.txt') }),
    (e: any) => e?.code === 'FS_NOT_REGULAR_FILE',
    '把文件当目录列必须报错；返回空 entries 会让调用方以为目录是空的',
  );
});
