import type { EditorCommand } from '@editor-platform/editor-core';
import type { Clip, VideoContent } from './model';
import { add, compare, multiply, sampleIndex, subtract, time, type Time } from './time';
import { assertVideoContent } from './validation';
export type VideoEdit =
  | { type: 'insert'; clip: Clip }
  | { type: 'move'; clipId: string; delta: Time }
  | { type: 'trim'; clipId: string; start: Time; end: Time; independent: true }
  | {
      type: 'split';
      clipId: string;
      at: Time;
      rightIds: Record<string, string>;
      rightLinkGroupId?: string;
    }
  | { type: 'delete'; clipId: string }
  | { type: 'link'; clipIds: string[]; groupId: string }
  | { type: 'unlink'; clipId: string }
  | { type: 'ripple-delete'; trackIds: string[]; start: Time; end: Time }
  | { type: 'ripple-insert-gap'; trackIds: string[]; at: Time; duration: Time }
  | { type: 'resize'; duration: Time };
const endOf = (c: Clip) => add(c.start, c.duration);
function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function select(v: VideoContent, id: string): Clip {
  const c = v.sequence.clips.find((c) => c.id === id);
  need(c, 'Missing clip');
  return c;
}
function group(v: VideoContent, clip: Clip): Clip[] {
  return v.sequence.clips.filter(
    (c) => c.id === clip.id || (clip.linkGroupId && c.linkGroupId === clip.linkGroupId),
  );
}
function unlocked(v: VideoContent, clips: Clip[]) {
  need(
    clips.every((c) => !v.sequence.tracks.find((t) => t.id === c.trackId)?.locked),
    'Locked track',
  );
}
function slice(v: VideoContent, clip: Clip, start: Time, end: Time): Clip {
  need(compare(start, end) < 0, 'Empty clip');
  const duration = subtract(end, start);
  const offset = subtract(start, clip.start);
  if (clip.kind === 'video') {
    const sourceIn = add(clip.sourceIn, multiply(offset, clip.rate));
    return {
      ...clip,
      start,
      duration,
      sourceIn,
      sourceOut: add(sourceIn, multiply(duration, clip.rate)),
    };
  }
  const stream = v.sources
    .find((s) => s.id === clip.sourceId)
    ?.streams.find((s) => s.id === clip.streamId);
  need(stream?.kind === 'audio', 'Missing audio stream');
  // Add as rational to avoid unsafe Number additions at large source indices.
  const sampleIn = sampleIndex(
    add(time(clip.sampleIn, stream.sampleRate), offset),
    stream.sampleRate,
  );
  const sampleOut = sampleIndex(
    add(time(sampleIn, stream.sampleRate), duration),
    stream.sampleRate,
  );
  return { ...clip, start, duration, sampleIn, sampleOut };
}
/** Trusted local code only. Host authorization/stale checks occur at submission. */
export function videoCommand(edit: VideoEdit): EditorCommand<VideoContent> {
  const owned = structuredClone(edit);
  return {
    type: `video.prototype.${owned.type}`,
    label: `Video ${owned.type}`,
    readonlyInput: true,
    reads: { content: ['*'] },
    apply(input) {
      assertVideoContent(input);
      const v = structuredClone(input);
      const q = v.sequence;
      const e = owned;
      if (e.type === 'insert') {
        unlocked(v, [e.clip]);
        q.clips.push(structuredClone(e.clip));
      } else if (e.type === 'resize') q.duration = e.duration;
      else if (e.type === 'ripple-delete' || e.type === 'ripple-insert-gap') {
        need(
          e.trackIds.length > 0 && new Set(e.trackIds).size === e.trackIds.length,
          'Invalid ripple cohort',
        );
        need(
          e.trackIds.every((id) => q.tracks.some((t) => t.id === id && !t.locked)),
          'Missing or locked ripple track',
        );
        const start = e.type === 'ripple-delete' ? e.start : e.at;
        const end = e.type === 'ripple-delete' ? e.end : e.at;
        const delta = e.type === 'ripple-delete' ? subtract(start, end) : e.duration;
        need(
          compare(start, time(0)) >= 0 &&
            compare(end, q.duration) <= 0 &&
            (e.type === 'ripple-delete' ? compare(start, end) < 0 : compare(delta, time(0)) > 0),
          'Invalid ripple interval',
        );
        const affected = q.clips.filter(
          (c) => e.trackIds.includes(c.trackId) && compare(endOf(c), start) > 0,
        );
        for (const c of affected) {
          need(
            group(v, c).every((member) => affected.includes(member)),
            'Ripple excludes linked member',
          );
          need(
            !(compare(c.start, start) < 0 && compare(endOf(c), start) > 0) &&
              !(compare(c.start, end) < 0 && compare(endOf(c), end) > 0),
            'Crossing ripple clip unsupported in v0',
          );
        }
        if (e.type === 'ripple-delete') {
          for (const c of affected) {
            const removed = compare(c.start, end) < 0;
            need(
              group(v, c).every((member) => compare(member.start, end) < 0 === removed),
              'Ripple would separate a linked group',
            );
          }
        }
        unlocked(v, affected);
        q.clips = q.clips.flatMap((c) => {
          if (!affected.includes(c)) return [c];
          if (e.type === 'ripple-delete' && compare(c.start, end) < 0) return [];
          return [{ ...c, start: add(c.start, delta) }];
        });
      } else if (e.type === 'link') {
        need(
          e.clipIds.length >= 2 && new Set(e.clipIds).size === e.clipIds.length,
          'Link requires distinct clips',
        );
        need(!q.clips.some((c) => c.linkGroupId === e.groupId), 'Link group already exists');
        const clips = e.clipIds.map((id) => select(v, id));
        unlocked(v, clips);
        need(
          clips.every((c) => !c.linkGroupId),
          'Unlink existing groups first',
        );
        for (const c of clips) c.linkGroupId = e.groupId;
      } else {
        const clip = select(v, e.clipId);
        const members = group(v, clip);
        const targets = e.type === 'trim' ? [clip] : members;
        unlocked(v, targets);
        if (e.type === 'move') for (const c of targets) c.start = add(c.start, e.delta);
        else if (e.type === 'trim') {
          need(e.independent === true, 'Independent trim must be explicit');
          q.clips = q.clips.map((c) => (c.id === clip.id ? slice(v, c, e.start, e.end) : c));
        } else if (e.type === 'delete') q.clips = q.clips.filter((c) => !targets.includes(c));
        else if (e.type === 'unlink') for (const c of targets) delete c.linkGroupId;
        else if (e.type === 'split') {
          need(
            Object.keys(e.rightIds).length === targets.length &&
              targets.every((c) => Object.hasOwn(e.rightIds, c.id)),
            'Provide exact split ID map',
          );
          need(
            targets.length === 1
              ? e.rightLinkGroupId === undefined
              : !!e.rightLinkGroupId &&
                  e.rightLinkGroupId !== clip.linkGroupId &&
                  !q.clips.some((c) => c.linkGroupId === e.rightLinkGroupId),
            'New right link group required',
          );
          const rights: Clip[] = [];
          q.clips = q.clips.map((c) => {
            if (!targets.includes(c)) return c;
            need(
              compare(c.start, e.at) < 0 && compare(e.at, endOf(c)) < 0,
              'Split must be interior to every linked clip',
            );
            const right = { ...slice(v, c, e.at, endOf(c)), id: e.rightIds[c.id] };
            if (e.rightLinkGroupId) right.linkGroupId = e.rightLinkGroupId;
            rights.push(right);
            return slice(v, c, c.start, e.at);
          });
          q.clips.push(...rights);
        } else throw new Error('Unsupported video command');
      }
      if (e.type !== 'resize')
        for (const c of q.clips) if (compare(endOf(c), q.duration) > 0) q.duration = endOf(c);
      assertVideoContent(v);
      // Do not expose captured edit objects through the returned snapshot.
      return structuredClone(v);
    },
  };
}
