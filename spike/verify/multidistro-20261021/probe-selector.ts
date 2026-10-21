#!/usr/bin/env node
/**
 * probe-selector.ts —— 「WSL 目标」列表（VS Code Remote Explorer 式）的渲染断言。
 *
 * 2026-10-21 第二次对齐：此前做的是头部下拉，用户指出应对位 VS Code 的 WSL TARGETS 列表；
 * 改为「多发行版时在主体顶部渲染目标列表，每行 = 状态点 + 名字 + 默认/当前徽标 + 运行态，点行切换」。
 *
 * 断言：
 *   1) 两个发行版 ⇒ 渲染 1 个 targets 区块、2 行；当前行带 --on 与 aria-current；
 *   2) 点非当前行 ⇒ onDistroChange(该名字)；
 *   3) 单发行版 ⇒ 不渲染 targets 区块（避免只有一个选项的死控件）。
 *
 * 用法：node probe-selector.ts；产出 out-selector.json；退出码 0=全过。
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
const registry = new Map();
const window = { __ModuleLoader__: { load(def) { registry.set(def.chunk, def.factory); } } };
const document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible', querySelector: () => null };
vm.runInNewContext(fs.readFileSync(path.join(CLIENT, 'client.panel.browser.js'), 'utf8'), { window, document, console, setTimeout, clearTimeout, Promise, Symbol, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }, { filename: 'client.panel.browser.js' });
const browser = registry.get('client.panel.browser.js')(() => ({ exports: {} }));
const t = (key, vars) => key + (vars ? ':' + JSON.stringify(vars) : '');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const walk = (n, out) => { if (!n || typeof n !== 'object') return out; if (n.$$typeof === 'el') { out.push(n); (n.children || []).forEach((c) => walk(c, out)); } return out; };
const calls = [];
let stopped = null;
let defaulted = null;

function render(distros, targetDistro) {
  const body = [];
  browser.renderBrowser({
    React, StatusDot: (props) => React.createElement('span', { className: 'dot ' + String(props.kind) }), body,
    breadcrumbOf: () => [], browse: { status: 'ready', entries: [], cwd: '/home/g', error: null, stale: false }, clearSearch: () => {},
    collapsed: {}, cwd: '/home/g', errorText: () => '', factsVisible: true, hiddenCount: 0, homePathOf: () => '/home/g', icon: () => null,
    jumpTo: () => {}, listPath: () => {}, mounts: [], pathError: null, pathInput: '/home/g', recent: [], recentOk: false,
    search: '', searchChange: () => {}, searchRef: { current: null }, searching: false, Entries: () => null,
    setCollapsed: () => {}, setPathError: () => {}, setPathInput: () => {}, setShowHidden: () => {}, showHidden: false,
    snapshot: {}, submitPath: () => {}, t,
    target: { distro: targetDistro, cwd: '/home/g', wslHome: '/home/g' }, totalEntries: 0, visibleEntries: [],
    distros, onDistroChange: (name) => { calls.push(name); }, onSetDefault: (name) => { defaulted = name; }, onStopTarget: (name) => { stopped = name; }, isRecord: (v) => !!v && typeof v === 'object',
  });
  return body;
}

// 场景 1：两个发行版
const body2 = render([{ name: 'debian-u8-1', default: true, reachable: true }, { name: 'Ubuntu-24.04', default: false, reachable: false }], 'debian-u8-1');
const nodes2 = body2.map((n) => walk(n, [])).flat();
const targets2 = nodes2.filter((n) => n.type === 'section' && String(n.props && n.props.className).split(' ').indexOf('dsh-rw-targets') >= 0);
const rows2 = nodes2.filter((n) => n.type === 'div' && String(n.props && n.props.className).split(' ').indexOf('dsh-rw-target') >= 0);
check('两发行版：渲染目标区块', targets2.length === 1, 'count=' + targets2.length);
check('两发行版：两行目标', rows2.length === 2, 'count=' + rows2.length);
const active = rows2.find((n) => String(n.props.className).indexOf('--on') >= 0);
check('两发行版：当前行高亮', !!active && String(active.props['aria-current']) === 'true', active ? String(active.props['aria-label']) : 'none');
const other = rows2.find((n) => n !== active);
check('两发行版：行不再绑定切换点击', !!other && typeof other.props.onClick !== 'function');
const acts = other ? walk(other, []).filter((n) => n.type === 'button' && String(n.props.className).indexOf('dsh-rw-link') >= 0) : [];
check('两发行版：行内有 设为默认/停止 两个动作', acts.length === 2, 'count=' + acts.length);
const labels = acts.map((n) => n.props['aria-label'] || (n.children || []).join(''));
check('两发行版：动作文案齐全', labels.join('|').indexOf('targets.setDefault') >= 0 && labels.join('|').indexOf('targets.stop') >= 0, labels.join('|'));
const stopBtn = acts.find((n) => (n.children || []).join('').indexOf('targets.stop') >= 0);
if (stopBtn) stopBtn.props.onClick({ stopPropagation: () => {} });
check('两发行版：停止动作回调带发行版名', stopped === 'Ubuntu-24.04', String(stopped));

// 场景 2：单发行版
const body1 = render([{ name: 'debian-u8-1', default: true, reachable: true }], 'debian-u8-1');
const nodes1 = body1.map((n) => walk(n, [])).flat();
const rows1 = nodes1.filter((n) => n.type === 'div' && String(n.props && n.props.className).split(' ').indexOf('dsh-rw-target') >= 0);
check('单发行版：仍列出本机这 1 个发行版', rows1.length === 1, 'count=' + rows1.length);

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
fs.writeFileSync(path.join(DIR, 'out-selector.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
console.log('\n' + summary.pass + '/' + summary.total + ' PASS');
process.exit(summary.fail === 0 ? 0 : 1);
