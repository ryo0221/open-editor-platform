import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import console from 'node:console';
const root = fileURLToPath(new URL('../work/issue-29/independent-host/dist/', import.meta.url));
createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ready');
    return;
  }
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== path.resolve(root) && !file.startsWith(root)) throw new Error('Invalid path');
    if (!path.extname(file)) file = path.join(root, 'index.html');
    const bytes = await readFile(file);
    res.writeHead(200, {
      'Content-Type':
        { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[
          path.extname(file)
        ] ?? 'application/octet-stream',
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end('Missing output');
  }
}).listen(4176, '127.0.0.1', () =>
  console.log('Design generated reference Host ready at http://127.0.0.1:4176'),
);
