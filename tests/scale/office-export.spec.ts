import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { SlideContent } from '@editor-platform/slide/model';
import { test, expect } from '../e2e/fixtures';
import {
  importOfficeDeck,
  openPptx,
  preparePptx,
  acceptPptx,
  officeDownload,
} from '../e2e/office-fixtures';
import { scaleArtifact } from './fixtures';

type Observation = {
  longTasks: { start: number; duration: number }[];
  heap?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
};
async function observe(page: Page) {
  await page.evaluate(() => {
    const data: Observation = { longTasks: [] };
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        data.longTasks.push({ start: e.startTime, duration: e.duration });
    });
    observer.observe({ type: 'longtask' });
    Object.assign(window, {
      officeObservation: () => {
        for (const e of observer.takeRecords())
          data.longTasks.push({ start: e.startTime, duration: e.duration });
        observer.disconnect();
        const heap = (performance as Performance & { memory?: Observation['heap'] }).memory;
        if (heap)
          data.heap = {
            usedJSHeapSize: heap.usedJSHeapSize,
            totalJSHeapSize: heap.totalJSHeapSize,
            jsHeapSizeLimit: heap.jsHeapSizeLimit,
          };
        return structuredClone(data);
      },
    });
  });
}
async function finishObservation(page: Page) {
  return page.evaluate(() =>
    (window as typeof window & { officeObservation: () => Observation }).officeObservation(),
  );
}

for (const fixture of ['standard-50x20', 'images-8x8'])
  test(`G14 ${fixture} cold/warm/cancel`, async ({ page, browser, context, baseURL }, info) => {
    test.setTimeout(180000);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    let content = scaleArtifact('slide').draft.content as SlideContent;
    let manifest: unknown;
    let imageRequests = 0;
    if (fixture === 'images-8x8') {
      const root = process.env.OFFICE_SCALE_IMAGES ?? '/tmp/office-scale-images';
      manifest = JSON.parse(await readFile(root + '/manifest.json', 'utf8'));
      const images = await Promise.all(
        Array.from({ length: 8 }, (_, i) => readFile(`${root}/image-${i}.png`)),
      );
      await context.route('**/office-scale-image-*.png', async (route) => {
        imageRequests++;
        const i = Number(/image-(\d+)\.png/.exec(route.request().url())![1]);
        await route.fulfill({
          contentType: 'image/png',
          headers: { 'Cache-Control': 'no-store' },
          body: images[i],
        });
      });
      content = {
        schemaVersion: 2,
        width: 1600,
        height: 900,
        slides: Array.from({ length: 8 }, (_, p) => ({
          id: `page-${p}`,
          title: `画像 ${p + 1}`,
          background: '#ffffff',
          objects: [
            {
              id: `p${p}-title`,
              type: 'text',
              text: `画像を含む資料 ${p + 1}`,
              fill: '#253044',
              bounds: { x: 30, y: 25, width: 1000, height: 60 },
              typography: { fontSize: 28 },
            },
            ...images.map((_, i) => ({
              id: `p${p}-image-${i}`,
              type: 'image' as const,
              text: '',
              fill: 'none',
              src: new URL(`/office-scale-image-${i}.png`, baseURL).href,
              bounds: {
                x: 30 + (i % 4) * 390,
                y: 130 + Math.floor(i / 4) * 370,
                width: 350,
                height: 280,
              },
            })),
          ],
        })),
      };
    }
    await importOfficeDeck(page, content);
    const cdp = await browser.newBrowserCDPSession();
    const memorySamples: { at: number; residentBytes: number; processes: number }[] = [];
    const started = performance.now();
    const sample = async () => {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      let residentBytes = 0,
        processes = 0;
      for (const p of processInfo) {
        const status = await readFile(`/proc/${p.id}/status`, 'utf8').catch(() => null);
        const kb = status && /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
        if (kb) {
          residentBytes += Number(kb) * 1024;
          processes++;
        }
      }
      memorySamples.push({ at: performance.now() - started, residentBytes, processes });
    };
    await sample();
    let activeSample: Promise<void> | undefined;
    const memoryErrors: string[] = [];
    const interval = setInterval(() => {
      if (!activeSample)
        activeSample = sample()
          .catch((e) => {
            memoryErrors.push(String(e));
          })
          .finally(() => {
            activeSample = undefined;
          });
    }, 200);
    const samples: unknown[] = [];
    let dialog: Awaited<ReturnType<typeof openPptx>> | undefined;
    try {
      for (const mode of ['cold', 'warm']) {
        await observe(page);
        const start = performance.now(),
          beforeRequests = imageRequests;
        dialog ??= await openPptx(page);
        await preparePptx(dialog);
        const prepareMs = performance.now() - start;
        await acceptPptx(dialog);
        const encodeStart = performance.now();
        const bytes = await officeDownload(page, dialog, 'Download PPTX');
        const encodeMs = performance.now() - encodeStart;
        const observation = await finishObservation(page);
        samples.push({
          mode,
          prepareMs,
          encodeMs,
          totalMs: prepareMs + encodeMs,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          imageRequests: imageRequests - beforeRequests,
          ...observation,
        });
        await writeFile(info.outputPath(`${mode}.pptx`), bytes);
        await writeFile(
          info.outputPath('partial-scale.json'),
          JSON.stringify({ commit, fixture, samples, memorySamples }, null, 2),
        );
      }
      await preparePptx(dialog!);
      await acceptPptx(dialog!);
      const lateFiles: string[] = [];
      page.on('download', (d) => lateFiles.push(d.suggestedFilename()));
      await observe(page);
      await dialog!.getByRole('button', { name: 'Download PPTX', exact: true }).click();
      const cancelStart = performance.now();
      await dialog!.getByRole('button', { name: 'Cancel export', exact: true }).click();
      await expect(dialog!.getByRole('alert')).toContainText('Export cancelled');
      const cancelMs = performance.now() - cancelStart;
      // Observe past the responsiveness budget to detect a late partial download.
      await page.waitForTimeout(1200);
      const cancelled = {
        mode: 'cancel',
        cancelMs,
        lateFiles,
        observation: await finishObservation(page),
      };
      samples.push(cancelled);
      clearInterval(interval);
      await activeSample;
      await sample();
      const result = {
        commit,
        fixture,
        sample: process.env.OFFICE_SCALE_REPEAT ?? 'diagnostic',
        browser: browser.version(),
        node: process.version,
        os: {
          platform: platform(),
          release: release(),
          cpu: cpus()[0]?.model,
          hostMemory: totalmem(),
          cpuMax: await readFile('/sys/fs/cgroup/cpu.max', 'utf8'),
          memoryMax: await readFile('/sys/fs/cgroup/memory.max', 'utf8'),
        },
        source: {
          slides: content.slides.length,
          objects: content.slides.reduce((n, p) => n + p.objects.length, 0),
        },
        manifest,
        samples,
        memorySamples,
        note: 'Cold is the first Office action in a fresh browser context. Warm reuses the same worker/fonts/encoder. Times include driver overhead but exclude automated consent between prepare/encode. RSS sums browser processes and may double-count shared pages; JS heap is main-page only. Image fixture is reported separately.',
      };
      await writeFile(info.outputPath('office-scale.json'), JSON.stringify(result, null, 2));
      const output = samples as {
        mode: string;
        totalMs?: number;
        longTasks?: { duration: number }[];
      }[];
      for (const s of output.filter((s) => s.mode !== 'cancel')) {
        if (fixture === 'standard-50x20')
          expect(s.totalMs).toBeLessThanOrEqual(s.mode === 'cold' ? 15000 : 10000);
        expect(s.longTasks!.filter((t) => t.duration > 500)).toEqual([]);
      }
      expect(cancelMs).toBeLessThanOrEqual(1000);
      expect(lateFiles).toEqual([]);
      expect(memoryErrors).toEqual([]);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(commit);
    } finally {
      clearInterval(interval);
      await activeSample;
      await cdp.detach();
    }
  });
