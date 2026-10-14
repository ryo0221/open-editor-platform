import { test, expect, nativeArtifact } from '../e2e/fixtures';
import { scaleArtifact } from './fixtures';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';

for (const kind of ['slide', 'design', 'whiteboard'])
  test(`${kind} continuous drag frame timing at original scale`, async ({
    page,
    browser,
  }, info) => {
    page.setDefaultTimeout(12000);
    await page.goto('/');
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: `${kind}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(scaleArtifact(kind))),
    });
    const canvas = page.getByRole('application', {
      name: `${kind === 'whiteboard' ? 'Whiteboard' : kind === 'design' ? 'Design' : 'Slide'} canvas`,
      exact: true,
    });
    const target = canvas.getByRole('button', {
      name:
        kind === 'slide'
          ? 'shape object 1'
          : kind === 'design'
            ? 'Design object Frame 0'
            : 'group 1',
      exact: true,
    });
    const before = (await nativeArtifact(page)).draft.content;
    const frames: number[] = [];
    for (let round = 0; round < 5; round++) {
      const bounds = (await target.boundingBox())!;
      const x = bounds.x + bounds.width / 2,
        y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.evaluate(() => {
        const scope = window as typeof window & {
          dragTiming: { running: boolean; frames: number[] };
        };
        const sample = (scope.dragTiming = { running: true, frames: [] as number[] });
        let previous = performance.now();
        const frame = (now: number) => {
          if (!sample.running) return;
          sample.frames.push(now - previous);
          previous = now;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await page.mouse.move(x + 45, y + 25, { steps: 60 });
      await page.mouse.move(x + 15, y + 10, { steps: 60 });
      const samples = await page.evaluate(() => {
        const sample = (
          window as typeof window & { dragTiming: { running: boolean; frames: number[] } }
        ).dragTiming;
        sample.running = false;
        return sample.frames;
      });
      await page.mouse.up();
      if (round > 1) frames.push(...samples.slice(1));
    }
    expect(frames.length).toBeGreaterThan(20);
    expect((await nativeArtifact(page)).draft.content).not.toEqual(before);
    const sorted = [...frames].sort((a, b) => a - b);
    await writeFile(
      info.outputPath(`${kind}-drag.json`),
      JSON.stringify(
        {
          kind,
          mode: 'local continuous drag',
          commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          measuredAt: new Date().toISOString(),
          browser: browser.version(),
          viewport: '1440x900',
          cpuModel: cpus()[0]?.model,
          cpus: cpus().length,
          memoryGB: totalmem() / 1024 ** 3,
          warmupDrags: 2,
          measuredDrags: 3,
          pointerMovesPerDrag: 120,
          samplesMs: frames,
          p95FrameMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
          longestFrameMs: sorted.at(-1),
          framesOver50Ms: frames.filter((v) => v > 50).length,
        },
        null,
        2,
      ),
    );
  });
