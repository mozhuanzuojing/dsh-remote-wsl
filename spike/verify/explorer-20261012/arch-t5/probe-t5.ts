/**
 * probe-t5.ts —— T5（task-44）验收探针：**逐符号真调**（零构建 TS 漏 import 不在语法期报错 ⇒ 必须真调）
 *
 * 用法：node probe-t5.ts <pluginRoot> <surface|smoke|unload>
 *   surface：列出 7 个工具的 name/参数 JSON/描述哈希/output.schema + 插件 name/inject（与 HEAD 对照）
 *   smoke  ：面板 snapshot→listDir→ensure→openSession + wsl_status（真 deps、真 WSL）
 *   unload ：起守护（看 mode）⇒ 跑 disposer ⇒ 断言守护仍在（"卸载不杀守护"）
 */
const root = process.argv[2].replace(/\\/g, '/');
const mode = process.argv[3];

function makeCtx(capture) {
  const tools = new Map();
  const ctx = {
    inject: (_d, cb) => cb({ get: (k) => (k === 'tools' ? { register: (t) => tools.set(t.name, t) } : undefined) }),
    get: () => undefined,
    effect: (fn) => { capture.disposer = fn(); },
  };
  return { ctx, tools };
}
const CFG = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', provider: 'deepseek-official', model: 'deepseek-flash',
  profile: 'sdk', dshVersion: '', webPort: 3082, idleTimeoutMs: 120000, timeoutMs: 240000,
  desktopRuntimeJson: 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\primary-runtime\\runtime.json',
  proxyPort: 9910, backend: 'daemon', daemonPort: 8912, daemonPortTries: 2, daemonIdleMs: 1800000,
  daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
  useShellEnvironment: true, backgroundWarm: false,
};
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(16); };
const mod = await import(`file:///${root}/src/index.ts`);
const cap = {};
const { ctx, tools } = makeCtx(cap);
mod.apply(ctx, CFG);

if (mode === 'surface') {
  console.log(`plugin.name=${mod.name} inject=${JSON.stringify(mod.inject)} effectRegistered=${typeof cap.disposer === 'function'}`);
  console.log(`tool.count=${tools.size}`);
  for (const n of [...tools.keys()].sort()) {
    const t = tools.get(n);
    console.log(`${n} | params=${JSON.stringify(t.parameters)} | descHash=${hash(t.description)} descLen=${String(t.description ?? '').length} | outSchema=${JSON.stringify(t.output?.schema)} | hasRender=${typeof t.output?.render === 'function'} | hasExecute=${typeof t.execute === 'function'}`);
  }
  process.exit(0);
}

if (mode === 'unload') {
  const dcli = await import(`file:///${root}/src/daemon-client.ts`);
  const cfg = { distro: CFG.distro, wslHome: CFG.wslHome, cwd: CFG.cwd, profile: CFG.profile, proxyPort: 9910, backend: 'daemon', daemonPort: 8912, daemonPortTries: 2, daemonIdleMs: 1800000, daemonLingerMs: 600000, daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000 };
  await dcli.stopDaemon(cfg, { slot: 8912, log: () => {} });
  const r = await dcli.ensureDaemon(cfg, { version: '0.2.0-rc.2', log: () => {} });
  const pid = r.info?.daemonPid;
  console.log(`UNLOAD ensure ok=${r.ok} mode=${r.mode} pid=${pid}`);
  cap.disposer(); // ← 插件卸载路径（dispose）
  await new Promise((res) => setTimeout(res, 1500));
  const rec = dcli.readDaemonRecord(cfg, 8912);
  const hs = rec ? await dcli.handshake(cfg, rec.meta?.port ?? 8912, rec.token, 3000) : { ok: false };
  console.log(`UNLOAD after-dispose: daemonAlive=${hs.ok === true} pidSame=${String(hs.info?.daemonPid) === String(pid)} (${hs.info?.daemonPid})`);
  await dcli.stopDaemon(cfg, { slot: 8912, log: () => {} });
  process.exit(hs.ok === true && String(hs.info?.daemonPid) === String(pid) ? 0 : 1);
}

// smoke：面板四个动作 + wsl_status（真 deps）
const ex = await import(`file:///${root}/src/explorer.ts`);
const dcli = await import(`file:///${root}/src/daemon-client.ts`);
const hs = (await import(`file:///${root}/src/shell-env.ts`));
const ver = await import(`file:///${root}/src/version.ts`);
const { handlers } = ex.createExplorerHandlers({
  config: { ...CFG, daemonPort: 8912 },
  listDistros: () => ['debian-u8-1'],
  resolveVersion: () => ({ version: '0.2.0-rc.2', desktopVersion: '0.2.0-rc.2', pin: '0.2.0-rc.2', drift: null }),
  writePin: () => true,
  webHosts: new Map(),
  workspaceRegistry: () => undefined,
});
const brief = (o) => JSON.stringify(o).slice(0, 160);
const snap = await handlers['explorer.snapshot']({});
console.log(`SMOKE snapshot ok types: daemon=${brief(snap.daemon)}`);
const ld = await handlers['explorer.listDir']({ path: '/home/g' });
console.log(`SMOKE listDir entries=${ld.entries?.length} (前 3: ${(ld.entries ?? []).slice(0, 3).map((e) => e.name + '/' + e.kind).join(', ')})`);
const en = await handlers['explorer.daemon']({ action: 'ensure', slot: 8912 });
console.log(`SMOKE ensure ok=${en.ok} mode=${en.mode} warning=${en.warning === null ? 'null' : 'set'} pid=${en.pid}`);
const st = String(await tools.get('wsl_status').execute({}, { signal: new AbortController().signal }));
console.log(`SMOKE wsl_status lines=${st.split('\n').length} hasDaemonLine=${/^daemon:/m.test(st)}`);
const os = await handlers['explorer.openSession']({ path: '/home/g' });
console.log(`SMOKE openSession(no-warm，面板 P0 的真实调用) => ${JSON.stringify(os).slice(0, 200)}`);
const osw = await handlers['explorer.openSession']({ path: '/home/g', warm: true }); // 显式允许真起一轮
const wtxt = JSON.stringify(osw);
console.log(`SMOKE openSession(warm=true) => ${wtxt.slice(0, 260)}`);
const ok = 'sessionId' in os && os.created === false && typeof osw.sessionId === 'string' && osw.sessionId.length > 0 && osw.created === true;
console.log(`SMOKE 判定：no-warm 返回 sessionId 字段且 created=false + warm 真起一轮（sessionId 非空、created=true）= ${ok}`);
await handlers['explorer.daemon']({ action: 'stop', slot: 8912 });
process.exit(ok ? 0 : 1);
