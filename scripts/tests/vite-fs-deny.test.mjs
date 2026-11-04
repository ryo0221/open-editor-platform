/* global fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

test('Vite denies protected files even through raw/import/url query transforms', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vite-deny-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = 'synthetic-denied-fixture';
  for (const file of ['.env', 'secret.crt']) await writeFile(join(root, file), marker);
  await writeFile(join(root, 'allowed.txt'), 'public fixture');
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  });
  t.after(() => server.close());
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  assert.equal(await (await fetch(`${origin}/allowed.txt`)).text(), 'public fixture');
  for (const file of ['.env', 'secret.crt']) {
    for (const query of ['', '?raw', '?import&raw', '?import&url&inline']) {
      const response = await fetch(`${origin}/${file}${query}`);
      assert.equal(response.status, 403, `${file}${query}`);
      assert.equal((await response.text()).includes(marker), false);
    }
  }
});
