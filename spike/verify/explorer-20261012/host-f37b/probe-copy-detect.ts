// probe-copy-detect.ts —— 回退"识别"分支测试：用**临时副本**把 systemd-run 变成不存在的命令，
// 走 auto 模式 ⇒ 必须识别为 SYSTEMD_FAIL → 回退 compat → 守护真活 → notes 里带告警。
// 不碰真机 PATH、不装任何东西；副本在 %TEMP%，测完删。
//
// ★ T61 根因修法（本条探针曾因 T3 拆分**静默失效**，两处"硬编码"都是 T45 那轮的同型问题）：
//   ① **拷贝清单**：原来手写 `['daemon-client.ts','daemon.ts']`。T3 把守护控制面拆成
//      daemon-protocol/daemon-launch/daemon-lifecycle 三个模块后，被 import 的文件不在清单里
//      ⇒ 副本内 `ERR_MODULE_NOT_FOUND`（实测：`Cannot find module …\t17-sysd-copy\daemon-protocol.ts`）。
//      改为**枚举 `src/*.ts`** ⇒ 以后再拆/再加文件都自动跟随，不会再悄悄过期。
//   ② **补丁目标**：原来写死 `DAEMON-CLIENT.TS`。T3 之后那个文件只剩 re-export，`systemd-run`
//      三处锚点已经搬到 `daemon-launch.ts` ⇒ 三个 `split().join()` 全成了**空操作**（实测打印
//      "systemd-run 出现 0 处"），探针于是**悄悄退化成"测正常路径"**（结论仍打印，但测的不是回退）。
//      改为**按内容定位**（扫所有拷贝进来的文件）+ **命中数必须 > 0，否则 exit 2 报错** ⇒
//      以后锚点再搬家会**响**，不会静默。
//   两处都从 `import.meta.url` 推导路径（位置无关），不再依赖绝对路径 `D:/project/...`。
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 位置无关：本文件位于 <repo>/spike/verify/explorer-20261012/host-f37b/ ⇒ 上溯 4 层到仓根
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..', '..', 'src');
const DIR = join(process.env.TEMP || '/tmp', 't17-sysd-copy');
const PORT = Number(process.argv[2] || 8912);

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// ── ① 按目录枚举拷贝（不再手写清单）──
const srcFiles = readdirSync(SRC).filter((n) => n.endsWith('.ts')).sort();
for (const n of srcFiles) cpSync(join(SRC, n), join(DIR, n));
console.log(`[copy] ${DIR}：整目录拷贝 src/*.ts ${srcFiles.length} 个（${srcFiles.join(', ')}）`);

// ── ② 按内容定位补丁 + 命中数为 0 即报错（不许退化成空操作）──
const PATCHES = [
  ['command -v systemd-run', 'command -v systemd-run-DOES-NOT-EXIST'],
  ['if out=$(systemd-run --user', 'if out=$(systemd-run-DOES-NOT-EXIST --user'],
  ['SYSTEMD_FAIL: 找不到 systemd-run（', 'SYSTEMD_FAIL: 找不到 systemd-run-DOES-NOT-EXIST（'],
];
let hits = 0;
const patchedIn = [];
for (const n of srcFiles) {
  const f = join(DIR, n);
  const orig = readFileSync(f, 'utf8');
  let s = orig;
  let local = 0;
  for (const [from, to] of PATCHES) {
    local += s.split(from).length - 1;
    s = s.split(from).join(to);
  }
  if (local > 0) {
    writeFileSync(f, s, 'utf8');
    hits += local;
    patchedIn.push(`${n}(${local})`);
  }
}
if (hits === 0) {
  console.error(
    `[copy] ✗ 补丁一处都没打上 ⇒ 本探针会退化成"测正常路径"，结果无意义。\n` +
      `        锚点：${PATCHES.map((p) => p[0]).join(' | ')}\n` +
      `        共拷入 ${srcFiles.length} 个文件；若锚点又被搬家/改写，请在此更新锚点（这是**故意的响**，不是噪声）。`,
  );
  process.exit(2);
}
console.log(`[copy] systemd-run 锚点命中 ${hits} 处，已 patch：${patchedIn.join(', ')}`);

const cfg = {
  distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', profile: 'sdk', proxyPort: 9910, backend: 'daemon',
  daemonPort: PORT, daemonPortTries: 3, daemonIdleMs: 1800000, daemonLingerMs: 600000,
  daemonQueueLimit: 4, daemonHandshakeTimeoutMs: 3000, daemonStartTimeoutMs: 20000,
};
const client = await import(`file:///${DIR}/daemon-client.ts`);
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
await client.stopDaemon(cfg, { slot: PORT, log: () => {} });
const r = await client.ensureDaemon(cfg, { version: '0.2.0-rc.2', log: (m) => out(`# ${m}`) });
out(`RESULT ${JSON.stringify({ ok: r.ok, pid: r.info?.daemonPid, port: r.port, mode: r.mode ?? null, notes: r.notes })}`);
const rec = client.readDaemonRecord(cfg, PORT);
const hs = rec ? await client.handshake(cfg, rec.meta?.port ?? PORT, rec.token, 3000) : { ok: false };
out(`AFTER ${JSON.stringify({ handshakeOk: hs.ok === true, pid: hs.info?.daemonPid ?? null })}`);
await client.stopDaemon(cfg, { slot: PORT, log: () => {} });
rmSync(DIR, { recursive: true, force: true });
out('[copy] 已删除临时副本');
