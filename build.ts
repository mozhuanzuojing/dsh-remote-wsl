// build.ts.mjs — P3 单包 TS：从 src/client/index.ts 打一个 lib/client.js（内联全部 chunk）
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const root = dirname(fileURLToPath(import.meta.url))
const id = process.env.RW_CLIENT_ID || 'dsh-remote-wsl'
mkdirSync(resolve(root, 'lib'), { recursive: true })
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
