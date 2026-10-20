import type { EditorCommand } from '@editor-platform/editor-core';
import type { ClipV1, VideoContentV1 } from './model';
import { add, multiply, subtract } from '../time';
import { timelineCommand, type TimelineEdit, type TimelineSchema } from '../timeline-commands';
import { assertVideoContentV1 } from './validation';
export type VideoEditV1 = TimelineEdit<ClipV1>;
const v1: TimelineSchema<VideoContentV1, ClipV1> = {
  commandType: 'video.prototype.v1',
  version: 'v1',
  assert: assertVideoContentV1,
  slice(_v, clip, start, end) {
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
    const sourceIn = add(clip.sourceIn, offset);
    return { ...clip, start, duration, sourceIn, sourceOut: add(sourceIn, duration) };
  },
};
/** Trusted local code only. Host authorization/stale checks occur at submission. */
export function videoCommandV1(edit: VideoEditV1): EditorCommand<VideoContentV1> {
  return timelineCommand(v1, edit);
}
