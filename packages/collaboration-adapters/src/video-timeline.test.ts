import { expect, it } from 'vitest';
import { Authority, initial, operation, type Principal } from '@editor-platform/collaboration-core';
import { time } from '@editor-platform/video-core';
import {
  createVideoTimelineCodec,
  splitVideoTimeline,
  videoTimelineAction,
  videoTimelineCodec,
  videoTimelineFixture,
  type SharedVideoEdit,
} from './video-timeline';

const principal = (id: string): Principal => ({
  actorId: id,
  clientId: id,
  sessionId: id,
  writable: true,
  scopes: ['*'],
});
const a = principal('a');
const b = principal('b');
function setup() {
  const content = videoTimelineFixture();
  const basis = initial('test-video', videoTimelineCodec, content);
  const authority = new Authority(videoTimelineCodec, basis);
  const prepare = (actor: Principal, edit: SharedVideoEdit, snapshot = basis) =>
    operation(videoTimelineCodec, snapshot, actor, [videoTimelineAction(edit)]);
  return { content, basis, authority, prepare };
}

it('combines a linked move and independent caption edits, including selective Undo and Redo', () => {
  const { authority, prepare, content } = setup();
  const move = prepare(a, { type: 'move', clipId: 'sample-picture', delta: time(1) });
  const caption = prepare(b, { type: 'caption-text', clipId: 'sample-caption', text: '第二稿' });
  expect(authority.submit(a, move).status).toBe('accepted');
  expect(authority.submit(b, caption).status).toBe('accepted');
  expect(
    authority
      .snapshot()
      .content.sequence.clips.slice(0, 2)
      .map((clip) => clip.start),
  ).toEqual([time(2), time(2)]);
  const undo = authority.undo(a, move.operationId);
  expect(undo.status).toBe('accepted');
  expect(authority.snapshot().content.sequence.clips.slice(0, 2)).toEqual(
    content.sequence.clips.slice(0, 2),
  );
  expect(authority.snapshot().content.sequence.clips[2]).toMatchObject({ text: '第二稿' });
  expect(authority.undo(a, undo.operationId, true).status).toBe('accepted');
  expect(
    authority
      .snapshot()
      .content.sequence.clips.slice(0, 2)
      .map((clip) => clip.start),
  ).toEqual([time(2), time(2)]);
});

it('rejects a stale move after split, remembers the result and restores linked clips atomically', () => {
  const { authority, content, prepare } = setup();
  const split = prepare(a, splitVideoTimeline(content, content.sequence.clips[0]!, time(2)));
  const move = prepare(b, { type: 'move', clipId: 'sample-sound', delta: time(1) });
  expect(authority.submit(a, split).status).toBe('accepted');
  const first = authority.submit(b, move);
  expect(first).toMatchObject({ status: 'rejected', code: 'stale-precondition' });
  expect(authority.submit(b, move)).toEqual(first);
  expect(authority.snapshot().revision).toBe(1);
  expect(authority.snapshot().content.sequence.clips.length).toBe(6);
  expect(authority.undo(a, split.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.sequence.clips).toEqual(content.sequence.clips);
});

it('keeps peer changes to newly split clips and rejects a caller-supplied inverse', () => {
  const { authority, content, prepare } = setup();
  const split = splitVideoTimeline(content, content.sequence.clips[0]!, time(2));
  if (split.type !== 'split') throw new Error('Expected split');
  const receipt = authority.submit(a, prepare(a, split));
  expect(receipt.status).toBe('accepted');
  const trim = prepare(
    b,
    {
      type: 'trim',
      clipId: split.rightIds['sample-picture'],
      start: time(2),
      end: time(70, 25),
      independent: true,
    },
    authority.snapshot(),
  );
  expect(authority.submit(b, trim).status).toBe('accepted');
  expect(authority.undo(a, receipt.operationId)).toMatchObject({
    status: 'rejected',
    code: 'undo-conflict',
  });
  const before = authority.snapshot();
  const forged = operation(videoTimelineCodec, before, b, [
    {
      type: 'history.video-clips',
      target: '*',
      payload: {
        clips: [{ id: 'sample-caption', value: { ...content.sequence.clips[2], text: 'Bypass' } }],
      },
    },
  ]);
  expect(authority.submit(b, forged)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
  expect(authority.snapshot()).toEqual(before);
});

it('preserves track locks, validates the whole timeline, and fixes all source declarations', () => {
  const { content, prepare } = setup();
  expect(() => prepare(a, { type: 'caption-text', clipId: 'locked-caption', text: 'No' })).toThrow(
    /locked/,
  );
  expect(() => prepare(a, { type: 'move', clipId: 'sample-picture', delta: time(20) })).toThrow(
    /fixed sequence/,
  );
  expect(() =>
    prepare(a, {
      type: 'trim',
      clipId: 'sample-picture',
      start: time(2),
      end: time(1),
      independent: true,
    }),
  ).toThrow(/Empty clip/);
  content.sources[0].asset.sha256 = 'f'.repeat(64);
  expect(videoTimelineCodec.validate(content)).toBe(false);
});

it('edits a Host-admitted project and keeps its original media pins after the caller mutates its input', () => {
  const project = videoTimelineFixture();
  project.sequence.id = 'client-film';
  project.sources[0].asset.sha256 = 'a'.repeat(64);
  const codec = createVideoTimelineCodec(project);
  const basis = initial('film', codec, project);
  const authority = new Authority(codec, basis);
  project.sources[0].asset.sha256 = 'b'.repeat(64);
  expect(codec.validate(project)).toBe(false);
  expect(videoTimelineCodec.validate(basis.content)).toBe(false);
  const edit = operation(codec, basis, a, [videoTimelineAction({ type: 'move', clipId: 'sample-picture', delta: time(1) })]);
  expect(authority.submit(a, edit).status).toBe('accepted');
  expect(authority.snapshot().content.sources[0].asset.sha256).toBe('a'.repeat(64));
  expect(authority.undo(a, edit.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(basis.content);
});
