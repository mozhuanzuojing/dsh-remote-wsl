import test from 'node:test';
import assert from 'node:assert/strict';
import { isGitProgram, windowsToLinuxMount, translateGitEnvValue, translateGitEnv, gitSpawnRewrite } from '../src/git-route.ts';

const UNC = '\\\\wsl.localhost\\debian-u8-1\\home\\g\\proj';

test('isGitProgram: git / 路径 / .exe，非 git 否', () => {
  assert.equal(isGitProgram('git'), true);
  assert.equal(isGitProgram('/usr/bin/git'), true);
  assert.equal(isGitProgram('C:\\Program Files\\Git\\bin\\git.exe'), true);
  assert.equal(isGitProgram('rg'), false);
  assert.equal(isGitProgram('git-lfs'), false);
  assert.equal(isGitProgram(''), false);
  assert.equal(isGitProgram(undefined), false);
});

test('windowsToLinuxMount: 盘符→/mnt，非盘符 undefined', () => {
  assert.equal(windowsToLinuxMount('D:\\proj\\x'), '/mnt/d/proj/x');
  assert.equal(windowsToLinuxMount('C:/Users/a'), '/mnt/c/Users/a');
  assert.equal(windowsToLinuxMount('/home/g'), undefined);
  assert.equal(windowsToLinuxMount('relative\\x'), undefined);
});

test('translateGitEnvValue: UNC→Linux / 盘符→/mnt / 其它原样', () => {
  assert.equal(translateGitEnvValue('\\\\wsl.localhost\\debian-u8-1\\home\\g\\x'), '/home/g/x');
  assert.equal(translateGitEnvValue('D:\\scratch'), '/mnt/d/scratch');
  assert.equal(translateGitEnvValue('0'), '0');
  assert.equal(translateGitEnvValue(undefined), undefined);
});

test('translateGitEnv: 仅 GIT_* 值翻译，其余原样，wslenv 收集全部键', () => {
  const { env, wslenv } = translateGitEnv({ GIT_INDEX_FILE: 'D:\\s\\idx', GIT_CONFIG_COUNT: '0', PATH: 'x' });
  assert.equal(env.GIT_INDEX_FILE, '/mnt/d/s/idx');
  assert.equal(env.GIT_CONFIG_COUNT, '0');
  assert.equal(env.PATH, 'x');
  assert.deepEqual(wslenv.sort(), ['GIT_CONFIG_COUNT', 'GIT_INDEX_FILE', 'PATH']);
});

test('gitSpawnRewrite: git + UNC cwd 重写为 wsl.exe，discovery/非 git/host cwd 不重写', () => {
  const rw = gitSpawnRewrite({ argv: ['C:\\git\\git.exe', 'add', '--all'], cwd: UNC, wslPath: 'wsl.exe' });
  assert.ok(rw);
  assert.equal(rw!.distro, 'debian-u8-1');
  assert.equal(rw!.linuxCwd, '/home/g/proj');
  assert.deepEqual(rw!.gitArgv, ['git', 'add', '--all']);
  assert.deepEqual(rw!.wslArgv, ['wsl.exe', '-d', 'debian-u8-1', '--cd', '/home/g/proj', '--exec', 'git', 'add', '--all']);

  // discovery 参数保持 host
  assert.equal(gitSpawnRewrite({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd: UNC, wslPath: 'wsl.exe' }), undefined);
  // 非 git
  assert.equal(gitSpawnRewrite({ argv: ['rg', 'x'], cwd: UNC, wslPath: 'wsl.exe' }), undefined);
  // host cwd
  assert.equal(gitSpawnRewrite({ argv: ['git', 'add', '--all'], cwd: 'C:\\proj', wslPath: 'wsl.exe' }), undefined);
});
