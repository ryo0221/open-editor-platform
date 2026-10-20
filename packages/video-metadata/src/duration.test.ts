import { beforeAll, afterAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { expect as browserExpect, type Browser } from '@playwright/test';
import { time } from '@editor-platform/video-core';
import { videoTimelineFixture } from './edit';
import type { TestMode } from '../test-host/edit-host';
import { closeServer, launchTestChromium, listenOnLoopback } from '../test-host/browser';
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
  origin = await listenOnLoopback(server);
  browser = await launchTestChromium();
});
afterAll(async () => {
  await browser?.close();
  await closeServer(server);
});

for (const width of [1280, 390])
  for (const scenario of [
    'resize',
    'invalid',
    'save-invalid-draft',
    'noop',
    'dirty-ime',
    'stale',
    'empty',
    'readonly',
    'missing-inputs',
    'revoke',
    'cancel-reenter-invalid',
    'cancel-gesture-reenter-invalid',
    'cancel-invalid-view',
    'save-delayed-input-error',
    'save-delayed-current-error',
    'save-delayed-current-draft',
    'save-delayed-current-dispose',
    'save-delayed-current-revoke',

    'save-delayed-new-draft',
    'save-delayed-cancel',
    'save-delayed-new-scope',
    'reenter-trim',
    'reenter-duration',
    'reenter-composition',
  ] as const)
    it(`sequence duration ${scenario} at ${width}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } }),
        errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      try {
        await page.goto(origin);
        await page.addScriptTag({ content: bundle });
        const fixture = videoTimelineFixture();
        if (scenario === 'empty') fixture.sequence.clips = [];
        const mode: TestMode =
          scenario === 'readonly' || scenario === 'missing-inputs'
            ? scenario
            : scenario.startsWith('save-delayed-')
              ? 'delayed-save'
              : 'normal';
        await page.evaluate(
          ({ mode, saved }) => {
            globalThis.videoTest = startVideoTest(mode, saved);
          },
          {
            mode,
            saved: JSON.stringify(fixture),
          },
        );
        const input = page.getByLabel('Sequence duration (rational seconds)', { exact: true });
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const read = () =>
          page.evaluate(() => ({
            content: videoTest.content(),
            revision: videoTest.revision(),
            redo: videoTest.canRedo(),
          }));
        const initial = await read();
        if (scenario === 'readonly' || scenario === 'missing-inputs') {
          await browserExpect(input).toBeDisabled();
          await browserExpect(button('Apply sequence duration')).toBeDisabled();
          await input.evaluate((el) => {
            (el as HTMLInputElement).value = '3';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          });
          await button('Apply sequence duration').evaluate((el) =>
            el.dispatchEvent(new MouseEvent('click', { bubbles: true })),
          );
          expect(await read()).toEqual(initial);
        } else if (scenario === 'save-invalid-draft') {
          await input.fill('1');
          await button('Save native JSON').click();
          await browserExpect(page.getByRole('status')).toContainText('Clip exceeds sequence');
          expect(await read()).toEqual(initial);
          expect(await input.inputValue()).toBe('1');
          expect((await page.evaluate(() => videoTest.getInputsSnapshot())).dirty).toBe(1);
          expect((await page.evaluate(() => videoTest.saveEvidence())).writes).toBe(0);
        } else if (scenario.startsWith('save-delayed-current-')) {
          await button('Save native JSON').click();
          await browserExpect.poll(() => page.evaluate(() => videoTest.savePending())).toBe(true);
          const observed = await page.evaluate(async (action) => {
            const status = document.querySelector('[role="status"]')!;
            const field = (name: string) =>
              [...document.querySelectorAll('label')]
                .find((label) => label.textContent!.startsWith(name))!
                .querySelector('input')!;
            const duration = field('Sequence duration');
            let calls = 0;
            let innerStatus: string | null = null;
            videoTest.setSaveCurrentHook(() => {
              calls++;
              if (action === 'error') {
                field('Split at sequence frame').value = 'not-frame';
                [...document.querySelectorAll('button')]
                  .find((button) => button.textContent === 'Split linked clips')!
                  .click();
              } else if (action === 'draft') {
                duration.value = '8';
                duration.dispatchEvent(new Event('input', { bubbles: true }));
              } else if (action === 'dispose') videoTest.disposeSurface();
              else videoTest.revoke();
              innerStatus = status.textContent;
            });
            videoTest.releaseSave();
            const deadline = Date.now() + 1000;
            while (calls === 0) {
              if (Date.now() >= deadline) throw Error('Save continuation hook did not run');
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            // Include the Save continuation and its rejection handler.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return {
              calls,
              innerStatus,
              finalStatus: status.textContent,
              connected: status.isConnected,
              duration: duration.value,
              dirty: videoTest.getInputsSnapshot().dirty,
              evidence: videoTest.saveEvidence(),
            };
          }, scenario.slice('save-delayed-current-'.length));
          expect(observed.calls).toBe(1);
          expect(observed.evidence.receipt?.state).toBe('committed');
          expect(observed.evidence.receipt?.capture.revision).toEqual(initial.revision);
          expect(JSON.parse(observed.evidence.savedBytes!)).toEqual(initial.content);
          expect(observed.evidence.writes).toBe(1);
          expect(await read()).toEqual(initial);
          expect(observed.finalStatus).toBe(observed.innerStatus);
          if (scenario.endsWith('-error')) {
            expect(observed.innerStatus).toContain('Invalid split frame');
            expect(observed.dirty).toBe(0);
          } else if (scenario.endsWith('-draft')) {
            expect(observed.duration).toBe('8');
            expect(observed.dirty).toBe(1);
            await browserExpect(button('Cancel inputs')).toBeEnabled();
          } else expect(observed.connected).toBe(false);
        } else if (scenario.startsWith('save-delayed-')) {
          await button('Save native JSON').click();
          await browserExpect.poll(() => page.evaluate(() => videoTest.savePending())).toBe(true);
          if (scenario === 'save-delayed-new-scope') {
            const retired = await page.evaluate(async () => {
              const old = videoTest;
              old.revoke();
              videoTest = startVideoTest('normal');
              old.releaseSave();
              const deadline = Date.now() + 1000;
              while (!old.saveEvidence().receipt) {
                if (Date.now() >= deadline) throw Error('Retired Save did not settle');
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              return old.saveEvidence();
            });
            expect(retired.receipt?.state).toBe('committed');
            expect((await read()).revision.sessionId).not.toBe(initial.revision.sessionId);
            expect((await read()).revision.sequence).toBe(0);
            expect((await read()).content).toEqual(initial.content);
            expect(await page.getByRole('status').innerText()).toBe('');
          } else {
            const draftValue = scenario === 'save-delayed-new-draft' ? '8' : 'not-time';
            await input.fill(draftValue);
            if (scenario !== 'save-delayed-new-draft') {
              await button('Apply sequence duration').click();
              const refused = await page.getByRole('status').innerText();
              expect(refused).toContain('Use integer seconds or numerator/denominator seconds');
            }
            if (scenario === 'save-delayed-cancel') await button('Cancel inputs').click();
            const latest = await page.getByRole('status').innerText();
            await page.evaluate(() => videoTest.releaseSave());
            await browserExpect
              .poll(() => page.evaluate(() => videoTest.saveEvidence().receipt?.state))
              .toBe('committed');
            expect(await read()).toEqual(initial);
            expect((await page.evaluate(() => videoTest.getInputsSnapshot())).dirty).toBe(
              scenario === 'save-delayed-cancel' ? 0 : 1,
            );
            expect(await input.inputValue()).toBe(
              scenario === 'save-delayed-cancel' ? '6/1' : draftValue,
            );
            expect(await page.getByRole('status').innerText()).toBe(latest);
          }
        } else if (scenario.startsWith('cancel-')) {
          if (scenario === 'cancel-gesture-reenter-invalid') {
            await button('Move selected clip').scrollIntoViewIfNeeded();
            const box = (await button('Move selected clip').boundingBox())!;
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            expect((await page.evaluate(() => videoTest.getInputsSnapshot())).dirty).toBe(1);
          } else {
            await input.fill('2');
            await button('Apply sequence duration').click();
            await browserExpect(page.getByRole('status')).toContainText('Clip exceeds sequence');
          }
          expect(await read()).toEqual(initial);
          await page.evaluate((invalidView) => {
            const stop = videoTest.subscribeInputs(() => {
              stop();
              if (invalidView) {
                // Fault injection into the supplied controller double: a Host
                // notification leaves invalid content for the next render.
                const view = videoTest.controllerSnapshot();
                if (view.state !== 'open') throw Error('Expected open test controller');
                view.snapshot.content.sequence.duration = { value: 0, timescale: 1 };
                return;
              }
              const field = [...document.querySelectorAll('label')]
                .find((label) => label.textContent?.startsWith('Sequence duration'))!
                .querySelector('input')!;
              field.value = '1';
              field.dispatchEvent(new Event('input', { bubbles: true }));
              [...document.querySelectorAll('button')]
                .find((candidate) => candidate.textContent === 'Apply sequence duration')!
                .click();
            });
          }, scenario === 'cancel-invalid-view');
          if (scenario === 'cancel-gesture-reenter-invalid') {
            await button('Cancel inputs').press('Enter');
            await page.mouse.up();
          } else await button('Cancel inputs').click();
          const status = await page.getByRole('status').innerText();
          if (scenario !== 'cancel-invalid-view') {
            expect(await input.inputValue()).toBe('1');
            expect((await page.evaluate(() => videoTest.getInputsSnapshot())).dirty).toBe(1);
            await browserExpect(button('Cancel inputs')).toBeEnabled();
            expect(await read()).toEqual(initial);
            expect(status).toContain('Clip exceeds sequence');
          } else {
            expect(await read()).toEqual(initial);
            expect((await page.evaluate(() => videoTest.getInputsSnapshot())).dirty).toBe(0);
            await browserExpect(button('Apply sequence duration')).toBeDisabled();
            expect(status).toContain('First validation failure:');
          }
          expect(status).not.toBe('Inputs cancelled');
        } else if (scenario.startsWith('reenter-')) {
          const innerDuration = scenario === 'reenter-duration';
          await page.evaluate(
            ({ innerDuration, composition }) => {
              videoTest.setIntentHook(() => {
                const field = [...document.querySelectorAll('label')]
                  .find((label) =>
                    label.textContent?.startsWith(
                      innerDuration ? 'Sequence duration' : 'Trim start',
                    ),
                  )!
                  .querySelector('input')!;
                field.value = innerDuration ? '3' : '26/25';
                if (composition) field.dispatchEvent(new Event('compositionstart'));
                field.dispatchEvent(new Event('input', { bubbles: true }));
              });
            },
            { innerDuration, composition: scenario === 'reenter-composition' },
          );
          const trim = page.getByLabel('Trim start (rational seconds)');
          await (innerDuration ? trim : input).fill(innerDuration ? '26/25' : '3');
          await browserExpect(page.getByRole('status')).toContainText('input rejected');
          await browserExpect(innerDuration ? input : trim).toHaveValue(
            innerDuration ? '3' : '26/25',
          );
          await browserExpect(
            button(innerDuration ? 'Apply independent trim' : 'Apply sequence duration'),
          ).toBeDisabled();
          expect(await read()).toEqual(initial);
          if (scenario === 'reenter-composition') {
            await button('Apply independent trim').click();
            expect(await read()).toEqual(initial);
            await trim.dispatchEvent('compositionend');
          }
          await button(
            innerDuration ? 'Apply sequence duration' : 'Apply independent trim',
          ).click();
          const applied = await read();
          expect(applied.revision.sequence).toBe(1);
          expect(await page.evaluate(() => videoTest.executions())).toBe(1);
          expect(applied.content.sequence.duration).toEqual(time(innerDuration ? 3 : 6));
          expect(applied.content.sequence.clips[0].start).toEqual(
            innerDuration ? time(1) : time(26, 25),
          );
          await button('Undo').click();
          expect((await read()).content).toEqual(initial.content);
          await button('Redo').click();
          expect((await read()).content).toEqual(applied.content);
        } else if (scenario === 'revoke') {
          await input.fill('3');
          await page.evaluate(() => videoTest.revoke());
          await browserExpect(input).toHaveCount(0);
          expect(await read()).toEqual(initial);
        } else if (scenario === 'stale') {
          await input.fill('3');
          await page.evaluate(() => videoTest.drift());
          const drifted = await read();
          await button('Apply sequence duration').click();
          expect(await read()).toEqual(drifted);
          await browserExpect(input).toHaveValue('3');
          await browserExpect(page.getByRole('status')).toContainText('StaleInput');
        } else if (scenario === 'dirty-ime') {
          await page.getByLabel('Trim start (rational seconds)').fill('26/25');
          await browserExpect(input).toBeDisabled();
          await browserExpect(button('Apply sequence duration')).toBeDisabled();
          await button('Cancel inputs').click();
          await input.fill('3');
          await browserExpect(page.getByLabel('Trim start (rational seconds)')).toBeDisabled();
          await browserExpect(button('Apply independent trim')).toBeDisabled();
          await button('Move +1 frame').click();
          await button('Undo').click();
          expect(await read()).toEqual(initial);
          await input.dispatchEvent('compositionstart');
          await button('Apply sequence duration').click();
          await button('Save native JSON').click();
          expect(await read()).toEqual(initial);
          expect(await page.evaluate(() => videoTest.saveEvidence().writes)).toBe(0);
          await input.dispatchEvent('compositionend');
          await button('Save native JSON').click();
          await browserExpect
            .poll(() => page.evaluate(() => videoTest.saveEvidence().writes))
            .toBe(1);
          expect((await read()).revision.sequence).toBe(1);
          expect((await read()).content.sequence.duration).toEqual(time(3));
        } else if (scenario === 'invalid') {
          for (const value of ['2', '-1', '0', '1/0', '86401', 'not-time']) {
            await input.fill(value);
            await button('Apply sequence duration').click();
            expect(await read()).toEqual(initial);
            await browserExpect(input).toHaveValue(value);
            await button('Save native JSON').click();
            expect(await page.evaluate(() => videoTest.saveEvidence().writes)).toBe(0);
            expect(await read()).toEqual(initial);
          }
          await input.fill('2');
          await button('Apply sequence duration').click();
          await browserExpect(page.getByRole('status')).toContainText('Clip exceeds sequence');
          const beforeCancel = await read();
          expect(beforeCancel).toEqual(initial);
          await button('Cancel inputs').click();
          await browserExpect(input).toHaveValue('6/1');
          expect(await page.getByRole('status').innerText()).toBe('Inputs cancelled');
          await browserExpect(button('Cancel inputs')).toBeDisabled();
          expect(await read()).toEqual(beforeCancel);
        } else if (scenario === 'noop') {
          await button('Move +1 frame').click();
          await button('Undo').click();
          const before = await read();
          await input.fill('6');
          await button('Apply sequence duration').click();
          expect(await read()).toEqual(before);
          await button('Redo').click();
          expect((await read()).content.sequence.clips[0].start).toEqual(time(26, 25));
        } else {
          await input.fill(scenario === 'empty' ? '1' : '3');
          await button('Apply sequence duration').click();
          const resized = await read();
          expect(resized.revision.sequence).toBe(1);
          expect(resized.content.sequence.duration).toEqual(time(scenario === 'empty' ? 1 : 3));
          expect(resized.content.sequence.clips).toEqual(initial.content.sequence.clips);
          expect(resized.content.sources).toEqual(initial.content.sources);
          await button('Undo').click();
          expect((await read()).content).toEqual(initial.content);
          await button('Redo').click();
          expect((await read()).content).toEqual(resized.content);
          await input.fill('10');
          await button('Apply sequence duration').click();
          expect((await read()).content.sequence.duration).toEqual(time(10));
        }
        expect(errors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } finally {
        await page.close();
      }
    });
