import type { EditorCommand } from '@editor-platform/editor-core';
import type { Clip, VideoContent } from './model';
import { add, multiply, sampleIndex, subtract, time } from './time';
import { need, timelineCommand, type TimelineEdit, type TimelineSchema } from './timeline-commands';
import { assertVideoContent } from './validation';
export type VideoEdit = TimelineEdit<Clip>;
const v0: TimelineSchema<VideoContent, Clip> = {
  commandType: 'video.prototype',
  version: 'v0',
  assert: assertVideoContent,
  slice(v, clip, start, end) {
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
  },
};
/** Trusted local code only. Host authorization/stale checks occur at submission. */
export function videoCommand(edit: VideoEdit): EditorCommand<VideoContent> {
  return timelineCommand(v0, edit);
}
