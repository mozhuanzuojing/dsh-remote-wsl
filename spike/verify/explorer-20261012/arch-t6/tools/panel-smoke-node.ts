/* panel-smoke-node.ts —— 拆 chunk 的**Node 级冒烟**（不起浏览器、不碰宿主）。
 *
 * 作用：用假的 `window.__ModuleLoader__` + 极简 React/DOM stub，**真的把 chunk 装载并执行一遍**：
 *   1) 每个 client.panel*.js 都必须能被 `__ModuleLoader__.load()` 注册（语法 + 装载面）
 *   2) 入口 chunk 的 `ready` 必须 resolve
 *   3) `createPanel(ctx, api, i18n)` 返回组件函数
 *   4) **调用该组件一次**（hooks 用 stub）⇒ 真跑 hooks/处理器定义/body 组装/JSX 渲染
 *      ⇒ 任何"自由变量没接上"都会在这里以 ReferenceError 的形式暴露（这正是拆 chunk 的头号事故）
 *
 * 用法：node panel-smoke-node.ts [插件根]
 * 退出码：0 全过；1 有失败
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.argv[2] || 'D:/project/dsh1/vendor/dsh-remote-wsl';
const CLIENT = path.join(ROOT, 'client');
const results = [];
const ok = (name, detail = '') => results.push({ ok: true, name, detail });
const bad = (name, detail = '') => results.push({ ok: false, name, detail });

// ───────── 最小 React stub（够跑一次渲染；hooks 语义够用） ─────────
const hookSeq = [];
const React = {
  createElement(type, props, ...children) {
    return { $$typeof: 'el', type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  useState(init) { const v = typeof init === 'function' ? init() : init; return [v, () => {}]; },
  useRef(init) { return { current: init }; },
  useCallback(fn) { return fn; },
  useMemo(fn) { return fn(); },
  useEffect() {},
  useReducer(reducer, init) { return [init, () => {}]; },
  Fragment: Symbol('Fragment'),
  createContext(v) { return { Provider: 'Provider', Consumer: 'Consumer', _v: v }; },
};

// ───────── 最小 DOM / 浏览器面 stub ─────────
const listeners = [];
const el = () => ({ addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, focus: () => {}, style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false }, appendChild: () => {}, removeChild: () => {}, getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0 }), scrollWidth: 100, clientWidth: 100, querySelector: () => null, querySelectorAll: () => [], contains: () => false, dataset: {} });
const document = {
  addEventListener: (t, f) => listeners.push([t, f]),
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => el(),
  body: el(),
  documentElement: el(),
  activeElement: el(),
  visibilityState: 'visible',
};
const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const window = {
  addEventListener: (t, f) => listeners.push([t, f]),
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(() => f(Date.now()), 0),
  localStorage, location: { href: 'http://127.0.0.1:8921/' }, navigator: { clipboard: { writeText: async () => {} } },
  __ModuleLoader__: null,
};

// ───────── 假 loader：注册 + 同步/异步装载 ─────────
const registry = new Map();   // chunk 名 -> factory
const loadedMods = new Map(); // chunk 名 -> exports
const pending = new Map();    // chunk 名 -> Promise

const evaluateChunkFile = (fileName) => {
  const p = path.join(CLIENT, fileName);
  if (!fs.existsSync(p)) throw new Error(`chunk 文件不存在：${fileName}`);
  const code = fs.readFileSync(p, 'utf8');
  vm.runInNewContext(code, { window, document, localStorage, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Symbol, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, AbortController, fetch: async () => { throw new Error('smoke: fetch 不应在渲染期被调用'); }, TextEncoder, URL, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, undefined: undefined, globalThis: undefined }, { filename: p });
};

const makeRequire = (ownerChunk) => {
  const req = (spec) => {
    if (spec === 'react') return React;
    // 平台种子表里的其它 specifier 本冒烟不支持
    throw new Error(`${ownerChunk}: require("${spec}") 不在冒烟支持范围内`);
  };
  req.async = async (spec) => {
    if (!spec.startsWith('./')) throw new Error(`${ownerChunk}: 只支持相对 chunk 装载，收到 ${spec}`);
    const fileName = spec.slice(2);
    if (pending.has(fileName)) return pending.get(fileName);
    const pr = Promise.resolve().then(() => {
      if (loadedMods.has(fileName)) return loadedMods.get(fileName);
      evaluateChunkFile(fileName);
      const f = registry.get(fileName);
      if (!f) throw new Error(`chunk ${fileName} 未通过 __ModuleLoader__.load 注册`);
      const exp = f(req2(fileName));
      loadedMods.set(fileName, exp);
      return exp;
    });
    pending.set(fileName, pr);
    return pr;
  };
  return req;
};
// 每个 chunk 自己的 require（chunk: 名用于报错）
const req2 = (name) => makeRequire(name);

window.__ModuleLoader__ = {
  load(def) {
    registry.set(def.chunk || '__entry__', def.factory);
  },
};

// ───────── 跑冒烟 ─────────
try {
  // 入口 = client.panel.js（必须存在且有 chunk 标记）
  evaluateChunkFile('client.panel.js');
  const entryFactory = registry.get('client.panel.js');
  if (!entryFactory) { bad('入口注册', 'client.panel.js 未注册 chunk="client.panel.js"'); }
  else ok('入口注册', 'chunk="client.panel.js" 已注册');

  const entry = entryFactory(req2('client.panel.js'));
  ok('入口导出面', Object.keys(entry).join(','));

  if (typeof entry.createPanel !== 'function') bad('createPanel 是函数', `实得 ${typeof entry.createPanel}`);
  else ok('createPanel 是函数');

  if (typeof entry.whenReady === 'function') {
    await entry.whenReady();
    ok('whenReady() resolve（子 chunk 全部装载）');
  } else if (entry.ready && typeof entry.ready.then === 'function') {
    await entry.ready;
    ok('ready resolve（子 chunk 全部装载）');
  } else ok('无子 chunk（薄入口无需 whenReady）');

  const ctx = { get: () => undefined, slots: { register: () => {}, inject: () => {} }, logger: { info: () => {} } };
  const api = {
    route: '/remote-wsl/api',
    methods: { snapshot: 'explorer.snapshot' },
    daemonActions: ['ensure', 'stop', 'restart'],
    timeoutMs: 9000,
    snapshot: async () => ({ distros: [{ name: 'debian-u8-1', default: true, reachable: true }], target: { distro: 'debian-u8-1', cwd: '/home/g' }, daemon: { running: false, keys: [] }, drift: { drifted: false }, workspaces: [{ distro: 'debian-u8-1', path: '/home/g/p', label: 'p', kind: 'folder' }], webHosts: [] }),
    probe: async () => [],
  };
  const i18n = { t: (k, vars) => k, subscribe: () => () => {} };
  const Panel = entry.createPanel(ctx, api, i18n);
  if (typeof Panel !== 'function') bad('createPanel 返回组件函数', typeof Panel);
  else ok('createPanel 返回组件函数');

  // 真调一次组件：hooks/渲染/body 组装全跑
  const tree = Panel();
  if (!tree || !tree.type) bad('组件渲染出根元素', JSON.stringify(tree)?.slice(0, 120));
  else {
    ok('组件渲染出根元素', `type=${String(tree.type)}`);
    const flat = [];
    const walk = (n) => { if (!n) return; if (n.$$typeof === 'el') { flat.push(String(n.type)); (n.children || []).forEach(walk); } };
    walk(tree);
    const uniq = [...new Set(flat)];
    ok('渲染树元素类型', `${flat.length} 个节点 / ${uniq.length} 种：${uniq.slice(0, 14).join(',')}`);
    for (const must of ['section', 'footer', 'header']) {
      if (uniq.includes(must)) ok(`渲染含 <${must}>`);
      else bad(`渲染含 <${must}>`, '未出现');
    }
  }
} catch (e) {
  bad('冒烟执行', `${e && e.message}\n${(e && e.stack || '').split('\n').slice(0, 4).join('\n')}`);
}

// ───────── 行数门禁（顺带报） ─────────
const panelFiles = fs.readdirSync(CLIENT).filter((f) => /^client\.panel.*\.js$/.test(f)).sort();
for (const f of panelFiles) {
  const n = fs.readFileSync(path.join(CLIENT, f), 'utf8').split('\n').length - 1;
  const line = `${f} = ${n} 行`;
  if (n < 400) ok('行数 <400', line); else bad('行数 <400', line);
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  —— ' + r.detail.replace(/\n/g, ' | ') : ''}`);
const fails = results.filter((r) => !r.ok);
console.log(`\npanel-smoke-node: ${results.length - fails.length}/${results.length} PASS`);
process.exit(fails.length ? 1 : 0);
