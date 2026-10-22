#!/usr/bin/env node
/**
 * probe-uiworkspace.ts —— 取证：第三方 client 插件的 ctx 能不能 `ctx.get("uiWorkspace")`。
 *
 * 背景（handoff-2026-10-22 §5「未验证」第 1 条）：「在此目录新建会话」走
 * `api.addWorkspace(UNC)` → 客户端 `ctx.get("uiWorkspace").startSession(ws.id)`，
 * 但"插件 ctx 是否拿得到这个服务"此前只有单元探针（假 ctx），没有真机验证。
 *
 * 为什么必须改一下插件：`apply(ctx)` 收到的 ctx 不暴露给页面，CDP 也没法伸手进去。
 * ⇒ 需要一段**临时**探针代码（验完即删，不在任何提交里）。原样贴在下面，按它改 `client/index.js`
 * 的 `apply()` 末尾（`bootSettled.then(registerList, registerList);` 之后）：
 *
 *   // 【临时取证 · 验完即删】
 *   (function probeUiWorkspace() {
 *     const out = { at: "apply", get: typeof ctx.get, tries: [] };
 *     const round = (label) => {
 *       const row = { label };
 *       try {
 *         const ui = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
 *         row.uiHit = ui !== undefined && ui !== null;
 *         if (row.uiHit) {
 *           row.startSession = typeof ui.startSession;
 *           row.openSession = typeof ui.openSession;
 *           row.listDirectory = typeof ui.listDirectory;
 *         }
 *       } catch (e) { row.uiError = String((e && e.message) || e); }
 *       try {
 *         const loc = typeof ctx.get === "function" ? ctx.get("locale") : undefined;
 *         row.localeHit = loc !== undefined && loc !== null;
 *       } catch (e) { row.localeError = String((e && e.message) || e); }
 *       out.tries.push(row);
 *       try { document.documentElement.setAttribute("data-rwsl-ui-probe", JSON.stringify(out)); } catch (e) {}
 *       try { console.log("[rwsl-ui-probe] " + JSON.stringify(out)); } catch (e) {}
 *     };
 *     round("apply");
 *     setTimeout(() => round("t+1500"), 1500);
 *     setTimeout(() => round("t+4000"), 4000);
 *   })();
 *
 * 为什么不用 `chrome --dump-dom`：页面持 websocket，dump 等到超时也不返回（实测 3 分钟无输出）。
 * 用 CDP 直读 attribute 才是确定的。
 *
 * 用法（先起实例，再起 headless Chrome，最后跑本脚本）：
 *   dsh web --port 8917 --no-open                                    # 打印带 token 的 URL
 *   chrome --headless=new --remote-debugging-port=8966 --user-data-dir=%TEMP%\probe-chrome <URL>
 *   node probe-uiworkspace.ts 8966 25
 *
 * 退出码：0 = 读到 ≥2 轮结果；1 = 未就绪/超时（会贴 console 采样）。
 */
const port = Number(process.argv[2] ?? 8965)
const waitSec = Number(process.argv[3] ?? 25)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function getJson(path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return await res.json()
}

let version: any = null
for (let i = 0; i < 40; i += 1) {
  try {
    version = await getJson('/json/version')
    break
  } catch {
    await sleep(500)
  }
}
if (version === null) {
  console.log('FAIL: CDP 未就绪（--remote-debugging-port 没起？）')
  process.exit(1)
}
console.log('CDP:', version['Browser'] ?? JSON.stringify(version).slice(0, 120))

let page: any = null
for (let i = 0; i < 40; i += 1) {
  const list = (await getJson('/json/list')) as any[]
  page = list.find((t) => t.type === 'page') ?? null
  if (page) break
  await sleep(500)
}
if (!page) {
  console.log('FAIL: 没有 page target')
  process.exit(1)
}
console.log('page url =', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (ev: MessageEvent) => {
  const msg = JSON.parse(String(ev.data))
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

const evaluate = async (expression: string) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return res?.result?.result?.value
}

const deadline = Date.now() + waitSec * 1000
let last: string | null = null
while (Date.now() < deadline) {
  const attr = await evaluate("document.documentElement.getAttribute('data-rwsl-ui-probe')")
  if (typeof attr === 'string' && attr.length > 0) {
    last = attr
    const parsed = JSON.parse(attr)
    if (Array.isArray(parsed.tries) && parsed.tries.length >= 2) break
  }
  await sleep(500)
}

const final = await evaluate("document.documentElement.getAttribute('data-rwsl-ui-probe')")
console.log('document.title =', JSON.stringify(await evaluate('document.title')))
console.log('document.readyState =', JSON.stringify(await evaluate('document.readyState')))
if (last !== null && last !== final) console.log('（中间态）', last)
console.log('PROBE_JSON =', final === null || final === undefined ? 'MISSING' : final)
ws.close()
process.exit(final ? 0 : 1)
