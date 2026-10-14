// probe-a1.ts —— T23 验收：经**真 host**（孤立 DSH_HOME 实例，端口 3093）调 explorer.addWorkspace。
// 用 node:http 显式设置 Origin/Host（同源门要求），打印每次的原始 HTTP 状态与 JSON。
import http from 'node:http';

const PORT = Number(process.argv[2] || 3093);
const HOST = `127.0.0.1:${PORT}`;
const call = (method, args) =>
  new Promise((resolve) => {
    const body = JSON.stringify({ method, args });
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/remote-wsl/api', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: `http://${HOST}`, host: HOST, 'sec-fetch-site': 'same-origin' } },
      (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, raw: t }); }); },
    );
    req.on('error', (e) => resolve({ status: 0, json: null, raw: `ERR ${e.message}` }));
    req.end(body);
  });

let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`); };
const show = (label, r) => console.log(`  ${label}: HTTP ${r.status} ${r.raw.slice(0, 300)}`);

console.log('########## ① 正常登记 /home/g ##########');
const a1 = await call('explorer.addWorkspace', { path: '/home/g' });
show('① register /home/g', a1);
const id1 = a1.json?.result?.id;
check('① ok + id + title + uncPath + alreadyExisted=false', a1.status === 200 && a1.json?.result?.ok === true && !!id1 && a1.json.result.alreadyExisted === false, JSON.stringify(a1.json?.result ?? a1.json));
check('① uncPath 形如 \\\\wsl.localhost\\<distro>\\home\\g', /^\\\\wsl\.localhost\\[^\\]+\\home\\g$/.test(a1.json?.result?.uncPath ?? ''), a1.json?.result?.uncPath);
check('① title 缺省 = 目录名 "g"', a1.json?.result?.title === 'g', String(a1.json?.result?.title));

console.log('\n########## ② 重复调用（必须复用、不新建）##########');
const a2 = await call('explorer.addWorkspace', { path: '/home/g' });
show('② register /home/g again', a2);
check('② alreadyExisted=true', a2.json?.result?.alreadyExisted === true, JSON.stringify(a2.json?.result));
check('② id 与首次相同', a2.json?.result?.id === id1, `${a2.json?.result?.id} vs ${id1}`);

console.log('\n########## ③ 不存在的路径 ⇒ 404 ##########');
const a3 = await call('explorer.addWorkspace', { path: '/home/g/definitely-not-here-t23' });
show('③ nonexistent', a3);
check('③ 404 E_NOTFOUND 且文案可读', a3.status === 404 && a3.json?.code === 'E_NOTFOUND', a3.json?.error?.slice(0, 120));

console.log('\n########## ④ 非法参数 ⇒ 400 且无副作用 ##########');
const bad = [
  ['空', { path: '' }],
  ['相对路径', { path: 'home/g' }],
  ['含 ..', { path: '/home/g/../g' }],
  ['反斜杠', { path: '\\home\\g' }],
  ['/mnt/c（Windows 卷）', { path: '/mnt/c/Users' }],
];
const idsBefore = JSON.stringify((await call('explorer.addWorkspace', { path: '/home/g' })).json?.result?.id);
for (const [label, args] of bad) {
  const r = await call('explorer.addWorkspace', args);
  show(`④ ${label}`, r);
  check(`④ ${label} ⇒ 400 E_ARG`, r.status === 400 && r.json?.code === 'E_ARG', String(r.json?.error ?? '').slice(0, 110));
}
const idsAfter = (await call('explorer.addWorkspace', { path: '/home/g' })).json?.result;
check('④ 无副作用（/home/g 仍是同一 id、仍 alreadyExisted）', idsAfter?.id === JSON.parse(idsBefore) && idsAfter?.alreadyExisted === true, JSON.stringify(idsAfter));

console.log('\n########## ⑥ 零副作用：调用前后 snapshot 的 daemon 段不变 ##########');
const s1 = (await call('explorer.snapshot', {})).json?.result?.daemon;
await call('explorer.addWorkspace', { path: '/home/g', title: 'T23-零副作用探测' });
const s2 = (await call('explorer.snapshot', {})).json?.result?.daemon;
console.log(`  before=${JSON.stringify(s1)}\n  after =${JSON.stringify(s2)}`);
check('⑥ daemon facts 不变', JSON.stringify(s1) === JSON.stringify(s2));

console.log(`\nSUMMARY: ${fails === 0 ? 'ALL PASS' : `${fails} FAILED`}`);
process.exit(fails === 0 ? 0 : 1);
