import type { EditorCommand } from '@editor-platform/editor-core';
import { videoCommandV1, type VideoEditV1 } from '../v1/commands';
import { assertVideoContentV2, baseContentV2 } from './validation';
import type { ClipV2, AudioClipV2, VideoContentV2 } from './model';
import type { Time } from '../time';
export type VideoEditV2 =
  | Exclude<VideoEditV1, { type: 'insert' }>
  | { type: 'insert'; clip: ClipV2 }
  | { type: 'gain'; clipId: string; gain: number }
  | { type: 'fade'; clipId: string; fadeIn: Time; fadeOut: Time };
export function videoCommandV2(edit: VideoEditV2): EditorCommand<VideoContentV2> {
  const owned = structuredClone(edit);
  return {
    type: `video.prototype.v2.${owned.type}`,
    label: `Video ${owned.type}`,
    readonlyInput: true,
    reads: { content: ['*'] },
    apply(input) {
      assertVideoContentV2(input);
      if (owned.type === 'gain' || owned.type === 'fade') {
        const result = structuredClone(input),
          c = result.sequence.clips.find((c) => c.id === owned.clipId);
        if (c?.kind !== 'audio') throw Error('Missing audio clip');
        if (result.sequence.tracks.find((t) => t.id === c.trackId)?.locked)
          throw Error('Locked track');
        if (owned.type === 'gain') c.gain = owned.gain;
        else
          c.fade = {
            start: { ...c.sourceIn },
            end: { ...c.sourceOut },
            in: { ...owned.fadeIn },
            out: { ...owned.fadeOut },
          };
        assertVideoContentV2(result);
        return result;
      }
      const original = new Map(
        input.sequence.clips
          .filter((c): c is AudioClipV2 => c.kind === 'audio')
          .map((c) => [c.id, c]),
      );
      let baseEdit: VideoEditV1;
      if (owned.type === 'insert' && owned.clip.kind === 'audio') {
        original.set(owned.clip.id, owned.clip);
        const { gain, fade, ...clip } = owned.clip;
        void gain;
        void fade;
        baseEdit = { type: 'insert', clip };
      } else baseEdit = owned;
      const edited = videoCommandV1(baseEdit).apply(baseContentV2(input));
      const result: VideoContentV2 = {
        ...edited,
        schema: 'video-core-prototype-v2',
        sequence: {
          ...edited.sequence,
          clips: edited.sequence.clips.map((c) => {
            if (c.kind === 'video') return c;
            const predecessor =
              original.get(c.id) ??
              (owned.type === 'split'
                ? original.get(
                    Object.entries(owned.rightIds).find(([, right]) => right === c.id)?.[0] ?? '',
                  )
                : undefined);
            if (!predecessor) throw Error('Missing audio effect predecessor');
            return { ...c, gain: predecessor.gain, fade: structuredClone(predecessor.fade) };
          }),
        },
      };
      assertVideoContentV2(result);
      return result;
    },
  };
}
