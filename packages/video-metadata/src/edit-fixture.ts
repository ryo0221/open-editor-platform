import { time, type VideoContent } from '@editor-platform/video-core';
/** Synthetic declared metadata only: no fetched/probed/saved media is implied. */
export function videoTimelineFixture(lockedAudio = false): VideoContent {
  return {
    schema: 'video-core-prototype-v0',
    sequence: {
      id: 'sequence',
      duration: time(6),
      frameRate: time(25),
      tracks: [
        { id: 'visual', kind: 'visual', enabled: true, locked: false },
        { id: 'audio', kind: 'audio', enabled: true, locked: lockedAudio },
      ],
      clips: [
        {
          id: 'v',
          kind: 'video',
          trackId: 'visual',
          sourceId: 'synthetic',
          streamId: 'vs',
          start: time(1),
          duration: time(2),
          sourceIn: time(2),
          sourceOut: time(4),
          rate: time(1),
          linkGroupId: 'av',
        },
        {
          id: 'a',
          kind: 'audio',
          trackId: 'audio',
          sourceId: 'synthetic',
          streamId: 'as',
          start: time(1),
          duration: time(2),
          sampleIn: 96000,
          sampleOut: 192000,
          linkGroupId: 'av',
        },
      ],
    },
    sources: [
      {
        id: 'synthetic',
        asset: { assetId: 'declared-fixture-only', sha256: '1'.repeat(64), byteLength: 1024 },
        streams: [
          {
            id: 'vs',
            kind: 'video',
            timebase: time(1, 90000),
            startPts: 0,
            endPts: 900000,
            presentationOrigin: time(0),
          },
          {
            id: 'as',
            kind: 'audio',
            sampleRate: 48000,
            sampleCount: 480000,
            presentationOrigin: time(0),
          },
        ],
      },
    ],
  };
}
