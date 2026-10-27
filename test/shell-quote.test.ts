/**
 * shell-quote 回归测试（2026-10-27 审查 F-08/F-09 的守卫）。
 *
 * 为什么要有这些用例：`cwd` 与清理脚本里的 pid/文件名都来自运行时数据，一旦拼错就是
 * "注入"或"误杀无关进程"。这里用真实 bash 验证语义，而不是只断言字符串长什么样。
 *
 * 运行：`node --test test/*.test.ts`（Node ≥ 22.6 需要 `--experimental-strip-types`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdPreamble, shq } from '../src/shell-quote.ts';
import { detectUsableBash } from './support/bash-probe.ts';

const dir = mkdtempSync(join(tmpdir(), 'dsh-rw-shellq-'));
// 用能真正执行脚本的探测：`bash -c true` 在 Windows 的 WSL 存根上会"静默成功"，
// 但换成脚本文件参数就失败，于是下面的 { skip: !hasBash } 形同虚设。
const hasBash = detectUsableBash();

/** 把脚本落盘后交给 bash 跑（避免二次 shell 解析影响断言）。 */
const runBash = (script: string) => {
  const file = join(dir, 's.sh');
  writeFileSync(file, script);
  try {
    return { code: 0, out: String(execFileSync('bash', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) };
  } catch (e: any) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

test('shq：普通路径与单引号路径都只被当成一个字面量参数', { skip: !hasBash }, () => {
  assert.equal(runBash(`printf '%s' ${shq('/home/g')}`).out, '/home/g');
  assert.equal(runBash(`printf '%s' ${shq(`/tmp/a'b`)}`).out, `/tmp/a'b`);
  // 注入串必须原样输出、不被执行
  const evil = `" ; echo BREAKOUT ; : "`;
  assert.equal(runBash(`printf '%s' ${shq(evil)}`).out, evil);
});

test('cdPreamble：注入字符串被 exit 2 拦住，命令体不执行', { skip: !hasBash }, () => {
  const evil = `" ; echo BREAKOUT ; : "`;
  const r = runBash(`${cdPreamble(evil)}\necho BODY_RAN\n`);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.out, /^BREAKOUT$/m, '注入的 echo 不能被执行');
  assert.doesNotMatch(r.out, /BODY_RAN/, 'cd 失败后不得继续执行命令体');
});

test('cdPreamble：不存在的 cwd ⇒ exit 2 且不执行命令体', { skip: !hasBash }, () => {
  const r = runBash(`${cdPreamble(join(dir, 'definitely-missing'))}\necho BODY_RAN\n`);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.out, /BODY_RAN/);
});

test('cdPreamble：含空格与单引号的目录可用', { skip: !hasBash }, () => {
  const weird = join(dir, `a b'c`);
  execFileSync('mkdir', ['-p', weird]);
  const r = runBash(`${cdPreamble(weird)}\npwd -P\n`);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), weird);
});
