#!/usr/bin/env node
/**
 * check-client-rev.mjs —— 机器门禁：**任何 client chunk 变了而"入口 rev"未随之变化 ⇒ 非 0 退出**。
 *
 * ── 它拦的是什么（机制来自平台源码，见 REPORT-chunk-rev.md §1） ──────────────────────
 * 平台给插件 client 半的资源版本号 `rev` 不是内容哈希，而是**入口文件 `client/index.js` 的元数据哈希**：
 *   app.asar: dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js
 *     :193-198  artifactRevision(baseline) = sha1("plugin-artifact", mtimeMs, ctimeMs, size)
 *     :610-614  const baseline = captureArtifactBaseline(record.meta.clientPath)   // 只取【入口】文件
 *     :882-884  同上（首次快照）
 *     :363-367  resources[].rev = record.entry.rev                                // 行的 rev
 *   app.asar: …/lib/client.js
 *     :725      chunkUrl(row, fileName, … ?? row.rev)                             // chunk URL 用【入口行的 rev】
 *     :480-486  chunkUrl ⇒ `/plugins/<pkg>/<fileName>?rev=<入口 rev>`
 *   app.asar: …/lib/index.js
 *     :159      IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
 *     :963-971  (id,fileName,rev) 命中才 200 并带 immutable；不命中 404
 * ⇒ **只改 chunk（不动入口）时 rev 不变 ⇒ chunk URL 一模一样 ⇒ 浏览器在 immutable 下最长一年不再取新字节**
 *   （重启宿主、换 token、新开页面都无效；`touch`/改一下 `client/index.js` 才会换 rev）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────────
 *   node check-client-rev.mjs                       # 自动选模式（git 可用则 git，否则 baseline，再否则 mtime）
 *   node check-client-rev.mjs --mode git            # 强制 git 模式
 *   node check-client-rev.mjs --mode baseline       # 便携基线模式（需先 --update 建基线）
 *   node check-client-rev.mjs --mode mtime          # 保守兜底（只看 mtime 先后）
 *   node check-client-rev.mjs --update              # 记录/刷新基线（**bump 入口之后**才该跑）
 *   node check-client-rev.mjs --json                # 机器可读输出
 *   node check-client-rev.mjs --print-rev           # 只算并打印当前入口 rev（与平台同算法）
 *   node check-client-rev.mjs --self-test           # 自测：副本里「改 chunk 不动入口 ⇒ FAIL」「改入口 ⇒ PASS」
 *   node check-client-rev.mjs --root <插件根>        # 默认 = 本脚本上溯到含 package.json 的目录
 *
 * 退出码：0 = PASS；1 = FAIL（chunk 变了但入口未 bump）；2 = 用法/环境错误；3 = 判定不可得（需 git 或基线）
 *
 * 局限（诚实写在这里，也写进 REPORT 的"未复核/局限"）：
 *   1. **无状态脚本无法单独判定**：单纯"当前文件长什么样"不足以知道"chunk 是在入口最后一次变化之后被改的"。
 *      ⇒ 必须借历史（git）或基线（--update 落的 JSON）；两者都没有时只能退化为保守的 mtime 检查。
 *   2. mtime 模式在**全新 checkout**（所有文件 mtime 几乎同时）下可能误报；基线模式/ git 模式不受此影响。
 *   3. 平台只对入口取元数据；本脚本**不做内容哈希推断 rev**（那不忠实地反映平台行为）；
 *      内容 sha256 只用于基线模式的"变了没有"判定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HASH_REVISION_LENGTH = 12; // 与平台 HASH_REVISION_LENGTH 相同
/** 与平台 `CLIENT_CHUNK` 同一条正则（index.js:169）：只认 client.<name>.js */
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(HERE, '.client-rev-baseline.json');

// ───────────────────────────── 参数 ─────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const mode = opt('--mode', 'auto');
const doUpdate = flag('--update');
const asJson = flag('--json');
const printRevOnly = flag('--print-rev');
const selfTest = flag('--self-test');
const baselinePath = opt('--baseline', DEFAULT_BASELINE);
// mtime 容差（毫秒）。默认 0 = 严格比较（入口必须**不早于**每个 chunk）。
// 放宽它只应用于"全新 checkout 下 mtime 几乎同时"的场景；放宽会同时放过"入口早于 chunk"的真缺陷。
const mtimeTolerance = Number(opt('--mtime-tolerance', '0')) || 0;

// ───────────────────────────── 工具 ─────────────────────────────
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** 与平台 `framedHash` 逐字节等价：domain + "\0" + 对每个 part 先写 `<byteLength>:` 再写 part */
const framedHash = (domain, parts) => {
  const h = createHash('sha1').update(domain).update('\0');
  for (const part of parts) h.update(`${Buffer.byteLength(part)}:`).update(part);
  return h.digest('hex').slice(0, HASH_REVISION_LENGTH);
};

/** 与平台 `artifactRevision` 等价：只吃**文件元数据**（mtimeMs / ctimeMs / size），不哈希内容 */
const artifactRevision = (baseline) =>
  framedHash('plugin-artifact', [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)]);

const statOf = (p) => {
  const s = fs.statSync(p);
  return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, size: s.size };
};

/** 找插件根：--root，或从脚本位置向上找 package.json */
const findRoot = () => {
  const explicit = opt('--root');
  if (explicit) return path.resolve(explicit);
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'client'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
};

/** 入口 = package.json 的 exports["./client"]（契约 §1.2 的权威来源），回退 client/index.js */
const resolveEntry = (root) => {
  const pkg = readJson(path.join(root, 'package.json'));
  const raw = pkg?.exports?.['./client'];
  let rel = typeof raw === 'string' ? raw : null;
  if (rel == null && raw && typeof raw === 'object') {
    for (const v of Object.values(raw)) if (typeof v === 'string') { rel = v; break; }
  }
  if (rel == null) rel = './client/index.js';
  const abs = path.resolve(root, rel);
  return { rel: path.relative(root, abs).split(path.sep).join('/'), abs, fromExports: pkg?.exports?.['./client'] != null };
};

/** chunk = 入口同目录下匹配 CLIENT_CHUNK 的文件（排除入口自身） */
const listChunks = (entryAbs) => {
  const dir = path.dirname(entryAbs);
  const names = fs.readdirSync(dir).filter((n) => CLIENT_CHUNK.test(n));
  return names.sort().map((n) => {
    const abs = path.join(dir, n);
    return { name: n, abs, sha256: sha256(fs.readFileSync(abs)), stat: statOf(abs) };
  });
};

const git = (root, args) => {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
};

// ───────────────────────────── --self-test ─────────────────────────────
if (selfTest) {
  // 在 %TEMP% 造一个**副本**插件（不碰真仓库），验证：改 chunk 不动入口 ⇒ FAIL；改入口 ⇒ PASS。
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsrw-chunkrev-selftest-'));
  const mk = () => {
    fs.rmSync(path.join(tmp, 'client'), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'client'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'fixture-plugin', version: '1.0.0', private: true,
      exports: { '.': './src/index.ts', './client': './client/index.js' },
      dsh: { client: { platform: 'web', inject: [] } }
    }, null, 2));
    fs.writeFileSync(path.join(tmp, 'client', 'index.js'), '// entry v1\nwindow.__ModuleLoader__.load({ id: "fixture-plugin", factory: () => ({ apply() {} }) });\n');
    fs.writeFileSync(path.join(tmp, 'client', 'client.panel.js'), '// panel v1\nexport const x = 1;\n');
    fs.writeFileSync(path.join(tmp, 'client', 'client.api.js'), '// api v1\nexport const y = 2;\n');
  };
  const run = (label, args) => {
    console.log(`\n### selftest: ${label}`);
    const r = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--root', tmp, ...args], { encoding: 'utf8' });
    process.stdout.write(r);
  };
  const runExpect = (label, args, expectCode) => {
    console.log(`\n### selftest: ${label}（期望 exit=${expectCode}）`);
    let code = 0, out = '';
    try { out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--root', tmp, ...args], { encoding: 'utf8' }); } catch (e) { code = e.status ?? 1; out = (e.stdout || '') + (e.stderr || ''); }
    process.stdout.write(out);
    const ok = code === expectCode;
    console.log(`---> 实得 exit=${code} ${ok ? 'OK' : '**不符**'}`);
    if (!ok) { console.log('SELFTEST FAILED'); process.exit(1); }
  };

  mk();
  const baseline = path.join(tmp, 'baseline.json');
  runExpect('① 建立基线（--mode baseline --update）', ['--mode', 'baseline', '--baseline', baseline, '--update'], 0);
  runExpect('② 未改动 ⇒ PASS（幂等）', ['--mode', 'baseline', '--baseline', baseline], 0);
  runExpect('③ 再跑一次仍未改动 ⇒ PASS（幂等第二次）', ['--mode', 'baseline', '--baseline', baseline], 0);
  // 负例：只改 chunk，不动入口
  fs.writeFileSync(path.join(tmp, 'client', 'client.panel.js'), '// panel v2 CHANGED\nexport const x = 2;\n');
  runExpect('④ 只改 chunk、不动入口 ⇒ FAIL', ['--mode', 'baseline', '--baseline', baseline], 1);
  runExpect('④b mtime 模式也抓到 ⇒ FAIL', ['--mode', 'mtime'], 1);
  // 正例：动入口（内容变化 ⇒ 元数据变化 ⇒ rev 变化）
  fs.writeFileSync(path.join(tmp, 'client', 'index.js'), '// entry v2 BUMPED\nwindow.__ModuleLoader__.load({ id: "fixture-plugin", factory: () => ({ apply() {} }) });\n');
  runExpect('⑤ 改了入口（bump）⇒ PASS', ['--mode', 'baseline', '--baseline', baseline], 0);
  runExpect('⑤b mtime 模式：入口更新晚于 chunk ⇒ PASS', ['--mode', 'mtime'], 0);
  runExpect('⑥ bump 后刷新基线', ['--mode', 'baseline', '--baseline', baseline, '--update'], 0);
  runExpect('⑦ 刷新后 ⇒ PASS', ['--mode', 'baseline', '--baseline', baseline], 0);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nSELFTEST PASSED（副本目录已清理）');
  process.exit(0);
}

// ───────────────────────────── 主流程 ─────────────────────────────
const root = findRoot();
if (!root) { console.error('找不到插件根（需含 package.json 与 client/）；用 --root 指定'); process.exit(2); }
const entry = resolveEntry(root);
if (!fs.existsSync(entry.abs)) { console.error(`入口不存在：${entry.rel}`); process.exit(2); }
const chunks = listChunks(entry.abs);
const entryStat = statOf(entry.abs);
const currentRev = artifactRevision(entryStat);

if (printRevOnly) {
  console.log(JSON.stringify({ root, entry: entry.rel, rev: currentRev, entryStat, chunks: chunks.map((c) => ({ name: c.name, sha256: c.sha256.slice(0, 16), size: c.stat.size })) }, null, 2));
  process.exit(0);
}

const result = {
  schema: 'client-rev-gate/1',
  checkedAt: new Date().toISOString(),
  root,
  entry: entry.rel,
  entryFromExports: entry.fromExports,
  rev: currentRev,
  entryStat: { mtime: new Date(entryStat.mtimeMs).toISOString(), ctime: new Date(entryStat.ctimeMs).toISOString(), size: entryStat.size },
  chunks: chunks.map((c) => ({ name: c.name, sha256: c.sha256, mtime: new Date(c.stat.mtimeMs).toISOString(), size: c.stat.size })),
  mode: null,
  verdict: null,
  reasons: [],
  evidence: {}
};

const newestChunk = chunks.reduce((a, c) => (a === null || c.stat.mtimeMs > a.stat.mtimeMs ? c : a), null);

// ── 选择模式 ──
let effectiveMode = mode;
if (mode === 'auto') {
  effectiveMode = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true' ? 'git' : (fs.existsSync(baselinePath) ? 'baseline' : 'mtime');
}
result.mode = effectiveMode;

const fail = (why, how) => {
  result.verdict = 'FAIL';
  result.reasons.push(why);
  result.evidence.how = how;
  emit();
  process.exit(1);
};
const pass = (why) => {
  result.verdict = 'PASS';
  result.reasons.push(why);
  emit();
  process.exit(0);
};

if (effectiveMode === 'git') {
  // 入口**内容**最后一次变更的提交
  const c = git(root, ['log', '-1', '--format=%H', '--', entry.rel]);
  if (c === null || c === '') { result.mode = 'mtime'; result.reasons.push('git 模式不可用（无提交/非仓库）⇒ 退化为 mtime 模式'); }
  else {
    const clientDir = path.posix.dirname(entry.rel);
    const changed = (git(root, ['diff', '--name-only', c, '--', clientDir]) || '').split('\n').filter(Boolean);
    const changedChunks = changed.filter((p) => CLIENT_CHUNK.test(path.posix.basename(p)));
    result.evidence.git = { entryLastContentCommit: c.slice(0, 12), clientDir, changedSinceEntryCommit: changed, changedChunks };
    if (changedChunks.length === 0) pass(`自入口最后一次内容变更（${c.slice(0, 12)}）以来没有任何 chunk 变化 ⇒ rev 与内容自洽`);
    // 有 chunk 变化：只要入口**元数据**比这些 chunk 都新，rev 就已经换了（URL 变 ⇒ 缓存失效）
    const newestChanged = changedChunks
      .map((p) => chunks.find((ch) => ch.name === path.posix.basename(p)))
      .filter(Boolean)
      .reduce((a, ch) => (a === null || ch.stat.mtimeMs > a.stat.mtimeMs ? ch : a), null);
    result.evidence.git.newestChangedChunk = newestChanged ? { name: newestChanged.name, mtime: new Date(newestChanged.stat.mtimeMs).toISOString() } : null;
    if (newestChanged && entryStat.mtimeMs + mtimeTolerance >= newestChanged.stat.mtimeMs) {
      pass(`chunk 有变化，但入口元数据更新（${new Date(entryStat.mtimeMs).toISOString()} > ${new Date(newestChanged.stat.mtimeMs).toISOString()}）⇒ rev 已换 ⇒ 缓存 URL 已失效`);
    }
    fail(
      `自入口最后一次内容变更（${c.slice(0, 12)}）以来有 chunk 变了，但入口未随之 bump：${changedChunks.join(', ')}`,
      'chunk URL 的 rev 取自入口元数据（mtimeMs/ctimeMs/size），入口不动 ⇒ rev 不变 ⇒ ' +
      '/plugins/<pkg>/<chunk>?rev=' + currentRev + ' 这个 URL 与旧的一模一样，而它在 immutable 下最长缓存一年 ⇒ 用户会一直拿到**旧 chunk**。'
    );
  }
}

if (effectiveMode === 'baseline') {
  // ★ 自查修正：`--update` 分支必须在"基线必须已存在"检查**之前** —— 否则首次建基线时
  //   会以 exit 3 失败（自测①就是这样抓出来的：没有基线就没法建基线）。
  if (doUpdate && !fs.existsSync(baselinePath)) {
    const first = {
      schema: 'client-rev-baseline/1',
      root: path.relative(process.cwd(), root) || '.',
      entry: entry.rel,
      rev: currentRev,
      entryStat: { mtimeMs: entryStat.mtimeMs, ctimeMs: entryStat.ctimeMs, size: entryStat.size },
      chunks: Object.fromEntries(chunks.map((c) => [c.name, c.sha256])),
      generatedAt: new Date().toISOString()
    };
    fs.writeFileSync(baselinePath, JSON.stringify(first, null, 2) + '\n');
    result.verdict = 'PASS';
    result.reasons.push(`已创建基线：${baselinePath}`);
    emit();
    process.exit(0);
  }
  if (!fs.existsSync(baselinePath)) {
    console.error(`baseline 模式需要基线文件：${baselinePath}\n先跑：node ${path.basename(fileURLToPath(import.meta.url))} --baseline 同一路径 --update`);
    process.exit(3);
  }
  const base = readJson(baselinePath);
  const baselineChunks = base.chunks || {};
  const changedChunks = chunks.filter((c) => baselineChunks[c.name] && baselineChunks[c.name] !== c.sha256).map((c) => c.name);
  const added = chunks.filter((c) => !baselineChunks[c.name]).map((c) => c.name);
  const removed = Object.keys(baselineChunks).filter((n) => !chunks.some((c) => c.name === n));
  result.evidence.baseline = { path: baselinePath, recordedRev: base.rev, recordedAt: base.generatedAt, currentRev, changedChunks, added, removed };
  if (doUpdate) {
    const payload = {
      schema: 'client-rev-baseline/1',
      root: path.relative(process.cwd(), root) || '.',
      entry: entry.rel,
      rev: currentRev,
      entryStat: { mtimeMs: entryStat.mtimeMs, ctimeMs: entryStat.ctimeMs, size: entryStat.size },
      chunks: Object.fromEntries(chunks.map((c) => [c.name, c.sha256])),
      generatedAt: new Date().toISOString()
    };
    const prev = fs.existsSync(baselinePath) ? readJson(baselinePath) : null;
    const same = prev && JSON.stringify({ ...prev, generatedAt: null }) === JSON.stringify({ ...payload, generatedAt: null });
    if (same) { result.reasons.push('基线内容未变 ⇒ 不重写（幂等）'); } else { fs.writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + '\n'); result.reasons.push(`基线已写入：${baselinePath}`); }
    result.verdict = 'PASS';
    emit();
    process.exit(0);
  }
  if (changedChunks.length === 0 && added.length === 0 && removed.length === 0) {
    pass(`基线一致（rev=${currentRev}，chunk 内容与基线逐一同哈希）`);
  }
  if (base.rev !== currentRev) {
    pass(`入口 rev 已变（基线 ${base.rev} → 现在 ${currentRev}）⇒ 缓存 URL 已失效；建议记录新基线：--update`);
  }
  fail(
    `chunk 内容变了但入口 rev 未变（仍是 ${currentRev}）：${[...changedChunks.map((n) => 'changed:' + n), ...added.map((n) => 'added:' + n), ...removed.map((n) => 'removed:' + n)].join(', ')}`,
    '入口 ' + entry.rel + ' 的元数据没动 ⇒ rev 不变 ⇒ chunk URL 不变 ⇒ 浏览器在 immutable 下继续用旧脚本。**必须**改一下入口（见下）再 --update。'
  );
}

// mtime 模式（兜底 / git 不可用）
if (effectiveMode === 'mtime') {
  result.evidence.mtime = { entryMtime: new Date(entryStat.mtimeMs).toISOString(), newestChunk: newestChunk ? { name: newestChunk.name, mtime: new Date(newestChunk.stat.mtimeMs).toISOString() } : null };
  if (!newestChunk) pass('没有任何 chunk（只有入口）⇒ 无陈旧风险');
  if (entryStat.mtimeMs + mtimeTolerance >= newestChunk.stat.mtimeMs) pass(`入口 mtime 晚于所有 chunk（${newestChunk.name}）⇒ 入口在最后一次 chunk 改动之后被 bump 过`);
  fail(
    `存在 chunk 的 mtime 晚于入口（${newestChunk.name} @ ${new Date(newestChunk.stat.mtimeMs).toISOString()} > 入口 @ ${new Date(entryStat.mtimeMs).toISOString()}）`,
    `chunk 在入口之后被改过 ⇒ 若入口元数据（rev 来源）没跟着变，浏览器会一直吃旧 chunk。` +
    `（mtime 模式是保守兜底：全新 checkout 下所有 mtime 接近，可能误报；权威判定请用 git 或 baseline 模式的基线文件。）`
  );
}

// 不应该到这儿
console.error(`未知模式：${effectiveMode}`);
process.exit(2);

function emit() {
  const how = result.evidence.how || '';
  const guidance = [
    '必须怎么做（任选其一，然后重跑本门禁）：',
    `  A) 让入口 rev 变化（推荐，可复现）：改 ${entry.rel} 的内容——最稳定的是加/改一行版本注释，例如：`,
    `       // client-rev: ${new Date().toISOString().slice(0, 10)} chunk=<改动的 chunk 名>`,
    `     （rev = sha1("plugin-artifact", mtimeMs, ctimeMs, size)，内容一变 size/mtime 就变 ⇒ rev 变 ⇒ chunk URL 变 ⇒ 缓存失效）`,
    '  B) 只动元数据也可（touch ' + entry.rel + '），但**不推荐**：clone/checkout 会重置 mtime，跨机器不可复现，别人拿到手的 rev 又可能撞回旧 URL。',
    '  C) 基线模式维护者：bump 后跑 `node check-client-rev.mjs --mode baseline --update` 记录新基线。'
  ].join('\n');
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const lines = [];
    lines.push(`client-rev 门禁：${result.verdict}（模式=${result.mode}）`);
    lines.push(`  插件根   : ${result.root}`);
    lines.push(`  入口     : ${result.entry}${result.entryFromExports ? '（来自 exports["./client"]）' : '（回退默认路径）'}`);
    lines.push(`  当前 rev : ${result.rev}   [mtime=${result.entryStat.mtime} ctime=${result.entryStat.ctime} size=${result.entryStat.size}]`);
    lines.push(`  chunks   : ${result.chunks.length} 个  ${result.chunks.map((c) => `${c.name}(${c.sha256.slice(0, 8)})`).join(' ')}`);
    lines.push(`  依据     : ${result.reasons.join('；')}`);
    if (how) { lines.push(''); lines.push(`  为什么这是缺陷：${how}`); lines.push(''); lines.push(guidance.split('\n').map((l) => '  ' + l).join('\n')); }
    console.log(lines.join('\n'));
  }
}
