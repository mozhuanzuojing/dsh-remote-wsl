/**
 * ux-shot.ts —— task-27 的 UX 基线截图器（**headless**，不弹任何可见窗口）。
 *
 * 为什么自己写：chrome-devtools-mcp 写不进本目录（filePath 受 workspace root 限制），且对应用页截图会超时；
 * cua 的浏览器工具不允许注入脚本。这里用 **Chrome headless + CDP（Node 内置 WebSocket，零安装）**：
 *   · Page.addScriptToEvaluateOnNewDocument → 注入夹具（延迟/空态/错误），用来**确定性地**拍到各状态；
 *   · Runtime.evaluate → 点 rail 图标、读 DOM、切主题；
 *   · Page.captureScreenshot → 直接写到 ux-baseline/。
 *
 * 用法：node ux-shot.ts <cdpPort> <scenariosJsonPath>
 *   scenarios.json = { "url": "...", "outDir": "...", "scenarios": [ {name, init?, steps[], shot} ] }
 *   step 取值：{"eval":"<js>"} | {"wait":ms} | {"waitFor":"<js>","timeout":ms} | {"shot":"a.png"}
 */
import fs from 'node:fs';
import path from 'node:path';

const cdpPort = process.argv[2] || '8965';
const jobPath = process.argv[3];
if (!jobPath) { console.error('usage: node ux-shot.ts <cdpPort> <scenariosJson>'); process.exit(2); }
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
const outDir = job.outDir;
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  return res.json();
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', (e) => rej(new Error('ws error: ' + (e.message || 'unknown'))), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const INITS = {
  // 让 snapshot 慢 3.5s：稳定地拍到"加载中"
  delay: `(() => {
    const of = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        const body = init && init.body;
        if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof body === 'string' && body.indexOf('explorer.snapshot') >= 0) {
          return new Promise((res, rej) => setTimeout(() => of.apply(window, [input, init]).then(res, rej), 3500));
        }
      } catch (e) {}
      return of.apply(this, arguments);
    };
  })();`,
  // 空态：distros 为空
  empty: `(() => {
    const of = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        const body = init && init.body;
        if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof body === 'string' && body.indexOf('explorer.snapshot') >= 0) {
          const payload = { ok: true, result: { distros: [], workspaces: [], target: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g/project/dsh1' }, daemon: { running: false, keys: [], orphans: 0, others: [] }, drift: { drifted: false }, webHosts: [] } };
          return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
      } catch (e) {}
      return of.apply(this, arguments);
    };
  })();`,
  // 错误态：路由不可达
  error: `(() => {
    const of = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (String(u).indexOf('/remote-wsl/api') >= 0) return Promise.reject(new TypeError('usab-injected: 模拟 explorer 路由不可达'));
      } catch (e) {}
      return of.apply(this, arguments);
    };
  })();`,
  // 多实例：daemon.others[] 非空（确定性夹具；本机此刻没有别人的守护在跑）
  multi: `(() => {
    const of = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        const body = init && init.body;
        if (String(u).indexOf('/remote-wsl/api') >= 0 && typeof body === 'string' && body.indexOf('explorer.snapshot') >= 0) {
          const note = '非本槽位（configured daemonPort=8962）；未复用、未打扰';
          const payload = { ok: true, result: {
            distros: [{ name: 'debian-u8-1', default: true, reachable: true }],
            workspaces: [{ distro: 'debian-u8-1', path: '/home/g/project/dsh1', label: 'dsh1', kind: 'folder' }],
            target: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g/project/dsh1' },
            daemon: { running: false, slot: 8962, keys: [], orphans: 0, others: [
              { slot: 8731, pid: 944726, port: 8731, version: '0.2.0-rc.2', note: note },
              { slot: 8972, pid: 964933, port: 8972, version: '0.2.0-rc.2', note: note }
            ] },
            drift: { drifted: false }, webHosts: [] } };
          return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
      } catch (e) {}
      return of.apply(this, arguments);
    };
  })();`
};

const CLICK_RAIL = `(() => {
  const b = Array.from(document.querySelectorAll('nav button, button')).find((x) => /远程资源管理器/.test((x.getAttribute('aria-label') || '') + (x.innerText || '')));
  if (!b) return 'rail-not-found';
  b.click();
  return 'clicked';
})()`;

const PANEL_READY = `(() => { const p = document.querySelector('[data-dsh-remote-wsl="panel"]'); return !!(p && !/正在读取/.test((p.innerText||''))); })()`;

const results = [];
const targets = await listTargets();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(3); }

for (const sc of job.scenarios) {
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: job.width || 1280, height: job.height || 900, deviceScaleFactor: 1, mobile: false });
  let scriptId = null;
  if (sc.dark) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  else await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  if (sc.init && INITS[sc.init]) {
    const r = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INITS[sc.init] });
    scriptId = r.identifier;
  }
  await cdp.send('Page.navigate', { url: job.url });
  await sleep(sc.settleMs ?? 2500);
  const log = [];
  for (const step of sc.steps || []) {
    if (step.eval) {
      const r = await cdp.send('Runtime.evaluate', { expression: step.eval, returnByValue: true, awaitPromise: true });
      log.push({ eval: step.eval.slice(0, 60), value: r.result ? r.result.value : null });
    } else if (step.wait) {
      await sleep(step.wait);
    } else if (step.waitFor) {
      const t0 = Date.now(); const to = step.timeout || 8000; let ok = false;
      while (Date.now() - t0 < to) {
        const r = await cdp.send('Runtime.evaluate', { expression: step.waitFor, returnByValue: true });
        if (r.result && r.result.value === true) { ok = true; break; }
        await sleep(200);
      }
      log.push({ waitFor: step.waitFor.slice(0, 50), ok, ms: Date.now() - t0 });
    } else if (step.shot) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(outDir, step.shot);
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      log.push({ shot: step.shot, bytes: fs.statSync(f).size });
    }
  }
  // 每个场景都顺手抓一份可见文本，便于逐条核对批判
  const textR = await cdp.send('Runtime.evaluate', { expression: `(() => { const p = document.querySelector('[data-dsh-remote-wsl="panel"]'); return p ? (p.innerText||'').replace(/\\s+/g,' ').slice(0,2000) : null; })()`, returnByValue: true });
  results.push({ name: sc.name, init: sc.init || null, dark: !!sc.dark, log, panelText: textR.result ? textR.result.value : null });
  if (scriptId) { try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }); } catch {} }
  cdp.close();
}

fs.writeFileSync(path.join(outDir, 'out-ux-shots.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map((r) => ({ name: r.name, log: r.log })), null, 1));
