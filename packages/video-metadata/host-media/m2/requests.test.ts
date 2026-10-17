import { describe, it, expect } from 'vitest';
import { time, videoCommandV1, type VideoContentV1 } from '@editor-platform/video-core';
import { prepareSourceRequests } from './requests';
import { sourceAt } from '../../../video-core/experiments/pcm-renderer/render';
function fixture(): VideoContentV1 {
  return {
    schema: 'video-core-prototype-v1',
    sources: ['one', 'two', 'sound'].map((id, i) => ({
      id,
      asset: { assetId: id, sha256: String(i + 1).repeat(64), byteLength: 100 },
      streams:
        i < 2
          ? [
              {
                id: 'v',
                kind: 'video',
                timebase: time(1, 600),
                startPts: 0,
                endPts: 6000,
                presentationOrigin: time(3),
              },
            ]
          : [
              {
                id: 'a',
                kind: 'audio',
                sampleRate: 44100,
                sampleCount: 44100 * 12,
                sampleOrigin: time(-1),
                validity: { start: time(0), end: time(10) },
                presentationOrigin: time(3),
              },
            ],
    })),
    sequence: {
      id: 'sequence',
      duration: time(4),
      frameRate: time(25),
      tracks: [
        { id: 'v', kind: 'visual', enabled: true, locked: false },
        { id: 'a', kind: 'audio', enabled: true, locked: false },
      ],
      clips: [
        {
          id: 'one-v',
          kind: 'video',
          sourceId: 'one',
          streamId: 'v',
          trackId: 'v',
          start: time(0),
          duration: time(2),
          sourceIn: time(3),
          sourceOut: time(5),
          rate: time(1),
        },
        {
          id: 'two-v',
          kind: 'video',
          sourceId: 'two',
          streamId: 'v',
          trackId: 'v',
          start: time(2),
          duration: time(2),
          sourceIn: time(4),
          sourceOut: time(6),
          rate: time(1),
        },
        {
          id: 'sound-a',
          kind: 'audio',
          sourceId: 'sound',
          streamId: 'a',
          trackId: 'a',
          start: time(1, 1000),
          duration: time(2),
          sourceIn: time(3001, 1000),
          sourceOut: time(5001, 1000),
        },
      ],
    },
  };
}
describe('M2 private multi-source request planning with existing v1 Core', () => {
  it('selects distinct source identity at a cut and subtracts presentation origin only once', () => {
    const plan = prepareSourceRequests(fixture());
    expect(plan.videoAt(time(1999, 1000))[0]).toMatchObject({
      sourceId: 'one',
      rawTime: time(1999, 1000),
    });
    expect(plan.videoAt(time(2))[0]).toMatchObject({
      sourceId: 'two',
      sourceTime: time(4),
      rawTime: time(1),
    });
    expect(plan.videoAt(time(4))).toEqual([]);
  });
  it('selects independent fractional audio with exact grid origin and half-open ceil endpoints', () => {
    const plan = prepareSourceRequests(fixture());
    expect(plan.audioWindow(0, 100)).toMatchObject([
      {
        sourceId: 'sound',
        first: 48,
        end: 100,
        mapping: { sourceStart: time(1001, 1000) },
        valid: { start: time(1), end: time(11) },
      },
    ]);
    expect(plan.audioWindow(96000, 97000)).toMatchObject([{ first: 96000, end: 96048 }]);
    expect(plan.audioWindow(96048, 97000)).toEqual([]);
  });
  it('preserves fractional split meaning through existing commands and chunk partitions', () => {
    const before = fixture();
    const split = videoCommandV1({
      type: 'split',
      clipId: 'sound-a',
      at: time(10001, 10000),
      rightIds: { 'sound-a': 'right' },
    }).apply(before);
    const plan = prepareSourceRequests(split),
      whole = plan.audioWindow(46000, 50000);
    expect(whole.map((r) => [r.first, r.end])).toEqual([
      [46000, 48005],
      [48005, 50000],
    ]);
    const piece = [...plan.audioWindow(46000, 48005), ...plan.audioWindow(48005, 50000)];
    expect(piece).toEqual(whole);
    expect(before.sequence.clips).toHaveLength(3);
  });
  it('preserves source phase after independent audio trim via the existing command', () => {
    const before = fixture(),
      original = structuredClone(before);
    const after = videoCommandV1({
      type: 'trim',
      clipId: 'sound-a',
      start: time(501, 1000),
      end: time(1501, 1000),
      independent: true,
    }).apply(before);
    const plan = prepareSourceRequests(after);
    expect(plan.audioWindow(24000, 25000)).toMatchObject([
      { first: 24048, end: 25000, mapping: { sourceStart: time(1501, 1000) } },
    ]);
    expect(plan.audioWindow(72000, 73000)).toMatchObject([{ first: 72000, end: 72048 }]);
    expect(plan.audioWindow(72048, 73000)).toEqual([]);
    const oldMap = prepareSourceRequests(before).audioWindow(24048, 24100)[0].mapping;
    const newMap = plan.audioWindow(24048, 24100)[0].mapping;
    for (const k of [24048, 24049, 24099])
      expect(sourceAt(newMap, time(k, 48000))).toEqual(sourceAt(oldMap, time(k, 48000)));
    expect(before).toEqual(original);
    expect(after.sources).toEqual(before.sources);
    expect(after.sequence.clips.slice(0, 2)).toEqual(before.sequence.clips.slice(0, 2));
  });
  it('returns no visual request in an enabled-track gap created by a real trim command', () => {
    const before = fixture();
    const after = videoCommandV1({
      type: 'trim',
      clipId: 'one-v',
      start: time(0),
      end: time(1),
      independent: true,
    }).apply(before);
    const plan = prepareSourceRequests(after);
    expect(plan.videoAt(time(9999, 10000))[0].sourceId).toBe('one');
    expect(plan.videoAt(time(1))).toEqual([]);
    expect(plan.videoAt(time(3, 2))).toEqual([]);
    expect(plan.videoAt(time(19999, 10000))).toEqual([]);
    expect(plan.videoAt(time(2))[0]).toMatchObject({ sourceId: 'two', rawTime: time(1) });
    expect(after.sequence.tracks.every((t) => t.enabled)).toBe(true);
    expect(after.sources).toEqual(before.sources);
  });
  it('keeps every output point and source position invariant under irregular mid-clip chunks', () => {
    const split = videoCommandV1({
      type: 'split',
      clipId: 'sound-a',
      at: time(10001, 10000),
      rightIds: { 'sound-a': 'right' },
    }).apply(fixture());
    const plan = prepareSourceRequests(split);
    const points = (rows: ReturnType<typeof plan.audioWindow>) =>
      rows.flatMap((row) =>
        Array.from({ length: row.end - row.first }, (_, i) => ({
          k: row.first + i,
          clipId: row.clipId,
          sourceId: row.sourceId,
          sourceTime: sourceAt(row.mapping, time(row.first + i, 48000)),
        })),
      );
    const boundaries = [46000, 46017, 47003, 48004, 48006, 49211, 50000];
    const chunks = boundaries
      .slice(0, -1)
      .flatMap((a, i) => points(plan.audioWindow(a, boundaries[i + 1])));
    const whole = points(plan.audioWindow(46000, 50000));
    expect(chunks).toEqual(whole);
    expect(new Set(chunks.map((p) => p.k)).size).toBe(4000);
    expect(chunks.find((p) => p.k === 48004)?.clipId).toBe('sound-a');
    expect(chunks.find((p) => p.k === 48005)?.clipId).toBe('right');
  });
  it('preserves Core ordering for independently placed overlapping audio tracks', () => {
    const v = fixture();
    v.sequence.tracks.push({ id: 'b', kind: 'audio', enabled: true, locked: false });
    v.sequence.clips.push({ ...v.sequence.clips[2], id: 'other', trackId: 'b', start: time(1) });
    const rows = prepareSourceRequests(v).audioWindow(48000, 49000);
    expect(rows.map((r) => r.clipId)).toEqual(['sound-a', 'other']);
    expect(rows[0].mapping.sourceStart).toEqual(rows[1].mapping.sourceStart);
    expect(rows[0].mapping.start).not.toEqual(rows[1].mapping.start);
  });
  it('keeps snapshot and returned request ownership independent from callers', () => {
    const v = fixture(),
      plan = prepareSourceRequests(v);
    v.sources[0].asset.sha256 = 'f'.repeat(64);
    v.sequence.tracks[0].enabled = false;
    const row = plan.videoAt(time(0))[0];
    row.asset.sha256 = 'e'.repeat(64);
    row.rawTime.value = 99;
    expect(plan.videoAt(time(0))[0]).toMatchObject({
      asset: { sha256: '1'.repeat(64) },
      rawTime: time(0),
    });
    plan.audioWindow(0, 100)[0].mapping.sourceStart.value = 99;
    expect(plan.audioWindow(0, 100)[0].mapping.sourceStart).toEqual(time(1001, 1000));
  });
  it('keeps disabled tracks empty and refuses unbounded/invalid requests', () => {
    const v = fixture();
    v.sequence.tracks[0].enabled = false;
    v.sequence.tracks[1].enabled = false;
    const plan = prepareSourceRequests(v);
    expect(plan.videoAt(time(1))).toEqual([]);
    expect(plan.audioWindow(0, 100)).toEqual([]);
    for (const [a, b] of [
      [0, 4097],
      [-1, 2],
      [0, 0],
      [0, 0.5],
      [192000, 192001],
    ])
      expect(() => plan.audioWindow(a, b)).toThrow('bounded');
    expect(() => plan.videoAt({ value: NaN, timescale: 1 })).toThrow('sequence time');
  });
});
