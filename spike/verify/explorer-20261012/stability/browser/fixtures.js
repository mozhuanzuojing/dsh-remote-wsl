/* fixtures.js —— explorer.snapshot 的**合成夹具 + 响应闸门**（页面内，不改被验对象）。
 *
 * 用途：
 *   - ② 竞态：让每条 `/remote-wsl/api` 响应带上唯一 marker（`target.cwd='FIXTURE-SEQ-<n>'`、
 *     `daemon.version='fx-<n>'`），从而能判断 DOM 上显示的是**哪个 seq** 的结果；
 *   - ④ 边界：直接喂 200 行 / 长路径 / 60×200 行，不必真去改 WSL 侧配置；
 *   - ① 长跑：固定行数的夹具，保证 20 轮循环的 DOM 读数可比（否则噪声淹没泄漏信号）。
 *
 * 安装方式：**不自己包 fetch**，只把钩子挂到 window.__dsrw_fx__，由 instrument 的 fetch 包装层调用
 * （因此必须先装 instrument.js）。没装仪表就拒绝安装（无法记账 ⇒ 不能判定）。
 *
 * ★ 计时诚实性（2026-10-12 自查抓到的第二个自身缺陷）：
 *   若每次响应都现造 12000 行（夹具 C），造数 + JSON.stringify 的开销会落在 fetch 包装层里，
 *   被 ④ 的"首屏渲染耗时"计时窗**误算成面板的渲染成本**。因此本夹具：
 *     (a) `warm()` 先把大数组**建好并缓存**，`respond()` 只做浅层 patch（target.cwd / daemon.version / seq）；
 *     (b) `warm()` 另外单独测出「夹具构造耗时」与「pretty-print 后的大小」（= 面板 `<pre>` 里那份 JSON 的真实体积），
 *         两者都不计入渲染计时窗，但必须写进报告。
 *
 * 用法（本文件是 async 箭头函数表达式）：
 *   evaluate_script / execute_javascript：`(${本文件内容})({fixture:'A'})`
 *   之后 `window.__dsrw_fx__.warm('A')` / `.status()` / `.uninstall()`。
 *
 * 诚实原则：`snapshotHits=0`（没有任何 snapshot 请求被夹具接住）时，调用方必须判 **unknown**。
 * fixture 模式在 instrument 的请求记录里回显为 `source:'fixture'`。
 */
async ({ fixture = 'A', apiPath = '/remote-wsl/api' } = {}) => {
  const instr = window.__dsrw_instr__;
  if (!instr || instr.version !== 1) {
    return { ok: false, error: 'instrument-missing', hint: '先注入 browser/instrument.js（首选 initScript）' };
  }

  const LONG_SEG = 'a-very-long-directory-name-segment-for-wsl-boundary-test';
  const SPECS = {
    FIXED: { distros: 1, rows: 5, len: 60 },   // ① 长跑：固定规模
    TINY: { distros: 1, rows: 2, len: 40 },    // 冒烟
    A: { distros: 1, rows: 200, len: 60 },     // ④ A：1×200 常规路径
    B: { distros: 1, rows: 200, len: 300 },    // ④ B：1×200 极长路径
    C: { distros: 60, rows: 200, len: 60 }     // ④ C：60×200（O(n²) 风险）
  };

  const mkPath = (i, len) => {
    const base = '/home/g/project/';
    let p = base + 'pkg-' + String(i).padStart(4, '0') + '/';
    while (p.length < len) p += LONG_SEG.slice(0, Math.max(1, len - p.length - 1)) + '/';
    return p.slice(0, Math.max(len, base.length + 8));
  };

  /** 大数组缓存：key = fixture 名（避免每次响应重造） */
  const cache = new Map();

  const buildBig = (name) => {
    const spec = SPECS[name] || SPECS.A;
    const t0 = performance.now();
    const distros = [];
    for (let d = 0; d < spec.distros; d++) distros.push({ name: d === 0 ? 'debian-u8-1' : 'distro-' + d, default: d === 0, reachable: true });
    const workspaces = [];
    for (let d = 0; d < spec.distros; d++) {
      for (let i = 0; i < spec.rows; i++) {
        const path = mkPath(i, spec.len);
        workspaces.push({
          distro: distros[d].name,
          path,
          label: path.split('/').filter(Boolean).slice(-1)[0] || 'pkg-' + i,
          kind: i % 7 === 0 ? 'code-workspace' : 'folder'
        });
      }
    }
    const buildMs = Math.round(performance.now() - t0);
    // 与面板 `<pre>{JSON.stringify(snapshot,null,2)}` 同口径：pretty-print 后的字符数
    const probeObj = { distros, target: { distro: distros[0].name, wslHome: '/home/g', cwd: 'FIXTURE-SEQ-0' }, daemon: { running: true, slot: 8982, pid: 100000, version: 'fx-0', keys: ['k1', 'k2'], orphans: 0 }, drift: { drifted: false, desktop: '0.2.0-rc.2', pin: '0.2.0-rc.2' }, workspaces, webHosts: [] };
    let prettyBytes = null;
    let compactBytes = null;
    try {
      prettyBytes = JSON.stringify(probeObj, null, 2).length;
      compactBytes = JSON.stringify(probeObj).length;
    } catch (e) {
      prettyBytes = null;
    }
    const rec = { spec, distros, workspaces, buildMs, prettyBytes, compactBytes, warmedAt: Math.round(performance.now()) };
    cache.set(name, rec);
    return rec;
  };

  let seq = 0;
  const fx = {
    schema: 'dsrw-fixture/1',
    enabled: true,
    spoofStale: false, // A3 强制红开关：marker 故意写成上一个请求的
    fixture,
    apiPath,
    spec: SPECS[fixture] || SPECS.A,
    hits: 0,
    snapshotHits: 0,
    otherHits: 0,
    lastSeq: null,
    installedAt: new Date().toISOString(),
    markers: [],

    status() {
      const c = cache.get(fx.fixture) || null;
      return {
        enabled: fx.enabled,
        fixture: fx.fixture,
        spec: fx.spec,
        hits: fx.hits,
        snapshotHits: fx.snapshotHits,
        otherHits: fx.otherHits,
        lastSeq: fx.lastSeq,
        spoofStale: fx.spoofStale === true,
        markers: fx.markers.slice(-20),
        warmed: c !== null,
        warmedBuildMs: c ? c.buildMs : null,
        prettyBytes: c ? c.prettyBytes : null,
        rows: c ? c.workspaces.length : null,
        instrRevision: instr.version
      };
    },

    /** 预先造好并缓存（**在计时窗外**调用），返回夹具构造耗时与 pretty-print 体积 */
    warm(name) {
      const n = name || fx.fixture;
      const rec = buildBig(n);
      return { fixture: n, buildMs: rec.buildMs, rows: rec.workspaces.length, distros: rec.distros.length, pathLen: rec.spec.len, prettyBytes: rec.prettyBytes, compactBytes: rec.compactBytes };
    },

    uninstall() {
      fx.enabled = false;
      return fx.status();
    },

    reinstall(name) {
      fx.fixture = name || fx.fixture;
      fx.spec = SPECS[fx.fixture] || SPECS.A;
      if (!cache.has(fx.fixture)) buildBig(fx.fixture);
      fx.enabled = true;
      return fx.status();
    },

    /** 复用缓存的大数组，只 patch 外层 marker 字段（响应开销小且稳定） */
    makeSnapshot(n) {
      const c = cache.get(fx.fixture) || buildBig(fx.fixture);
      return {
        distros: c.distros,
        target: { distro: c.distros[0].name, wslHome: '/home/g', cwd: 'FIXTURE-SEQ-' + n },
        daemon: { running: true, slot: 8982, pid: 100000 + n, version: 'fx-' + n, keys: ['k1', 'k2'], orphans: 0 },
        drift: { drifted: false, desktop: '0.2.0-rc.2', pin: '0.2.0-rc.2' },
        workspaces: c.workspaces,
        webHosts: [],
        __fixture: { name: fx.fixture, seq: n, rows: c.workspaces.length, distros: c.distros.length, pathLen: c.spec.len, buildMs: c.buildMs }
      };
    },

    async respond(rec, init) {
      fx.hits++;
      let method = null;
      try {
        method = JSON.parse((init && init.body) || '').method;
      } catch {
        method = null;
      }
      if (method === 'explorer.snapshot') {
        fx.snapshotHits++;
        const fixtureSeq = ++seq;
        // ★ S11（2026-10-12 实盘抓到的**假红**）：marker 必须用**仪表记账的请求 seq**（rec.seq），
        //   不能用夹具自己的计数器 —— 两者起点不同（夹具晚于 apiSeq 开始计数），于是
        //   "DOM 显示的 marker ≠ 最后发出的 apiSeq" 会**误报 STALE-OVERWRITE**。
        //   我第一轮就是这样把一次**正确**的行为判成了竞态（正序/倒序两次都"命中"）。
        const marked = rec.seq !== null && rec.seq !== undefined ? rec.seq : fixtureSeq;
        // 强制红 A3：spoofStale=true 时把 marker 故意写成"上一个请求"的，模拟"旧响应覆盖新响应"的坏实现，
        //   用来证明本断言**有区分力**（不改被验对象）。
        const n = fx.spoofStale === true ? Math.max(1, marked - 1) : marked;
        fx.lastSeq = marked;
        fx.lastFixtureSeq = fixtureSeq;
        fx.markers.push({ reqSeq: marked, fixtureSeq, marker: n, spoofed: fx.spoofStale === true, at: Math.round(performance.now()), startedAt: Math.round(rec.startedAt) });
        return new Response(JSON.stringify({ ok: true, result: fx.makeSnapshot(n) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      fx.otherHits++;
      if (init && init.method === 'GET') {
        return new Response(JSON.stringify({ ok: true, methods: ['explorer.snapshot', 'explorer.openSession', 'explorer.daemon', 'explorer.fixPin'] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: false, error: 'fixture: 该方法未被合成（fixture 只合成 explorer.snapshot）' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  };

  if (window.__dsrw_fx__ && typeof window.__dsrw_fx__.uninstall === 'function') window.__dsrw_fx__.uninstall();
  window.__dsrw_fx__ = fx;
  const warmInfo = fx.warm(fixture); // 首次构造（**不计入任何渲染计时窗**）
  instr.mark('fixture:' + fixture);
  return { ok: true, status: fx.status(), warm: warmInfo, instr: { dom: instr.domCounts(), pending: instr.fetchSnapshot().pendingCount } };
}
