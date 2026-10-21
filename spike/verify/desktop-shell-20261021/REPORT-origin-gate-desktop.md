# 桌面端「远程资源管理器」全量 403 —— 根因、修复与回归证据（2026-10-21）

## 1. 现象

用户截图（DSH Desktop 窗口）：侧栏「远程资源管理器」面板显示
`目标未知（读取失败）`、`读取远程资源失败（当前没有可用数据）`，红框内是 host 原话
`跨站请求被拒（Origin/Host 不同源）`，下方「重试」无效。

## 2. 根因（已证，不是网络问题）

1. 面板数据面唯一出口是相对路径 `POST /remote-wsl/api`（`client/client.api.js:35,158`），
   在桌面端解析成 `dsh-app://app/remote-wsl/api`。
2. 桌面壳主窗口载的是 `dsh-app://app/`（`app.asar/lib/main.js`：`applicationUrl = "dsh-app://app/"`，
   :12134；`protocol.handle(SCHEME, …)` :12406-12413），**不是** http origin。
3. 该 scheme handler 把非静态资源交给 `forwardWebRequest()`（:8268-8298）：
   - 先要求 `origin === 'dsh-app://app'`（:8270-8271）；
   - 然后**删掉** `host`/`origin`/`cookie`/`sec-fetch-site`（:8276-8281），装上宿主 cookie；
   - 再用 **Node fetch** 重放到 `http://127.0.0.1:<port>`。
4. Node fetch 不会补 `Origin` ⇒ 到达插件路由的请求**没有 Origin**。
5. 旧 `isSameOrigin()` 第一条就是"`Origin` 必须存在"（修前 `src/explorer.ts:854-855`），
   于是**任何方法都不执行**，直接 403 —— 面板所有读取与动作全灭；6 个 agent 工具不受影响。

历史 FMEA 早已把这条列为"未实测"（`reliability/FMEA.md` F9(d)/F26/F27），本次实测确认。

## 3. 修复（一行判据 + 文档）

`src/explorer.ts`：`if (!origin) return false` → `return true`，其余判据不变。

语义（与官方 `@deepseek-ai/dsh-client-connection` 的 `admit()` 同策略，`lib/index.js:238-249`）：

| 形状 | 判据 |
|---|---|
| 浏览器同源 | `Origin` 存在且与 `Host` 同源（`Sec-Fetch-Site` 存在时必须 `same-origin`） |
| 桌面壳转发 / 本机客户端 | 无 `Origin` **且** 无 `Sec-Fetch-Site` ⇒ 放行 |
| 第三方网页 CSRF | `Origin` 异源、或 `Sec-Fetch-Site: cross-site` ⇒ 403（且一个方法都不执行） |
| 缺 `Host` | 403 |

为什么不是"放宽 web 面"的新口子：浏览器对**每一个 POST** 都带 `Origin`（同源也带），
对每个非导航请求都带 `Sec-Fetch-Site`，两个头都缺失只可能来自非浏览器客户端；而本机进程
本来就能直接伪造 `Origin`（实测：带 `Origin: http://127.0.0.1:59014` 的 GET 在**没有 cookie**
的情况下返回 200）⇒ 闸门本来就只是 CSRF 边界，不是身份认证。桌面壳的形状与官方静态插件
路由受到的对待完全一致。

## 4. 验证

| 证据 | 结果 |
|---|---|
| 回归矩阵 `out-before-origin-matrix.json`（修复前源码） | **8/12**，C2/C3/C4/C8 FAIL（403，文案与用户截图逐字相同） |
| 回归矩阵 `out-after-origin-matrix.json`（修复后源码） | **12/12 PASS**（含 C5 异源 403、C7 cross-site 403、C12 无 Host 403、C9 405、C10 415、C11 400） |
| 真机探针 `out-live-host-before-restart.json`（运行中的桌面宿主 59014，仍是旧代码） | browser- GET 200；desktop-shell GET / POST **403** —— 与桌面壳行为一致 |
| 门禁 | `check-client-rev` PASS（rev `b49be5546840`，11 chunks）；`check-explorer-methods --check` 8 断言 PASS；`check-docs-methods` 13 断言 PASS |

复跑：

    node spike/verify/desktop-shell-20261021/probe-origin-matrix.ts --label after
    node spike/verify/desktop-shell-20261021/probe-live-host.ts --label after-restart

## 5. 未完成 / 待确认

- **桌面宿主需要重启**才会加载新的 host 半。本会话就跑在该宿主里，**不能自行重启**
  ⇒ `probe-live-host.ts --label after-restart` 与"面板显示真实数据"由用户重启后确认。
- 浏览器（`dsh web`）路径的既有行为未变：`check-explorer-methods`/`check-docs-methods` 通过，
  矩阵 C1/C9/C10/C11 与修前一致。

## 6. 残留风险（既有，本次未扩大）

1. **路由未鉴权**：`/remote-wsl/api` 不经 DSH 的 browser-session（实测无 cookie 也能 200）。
   任何本机进程可直接调用；闸门只防"第三方网页借用户浏览器发请求"。
2. **DNS rebinding**：`Host` 只校验"存在"，未像官方 `admit()` 那样校验 Host ∈ loopback/绑定地址。
   攻击页把自有域名解析到 127.0.0.1 时 `Host` 与 `Origin` 可自洽 ⇒ 闸门不拦（修前修后同样如此）。
   建议：等 `webServer` 暴露绑定/可信信息后，按官方口径补 Host 白名单。
3. **反代形态**（F26）：反代改写 `Host` 时仍 403 —— 与修前一致，未处理。
