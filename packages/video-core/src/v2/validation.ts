import { assertVideoContentV1 } from '../v1/validation';
import type { VideoContentV1 } from '../v1/model';
import type { VideoContentV2 } from './model';
import { add, compare, isTime, subtract, time } from '../time';
function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function record(v: unknown): Record<string, unknown> {
  need(
    v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(v)),
    'Expected v2 record',
  );
  return v as Record<string, unknown>;
}
/** Internal structural projection; only call after v2 structural traversal. */
export function baseContentV2(content: VideoContentV2): VideoContentV1 {
  return structuredClone({
    ...content,
    schema: 'video-core-prototype-v1',
    sequence: {
      ...content.sequence,
      clips: content.sequence.clips.map((c) => {
        if (c.kind === 'video') return c;
        const { gain, fade, ...base } = c;
        void gain;
        void fade;
        return base;
      }),
    },
  });
}
export function assertVideoContentV2(value: unknown): asserts value is VideoContentV2 {
  const v = record(value);
  need(v.schema === 'video-core-prototype-v2', 'Unsupported video v2 schema');
  const sequence = record(v.sequence);
  need(Array.isArray(sequence.clips) && sequence.clips.length <= 1000, 'V2 clip limit');
  for (const raw of sequence.clips) {
    const c = record(raw);
    if (c.kind !== 'audio') continue;
    need(
      typeof c.gain === 'number' && Number.isFinite(c.gain) && c.gain >= 0 && c.gain <= 1,
      'Audio gain range',
    );
    const f = record(c.fade);
    need(Object.keys(f).sort().join() === 'end,in,out,start', 'Audio fade fields');
    need(isTime(f.start) && isTime(f.end) && isTime(f.in) && isTime(f.out), 'Audio fade time');
    need(
      compare(f.start, f.end) < 0 &&
        compare(f.in, time(0)) >= 0 &&
        compare(f.out, time(0)) >= 0 &&
        compare(add(f.in, f.out), subtract(f.end, f.start)) <= 0,
      'Audio fade duration',
    );
  }
  const content = value as VideoContentV2;
  assertVideoContentV1(baseContentV2(content));
  for (const c of content.sequence.clips) {
    if (c.kind !== 'audio') continue;
    const stream = content.sources
      .find((s) => s.id === c.sourceId)!
      .streams.find((s) => s.id === c.streamId)!;
    need(stream.kind === 'audio', 'Audio stream');
    need(
      compare(c.fade.start, add(stream.presentationOrigin, stream.validity.start)) >= 0 &&
        compare(c.fade.end, add(stream.presentationOrigin, stream.validity.end)) <= 0,
      'Fade outside original',
    );
  }
}
/** Explicit new draft only; caller retains all old serialized versions byte-for-byte. */
export function adoptVideoContentV2(value: VideoContentV1): VideoContentV2 {
  assertVideoContentV1(value);
  const result: VideoContentV2 = {
    ...structuredClone(value),
    schema: 'video-core-prototype-v2',
    sequence: {
      ...structuredClone(value.sequence),
      clips: value.sequence.clips.map((c) =>
        c.kind === 'video'
          ? structuredClone(c)
          : {
              ...structuredClone(c),
              gain: 1,
              fade: {
                start: { ...c.sourceIn },
                end: { ...c.sourceOut },
                in: time(0),
                out: time(0),
              },
            },
      ),
    },
  };
  assertVideoContentV2(result);
  return result;
}
