/**
 * 供应链校验的离线回归。
 *
 * 历史（**必须留在这里，防止再退化成伪成功**）：2026-10-27 那轮提交（3790880）与
 * `docs/2026-10-27-fix-round.md` 都声称"解析发布页的 *.sha256 / SHA256SUMS / checksums.txt，
 * 下载后校验 sha256，不匹配拒绝安装"。实际上 `asset.checksumUrl` / `asset.checksumName`
 * **全仓没有任何赋值处**，`if (asset.checksumUrl)` 恒为假 ⇒ `verified` 永远是 `'unavailable'`
 * ⇒ 每一个自动下载并执行的二进制从未被校验过。当时只有 3 条 `pickSha256` 用例，
 * 它们能全过正是因为它们只锁住了"解析校验文件"这一个**从未被调用**的函数。
 *
 * 所以本文件现在锁三件事：
 *   1. `pickSha256`（原有，保留）；
 *   2. 新增的纯函数：`parseGithubDigest` / `pickChecksumAsset`（"来源要真的能接上"）；
 *   3. 状态机 `decideVerification` / `verificationPlanOfAsset`：**没跑校验不得返回 'ok'**，
 *      官方摘要 > 发布校验文件 > 内置 pin > unavailable，且内置 pin 只对兜底资产生效。
 * 网络相关的实际下载与真实摘要比对由端到端实测覆盖（见 fix 记录/报告），这里保证"接线正确"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  pickSha256,
  parseGithubDigest,
  pickChecksumAsset,
  decideVerification,
  verificationPlanOfAsset,
  judgeSha256,
  verifySha256,
  capStreamAppend,
} from '../src/search-provision.ts';

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

// ── parseGithubDigest：API 资产 digest 是**最权威**来源，旧实现完全没读它 ──────────────

test('parseGithubDigest：sha256:<hex> 解析成小写 hex（大小写混写也归一）', () => {
  assert.deepEqual(parseGithubDigest(`sha256:${HEX}`), { algo: 'sha256', hex: HEX });
  const upper = 'ABCDEF0123456789'.repeat(4); // 64 位、全大写
  assert.deepEqual(parseGithubDigest(`sha256:${upper}`), { algo: 'sha256', hex: upper.toLowerCase() });
  // 真实值（bat v0.26.1 x86_64-linux-musl，2026-10-27 从 GitHub API 取到并实算一致）
  assert.equal(
    parseGithubDigest('sha256:0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191')?.hex,
    '0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191',
  );
});

test('parseGithubDigest：非 sha256 / 空 / 垃圾 / 长度不对 ⇒ null（不猜、不降级成"看起来像"）', () => {
  assert.equal(parseGithubDigest(null), null);
  assert.equal(parseGithubDigest(undefined), null);
  assert.equal(parseGithubDigest(''), null);
  assert.equal(parseGithubDigest('   '), null);
  assert.equal(parseGithubDigest(`sha512:${HEX}`), null); // 只认 sha256：本模块没有 sha512 实现
  assert.equal(parseGithubDigest(`md5:${'a'.repeat(32)}`), null);
  assert.equal(parseGithubDigest(HEX), null); // 没有算法前缀 ⇒ 不知道是什么，不当作 sha256
  assert.equal(parseGithubDigest(`sha256:${'a'.repeat(63)}`), null); // 少一位
  assert.equal(parseGithubDigest(`sha256:${'a'.repeat(65)}`), null); // 多一位
  assert.equal(parseGithubDigest(`sha256:${'z'.repeat(64)}`), null); // 非 hex
  assert.equal(parseGithubDigest(123), null);
});

// ── pickChecksumAsset：同批 assets 里的校验文件，宁缺勿错 ────────────────────────────

const asset = (name) => ({ name, browser_download_url: `https://example.invalid/${name}` });

test('pickChecksumAsset：优先命中与目标资产同名的 <asset>.sha256', () => {
  const assets = [
    asset('ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz'),
    asset('ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz.sha256'),
    asset('ripgrep-14.1.1-aarch64-unknown-linux-musl.tar.gz.sha256'),
  ];
  const hit = pickChecksumAsset(assets, 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz');
  assert.deepEqual(hit, {
    url: 'https://example.invalid/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz.sha256',
    name: 'ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz.sha256',
  });
});

test('pickChecksumAsset：支持 <asset>.sha256sum 与通用清单（SHA256SUMS / checksums.txt / sha256sums.txt）', () => {
  const target = 'just-1.38.0-x86_64-unknown-linux-musl.tar.gz';
  assert.equal(
    pickChecksumAsset([asset(target), asset(`${target}.sha256sum`)], target)?.name,
    `${target}.sha256sum`,
  );
  for (const listName of ['SHA256SUMS', 'SHA256SUMS.txt', 'sha256sums.txt', 'sha256sum', 'checksums.txt', 'CHECKSUMS']) {
    const hit = pickChecksumAsset([asset(target), asset(listName)], target);
    assert.equal(hit?.name, listName, `${listName} 应当被认成清单`);
  }
});

test('pickChecksumAsset：只有**别的文件**的 .sha256 ⇒ null（错配会让好资产被判 mismatch）', () => {
  const target = 'x-v1-x86_64-unknown-linux-musl.tar.gz';
  const assets = [
    asset(target),
    asset('x-v1-aarch64-unknown-linux-musl.tar.gz.sha256'), // 另一个架构
    asset('x-v1-x86_64-apple-darwin.tar.gz.sha256'), // 另一个平台
  ];
  assert.equal(pickChecksumAsset(assets, target), null);
});

test('pickChecksumAsset：没有校验资产 / 空输入 / 缺 url ⇒ null；目标名可取路径 basename', () => {
  assert.equal(pickChecksumAsset([], 'x.tar.gz'), null);
  assert.equal(pickChecksumAsset(null, 'x.tar.gz'), null);
  assert.equal(pickChecksumAsset([asset('x.tar.gz')], 'x.tar.gz'), null);
  // 有名字但没下载地址的条目不能被当成可用来源
  assert.equal(pickChecksumAsset([{ name: 'x.tar.gz.sha256' }], 'x.tar.gz'), null);
  assert.equal(pickChecksumAsset([asset('x.tar.gz.sha256')], ''), null);
  assert.equal(pickChecksumAsset([asset('x.tar.gz.sha256')], '/tmp/dl/x.tar.gz')?.name, 'x.tar.gz.sha256');
});

// ── decideVerification：唯一决策点，**没跑校验不得返回 'ok'** ─────────────────────────

test('decideVerification：优先级 = 官方 digest > 发布校验文件 > 内置 pin > unavailable', () => {
  const digest = `sha256:${HEX}`;
  const checksumFile = { url: 'https://example.invalid/SHA256SUMS', name: 'SHA256SUMS' };
  const builtin = { hex: OTHER, source: 'tofu' };

  // 三者都有 ⇒ 用最权威的官方 digest
  assert.deepEqual(
    (({ verified, digestSource }) => ({ verified, digestSource }))(decideVerification({ digest, checksumFile, builtin })),
    { verified: 'ok', digestSource: 'github-api' },
  );
  // 没有 digest ⇒ 发布校验文件
  assert.deepEqual(
    (({ verified, digestSource }) => ({ verified, digestSource }))(decideVerification({ checksumFile, builtin })),
    { verified: 'ok', digestSource: 'release-file' },
  );
  // 只有内置 pin ⇒ 'pinned'（**不是** 'ok'：没有向上游实时核对）
  assert.deepEqual(
    (({ verified, digestSource }) => ({ verified, digestSource }))(decideVerification({ builtin })),
    { verified: 'pinned', digestSource: 'builtin' },
  );
  // 什么都没有 ⇒ 'unavailable' + digestSource null，绝不 'ok'
  assert.deepEqual(
    (({ verified, digestSource }) => ({ verified, digestSource }))(decideVerification({})),
    { verified: 'unavailable', digestSource: null },
  );
});

test('decideVerification：非法/空的来源不能伪装成已验证', () => {
  const cases = [
    undefined,
    {},
    { digest: 'sha512:' + HEX },
    { digest: '' },
    { digest: 'garbage' },
    { checksumFile: { name: 'SHA256SUMS' } }, // 没有 url
    { checksumFile: null, builtin: null },
    { builtin: { hex: 'not-a-hash' } },
    { builtin: { hex: 'a'.repeat(63) } },
    { builtin: null },
  ];
  for (const input of cases) {
    const r = decideVerification(input);
    assert.equal(r.verified, 'unavailable', `输入 ${JSON.stringify(input)} 必须判 unavailable`);
    assert.equal(r.digestSource, null);
    assert.ok(r.reason && r.reason.length > 0, 'reason 必须可读（用户要能看懂为什么没校验）');
  }
});

test('decideVerification：builtin 支持裸 hex 字符串；pin 的 provenance 只作说明不改状态', () => {
  for (const builtin of [HEX, { hex: HEX }, { hex: HEX.toUpperCase() }, { hex: HEX, source: 'github-api-digest' }]) {
    const r = decideVerification({ builtin });
    assert.equal(r.verified, 'pinned');
    assert.equal(r.digestSource, 'builtin');
  }
  // 来源说明里不得出现"官方实时校验"之类的话术：pin 就是 pin
  const r = decideVerification({ builtin: { hex: HEX, source: 'github-api-digest' } });
  assert.match(r.reason, /TOFU pin/);
});

// ── verificationPlanOfAsset：内置 pin 只对**兜底资产**生效 ───────────────────────────

test('verificationPlanOfAsset：API 资产走 digest；兜底资产走内置 pin；API 资产**不得**套用内置 pin', () => {
  const pin = { hex: HEX, source: 'github-api-digest' };
  // 兜底资产：只有 builtin
  assert.equal(verificationPlanOfAsset({ fallback: true, builtin: pin }).verified, 'pinned');
  // API 资产即便带 builtin 也不采用（pin 对应的是硬编码 URL 那一个版本，字节本来就不同）
  const apiAsset = verificationPlanOfAsset({ fallback: false, builtin: pin });
  assert.equal(apiAsset.verified, 'unavailable');
  assert.equal(apiAsset.digestSource, null);
  // API 资产带 digest ⇒ ok/github-api
  const withDigest = verificationPlanOfAsset({ fallback: false, digest: `sha256:${HEX}` });
  assert.equal(withDigest.verified, 'ok');
  assert.equal(withDigest.digestSource, 'github-api');
  // API 资产带校验文件 URL ⇒ ok/release-file
  const withFile = verificationPlanOfAsset({
    fallback: false,
    checksumUrl: 'https://example.invalid/x.tar.gz.sha256',
    checksumName: 'x.tar.gz.sha256',
  });
  assert.equal(withFile.verified, 'ok');
  assert.equal(withFile.digestSource, 'release-file');
});

test('verificationPlanOfAsset：digest 优先于 checksum 文件（两者同时存在时只报一个来源）', () => {
  const r = verificationPlanOfAsset({
    digest: `sha256:${HEX}`,
    checksumUrl: 'https://example.invalid/SHA256SUMS',
    checksumName: 'SHA256SUMS',
  });
  assert.equal(r.verified, 'ok');
  assert.equal(r.digestSource, 'github-api');
});

test('verificationPlanOfAsset：兜底资产**没有**内置 pin 时如实判 unavailable（不猜、不伪造）', () => {
  const r = verificationPlanOfAsset({ fallback: true, builtin: null });
  assert.equal(r.verified, 'unavailable');
  assert.equal(r.digestSource, null);
});

// ── judgeSha256：fail-closed 的比对闸门 ────────────────────────────────────────────

test('judgeSha256：相等才通过；大小写归一；不相等/缺项/垃圾一律不通过', () => {
  assert.deepEqual(judgeSha256(HEX, HEX), { match: true });
  // 上游清单偶尔带大写 hex，归一后仍应判通过
  assert.equal(judgeSha256(HEX.toUpperCase(), HEX).match, true);
  const bad = judgeSha256(HEX, OTHER);
  assert.equal(bad.match, false);
  assert.match(bad.reason, /期望/, 'reason 要说清期望/实际，便于排障');
  // fail-closed：任何一边不是合法 sha256 都不能算通过
  for (const [e, a] of [
    [null, HEX],
    [HEX, null],
    ['', HEX],
    [HEX, ''],
    ['not-a-hash', 'not-a-hash'],
    [HEX, HEX.slice(0, 63)],
  ]) {
    assert.equal(judgeSha256(e, a).match, false, `${String(e)} vs ${String(a)} 不得判通过`);
  }
  // 关键：两边都是同样的垃圾也不能"因为它俩相等"就通过
  assert.equal(judgeSha256('deadbeef', 'deadbeef').match, false);
});

// ── verifySha256：三种来源的真实比对（不联网 GitHub，用本地 http 服务）────────────────
//
// 为什么值得写成"集成"用例而不是只测纯函数：上一轮的教训是**函数都写对了、但没人调用**
// （checksumUrl 没有赋值处）。这里让 verifySha256 走完整的 curl 取文件 → 解析 → 比 hash 的链路，
// 才能证明"来源接上之后真的会去比"。

function curlAvailable() {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 起一个只服务固定路由的本地 http 服务（零依赖，127.0.0.1 随机端口）。 */
async function withLocalServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url ?? ''];
    if (typeof body !== 'string') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withTempFile(content, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sc-'));
  try {
    const file = path.join(dir, 'tool.tar.gz');
    writeFileSync(file, content);
    // 必须 await：否则 finally 会在用例真正读文件之前就把目录删掉（ENOENT）。
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('verifySha256：release-file 来源的三种结局（匹配 / 不匹配=拒绝安装 / 文件不覆盖本资产=降级）', async (t) => {
  if (!curlAvailable()) {
    t.skip('本机没有 curl，无法跑 release-file 集成用例（显式跳过，不当通过）');
    return;
  }
  const WRONG = 'b'.repeat(64);
  await withTempFile('pretend-this-is-a-tarball', async (file) => {
    const hex = createHash('sha256').update(readFileSync(file)).digest('hex');
    await withLocalServer(
      {
        '/SHA256SUMS': `${hex}  tool.tar.gz\n${WRONG}  other.tar.gz\n`,
        '/SHA256SUMS.bad': `${WRONG}  tool.tar.gz\n`,
        '/SHA256SUMS.other': `${WRONG}  other.tar.gz\n`,
      },
      async (port) => {
        const base = `http://127.0.0.1:${port}`;
        const assetOf = (url) => ({
          name: 'tool.tar.gz',
          fallback: false,
          digest: null,
          checksumUrl: url,
          checksumName: 'SHA256SUMS',
        });

        // ① 匹配 ⇒ ok + 来源 release-file（这才是"校验真的跑了"）
        const good = await verifySha256(file, assetOf(`${base}/SHA256SUMS`), null);
        assert.equal(good.ok, true);
        assert.equal(good.source, 'release-file');
        assert.equal(good.expected, hex);
        assert.equal(good.actual, hex);

        // ② 不匹配 ⇒ 必须是"拒绝安装"那一类：ok:false 且**不是** unavailable
        const bad = await verifySha256(file, assetOf(`${base}/SHA256SUMS.bad`), null);
        assert.equal(bad.ok, false);
        assert.equal(bad.unavailable, undefined, 'mismatch 不能被降级成 unavailable');
        assert.match(bad.error, /不匹配/);
        assert.match(bad.error, /拒绝安装/);

        // ③ 校验文件里没有本资产 ⇒ 拿不到摘要，属于"降级"而不是"被篡改"
        const nocover = await verifySha256(file, assetOf(`${base}/SHA256SUMS.other`), null);
        assert.equal(nocover.ok, false);
        assert.equal(nocover.unavailable, true);
        assert.match(nocover.error, /找不到/);

        // ④ 校验文件根本下载不到（404）⇒ 同样是降级，不得伪装成 mismatch
        const down = await verifySha256(file, assetOf(`${base}/nope`), null);
        assert.equal(down.ok, false);
        assert.equal(down.unavailable, true);
      },
    );
  });
});

test('verifySha256：API digest 与内置 pin 都不联网，且 pin 不匹配即拒绝', async (t) => {
  await withTempFile('pretend-this-is-a-tarball', async (file) => {
    const hex = createHash('sha256').update(readFileSync(file)).digest('hex');

    // ① API digest：直接可用，不发起任何网络请求（curl 不可用也不影响）
    const viaApi = await verifySha256(file, { name: 'tool.tar.gz', fallback: false, digest: `sha256:${hex}` }, null);
    assert.equal(viaApi.ok, true);
    assert.equal(viaApi.source, 'github-api');

    // ② 内置 TOFU pin 命中
    const viaPin = await verifySha256(
      file,
      { name: 'tool.tar.gz', fallback: true, builtin: { hex, source: 'tofu' } },
      null,
    );
    assert.equal(viaPin.ok, true);
    assert.equal(viaPin.source, 'builtin');

    // ③ 内置 pin 不匹配 ⇒ 拒绝安装（兜底资产一样要挡）
    const pinMismatch = await verifySha256(
      file,
      { name: 'tool.tar.gz', fallback: true, builtin: { hex: 'c'.repeat(64), source: 'tofu' } },
      null,
    );
    assert.equal(pinMismatch.ok, false);
    assert.equal(pinMismatch.unavailable, undefined);
    assert.match(pinMismatch.error, /不匹配/);

    // ④ 没有任何来源 ⇒ 降级（不是 mismatch），并且必须给得出原因
    const nothing = await verifySha256(file, { name: 'tool.tar.gz', fallback: false }, null);
    assert.equal(nothing.ok, false);
    assert.equal(nothing.unavailable, true);
    assert.ok(nothing.error && nothing.error.length > 0);
  });
});

// ── capStreamAppend：F-32 同型缺陷（流层静默截断）────────────────────────────────────
//
// 为什么测这个：`runAsync` 收 stdout/stderr 的老写法是
//   `if (outBytes >= maxBytes) return;`            ← 到上限后静默丢尾
//   `if (err.length < 200) err.push(c);`           ← stderr 按"块数"限，语义混乱
//   `truncated: outBytes >= maxBytes`              ← 正好等于上限（一个字节没丢）会被误报截断
// 而 curl/tar/unzip 的失败原因几乎总在输出尾部 ⇒ 用户看到的是被切断的半句话，且无从知道被截断过。
// 这里把"是否真的丢过字节"钉死；真正的接线（把 truncated 拼进错误文本）由 verifySha256/解压路径覆盖。

const buf = (s) => Buffer.from(s, 'utf8');

test('capStreamAppend：未达上限时全部保留且不报截断', () => {
  const r1 = capStreamAppend([], 0, buf('abc'), 10);
  assert.deepEqual([r1.total, r1.dropped], [3, false]);
  const r2 = capStreamAppend(r1.chunks, r1.total, buf('defg'), 10);
  assert.deepEqual([r2.total, r2.dropped], [7, false]);
  assert.equal(Buffer.concat(r2.chunks).toString('utf8'), 'abcdefg');
});

test('capStreamAppend：**正好到达**上限但一个字节都没丢 ⇒ dropped 必须为 false（不误报截断）', () => {
  const r = capStreamAppend([], 0, buf('abcdefghij'), 10);
  assert.equal(r.total, 10);
  assert.equal(r.dropped, false, '恰好等于上限不等于截断');
});

test('capStreamAppend：超出上限 ⇒ 只留前缀、total 不超限、dropped=true', () => {
  const r = capStreamAppend([], 0, buf('abcdefghij'), 4);
  assert.equal(r.total <= 4, true);
  assert.equal(r.dropped, true);
  assert.equal(Buffer.concat(r.chunks).toString('utf8'), 'abcd');
});

test('capStreamAppend：到达上限后再来数据 ⇒ 不再增长但仍报 dropped（截断可见）', () => {
  const filled = capStreamAppend([], 0, buf('0123456789'), 10);
  assert.equal(filled.dropped, false);
  const more = capStreamAppend(filled.chunks, filled.total, buf('XYZ'), 10);
  assert.equal(more.total, 10);
  assert.equal(more.dropped, true);
  assert.equal(Buffer.concat(more.chunks).toString('utf8'), '0123456789', '已收集内容不得被改写');
  // 再来的块依旧是 dropped，且 total 恒定
  const again = capStreamAppend(more.chunks, more.total, buf('!'), 10);
  assert.equal(again.total, 10);
  assert.equal(again.dropped, true);
});

test('capStreamAppend：上限 0 ⇒ 一个字节都不收且明确报 dropped', () => {
  const r = capStreamAppend([], 0, buf('x'), 0);
  assert.equal(r.total, 0);
  assert.equal(r.dropped, true);
  assert.equal(r.chunks.length, 0);
});

test('capStreamAppend：切点落在多字节字符中间时回退到字符边界（不产生 U+FFFD）', () => {
  // "中" = E4 B8 AD（3 字节）。上限 4 ⇒ 只能留 "a" + "中"(3B)；若按字节硬切会切出半个字符。
  const r = capStreamAppend([], 0, buf('a中b'), 4);
  assert.equal(r.dropped, true);
  const text = Buffer.concat(r.chunks).toString('utf8');
  assert.equal(text, 'a中');
  assert.equal(text.includes('\uFFFD'), false, '不得解码出替换字符');
});

test('capStreamAppend：空块不影响状态；不修改入参数组（纯函数）', () => {
  const chunks = [buf('ab')];
  const r = capStreamAppend(chunks, 2, buf(''), 10);
  assert.equal(r.total, 2);
  assert.equal(r.dropped, false);
  assert.deepEqual(chunks, [buf('ab')], '入参数组不得被就地修改');
});

