/**
 * 诊断事实收集器：只读纪律 + 解析 + 门控（面板 `explorer.diagnose` 与工具 `wsl_doctor` 共用）。
 * 结构断言（不 spawn wsl.exe）用源码级检查，与 test/supply-chain.test.ts 同风格。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { collectDoctorFacts, parseMeminfo, daemonFactsFromMeta } from '../src/doctor-facts.ts';
import { doctorReport } from '../src/doctor.ts';

const MEMINFO = `MemTotal:       16380460 kB
MemFree:         2048000 kB
SwapTotal:       8388604 kB
SwapFree:                0 kB
`;

const CFG = { distro: 'D', wslHome: '/home/u', cwd: '/home/u' };

test('parseMeminfo：与 free -m 对齐（MB / swap 百分比），字段缺失返回 null', () => {
  const m = parseMeminfo(MEMINFO)!;
  assert.equal(m.totalMB, 15997);
  assert.equal(m.freeMB, 2000);
  assert.equal(m.swapUsedPct, 100);
  assert.equal(parseMeminfo(''), null);
  assert.equal(parseMeminfo('MemTotal: 1 kB'), null);
});

test('daemonFactsFromMeta：null=未探测，对象=登记状态', () => {
  assert.equal(daemonFactsFromMeta(null), null);
  assert.equal(daemonFactsFromMeta('x'), null);
  assert.deepEqual(daemonFactsFromMeta({ slot: 8731, pid: 9, version: '1' }), {
    present: true,
    running: true,
    reachable: undefined,
    detail: 'slot=8731 pid=9 version=1',
  });
});

test('collectDoctorFacts：探针抛错不冒泡，落成 fail/skip', async () => {
  const facts = await collectDoctorFacts(
    { config: CFG },
    {
      listDistros: async () => {
        throw new Error('boom');
      },
      resolveVersion: () => {
        throw new Error('vboom');
      },
      readDaemonMeta: () => {
        throw new Error('dboom');
      },
      readMeminfo: () => {
        throw new Error('mboom');
      },
    },
  );
  assert.equal(facts.distrosReadFailed, true);
  assert.match(String(facts.versionIssue), /vboom/);
  assert.equal(facts.daemon, null);
  assert.equal(facts.memory, null);
  const report = doctorReport(facts);
  assert.equal(report.verdict, 'blocked', 'listDistros 失败 ⇒ 有 fail ⇒ blocked');
});

test('门控：内存只读 /proc/meminfo（readMeminfo），发行版缺失时三探针零调用', async () => {
  let mem = 0;
  let daemon = 0;
  const facts = await collectDoctorFacts(
    { config: { ...CFG, distro: 'Nope' } },
    {
      listDistros: async () => ['Other'],
      resolveVersion: () => ({ version: '1' }),
      readDaemonMeta: () => {
        daemon += 1;
        return {};
      },
      readMeminfo: (d) => {
        mem += 1;
        assert.equal(d, 'Nope');
        return MEMINFO;
      },
    },
  );
  assert.equal(facts.targetMissing, true);
  assert.equal(mem, 0, '目标缺失时不得读内存');
  assert.equal(daemon, 0, '目标缺失时不得读守护元数据');
});

test('正常路径：内存进 facts，verdict 由 doctorReport 计算', async () => {
  const facts = await collectDoctorFacts(
    { config: CFG },
    {
      listDistros: async () => ['D'],
      resolveVersion: () => ({ version: '0.2.2' }),
      readDaemonMeta: () => ({ slot: 8731, pid: 1, version: '1' }),
      readMeminfo: () => MEMINFO,
    },
  );
  assert.deepEqual(facts.memory, { totalMB: 15997, freeMB: 2000, swapUsedPct: 100 });
  const report = doctorReport(facts);
  assert.equal(report.verdict, 'blocked', 'swap 100% ⇒ 内存项 fail ⇒ blocked');
});

test('结构纪律：doctor-facts.ts 不出现 child_process / wsl.exe（诊断路径不启动发行版）', () => {
  const raw = readFileSync(new URL('../src/doctor-facts.ts', import.meta.url), 'utf8');
  // 只看代码行：注释里出现 "node:child_process" 是在描述纪律，不算违规。
  const src = raw
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  assert.equal(/node:child_process/.test(src), false, '不得 import child_process');
  assert.equal(/\bwsl\.exe\b/.test(src), false, '不得 spawn wsl.exe');
  assert.equal(/\bspawn(Sync)?\(/.test(src), false, '不得 spawn 任何进程');
});
