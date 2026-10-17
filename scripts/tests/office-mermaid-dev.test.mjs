import test from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { URL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { officeMermaidHtml } from '../dev/office-mermaid-html.mjs';

function get(port, url, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
        headers: { Host: 'localhost', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('restricted renderer preserves Vite guards and exact HTML without affecting normal routes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'office-mermaid-dev-test-'));
  // The production CSP/entry is the fixture: no weakened test-only HTML policy.
  const html = await readFile(
    new URL('../../apps/playground/office-mermaid.html', import.meta.url),
  );
  await writeFile(path.join(root, 'office-mermaid.html'), html);
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><html><head></head><body>normal</body></html>',
  );
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/office-mermaid.ts'), 'export {};');
  const config = {
    configFile: false,
    root,
    publicDir: false,
    logLevel: 'silent',
    cacheDir: path.join(root, '.vite'),

    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      allowedHosts: ['localhost'],
      cors: { origin: 'http://allowed.example' },
    },
  };
  const corsHeaders = (headers) =>
    Object.fromEntries(
      Object.entries(headers).filter(
        ([key]) => key.startsWith('access-control-') || key === 'vary',
      ),
    );
  const baselineCors = {};
  const baseline = await createServer({ ...config, plugins: [react()] });
  try {
    await new Promise((resolve, reject) => {
      baseline.httpServer.once('error', reject);
      baseline.httpServer.listen(0, '127.0.0.1', resolve);
    });
    const port = baseline.httpServer.address().port;
    for (const origin of ['http://allowed.example', 'http://denied.example'])
      baselineCors[origin] = corsHeaders(
        (await get(port, '/office-mermaid.html', 'GET', { Origin: origin })).headers,
      );
    assert.equal(
      (
        await get(port, '/office-mermaid.html', 'GET', {
          Host: 'blocked.invalid',
        })
      ).status,
      403,
    );
  } finally {
    await baseline.close();
  }
  const server = await createServer({
    ...config,
    plugins: [react(), officeMermaidHtml()],
  });
  try {
    // Node listen(0), rather than Vite's default-port fallback, reserves a fresh OS port.
    await new Promise((resolve, reject) => {
      server.httpServer.once('error', reject);
      server.httpServer.listen(0, '127.0.0.1', resolve);
    });
    const port = server.httpServer.address().port;
    await t.test('GET, query and HEAD preserve bytes/CSP and disable caching', async () => {
      for (const url of ['/office-mermaid.html', '/office-mermaid.html?probe=1']) {
        const res = await get(port, url);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, html);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.match(res.headers['content-type'], /^text\/html/);
        assert.equal(Number(res.headers['content-length']), html.byteLength);
        assert.ok(!res.body.toString().includes('/@vite/client'));
        assert.ok(!res.body.toString().includes('/@react-refresh'));
      }
      const head = await get(port, '/office-mermaid.html', 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(Number(head.headers['content-length']), html.byteLength);
    });
    await t.test(
      'Vite rejects denied Host and invalid request before renderer handler',
      async () => {
        for (const url of ['/office-mermaid.html', '/']) {
          const res = await get(port, url, 'GET', { Host: 'blocked.invalid' });
          assert.equal(res.status, 403);
          assert.match(res.body.toString(), /Blocked request/);
        }
        assert.equal((await get(port, '/office-mermaid.html#invalid')).status, 400);
      },
    );
    await t.test('CORS middleware and normal development injection remain active', async () => {
      const allowed = await get(port, '/office-mermaid.html', 'GET', {
        Origin: 'http://allowed.example',
      });
      assert.equal(allowed.headers['access-control-allow-origin'], 'http://allowed.example');
      for (const origin of Object.keys(baselineCors)) {
        const response = await get(port, '/office-mermaid.html', 'GET', {
          Origin: origin,
        });
        assert.deepEqual(corsHeaders(response.headers), baselineCors[origin]);
      }
      const main = await get(port, '/');
      assert.equal(main.status, 200);
      assert.match(main.body.toString(), /\/@vite\/client/);
      assert.match(main.body.toString(), /\/@react-refresh/);
    });
    await t.test(
      'other methods and encoded/traversal/alias paths do not hit the raw handler',
      async () => {
        const post = await get(port, '/office-mermaid.html', 'POST');
        assert.equal(post.status, 200); // Existing Vite index HTML behavior; handler falls through.
        assert.match(post.body.toString(), /\/@vite\/client/);
        assert.notEqual(post.headers['cache-control'], 'no-store');
        for (const url of [
          '/%6fffice-mermaid.html',
          '/x/../office-mermaid.html',
          '/office-mermaid',
          '/office-mermaid.html/',
          '/other.html',
        ]) {
          const res = await get(port, url);
          assert.notEqual(res.headers['cache-control'], 'no-store', url);
          assert.notDeepEqual(res.body, html, url);
        }
      },
    );
    await t.test('read errors are bounded and do not fall through to HTML injection', async () => {
      await rename(path.join(root, 'office-mermaid.html'), path.join(root, 'held.html'));
      const res = await get(port, '/office-mermaid.html');
      assert.equal(res.status, 500);
      assert.equal(res.body.toString(), 'Office renderer HTML unavailable');
      assert.equal(res.headers['cache-control'], 'no-store');
      const head = await get(port, '/office-mermaid.html', 'HEAD');
      assert.equal(head.status, 500);
      assert.equal(head.body.length, 0);
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
