/* serve-t42.ts —— T42 临时静态服务器（端口 **8925**，本任务段 8921–8930 内）。
 *
 * 只为把 measure-t42.js 交给页面（免得每次 evaluate 内联 5 KB 脚本）：只读服务本目录，CORS `*`，
 * 收工即停、目录不留残留。不属于交付物。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8925;
const MIME = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  const abs = path.resolve(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  if (!abs.startsWith(ROOT)) { res.writeHead(403, { 'access-control-allow-origin': '*' }); return res.end('forbidden'); }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'access-control-allow-origin': '*' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`t42 static server on ${PORT} (pid=${process.pid})`));
