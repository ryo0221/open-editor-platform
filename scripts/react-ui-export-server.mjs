import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';

// Verification-only server. Build fixed, independent React apps before announcing readiness.
const repo = fileURLToPath(new URL('../', import.meta.url));
const screens = ['unbound', 'product', 'form', 'revised'];
for (const screen of screens) {
  const result = spawnSync(process.execPath, ['scripts/react-ui-export-host.mjs', screen], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const mediaTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};
const server = createServer(async (request, response) => {
  try {
    const segments = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      .split('/')
      .filter(Boolean);
    const screen = screens.includes(segments[0]) ? segments.shift() : 'unbound';
    const root = path.join(repo, 'work/issue-24/export-host', screen, 'dist');
    const file = path.resolve(root, segments.length ? segments.join('/') : 'index.html');
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    const bytes = await readFile(file);
    response.writeHead(200, {
      'Content-Type': mediaTypes[path.extname(file)] ?? 'application/octet-stream',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
server.listen(4175, '127.0.0.1', () =>
  console.log('Independent React apps: http://127.0.0.1:4175/{product,form,revised}/'),
);
