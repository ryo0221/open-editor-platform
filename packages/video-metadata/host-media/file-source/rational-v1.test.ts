import { describe, expect, it } from 'vitest';
import { command, EditorSession } from '@editor-platform/editor-core';
import {
  add,
  assertVideoContentV1,
  evaluateSequenceV1,
  subtract,
  time,
  validateVideoContent,
  videoCommandV1,
  type VideoContentV1,
} from '@editor-platform/video-core';
import { prepareImportSetV1, type ImportSetV1 } from './import-v1';
import { audioMappingV1, outputSpanV1, videoIntervalV1 } from './timing-v1';
import {
  planWindow,
  renderPcm,
  WindowCollector,
} from '../../../video-core/experiments/pcm-renderer/render';
const T = time(42251, 600);
function empty(): VideoContentV1 {
  return {
    schema: 'video-core-prototype-v1',
    sources: [],
    sequence: {
      id: 'sequence',
      duration: time(0),
      frameRate: time(25),
      tracks: [
        { id: 'visual', kind: 'visual', locked: false, enabled: true },
        { id: 'audio', kind: 'audio', locked: false, enabled: true },
      ],
      clips: [],
    },
  };
}
function plan(): ImportSetV1 {
  return {
    format: 'video-media-interpretation-v1',
    streams: [
      {
        id: 'v',
        kind: 'video',
        destination: 'visual',
        mediaStart: time(0),
        mediaEnd: T,
        presentationStart: time(0),
      },
      {
        id: 'a',
        kind: 'audio',
        destination: 'audio',
        mediaStart: time(0),
        mediaEnd: T,
        presentationStart: time(0),
        sampleRate: 44100,
        sampleCount: 3107840,
        sampleOrigin: time(0),
      },
    ],
  };
}
function fixture(p = plan()) {
  return prepareImportSetV1(
    empty(),
    p,
    { assetId: 'original', sha256: 'a'.repeat(64), byteLength: 146163851 },
    'source',
  );
}
describe('v1 exact presentation Core and interpretation', () => {
  it('keeps the full half-sample endpoint and excludes exclusive presentation end', () => {
    const v = fixture();
    assertVideoContentV1(v);
    expect(v.sequence.duration).toEqual(T);
    const audio = v.sequence.clips[1];
    expect(audio.kind).toBe('audio');
    expect(audio).toMatchObject({ sourceIn: time(0), sourceOut: T, duration: T });
    expect(evaluateSequenceV1(v, subtract(T, time(1, 88200))).map((x) => x.sourceTime)).toEqual([
      subtract(T, time(1, 88200)),
      subtract(T, time(1, 88200)),
    ]);
    expect(evaluateSequenceV1(v, T)).toEqual([]);
    expect(validateVideoContent(v).valid).toBe(false);
    expect(() => assertVideoContentV1({ ...v, schema: 'video-core-prototype-v2' })).toThrow(
      'schema',
    );
  });
  it('preserves raw sample origin, presentation origin and fractional start independently', () => {
    const p = plan();
    const a = p.streams[1];
    if (a.kind !== 'audio') throw Error();
    a.sampleOrigin = time(-1);
    a.mediaStart = time(1, 88200);
    a.mediaEnd = time(1001, 88200);
    a.presentationStart = time(3);
    const v = fixture(p),
      bound = audioMappingV1(v, 'source:a');
    expect(bound.stream.presentationOrigin).toEqual(subtract(time(3), time(1, 88200)));
    expect(bound.valid).toEqual({
      start: add(time(1), time(1, 88200)),
      end: add(time(1), time(1001, 88200)),
    });
    expect(bound.mapping.sourceStart).toEqual(bound.valid.start);
    expect(evaluateSequenceV1(v, time(3)).find((x) => x.clipId === 'source:a')?.sourceTime).toEqual(
      time(3),
    );
    a.mediaEnd = time(100);
    expect(() => fixture(p)).toThrow('validity');
  });
  it('splits fractional source endpoints with canonical Undo/Redo and no input alias', () => {
    const v = fixture(),
      before = JSON.stringify(v),
      at = time(1, 1000),
      session = new EditorSession(v);
    session.execute(
      videoCommandV1({
        type: 'split',
        clipId: 'source:a',
        at,
        rightIds: { 'source:a': 'ar', 'source:v': 'vr' },
        rightLinkGroupId: 'right',
      }),
    );
    const split = structuredClone(session.content);
    expect(split.sequence.clips.find((c) => c.id === 'ar')).toMatchObject({
      sourceIn: at,
      sourceOut: T,
      duration: subtract(T, at),
    });
    expect(evaluateSequenceV1(split, at).map((x) => x.clipId)).toEqual(['vr', 'ar']);
    session.undo();
    expect(session.content).toEqual(v);
    session.redo();
    expect(session.content).toEqual(split);
    session.execute(
      videoCommandV1({
        type: 'trim',
        clipId: 'ar',
        start: time(3, 2000),
        end: subtract(T, time(1, 176400)),
        independent: true,
      }),
    );
    expect(audioMappingV1(session.content, 'ar').valid.end).toEqual(T);
    session.undo();
    expect(session.content).toEqual(split);
    expect(JSON.stringify(v)).toBe(before);
  });
  it('rejects missing, redundant and mismatched declarations atomically', () => {
    for (const mutate of [
      (v: VideoContentV1) => Object.assign(v.sources[0].streams[1], { sampleCount: 1 }),
      (v: VideoContentV1) => Object.assign(v.sequence.clips[1], { sampleIn: 0 }),
      (v: VideoContentV1) =>
        Object.assign(v.sequence.clips[1], { sourceOut: add(T, time(1, 88200)) }),
      (v: VideoContentV1) =>
        Object.assign(v.sources[0].streams[1], { validity: { start: time(0), end: time(0) } }),
    ]) {
      const v = fixture();
      mutate(v);
      expect(() => assertVideoContentV1(v)).toThrow();
    }
    const p = plan();
    Object.assign(p, { format: 'unknown' });
    expect(() => fixture(p)).toThrow('fields');
    const v = fixture();
    v.sequence.tracks[1].locked = true;
    expect(() =>
      videoCommandV1({ type: 'move', clipId: 'source:v', delta: time(1) }).apply(v),
    ).toThrow('Locked');
  });
  it('moves and ripples whole linked cohorts without changing original validity', () => {
    const v = fixture();
    const moved = videoCommandV1({
      type: 'ripple-insert-gap',
      trackIds: ['visual', 'audio'],
      at: time(0),
      duration: time(1, 1000),
    }).apply(v);
    expect(moved.sequence.clips.map((c) => c.start)).toEqual([time(1, 1000), time(1, 1000)]);
    expect(moved.sources).toEqual(v.sources);
    const restored = videoCommandV1({
      type: 'ripple-delete',
      trackIds: ['visual', 'audio'],
      start: time(0),
      end: time(1, 1000),
    }).apply(moved);
    expect(restored.sequence.clips).toEqual(v.sequence.clips);
    expect(() =>
      videoCommandV1({
        type: 'ripple-insert-gap',
        trackIds: ['audio'],
        at: time(0),
        duration: time(1),
      }).apply(v),
    ).toThrow('linked');
    expect(() =>
      videoCommandV1({ type: 'insert', clip: { ...v.sequence.clips[1], id: 'overlap' } }).apply(v),
    ).toThrow('overlap');
  });
  it('requires a sample point within original validity without rounding fractional edges', () => {
    const p = plan();
    const a = p.streams[1];
    if (a.kind !== 'audio') throw Error();
    a.sampleCount = 1;
    a.mediaStart = time(1, 88200);
    a.mediaEnd = time(1, 44100);
    expect(() => fixture(p)).toThrow('contains no sample points');
    a.mediaStart = time(0);
    a.mediaEnd = time(1, 88200);
    expect(() => fixture(p)).not.toThrow();
    a.sampleCount = 2;
    a.mediaStart = time(1, 88200);
    a.mediaEnd = time(3, 88200);
    expect(() => fixture(p)).not.toThrow();
  });
  it('rejects origins whose renderer-coordinate endpoints overflow existing Time', () => {
    const p = plan();
    const a = p.streams[1];
    if (a.kind !== 'audio') throw Error();
    a.sampleOrigin = time(-1, Number.MAX_SAFE_INTEGER);
    a.sampleCount = 44100;
    a.mediaEnd = time(1, 2);
    expect(() => fixture(p)).toThrow('overflow');
    a.sampleOrigin = time(-1, 44100);
    expect(() => fixture(p)).not.toThrow();
  });
  it('rejected admissions preserve content, revision and the existing Undo/Redo history', () => {
    for (const origin of [time(-1, Number.MAX_SAFE_INTEGER), time(1, 100000007)]) {
      const session = new EditorSession(empty());
      session.execute(videoCommandV1({ type: 'resize', duration: time(1) }));
      const before = structuredClone(session.content),
        revision = session.revision;
      const p = plan(),
        a = p.streams[1];
      if (a.kind !== 'audio') throw Error();
      a.sampleOrigin = origin;
      a.sampleCount = 44100;
      a.mediaEnd = time(1, 2);
      if (origin.value > 0) a.mediaStart = time(1, 100000003);
      expect(() =>
        session.execute(
          command('test.admission', 'Import', (content) =>
            prepareImportSetV1(
              content,
              p,
              { assetId: 'original', sha256: 'a'.repeat(64), byteLength: 146163851 },
              'source',
            ),
          ),
        ),
      ).toThrow('overflow');
      expect(session.content).toEqual(before);
      expect(session.revision).toEqual(revision);
      session.undo();
      expect(session.content).toEqual(empty());
      session.redo();
      expect(session.content).toEqual(before);
    }
    const session = new EditorSession(empty());
    session.execute(videoCommandV1({ type: 'resize', duration: time(1) }));
    const before = structuredClone(session.content),
      revision = session.revision,
      p = plan(),
      a = p.streams[1];
    if (a.kind !== 'audio') throw Error();
    a.sampleCount = 1;
    a.mediaStart = time(1, 88200);
    a.mediaEnd = time(1, 44100);
    expect(() =>
      session.execute(
        command('test.admission', 'Import', (content) =>
          prepareImportSetV1(
            content,
            p,
            { assetId: 'original', sha256: 'a'.repeat(64), byteLength: 146163851 },
            'source',
          ),
        ),
      ),
    ).toThrow('no sample points');
    expect(session.content).toEqual(before);
    expect(session.revision).toEqual(revision);
    session.undo();
    expect(session.content).toEqual(empty());
    session.redo();
    expect(session.content).toEqual(before);
  });
  it('rejects sample-coordinate overflow atomically while preserving valid fractional grids', () => {
    const session = new EditorSession(empty());
    session.execute(videoCommandV1({ type: 'resize', duration: time(1) }));
    const before = structuredClone(session.content),
      revision = session.revision,
      p = plan(),
      a = p.streams[1];
    if (a.kind !== 'audio') throw Error();
    a.sampleCount = 44100;
    a.mediaEnd = time(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER);
    expect(() => fixture(p)).toThrow('overflow');
    expect(() =>
      session.execute(
        command('test.admission', 'Import', (content) =>
          prepareImportSetV1(
            content,
            p,
            { assetId: 'original', sha256: 'a'.repeat(64), byteLength: 146163851 },
            'source',
          ),
        ),
      ),
    ).toThrow('overflow');
    expect(session.content).toEqual(before);
    expect(session.revision).toEqual(revision);
    session.undo();
    expect(session.content).toEqual(empty());
    session.redo();
    expect(session.content).toEqual(before);
    // Half-second clip isolates the source-domain endpoint multiplication:
    // output span is the ordinary integer 24000 samples at 48 kHz.
    const half = fixture(),
      stream = half.sources[0].streams.find((s) => s.kind === 'audio')!,
      halfClip = half.sequence.clips.find((c) => c.kind === 'audio')!;
    stream.sampleCount = 44100;
    stream.validity.end = time(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER);
    halfClip.sourceOut = time(1, 2);
    halfClip.duration = time(1, 2);
    const beforeHalf = structuredClone(session.content),
      revisionHalf = session.revision;
    expect(outputSpanV1(halfClip.duration, 48000).end).toBe(24000);
    expect(() =>
      session.execute(
        command('test.admission.half', 'Import trimmed', () => {
          assertVideoContentV1(half);
          return half;
        }),
      ),
    ).toThrow('overflow');
    expect(session.content).toEqual(beforeHalf);
    expect(session.revision).toEqual(revisionHalf);
    session.undo();
    expect(session.content).toEqual(empty());
    session.redo();
    expect(session.content).toEqual(beforeHalf);
    a.mediaEnd = time(44101, 88200);
    expect(() => fixture(p)).not.toThrow();
    const valid = fixture(),
      clip = valid.sequence.clips.find((c) => c.kind === 'audio')!;
    clip.sourceOut = time(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER);
    clip.duration = clip.sourceOut;
    expect(() => assertVideoContentV1(valid)).toThrow('overflow');
  });
  it('keeps 3380080 output sample points and a final 11/600-second video interval', () => {
    expect(outputSpanV1(T, 48000)).toEqual({ first: 0, end: 3380080, presentationEnd: T });
    expect(videoIntervalV1(1760, time(25), T)).toEqual({
      start: time(352, 5),
      end: T,
      duration: time(11, 600),
    });
    expect(() => videoIntervalV1(1761, time(25), T)).toThrow();
    expect(outputSpanV1(time(1, 88200), 48000)).toEqual({
      first: 0,
      end: 1,
      presentationEnd: time(1, 88200),
    });
  });
});
describe('v1 renderer binding (synthetic mono PCM, not codec acceptance)', () => {
  function short() {
    const p = plan();
    for (const s of p.streams) s.mediaEnd = time(4411, 88200);
    return fixture(p);
  }
  const signal = new AbortController().signal;
  function render(v: VideoContentV1, id: string, first: number, end: number, omitLast = false) {
    const { mapping, valid } = audioMappingV1(v, id),
      plan = planWindow(mapping, first, end, 48000, 44100, valid, 1, 'edge-hold-v0');
    const collector = new WindowCollector(plan),
      n = plan.end - plan.first - (omitLast ? 1 : 0);
    collector.push({
      first: plan.first,
      rate: 44100,
      planes: [Float32Array.from({ length: n }, (_, i) => Math.sin((i + plan.first) * 0.031))],
    });
    return renderPcm(mapping, first, end, 48000, collector.finish(), signal, {
      mode: 'edge-hold-v0',
      valid,
    }).planes[0];
  }
  it('mono 44.1→48k is identical across fractional split and irregular output chunks', () => {
    const v = short(),
      end = outputSpanV1(v.sequence.duration, 48000).end,
      all = render(v, 'source:a', 0, end);
    const at = time(1, 1000),
      split = videoCommandV1({
        type: 'split',
        clipId: 'source:a',
        at,
        rightIds: { 'source:a': 'ar', 'source:v': 'vr' },
        rightLinkGroupId: 'r',
      }).apply(v);
    const pieces = [
      render(split, 'source:a', 0, 48),
      render(split, 'ar', 48, 137),
      render(split, 'ar', 137, end),
    ];
    expect(Float32Array.from(pieces.flatMap((x) => Array.from(x)))).toEqual(all);
    expect(all.length).toBe(2401);
    expect(all.every(Number.isFinite)).toBe(true);
    // Point 2205 exists although the validity endpoint is 2205.5 source samples.
    const bound = audioMappingV1(v, 'source:a');
    expect(
      planWindow(bound.mapping, end - 1, end, 48000, 44100, bound.valid, 1, 'edge-hold-v0').end,
    ).toBe(2206);
    expect(() => render(v, 'source:a', end - 1, end, true)).toThrow('Missing decoded coverage');
  });
  it('preserves an already-pending Redo branch when v1 admission is refused', () => {
    for (const failure of ['empty-grid', 'origin-overflow', 'rate-overflow']) {
      const session = new EditorSession(fixture());
      const base = structuredClone(session.content);
      session.execute(videoCommandV1({ type: 'resize', duration: add(T, time(1)) }));
      const future = structuredClone(session.content);
      session.undo();
      const revision = session.revision;
      const invalid = fixture();
      const stream = invalid.sources[0].streams.find((s) => s.kind === 'audio')!;
      stream.sampleCount = 44100;
      stream.validity = { start: time(0), end: time(1, 2) };
      if (failure === 'empty-grid')
        stream.validity = { start: time(1, 88200), end: time(1, 44100) };
      if (failure === 'origin-overflow') stream.sampleOrigin = time(-1, Number.MAX_SAFE_INTEGER);
      if (failure === 'rate-overflow')
        stream.validity.end = time(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER);
      expect(() =>
        session.execute(
          command('test.reject-with-redo', 'Import', () => {
            assertVideoContentV1(invalid);
            return invalid;
          }),
        ),
      ).toThrow(failure === 'empty-grid' ? /no sample points/ : /overflow/);
      expect(session.content).toEqual(base);
      expect(session.revision).toEqual(revision);
      session.redo();
      expect(session.content).toEqual(future);
      session.undo();
      expect(session.content).toEqual(base);
    }
  });
});
