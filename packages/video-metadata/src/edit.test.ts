import { canonicalJson, contentHash } from '@editor-platform/artifact-core';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { chromium, type Browser } from '@playwright/test';
import { EditorSession } from '@editor-platform/editor-core';
import { time, validateVideoContent } from '@editor-platform/video-core';
import { prepareVideoTimelineEdit, videoTimelineFixture } from './edit';
import type { TestMode } from '../test-host/edit-host';

it('uses valid v0 metadata and exact split IDs/windows; no-op leaves Core redo available', () => {
  const content = videoTimelineFixture(),
    session = new EditorSession(content);
  const snapshot = () => ({
    scope: { artifactId: 'video', sessionId: 'scope', generation: 'one' },
    revision: session.revision,
    content: session.content,
  });
  expect(validateVideoContent(content).valid).toBe(true);
  const split = prepareVideoTimelineEdit(snapshot(), {
    type: 'split',
    clipId: 'v',
    at: time(2),
    rightIds: { v: 'vr', a: 'ar' },
    rightLinkGroupId: 'right',
  });
  session.execute(split.command!);
  expect(session.content.sequence.clips[3]).toMatchObject({
    id: 'ar',
    sampleIn: 144000,
    linkGroupId: 'right',
  });
  expect(session.content.sources).toEqual(content.sources);
  session.undo();
  expect(
    prepareVideoTimelineEdit(snapshot(), { type: 'move', clipId: 'v', delta: time(0) }).command,
  ).toBeNull();
  expect(session.canRedo).toBe(true);
  expect(() =>
    prepareVideoTimelineEdit(snapshot(), {
      type: 'split',
      clipId: 'v',
      at: time(2),
      rightIds: { v: 'vr' },
      rightLinkGroupId: 'right',
    }),
  ).toThrow();
});
let browser: Browser, bundle: string, origin: string;
const server = createServer((_request, response) =>
  response.end('<!doctype html><main><p id="host">Host-owned sibling</p></main>'),
);
beforeAll(async () => {
  bundle = (
    await build({
      entryPoints: ['packages/video-metadata/test-host/edit-host.ts'],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      minify: true,
      keepNames: true,
    })
  ).outputFiles[0].text;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
for (const width of [1280, 390]) {
  it.each([
    'edit-chain',
    'trim-save',
    'invalid',
    'noop-redo',
    'reordered-reopen-noop-redo',
    'stale',
    'locked',
    'readonly',
    'missing-inputs',
    'composition',
    'delayed-save',
    'capture-race',
    'indeterminate',
    'aborted',
  ] as const)('%s domain Surface at ' + width, async (scenario) => {
    const page = await browser.newPage({ viewport: { width, height: 850 } }),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await page.goto(origin);
      await page.addScriptTag({ content: bundle });
      const mode: TestMode =
        scenario === 'capture-race'
          ? 'delayed-save'
          : [
                'locked',
                'readonly',
                'missing-inputs',
                'delayed-save',
                'indeterminate',
                'aborted',
              ].includes(scenario)
            ? (scenario as TestMode)
            : 'normal';
      await page.evaluate((mode) => {
        globalThis.videoTest = globalThis.startVideoTest(mode);
      }, mode);
      const click = (name: string) => page.getByRole('button', { name, exact: true }).click();
      const initial = await page.evaluate(() => videoTest.content());
      if (scenario === 'edit-chain') {
        await click('Move +1 frame');
        expect(
          (await page.evaluate(() => videoTest.content())).sequence.clips.map((c) => c.start),
        ).toEqual([time(26, 25), time(26, 25)]);
        await click('Undo');
        await click('Redo');
        await click('Undo');
        await click('Split linked clips');
        const split = await page.evaluate(() => videoTest.content());
        expect(split.sequence.clips.map((c) => c.id)).toEqual(['v', 'a', 'clip-1', 'clip-2']);
        expect(split.sequence.clips[3]).toMatchObject({ sampleIn: 144000, linkGroupId: 'link-1' });
        await click('Delete linked clips');
        expect(
          (await page.evaluate(() => videoTest.content())).sequence.clips.map((c) => c.id),
        ).toEqual(['clip-1', 'clip-2']);
        await click('Undo');
        await click('Undo');
        expect(await page.evaluate(() => videoTest.content())).toEqual(initial);
        const result = await page.evaluate(() =>
          videoTest.nonUI({ type: 'move', clipId: 'v', delta: { value: 1, timescale: 25 } }),
        );
        expect(result.state).toBe('applied');
        expect(await page.evaluate(() => videoTest.executions())).toBe(4);
      } else if (scenario === 'trim-save') {
        await page.getByLabel('Selected clip').selectOption('a');
        await page.getByLabel('Trim start (rational seconds)').fill('26/25');
        await click('Save native JSON');
        await expect
          .poll(() => page.getByRole('status').textContent())
          .toContain('receipt test-receipt');
        const evidence = await page.evaluate(() => videoTest.saveEvidence());
        expect(evidence.receipt?.state).toBe('committed');
        expect(evidence.receipt?.capture.revision.sequence).toBe(1);
        const saved = JSON.parse(evidence.savedBytes!);
        expect(evidence.receipt?.capture.contentHash).toBe(await contentHash(saved));
        expect(saved.sequence.clips[1].sampleIn).toBe(97920);
        expect(saved.sources).toEqual(initial.sources);
        const before = await page.evaluate(() => videoTest.content());
        await page.evaluate((saved) => {
          videoTest.revoke();
          globalThis.videoTest = startVideoTest('normal', saved);
        }, evidence.savedBytes!);
        expect(await page.evaluate(() => videoTest.content())).toEqual(before);
      } else if (scenario === 'invalid') {
        await page.getByLabel('Trim start (rational seconds)').fill('4');
        await page.getByLabel('Trim end (rational seconds)').fill('2');
        await click('Apply independent trim');
        await click('Save native JSON');
        expect(await page.evaluate(() => videoTest.content())).toEqual(initial);
        expect(await page.evaluate(() => videoTest.saveEvidence().writes)).toBe(0);
        expect(await page.getByLabel('Trim start (rational seconds)').inputValue()).toBe('4');
      } else if (scenario === 'noop-redo') {
        await click('Move +1 frame');
        await click('Undo');
        const revision = await page.evaluate(() => videoTest.revision());
        await page.getByLabel('Trim start (rational seconds)').fill('1/1');
        await click('Apply independent trim');
        expect(await page.evaluate(() => videoTest.revision())).toEqual(revision);
        expect(await page.evaluate(() => videoTest.canRedo())).toBe(true);
        await click('Redo');
        expect((await page.evaluate(() => videoTest.content())).sequence.clips[0].start).toEqual(
          time(26, 25),
        );
      } else if (scenario === 'reordered-reopen-noop-redo') {
        await click('Save native JSON');
        await expect.poll(() => page.evaluate(() => videoTest.saveEvidence().writes)).toBe(1);
        const bytes = (await page.evaluate(() => videoTest.saveEvidence())).savedBytes!;
        // Legal native JSON: reverse every object's property order, including rational time.
        const reordered = JSON.stringify(JSON.parse(bytes), (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).reverse())
            : value,
        );
        expect(reordered).not.toBe(bytes);
        expect(canonicalJson(JSON.parse(reordered))).toBe(canonicalJson(JSON.parse(bytes)));
        await page.evaluate((saved) => {
          videoTest.revoke();
          globalThis.videoTest = startVideoTest('normal', saved);
        }, reordered);
        expect(
          await page.evaluate(() => Object.keys(videoTest.content().sequence.clips[0].start)),
        ).toEqual(['timescale', 'value']);
        await click('Move +1 frame');
        await click('Undo');
        const revision = await page.evaluate(() => videoTest.revision());
        const executions = await page.evaluate(() => videoTest.executions());
        expect(revision.sequence).toBe(2);
        expect(await page.evaluate(() => videoTest.canRedo())).toBe(true);
        await page.evaluate(() =>
          videoTest.nonUI({
            type: 'move',
            clipId: 'v',
            delta: { timescale: 1, value: 0 },
          }),
        );
        expect(await page.evaluate(() => videoTest.revision())).toEqual(revision);
        expect(await page.evaluate(() => videoTest.canRedo())).toBe(true);
        await page.getByLabel('Trim start (rational seconds)').fill('1/1');
        await click('Apply independent trim');
        expect(await page.evaluate(() => videoTest.revision())).toEqual(revision);
        expect(await page.evaluate(() => videoTest.executions())).toBe(executions);
        expect(await page.evaluate(() => videoTest.canRedo())).toBe(true);
        expect(canonicalJson(await page.evaluate(() => videoTest.content()))).toBe(
          canonicalJson(JSON.parse(bytes)),
        );
        await click('Redo');
        expect((await page.evaluate(() => videoTest.content())).sequence.clips[0].start).toEqual(
          time(26, 25),
        );
      } else if (scenario === 'stale') {
        const result = await page.evaluate(() => {
          const snapshot = videoTest.snapshot();
          videoTest.nonUI({ type: 'move', clipId: 'v', delta: { value: 1, timescale: 25 } });
          return videoTest.nonUI({ type: 'delete', clipId: 'v' }, snapshot);
        });
        expect(result.state).toBe('refused');
        await page.getByLabel('Trim start (rational seconds)').fill('2');
        await page.evaluate(() => videoTest.drift());
        await click('Apply independent trim');
        expect(await page.getByRole('status').textContent()).toContain('StaleInput');
        expect(await page.getByLabel('Trim start (rational seconds)').inputValue()).toBe('2');
      } else if (scenario === 'locked') {
        await click('Move +1 frame');
        await click('Split linked clips');
        await click('Delete linked clips');
        expect(await page.evaluate(() => videoTest.content())).toEqual(initial);
        expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(0);
      } else if (scenario === 'readonly' || scenario === 'missing-inputs') {
        expect(
          await page.getByRole('button', { name: 'Move +1 frame', exact: true }).isDisabled(),
        ).toBe(true);
        expect(
          (await page.evaluate(() => videoTest.nonUI({ type: 'delete', clipId: 'v' }))).state,
        ).toBe('refused');
        expect(await page.evaluate(() => videoTest.content())).toEqual(initial);
      } else if (scenario === 'composition') {
        await page.getByLabel('Trim start (rational seconds)').dispatchEvent('compositionstart');
        await click('Save native JSON');
        expect(await page.evaluate(() => videoTest.saveEvidence().writes)).toBe(0);
        await page.getByLabel('Trim start (rational seconds)').dispatchEvent('compositionend');
        await click('Cancel inputs');
      } else if (scenario === 'capture-race') {
        const captured = await page.evaluate(() => videoTest.content());
        await click('Save native JSON');
        await expect.poll(() => page.evaluate(() => videoTest.savePending())).toBe(true);
        await click('Move +1 frame');
        const newer = await page.evaluate(() => videoTest.content());
        expect(await page.getByRole('status').innerText()).toBe('applied');
        await page.evaluate(() => videoTest.releaseSave());
        await expect
          .poll(() => page.evaluate(() => videoTest.saveEvidence().receipt?.state))
          .toBe('committed');
        const evidence = await page.evaluate(() => videoTest.saveEvidence());
        if (evidence.receipt?.state !== 'committed') throw Error('Expected committed receipt');
        expect(evidence.receipt.receipt.adapterReceiptId).toBe('test-receipt');
        expect(JSON.parse(evidence.savedBytes!)).toEqual(captured);
        expect(evidence.receipt?.capture.revision.sequence).toBe(0);
        expect(evidence.receipt.capture.contentHash).toBe(await contentHash(captured));
        expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(1);
        expect(await page.evaluate(() => videoTest.content())).toEqual(newer);
        expect(newer).not.toEqual(captured);
        expect(await page.getByRole('status').innerText()).toBe('applied');
      } else if (scenario === 'delayed-save') {
        await click('Save native JSON');
        await expect.poll(() => page.evaluate(() => videoTest.savePending())).toBe(true);
        const count = await page.evaluate(() => {
          videoTest.revoke();
          videoTest.releaseSave();
          return document.querySelectorAll('section').length;
        });
        expect(count).toBe(0);
        await page.waitForTimeout(30);
        expect(await page.locator('section').count()).toBe(0);
      } else {
        await click('Save native JSON');
        await expect
          .poll(() => page.getByRole('status').textContent())
          .toContain(scenario === 'aborted' ? 'aborted-before-write' : 'indeterminate');
        expect(await page.evaluate(() => videoTest.saveEvidence().savedBytes)).toBeUndefined();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (scenario === 'edit-chain')
        await page.screenshot({ path: `/tmp/video-timeline-${width}.png`, fullPage: true });
      const beforeRevoke = await page.evaluate(() => videoTest.content());
      await page.evaluate(() => {
        const oldButton = document.querySelector<HTMLButtonElement>('section button');
        videoTest.revoke();
        oldButton?.click();
      });
      expect(await page.evaluate(() => videoTest.content())).toEqual(beforeRevoke);
      expect(await page.locator('section').count()).toBe(0);
      expect(await page.locator('#host').count()).toBe(1);
      expect(await page.evaluate(() => videoTest.errors)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
