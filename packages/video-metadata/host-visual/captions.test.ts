import { expect, it } from 'vitest';
import { time, subtract, type CaptionClipV3 } from '@editor-platform/video-core';
import { parseCaptions, serializeCaptions } from './captions';
const bytes = (s: string) => new TextEncoder().encode(s);
it('roundtrips exact Japanese multiline cue times across both plain sidecars', () => {
  const cues = parseCaptions(
    bytes('1\r\n00:00:00,017 --> 00:00:01,234\r\n日本語\r\n二行\r\n'),
    'srt',
  );
  const clips: CaptionClipV3[] = cues.map((c, i) => ({
    id: String(i),
    kind: 'caption',
    sourceId: 'font',
    trackId: 'captions',
    start: c.start,
    duration: subtract(c.end, c.start),
    sourceIn: time(0),
    sourceOut: subtract(c.end, c.start),
    rate: time(1),
    text: c.text,
    style: { x: 0, y: 0, width: 1, height: 1, size: 0.04, color: '#ffffff', align: 'center' },
  }));
  for (const format of ['srt', 'vtt'] as const)
    expect(parseCaptions(bytes(serializeCaptions(clips, format)), format)).toEqual(cues);
  for (const invalid of ['a\n\nb', '\na', 'a\n']) {
    for (const format of ['srt', 'vtt'] as const)
      expect(() => serializeCaptions([{ ...clips[0], text: invalid }], format)).toThrow(
        'plain caption',
      );
  }
  clips[0].start = time(1, 3);
  expect(() => serializeCaptions(clips, 'srt')).toThrow('exact milliseconds');
});
it('refuses unknown metadata, settings, markup, encoding and empty times atomically', () => {
  for (const body of [
    'WEBVTT\n\n00:00.000 --> 00:01.000 align:start\n字幕',
    'WEBVTT\n\nSTYLE\n::cue{}',
    'WEBVTT\n\nid\n00:00.000 --> 00:01.000\n字幕',
    'WEBVTT\n\n00:00.000 --> 00:00.000\n字幕',
    'WEBVTT\n\n00:00.000 --> 00:01.000\n<b>字幕</b>',
  ])
    expect(() => parseCaptions(bytes(body), 'vtt')).toThrow();
  expect(() => parseCaptions(Uint8Array.of(255), 'srt')).toThrow();
  expect(() =>
    parseCaptions(
      bytes('1\n00:00:00,000 --> 00:00:01,000\n字幕\n\n3\n00:00:02,000 --> 00:00:03,000\n後半'),
      'srt',
    ),
  ).toThrow('index');
});
