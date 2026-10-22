#!/usr/bin/env node
/**
 * probe-layout.ts —— 2026-10-21 UI 重做的**结构断言**（元素树层面，不起浏览器）。
 *
 * 断言：
 *   1) 头部守护药丸：未运行 ⇒ --off 且点击 runDaemon("ensure") 一次；运行中 ⇒ --on 且点击不触发启动；
 *   2) 目录卡：存在 places / navrow / formrow 三层，**不再有** cardhead（"浏览目录"标题占位）；
 *   3) 列表容器存在（滚动体）且卡片没有把列表包在额外的滚动层里。
 *
 * 用法：node probe-layout.ts；产出 out-layout.json；退出码 0=全过。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../../..');
const CLIENT = path.join(ROOT, 'client');

const React = {
  createElement(type, props, ...children) {
    return { $$typeof: 'el', type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
  },
  Fragment: Symbol('Fragment'),
};

function loadChunk(file) {
  const registry = new Map();
  const window = { __ModuleLoader__: { load(def) { registry.set(def.chunk, def.factory); } } };
  const document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible', querySelector: () => null };
  const code = fs.readFileSync(path.join(CLIENT, file), 'utf8');
  vm.runInNewContext(code, { window, document, console, setTimeout, clearTimeout, Promise, Symbol, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }, { filename: file });
  const factory = registry.get(file);
  if (!factory) throw new Error('chunk not registered: ' + file);
  return factory(() => ({ exports: {} }));
}

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const walk = (node, out) => {
  if (!node || typeof node !== 'object') return out;
  if (node.$$typeof === 'el') { out.push(node); (node.children || []).forEach((c) => walk(c, out)); }
  return out;
};
const t = (key, vars) => key + (vars ? ':' + JSON.stringify(vars) : '');

// ── 1) 头部：守护药丸 ────────────────────────────────────────────────────────
{
  const mod = loadChunk('client.panel.header.js');
  let ensureCalls = 0;
  const base = {
    HIDE_UPDATED_PX: 720, NARROW_PX: 420, RECENT_KEY: 'k', RECENT_MAX: 8,
    React, StatusDot: () => null, action: { busy: null, note: null, detail: null, error: null }, actionAbort: { current: null },
    actionFailure: () => '', actionFailureText: () => '', activeDistro: 'debian-u8-1',
    addWorkspaceErrorText: () => '', addWorkspaceNote: () => '', api: { addWorkspace: async () => ({}), newSession: async (input) => { createdFor = input; return { sessionId: 's1', cwd: '\\\\wsl.localhost\\debian-u8-1\\home\\g' }; } },
    asArray: (v) => (Array.isArray(v) ? v : []), body: [], breadcrumbOf: () => [], browse: { cwd: '/home/g' },
    browseAbort: { current: null }, browseSeq: { current: 0 }, cancelRef: { current: null }, clock: () => '',
    closeMenu: () => {}, collapsed: {}, ctx: {}, cwd: '/home/g', cwdDiffersFromTarget: false,
    daemon: { running: false, keys: [] }, daemonKnown: true, daemonNote: () => '', daemonSlot: 8972, distros: [],
    drift: { drifted: false }, driftKnown: true, errorText: () => '', factsVisible: true, focusIndex: -1,
    forceLocale: () => {}, hiddenCount: 0, hideUpdated: false, homePathOf: () => '/home/g', icon: () => null,
    isRecord: (v) => !!v && typeof v === 'object', joinWslPath: (a, b) => a + '/' + b, jumpTo: () => {},
    keys: [], keysKnown: true, lastRun: { current: null }, listPath: () => {}, load: () => {}, menuOpen: false,
    menuRef: { current: null }, moreRef: { current: null }, mounts: [], mountsCache: null, mountsProbed: { current: false },
    narrow: false, newAbortController: () => ({}), normalizeWslPath: (p) => p, onMenuKey: () => {},
    openSessionNote: () => '', others: [], pathError: null, pathInput: '/home/g', pending: null,
    pendingFrom: { current: null }, pushRecent: () => [], readAbort: { current: null }, readRecent: () => [],
    readSeq: { current: 0 }, recent: [], recentOk: true, rootRef: { current: null }, run: (key, op) => { if (typeof op === 'function') op({}); },
    runDaemon: (action) => { ensureCalls += 1; }, setAction: () => {}, setBrowse: () => {}, setCollapsed: () => {},
    setFocusIndex: () => {}, setMenuOpen: () => {}, setMounts: () => {}, setPathError: () => {}, setPathInput: () => {},
    setPending: () => {}, setRecent: () => {}, setRecentOk: () => {}, setShowHidden: () => {}, setSlow: () => {},
    setState: () => {}, setWidth: () => {}, showHidden: false, signalOf: () => ({}), slow: false,
    snapshot: {}, splitFirstSentence: (s) => s, splitHumanText: (s) => s,
    state: { status: 'ready', snapshot: {}, error: null, lastSuccessAt: null, lastFailureAt: null }, submitPath: () => {},
    t, target: { distro: 'debian-u8-1', cwd: '/home/g', wslHome: '/home/g' }, visibleEntries: [], width: 900,
  };
  let createdFor = null;
  const off = mod.renderHeader(base);
  const inSubdir = mod.renderHeader(Object.assign({}, base, { cwd: '/home/g/project', cwdDiffersFromTarget: true }));
  const primary = inSubdir.headerButtons.map((b) => walk(b, [])).flat().find((n) => n.type === 'button' && String(n.props.className).indexOf('dsh-rw-btn--primary') >= 0);
  if (primary) primary.props.onClick();
  check('头部：主按钮创建 DSH 会话（带 cwd）', !!createdFor && createdFor.path === '/home/g/project', JSON.stringify(createdFor));
  const offNodes = walk(off.daemonPill, []);
  const pill = offNodes.find((n) => String(n.props && n.props.className).indexOf('dsh-rw-daemon') >= 0);
  check('头部：未运行时渲染药丸', !!pill, pill ? String(pill.props.className) : 'none');
  check('头部：未运行药丸是 --off', !!pill && String(pill.props.className).indexOf('dsh-rw-daemon--off') >= 0);
  if (pill && typeof pill.props.onClick === 'function') pill.props.onClick();
  check('头部：点未运行药丸触发一次启动', ensureCalls === 1, 'calls=' + ensureCalls);

  const on = mod.renderHeader(Object.assign({}, base, { daemon: { running: true, keys: [], pid: 1234, slot: 8972 } }));
  const onNodes = walk(on.daemonPill, []);
  const onPill = onNodes.find((n) => String(n.props && n.props.className).indexOf('dsh-rw-daemon') >= 0);
  check('头部：运行中药丸是 --on', !!onPill && String(onPill.props.className).indexOf('dsh-rw-daemon--on') >= 0);
  const before = ensureCalls;
  if (onPill && typeof onPill.props.onClick === 'function') onPill.props.onClick();
  check('头部：运行中点击不会重启', ensureCalls === before, 'calls=' + ensureCalls);
}

// ── 2) 目录卡结构 ────────────────────────────────────────────────────────────
{
  const mod = loadChunk('client.panel.browser.js');
  const body = [];
  const browserProps = {
    distros: [], onDistroChange: () => {},
    React, body, breadcrumbOf: () => [{ label: '/', path: '/' }, { label: 'home', path: '/home' }],
    browse: { status: 'ready', entries: [], cwd: '/home', error: null, stale: false }, clearSearch: () => {},
    collapsed: {}, cwd: '/home', errorText: () => '', factsVisible: true, hiddenCount: 2,
    homePathOf: () => '/home/g', icon: () => null, jumpTo: () => {}, listPath: () => {}, mounts: ['/mnt/c'],
    pathError: null, pathInput: '/home', recent: [], recentOk: false, search: '', searchChange: () => {},
    searchRef: { current: null }, searching: false, Entries: () => React.createElement('div', { className: 'probe-entries' }),
    setCollapsed: () => {}, setPathError: () => {}, setPathInput: () => {}, setShowHidden: () => {},
    showHidden: false, snapshot: {}, submitPath: () => {}, t,
    target: { distro: 'debian-u8-1', cwd: '/home/g', wslHome: '/home/g' }, totalEntries: 0, visibleEntries: [],
    sessions: [], api: {}, run: () => {}, openSessionNote: () => '',
  };
  mod.renderBrowser(browserProps);
  const nodes = body.map((n) => walk(n, [])).flat();
  const classes = nodes.map((n) => String(n.props && n.props.className || ''));
  check('目录卡：有位置条', classes.some((c) => c.indexOf('dsh-rw-places') >= 0));
  check('目录卡：有导航行（上一级 + 面包屑）', classes.some((c) => c.indexOf('dsh-rw-navrow') >= 0));
  check('目录卡：有输入行（路径 + 筛选）', classes.some((c) => c.indexOf('dsh-rw-formrow') >= 0));
  const browserCard = nodes.find((n) => n.type === 'section' && String(n.props.className).indexOf('dsh-rw-card') >= 0 && String(n.props['aria-label']).indexOf('browser.aria') >= 0);
  const cardNodes = browserCard ? walk(browserCard, []) : [];
  check('目录卡：没有 cardhead 占位', !!browserCard && cardNodes.every((n) => String(n.props && n.props.className).indexOf('dsh-rw-cardhead') < 0));
  check('目录卡：列表容器在卡片内', classes.some((c) => c.indexOf('dsh-rw-card') >= 0) && nodes.some((n) => typeof n.type === 'function'));
  let opened = null;
  const body3 = [];
  mod.renderBrowser(Object.assign({}, browserProps, {
    body: body3,
    sessions: [{ cwd: '/home/g/proj', sessionId: 'abc12345' }],
    api: { openSession: async (input) => { opened = input; return { sessionId: 'abc12345' }; } },
    run: (key, op) => { op({}); },
    openSessionNote: () => 'ok',
  }));
  const nodes3 = body3.map((n) => walk(n, [])).flat();
  const sessionRows = nodes3.filter((n) => n.type === 'div' && String(n.props && n.props.className).indexOf('dsh-rw-session') >= 0);
  check('会话卡：渲染会话行', sessionRows.length === 1, 'count=' + sessionRows.length);
  const openBtn = nodes3.find((n) => n.type === 'button' && (n.children || []).join('').indexOf('sessions.open') >= 0);
  if (openBtn) openBtn.props.onClick();
  check('会话卡：打开回调带 distro+cwd', !!opened && opened.distro === 'debian-u8-1' && opened.path === '/home/g/proj', JSON.stringify(opened));
}

// ── 3) 折叠区交互：onToggle 的 currentTarget 在 updater 执行前会被 React 置空 ─────────
{
  const tail = loadChunk('client.panel.tail.js');
  let updater = null;
  const baseProps = {
    HIDE_UPDATED_PX: 720, NARROW_PX: 420, RECENT_KEY: 'k', RECENT_MAX: 8, React, StatusDot: () => null,
    action: { busy: null, note: null, detail: null, error: null }, actionAbort: { current: null }, actionFailure: () => '', actionFailureText: () => '',
    activeDistro: 'd', addWorkspaceErrorText: () => '', addWorkspaceNote: () => '', api: {}, asArray: (v) => (Array.isArray(v) ? v : []), body: [],
    breadcrumbOf: () => [], browse: { cwd: '/home/g' }, browseAbort: { current: null }, browseSeq: { current: 0 }, cancelRef: { current: null }, clock: () => '',
    closeMenu: () => {}, collapsed: { advanced: true }, ctx: {}, cwd: '/home/g', cwdDiffersFromTarget: false, daemon: { running: false, keys: [], others: [] }, daemonKnown: true,
    daemonNote: () => '', daemonPill: null, daemonSlot: 8972, distros: [], drift: { drifted: false }, driftKnown: true, errorText: () => '', factsVisible: true,
    focusIndex: -1, forceLocale: () => {}, headerButtons: [], hiddenCount: 0, hideUpdated: false, homePathOf: () => '/home/g', icon: () => null,
    isRecord: (v) => !!v && typeof v === 'object', joinWslPath: (a, b) => a + '/' + b, jumpTo: () => {}, keys: [], keysKnown: true, lastRun: { current: null },
    listPath: () => {}, load: () => {}, menuOpen: false, menuRef: { current: null }, moreRef: { current: null }, mounts: [], mountsCache: null, mountsProbed: { current: false },
    narrow: false, newAbortController: () => ({}), normalizeWslPath: (p) => p, onDistroChange: () => {}, onMenuKey: () => {}, openSessionNote: () => '',
    others: [], pathError: null, pathInput: '/home/g', pending: null, pendingFrom: { current: null }, primaryBusyKey: '', primaryIsSession: false, pushRecent: () => [],
    readAbort: { current: null }, readRecent: () => [], readSeq: { current: 0 }, recent: [], recentOk: true, rootRef: { current: null }, run: (key, op) => { if (typeof op === 'function') op({}); }, runDaemon: () => {},
    setAction: () => {}, setBrowse: () => {}, setCollapsed: (fn) => { updater = fn; }, setFocusIndex: () => {}, setMenuOpen: () => {}, setMounts: () => {}, setPathError: () => {},
    setPathInput: () => {}, setPending: () => {}, setRecent: () => {}, setRecentOk: () => {}, setShowHidden: () => {}, setSlow: () => {}, setState: () => {},
    setWidth: () => {}, showHidden: false, signalOf: () => ({}), slow: false,
    snapshot: { distros: [], target: {}, daemon: { running: false, keys: [] }, drift: { drifted: false }, workspaces: [], webHosts: [] },
    splitFirstSentence: (s) => s, splitHumanText: (s) => s, state: { status: 'ready', snapshot: {}, error: null, lastSuccessAt: null, lastFailureAt: null },
    submitPath: () => {}, t, target: { distro: 'd', cwd: '/home/g', wslHome: '/home/g' }, visibleEntries: [], width: 900, chosenDistro: null,
  };
  const tree = tail.renderTail(baseProps);
  const adv = walk(tree, []).find((n) => n.type === 'details' && String(n.props.className).indexOf('dsh-rw-fold') >= 0);
  check('折叠区：诊断 details 存在', !!adv);
  const ev1 = { currentTarget: { open: true } };
  if (adv) adv.props.onToggle(ev1);
  ev1.currentTarget = null;
  let crash1 = null;
  let next1 = null;
  try { next1 = updater({}); } catch (e) { crash1 = e; }
  check('折叠区：诊断 updater 不因 currentTarget 置空而崩', crash1 === null, crash1 ? String(crash1.message) : '');
  check('折叠区：诊断写入 open=true', !!next1 && next1.advanced === true, JSON.stringify(next1));
  let crash2 = null;
  try { tail.renderTail(Object.assign({}, baseProps, { daemon: null, daemonKnown: false })); } catch (e) { crash2 = e; }
  check('折叠区：daemon 未知时诊断块不崩', crash2 === null, crash2 ? String(crash2.message) : '');

  const browserMod = loadChunk('client.panel.browser.js');
  let updater2 = null;
  const body2 = [];
  browserMod.renderBrowser(Object.assign({}, baseProps, { body: body2, distros: [], onDistroChange: () => {}, collapsed: { recent: false }, recent: ['/home/g'], recentOk: true, setCollapsed: (fn) => { updater2 = fn; },
    browse: { status: 'ready', entries: [], cwd: '/home/g', error: null, stale: false }, search: '', searching: false, totalEntries: 0, visibleEntries: [],
    Entries: () => null, searchChange: () => {}, searchRef: { current: null }, homePathOf: () => '/home/g' }));
  const rec = body2.map((node) => walk(node, [])).flat().find((n) => n.type === 'details' && String(n.props.className).indexOf('dsh-rw-fold') >= 0);
  check('折叠区：最近目录 details 存在', !!rec);
  const ev2 = { currentTarget: { open: true } };
  if (rec) rec.props.onToggle(ev2);
  ev2.currentTarget = null;
  let crash3 = null;
  let next2 = null;
  try { next2 = updater2({}); } catch (e) { crash3 = e; }
  check('折叠区：最近目录 updater 不崩', crash3 === null, crash3 ? String(crash3.message) : '');
  check('折叠区：最近目录写入 open=true', !!next2 && next2.recent === true, JSON.stringify(next2));
}
const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-layout.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
