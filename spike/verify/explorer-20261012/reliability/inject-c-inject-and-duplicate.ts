/**
 * inject-c-inject-and-duplicate.ts —— INJ-C：`webServer` 未注入 / 注入回调被触发多次 / route 重复注册
 * （FMEA F15/F16/F20/SP2/SP7 + **新增 F32 残留路由**）。
 *
 * **不需要宿主、不需要守护、不占端口**：直接 import 被验对象 `src/explorer.ts`（只读），
 * 用桩 ctx 驱动 `registerExplorer()`。这是本任务唯一**未被环境阻断**的注入实验
 * （2026-10-12 15:54 起 `dsh` CLI 与全局 `@deepseek-ai/*` 被 npm 剪掉，宿主类实验做不了，见 REPORT）。
 *
 * 用法（必须带 --go）：
 *   node --experimental-strip-types inject-c-inject-and-duplicate.ts --go
 *
 * 产物：out-C-01..05-*.txt、out-C-summary.json
 *
 * ★ 冻结 revision（2026-10-12 15:45，`src/explorer.ts` 86f29d83… 29545 B / 646 行）**已含 lead 加固**：
 *   `registerExplorer` 把路由注册整体包进 try/catch（:597-629），失败只降级数据面、不打倒插件。
 *   本实验就是**验证这条加固真的生效**，并检查它有没有留下新缺口。
 *
 * 诚实边界：桩只能证明**实现层**行为；真实 Cordis 的卸载语义未复核。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const GO = process.argv.includes('--go');
const SRC = 'D:/project/dsh1/vendor/dsh-remote-wsl/src/explorer.ts';

if (!GO) {
  console.log('INJ-C 计划（未执行；加 --go 才 import 被验对象并驱动桩 ctx）');
  console.log('  C1  inject 永不回调（条件注入未触发）⇒ 期望：只打一行"未注册"，不抛，methods 仍 4 个，dispose 安全');
  console.log('  C2  两个独立的 registerExplorer 先后注册同一 route ⇒ 第 2 次必抛（官方语义），但必须被 catch；第 1 个 handle 的 dispose 仍应有效');
  console.log('  C3  同一次 registerExplorer 内 inject 回调触发两次（HMR/服务重提供）⇒ 检查 catch 是否把共享的 removeRoute 置空 ⇒ 路由残留');
  console.log('  C4  webServer 在但 register 不是函数 ⇒ 期望"服务不可用"降级，不抛');
  console.log('  C5  register 抛非 duplicate 的普通错误 ⇒ 期望同样被 catch 降级（证明 catch 不是只挡 duplicate）');
  console.log('  不做：真实 Cordis 的卸载/热更语义（未复核项）');
  process.exit(0);
}

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
const dump = (name) => writeFileSync(`${DIR}${name}`, lines.join('\n') + '\n', 'utf8');
const summary = { at: new Date().toISOString(), src: SRC };

function captureStderr(fn) {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return orig(chunk, ...rest); };
  try { return { value: fn(), captured }; } finally { process.stderr.write = orig; }
}

/** 桩依赖：纯函数/空 Map，不触 WSL、不触文件系统。 */
const deps = {
  config: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', daemonPort: 8972, timeoutMs: 1000 },
  listDistros: () => ['debian-u8-1'],
  resolveVersion: () => ({ version: 'v0.0.0-stub', pin: null, desktopVersion: null, drift: null }),
  writePin: () => true,
  webHosts: new Map(),
};

/** 真实语义的 webServer（照抄 @deepseek-ai/dsh-host-webserver/lib/index.js:177-184）。 */
function makeWebServerStub(opts = {}) {
  const table = new Map();
  return {
    routes: table,
    register(route) {
      if (opts.failWith) throw new Error(opts.failWith);
      const key = `${route.kind}:${route.path}`;
      if (table.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      table.set(key, route);
      return () => table.delete(key);
    },
  };
}

const mod = await import(`file:///${SRC}`);
const { registerExplorer } = mod;
say(`entry=${SRC}`);
say(`exports: registerExplorer=${typeof registerExplorer}`);
if (typeof registerExplorer !== 'function') { say('FATAL: 被验对象没有 registerExplorer ⇒ 实现形状变了，实验无效'); dump('out-C-summary.json'); process.exit(1); }

// ── C1：inject 永不回调 ────────────────────────────────────────────────────────
{
  lines.length = 0;
  say('### C1 inject 永不回调（条件注入未触发 / 无 webServer 组合）');
  const neverCtx = { inject: () => { /* 永不回调 */ } };
  let threw = null, out = null;
  const { captured } = captureStderr(() => { try { out = registerExplorer(neverCtx, deps); } catch (e) { threw = e; } });
  say(`throw=${threw ? threw.message : '(none)'}`);
  say(`methods=${JSON.stringify(out?.methods ?? null)} route=${out?.route ?? null}`);
  say(`stderr=${JSON.stringify(captured)}`);
  let disposeOk = true;
  try { out?.dispose?.(); } catch (e) { disposeOk = false; say(`dispose threw: ${e.message}`); }
  // ★ 实测修正（2026-10-12）：inject **永不回调**时，`registerRoute` 根本不会被执行 ⇒ **一行日志都没有**。
  //   我原先在 FMEA F15 写"stderr 一行 webServer 服务不可用…"是**错的**：那行只在"回调触发了但服务形状不对"（C4）时出现。
  //   ⇒ 这不是脚本失败，而是**实现的可诊断性缺口**：headless/无 webServer 组合下面板数据面静默缺席。
  const logEmitted = captured.join('').includes('未注册') || captured.join('').includes('不可用');
  const ok = threw === null && out?.methods?.length === 4 && disposeOk;
  say(`日志是否出现=${logEmitted}（实测：inject 不回调 ⇒ **无任何日志**）`);
  say(`verdict=${ok ? (logEmitted ? 'PASS' : 'PASS-BUT-SILENT(F15-可诊断性缺口)') : 'RED'}`);
  summary.C1 = { throw: threw?.message ?? null, methods: out?.methods ?? null, stderr: captured.join(''), disposeOk, logEmitted, verdict: ok ? (logEmitted ? 'PASS' : 'PASS-BUT-SILENT(F15-gap)') : 'RED' };
  dump('out-C-01-inject-absent.txt');
}

// ── C2：两个**独立**的 registerExplorer 先后注册同一 route（= 插件双装载）────────
{
  lines.length = 0;
  say('### C2 同一 webServer 上 registerExplorer 被调用两次（独立两次）');
  const webServer = makeWebServerStub();
  const ctx = { inject: (_deps, cb) => cb({ get: (k) => (k === 'webServer' ? webServer : undefined) }) };
  let first = null, firstErr = null, second = null, secondErr = null, firstCaptured = [], secondCaptured = [];
  const r1 = captureStderr(() => { try { first = registerExplorer(ctx, deps); } catch (e) { firstErr = e; } });
  firstCaptured = r1.captured;
  say(`第 1 次: throw=${firstErr ? firstErr.message : '(none)'} routes=${webServer.routes.size} stderr=${JSON.stringify(firstCaptured)}`);
  const r2 = captureStderr(() => { try { second = registerExplorer(ctx, deps); } catch (e) { secondErr = e; } });
  secondCaptured = r2.captured;
  say(`第 2 次: throw=${secondErr ? secondErr.message : '(none)'} routes=${webServer.routes.size} stderr=${JSON.stringify(secondCaptured)}`);
  const degradedLogged = secondCaptured.join('').includes('explorer http route unavailable');
  const routesAfter1 = webServer.routes.size;
  // 第 1 个 handle 的 dispose 是否仍有效（两个 registerExplorer 各有自己的 removeRoute）
  let disposeErr = null;
  try { first?.dispose?.(); } catch (e) { disposeErr = e; }
  const routesAfterDispose = webServer.routes.size;
  say('');
  say(`观察点：第 2 次抛错是否逃逸 = ${secondErr ? 'YES（未加固时就是这样）' : 'NO ✅（被 catch）'}`);
  say(`       降级日志是否出现 = ${degradedLogged ? 'YES ✅' : 'NO'}`);
  say(`       第 1 个 handle.dispose() 后 routes = ${routesAfterDispose}（期望 0）`);
  const pass = secondErr === null && degradedLogged && routesAfter1 === 1 && routesAfterDispose === 0 && disposeErr === null;
  say(`verdict=${pass ? 'PASS（加固生效：重复装载不再打倒插件，且第一次的路由仍可释放）' : 'RED/需看细节'}`);
  summary.C2 = {
    secondThrowsToCaller: Boolean(secondErr), secondError: secondErr?.message ?? null,
    degradedLogged, routesAfterFirst: routesAfter1, routesAfterFirstDispose: routesAfterDispose,
    disposeErr: disposeErr?.message ?? null, verdict: pass ? 'PASS' : 'RED',
  };
  dump('out-C-02-duplicate-throw.txt');
}

// ── C3：**同一次** registerExplorer 内 inject 触发两次（HMR / webServer 被重新 provide）──
{
  lines.length = 0;
  say('### C3 inject 回调在**同一次** registerExplorer 内被触发两次（HMR / 服务重提供）');
  const webServer = makeWebServerStub();
  const innerThrows = [];
  const ctx = {
    inject: (_deps, cb) => {
      for (const tag of ['第一次就绪', '重新就绪']) {
        try { cb({ get: (k) => (k === 'webServer' ? webServer : undefined) }); } catch (e) { innerThrows.push(`${tag}: ${e.message}`); }
      }
    },
  };
  let handle = null, outer = null;
  const { captured } = captureStderr(() => { try { handle = registerExplorer(ctx, deps); } catch (e) { outer = e; } });
  const routesBeforeDispose = webServer.routes.size;
  let disposeErr = null;
  try { handle?.dispose?.(); } catch (e) { disposeErr = e; }
  const routesAfterDispose = webServer.routes.size;
  say(`回调内捕获到的抛错=${JSON.stringify(innerThrows)}`);
  say(`逃到最外层的抛错=${outer ? outer.message : '(none) ✅'}`);
  say(`stderr=${JSON.stringify(captured)}`);
  say('');
  say(`★ 关键读点：routes before dispose = ${routesBeforeDispose}（期望 1，第一次注册成功）`);
  say(`            handle.dispose() 后 routes = ${routesAfterDispose}`);
  say('   第二次就绪时 `createExplorerHttpAdapter` 抛 duplicate ⇒ catch 里 `removeRoute = null`。');
  say('   而 `removeRoute` 是**同一次 registerExplorer 内共享**的变量 ⇒ 它把**第一次成功注册那条路由的 disposer 抹掉了**。');
  say('   ⇒ 若 routesAfterDispose === 1：**路由残留**（卸载/热更后不释放，且仍持旧闭包）。这是 FMEA **F32**。');
  say('');
  say('⚠ 未复核：真实 DSH 的 HMR 是否会重放 inject 回调（若会，"改一次 web 插件"就能触发本路径）。');
  const isResidual = routesAfterDispose === 1;
  summary.C3 = {
    innerThrows, outerThrow: outer?.message ?? null, routesBeforeDispose, routesAfterDispose,
    residualRouteLeak: isResidual, disposeErr: disposeErr?.message ?? null,
    verdict: outer === null ? (isResidual ? 'HARDENING-OK-BUT-RESIDUAL-LEAK(F32)' : 'PASS') : 'RED(throw escaped)',
  };
  dump('out-C-03-inject-twice.txt');
}

// ── C4：webServer 在但 register 不是函数 ───────────────────────────────────────
{
  lines.length = 0;
  say('### C4 webServer 服务在，但 register 不是函数（形状不对）');
  const broken = { get: (k) => (k === 'webServer' ? { notRegister: true } : undefined) };
  const ctx = { inject: (_d, cb) => cb(broken) };
  let threw = null, out = null;
  const { captured } = captureStderr(() => { try { out = registerExplorer(ctx, deps); } catch (e) { threw = e; } });
  const ok = threw === null && captured.join('').includes('不可用');
  say(`throw=${threw ? threw.message : '(none)'} methods=${JSON.stringify(out?.methods ?? null)}`);
  say(`stderr=${JSON.stringify(captured)}`);
  say(`verdict=${ok ? 'PASS（形状不对也优雅降级）' : 'RED'}`);
  summary.C4 = { throw: threw?.message ?? null, stderr: captured.join(''), verdict: ok ? 'PASS' : 'RED' };
  dump('out-C-04-register-not-function.txt');
}

// ── C5：register 抛**非** duplicate 的普通错误 ─────────────────────────────────
{
  lines.length = 0;
  say('### C5 register 抛普通错误（非 duplicate，例如 EACCES/内部错）');
  const webServer = makeWebServerStub({ failWith: 'boom: register failed for an unrelated reason' });
  const ctx = { inject: (_d, cb) => cb({ get: (k) => (k === 'webServer' ? webServer : undefined) }) };
  let threw = null, out = null;
  const { captured } = captureStderr(() => { try { out = registerExplorer(ctx, deps); } catch (e) { threw = e; } });
  const ok = threw === null && captured.join('').includes('explorer http route unavailable');
  say(`throw=${threw ? threw.message : '(none)'} routes=${webServer.routes.size}`);
  say(`stderr=${JSON.stringify(captured)}`);
  say(`verdict=${ok ? 'PASS（catch 不只挡 duplicate；任何注册失败都降级而不打倒插件）' : 'RED'}`);
  summary.C5 = { throw: threw?.message ?? null, routes: webServer.routes.size, stderr: captured.join(''), verdict: ok ? 'PASS' : 'RED' };
  dump('out-C-05-generic-register-error.txt');
}

summary.verdicts = { C1: summary.C1.verdict, C2: summary.C2.verdict, C3: summary.C3.verdict, C4: summary.C4.verdict, C5: summary.C5.verdict };
writeFileSync(`${DIR}out-C-summary.json`, JSON.stringify(summary, null, 2), 'utf8');
console.log('\nINJ-C 完成（桩级）。逐条结论见 out-C-0*.txt；真实 Cordis 行为仍是未复核项。');
console.log('RESTORED: n/a（不启宿主/守护，未占端口，未改被验对象）');
process.exit(0);
