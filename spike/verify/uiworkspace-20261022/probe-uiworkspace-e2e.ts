#!/usr/bin/env node
/**
 * probe-uiworkspace-e2e.ts —— 端到端取证：「在此目录新建会话」这条链路在真实例里到底成不成。
 *
 * 链路（与 client/client.panel.header.js 的主按钮同一条）：
 *   1) `explorer.addWorkspace({path})` —— host 侧把 WSL 路径登记成 DSH 工作区（UNC）；
 *   2) `ctx.get("uiWorkspace").startSession(ws.id)` —— 客户端工作区导航开会话并 replaceMain。
 *
 * 探针需要在 `client/index.js` 的 `apply()` 里额外挂一个把手（验完即删）：
 *
 *   bootSettled.then(() => {
 *     try {
 *       window.__rwslProbe = { ctx, api: boot.api, i18n: boot.i18n };
 *       document.documentElement.setAttribute("data-rwsl-probe-ready", "1");
 *     } catch (e) {}
 *   }, () => {});
 *
 * 判据（不靠"看起来切了"）：
 *   · startSession 的返回值形态（实测 undefined ⇒ 同步、且它自己吞失败）；
 *   · 5 秒后 `uiWorkspace.mainReference.sessionId` 是否变成新的 session（replaceMain 的证据）；
 *   · `workspaces.list` / `sessions.list` 快照是否 ready，页面有无"失败/无法/错误"toast；
 *   · console 里有无 `new session failed:`（ui-workspace 自己的告警）。
 *
 * 用法：node probe-uiworkspace-e2e.ts <cdpPort> [UNC 路径]
 * 退出码：0 = addWorkspace 且 startSession 后 mainReference 拿到了 session；1 = 其它。
 */
const port = Number(process.argv[2] ?? 8966)
const uncPath = process.argv[3] ?? '\\\\wsl.localhost\\debian-u8-1\\home\\g'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getJson(path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return await res.json()
}

let up = false
for (let i = 0; i < 40; i += 1) {
  try {
    await getJson('/json/version')
    up = true
    break
  } catch {
    await sleep(500)
  }
}
if (!up) {
  console.log('FAIL: CDP 未就绪')
  process.exit(1)
}

const list = (await getJson('/json/list')) as any[]
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.log('FAIL: 没有 page target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, (v: any) => void>()
const consoleLines: string[] = []

ws.addEventListener('message', (ev: MessageEvent) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ')
    consoleLines.push(`[${msg.params.type}] ${String(text).slice(0, 300)}`)
  }
  if (msg.method === 'Log.entryAdded') {
    consoleLines.push(`[log:${msg.params.entry.level}] ${String(msg.params.entry.text).slice(0, 300)}`)
  }
  const fn = pending.get(msg.id)
  if (fn) {
    pending.delete(msg.id)
    fn(msg)
  }
})

const send = (method: string, params: any = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', () => reject(new Error('ws error')))
})
await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

const evaluate = async (expression: string) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (res?.result?.exceptionDetails) return { __error: res.result.exceptionDetails.text ?? 'exception' }
  return res?.result?.result?.value
}

// 1) 刷新页面拿到最新 client chunk，并等探针把手就绪
await send('Page.reload', { ignoreCache: true })
let probeReady = false
for (let i = 0; i < 60; i += 1) {
  if ((await evaluate("document.documentElement.getAttribute('data-rwsl-probe-ready')")) === '1') {
    probeReady = true
    break
  }
  await sleep(500)
}
console.log('probe ready =', probeReady)
if (!probeReady) {
  console.log('FAIL: 探针未就绪；console 采样：', consoleLines.slice(-10))
  process.exit(1)
}

console.log('BEFORE:', JSON.stringify(await evaluate(`(() => {
  const p = window.__rwslProbe
  const ui = p.ctx.get('uiWorkspace')
  return {
    hasProbe: !!p,
    uiHit: ui !== undefined && ui !== null,
    startSession: typeof (ui || {}).startSession,
    mainBefore: location.hash,
    toastText: (document.body.innerText.match(/[^\\n]*(失败|无法|错误)[^\\n]*/g) || []).slice(0, 3),
  }
})()`)))

// 2) 登记工作区
const add = await evaluate(`(async () => {
  const p = window.__rwslProbe
  try {
    const ws = await p.api.addWorkspace({ path: ${JSON.stringify(uncPath)} })
    return { ok: true, ws }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
})()`)
console.log('ADD_WORKSPACE =', JSON.stringify(add))

// 3) 走客户端导航开会话
const start = await evaluate(`(async () => {
  const p = window.__rwslProbe
  const ws = ${JSON.stringify(add)}
  if (!ws || !ws.ok) return { skipped: true }
  const ui = p.ctx.get('uiWorkspace')
  try {
    const ret = ui.startSession(ws.ws.id)
    return { called: true, returned: typeof ret, thenable: !!(ret && typeof ret.then === 'function') }
  } catch (e) {
    return { called: false, error: String((e && e.message) || e) }
  }
})()`)
console.log('START_SESSION =', JSON.stringify(start))

await sleep(5000)

const after = await evaluate(`(() => {
  const p = window.__rwslProbe
  const ui = p.ctx.get('uiWorkspace')
  const bodyText = document.body.innerText
  const snap = (name) => {
    try {
      const svc = p.ctx.get(name)
      const s = svc && svc.list && typeof svc.list.getSnapshot === 'function' ? svc.list.getSnapshot() : null
      if (!s) return null
      return s.byId ? { phase: s.phase, count: Object.keys(s.byId).length } : { phase: s.phase, count: (s.items || []).length }
    } catch (e) { return 'err:' + String(e && e.message) }
  }
  return {
    hash: location.hash,
    sessions: snap('sessions'),
    workspaces: snap('workspaces'),
    mainReference: ui.mainReference === undefined ? null : String(ui.mainReference && ui.mainReference.sessionId),
    hasComposer: !!document.querySelector('[contenteditable="true"], textarea'),
    failedToasts: (bodyText.match(/[^\\n]*(失败|无法|错误)[^\\n]*/g) || []).slice(0, 5),
  }
})()`)
console.log('AFTER:', JSON.stringify(after))
console.log('CONSOLE_TAIL:')
for (const line of consoleLines.slice(-15)) console.log('  ' + line)

const opened = !!(after && after.mainReference)
ws.close()
process.exit(opened ? 0 : 1)
