/* serve.js —— task-7 的**本地夹具服务器**（端口 8983，属我自己的 8981–8990 段）。
 *
 * 为什么需要它：浏览器里的探针/仪表若要逐次 `evaluate_script` 内联全文（每份 9–19 KB），
 * 既贵又容易抄错。改为：把 `browser/*.js` 由本服务器按需提供，页面里只用**一行**同步 XHR 引导：
 *   (function(){var x=new XMLHttpRequest();x.open('GET','http://127.0.0.1:8983/browser/instrument.js',false);
 *    x.send();return eval(x.responseText);})()
 *
 * 只读地服务 `stability/**`（不写任何东西）；请求日志落 `out-03-serve.log` 作为取证。
 * 端口固定在 8983（我的段内），只监听 127.0.0.1。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE; // 只服务本目录及其子目录
const PORT = 8983;
const LOG = path.join(HERE, 'out-03-serve.log');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const log = (line) => {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()}\t${line}\n`);
  } catch {}
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  // 路径穿越防护：解析后必须仍在 ROOT 之内
  const abs = path.resolve(ROOT, rel);
  const origin = req.headers.origin || '-';
  // CORS 预检（S8：application/json 的 POST 会先发 OPTIONS；不答预检 ⇒ 页面侧 "Failed to fetch"）
  if (req.method === 'OPTIONS') {
    log(`204 OPTIONS ${url.pathname} origin=${origin}`);
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,accept',
      'access-control-max-age': '600'
    });
    return res.end();
  }
  if (!abs.startsWith(ROOT)) {
    log(`403 ${req.method} ${url.pathname} origin=${origin}`);
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  if (url.pathname === '/health') {
    log(`200 GET /health origin=${origin}`);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ ok: true, root: ROOT, pid: process.pid }));
  }
  // POST /collect  —— 浏览器把原始读数**直接落盘**（避免大 JSON 走工具调用内联）
  // body: { name: "out-10-cycle-samples", data: <任意 JSON> }
  if (req.method === 'POST' && url.pathname === '/collect') {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 8 * 1024 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) {
        log(`413 POST /collect origin=${origin}`);
        res.writeHead(413, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ ok: false, error: 'body > 8MB' }));
      }
      try {
        const payload = JSON.parse(body);
        const name = String(payload.name || 'unnamed').replace(/[^A-Za-z0-9._-]/g, '_');
        const outDir = path.join(ROOT, 'collect');
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, `${name}.json`);
        const wrapped = { receivedAt: new Date().toISOString(), name, data: payload.data };
        fs.writeFileSync(file, JSON.stringify(wrapped, null, 1));
        log(`200 POST /collect name=${name} bytes=${body.length} -> ${path.basename(file)}`);
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ ok: true, file: `collect/${name}.json`, bytes: body.length }));
      } catch (e) {
        log(`400 POST /collect origin=${origin} err=${e.message}`);
        res.writeHead(400, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        return res.end(JSON.stringify({ ok: false, error: String(e.message) }));
      }
    });
    return;
  }
  fs.readFile(abs, (err, buf) => {
    if (err) {
      log(`404 ${req.method} ${url.pathname} origin=${origin}`);
      res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      return res.end('not found');
    }
    log(`200 ${req.method} ${url.pathname} origin=${origin} bytes=${buf.length}`);
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    });
    res.end(buf);
  });
});
server.listen(PORT, '127.0.0.1', () => {
  log(`listening 127.0.0.1:${PORT} pid=${process.pid}`);
  console.log(`fixture server listening on http://127.0.0.1:${PORT}/ (pid=${process.pid})`);
});
