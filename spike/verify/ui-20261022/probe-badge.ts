#!/usr/bin/env node
/**
 * probe-badge.ts —— B1「代理状态头部徽标」的元素树断言（Node 级，不起浏览器；假 ctx + 假快照）。
 *
 * 覆盖（任务书 B1 的每一条都可判）：
 *   B1-a 三态：snapshot.proxy.reachable = true / false / null（+ 段缺失）分别渲染 --up / --down /
 *        --unknown 徽标 / 不渲染；`data-proxy-state` 与 class 一致。
 *   B1-b 文字通道：三态可见文案来自字典且互不相同（颜色不是唯一信息载体）。
 *   B1-c 可访问性：role=img + aria-label + title 三者都有；aria 与 title 同句；三态句中都有 `host:port`；
 *        不可达态句子里含可操作提示（本机代理是否启动 / 不用代理可忽略）。
 *   B1-d 窄态：narrow=true 时换极短词（proxy.*Short），aria/title 仍是整句（信息不丢）。
 *   B1-e 形状通道：三态 StatusDot kind 互不相同（running / error / unknown）。
 *   B1-f 位置：tail 把徽标放进 `.dsh-rw-header-meta`（标题区），且根节点在窄态带 `--narrow` 语义类。
 *   B1-g 守护药丸窄态短文案（同一次头部改动）：narrow 时可见文字换短键，aria/title 不变。
 *   B1-h i18n 逐键配对：本轮新增键在 zh/en 都存在、非空、占位符一致。
 *
 * 用法：node probe-badge.ts
 * 产出：out-badge.json；退出码 0 = 全过。
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

function loadChunk(file: string) {
  const registry = new Map<string, any>()
  const window = { __ModuleLoader__: { load(def: any) { registry.set(def.chunk, def.factory) } } }
  const document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', querySelector: () => null, documentElement: { lang: 'zh-CN' } }
  const code = fs.readFileSync(path.join(CLIENT, file), 'utf8')
  vm.runInNewContext(code, { window, document, console, setTimeout, clearTimeout, Promise, Symbol, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } }, { filename: file })
  const factory = registry.get(file)
  if (!factory) throw new Error('chunk not registered: ' + file)
  return factory(() => ({ exports: {} }))
}

const results: { ok: boolean; name: string; detail: string }[] = []
const check = (name: string, ok: any, detail = '') => results.push({ ok: !!ok, name, detail })
const walk = (node: any, out: any[] = []): any[] => {
  if (!node || typeof node !== 'object') return out
  if (node.$$typeof === 'el') { out.push(node); (node.children || []).forEach((c) => walk(c, out)) }
  return out
}
/** 假 t：把 key 与插值变量都编进字符串 ⇒ 断言能看清"用了哪个键、带了什么变量"。 */
const t = (key: string, vars?: any) => 'T:' + key + (vars ? '|' + JSON.stringify(vars) : '')
const textOf = (node: any): string => (node && node.children ? node.children.filter((c: any) => typeof c === 'string').join('') : '')

const StatusDot = (props: any) => React.createElement('dot', { kind: props.kind, className: 'dsh-rw-dot' })

const HEADER_BASE: any = {
  HIDE_UPDATED_PX: 720, NARROW_PX: 420, RECENT_KEY: 'k', RECENT_MAX: 8,
  React, StatusDot, action: { busy: null, note: null, detail: null, error: null }, actionAbort: { current: null },
  actionFailure: () => '', actionFailureText: () => '', activeDistro: 'debian-u8-1',
  addWorkspaceErrorText: () => '', addWorkspaceNote: () => '', api: { addWorkspace: async () => ({ ok: true }), newSession: async () => ({}) },
  asArray: (v: any) => (Array.isArray(v) ? v : []), body: [], breadcrumbOf: () => [], browse: { cwd: '/home/g' },
  browseAbort: { current: null }, browseSeq: { current: 0 }, cancelRef: { current: null }, clock: () => '',
  closeMenu: () => {}, collapsed: {}, ctx: {}, cwd: '/home/g', cwdDiffersFromTarget: false,
  daemon: { running: false, keys: [] }, daemonKnown: true, daemonNote: () => '', daemonSlot: 8972, distros: [],
  drift: { drifted: false }, driftKnown: true, errorText: () => '', factsVisible: true, focusIndex: -1,
  forceLocale: () => {}, hiddenCount: 0, hideUpdated: false, homePathOf: () => '/home/g', icon: () => null,
  isRecord: (v: any) => !!v && typeof v === 'object' && !Array.isArray(v), joinWslPath: (a: string, b: string) => a + '/' + b, jumpTo: () => {},
  keys: [], keysKnown: true, lastRun: { current: null }, listPath: () => {}, load: () => {}, menuOpen: false,
  menuRef: { current: null }, moreRef: { current: null }, mounts: [], mountsCache: null, mountsProbed: { current: false },
  narrow: false, newAbortController: () => ({}), normalizeWslPath: (p: string) => p, onMenuKey: () => {},
  openSessionNote: () => '', others: [], pathError: null, pathInput: '/home/g', pending: null,
  pendingFrom: { current: null }, pushRecent: () => [], readAbort: { current: null }, readRecent: () => [],
  readSeq: { current: 0 }, recent: [], recentOk: true, rootRef: { current: null }, run: () => {},
  runDaemon: () => {}, setAction: () => {}, setBrowse: () => {}, setCollapsed: () => {},
  setFocusIndex: () => {}, setMenuOpen: () => {}, setMounts: () => {}, setPathError: () => {}, setPathInput: () => {},
  setPending: () => {}, setRecent: () => {}, setRecentOk: () => {}, setShowHidden: () => {}, setSlow: () => {},
  setState: () => {}, setWidth: () => {}, showHidden: false, signalOf: () => ({}), slow: false,
  snapshot: {}, splitFirstSentence: (s: string) => s, splitHumanText: (s: string) => s,
  state: { status: 'ready', snapshot: {}, error: null, lastSuccessAt: null, lastFailureAt: null },
  submitPath: () => {}, t, target: { distro: 'debian-u8-1', cwd: '/home/g', wslHome: '/home/g' },
  visibleEntries: [], width: 900,
}

const header = loadChunk('client.panel.header.js')
const ENDPOINT = '10.0.0.1:9910'
const snap = (reachable: any) => ({ proxy: { host: '10.0.0.1', port: 9910, reachable, cached: false } })
const render = (over: any = {}) => header.renderHeader(Object.assign({}, HEADER_BASE, over))

// ── B1-a/b/c/e：三态（宽态）────────────────────────────────────────────────────
const states: [string, any, string, string, string][] = [
  ['up', true, 'dsh-rw-proxy--up', 'running', 'proxy.up'],
  ['down', false, 'dsh-rw-proxy--down', 'error', 'proxy.downAt'],
  ['unknown', null, 'dsh-rw-proxy--unknown', 'unknown', 'proxy.unknown'],
]
const dots = new Set<string>()
const labels = new Set<string>()
const seen: any[] = []
for (const [state, reachable, cls, dotKind, labelKey] of states) {
  const out = render({ snapshot: snap(reachable) })
  const badge = out.proxyBadge
  check(`B1-a ${state}: 渲染出徽标`, !!badge, badge ? String(badge.props.className) : 'null')
  if (!badge) continue
  check(`B1-a ${state}: class 带 ${cls}`, String(badge.props.className).indexOf(cls) >= 0, String(badge.props.className))
  check(`B1-a ${state}: data-proxy-state=${state}`, badge.props['data-proxy-state'] === state, String(badge.props['data-proxy-state']))
  check(`B1-c ${state}: role=img`, badge.props.role === 'img', String(badge.props.role))
  const aria = String(badge.props['aria-label'] || '')
  const title = String(badge.props.title || '')
  check(`B1-c ${state}: aria-label 非空且 == title`, aria.length > 10 && aria === title, aria)
  check(`B1-c ${state}: aria 带端点 ${ENDPOINT}`, aria.indexOf(ENDPOINT) >= 0, aria)
  const ariaKey = state === 'up' ? 'proxy.ariaUp' : state === 'down' ? 'proxy.ariaDown' : 'proxy.ariaUnknown'
  check(`B1-c ${state}: aria 用整句键 ${ariaKey}`, aria.indexOf('T:' + ariaKey) === 0, aria.slice(0, 46))
  const nodes = walk(badge)
  // 假 React 不会执行组件函数 ⇒ 按**元素 type === StatusDot** 找圆点，读它的 props.kind
  const dot = nodes.find((n: any) => n.type === StatusDot)
  check(`B1-e ${state}: StatusDot kind=${dotKind}`, !!dot && dot.props.kind === dotKind, dot ? String(dot.props.kind) : 'none')
  if (dot) dots.add(String(dot.props.kind))
  const textNode = nodes.find((n: any) => String(n.props && n.props.className).indexOf('dsh-rw-proxy-text') >= 0)
  const text = textOf(textNode)
  check(`B1-b ${state}: 可见文字用键 ${labelKey}`, text.indexOf('T:' + labelKey) === 0, text)
  check(`B1-b ${state}: 可见文字非空（不是只有红点）`, text.length > 0, text)
  labels.add(text)
  if (state === 'down') {
    check('B1-c down: 可见文字带端点（给出代理地址）', text.indexOf(ENDPOINT) >= 0, text)
  }
  seen.push({ state, class: String(badge.props.className), aria, title, text, dot: dot ? dot.props.kind : null })
}
check('B1-e 三态形状通道互不相同', dots.size === 3, [...dots].join(' / '))
check('B1-b 三态可见文案互不相同', labels.size === 3, [...labels].join(' / '))

// 段缺失 ⇒ 不渲染（不回退成"未探测"，避免把"宿主没给数据"说成"探测过"）
check('B1-a proxy 段缺失时无徽标', render({ snapshot: {} }).proxyBadge === null, 'null')
check('B1-a factsVisible=false 时无徽标', render({ snapshot: snap(true), factsVisible: false }).proxyBadge === null, 'null')

// ── B1-d：窄态短词 ────────────────────────────────────────────────────────────
for (const [state, reachable, , , ] of states) {
  const out = render({ snapshot: snap(reachable), narrow: true })
  const nodes = walk(out.proxyBadge)
  const textNode = nodes.find((n: any) => String(n.props && n.props.className).indexOf('dsh-rw-proxy-text') >= 0)
  const text = textOf(textNode)
  const shortKey = state === 'up' ? 'proxy.upShort' : state === 'down' ? 'proxy.downShort' : 'proxy.unknownShort'
  check(`B1-d narrow ${state}: 可见文字用短键 ${shortKey}`, text.indexOf('T:' + shortKey) === 0, text)
  check(`B1-d narrow ${state}: aria 仍是整句`, String(out.proxyBadge.props['aria-label'] || '').indexOf(ENDPOINT) >= 0, String(out.proxyBadge.props['aria-label'] || '').slice(0, 40))
  check(`B1-d narrow ${state}: 徽标容器仍是单行药丸（nowrap 由 CSS 钉死）`, String(out.proxyBadge.props.className).indexOf('dsh-rw-proxy') >= 0, String(out.proxyBadge.props.className))
}

// ── B1-g：守护药丸窄态短文案（aria/title 不变）───────────────────────────────
{
  const wideOff = render({ snapshot: snap(true) }).daemonPill
  const narrowOff = render({ snapshot: snap(true), narrow: true }).daemonPill
  const wideOn = render({ snapshot: snap(true), daemon: { running: true, keys: [], pid: 1, slot: 8972, version: '0.2.1' } }).daemonPill
  const narrowOn = render({ snapshot: snap(true), daemon: { running: true, keys: [], pid: 1, slot: 8972, version: '0.2.1' }, narrow: true }).daemonPill
  check('B1-g 宽态守护药丸文字 status.daemonOff', textOf(wideOff).indexOf('T:status.daemonOff') >= 0, textOf(wideOff))
  check('B1-g 窄态守护药丸文字 status.daemonPillShortOff', textOf(narrowOff).indexOf('T:status.daemonPillShortOff') >= 0, textOf(narrowOff))
  check('B1-g 宽态守护药丸文字 status.daemonRunning', textOf(wideOn).indexOf('T:status.daemonRunning') >= 0, textOf(wideOn))
  check('B1-g 窄态守护药丸文字 status.daemonPillShortOn', textOf(narrowOn).indexOf('T:status.daemonPillShortOn') >= 0, textOf(narrowOn))
  check('B1-g 窄态 aria 仍是完整文案', String(narrowOff.props['aria-label']) === 'T:status.daemonOff', String(narrowOff.props['aria-label']))
  check('B1-g 窄态 title 仍是完整提示', String(narrowOff.props.title) === 'T:status.daemonPillOff', String(narrowOff.props.title))
}

// ── B1-f：tail 把徽标放进 header-meta + 根节点窄态语义类 ────────────────────
{
  const tail = loadChunk('client.panel.tail.js')
  const tailBase: any = Object.assign({}, HEADER_BASE, {
    daemonPill: null, proxyBadge: render({ snapshot: snap(true) }).proxyBadge,
    daemon: null, daemonKnown: false, distros: [], headerButtons: [], chosenDistro: null,
    drift: { drifted: false }, driftKnown: false, extra: '', keys: [], keysKnown: true,
    onDistroChange: () => {}, others: [], primaryBusyKey: '', primaryIsSession: false,
    snapshot: { distros: [], target: {}, daemon: { running: false, keys: [] }, drift: { drifted: false }, workspaces: [], webHosts: [], proxy: { host: '10.0.0.1', port: 9910, reachable: true } },
    state: { status: 'ready', snapshot: {}, error: null, lastSuccessAt: null, lastFailureAt: null },
    setCollapsed: () => {}, setShowHidden: () => {}, width: 900, copyNote: null, onCopySession: () => {},
    search: '', setSearch: () => {}, searchRef: { current: null }, navSeq: { current: 0 },
    formatIdle: () => '',
  })
  const tree = tail.renderTail(Object.assign({}, tailBase, { narrow: false }))
  const nodes = walk(tree)
  const root = nodes.find((n: any) => String(n.props && n.props.className) === 'dsh-rw-root')
  check('B1-f 宽态根节点没有 --narrow 类', !!root, root ? String(root.props.className) : 'none')
  const meta = nodes.find((n: any) => String(n.props && n.props.className) === 'dsh-rw-header-meta')
  check('B1-f header-meta 存在', !!meta, meta ? 'ok' : 'none')
  const metaKids = meta ? walk(meta) : []
  const badgeInMeta = metaKids.find((n: any) => String(n.props && n.props.className).indexOf('dsh-rw-proxy') >= 0)
  check('B1-f 徽标渲染在 header-meta（标题区）里', !!badgeInMeta, badgeInMeta ? String(badgeInMeta.props.className) : 'none')
  const narrowTree = tail.renderTail(Object.assign({}, tailBase, { narrow: true }))
  const narrowRoot = walk(narrowTree).find((n: any) => String(n.props && n.props.className).indexOf('dsh-rw-root') >= 0)
  check('B1-f 窄态根节点带 dsh-rw-root--narrow', !!narrowRoot && String(narrowRoot.props.className).indexOf('dsh-rw-root--narrow') >= 0, narrowRoot ? String(narrowRoot.props.className) : 'none')
}

// ── B1-h：i18n 逐键配对（本轮新增 13 键）─────────────────────────────────────
{
  const dicts = loadChunk('client.i18n.js').DICTS
  const keys = [
    'proxy.up', 'proxy.upShort', 'proxy.down', 'proxy.downShort', 'proxy.downAt', 'proxy.unknown', 'proxy.unknownShort',
    'proxy.ariaUp', 'proxy.ariaDown', 'proxy.ariaUnknown', 'status.daemonPillShortOn', 'status.daemonPillShortOff', 'targets.chipShort',
  ]
  const missingZh = keys.filter((k) => typeof dicts.zh[k] !== 'string' || dicts.zh[k].length === 0)
  const missingEn = keys.filter((k) => typeof dicts.en[k] !== 'string' || dicts.en[k].length === 0)
  check('B1-h 新增键在 zh 全部存在且非空', missingZh.length === 0, missingZh.join(',') || keys.length + ' 键')
  check('B1-h 新增键在 en 全部存在且非空', missingEn.length === 0, missingEn.join(',') || keys.length + ' 键')
  const holder = (s: string) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',')
  const mismatched = keys.filter((k) => holder(dicts.zh[k] || '') !== holder(dicts.en[k] || ''))
  check('B1-h zh/en 占位符一致', mismatched.length === 0, mismatched.join(',') || 'ok')
  const zhOnly = Object.keys(dicts.zh).filter((k) => !(k in dicts.en))
  const enOnly = Object.keys(dicts.en).filter((k) => !(k in dicts.zh))
  check('B1-h 全字典 zh/en 逐键配对', zhOnly.length === 0 && enOnly.length === 0, `zh-only=${zhOnly.length} en-only=${enOnly.length}`)
  check('B1-h 三态可见文案两两不同（zh）', new Set(['proxy.up', 'proxy.down', 'proxy.unknown'].map((k) => dicts.zh[k])).size === 3, ['proxy.up', 'proxy.down', 'proxy.unknown'].map((k) => dicts.zh[k]).join(' / '))
  // B1-c 的"一句可操作提示"必须真的在**文案**里（假 t 只回键名，所以这条查字典原文）
  check('B1-c 不可达句含代理地址占位符', /endpoint/.test(holder(dicts.zh['proxy.ariaDown'] || '')) && /endpoint/.test(holder(dicts.en['proxy.ariaDown'] || '')), dicts.zh['proxy.ariaDown'])
  check('B1-c 不可达句含可操作提示（zh：确认代理已启动 / 可忽略）', /代理已启动/.test(dicts.zh['proxy.ariaDown']) && /忽略/.test(dicts.zh['proxy.ariaDown']), dicts.zh['proxy.ariaDown'])
  check('B1-c 不可达句含可操作提示（en：host proxy / ignore）', /host proxy/.test(dicts.en['proxy.ariaDown']) && /ignore/.test(dicts.en['proxy.ariaDown']), dicts.en['proxy.ariaDown'])
  check('B1-c 未探测句解释原因（发行版未运行/探测失败）', /未运行|探测失败/.test(dicts.zh['proxy.ariaUnknown']), dicts.zh['proxy.ariaUnknown'])
}

const summary = { generatedAt: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, rendered: seen, results }
fs.writeFileSync(path.join(DIR, 'out-badge.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  —— ' + r.detail : ''))
console.log('\n' + summary.pass + '/' + summary.total + ' PASS')
process.exit(summary.fail === 0 ? 0 : 1)
