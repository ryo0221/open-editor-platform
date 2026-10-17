/* global document, window */
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { createHash } from 'node:crypto';
const output = path.resolve(process.argv[3] ?? '/tmp/animation-long-trace');
await mkdir(output, { recursive: true });
const directory = path.resolve(process.argv[2]),
  reports = [],
  hashes = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind),
    pins = JSON.parse(await readFile(path.join(root, 'editor-pin.json'))).packages;
  hashes.push(pins['@editor-platform/animation']);
  const server = createServer(async (req, res) => {
    const name =
      req.url === '/'
        ? 'animation.html'
        : req.url === '/animation.js'
          ? 'animation.js'
          : req.url === '/animation.css'
            ? 'animation.css'
            : undefined;
    if (!name) {
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
    for (const width of [1280, 390])
      for (const layout of ['page', 'ancestor']) {
        const page = await browser.newPage({ viewport: { width, height: 844 } }),
          errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction('globalThis.ready');
        await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
        await expect(page.locator('.ae-key-marker').first()).toHaveCSS('position', 'absolute');
        assert.equal(await page.locator('code').textContent(), pins['@editor-platform/animation']);
        const inspect = () => page.evaluate('host.inspect()');
        const trace = [],
          ids = new Map();
        const normalize = (value) =>
          JSON.parse(
            JSON.stringify(value, (_, v) => {
              if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) {
                if (!ids.has(v)) ids.set(v, `created-${ids.size + 1}`);
                return ids.get(v);
              }
              return v;
            }),
          );
        const record = async (action, revision) => {
          const state = await inspect();
          assert.equal(state.view.snapshot.revision.sequence, revision, action);
          trace.push({
            action,
            revision,
            contentHash: createHash('sha256')
              .update(JSON.stringify(normalize(state.view.snapshot.content)))
              .digest('hex'),
          });
        };
        const button = (name) => page.getByRole('button', { name, exact: true });
        const field = (name) => page.getByLabel(name, { exact: true });
        const scrollState = () =>
          page.evaluate(() => ({
            page: window.scrollY,
            pageX: window.scrollX,
            ancestor: document.querySelector('#qa-scroll-ancestor')?.scrollTop ?? 0,
            ancestorX: document.querySelector('#qa-scroll-ancestor')?.scrollLeft ?? 0,
          }));
        const assertVisible = async (locator) => {
          const k = await locator.boundingBox(),
            r = await field('Scrollable timeline').boundingBox();
          assert.ok(
            k && r && k.x >= r.x - 1 && k.x + k.width <= r.x + r.width + 1,
            'key/preview visible inside timeline',
          );
        };
        if (layout === 'ancestor')
          await page.evaluate(() => {
            const main = document.querySelector('main'),
              box = document.createElement('div');
            box.id = 'qa-scroll-ancestor';
            box.style.cssText = 'height:620px;overflow:auto;margin-top:700px;border:1px solid #888';
            main.before(box);
            box.append(main);
          });
        await record('open', 0);
        await button('Add rectangle').click();
        const layer = (await inspect()).view.snapshot.content.compositions[0].layers.at(-1);
        await expect(button(`rect ${layer.id}`)).toHaveAttribute('aria-pressed', 'true');
        await record('create rectangle', 1);
        await field('Base y').fill('220');
        await button('Apply inputs').click();
        await record('base transform', 2);
        await button('Add key at playhead (base value)').click();
        await record('start key', 3);
        await expect(button('Play')).toBeEnabled();
        await field('Seek').fill('960000');
        await button('Add key at playhead (base value)').click();
        await record('end key', 4);
        await field('Key value').fill('460');
        await button('Apply inputs').click();
        await record('end value', 5);
        await button('0 ticks · 80').click();
        await field('Easing').selectOption('bezier');
        await field('Bezier x1').fill('0.25');
        await field('Bezier x2').fill('0.75');
        await button('Apply inputs').click();
        await record('outgoing curve', 6);
        await field('Timeline zoom').fill('4');
        await button('0 ticks · 80').focus();
        await page.keyboard.press('Tab');
        await expect(button('960000 ticks · 460')).toBeFocused();
        await assertVisible(button('960000 ticks · 460'));
        const vertical = await scrollState();
        for (let i = 0; i < 50; i++) await page.keyboard.press('Shift+ArrowLeft');
        await assertVisible(page.locator('.ae-key-ghost'));
        await record('keyboard preview private', 6);
        await page.keyboard.press('Escape');
        await expect(button('960000 ticks · 460')).toBeFocused();
        await assertVisible(button('960000 ticks · 460'));
        await record('zoomed Escape', 6);
        const cancelledScroll = await scrollState();
        assert.ok(
          Math.abs(vertical.page - cancelledScroll.page) <= 1,
          'Cancel must not move an already visible page vertically',
        );
        assert.ok(
          Math.abs(vertical.ancestor - cancelledScroll.ancestor) <= 1,
          'Cancel must not move visible scroll ancestor vertically',
        );
        for (let i = 0; i < 40; i++) await page.keyboard.press('Shift+ArrowLeft');
        await page.keyboard.press('Enter');
        await expect(button('640000 ticks · 460')).toBeFocused();
        await assertVisible(button('640000 ticks · 460'));
        const committedScroll = await scrollState();
        assert.ok(
          Math.abs(vertical.page - committedScroll.page) <= 1,
          'commit vertical page stability',
        );
        assert.ok(
          Math.abs(vertical.ancestor - committedScroll.ancestor) <= 1,
          'commit vertical ancestor stability',
        );
        for (const axis of ['pageX', 'ancestorX']) {
          assert.equal(
            cancelledScroll[axis],
            vertical[axis],
            'Cancel keeps outer horizontal scroll',
          );
          assert.equal(
            committedScroll[axis],
            vertical[axis],
            'commit keeps outer horizontal scroll',
          );
        }
        await record('keyboard commit', 7);
        await button('Undo').focus();
        await page.keyboard.press('Enter');
        await expect(button('Undo')).toBeFocused();
        await record('move Undo', 8);
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await expect(button('Redo')).toBeFocused();
        await record('move Redo', 9);
        const beforePending = (await inspect()).view.snapshot.content;
        await field('Base y').fill('230');
        await field('Key tick').fill('0');
        await field('Easing').selectOption('bezier');
        await field('Bezier y2').fill('-');
        await button('Apply inputs').click();
        await expect(field('Key tick')).toBeFocused();
        await expect(button('Undo')).toBeDisabled();
        await expect(button('rect box')).toBeDisabled();
        await record('collision refusal', 9);
        await field('Key tick').fill('720000');
        await button('Save through Host').click();
        await expect(field('Bezier y2')).toBeFocused();
        await expect(field('Base y')).toHaveValue('230');
        await record('Bezier refusal', 9);
        await field('Key value').dispatchEvent('compositionstart');
        await button('Save through Host').click();
        await expect(field('Key value')).toBeFocused();
        await expect(field('Bezier y2')).toHaveValue('-');
        await record('IME refusal', 9);
        await field('Key value').dispatchEvent('compositionend');
        await button('Cancel inputs').click();
        assert.deepEqual((await inspect()).view.snapshot.content, beforePending);
        await expect(field('Base y')).toHaveValue('220');
        await expect(field('Key tick')).toHaveValue('640000');
        await record('cancel all pending', 9);
        await field('Base y').fill('230');
        await field('Key tick').fill('720000');
        await field('Key value').fill('480');
        await field('Easing').selectOption('bezier');
        await field('Bezier y2').fill('0.8');
        await button('Apply inputs').click();
        await record('atomic corrected batch', 10);
        const edited = (await inspect()).view.snapshot.content;
        await button('Undo').click();
        assert.deepEqual((await inspect()).view.snapshot.content, beforePending);
        await record('batch Undo', 11);
        await button('Redo').click();
        assert.deepEqual((await inspect()).view.snapshot.content, edited);
        await record('batch Redo', 12);
        await expect(button('Play')).toBeEnabled();
        await field('Seek').fill('0');
        await button('Play').click();
        await page.waitForFunction('host.inspect().playback.tick>0');
        await button('Pause').click();
        await field('Seek').fill('720000');
        await expect(page.locator('svg rect').last()).toHaveAttribute(
          'transform',
          'matrix(1 0 0 1 480 230)',
        );
        await record('play pause deterministic seek', 12);
        await button('Save through Host').click();
        await expect(page.getByRole('status')).toHaveText('Save: committed');
        await record('save', 12);
        await page.reload();
        await page.waitForFunction('globalThis.ready');
        await expect(button('Play')).toBeEnabled();
        assert.deepEqual((await inspect()).view.snapshot.content, edited);
        await record('fresh reopen', 0);
        await button(`rect ${layer.id}`).click();
        await button('0 ticks · 80').click();
        await expect(field('Bezier x1')).toHaveValue('0.25');
        await button('720000 ticks · 480').click();
        await expect(field('Bezier y2')).toHaveValue('0.8');
        await field('Seek').fill('720000');
        await expect(page.locator('svg rect').last()).toHaveAttribute(
          'transform',
          'matrix(1 0 0 1 480 230)',
        );
        await record('resume editing target', 0);
        assert.deepEqual(errors, []);
        assert.deepEqual((await inspect()).errors, []);
        const at = (action) => trace.find((step) => step.action === action).contentHash;
        for (const action of ['keyboard preview private', 'zoomed Escape', 'move Undo'])
          assert.equal(at(action), at('outgoing curve'), action);
        for (const action of [
          'collision refusal',
          'Bezier refusal',
          'IME refusal',
          'cancel all pending',
          'batch Undo',
        ])
          assert.equal(at(action), at('move Redo'), action);
        for (const action of [
          'batch Redo',
          'play pause deterministic seek',
          'save',
          'fresh reopen',
          'resume editing target',
        ])
          assert.equal(at(action), at('atomic corrected batch'), action);

        await writeFile(
          path.join(output, `${kind}-${width}-${layout}.json`),
          JSON.stringify(
            { kind, width, layout, vertical, cancelledScroll, committedScroll, trace },
            null,
            2,
          ),
        );
        reports.push({
          kind,
          width,
          layout,
          trace,
          result: 'PASS',
          editorSha256: pins['@editor-platform/animation'],
          adapterSha256: pins['@editor-platform/extension-animation-adapter'],
        });
        console.log(
          'PASS',
          kind,
          width,
          layout,
          'long deterministic creation/recovery/save trace; zoom Cancel and page/ancestor scrolling',
        );
        await page.close();
      }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
assert.equal(hashes[0], hashes[1]);
assert.equal(
  new Set(reports.map((r) => JSON.stringify(r.trace))).size,
  1,
  'normalized native traces must match all Hosts/viewports/layouts',
);
await writeFile(path.join(output, 'results.json'), JSON.stringify(reports, null, 2));
