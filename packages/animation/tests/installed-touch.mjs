/* global window, document, scrollY */
import process from 'node:process';
import console from 'node:console';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseTouchPinOptions } from '../../../scripts/extension-hosts/touch-pin-options.mjs';
// installed-touch.mjs CONSUMERS OUTPUT_OUTSIDE_GIT KIT
// [--expected-pin FULLSHA --expected-provenance SHA256]
const {
  paths,
  expectedPin: runtime,
  expectedProvenance,
} = parseTouchPinOptions(process.argv.slice(2));
const directory = await realpath(paths[0]);
const requestedOutput = path.resolve(paths[1]);
const outputParent = await realpath(path.dirname(requestedOutput));
const output = path.join(outputParent, path.basename(requestedOutput));
// Resolve symlinks, then ask Git; an empty sandbox .git sentinel is not a checkout.
let insideGit = false;
try {
  insideGit =
    execFileSync('git', ['-C', outputParent, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true';
} catch (error) {
  if (error.code === 'ENOENT') throw error;
}
assert.equal(insideGit, false, 'Output must be outside Git');
const provenanceBytes = await readFile(path.join(paths[2], 'provenance.json'));
const provenanceHash = createHash('sha256').update(provenanceBytes).digest('hex');
assert.equal(provenanceHash, expectedProvenance, 'Unexpected kit provenance');
const provenance = JSON.parse(provenanceBytes);
assert.equal(provenance.sourceCommit, runtime);
const packages = Object.fromEntries(provenance.packages.map((p) => [p.name, p.sha256]));
for (const kind of ['reference', 'independent']) {
  const pins = JSON.parse(await readFile(path.join(directory, kind, 'editor-pin.json')));
  assert.equal(pins.sourceCommit, runtime, `${kind} source pin`);
  assert.deepEqual(pins.packages, packages, `${kind} package pins`);
}
await mkdir(output); // Non-recursive: refuse every existing output; never overwrite old evidence.
const harnessSha256 = createHash('sha256')
  .update(await readFile(fileURLToPath(import.meta.url)))
  .digest('hex');
const metadata = {
  runtime,
  provenanceHash,
  harnessSha256,
  pinOptionsSha256: createHash('sha256')
    .update(
      await readFile(
        new URL('../../../scripts/extension-hosts/touch-pin-options.mjs', import.meta.url),
      ),
    )
    .digest('hex'),
  consumers: directory,
  servedDistSha256: {},
  notes: [
    'CDP trusted touch emulation; not physical iPhone/Safari.',
    'DOM scroll setup and mouse Apply/Undo/Redo plus fill are auxiliary; only gestures claim touch input.',
    'Marker vertical swipe is scroll suppression, not scrolling interrupted by pointercancel.',
  ],
};
console.log('OUTPUT', output);
const results = [];
for (const kind of ['reference', 'independent']) {
  const root = path.join(directory, kind);
  metadata.servedDistSha256[kind] = Object.fromEntries(
    await Promise.all(
      ['animation.html', 'animation.js', 'animation.css'].map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(path.join(root, 'dist', name)))
          .digest('hex'),
      ]),
    ),
  );
  const server = createServer(async (req, res) => {
    const name = req.url === '/' ? 'animation.html' : req.url.slice(1);
    if (!['animation.html', 'animation.js', 'animation.css'].includes(name)) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(await readFile(`${root}/dist/${name}`));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  try {
    for (const scenario of [
      'cancel',
      'outside-release',
      'vertical-scroll-attempt',
      'background-scroll',
      'repeat-taps',
    ]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const captureChecks = [];
      let result = { kind, scenario, captureChecks };
      let gestureScroll, downScroll;
      try {
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction('globalThis.ready');
        await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
        await page.evaluate(() => {
          window.touchEvidence = [];
          const active = new Set(),
            captured = new Map(),
            targets = new Map();
          let touches = [];
          window.touchPointerState = () => ({
            active: [...active],
            touches,
            captured: [...captured.keys()],
            actualCapture: [...targets]
              .filter(([id, elements]) =>
                [...elements].some((element) => element.hasPointerCapture(id)),
              )
              .map(([id]) => id),
          });
          for (const type of [
            'pointerdown',
            'pointermove',
            'pointerup',
            'pointercancel',
            'gotpointercapture',
            'lostpointercapture',
            'touchstart',
            'touchmove',
            'touchend',
            'touchcancel',
            'scroll',
          ])
            document.addEventListener(
              type,
              (e) => {
                if (e.pointerType === 'touch') {
                  if (!targets.has(e.pointerId)) targets.set(e.pointerId, new Set());
                  targets.get(e.pointerId).add(e.target);
                  if (e.type === 'pointerdown') active.add(e.pointerId);
                  if (['pointerup', 'pointercancel'].includes(e.type)) active.delete(e.pointerId);
                  if (e.type === 'gotpointercapture') captured.set(e.pointerId, e.target);
                  if (e.type === 'lostpointercapture') captured.delete(e.pointerId);
                }
                if (e.touches) touches = [...e.touches].map((touch) => touch.identifier);
                window.touchEvidence.push({
                  type: e.type,
                  pointerType: e.pointerType,
                  isTrusted: e.isTrusted,
                  pointerId: e.pointerId,
                  cancelled: e.type.endsWith('cancel'),
                  capture: e.target.hasPointerCapture?.(e.pointerId),
                  target: e.target.className,
                  x: e.clientX,
                  y: e.clientY,
                  scrollX: document.querySelector('.ae-time-scroll')?.scrollLeft,
                  scrollY: window.scrollY,
                });
              },
              true,
            );
        });
        const inspect = () => page.evaluate('host.inspect()');
        const before = await inspect();
        const content = before.view.snapshot.content;
        const marker = page.getByRole('button', { name: '0 ticks · 80', exact: true });
        await marker.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          const s = document.querySelector('.ae-time-scroll');
          s.scrollLeft = 0;
          s.scrollIntoView({ block: 'center' });
          window.touchEvidence = [];
        });
        const cdp = await context.newCDPSession(page);
        const assertReleased = async (phase) => {
          const state = await page.evaluate('touchPointerState()');
          captureChecks.push({ phase, ...state });
          assert.deepEqual(state, { active: [], touches: [], captured: [], actualCapture: [] });
        };
        const send = async (type, x, y) => {
          await cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: ['touchEnd', 'touchCancel'].includes(type)
              ? []
              : [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
          });
          if (['touchEnd', 'touchCancel'].includes(type)) await assertReleased(type);
        };
        const b = await marker.boundingBox();
        const x = b.x + b.width / 2,
          y = b.y + b.height / 2;
        const scroll0 = await page.evaluate(() => ({
          x: document.querySelector('.ae-time-scroll').scrollLeft,
          y: scrollY,
        }));
        if (scenario === 'background-scroll') {
          const rail = await page.locator('.ae-time-scroll').boundingBox();
          const yy = rail.y + rail.height - 10;
          await send('touchStart', 320, yy);
          for (let i = 1; i <= 6; i++) await send('touchMove', 320 - i * 30, yy);
          await send('touchEnd');
          await expect
            .poll(() => page.locator('.ae-time-scroll').evaluate((e) => e.scrollLeft))
            .toBeGreaterThan(0);
          assert.deepEqual((await inspect()).view.snapshot.content, content);
        } else if (scenario === 'repeat-taps') {
          for (let i = 0; i < 5; i++) {
            await send('touchStart', x, y);
            await send('touchEnd');
          }
          assert.deepEqual((await inspect()).view.snapshot.content, content);
          assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
          await expect(marker).toHaveAttribute('aria-pressed', 'true');
          await expect(page.getByLabel('Key tick', { exact: true })).toHaveValue('0');
          await page.getByLabel('Key value', { exact: true }).fill('95'); // input setup; touch-only claim limited to gestures
          await page.getByRole('button', { name: 'Apply inputs', exact: true }).click();
          assert.equal((await inspect()).view.snapshot.revision.sequence, 1);
          const edited = (await inspect()).view.snapshot.content;
          await page.getByRole('button', { name: 'Undo', exact: true }).click();
          assert.deepEqual((await inspect()).view.snapshot.content, content);
          await page.getByRole('button', { name: 'Redo', exact: true }).click();
          assert.deepEqual((await inspect()).view.snapshot.content, edited);
        } else {
          await send('touchStart', x, y);
          downScroll = await page.evaluate(() => ({
            x: document.querySelector('.ae-time-scroll').scrollLeft,
            y: scrollY,
          }));
          await send(
            'touchMove',
            x + (scenario === 'vertical-scroll-attempt' ? 0 : 40),
            y + (scenario === 'cancel' ? 0 : -120),
          );
          gestureScroll = await page.evaluate(() => ({
            x: document.querySelector('.ae-time-scroll').scrollLeft,
            y: scrollY,
          }));
          assert.deepEqual(gestureScroll, downScroll);
          assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
          assert.equal((await page.evaluate('host.save()')).state, 'refused');
          if (scenario === 'cancel') {
            await send('touchCancel');
            assert.deepEqual((await inspect()).view.snapshot.content, content);
            assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
          } else if (scenario === 'vertical-scroll-attempt') {
            await send('touchEnd');
            assert.deepEqual((await inspect()).view.snapshot.content, content);
            assert.equal((await inspect()).view.snapshot.revision.sequence, 0);
          } else {
            await send('touchEnd');
            assert.equal((await inspect()).view.snapshot.revision.sequence, 1);
            const moved = (await inspect()).view.snapshot.content;
            assert.ok(moved.compositions[0].tracks[0].keys[0].tick > 0);
            await page.getByRole('button', { name: 'Undo', exact: true }).click();
            assert.deepEqual((await inspect()).view.snapshot.content, content);
            await page.getByRole('button', { name: 'Redo', exact: true }).click();
            assert.deepEqual((await inspect()).view.snapshot.content, moved);
          }
        }
        await assertReleased('case-final');
        const after = await inspect();
        assert.equal(after.inputs.dirty, 0);
        assert.equal(after.inputs.composing, 0);
        assert.deepEqual(errors, []);
        assert.deepEqual(after.errors, []);
        if (['cancel', 'vertical-scroll-attempt', 'background-scroll'].includes(scenario)) {
          assert.equal(after.view.snapshot.revision.sequence, 0);
          assert.equal(after.inputs.canUndo, false);
        }
        if (scenario === 'outside-release') assert.equal(after.view.snapshot.revision.sequence, 3);
        const events = await page.evaluate('touchEvidence');
        assert.ok(
          events.some((e) => e.type === 'pointerdown' && e.pointerType === 'touch' && e.isTrusted),
        );
        if (scenario === 'cancel')
          assert.ok(
            events.some(
              (e) => e.type === 'pointercancel' && e.pointerType === 'touch' && e.isTrusted,
            ),
          );
        if (scenario === 'vertical-scroll-attempt')
          assert.ok(!events.some((e) => e.type === 'pointercancel'));
        if (scenario === 'background-scroll') {
          assert.ok(events.some((e) => e.type === 'scroll' && e.isTrusted));
          assert.ok(
            events.some(
              (e) => e.type === 'pointercancel' && e.pointerType === 'touch' && e.isTrusted,
            ),
          );
        }
        result = {
          ...result,
          result: 'PASS',
          before,
          after,
          events,
          scroll0,
          downScroll,
          gestureScroll,
          scrollAfter: await page.evaluate(() => ({
            x: document.querySelector('.ae-time-scroll').scrollLeft,
            y: scrollY,
          })),
        };
      } catch (e) {
        result = {
          ...result,
          result: 'FAIL',
          error: String(e),
          state: await page.evaluate('host.inspect()').catch(() => null),
          events: await page.evaluate('touchEvidence').catch(() => null),
        };
      }
      await page.screenshot({ path: `${output}/${kind}-${scenario}.png`, fullPage: true });
      await context.tracing.stop({ path: `${output}/${kind}-${scenario}.zip` });
      await context.close();
      results.push(result);
      await writeFile(
        `${output}/results.json`,
        JSON.stringify({ ...metadata, browser: browser.version(), results }, null, 2),
      );
      console.log(kind, scenario, result.result, result.error ?? '');
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
console.log(output);
if (results.some((r) => r.result === 'FAIL')) process.exitCode = 1;
