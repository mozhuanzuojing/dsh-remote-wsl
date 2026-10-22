#!/usr/bin/env node
/**
 * probe-narrow.ts —— B2「窄态 320/360 布局」的**静态 + 元素树**断言（Node 级，不起浏览器）。
 *
 * 分工（重要，别把这里当"几何实测"）：
 *   · 本探针负责：① 断点常量与 `narrow` 判断本身没被改坏；② 真正发出去的 CSS 里，三条修法
 *     （底栏折行 / 元信息行折行 / 窄态语义类下的路径行·目标行折行）确实存在且取值正确；
 *     ③ 窄态/宽态**元素树**的可见文案切换（chip 短文案、漂移只留图标、短标签）正确；
 *   · **几何数字**（scrollWidth/clientWidth、标题行数、主按钮命中盒）由 `probe-render.ts`
 *     在真 dsh web 实例 + headless Chrome 里量，见 `out-render-before.json` / `out-render-after.json`。
 *
 * 用法：node probe-narrow.ts
 * 产出：out-narrow.json；退出码 0 = 全过。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DIR, '../../..')
const CLIENT = path.join(ROOT, 'client')

const React = {
  createElement(type: any, props: any, ...children: any[]) {
    return { $$typeof: 'el', type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  Fragment: Symbol('Fragment'),
}

function loadChunk(file: string, extraSandbox: any = {}) {
  const registry = new Map<string, any>()
  const window = { __ModuleLoader__: { load(def: any) { registry.set(def.chunk || '__entry__', def.factory) } }, addEventListener() {}, removeEventListener() {} }
  const document = Object.assign({ addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null, documentElement: { lang: 'zh-CN' } }, extraSandbox.document || {})
  const code = fs.readFileSync(path.join(CLIENT, file), 'utf8')
  vm.runInNewContext(code, Object.assign({ window, document, console, setTimeout, clearTimeout, Promise, Symbol, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } }, extraSandbox.globals || {}), { filename: file })
  const factory = registry.get(file) || registry.get('__entry__')
  if (!factory) throw new Error('chunk not registered: ' + file)
  return factory((spec: string) => { if (spec === 'react') return React; throw new Error('unexpected require: ' + spec) })
}

const results: { ok: boolean; name: string; detail: string }[] = []
const check = (name: string, ok: any, detail = '') => results.push({ ok: !!ok, name, detail })
const walk = (node: any, out: any[] = []): any[] => {
  if (!node || typeof node !== 'object') return out
  if (node.$$typeof === 'el') { out.push(node); (node.children || []).forEach((c) => walk(c, out)) }
  return out
}
const t = (key: string, vars?: any) => 'T:' + key + (vars ? '|' + JSON.stringify(vars) : '')
const textOf = (node: any): string => (node && node.children ? node.children.filter((c: any) => typeof c === 'string').join('') : '')

// ── ① 断点常量 + narrow 判断（没被改坏；改它就要重新量几何）────────────────────
{
  const helpers = loadChunk('client.panel.helpers.js')
  check('断点 NARROW_PX 仍是 420（本轮不改既有分档语义）', helpers.NARROW_PX === 420, String(helpers.NARROW_PX))
  check('断点 HIDE_UPDATED_PX 仍是 360', helpers.HIDE_UPDATED_PX === 360, String(helpers.HIDE_UPDATED_PX))
  const actions = fs.readFileSync(path.join(CLIENT, 'client.panel.actions.js'), 'utf8')
  check('actions 里 narrow 仍由面板实宽算出（width < NARROW_PX）', /const narrow = width < NARROW_PX;/.test(actions), '静态断言：ResizeObserver contentRect 驱动的 width')
  check('actions 里 hideUpdated 仍由 width < HIDE_UPDATED_PX 算出', /const hideUpdated = width < HIDE_UPDATED_PX;/.test(actions), '静态断言')
  // 反向：不许用 @media 量面板宽度（面板实宽 ≠ 视口宽：rail 56px）
  const entrySrc = fs.readFileSync(path.join(CLIENT, 'index.js'), 'utf8')
  const mediaForLayout = /@media[^{]*\{[^}]*dsh-rw-(header|status|formrow|target)/.test(entrySrc)
  check('窄态修复没用 @media 冒充面板宽度（prefers-reduced-motion 除外）', mediaForLayout === false, mediaForLayout ? '发现布局 @media' : '无布局 @media')
}

// ── ② 真 CSS：装载入口 chunk，抓它注入的 <style>，逐条核对修法 ─────────────────
let CSS = ''
{
  const tags: any[] = []
  const doc = {
    querySelector: () => null,
    createElement: (tag: string) => ({ tagName: tag, dataset: {}, textContent: '' }),
    head: { appendChild: (el: any) => tags.push(el) },
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    documentElement: { lang: 'zh-CN' },
  }
  loadChunk('index.js', { document: doc })
  CSS = tags.length > 0 ? String(tags[0].textContent) : ''
  check('入口 chunk 真的注入了 <style data-plugin-css>', CSS.length > 1000, `${CSS.length} 字符 / ${tags.length} 个 style`)
}
const rules = CSS.split('\n')
const rule = (selectorPrefix: string) => rules.find((r) => r.startsWith(selectorPrefix + '{')) || ''
const ruleOf = (selector: string) => rules.find((r) => r.startsWith(selector + '{')) || ''

{
  const meta = ruleOf('.dsh-rw-header-meta')
  check('CSS: 元信息行允许折行（压缩标题的根因修法）', /flex-wrap:wrap/.test(meta), meta.slice(0, 120))
  check('CSS: 元信息行折行间距 4px', /row-gap:4px/.test(meta), meta.slice(0, 140))

  const footer = ruleOf('.dsh-rw-status')
  check('CSS: 底栏允许折行（0 横向溢出的根因修法）', /flex-wrap:wrap/.test(footer), footer.slice(0, 160))
  check('CSS: 底栏高从固定 47 改为 min-height:47（折行时能长高）', /min-height:47px/.test(footer) && !/(^|;)height:47px/.test(footer), footer.slice(0, 160))

  const proxy = ruleOf('.dsh-rw-proxy')
  check('CSS: 徽标 flex:none（不被压扁）', /flex:none/.test(proxy), proxy.slice(0, 120))
  check('CSS: 徽标 white-space:nowrap（徽标自身不折行）', /white-space:nowrap/.test(proxy), proxy.slice(0, 160))
  check('CSS: 徽标文字同样 nowrap', /white-space:nowrap/.test(ruleOf('.dsh-rw-proxy-text')), ruleOf('.dsh-rw-proxy-text'))
  check('CSS: 可达态用宿主 success token', /--dsw-alias-state-success-primary/.test(ruleOf('.dsh-rw-proxy--up')), ruleOf('.dsh-rw-proxy--up'))
  check('CSS: 不可达态用宿主 error token', /--dsw-alias-state-error-primary/.test(ruleOf('.dsh-rw-proxy--down')), ruleOf('.dsh-rw-proxy--down'))
  check('CSS: 未探测态用次级文字色 + border-l2（不是成功/失败色）', /--dsw-alias-label-secondary/.test(ruleOf('.dsh-rw-proxy--unknown')), ruleOf('.dsh-rw-proxy--unknown'))
  check('CSS: 漂移图标壳存在（窄态只留 ⚠）', !!ruleOf('.dsh-rw-driftmark'), ruleOf('.dsh-rw-driftmark').slice(0, 90))

  const formrow = rules.find((r) => r.startsWith('.dsh-rw-root--narrow .dsh-rw-formrow{')) || ''
  const pathform = rules.find((r) => r.startsWith('.dsh-rw-root--narrow .dsh-rw-pathform{')) || ''
  const search = rules.find((r) => r.startsWith('.dsh-rw-root--narrow .dsh-rw-search{')) || ''
  const target = rules.find((r) => r.startsWith('.dsh-rw-root--narrow .dsh-rw-target{')) || ''
  check('CSS: 窄态路径行折行', /flex-wrap:wrap/.test(formrow), formrow.slice(0, 120))
  check('CSS: 窄态路径容器占满一行', /flex:1 1 100%/.test(pathform), pathform)
  check('CSS: 窄态筛选框占满一行且可收缩（不再被推出卡片）', /flex:1 1 100%/.test(search) && /min-width:0/.test(search), search)
  check('CSS: 窄态目标行允许换行（徽标不再把行挤爆）', /flex-wrap:wrap/.test(target), target.slice(0, 120))
}

// ── ③ 元素树：窄/宽两态的可见文案切换 ───────────────────────────────────────
const BASE: any = {
  HIDE_UPDATED_PX: 360, NARROW_PX: 420, RECENT_KEY: 'k', RECENT_MAX: 8,
  React, StatusDot: (p: any) => React.createElement('dot', { kind: p.kind }), action: { busy: null, note: null, detail: null, error: null },
  actionAbort: { current: null }, actionFailure: () => '', actionFailureText: () => '', activeDistro: 'debian-u8-1',
  addWorkspaceErrorText: () => '', addWorkspaceNote: () => '', api: {}, asArray: (v: any) => (Array.isArray(v) ? v : []), body: [],
  breadcrumbOf: () => [], browse: { cwd: '/home/g' }, browseAbort: { current: null }, browseSeq: { current: 0 }, cancelRef: { current: null },
  clock: () => '10:00:00', closeMenu: () => {}, collapsed: {}, ctx: {}, cwd: '/home/g', cwdDiffersFromTarget: false,
  daemon: { running: false, keys: [], others: [] }, daemonKnown: true, daemonNote: () => '', daemonPill: null, daemonSlot: 8972,
  distros: [], drift: { drifted: true }, driftKnown: true, errorText: () => '', factsVisible: true, focusIndex: -1,
  forceLocale: () => {}, headerButtons: [], hiddenCount: 0, hideUpdated: false, homePathOf: () => '/home/g', icon: () => null,
  isRecord: (v: any) => !!v && typeof v === 'object' && !Array.isArray(v), joinWslPath: (a: string, b: string) => a + '/' + b, jumpTo: () => {},
  keys: [], keysKnown: true, lastRun: { current: null }, listPath: () => {}, load: () => {}, menuOpen: false, menuRef: { current: null },
  moreRef: { current: null }, mounts: [], mountsCache: null, mountsProbed: { current: false }, narrow: false,
  newAbortController: () => ({}), normalizeWslPath: (p: string) => p, onDistroChange: () => {}, onMenuKey: () => {},
  openSessionNote: () => '', others: [], pathError: null, pathInput: '/home/g', pending: null, pendingFrom: { current: null },
  primaryBusyKey: '', primaryIsSession: false, proxyBadge: null, pushRecent: () => [], readAbort: { current: null },
  readRecent: () => [], readSeq: { current: 0 }, recent: [], recentOk: true, rootRef: { current: null }, run: () => {},
  runDaemon: () => {}, setAction: () => {}, setBrowse: () => {}, setCollapsed: () => {}, setFocusIndex: () => {},
  setMenuOpen: () => {}, setMounts: () => {}, setPathError: () => {}, setPathInput: () => {}, setPending: () => {},
  setRecent: () => {}, setRecentOk: () => {}, setShowHidden: () => {}, setSlow: () => {}, setState: () => {}, setWidth: () => {},
  showHidden: false, signalOf: () => ({}), slow: false,
  snapshot: { distros: [], target: {}, daemon: { running: false, keys: [] }, drift: { drifted: true }, workspaces: [], webHosts: [] },
  splitFirstSentence: (s: string) => s, splitHumanText: (s: string) => s,
  state: { status: 'ready', snapshot: {}, error: null, lastSuccessAt: new Date(), lastFailureAt: null },
  submitPath: () => {}, t, target: { distro: 'debian-u8-1', cwd: '/home/g', wslHome: '/home/g' }, visibleEntries: [], width: 900,
  chosenDistro: null, copyNote: null, onCopySession: () => {}, search: '', setSearch: () => {},
  searchRef: { current: null }, navSeq: { current: 0 }, formatIdle: () => '',
}
const tail = loadChunk('client.panel.tail.js')
const treeOf = (over: any = {}) => tail.renderTail(Object.assign({}, BASE, over))

{
  const wide = walk(treeOf({ narrow: false }))
  const narrow = walk(treeOf({ narrow: true }))
  const summaryOf = (nodes: any[]) => nodes.find((n: any) => String(n.props && n.props.className) === 'dsh-rw-tchip-summary')
  const wideSummary = summaryOf(wide)
  const narrowSummary = summaryOf(narrow)
  check('底栏 chip 宽态保持「WSL: 发行版」', !!wideSummary && textOf(wideSummary).indexOf('T:targets.chip|') === 0, textOf(wideSummary))
  check('底栏 chip 窄态换成短键 targets.chipShort', !!narrowSummary && textOf(narrowSummary).indexOf('T:targets.chipShort') === 0, textOf(narrowSummary))
  check('底栏 chip 窄态 aria-label 仍是完整「WSL: 发行版」', !!narrowSummary && String(narrowSummary.props['aria-label']).indexOf('T:targets.chip|') === 0, String(narrowSummary && narrowSummary.props['aria-label']))
  check('底栏 chip 宽态也带 aria-label（不被 title 顶掉可访问名）', !!wideSummary && String(wideSummary.props['aria-label']).indexOf('T:targets.chip|') === 0, String(wideSummary && wideSummary.props['aria-label']))

  const wideDrift = wide.find((n: any) => String(n.props && n.props.className) === 'dsh-rw-driftmark')
  const narrowDrift = narrow.find((n: any) => String(n.props && n.props.className) === 'dsh-rw-driftmark')
  check('漂移提示宽态保留文字版（不是窄态图标）', wideDrift === undefined, wideDrift ? 'wide 也变成 icon-only' : 'ok')
  check('漂移提示窄态变成 icon-only 壳', !!narrowDrift, narrowDrift ? String(narrowDrift.props.className) : 'none')
  check('漂移 icon-only 壳带 title/aria-label（文字不丢）', !!narrowDrift && String(narrowDrift.props.title) === 'T:status.drifted' && String(narrowDrift.props['aria-label']) === 'T:status.drifted', narrowDrift ? `${narrowDrift.props.title} / ${narrowDrift.props['aria-label']}` : '')

  const wideWords = wide.filter((n: any) => String(n.props && n.props.className) === 'dsh-rw-statusword').map((n: any) => textOf(n))
  const narrowWords = narrow.filter((n: any) => String(n.props && n.props.className) === 'dsh-rw-statusword').map((n: any) => textOf(n))
  check('底栏窄态只剩 1 个状态词（漂移词让位给图标）', narrowWords.length === 1, narrowWords.join(' / '))
  check('底栏宽态有 2 个状态词（守护 + 漂移）', wideWords.length === 2, wideWords.join(' / '))
  check('底栏状态词本身不被改短（daemon 状态是主信息）', narrowWords[0] === wideWords[0], `${narrowWords[0]} vs ${wideWords[0]}`)
  const extraNarrow = narrow.find((n: any) => String(n.props && n.props.className).indexOf('dsh-rw-extra') >= 0)
  check('底栏窄态仍隐藏「会话 N 个」（T63 既有行为不动）', !!extraNarrow && String(extraNarrow.props.className).indexOf('dsh-rw-extra--hidden') >= 0, extraNarrow ? String(extraNarrow.props.className) : 'none')
}

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, cssChars: CSS.length, results }
fs.writeFileSync(path.join(DIR, 'out-narrow.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''))
console.log('\n' + summary.pass + '/' + summary.total + ' PASS')
process.exit(summary.fail === 0 ? 0 : 1)
