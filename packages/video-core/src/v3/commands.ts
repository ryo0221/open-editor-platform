import { canonicalJson } from '@editor-platform/artifact-core';
import type { AnimationEmbed2 } from '@editor-platform/animation-core/v2';
import type { EditorCommand } from '@editor-platform/editor-core';
import {
  timelineCommand,
  type TimelineEdit,
  type TimelineSchema,
  need,
} from '../timeline-commands';
import { add, multiply, subtract } from '../time';
import { videoCommandV2, type VideoEditV2 } from '../v2/commands';
import type { ClipV3, VideoContentV3 } from './model';
import { assertVideoContentV3, mediaContentV3 } from './validation';
const schema: TimelineSchema<VideoContentV3, ClipV3> = {
  commandType: 'video.prototype.v3',
  version: 'v3',
  assert: assertVideoContentV3,
  afterEdit(content, edit) {
    if (!content.sequence.transitions) return;
    if (edit.type === 'split')
      for (const edge of content.sequence.transitions) {
        if (edit.rightIds[edge.leftClipId]) edge.leftClipId = edit.rightIds[edge.leftClipId];
      }
    const ids = new Set(content.sequence.clips.map((c) => c.id));
    content.sequence.transitions = content.sequence.transitions.filter(
      (e) => ids.has(e.leftClipId) && ids.has(e.rightClipId),
    );
    if (!content.sequence.transitions.length) delete content.sequence.transitions;
  },
  slice(_content, clip, start, end) {
    const duration = subtract(end, start),
      offset = subtract(start, clip.start);
    const sourceIn = add(
      clip.sourceIn,
      clip.kind === 'audio' ? offset : multiply(offset, clip.rate),
    );
    return {
      ...clip,
      start,
      duration,
      sourceIn,
      sourceOut: add(sourceIn, clip.kind === 'audio' ? duration : multiply(duration, clip.rate)),
    };
  },
};
export type VideoEditV3 =
  | TimelineEdit<ClipV3>
  | { type: 'dissolve-set'; edge: import('./model').DissolveV3 }
  | { type: 'dissolve-remove'; edgeId: string }
  | { type: 'visual-track-add'; trackId: string }
  | { type: 'visual-track-shift'; trackId: string; direction: 1 | -1 }
  | { type: 'visual-track-assign'; clipId: string; trackId: string }
  | Extract<VideoEditV2, { type: 'gain' | 'fade' }>
  | {
      type: 'visual-fade';
      clipId: string;
      fadeIn: import('../time').Time;
      fadeOut: import('../time').Time;
    };
export function videoCommandV3(edit: VideoEditV3): EditorCommand<VideoContentV3> {
  if (edit.type === 'dissolve-set' || edit.type === 'dissolve-remove') {
    const owned = structuredClone(edit);
    return {
      type: 'video.prototype.v3.' + owned.type,
      label: 'Edit cross-dissolve',
      readonlyInput: true,
      reads: { content: ['*'] },
      apply(input) {
        assertVideoContentV3(input);
        const result = structuredClone(input);
        const existing = (result.sequence.transitions ?? []).find(
          (e) => e.id === (owned.type === 'dissolve-set' ? owned.edge.id : owned.edgeId),
        );
        const endpoints = [
          ...(existing ? [existing.leftClipId, existing.rightClipId] : []),
          ...(owned.type === 'dissolve-set' ? [owned.edge.leftClipId, owned.edge.rightClipId] : []),
        ];
        for (const id of endpoints) {
          const clip = result.sequence.clips.find((c) => c.id === id);
          need(
            clip && !result.sequence.tracks.find((t) => t.id === clip.trackId)?.locked,
            'Missing or locked dissolve endpoint',
          );
        }
        if (owned.type === 'dissolve-remove') need(existing, 'Missing dissolve');
        result.sequence.transitions = (result.sequence.transitions ?? []).filter(
          (e) => e !== existing,
        );
        if (owned.type === 'dissolve-set')
          result.sequence.transitions.push(structuredClone(owned.edge));
        if (!result.sequence.transitions.length) delete result.sequence.transitions;
        assertVideoContentV3(result);
        return result;
      },
    };
  }
  if (
    edit.type === 'visual-track-add' ||
    edit.type === 'visual-track-shift' ||
    edit.type === 'visual-track-assign'
  ) {
    const owned = structuredClone(edit);
    return {
      type: `video.prototype.v3.${owned.type}`,
      label: 'Edit visual track',
      readonlyInput: true,
      reads: { content: ['*'] },
      apply(input) {
        assertVideoContentV3(input);
        const result = structuredClone(input),
          tracks = result.sequence.tracks;
        if (owned.type === 'visual-track-add') {
          tracks.push({ id: owned.trackId, kind: 'visual', enabled: true, locked: false });
        } else {
          const track = tracks.find((t) => t.id === owned.trackId);
          need(track?.kind === 'visual' && !track.locked, 'Missing or locked visual track');
          if (owned.type === 'visual-track-assign') {
            const clip = result.sequence.clips.find((c) => c.id === owned.clipId);
            need(clip && clip.kind !== 'audio', 'Missing visual clip');
            need(!tracks.find((t) => t.id === clip.trackId)?.locked, 'Locked track');
            clip.trackId = track.id;
          } else {
            need(owned.direction === 1 || owned.direction === -1, 'Visual track direction');
            const visual = tracks.filter((t) => t.kind === 'visual');
            const neighbor = visual[visual.indexOf(track) + owned.direction];
            need(neighbor && !neighbor.locked, 'Missing or locked neighboring visual track');
            const first = tracks.indexOf(track),
              second = tracks.indexOf(neighbor);
            [tracks[first], tracks[second]] = [tracks[second], tracks[first]];
          }
        }
        assertVideoContentV3(result);
        return result;
      },
    };
  }
  if (edit.type === 'visual-fade') {
    const owned = structuredClone(edit);
    return {
      type: 'video.prototype.v3.visual-fade',
      label: 'Set visual fades',
      readonlyInput: true,
      reads: { content: ['*'] },
      apply(input) {
        assertVideoContentV3(input);
        const result = structuredClone(input);
        const clip = result.sequence.clips.find((c) => c.id === owned.clipId);
        need(clip && clip.kind !== 'audio', 'Missing visual clip');
        need(!result.sequence.tracks.find((t) => t.id === clip.trackId)?.locked, 'Locked track');
        clip.visualFade = {
          start: { ...clip.sourceIn },
          end: { ...clip.sourceOut },
          in: multiply(owned.fadeIn, clip.rate),
          out: multiply(owned.fadeOut, clip.rate),
        };
        assertVideoContentV3(result);
        return result;
      },
    };
  }
  if (edit.type !== 'gain' && edit.type !== 'fade') return timelineCommand(schema, edit);
  const mediaEdit = videoCommandV2(edit);
  return {
    ...mediaEdit,
    type: `video.prototype.v3.${edit.type}`,
    apply(input) {
      assertVideoContentV3(input);
      const media = mediaEdit.apply(mediaContentV3(input));
      const clips = new Map(media.sequence.clips.map((c) => [c.id, c]));
      const result: VideoContentV3 = {
        ...input,
        sequence: {
          ...input.sequence,
          clips: input.sequence.clips.map((c) =>
            c.kind !== 'audio'
              ? c
              : { ...clips.get(c.id)!, ...(c.linkGroupId ? { linkGroupId: c.linkGroupId } : {}) },
          ),
        },
      };
      assertVideoContentV3(result);
      return result;
    },
  };
}
/** Host uses a revision-bound prepared candidate; no automatic latest-version following. */
export function updateAnimationClipV3(
  clipId: string,
  expected: AnimationEmbed2['source'],
  next: AnimationEmbed2,
): EditorCommand<VideoContentV3> {
  const owned = structuredClone({ clipId, expected, next });
  return {
    type: 'video.prototype.v3.animation-pin',
    label: 'Update Animation version',
    readonlyInput: true,
    reads: { content: ['*'] },
    apply(input) {
      const identities = new Map<string, string>();
      assertVideoContentV3(input, identities);
      const result = structuredClone(input),
        clip = result.sequence.clips.find((c) => c.id === owned.clipId);
      need(clip?.kind === 'animation', 'Missing Animation clip');
      need(!result.sequence.tracks.find((t) => t.id === clip.trackId)?.locked, 'Locked track');
      need(
        canonicalJson(clip.embed.source) === canonicalJson(owned.expected),
        'Animation pin changed',
      );
      clip.embed = structuredClone(owned.next);
      assertVideoContentV3(result, identities);
      return result;
    },
  };
}
