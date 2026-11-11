import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { blockyFigure } from '@editor-platform/character-core';
import {
  exportPngSequence,
  VideoExportError,
  videoFrameCount,
  videoFrameName,
  videoFrameTicks,
  videoSettingsProblems,
  type VideoFrameSource,
  type VideoSettings,
} from './video-export';

const doc = () => blockyFigure().doc;
const fps = (numerator: number, denominator = 1) => ({ numerator, denominator });
// The figure's Wave lasts one second (240,000 ticks) at 30 fps.
const wave = (over: Partial<VideoSettings> = {}): VideoSettings => ({
  actionId: 'wave',
  start: 0,
  end: 240_000,
  width: 64,
  height: 36,
  fps: fps(30),
  ...over,
});

/** Draws a frame as its tick written out, and records what it was asked. */
class FakeSource implements VideoFrameSource {
  ticks: number[] = [];
  began: [number, number] | undefined;
  ended = 0;
  constructor(private readonly onFrame?: (k: number) => void) {}
  begin(w: number, h: number) {
    this.began = [w, h];
  }
  async png(tick: number) {
    this.onFrame?.(this.ticks.length);
    this.ticks.push(tick);
    await Promise.resolve();
    return new TextEncoder().encode(`tick ${tick}`);
  }
  end() {
    this.ended++;
  }
}

describe('video export settings and frames (C8a, TS-1291)', () => {
  it('draws frame k at start + round(k × 240,000 / fps), the end left out', () => {
    expect(videoFrameTicks(wave())).toEqual(Array.from({ length: 30 }, (_, k) => k * 8000));
    expect(videoFrameCount(wave({ fps: fps(24) }))).toBe(24);
    expect(videoFrameTicks(wave({ start: 120_000, fps: fps(60) }))[0]).toBe(120_000);
    expect(videoFrameCount(wave({ start: 120_000, fps: fps(60) }))).toBe(30);
    // NTSC: 30000/1001 fps over one second is 29.97 frames, so 30 are drawn.
    const ntsc = videoFrameTicks(wave({ fps: fps(30000, 1001) }));
    expect(ntsc).toHaveLength(30);
    expect(ntsc[1]).toBe(8008);
    expect(ntsc.at(-1)).toBeLessThan(240_000);
    // At 29 fps frame 1 is at round(8275.86) = 8276: a range ending there holds one frame.
    expect(videoFrameTicks(wave({ end: 8276, fps: fps(29) }))).toEqual([0]);
    expect(videoFrameTicks(wave({ end: 8277, fps: fps(29) }))).toEqual([0, 8276]);
    // A range shorter than a frame still draws its first frame.
    expect(videoFrameCount(wave({ end: 1 }))).toBe(1);
    expect(videoFrameName(0, 30)).toBe('frame-00001.png');
    expect(videoFrameName(123_455, 200_000)).toBe('frame-123456.png');
  });

  it('refuses sizes, rates and ranges beyond the limits, naming each', () => {
    expect(videoSettingsProblems(doc(), wave())).toEqual([]);
    expect(videoSettingsProblems(doc(), wave({ actionId: 'none' }))).toEqual([
      'Choose an action to export.',
    ]);
    expect(videoSettingsProblems(doc(), wave({ width: 15 }))[0]).toMatch(/^Width must be an even/);
    expect(videoSettingsProblems(doc(), wave({ height: 721 }))[0]).toMatch(/^Height must be/);
    expect(videoSettingsProblems(doc(), wave({ width: 4098 }))[0]).toMatch(/^Width/);
    expect(videoSettingsProblems(doc(), wave({ width: 4096, height: 4096 }))).toEqual([]);
    expect(videoSettingsProblems(doc(), wave({ fps: fps(121) }))[0]).toMatch(/frame rate/);
    expect(videoSettingsProblems(doc(), wave({ fps: fps(30, 0) }))[0]).toMatch(/frame rate/);
    expect(videoSettingsProblems(doc(), wave({ start: 10, end: 10 }))).toEqual([
      'The range must end after it starts.',
    ]);
    expect(videoSettingsProblems(doc(), wave({ end: 240_001 }))[0]).toMatch(/action's end/);
    const long = doc();
    long.actions[0]!.duration = 240_000 * 700;
    expect(videoSettingsProblems(long, wave({ end: 240_000 * 700, fps: fps(60) }))[0]).toBe(
      'At most 36000 frames can be exported (42000 asked).',
    );
  });

  it('stores every frame in a ZIP, the same bytes each time, and reports progress', async () => {
    const steps: string[] = [];
    const source = new FakeSource();
    const zip = await exportPngSequence(doc(), wave({ fps: fps(10) }), source, (d, t) =>
      steps.push(`${d}/${t}`),
    );
    expect(source.began).toEqual([64, 36]);
    expect(source.ended).toBe(1);
    expect(source.ticks).toEqual(Array.from({ length: 10 }, (_, k) => k * 24_000));
    expect(steps).toEqual(Array.from({ length: 10 }, (_, k) => `${k + 1}/10`));
    expect(zip.type).toBe('application/zip');
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(
      Array.from({ length: 10 }, (_, k) => `frame-${String(k + 1).padStart(5, '0')}.png`),
    );
    expect(new TextDecoder().decode(files['frame-00003.png'])).toBe('tick 48000');
    const again = await exportPngSequence(doc(), wave({ fps: fps(10) }), new FakeSource());
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);
  });

  it('starts at the range start, and refuses past the size cap with nothing handed over', async () => {
    const late = new FakeSource();
    const zip = await exportPngSequence(doc(), wave({ start: 120_000, fps: fps(10) }), late);
    expect(late.ticks).toEqual([120_000, 144_000, 168_000, 192_000, 216_000]);
    const size = zip.size;
    // The cap counts headers too: exactly the archive's size passes, a byte less does not.
    const exact = await exportPngSequence(
      doc(),
      wave({ start: 120_000, fps: fps(10) }),
      new FakeSource(),
      undefined,
      undefined,
      size,
    );
    expect(exact.size).toBe(size);
    const capped = new FakeSource();
    await expect(
      exportPngSequence(
        doc(),
        wave({ start: 120_000, fps: fps(10) }),
        capped,
        undefined,
        undefined,
        size - 1,
      ),
    ).rejects.toMatchObject({ code: 'video-size' });
    expect(capped.ticks).toHaveLength(5);
    expect(capped.ended).toBe(1);
  });

  it('a cancel stops before the next frame, hands nothing over and ends the source', async () => {
    const abort = new AbortController();
    const source = new FakeSource((k) => k === 3 && abort.abort());
    const run = exportPngSequence(doc(), wave(), source, undefined, abort.signal);
    await expect(run).rejects.toMatchObject({ code: 'video-cancelled' });
    expect(source.ticks).toHaveLength(4);
    expect(source.ended).toBe(1);
  });

  it('refused settings draw nothing; a failing frame ends the source too', async () => {
    const source = new FakeSource();
    await expect(exportPngSequence(doc(), wave({ width: 3 }), source)).rejects.toBeInstanceOf(
      VideoExportError,
    );
    expect(source.began).toBeUndefined();
    const failing = new FakeSource((k) => {
      if (k === 2) throw new VideoExportError('video-render-unsupported', 'lost');
    });
    await expect(exportPngSequence(doc(), wave(), failing)).rejects.toMatchObject({
      code: 'video-render-unsupported',
    });
    expect(failing.ended).toBe(1);
  });
});
