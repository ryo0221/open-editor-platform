import { describe, it, expect } from 'vitest';
import {
  adoptVideoContentV2,
  videoCommandV2,
  time,
  subtract,
  add,
  multiply,
  type VideoContentV1,
} from '@editor-platform/video-core';
import { prepareMixV2, type ResamplePortV2 } from './mix-v2';
function fixture(count = 2) {
  const v: VideoContentV1 = {
    schema: 'video-core-prototype-v1',
    sources: [],
    sequence: { id: 'sequence', duration: time(1), frameRate: time(25), tracks: [], clips: [] },
  };
  for (let i = 0; i < count; i++) {
    v.sources.push({
      id: `s${i}`,
      asset: { assetId: `asset${i}`, sha256: String(i + 1).repeat(64), byteLength: 1 },
      streams: [
        {
          id: 'a',
          kind: 'audio',
          sampleRate: 44100,
          sampleCount: 44100,
          sampleOrigin: time(0),
          validity: { start: time(0), end: time(1) },
          presentationOrigin: time(0),
        },
      ],
    });
    v.sequence.tracks.push({ id: `t${i}`, kind: 'audio', enabled: true, locked: false });
    v.sequence.clips.push({
      id: `c${i}`,
      kind: 'audio',
      sourceId: `s${i}`,
      streamId: 'a',
      trackId: `t${i}`,
      start: time(0),
      duration: time(1),
      sourceIn: time(0),
      sourceOut: time(1),
    });
  }
  return adoptVideoContentV2(v);
}
const values =
  (amplitudes: number[], calls: string[] = []): ResamplePortV2 =>
  async (r) => {
    calls.push(r.sourceId);
    return {
      first: r.first,
      rate: 48000,
      planes: [new Float32Array(r.end - r.first).fill(amplitudes[Number(r.sourceId.slice(1))])],
    };
  };
describe('shared v2 audio block mix', () => {
  it('preserves PCM across a linked A/V split between sample points and irregular render windows', async () => {
    let v = fixture(1);
    v.sources[0].streams.push({
      id: 'v',
      kind: 'video',
      timebase: time(1, 600),
      startPts: 0,
      endPts: 600,
      presentationOrigin: time(0),
    });
    v.sequence.tracks.push({ id: 'visual', kind: 'visual', enabled: true, locked: false });
    v.sequence.clips[0].linkGroupId = 'av';
    v.sequence.clips.push({
      id: 'picture',
      kind: 'video',
      sourceId: 's0',
      streamId: 'v',
      trackId: 'visual',
      start: time(0),
      duration: time(1),
      sourceIn: time(0),
      sourceOut: time(1),
      rate: time(1),
      linkGroupId: 'av',
    });
    v = videoCommandV2({ type: 'gain', clipId: 'c0', gain: 0.5 }).apply(v);
    v = videoCommandV2({
      type: 'fade',
      clipId: 'c0',
      fadeIn: time(1, 2),
      fadeOut: time(1, 2),
    }).apply(v);
    const before = structuredClone(v);
    const split = videoCommandV2({
      type: 'split',
      clipId: 'picture',
      at: time(50001, 100000),
      rightIds: { c0: 'audio-right', picture: 'picture-right' },
      rightLinkGroupId: 'right',
    }).apply(v);
    const signal = new AbortController().signal;
    // A synthetic source ramp, evaluated from the request's exact rational mapping.
    // It is deliberately not keyed only by the output index: a wrong source window
    // must change PCM. This tests mapping/effects composition, not a codec/resampler.
    const sourceRamp: ResamplePortV2 = async (request) => ({
      first: request.first,
      rate: 48000,
      planes: [
        Float32Array.from({ length: request.end - request.first }, (_, i) => {
          const source = add(
            request.mapping.sourceStart,
            multiply(
              subtract(time(request.first + i, 48000), request.mapping.start),
              request.mapping.speed,
            ),
          );
          return source.value / source.timescale;
        }),
      ],
    });
    const original = await prepareMixV2(v, sourceRamp).render(22000, 26000, signal);
    const mix = prepareMixV2(split, sourceRamp);
    const whole = await mix.render(22000, 26000, signal);
    // Independent triangular envelope at k/48000: gain .5 and half-second ramps.
    const expected = Float32Array.from({ length: 4000 }, (_, i) => {
      const k = 22000 + i;
      // The original source starts at zero at unit speed. Round the source
      // sample to Float32 before applying the independently derived envelope.
      return Math.fround(k / 48000) * (Math.min(k, 48000 - k) / 48000);
    });
    expect(whole.planes[0]).toEqual(expected);
    expect(whole.planes[0]).toEqual(original.planes[0]);
    const cuts = [22000, 22017, 24000, 24001, 25599, 26000],
      parts: number[] = [];
    for (let i = 0; i < cuts.length - 1; i++)
      parts.push(...(await mix.render(cuts[i], cuts[i + 1], signal)).planes[0]);
    expect(parts).toEqual([...expected]);
    expect(v).toEqual(before);

    // Sensitivity check: neutralize fades so only source mapping can detect the
    // deliberate one-output-sample phase discontinuity. Keep native input valid
    // by shifting both source endpoints, preserving the right clip's duration.
    const shifted = structuredClone(split);
    for (const clip of shifted.sequence.clips) {
      if (clip.kind === 'audio') {
        clip.fade.in = time(0);
        clip.fade.out = time(0);
      }
    }
    const neutralExpected = Float32Array.from(
      { length: 4000 },
      (_, i) => Math.fround((22000 + i) / 48000) * 0.5,
    );
    const neutral = await prepareMixV2(shifted, sourceRamp).render(22000, 26000, signal);
    expect(neutral.planes[0]).toEqual(neutralExpected);
    const right = shifted.sequence.clips.find((c) => c.id === 'audio-right')!;
    if (right.kind !== 'audio') throw Error();
    right.sourceIn = subtract(right.sourceIn, time(1, 48000));
    right.sourceOut = subtract(right.sourceOut, time(1, 48000));
    const discontinuous = await prepareMixV2(shifted, sourceRamp).render(22000, 26000, signal);
    expect(discontinuous.planes[0].slice(0, 2001)).toEqual(neutralExpected.slice(0, 2001));
    expect(discontinuous.planes[0][2001]).not.toBe(neutralExpected[2001]);
    expect(discontinuous.planes[0]).not.toEqual(neutralExpected);
  });

  it('renders high-denominator fade anchors with exact global chunk invariance', async () => {
    const v = fixture(1),
      c = v.sequence.clips[0];
    if (c.kind !== 'audio') throw Error();
    c.sourceIn = time(1, 100000003);
    c.sourceOut = time(1, 2);
    c.duration = subtract(c.sourceOut, c.sourceIn);
    c.fade = { start: time(1, 100000007), end: time(1), in: time(1, 2), out: time(0) };
    const mix = prepareMixV2(v, values([1])),
      signal = new AbortController().signal;
    const all = await mix.render(0, 100, signal);
    expect(all.planes[0][0]).toBe(Math.fround(Number(8n) / Number(10000001000000021n)));
    const left = await mix.render(0, 37, signal),
      right = await mix.render(37, 100, signal);
    expect([...left.planes[0], ...right.planes[0]]).toEqual([...all.planes[0]]);
  });
  it('permits cancelling partial overshoot, sums in stable order, then validates final output', async () => {
    const calls: string[] = [],
      mix = prepareMixV2(fixture(), values([1.5, -1], calls));
    const result = await mix.render(0, 100, new AbortController().signal);
    expect(calls).toEqual(['s0', 's1']);
    expect([...result.planes[0]]).toEqual(Array(100).fill(0.5));
  });
  it('rejects final range and nonfinite samples without delivering a block or auto correction', async () => {
    for (const amplitudes of [
      [0.75, 0.75],
      [Infinity, -1],
      [NaN, 0],
      [-0.75, -0.75],
    ]) {
      let delivered = false;
      await expect(
        prepareMixV2(fixture(), values(amplitudes))
          .render(0, 100, new AbortController().signal)
          .then((x) => {
            delivered = true;
            return x;
          }),
      ).rejects.toThrow('final mixed');
      expect(delivered).toBe(false);
    }
  });
  it('evaluates fade at global sample time and preserves exact output across irregular chunks', async () => {
    let v = fixture(1);
    v = videoCommandV2({ type: 'gain', clipId: 'c0', gain: 0.5 }).apply(v);
    v = videoCommandV2({
      type: 'fade',
      clipId: 'c0',
      fadeIn: time(1, 2),
      fadeOut: time(1, 2),
    }).apply(v);
    const mix = prepareMixV2(v, values([1])),
      signal = new AbortController().signal;
    const whole = await mix.render(22000, 26000, signal),
      cuts = [22000, 22017, 23501, 24001, 25599, 26000],
      parts = [];
    for (let i = 0; i < cuts.length - 1; i++)
      parts.push(...(await mix.render(cuts[i], cuts[i + 1], signal)).planes[0]);
    expect(parts).toEqual([...whole.planes[0]]);
    expect(whole.planes[0][2000]).toBe(0.5);
  });
  it('returns silence for gaps and checks concurrency before opening resamplers', async () => {
    const v = videoCommandV2({
        type: 'trim',
        clipId: 'c0',
        start: time(1, 2),
        end: time(1),
        independent: true,
      }).apply(fixture(1)),
      calls: string[] = [];
    expect([
      ...(await prepareMixV2(v, values([1], calls)).render(0, 100, new AbortController().signal))
        .planes[0],
    ]).toEqual(Array(100).fill(0));
    expect(calls).toEqual([]);
    await expect(
      prepareMixV2(fixture(3), values([0, 0, 0], calls)).render(
        0,
        100,
        new AbortController().signal,
      ),
    ).rejects.toThrow('contributor');
    expect(calls).toEqual([]);
  });
  it('refuses stale/aborted resample results and shape errors before publishing output', async () => {
    const c = new AbortController();
    const port: ResamplePortV2 = async (r) => {
      c.abort();
      return { first: r.first, rate: 48000, planes: [new Float32Array(r.end - r.first)] };
    };
    await expect(prepareMixV2(fixture(1), port).render(0, 100, c.signal)).rejects.toThrow();
    await expect(
      prepareMixV2(fixture(1), async () => ({ first: 1, rate: 44100, planes: [] })).render(
        0,
        100,
        new AbortController().signal,
      ),
    ).rejects.toThrow('mismatch');
  });
});

describe('M2 mix ownership failure boundaries', () => {
  for (const fault of ['abort', 'shape', 'range', 'output-admission', 'none']) {
    it(`releases input/accumulator and transfers only successful output: ${fault}`, async () => {
      let bytes = 0,
        sourceReleases = 0;
      const abort = new AbortController();
      const owner = {
        reserve(n: number, category?: string) {
          if (fault === 'output-admission' && category === 'mix-output')
            throw Error('test admission');
          bytes += n;
          let live = true;
          return () => {
            if (live) {
              live = false;
              bytes -= n;
            }
          };
        },
      };
      const mix = prepareMixV2(
        fixture(1),
        async (r) => {
          if (fault === 'abort') abort.abort();
          return {
            first: fault === 'shape' ? -1 : r.first,
            rate: 48000,
            planes: [new Float32Array(r.end - r.first).fill(fault === 'range' ? 2 : 0.25)],
            release: () => {
              sourceReleases++;
            },
          };
        },
        owner,
      );
      if (fault === 'none') {
        const output = await mix.render(0, 64, abort.signal);
        expect(bytes).toBe(256);
        output.release!();
        output.release!();
      } else await expect(mix.render(0, 64, abort.signal)).rejects.toThrow();
      expect(sourceReleases).toBe(1);
      expect(bytes).toBe(0);
    });
  }
});
