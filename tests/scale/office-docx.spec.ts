import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { DocumentContent } from '@editor-platform/document/model';
import { test, expect } from '../e2e/fixtures';
import {
  importOfficeDocument,
  openDocx,
  prepareDocx,
  acceptDocx,
} from '../e2e/office-docx-fixtures';
import { officeDownload } from '../e2e/office-fixtures';
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

for (const fixture of ['standard-200-blocks', 'images-64-8unique'])
  test(`D12 ${fixture} cold/warm/cancel`, async ({ page, browser, context, baseURL }, info) => {
    test.setTimeout(180000);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const workingDiffSha256 = createHash('sha256')
      .update(execFileSync('git', ['diff', 'HEAD', '--', '.']))
      .digest('hex');
    let content = scaleArtifact('document').draft.content as DocumentContent;
    // D12 is a DOCX fixture: use a supported PNG for the five image blocks.
    // The original #6 interaction fixture (including its SVGs) is measured separately.
    const standardPng = (await readFile('tests/fixtures/office/images/quadrants.png')).toString(
      'base64',
    );
    content = {
      ...content,
      blocks: content.blocks.map((b) =>
        b.type === 'image' ? { ...b, src: 'data:image/png;base64,' + standardPng } : b,
      ),
    };
    let manifest: unknown;
    let imageRequests = 0;
    if (fixture === 'images-64-8unique') {
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
        page: { size: 'A4', margin: 64 },
        blocks: Array.from({ length: 64 }, (_, i) => ({
          id: `image-${i}`,
          type: 'image',
          text: '',
          alt: `画像 ${i + 1}`,
          width: 320,
          src: new URL(`/office-scale-image-${i % 8}.png`, baseURL).href,
        })),
      };
    }
    await importOfficeDocument(page, content);
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
    let dialog: Awaited<ReturnType<typeof openDocx>> | undefined;
    try {
      for (const mode of ['cold', 'warm']) {
        await observe(page);
        const start = performance.now(),
          beforeRequests = imageRequests;
        dialog ??= await openDocx(page);
        await prepareDocx(dialog);
        const prepareMs = performance.now() - start;
        await acceptDocx(dialog);
        const encodeStart = performance.now();
        const bytes = await officeDownload(page, dialog, 'Download DOCX');
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
        await writeFile(info.outputPath(`${mode}.docx`), bytes);
        await writeFile(
          info.outputPath('partial-scale.json'),
          JSON.stringify({ commit, fixture, samples, memorySamples }, null, 2),
        );
      }
      await prepareDocx(dialog!);
      await acceptDocx(dialog!);
      const lateFiles: string[] = [];
      page.on('download', (d) => lateFiles.push(d.suggestedFilename()));
      await observe(page);
      // A 14 KB standard output can finish within one driver round trip. Submit
      // Cancel through its real DOM handler as soon as it is displayed; include
      // the confirmation and two frames. The image case uses an ordinary driver click.
      if (fixture === 'standard-200-blocks')
        await dialog!.evaluate((section) => {
          Object.assign(window, {
            docxCancellation: new Promise<{ elapsed?: number; error?: string }>((resolve) => {
              let started: number | undefined;
              const timeout = setTimeout(() => {
                observer.disconnect();
                resolve({ error: 'Cancel or its confirmation never appeared' });
              }, 5000);
              const observer = new MutationObserver(() => {
                if (started === undefined) {
                  const button = [...section.querySelectorAll('button')].find(
                    (b) => b.textContent === 'Cancel export',
                  );
                  if (button) {
                    started = performance.now();
                    button.click();
                  }
                } else if (
                  section.querySelector('[role="alert"]')?.textContent?.includes('Export cancelled')
                ) {
                  observer.disconnect();
                  clearTimeout(timeout);
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve({ elapsed: performance.now() - started! })),
                  );
                }
              });
              observer.observe(section, { childList: true, subtree: true, characterData: true });
            }),
          });
        });
      await dialog!.getByRole('button', { name: 'Download DOCX', exact: true }).click();
      const cancelStart = performance.now();
      let cancelMs: number;
      if (fixture === 'standard-200-blocks') {
        const result = await page.evaluate(
          () =>
            (
              window as typeof window & {
                docxCancellation: Promise<{ elapsed?: number; error?: string }>;
              }
            ).docxCancellation,
        );
        expect(result.error).toBeUndefined();
        cancelMs = result.elapsed!;
      } else {
        await dialog!.getByRole('button', { name: 'Cancel export', exact: true }).click();
        await expect(dialog!.getByRole('alert')).toContainText('Export cancelled');
        cancelMs = performance.now() - cancelStart;
      }
      await expect(dialog!.getByRole('alert')).toContainText('Export cancelled');
      // Observe past the responsiveness budget to detect a late partial download.
      await page.waitForTimeout(1200);
      const cancelled = {
        mode: 'cancel',
        inputMethod:
          fixture === 'standard-200-blocks'
            ? 'DOM activation on busy-control appearance; confirmation plus two frames'
            : 'ordinary Playwright pointer click through confirmation',
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
        workingDiffSha256,
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
          blocks: content.blocks.length,
          types: content.blocks.reduce(
            (counts, b) => ({ ...counts, [b.type]: (counts[b.type] ?? 0) + 1 }),
            {} as Record<string, number>,
          ),
          sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
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
        if (fixture === 'standard-200-blocks')
          expect(s.totalMs).toBeLessThanOrEqual(s.mode === 'cold' ? 15000 : 10000);
        expect(s.longTasks!.filter((t) => t.duration > 500)).toEqual([]);
      }
      expect(cancelMs).toBeLessThanOrEqual(1000);
      expect(lateFiles).toEqual([]);
      expect(memoryErrors).toEqual([]);
      expect(
        createHash('sha256')
          .update(execFileSync('git', ['diff', 'HEAD', '--', '.']))
          .digest('hex'),
      ).toBe(workingDiffSha256);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(commit);
    } finally {
      clearInterval(interval);
      await activeSample;
      await cdp.detach();
    }
  });
