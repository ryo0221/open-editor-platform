import { describe, it, expect } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { time, subtract } from '../time';
import { assertVideoContentV1 } from '../v1/validation';
import type { VideoContentV1 } from '../v1/model';
import { adoptVideoContentV2, assertVideoContentV2 } from './validation';
import { videoCommandV2 } from './commands';
import { audioGainAtV2 } from './gain';
function audioFixtureV1(): VideoContentV1 {
  return {
    schema: 'video-core-prototype-v1',
    sources: [
      {
        id: 'source',
        asset: { assetId: 'asset', sha256: 'a'.repeat(64), byteLength: 1 },
        streams: [
          {
            id: 'audio',
            kind: 'audio',
            sampleRate: 44100,
            sampleCount: 441000,
            sampleOrigin: time(0),
            validity: { start: time(0), end: time(10) },
            presentationOrigin: time(3),
          },
        ],
      },
    ],
    sequence: {
      id: 'sequence',
      duration: time(6),
      frameRate: time(25),
      tracks: [{ id: 'track', kind: 'audio', enabled: true, locked: false }],
      clips: [
        {
          id: 'clip',
          kind: 'audio',
          sourceId: 'source',
          streamId: 'audio',
          trackId: 'track',
          start: time(1),
          duration: time(4),
          sourceIn: time(4),
          sourceOut: time(8),
        },
      ],
    },
  };
}
function linkedFixtureV2() {
  const old = audioFixtureV1();
  old.sources[0].streams.push({
    id: 'video',
    kind: 'video',
    timebase: time(1, 600),
    startPts: 0,
    endPts: 6000,
    presentationOrigin: time(3),
  });
  old.sequence.tracks.push({ id: 'visual', kind: 'visual', enabled: true, locked: false });
  old.sequence.clips[0].linkGroupId = 'linked';
  old.sequence.clips.push({
    id: 'picture',
    kind: 'video',
    sourceId: 'source',
    streamId: 'video',
    trackId: 'visual',
    start: time(1),
    duration: time(4),
    sourceIn: time(4),
    sourceOut: time(8),
    rate: time(1),
    linkGroupId: 'linked',
  });
  old.sequence.tracks.push({ id: 'other-track', kind: 'audio', enabled: true, locked: false });
  old.sequence.clips.push({
    ...old.sequence.clips[0],
    id: 'other',
    trackId: 'other-track',
  });
  delete old.sequence.clips[2].linkGroupId;
  let v = adoptVideoContentV2(old);
  v = videoCommandV2({ type: 'gain', clipId: 'clip', gain: 0.8 }).apply(v);
  v = videoCommandV2({ type: 'fade', clipId: 'clip', fadeIn: time(2), fadeOut: time(2) }).apply(v);
  return videoCommandV2({ type: 'gain', clipId: 'other', gain: 0.25 }).apply(v);
}
describe('explicit native v2 audio effects', () => {
  it('keeps linked split effects, unrelated identity and independent trim through Undo/Redo', () => {
    const input = linkedFixtureV2(),
      before = structuredClone(input),
      session = new EditorSession(input);
    session.execute(
      videoCommandV2({
        type: 'split',
        clipId: 'picture',
        at: time(25001, 10000),
        rightIds: { picture: 'picture-right', clip: 'audio-right' },
        rightLinkGroupId: 'right',
      }),
    );
    const split = structuredClone(session.content);
    expect(split.sequence.clips.map((c) => c.id)).toEqual([
      'clip',
      'picture',
      'other',
      'audio-right',
      'picture-right',
    ]);
    for (const id of ['clip', 'audio-right']) {
      const clip = split.sequence.clips.find((c) => c.id === id)!;
      expect(clip).toMatchObject({
        gain: 0.8,
        fade: before.sequence.clips[0].kind === 'audio' ? before.sequence.clips[0].fade : undefined,
      });
      expect(clip.linkGroupId).toBe(id === 'clip' ? 'linked' : 'right');
      if (clip.kind !== 'audio') throw Error();
      // Source time is sequence time + 3; these independent values straddle the split.
      expect(audioGainAtV2(clip, id === 'clip' ? time(2) : time(4))).toBe(0.4);
    }
    session.execute(
      videoCommandV2({
        type: 'trim',
        clipId: 'audio-right',
        start: time(3),
        end: time(9, 2),
        independent: true,
      }),
    );
    const trimmed = structuredClone(session.content);
    expect(trimmed.sequence.clips.find((c) => c.id === 'picture-right')).toEqual(
      split.sequence.clips.find((c) => c.id === 'picture-right'),
    );
    expect(trimmed.sequence.clips.find((c) => c.id === 'other')).toEqual(
      before.sequence.clips.find((c) => c.id === 'other'),
    );
    const audio = trimmed.sequence.clips.find((c) => c.id === 'audio-right')!;
    if (audio.kind !== 'audio') throw Error();
    expect(audio).toMatchObject({
      start: time(3),
      duration: time(3, 2),
      sourceIn: time(6),
      sourceOut: time(15, 2),
    });
    expect(audioGainAtV2(audio, time(4))).toBe(0.4);
    session.undo();
    expect(session.content).toEqual(split);
    session.undo();
    expect(session.content).toEqual(before);
    session.redo();
    expect(session.content).toEqual(split);
    session.redo();
    expect(session.content).toEqual(trimmed);
    expect(input).toEqual(before);
  });
  it.each(['locked-peer', 'colliding-id', 'missing-id'])(
    'rejects linked split %s without changing pending Redo',
    (fault) => {
      const input = linkedFixtureV2();
      if (fault === 'locked-peer')
        input.sequence.tracks.find((t) => t.id === 'visual')!.locked = true;
      const session = new EditorSession(input);
      session.execute(videoCommandV2({ type: 'gain', clipId: 'other', gain: 0.5 }));
      const future = structuredClone(session.content);
      session.undo();
      const before = structuredClone(session.content),
        revision = session.revision;
      const rightIds: Record<string, string> = { clip: 'audio-right', picture: 'picture-right' };
      if (fault === 'colliding-id') rightIds.clip = 'other';
      if (fault === 'missing-id') delete rightIds.picture;
      expect(() =>
        session.execute(
          videoCommandV2({
            type: 'split',
            clipId: 'clip',
            at: time(25001, 10000),
            rightIds,
            rightLinkGroupId: 'right',
          }),
        ),
      ).toThrow();
      expect(session.content).toEqual(before);
      expect(session.revision).toEqual(revision);
      session.redo();
      expect(session.content).toEqual(future);
      session.undo();
      expect(session.content).toEqual(before);
    },
  );

  it('adopts explicitly without changing old bytes and refuses cross-version readers', () => {
    const old = audioFixtureV1(),
      bytes = JSON.stringify(old),
      v = adoptVideoContentV2(old);
    expect(JSON.stringify(old)).toBe(bytes);
    expect(v.schema).toBe('video-core-prototype-v2');
    expect(() => assertVideoContentV1(v)).toThrow();
    expect(() => assertVideoContentV2(old)).toThrow();
    expect(v.sequence.clips[0]).toMatchObject({ gain: 1, fade: { in: time(0), out: time(0) } });
  });
  it('evaluates linear fade at global times, preserving function through trim, split and move', () => {
    let v = adoptVideoContentV2(audioFixtureV1());
    v = videoCommandV2({ type: 'gain', clipId: 'clip', gain: 0.8 }).apply(v);
    v = videoCommandV2({ type: 'fade', clipId: 'clip', fadeIn: time(2), fadeOut: time(2) }).apply(
      v,
    );
    const original = v.sequence.clips[0];
    if (original.kind !== 'audio') throw Error();
    expect(audioGainAtV2(original, time(1))).toBe(0);
    expect(audioGainAtV2(original, time(2))).toBe(0.4);
    expect(audioGainAtV2(original, time(3))).toBe(0.8);
    expect(audioGainAtV2(original, time(4))).toBe(0.4);
    const trimmed = videoCommandV2({
      type: 'trim',
      clipId: 'clip',
      start: time(3, 2),
      end: time(9, 2),
      independent: true,
    }).apply(v);
    const split = videoCommandV2({
      type: 'split',
      clipId: 'clip',
      at: time(25001, 10000),
      rightIds: { clip: 'right' },
    }).apply(trimmed);
    for (const c of split.sequence.clips) {
      if (c.kind !== 'audio') throw Error();
      expect(c.fade).toEqual(original.fade);
      for (const at of [c.start, time(3), time(4)])
        if (
          at.value / at.timescale >= c.start.value / c.start.timescale &&
          at.value / at.timescale <
            c.start.value / c.start.timescale + c.duration.value / c.duration.timescale
        )
          expect(audioGainAtV2(c, at)).toBe(audioGainAtV2(original, at));
    }
    const moved = videoCommandV2({ type: 'move', clipId: 'right', delta: time(1) })
      .apply(split)
      .sequence.clips.find((c) => c.id === 'right')!;
    if (moved.kind !== 'audio') throw Error();
    expect(audioGainAtV2(moved, time(4))).toBe(audioGainAtV2(original, time(3)));
  });
  it('evaluates admitted high-denominator anchors without narrowing intermediate Time', () => {
    const v = adoptVideoContentV2(audioFixtureV1());
    const stream = v.sources[0].streams[0];
    if (stream.kind !== 'audio') throw Error();
    stream.presentationOrigin = time(0);
    stream.sampleCount = 44100;
    stream.validity.end = time(1);
    const clip = v.sequence.clips[0];
    if (clip.kind !== 'audio') throw Error();
    clip.start = time(0);
    clip.sourceIn = time(1, 100000003);
    clip.sourceOut = time(1, 2);
    clip.duration = subtract(clip.sourceOut, clip.sourceIn);
    v.sequence.duration = clip.duration;
    clip.fade = { start: time(1, 100000007), end: time(1), in: time(0), out: time(0) };
    assertVideoContentV2(v);
    const oldBytes = JSON.stringify(v);
    expect(audioGainAtV2(clip, time(0))).toBe(1);
    clip.fade.in = time(1, 2);
    assertVideoContentV2(v);
    // Independent exact cross-product, no subtraction of nearly equal floats.
    expect(audioGainAtV2(clip, time(0))).toBe(Number(8n) / Number(10000001000000021n));
    const gain = audioGainAtV2(clip, time(1, 48000));
    expect(Number.isFinite(gain)).toBe(true);
    expect(gain).toBeGreaterThan(0);
    const moved = videoCommandV2({ type: 'move', clipId: 'clip', delta: time(1) }).apply({
      ...v,
      sequence: { ...v.sequence, duration: time(2) },
    });
    const movedClip = moved.sequence.clips[0];
    if (movedClip.kind !== 'audio') throw Error();
    expect(audioGainAtV2(movedClip, time(48001, 48000))).toBe(gain);
    clip.fade.in = time(0);
    expect(JSON.stringify(v)).toBe(oldBytes);
  });
  it('rejects unknown/invalid gain and fade while preserving pending Redo on failure', () => {
    const v = adoptVideoContentV2(audioFixtureV1()),
      session = new EditorSession(v);
    session.execute(videoCommandV2({ type: 'gain', clipId: 'clip', gain: 0.5 }));
    session.undo();
    for (const gain of [-1, 1.01, Infinity, NaN])
      expect(() =>
        session.execute(videoCommandV2({ type: 'gain', clipId: 'clip', gain })),
      ).toThrow();
    expect(() =>
      session.execute(
        videoCommandV2({ type: 'fade', clipId: 'clip', fadeIn: time(3), fadeOut: time(2) }),
      ),
    ).toThrow();
    session.redo();
    expect(session.content.sequence.clips[0]).toMatchObject({ gain: 0.5 });
    const invalid = structuredClone(v);
    Object.assign(invalid.sequence.clips[0], { bogus: 1 });
    expect(() => assertVideoContentV2(invalid)).toThrow();
    v.sequence.tracks[0].locked = true;
    expect(() => videoCommandV2({ type: 'gain', clipId: 'clip', gain: 0 }).apply(v)).toThrow(
      'Locked',
    );
  });
});
