import { describe, it, expect } from 'vitest';
import {
  assertVideoContentV2,
  videoCommandV2,
  audioGainAtV2,
  time,
  type VideoContentV2,
} from '@editor-platform/video-core';
import { prepareAudioImportV2 } from './audio-import-v2';
import type { AudioImportSetV2 } from './audio-profile-v2';
function empty(): VideoContentV2 {
  return {
    schema: 'video-core-prototype-v2',
    sources: [],
    sequence: {
      id: 'sequence',
      duration: time(0),
      frameRate: time(25),
      tracks: [{ id: 'audio', kind: 'audio', enabled: true, locked: false }],
      clips: [],
    },
  };
}
const plan: AudioImportSetV2 = {
  format: 'video-media-interpretation-v2',
  profile: 'aac-mono-v2',
  streams: [
    {
      id: '1',
      destination: 'audio',
      kind: 'audio',
      mediaStart: time(1024, 44100),
      mediaEnd: time(89224, 44100),
      presentationStart: time(0),
      sampleCount: 89224,
      sampleRate: 44100,
      sampleOrigin: time(0),
    },
  ],
};
const asset = { assetId: 'original', sha256: 'a'.repeat(64), byteLength: 100 };
describe('explicit audio-only v2 import', () => {
  it('places an unlinked source independently, retaining priming/edit origin and original identity', () => {
    const input = empty(),
      bytes = JSON.stringify(input),
      p = structuredClone(plan);
    const result = prepareAudioImportV2(input, p, asset, 'source', time(1, 1000));
    assertVideoContentV2(result);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(result.sequence.duration).toEqual(time(2001, 1000));
    expect(result.sources[0].streams[0]).toMatchObject({
      presentationOrigin: time(-1024, 44100),
      sampleCount: 89224,
      validity: { start: time(1024, 44100), end: time(89224, 44100) },
    });
    const clip = result.sequence.clips[0];
    expect(clip).not.toHaveProperty('linkGroupId');
    expect(clip).toMatchObject({
      start: time(1, 1000),
      sourceIn: time(0),
      sourceOut: time(2),
      gain: 1,
    });
    p.streams[0].sampleCount = 1;
    expect(result.sources[0].streams[0]).toHaveProperty('sampleCount', 89224);
    const faded = videoCommandV2({
      type: 'fade',
      clipId: 'source:1',
      fadeIn: time(1),
      fadeOut: time(1),
    }).apply(result).sequence.clips[0];
    if (faded.kind !== 'audio') throw Error();
    expect(audioGainAtV2(faded, time(501, 1000))).toBe(0.5);
  });
  it('rejects mismatched profiles, unknown stream fields, unsupported rates and locked destinations without mutating input', () => {
    const input = empty(),
      before = structuredClone(input);
    for (const change of [
      (p: AudioImportSetV2) => Object.assign(p, { profile: 'unknown' }),
      (p: AudioImportSetV2) => Object.assign(p.streams[0], { channels: 2 }),
      (p: AudioImportSetV2) => {
        p.streams[0].sampleRate = 22050;
      },
      (p: AudioImportSetV2) => {
        p.streams[0].sampleCount = 1;
      },
    ]) {
      const p = structuredClone(plan);
      change(p);
      expect(() => prepareAudioImportV2(input, p, asset, 'source', time(0))).toThrow();
      expect(input).toEqual(before);
    }
    input.sequence.tracks[0].locked = true;
    expect(() => prepareAudioImportV2(input, plan, asset, 'source', time(0))).toThrow('Locked');
    expect(input.sources).toEqual([]);
  });
});
