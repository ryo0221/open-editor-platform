import { beforeAll, afterAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { time, type VideoContent } from '@editor-platform/video-core';
import type {} from '../test-host/demo-preview';
import { closeServer, launchTestChromium, listenOnLoopback } from '../test-host/browser';
let browser: Browser, bundle: string, origin: string, dir: string, content: VideoContent;
const media = new Map<string, Buffer>();
const server = createServer((req, res) => {
  const bytes = media.get(req.url ?? '');
  res.setHeader('Content-Type', bytes ? 'video/webm' : 'text/html');
  res.end(bytes ?? '<!doctype html><title>Video demo TEST Host</title>');
});
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'video-demo-browser-'));
  const sources: VideoContent['sources'] = [];
  for (const [id, first, second] of [
    ['a', 'red', 'lime'],
    ['b', 'blue', 'yellow'],
  ]) {
    const path = join(dir, `${id}.webm`);
    // Test fixture generation only, never a product encode/export implementation.
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=${first}:s=64x48:r=10:d=1`,
      '-f',
      'lavfi',
      '-i',
      `color=${second}:s=64x48:r=10:d=1`,
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-an',
      '-c:v',
      'libvpx',
      '-g',
      '10',
      '-y',
      path,
    ]);
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', path],
        { encoding: 'utf8' },
      ),
    );
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0].codec_name).toBe('vp8');
    expect(probe.streams[0].time_base).toBe('1/1000');
    expect(probe.packets).toHaveLength(20);
    for (let i = 0; i < probe.packets.length; i++) {
      expect(probe.packets[i].pts).toBe(i * 100);
      expect(probe.packets[i].duration).toBe(100);
    }
    const last = probe.packets.at(-1);
    expect(last.pts + last.duration).toBe(2000);
    const bytes = readFileSync(path);
    media.set(`/${id}.webm`, bytes);
    sources.push({
      id,
      asset: {
        assetId: id,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
      },
      streams: [
        {
          id: 'vs',
          kind: 'video',
          timebase: time(1, 1000),
          startPts: 0,
          endPts: 2000,
          presentationOrigin: time(0),
        },
      ],
    });
  }
  content = {
    schema: 'video-core-prototype-v0',
    sources,
    sequence: {
      id: 'sequence',
      duration: time(5),
      frameRate: time(10),
      tracks: [{ id: 'track', kind: 'visual', enabled: true, locked: false }],
      clips: sources.map((s, i) => ({
        id: `clip-${s.id}`,
        kind: 'video',
        trackId: 'track',
        sourceId: s.id,
        streamId: 'vs',
        start: time(i * 3),
        duration: time(2),
        sourceIn: time(0),
        sourceOut: time(2),
        rate: time(1),
      })),
    },
  };
  bundle = (
    await build({
      entryPoints: ['packages/video-metadata/test-host/demo-preview.ts'],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      minify: true,
    })
  ).outputFiles[0].text;
  origin = await listenOnLoopback(server);
  browser = await launchTestChromium();
});
afterAll(async () => {
  await browser?.close();
  await closeServer(server);
  if (dir) rmSync(dir, { recursive: true, force: true });
});
for (const width of [1280, 390])
  it(`ignores a real initial frame delivered before seek completion at ${width}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    try {
      await page.goto(origin);
      await page.addScriptTag({ content: bundle });
      await page.evaluate(async (c) => {
        // Control only the browser event order: deliver an ACTUAL initial decoded
        // frame before performing the requested seek. No fabricated pixels/PTS.
        const descriptor = Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          'currentTime',
        )!;
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
          ...descriptor,
          set(this: HTMLMediaElement, value: number) {
            if (this instanceof HTMLVideoElement) {
              this.requestVideoFrameCallback(() => {
                this.pause();
                descriptor.set!.call(this, value);
              });
              void this.play();
            } else descriptor.set!.call(this, value);
          },
        });
        globalThis.demoPreview = await startDemoPreview(c);
      }, content);
      expect(await page.evaluate(() => demoPreview.render(5, 4))).toBe('frame');
      const e = await page.evaluate(() => demoPreview.evidence());
      expect(e.shown.at(-1)!.mediaTime, JSON.stringify(e.shown)).toBeCloseTo(1.2, 5);
      expect(e.pixel[1], JSON.stringify(e.pixel)).toBeGreaterThan(240);
      expect(e.activeURLs).toBe(0);
      expect(e.released).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
for (const width of [1280, 390])
  it(`decodes/seeks actual silent fixtures with domain edits and lifecycle at ${width}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    try {
      await page.goto(origin);
      await page.addScriptTag({ content: bundle });
      await page.evaluate(async (c) => {
        globalThis.demoPreview = await startDemoPreview(c);
      }, content);
      const render = async (n: number, d = 1) => {
        expect(await page.evaluate(([n, d]) => demoPreview.render(n, d), [n, d])).toBe('frame');
        return page.evaluate(() => demoPreview.evidence());
      };
      let e = await render(1, 4);
      expect(e.pixel[0]).toBeGreaterThan(240);
      expect(e.pixel[1]).toBeLessThan(10);
      expect(e.shown.at(-1)!.mediaTime).toBeCloseTo(0.2, 5);
      e = await render(5, 4);
      expect(e.pixel[1], JSON.stringify({ pixel: e.pixel, frame: e.shown.at(-1) })).toBeGreaterThan(
        240,
      );
      expect(e.shown.at(-1)!.mediaTime).toBeCloseTo(1.2, 5);
      expect(await page.evaluate(() => demoPreview.render(2))).toBe('gap');
      expect((await page.evaluate(() => demoPreview.evidence())).pixel[3]).toBe(0);
      e = await render(13, 4);
      expect(e.pixel[2]).toBeGreaterThan(240);
      await page.evaluate(() => {
        demoPreview.startClock();
        demoPreview.order(['clip-b', 'clip-a']);
      });
      e = await render(1, 4);
      expect(e.playing).toBe(false);
      expect(e.revision.sequence).toBe(1);
      expect(e.pixel[2]).toBeGreaterThan(240);
      await page.evaluate(() => demoPreview.undo());
      const rev = await page.evaluate(() => demoPreview.evidence().revision);
      await page.evaluate(() => demoPreview.order(['clip-a', 'clip-b']));
      expect((await page.evaluate(() => demoPreview.evidence())).revision).toEqual(rev);
      expect((await page.evaluate(() => demoPreview.evidence())).canRedo).toBe(true);
      await page.evaluate(() => {
        demoPreview.redo();
        demoPreview.undo();
        demoPreview.edit({
          type: 'trim',
          clipId: 'clip-a',
          start: { value: 1, timescale: 1 },
          end: { value: 2, timescale: 1 },
          independent: true,
        });
      });
      e = await render(5, 4);
      expect(e.pixel[1], JSON.stringify({ pixel: e.pixel, frame: e.shown.at(-1) })).toBeGreaterThan(
        240,
      );
      await page.evaluate(() =>
        demoPreview.edit({
          type: 'split',
          clipId: 'clip-a',
          at: { value: 3, timescale: 2 },
          rightIds: { 'clip-a': 'right' },
        }),
      );
      e = await render(7, 4);
      expect(e.shown.at(-1)!.clipId).toBe('right');
      expect(e.shown.at(-1)!.mediaTime).toBeCloseTo(1.7, 5);
      // Detached bitmap resolves after a newer seek: it must never overwrite the new frame.
      await page.evaluate(() => demoPreview.hold());
      const late = page.evaluate(() => demoPreview.render(7, 4));
      await expect.poll(() => page.evaluate(() => demoPreview.evidence().heldReady)).toBe(true);
      await render(13, 4);
      await page.evaluate(() => demoPreview.release());
      expect(await late).toBe('superseded');
      e = await page.evaluate(() => demoPreview.evidence());
      expect(e.pixel[2]).toBeGreaterThan(240);
      expect(e.activeURLs).toBe(0);
      // Actual pending decoded frame also loses authority after scope retirement.
      await page.evaluate(() => demoPreview.hold());
      const retired = page.evaluate(() => demoPreview.render(7, 4));
      await expect.poll(() => page.evaluate(() => demoPreview.evidence().heldReady)).toBe(true);
      await page.evaluate(() => {
        demoPreview.revoke();
        demoPreview.release();
        demoPreview.dispose();
      });
      expect(await retired).toBe('superseded');
      e = await page.evaluate(() => demoPreview.evidence());
      expect(e.pixel[3]).toBe(0);
      expect(e.activeURLs).toBe(0);
      expect(e.released).toBe(9);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
