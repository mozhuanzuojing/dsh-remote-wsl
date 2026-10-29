/**
 * open-editor 纯函数回归（ZCode 第三轮吸收：VS Code Remote-WSL URI + 资源管理器 UNC 候选）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVsCodeOpenArgs, buildVsCodeWslUri, buildWslUncCandidates } from '../src/open-editor.ts';

test('open-editor：VS Code WSL URI 分段编码，保留 Linux 路径结构', () => {
  assert.equal(
    buildVsCodeWslUri('Ubuntu 22.04', '/home/demo/My Repo/src/index.ts'),
    'vscode-remote://wsl+Ubuntu%2022.04/home/demo/My%20Repo/src/index.ts',
  );
});

test('open-editor：目录用 folder-uri，文件用 file-uri', () => {
  assert.deepEqual(buildVsCodeOpenArgs('directory', 'vscode-remote://wsl+Ubuntu/home/u'), ['--folder-uri', 'vscode-remote://wsl+Ubuntu/home/u']);
  assert.deepEqual(buildVsCodeOpenArgs('file', 'vscode-remote://wsl+Ubuntu/home/u/a.ts'), ['--file-uri', 'vscode-remote://wsl+Ubuntu/home/u/a.ts']);
});

test('open-editor：资源管理器候选优先 wsl.localhost、回退 wsl$', () => {
  assert.deepEqual(buildWslUncCandidates('\\\\wsl.localhost\\Ubuntu\\home\\u\\a.ts', '/home/u/a.ts'), [
    '\\\\wsl.localhost\\Ubuntu\\home\\u\\a.ts',
    '\\\\wsl$\\Ubuntu\\home\\u\\a.ts',
  ]);
});

test('open-editor：含反斜杠的 Linux 路径拒绝构造 UNC', () => {
  assert.throws(() => buildWslUncCandidates('\\\\wsl.localhost\\Ubuntu\\home\\u', '/home/u/a\\b'), /backslash/);
});
