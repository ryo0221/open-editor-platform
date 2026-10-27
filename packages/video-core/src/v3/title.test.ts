import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { fixture } from './fixture.test-support';
import { assertVideoContentV3 } from './validation';
import { videoCommandV3 } from './commands';
import { time } from '../time';
import type { TitleClipV3 } from './model';
it('keeps native title placement and split/Undo in the same timeline without embedded font bytes', () => {
  const content = fixture();
  content.sources.push({
    id: 'font',
    kind: 'font',
    asset: { assetId: 'font', sha256: 'a'.repeat(64), byteLength: 17000000 },
    fontProfile: 'noto-cjk-jp-2.004',
    weight: 'regular',
  });
  content.sequence.tracks.push({ id: 'titles', kind: 'visual', enabled: true, locked: false });
  const clip: TitleClipV3 = {
    id: 'title',
    kind: 'title',
    sourceId: 'font',
    trackId: 'titles',
    text: '日本語\nタイトル',
    start: time(0),
    duration: time(2),
    sourceIn: time(0),
    sourceOut: time(2),
    rate: time(1),
    style: {
      x: 0.05,
      y: 0.8,
      width: 0.9,
      height: 0.15,
      size: 0.04,
      color: '#ffffff',
      align: 'center',
    },
  };
  const session = new EditorSession(content);
  session.execute(videoCommandV3({ type: 'insert', clip }));
  const inserted = structuredClone(session.content);
  session.execute(
    videoCommandV3({
      type: 'split',
      clipId: clip.id,
      at: time(1),
      rightIds: { title: 'right-title' },
    }),
  );
  expect(
    session.content.sequence.clips.filter((c) => c.kind === 'title').map((c) => c.text),
  ).toEqual([clip.text, clip.text]);
  session.undo();
  expect(session.content).toEqual(inserted);
  session.undo();
  expect(session.content).toEqual(content);
  session.redo();
  expect(() => assertVideoContentV3(session.content)).not.toThrow();
  const invalid = structuredClone(inserted);
  invalid.sources = [];
  expect(() => assertVideoContentV3(invalid)).toThrow('Missing title font');
  const bad = structuredClone(clip);
  bad.style.x = 0.9;
  expect(() => videoCommandV3({ type: 'insert', clip: bad }).apply(content)).toThrow('Title box');
});

it('links captions explicitly to Animation and preserves atomic move/split/Undo', () => {
  const content = fixture();
  content.sources.push({
    id: 'font',
    kind: 'font',
    asset: { assetId: 'font', sha256: 'a'.repeat(64), byteLength: 17000000 },
    fontProfile: 'noto-cjk-jp-2.004',
    weight: 'regular',
  });
  content.sequence.tracks.push({ id: 'captions', kind: 'visual', enabled: true, locked: false });
  content.sequence.clips.push({
    id: 'caption',
    kind: 'caption',
    sourceId: 'font',
    trackId: 'captions',
    text: '字幕',
    start: time(1),
    duration: time(2),
    sourceIn: time(0),
    sourceOut: time(2),
    rate: time(1),
    style: { x: 0, y: 0.8, width: 1, height: 0.2, size: 0.04, color: '#ffffff', align: 'center' },
  });
  const session = new EditorSession(content);
  session.execute(
    videoCommandV3({ type: 'link', clipIds: ['animation-clip', 'caption'], groupId: 'linked' }),
  );
  const linked = structuredClone(session.content);
  session.execute(videoCommandV3({ type: 'move', clipId: 'caption', delta: time(1) }));
  expect(session.content.sequence.clips.map((c) => c.start)).toEqual([time(2), time(2)]);
  session.undo();
  expect(session.content).toEqual(linked);
  session.execute(
    videoCommandV3({
      type: 'split',
      clipId: 'caption',
      at: time(2),
      rightIds: { 'animation-clip': 'animation-right', caption: 'caption-right' },
      rightLinkGroupId: 'right-group',
    }),
  );
  expect(session.content.sequence.clips).toHaveLength(4);
  expect(
    session.content.sequence.clips.filter((c) => c.kind === 'caption').map((c) => c.text),
  ).toEqual(['字幕', '字幕']);
  session.undo();
  expect(session.content).toEqual(linked);
  session.execute(videoCommandV3({ type: 'unlink', clipId: 'caption' }));
  session.execute(videoCommandV3({ type: 'move', clipId: 'caption', delta: time(1) }));
  expect(session.content.sequence.clips.find((c) => c.id === 'animation-clip')!.start).toEqual(
    time(1),
  );
  const invalid = structuredClone(linked);
  invalid.sequence.clips.pop();
  expect(() => assertVideoContentV3(invalid)).toThrow('Invalid link group');
});
