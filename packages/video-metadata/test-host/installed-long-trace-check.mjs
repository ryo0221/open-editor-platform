/* global document, innerWidth */
import { chromium, expect } from '@playwright/test';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = process.argv[2];
let failed = 0;
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind, 'dist');
  const server = createServer(async (req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['video-edit.html', 'video-edit.js'].includes(file)) return res.writeHead(204).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, file)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390])
      for (const seed of [75, 142]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const trace = [],
          errors = [],
          focusFailures = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        let rng = seed;
        const next = () => (rng = (Math.imul(1664525, rng) + 1013904223) >>> 0);
        const splitFrame = 45 + (next() % 11),
          zoom = 80 + (next() % 3) * 40;
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}/video-edit.html`);
          await page.waitForFunction('globalThis.ready');
          const button = (name) => page.getByRole('button', { name, exact: true });
          const state = () => page.evaluate('host.state()');
          const record = async (action) => {
            const s = await state();
            trace.push({
              step: trace.length + 1,
              action,
              hash: s.hash,
              sequence: s.revision.sequence,
              canUndo: s.canUndo,
              canRedo: s.canRedo,
              dirty: s.inputs.dirty,
              focus: await page.evaluate(
                () =>
                  document.activeElement?.getAttribute('aria-label') ||
                  document.activeElement?.textContent?.slice(0, 80),
              ),
            });
          };
          const invariant = async (before) => {
            const now = await state();
            assert.deepEqual(now.content, before.content);
            assert.deepEqual(now.revision, before.revision);
            assert.equal(now.canUndo, before.canUndo);
            assert.equal(now.canRedo, before.canRedo);
          };
          let current = (await state()).content;
          const undo = [],
            redo = [];
          let edits = 0;
          const op = async (name, action) => {
            const before = await state();
            await action();
            const after = await state();
            assert.equal(after.revision.sequence, before.revision.sequence + 1, name);
            if (name === 'Undo') {
              redo.push(current);
              current = undo.pop();
            } else if (name === 'Redo') {
              undo.push(current);
              current = redo.pop();
            } else {
              undo.push(current);
              redo.length = 0;
              current = after.content;
            }
            assert.deepEqual(after.content, current, name);
            assert.equal(after.canUndo, undo.length > 0);
            assert.equal(after.canRedo, redo.length > 0);
            edits++;
            await record(name);
          };
          const click = (name) => op(name, () => button(name).click());
          const key = (control, key) =>
            op(control + ':' + key, async () => {
              await button(control).focus();
              await page.keyboard.press(key);
              await expect(button(control)).toBeFocused();
            });
          const select = (id) => page.getByLabel('Selected clip', { exact: true }).selectOption(id);
          await click('Move +1 frame');
          await click('Move −1 frame');
          await key('Trim selected start', 'ArrowRight');
          await key('Trim selected end', 'ArrowLeft');
          await click('Undo');
          // Invalid pending input and Save refusal must preserve the redo branch.
          let before = await state();
          const input = page.getByLabel('Trim start (rational seconds)', { exact: true });
          await input.fill('not-a-time');
          await button('Save native JSON').click();
          await expect.poll(async () => (await state()).view.saving).toBe(false);
          await invariant(before);
          assert.equal((await state()).writes, before.writes);
          assert.equal(await input.inputValue(), 'not-a-time');
          await button('Undo').click();
          await invariant(before);
          await button('Cancel inputs').click();
          await invariant(before);
          await record('invalid input / Save refused / Undo refused / cancel');
          await click('Redo');
          await page
            .getByLabel('Split at sequence frame', { exact: true })
            .fill(String(splitFrame));
          await click('Split linked clips');
          await select('clip-1');
          await click('Delete linked clips');
          await click('Undo');
          await click('Redo');
          // Adapter-proven no-write result, then normal Save recovery later.
          before = await state();
          await page.evaluate("host.mode('no-write')");
          await button('Save native JSON').click();
          await expect
            .poll(async () => (await state()).view.lastSave?.state)
            .toBe('aborted-before-write');
          await invariant(before);
          assert.equal((await state()).writes, before.writes);
          await page.evaluate("host.mode('normal')");
          await record('adapter no-write Save refusal');
          await click('Undo');
          await select('v');
          await key('Trim selected end', 'ArrowLeft');
          await click('Undo');
          before = await state();
          await page.getByLabel('Timeline zoom', { exact: true }).fill(String(zoom));
          const control = button('Trim selected end');
          await control.scrollIntoViewIfNeeded();
          const box = await control.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 - zoom / 25, box.y + box.height / 2);
          await page.keyboard.press('Escape');
          await page.mouse.up();
          await invariant(before);
          assert.equal((await state()).inputs.dirty, 0);
          if (!(await control.evaluate((el) => el === document.activeElement)))
            focusFailures.push('Escape lost fixed trim control focus');
          await record('fixed trim drag Escape / redo preserved / focus');
          await click('Redo');
          await click('Undo');
          await select('clip-1');
          await key('Move selected clip', 'ArrowRight');
          await click('Undo');
          await click('Redo');
          await click('Undo');
          await click('Redo');
          assert.equal(edits, 20);
          const final = await state();
          await button('Save native JSON').click();
          await expect.poll(async () => (await state()).view.lastSave?.state).toBe('committed');
          await invariant(final);
          assert.deepEqual(
            JSON.parse(await page.evaluate('host.raw()')).request.content,
            final.content,
          );
          await record('Save after20 history operations');
          // Revocation closes a scope. Reopen intentionally starts a fresh readonly history.
          await page.evaluate('host.revoke()');
          assert.deepEqual((await state()).content, final.content);
          assert.equal((await page.evaluate('host.move(1)')).state, 'refused');
          await button('Reopen saved').click();
          await expect.poll(async () => (await state()).view.state).toBe('open');
          assert.deepEqual((await state()).content, final.content);
          assert.equal((await state()).policy, 'readonly');
          assert.equal((await state()).canUndo, false);
          for (const name of ['Move selected clip', 'Trim selected start', 'Trim selected end'])
            await expect(button(name)).toBeDisabled();
          before = await state();
          await button('Move selected clip').dispatchEvent('keydown', { key: 'ArrowRight' });
          await invariant(before);
          await record('revoked / reopened readonly / fresh history / denied input');
          await page.reload();
          await page.waitForFunction('globalThis.ready');
          assert.deepEqual((await state()).content, final.content);
          assert.equal((await state()).policy, 'readonly');
          // Existing test Host authorization grants a fresh editing scope with saved content.
          await page.evaluate(async () =>
            globalThis.host.open('editable', (await globalThis.host.state()).content),
          );
          await button('Move selected clip').focus();
          await page.keyboard.press('ArrowRight');
          await button('Undo').click();
          assert.deepEqual((await state()).content, final.content);
          await button('Save native JSON').click();
          await expect.poll(async () => (await state()).view.lastSave?.state).toBe('committed');
          await page.reload();
          await page.waitForFunction('globalThis.ready');
          assert.deepEqual((await state()).content, final.content);
          assert.equal((await state()).revision.sequence, 0);
          await record('authorized fresh scope / edit Undo / Save / reload native equality');
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(focusFailures, []);
          console.log(
            'PASS',
            kind,
            width,
            seed,
            '20 history operations + refusals/recovery/native reload',
          );
        } catch (e) {
          failed++;
          trace.push({ failure: String(e) });
          console.log('FAIL', kind, width, seed, String(e));
        } finally {
          await writeFile(
            `/tmp/video-long-${kind}-${width}-${seed}.json`,
            JSON.stringify({ seed, splitFrame, zoom, trace }, null, 2),
          );
          await page.close();
        }
      }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
console.log(JSON.stringify({ passed: 8 - failed, failed }));
process.exitCode = failed ? 1 : 0;
