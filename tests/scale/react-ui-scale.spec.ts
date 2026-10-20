import { test, expect } from '../e2e/fixtures';
import type { Locator, Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ReactUiDocument } from '@editor-platform/react-ui-core';

type InstrumentedWindow = typeof window & {
  scaleBenchmark: { snapshot(): ReactUiDocument };
  scaleTiming: Promise<number>;
  scaleNavigation: Promise<number>;
};
const iframe = (page: Page) => page.locator('iframe[title="React component preview"]');
async function ready(page: Page) {
  await expect(iframe(page)).toHaveAttribute('aria-busy', 'false');
}
async function snapshot(page: Page) {
  return page.evaluate(() => (window as InstrumentedWindow).scaleBenchmark.snapshot());
}
async function timeAction(
  page: Page,
  control: Locator,
  event: string,
  action: () => Promise<unknown>,
  save = false,
) {
  await control.evaluate(
    (element, { event, save }) => {
      (window as InstrumentedWindow).scaleTiming = new Promise<number>((resolve, reject) => {
        element.addEventListener(
          event,
          () => {
            const start = performance.now();
            let busy = false;
            const target = save
              ? document.querySelector('[aria-label="Host save state"]')!
              : document.querySelector('iframe[title="React component preview"]')!;
            const saved = target.getAttribute('data-saved-sequence');
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(Error('No exact preview/save completion'));
            }, 20000);
            const observer = new MutationObserver(() => {
              if (!save && target.getAttribute('aria-busy') === 'true') busy = true;
              const done = save
                ? target.getAttribute('data-saved-sequence') !== saved
                : busy && target.getAttribute('aria-busy') === 'false';
              if (!done) return;
              observer.disconnect();
              clearTimeout(timer);
              if (save) resolve(performance.now() - start);
              else
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve(performance.now() - start)),
                );
            });
            observer.observe(target, { attributes: true });
          },
          { capture: true, once: true },
        );
      });
    },
    { event, save },
  );
  await action();
  return page.evaluate(() => (window as InstrumentedWindow).scaleTiming);
}
for (const width of [390, 1024, 1400]) {
  test(`React UI 21 components / 500 nodes / depth 4 at ${width}`, async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(600000);
    const fixtureBytes = await readFile('work/complete24/fixture.json');
    const fixed = JSON.parse(fixtureBytes.toString());
    await page.addInitScript(
      ({ width }) => {
        if (window.top !== window) return;
        (window as InstrumentedWindow).scaleNavigation = new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            const frame = document.querySelector('iframe[title="React component preview"]');
            if (
              frame?.getAttribute('width') !== String(width) ||
              frame.getAttribute('aria-busy') !== 'false'
            )
              return;
            observer.disconnect();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
          });
          observer.observe(document, { childList: true, subtree: true, attributes: true });
        });
      },
      { width },
    );
    async function navigate(reload = false) {
      if (reload) await page.reload();
      else await page.goto('/');
      await ready(page);
      if (width !== 390) {
        await page.getByLabel('Preview width', { exact: true }).selectOption(String(width));
        await ready(page);
      }
      return page.evaluate(() => (window as InstrumentedWindow).scaleNavigation);
    }
    const initialMs = await navigate();
    expect(await snapshot(page)).toEqual(fixed);
    const frame = page.frameLocator('iframe[title="React component preview"]');
    await expect(frame.locator('[data-react-ui-node]')).toHaveCount(500);
    const metrics: {
      name: string;
      budgetMs: number;
      targetMs: number;
      warmups: number;
      samples: number[];
      p95Ms: number | null;
      maxMs: number;
    }[] = [];
    function report(
      name: string,
      budgetMs: number,
      targetMs: number,
      samples: number[],
      warmups = 5,
    ) {
      const sorted = samples.slice(warmups).sort((a, b) => a - b);
      metrics.push({
        name,
        budgetMs,
        targetMs,
        warmups,
        samples,
        p95Ms: warmups ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
        maxMs: Math.max(...sorted),
      });
    }
    report('initial', 5000, 2500, [initialMs], 0);
    const prop = page.getByLabel('Prop text', { exact: true });
    const propSamples = [];
    await prop.focus();
    for (let i = 0; i < 25; i++)
      propSamples.push(await timeAction(page, prop, 'input', () => page.keyboard.type('x')));
    await expect(frame.locator('[data-react-ui-node="leaf-000"]')).toHaveText(
      'Item 0' + 'x'.repeat(25),
    );
    report('prop-preview', 100, 50, propSamples);
    await page.getByLabel('Target slot', { exact: true }).selectOption({ label: 'card-0 / body' });
    const insert = page.getByRole('button', { name: 'Insert Text', exact: true });
    const insertSamples = [];
    for (let i = 0; i < 25; i++) {
      insertSamples.push(await timeAction(page, insert, 'click', () => insert.click()));
      await expect(page.getByLabel('Node count', { exact: true })).toHaveText('501');
      await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
      await ready(page);
      await expect(page.getByLabel('Node count', { exact: true })).toHaveText('500');
    }
    report('insert-preview', 100, 50, insertSamples);
    await page.getByRole('button', { name: 'leaf-001 · Heading', exact: true }).click();
    const moveUp = page.getByRole('button', { name: 'Move up', exact: true });
    const moveDown = page.getByRole('button', { name: 'Move down', exact: true });
    const moveSamples = [];
    for (let i = 0; i < 25; i++) {
      moveSamples.push(await timeAction(page, moveUp, 'click', () => moveUp.click()));
      expect((await snapshot(page)).nodes.find((n) => n.id === 'card-0')!.slots.body[0]).toBe(
        'leaf-001',
      );
      await moveDown.click();
      await ready(page);
    }
    report('move-preview', 100, 50, moveSamples);
    await page.getByRole('button', { name: 'leaf-000 · Text', exact: true }).click();
    const undo = page.getByRole('button', { name: 'Host Undo', exact: true });
    const undoSamples = [];
    const beforeUndo = await snapshot(page);
    for (let i = 0; i < 25; i++) {
      await prop.fill(`Undo candidate ${i}`);
      await ready(page);
      undoSamples.push(await timeAction(page, undo, 'click', () => undo.click()));
      expect(await snapshot(page)).toEqual(beforeUndo);
    }
    report('undo-preview', 100, 50, undoSamples);
    const select = page.getByLabel('Preview width', { exact: true });
    const widthSamples = [];
    for (let i = 0; i < 25; i++) {
      await select.selectOption(String(width === 390 ? 1024 : 390));
      await ready(page);
      widthSamples.push(
        await timeAction(page, select, 'change', () => select.selectOption(String(width))),
      );
      await expect(iframe(page)).toHaveAttribute('width', String(width));
    }
    report('width-preview', 500, 250, widthSamples);
    const save = page.getByRole('button', { name: 'Host Save', exact: true });
    const saveSamples = [];
    for (let i = 0; i < 25; i++)
      saveSamples.push(await timeAction(page, save, 'click', () => save.click(), true));
    report('save', 1000, 500, saveSamples);
    const saved = await snapshot(page);
    const reloadSamples = [];
    for (let i = 0; i < 25; i++) {
      reloadSamples.push(await navigate(true));
      expect(await snapshot(page)).toEqual(saved);
      await expect(frame.locator('[data-react-ui-node]')).toHaveCount(500);
    }
    report('reload', 5000, 2500, reloadSamples);
    await page.screenshot({ path: info.outputPath('scale.png') });
    const result = {
      kind: 'browser',
      width,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      measuredAt: new Date().toISOString(),
      browser: browser.version(),
      node: process.version,
      fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
      metrics,
    };
    await writeFile(info.outputPath('results.json'), JSON.stringify(result, null, 2));
    for (const metric of metrics)
      expect
        .soft(metric.p95Ms ?? metric.maxMs, `${width}/${metric.name}`)
        .toBeLessThanOrEqual(metric.budgetMs);
  });
}
