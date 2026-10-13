/**
 * probe-tools.ts —— T48 A① 的**逐工具真调探针**（预备件，等 T47/T50 落地后执行）。
 *
 * 三条纪律都写进代码：
 *   ① **孤立 `DSH_HOME`**：一切工具/接口真调都在 `%TEMP%\t48-dsh-home` 下跑，绝不写用户全局
 *      `~/.dsh/storages/workspace.json`（T46 的 A5 踩过：条目没变但 sha 变了）；
 *   ② **前后比 sha**：跑之前/之后各算一次用户全局 `storages/workspace.json` 的 sha256，
 *      报告里给对照（期望完全相同）；
 *   ③ **参数从工具自带的 JSON Schema 自动构造**（safe 默认值：字符串给安全值、布尔给 `false`、
 *      枚举优先 `stop`/只读项），避免把某个工具的 schema 写死在探针里。
 *
 * 用法：node --experimental-strip-types probe-tools.ts [--root <repoRoot>] [--out <json>] [--no-agent] [--only <toolName>]
 * 退出码：0 = 7 个工具全部真调成功；1 = 有工具抛错/失败；2 = 环境问题（工具没注册齐）
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = arg('root', 'D:/project/dsh1/vendor/dsh-remote-wsl');
const OUT = arg('out', '');
const ONLY = arg('only', '');
const NO_AGENT = process.argv.includes('--no-agent');

const TOOLS7 = ['wsl_status', 'wsl_exec', 'wsl_agent', 'wsl_daemon', 'wsl_open_ui', 'wsl_sync_version', 'wsl_path'];
const USER_HOME = join(homedir(), '.dsh');
const USER_WS = join(USER_HOME, 'storages', 'workspace.json');
const ISO_HOME = join(tmpdir(), 't48-dsh-home');

const shaOf = (p: string): string | null => (existsSync(p) && statSync(p).isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);
const wsBefore = shaOf(USER_WS);

// ── 孤立 DSH_HOME：目录 + （可选）只播种**凭据**，**绝不**播种 storages ──
// 说明：本机 DSH_HOME 里没有 `config.json`，凭据在 `.credentials.yaml` / `.env`（profiles 是目录）。
// 而 `wsl_agent` 的 provider 其实在 **WSL 侧**（`dsh --profile sdk`），Windows 侧 DSH_HOME 只影响
// storages/sessions/logs ⇒ **默认不复制任何密钥**到 %TEMP%；只有 `--seed-credentials` 才复制。
rmSync(ISO_HOME, { recursive: true, force: true });
mkdirSync(join(ISO_HOME, 'storages'), { recursive: true });
const SEED = process.argv.includes('--seed-credentials');
const seeded: string[] = [];
if (SEED) {
  for (const n of ['.credentials.yaml', '.env']) {
    const src = join(USER_HOME, n);
    if (existsSync(src)) { copyFileSync(src, join(ISO_HOME, n)); seeded.push(n); }
  }
}
process.env.DSH_HOME = ISO_HOME;
console.log(`孤立 DSH_HOME = ${ISO_HOME}（凭据播种：${SEED ? (seeded.join(', ') || '(无)') : '否（默认，不复制密钥）'}；storages 空）`);
console.log(`用户全局 workspace.json sha256(前) = ${wsBefore ?? '(不存在)'}`);

// ── 宿主接线（stub ctx，与 T3/T31 的手法一致）──
const tools = new Map<string, any>();
const services = new Map<string, any>();
const routes = new Map<string, any>();
services.set('webServer', { register(r: any) { const k = `${r.kind}:${r.path}`; if (routes.has(k)) throw new Error(`duplicate ${k}`); routes.set(k, r); return () => routes.delete(k); } });
const childCtx: any = { get: (k: string) => (k === 'tools' ? { register: (t: any) => tools.set(t.name, t) } : services.get(k)), set: (k: string, v: unknown) => void services.set(k, v), provide: (k: string, v: unknown) => void services.set(k, v) };
const ctx: any = { ...childCtx, inject: (_d: string[], cb: (c: unknown) => unknown) => cb(childCtx), effect: (fn: () => unknown) => { const d = fn(); return typeof d === 'function' ? d : undefined; }, plugin: () => {} };

const idx: any = await import(`file:///${ROOT}/src/index.ts`);
const cfg: any = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', dshVersion: '',
  daemonPort: 8931, daemonPortTries: 1, timeoutMs: 60000, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
  daemonIdleMs: 1800000, daemonQueueLimit: 4, useShellEnvironment: true, backend: 'daemon',
  provider: 'deepseek-official', model: 'deepseek-flash', desktopRuntimeJson: '', webPort: 8932, idleTimeoutMs: 120000, proxyPort: 9910, backgroundWarm: false,
};
idx.apply(ctx, cfg);
if (tools.size !== 7) { console.error(`✗ 工具注册数 = ${tools.size}（期望 7）：${[...tools.keys()].join(', ')}`); process.exit(2); }

/** 依工具自带 JSON Schema 造安全参数。 */
function autoArgs(schema: any, variant: 'safe' | 'alt' = 'safe'): any {
  const props = schema?.parameters?.properties ?? {};
  const args: any = {};
  for (const [k, v] of Object.entries<any>(props)) {
    if (v?.enum?.length) { args[k] = variant === 'alt' && v.enum.includes('stop') ? 'stop' : (v.enum.find((e: string) => /stop|status|off|false/i.test(String(e))) ?? v.enum[0]); continue; }
    if (v?.type === 'boolean') { args[k] = variant === 'alt' ? true : false; continue; }
    if (v?.type === 'number' || v?.type === 'integer') { args[k] = variant === 'alt' ? 60 : 30; continue; }
    if (v?.type === 'string') {
      if (/path/i.test(k)) args[k] = variant === 'alt' ? '/home/g' : 'D:\\project\\net1';
      else if (/command|cmd|script/i.test(k)) args[k] = 'echo t48-probe';
      else if (/prompt|text|task|message|input/i.test(k)) args[k] = 'Reply with exactly: ACK';
      else args[k] = 't48-probe';
      continue;
    }
    args[k] = null;
  }
  return args;
}

const results: Array<Record<string, unknown>> = [];
for (const name of TOOLS7) {
  const t = tools.get(name);
  if (ONLY && ONLY !== name) continue;
  const schema = { parameters: t.parameters };
  const isAgent = name === 'wsl_agent';
  if (isAgent && NO_AGENT) { results.push({ name, status: 'SKIPPED', detail: '--no-agent' }); console.log(`  SKIP ${name}（--no-agent）`); continue; }
  const calls: Array<['safe' | 'alt', any]> = name === 'wsl_open_ui' ? [['safe', autoArgs(schema, 'safe')], ['alt', autoArgs(schema, 'alt')]] : [['safe', autoArgs(schema, 'safe')]];
  for (const [variant, args] of calls) {
    const t0 = Date.now();
    let status = 'OK', detail = '';
    try {
      const out = await t.execute(args, { signal: new AbortController().signal, cwd: cfg.cwd });
      detail = typeof out === 'string' ? out.replace(/\s+/g, ' ').slice(0, 160) : JSON.stringify(out).slice(0, 160);
    } catch (e: any) { status = e instanceof ReferenceError ? 'REFERENCE_ERROR' : 'THREW'; detail = `${e?.name}: ${String(e?.message).slice(0, 200)}`; }
    results.push({ name, variant, args, status, ms: Date.now() - t0, detail });
    console.log(`  [${status === 'OK' ? 'PASS' : 'FAIL'}] ${name}${name === 'wsl_open_ui' ? `(${variant})` : ''} ${Date.now() - t0}ms — ${detail}`);
  }
}

const wsAfter = shaOf(USER_WS);
console.log(`\n用户全局 workspace.json sha256(后) = ${wsAfter ?? '(不存在)'}`);
console.log(`隔离核对：前后完全相同 = ${wsBefore === wsAfter}` + (wsBefore === wsAfter ? ' ✓' : ' ✗ 有写入！'));
const fails = results.filter((r) => r.status !== 'OK' && r.status !== 'SKIPPED');
console.log(`工具真调：${results.filter((r) => r.status === 'OK').length}/${results.length} OK；失败 ${fails.length}：${fails.map((f) => `${f.name}(${f.status})`).join(', ') || '(无)'}`);
if (OUT) { const { writeFileSync } = await import('node:fs'); writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), isoHome: ISO_HOME, seededCredentials: seeded, wsBefore, wsAfter, results }, null, 2), 'utf8'); }
process.exit(fails.length || wsBefore !== wsAfter ? 1 : 0);
