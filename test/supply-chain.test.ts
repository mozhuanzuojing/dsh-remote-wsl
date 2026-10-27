/**
 * 供应链校验的离线回归（2026-10-27 换角度评审第 2 条）。
 *
 * 为什么：插件会自动下载并执行 GitHub Releases 里的二进制；旧实现把发布页的 `*.sha256`
 * 当噪音过滤掉，只验"可执行位"。这里锁住"从校验文件里挑摘要"的解析逻辑（`pickSha256`），
 * 网络相关部分（下载 + 实际哈希）由手工验证覆盖，见 fix 记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSha256 } from '../src/search-provision.ts';

const HEX = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

test('pickSha256：多行清单按 basename 匹配（含 * 标记与路径前缀）', () => {
  const text = [
    `${OTHER}  other-tool-linux-x86_64.tar.gz`,
    `${HEX} *ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz`,
    '',
  ].join('\n');
  assert.equal(pickSha256(text, 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz'), HEX);
  assert.equal(pickSha256(text, '/tmp/dl/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz'), HEX);
  assert.equal(pickSha256(text, 'other-tool-linux-x86_64.tar.gz'), OTHER);
});

test('pickSha256：单值文件取唯一 hex；没有 hex 返回 null', () => {
  assert.equal(pickSha256(`${HEX}\n`, 'anything.tar.gz'), HEX);
  assert.equal(pickSha256('no checksum here', 'x.tar.gz'), null);
  assert.equal(pickSha256('', 'x.tar.gz'), null);
});

test('pickSha256：清单格式里没有目标文件 ⇒ 返回 null（不拿别的文件摘要顶替）', () => {
  const text = `${HEX}  a.tar.gz\n${OTHER}  b.tar.gz\n`;
  assert.equal(pickSha256(text, 'c.tar.gz'), null);
  // 两个裸 hex 也没有"唯一值"可回退
  assert.equal(pickSha256(`${HEX}\n${OTHER}\n`, 'c.tar.gz'), null);
});
