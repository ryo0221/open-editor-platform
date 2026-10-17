/* global document */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2]),
  media = path.resolve(process.argv[3]),
  evidence = path.resolve(process.argv[4]);
await mkdir(evidence, { recursive: true });
const recoveryFailures = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['media-demo.html', 'media-demo.js'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        ...(kind === 'reference'
          ? { recordVideo: { dir: evidence, size: { width, height: 900 } } }
          : {}),
      });
      const page = await context.newPage(),
        errors = [];
      const origin = `http://127.0.0.1:${server.address().port}`;
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.route('**/*', (r) => {
        if (new URL(r.request().url()).origin !== origin) {
          errors.push(r.request().url());
          return r.abort();
        }
        return r.continue();
      });
      try {
        await page.goto(origin + '/media-demo.html');
        await page.waitForFunction('globalThis.ready');
        const state = () => page.evaluate('mediaHost.state()'),
          button = (name) => page.getByRole('button', { name, exact: true }),
          input = (name) => page.getByLabel(name, { exact: true });
        const content = async () => (await state()).view.snapshot.content,
          revision = async () => (await state()).view.snapshot.revision.sequence;
        await input('Animation and GIS recordings').setInputFiles(
          ['animation', 'geo'].map((d) =>
            path.join(media, `editor-platform-${d}-reference-b18369f2.mp4`),
          ),
        );
        const focusLog = [],
          steps = [];
        const tabTo = async (target, label) => {
          for (let i = 0; i < 100; i++) {
            if (await target.evaluate((el) => el === document.activeElement)) {
              const rect = await target.boundingBox();
              assert.ok(
                rect &&
                  rect.x >= 0 &&
                  rect.x + rect.width <= width + 1 &&
                  rect.y >= 0 &&
                  rect.y + rect.height <= 901,
                `Focused control outside viewport: ${label}`,
              );
              focusLog.push({ label, rect });
              return;
            }
            await page.keyboard.press('Tab');
          }
          throw Error(`Keyboard target unreachable: ${label}`);
        };
        const press = async (label, key = 'Enter') => {
          await tabTo(button(label), label);
          await page.keyboard.press(key);
        };
        const type = async (label, value) => {
          await tabTo(input(label), label);
          await page.keyboard.press('Control+A');
          await page.keyboard.type(value);
        };
        const remember = async (label) => steps.push({ label, state: await state() });
        await press('Load recordings');
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(0);
        await type('Preview sequence frame', '700');
        await press('Seek preview', 'Space');
        await expect.poll(async () => (await state()).lastFrame?.sourceId).toBe('recording-geo');
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(0.16);
        await tabTo(input('Selected clip'), 'Selected clip');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await expect(input('Selected clip')).toHaveValue('clip-recording-geo');
        await press('Delete linked clips', 'Space');
        assert.equal((await content()).sequence.clips.length, 1);
        await remember('Keyboard removed GIS after checking actual preview');
        const beforeTrim = await content();
        await type('Trim end (rational seconds)', '8');
        await expect(input('Sequence duration (rational seconds)')).toBeDisabled();
        await expect(button('Apply sequence duration')).toBeDisabled();
        await press('Cancel inputs', 'Space');
        assert.deepEqual(await content(), beforeTrim);
        assert.equal((await state()).inputs.dirty, 0);
        await type('Trim end (rational seconds)', '8');
        await press('Apply independent trim');
        assert.deepEqual((await content()).sequence.clips[0].duration, { value: 8, timescale: 1 });
        await type('Split at sequence frame', '100');
        await press('Split linked clips', 'Space');
        assert.equal((await content()).sequence.clips.length, 2);
        const split = await content();
        await tabTo(input('Selected clip'), 'Selected clip');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await tabTo(button('Move selected clip'), 'Move selected clip');
        await page.keyboard.press('ArrowRight');
        const moved = await content();
        assert.notDeepEqual(moved, split);
        assert.deepEqual(moved.sequence.clips[1].start, { value: 101, timescale: 25 });
        await page.keyboard.press('Control+z');
        assert.deepEqual(await content(), split);
        await page.keyboard.press('Control+Shift+z');
        assert.deepEqual(await content(), moved);
        await page.keyboard.press('Control+z');
        assert.deepEqual(await content(), split);
        await remember('Arrow move then keyboard Undo Redo Undo');
        const beforeDuration = await content(),
          durationRevision = await revision();
        await type('Sequence duration (rational seconds)', '3');
        await expect(input('Trim start (rational seconds)')).toBeDisabled();
        await expect(input('Trim end (rational seconds)')).toBeDisabled();
        await expect(button('Apply independent trim')).toBeDisabled();
        await press('Apply sequence duration');
        assert.deepEqual(await content(), beforeDuration);
        assert.equal(await revision(), durationRevision);
        assert.equal((await state()).inputs.dirty, 1);
        const durationError = await page
          .getByLabel('Video metadata timeline', { exact: true })
          .getByRole('status')
          .innerText();
        assert.match(durationError, /Clip exceeds sequence/);
        await remember('Invalid duration refuses without losing draft');
        await type('Sequence duration (rational seconds)', '8');
        await press('Apply sequence duration', 'Space');
        assert.deepEqual((await content()).sequence.duration, { value: 8, timescale: 1 });
        assert.equal(await revision(), durationRevision + 1);
        assert.equal((await state()).inputs.dirty, 0);
        const final = await content();
        await type('Sequence duration (rational seconds)', '7');
        await press('Apply sequence duration');
        await press('Cancel inputs');
        assert.deepEqual(await content(), final);
        await expect(input('Sequence duration (rational seconds)')).toHaveValue('8/1');
        assert.equal((await state()).inputs.dirty, 0);
        const cancelledStatus = await page
          .getByLabel('Video metadata timeline', { exact: true })
          .getByRole('status')
          .innerText();
        if (cancelledStatus.includes('OperationFailed'))
          recoveryFailures.push({ kind, width, cancelledStatus });
        await remember('Invalid duration Cancel restores accepted 8 seconds');
        await type('Preview sequence frame', '199');
        await press('Seek preview');
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(7.96);
        await type('Preview sequence frame', '0');
        await press('Seek preview');
        await expect.poll(async () => (await state()).lastFrame?.decodedSeconds).toBe(0);
        await press('Play preview', 'Space');
        await expect.poll(async () => (await state()).playing).toBe(true);
        await press('Pause preview');
        assert.equal((await state()).playing, false);
        assert.deepEqual(await content(), final);
        assert.equal((await state()).view.canSave, false);
        await expect(button('Save native JSON')).toBeDisabled();
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}.png`),
          fullPage: true,
        });
        const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json'), 'utf8'));
        await writeFile(
          path.join(evidence, `${kind}-${width}.json`),
          JSON.stringify(
            {
              sourceCommit: pin.sourceCommit,
              method:
                'Keyboard only after setInputFiles setup; Tab/Enter/Space/Arrow/End/Ctrl shortcuts; no click, fill, focus or selectOption',
              final,
              durationError,
              cancelledStatus,
              focusLog,
              steps,
              errors,
            },
            null,
            2,
          ),
        );
        await page.evaluate('mediaHost.revoke()');
        const closed = await state();
        assert.equal(closed.pool.urlsCreated, closed.pool.urlsReleased);
        assert.deepEqual(errors, []);
        console.log(
          'PASS native/focus/main operations',
          kind,
          width,
          'keyboard-only / narrow reachable focus / trim split move / duration refusal repair Cancel / UndoRedo / actual preview',
        );
      } catch (error) {
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-failure.png`),
          fullPage: true,
        });
        await writeFile(
          path.join(evidence, `${kind}-${width}-failure.json`),
          JSON.stringify(
            { error: String(error), state: await page.evaluate('mediaHost.state()'), errors },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        const video = page.video();
        await context.close();
        if (video) await video.saveAs(path.join(evidence, `${kind}-${width}.webm`));
      }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

assert.deepEqual(recoveryFailures, [], 'Cancel must clear the resolved duration error status');
