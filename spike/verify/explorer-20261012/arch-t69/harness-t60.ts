/**
 * harness-t60.ts —— T69：**独立**复验 T60（`WebHost` 失败后同端口重试返回 `OK 0ms :: null` 的静默假成功）。
 *
 * 我为什么不照抄他们的脚本：他们验的是"工具层 `wsl_open_ui` 的返回串"；我这里**直接打在根因对象上** ——
 * `WebHost.start()` 的"可用态判据"。做法是把 T55 抓到的现场**注入**出来：
 *   `child` 有值（上一次尝试留下的半死包装层）/ `url` 为空（从没起来过）⇒ 同端口再 `start()`。
 *
 * 两个树都是**真实模块**（Node 26 直跑 TS）：
 *   prefix = `git archive 598543c^ src`（T60 修复**之前**）
 *   head   = 当前工作树 `src/`
 *
 * 安全性：prefix 的旧判据 `if (this.child) return this.url;` 会在 **spawn 之前**短路返回 ⇒ **零副作用**；
 * head 那一侧用**不存在的发行版**做 cfg.distro，使它在真正 `spawn wsl.exe … dsh web` **之前**就失败
 * （UNC 写入/`wsl.exe -d` 即刻报错）⇒ 不会真的起任何 `dsh web`、不占端口、不碰他人守护。
 *
 * 用法：node harness-t60.ts <prefix|head> <path/to/register-tools.ts> <bogusDistro>
 * 输出：一行 JSON（stdout），字段见 `emit`
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [, , tree, modPath, bogusDistro] = process.argv;
if (!tree || !modPath || !bogusDistro) {
	console.error('用法：node harness-t60.ts <prefix|head> <register-tools.ts 路径> <不存在的发行版名>');
	process.exit(2);
}

const TIMEOUT_MS = 20000;
const mod: any = await import(pathToFileURL(path.resolve(modPath)).href);

// cfg 只给 web 启动路径真正会读到的字段；distro 故意不存在
const cfg = { distro: bogusDistro, wslHome: '/home/g', webPort: 8999, daemonPort: 8998 };
const host: any = new mod.WebHost(cfg, '0.0.0-t69');

// —— 注入 T55 抓到的现场：child 有、url 无 ——
let killed = false;
let killCalls = 0;
host.child = {
	kill() { killed = true; killCalls += 1; },
	stdout: { setEncoding() {}, on() {}, removeAllListeners() {}, resume() {} },
	stderr: { setEncoding() {}, on() {} },
	on() {},
};
host.script = '/tmp/dsh-rwsl-t69-injected-none.sh';

const timeout = new Promise((resolve) => setTimeout(() => resolve('__HARNESS_TIMEOUT__'), TIMEOUT_MS));
const t0 = Date.now();
let outcome: Record<string, unknown>;
try {
	const r = await Promise.race([host.start(), timeout]);
	const ms = Date.now() - t0;
	if (r === '__HARNESS_TIMEOUT__') outcome = { kind: 'timeout', ms };
	else if (r === null) outcome = { kind: 'resolved_null', ms };
	else if (r === undefined) outcome = { kind: 'resolved_undefined', ms };
	else outcome = { kind: 'resolved_value', ms, valueHead: String(r).slice(0, 40) };
} catch (e) {
	outcome = { kind: 'threw', ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 240) };
}

const emit = {
	tree,
	modPath,
	bogusDistro,
	timedOutAt: TIMEOUT_MS,
	outcome,
	// 失败收尾是否发生（T60 的第二半：不能留半死对象）
	childAfter: host.child === null ? 'null' : typeof host.child,
	urlAfter: host.url === null ? 'null' : typeof host.url,
	scriptAfter: host.script === null ? 'null' : typeof host.script,
	injectedChildKilled: killed,
	killCalls,
	ts: new Date().toISOString(),
};
console.log(JSON.stringify(emit, null, 2));
