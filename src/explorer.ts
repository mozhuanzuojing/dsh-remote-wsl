/**
 * dsh-remote-wsl / explorer —— 「人面」（侧栏面板）的 **host 数据面**。
 *
 * 设计依据：`docs/remote-explorer-design.md` §4（接口原样照做）与 §8（纪律）。
 * 面板只需要**一个聚合快照** + 三个动作；所有数字必须与现有 6 个 agent 工具**同源**
 * （§8.6：面板上的每个数字都要能在 `wsl_status` 找到同一个来源值）。
 *
 * ## 分层（lead 2026-10-12 裁决：传输层与数据面分开）
 *
 *   1. `createExplorerHandlers(deps)` —— **数据面**（无传输、无 `req/res`）：四个方法名逐字，
 *      依赖全部由 index.ts 注入既有实现（所以"同源"是接线方式，不是承诺）。
 *   2. `createExplorerHttpAdapter(webServer)` —— **传输层**：只做 HTTP 语义（动词/头/同源/白名单/
 *      错误映射），业务一律转给上面的方法表。
 *   3. `registerExplorer(ctx, deps)` —— 组合点：等 `webServer` 就绪后把 1 装进 2（index.ts 只调它）。
 *
 * 将来若证实存在零构建可用的 Remote 通道，只换第 2 层（`handlers` 已导出），业务逻辑一行不改。
 *
 * ## 为什么传输不是 §4 里那个 `host.call`
 *
 * 实测（2026-10-12，读官方 asar 源码与 README）：`host.call` 是 **动态包**
 * （`cordis_define`/`cordis_run`）浏览器半的 builtin —— `@deepseek-ai/dsh-cordis-client-runner`
 * README 原文："It receives a fixed set of names — `React`, `console`, `styles`, and `host` …
 * Calling `host.call(method, args)` from the loaded half reaches its own host half"。
 * 而设计稿 §1 自己也写明动态包只能渲染进自己的工具卡、**进不了侧栏**；静态 client 半
 * （`dsh.client`，经 `@deepseek-ai/dsh-client-modules` 编成 `/plugins` 下的 bundle）拿到的是
 * `window.__ModuleLoader__` 的模块表，里面没有 `host`。官方浏览器→host 的 Remote 端点由
 * typertGateway 认领、且是**构建期生成**的（`@Remote` + schema 生成），link 装的零构建插件没有生成物。
 *
 * 所以这里用**真实第三方插件在生产里验证过**的那条通道（dsh-wechat 0.8.0：设置页 API 走
 * `webServer.register`，源码注释明确写 "no @deepseek-ai imports at runtime"）：
 *
 *   POST /remote-wsl/api   body {"method":"explorer.snapshot","args":{}}  → {"ok":true,"result":…}
 *   GET  /remote-wsl/api                                                  → {"ok":true,"methods":[…]}
 *
 * ## 安全边界（lead 新增硬要求，逐条对应）
 *
 * · (a) **同源**：POST 必须带 `Origin` 且与请求 `Host` 同源；再校验 `Sec-Fetch-Site`（若存在）
 *   必须为 `same-origin`；Host 缺失或非同源 ⇒ **403，且一个方法都不执行**。
 * · (b) **硬编码白名单**：`method` 只能命中方法表里的四个字符串，未知 ⇒ **400**（绝不把输入
 *   反射成任意函数，也不用 `handlers[method]` 之外的属性查找）。
 * · (c) **动词与类型**：POST 无 `content-type: application/json` ⇒ 415；其它动词 ⇒ 405。
 *   （GET 只回方法清单，是纯只读发现，同样过同源检查；lead 第 1 条要它。）
 * · (d) **不做全局副作用**：没有 `all=true` 这类会波及其他人的能力；`explorer.daemon` 的
 *   `slot` 一律经 daemon-client 的**本插件 state 目录**读写，`stop` 只停被点名的那个槽位。
 * · (e) **不泄漏凭据**：响应只含 pid/port/version/slot/notes 等面板字段，永不回传 token；
 *   错误只回 message（不回显请求体、不回显 headers）。
 *
 * ## 零构建纪律
 *
 * 只用可擦除语法（无 enum / 无 decorator / 无 namespace / 无参数属性）；相对导入带 `.ts`；
 * 只引 `node:` 内置模块与同目录相对模块，**禁裸 `@deepseek-ai/*`**（link 装的插件解析不到）。
 *
 * @module dsh-remote-wsl/explorer
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { daemonSnapshot, ensureDaemon, stopDaemon, readDaemonMeta, daemonPrompt, unc } from './daemon-client.ts';

/** 四个 RPC 的**逐字**方法名（client 半按这些字符串调用）。 */
export const EXPLORER_METHODS = [
  'explorer.snapshot',
  'explorer.openSession',
  'explorer.daemon',
  'explorer.fixPin',
];

/** 面板数据面的 HTTP 路由（见文件头"传输层"）。 */
export const EXPLORER_ROUTE = '/remote-wsl/api';

/** HTTP 请求体上限（面板调用体极小；超了就是异常用法）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 收藏路径清单在 WSL 侧的落点（与守护元数据同一个 state 目录，避免第二处状态）。 */
const favoritesLinux = (cfg) => `${cfg.wslHome}/.dsh/remote-wsl/explorer.json`;

/** 面板动作里被驱动的**远端会话**用的 runtime key（与 agent 面 `wsl_agent` 的默认 key 区分开）。 */
const EXPLORER_RUNTIME_KEY = 'explorer';

/**
 * `warm:true` 时用来物化 runtime 的那一轮 prompt 正文。
 * 取最短且无副作用的一句：它的**唯一目的**是让上游 daemon 建出 runtime+sessionId
 * （daemon 协议没有别的建会话的臂，见 openSession 注释）。P0 UI **不**调用这条分支。
 */
const WARM_PROMPT = 'ACK';

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * 带**机器可读 code** 的错误（lead 加固 2）。
 * 为什么：`explorer.daemon` / `fixPin` 的失败路径必须回"可读结构化错误 + 合适状态码"，
 * 不允许异常穿过 adapter 变成 500 裸栈。adapter 按 `code` 选状态码：
 *   `E_ARG` → 400（调用方参数错）、`E_UNAVAILABLE` → 503（守护/版本这类"远端此刻不可用"）、
 *   其它/未标 → 500（真内部错）。message 已含可操作诊断（端口被占时 daemon-client 会把
 *   daemon.log 尾部一并带出来），且**不含任何凭据**。
 */
function explorerError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const failArg = (message) => {
  throw explorerError('E_ARG', message);
};
const failUnavailable = (message) => {
  throw explorerError('E_UNAVAILABLE', message);
};

/** Linux 路径的显示名（面板树上的 label 缺省值）。 */
function baseName(p) {
  const s = str(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) || s : s;
}

/** 路径 → 面板树的 kind（设计稿 §4：'folder' | 'code-workspace'）。 */
function kindOf(p) {
  return /\.code-workspace$/i.test(str(p)) ? 'code-workspace' : 'folder';
}

/**
 * `wsl -l -v` 的 NAME/STATE/VERSION 表 → `{ defaultName, running:Set<name> }`。
 *
 * 为什么**不是**逐个 `wsl -d <name> -- true` 探活：那会把**关着的发行版启动起来**（WSL 对任何
 * `wsl -d` 都会拉起该发行版）—— 面板刷一次快照不该有这种副作用。所以 `reachable` 的定义是
 * "该发行版此刻 STATE=Running"，只读、零副作用。
 *
 * 编码坑：`wsl.exe -l -v` 是 **UTF-16LE**，按 utf8 读出来每个字符前有个 `\0`（index.ts 的
 * `listDistros` 也是这么处理的）。名字列表仍以 index.ts 注入的 `listDistros()`（`wsl -l -q`）为准，
 * 这里**只**取 `*`（默认发行版）与 STATE 两个标志，按名字对齐；表里没有的名字两个标志都留 false
 * （不猜）。
 */
function distroFlags() {
  const out = { defaultName: null, running: new Set() };
  let text = '';
  try {
    const res = spawnSync('wsl.exe', ['-l', '-v'], { encoding: 'utf8', windowsHide: true });
    text = str(res.stdout);
  } catch {
    return out;
  }
  if (!text) return out;
  for (const raw of text.replace(/\0/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\*)?\s*(\S+)\s+(Running|Stopped|Installing|Uninstalling|Converting|Exporting)\b/i.exec(line);
    if (!m) continue;
    const name = m[2];
    if (m[1] === '*') out.defaultName = name;
    if (m[3].toLowerCase() === 'running') out.running.add(name);
  }
  return out;
}

/**
 * 收藏路径（面板树的第二层）。
 *
 * 读 WSL 侧 `~/.dsh/remote-wsl/explorer.json`（经 UNC，读失败=没有，不是异常）。
 * 文件形状宽容接受两种：`["/a/b"]` 或 `{"paths":[{"path":"/a/b","label":"x","kind":"folder"}]}`。
 * 都没有时**回落到配置里的 `cwd` 一条**，这样面板第一次打开就至少显示"当前目标目录"，
 * 而不是空树 —— 这个回落是本次引入的约定，已写进交付报告，等 lead/client 半确认。
 */
function readWorkspaces(cfg) {
  const fallback = [
    { distro: cfg.distro, path: cfg.cwd, label: baseName(cfg.cwd) || cfg.cwd, kind: kindOf(cfg.cwd) },
  ];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(unc(cfg.distro, favoritesLinux(cfg)), 'utf8'));
  } catch {
    return fallback;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.paths) ? parsed.paths : [];
  const out = [];
  for (const entry of list) {
    const path = str(typeof entry === 'string' ? entry : entry?.path).trim();
    if (!path) continue;
    const o = typeof entry === 'object' && entry ? entry : {};
    out.push({
      distro: str(o.distro) || cfg.distro,
      path,
      label: str(o.label) || baseName(path) || path,
      kind: o.kind === 'code-workspace' || kindOf(path) === 'code-workspace' ? 'code-workspace' : 'folder',
    });
  }
  return out.length ? out : fallback;
}

/**
 * ── 数据面（第 1 层）────────────────────────────────────────────────────────────
 * 构造四个方法的方法表。**纯依赖注入**：`deps` 里全是 index.ts 已有的实现
 * （所以"同源"不是承诺，而是接线方式），本模块不复制它们的判断。
 *
 * @param deps.config          归一后的插件配置（index.ts 的 `{...DEFAULTS, ...rawConfig}`）
 * @param deps.listDistros     index.ts 的 `listDistros()`（`wsl -l -q`）—— `wsl_status` 用的同一个
 * @param deps.resolveVersion  index.ts 的 `resolveVersion()` —— 版本/pin/drift 的同一个
 * @param deps.writePin        index.ts 的 `writePin()` —— `wsl_sync_version` 写 pin 的同一个
 * @param deps.webHosts        index.ts 的 `webHosts` Map（port → WebHost）—— `wsl_open_ui` 的同一个
 */
export function createExplorerHandlers(deps) {
  const cfg = deps.config;
  const log = (m) => process.stderr.write(`remote-wsl(explorer): ${m}\n`);

  /** `explorer.snapshot` —— 只读聚合快照；**不启动、不停止、不写任何东西**。 */
  async function snapshot() {
    const names = deps.listDistros();
    const flags = distroFlags();
    const distros = names.map((name) => ({
      name,
      default: flags.defaultName === name,
      reachable: flags.running.has(name), // 定义见 distroFlags()：此刻 STATE=Running（不探活、零副作用）
    }));

    const v = deps.resolveVersion(cfg);

    // ★ 单一真相源：daemon 段只能来自 daemonSnapshot()（= wsl_status / wsl_daemon status 的同一函数）。
    //   `live[0]` 的选择口径与 daemonStatus() 完全一致（同一个数组、同一顺序，
    //   listDaemonSlots 已把 cfg.daemonPort 排最前）。
    const ds = await daemonSnapshot(cfg);
    const live = Array.isArray(ds.live) ? ds.live : [];
    const first = live[0];
    const liveKeys = Array.isArray(first?.info?.keys) ? first.info.keys : [];
    const daemon = first
      ? {
          running: true,
          slot: first.slot,
          pid: first.info?.daemonPid ?? null,
          // `port` 是对 §4 字段表的一处**加法**（§4 原文只列 running/slot/pid/version/keys/orphans）：
          // §2 的状态条与 §6 验收②都要显示守护端口，而 T4 的比对器有 daemon.port 一项。
          // 来源同一个：daemonSnapshot() 的 live[0].info.port（= wsl_status 的 `actualPort=`）。
          port: first.info?.port ?? null,
          version: first.info?.version ?? null,
          keys: liveKeys.map((k) => str(k?.key)),
          orphans: Array.isArray(ds.orphans) ? ds.orphans.length : 0,
        }
      : {
          running: false,
          keys: [],
          orphans: Array.isArray(ds.orphans) ? ds.orphans.length : 0,
        };

    const drift = v.drift
      ? { drifted: true, desktop: v.drift.desktop ?? null, pin: v.drift.pin ?? null }
      : { drifted: false };

    const webHosts = [];
    if (deps.webHosts && typeof deps.webHosts[Symbol.iterator] === 'function') {
      for (const [port, host] of deps.webHosts) {
        if (host && typeof host.url === 'string' && host.url) webHosts.push({ port: Number(port), url: host.url });
      }
    }

    return {
      distros,
      target: { distro: cfg.distro, wslHome: cfg.wslHome, cwd: cfg.cwd },
      daemon,
      drift,
      workspaces: readWorkspaces(cfg),
      webHosts,
    };
  }

  /**
   * `explorer.openSession({distro, path, warm?})` —— 在 WSL 里取得（或物化）该 cwd 的远端会话。
   *
   * ⚠️ **与设计稿 §5 的降级 + lead 裁决（2026-10-12）**：上游 daemon 协议只有
   * hello/status/prompt/shutdown（daemon.ts 实测），**没有**"不发一轮 prompt 就建会话"的臂 ——
   * runtime + sessionId 只在 `prompt` 里被物化。所以：
   *   · 默认（`warm` 缺省/false）：幂等 ensure 守护（复用 daemon-client 的 ensureDaemon，与
   *     `wsl_daemon action=start` 同一臂）→ 从守护元数据取该 `(key, cwd)` 已有的 sessionId
   *     （与 index.ts `priorSessionFor` 同一来源）；取不到就如实返回 `{sessionId:null, created:false}`
   *     —— **不偷偷烧一次模型调用**。
   *   · `warm:true`：显式允许走既有 `daemonPrompt` 真起一轮，把 runtime+sessionId 物化出来。
   *     P0 UI **不暴露**这个参数（lead：留给 P1 的显式动作）；这里保留分支并标注。
   */
  async function openSession(args) {
    const distro = str(args?.distro) || cfg.distro;
    const path = str(args?.path).trim();
    if (!path) failArg('remote-wsl: explorer.openSession 需要 path（WSL 绝对路径）');
    if (!path.startsWith('/')) {
      failArg(`remote-wsl: explorer.openSession 的 path 必须是 WSL 绝对路径（以 / 开头），收到 "${path}"`);
    }
    if (distro !== cfg.distro) {
      failArg(
        `remote-wsl: explorer.openSession 收到 distro=${distro}，但本插件当前只驱动配置里的 "${cfg.distro}"` +
          `（一次一个发行版；要换请改 config.distro）`,
      );
    }
    const v = deps.resolveVersion(cfg);
    if (!v.version) failUnavailable('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');

    const found = (readDaemonMeta(cfg)?.keys ?? []).find(
      (k) => str(k?.key) === EXPLORER_RUNTIME_KEY && str(k?.cwd ?? cfg.cwd) === path,
    );
    if (found?.sessionId) {
      return {
        sessionId: String(found.sessionId),
        cwd: path,
        distro,
        created: false,
        reused: true,
        warm: false,
        note: '复用守护里已存在的运行时（同一 key+cwd ⇒ 同一上下文）',
      };
    }

    const ensured = await ensureDaemon(cfg, { version: v.version, log });
    if (!ensured.ok) throw new Error(`remote-wsl: ${ensured.error}`);
    const daemonInfo = { slot: ensured.slot ?? null, port: ensured.port ?? null, pid: ensured.info?.daemonPid ?? null };

    // ── warm 分支：仅在显式 warm:true 下走（P0 UI 不暴露）──────────────────────
    if (args?.warm === true) {
      const r = await daemonPrompt(cfg, {
        port: ensured.port,
        token: ensured.token,
        key: EXPLORER_RUNTIME_KEY,
        text: WARM_PROMPT,
        cwd: path,
        timeoutMs: Number(cfg.timeoutMs),
      });
      if (!r.ok || !r.sessionId) {
        failUnavailable(
          `remote-wsl: warm 开会话失败（${r.queueFull ? '并发超限' : r.kind ?? 'op 失败'}）：${r.error ?? '(no error)'}`,
        );
      }
      return {
        sessionId: String(r.sessionId),
        cwd: str(r.cwd) || path,
        distro,
        created: true,
        reused: false,
        warm: true,
        daemon: daemonInfo,
        note: '已用一轮 prompt 物化运行时（warm:true 是显式动作，P0 UI 不调用）',
      };
    }

    return {
      sessionId: null,
      cwd: path,
      distro,
      created: false,
      reused: false,
      warm: false,
      daemon: daemonInfo,
      note:
        '守护已就绪，但该 cwd 尚无远端会话：上游 daemon 只在收到一轮 prompt 时才物化 runtime+sessionId。' +
        `首次用 wsl_agent（cwd=${path}）发一轮后，本方法即返回该 sessionId；或显式 openSession({warm:true})。`,
    };
  }

  /**
   * `explorer.daemon({action,slot})` —— 幂等结果；三个动作都复用既有臂：
   * `ensure`/`restart` → `daemon-client.ensureDaemon`（= `wsl_daemon action=start|restart`），
   * `stop` → `daemon-client.stopDaemon`（= `wsl_daemon action=stop`）。
   * 安全边界 (d)：**没有** `all=true` 之类的入口；`slot` 一律经 daemon-client 在**本插件自己的
   * state 目录**（`~/.dsh/remote-wsl/daemon.<slot>.json`）里解析，`stop` 只停被点名的那个槽位，
   * 绝不遍历/连带别的槽位。
   */
  async function daemonAction(args) {
    const action = str(args?.action) || 'ensure';
    const slot = args?.slot == null ? undefined : Number(args.slot);
    if (slot !== undefined && (!Number.isFinite(slot) || slot <= 0)) {
      failArg(`remote-wsl: explorer.daemon 的 slot 非法: ${String(args?.slot)}`);
    }
    // slot 只在**本次调用**里覆盖 daemonPort（与 wsl_daemon 的 "配置端口即槽位" 语义一致）
    const eff = slot === undefined ? cfg : { ...cfg, daemonPort: slot };

    if (action === 'ensure' || action === 'restart') {
      const v = deps.resolveVersion(eff);
      if (!v.version) failUnavailable('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');
      const r = await ensureDaemon(eff, { version: v.version, restart: action === 'restart', log });
      // 失败原因原样带出（daemon-client 已含"端口被占/握手超时/daemon.log 尾部"这类可操作诊断）
      if (!r.ok) failUnavailable(`remote-wsl: ${r.error}`);
      return {
        action,
        ok: true,
        idempotent: true,
        slot: r.slot ?? null,
        port: r.port ?? null,
        pid: r.info?.daemonPid ?? null,
        version: r.info?.version ?? null,
        reused: r.reused === true,
        started: r.started === true,
        notes: Array.isArray(r.notes) ? r.notes : [],
      };
    }
    if (action === 'stop') {
      const r = await stopDaemon(eff, slot === undefined ? { log } : { log, slot });
      return {
        action,
        ok: true,
        idempotent: true,
        alreadyStopped: r.alreadyStopped === true,
        slot: r.slot ?? null,
        port: r.port ?? null,
        pid: r.pid ?? null,
        version: r.version ?? null,
        reaped: Array.isArray(r.reaped) ? r.reaped.length : 0,
        notes: r.note ? [r.note] : [],
      };
    }
    throw explorerError('E_ARG', `remote-wsl: explorer.daemon 不认识 action=${action}（可选 ensure|stop|restart）`);
  }

  /**
   * `explorer.fixPin()` —— 与 `wsl_sync_version` **同一实现**（`resolveVersion` + `writePin`），
   * 只修 pin，**绝不重启/停止守护**（§5：默认只告警，显式点击才动手；语义 #5）。不 warm（warm 是
   * `wsl_sync_version --warm` 的显式选项，面板的"修 pin"不该顺带下载）。
   */
  async function fixPin() {
    const v = deps.resolveVersion(cfg);
    const pinBefore = v.pin ?? null;
    if (!v.version) {
      return {
        ok: false,
        pinBefore,
        pinAfter: pinBefore,
        wrote: false,
        error: '无法确定要 pin 的版本（桌面 runtime.json 不可读且未配 dshVersion）',
      };
    }
    const wrote = deps.writePin(cfg, v.version) === true;
    const after = deps.resolveVersion(cfg);
    return {
      ok: wrote,
      pinBefore,
      pinAfter: after.pin ?? null,
      wrote,
      version: v.version,
      desktopVersion: v.desktopVersion ?? null,
      driftBefore: v.drift ? { desktop: v.drift.desktop ?? null, pin: v.drift.pin ?? null } : null,
      driftAfter: after.drift ? { desktop: after.drift.desktop ?? null, pin: after.drift.pin ?? null } : null,
      note: wrote
        ? '已写入 WSL 侧 pin；守护未被动过（要换版本请用 explorer.daemon action=restart）'
        : '写入失败（WSL 侧 pin 文件不可写）',
    };
  }

  const handlers = {
    'explorer.snapshot': snapshot,
    'explorer.openSession': openSession,
    'explorer.daemon': daemonAction,
    'explorer.fixPin': fixPin,
  };
  return { handlers, log };
}

/**
 * ── 传输层（第 2 层）────────────────────────────────────────────────────────────
 *
 * 同源判据（安全要求 (a)）：
 *   · `Origin` **必须存在**，且其 `host[:port]` 与请求的 `Host` 头逐字相同；
 *   · 若带 `Sec-Fetch-Site`，必须是 `same-origin`（浏览器同源 fetch 会带）。
 * 任一不满足 ⇒ `false`（调用方回 403，且**一个方法都不执行**、不解析请求体）。
 *
 * 为什么按 `Host` 比而不是比配置里的端口：GUI 可能是 `dsh web --port N` 起的（N 可变），
 * `Origin`/`Host` 是**同一次请求自证**的一对，比较它们不依赖任何配置。这是 CSRF 防线
 * （挡跨站发起的请求），不是身份认证 —— 身份仍由 DSH 自己的 browser-session 负责。
 */
function isSameOrigin(req) {
  const headers = req?.headers ?? {};
  const host = str(headers.host).trim();
  if (!host) return false;
  const site = str(headers['sec-fetch-site']).trim().toLowerCase();
  if (site && site !== 'same-origin') return false;
  const origin = str(headers.origin).trim();
  if (!origin) return false;
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost.toLowerCase() === host.toLowerCase();
}

/** 从请求体里读 JSON（上限 `MAX_BODY_BYTES`）。 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, status, body) {
  try {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (typeof res.end === 'function') res.end(JSON.stringify(body));
  } catch (e) {
    process.stderr.write(`remote-wsl(explorer): 写响应失败: ${e?.message ?? String(e)}\n`);
  }
}

/** 失败 `code` → HTTP 状态码（lead 加固 2：错误路径必须是可读结构化响应，不是 500 裸栈）。 */
const STATUS_BY_CODE = { E_ARG: 400, E_UNAVAILABLE: 503 };

/**
 * 把方法表装进 HTTP。**本层不做任何业务判断**，只做动词/头/白名单/错误映射。
 *
 * @param webServer `ctx.get('webServer')`
 * @param handlers  `createExplorerHandlers(...).handlers`
 * @returns `{ dispose }`
 */
export function createExplorerHttpAdapter(webServer, handlers) {
  const dispose = webServer.register({
    kind: 'exact',
    path: EXPLORER_ROUTE,
    handler: async (req, res) => {
      const method0 = str(req?.method).toUpperCase();

      // (a) 同源门：先过，再看别的 —— 不满足时任何方法都不执行。
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: '跨站请求被拒（Origin/Host 不同源）' });
        return;
      }

      // GET = 纯只读的方法发现（lead 第 1 条）；其余动词一律 405。
      if (method0 === 'GET') {
        sendJson(res, 200, { ok: true, methods: EXPLORER_METHODS });
        return;
      }
      if (method0 !== 'POST') {
        sendJson(res, 405, { ok: false, error: `只接受 GET（方法清单）与 POST（调用）；收到 ${method0}` });
        return;
      }

      // (c) 类型：必须是 application/json。
      const ctype = str(req?.headers?.['content-type']).toLowerCase();
      if (!ctype.includes('application/json')) {
        sendJson(res, 415, { ok: false, error: `POST 需要 content-type: application/json（收到 "${ctype || '(空)'}"）` });
        return;
      }

      let method = '';
      let args = {};
      try {
        const body = await readJsonBody(req);
        method = str(body?.method);
        args = body?.args && typeof body.args === 'object' ? body.args : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON: ${e?.message ?? String(e)}` });
        return;
      }

      // (b) 硬编码白名单：只有方法表里这四个字符串能被执行。
      const handler = EXPLORER_METHODS.includes(method) ? handlers[method] : undefined;
      if (typeof handler !== 'function') {
        sendJson(res, 400, { ok: false, error: `未知方法 ${method || '(空)'}`, methods: EXPLORER_METHODS });
        return;
      }

      try {
        const result = await handler(args);
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        // (e) 只回 message + 机器可读 code，不回显请求体 / headers / 任何凭据、不带栈
        const code = str(e?.code);
        sendJson(res, STATUS_BY_CODE[code] ?? 500, { ok: false, error: e?.message ?? String(e), code: code || 'E_UNKNOWN' });
      }
    },
  });
  return { dispose };
}

/**
 * ── 组合点（第 3 层）────────────────────────────────────────────────────────────
 *
 * 与 `wsl_status` 一样**不假设 `webServer` 在 apply 时就绪**（它是条件注入的服务）：
 * 用 `ctx.inject(['webServer'], …)` 等它就绪再注册（dsh-wechat 的同一模式）。服务不可用时
 * 只打一行 stderr —— 插件其余 6 个工具与 `createExplorerHandlers()` 的方法表都不受影响。
 *
 * @returns {{ methods: string[], handlers: Record<string, Function>, route: string, dispose: () => void }}
 */
export function registerExplorer(ctx, deps) {
  const { handlers, log } = createExplorerHandlers(deps);
  let removeRoute = null;

  /**
   * 把路由注册**整体**包进 try/catch（lead 加固 1，阻断级）。
   *
   * 为什么：官方 `webServer.register` 在**重复 (kind,path)** 时 throw；而注册发生在
   * `ctx.inject` 回调里。异常冒出去可能 ① 把整个插件（含 6 个 agent 工具）带下去；
   * ② 留下"注册成功但 dispose 还没接上"的无主残留。所以：
   *   · 注册成功 → `removeRoute` 立刻接上，并返回可等待的 disposer；
   *   · 注册 throw → 只**降级数据面**（打一行 `explorer http route unavailable: …`），
   *     插件其余部分照常；此时没有任何东西被注册，也就不存在残留；
   *   · 兜底：万一在赋值之后才抛，先把已注册的路由 dispose 掉再降级（不留无主残留）。
   */
  const registerRoute = (webCtx) => {
    let adapter = null;
    try {
      const webServer = typeof webCtx?.get === 'function' ? webCtx.get('webServer') : undefined;
      if (!webServer || typeof webServer.register !== 'function') {
        log('webServer 服务不可用 ⇒ explorer.* 的 HTTP 路由未注册（方法表仍可用）');
        return;
      }
      adapter = createExplorerHttpAdapter(webServer, handlers);
      removeRoute = adapter.dispose;
      log(`面板数据面已注册: ${EXPLORER_ROUTE}（方法 ${EXPLORER_METHODS.join(', ')}）`);
    } catch (e) {
      // 降级，但先把可能已建立的路由收干净（register 返回 disposer 之后才抛的唯一情形）
      if (adapter && typeof adapter.dispose === 'function') {
        try {
          adapter.dispose();
        } catch (e2) {
          log(`dispose 已注册路由时又失败: ${e2?.message ?? String(e2)}`);
        }
      }
      removeRoute = null;
      log(`explorer http route unavailable: ${e?.message ?? String(e)}（面板数据面降级；6 个 agent 工具不受影响）`);
      return;
    }
    return () => {
      try {
        if (typeof removeRoute === 'function') removeRoute();
      } catch (e) {
        log(`移除路由失败: ${e?.message ?? String(e)}`);
      }
      removeRoute = null;
    };
  };

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], registerRoute);
  } else {
    log('ctx.inject 不可用 ⇒ explorer.* 的 HTTP 路由未注册（方法表仍可用）');
  }

  return {
    methods: EXPLORER_METHODS.slice(),
    handlers,
    route: EXPLORER_ROUTE,
    dispose: () => {
      if (typeof removeRoute === 'function') removeRoute();
      removeRoute = null;
    },
  };
}
