/**
 * dsh-remote-wsl / explorer —— 「人面」（侧栏面板）的 **host 数据面**。
 *
 * 设计依据：`docs/remote-explorer-design.md` §4（接口原样照做）与 §8（纪律）。
 * 面板只需要**一个聚合快照** + 三个动作；所有数字必须与现有 6 个 agent 工具**同源**
 * （§8.6：面板上的每个数字都要能在 `wsl_status` 找到同一个来源值）。
 *
 * ## 分层（lead 2026-10-12 裁决：传输层与数据面分开）
 *
 *   1. `createExplorerHandlers(deps)` —— **数据面**（无传输、无 `req/res`）：方法名逐字，
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
 * · (a) **来源可信**（2026-10-21 修正桌面壳误杀）：`Sec-Fetch-Site` 若存在必须是 `same-origin`；
 *   `Origin` 若存在必须与请求 `Host` 同源；**两者都缺失 = 非浏览器客户端（桌面壳转发 / curl），放行**
 *   —— 与官方 `dsh-client-connection` 的 `admit()` 同策略（`origin === undefined ⇒ true`）。
 *   Host 缺失、`Sec-Fetch-Site` 非 same-origin、`Origin` 异源 ⇒ **403，且一个方法都不执行**。
 * · (b) **硬编码白名单**：`method` 只能命中方法表里那几个**字面量**字符串，未知 ⇒ **400**（绝不把输入
 *   反射成任意函数，也不用 `handlers[method]` 之外的属性查找）。
 * · (c) **动词与类型**：POST 无 `content-type: application/json` ⇒ 415；其它动词 ⇒ 405。
 *   （GET 只回方法清单，是纯只读发现，同样过同源检查；lead 第 1 条要它。）
 * · (d) **不做全局副作用**：没有 `all=true` 这类会波及其他人的能力；`explorer.daemon` 的
 *   `slot` 一律经 daemon-client 的**本插件 state 目录**读写，`stop` 只停被点名的那个槽位。
 * · (e) **不泄漏凭据**：响应只含 pid/port/version/slot/notes 等面板字段；`webHosts[].url` 在透传前
 *   **脱敏**（`?token=…` 的值打码，保留 host:port —— F-37：面板会把 snapshot 渲染进 DOM 并可复制）；
 *   错误只回 `{code,error,detail,reason}`（不回显请求体、不回显 headers、不带栈）。
 *
 * ## 零构建纪律
 *
 * 只用可擦除语法（无 enum / 无 decorator / 无 namespace / 无参数属性）；相对导入带 `.ts`；
 * 只引 `node:` 内置模块与同目录相对模块，**禁裸 `@deepseek-ai/*`**（link 装的插件解析不到）。
 *
 * @module dsh-remote-wsl/explorer
 */
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { daemonSnapshot, ensureDaemon, stopDaemon, readDaemonMeta, daemonPrompt, unc } from './daemon-client.ts';
import { parseWslUncPath } from './unc-path.ts';
import { invalidateProxyCache, resolveWslProxy } from './wsl-proxy.ts';
import { readWslOutput } from './wsl-output.ts';
import { parseWslDistroTable } from './distro-table.ts';
import { targetProblem, NO_DISTRO_REASON, NO_HOME_REASON } from './config.ts';
import { asConfigText } from './target-detect.ts';

/** RPC 的**逐字**方法名（client 半按这些字符串调用）。 */
export const EXPLORER_METHODS = [
  'explorer.snapshot',
  'explorer.openSession',
  'explorer.daemon',
  'explorer.fixPin',
  'explorer.listDir',
  'explorer.addWorkspace',
  'explorer.newSession',
];

/**
 * 本表是**方法名的唯一权威**（T4，2026-10-13）。三处消费它，都不许各自再抄一份：
 *   · `client/client.api.js` 的 `METHODS` —— **零构建**的手写 bundle 只能复制字面量，
 *     所以那边是"投影"：`arch-t2/tools/check-docs-methods.ts`（跨任务门禁；2026-10-13 由 .mjs 更名，判据未改）与
 *     `arch-t4/tools/check-explorer-methods.ts`（本任务新增，带 `--print` 可再生成）逐项校验一致；
 *   · HTTP 白名单与 `GET /remote-wsl/api` 的方法清单（直接读 `EXPLORER_METHODS`）；
 *   · README / 设计稿 §4 的方法表（由上面那个门禁断言列全）。
 * 改这里 ⇒ 必须同步 client 投影与两份文档，否则门禁红。
 */

/**
 * **发现选择器**（T4）：`wsl_status` 的发现语义 —— "这台机器上发现了哪些守护"。
 * 与 {@link selectOwnedDaemon} 的所有权语义**刻意区分**；线上字段正式改名
 * `discoveredDaemon` 属 P2（README「仍余」②），本轮只命名、不改名。
 * @param live - `daemonSnapshot()` 的 `live` 列表（只读透传，不做筛选）。
 * @returns 同一列表（语义命名点，不改变行为）。
 */
export const discoverDaemons = <T>(live: readonly T[]): readonly T[] => live;

/**
 * **所有权选择器**（T4）：只认本插件配置的槽位 —— "我们拥有哪一个守护"。
 * `explorer.snapshot().daemon` 用它；**绝不回落到 `live[0]`**（F33：那会显示别人的槽位，
 * 而 UI 的停止/重启以该 slot 为目标 ⇒ 跨实例误停）。
 * @param live - `daemonSnapshot()` 的 `live` 列表。
 * @param slot - 本插件配置的槽位（`cfg.daemonPort`）；`null` ⇒ 明确返回 `null`。
 * @returns 命中槽位的那条，或 `null`。
 */
export const selectOwnedDaemon = <T extends { slot?: unknown }>(live: readonly T[], slot: number | null): T | null =>
  slot === null ? null : (live.find((item) => Number(item.slot) === slot) ?? null);

/** 面板数据面的 HTTP 路由（见文件头"传输层"）。 */
export const EXPLORER_ROUTE = '/remote-wsl/api';

/** HTTP 请求体上限（面板调用体极小；超了就是异常用法）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 发行版事实（`wsl -l -q` 的名字列表 + `wsl -l -v` 的 STATE/默认标志）的**短 TTL**。
 *
 * 为什么可以缓存：这两条只是"这台机器上此刻有哪些发行版、哪个在跑"的**只读快照**；每次
 * `wsl.exe` spawn 实测 ~45–60ms（见 `spike/verify/uiux-20261019/host-perf/`），而面板一次刷新会
 * **连着**调 `snapshot` + `listDir`，两处都要同一份事实 ⇒ 不合并就是重复的 spawn 成本。
 *
 * 为什么是 2s：远长于一次面板刷新（百毫秒级），又短到"用户刚在 Windows 终端里 `wsl --terminate`
 * 再看面板"最多滞后 2s。**这不是实时性承诺**：`reachable` 的语义仍是"上一次探测时 STATE=Running"，
 * 只是在 TTL 窗口内复用了那次探测的结果。
 *
 * **失败不缓存**：名字列表为空（可能是 `wsl.exe` 不可用/输出异常）或 STATE 表读取失败时，
 * 既不写入也不复用旧值，下一次调用立刻重试 —— 不把一次瞬时故障放大成 TTL 窗口内的假阴性
 * （"发行版不存在 / 未运行"）。
 */
const DISTRO_FACTS_TTL_MS = 2000;

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
 *
 * ★ F-36（task-8，统一错误体 `{code, message, detail}`）：`detail` 是**给人折叠看的技术细节**
 *   （systemd/unit/daemon.log 尾部…），`reason` 是**给机器判的稳定短标签**（如 `unknown-distro`）。
 *   为什么要有：面板的主句必须是用户语言（i18n），host 的中文技术文案只能进 detail；
 *   而"记住的发行版被删/改名"这类**客户端要自动纠偏**的场景又不能靠匹配中文句子——
 *   过去 `client.panel.js` 里那句 `message.indexOf("未知发行版")` 就是契约漂移的典型。
 */
function explorerError(code, message, detail = null, reason = null) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  e.reason = reason;
  return e;
}
const failArg = (message, detail = null, reason = null) => {
  throw explorerError('E_ARG', message, detail, reason);
};
const failUnavailable = (message, detail = null, reason = null) => {
  throw explorerError('E_UNAVAILABLE', message, detail, reason);
};
const failNotFound = (message, detail = null, reason = null) => {
  throw explorerError('E_NOTFOUND', message, detail, reason);
};

/**
 * URL 里的凭据脱敏（F-37，安全级）。
 *
 * 为什么必须在 host 侧做：`deps.webHosts` 的 `url` 来自 `wsl_open_ui` 的启动 URL
 * （register-tools 用 `/\?token=[A-Za-z0-9_-]+/` 从输出里抓的），而面板把 `snapshot` **整份**
 * `JSON.stringify` 进 `<pre>` 并支持"复制诊断"写系统剪贴板 ⇒ 明文 token 会进 DOM、进剪贴板，
 * 可被同源其它客户端插件读到、被剪贴板同步带出机器。webHosts 在 UI 没有别的消费者，脱敏零成本。
 *
 * 保留 host:port 与路径（面板仍要能区分是哪个端口），只把 `token`（含 `access_token` 这类
 * `*token` 参数）的**值**换成 `***`。引号/空白/`&`/`#` 都算值的边界，避免吃掉 JSON 结构。
 *
 * @param url 原 URL（可能是空串/非字符串）
 * @returns 脱敏后的 URL（输入为空 ⇒ 空串）
 */
export function redactUrlToken(url) {
  const text = str(url);
  if (text.length === 0) return '';
  return text.replace(/([?&][A-Za-z0-9_-]*token=)[^&#\s"']*/gi, '$1***');
}

/**
 * `deps.webHosts`（`Map<port, {url}>`）→ `snapshot.webHosts[]`（F-37：凭据已脱敏）。
 *
 * 抽成导出纯函数是为了**可单测**：不启动 web server、不碰 WSL，直接喂一个 host 对象进来
 * 就能断言"输出里没有 token 明文、但端口还在"。
 *
 * @param webHosts index.ts 的 `webHosts` Map（不可迭代/缺省 ⇒ 空数组）
 * @returns `{ port, url }[]`，`url` 已过 {@link redactUrlToken}
 */
export function snapshotWebHosts(webHosts) {
  const rows = [];
  if (!webHosts || typeof webHosts[Symbol.iterator] !== 'function') return rows;
  for (const [port, host] of webHosts) {
    if (host && typeof host.url === 'string' && host.url) {
      rows.push({ port: Number(port), url: redactUrlToken(host.url) });
    }
  }
  return rows;
}

/**
 * 只保留**一份** `remote-wsl: ` 模块标记。
 *
 * 为什么需要：上游 `daemon-client` 的部分 error 文案**自带**前缀（`=on` 拒绝回退那句），
 * 而它会被并进聚合错误（`远端守护在 Windows 侧不可达：… —— ${last}`）。外层若再无脑加一层，
 * 同一条消息里就会出现**两次** `remote-wsl:`（T20 复验发现的组合型缺陷）。
 *
 * 判据用 `includes` 而非 `startsWith`：上游前缀在聚合错误里落**句中**（`—— remote-wsl: …`），
 * 只看开头会漏判。本函数只决定"要不要加"，**不改**上游文案（内层前缀是"错误源自谁"的语义标记，
 * `wsl_exec`/`wsl_daemon` 等路径也在用 —— lead 2026-10-12 裁决：改外层，别动内层）。
 * @param message 上游 error 或自撰文案
 * @returns 恰好含一份模块标记的文案
 */
export function withModulePrefix(message) {
  const text = str(message).trim();
  return text.includes('remote-wsl:') ? text : `remote-wsl: ${text}`;
}

/**
 * `explorer.listDir` 的入参校验：只接受**干净**的 WSL 绝对 POSIX 路径。
 *
 * 为什么这么严：路径经 `unc()` 变成 `\\wsl.localhost\<distro>\…` 后由 Windows 侧
 * `readdirSync` 解析，任何 `..` / 反斜杠 / NUL 都可能把它变成"发行版外"的另一个位置；
 * 面板只需要浏览，不需要穿越。校验失败一律 `E_ARG`(400)，且**回显被拒的原串**。
 *
 * @param value 请求里的 `path`
 * @param method 报错文案里用的方法名（缺省 `explorer.listDir` ⇒ 老调用方文案**逐字不变**）
 * @returns 归一化后的路径（合并重复 `/`、去尾 `/`、根保持 `/`）
 */
function assertSafeWslPath(value, method = 'explorer.listDir') {
  const raw = str(value);
  if (raw.length === 0) failArg(`remote-wsl: ${method} 需要 path（WSL 绝对路径，例如 /home/g）`);
  if (raw.includes('\0')) failArg(`remote-wsl: ${method} 的 path 含 NUL 字节，拒绝`);
  if (!raw.startsWith('/')) {
    failArg(`remote-wsl: ${method} 的 path 必须是 WSL 绝对路径（以 / 开头），收到 "${raw}"（Windows 盘符请写成 /mnt/c/...）`);
  }
  if (raw.includes('\\')) {
    failArg(`remote-wsl: ${method} 的 path 不得含反斜杠（那是 Windows 分隔符），收到 "${raw}"`);
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '..') failArg(`remote-wsl: ${method} 的 path 不得含 ".." 段，收到 "${raw}"`);
  }
  return `/${segments.filter((segment) => segment.length > 0).join('/')}`;
}

/** 目录项类型（设计稿：面板只需要 dir/file/other 三分类）。 */
function entryKindOf(dirent) {
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  return 'other';
}

/**
 * `/mnt/<盘符>` → Windows 盘符路径；其余返回 `null`。
 *
 * 为什么需要这个特例（T13 实测）：`/mnt` 本身经 UNC 能列（7 项：c d e f g wsl wslg），
 * 但 **`\\wsl.localhost\<distro>\mnt\c` 列不出来**（9p 不暴露 drvfs 挂载根 ⇒ `ok:false`），
 * 于是"快捷 chip 点进去是死路"。而 `/mnt/<letter>` **本来就是** Windows 的那个卷 ⇒ 直接按
 * `C:\…` 读：同一份数据、本机路径。
 *
 * 边界：**只用于读**（explorer.listDir 全文只读）。设计稿 §7 警告的是"在 UNC 上跑写型 Windows
 * 工具会写坏 ext4 属主/权限"，那条针对发行版内的 ext4 路径；`/mnt/c` 恰恰是 Windows 卷。
 */
function windowsDriveForMount(path) {
  const match = /^\/mnt\/([a-z])(\/.*)?$/.exec(path);
  if (match === null) return null;
  const rest = (match[2] ?? '').replace(/^\/+/, '').replace(/\//g, '\\');
  return `${match[1].toUpperCase()}:\\${rest}`;
}

/** Linux 路径的显示名（面板树上的 label 缺省值）。 */
function baseName(p) {
  const s = str(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');  return i >= 0 ? s.slice(i + 1) || s : s;
}

/** 路径 → 面板树的 kind（设计稿 §4：'folder' | 'code-workspace'）。 */
function kindOf(p) {
  return /\.code-workspace$/i.test(str(p)) ? 'code-workspace' : 'folder';
}

/**
 * wsl.exe 输出解码：wsl -l -v 在 Windows 上常是 UTF-16LE；按 UTF-8 读会夹满 NUL。
 * 参考 ZCode 的 wsl-detect：含 NUL 字节即按 UTF-16LE 解码，同时兼容 UTF-8。
 *
 * 2026-10-22 review：实现已合并到 `src/wsl-output.ts`（与 wsl-io 共用单一来源）；
 * 这里保留原名导出（index.ts 与既有探针依赖 `explorer.decodeWslOutput`）。
 */
export const decodeWslOutput = readWslOutput;

/**
 * `wsl -l -v` 的表解析：实现已抽到 `src/distro-table.ts`（2026-10-28 零配置改动 ——
 * 默认目标的探测也要用同一份解析，两处各写一份必然漂移）。**保留原名导出**，
 * 既有调用方与探针不用改。
 */
export { parseWslDistroTable };
/** 异步执行 wsl.exe 并拿 Buffer：不阻塞 host 事件循环（只读探测专用）。 */
function execWslBuffer(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      args,
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: timeoutMs },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/** 异步执行 WSL 里的脚本文本（一次性只读检查，例如代理探测）。 */
function execWslText(distro, script, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--exec', 'bash', '-c', script],
      { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true, timeout: timeoutMs },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(decodeWslOutput(stdout));
      },
    );
  });
}

/**
 * 读一次 `wsl -l -v` 的发行版事实 → `{ defaultName, running:Set<name>, versions:Map<name,1|2>, ok }`。
 *
 * 为什么**不是**逐个 `wsl -d <name> -- true` 探活：那会把**关着的发行版启动起来**（WSL 对任何
 * `wsl -d` 都会拉起该发行版）—— 面板刷一次快照不该有这种副作用。所以 `reachable` 的定义是
 * "该发行版此刻 STATE=Running"，只读、零副作用。
 *
 * 名字列表仍以 index.ts 注入的 `listDistros()`（`wsl -l -q`）为准，这里**只**取 `*`（默认发行版）
 * 与 STATE 两个标志，按名字对齐；表里没有的名字两个标志都留 false（不猜）。
 * `ok` 是给短 TTL 缓存用的**可观测性标志**（不对外暴露）：只有"命令真的跑成功且有输出"才算
 * `ok:true`；失败时调用方**不得**把这份结果写进缓存（见 `DISTRO_FACTS_TTL_MS` 注释）。
 */
async function probeDistroState() {
  const out = { defaultName: null, running: new Set(), versions: new Map(), ok: false };
  let buffer;
  try {
    buffer = await execWslBuffer(['-l', '-v'], 8000);
  } catch {
    return out;
  }
  const text = decodeWslOutput(buffer);
  if (!text) return out;
  out.ok = true;
  for (const row of parseWslDistroTable(text)) {
    if (row.isDefault) out.defaultName = row.name;
    if (row.state.toLowerCase() === 'running') out.running.add(row.name);
    if (row.version !== null) out.versions.set(row.name, row.version);
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
  // 2026-10-28（零评审 nit）：面板显式切到 B 发行版、而 B 的 `$HOME` 读不到时，`cfgFor(B)` 的
  // `wslHome`/`cwd` 会回落成空串 —— 那会生成 `{path:'', label:''}` 这种伪条目（点进去只会得到
  // 一个不可诊断的错误）。这里直接说清缺什么，别让空路径流到 UI。
  const cwd = str(cfg.cwd);
  if (!cwd) {
    throw explorerError(
      'E_UNAVAILABLE',
      `remote-wsl: 无法确定发行版 "${cfg.distro}" 的默认工作目录（读不到它的登录用户 $HOME）—— ` +
        '请在 cordis.patch.yml 里显式配置 wslHome，或在面板里直接浏览一个具体路径。',
    );
  }
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
 * @param deps.workspaceRegistry 取 host 的 `workspaceRegistry` 服务的闭包（`addWorkspace` 登记 / `newSession`
 *                             用 workspaceId 时查 path）；服务缺失 ⇒ 返回 undefined，由方法自己给可读 503/400
 * @param deps.sessionController 取 host 的 `sessionController` 服务的闭包（`newSession` 建真会话；
 *                              `create({cwd|workspaceId, agentPreset})`，契约见 `newSession` 的注释）
 * @param deps.distroStateProbe **可选测试缝**：注入 `() => {defaultName,running,ok}` 以在不起发行版、
 *                             不改真实 STATE 的前提下验证"未运行/启停"分支。**index.ts 不传**，默认走真实
 *                             `wsl.exe -l -v`（`probeDistroState()`）；生产路径不因它而变。
 */
export function createExplorerHandlers(deps) {
  const cfg = deps.config;
  const log = (m) => process.stderr.write(`remote-wsl(explorer): ${m}\n`);

  /**
   * 发行版事实的**短 TTL 缓存**（每个 handler 实例一份；生产里 index.ts 只建一个实例）。
   *
   * 缓存对象：`{ names, flags }` —— `names` 来自注入的 `deps.listDistros()`（`wsl -l -q`），
   * `flags` 来自 `probeDistroState()`（`wsl -l -v` 的 STATE/默认标志）。
   * `snapshot` 与 `listDir` **共用**这一份：两者对"发行版列表/是否在跑"的判断必须同源，
   * 否则同一次刷新里两处可能给出互相矛盾的结论。
   *
   * 语义边界（不许被当成"实时"）：
   *  · 窗口内 `reachable` = **上一次探测时**的 STATE；发行版在这 2s 内被 terminate/start，
   *    面板/工具看到的是旧值，直到 TTL 过期后的下一次调用。
   *  · 只有"名字非空 且 STATE 表读取成功"才写入；失败/退化立即清空缓存并**重试**（失败不缓存）。
   *  · 缓存**只**影响"读事实"这一步：不改变 `listDir` 的"不启动发行版"承诺，也不改变任何错误文案。
   */
  let distroFactsCache = null;
  let distroFactsInflight = null;
  const probeState = () => (typeof deps.distroStateProbe === 'function' ? Promise.resolve(deps.distroStateProbe()) : probeDistroState());

  /** 读一份发行版事实（命中 TTL 直接返回；同一时刻的并发调用共享一次探测）。 */
  async function readDistroFacts() {
    const at = Date.now();
    if (distroFactsCache !== null && at - distroFactsCache.at < DISTRO_FACTS_TTL_MS) return distroFactsCache.facts;
    if (distroFactsInflight !== null) return distroFactsInflight;
    const load = (async () => {
      const names = typeof deps.listDistrosAsync === 'function' ? await deps.listDistrosAsync() : deps.listDistros();
      const flags = await probeState();
      const facts = { names, flags };
      if (Array.isArray(names) && names.length > 0 && flags && flags.ok === true) distroFactsCache = { at: Date.now(), facts };
      else distroFactsCache = null; // 失败/退化：既不写入也不复用旧值
      return facts;
    })();
    distroFactsInflight = load;
    try {
      return await load;
    } finally {
      if (distroFactsInflight === load) distroFactsInflight = null;
    }
  }

  /** 丢掉发行版事实缓存（面板「重新扫描」用：refresh 时不复用 TTL 内的旧 STATE/清单）。 */
  const invalidateFacts = () => {
    distroFactsCache = null;
    distroFactsInflight = null;
  };

  /**
   * 本次调用要驱动的发行版：缺省 = 配置里的 `distro`；显式给了就必须出现在
   * `listDistros()`（`wsl -l -q`）里 —— **不猜、不回落**（写错名字要响，不要静默换成默认发行版）。
   *
   * 为什么允许显式指定（2026-10-21「多发行版」）：面板在多发行版机器上要能切换目标；
   * 切换是**按请求**生效的（不写插件配置），所以每个方法都从 `args.distro` 取一次。
   */
  async function resolveDistro(args) {
    const raw = str(args?.distro).trim();
    if (!raw) {
      // 2026-10-28（零配置）：默认目标没解析出来（自动探测失败）时必须给**机器可读**原因 ——
      // 面板的 `distroResetRef` 与客户端提示都靠 `reason`，不许让空发行版流到 UNC/`wsl -d` 层。
      // 显式 `args.distro` 不受此限：这类机器上，面板仍可浏览一个被点名的发行版。
      const issue = targetProblem(cfg);
      if (issue) failArg(issue, null, asConfigText(cfg.distro) ? NO_HOME_REASON : NO_DISTRO_REASON);
      const facts0 = await readDistroFacts();
      const v0 = facts0.flags && facts0.flags.versions && typeof facts0.flags.versions.get === 'function' ? facts0.flags.versions.get(cfg.distro) : null;
      if (v0 === 1) failArg('remote-wsl: 配置的发行版 "' + cfg.distro + '" 是 WSL1；本插件只支持 WSL2（可先执行 wsl --set-version ' + cfg.distro + ' 2 升级）');
      return cfg.distro;
    }
    const facts = await readDistroFacts();
    const names = facts.names;
    if (!Array.isArray(names) || names.indexOf(raw) < 0) {
      // ★ F-36：带机器可读 reason（不是中文子串匹配）。面板"记住的发行版被删/改名"时就靠它
      // 退回缺省目标重试一次（client.panel.js 的 distroResetRef），不解析文案。
      failArg(
        `remote-wsl: 未知发行版 "${raw}"（本机 wsl -l -q：${(Array.isArray(names) && names.length ? names.join('、') : '(读不到)')}）`,
        null,
        'unknown-distro',
      );
    }
    const versionOf = facts.flags && facts.flags.versions && typeof facts.flags.versions.get === 'function' ? facts.flags.versions.get(raw) : null;
    if (versionOf === 1) {
      failArg('remote-wsl: 发行版 "' + raw + '" 是 WSL1；本插件只支持 WSL2（可先执行 wsl --set-version ' + raw + ' 2 升级）');
    }
    // 家目录预热（异步）：后续 cfgFor/distroHome 直接命中缓存，不再同步 spawn 一次
    await ensureDistroHome(raw);
    return raw;
  }

  /**
   * 把 `args.path` 归一成 `{ distro, path }`。
   *
   * UNC 形式（`\\wsl.localhost\<distro>\...` 或 `\\wsl$\...`）先反解出 distro 与 Linux 路径；
   * 其余按原约定校验必须是 WSL 绝对路径。显式 `args.distro` 与 UNC 里的发行版不一致时报错（不猜、不静默换）。
   */
  async function resolveTarget(args, method) {
    const parsed = parseWslUncPath(args?.path);
    if (parsed === null) {
      const distro = await resolveDistro(args);
      return { distro, path: assertSafeWslPath(args?.path, method) };
    }
    const explicit = str(args?.distro).trim();
    if (explicit.length > 0 && explicit !== parsed.distro) {
      failArg(`remote-wsl: ${method} 的 path 属于发行版 "${parsed.distro}"，但 distro 参数写的是 "${explicit}"`);
    }
    const distro = await resolveDistro({ distro: parsed.distro });
    return { distro, path: assertSafeWslPath(parsed.linuxPath, method) };
  }

  /**
   * 非配置发行版的**家目录**：进程内缓存，成功只解析一次。
   *
   * 为什么必须解析而不是猜：守护的 state 目录是 `${wslHome}/.dsh/remote-wsl`（`stateDirLinux`），
   * 家目录错了 ⇒ 既找不到那台发行版已有的守护，也会把新守护的元数据写到别处。
   * 代价（**如实写在这里**）：`wsl -d <distro>` 会把**未运行**的发行版拉起来 —— 这只发生在
   * 用户显式切到该发行版时（配置里的那台短路，不探测），且结果按进程缓存；
   * 失败缓存 60s，避免每次刷新都去敲一次坏掉的发行版。
   */
  const distroHomeCache = new Map();

  /**
   * 异步预热非默认发行版的家目录（在 resolveDistro 的 await 点调用）。
   * 目的：把 `wsl -d X printf $HOME` 从 cfgFor → distroHome 的**同步**路径挪到请求的 await 点，
   * 避免在同步段里阻塞最多 8 秒；失败仍按 60 秒缓存（与同步版共用同一份缓存）。
   */
  async function ensureDistroHome(distro) {
    if (distro === cfg.distro) return cfg.wslHome;
    const hit = distroHomeCache.get(distro);
    if (hit !== undefined && (hit.home !== null || Date.now() - hit.at < 60000)) return hit.home ?? cfg.wslHome;
    let home = null;
    try {
      const out = (await execWslText(distro, 'printf %s "$HOME"', 8000)).trim();
      if (out.startsWith('/')) home = out;
    } catch {
      home = null;
    }
    distroHomeCache.set(distro, { home, at: Date.now() });
    return home ?? cfg.wslHome;
  }

  function distroHome(distro) {
    if (distro === cfg.distro) return cfg.wslHome;
    const hit = distroHomeCache.get(distro);
    if (hit !== undefined && (hit.home !== null || Date.now() - hit.at < 60000)) return hit.home ?? cfg.wslHome;
    let home = null;
    try {
      const res = spawnSync('wsl.exe', ['-d', distro, '--exec', 'sh', '-c', 'printf %s "$HOME"'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      });
      const out = str(res.stdout).trim();
      if (res.status === 0 && out.startsWith('/')) home = out;
    } catch {
      home = null;
    }
    distroHomeCache.set(distro, { home, at: Date.now() });
    return home ?? cfg.wslHome;
  }

  /**
   * 换一个发行版跑同一套逻辑：只换 `distro` / `wslHome` / 默认 `cwd`。
   * 非配置发行版的默认 cwd 用它的家目录（解析失败时回落配置值 —— 不伪造"存在"，
   * 后续 listDir 会用真实 ENOENT/未运行错误说清楚）。
   */
  function cfgFor(distro) {
    if (distro === cfg.distro) return cfg;
    const home = distroHome(distro);
    return { ...cfg, distro, wslHome: home, cwd: home };
  }

  /**
   * `explorer.snapshot` —— 只读聚合快照；**不启动、不停止、不写任何东西**。
   *
   * **并发单飞（single-flight）**：`snapshot` 无参，同参并发共享**同一次执行** —— 面板重挂载、
   * 多客户端同时刷新时，不会把同一份 `wsl.exe` 探测/守护扫描重复 N 遍。
   * 它**不是缓存**：执行一结束 `snapshotInflight` 立刻清空，下一个调用（哪怕紧接着）**必然重新探测**，
   * 不伪造实时性；并发调用者只共享"同一次执行的结果对象"（只读使用；adapter 只做 JSON 序列化）。
   * 失败同样共享这一次的 rejection 并清空 in-flight，不留下"永远返回旧错误"的悬挂 Promise。
   */
  /** 单飞：**按发行版分键**（多发行版面板里，A 与 B 的快照互不阻塞、不串味）。 */
  const snapshotInflight = new Map();
  async function snapshot(args) {
    const refresh = args?.refresh === true;
    if (refresh) invalidateFacts();
    const distro = await resolveDistro(args);
    if (refresh) {
      invalidateProxyCache(distro);
      snapshotInflight.delete(distro);
    }
    const existing = refresh ? undefined : snapshotInflight.get(distro);
    if (existing !== undefined) return existing;
    const p = runSnapshot(distro);
    snapshotInflight.set(distro, p);
    try {
      return await p;
    } finally {
      if (snapshotInflight.get(distro) === p) snapshotInflight.delete(distro);
    }
  }

  async function runSnapshot(distro) {
    const eff = cfgFor(distro);
    const facts = await readDistroFacts();
    const names = facts.names;
    const flags = facts.flags;
    // 与 VS Code Remote-WSL 的 targetsWsl 对齐：过滤 Docker Desktop 自带发行版（除非它是默认），
    // 默认发行版排最前、其余按名字排（二进制比较，保持确定性）。
    const DOCKER_DISTRO = /^docker-desktop(-data)?$/;
    const distros = names
      .map((name) => ({
        name,
        default: flags.defaultName === name,
        reachable: flags.running.has(name), // 定义见 probeDistroState()：探测时 STATE=Running（不探活、零副作用）
        version: flags.versions && typeof flags.versions.get === 'function' ? (flags.versions.get(name) ?? null) : null,
      }))
      .filter((row) => row.default || !DOCKER_DISTRO.test(row.name))
      .sort((a, b) => (a.default ? -1 : b.default ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const v = deps.resolveVersion(eff);

    // 宿主代理：host 侧一次性解析 + 5 分钟缓存（参考 ZCode 的 wslProxy）。**只对运行中的发行版探**
    // —— `wsl -d X` 会把停着的发行版拉起来，而面板的承诺是「只读、不启动发行版」。
    const proxyPort = Number(eff.proxyPort ?? 0) || 0;
    const proxy = flags.running.has(distro)
      ? await resolveWslProxy({ distro, port: proxyPort, run: (script) => execWslText(distro, script) })
      : { host: null, port: proxyPort, reachable: null, cached: false };

    // ★ 单一真相源：daemon 段只能来自 daemonSnapshot()（= wsl_status / wsl_daemon status 的同一函数）。
    //
    // ★★ F33（task-8，安全级）：**只认配置槽位**，绝不回落到 `live[0]`。
    // 为什么（T7 实测，修复前）：自有槽位 8982 无守护时 `live[0]` 会是**别的 agent 的槽位 8962**，
    // 面板于是显示"我的守护 slot 8962 · pid …"，而 UI 的"停止"按钮正是以该 slot 为目标 ⇒
    // **跨实例误停风险**。所以：
    //   · 本槽位（`cfg.daemonPort`）没有守护 ⇒ 明确 `running:false`（**不回落**）；
    //   · 别的槽位的活守护只作为**只读资讯**进 `others[]`，并逐条标明"非本槽位、未复用未打扰"。
    // `orphans` 仍取 daemonSnapshot() 的全量口径（孤儿本来就是"无元数据"的，不存在"谁的"问题）。
    // ★★ T4（2026-10-13）：把"daemon 是哪一个"这件事拆成**两个具名选择器**，从此不许再混用。
    //
    //   · {@link selectOwnedDaemon} —— **所有权选择器**：只认本插件配置的槽位 `cfg.daemonPort`。
    //     `explorer.snapshot().daemon` 走它；**绝不回落到 `live[0]`**（F33：那会显示别人的槽位，
    //     而 UI 的停止/重启正是以该 slot 为目标 ⇒ 跨实例误停）。
    //   · {@link discoverDaemons} —— **发现选择器**：`wsl_status` 的发现语义 = "这台机器上发现了
    //     哪些守护"，与"我们拥有哪一个"无关。线上字段正式改名 `discoveredDaemon` 属 **P2**
    //     （README「仍余」② 已记录：要动 6 个工具 + selftest），本轮只落地**具名选择器**，
    //     不改字段名 —— 这样两个语义此后各有名字，不会再被"顺手回落"糊在一起。
    const ds = await daemonSnapshot(eff);
    // F-50（2026-10-27 第三轮）：孤儿数只在扫描成功时才是权威。面板照旧显示计数，但必须同时
    // 透传 `orphansVerified`，否则「扫描失败」会显示成「0 个孤儿」——读者会以为面板确认过。
    const orphansVerified = ds.orphansVerified !== false;
    const scan = ds.scan ?? { ok: orphansVerified };
    const live = discoverDaemons(Array.isArray(ds.live) ? ds.live : []);
    const configuredSlot = Number(cfg.daemonPort) || null;
    const mine = selectOwnedDaemon(live, configuredSlot);
    const others = live
      .filter((l) => Number(l.slot) !== configuredSlot)
      .map((l) => ({
        slot: l.slot,
        pid: l.info?.daemonPid ?? null,
        port: l.info?.port ?? null,
        version: l.info?.version ?? null,
        note: `非本槽位（configured daemonPort=${configuredSlot}）；未复用、未打扰`,
      }));
    const mineKeys = Array.isArray(mine?.info?.keys) ? mine.info.keys : [];
    const daemon = mine
      ? {
          running: true,
          slot: mine.slot,
          pid: mine.info?.daemonPid ?? null,
          // `port` 是对 §4 字段表的一处**加法**（§4 原文只列 running/slot/pid/version/keys/orphans）：
          // §2 的状态条与 §6 验收②都要显示守护端口，而 T4 的比对器有 daemon.port 一项。
          // 来源同一个：daemonSnapshot() 的 live[0].info.port（= wsl_status 的 `actualPort=`）。
          port: mine.info?.port ?? null,
          version: mine.info?.version ?? null,
          keys: mineKeys.map((k) => str(k?.key)),
          // 会话明细（对齐 VS Code 树里 distro 下的 folder 行）：cwd + sessionId + 最近活跃。
          sessions: mineKeys.map((k) => ({
            key: str(k?.key),
            cwd: str(k?.cwd) || null,
            sessionId: k?.sessionId === undefined || k?.sessionId === null ? null : str(k.sessionId),
            turns: Number(k?.turns) || 0,
            idleForMs: k?.idleForMs === undefined || k?.idleForMs === null ? null : Number(k.idleForMs),
          })),
          orphans: Array.isArray(ds.orphans) ? ds.orphans.length : 0,
          // F-50：`orphans` 只是"已知部分"；`orphansVerified:false` ⇒ 面板/诊断必须标明未核实。
          orphansVerified,
          scan,
          others,
        }
      : {
          running: false,
          keys: [],
          sessions: [],
          orphans: Array.isArray(ds.orphans) ? ds.orphans.length : 0,
          orphansVerified,
          scan,
          others,
        };

    const drift = v.drift
      ? { drifted: true, desktop: v.drift.desktop ?? null, pin: v.drift.pin ?? null }
      : { drifted: false };

    // ★ F-37（task-8，安全级）：**透传前脱敏**。`host.url` 由 `wsl_open_ui` 的启动 URL 抓来
    // （含 `?token=`），而面板把这整份 snapshot 渲染进 `<pre>` 且能一键复制到剪贴板 ⇒
    // 原样透传等于把 Web UI 的访问凭据写进 DOM 与系统剪贴板。保留 host:port，只打码 token 值。
    // 见 {@link snapshotWebHosts} / {@link redactUrlToken}（纯函数，可单测）。
    const webHosts = snapshotWebHosts(deps.webHosts);

    return {
      distros,
      target: { distro, wslHome: eff.wslHome, cwd: eff.cwd },
      daemon,
      drift,
      workspaces: readWorkspaces(eff),
      proxy,
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
    const { distro, path } = await resolveTarget(args, 'explorer.openSession');
    const eff = cfgFor(distro);
    const v = deps.resolveVersion(eff);
    if (!v.version) failUnavailable('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');

    const found = (readDaemonMeta(eff)?.keys ?? []).find(
      (k) => str(k?.key) === EXPLORER_RUNTIME_KEY && str(k?.cwd ?? eff.cwd) === path,
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

    const ensured = await ensureDaemon(eff, { version: v.version, log });
    // F14b（task-8）：与 `daemon` 分支**同一失败语义** —— 都走 E_UNAVAILABLE(503)。
    // 改前这里是裸 Error ⇒ HTTP 500，而同类的 daemon ensure 失败是 503（调用方无法按 code 分流）。
    if (!ensured.ok) failUnavailable(withModulePrefix(ensured.error));
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
    const distro = await resolveDistro(args);
    const base = cfgFor(distro);
    const slot = args?.slot == null ? undefined : Number(args.slot);
    if (slot !== undefined && (!Number.isFinite(slot) || slot <= 0)) {
      failArg(`remote-wsl: explorer.daemon 的 slot 非法: ${String(args?.slot)}`);
    }
    // ★★ F33（task-8，安全级）：动作面**也只允许配置槽位**。
    // 宁可拒绝，也不给 UI 任何路径去碰别人的守护（改前：面板能从 snapshot 里拿到别的实例的 slot
    // 并把它当"停止"目标 ⇒ 跨实例误停；见 T7 稳定性报告）。
    const configuredSlot = Number(cfg.daemonPort) || null;
    if (slot !== undefined && configuredSlot !== null && slot !== configuredSlot) {
      failArg(
        `remote-wsl: slot ${slot} 不是本插件配置的槽位（${slot}≠${configuredSlot}）；本插件只操作自己的槽位`,
      );
    }
    // slot 只在**本次调用**里覆盖 daemonPort（与 wsl_daemon 的 "配置端口即槽位" 语义一致）
    const eff = slot === undefined ? base : { ...base, daemonPort: slot };

    if (action === 'ensure' || action === 'restart') {
      const v = deps.resolveVersion(eff);
      if (!v.version) failUnavailable('remote-wsl: 无法确定 dsh 版本（桌面 runtime.json 不可读且未配 dshVersion）');
      const r = await ensureDaemon(eff, { version: v.version, restart: action === 'restart', log });
      // ★ F-36（task-8）：失败走**结构化错误体**（code+message+detail），不再只有一行 message。
      // 面板的主句由 client 的 failKey（`note.failStart` / `note.failRestart`，用户语言）给出，
      // host 的中文技术文案（端口被占 / 握手超时 / daemon.log 尾部）只进 detail 折叠区。
      // 为什么不能只去掉文案：脚本与 `wsl_daemon` 工具也读 message，它必须仍然可独立读懂。
      if (!r.ok) {
        const why = withModulePrefix(r.error);
        const notes = Array.isArray(r.notes) ? r.notes.filter((line) => typeof line === 'string' && line.length > 0) : [];
        failUnavailable(why, notes.length > 0 ? notes.join('\n') : null);
      }
      return {
        action,
        ok: true,
        idempotent: true,
        // ★ F-38c（task-20）：把 daemon 层的**机器可读**启动方式透传出来 ——
        //   `mode`: 'systemd'（主路径：无窗 + 与 Windows 侧生死解耦）| 'compat-detached'（回退：**可能弹窗**）| 'reused'
        //   `warning`: 回退时是完整可展示的一句告警（含 /etc/wsl.conf `systemd=true` 建议），其余为 null。
        //   调用方（面板/脚本/T21）据此**不必解析 notes[]** 就能判定本次走的是哪条路。
        //   `notes[]` 照旧保留（人读版，含"启动方式…"与同一条告警）：两者并存，互不替代。
        mode: r.mode ?? null,
        warning: r.warning ?? null,
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
      // T30/T26 定位的缺陷：这里曾硬编码 `ok: true`，且只取 `r.note` ——
      // P1 保护路径下 `stopDaemon` 返回 `ok:false` + 可读 `error` 时会被**静默丢弃**，
      // 调用方（面板/脚本）被告知"成功"。现在如实透传，并把失败原因带进 notes。
      const stopNotes = [r.note, r.error].filter((line) => typeof line === 'string' && line.length > 0);
      return {
        action,
        ok: r.ok !== false,
        idempotent: true,
        alreadyStopped: r.alreadyStopped === true,
        slot: r.slot ?? null,
        port: r.port ?? null,
        pid: r.pid ?? null,
        version: r.version ?? null,
        reaped: Array.isArray(r.reaped) ? r.reaped.length : 0,
        notes: stopNotes,
      };
    }
    throw explorerError('E_ARG', `remote-wsl: explorer.daemon 不认识 action=${action}（可选 ensure|stop|restart）`);
  }

  /**
   * `explorer.fixPin()` —— 与 `wsl_sync_version` **同一实现**（`resolveVersion` + `writePin`），
   * 只修 pin，**绝不重启/停止守护**（§5：默认只告警，显式点击才动手；语义 #5）。不 warm（warm 是
   * `wsl_sync_version --warm` 的显式选项，面板的"修 pin"不该顺带下载）。
   */
  async function fixPin(args) {
    const eff = cfgFor(await resolveDistro(args));
    const v = deps.resolveVersion(eff);
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
    const wrote = deps.writePin(eff, v.version) === true;
    const after = deps.resolveVersion(eff);
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

  /**
   * `explorer.listDir({path})` —— 给面板目录浏览器（A3）列**一层**目录。
   *
   * 纪律（lead 2026-10-12 裁决 + 设计稿 §7）：
   * · **只读、零副作用**：复用既有 `unc()` 读法（与 `readFavorites` 同一套约定：经 UNC 读）；
   *   **不启动发行版** —— 关着的发行版 UNC 访问本来就会失败，这里先按 `wsl -l -v` 的
   *   `STATE=Running` 判一次并给**精确**的可读错误，避免把"发行版没开"误报成"路径不存在"。
   * · **一次返回全部条目（含隐藏）**：隐藏文件开关在 client 侧过滤，切换即时、不重发请求。
   * · 顺序**确定性**：`name` 升序（dir/file 分组由 client 做）。
   * · 失败给可读错误并**带上那个 path**：路径不存在/不是目录 ⇒ `E_NOTFOUND`(404)；
   *   发行版不在列表/未运行/无权限/其它 ⇒ `E_UNAVAILABLE`(503)。
   * @param args `{ path, distro? }`（`distro` 缺省 = 配置里的发行版）
   * @returns `{ path, distro, entries: [{ name, kind: 'dir'|'file'|'other', hidden }] }`
   */
  async function listDir(args) {
    const { distro, path } = await resolveTarget(args, 'explorer.listDir');

    // 发行版前置判定（只读：`wsl -l -q` + `wsl -l -v` 的 STATE，两者都零副作用）
    // 与 snapshot 共用同一份短 TTL 事实缓存（DISTRO_FACTS_TTL_MS）；判定分支与文案逐字不变。
    const facts = await readDistroFacts();
    const names = facts.names;
    const flags = facts.flags;
    if (!names.includes(distro)) {
      failUnavailable(
        `remote-wsl: 发行版 "${distro}" 不在 wsl -l -q 的输出里 ⇒ 无法读取 ${path}。` +
          `面板是只读的，不会为了浏览而启动发行版；请检查发行版名称或先手动启动它。`,
      );
    }
    if (!flags.running.has(distro)) {
      failUnavailable(
        `remote-wsl: 发行版 "${distro}" 此刻未运行（wsl -l -v 的 STATE ≠ Running）⇒ 无法读取 ${path}。` +
          `面板是只读的，不会为了浏览而启动发行版；请先在终端执行 wsl -d ${distro} 启动它。`,
      );
    }

    const winPath = windowsDriveForMount(path) ?? unc(distro, path);
    let dirents;
    try {
      dirents = readdirSync(winPath, { withFileTypes: true });
    } catch (e) {
      const code = str(e?.code);
      const detail = `${code || 'no-code'}: ${e?.message ?? String(e)}`;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        failNotFound(`remote-wsl: 列目录失败：路径 ${path} 不存在或不是目录（${detail}）`);
      }
      failUnavailable(`remote-wsl: 列目录失败：无法读取 ${path}（${detail}）`);
    }

    const entries = dirents
      .map((dirent) => ({
        name: dirent.name,
        kind: entryKindOf(dirent),
        hidden: dirent.name.startsWith('.'),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return { path, distro, entries };
  }

/**
 * 本插件注册的 WSL preset 的 id（权威：`src/preset.ts` 的 `agentPresets.register({ id: 'wsl' })`）。
 * 面板「在此目录新建会话」默认就落这个 preset（HANDOFF 第九版 P2）。
 */
const WSL_PRESET_ID = 'wsl';

/**
 * 宿主的 `sessionController.create` 是不是**因为 preset** 拒的（P2 降级判据）。
 *
 * 为什么必须判而不是"错了就重试"：`create` 的失败面里还有 cwd/workspace 冲突、mkdir 失败、
 * 内部错误 —— 那些重试不带 preset 只会把真实根因盖掉。这里只认**契约里能证明与 preset 有关**的两类：
 *   · `agent-preset/*`：`dsh-api-session-controller` 的 `rejectCreation()` 把 preset 冲突/未知转成
 *     `agent-preset/conflict|not-found|invalid`（抽源码 `lib/index.js:1073-1086`；`agent-preset/not-found`
 *     由 `dsh-agent-preset-registry/lib/index.js:599/615/636` 抛，`invalid` 见 `:645`）；
 *   · `gateway/bad-request` 且 message 明确点名 agentPreset（更老的宿主可能把未知字段当参数错拒绝）。
 * 其余一律**不降级**（原样报错）。
 * @param e `ctl.create()` 抛出的错误
 * @returns 是否属于"preset 被宿主拒绝"
 */
const isPresetRejection = (e) => {
  const code = str(e?.code);
  if (code.startsWith('agent-preset/')) return true;
  const message = str(e?.message);
  return code === 'gateway/bad-request' && /agent[\s-]?preset/i.test(message);
};

/**
 * `explorer.newSession({path, distro?, workspaceId?})` —— 建一个**真正的 DSH 会话**（P2：默认落 WSL preset）。
 *
 * 为什么不是 `explorer.openSession`：openSession 只碰 WSL 侧守护（准备/附着一个远端会话），不产生 DSH 会话；
 * 宿主本来就有 `sessionController.create`（Web 前端「新会话」用的同一个入口，抽源码
 * `dsh-api-session-controller/lib/index.js:3090-3091` → `SessionCommandController.create` `:755-787`）。
 *
 * ## P2：`agentPreset: 'wsl'`
 * 以前这里只传 `{ cwd }` ⇒ 会话落标准 preset：文件工具是 Windows 侧 `dsh-tool-fs` 走 9P（Linux 路径读
 * 大文件会报 `offset … is out of range`），shell 是 pwsh ⇒ 面板开的会话根本不是"WSL 世界"。
 * 契约（抽源码逐行核实）：
 *   · `create(request)` 收 `agentPreset`（`SessionCommandController.create` `:768` 原样透传给
 *     `agents.createSession`；`composeAgent(presetId)` `:351-364` 用 `agentPresets.resolve(id)` 解析）；
 *   · 返回体在宿主**真的**解析到 preset 时带 `{ agentPreset }`（`:783-786`），否则**不带该字段**
 *     （`composeAgent` 在 `agentPresets` 服务缺失时直接跳过 preset，见 `:352-355`）。
 *
 * ## 兼容与失败透明（不静默）
 * 旧宿主有三种"不认 agentPreset"的形态，本方法的处理：
 *   1. **静默忽略**（最老版本：字段被丢、返回体没有 `agentPreset`）⇒ 不报错也不谎称成功：
 *      `presetApplied:false` + `agentPreset:null`，调用方必须如实显示"preset 未应用"；
 *   2. **抛 `agent-preset/not-found|invalid|conflict`**（WSL preset 没注册/被禁/坏掉）⇒ **明确降级**：
 *      打一行日志 + 重试一次**不带 preset** 的 create，返回 `presetApplied:false, presetDegraded:true,
 *      presetError:<宿主原文>`；重试仍失败则两条原因一起报；
 *   3. 其它失败（cwd/workspace/内部错）⇒ **不降级**，原样 `E_UNAVAILABLE`（降级只会掩盖根因）。
 *
 * ## `workspaceId`（可选）
 * 面板已把目录登记为 host 工作区时传它：`create` 只接受 `workspaceId` 或 `cwd` **之一**
 * （`:756` 显式拒绝两个都给），给 workspaceId 才能把新会话挂进该工作区（`:775-782` `attachSession`），
 * 与侧栏「新会话」同一条宿主路径。缺省仍按 `cwd = 该 WSL 路径的 UNC`（原始语义）。
 *
 * @param args `{ path, distro?, workspaceId? }`（`distro` 缺省 = 配置里的发行版）
 * @returns `{ ok:true, sessionId, cwd, distro, path, workspaceId?, presetRequested,
 *   presetApplied, agentPreset, presetDegraded?, presetError? }`
 */
async function newSession(args) {
  const { distro, path } = await resolveTarget(args, 'explorer.newSession');
  const uncPath = unc(distro, path);
  const ctl = typeof deps.sessionController === 'function' ? deps.sessionController() : undefined;
  if (!ctl || typeof ctl.create !== 'function') {
    failUnavailable('remote-wsl: 宿主没有 sessionController 服务（当前 profile 不是 Web 应用？）⇒ 无法创建 DSH 会话');
  }

  const workspaceId = str(args?.workspaceId).trim();
  let cwd = uncPath;
  if (workspaceId) {
    // 只做**报告面**的校验（拿 workspace.path 当 cwd 回给面板）；真正的 not-found 由宿主 create 负责。
    const registry = typeof deps.workspaceRegistry === 'function' ? deps.workspaceRegistry() : undefined;
    const found = registry && typeof registry.get === 'function' ? await Promise.resolve(registry.get(workspaceId)) : undefined;
    if (registry && typeof registry.get === 'function' && found === undefined) {
      failArg(
        `remote-wsl: explorer.newSession 的 workspaceId "${workspaceId}" 在宿主 workspaceRegistry 里不存在` +
          `（先调 explorer.addWorkspace 登记该路径，或不要传 workspaceId）`,
      );
    }
    cwd = str(found?.path) || uncPath;
  }
  const base = workspaceId ? { workspaceId } : { cwd };

  let created;
  let presetDegraded = false;
  let presetError = null;
  try {
    created = await ctl.create({ ...base, agentPreset: WSL_PRESET_ID });
  } catch (e) {
    if (!isPresetRejection(e)) {
      failUnavailable('remote-wsl: 创建 DSH 会话失败：' + String(e && e.message ? e.message : e));
    }
    // 明确降级（形态 2）：宿主拒绝这个 preset ⇒ 先留证，再不带 preset 重试一次。
    // 留证必须带**机器可读 code**（`agent-preset/not-found` 等）：面板 detail 与日志都靠它定位，
    // 只有 message 的话"为什么降级"就退化成一句人话，没法与宿主契约对上。
    presetDegraded = true;
    presetError = [str(e?.code), str(e?.message)].filter((part) => part.length > 0).join(': ') || String(e);
    log(
      `explorer.newSession: 宿主拒绝 agentPreset="${WSL_PRESET_ID}"（${presetError}）⇒ 降级为不带 preset 重试；` +
        '返回 presetApplied:false',
    );
    try {
      created = await ctl.create({ ...base });
    } catch (e2) {
      failUnavailable(
        'remote-wsl: 创建 DSH 会话失败（WSL preset 被拒后不带 preset 重试仍失败）：' +
          String(e2 && e2.message ? e2.message : e2),
        presetError,
      );
    }
  }

  const sessionId = str(created?.sessionId);
  if (!sessionId) failUnavailable('remote-wsl: 创建 DSH 会话后没有拿到 sessionId');

  // 事实面（形态 1 的可见化）：只有宿主回传 agentPreset === 'wsl' 才敢说 true；
  // 旧宿主静默丢字段时这里必为 false —— 不许把"请求过"当成"已应用"。
  const applied = str(created?.agentPreset).trim();
  return {
    ok: true,
    sessionId,
    cwd,
    distro,
    path,
    ...(workspaceId ? { workspaceId } : {}),
    presetRequested: WSL_PRESET_ID,
    presetApplied: applied === WSL_PRESET_ID,
    agentPreset: applied || null,
    ...(presetDegraded ? { presetDegraded: true, presetError } : {}),
  };
}

  /**
   * `explorer.addWorkspace({path, title?})` —— 把一个**发行版内路径**登记为 DSH 工作区（采纳项 A1 的 host 半）。
   *
   * 依 T11 实测的契约（不重新发明）：
   * · host 服务是 **`workspaceRegistry`**（不是 `workspaces`），`create(path, title)`（**arity 2**）；
   * · 上游 `create` 要求路径**全限定**且**已存在**（`realpathNormalize`）—— 在 win32 下 `\\wsl.localhost\<distro>\…`
   *   这种 UNC 的 `root` 是 `\\host\` ⇒ 通过；而**发行版内路径**（`/home/g`）的 `win32.parse().root === "/"`
   *   ⇒ 被上游判"非全限定"直接抛 `TypeError`。所以本方法**只收 WSL 绝对路径**，内部转 UNC 后再交给上游；
   * · `resolveByPath` 用来判"已登记" ⇒ 已登记就**返回既有 id + `alreadyExisted:true`，绝不新建第二个**。
   *
   * 为什么 `/mnt/<盘符>` **先拒绝**（与 `explorer.listDir` 的 `windowsDriveForMount` 取舍一致）：
   * `/mnt/c` 本来就是 **Windows 卷**（不是发行版内的 ext4 路径），把它登成 UNC 工作区会让"同一份数据两条路径"
   * 并存；`listDir` 那边已经把它特判成 `C:\…`（因为 9p 不暴露 drvfs 挂载根）。所以这里给**可读错误 + 去向**，
   * 而不是制造一条与面板浏览不一致的登记。
   *
   * 副作用边界：**会写 host 侧的工作区存储**（这是本方法的用途），但**不碰守护/端口/发行版**；
   * 失败（含参数错、路径不存在、服务缺失）都在**写之前**返回 ⇒ 零副作用。
   *
   * @param args `{ path, title?, distro? }`（`distro` 缺省 = 配置里的发行版）
   * @returns `{ ok:true, id, title, uncPath, alreadyExisted }`
   */
  async function addWorkspace(args) {
    const { distro, path } = await resolveTarget(args, 'explorer.addWorkspace');
    const mount = windowsDriveForMount(path);
    if (mount !== null) {
      failArg(
        `remote-wsl: explorer.addWorkspace 不接受 /mnt/<盘符> 路径（收到 "${path}"）：它本来就是 Windows 卷 ${mount}，` +
          `与面板浏览（explorer.listDir）把它当 ${mount} 读的取舍必须一致。请改用发行版内的 ext4 路径（例如 /home/…），` +
          `或在需要 Windows 卷时按 Windows 路径语义登记。`,
      );
    }

    // 服务可用性：拿不到就给**可读 503 + 一行降级日志**（照 webServer 那次的写法，不静默）
    const registry = typeof deps.workspaceRegistry === 'function' ? deps.workspaceRegistry() : undefined;
    if (!registry || typeof registry.create !== 'function' || typeof registry.resolveByPath !== 'function') {
      log('workspaceRegistry 服务不可用 ⇒ explorer.addWorkspace 降级（无法登记 DSH 工作区；方法表其余方法不受影响）');
      failUnavailable(
        'remote-wsl: host 侧 workspaceRegistry 服务不可用 ⇒ 无法把该路径登记为 DSH 工作区（其余面板功能不受影响）',
      );
    }

    const uncPath = unc(distro, path);
    // 存在性前置判定：Windows 侧经 9p stat（与上游 realpath 的要求一致），但把 ENOENT 变成**可读 404**
    try {
      const st = statSync(uncPath);
      if (!st.isDirectory()) {
        failNotFound(`remote-wsl: explorer.addWorkspace 的路径 ${path} 不是目录（UNC ${uncPath}）`);
      }
    } catch (e) {
      const code = str(e?.code);
      const detail = `${code || 'no-code'}: ${e?.message ?? String(e)}`;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        failNotFound(`remote-wsl: explorer.addWorkspace 的路径 ${path} 不存在（UNC ${uncPath}；${detail}）`);
      }
      failUnavailable(`remote-wsl: explorer.addWorkspace 无法确认路径 ${path}（${detail}）`);
    }

    const title = str(args?.title).trim() || baseName(path) || path;

    // ★ 已登记 ⇒ 复用（不新建）：这是"点两次不产生第二个工作区"的关键
    let existing = null;
    try {
      existing = await Promise.resolve(registry.resolveByPath(uncPath));
    } catch {
      existing = null; // 解析失败按"未登记"处理，让下面的 create 给出真正的错误
    }
    const existingId = str(existing?.id) || str(existing?.record?.id);
    if (existingId) {
      return {
        ok: true,
        id: existingId,
        title: str(existing?.record?.title) || str(existing?.title) || title,
        uncPath,
        alreadyExisted: true,
      };
    }

    let created;
    try {
      created = await Promise.resolve(registry.create(uncPath, title));
    } catch (e) {
      const code = str(e?.code);
      const detail = `${code || e?.name || 'no-code'}: ${e?.message ?? String(e)}`;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        failNotFound(`remote-wsl: 登记工作区失败：路径不存在（UNC ${uncPath}；${detail}）`);
      }
      if (/not fully qualified/i.test(str(e?.message))) {
        failArg(`remote-wsl: 登记工作区失败：上游判定路径非全限定（UNC ${uncPath}；${detail}）`);
      }
      failUnavailable(`remote-wsl: 登记工作区失败（UNC ${uncPath}；${detail}）`);
    }
    const id = str(created?.id) || str(created?.record?.id);
    if (!id) {
      failUnavailable(`remote-wsl: 登记工作区后上游未返回 id（UNC ${uncPath}）⇒ 视为失败，未登记`);
    }
    return { ok: true, id, title: str(created?.record?.title) || title, uncPath, alreadyExisted: false };
  }

  const handlers = {
    'explorer.snapshot': snapshot,
    'explorer.openSession': openSession,
    'explorer.daemon': daemonAction,
    'explorer.fixPin': fixPin,
    'explorer.listDir': listDir,
    'explorer.addWorkspace': addWorkspace,
    'explorer.newSession': newSession,
  };
  return { handlers, log };
}

/**
 * ── 传输层（第 2 层）────────────────────────────────────────────────────────────
 *
 * 来源可信判据（安全要求 (a)；2026-10-21 修正桌面壳误杀）：
 *   · `Host` 必须存在（HTTP/1.1 必备）；
 *   · `Sec-Fetch-Site` 若存在必须是 `same-origin`（浏览器同源 fetch 会带；跨站带 cross-site）；
 *   · `Origin` 若存在，其 `host[:port]` 必须与请求的 `Host` 头逐字相同；
 *   · **`Origin` 缺失 ⇒ 放行**：浏览器对**每一个 POST** 都带 `Origin`（同源也带），并对每个
 *     非导航请求都带 `Sec-Fetch-Site`；两个头都没有只可能来自非浏览器客户端。DSH Desktop
 *     （Electron 壳）就是这种形状：壳把页面 `dsh-app://app` 发起的 fetch 交给 Node fetch
 *     重放，并**主动删掉** `origin`/`host`/`cookie`/`sec-fetch-site`
 *     （`app.asar/lib/main.js` 的 `forwardWebRequest`，2026-10-21 平台版本实测），
 *     于是到达本路由的请求只剩 Node 重新生成的 `Host`。
 *
 * 这不是新开的口子，而是与官方同策略：`@deepseek-ai/dsh-client-connection` 的 `admit()`
 * （`lib/index.js:238-249`）判据是「`sec-fetch-site === 'cross-site'` ⇒ 拒；`origin ===
 * undefined` ⇒ **放行**；否则 `Origin` 必须与 Host 同 authority」。本机进程本来就能直接
 * 伪造 `Origin`（2026-10-21 实测 200），所以放行"无 Origin"不扩大 CSRF 面：闸门挡的是
 * **第三方网页借用户浏览器发请求**，那种请求必带 `Origin` 或 `Sec-Fetch-Site`。
 *
 * 为什么按 `Host` 比而不是比配置里的端口：GUI 可能是 `dsh web --port N` 起的（N 可变），
 * 也可能是桌面壳的 `dsh-app://app`（无端口）；`Origin`/`Host` 是**同一次请求自证**的一对，
 * 比较它们不依赖任何配置。这是 CSRF 防线，不是身份认证 —— 身份仍由 DSH 自己的
 * browser-session / 桌面壳 cookie 负责。
 */
function isSameOrigin(req) {
  const headers = req?.headers ?? {};
  const host = str(headers.host).trim();
  if (!host) return false;
  const site = str(headers['sec-fetch-site']).trim().toLowerCase();
  if (site && site !== 'same-origin') return false;
  const origin = str(headers.origin).trim();
  if (!origin) return true; // 桌面壳转发（forwardWebRequest 删头）/ 本机客户端：没有浏览器标记可校验
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

/** 失败 `code` → HTTP 状态码（lead 加固 2：错误路径必须是可读结构化响应，不是 500 裸栈）。
 *  `E_NOTFOUND`(404) 是 A3 的加法，与 `explorer.listDir` 的"路径不存在"一类**成对**存在：
 *  状态码表新增一项，方法表也新增一项，两边都不单独扩张。 */
const STATUS_BY_CODE = { E_ARG: 400, E_NOTFOUND: 404, E_UNAVAILABLE: 503 };

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
        sendJson(res, 403, { ok: false, error: '跨站请求被拒（Origin/Host 不同源）', code: 'E_ORIGIN', detail: null, reason: 'cross-origin' });
        return;
      }

      // GET = 纯只读的方法发现（lead 第 1 条）；其余动词一律 405。
      if (method0 === 'GET') {
        sendJson(res, 200, { ok: true, methods: EXPLORER_METHODS });
        return;
      }
      if (method0 !== 'POST') {
        sendJson(res, 405, { ok: false, error: `只接受 GET（方法清单）与 POST（调用）；收到 ${method0}`, code: 'E_METHOD', detail: null, reason: 'bad-verb' });
        return;
      }

      // (c) 类型：必须是 application/json。
      const ctype = str(req?.headers?.['content-type']).toLowerCase();
      if (!ctype.includes('application/json')) {
        sendJson(res, 415, { ok: false, error: `POST 需要 content-type: application/json（收到 "${ctype || '(空)'}"）`, code: 'E_CONTENT_TYPE', detail: null, reason: 'not-json' });
        return;
      }

      let method = '';
      let args = {};
      try {
        const body = await readJsonBody(req);
        method = str(body?.method);
        args = body?.args && typeof body.args === 'object' ? body.args : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON: ${e?.message ?? String(e)}`, code: 'E_BODY', detail: null, reason: 'bad-json' });
        return;
      }

      // (b) 硬编码白名单：只有方法表里这四个字符串能被执行。
      const handler = EXPLORER_METHODS.includes(method) ? handlers[method] : undefined;
      if (typeof handler !== 'function') {
        sendJson(res, 400, { ok: false, error: `未知方法 ${method || '(空)'}`, methods: EXPLORER_METHODS, code: 'E_UNKNOWN_METHOD', detail: null, reason: 'unknown-method' });
        return;
      }

      try {
        const result = await handler(args);
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        // (e) 只回 message + 机器可读 code + detail + reason，不回显请求体 / headers / 任何凭据、不带栈。
        // ★ F-36（task-8）：**统一错误体** —— 四个字段各有唯一消费者：
        //   `error`(message) 人读的一句话（脚本工具也靠它，必须可独立读懂）；
        //   `code`           HTTP 状态码选择器（STATUS_BY_CODE）；
        //   `detail`         技术细节（daemon.log 尾部 / systemd 提示），面板折叠显示；
        //   `reason`         稳定机器标签（如 `unknown-distro`），让客户端**不必解析中文**。
        const code = str(e?.code);
        const detail = typeof e?.detail === 'string' && e.detail.length > 0 ? e.detail : null;
        const reason = typeof e?.reason === 'string' && e.reason.length > 0 ? e.reason : null;
        sendJson(res, STATUS_BY_CODE[code] ?? 500, { ok: false, error: e?.message ?? String(e), code: code || 'E_UNKNOWN', detail, reason });
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
  /** inject 回调是否**至少触发过一次**（F15 判据：只有"根本没触发"才补降级日志）。 */
  let injectFired = false;

  /**
   * 把路由注册**整体**包进 try/catch（lead 加固 1，阻断级）。
   *
   * 为什么：官方 `webServer.register` 在**重复 (kind,path)** 时 throw；而注册发生在
   * `ctx.inject` 回调里。异常冒出去可能 ① 把整个插件（含 6 个 agent 工具）带下去；
   * ② 留下"注册成功但 dispose 还没接上"的无主残留。所以：
   *   · 注册成功 → `removeRoute` 立刻接上，并返回可等待的 disposer；
   *   · 注册 throw → 只**降级数据面**（打一行 `explorer http route unavailable: …`），
   *     插件其余部分照常；
   *   · 兜底：万一在赋值之后才抛，先把**本次**注册的路由 dispose 掉再降级。
   *
   * ★★ F32（task-8）：`registeredHere` 是**每次回调自己**的局部标志。
   * 改前的缺陷：catch 里无条件 `removeRoute = null`，而 `removeRoute` 是同一次
   * `registerExplorer` 内**共享**的变量 —— 于是当 inject 回调被触发**第二次**（HMR / 服务重提供）、
   * 第二次因 duplicate 抛错时，会把**第一次成功注册**那条路由的 disposer 抹掉 ⇒
   * 卸载后路由计数仍为 1（残留，且仍持旧闭包）。实测对照见
   * `spike/verify/explorer-20261012/reliability/out-C-03-inject-twice.txt`。
   * 现在：只有"本次确实注册成功过"才允许清理/置空 `removeRoute`。
   */
  const registerRoute = (webCtx) => {
    injectFired = true;
    if (warnTimer) clearTimeout(warnTimer);
    let registeredHere = false;
    let adapter = null;
    try {
      const webServer = typeof webCtx?.get === 'function' ? webCtx.get('webServer') : undefined;
      if (!webServer || typeof webServer.register !== 'function') {
        log('webServer 服务不可用 ⇒ explorer.* 的 HTTP 路由未注册（方法表仍可用）');
        return;
      }
      adapter = createExplorerHttpAdapter(webServer, handlers);
      // 新路由已就位：把**上一次**（若还在，例如换了一个 webServer 实例）释放掉，
      // 避免同一次 registerExplorer 内两条 route 并存。
      if (typeof removeRoute === 'function') {
        try {
          removeRoute();
        } catch (e2) {
          log(`释放上一次路由失败: ${e2?.message ?? String(e2)}`);
        }
      }
      removeRoute = adapter.dispose;
      registeredHere = true;
      log(`面板数据面已注册: ${EXPLORER_ROUTE}（方法 ${EXPLORER_METHODS.join(', ')}）`);
    } catch (e) {
      // 只清**本次**注册成功的那条；本次没成功 ⇒ 绝不碰 removeRoute（那可能是上一次成功注册的）
      if (registeredHere && adapter && typeof adapter.dispose === 'function') {
        try {
          adapter.dispose();
        } catch (e2) {
          log(`dispose 本次已注册路由时又失败: ${e2?.message ?? String(e2)}`);
        }
        removeRoute = null;
      }
      log(`explorer http route unavailable: ${e?.message ?? String(e)}（面板数据面降级；6 个 agent 工具不受影响）`);
      return;
    }
    return () => {
      // 幂等：只释放本次注册的那条
      if (!registeredHere) return;
      registeredHere = false;
      try {
        if (typeof adapter?.dispose === 'function') adapter.dispose();
      } catch (e) {
        log(`移除路由失败: ${e?.message ?? String(e)}`);
      }
      if (removeRoute === adapter?.dispose) removeRoute = null;
    };
  };

  /**
   * ★★ F15（task-8）：`webServer` **永不就绪**（条件注入的回调根本不触发）时，改前**一行日志都没有**
   * —— 数据面静默缺席，排查时只能靠猜（INJ-C1 实测 `stderr=[]`）。
   * 这里补一条**一次性**降级日志。两点纪律：
   *   · 只在 `injectFired === false` 时打（`webServer` 到位但服务形状不对的那句已有，绝不重复打）；
   *   · 定时器 `unref()`（诊断不能拖住宿主退出），且 inject 一旦触发就立刻清掉。
   * 延迟默认 30s（服务激活通常快得多，避免误报"永不就绪"）；可用
   * `DSH_REMOTE_WSL_INJECT_WARN_MS` 覆盖 —— 这是给验证用的接缝（T10 不必等 30 秒）。
   */
  const warnAfterMs = Number(process.env.DSH_REMOTE_WSL_INJECT_WARN_MS) || 30000;
  const warnTimer = setTimeout(() => {
    if (!injectFired) {
      log('webServer 未就绪 ⇒ explorer.* HTTP 路由未注册（方法表仍可用）');
    }
  }, warnAfterMs);
  warnTimer.unref?.();

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
      if (warnTimer) clearTimeout(warnTimer);
      if (typeof removeRoute === 'function') removeRoute();
      removeRoute = null;
    },
  };
}
