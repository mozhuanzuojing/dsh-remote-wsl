// build.ts — P3 单包 TS：① 从 src/client/index.ts 打一个 lib/client.js（内联全部 chunk）
//                ② 把 host 半（src/ 除 client）转译成 lib/*.js（npm 分发形态；见 tsconfig.build.json）
//
// 为什么 ② 必须存在（2026-11-24 实测）：Node 的类型擦除**拒绝 `node_modules` 里的 `.ts`**
// （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。插件源码里 `main` 指着 `src/index.ts` 时，
// `link:` 安装能跑（文件在工作树里），但一旦从 npm 装、文件落进 `node_modules/`，宿主半与守护半
// 双双拒绝加载。转译产物是唯一能让两种安装形态都成立的路径。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const root = dirname(fileURLToPath(import.meta.url))
const id = process.env.RW_CLIENT_ID || 'dsh-remote-wsl'
mkdirSync(resolve(root, 'lib'), { recursive: true })

// ② host 半转译（tsc --noCheck + rewriteRelativeImportExtensions：只转译、并把 ./x.ts 改写成 ./x.js）
const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
if (existsSync(tsc)) {
  const r = spawnSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.build.json')], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`tsc -p tsconfig.build.json 失败（exit=${r.status}）—— 不发布半成品`)
    process.exit(r.status ?? 1)
  }
  console.log('transpiled host half -> lib/*.js')
} else {
  console.error('跳过 host 半转译：找不到 node_modules/typescript（先 pnpm install）')
  process.exit(1)
}

// ① 浏览器侧单包（内联全部 chunk）
await build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  outfile: resolve(root, 'lib/client.js'),
  bundle: true, format: 'cjs', platform: 'browser', target: ['es2022'], jsx: 'automatic', sourcemap: false, minify: true,
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler', '@deepseek-ai/*'],
  banner: { js: `window.__ModuleLoader__.load({ id: '${id}', factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
  legalComments: 'none', logLevel: 'info',
})
console.log('built single bundle lib/client.js (id=' + id + ')')
