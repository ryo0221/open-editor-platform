import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  add,
  assertVideoContent,
  compare,
  evaluateSequence,
  frameTime,
  multiply,
  sampleIndex,
  time,
  validateVideoContent,
  videoCommand,
  type VideoContent,
  type VideoEdit,
} from './index';
function fixture(): VideoContent {
  return {
    schema: 'video-core-prototype-v0',
    sequence: {
      id: 'sequence',
      duration: time(8),
      frameRate: time(30000, 1001),
      tracks: [
        { id: 'visual', kind: 'visual', locked: false, enabled: true },
        { id: 'audio', kind: 'audio', locked: false, enabled: true },
      ],
      clips: [
        {
          id: 'v',
          kind: 'video',
          trackId: 'visual',
          sourceId: 'source',
          streamId: 'vs',
          start: time(1),
          duration: time(2),
          sourceIn: time(-1),
          sourceOut: time(1),
          rate: time(1),
          linkGroupId: 'av',
        },
        {
          id: 'a',
          kind: 'audio',
          trackId: 'audio',
          sourceId: 'source',
          streamId: 'as',
          start: time(1),
          duration: time(2),
          sampleIn: 44100,
          sampleOut: 132300,
          linkGroupId: 'av',
        },
      ],
    },
    sources: [
      {
        id: 'source',
        asset: { assetId: 'media', sha256: 'a'.repeat(64), byteLength: 1024 },
        streams: [
          {
            id: 'vs',
            kind: 'video',
            timebase: time(1, 90000),
            startPts: -180000,
            endPts: 900000,
            presentationOrigin: time(0),
          },
          {
            id: 'as',
            kind: 'audio',
            sampleRate: 44100,
            sampleCount: 441000,
            presentationOrigin: time(-2),
          },
        ],
      },
    ],
  };
}
function apply(edit: VideoEdit, f = fixture()) {
  return videoCommand(edit).apply(f);
}
describe('exact source and sequence time', () => {
  it('canonicalizes rational time and handles products beyond safe Number intermediates', () => {
    expect(time(0, 44100)).toEqual(time(0));
    expect(time(-2, 4)).toEqual(time(-1, 2));
    expect(multiply(time(Number.MAX_SAFE_INTEGER, 2), time(2, Number.MAX_SAFE_INTEGER))).toEqual(
      time(1),
    );
    expect(() => add(time(Number.MAX_SAFE_INTEGER), time(1))).toThrow('overflow');
    expect(() => time(1, 0)).toThrow();
    expect(() => time(Infinity)).toThrow();
  });
  it.each([time(24000, 1001), time(30000, 1001)])(
    'computes CFR from frame index without accumulated rounding: %o',
    (fps) => {
      expect(frameTime(30000, fps)).toEqual(multiply(time(30000), time(fps.timescale, fps.value)));
      expect(compare(frameTime(1001, fps), frameTime(1000, fps))).toBe(1);
    },
  );
  it.each([44100, 48000])('retains sample boundaries at %i Hz', (rate) => {
    expect(sampleIndex(time(10001, rate), rate)).toBe(10001);
    expect(() => sampleIndex(time(1, 13), rate)).toThrow('between source samples');
  });
  it('evaluates half-open ranges and negative PTS independently of seek order', () => {
    const f = fixture();
    const json = JSON.stringify(f);
    for (const at of [time(3), time(1), time(2), time(0), time(1)]) {
      const result = evaluateSequence(f, at);
      if (at.value === 1) expect(result.map((r) => r.sourceTime)).toEqual([time(-1), time(-1)]);
      if (at.value === 3 || at.value === 0) expect(result).toEqual([]);
    }
    expect(evaluateSequence(f, time(1001, 1000))[0].sourceTime).toEqual(time(-999, 1000));
    expect(JSON.stringify(f)).toBe(json);
  });
});
describe('strict prototype validation', () => {
  it.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 2])(
    'rejects an unrepresentable mapped audio endpoint for origin %s',
    (origin) => {
      const f = fixture();
      f.sources[0].streams[1].presentationOrigin = time(origin);
      const before = JSON.stringify(f);
      expect(validateVideoContent(f)).toEqual({ valid: false, reason: 'Time overflow' });
      expect(() => assertVideoContent(f)).toThrow('Time overflow');
      expect(JSON.stringify(f)).toBe(before);
    },
  );
  it('retains a representable negative audio presentation origin', () => {
    const f = fixture();
    f.sources[0].streams[1].presentationOrigin = time(-Number.MAX_SAFE_INTEGER);
    assertVideoContent(f);
    expect(
      evaluateSequence(f, time(1)).find((request) => request.clipId === 'a')?.sourceTime,
    ).toEqual(time(-Number.MAX_SAFE_INTEGER + 1));
  });

  it('accepts empty sequence and JSON roundtrip', () => {
    const f = fixture();
    expect(validateVideoContent(JSON.parse(JSON.stringify(f))).valid).toBe(true);
    f.sequence.clips = [];
    f.sequence.duration = time(0);
    assertVideoContent(f);
  });
  it.each([
    (f: VideoContent) => {
      f.sequence.clips[1].id = 'v';
    },
    (f: VideoContent) => {
      f.sequence.clips[0].trackId = 'audio';
    },
    (f: VideoContent) => {
      f.sequence.clips[0].streamId = 'missing';
    },
    (f: VideoContent) => {
      f.sequence.clips[0].duration = time(0);
    },
    (f: VideoContent) => {
      f.sequence.clips[0].start = { value: 2, timescale: 2 };
    },
    (f: VideoContent) => {
      f.sequence.clips[0].duration = time(99);
    },
    (f: VideoContent) => {
      f.sequence.clips[0].start = time(-1);
    },
    (f: VideoContent) => {
      f.sources[0].asset.sha256 = 'bad';
    },
    (f: VideoContent) => {
      f.sequence.clips.push({ ...f.sequence.clips[0], id: 'overlap' });
    },
    (f: VideoContent) => {
      delete f.sequence.clips[0].linkGroupId;
    },
    (f: VideoContent) => {
      Object.assign(f.sequence.clips[0], { effects: [] });
    },
    (f: VideoContent) => {
      Object.assign(f.sources[0], { url: 'https://untrusted.invalid/' });
    },
  ])('rejects malformed/unsupported input without mutation %#', (mutate) => {
    const f = fixture();
    mutate(f);
    const before = JSON.stringify(f);
    expect(validateVideoContent(f).valid).toBe(false);
    expect(JSON.stringify(f)).toBe(before);
  });
  it('rejects all unknown roots and schema capabilities', () => {
    for (const value of [
      null,
      [],
      {},
      { ...fixture(), schema: 1 },
      { ...fixture(), animation: {} },
    ])
      expect(validateVideoContent(value).valid).toBe(false);
  });
});
describe('pure atomic edits', () => {
  it('moves linked clips and integrates with existing local Undo/Redo', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const session = new EditorSession(f);
    session.execute(videoCommand({ type: 'move', clipId: 'v', delta: time(1) }));
    expect(session.content.sequence.clips.map((c) => c.start)).toEqual([time(2), time(2)]);
    session.undo();
    expect(session.content).toEqual(f);
    session.redo();
    expect(session.content.sequence.clips[0].start).toEqual(time(2));
    expect(JSON.stringify(f)).toBe(before);
  });
  it('splits all linked streams and remaps only right side IDs/groups', () => {
    const f = fixture();
    const result = apply(
      {
        type: 'split',
        clipId: 'v',
        at: time(2),
        rightIds: { v: 'vr', a: 'ar' },
        rightLinkGroupId: 'av-right',
      },
      f,
    );
    expect(result.sequence.clips.map((c) => [c.id, c.duration, c.linkGroupId])).toEqual([
      ['v', time(1), 'av'],
      ['a', time(1), 'av'],
      ['vr', time(1), 'av-right'],
      ['ar', time(1), 'av-right'],
    ]);
    expect(result.sequence.clips[3]).toMatchObject({ sampleIn: 88200, sampleOut: 132300 });
    expect(evaluateSequence(result, time(5, 2)).map((r) => r.sourceTime)).toEqual(
      evaluateSequence(f, time(5, 2)).map((r) => r.sourceTime),
    );
  });
  it('independent trim preserves source mapping and linked partner', () => {
    const f = fixture();
    const result = apply(
      { type: 'trim', clipId: 'a', start: time(3, 2), end: time(5, 2), independent: true },
      f,
    );
    expect(result.sequence.clips[0]).toEqual(f.sequence.clips[0]);
    expect(result.sequence.clips[1]).toMatchObject({ sampleIn: 66150, sampleOut: 110250 });
  });
  it('unlink/relink preserves source data; linked delete removes both', () => {
    const unlinked = apply({ type: 'unlink', clipId: 'v' });
    expect(unlinked.sequence.clips.every((c) => c.linkGroupId === undefined)).toBe(true);
    expect(apply({ type: 'link', clipIds: ['v', 'a'], groupId: 'av' }, unlinked)).toEqual(
      fixture(),
    );
    expect(apply({ type: 'delete', clipId: 'v' }).sequence.clips).toEqual([]);
  });
  it.each<VideoEdit>([
    { type: 'move', clipId: 'v', delta: time(-2) },
    { type: 'trim', clipId: 'v', start: time(0), end: time(20), independent: true },
    { type: 'trim', clipId: 'a', start: time(1, 13), end: time(2), independent: true },
    {
      type: 'split',
      clipId: 'v',
      at: time(1),
      rightIds: { v: 'vr', a: 'ar' },
      rightLinkGroupId: 'right',
    },
    {
      type: 'split',
      clipId: 'v',
      at: time(2),
      rightIds: { v: 'a', a: 'ar' },
      rightLinkGroupId: 'right',
    },
    { type: 'resize', duration: time(2) },
    { type: 'ripple-insert-gap', trackIds: ['visual'], at: time(1), duration: time(1) },
    { type: 'ripple-delete', trackIds: ['visual', 'audio'], start: time(2), end: time(4) },
  ])('rejects invalid edit atomically: $type', (edit) => {
    const f = fixture();
    const before = JSON.stringify(f);
    expect(() => apply(edit, f)).toThrow();
    expect(JSON.stringify(f)).toBe(before);
  });
  it('rejects locked linked partner without changing session/history', () => {
    const f = fixture();
    f.sequence.tracks[1].locked = true;
    const session = new EditorSession(f);
    const revision = session.revision;
    expect(() =>
      session.execute(videoCommand({ type: 'move', clipId: 'v', delta: time(1) })),
    ).toThrow('Locked');
    expect(session.content).toEqual(f);
    expect(session.revision).toEqual(revision);
  });
  it('ripple moves only explicit cohort and supports whole-clip deletion', () => {
    const f = fixture();
    const shifted = apply(
      { type: 'ripple-insert-gap', trackIds: ['visual', 'audio'], at: time(1), duration: time(1) },
      f,
    );
    expect(shifted.sequence.clips.map((c) => c.start)).toEqual([time(2), time(2)]);
    expect(
      apply(
        { type: 'ripple-delete', trackIds: ['visual', 'audio'], start: time(1), end: time(2) },
        shifted,
      ),
    ).toEqual(f);
    expect(
      apply(
        { type: 'ripple-delete', trackIds: ['visual', 'audio'], start: time(1), end: time(3) },
        f,
      ).sequence.clips,
    ).toEqual([]);
  });
  it('rejects ripple deleting only one J/L-linked member', () => {
    const f = fixture();
    f.sequence.clips[1].start = time(4);
    expect(() =>
      apply(
        { type: 'ripple-delete', trackIds: ['visual', 'audio'], start: time(1), end: time(3) },
        f,
      ),
    ).toThrow('separate');
  });
  it('inserts without rewriting unrelated clips and grows duration', () => {
    const f = fixture();
    const clip = { ...f.sequence.clips[0], id: 'inserted', start: time(8) };
    delete clip.linkGroupId;
    const next = apply({ type: 'insert', clip }, f);
    expect(next.sequence.clips.slice(0, 2)).toEqual(f.sequence.clips);
    expect(next.sequence.duration).toEqual(time(10));
    expect(() => apply({ type: 'insert', clip: { ...clip, linkGroupId: 'orphan' } }, f)).toThrow(
      'link group',
    );
  });
  it('snapshots caller-owned edit and prevents result aliasing across apply', () => {
    const edit: VideoEdit = { type: 'move', clipId: 'v', delta: time(1) };
    const command = videoCommand(edit);
    edit.delta.value = 100;
    const result = command.apply(fixture());
    result.sequence.clips[0].start.value = 999;
    expect(command.apply(fixture()).sequence.clips[0].start).toEqual(time(2));
  });
});
