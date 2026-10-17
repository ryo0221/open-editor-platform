import { it, expect } from 'vitest';
import { time, videoCommandV2, type VideoContentV2 } from '@editor-platform/video-core';
import { prepareAudioImportV2 } from './audio-import-v2';
import { prepareAvImportV2, type AvImportSetV2 } from './media-profile-v2';
it('new AV imports preserve every existing v2 effect and original while adding default effects only to new audio', () => {
  const empty: VideoContentV2 = {
    schema: 'video-core-prototype-v2',
    sources: [],
    sequence: {
      id: 'seq',
      duration: time(0),
      frameRate: time(25),
      tracks: [
        { id: 'visual', kind: 'visual', enabled: true, locked: false },
        { id: 'audio', kind: 'audio', enabled: true, locked: false },
      ],
      clips: [],
    },
  };
  let before = prepareAudioImportV2(
    empty,
    {
      format: 'video-media-interpretation-v2',
      profile: 'aac-mono-v2',
      streams: [
        {
          id: 'a',
          kind: 'audio',
          destination: 'audio',
          sampleRate: 48000,
          sampleCount: 48000,
          sampleOrigin: time(0),
          mediaStart: time(0),
          mediaEnd: time(1),
          presentationStart: time(0),
        },
      ],
    },
    { assetId: 'old', sha256: 'a'.repeat(64), byteLength: 1 },
    'old',
    time(0),
  );
  before = videoCommandV2({ type: 'gain', clipId: 'old:a', gain: 0.25 }).apply(before);
  before = videoCommandV2({
    type: 'fade',
    clipId: 'old:a',
    fadeIn: time(1, 2),
    fadeOut: time(1, 2),
  }).apply(before);
  const original = structuredClone(before);
  const plan: AvImportSetV2 = {
    format: 'video-media-interpretation-v2',
    profile: 'av-sdr-v2',
    streams: [
      {
        id: 'v',
        kind: 'video',
        destination: 'visual',
        mediaStart: time(0),
        mediaEnd: time(1),
        presentationStart: time(0),
      },
      {
        id: 'a',
        kind: 'audio',
        destination: 'audio',
        mediaStart: time(0),
        mediaEnd: time(1),
        presentationStart: time(0),
        sampleRate: 48000,
        sampleCount: 48000,
        sampleOrigin: time(0),
      },
    ],
  };
  const result = prepareAvImportV2(
    before,
    plan,
    { assetId: 'new', sha256: 'b'.repeat(64), byteLength: 1 },
    'new',
  );
  expect(before).toEqual(original);
  expect(result.sources[0]).toEqual(before.sources[0]);
  expect(result.sequence.clips.find((c) => c.id === 'old:a')).toEqual(before.sequence.clips[0]);
  expect(result.sequence.clips.find((c) => c.id === 'new:a')).toMatchObject({
    gain: 1,
    start: time(1),
    fade: { in: time(0), out: time(0) },
  });
  expect(() =>
    prepareAvImportV2(
      before,
      { ...plan, profile: 'aac-mono-v2' } as unknown as AvImportSetV2,
      { assetId: 'new', sha256: 'b'.repeat(64), byteLength: 1 },
      'new',
    ),
  ).toThrow('import set');
});
