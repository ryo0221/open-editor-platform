/**
 * Chromium CDP touch-emulation regression; not physical iPhone/Safari evidence.
 * Run from the checkout (prebuilt, verified consumers; no downloads or rebuilds):
 * node scripts/extension-hosts/geo-touch-check.mjs \
 *   --consumers /tmp/issue76-delivery-082c-consumers \
 *   --expected-pin 082c698740cf30f78ec4f9a293e663633ba86f0a \
 *   --provenance /tmp/issue76-delivery-082c-kit/provenance.json \
 *   --expected-provenance 8ec2cef23877ac8e3810984fed598b2a0a2fa1b224501addf88926257cc10e66 \
 *   --out /tmp/geo-touch-new-run
 * --out is mandatory, must not exist, and must be outside every Git worktree.
 * Fixture text fill / scrollIntoView are setup. Selection, Apply, Undo and Redo
 * use CDP touch, with trusted touch pointer events asserted. No DOM-dispatched
 * synthetic touch/pointer events. Map dragging has no editing contract.
 */
/* global document */
import process from 'node:process';
import console from 'node:console';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, basename, resolve, relative, isAbsolute, join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';

const { values } = parseArgs({
  options: Object.fromEntries(
    ['consumers', 'expected-pin', 'provenance', 'expected-provenance', 'out'].map((name) => [
      name,
      { type: 'string' },
    ]),
  ),
  allowPositionals: false,
});
for (const name of ['consumers', 'expected-pin', 'provenance', 'expected-provenance', 'out']) {
  assert.ok(values[name], `Missing required --${name}; see usage at top of this script`);
}
assert.match(values['expected-pin'], /^[0-9a-f]{40}$/);
assert.match(values['expected-provenance'], /^[0-9a-f]{64}$/);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const consumers = await realpath(values.consumers);
const provenanceBytes = await readFile(values.provenance);
assert.equal(sha256(provenanceBytes), values['expected-provenance'], 'Provenance SHA mismatch');
const provenance = JSON.parse(provenanceBytes);
assert.equal(provenance.sourceCommit, values['expected-pin'], 'Provenance source pin mismatch');
const pins = {},
  served = {},
  verifiedFiles = {};
for (const kind of ['reference', 'independent']) {
  const root = join(consumers, kind);
  const pin = JSON.parse(await readFile(join(root, 'editor-pin.json'), 'utf8'));
  assert.equal(pin.sourceCommit, values['expected-pin'], `${kind}: consumer source pin mismatch`);
  assert.deepEqual(
    pin.packages,
    Object.fromEntries(provenance.packages.map((p) => [p.name, p.sha256])),
    `${kind}: package pin mismatch`,
  );
  verifiedFiles[kind] = 0;
  for (const pkg of provenance.packages) {
    assert.match(pkg.name, /^@editor-platform\/[a-z0-9-]+$/);
    for (const [file, hash] of Object.entries(pkg.files)) {
      assert.ok(
        !isAbsolute(file) && !file.split('/').includes('..'),
        'Unsafe provenance file path',
      );
      assert.equal(
        sha256(await readFile(join(root, 'node_modules', pkg.name, file))),
        hash,
        `${kind}: installed ${pkg.name}/${file} mismatch`,
      );
      verifiedFiles[kind]++;
    }
  }
  pins[kind] = pin;
  // Serve exactly these captured bytes and record their hashes, avoiding a read/serve race.
  served[kind] = Object.fromEntries(
    await Promise.all(
      ['geo-save.html', 'geo-save.js'].map(async (name) => [
        name,
        await readFile(join(root, 'dist', name)),
      ]),
    ),
  );
}
const outParent = await realpath(dirname(resolve(values.out)));
const evidence = join(outParent, basename(resolve(values.out)));
const scriptPath = fileURLToPath(import.meta.url);
const repo = execFileSync('git', ['-C', dirname(scriptPath), 'rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const inside = relative(await realpath(repo), evidence);
assert.ok(
  inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside),
  '--out must be outside the checkout',
);
try {
  const gitRoot = execFileSync('git', ['-C', outParent, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  assert.fail(`--out parent belongs to Git worktree ${gitRoot}`);
} catch (error) {
  if (error.code === 'ERR_ASSERTION' || error.status !== 128) throw error;
}
// Non-recursive mkdir refuses any existing file, directory or symlink; never overwrite evidence.
await mkdir(evidence);
const summary = {
  runtimePin: values['expected-pin'],
  provenanceSha256: values['expected-provenance'],
  harnessSha256: sha256(await readFile(scriptPath)),
  harnessCheckout: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  viewport: { width: 390, height: 844 },
  input: 'Chromium CDP touch emulation',
  setup: 'Playwright fill and scrollIntoView; no mobile keyboard claim',
  actions: 'CDP touch selection, cancellation, scrolling, Apply, Undo, Redo',
  syntheticPointerEvents: false,
  verifiedInstalledFiles: verifiedFiles,
  servedHashes: Object.fromEntries(
    Object.entries(served).map(([kind, files]) => [
      kind,
      Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
    ]),
  ),
  limitations: [
    'Not physical iPhone or Safari',
    'No map drag editing/pan/zoom contract',
    'Prebuilt bundle hashes recorded; no rebuild performed',
  ],
  results: [],
};
await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
console.log('EVIDENCE_DIRECTORY', evidence);
for (const kind of ['reference', 'independent']) {
  const pin = pins[kind];
  const server = createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!['geo-save.html', 'geo-save.js'].includes(name)) return res.writeHead(204).end();
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(served[kind][name]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const failures = [],
    report = [],
    gestures = [];
  page.on('pageerror', (e) => failures.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') failures.push(m.text());
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/geo-save.html`);
    await page.waitForFunction('globalThis.ready');
    await page.evaluate(() => {
      globalThis.touchEvents = [];
      globalThis.activePointers = new Set();
      globalThis.capturedPointers = new Set();
      for (const type of [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'gotpointercapture',
        'lostpointercapture',
        'click',
      ]) {
        document.addEventListener(
          type,
          (event) => {
            if (type === 'pointerdown') globalThis.activePointers.add(event.pointerId);
            if (type === 'pointerup' || type === 'pointercancel')
              globalThis.activePointers.delete(event.pointerId);
            if (type === 'gotpointercapture') globalThis.capturedPointers.add(event.pointerId);
            if (type === 'lostpointercapture') globalThis.capturedPointers.delete(event.pointerId);
            globalThis.touchEvents.push({
              pointerId: event.pointerId,
              type,
              pointerType: event.pointerType,
              isTrusted: event.isTrusted,
              cancelled: event.type === 'pointercancel',
              target:
                event.target.closest?.('[aria-label]')?.getAttribute('aria-label') ??
                event.target.textContent?.slice(0, 70),
              capture: event.target.hasPointerCapture?.(event.pointerId) ?? false,
              x: event.clientX,
              y: event.clientY,
            });
          },
          { capture: true, passive: true },
        );
      }
    });
    const state = () => page.evaluate('host.state()');
    const mark = (name) =>
      page.evaluate((name) => {
        globalThis.touchEvents.push({ phase: name });
      }, name);
    const row = (id) => page.getByRole('button', { name: `Select ${id} (Point)`, exact: true });
    const point = (id) => page.getByRole('button', { name: new RegExp(`^Select point ${id};`) });
    const stable = (s) => ({
      hash: s.hash,
      revision: s.revision,
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      inputs: s.inputs,
    });
    const unchanged = async (s) => assert.deepEqual(stable(await state()), stable(s));
    const position = async (locator) => {
      // Programmatic visibility positioning is setup only; gesture scroll is measured separately.
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      assert.ok(box);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const released = () =>
      page.evaluate(() => ({
        active: [...globalThis.activePointers],
        captured: [...globalThis.capturedPointers],
      }));
    const touch = async (type, p) => {
      if (type === 'touchStart') assert.deepEqual(await released(), { active: [], captured: [] });
      await cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: p ? [{ ...p, radiusX: 1, radiusY: 1, force: 1, id: 1 }] : [],
      });
      if (type === 'touchEnd' || type === 'touchCancel') {
        await expect.poll(released).toEqual({ active: [], captured: [] });
      }
    };
    const tap = async (locator) => {
      const p = await position(locator);
      await touch('touchStart', p);
      await touch('touchEnd');
    };
    const gesture = async (locator, dx, dy, cancelled) => {
      const p = await position(locator);
      const region = await locator.evaluate((el) =>
        el.ownerSVGElement?.getBoundingClientRect().toJSON(),
      );
      gestures.push({
        start: p,
        dx,
        dy,
        cancelled,
        svgRegion: region,
        endpoint: {
          x: Math.max(2, Math.min(388, p.x + dx)),
          y: Math.max(2, Math.min(842, p.y + dy)),
        },
      });
      await touch('touchStart', p);
      for (let step = 1; step <= 8; step++)
        await touch('touchMove', {
          x: Math.max(2, Math.min(388, p.x + (dx * step) / 8)),
          y: Math.max(2, Math.min(842, p.y + (dy * step) / 8)),
        });
      await touch(cancelled ? 'touchCancel' : 'touchEnd');
      await page.waitForTimeout(150);
    };
    const initial = await state();
    await mark('clean-map-tap');
    await tap(point('point-2'));
    await expect(point('point-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(row('point-2')).toHaveAttribute('aria-pressed', 'true');
    await unchanged(initial);
    report.push('map tap changes selection, not native/history');
    await mark('table-tap-and-repeated-taps');
    for (const id of ['point-1', 'point-2', 'point-3', 'point-2', 'point-3']) {
      await tap(row(id));
      await expect(row(id)).toHaveAttribute('aria-pressed', 'true');
      await unchanged(initial);
    }
    report.push('five successive table taps retain stable identity and native/history');
    await mark('explicit-cdp-cancel');
    const cancelPoint = await position(point('point-2'));
    await touch('touchStart', cancelPoint);
    await touch('touchCancel');
    await expect(row('point-3')).toHaveAttribute('aria-pressed', 'true');
    await unchanged(initial);
    report.push('CDP cancel before click retains selection/native/history');
    await mark('map-outside-drag');
    await gesture(point('point-2'), 130, 160, false);
    await expect(row('point-3')).toHaveAttribute('aria-pressed', 'true');
    await unchanged(initial);
    report.push('map drag has no native editing contract; no accidental selection/command');
    await mark('table-scroll-interruption');
    const table = page.getByRole('region', { name: 'Attributes sites', exact: true });
    const scrollTarget = table.locator('td').first();
    const p = await position(scrollTarget);
    const beforeScroll = await table.evaluate((el) => el.scrollLeft);
    const index = await page.evaluate('touchEvents.length');
    await touch('touchStart', { x: Math.min(330, p.x), y: p.y });
    for (let step = 1; step <= 8; step++)
      await touch('touchMove', { x: Math.min(330, p.x) - 24 * step, y: p.y });
    await touch('touchCancel');
    await page.waitForTimeout(150);
    const afterScroll = await table.evaluate((el) => el.scrollLeft);
    const scrollingEvents = await page.evaluate(
      (index) => globalThis.touchEvents.slice(index),
      index,
    );
    assert.ok(afterScroll > beforeScroll, `Native table scroll ${beforeScroll}→${afterScroll}`);
    assert.ok(
      scrollingEvents.some(
        (e) => e.type === 'pointercancel' && e.pointerType === 'touch' && e.isTrusted,
      ),
    );
    await unchanged(initial);
    await expect(row('point-3')).toHaveAttribute('aria-pressed', 'true');
    report.push({
      nativeHorizontalScroll: [beforeScroll, afterScroll],
      trustedPointerCancel: true,
    });
    await mark('dirty-selection-refusal');
    // Text entry is controlled fixture setup, not a claim about mobile virtual keyboards.
    await page.getByLabel('Longitude', { exact: true }).fill('12.75');
    await page.getByLabel('Scalar value', { exact: true }).fill('17');
    const dirty = await state();
    await tap(point('point-2'));
    await tap(row('point-1'));
    await expect(row('point-3')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('12.75');
    await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('17');
    await unchanged(dirty);
    await mark('dirty-cancelled-drag');
    await gesture(point('point-2'), -130, 130, true);
    await unchanged(dirty);
    await expect(page.getByLabel('Longitude', { exact: true })).toHaveValue('12.75');
    await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('17');
    await expect(row('point-3')).toHaveAttribute('aria-pressed', 'true');
    report.push('dirty buffers survive map/table tap refusal and cancelled drag');
    await mark('touch-apply-undo-redo');
    await tap(page.getByRole('button', { name: 'Apply', exact: true }));
    const applied = await state();
    assert.equal(applied.revision.sequence, initial.revision.sequence + 1);
    assert.equal(applied.inputs.dirty, 0);
    assert.deepEqual(
      applied.content.layers[0].features.find((f) => f.id === 'point-3').geometry.coordinates,
      [12.75, 34],
    );
    assert.equal(
      applied.content.layers[0].features.find((f) => f.id === 'point-3').values.metric,
      17,
    );
    await tap(page.getByRole('button', { name: 'Undo', exact: true }));
    assert.deepEqual((await state()).content, initial.content);
    await tap(page.getByRole('button', { name: 'Redo', exact: true }));
    assert.deepEqual((await state()).content, applied.content);
    await tap(point('point-2'));
    const selected = await state();
    for (let n = 0; n < 3; n++) await tap(point('point-2'));
    await unchanged(selected);
    report.push(
      'touch Apply is one revision; Undo/Redo preserve content; repeated map tap adds no history',
    );
    const releasedState = await released();
    assert.deepEqual(releasedState, { active: [], captured: [] });
    const events = await page.evaluate('touchEvents');
    const starts = events.filter((e) => e.type === 'pointerdown');
    const cancels = events.filter((e) => e.type === 'pointercancel');
    assert.equal(starts.length, 19);
    assert.equal(cancels.length, 4);
    assert.ok(starts.concat(cancels).every((e) => e.pointerType === 'touch' && e.isTrusted));
    assert.ok(
      events.some((e) => e.type === 'pointercancel' && e.isTrusted && e.pointerType === 'touch'),
    );
    assert.ok(events.some((e) => e.type === 'click' && e.isTrusted && e.pointerType === 'touch'));
    assert.deepEqual(failures, []);
    assert.deepEqual((await state()).errors, []);
    await page.screenshot({ path: `${evidence}/${kind}.png` });
    summary.results.push({
      kind,
      status: 'PASS',
      pointerStarts: starts.length,
      pointerCancels: cancels.length,
      releasedState,
      report,
    });
    console.log('PASS', kind, pin.sourceCommit, JSON.stringify(report));
  } catch (e) {
    await page.screenshot({ path: `${evidence}/${kind}-failure.png` });
    summary.results.push({ kind, status: 'FAIL', error: String(e) });
    console.error('FAIL', kind, String(e));
    throw e;
  } finally {
    await writeFile(
      `${evidence}/${kind}.json`,
      JSON.stringify(
        {
          pin,
          report,
          gestures,
          events: await page.evaluate('globalThis.touchEvents ?? []'),
          state: await page.evaluate('host.state()'),
        },
        null,
        2,
      ),
    );
    await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2));
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
