/**
 * fs-rpc：DSH 0.2.2 新增的 `patchText` / `deleteFile` / `moveFile` 与 CRLF 编辑语义回归。
 *
 * 这些用例直接驱动守护侧实现（`fs-rpc.handleFsOp`，纯 node:fs，不启动 WSL/守护），
 * 对齐 `@deepseek-ai/dsh-fs-local@0.2.2-rc.1` 的行为：
 *  · 编辑/补丁在 LF 规范化文本上匹配，写回恢复原行尾；
 *  · 错误码用 `FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` / `FS_PATCH_MISMATCH` / `FS_STALE_VERSION`；
 *  · moveFile 同目标 ⇒ `FS_SAME_TARGET`，源删除失败不谎报成功。
 *
 * 路径说明：`fs-rpc` 是 WSL 侧实现，`assertLinuxAbsolute()` 只接受 `/…`。Node 在 Windows 上把
 * `/tmp/x` 解析到**当前盘符**的 `\tmp\x`，所以测试把 Linux 路径 `/tmp/<name>` 映射到
 * `<cwd 盘符>:\tmp\<name>` 做真实 I/O。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { handleFsOp } from '../src/fs-rpc.ts';

let counter = 0;

async function tempDir() {
  const name = `rwsl-fsrpc-${process.pid}-${counter++}`;
  const linux = `/tmp/${name}`;
  const native = path.join(path.parse(process.cwd()).root, 'tmp', name);
  await fs.mkdir(native, { recursive: true });
  return {
    linux,
    native,
    linuxFile: (file: string) => `${linux}/${file}`,
    nativeFile: (file: string) => path.join(native, file),
    cleanup: () => fs.rm(native, { recursive: true, force: true }),
  };
}

async function statVersion(linuxPath: string): Promise<string> {
  return (await handleFsOp({ method: 'stat', args: { path: linuxPath } })).version;
}

const fsError = (code: string) => (error: any) => error?.code === code || error?.fsCode === code;

test('editText：CRLF 文件按 LF 匹配并把行尾恢复成 CRLF（0.2.2 语义）', async () => {
  const dir = await tempDir();
  try {
    const file = dir.linuxFile('a.txt');
    await fs.writeFile(dir.nativeFile('a.txt'), 'a\r\nb\r\nc\r\n', 'utf8');
    const out = await handleFsOp({ method: 'editText', args: { path: file, oldString: 'b\n', newString: 'B\n' } });
    assert.equal(out.before, 'a\nb\nc\n');
    assert.equal(out.after, 'a\nB\nc\n');
    assert.equal(await fs.readFile(dir.nativeFile('a.txt'), 'utf8'), 'a\r\nB\r\nc\r\n');
  } finally {
    await dir.cleanup();
  }
});

test('editText：错误码与 fs-local 一致（空/找不到/多处歧义）', async () => {
  const dir = await tempDir();
  try {
    const file = dir.linuxFile('b.txt');
    await fs.writeFile(dir.nativeFile('b.txt'), 'x\ny\nx\n', 'utf8');
    await assert.rejects(() => handleFsOp({ method: 'editText', args: { path: file, oldString: '', newString: 'z' } }), fsError('FS_EDIT_NOT_FOUND'));
    await assert.rejects(() => handleFsOp({ method: 'editText', args: { path: file, oldString: 'nope', newString: 'z' } }), fsError('FS_EDIT_NOT_FOUND'));
    await assert.rejects(() => handleFsOp({ method: 'editText', args: { path: file, oldString: 'x', newString: 'z' } }), fsError('FS_AMBIGUOUS_EDIT'));
    await handleFsOp({ method: 'editText', args: { path: file, oldString: 'x', newString: 'z', replaceAll: true } });
    assert.equal(await fs.readFile(dir.nativeFile('b.txt'), 'utf8'), 'z\ny\nz\n');
  } finally {
    await dir.cleanup();
  }
});

test('patchText：应用旧行替换与末尾追加，保留 CRLF', async () => {
  const dir = await tempDir();
  try {
    const file = dir.linuxFile('c.txt');
    await fs.writeFile(dir.nativeFile('c.txt'), 'one\r\ntwo\r\nthree\r\n', 'utf8');
    const version = await statVersion(file);
    const out = await handleFsOp({
      method: 'patchText',
      args: {
        path: file,
        expectedVersion: version,
        hunks: [
          { lineNumber: 2, oldLines: ['two'], newLines: ['TWO'] },
          { lineNumber: 4, oldLines: [], newLines: ['four'] },
        ],
      },
    });
    assert.equal(out.before, 'one\ntwo\nthree\n');
    assert.equal(out.after, 'one\nTWO\nthree\nfour\n');
    assert.equal(await fs.readFile(dir.nativeFile('c.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\nfour\r\n');
  } finally {
    await dir.cleanup();
  }
});

test('patchText：hunk 不匹配 ⇒ FS_PATCH_MISMATCH；版本过期 ⇒ FS_STALE_VERSION', async () => {
  const dir = await tempDir();
  try {
    const file = dir.linuxFile('d.txt');
    await fs.writeFile(dir.nativeFile('d.txt'), 'one\ntwo\n', 'utf8');
    const version = await statVersion(file);
    await assert.rejects(
      () => handleFsOp({ method: 'patchText', args: { path: file, expectedVersion: version, hunks: [{ lineNumber: 9, oldLines: ['nope'], newLines: ['x'] }] } }),
      fsError('FS_PATCH_MISMATCH'),
    );
    await assert.rejects(
      () => handleFsOp({ method: 'patchText', args: { path: file, expectedVersion: 'stale', hunks: [{ lineNumber: 1, oldLines: ['one'], newLines: ['ONE'] }] } }),
      fsError('FS_STALE_VERSION'),
    );
  } finally {
    await dir.cleanup();
  }
});

test('deleteFile：版本匹配删除并回 before；版本过期拒绝且文件仍在', async () => {
  const dir = await tempDir();
  try {
    const file = dir.linuxFile('e.txt');
    await fs.writeFile(dir.nativeFile('e.txt'), 'keep\r\nme\r\n', 'utf8');
    const version = await statVersion(file);
    await assert.rejects(() => handleFsOp({ method: 'deleteFile', args: { path: file, expectedVersion: 'stale' } }), fsError('FS_STALE_VERSION'));
    assert.equal(await fs.readFile(dir.nativeFile('e.txt'), 'utf8'), 'keep\r\nme\r\n');
    const out = await handleFsOp({ method: 'deleteFile', args: { path: file, expectedVersion: version } });
    assert.equal(out.before, 'keep\nme\n');
    await assert.rejects(() => fs.stat(dir.nativeFile('e.txt')));
  } finally {
    await dir.cleanup();
  }
});

test('deleteFile：恰好 10 MiB 的文件 diff 基线为 null（fs-local 的 >= 边界）', async () => {
  const dir = await tempDir();
  try {
    const file = dir.linuxFile('big.txt');
    const size = 10 * 1024 * 1024;
    await fs.writeFile(dir.nativeFile('big.txt'), Buffer.alloc(size, 0x61));
    const version = await statVersion(file);
    const out = await handleFsOp({ method: 'deleteFile', args: { path: file, expectedVersion: version } });
    assert.equal(out.before, null, '达到上限的文件不应再读入内存做 diff 基线');
    await assert.rejects(() => fs.stat(dir.nativeFile('big.txt')));
  } finally {
    await dir.cleanup();
  }
});

test('moveFile：基本移动保留 CRLF 与源删除；同目标拒绝', async () => {
  const dir = await tempDir();
  try {
    const source = dir.linuxFile('src.txt');
    const dest = dir.linuxFile('dst.txt');
    await fs.writeFile(dir.nativeFile('src.txt'), 'a\r\nb\r\n', 'utf8');
    const version = await statVersion(source);
    await assert.rejects(
      () => handleFsOp({ method: 'moveFile', args: { sourcePath: source, destinationPath: source, expectedSourceVersion: version } }),
      fsError('FS_SAME_TARGET'),
    );
    const out = await handleFsOp({ method: 'moveFile', args: { sourcePath: source, destinationPath: dest, expectedSourceVersion: version } });
    assert.equal(out.sourceDeleted, true);
    assert.equal(out.destination.operation, 'create');
    assert.equal(out.destination.after, 'a\nb\n');
    assert.equal(await fs.readFile(dir.nativeFile('dst.txt'), 'utf8'), 'a\r\nb\r\n');
    await assert.rejects(() => fs.stat(dir.nativeFile('src.txt')));
  } finally {
    await dir.cleanup();
  }
});

test('patchText：context / isEndOfFile / 空白归一化匹配（fs-local applyHunks 语义）', async () => {
  const dir = await tempDir();
  try {
    // context 先行匹配：只在 context 行之后找 oldLines
    const contextFile = dir.linuxFile('ctx.txt');
    await fs.writeFile(dir.nativeFile('ctx.txt'), 'a\nb\nc\n', 'utf8');
    await handleFsOp({
      method: 'patchText',
      args: {
        path: contextFile,
        expectedVersion: await statVersion(contextFile),
        hunks: [{ lineNumber: 2, context: 'b', oldLines: ['c'], newLines: ['C'] }],
      },
    });
    assert.equal(await fs.readFile(dir.nativeFile('ctx.txt'), 'utf8'), 'a\nb\nC\n');

    // isEndOfFile：只在文件末尾匹配（模拟 patch 的末尾约束）
    const eofFile = dir.linuxFile('eof.txt');
    await fs.writeFile(dir.nativeFile('eof.txt'), 'a\nb\nc\n', 'utf8');
    await handleFsOp({
      method: 'patchText',
      args: {
        path: eofFile,
        expectedVersion: await statVersion(eofFile),
        hunks: [{ lineNumber: 3, oldLines: ['c'], newLines: ['CC'], isEndOfFile: true }],
      },
    });
    assert.equal(await fs.readFile(dir.nativeFile('eof.txt'), 'utf8'), 'a\nb\nCC\n');

    // 空白归一：oldLines 两侧空白不一致仍能匹配
    const wsFile = dir.linuxFile('ws.txt');
    await fs.writeFile(dir.nativeFile('ws.txt'), 'a\n  two  \nz\n', 'utf8');
    await handleFsOp({
      method: 'patchText',
      args: {
        path: wsFile,
        expectedVersion: await statVersion(wsFile),
        hunks: [{ lineNumber: 2, oldLines: ['two'], newLines: ['TWO'] }],
      },
    });
    assert.equal(await fs.readFile(dir.nativeFile('ws.txt'), 'utf8'), 'a\nTWO\nz\n');
  } finally {
    await dir.cleanup();
  }
});

test('moveFile：带 hunks 的移动 + 改写', async () => {
  const dir = await tempDir();
  try {
    const source = dir.linuxFile('src2.txt');
    const dest = dir.linuxFile('dst2.txt');
    await fs.writeFile(dir.nativeFile('src2.txt'), 'hello\nworld\n', 'utf8');
    const version = await statVersion(source);
    const out = await handleFsOp({
      method: 'moveFile',
      args: {
        sourcePath: source,
        destinationPath: dest,
        expectedSourceVersion: version,
        hunks: [{ lineNumber: 2, oldLines: ['world'], newLines: ['WSL'] }],
      },
    });
    assert.equal(out.sourceDeleted, true);
    assert.equal(out.destination.after, 'hello\nWSL\n');
    assert.equal(await fs.readFile(dir.nativeFile('dst2.txt'), 'utf8'), 'hello\nWSL\n');
  } finally {
    await dir.cleanup();
  }
});
