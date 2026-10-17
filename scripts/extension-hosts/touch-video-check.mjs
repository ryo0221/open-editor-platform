/* global document, innerWidth */
// Reproduce, do not mask: expected unresolved clicks remain FAIL/exit 1.
// node scripts/extension-hosts/touch-video-check.mjs CONSUMERS KIT OUTPUT_OUTSIDE_GIT
// Chromium touch emulation only, not physical iPhone/Safari acceptance.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { setTimeout as inputDelay } from 'node:timers/promises';
import { parseTouchPinOptions } from './touch-pin-options.mjs';
// Optional paired --expected-pin FULLSHA --expected-provenance SHA256;
// existing --dom-timing / --dom-point-timing / --product-paced remain exclusive.
const { paths, expectedPin, expectedProvenance, mode } = parseTouchPinOptions(
  process.argv.slice(2),
  ['--dom-timing', '--dom-point-timing', '--product-paced'],
);
const timingOnly = mode === '--dom-timing';
const pointTimingOnly = mode === '--dom-point-timing';
const productPacedOnly = mode === '--product-paced';
const [consumers, kit, requestedOutput] = paths.map((p) => path.resolve(p));
const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
// Existing output parents must resolve outside Git, including symlinks.
const parent = await realpath(path.dirname(requestedOutput));
assert(
  !parent.startsWith(repository + path.sep) && parent !== repository,
  'Evidence must be outside Git',
);
const output = path.join(parent, path.basename(requestedOutput));
const parentGit = spawnSync('git', ['-C', parent, 'rev-parse', '--is-inside-work-tree'], {
  encoding: 'utf8',
});
assert(!parentGit.error && parentGit.status !== 0, 'Evidence must be outside every Git repository');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const provenanceBytes = await readFile(path.join(kit, 'provenance.json'));
assert.equal(hash(provenanceBytes), expectedProvenance);
const provenance = JSON.parse(provenanceBytes);
assert.equal(provenance.sourceCommit, expectedPin);
const fixturePath = fileURLToPath(new URL('./touch-video-dom-fixture.html', import.meta.url));
const fixture = await readFile(fixturePath);
const pins = {};
const bundles = {};
for (const kind of ['reference', 'independent']) {
  const root = path.join(consumers, kind);
  const pin = JSON.parse(await readFile(path.join(root, 'editor-pin.json')));
  assert.equal(pin.sourceCommit, expectedPin);
  for (const pkg of provenance.packages) {
    assert.equal(pin.packages[pkg.name], pkg.sha256);
    // Verify actual installed files, not just an asserted pin label.
    for (const [name, digest] of Object.entries(pkg.files))
      assert.equal(hash(await readFile(path.join(root, 'node_modules', pkg.name, name))), digest);
  }
  pins[kind] = pin;
  bundles[kind] = {};
  for (const name of ['video-edit.html', 'video-edit.js'])
    bundles[kind][name] = hash(await readFile(path.join(root, 'dist', name)));
}
await mkdir(output, { recursive: false }); // Validated pin; never overwrite a failure run.
const evidence = {
  runtimeCommit: expectedPin,
  provenanceSHA256: expectedProvenance,
  pins,
  bundles,
  harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  harnessWorkingTree: execFileSync(
    'git',
    [
      'status',
      '--porcelain',
      '--',
      'scripts/extension-hosts/touch-video-check.mjs',
      'scripts/extension-hosts/touch-video-dom-fixture.html',
    ],
    { encoding: 'utf8' },
  ).trim(),
  harnessSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
  fixtureSHA256: hash(fixture),
  pinOptionsSHA256: hash(await readFile(new URL('./touch-pin-options.mjs', import.meta.url))),
  environment: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  limits:
    'Chromium emulated trusted touch, not device/Safari. No dispatchEvent/click rescue. Failure evidence retained.',
  results: [],
};
const cases = [];
for (const kind of ['reference', 'independent']) {
  for (const scenario of [
    'move',
    'trim',
    'pointercancel',
    'outside',
    'scroll-interrupt',
    'rapid-tap',
    'cancel-redo',
    'mouse-keyboard',
  ])
    cases.push({ kind, scenario, tapDriver: 'cdp', suite: 'primary' });
  for (const scenario of ['outside', 'cancel-redo'])
    cases.push({ kind, scenario, tapDriver: 'playwright', suite: 'tap-comparison' });
  for (const scenario of [
    'direct-move',
    'direct-trim',
    'trim-cancel',
    'cancel-redo-keyboard-setup',
  ])
    cases.push({ kind, scenario, tapDriver: 'cdp', suite: 'supplement' });
}
for (const tapDriver of ['cdp', 'playwright'])
  for (const scenario of ['outside', 'cancel-redo'])
    cases.push({ kind: 'dom', scenario, tapDriver, suite: 'product-free-comparison' });
// Each variant changes one factor relative to the product-free baseline.
for (const variant of ['no-prior-gesture', 'no-scroll', 'same-capture', 'no-focus'])
  cases.push({
    kind: 'dom',
    scenario: variant === 'no-prior-gesture' ? 'tap-only' : 'outside',
    tapDriver: 'cdp',
    suite: 'factor-control',
    variant,
  });
// Predeclared functional input controls: no adaptive timing or threshold search.
if (timingOnly) {
  cases.length = 0;
  for (const timing of ['immediate-implicit', 'paced-implicit', 'paced-explicit'])
    for (const scenario of ['outside', 'cancel-redo'])
      cases.push({ kind: 'dom', scenario, tapDriver: 'cdp', suite: 'timing-control', timing });
}
if (pointTimingOnly) {
  cases.length = 0;
  for (const timing of ['immediate-implicit', 'paced-implicit'])
    for (const movePoints of [1, 3])
      cases.push({
        kind: 'dom',
        scenario: 'horizontal-control',
        tapDriver: 'cdp',
        suite: 'point-timing-control',
        timing,
        movePoints,
      });
}
if (productPacedOnly) {
  cases.length = 0;
  for (const kind of ['reference', 'independent'])
    for (const scenario of ['outside', 'cancel-redo'])
      cases.push({
        kind,
        scenario,
        tapDriver: 'cdp',
        suite: 'product-paced',
        timing: 'paced-implicit',
      });
}
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
evidence.browserVersion = browser.version();
try {
  for (const test of cases) {
    const { kind, scenario, tapDriver, suite, variant = 'baseline' } = test;
    const timing = test.timing || 'immediate-implicit';
    const paced = timing.startsWith('paced-');
    const name = `${kind}-${suite}-${scenario}-${tapDriver}-${variant}-${timing}-${test.movePoints || 'default'}`;
    const server = createServer(async (req, res) => {
      const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'video-edit.html';
      if (!['video-edit.html', 'video-edit.js'].includes(file)) return res.writeHead(204).end();
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(kind === 'dom' ? fixture : await readFile(path.join(consumers, kind, 'dist', file)));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ ...evidence.environment, deviceScaleFactor: 1 });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage(),
      cdp = await context.newCDPSession(page);
    const result = { ...test, injection: [], checkpoints: [], errors: [], result: 'PASS' };
    let stage = 'startup';
    page.on('pageerror', (error) => result.errors.push(String(error)));
    await page.addInitScript(() => {
      const data = { events: [], active: new Set(), pointers: new Set(), elements: new Set() };
      globalThis.touchEvidence = data;
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
        'click',
        'focusin',
        'focusout',
        'scroll',
      ])
        document.addEventListener(
          type,
          (event) => {
            if (event.type === 'pointerdown') data.active.add(event.pointerId);
            if (['pointerup', 'pointercancel'].includes(event.type))
              data.active.delete(event.pointerId);
            if (event.pointerId !== undefined) data.pointers.add(event.pointerId);
            data.elements.add(event.target);
            const row = {
              type,
              phase: 'capture',
              sameExpectedTarget: event.target === globalThis.touchExpectedTarget,
              expectedTargetContains:
                globalThis.touchExpectedTarget?.contains(event.target) || false,
              tapId: globalThis.touchTapId,
              touchIds: [...(event.touches || [])].map((touch) => touch.identifier),
              changedTouchIds: [...(event.changedTouches || [])].map((touch) => touch.identifier),
              timestamp: event.timeStamp,
              receivedAt: globalThis.performance.now(),
              timeOrigin: globalThis.performance.timeOrigin,
              trusted: event.isTrusted,
              pointerType: event.pointerType,
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              text: event.target.textContent?.slice(0, 200),
              target: event.target.getAttribute?.('aria-label'),
              disabled: event.target.disabled,
              defaultPrevented: event.defaultPrevented,
              captured: event.target.hasPointerCapture?.(event.pointerId),
              scrollY: globalThis.scrollY,
              activePointers: [...data.active],
              focused:
                document.activeElement?.getAttribute('aria-label') ||
                document.activeElement?.textContent?.slice(0, 80),
            };
            data.events.push(row);
            globalThis.queueMicrotask(() => {
              row.defaultPreventedAtCaptureMicrotask = event.defaultPrevented;
            });
            globalThis.setTimeout(() => {
              row.defaultPreventedAtNextTask = event.defaultPrevented;
            }, 0);
          },
          true,
        );
      for (const type of [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'touchstart',
        'touchmove',
        'touchend',
        'touchcancel',
        'click',
      ])
        document.addEventListener(type, (event) => {
          data.events.push({
            type,
            phase: 'bubble',
            sameExpectedTarget: event.target === globalThis.touchExpectedTarget,
            tapId: globalThis.touchTapId,
            trusted: event.isTrusted,
            pointerType: event.pointerType,
            timestamp: event.timeStamp,
            receivedAt: globalThis.performance.now(),
            timeOrigin: globalThis.performance.timeOrigin,
            text: event.target.textContent?.slice(0, 200),
            target: event.target.getAttribute?.('aria-label'),
            defaultPrevented: event.defaultPrevented,
          });
        });
    });
    const state = () => page.evaluate('host.state()');
    const button = (label) => page.getByRole('button', { name: label, exact: true });
    const checkpoint = async (label) => {
      const value = { label, state: await state() };
      result.checkpoints.push(value);
      return value.state;
    };
    const center = async (locator) => {
      const beforeScroll = await page.evaluate(() => ({
        x: globalThis.scrollX,
        y: globalThis.scrollY,
      }));
      await locator.scrollIntoViewIfNeeded(); // Setup, not a claimed physical touch scroll.
      const box = await locator.boundingBox();
      assert(box);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const afterScroll = await page.evaluate(() => ({
        x: globalThis.scrollX,
        y: globalThis.scrollY,
      }));
      result.injection.push({ type: 'scrollIntoViewIfNeeded', point, beforeScroll, afterScroll });
      if (variant === 'no-scroll' && (await locator.textContent()) === 'Undo')
        assert.deepEqual(afterScroll, beforeScroll, 'no-scroll control must not scroll at Undo');
      return point;
    };
    const touch = async (type, point, delayMs = 0) => {
      if (delayMs) await inputDelay(delayMs);
      const args = {
        type,
        touchPoints: point ? [{ ...point, id: 0, radiusX: 2, radiusY: 2, force: 1 }] : [],
      };
      if (timing === 'paced-explicit') args.timestamp = Date.now() / 1000;
      const delivery = {
        driver: 'cdp',
        ...args,
        requestedDelayMs: delayMs,
        sentAt: Date.now(),
        awaited: true,
      };
      result.injection.push(delivery);
      await cdp.send('Input.dispatchTouchEvent', args);
      delivery.acknowledgedAt = Date.now();
    };
    const released = async (boundary) => {
      const snapshot = await page.evaluate(() => {
        const data = globalThis.touchEvidence;
        return {
          activePointers: [...data.active],
          captures: [...data.elements].flatMap((element) =>
            [...data.pointers].filter((id) => element.hasPointerCapture?.(id)),
          ),
        };
      });
      result.checkpoints.push({ boundary, input: snapshot });
      assert.deepEqual(snapshot.activePointers, [], boundary + ': active pointer remains');
      assert.deepEqual(snapshot.captures, [], boundary + ': capture remains');
    };
    const drag = async (label, { dx = 20, dy = 0, steps = 3, cancel = false } = {}) => {
      const before = await checkpoint('before-drag');
      const point = await center(button(label));
      await touch('touchStart', point);
      assert.equal((await state()).inputs.dirty, 1);
      for (let i = 1; i <= steps; i++)
        await touch(
          'touchMove',
          { x: point.x + (dx * i) / steps, y: point.y + (dy * i) / steps },
          paced ? 80 : 0,
        );
      const during = await checkpoint('during-drag');
      assert.deepEqual(during.content, before.content);
      assert.deepEqual(during.revision, before.revision);
      await touch(cancel ? 'touchCancel' : 'touchEnd', undefined, paced ? 80 : 0);
      await released(cancel ? 'after-drag-cancel' : 'after-drag-end');
      return before;
    };
    const tap = async (label, requireClick = true) => {
      stage = `tap-${label}`;
      if (paced) {
        result.injection.push({ type: 'inter-gesture-delay', requestedDelayMs: 300 });
        await inputDelay(300);
      }
      const target = button(label);
      const tapId = await target.evaluate((element) => {
        globalThis.touchExpectedTarget = element;
        return (globalThis.touchTapId = (globalThis.touchTapId || 0) + 1);
      });
      const clicks = () =>
        page.evaluate(
          (tapId) =>
            globalThis.touchEvidence.events.filter(
              (e) =>
                e.type === 'click' &&
                e.phase === 'capture' &&
                e.trusted &&
                e.sameExpectedTarget &&
                e.tapId === tapId,
            ).length,
          tapId,
        );
      const point = await center(target);
      const hitTest = await target.evaluate(
        (element, point) => ({
          sameElement: document.elementFromPoint(point.x, point.y) === element,
          hitText: document.elementFromPoint(point.x, point.y)?.textContent,
          disabled: element.disabled,
          rect: element.getBoundingClientRect().toJSON(),
          scrollX: globalThis.scrollX,
          scrollY: globalThis.scrollY,
          viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
        }),
        point,
      );
      result.injection.push({ type: 'tap-hit-test', label, point, ...hitTest });
      assert(hitTest.sameElement && !hitTest.disabled, 'Tap must hit the enabled target');
      if (tapDriver === 'playwright') {
        result.injection.push({ driver: 'playwright-touchscreen.tap', point });
        await page.touchscreen.tap(point.x, point.y);
      } else {
        await touch('touchStart', point);
        await touch('touchEnd', undefined, paced ? 120 : 0);
      }
      await released('after-native-tap-end');
      if (requireClick) await expect.poll(clicks, { timeout: 5000 }).toBeGreaterThan(0);
      await checkpoint(`after-${label}-${requireClick ? 'click' : 'touch'}`);
    };
    try {
      await page.goto(
        `http://127.0.0.1:${server.address().port}/video-edit.html?variant=${variant}`,
      );
      await page.waitForFunction('globalThis.ready');
      const initial = await checkpoint('initial');
      stage = scenario;
      if (scenario === 'tap-only') {
        result.semantics = 'Click-delivery control only; no history exists to undo.';
        await tap('Undo');
        assert.deepEqual((await state()).content, initial.content);
      } else if (scenario === 'rapid-tap') {
        for (let i = 0; i < 4; i++) {
          await tap('Select clip a', false); // Selection occurs on pointerdown and rerenders its button.
          await tap('Select clip v', false);
        }
        const after = await checkpoint('after-repeated-taps');
        assert.deepEqual(after.content, initial.content);
        assert.deepEqual(after.revision, initial.revision);
        assert.equal(after.inputs.dirty, 0);
        assert.equal(after.canUndo, initial.canUndo);
        assert.equal(await page.getByLabel('Selected clip', { exact: true }).inputValue(), 'v');
      } else if (scenario === 'mouse-keyboard') {
        const p = await center(button('Move selected clip'));
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.move(p.x + 20, p.y, { steps: 3 });
        await page.mouse.up();
        const mid = await state();
        assert.equal(mid.revision.sequence, initial.revision.sequence + 1);
        await button('Move selected clip').press('ArrowRight');
        assert.equal((await state()).revision.sequence, mid.revision.sequence + 1);
        await button('Undo').press('Enter');
        assert.deepEqual((await state()).content, mid.content);
        await button('Undo').press('Enter');
        assert.deepEqual((await state()).content, initial.content);
      } else {
        let before = initial,
          redoContent;
        if (scenario.startsWith('cancel-redo')) {
          await drag('Move selected clip', { steps: 1 });
          const candidate = await checkpoint('redo-candidate');
          redoContent = candidate.content;
          if (productPacedOnly) {
            assert.notDeepEqual(candidate.content, initial.content);
            assert.equal(candidate.revision.sequence, initial.revision.sequence + 1);
            assert.equal(candidate.canUndo, true);
          }
          if (scenario.endsWith('keyboard-setup')) {
            result.injection.push({ driver: 'keyboard', action: 'Undo setup via Enter' });
            await button('Undo').press('Enter');
          } else await tap('Undo'); // Preserve original blocking failure separately.
          before = await checkpoint('undo-setup-complete');
          assert.equal(before.canRedo, true);
          if (productPacedOnly) {
            assert.deepEqual(before.content, initial.content);
            assert.equal(before.revision.sequence, initial.revision.sequence + 2);
            assert.equal(before.canUndo, initial.canUndo);
          }
        }
        const trim = ['trim', 'direct-trim', 'trim-cancel'].includes(scenario);
        const cancel =
          ['pointercancel', 'trim-cancel'].includes(scenario) || scenario.startsWith('cancel-redo');
        const label = ['direct-move', 'scroll-interrupt'].includes(scenario)
          ? 'Select clip v'
          : scenario === 'direct-trim'
            ? 'Trim end v'
            : trim
              ? 'Trim selected end'
              : 'Move selected clip';
        const scrollBefore = await page.evaluate('scrollY');
        await drag(label, {
          dx: scenario === 'scroll-interrupt' ? 0 : trim ? -15 : 20,
          dy: scenario === 'outside' ? 100 : scenario === 'scroll-interrupt' ? -125 : 0,
          steps: test.movePoints ?? (scenario === 'scroll-interrupt' ? 5 : 3),
          cancel,
        });
        const after = await checkpoint('after-release');
        assert.equal(after.inputs.dirty, 0);
        if (cancel || scenario === 'scroll-interrupt') {
          assert(
            await page.evaluate(() =>
              globalThis.touchEvidence.events.some(
                (e) => e.type === 'pointercancel' && e.trusted && e.pointerType === 'touch',
              ),
            ),
          );
          assert.deepEqual(after.content, before.content);
          assert.deepEqual(after.revision, before.revision);
          assert.equal(after.canRedo, before.canRedo);
          if (productPacedOnly) assert.equal(after.canUndo, before.canUndo);
          if (scenario === 'scroll-interrupt') {
            const finalScrollY = await page.evaluate('scrollY');
            result.scroll = { beforeSetup: scrollBefore, after: finalScrollY };
            const events = await page.evaluate(() => globalThis.touchEvidence.events);
            assert.notEqual(finalScrollY, events.find((e) => e.type === 'pointerdown').scrollY);
          }
          if (scenario.startsWith('cancel-redo')) {
            await tap('Redo');
            assert.equal((await state()).canRedo, false);
            assert.deepEqual((await state()).content, redoContent);
            if (productPacedOnly) {
              assert.equal((await state()).revision.sequence, before.revision.sequence + 1);
              assert.equal((await state()).canUndo, true);
            }
          }
        } else {
          assert.equal(after.revision.sequence, before.revision.sequence + 1);
          assert.notDeepEqual(after.content, before.content);
          for (const operation of ['Undo', 'Redo']) {
            if (scenario.startsWith('direct-')) {
              result.injection.push({
                driver: 'keyboard',
                action: `${operation} verification via Enter`,
              });
              await button(operation).press('Enter');
            } else await tap(operation);
            await expect
              .poll(async () => (await state()).content)
              .toEqual(operation === 'Undo' ? before.content : after.content);
          }
        }
      }
      if (productPacedOnly) {
        const final = await checkpoint('product-paced-final');
        assert.equal(final.revision.sequence, initial.revision.sequence + 3);
        assert.equal(final.canUndo, true);
        assert.equal(final.canRedo, false);
        assert.equal(final.inputs.dirty, 0);
      }
      assert.deepEqual(result.errors, []);
    } catch (error) {
      result.result = 'FAIL';
      result.failure = { stage, message: String(error) };
    } finally {
      result.finalState = await state();
      result.inputEnd = await page.evaluate(() => {
        const data = globalThis.touchEvidence;
        return {
          events: data.events,
          activePointers: [...data.active],
          captures: [...data.elements].flatMap((element) =>
            [...data.pointers]
              .filter((id) => element.hasPointerCapture?.(id))
              .map((id) => ({
                id,
                connected: element.isConnected,
                text: element.textContent?.slice(0, 80),
              })),
          ),
          scrollY: globalThis.scrollY,
          viewportWidth: innerWidth,
        };
      });
      if (result.inputEnd.activePointers.length || result.inputEnd.captures.length) {
        result.result = 'FAIL';
        result.residualInput = true;
      }
      if (scenario !== 'mouse-keyboard') {
        const events = result.inputEnd.events;
        if (
          !events.some((e) => e.type === 'pointerdown' && e.pointerType === 'touch' && e.trusted) ||
          !events.some(
            (e) =>
              e.type === 'gotpointercapture' &&
              e.pointerType === 'touch' &&
              e.trusted &&
              e.captured,
          )
        ) {
          result.result = 'FAIL';
          result.missingTrustedTouch = true;
        }
      }
      await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
      await context.tracing.stop({ path: path.join(output, `${name}.zip`) });
      await context.close();
      await new Promise((resolve) => server.close(resolve));
      evidence.results.push(result);
      await writeFile(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2));
      console.log(result.result, name, result.failure?.stage || 'complete');
    }
  }
} finally {
  await browser.close();
}
if (evidence.results.some((result) => result.result === 'FAIL')) process.exitCode = 1;
