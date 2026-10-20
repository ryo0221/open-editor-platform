import { test, expect } from '../e2e/fixtures';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { scaleArtifact } from './fixtures';

/** Browser event dispatch to two animation frames, optionally waiting for async page rendering.
 * Excludes driver round trips. Functional assertions below verify that the measured action applied. */
async function response(page: Page, event: string, action: () => Promise<unknown>, ready?: string) {
  await page.evaluate(
    ({ event, ready }) => {
      const scope = window as typeof window & { scaleMeasurement: Promise<number> };
      scope.scaleMeasurement = new Promise((resolve) => {
        window.addEventListener(
          event,
          () => {
            const start = performance.now();
            const check = () =>
              requestAnimationFrame(() => {
                if (ready && !document.querySelector(ready)) {
                  check();
                  return;
                }
                requestAnimationFrame(() => resolve(performance.now() - start));
              });
            check();
          },
          { capture: true, once: true },
        );
      });
    },
    { event, ready },
  );
  await action();
  return page.evaluate(
    () => (window as typeof window & { scaleMeasurement: Promise<number> }).scaleMeasurement,
  );
}
for (const kind of ['slide', 'design', 'whiteboard', 'document', 'data', 'review', 'pdf'])
  test(`${kind} practical-scale production interaction`, async ({ page, browser }, info) => {
    const coldStart = Date.now();
    await page.goto('/');
    if (kind === 'pdf') {
      const pdf = await PDFDocument.create();
      for (let i = 1; i <= 50; i++)
        pdf.addPage([612, 792]).drawText(`Production scale PDF / ${i}`, { x: 50, y: 700 });
      await page.getByRole('button', { name: 'New File Viewer', exact: true }).click();
      // Set up the unchanged 50-page workload through the current source
      // replacement/consent UI. This stays outside the navigation timing loop.
      await page.getByRole('button', { name: 'Replace source', exact: true }).click();
      const replacement = page.getByRole('dialog', { name: 'Replace source', exact: true });
      const chooser = page.waitForEvent('filechooser');
      await replacement
        .getByRole('button', { name: 'Choose replacement file', exact: true })
        .click();
      await (
        await chooser
      ).setFiles({
        name: 'fifty-pages.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
      });
      await replacement
        .getByRole('button', { name: 'Confirm source replacement', exact: true })
        .click();
      await expect(replacement).toHaveCount(0);
      await expect(page.getByLabel('Rendered PDF page 1', { exact: true })).toHaveAttribute(
        'data-rendered',
        'true',
      );
    } else {
      await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
        name: `${kind}-scale.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(scaleArtifact(kind))),
      });
      await expect(page.getByTestId('editor-viewport')).toBeVisible();
    }
    const coldMs = Date.now() - coldStart;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics;
    if (process.env.PROFILE_SCALE) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    const timings: number[] = [];
    if (kind === 'slide' || kind === 'pdf') {
      const label = kind === 'slide' ? 'Next slide' : 'Next PDF page';
      for (let i = 0; i < 22; i++) {
        const t = await response(
          page,
          'click',
          () => page.getByRole('button', { name: label, exact: true }).click(),
          kind === 'pdf'
            ? `canvas[aria-label="Rendered PDF page ${i + 2}"][data-rendered=true]`
            : undefined,
        );
        if (i > 1) timings.push(t);
        await expect(
          page.getByLabel(kind === 'slide' ? 'Current page' : 'PDF page', { exact: true }),
        ).toHaveValue(String(i + 2));
      }
      if (kind === 'pdf') expect(await page.locator('canvas').count()).toBeLessThan(15);
    } else if (kind === 'design' || kind === 'whiteboard') {
      await page
        .getByRole('button', {
          name: kind === 'design' ? 'Layer Frame 0' : 'Layer group 1',
          exact: true,
        })
        .click();
      const canvas = page.getByRole('application');
      await canvas.focus();
      for (let i = 0; i < 22; i++) {
        const t = await response(page, 'keydown', () => page.keyboard.press('ArrowRight'));
        if (i > 1) timings.push(t);
      }
      await expect(page.getByLabel('Element x', { exact: true })).toHaveValue('22');
    } else if (kind === 'document') {
      await page.locator('.ProseMirror p').first().click();
      for (let i = 0; i < 22; i++) {
        const t = await response(page, 'keydown', () => page.keyboard.type('x'));
        if (i > 1) timings.push(t);
      }
      await expect(page.locator('.ProseMirror')).toContainText('x'.repeat(22));
    } else if (kind === 'data') {
      await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '5001');
      expect(await page.getByRole('row').count()).toBeLessThan(50);
      for (let i = 0; i < 22; i++) {
        await page.getByRole('gridcell', { name: 'Metric 1 · record 1', exact: true }).dblclick();
        await page.getByLabel('Edit Metric 1', { exact: true }).fill(String(i + 100));
        const t = await response(page, 'keydown', () =>
          page.getByLabel('Edit Metric 1', { exact: true }).press('Enter'),
        );
        if (i > 1) timings.push(t);
      }
      await expect(
        page.getByRole('gridcell', { name: 'Metric 1 · record 1', exact: true }),
      ).toHaveText('121');
    } else {
      for (let i = 0; i < 22; i++) {
        const index = (i + 1) % 3;
        const t = await response(page, 'click', () =>
          page.getByRole('button', { name: `large-${index}.ts`, exact: false }).click(),
        );
        if (i > 1) timings.push(t);
        await expect(page.locator('.ep-diff-heading')).toContainText(`large-${index}.ts`);
      }
      expect(await page.locator('.ep-diff-row').count()).toBeLessThan(100);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    const targetMs = ['slide', 'review', 'pdf'].includes(kind) ? 500 : 100;
    const result = {
      kind,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingDiffHash: createHash('sha256')
        .update(execFileSync('git', ['diff', '--', 'apps', 'packages']))
        .digest('hex'),
      measuredAt: new Date().toISOString(),
      browser: browser.version(),
      node: process.version,
      platform: platform(),
      cpus: cpus().length,
      memoryGB: Math.round(totalmem() / 1024 ** 3),
      cpuModel: cpus()[0]?.model,
      metricsBefore,
      metricsAfter: (await cdp.send('Performance.getMetrics')).metrics,
      viewport: '1440x900',
      coldMs,
      sampleCount: timings.length,
      p95Ms: +p95.toFixed(1),
      targetMs,
      meetsTarget: p95 <= targetMs,
      samplesMs: timings.map((t) => +t.toFixed(1)),
    };
    await writeFile(info.outputPath(`${kind}.json`), JSON.stringify(result, null, 2));
    if (process.env.PROFILE_SCALE) {
      const { profile } = await cdp.send('Profiler.stop');
      await writeFile(info.outputPath(`${kind}.cpuprofile`), JSON.stringify(profile));
    }
    await cdp.detach();
    console.log(JSON.stringify(result));
    await page.screenshot({ path: info.outputPath(`${kind}.png`) });
    // Performance is recorded honestly; correctness failures fail this suite regardless of timing.
  });
