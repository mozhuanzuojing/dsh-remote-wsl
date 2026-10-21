# 多发行版目标切换 + 面板头部选择器（2026-10-21）

## 1. 用户反馈

「UI 很烂，如果有多个 WSL 服务，也没有选择的地方」。截图里头部只有「目标 debian-u8-1 · /home/g」和一句
「仅筛选，不改目标」——**提示还在，控件已经没了**：`header.distroScope` 的文案仍渲染，但选择器在
2026-10-19 的 UX 轮之后被删掉了（`header.distroField` 成了死键）。

## 2. 改了什么

### host（`src/explorer.ts`）

- 每个方法都接受可选 `args.distro`：`snapshot` / `listDir` / `openSession` / `daemon` / `fixPin` / `addWorkspace`。
  - 名字必须出现在 `listDistros()`（`wsl -l -q`）里，否则 **400 E_ARG**（不静默回落默认发行版）。
  - 其余逻辑不变：`daemonSnapshot`、`readWorkspaces`、`ensureDaemon`、`unc()` 都跑在"换过 distro 的 cfg"上。
- 非配置发行版的 `wslHome`：`wsl -d <distro> -- sh -c 'printf %s "$HOME"'` 解析一次（进程内缓存；
  失败缓存 60s 后回落配置值）。**为什么必须解析**：守护 state 目录是 `{wslHome}/.dsh/remote-wsl`，
  猜错会找不到该发行版已有的守护、并把新元数据写到别处。**副作用**：这一步可能把未运行的发行版拉起来
  —— 只发生在用户显式切到该发行版时，且每进程一次。
- `snapshot` 的单飞从"单键"改成**按发行版分键**（A/B 的快照不互相阻塞、不串味）。

### client

- `client.api.js`：新增 `api.setDistro(name)` / `getDistro()`，每次调用自动把 `distro` 合进 `args`；
  面板不需要在 10 个调用点各拼一次参数。
- `client.panel.js`：`chosenDistro` 状态 + `localStorage['dsh-remote-wsl.distro']` 记忆；切换时清目录缓存
  （缓存键只有路径，不清会把 A 的目录显示成 B 的）、重置浏览、重新拉快照；记住的发行版被删/改名时
  收到「未知发行版」后**自动退回缺省目标重试一次**（只一次，不循环）。
- `client.panel.tail.js`：头部 meta 渲染选择器——
  - `distros.length > 1`：真 `<select>`，选项是 `发行版 · 运行中/未运行`；
  - 只有 1 个：静态说明「发行版 X（本机仅 1 个）」，**不摆只有一个选项的死控件**（沿用 2026-10 可用性报告的 L5/D4 结论）。
- i18n：新增 6 个键、删掉两条已失效的「仅筛选」文案，zh/en 222/222 逐键配对。

## 3. 验证

| 证据 | 结果 |
|---|---|
| `probe-selector.ts`（最小 React stub 直接调 renderTail，断言元素树） | **9/9 PASS**：两发行版出 1 个 select / 2 个 option / 当前值正确 / 运行态在选项文案里 / onChange 回传新名字；单发行版无 select、给出带发行版名的静态说明 |
| `probe-host-distro.ts`（真依赖、只读） | **8/8 PASS**：未知发行版 400 E_ARG 且点名请求值；未运行发行版 listDir 503 且点名它；真实发行版 listDir/snapshot 的 `distro` 回显一致；未运行发行版 snapshot 不抛、target 仍是它 |
| `panel-smoke-node`（chunk 装载 + 组件真跑一次） | **18/18 PASS** |
| 门禁 | `check-client-rev` PASS（rev `173252db37f1`）；`check-explorer-methods` 8/8；`check-docs-methods` 13/13；i18n 222/222 paired |

## 4. 未验证 / 限制（如实写）

- **本机只有 1 个发行版**（`wsl -l -v` 只有 `debian-u8-1`）⇒「A 与 B 两个真实发行版之间来回切」没有真机验证；
  多发行版分支用的是**注入的假发行版名**（验证拒绝/降级路径）+ 真实发行版（验证正常路径）。
- 选择器只在**元素树**上验证过（node stub），没有跑真实浏览器的像素/键盘验收；需要宿主重启后人工看一眼。
- 非配置发行版的家目录解析会启动该发行版（见 §2 的副作用说明）；如果用户不希望被启动，需要在选择器上另做"仅浏览"模式。

## 5. 复跑

    node spike/verify/multidistro-20261021/probe-selector.ts
    node spike/verify/multidistro-20261021/probe-host-distro.ts
    node spike/verify/explorer-20261012/arch-t6/tools/panel-smoke-node.ts D:/project/dsh1/dsh-remote-wsl
