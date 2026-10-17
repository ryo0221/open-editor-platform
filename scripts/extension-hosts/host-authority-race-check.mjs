/* global host, sessionStorage */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';

const directory = path.resolve(process.argv[2]);
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'), 'utf8'));
  const server = createServer(async (request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1);
    if (!/^(geo-save|video-edit)\.(html|js)$/.test(name)) {
      response.writeHead(204).end();
      return;
    }
    response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const route of ['geo-save', 'video-edit']) {
      for (const width of [1280, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await context.route('**/*', (request) => {
          if (new URL(request.request().url()).origin !== origin) {
            errors.push(request.request().url());
            return request.abort();
          }
          return request.continue();
        });
        const prefix = route === 'geo-save' ? 'Geo' : 'Video';
        const state = () => page.evaluate('host.state()');
        const resume = () => page.evaluate(() => Object.entries(sessionStorage));
        const drained = async () => {
          const retired = await page.evaluate('host.retired()');
          assert.ok(retired.length >= 2, 'Both old and discarded staged scopes are tracked');
          for (const result of retired) {
            assert.equal(result.state, 'drained');
            assert.deepEqual(result.pending, []);
            assert.deepEqual(result.failed, []);
          }
        };
        try {
          await page.goto(`${origin}/${route}.html`);
          await page.waitForFunction('globalThis.ready');
          const before = await state();
          // Both calls start in one JS turn: open has staged next, then yields at old drain.
          const raced = await page.evaluate(async () => {
            const opening = host.open('editable');
            const revoking = host.revoke();
            return (await Promise.allSettled([opening, revoking])).map((r) => ({
              state: r.status,
              error: r.status === 'rejected' ? String(r.reason) : null,
            }));
          });
          assert.equal(raced[0].state, 'rejected');
          assert.ok(raced[0].error.includes(prefix + 'ReopenConflict'));
          assert.equal(raced[1].state, 'fulfilled');
          assert.equal((await state()).policy, 'readonly');
          assert.equal((await state()).view.state, 'revoked');
          assert.equal((await state()).hash, before.hash);
          assert.ok((await resume()).some(([, value]) => value === 'readonly'));
          await drained();
          await page.reload();
          await page.waitForFunction('globalThis.ready');
          assert.equal((await state()).policy, 'readonly');
          assert.equal((await state()).view.canEdit, false);
          assert.equal((await state()).view.canSave, false);

          // A new explicit authority action AFTER revoke keeps its existing semantics.
          const reversed = await page.evaluate(async () => {
            const revoking = host.revoke();
            const opening = host.open('editable');
            return (await Promise.allSettled([revoking, opening])).map((r) => r.status);
          });
          assert.deepEqual(reversed, ['fulfilled', 'fulfilled']);
          assert.equal((await state()).policy, 'editable');
          assert.equal((await state()).view.canEdit, true);
          assert.equal((await state()).view.canSave, true);
          assert.equal(
            (await resume()).some(([, value]) => value === 'readonly'),
            false,
          );

          const overlapping = await page.evaluate(async () => {
            const first = host.open('editable');
            const second = host.open('readonly');
            return (await Promise.allSettled([first, second])).map((r) => ({
              state: r.status,
              error: r.status === 'rejected' ? String(r.reason) : null,
            }));
          });
          assert.equal(overlapping[0].state, 'fulfilled');
          assert.ok(overlapping[1].error.includes(prefix + 'OpenBusy'));
          await page.evaluate('host.open("editable")');
          assert.equal((await state()).policy, 'editable');

          // A real Save paused before dispatch excludes open; revoke keeps bytes unchanged.
          const writes = (await state()).writes;
          const raw = await page.evaluate('host.raw()');
          await page.evaluate(() => {
            host.pauseBefore();
            globalThis.authorityPendingSave = host.save();
          });
          await expect.poll(async () => (await state()).view.saving).toBe(true);
          const pendingOpen = await page.evaluate(() =>
            host.open('editable').then(
              () => 'unexpected open',
              (error) => String(error),
            ),
          );
          assert.ok(pendingOpen.includes(prefix + 'SavePending'));
          await page.evaluate('host.revoke()');
          assert.equal((await state()).policy, 'readonly');
          await page.evaluate('host.releaseBefore()');
          await page.evaluate('globalThis.authorityPendingSave');
          assert.equal((await state()).writes, writes);
          assert.equal(await page.evaluate('host.raw()'), raw);
          assert.ok((await resume()).some(([, value]) => value === 'readonly'));
          await page.evaluate('host.open("editable")');

          const closing = await page.evaluate(async () => {
            const opening = host.open('editable');
            const closing = host.close();
            return (await Promise.allSettled([opening, closing])).map((r) => ({
              state: r.status,
              error: r.status === 'rejected' ? String(r.reason) : null,
            }));
          });
          assert.ok(closing[0].error.includes(prefix + 'ReopenConflict'));
          assert.equal(closing[1].state, 'fulfilled');
          assert.equal((await state()).view.state, 'revoked');
          await drained();

          // Read/hash suspension precedes staged open: authority must span BOTH awaits.
          for (const reader of ['reopen', 'reopenText']) {
            for (const interrupt of ['close', 'revoke']) {
              await page.evaluate('host.open("editable")');
              const saved = await page.evaluate('host.save()');
              assert.equal(saved.state, 'outcome');
              assert.equal(saved.outcome.state, 'committed');
              const beforeRead = await state();
              const savedText = await page.evaluate('host.raw()');
              const readRace = await page.evaluate(
                async ({ reader, interrupt, savedText }) => {
                  const reading =
                    reader === 'reopenText' ? host.reopenText(savedText) : host.reopen();
                  const interrupted = host[interrupt]();
                  return (await Promise.allSettled([reading, interrupted])).map((r) => ({
                    state: r.status,
                    error: r.status === 'rejected' ? String(r.reason) : null,
                  }));
                },
                { reader, interrupt, savedText },
              );
              assert.equal(readRace[0].state, 'rejected', `${reader}→${interrupt}`);
              assert.ok(readRace[0].error.includes(prefix + 'ReopenConflict'));
              assert.equal(readRace[1].state, 'fulfilled');
              const afterRead = await state();
              assert.equal(afterRead.view.state, 'revoked');
              assert.equal(afterRead.hash, beforeRead.hash);
              assert.deepEqual(afterRead.revision, beforeRead.revision);
              assert.equal(afterRead.writes, beforeRead.writes);
              assert.equal(await page.evaluate('host.raw()'), savedText);
              if (interrupt === 'revoke') {
                assert.equal(afterRead.policy, 'readonly');
                assert.ok((await resume()).some(([, value]) => value === 'readonly'));
              }
              await drained();
            }
          }
          assert.deepEqual(errors, []);
          console.log(
            'PASS',
            kind,
            route,
            width,
            pin.sourceCommit,
            'open→revoke / revoke→explicit open / overlapping+sequential open / pending Save refusal / old+staged drain / open→close / readonly reload / reopen+reopenText read→close+revoke',
          );
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
