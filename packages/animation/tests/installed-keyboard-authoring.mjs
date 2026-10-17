/* global document, innerHeight, innerWidth */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { URL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
const directory = path.resolve(process.argv[2]);
const evidence = await mkdtemp(path.join(tmpdir(), 'animation-keyboard-'));
console.log('Evidence:', evidence);
const reports = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  const pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
  const server = createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const name = route === '/' ? 'animation.html' : route.slice(1);
    if (!['animation.html', 'animation.js', 'animation.css'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(await readFile(path.join(root, 'dist', name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const width of [1280, 390]) {
      const recording = kind === 'reference' && width === 390;
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        ...(recording
          ? { recordVideo: { dir: path.join(evidence, 'raw'), size: { width, height: 844 } } }
          : {}),
      });
      const errors = [],
        focusChecks = [],
        videos = [];
      context.on('page', (p) => {
        if (recording) videos.push(p.video());
        p.on('pageerror', (e) => errors.push(String(e)));
        p.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
      });
      let page = await context.newPage();
      const button = (name) => page.getByRole('button', { name, exact: true });
      const field = (name) => page.getByLabel(name, { exact: true });
      const inspect = () => page.evaluate('host.inspect()');
      const visibleFocus = async (target, label) => {
        await expect(target).toBeFocused();
        const box = await target.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            visible:
              r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
            focusVisible: element.matches(':focus-visible'),
          };
        });
        assert.ok(box.visible, `focused ${label} must fit the viewport: ${JSON.stringify(box)}`);
        assert.ok(box.focusVisible, `${label} must be keyboard focus-visible`);
        focusChecks.push({ label, ...box });
      };
      // Selectors identify the target only. All focus movement is actual Tab/Shift+Tab.
      const reach = async (target, label, reverse = false) => {
        for (let steps = 0; steps < 120; steps++) {
          if (await target.evaluate((element) => element === document.activeElement)) {
            await visibleFocus(target, label);
            return;
          }
          await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
        }
        throw Error(`Keyboard could not reach ${label}`);
      };
      const activate = async (name, key = 'Enter') => {
        await reach(button(name), name);
        await page.keyboard.press(key);
      };
      const type = async (name, value, reverse = false) => {
        await reach(field(name), name, reverse);
        await page.keyboard.press('Control+A');
        await page.keyboard.type(value);
      };
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}/animation.html`);
        await page.waitForFunction('globalThis.ready');
        const original = (await inspect()).view.snapshot;
        const popup = context.waitForEvent('page');
        await activate('New empty Animation');
        const previous = page;
        page = await popup;
        await page.waitForFunction('globalThis.ready');
        assert.deepEqual((await inspect()).view.snapshot.content.compositions[0].layers, []);
        assert.equal(await page.evaluate('window.opener'), null);
        await activate('Add rectangle', 'Space');
        const created = (await inspect()).view.snapshot.content.compositions[0].layers[0].id;
        const beforeInvalid = (await inspect()).view.snapshot;
        await type('Base y', '-');
        await expect(button('New empty Animation')).toBeDisabled();
        await activate('Save through Host');
        await expect(field('Base y')).toHaveAttribute('aria-invalid', 'true');
        await visibleFocus(field('Base y'), 'invalid Base y recovery');
        assert.deepEqual((await inspect()).view.snapshot, beforeInvalid);
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-invalid-focus.png`),
          fullPage: true,
        });
        await type('Base y', '160');
        await activate('Apply inputs');
        assert.equal(
          (await inspect()).view.snapshot.revision.sequence,
          beforeInvalid.revision.sequence + 1,
        );
        await type('Base x', '90', true);
        await activate('Cancel inputs');
        assert.equal(
          (await inspect()).view.snapshot.content.compositions[0].layers[0].transform.x,
          80,
        );
        await activate('Add key at playhead (base value)');
        await expect(field('Key tick')).toHaveValue('0');
        await reach(field('Seek'), 'Seek');
        await page.keyboard.press('End');
        assert.equal((await inspect()).playback.tick, 960000);
        await activate('Add key at playhead (base value)');
        await type('Key value', '400');
        await activate('Apply inputs');
        await reach(button('960000 ticks · 400'), 'last key');
        await page.keyboard.press('Shift+ArrowLeft');
        const moving = (await inspect()).view.snapshot;
        await page.keyboard.press('Enter');
        assert.equal(
          (await inspect()).view.snapshot.revision.sequence,
          moving.revision.sequence + 1,
        );
        assert.equal(
          (await inspect()).view.snapshot.content.compositions[0].tracks[0].keys[1].tick,
          952000,
        );
        const authored = (await inspect()).view.snapshot.content;
        await activate('Undo');
        assert.equal(
          (await inspect()).view.snapshot.content.compositions[0].tracks[0].keys[1].tick,
          960000,
        );
        await activate('Redo');
        assert.deepEqual((await inspect()).view.snapshot.content, authored);
        await reach(field('Seek'), 'Seek before playback');
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowRight');
        assert.equal((await inspect()).playback.tick, 1);
        await activate('Play', 'Space');
        await expect.poll(async () => (await inspect()).playback.tick).toBeGreaterThan(1);
        await activate('Pause', 'Space');
        assert.deepEqual((await inspect()).view.snapshot.content, authored);
        const beforeSave = (await inspect()).view.snapshot;
        await activate('Save through Host');
        await expect(page.getByRole('status')).toHaveText('Save: committed');
        assert.deepEqual((await inspect()).view.snapshot.revision, beforeSave.revision);
        await activate('Reopen saved Animation');
        await page.waitForFunction('globalThis.ready');
        const resumed = (await inspect()).view.snapshot;
        assert.deepEqual(resumed.content, authored);
        assert.equal(resumed.revision.sequence, 0);
        assert.notEqual(resumed.scope.sessionId, beforeSave.scope.sessionId);
        await reach(button(`rect ${created}`), 'reopened layer');
        await page.keyboard.press('Enter');
        assert.deepEqual((await previous.evaluate('host.inspect()')).view.snapshot, original);
        assert.deepEqual(errors, []);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-reopened.png`),
          fullPage: true,
        });
        const video = recording ? page.video() : null;
        await context.close();
        const videoPath = recording
          ? path.join(evidence, 'reference-390-keyboard-new-ui.webm')
          : null;
        if (video) {
          await video.saveAs(videoPath);
          for (const raw of videos) await raw.delete();
        }
        reports.push({
          kind,
          width,
          result: 'PASS',
          sourceCommit: pins.sourceCommit,
          animationSha256: pins.packages['@editor-platform/animation'],
          videoPath,
          focusChecks,
          inputMethods: [
            'Tab',
            'Shift+Tab',
            'Enter',
            'Space',
            'Home',
            'End',
            'ArrowRight',
            'Shift+ArrowLeft',
            'Control+A',
            'keyboard.type',
          ],
          programmaticFocus: false,
          mouse: false,
          osIme: 'NOT RUN',
        });
        console.log('PASS', kind, width, focusChecks.length, 'visible keyboard focus checks');
      } catch (error) {
        await page.screenshot({
          path: path.join(evidence, `${kind}-${width}-failure.png`),
          fullPage: true,
        });
        await writeFile(
          path.join(evidence, `${kind}-${width}-failure.json`),
          JSON.stringify({ error: String(error), focusChecks }, null, 2),
        );
        await context.close();
        throw error;
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
await writeFile(path.join(evidence, 'results.json'), JSON.stringify(reports, null, 2));
