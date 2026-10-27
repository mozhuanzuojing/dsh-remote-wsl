/**
 * dsh-remote-wsl / search-provision —— **WSL 里按需/自动安装 Rust CLI 工具**。
 *
 * 用户要求（2026-10-23）：缺工具就自己装，装不上提示用户；把能用的 Rust 工具尽量都装上。
 *
 * 做法：
 *   1. 目录（{@link TOOLS}）列出仓库 + 二进制名（ripgrep、fd、ast-grep、sd、bat、tokei、difft、
 *      dust、procs、xh、hexyl、qsv、typos、taplo、just、delta、rga、hyperfine）；
 *   2. **从 GitHub Releases API 解析资产名**（不写死版本/后缀，适配各仓库命名差异），按
 *      linux/本机 arch/静态优先 选 tar.gz 或 zip；
 *   3. 下载（自动走宿主代理网关）→ 解压 → 复制到 `~/.local/bin`（**不用 sudo、不写系统目录**）；
 *   4. 失败返回可读原因 + 手动安装命令；调用方（工具/daemon）负责把提示带给用户，不静默降级。
 *
 * 2026-10-27 搜索层修复（F-12 / F-14 / F-22 / F-25）：
 *   · **探测/解析/下载全部异步**（`runAsync`：超时 + AbortSignal ⇒ SIGKILL 子进程）。旧实现用
 *     `spawnSync` + curl（最长 150s）解析资产，守护是单进程，同步等待会**卡住整个事件循环**：
 *     首次搜索要等安装，期间面板刷新和其它 RPC 一起排队。
 *   · **搜索路径不等待安装**（F-12）：{@link ensureSearchToolsNonBlocking} 只返回
 *     "就绪 / 正在安装 / 失败" 的状态快照，缺工具时把安装丢到**后台**，本次搜索立刻用搜索层
 *     自带的 GNU grep/find 兜底；装好后的下一次搜索自动用上 rg/fd。并发请求共享同一个安装
 *     Promise（in-flight 去重，F-25），不会重复下载。
 *   · **失败不永久缓存**（F-25）：成功结果缓存 10 分钟、失败只记 60 秒（过后允许重试），
 *     `force:true` 可立刻重试；失败始终通过 `tools[id].source === 'failed'` + `notes` 返回，
 *     不伪装成功。
 *   · **{@link toolPaths} 按工具 id 合并**（F-22）：旧实现取 `[...cache.values()].at(-1)`，
 *     "先装 rg、再装别的工具" 之后 rg 路径就丢了，搜索会白退回慢后端。
 *   · 兼容：`resolveAsset()` / `resolveAssetFor()` 保留**同步**签名，只服务 daemon 的
 *     `provision{ resolveOnly: true }` 诊断分支（daemon.ts 里那一行不在本模块写面内）。
 *     它内部仍是同步 curl；**搜索/安装热路径已完全不再调用它**。daemon 若把那一行改成
 *     `await resolveAssetForAsync(...)`，这两个同步入口即可整段删除。
 *
 * 2026-10-27 供应链修复（缺陷：**校验是死代码**）：
 *   · 上一轮（3790880）与 `docs/2026-10-27-fix-round.md` 声称"解析发布页 *.sha256 / SHA256SUMS /
 *     checksums.txt，下载后校验，不匹配拒绝安装"。实测是假的：`asset.checksumUrl` / `checksumName`
 *     **全仓没有赋值处**，`if (asset.checksumUrl)` 恒假 ⇒ `verified` 永远 `'unavailable'` ⇒
 *     每个自动下载并执行的二进制**从未被校验**，而文档把它写成了"已实现"。
 *   · 现在 `resolveAssetAsync()` / `resolveAsset()` 真的产出校验来源：API 资产 `digest`（`sha256:<hex>`）
 *     优先，其次同批发布里的 `<name>.sha256` / `SHA256SUMS` / `checksums.txt`（见 {@link pickChecksumAsset}）。
 *   · `FALLBACK_X86_64`（硬编码 URL、走不到 API）补上逐个**真实下载计算**的 sha256，语义是
 *     **TOFU pin**（见该表注释），状态记为 `'pinned'` 而不是 `'ok'`。
 *   · `verified` 状态机细分为 `'ok' | 'pinned' | 'unavailable' | 'mismatch'`，并一并返回 `digestSource`；
 *     `'unavailable'` 会出现在 `ensureTools` 的 notes 与 `tools[id]` 条目里（不再隐身）。
 *   · `runAsync` 的流截断不再静默（F-32 同型缺陷）：按**字节**上限收集并如实标记 `truncated`。
 *
 * 只依赖 `node:` 内置；运行在 WSL 侧守护里。
 *
 * @module dsh-remote-wsl/search-provision
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * 工具目录。`bins` 是解压后可能出现的二进制名（各仓库不同），`repo` 用于调 GitHub API。
 * @type {Array<{id:string, repo:string, bins:string[], label:string}>}
 */
export const TOOLS = [
  { id: 'rg', repo: 'BurntSushi/ripgrep', bins: ['rg'], label: 'ripgrep 文本搜索' },
  { id: 'fd', repo: 'sharkdp/fd', bins: ['fd', 'fdfind'], label: 'fd 文件名搜索' },
  { id: 'ast-grep', repo: 'ast-grep/ast-grep', bins: ['sg', 'ast-grep'], label: 'ast-grep 结构化搜索/替换' },
  { id: 'sd', repo: 'chmln/sd', bins: ['sd'], label: 'sd 查找替换' },
  { id: 'bat', repo: 'sharkdp/bat', bins: ['bat', 'batcat'], label: 'bat 语法高亮预览' },
  { id: 'tokei', repo: 'XAMPPRocky/tokei', bins: ['tokei'], label: 'tokei 代码统计' },
  { id: 'difft', repo: 'Wilfred/difftastic', bins: ['difft'], label: 'difftastic 结构化 diff' },
  { id: 'dust', repo: 'bootandy/dust', bins: ['dust'], label: 'dust 磁盘占用' },
  { id: 'procs', repo: 'dalance/procs', bins: ['procs'], label: 'procs 进程查看' },
  { id: 'xh', repo: 'ducaale/xh', bins: ['xh'], label: 'xh HTTP 客户端' },
  { id: 'hexyl', repo: 'sharkdp/hexyl', bins: ['hexyl'], label: 'hexyl 十六进制查看' },
  { id: 'qsv', repo: 'dathere/qsv', bins: ['qsv'], label: 'qsv CSV 工具' },
  { id: 'typos', repo: 'crate-ci/typos', bins: ['typos'], label: 'typos 拼写检查' },
  { id: 'taplo', repo: 'tamasfe/taplo', bins: ['taplo'], label: 'taplo TOML 格式化/校验' },
  { id: 'just', repo: 'casey/just', bins: ['just'], label: 'just 任务运行器' },
  { id: 'delta', repo: 'dandavison/delta', bins: ['delta'], label: 'delta git diff 美化' },
  { id: 'rga', repo: 'phiresky/ripgrep-all', bins: ['rga'], label: 'rga 全格式搜索（PDF/压缩包）' },
  { id: 'hyperfine', repo: 'sharkdp/hyperfine', bins: ['hyperfine'], label: 'hyperfine 基准测试' },
];

/** 守护启动时后台预热的核心集合（其余按需装）。 */
export const CORE_TOOLS = ['rg', 'fd', 'ast-grep', 'sd', 'bat', 'tokei', 'dust', 'procs'];

/**
 * API 不可用（GitHub 未认证限流 60/小时、多人共享代理 IP 时很常见）时的**固定下载地址兜底**。
 * 这些 URL 已逐个用 `curl -r 0-0` 验证过（2026-10-23）；只有 x86_64，aarch64 仍走 API。
 * 资产名不随版本变化时可直接命中；版本过旧时若 404，会回落到"给用户手动安装提示"。
 *
 * `sha256` 是 **TOFU pin（trust-on-first-use，首用即钉住）**，语义上**不等于**"官方已验证"：
 *   为什么需要：兜底 URL 是硬编码的，走不到 GitHub API 的 `digest` 字段，也不一定有
 *   `<name>.sha256` 校验资产；修这个缺陷之前（2026-10-27）这些下载**根本没有摘要可比**，
 *   于是 `verified` 恒为 `'unavailable'` —— 插件会自动下载并执行它们，却从不校验。
 *   值怎么来的：2026-10-27 对每个 tag 的发布资产**真实下载**并计算 sha256（不是抄来的、更不是编的）。
 *   交叉验证见 `pinSource`（拿不到官方值就标 `'tofu'`，不冒充官方）：
 *     - `'github-api-digest'`：与该 tag 的 API 资产 `digest` 字段逐字相等（rg/ast-grep/sd/bat/difft 之外的 5 项已核对）；
 *     - `'release-sha256-file'`：与该 tag 发布的 `<name>.sha256` 文件逐字相等（rg 已核对）；
 *     - `'tofu'`：该 tag 上游**没有**发布任何摘要，此值只有本地计算记录 —— 只保证"与本次钉住的
 *       那一份一致"，**不证明上游未被入侵/未被替换**。
 *   所以安装结果把这种情况记为 `verified:'pinned'`（不是 `'ok'`），调用方不得把它说成"官方校验通过"。
 */
const FALLBACK_X86_64 = {
  rg: {
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: '14.1.1',
    sha256: '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e',
    pinSource: 'release-sha256-file',
  },
  fd: {
    url: 'https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v10.2.0',
    sha256: 'd9bfa25ec28624545c222992e1b00673b7c9ca5eb15393c40369f10b28f9c932',
    pinSource: 'tofu',
  },
  'ast-grep': {
    url: 'https://github.com/ast-grep/ast-grep/releases/download/0.51.0/app-x86_64-unknown-linux-gnu.zip',
    kind: 'zip',
    tag: '0.51.0',
    sha256: 'a7eead5552d3a8daad70f5d50d935da44bd0c138e946b5b0a96b1d38169fa639',
    pinSource: 'github-api-digest',
  },
  sd: {
    url: 'https://github.com/chmln/sd/releases/download/v1.1.0/sd-v1.1.0-x86_64-unknown-linux-gnu.tar.gz',
    kind: 'tar.gz',
    tag: 'v1.1.0',
    sha256: '3613eca74cd686739bb5a6d68319aa56c747e7315274d02323a2ca2b1c5d82d2',
    pinSource: 'github-api-digest',
  },
  bat: {
    url: 'https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v0.26.1',
    sha256: '0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191',
    pinSource: 'github-api-digest',
  },
  tokei: {
    url: 'https://github.com/XAMPPRocky/tokei/releases/download/v12.1.2/tokei-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v12.1.2',
    sha256: '331e77046935d655dce8d97ebb943fcc7e9684586dadf3d197f3df5e760cd31b',
    pinSource: 'tofu',
  },
  dust: {
    url: 'https://github.com/bootandy/dust/releases/download/v1.1.1/dust-v1.1.1-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v1.1.1',
    sha256: '4d0e7f3e39ce85e98cc69260ab6f40e460a455cd8575af1ba70d14a2940ae553',
    pinSource: 'tofu',
  },
  procs: {
    url: 'https://github.com/dalance/procs/releases/download/v0.14.5/procs-v0.14.5-x86_64-linux.zip',
    kind: 'zip',
    tag: 'v0.14.5',
    sha256: '2c3f2b8aa03c0eaaad827a2699556590ebf20a9a3eef32f3a09c19b0248afba5',
    pinSource: 'tofu',
  },
  xh: {
    url: 'https://github.com/ducaale/xh/releases/download/v0.23.0/xh-v0.23.0-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v0.23.0',
    sha256: '79fb00506a53ae2bbc490e4690c75d488ff029e06f8e7835095d1c680103488a',
    pinSource: 'tofu',
  },
  hexyl: {
    url: 'https://github.com/sharkdp/hexyl/releases/download/v0.16.0/hexyl-v0.16.0-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v0.16.0',
    sha256: '62ae62a5e5fdd67a587e45ba19acdbe0099a6e60961ccd4db9fe2ac1f3f29528',
    pinSource: 'tofu',
  },
  difft: {
    url: 'https://github.com/Wilfred/difftastic/releases/download/0.65.0/difft-x86_64-unknown-linux-gnu.tar.gz',
    kind: 'tar.gz',
    tag: '0.65.0',
    sha256: '7196d3fb8c0c24afcc396085c42c74fcf4e4da1e63e27f5b3cfcaef4b72a844f',
    pinSource: 'github-api-digest',
  },
  rga: {
    url: 'https://github.com/phiresky/ripgrep-all/releases/download/v0.10.6/ripgrep_all-v0.10.6-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v0.10.6',
    sha256: 'aa7b201078aab21d3c53de671ab448ac5a7c1b445fcf3474c27264ceae03b3ef',
    pinSource: 'tofu',
  },
  taplo: {
    url: 'https://github.com/tamasfe/taplo/releases/download/0.9.3/taplo-linux-x86_64.gz',
    kind: 'gz',
    tag: '0.9.3',
    sha256: '889efcfa067b179fda488427d3b13ce2d679537da8b9ed8138ba415db7da2a5e',
    pinSource: 'tofu',
  },
  qsv: {
    url: 'https://github.com/dathere/qsv/releases/download/0.135.0/qsv-0.135.0-x86_64-unknown-linux-musl.zip',
    kind: 'zip',
    tag: '0.135.0',
    sha256: '147076cf85b10d1d873db9eba09ff7ca4cbb46ac566580e3ca64f0921f5a8960',
    pinSource: 'tofu',
  },
  typos: {
    url: 'https://github.com/crate-ci/typos/releases/download/v1.29.7/typos-v1.29.7-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v1.29.7',
    sha256: '27e96ea40ce90c1c81e0c761b3c3161e8b0a0184f89cc938f101e1719754e6e6',
    pinSource: 'tofu',
  },
  just: {
    url: 'https://github.com/casey/just/releases/download/1.38.0/just-1.38.0-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: '1.38.0',
    sha256: 'c803e67fd7b0af01667bd537197bc3df319938eacf9e8d51a441c71d03035bb5',
    pinSource: 'tofu',
  },
  delta: {
    url: 'https://github.com/dandavison/delta/releases/download/0.18.2/delta-0.18.2-x86_64-unknown-linux-gnu.tar.gz',
    kind: 'tar.gz',
    tag: '0.18.2',
    sha256: '99607c43238e11a77fe90a914d8c2d64961aff84b60b8186c1b5691b39955b0f',
    pinSource: 'tofu',
  },
  hyperfine: {
    url: 'https://github.com/sharkdp/hyperfine/releases/download/v1.19.0/hyperfine-v1.19.0-x86_64-unknown-linux-musl.tar.gz',
    kind: 'tar.gz',
    tag: 'v1.19.0',
    sha256: '825287143f397774093539ca2458854ab3735c0e8a1aaf075c22edce7d261556',
    pinSource: 'tofu',
  },
};

const MANUAL = {
  rg: 'sudo apt install ripgrep',
  fd: 'sudo apt install fd-find',
  'ast-grep': 'npm i -g @ast-grep/cli   # 或 cargo install ast-grep',
  sd: 'cargo install sd',
  bat: 'sudo apt install bat',
  tokei: 'cargo install tokei',
  difft: 'cargo install difftastic',
  dust: 'cargo install du-dust',
  procs: 'cargo install procs',
  xh: 'cargo install xh',
  hexyl: 'cargo install hexyl',
  qsv: 'cargo install qsv',
  typos: 'cargo install typos-cli',
  taplo: 'cargo install taplo-cli',
  just: 'cargo install just',
  delta: 'cargo install git-delta',
  rga: 'cargo install ripgrep_all',
  hyperfine: 'cargo install hyperfine',
};

/** PATH 探测（`command -v`）结果缓存时长：装完二进制后最多 10 秒就能被看见（F-22 附带项）。 */
const PATH_PROBE_TTL_MS = 10_000;
/** 全量探测成功结果的缓存时长：用户可能删掉 ~/.local/bin 里的二进制，过一会儿重新确认。 */
const RESULT_SUCCESS_TTL_MS = 10 * 60_000;
/**
 * 失败重试闸门：搜索路径每来一次请求都重打 GitHub 会立刻触发未认证限流（60/小时），
 * 所以非阻塞入口在失败后 60 秒内只报告失败、不再起新的下载；过了 TTL 自动重试。
 * （失败**不永久缓存**：旧实现把失败结果永久写进 cache，一次网络抖动就永远装不上。）
 */
const FAILURE_RETRY_TTL_MS = 60_000;
/** 一次 curl 最多收多少字节（GitHub releases/latest 的 JSON 通常几百 KB）。 */
const FETCH_MAX_BYTES = 8 * 1024 * 1024;

const execOk = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const defaultBinDir = () => path.join(os.homedir(), '.local', 'bin');

/** stderr 每条流最多收多少字节（旧实现按"块数 < 200"限，语义混乱：一块可能是 1B 也可能是 64KB）。 */
const STDERR_MAX_BYTES = 16 * 1024;

/**
 * 一条命令的结果（异步实现，见 {@link runAsync}）。**所有分支共用这一个形状**：
 * 旧实现里 `emptyRun()` 只有 `truncated:false`、`close` 分支却是 `truncated: outBytes>=maxBytes`、
 * 超时分支还只回填 stdout（stderr 直接丢了）—— 同一个函数三种形状，调用方只能瞎猜。
 */
const emptyRun = (error, timedOut = false) => ({
  code: null,
  stdout: '',
  stderr: '',
  error,
  timedOut,
  aborted: false,
  truncated: { stdout: false, stderr: false },
});

/**
 * 把一块输出追加进收集器：**不超过上限**，并如实报告这一块是否被丢弃（F-32 同型缺陷）。
 *
 * 旧写法 `if (outBytes >= maxBytes) return;` 在到达上限后**静默丢尾**：curl 的报错、tar/unzip 的
 * 失败原因几乎总在输出的最后，被无声吞掉后调用方会把"被截断的输出"当成完整结果。
 * 另外不能用 `total >= limit` 反推截断 —— 一条输出**正好**等于上限（一个字节都没丢）会被误报成
 * "已截断"，于是"结果可不可信"的判断直接失真。这里只在**真丢过字节**时置 `dropped`。
 *
 * 与 `wsl-io.ts` 的 `capAppend`（F-32 的正式修复）语义一致但**故意不复用**：本模块的契约是
 * "只依赖 node: 内置"（见文件头），import wsl-io 会顺着它牵入 daemon-client/lifecycle 一整条依赖链。
 * 两处都是十几行纯逻辑，各自单测；改名以避免与那边混淆。
 *
 * @param chunks 已收集的分片（`Buffer[]`）；不修改入参，保持纯函数
 * @param total 已收集字节数
 * @param chunk 新到的分片
 * @param limit 上限（字节）；≤0 表示一个字节都不收
 * @returns `{chunks, total, dropped}` —— `dropped` 为真表示**这一块**有字节被丢弃
 */
export function capStreamAppend(chunks, total, chunk, limit) {
  const list = Array.isArray(chunks) ? chunks : [];
  const used = Math.max(Number(total) || 0, 0);
  const cap = Math.max(Number(limit) || 0, 0);
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
  if (buf.length === 0) return { chunks: list, total: used, dropped: false };
  const room = cap - used;
  if (room <= 0) return { chunks: list, total: used, dropped: true };
  if (buf.length <= room) return { chunks: [...list, buf], total: used + buf.length, dropped: false };
  // 放不下整块 ⇒ 只留前缀；切点若落在多字节 UTF-8 字符中间，回退到字符起始字节（否则解码出 U+FFFD）
  let cut = room;
  let guard = 0;
  while (cut > 0 && guard < 3 && (buf[cut] & 0xc0) === 0x80) {
    cut -= 1;
    guard += 1;
  }
  const kept = cut > 0 ? buf.subarray(0, cut) : null;
  return { chunks: kept ? [...list, kept] : list, total: used + (kept ? kept.length : 0), dropped: true };
}

/** 收集器 → 字符串。 */
const textOf = (chunks) => Buffer.concat(chunks).toString('utf8');

/** 给错误信息带上"这条流被截断过"的标记（截断必须可见，不能静默丢尾）。 */
function withTruncMark(text, truncated) {
  return truncated ? `${text}\n[输出超过上限，尾部已截断]` : text;
}

/**
 * 异步跑一条命令（探测/解析/下载/解压）。**不能用 spawnSync**：守护是单进程，同步等待会把整个
 * 事件循环卡住——首次搜索/面板刷新会和几分钟的下载一起排队（2026-10-26 UX 复查 / F-14）。
 * 超时或 AbortSignal 取消时 SIGKILL 子进程，避免留下悬挂的 curl/tar。
 *
 * 返回形状（与 `wsl-io.runWsl` 的 F-32 修复对齐）：
 * `{code, stdout, stderr, error, timedOut, aborted, truncated:{stdout,stderr}}`
 *   · `timedOut` / `aborted` 由**我们自己的定时器/信号**置位，不靠退出码推断；
 *   · `truncated.*` 只在该流**真的丢过字节**时为真；超时/取消时也保留已经收到的 stdout+stderr，
 *     不再像旧实现那样只回填 stdout、把 stderr 整个丢掉。
 */
function runAsync(command, args, { timeoutMs = 120_000, maxBytes = 1024 * 1024, signal = null } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(emptyRun('aborted by caller'));
      return;
    }
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve(emptyRun(e?.message ?? String(e)));
      return;
    }
    let out = { chunks: [], total: 0 };
    let err = { chunks: [], total: 0 };
    let outDropped = false;
    let errDropped = false;
    let settled = false;
    let aborted = false;
    let timer = null;
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    /** 当前已收到的部分结果（超时/中断/取消都要交回去，别让关键错误信息随进程一起消失）。 */
    const partial = (extra) => ({
      code: null,
      stdout: textOf(out.chunks),
      stderr: textOf(err.chunks),
      error: null,
      timedOut: false,
      aborted,
      truncated: { stdout: outDropped, stderr: errDropped },
      ...extra,
    });
    timer = setTimeout(() => {
      kill();
      finish(partial({ timedOut: true, error: `timed out after ${timeoutMs}ms` }));
    }, timeoutMs);
    try {
      signal?.addEventListener?.('abort', onAbort, { once: true });
    } catch {
      /* ignore */
    }
    child.stdout.on('data', (c) => {
      const r = capStreamAppend(out.chunks, out.total, c, maxBytes);
      out = { chunks: r.chunks, total: r.total };
      if (r.dropped) outDropped = true;
    });
    child.stderr.on('data', (c) => {
      const r = capStreamAppend(err.chunks, err.total, c, STDERR_MAX_BYTES);
      err = { chunks: r.chunks, total: r.total };
      if (r.dropped) errDropped = true;
    });
    child.on('error', (e) => finish(emptyRun(e?.message ?? String(e))));
    child.on('close', (code) => {
      finish(partial({ code, error: aborted ? 'aborted by caller' : null }));
    });
  });
}

/**
 * 代理参数可以是字符串，也可以是**惰性取值函数**：只有真要下载时才去探活宿主代理
 * （F-30：搜索路径不必每次都做 TCP 探活；就绪时一次调用都不做）。
 */
async function resolveProxyArg(proxy) {
  if (typeof proxy === 'function') {
    try {
      const value = await proxy();
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }
  return typeof proxy === 'string' && proxy ? proxy : null;
}

const pathProbeCache = new Map(); // bin -> {path, at}

/**
 * `command -v <bin>`（带 TTL 缓存）。旧实现用 spawnSync 且缓存永不失效：装完工具后探测仍然
 * 说"没有"（F-22 附带项）。异步 + 10s TTL 让新装的二进制在短时间内可见。
 */
async function commandOf(bin, { signal = null } = {}) {
  const hit = pathProbeCache.get(bin);
  if (hit && Date.now() - hit.at < PATH_PROBE_TTL_MS) return hit.path;
  const r = await runAsync('bash', ['-c', `command -v ${JSON.stringify(bin)} 2>/dev/null`], {
    timeoutMs: 5000,
    maxBytes: 64 * 1024,
    signal,
  });
  const first = (r.stdout || '').trim().split('\n')[0] || '';
  const found = r.code === 0 && first.startsWith('/') && execOk(first) ? first : null;
  pathProbeCache.set(bin, { path: found, at: Date.now() });
  return found;
}

let archCache = null;

/** 本机架构：`uname -m`（异步；失败时退回 `process.arch`，别因为探测失败就默认 x86_64）。 */
async function archOf({ signal = null } = {}) {
  if (archCache) return archCache;
  let machine = '';
  try {
    const r = await runAsync('uname', ['-m'], { timeoutMs: 5000, maxBytes: 4096, signal });
    machine = (r.stdout || '').trim();
  } catch {
    machine = '';
  }
  if (machine === 'aarch64' || machine === 'arm64') archCache = 'aarch64';
  else if (machine) archCache = 'x86_64';
  else archCache = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return archCache;
}

/** 走 curl 取文本（GitHub API）。异步：不能阻塞守护事件循环（F-14）。 */
async function fetchText(url, proxy, { signal = null, timeoutMs = 150_000 } = {}) {
  const args = ['-sSL', '--connect-timeout', '20', '--max-time', '120', '-w', '\n%{http_code}'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = await runAsync('curl', args, { timeoutMs, maxBytes: FETCH_MAX_BYTES, signal });
  if (r.error) return { ok: false, error: `curl ${r.error}` };
  // 响应体被上限截断时 `-w '\n%{http_code}'` 的尾巴也一起丢了 ⇒ 既解析不出状态码，也解析不出完整
  // JSON/校验清单。必须当成错误上报（旧实现会继续用半截 body 去 JSON.parse，得到莫名其妙的语法错）。
  if (r.truncated?.stdout) {
    return { ok: false, error: `响应超过 ${Math.round(FETCH_MAX_BYTES / 1024 / 1024)}MB 上限被截断，无法完整解析` };
  }
  const out = r.stdout ?? '';
  const cut = out.lastIndexOf('\n');
  const code = cut >= 0 ? out.slice(cut + 1).trim() : '';
  const body = cut >= 0 ? out.slice(0, cut) : out;
  if (r.code !== 0) {
    return { ok: false, error: `curl exit ${r.code}: ${withTruncMark(String(r.stderr || '').slice(0, 200), r.truncated?.stderr)}` };
  }
  if (code !== '200') return { ok: false, error: `HTTP ${code}: ${body.slice(0, 160)}` };
  return { ok: true, text: body };
}

/** 资产打分：linux + 本机架构 + 静态优先；排除校验/包管理器产物。 */
function scoreAsset(name, arch) {
  const n = name.toLowerCase();
  if (!/linux/.test(n)) return -1;
  if (!/\.(tar\.gz|tgz|zip|gz)$/.test(n)) return -1;
  if (/(sha256|sha512|\.sig|\.txt|\.json|\.sbom|\.deb|\.rpm|\.apk)/.test(n)) return -1;
  const archTokens = arch === 'aarch64' ? ['aarch64', 'arm64'] : ['x86_64', 'amd64'];
  if (!archTokens.some((t) => n.includes(t))) return -1;
  if (arch === 'x86_64' && /(aarch64|arm64|armv7|i686|i386)/.test(n)) return -1;
  if (arch === 'aarch64' && /(x86_64|amd64|i686|i386)/.test(n)) return -1;
  let score = 0;
  if (/musl/.test(n)) score += 4;
  if (/\.tar\.gz$/.test(n)) score += 3;
  if (/\.zip$/.test(n)) score += 1;
  if (/static/.test(n)) score += 2;
  return score;
}

/** 资产名 → 解压方式（tar.gz / zip / 单文件 gz）。两个解析入口共用，避免各写一份判错。 */
function kindOfAssetName(name) {
  const n = String(name ?? '');
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  return 'gz';
}

/**
 * 解析 GitHub API 资产上的 `digest` 字段（`sha256:<hex>`）。
 *
 * 为什么单列一个纯函数：这是**最权威**的校验来源（GitHub 在服务端算好随 API 返回，不依赖仓库
 * 是否额外发布校验文件）。旧实现根本没读这个字段，导致 `asset.checksumUrl` 永远为空。
 * 只认 sha256：其它算法（sha512 等）本模块没有对应实现，宁可返回 null 由调用方降级，
 * 也不拿"不认识的算法"当校验过。
 *
 * @returns `{algo:'sha256', hex}`（hex 已小写）或 null（非 sha256 / 空 / 垃圾）
 */
export function parseGithubDigest(digest) {
  if (typeof digest !== 'string') return null;
  const m = /^\s*sha256:([0-9a-fA-F]{64})\s*$/.exec(digest);
  if (!m) return null;
  return { algo: 'sha256', hex: m[1].toLowerCase() };
}

/** 把 `'<64 hex>'` 或 `{hex}` 归一化成小写 hex；不合法返回 null（**不猜**）。 */
function normalizeSha256(value) {
  const raw = typeof value === 'string' ? value : value && typeof value === 'object' ? value.hex : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

/** 发布页上"通用清单"类校验资产的名字（大小写不敏感，允许 .txt 后缀）。 */
const CHECKSUM_LIST_ASSET_RE = /^(sha256sums|sha256sums\.txt|sha256sum|checksums|checksums\.txt)$/i;

/**
 * 从同一次 API 响应的 assets 数组里挑出**能校验目标资产**的校验文件（纯函数）。
 *
 * 命中顺序（宁缺勿错，错配会让好资产被判 mismatch）：
 *   1. 与目标资产**同名 + 后缀**：`x.tar.gz.sha256` / `x.tar.gz.sha256sum`（每资产一个，最精确）；
 *   2. 通用清单：`SHA256SUMS` / `SHA256SUMS.txt` / `sha256sums.txt` / `checksums.txt` / `sha256sum`。
 * 别的资产的 `.sha256`（如 `y.tar.gz.sha256`）**必须不命中** —— 那是另一个文件的摘要，
 * 拿它来校验只会得到"恒 mismatch"，还会掩盖上游改名。
 *
 * @param assets GitHub API 的 `assets` 数组（元素至少有 name / browser_download_url）
 * @param assetName 已选定的目标资产名（可带路径，按 basename 比）
 * @returns `{url, name}` 或 null
 */
export function pickChecksumAsset(assets, assetName) {
  const list = Array.isArray(assets) ? assets : [];
  const base = String(assetName ?? '').split('/').pop();
  if (!base) return null;
  const exact = [base + '.sha256', base + '.sha256sum'];
  for (const a of list) {
    const name = String(a?.name ?? '');
    const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
    if (url && exact.includes(name)) return { url, name };
  }
  for (const a of list) {
    const name = String(a?.name ?? '');
    const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
    if (url && CHECKSUM_LIST_ASSET_RE.test(name)) return { url, name };
  }
  return null;
}

/**
 * 校验状态机的**唯一决策点**（纯函数）：给出真实摘要来源的优先级。
 *
 * 修这个缺陷的关键契约：**"没跑校验"绝不能返回 `'ok'`**。旧实现里 verified 只有
 * `'ok' | 'unavailable' | 'mismatch'`，但 `'ok'` 的赋值分支永远进不去，于是所有下载都落在
 * `'unavailable'`；同时文档/提交信息把这件事写成了"已实现校验" —— 伪成功。
 * 现在把来源一起返回（`digestSource`），让调用方和用户都能分辨：
 *   - `'ok'`          官方摘要（API `digest` 或发布页校验文件，运行时**真正取到**的）
 *   - `'pinned'`      只有内置 TOFU 摘要（硬编码 pin）且匹配
 *   - `'unavailable'` 三样都没有 ⇒ 必然 `digestSource: null`
 *
 * 优先级：API digest > 发布校验文件 > 内置 pin。前两者是"能追到上游"的官方摘要，
 * 内置 pin 追不到本次上游，所以排在最后且只算 `'pinned'`。
 *
 * @param input.digest     API 资产 `digest` 原值（`sha256:<hex>` 或 null）
 * @param input.checksumFile 发布页校验文件 `{url, name}`（来自 {@link pickChecksumAsset}）
 * @param input.builtin   内置 pin `{hex, source?}`（`source` 仅用于说明这个值当初怎么来的）
 * @returns `{verified, digestSource, reason}`；`reason` 是给人和日志看的一句话
 */
export function decideVerification({ digest = null, checksumFile = null, builtin = null } = {}) {
  const gh = parseGithubDigest(digest);
  if (gh) {
    return {
      verified: 'ok',
      digestSource: 'github-api',
      reason: `GitHub API 资产 digest（sha256:${gh.hex.slice(0, 12)}…）`,
    };
  }
  const csName = typeof checksumFile?.name === 'string' ? checksumFile.name : '';
  const csUrl = typeof checksumFile?.url === 'string' ? checksumFile.url : '';
  if (csUrl) {
    return {
      verified: 'ok',
      digestSource: 'release-file',
      reason: `发布页校验文件 ${csName || csUrl}（sha256）`,
    };
  }
  const pin = normalizeSha256(builtin);
  if (pin) {
    // pinSource 只描述"当初这个值是怎么核对的"，**不改变**它此刻是 pins 的事实：
    // 运行时没有再向上游取一次，所以不能算 'ok'。
    const provenance =
      builtin?.source === 'github-api-digest'
        ? 'TOFU pin；钉住时与官方 API digest 逐字相等'
        : builtin?.source === 'release-sha256-file'
          ? 'TOFU pin；钉住时与官方 .sha256 文件逐字相等'
          : 'TOFU pin；上游未发布摘要，仅本机实测计算';
    return {
      verified: 'pinned',
      digestSource: 'builtin',
      reason: `内置摘要 ${pin.slice(0, 12)}…（${provenance}）`,
    };
  }
  return {
    verified: 'unavailable',
    digestSource: null,
    reason: '上游没有提供任何可用摘要（API 无 digest、发布页无校验文件、内置表无 pin）',
  };
}

/**
 * 把"一个已解析资产"交给状态机（纯函数，导出便于离线锁住"内置 pin 只对兜底资产生效"）。
 *
 * 为什么限定 `fallback === true` 才采用 `builtin`：内置摘要对应的是**硬编码 URL 的那一个版本**。
 * 若 API 路径解析出的是"最新版"，它的字节和 pin 本来就不一样，套用 pin 只会得到恒 mismatch。
 * @returns 与 {@link decideVerification} 同形
 */
export function verificationPlanOfAsset(asset) {
  const checksumUrl = typeof asset?.checksumUrl === 'string' ? asset.checksumUrl : '';
  return decideVerification({
    digest: asset?.digest ?? null,
    checksumFile: checksumUrl ? { url: checksumUrl, name: String(asset?.checksumName ?? '') } : null,
    builtin: asset?.fallback === true ? (asset?.builtin ?? null) : null,
  });
}

/** 从 GitHub API 解析一个仓库的可下载资产（异步主实现）。 */
export async function resolveAssetAsync(repo, { arch = null, proxy = null, signal = null } = {}) {
  const targetArch = arch || (await archOf({ signal }));
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetchText(api, await resolveProxyArg(proxy), { signal });
  if (!res.ok) return { ok: false, error: `GitHub API 失败（${api}）：${res.error}` };
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (e) {
    return { ok: false, error: `GitHub API 返回非 JSON：${String(e?.message ?? e).slice(0, 120)}` };
  }
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const ranked = assets
    .map((a) => ({ a, score: scoreAsset(String(a?.name ?? ''), targetArch) }))
    .filter((x) => x.score >= 0)
    .sort((x, y) => y.score - x.score);
  if (ranked.length === 0) return { ok: false, error: `没有匹配 linux/${targetArch} 的资产（共 ${assets.length} 个）` };
  const chosen = ranked[0].a;
  const name = String(chosen.name);
  // 供应链校验接线（2026-10-27 缺陷修复）：旧实现从这里直接 return，**从不**填 checksumUrl /
  // checksumName，于是 installToolById 里 `if (asset.checksumUrl)` 恒假、verified 恒 'unavailable'。
  // 现在把两种官方来源都解析出来（优先 API digest，其次同批发布里的校验文件）。
  // 注意 `digest` 原样保留（诊断用），是否压制校验文件由"能否解析成 sha256"决定：
  // 上游若给的是 sha512 之类本模块不支持的算法，仍应继续找 `*.sha256` 校验文件，别白丢一个可用来源。
  const digest = typeof chosen.digest === 'string' ? chosen.digest : null;
  const checksumAsset = parseGithubDigest(digest) ? null : pickChecksumAsset(assets, name);
  return {
    ok: true,
    name,
    url: chosen.browser_download_url,
    tag: json.tag_name ?? null,
    kind: kindOfAssetName(name),
    digest,
    checksumUrl: checksumAsset?.url ?? null,
    checksumName: checksumAsset?.name ?? null,
  };
}

/**
 * 解析一个工具的资产（异步主实现）：先 GitHub API，失败（限流/网络/无资产）用固定兜底地址。
 * @returns 与 {@link resolveAssetAsync} 同形，另带 `fallback:boolean`
 */
export async function resolveAssetForAsync(id, { proxy = null, signal = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}`, fallback: false };
  const proxyUrl = await resolveProxyArg(proxy);
  const api = await resolveAssetAsync(spec.repo, { proxy: proxyUrl, signal });
  if (api.ok) return { ...api, fallback: false };
  const arch = archCache || (await archOf({ signal }));
  const fb = arch === 'x86_64' ? FALLBACK_X86_64[id] : null;
  if (fb) {
    const name = fb.url.split('/').pop();
    // 兜底资产是硬编码 URL ⇒ 拿不到 API digest，只能靠表里的 TOFU pin（见 FALLBACK_X86_64 注释）。
    // 没有 pin（未来新增工具忘填）时显式给 null，由状态机如实判 'unavailable'，不猜。
    return {
      ok: true,
      name,
      url: fb.url,
      tag: fb.tag,
      kind: fb.kind,
      fallback: true,
      apiError: api.error,
      digest: null,
      checksumUrl: null,
      checksumName: null,
      builtin: fb.sha256 ? { hex: fb.sha256, source: fb.pinSource ?? null } : null,
    };
  }
  return { ...api, fallback: false };
}

/** 同步入口（deprecated）：只给 daemon 的 `provision{resolveOnly:true}` 诊断分支用。 */
function fetchTextSync(url, proxy, { timeoutMs = 150_000 } = {}) {
  const args = ['-sSL', '--connect-timeout', '20', '--max-time', '120', '-w', '\n%{http_code}'];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: FETCH_MAX_BYTES });
  const out = r.stdout ?? '';
  const cut = out.lastIndexOf('\n');
  const code = cut >= 0 ? out.slice(cut + 1).trim() : '';
  const body = cut >= 0 ? out.slice(0, cut) : out;
  if (r.error) return { ok: false, error: `curl ${r.error.message ?? String(r.error)}` };
  if (r.status !== 0) return { ok: false, error: `curl exit ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
  if (code !== '200') return { ok: false, error: `HTTP ${code}: ${body.slice(0, 160)}` };
  return { ok: true, text: body };
}

function archOfSync() {
  if (archCache) return archCache;
  try {
    const r = spawnSync('uname', ['-m'], { encoding: 'utf8', timeout: 5000 });
    const machine = (r.stdout || '').trim();
    if (machine === 'aarch64' || machine === 'arm64') archCache = 'aarch64';
    else if (machine) archCache = 'x86_64';
  } catch {
    /* 走下面的默认值 */
  }
  if (!archCache) archCache = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return archCache;
}

/** 同步版资产解析（deprecated，见文件头）。 */
export function resolveAsset(repo, { arch = archOfSync(), proxy = null } = {}) {
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = fetchTextSync(api, proxy);
  if (!res.ok) return { ok: false, error: `GitHub API 失败（${api}）：${res.error}` };
  let json;
  try {
    json = JSON.parse(res.text);
  } catch (e) {
    return { ok: false, error: `GitHub API 返回非 JSON：${String(e?.message ?? e).slice(0, 120)}` };
  }
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const ranked = assets
    .map((a) => ({ a, score: scoreAsset(String(a?.name ?? ''), arch) }))
    .filter((x) => x.score >= 0)
    .sort((x, y) => y.score - x.score);
  if (ranked.length === 0) return { ok: false, error: `没有匹配 linux/${arch} 的资产（共 ${assets.length} 个）` };
  const chosen = ranked[0].a;
  const name = String(chosen.name);
  // 与异步版保持一致（daemon 的 `provision{resolveOnly:true}` 诊断分支会展示这两个字段，
  // 看不到来源就没法判断"这台机器上的安装会不会被校验"）。
  const digest = typeof chosen.digest === 'string' ? chosen.digest : null;
  const checksumAsset = parseGithubDigest(digest) ? null : pickChecksumAsset(assets, name);
  return {
    ok: true,
    name,
    url: chosen.browser_download_url,
    tag: json.tag_name ?? null,
    kind: kindOfAssetName(name),
    digest,
    checksumUrl: checksumAsset?.url ?? null,
    checksumName: checksumAsset?.name ?? null,
  };
}

/** 同步版 `resolveAssetFor`（deprecated，只给 daemon resolveOnly 诊断分支；见文件头）。 */
export function resolveAssetFor(id, { proxy = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}` };
  const api = resolveAsset(spec.repo, { proxy });
  if (api.ok) return { ...api, fallback: false };
  const arch = archOfSync();
  const fb = arch === 'x86_64' ? FALLBACK_X86_64[id] : null;
  if (fb) {
    const name = fb.url.split('/').pop();
    // 同异步版的兜底分支：带出 TOFU pin，否则诊断分支会以为"这个兜底没摘要可校验"。
    return {
      ok: true,
      name,
      url: fb.url,
      tag: fb.tag,
      kind: fb.kind,
      fallback: true,
      apiError: api.error,
      digest: null,
      checksumUrl: null,
      checksumName: null,
      builtin: fb.sha256 ? { hex: fb.sha256, source: fb.pinSource ?? null } : null,
    };
  }
  return { ...api, fallback: false };
}

/** 已确认可用的工具路径（按 id 合并，F-22）：Path 探测/安装目录/后台安装成功都记这里。 */
const known = new Map(); // id -> {path, source, version, at}
/** 失败记录（带 TTL，F-25）：{error, at}；过期后允许重试。 */
const failures = new Map();
/** 正在跑的安装（in-flight 去重，F-25）：key = `${id}|${dir}`。 */
const installInFlight = new Map();
/** ensureTools 的结果缓存：key -> {result, at, complete}。 */
const resultCache = new Map();

function recordKnown(id, entry) {
  if (!entry?.path) return;
  // verified / digestSource 必须一起留下来：它们是"这个二进制到底校验过没有"的唯一凭据，
  // 只放安装返回值里会随调用结束丢掉（verificationSummary/toolPaths 之后就说不清了）。
  // PATH/已装目录命中（locateTool）本身不做校验，不能把已验证的结论覆盖成 null；但**路径变了**
  // 就是另一个文件了，旧结论不再成立 —— 只在"同一条路径"上沿用上一次的结论。
  const prev = known.get(id);
  const sameFile = prev && prev.path === entry.path;
  known.set(id, {
    path: entry.path,
    source: entry.source ?? 'unknown',
    version: entry.version ?? null,
    verified: entry.verified ?? (sameFile ? (prev.verified ?? null) : null),
    digestSource: entry.digestSource ?? (sameFile ? (prev.digestSource ?? null) : null),
    at: Date.now(),
  });
}

function recordKnownFromResult(result) {
  for (const [id, t] of Object.entries(result?.tools ?? {})) {
    if (t?.path) recordKnown(id, t);
  }
}

function failureOf(id) {
  const f = failures.get(id);
  if (!f) return null;
  if (Date.now() - f.at > FAILURE_RETRY_TTL_MS) {
    failures.delete(id);
    return null;
  }
  return f;
}

const isInstalling = (id, installDir) => installInFlight.has(`${id}|${installDir || defaultBinDir()}`);

/**
 * 定位一个工具（不安装）：已确认的 known 快路径 → PATH（带 TTL 缓存）→ 安装目录。
 * @returns `{path, source, version?}`；没找到时 `path:null, source:'missing'|'unknown'`
 */
async function locateTool(id, { installDir, ignorePath = false, signal = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { path: null, source: 'unknown' };
  const cached = known.get(id);
  if (cached?.path) {
    if (execOk(cached.path)) return { path: cached.path, source: cached.source, version: cached.version };
    known.delete(id); // 二进制被删/不可执行 ⇒ 别把死路径继续注入搜索后端
  }
  if (!ignorePath) {
    for (const bin of spec.bins) {
      const p = await commandOf(bin, { signal });
      if (p) {
        const entry = { path: p, source: 'path' };
        recordKnown(id, entry);
        return entry;
      }
    }
  }
  const dir = installDir || defaultBinDir();
  for (const bin of spec.bins) {
    const p = path.join(dir, bin);
    if (execOk(p)) {
      const entry = { path: p, source: 'installed-dir' };
      recordKnown(id, entry);
      return entry;
    }
  }
  return { path: null, source: 'missing' };
}

/** 起一次安装（in-flight 去重由 {@link installToolById} 保证：并发搜索只发一次下载）。 */
function startInstall(id, { installDir, proxy = null, signal = null } = {}) {
  const dir = installDir || defaultBinDir();
  const running = installInFlight.get(`${id}|${dir}`);
  if (running) return running;
  return installToolById(id, { installDir: dir, proxy, signal });
}

/**
 * 装一个工具到 installDir（默认 `~/.local/bin`）。
 * 下载/解析/解压全异步；同一 (id, dir) 的并发调用共享一个 Promise（不会重复下载）。
 *
 * 返回值里的供应链字段（**必须区分开，不许把没校验说成已验证**）：
 *   · `verified`: `'ok'`（官方摘要匹配）| `'pinned'`（仅内置 TOFU pin 匹配）
 *               | `'unavailable'`（没有任何可用摘要 ⇒ 本次下载没被校验）| `'mismatch'`（拒绝安装）
 *               | `null`（安装目录里已有二进制，本次压根没下载）
 *   · `digestSource`: `'github-api' | 'release-file' | 'builtin' | null`（与实际比对过的那个摘要同源）
 *   · `verifyNote`: 给用户看的一句话说明（'unavailable'/'pinned' 时非空，'ok' 时为 null）
 * @returns `{ok, path, version, asset, fallback?, verified, digestSource, verifyNote?, error?}`
 */
export async function installToolById(id, { installDir, proxy = null, signal = null } = {}) {
  const spec = TOOLS.find((t) => t.id === id);
  if (!spec) return { ok: false, error: `unknown tool: ${id}` };
  const dir = installDir || defaultBinDir();
  const existing = spec.bins.map((b) => path.join(dir, b)).find((p) => execOk(p));
  if (existing) {
    recordKnown(id, { path: existing, source: 'installed-dir' });
    // 已经躺在安装目录里的二进制：本次没有下载、也就没有校验，`verified` 必须是 null 而不是任何
    // "看起来验过"的值（同一文件的既往结论由 recordKnown 按同路径沿用）。
    return { ok: true, path: existing, asset: 'cached', source: 'installed-dir', verified: null, digestSource: null };
  }
  const key = `${id}|${dir}`;
  const running = installInFlight.get(key);
  if (running) return running;
  const task = (async () => {
    let tmp = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const proxyUrl = await resolveProxyArg(proxy);
      const asset = await resolveAssetForAsync(id, { proxy: proxyUrl, signal });
      if (!asset.ok) {
        failures.set(id, { error: asset.error, at: Date.now() });
        return { ok: false, error: asset.error, fallback: false };
      }
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-rwsl-${id}-`));
      const file = path.join(tmp, asset.name);
      const dl = await download(asset.url, file, proxyUrl, signal);
      if (!dl.ok) {
        const error = `下载 ${asset.name} 失败：${dl.error}`;
        failures.set(id, { error, at: Date.now() });
        return { ok: false, error, fallback: !!asset.fallback };
      }
      // 供应链校验（2026-10-27 缺陷修复）：这里过去是 `if (asset.checksumUrl)` + `verified='ok'`，
      // 但 checksumUrl 从来没有赋值处 ⇒ 恒假 ⇒ 每个自动下载并执行的二进制从未被校验，而且
      // 提交信息/文档还声称"已实现校验"（伪成功）。现在：
      //   · verificationPlanOfAsset 给出**来源优先级**（官方 digest > 发布校验文件 > 内置 TOFU pin）；
      //   · 每个来源都真的去取摘要并比对；取不到摘要（下载/解析失败）**不算通过**——降级为
      //     'unavailable' 并写进返回值和 note，绝不静默当成已验证；
      //   · 摘要不匹配 ⇒ 拒绝安装（保持原有安全语义）。
      const plan = verificationPlanOfAsset(asset);
      let verified = 'unavailable';
      let digestSource = null;
      let verifyNote = null;
      if (plan.verified === 'unavailable') {
        verifyNote = `未校验 ${id}：${plan.reason}`;
      } else {
        const cs = await verifySha256(file, asset, proxyUrl, signal);
        if (!cs.ok) {
          if (cs.unavailable === true) {
            // 有来源但**取不到摘要**（限流/网络/文件里没有该资产的条目）：如实降级，仍然安装，
            // 但状态必须是 'unavailable' 且 notes 可见 —— 这是"降级但不撒谎"。
            verified = 'unavailable';
            verifyNote = `未校验 ${id}：${cs.error}`;
          } else {
            const error = `校验 ${asset.name} 失败：${cs.error}`;
            failures.set(id, { error, at: Date.now() });
            return { ok: false, error, fallback: !!asset.fallback, verified: 'mismatch', digestSource: plan.digestSource };
          }
        } else {
          verified = plan.verified;
          digestSource = plan.digestSource;
          verifyNote =
            verified === 'pinned'
              ? `${id} 使用内置摘要校验通过（TOFU pin，不是官方实时校验）：${plan.reason}`
              : null;
        }
      }
      const extracted = path.join(tmp, 'x');
      const ex = await extract(file, asset.kind, extracted, signal);
      if (!ex.ok) {
        const error = `解压 ${asset.name} 失败：${ex.error}`;
        failures.set(id, { error, at: Date.now() });
        return { ok: false, error, fallback: !!asset.fallback };
      }
      // 单文件 `.gz` 资产（如 taplo-linux-x86_64.gz）解压出来叫 payload，没有目录结构，
      // 直接按工具名落盘；tar.gz/zip 才去包里找匹配的二进制名。
      const payload = path.join(extracted, 'payload');
      const found = asset.kind === 'gz' && fs.existsSync(payload) ? payload : findBinary(extracted, spec.bins);
      if (!found) {
        const error = `${asset.name} 里找不到 ${spec.bins.join('/')}`;
        failures.set(id, { error, at: Date.now() });
        return { ok: false, error, fallback: !!asset.fallback };
      }
      const target = path.join(dir, asset.kind === 'gz' ? spec.bins[0] : path.basename(found));
      fs.copyFileSync(found, target);
      fs.chmodSync(target, 0o755);
      const entry = { path: target, source: 'installed', version: asset.tag ?? null, verified };
      recordKnown(id, entry);
      failures.delete(id);
      // 校验结论必须跟着安装结果一起回家（不只在返回值深处）：ensureToolReady 会把它拼进 note。
      known.set(id, { ...known.get(id), verifyNote, digestSource });
      return {
        ok: true,
        path: target,
        version: asset.tag ?? null,
        asset: asset.name,
        source: 'installed',
        fallback: !!asset.fallback,
        apiError: asset.apiError,
        // 'ok' = 官方摘要匹配；'pinned' = 仅内置 TOFU pin 匹配；'unavailable' = 根本没摘要（已知风险，可见）
        verified,
        digestSource,
        verifyNote,
      };
    } catch (e) {
      const error = e?.message ?? String(e);
      failures.set(id, { error, at: Date.now() });
      return { ok: false, error, fallback: false };
    } finally {
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  })();
  installInFlight.set(key, task);
  const settle = () => {
    if (installInFlight.get(key) === task) installInFlight.delete(key);
  };
  task.then(settle, settle);
  return task;
}

async function download(url, outFile, proxy, signal = null) {
  const args = ['-fsSL', '--connect-timeout', '20', '--max-time', '300', '--retry', '3', '--retry-delay', '2', '--retry-all-errors', '-o', outFile];
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const r = await runAsync('curl', args, { timeoutMs: 320_000, maxBytes: 64 * 1024, signal });
  if (r.error) return { ok: false, error: r.error };
  if (r.code === 0) return { ok: true };
  // curl 的失败原因几乎总在 stderr 尾部：截断时必须标出来，否则用户看到的是被切断的半句
  return { ok: false, error: `curl exit ${r.code}: ${withTruncMark(String(r.stderr || '').slice(0, 200), r.truncated?.stderr)}` };
}

/**
 * 从校验文件正文里挑出指定文件的 sha256（纯函数，便于离线单测）。
 * 支持两种发布形态：`<hex>  <name>` 多行清单，以及只有单个 hex 的文件。
 * @param text 校验文件正文
 * @param fileName 目标资产文件名（可带路径，按 basename 比）
 * @returns 小写 hex，或 null（找不到）
 */
export function pickSha256(text, fileName) {
  const base = String(fileName ?? '').split('/').pop();
  const body = String(text ?? '');
  let sawNamed = false;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!m) continue;
    sawNamed = true;
    const name = m[2].split('/').pop();
    if (name === base) return m[1].toLowerCase();
  }
  // 清单格式里没有目标文件 ⇒ **不猜**（拿别的文件的摘要顶替只会得到"恒失败"，且掩盖上游改名）。
  if (sawNamed) return null;
  // 只有单个摘要值的文件（有些仓库只发布 `sha256sum` 单值文件）。
  const all = [...body.matchAll(/\b([0-9a-fA-F]{64})\b/g)].map((m) => m[1].toLowerCase());
  return all.length === 1 ? all[0] : null;
}

/**
 * 比对"期望摘要 vs 实算摘要"（纯函数，**fail-closed**：任何一边不合法都判不匹配）。
 *
 * 为什么单独抽出来：`mismatch ⇒ 拒绝安装` 是这条供应链里唯一真正的安全闸门，
 * 必须能在离线单测里锁死"不相等就绝不通过""摘要格式不对也绝不通过"，
 * 而不是只能靠联网安装碰运气。旧实现把比对写死在下载流程里，连"有没有真的比过"都看不出来。
 * @returns `{match:boolean, reason?}`
 */
export function judgeSha256(expected, actual) {
  const e = normalizeSha256(expected);
  const a = normalizeSha256(actual);
  if (!e) return { match: false, reason: '期望摘要不是合法 sha256（按不匹配处理，拒绝安装）' };
  if (!a) return { match: false, reason: '实际摘要不是合法 sha256（按不匹配处理，拒绝安装）' };
  if (e === a) return { match: true };
  return { match: false, reason: `期望 ${e.slice(0, 16)}… 实际 ${a.slice(0, 16)}…` };
}

/**
 * 取"期望摘要"并校验下载产物的 sha256。期望摘要的来源按 {@link verificationPlanOfAsset} 的优先级：
 *   · `digestSource === 'github-api'`  ⇒ 直接用 API 的 `digest`（不用联网再取一次）；
 *   · `digestSource === 'release-file'` ⇒ 下载 `checksumUrl` 再 {@link pickSha256}；
 *   · `digestSource === 'builtin'`      ⇒ 用内置 TOFU pin。
 *
 * 为什么：插件会在用户机器上**自动下载并执行** GitHub Releases 里的二进制；旧实现把发布页上的
 * `*.sha256` / `SHA256SUMS` 当作噪音过滤掉，安装后只验"可执行位" —— 上游资产被替换或镜像劫持时，
 * 没有任何一层会察觉。这里用摘要做校验；没有摘要就如实标 `unavailable`（调用方与 notes 都可见）。
 *
 * 导出而非私有：`test/supply-chain.test.ts` 用本地 http 服务喂它假的校验文件/资产，
 * 从而在**完全离线**的情况下锁住 release-file 来源与"不匹配就拒绝"，不依赖 GitHub 是否可达。
 *
 * @returns `{ok:true, expected, actual, source}` 校验通过；
 *          `{ok:false, unavailable:true, error}` **拿不到**摘要（限流/网络/文件里没有目标条目）⇒ 调用方降级为
 *          `'unavailable'`，不是 mismatch；
 *          `{ok:false, error}` 摘要**不匹配** ⇒ 调用方必须放弃安装（这才是 mismatch）
 */
export async function verifySha256(file, asset, proxy, signal = null) {
  const plan = verificationPlanOfAsset(asset);
  let expected = null;
  if (plan.digestSource === 'github-api') {
    expected = parseGithubDigest(asset.digest)?.hex ?? null;
    if (!expected) return { ok: false, unavailable: true, error: `API digest 无法解析：${String(asset.digest).slice(0, 40)}` };
  } else if (plan.digestSource === 'release-file') {
    const res = await fetchText(asset.checksumUrl, proxy, { signal, timeoutMs: 60_000 });
    if (!res.ok) return { ok: false, unavailable: true, error: `下载校验文件 ${asset.checksumName ?? asset.checksumUrl} 失败：${res.error}` };
    expected = pickSha256(res.text, asset.name);
    if (!expected) {
      // 拿到了文件但里面没有目标资产的摘要：可能是上游改名/清单格式变了。此时**无法校验**，
      // 不能当成 mismatch（那是"校验了且不符"），否则会误报上游资产被替换。
      return { ok: false, unavailable: true, error: `校验文件 ${asset.checksumName ?? ''} 里找不到 ${asset.name} 的摘要` };
    }
  } else if (plan.digestSource === 'builtin') {
    expected = normalizeSha256(asset.builtin);
    if (!expected) return { ok: false, unavailable: true, error: '内置摘要表里的 pin 不是合法 sha256' };
  } else {
    return { ok: false, unavailable: true, error: plan.reason };
  }
  const actual = await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  const got = String(actual).toLowerCase();
  const verdict = judgeSha256(expected, got);
  if (!verdict.match) {
    return {
      ok: false,
      error: `sha256 不匹配（来源 ${plan.digestSource}）：${verdict.reason}（拒绝安装）`,
      expected,
      actual: got,
    };
  }
  return { ok: true, expected, actual: got, source: plan.digestSource };
}

function findBinary(root, bins) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      // 不要求解压后已有可执行位：zip 里的 `qsv` 就没有 exec 位（实测 2026-10-26），
      // 拷贝后统一 chmod 755，所以这里只按文件名认。
      else if (bins.includes(entry.name)) {
        try {
          if (fs.statSync(full).isFile()) return full;
        } catch {
          /* 忽略坏条目 */
        }
      }
    }
  }
  return null;
}

async function extract(file, kind, dest, signal = null) {
  fs.mkdirSync(dest, { recursive: true });
  if (kind === 'tar.gz') {
    const r = await runAsync('tar', ['-xzf', file, '-C', dest], { timeoutMs: 120_000, maxBytes: 64 * 1024, signal });
    return r.code === 0
      ? { ok: true }
      : { ok: false, error: `tar exit ${r.code}: ${tarDiag(r)}` };
  }
  if (kind === 'zip') {
    if (!(await commandOf('unzip', { signal }))) return { ok: false, error: '发行版里没有 unzip，无法解压 zip 资产' };
    const r = await runAsync('unzip', ['-q', '-o', file, '-d', dest], { timeoutMs: 120_000, maxBytes: 64 * 1024, signal });
    return r.code === 0
      ? { ok: true }
      : { ok: false, error: `unzip exit ${r.code}: ${tarDiag(r)}` };
  }
  const target = path.join(dest, 'payload');
  const r = await runAsync('bash', ['-c', `gzip -dc ${JSON.stringify(file)} > ${JSON.stringify(target)}`], { timeoutMs: 120_000, maxBytes: 64 * 1024, signal });
  return r.code === 0
    ? { ok: true }
    : { ok: false, error: `gzip exit ${r.code}: ${tarDiag(r)}` };
}

/** 解压类命令的诊断文本：优先 stderr，截断/超时都要标出来（F-32：别让尾部原因静默消失）。 */
function tarDiag(r) {
  const body = r.error ?? String(r.stderr ?? '').trim().slice(0, 200);
  const noted = withTruncMark(body, r.truncated?.stderr);
  return r.timedOut ? `${noted}（已超时）` : noted;
}

/** 等一次安装（ensureTools/显式安装用；搜索路径不要用这个，见 {@link ensureSearchToolsNonBlocking}）。 */
async function ensureToolReady(id, { installDir, autoInstall = true, ignorePath = false, proxy = null, signal = null, force = false, failureGate = false } = {}) {
  const dir = installDir || defaultBinDir();
  const located = await locateTool(id, { installDir: dir, ignorePath, signal });
  if (located.path) {
    return { entry: { path: located.path, source: located.source, version: located.version ?? null }, note: null };
  }
  if (!autoInstall) {
    return { entry: { path: null, source: 'missing' }, note: `${id} 未安装（已禁用自动安装）；手动安装：${MANUAL[id] ?? '见项目文档'}` };
  }
  // awaiting 的调用通常是"明确要装"（wsl_tools install / 显式 provision）：失败后允许立刻重试。
  // 例外是 daemon 的搜索后台安装（ensureSearchTools ⇒ failureGate）：每次搜索都重打 GitHub 会触发
  // 未认证限流（60/小时），所以在失败后 60 秒内只回报失败、不再起新的下载。
  if (failureGate && !force) {
    const recent = failureOf(id);
    if (recent) {
      return { entry: { path: null, source: 'failed' }, note: `${id} 自动安装失败（${recent.error}）；手动安装：${MANUAL[id] ?? '见项目文档'}` };
    }
  }
  if (force) failures.delete(id);
  const installed = await startInstall(id, { installDir: dir, proxy, signal });
  if (installed.ok) {
    return {
      entry: {
        path: installed.path,
        source: 'installed',
        version: installed.version ?? null,
        // 供应链结论跟着工具条目走：调用方（daemon → register-tools → 用户）不需要再翻安装返回值。
        verified: installed.verified ?? null,
        digestSource: installed.digestSource ?? null,
      },
      // 校验结论必须**可见**：旧实现只把 verified 放在安装返回值深处，没人看 ⇒ "没校验"等于隐身。
      // 'pinned'/'unavailable' 都要在 notes 里说清楚，'ok' 不重复刷屏。
      note: `已自动安装 ${id}${installed.version ? `@${installed.version}` : ''} → ${installed.path}${installed.verifyNote ? `；${installed.verifyNote}` : ''}`,
    };
  }
  return { entry: { path: null, source: 'failed' }, note: `${id} 自动安装失败（${installed.error}）；手动安装：${MANUAL[id] ?? '见项目文档'}` };
}

const proxyKey = (proxy) => (typeof proxy === 'function' ? 'fn' : proxy || '');

/** 只缓存**全部就绪**的结果；有缺失/失败不缓存（F-25：失败不永久缓存，下次调用可重试）。 */
function cacheGet(key) {
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_SUCCESS_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return hit.result;
}

/**
 * 确保一组工具可用（先 PATH、再已装目录、最后自动下载安装）。**会等安装完成**；
 * 搜索请求路径请用 {@link ensureSearchToolsNonBlocking}（F-12）。
 * @param ids - 工具 id 列表
 * @param options.autoInstall - 允许自动安装（默认 true）
 * @param options.ignorePath - 跳过 PATH 探测（探针用）
 * @param options.force - 忽略缓存/失败闸门，立刻重试（显式安装）
 * @param options.failureGate - 失败后 60s 内不再重试（daemon 的搜索后台安装用，防止每次搜索都打 GitHub）
 * @param options.signal - AbortSignal（取消正在跑的探测/下载）
 * @returns `{tools:{[id]:{path,source,version}}, notes}`
 */
export async function ensureTools(ids, { autoInstall = true, installDir, proxy = null, ignorePath = false, signal = null, force = false, failureGate = false } = {}) {
  const dir = installDir || defaultBinDir();
  const key = `${ids.join(',')}|${dir}|${proxyKey(proxy)}|${autoInstall ? '1' : '0'}|${ignorePath ? '1' : '0'}`;
  if (!force) {
    const hit = cacheGet(key);
    if (hit) {
      recordKnownFromResult(hit);
      // 命中缓存时不再重复"已自动安装 …"这类一次性提示（daemon 每次搜索都会 kick 一次，
      // 否则同样的成功提示会跟着每条搜索结果重复 10 分钟）。失败/缺失结果本来就不缓存。
      return { tools: hit.tools, notes: [] };
    }
  }
  const tools = {};
  const notes = [];
  for (const id of ids) {
    const spec = TOOLS.find((t) => t.id === id);
    if (!spec) {
      tools[id] = { path: null, source: 'unknown' };
      notes.push(`未知工具：${id}`);
      continue;
    }
    const { entry, note } = await ensureToolReady(id, { installDir: dir, autoInstall, ignorePath, proxy, signal, force, failureGate });
    tools[id] = entry;
    if (note) notes.push(note);
  }
  const result = { tools, notes };
  // 只有"全都拿到了"才缓存；有缺失/失败时下次调用会重新探测/重试（F-25：失败不永久缓存）。
  const complete = Object.values(tools).every((t) => !!t.path);
  if (complete) resultCache.set(key, { result, at: Date.now() });
  return result;
}

/** 搜索用：确保 rg/fd（保留旧名，语义不变：会等安装）。 */
export async function ensureSearchTools(opts = {}) {
  // failureGate：daemon 的搜索分支把这里当"后台安装"用（fire-and-forget，每次搜索调用一次）；
  // 失败后 60s 内不再重打 GitHub，避免未认证限流（F-25）。
  const r = await ensureTools(['rg', 'fd'], { failureGate: true, ...opts });
  return {
    rg: { path: r.tools.rg?.path ?? null, source: r.tools.rg?.source },
    fd: { path: r.tools.fd?.path ?? null, source: r.tools.fd?.source },
    notes: r.notes,
  };
}

/**
 * 搜索用（F-12）：**不等待安装**，只返回当前状态。缺 rg/fd 时把安装丢到后台（in-flight 去重），
 * 本次搜索立刻用 GNU grep/find 兜底；失败会在后续调用里以 `failed` + `notes` 出现，绝不静默。
 *
 * daemon 的 `op:'search'` 应当调用这个（而不是 `await ensureSearchTools`），然后
 * `setSearchToolPaths(toolPaths())` 再跑搜索。
 *
 * @param opts.autoInstall - 允许自动安装（默认 true）
 * @param opts.installDir - 安装目录（默认 `~/.local/bin`）
 * @param opts.proxy - 代理字符串，或返回代理的**惰性函数**（只有真要下载时才取值，F-30）
 * @returns `{rg, fd, installing: string[], notes: string[]}`；两个工具对象形如
 *          `{status:'ready'|'installing'|'failed'|'missing', path, source, version?, error?, manual?}`
 */
export async function ensureSearchToolsNonBlocking(opts = {}) {
  const installDir = opts.installDir || defaultBinDir();
  const autoInstall = opts.autoInstall !== false;
  const ignorePath = opts.ignorePath === true;
  const ids = ['rg', 'fd'];
  const status = {};
  for (const id of ids) {
    const located = await locateTool(id, { installDir, ignorePath, signal: opts.signal });
    if (located.path) {
      status[id] = { status: 'ready', path: located.path, source: located.source, version: located.version ?? null };
      continue;
    }
    const manual = MANUAL[id] ?? null;
    if (!autoInstall) {
      status[id] = { status: 'missing', path: null, source: 'missing', manual };
      continue;
    }
    if (isInstalling(id, installDir)) {
      status[id] = { status: 'installing', path: null, source: null };
      continue;
    }
    const recent = failureOf(id);
    if (recent) {
      status[id] = { status: 'failed', path: null, source: 'failed', error: recent.error, manual };
      continue;
    }
    // 后台安装：不 await。本次搜索用自带后端兜底，装好后的下一次搜索用上 rg/fd。
    startInstall(id, { installDir, proxy: opts.proxy, signal: opts.signal });
    status[id] = { status: 'installing', path: null, source: null };
  }
  const installing = ids.filter((id) => status[id].status === 'installing');
  const notes = [];
  for (const id of ids) {
    const st = status[id];
    if (st.status === 'failed') {
      notes.push(`${id} 自动安装失败（${st.error}）；本次搜索已回退到发行版自带后端；手动安装：${st.manual ?? '见项目文档'}`);
    }
  }
  return { ...status, installing, notes };
}

/**
 * 同步状态快照（不再探测）：给测试/诊断用，daemon 不需要。
 * @param installDir - 安装目录（默认 `~/.local/bin`），用于判断"该目录里是否有安装在进行"
 * @returns 与 {@link ensureSearchToolsNonBlocking} 同形
 */
export function searchToolsStatus(installDir) {
  const ids = ['rg', 'fd'];
  const status = {};
  for (const id of ids) {
    const cached = known.get(id);
    if (cached?.path && execOk(cached.path)) {
      status[id] = { status: 'ready', path: cached.path, source: cached.source, version: cached.version ?? null };
    } else if (isInstalling(id, installDir)) {
      status[id] = { status: 'installing', path: null, source: null };
    } else {
      const f = failures.get(id);
      status[id] = f
        ? { status: 'failed', path: null, source: 'failed', error: f.error, manual: MANUAL[id] ?? null }
        : { status: 'missing', path: null, source: 'missing', manual: MANUAL[id] ?? null };
    }
  }
  const installing = ids.filter((id) => status[id].status === 'installing');
  return { ...status, installing, notes: [] };
}

/**
 * rg/fd 的绝对路径（daemon 注入给 search-rpc）。
 * F-22：按 **工具 id 合并**所有探测/安装结果；旧实现取 `[...cache.values()].at(-1)`，
 * "先装 rg、再装别的工具"之后 rg 路径就丢了。死路径（二进制被删）在这里剔除。
 */
export function toolPaths() {
  const out = { rg: null, fd: null };
  for (const id of ['rg', 'fd']) {
    const entry = known.get(id);
    if (!entry?.path) continue;
    if (!execOk(entry.path)) {
      known.delete(id);
      continue;
    }
    out[id] = entry.path;
  }
  return out;
}

/** 允许工具清单读取（`wsl_tools` 用）。 */
export function catalog() {
  return TOOLS.map((t) => ({ id: t.id, repo: t.repo, label: t.label, manual: MANUAL[t.id] ?? null }));
}

/**
 * 已安装工具的**校验溯源快照**（只读，不探测）。给诊断/`wsl_tools` 用：
 * 让"哪些是官方摘要校验过、哪些只是 TOFU pin、哪些根本没摘要"一眼可见，而不是埋在一次安装的返回值里。
 *
 * 为什么需要：修这个缺陷（2026-10-27）之前所有条目的 `verified` 都是 'unavailable' 却没人发现，
 * 因为没有任何地方能一次看到全貌。
 * @returns `{[id]: {path, verified, digestSource, version}}`（仅含本次进程内已确认的条目）
 */
export function verificationSummary() {
  const out = {};
  for (const [id, entry] of known.entries()) {
    if (!entry?.path) continue;
    out[id] = {
      path: entry.path,
      version: entry.version ?? null,
      verified: entry.verified ?? null, // null = 走 instanceof PATH/已装目录命中的二进制（不是本模块下载的，来源不可考）
      digestSource: entry.digestSource ?? null,
    };
  }
  return out;
}

/** 清空模块内缓存（测试/诊断用；生产代码不需要）。 */
export function resetToolCache() {
  known.clear();
  failures.clear();
  installInFlight.clear();
  resultCache.clear();
  pathProbeCache.clear();
  archCache = null;
}
