// Local development/test preview only. This is not a server the Android app needs.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
const root = path.resolve('dist');
const portText = process.env.SHIYU_PREVIEW_PORT ?? '18081';
const previewPort = Number(portText);
if (!/^\d+$/.test(portText) || !Number.isSafeInteger(previewPort) || previewPort < 1 || previewPort > 65535) {
  throw new Error('SHIYU_PREVIEW_PORT must be an integer from 1 to 65535.');
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  let file = path.resolve(root, `.${url}`);
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(previewPort, '127.0.0.1', () => process.stdout.write(`Preview: http://127.0.0.1:${previewPort}\n`));
