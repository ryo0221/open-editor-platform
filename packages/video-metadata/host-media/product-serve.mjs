import { URL } from 'node:url';
import { productBuild } from './product-build.mjs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import process from 'node:process';
import console from 'node:console';
const deps = process.argv[2],
  port = Number(process.argv[3] ?? 4178);
if (!deps || !Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error('Usage: product-serve.mjs fixed-external-deps-directory [local-port]');
const bundle = await productBuild(deps),
  html = await readFile(new URL('./browser-host.html', import.meta.url));
const server = createServer((request, response) => {
  if (request.method !== 'GET' || !['/', '/host.js', '/favicon.ico'].includes(request.url)) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (request.url === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  response.setHeader(
    'content-type',
    request.url === '/host.js' ? 'application/javascript' : 'text/html',
  );
  response.end(request.url === '/host.js' ? bundle.outputFiles[0].text : html);
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Private Video candidate: http://127.0.0.1:${port}`),
);
