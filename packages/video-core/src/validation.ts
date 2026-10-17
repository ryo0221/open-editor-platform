import type { VideoContent, MediaAssetRef } from './model';
import { add, compare, isTime, multiply, subtract, time } from './time';
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected record');
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'Expected plain record',
  );
  return value as Record<string, unknown>;
}
function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  const r = record(value);
  requireValue(
    required.every((k) => Object.hasOwn(r, k)) &&
      Object.keys(r).every((k) => required.includes(k) || optional.includes(k)),
    'Unknown or missing field',
  );
  return r;
}
function list(value: unknown, max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, 'Invalid collection or limit');
  return value;
}
function id(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
    'Invalid ID',
  );
}
function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  requireValue(
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max,
    'Invalid integer',
  );
}
function rational(value: unknown, positive = false) {
  requireValue(isTime(value) && (!positive || value.value > 0), 'Invalid canonical time');
}
export function assertMediaAsset(value: unknown): asserts value is MediaAssetRef {
  const a = fields(value, ['assetId', 'sha256', 'byteLength']);
  id(a.assetId);
  requireValue(typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256), 'Invalid SHA-256');
  integer(a.byteLength, 1);
}
/** Strict prototype-only boundary; unsupported fields are never silently lost. */
export function assertVideoContent(value: unknown): asserts value is VideoContent {
  const v = fields(value, ['schema', 'sequence', 'sources']);
  requireValue(v.schema === 'video-core-prototype-v0', 'Unsupported video schema');
  const q = fields(v.sequence, ['id', 'duration', 'frameRate', 'tracks', 'clips']);
  const ids = new Set<string>();
  function unique(value: unknown) {
    id(value);
    requireValue(!ids.has(value), 'Duplicate ID');
    ids.add(value);
  }
  unique(q.id);
  rational(q.duration);
  rational(q.frameRate, true);
  requireValue(
    isTime(q.duration) && q.duration.value >= 0 && compare(q.duration, time(86400)) <= 0,
    'Sequence duration limit',
  );
  requireValue(isTime(q.frameRate) && compare(q.frameRate, time(240)) <= 0, 'Frame rate limit');
  for (const raw of list(v.sources, 100)) {
    const s = fields(raw, ['id', 'asset', 'streams']);
    unique(s.id);
    assertMediaAsset(s.asset);
    const streamIds = new Set<string>();
    const streams = list(s.streams, 32);
    requireValue(streams.length, 'Source has no streams');
    for (const rawStream of streams) {
      const st = record(rawStream);
      id(st.id);
      requireValue(!streamIds.has(st.id), 'Duplicate stream');
      streamIds.add(st.id);
      rational(st.presentationOrigin);
      if (st.kind === 'video') {
        fields(st, ['id', 'kind', 'timebase', 'startPts', 'endPts', 'presentationOrigin']);
        rational(st.timebase, true);
        integer(st.startPts, -Number.MAX_SAFE_INTEGER);
        integer(st.endPts, -Number.MAX_SAFE_INTEGER);
        requireValue(st.endPts > st.startPts, 'Invalid PTS interval');
      } else {
        requireValue(st.kind === 'audio', 'Unsupported stream');
        fields(st, ['id', 'kind', 'sampleRate', 'sampleCount', 'presentationOrigin']);
        integer(st.sampleRate, 1, 384000);
        integer(st.sampleCount, 1);
      }
    }
  }
  for (const raw of list(q.tracks, 32)) {
    const t = fields(raw, ['id', 'kind', 'locked', 'enabled']);
    unique(t.id);
    requireValue(t.kind === 'visual' || t.kind === 'audio', 'Unsupported track');
    requireValue(
      typeof t.locked === 'boolean' && typeof t.enabled === 'boolean',
      'Invalid track flags',
    );
  }
  const groups = new Map<string, number>();
  for (const raw of list(q.clips, 1000)) {
    const c = record(raw);
    const keys = ['id', 'kind', 'trackId', 'sourceId', 'streamId', 'start', 'duration'];
    fields(
      c,
      [
        ...keys,
        ...(c.kind === 'video' ? ['sourceIn', 'sourceOut', 'rate'] : ['sampleIn', 'sampleOut']),
      ],
      ['linkGroupId'],
    );
    unique(c.id);
    id(c.trackId);
    id(c.sourceId);
    id(c.streamId);
    rational(c.start);
    rational(c.duration, true);
    requireValue(isTime(c.start) && c.start.value >= 0, 'Negative placement');
    if (Object.hasOwn(c, 'linkGroupId')) {
      id(c.linkGroupId);
      groups.set(c.linkGroupId, (groups.get(c.linkGroupId) ?? 0) + 1);
    }
    if (c.kind === 'video') {
      rational(c.sourceIn);
      rational(c.sourceOut);
      rational(c.rate, true);
    } else {
      requireValue(c.kind === 'audio', 'Unsupported clip');
      integer(c.sampleIn, 0);
      integer(c.sampleOut, 1);
    }
  }
  for (const [group, count] of groups) {
    requireValue(count >= 2 && !ids.has(group), 'Invalid link group');
  }
  // Typed traversal is safe only after the complete structural pass above.
  const content = value as VideoContent;
  const { sequence, sources } = content;
  for (const c of sequence.clips) {
    const track = sequence.tracks.find((t) => t.id === c.trackId);
    const stream = sources
      .find((s) => s.id === c.sourceId)
      ?.streams.find((s) => s.id === c.streamId);
    requireValue(
      track && track.kind === (c.kind === 'video' ? 'visual' : 'audio') && stream?.kind === c.kind,
      'Missing or mismatched track/source/stream',
    );
    requireValue(
      compare(add(c.start, c.duration), sequence.duration) <= 0,
      'Clip exceeds sequence',
    );
    if (c.kind === 'video' && stream.kind === 'video') {
      const lo = add(stream.presentationOrigin, multiply(time(stream.startPts), stream.timebase));
      const hi = add(stream.presentationOrigin, multiply(time(stream.endPts), stream.timebase));
      requireValue(
        compare(c.sourceIn, lo) >= 0 &&
          compare(c.sourceOut, hi) <= 0 &&
          compare(subtract(c.sourceOut, c.sourceIn), multiply(c.duration, c.rate)) === 0,
        'Invalid video source window',
      );
    } else if (c.kind === 'audio' && stream.kind === 'audio') {
      requireValue(
        c.sampleOut > c.sampleIn &&
          c.sampleOut <= stream.sampleCount &&
          compare(
            subtract(time(c.sampleOut, stream.sampleRate), time(c.sampleIn, stream.sampleRate)),
            c.duration,
          ) === 0,
        'Invalid audio sample window',
      );
      // Accepted source windows must have representable mapped endpoints, including
      // the exclusive end, before evaluation or editing can consume the content.
      add(stream.presentationOrigin, time(c.sampleIn, stream.sampleRate));
      add(stream.presentationOrigin, time(c.sampleOut, stream.sampleRate));
    }
  }
  for (const track of sequence.tracks) {
    const clips = sequence.clips
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => compare(a.start, b.start));
    for (let i = 1; i < clips.length; i++)
      requireValue(
        compare(add(clips[i - 1].start, clips[i - 1].duration), clips[i].start) <= 0,
        'Unsupported same-track overlap',
      );
  }
}
export function validateVideoContent(
  value: unknown,
): { valid: true } | { valid: false; reason: string } {
  try {
    assertVideoContent(value);
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'Invalid video' };
  }
}
