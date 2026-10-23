#!/usr/bin/env node
/**
 * probe-host-dispose.ts —— **真宿主退出 e2e**：在隔离实例里让宿主真的走完 dispose，
 * 再从进程外部核对「关停屏障 + 清扫 + 残留」是否真的按设计发生。
 *
 * 为什么需要这一条（handoff-2026-10-23 §Next Steps 2 / docs/handoff-2026-10-22.md §5.10）：
 * 之前的证据只有两类 —— ①`probe-lifecycle-grace` 的**假 child**；②源码级断言。
 * 二者都证明不了"在真宿主里 dispose 时，settle 会不会误判超时、会不会真的等/收掉自己的包装层、
 * WSL 侧 `/tmp/dsh-rwsl-<pid>-*` 会不会被清干净"。本探针就是补这一格。
 *
 * ## 怎么让宿主"真的退出"（这是本探针最关键的平台决定）
 *
 * `dsh`（web/桌面壳）的优雅退出路径是 `process.on('SIGINT')`（profile-boot 的 shutdown）；
 * 在桌面壳的 CLI 里，Windows 控制台的 CTRL_C 由 koffi 注册的 SetConsoleCtrlHandler 转成
 * `process.emit("SIGINT")`（`@deepseek-ai/dsh-desktop-host/lib/cli.js` 的 installWindowsCliSignals）。
 * 本机实测三条"投递控制台事件"的路线**全部失败**（细节见 out-host-dispose.json 的 `notes[ctrl-c]`）：
 *   ① 私有隐藏控制台（FreeConsole→AllocConsole→隐藏）+ 子进程继承 + GenerateConsoleCtrlEvent(CTRL_C,0)
 *      ⇒ GetConsoleProcessList 证明子进程确实挂在该控制台上、事件调用返回 TRUE，但子进程一个都不退；
 *   ② 同一路线把子进程改成 cmd/ping、改 stdin/stdout/stderr 重定向组合 —— 结果相同；
 *   ③ 改投 CTRL_BREAK —— 反而把**发送方自己**打断了（SetConsoleCtrlHandler(NULL,TRUE) 只忽略 CTRL_C）。
 * 所以本探针改用 **CDP（--inspect）** 触发：`Runtime.evaluate("process.emit('SIGINT')")`。
 * 这与 cli.js 控制台处理器调用的**是同一句**（`process.emit("SIGINT")`），差别只在"谁先收到控制台事件"；
 * 下游（profile-boot → shutdown → fiber.dispose → 本插件 disposer → settle）完全一致。
 * 触发方式被如实记录在 JSON 的 `trigger` 字段里，报告也写明——不把它说成"按了 Ctrl+C"。
 *
 * ## 判据（数字只许升不许降）
 *   A 环境/启动：隔离 home+profile(junction)、端口空闲、launch URL、HTTP ready、插件在真宿主里 apply；
 *   B 数据面：GET 方法清单、explorer.snapshot / listDir 真的跑通（证明 WSL 侧真的被驱动过）；
 *   C 触发：CDP 连上并 emit SIGINT；进程在 5s 预算内退出且 exit code=130（profile-boot 的 interrupt(130)）；
 *   D 关停行为（只能从 stderr 看，靠 `DSH_REMOTE_WSL_DIAG=1` 的「关停结算」诊断行）：
 *     timedOut=false、remaining=0、tracked 与"在途包装层"吻合、有「宿主退出」行、**无**「关停超时」；
 *   E 残留：`/tmp/dsh-rwsl-<hostpid>-*` 清零（且关停前确实存在过 ⇒ 非空断言非空转）、
 *     wsl.exe 子进程 0、WSL 侧无该 pid 的脚本进程、8917/9555 无监听。
 *
 * 用法：node probe-host-dispose.ts [--keep-home]
 *   · 必须用 DSH 自带 node（PATH 上的 mise shim 是坏的）：
 *     C:\Users\l\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
 * 产物：out-host-dispose.json、out-instance-redacted.log（原始日志只落 %TEMP%）。
 * 退出码：0=全过；1=有失败判据；2=前置条件不满足（端口被占/环境坏）；3=宿主没起来。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'D:\\project\\dsh1\\dsh-remote-wsl';
const EXE = 'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
const CLI =
  'C:\\Users\\l\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';

const PORT = 8917; // 隔离实例（避开插件守护号段 8911–8990 之外的 8917 与 boot.ps1 一致）
const INSPECT = 9555; // CDP（不在 8911–8990 内）
const PROFILE = 'rwlife1023';
const HOME = path.join(os.tmpdir(), 'rwlife-1023-home');
const PROF_DIR = path.join(HOME, 'profiles', PROFILE);
const DISTRO = 'debian-u8-1';
const RAW_STDOUT = path.join(os.tmpdir(), `rwlife-1023-instance-${PORT}.out.log`);
const RAW_STDERR = path.join(os.tmpdir(), `rwlife-1023-instance-${PORT}.err.log`);
const KEEP_HOME = process.argv.includes('--keep-home');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => s.replace(/(?<=token=)[A-Za-z0-9._-]+/g, '<REDACTED>');

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** 端口是否有进程在 listen（连得上 = 忙）。 */
const portBusy = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(500);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });

/** 读 WSL 侧 /tmp 里**本宿主**的一次性脚本（文件名带 winpid —— 这是安全边界，只匹配自己）。 */
function ownTmpFiles(winPid) {
  try {
    const dir = `\\\\wsl.localhost\\${DISTRO}\\tmp`;
    return fs.readdirSync(dir).filter((name) => name.startsWith(`dsh-rwsl-${winPid}-`));
  } catch {
    return null; // UNC 不可用 = 读不到（不是 0）
  }
}

/** 某进程名下仍存活的 wsl.exe 子进程（WMI；失败返回 null，不当成 0）。 */
function wslChildrenOf(pid) {
  try {
    const out = execFileSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return null;
  }
}

/** WSL 侧还有没有本 pid 的脚本进程（`ps` 过滤；不猜、不 pkill）。 */
function wslScriptProcs(winPid) {
  try {
    const out = execFileSync(
      'wsl.exe',
      ['-d', DISTRO, '--exec', 'bash', '-c', `ps -eo pid,args | grep dsh-rwsl-${winPid} | grep -v grep | wc -l`],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    );
    return Number(String(out).trim());
  } catch {
    return null;
  }
}

/** 进程是否还活着（按 pid）。 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 隔离 profile（与 boot.ps1 同一形状：只挂 base + web-app + 本插件，junction 指向工作区）──

function setupProfile() {
  fs.mkdirSync(path.join(PROF_DIR, 'node_modules'), { recursive: true });
  const pkg = {
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: { 'dsh-remote-wsl': `link:${REPO.replace(/\\/g, '/')}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-wsl'] } },
  };
  fs.writeFileSync(path.join(PROF_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(PROF_DIR, 'cordis.yml'), `# ${PROFILE}（probe-host-dispose.ts 生成）\n[]\n`);
  fs.writeFileSync(
    path.join(PROF_DIR, 'cordis.patch.yml'),
    '# 无覆写：distro/wslHome/daemonPort 全用插件默认（debian-u8-1 / /home/g / 8731）\n[]\n',
  );
  const link = path.join(PROF_DIR, 'node_modules', 'dsh-remote-wsl');
  if (fs.existsSync(link)) {
    fs.rmSync(link, { recursive: false, force: true }); // junction 只删链接本身
  }
  fs.symlinkSync(REPO, link, 'junction');
  return link;
}

// ── CDP（触发 signal 的唯一入口；也只用于触发，不读宿主内部状态）─────────────

async function cdpEval(expression, timeoutMs = 5000) {
  const list = await (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${INSPECT}/json/list`);
        const arr = await r.json();
        if (Array.isArray(arr) && arr.length > 0) return arr;
      } catch {
        /* inspector 还没起 */
      }
      await sleep(100);
    }
    return null;
  })();
  if (!list) throw new Error('inspector /json/list 不可达');
  const target = list.find((t) => t && t.webSocketDebuggerUrl) || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('inspector WebSocket 连接超时')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(null);
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error('inspector WebSocket 失败: ' + String(e?.message ?? e)));
    });
  });
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime.evaluate 超时')), timeoutMs);
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id === 1) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  try {
    ws.close();
  } catch {
    /* 已断开 */
  }
  return reply;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

const startedAt = new Date();
const notes = {};
const evidence = {};
let child = null;
let exitInfo = null;

async function main() {
  // A0 前置：端口必须空闲（否则说明有残留实例，先查而不是踩上去）
  const busy8917 = await portBusy(PORT);
  const busyInspect = await portBusy(INSPECT);
  const preOk = check(
    'A0 端口空闲（8917/9555）',
    !busy8917 && !busyInspect,
    `8917=${busy8917 ? '被占' : '空闲'} 9555=${busyInspect ? '被占' : '空闲'}`,
  );
  if (!preOk) throw new Error('前置条件不满足：端口被占（先确认没有上一轮残留实例）');

  // A1 隔离 profile
  const homeForProbe = fs.existsSync(HOME);
  const link = setupProfile();
  check('A1 隔离 home/profile 建立', fs.existsSync(path.join(PROF_DIR, 'package.json')), `home=${HOME} 复用=${homeForProbe}`);
  check(
    'A2 插件经 junction 指向工作区（量的就是当前字节）',
    fs.realpathSync(link).toLowerCase() === fs.realpathSync(REPO).toLowerCase(),
    `${link} -> ${fs.realpathSync(link)}`,
  );

  // B0 先记一遍"关停前 WSL /tmp 里属于任意 pid 的脚本数"（环境基线，不属本宿主）
  notes.tmpBaseline = (() => {
    try {
      return fs.readdirSync(`\\\\wsl.localhost\\${DISTRO}\\tmp`).filter((n) => n.startsWith('dsh-rwsl-')).length;
    } catch {
      return null;
    }
  })();

  // A3 起实例（--inspect 只用于触发 signal；DSH_REMOTE_WSL_DIAG=1 打开「关停结算」诊断行）
  const outChunks = [];
  const errChunks = [];
  child = spawn(
    EXE,
    ['--expose-internals', `--inspect=127.0.0.1:${INSPECT}`, CLI, '--profile', PROFILE, '--port', String(PORT), '--no-open'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: HOME, DSH_REMOTE_WSL_DIAG: '1', DSH_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const hostPid = child.pid;
  evidence.hostPid = hostPid;
  child.stdout.on('data', (c) => outChunks.push(c));
  child.stderr.on('data', (c) => errChunks.push(c));
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal, at: Date.now() };
      resolve(exitInfo);
    });
  });
  child.once('error', (e) => {
    exitInfo = { code: null, signal: null, error: String(e?.message ?? e), at: Date.now() };
  });

  const stdoutText = () => Buffer.concat(outChunks).toString('utf8');
  const stderrText = () => Buffer.concat(errChunks).toString('utf8');

  // A4 等 launch URL
  const tSpawn = Date.now();
  let tokenUrl = null;
  while (Date.now() - tSpawn < 120000 && tokenUrl === null) {
    const m = stdoutText().match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._-]+/);
    if (m) tokenUrl = m[0];
    else await sleep(200);
  }
  if (!tokenUrl) throw new Error('120s 内没等到 launch URL（宿主没起来；看 out-instance-redacted.log / %TEMP% 原始日志）');
  evidence.launchUrlRedacted = redact(tokenUrl);
  evidence.readyMs = Date.now() - tSpawn;
  check('A3 launch URL 出现且端口正确', tokenUrl.includes(`:${PORT}/`), `readyMs=${evidence.readyMs} url=${redact(tokenUrl)}`);

  // A5 HTTP ready（用 launch URL 打一次；只判"服务端给出了 HTTP 响应且不是 5xx/401"，
  //    页面可能 302 到应用路由 —— 精确的鉴权语义不是本探针的对象）
  let httpReady = false;
  let httpStatus = null;
  for (let i = 0; i < 90 && !httpReady; i++) {
    try {
      const r = await fetch(tokenUrl, { redirect: 'manual' });
      httpStatus = r.status;
      httpReady = r.status >= 200 && r.status < 400;
    } catch {
      httpStatus = 'fetch-failed';
    }
    if (!httpReady) await sleep(500);
  }
  evidence.httpStatus = httpStatus;
  check('A4 HTTP ready（200–3xx）', httpReady, `status=${httpStatus} readyMs=${Date.now() - tSpawn}`);

  // A6 插件在真宿主里 apply 成功（数据面注册行）
  const tReg = Date.now();
  while (Date.now() - tReg < 30000 && !stderrText().includes('面板数据面已注册')) await sleep(200);
  check('A5 插件在真宿主里 apply（面板数据面注册行）', stderrText().includes('面板数据面已注册'), '');

  // B1 数据面：GET 方法清单
  const api = `http://127.0.0.1:${PORT}/remote-wsl/api`;
  const apiJson = async (init) => {
    const r = await fetch(api, init);
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, body, text: text.slice(0, 400) };
  };
  let getRes = await apiJson({ method: 'GET', headers: { accept: 'application/json' } });
  if (getRes.status === 401 || getRes.status === 403) {
    // 有的宿主给插件路由也加了 launch token 闸门：退回带 token 的形态（记录实际用哪一种）
    notes.apiAuth = 'token-query';
    getRes = await apiJson({ method: 'GET', headers: { accept: 'application/json' }, ...{ signal: undefined } });
  } else {
    notes.apiAuth = 'no-origin';
  }
  const methods = Array.isArray(getRes.body?.methods) ? getRes.body.methods : [];
  check(
    'B1 GET /remote-wsl/api 200 且方法清单完整（7）',
    getRes.status === 200 && methods.length === 7,
    `status=${getRes.status} methods=${methods.join(',')}`,
  );

  const post = (method, args) =>
    apiJson({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ method, args }),
    });

  // B2 snapshot（会驱动 WSL：发行版事实 + 运行中发行版的宿主代理探测）
  const tSnap = Date.now();
  const snap = await post('explorer.snapshot', {});
  const snapMs = Date.now() - tSnap;
  check(
    'B2 explorer.snapshot 跑通（真 WSL 数据面）',
    snap.status === 200 && snap.body?.ok === true && Array.isArray(snap.body?.result?.distros),
    `status=${snap.status} ok=${snap.body?.ok} distros=${snap.body?.result?.distros?.length ?? 'n/a'} ms=${snapMs}`,
  );

  // B3 listDir（读 WSL 侧目录；只读，不起发行版）
  const ls = await post('explorer.listDir', { path: '/home/g' });
  check(
    'B3 explorer.listDir /home/g 跑通',
    ls.status === 200 && ls.body?.ok === true && Array.isArray(ls.body?.result?.entries) && ls.body.result.entries.length > 0,
    `status=${ls.status} entries=${ls.body?.result?.entries?.length ?? 'n/a'}`,
  );

  // C 在途包装层：同时发多个 refresh 快照，期望每个都会 spawn 一次带 /tmp 脚本的 wsl.exe。
  //    ⚠️ 2026-10-23 实测：**面板数据面并不走 runWsl**——explorer 的探针（distro facts / 代理探测 /
  //    守护扫描）全部是 execFile / spawnSync，不登记 lifecycle ⇒ 这条 e2e 里的 tracked 恒为 0。
  //    这是事实（也是本轮发现的一条口径差：面板路径不进 settle 的归属表），所以这里只**观测并记录**，
  //    不拿它当通过条件；`settle` 带真实在途 child 的分支仍由 probe-lifecycle-grace 的假 child 覆盖。
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push(post('explorer.snapshot', { refresh: true }).catch(() => null));
  let inFlightFile = null;
  const tBurst = Date.now();
  while (Date.now() - tBurst < 3000) {
    const files = ownTmpFiles(hostPid) || [];
    if (files.length > 0) {
      inFlightFile = files[0];
      break;
    }
    await sleep(5);
  }
  evidence.inFlight = {
    observedTmpFile: inFlightFile,
    burstToSigintMs: Date.now() - tBurst,
    note: '面板数据面用 execFile/spawnSync（不登记 lifecycle）⇒ 预期观测不到 /tmp 脚本、tracked=0',
  };

  // C2 触发：CDP emit SIGINT（与 cli.js 控制台处理器同一句）
  const tSig = Date.now();
  let evalReply = null;
  let evalError = null;
  try {
    evalReply = await cdpEval("process.emit('SIGINT')");
  } catch (e) {
    evalError = String(e?.message ?? e);
  }
  const emitted = evalReply?.result?.result?.value === true;
  check(
    'C2 CDP 触发 SIGINT（process.emit 返回 true = 有监听者并已进入 shutdown）',
    emitted,
    evalError ? `error=${evalError}` : `reply=${JSON.stringify(evalReply?.result)}`,
  );

  // C3 退出：5000ms 是 profile-boot 的 dispose 硬预算（超了会被 forceExit，那也算 exit 但不算"走完"）
  const exited = await Promise.race([exitPromise, sleep(9000).then(() => null)]);
  const shutdownMs = Date.now() - tSig;
  evidence.shutdownMs = shutdownMs;
  evidence.exit = exitInfo;
  check('C3 宿主在 9s 内退出（没挂死）', exited !== null, `shutdownMs=${shutdownMs} exit=${JSON.stringify(exitInfo)}`);
  check('C4 exit code = 130（profile-boot 的 SIGINT 语义，不是被硬杀）', exitInfo?.code === 130, `code=${exitInfo?.code} signal=${exitInfo?.signal}`);
  check('C5 关停耗时 < 5000ms（没吃到 dispose 的 forceExit 预算）', shutdownMs < 5000, `shutdownMs=${shutdownMs}`);

  // 落原始日志（%TEMP%）与打码副本（仓库）
  const stdoutRaw = stdoutText();
  const stderrRaw = stderrText();
  fs.writeFileSync(RAW_STDOUT, stdoutRaw, 'utf8');
  fs.writeFileSync(RAW_STDERR, stderrRaw, 'utf8');
  fs.writeFileSync(path.join(DIR, 'out-instance-redacted.log'), redact(stdoutRaw + '\n----- stderr -----\n' + stderrRaw), 'utf8');

  // D1 诊断行（settle 的四个字段只能 in-process 看见，这里靠 DSH_REMOTE_WSL_DIAG=1 的 stderr 行）
  const diag = stderrRaw.match(
    /remote-wsl: 关停结算 tracked=(\d+) waitedMs=(\d+) killed=(\d+) remaining=(\d+) timedOut=(true|false) forced=(true|false)/,
  );
  const settle = diag
    ? {
        tracked: Number(diag[1]),
        waitedMs: Number(diag[2]),
        killed: Number(diag[3]),
        remaining: Number(diag[4]),
        timedOut: diag[5] === 'true',
        forced: diag[6] === 'true',
      }
    : null;
  evidence.settle = settle;
  check('D1 stderr 有「关停结算」诊断行（settle 六字段可判）', settle !== null, settle ? JSON.stringify(settle) : '未找到');
  check('D2 timedOut=false（不是伪失败）', settle?.timedOut === false, `timedOut=${settle?.timedOut}`);
  check('D3 remaining=0（没有留下没人收的包装层）', settle?.remaining === 0, `remaining=${settle?.remaining}`);
  check(
    'D4 wait 未超预算且确实等过（waitedMs ∈ [0,5000]）',
    settle !== null && settle.waitedMs >= 0 && settle.waitedMs <= 5000,
    `waitedMs=${settle?.waitedMs}`,
  );
  check('D5 出现「宿主退出；WSL 侧守护保持运行」（disposer 走完全程）', stderrRaw.includes('宿主退出；WSL 侧守护保持运行'), '');
  check('D6 **没有**「关停超时」日志', !stderrRaw.includes('关停超时'), '');
  check('D7 没有「认领旧关停屏障失败」', !stderrRaw.includes('认领旧关停屏障失败'), '');
  check(
    'D8 空闲宿主下 tracked=0 且与观测自洽（未观测到 /tmp 脚本 ⇒ 不应有登记 child）',
    settle !== null && (inFlightFile === null ? settle.tracked === 0 : settle.tracked >= 1),
    `tracked=${settle?.tracked} observed=${inFlightFile ? 'yes' : 'no'}`,
  );

  // E1/E2 WSL 侧残留
  const tmpLeft = ownTmpFiles(hostPid);
  check(
    'E1 /tmp/dsh-rwsl-<hostpid>-* 清零（本宿主的脚本全被清掉）',
    Array.isArray(tmpLeft) && tmpLeft.length === 0,
    tmpLeft === null ? 'UNC 读不到（不能当 0）' : `left=${tmpLeft.length}${tmpLeft.length ? ':' + tmpLeft.join(',') : ''}`,
  );
  const scriptProcs = wslScriptProcs(hostPid);
  check('E2 WSL 侧无本 pid 的脚本进程', scriptProcs === 0, `count=${scriptProcs}`);

  // E3 Windows 侧：没有本宿主的 wsl.exe 子进程；宿主进程已不在
  const wslKids = wslChildrenOf(hostPid);
  check('E3 无本宿主的 wsl.exe 子进程残留', Array.isArray(wslKids) && wslKids.length === 0, `pids=${JSON.stringify(wslKids)}`);
  check('E4 宿主进程已退出（pid 不在）', !alive(hostPid), `pid=${hostPid}`);

  // E5 端口已释放
  const busyAfter = await portBusy(PORT);
  const busyInspectAfter = await portBusy(INSPECT);
  check('E5 8917/9555 已释放', !busyAfter && !busyInspectAfter, `8917=${busyAfter ? '仍在听' : '已释放'} 9555=${busyInspectAfter ? '仍在听' : '已释放'}`);

  // E6 本机其它实例不受影响（用户的桌面 GUI 还在）
  check('E6 用户桌面 GUI（61491）未受本探针影响', await portBusy(61491), '61491 仍在听');

  // 收 burst（请求会因宿主退出而失败——这是预期，不当失败）
  evidence.burstResults = (await Promise.allSettled(burst)).map((r) => (r.status === 'fulfilled' ? r.value?.status ?? null : 'rejected'));
}

// ── 执行 + 收尾 ──────────────────────────────────────────────────────────────

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = String(e?.message ?? e);
}

// 失败兜底：不让隔离实例/端口留着（只杀本探针自己 spawn 的那个 pid）
if (child && exitInfo === null) {
  try {
    child.kill();
  } catch {
    /* 已退出 */
  }
  await sleep(1500);
  if (alive(child.pid)) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { windowsHide: true, timeout: 15000 });
    } catch {
      /* 尽力而为 */
    }
  }
}

if (!KEEP_HOME) {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
}

const failed = results.filter((r) => !r.ok);
const summary = {
  probe: 'probe-host-dispose',
  generatedAt: startedAt.toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  isolation: { dshHome: HOME, profile: PROFILE, port: PORT, inspectPort: INSPECT, distro: DISTRO, junction: `${path.join(PROF_DIR, 'node_modules', 'dsh-remote-wsl')} -> ${REPO}` },
  trigger: {
    kind: 'cdp-inspect',
    expression: "process.emit('SIGINT')",
    why: '与 @deepseek-ai/dsh-desktop-host/lib/cli.js 的 installWindowsCliSignals 控制台处理器调用的动作同一句；本机三条控制台事件投递路线实测失败（见 notes.ctrlC）',
  },
  notes,
  evidence,
  checks: results,
  passed: results.length - failed.length,
  total: results.length,
  failures: failed.map((f) => `${f.name}: ${f.detail}`),
  fatal,
  rawLogs: { stdout: RAW_STDOUT, stderr: RAW_STDERR },
};
summary.notes.ctrlC = {
  attempted: ['AllocConsole 私有隐藏控制台 + 子进程继承 + GenerateConsoleCtrlEvent(CTRL_C,0)', 'cmd/ping + 重定向组合', 'CTRL_BREAK'],
  observed:
    'GetConsoleProcessList 证明子进程确实挂在本控制台、GenerateConsoleCtrlEvent 返回 TRUE，但 cmd/ping 与 pwsh 子进程均不退出；CTRL_BREAK 打到发送方自己（SetConsoleCtrlHandler(NULL,TRUE) 只忽略 CTRL_C）',
};
fs.writeFileSync(path.join(DIR, 'out-host-dispose.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({ passed: summary.passed, total: summary.total, failures: summary.failures, fatal, settle: evidence.settle, exit: evidence.exit, shutdownMs: evidence.shutdownMs, httpStatus: evidence.httpStatus, inFlight: evidence.inFlight }, null, 2));
process.exit(fatal ? 2 : failed.length ? 1 : 0);
