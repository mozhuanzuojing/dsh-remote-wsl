/**
 * check-pack-loadable.ts —— **发布形态门禁**：`npm pack` 出来的东西，装到别人机器上到底能不能加载。
 *
 * 为什么需要它（2026-11-24 实测事故事实）：
 * 插件原本 `main` 指着 `src/index.ts`、守护是 `src/daemon.ts`，靠 Node 的类型擦除直接跑 ——
 * 这在 `link:` 安装下成立（文件在工作树里），但 Node **明确拒绝 `node_modules` 里的 `.ts`**：
 *   ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
 * 于是 `npm i dsh-remote-wsl` 之后宿主半与守护半**双双加载失败**，而本仓库所有既有测试都绿 ——
 * 因为测试永远 import `../src/*.ts`。这个脚本补的就是这段"最后一步"：把 tarball 解出来，
 * 按**安装形态**逐个 entry 真加载，并验证守护脚本解析到 `lib/daemon.js`。
 *
 * 用法：先 `npm run build`（产物在 lib/），再 `npm run check:pack`。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
const results: Array<{ ok: boolean; what: string; detail?: string }> = [];
const say = (ok: boolean, what: string, detail?: string) => {
  results.push({ ok, what, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !detail ? '' : ` —— ${detail}`}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'dsh-rw-pack-'));
try {
  // 1) 打包（不跑 scripts：产物必须由调用方先 build 好，避免门禁偷偷重建、掩盖"忘了 build"）
  // Windows 上 npm 是 .cmd ⇒ 必须走 shell；整条命令拼成一个字符串（不传 args 数组）以避免 DEP0190。
  const packCmd = `npm pack --pack-destination "${tmp}" --ignore-scripts --silent`;
  const pack = spawnSync(packCmd, { cwd: root, shell: true, encoding: 'utf8' });
  const tgz = (pack.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.tgz'))
    .pop();
  say(pack.status === 0 && tgz !== undefined, 'npm pack 成功', pack.stderr?.slice(0, 300));
  if (!tgz) throw new Error('没有产出 tarball');

  // 2) 解开（Windows 10+ 自带 bsdtar）
  const ex = spawnSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp], { encoding: 'utf8' });
  say(ex.status === 0, 'tarball 解包成功', ex.stderr?.slice(0, 300));
  const pkgDir = join(tmp, 'package');

  // 3) 逐个 entry 真加载（这一步就是"别人的机器上会不会炸"）
  const entries = ['index.js', 'fs-provider.js', 'search-tool.js', 'shell-provider.js', 'command-policy.js'];
  for (const file of entries) {
    const target = join(pkgDir, 'lib', file);
    if (!existsSync(target)) {
      say(false, `lib/${file} 存在`, '缺失：exports 会解析到不存在的文件');
      continue;
    }
    try {
      const m = await import(pathToFileURL(target).href);
      say(typeof m === 'object' && m !== null, `lib/${file} 可加载`, undefined);
      if (file === 'index.js') {
        say(typeof m.apply === 'function', 'lib/index.js 导出 apply()（插件入口契约）');
      }
    } catch (e: any) {
      say(false, `lib/${file} 可加载`, `${e?.code ?? ''} ${String(e?.message ?? e).split('\n')[0]}`);
    }
  }

  // 4) 守护脚本必须解析到 **安装形态**（daemon.js），否则 WSL 侧会因 node_modules 里的 .ts 被拒
  const dp = join(pkgDir, 'lib', 'daemon-protocol.js');
  if (existsSync(dp)) {
    const m = await import(pathToFileURL(dp).href);
    const script = String(m.daemonScriptWsl?.() ?? '');
    say(script.endsWith('daemon.js'), '守护脚本解析到 lib/daemon.js', `实际：${script || '(空)'}`);
  } else {
    say(false, 'lib/daemon-protocol.js 存在');
  }
  say(existsSync(join(pkgDir, 'lib', 'daemon.js')), 'lib/daemon.js 随包发布（WSL 侧要跑它）');
  say(!existsSync(join(pkgDir, 'node_modules')), 'tarball 未夹带 node_modules');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${failed.length === 0 ? 'PASS' : 'FAIL'} ｜ 断言 ${results.length} 条 ｜ root=${root}`);
if (failed.length > 0) process.exit(1);
