/**
 * probe-f32-f15.mjs —— T10 桩级断言：
 *   F32：同一 registerExplorer 内 inject 触发**两次** ⇒ dispose 后**活跃路由计数必须为 0**
 *        （并附**旧缺陷形态对照**：catch 里无条件 `removeRoute=null` ⇒ dispose 后残留 1）
 *   F15：webServer 永不就绪 ⇒ 必须出现那一行降级日志（用 DSH_REMOTE_WSL_INJECT_WARN_MS 接缝，不等 30s）
 *
 * 只 import 交付物本体；不改任何被验对象。log 走 process.stderr（`remote-wsl(explorer): ` 前缀），
 * 故本探针把 stderr 也重定向到自己的捕获数组，原始输出由调用方连同 .err 一起留档。
 */
const LIB = 'D:/project/dsh1/vendor/dsh-remote-wsl/src/explorer.ts';
const mod = await import(`file:///${LIB}`);

const CONFIG = { daemonPort: 8932, distro: 'debian-u8-1', cwd: '/home/g', wslHome: '/home/g', dshVersion: '' };

function makeWebServer() {
  const routes = [];
  return {
    routes,
    activeCount: () => routes.length,
    register(opts) {
      if (routes.some((r) => r.kind === opts.kind && r.path === opts.path)) {
        throw new Error(`duplicate (kind,path): ${opts.kind} ${opts.path}`);
      }
      const rec = { kind: opts.kind, path: opts.path };
      routes.push(rec);
      return () => {
        const i = routes.indexOf(rec);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
}
function makeCtx() {
  const cbs = [];
  return { cbs, inject: (_deps, cb) => { cbs.push(cb); }, get: () => undefined };
}

const out = { entry: LIB, f32: {}, f15: {} };

// ───────────────────────── F32 ─────────────────────────
const ws = makeWebServer();
const ctx = makeCtx();
const reg = mod.registerExplorer(ctx, { config: CONFIG });
const webCtx = { get: (k) => (k === 'webServer' ? ws : undefined) };

ctx.cbs[0](webCtx);                       // 第 1 次 inject 触发（成功注册）
out.f32.afterFirstInject = ws.activeCount();
let secondError = null;
try { ctx.cbs[0](webCtx); } catch (e) { secondError = String(e?.message ?? e); }  // 第 2 次（HMR/服务重提供）
out.f32.secondInjectEscaped = secondError;   // 期望 null（内部已被 catch，不该冒出去）
out.f32.afterSecondInject = ws.activeCount(); // 期望仍 1（旧路由还在，未被 duplicate 抹掉 disposer）
try { await reg.dispose(); } catch (e) { out.f32.disposeError = String(e?.message ?? e); }
out.f32.afterDispose = ws.activeCount();      // ★ 期望 0
out.f32.VERDICT = out.f32.afterDispose === 0 ? 'PASS' : 'RED';

// 旧缺陷形态对照（局部复刻"catch 里无条件 removeRoute=null"）——证明该断言能区分 0 与 1
const ws2 = makeWebServer();
let removeRoute = null;
function registerRouteOldBug(webServer) {
  let adapter = null;
  try {
    adapter = { dispose: webServer.register({ kind: 'exact', path: '/remote-wsl/api' }) };
    removeRoute = adapter.dispose;
  } catch {
    removeRoute = null;              // ← 改前行为
  }
  return () => { if (typeof removeRoute === 'function') removeRoute(); };
}
const oldDispose = registerRouteOldBug(ws2);
try { registerRouteOldBug(ws2); } catch {}
oldDispose();
out.f32.control_oldBug_afterDispose = ws2.activeCount();   // 期望 1（残留）⇒ 断言有区分力
out.f32.controlVerdict = out.f32.control_oldBug_afterDispose === 1 ? 'CONTROL-OK(区分力成立)' : 'CONTROL-BAD';

// ───────────────────────── F15 ─────────────────────────
const logs = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => { logs.push(String(chunk)); return true; };
try {
  const prev = process.env.DSH_REMOTE_WSL_INJECT_WARN_MS;
  process.env.DSH_REMOTE_WSL_INJECT_WARN_MS = '300';       // 验证接缝：0.3s 而不是 30s
  const ctx2 = makeCtx();                                   // inject 永不触发
  const reg2 = mod.registerExplorer(ctx2, { config: CONFIG });
  await new Promise((r) => setTimeout(r, 1200));
  process.stderr.write = origWrite;
  const warn = logs.filter((l) => /webServer|未就绪|未触发|未注册|降级|inject/i.test(l));
  out.f15.logsCaptured = logs.length;
  out.f15.warnLines = warn.map((l) => l.trim());
  // 修正（自查）：第一版正则写成 /inject.*未触发|注入.*未触发|降级/，而实现的实际文案是
  // `webServer 未就绪 ⇒ explorer.* HTTP 路由未注册（方法表仍可用）` ⇒ 把**已修好**的行为判成红。
  // 断言必须按实现的实际文案判，故这里放宽到"未就绪/未注册/未触发/降级"任一命中。
  out.f15.hasWarnLine = warn.some((l) => /未就绪|未注册|未触发|降级/.test(l));
  out.f15.VERDICT = out.f15.hasWarnLine ? 'PASS' : 'RED';
  out.f15.registeredInBothCases = typeof reg2.dispose === 'function';
  try { await reg2.dispose(); } catch {}
  if (prev === undefined) delete process.env.DSH_REMOTE_WSL_INJECT_WARN_MS; else process.env.DSH_REMOTE_WSL_INJECT_WARN_MS = prev;
} catch (e) {
  process.stderr.write = origWrite;
  out.f15.error = String(e?.message ?? e);
  out.f15.VERDICT = 'RED';
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
