import { beforeAll, afterAll, it, expect } from 'vitest';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { chromium, type Browser, type Page } from '@playwright/test';
import { time, type VideoContent } from '@editor-platform/video-core';
import { videoTimelineFixture } from './edit-fixture';
import type {} from '../test-host/edit-host';
let browser: Browser, bundle: string, origin: string;
const server = createServer((_q, r) => {
  r.setHeader('Content-Type', 'text/html');
  r.end('<!doctype html><main><p id="host">Host sibling</p></main>');
});
beforeAll(async () => {
  bundle = (
    await build({
      entryPoints: ['packages/video-metadata/test-host/edit-host.ts'],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      minify: true,
    })
  ).outputFiles[0].text;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw Error('server');
  origin = `http://127.0.0.1:${a.port}`;
  browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});
function single(): VideoContent {
  const v = videoTimelineFixture();
  v.sequence.tracks = [v.sequence.tracks[0]];
  const c = v.sequence.clips[0];
  if (c.kind !== 'video') throw Error('fixture');
  delete c.linkGroupId;
  v.sequence.clips = [c, { ...c, id: 'b', start: time(4), duration: time(1), sourceOut: time(3) }];
  return v;
}
async function down(page: Page, label = 'Select clip v') {
  const b = await page.getByRole('button', { name: label, exact: true }).boundingBox();
  if (!b) throw Error('bounds');
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  return p;
}
for (const width of [1280, 390])
  for (const scenario of [
    'drag',
    'cancel-noop',
    'trim-keyboard',
    'playhead',
    'focused-delete',
    'focused-split',
    'modified-shortcut',
    'dirty-focus',
    'overflow',
    'low-fps',
    'reentry',
    'key-reentry',
    'cancel-reentry',
    'pointercancel',
    'invalid-trim',
    'reorder-split-delete',
    'stale',
    'locked',
    'readonly',
    'revoke',
  ] as const)
    it(`${scenario} visual timeline at ${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } }),
        errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      try {
        await page.goto(origin);
        await page.addScriptTag({ content: bundle });
        await page.evaluate(
          ({ mode, saved }) => {
            globalThis.videoTest = startVideoTest(mode, saved);
          },
          {
            mode:
              scenario === 'readonly'
                ? ('readonly' as const)
                : scenario === 'locked'
                  ? ('locked' as const)
                  : ('normal' as const),
            saved: [
              'reorder-split-delete',
              'reentry',
              'key-reentry',
              'cancel-reentry',
              'overflow',
              'low-fps',
            ].includes(scenario)
              ? JSON.stringify(
                  scenario === 'overflow' || scenario === 'low-fps'
                    ? {
                        ...single(),
                        sequence: {
                          ...single().sequence,
                          frameRate:
                            scenario === 'low-fps'
                              ? time(1, Number.MAX_SAFE_INTEGER)
                              : time(30000, 1001),
                        },
                      }
                    : single(),
                )
              : undefined,
          },
        );
        const click = (name: string) => page.getByRole('button', { name, exact: true }).click();
        const original = await page.evaluate(() => videoTest.content());
        if (scenario === 'drag') {
          const p = await down(page);
          await page.mouse.move(p.x + 32, p.y, { steps: 4 });
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(0);
          await page
            .getByRole('button', { name: 'Save native JSON', exact: true })
            .evaluate((b) => (b as HTMLButtonElement).click());
          expect(await page.evaluate(() => videoTest.saveEvidence().writes)).toBe(0);
          await page.mouse.up();
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(1);
          expect(
            (await page.evaluate(() => videoTest.content())).sequence.clips.map((c) => c.start),
          ).toEqual([time(7, 5), time(7, 5)]);
          await click('Undo');
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
          await click('Redo');
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(3);
        } else if (scenario === 'cancel-noop') {
          await click('Move +1 frame');
          await click('Undo');
          const rev = await page.evaluate(() => videoTest.revision());
          const p = await down(page);
          await page.mouse.move(p.x + 32, p.y);
          await page.keyboard.press('Escape');
          await page.mouse.up();
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
          await down(page);
          await page.mouse.up();
          expect(await page.evaluate(() => videoTest.revision())).toEqual(rev);
          expect(await page.evaluate(() => videoTest.canRedo())).toBe(true);
          await page.getByLabel('Timeline zoom', { exact: true }).fill('120');
          expect(await page.evaluate(() => videoTest.revision())).toEqual(rev);
        } else if (scenario === 'trim-keyboard') {
          const p = await down(page, 'Trim start v');
          await page.mouse.move(p.x + 32, p.y);
          await page.mouse.up();
          expect((await page.evaluate(() => videoTest.content())).sequence.clips[0].start).toEqual(
            time(7, 5),
          );
          expect((await page.evaluate(() => videoTest.content())).sequence.clips[1].start).toEqual(
            time(1),
          );
          await click('Undo');
          await page.getByRole('button', { name: 'Trim start v', exact: true }).focus();
          await page.keyboard.press('ArrowRight');
          expect((await page.evaluate(() => videoTest.content())).sequence.clips[0].start).toEqual(
            time(26, 25),
          );
          await click('Undo');
          await page.getByLabel('Trim start (rational seconds)').fill('26/25');
          await click('Apply independent trim');
          expect((await page.evaluate(() => videoTest.content())).sequence.clips[0].start).toEqual(
            time(26, 25),
          );
          await click('Undo');
          await page.getByRole('button', { name: 'Select clip v', exact: true }).focus();
          await page.keyboard.press('ArrowLeft');
          expect((await page.evaluate(() => videoTest.content())).sequence.clips[0].start).toEqual(
            time(24, 25),
          );
        } else if (scenario === 'reorder-split-delete') {
          await click('Move later');
          const v = await page.evaluate(() => videoTest.content());
          expect(v.sequence.clips.find((c) => c.id === 'b')!.start).toEqual(time(1));
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(1);
          await click('Undo');
          await page.getByLabel('Split at sequence frame', { exact: true }).fill('50');
          await click('Split linked clips');
          expect((await page.evaluate(() => videoTest.content())).sequence.clips).toHaveLength(3);
          await page.getByRole('button', { name: 'Select clip clip-1', exact: true }).click();
          await page.keyboard.press('Delete');
          expect((await page.evaluate(() => videoTest.content())).sequence.clips).toHaveLength(2);
          await click('Undo');
          await page.screenshot({ path: `/tmp/video-visual-${width}.png`, fullPage: true });
        } else if (scenario === 'low-fps') {
          expect(
            await page.getByLabel('Split at sequence frame', { exact: true }).inputValue(),
          ).toBe('0');
          expect(await page.locator('section').count()).toBe(1);
          await click('Delete linked clips');
          await click('Undo');
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
        } else if (scenario === 'overflow') {
          const input = page.getByLabel('Split at sequence frame', { exact: true });
          await input.fill('25');
          const rev = await page.evaluate(() => videoTest.revision());
          const selection = await page.getByLabel('Selected clip', { exact: true }).inputValue();
          for (const invalid of ['9007199254740991', '1000000', '-1']) {
            await input.fill(invalid);
            expect(await input.inputValue()).toBe('25');
            await page.getByLabel('Timeline zoom', { exact: true }).fill('100');
            expect(await page.locator('section').count()).toBe(1);
            expect(await page.getByLabel('Selected clip', { exact: true }).inputValue()).toBe(
              selection,
            );
            expect(await page.evaluate(() => videoTest.revision())).toEqual(rev);
          }
          await click('Move +1 frame');
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(1);
        } else if (
          scenario === 'reentry' ||
          scenario === 'key-reentry' ||
          scenario === 'cancel-reentry'
        ) {
          await page.evaluate(
            (scenario) =>
              videoTest.setIntentHook(() => {
                if (scenario === 'cancel-reentry') {
                  document
                    .querySelector('[aria-label="Timeline tracks"]')!
                    .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
                  return;
                }
                document
                  .querySelector<HTMLButtonElement>('[data-id="b"][data-mode="move"]')!
                  .dispatchEvent(
                    new PointerEvent('pointerdown', {
                      bubbles: true,
                      button: 0,
                      pointerId: 99,
                      clientX: 400,
                      clientY: 300,
                    }),
                  );
              }),
            scenario,
          );
          if (scenario === 'key-reentry') {
            await page.getByRole('button', { name: 'Select clip v', exact: true }).focus();
            await page.keyboard.press('ArrowRight');
          } else {
            const p = await down(page);
            await page.mouse.move(p.x + 32, p.y);
            await page.mouse.up();
          }
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(0);
          expect(await page.getByRole('status').textContent()).toContain('Reentry');
          const fresh = await down(page);
          await page.mouse.move(fresh.x + 32, fresh.y);
          await page.mouse.up();
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(1);
          expect((await page.evaluate(() => videoTest.content())).sequence.clips[0].start).toEqual(
            time(7, 5),
          );
        } else if (
          ['focused-delete', 'focused-split', 'dirty-focus', 'modified-shortcut'].includes(scenario)
        ) {
          await click('Split linked clips');
          const split = await page.evaluate(() => videoTest.content());
          if (scenario === 'focused-split')
            await page.getByLabel('Split at sequence frame', { exact: true }).fill('62');
          if (scenario === 'dirty-focus')
            await page.getByLabel('Trim start (rational seconds)').fill('26/25');
          await page.getByRole('button', { name: 'Select clip v', exact: true }).focus();
          for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
          expect(
            await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
          ).toBe('Select clip clip-1');
          const rev = await page.evaluate(() => videoTest.revision());
          if (scenario === 'modified-shortcut') {
            await page.keyboard.press('Alt+ArrowRight');
            await page
              .getByRole('button', { name: 'Select clip clip-1', exact: true })
              .dispatchEvent('keydown', { key: 's', ctrlKey: true, bubbles: true });
          } else await page.keyboard.press(scenario === 'focused-split' ? 's' : 'Delete');
          const after = await page.evaluate(() => videoTest.content());
          if (scenario === 'focused-delete')
            expect(after.sequence.clips.map((c) => c.id)).toEqual(['v', 'a']);
          else if (scenario === 'focused-split') {
            expect(after.sequence.clips).toHaveLength(6);
            expect(after.sequence.clips.find((c) => c.id === 'v')).toEqual(
              split.sequence.clips.find((c) => c.id === 'v'),
            );
          } else {
            expect(after).toEqual(split);
            expect(await page.evaluate(() => videoTest.revision())).toEqual(rev);
            if (scenario === 'dirty-focus')
              expect(await page.getByLabel('Trim start (rational seconds)').inputValue()).toBe(
                '26/25',
              );
          }
        } else if (scenario === 'playhead') {
          const rev = await page.evaluate(() => videoTest.revision());
          await page.getByLabel('Split at sequence frame', { exact: true }).fill('25');
          expect(
            (await page.evaluate(() => videoTest.timelineEvidence())).seekTimes.at(-1),
          ).toEqual(time(1));
          const box = await page.getByLabel('Timeline tracks', { exact: true }).boundingBox();
          await page.mouse.click(box!.x + 160, box!.y + 20);
          expect(
            (await page.evaluate(() => videoTest.timelineEvidence())).seekTimes.at(-1),
          ).toEqual(time(2));
          expect(await page.evaluate(() => videoTest.revision())).toEqual(rev);
        } else if (scenario === 'pointercancel') {
          const p = await down(page);
          await page.mouse.move(p.x + 32, p.y);
          await page.getByLabel('Timeline tracks', { exact: true }).dispatchEvent('pointercancel');
          await page.mouse.up();
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(0);
        } else if (scenario === 'invalid-trim') {
          const p = await down(page, 'Trim start v');
          await page.mouse.move(p.x + 190, p.y);
          await page.mouse.up();
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(0);
          expect(await page.getByRole('status').textContent()).toContain('Empty clip');
        } else if (scenario === 'stale') {
          const p = await down(page);
          await page.mouse.move(p.x + 32, p.y);
          await page.evaluate(() => videoTest.drift());
          await page.mouse.up();
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(1);
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
          expect(await page.getByRole('status').textContent()).toContain('Stale');
        } else if (scenario === 'revoke') {
          const p = await down(page);
          await page.mouse.move(p.x + 32, p.y);
          await page.evaluate(() => videoTest.revoke());
          await page.mouse.up();
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(0);
          expect(await page.locator('section').count()).toBe(0);
        } else {
          const p = await down(page);
          await page.mouse.move(p.x + 32, p.y);
          await page.mouse.up();
          expect((await page.evaluate(() => videoTest.revision())).sequence).toBe(0);
          expect(await page.evaluate(() => videoTest.content())).toEqual(original);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => videoTest.errors)).toEqual([]);
        await page.evaluate(() => videoTest.revoke());
        expect(await page.locator('#host').count()).toBe(1);
      } finally {
        await page.close();
      }
    });
