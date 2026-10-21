#!/usr/bin/env node
/**
 * probe-selector.ts —— 「目标发行版」选择器的渲染断言（多发行版才出下拉，单发行版只给静态徽标）。
 *
 * 为什么单独写：这是纯客户端渲染分支，panel-smoke-node 只渲染"加载中"一态（factsVisible=false），
 * 覆盖不到头部 meta 里的选择器。这里用最小 React stub 直接调 renderTail()，只断言**元素树**，
 * 不起浏览器、不碰宿主、不发请求。
 *
 * 用法：node probe-selector.ts
 * 产出：out-selector.json（本目录）；退出码 0=全过，1=有断言失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../../..');
const CLIENT = path.join(ROOT, 'client');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

const React = {
  createElement(type, props, ...children) {
    return { $$typeof: 'el', type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  Fragment: Symbol('Fragment'),
};
const storage = new Map();
const window = {
  __ModuleLoader__: null,
  addEventListener: () => {}, removeEventListener: () => {},
  localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
};
const document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible', createElement: () => ({}) };

const registry = new Map();
window.__ModuleLoader__ = { load(def) { registry.set(def.chunk, def.factory); } };
const code = fs.readFileSync(path.join(CLIENT, 'client.panel.tail.js'), 'utf8');
vm.runInNewContext(code, { window, document, console, setTimeout, clearTimeout, Promise, Symbol, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, localStorage: window.localStorage }, { filename: 'client.panel.tail.js' });

const factory = registry.get('client.panel.tail.js');
if (!factory) { console.error('client.panel.tail.js 未注册'); process.exit(1); }
const mod = factory(() => ({ exports: {} }));
const renderTail = mod.renderTail;
check('renderTail 是函数', typeof renderTail === 'function', String(typeof renderTail));

const mkProps = (distros, targetDistro, chosen) => ({
  HIDE_UPDATED_PX: 720, NARROW_PX: 420, RECENT_KEY: 'k', RECENT_MAX: 8,
  React, StatusDot: () => null, action: { busy: null, note: null, detail: null, error: null }, actionAbort: { current: null },
  actionFailure: () => '', actionFailureText: () => '', activeDistro: targetDistro,
  addWorkspaceErrorText: () => '', addWorkspaceNote: () => '', api: { daemon: async () => ({}), addWorkspace: async () => ({}) },
  asArray: (v) => (Array.isArray(v) ? v : []), body: [], breadcrumbOf: () => [], browse: { cwd: '/home/x' },
  browseAbort: { current: null }, browseSeq: { current: 0 }, cancelRef: { current: null }, clock: () => '', closeMenu: () => {},
  collapsed: {}, ctx: {}, cwd: '/home/x', cwdDiffersFromTarget: false, daemon: { running: false, keys: [] },
  daemonKnown: true, daemonNote: () => '', daemonSlot: 8972, distros, drift: { drifted: false }, driftKnown: true,
  errorText: () => '', factsVisible: true, focusIndex: -1, forceLocale: () => {}, headerButtons: [], hiddenCount: 0,
  hideUpdated: false, homePathOf: () => '/home/x', icon: () => null, isRecord: (v) => !!v && typeof v === 'object',
  joinWslPath: (a, b) => a + '/' + b, jumpTo: () => {}, keys: [], keysKnown: true, lastRun: { current: null },
  listPath: () => {}, load: () => {}, menuOpen: false, menuRef: { current: null }, moreRef: { current: null },
  mounts: [], mountsCache: null, mountsProbed: { current: false }, narrow: false, newAbortController: () => ({}),
  normalizeWslPath: (p) => p, onMenuKey: () => {}, openSessionNote: () => '', others: [], pathError: null, pathInput: '/home/x',
  pending: null, pendingFrom: { current: null }, primaryBusyKey: '', primaryIsSession: false, pushRecent: () => [],
  readAbort: { current: null }, readRecent: () => [], readSeq: { current: 0 }, recent: [], recentOk: true, rootRef: { current: null },
  run: () => {}, runDaemon: () => {}, setAction: () => {}, setBrowse: () => {}, setCollapsed: () => {}, setFocusIndex: () => {},
  setMenuOpen: () => {}, setMounts: () => {}, setPathError: () => {}, setPathInput: () => {}, setPending: () => {},
  setRecent: () => {}, setRecentOk: () => {}, setShowHidden: () => {}, setSlow: () => {}, setState: () => {}, setWidth: () => {},
  showHidden: false, signalOf: () => ({}), slow: false, snapshot: {}, splitFirstSentence: (s) => s, splitHumanText: (s) => s,
  state: { status: 'ready', snapshot: {}, error: null, lastSuccessAt: null, lastFailureAt: null }, submitPath: () => {},
  t: (key, vars) => key + (vars ? ':' + JSON.stringify(vars) : ''), target: { distro: targetDistro, cwd: '/home/x', wslHome: '/home' },
  visibleEntries: [], width: 900, chosenDistro: chosen, onDistroChange: (name) => { calls.push(name); },
});
const calls = [];

const collect = (node, out) => {
  if (!node || typeof node !== 'object') return out;
  if (node.$$typeof === 'el') { out.push(node); (node.children || []).forEach((c) => collect(c, out)); }
  return out;
};
const flatText = (node) => {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(flatText).join('');
};

// ── 场景 1：两个发行版 ⇒ 下拉 ────────────────────────────────────────────────
const two = mkProps([{ name: 'debian-u8-1', default: true, reachable: true }, { name: 'Ubuntu-24.04', default: false, reachable: false }], 'debian-u8-1', null);
const tree2 = renderTail(two);
const nodes2 = collect(tree2, []);
const selects = nodes2.filter((n) => n.type === 'select');
const options = nodes2.filter((n) => n.type === 'option');
check('两发行版：出现 select', selects.length === 1, 'count=' + selects.length);
check('两发行版：选项数 = 2', options.length === 2, 'count=' + options.length);
check('两发行版：当前值 = 目标发行版', selects[0] && selects[0].props.value === 'debian-u8-1', selects[0] ? String(selects[0].props.value) : 'n/a');
check('两发行版：可访问标签存在', selects[0] && typeof selects[0].props['aria-label'] === 'string' && selects[0].props['aria-label'].length > 0);
const optionText = options.map(flatText).join(' | ');
check('两发行版：选项带运行态', optionText.indexOf('header.distroRunning') >= 0 && optionText.indexOf('header.distroStopped') >= 0, optionText);
// 触发 onChange 应回调选中的名字
if (selects[0]) selects[0].props.onChange({ target: { value: 'Ubuntu-24.04' } });
check('切换回调带新发行版', calls[0] === 'Ubuntu-24.04', JSON.stringify(calls));

// ── 场景 2：单个发行版 ⇒ 静态徽标，没有死下拉 ─────────────────────────────────
const one = mkProps([{ name: 'debian-u8-1', default: true, reachable: true }], 'debian-u8-1', null);
const tree1 = renderTail(one);
const nodes1 = collect(tree1, []);
check('单发行版：不出现 select', nodes1.filter((n) => n.type === 'select').length === 0);
const hints = nodes1.filter((n) => n.type === 'span' && n.props && n.props.className === 'dsh-rw-hint');
const onlyHint = hints.map(flatText).find((text) => text.indexOf('header.distroOnly') >= 0);
check('单发行版：给出静态说明（含发行版名）', typeof onlyHint === 'string' && onlyHint.indexOf('debian-u8-1') >= 0, String(onlyHint));

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-selector.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
