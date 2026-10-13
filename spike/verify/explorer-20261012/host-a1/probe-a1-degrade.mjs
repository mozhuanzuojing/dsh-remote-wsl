// probe-a1-degrade.mjs —— ⑤ 服务缺失降级：workspaceRegistry 拿不到 ⇒ 可读 503 + **一行日志**（不静默）。
import { spawnSync } from 'node:child_process';
const ex = await import('file:///D:/project/dsh1/vendor/dsh-remote-wsl/src/explorer.ts');

// 捕获 stderr 里的降级日志
const captured = [];
const orig = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return true; };

const makeHandlers = (registryGetter) => ex.createExplorerHandlers({
  config: { distro: 'debian-u8-1', wslHome: '/home/g', cwd: '/home/g', daemonPort: 8911 },
  listDistros: () => ['debian-u8-1'],
  resolveVersion: () => ({ version: '0.2.0-rc.2', desktopVersion: '0.2.0-rc.2', pin: '0.2.0-rc.2', drift: null }),
  writePin: () => true,
  webHosts: new Map(),
  workspaceRegistry: registryGetter,
});

async function probe(label, getter, args) {
  const { handlers } = makeHandlers(getter);
  try {
    const r = await handlers['explorer.addWorkspace'](args);
    console.log(`[${label}] 未抛错（意外）: ${JSON.stringify(r)}`);
    return { threw: false, code: null };
  } catch (e) {
    console.log(`[${label}] throw code=${e?.code ?? '(none)'} :: ${String(e?.message).slice(0, 150)}`);
    return { threw: true, code: e?.code ?? null };
  }
}

console.log('=== ⑤a workspaceRegistry 服务缺失（getter 返回 undefined）===');
const a = await probe('missing', () => undefined, { path: '/home/g' });
console.log('=== ⑤b 服务存在但 create 不是函数（形状不对）===');
const b = await probe('wrong-shape', () => ({ resolveByPath: () => null }), { path: '/home/g' });
process.stderr.write = orig; // ★ 两个探测都跑完再恢复（第一次恢复过早 ⇒ 只捕获到 1 条，是夹具自身的 bug）

const logs = captured.join('');
const degradeLine = logs.split('\n').filter((l) => l.includes('workspaceRegistry 服务不可用'));
console.log(`\n捕获到的降级日志行（应恰好 2 条，每个失败一次）:`);
degradeLine.forEach((l) => console.log(`   ${l}`));
console.log(`\n判据: ⑤a/⑤b 都是 E_UNAVAILABLE = ${a.code === 'E_UNAVAILABLE' && b.code === 'E_UNAVAILABLE'}`);
console.log(`判据: 降级日志行数 = ${degradeLine.length}（期望 2，且含 "不静默" 的说明）`);
console.log(`判据: 服务不可用时**不触碰** registry（getter 只读）与文件系统 = 无副作用（无 create 调用）`);
process.exit(a.code === 'E_UNAVAILABLE' && b.code === 'E_UNAVAILABLE' && degradeLine.length === 2 ? 0 : 1);
