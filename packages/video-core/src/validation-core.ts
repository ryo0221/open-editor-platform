import type { Track, VideoClip, VideoStream } from './model';
import { add, compare, isTime, multiply, subtract, time, type Time } from './time';

// Structural primitives shared by every schema version's strict validator.
export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(value: unknown): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected record');
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'Expected plain record',
  );
  return value as Record<string, unknown>;
}
export function fields(
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
export function list(value: unknown, max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, 'Invalid collection or limit');
  return value;
}
export function id(value: unknown): asserts value is string {
  requireValue(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
    'Invalid ID',
  );
}
export function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  requireValue(
    Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max,
    'Invalid integer',
  );
}
export function rational(value: unknown, positive = false) {
  requireValue(isTime(value) && (!positive || value.value > 0), 'Invalid canonical time');
}

interface TypedClip {
  id: string;
  kind: 'video' | 'audio';
  trackId: string;
  sourceId: string;
  streamId: string;
  start: Time;
  duration: Time;
}
interface TypedContent<C extends TypedClip, A> {
  sequence: { duration: Time; tracks: Track[]; clips: C[] };
  sources: { id: string; streams: (VideoStream | A)[] }[];
}

/** Audio representation is what differs between schema versions. */
export interface ContentSchema<C extends TypedClip, A extends { id: string; kind: 'audio' }> {
  schema: string;
  /** Exact audio stream field set (beyond the shared video set). */
  audioStreamFields: string[];
  checkAudioStream(stream: Record<string, unknown>): void;
  /** Exact audio clip source-window fields. */
  audioClipFields: string[];
  checkAudioClip(clip: Record<string, unknown>): void;
  /** Typed checks of each audio stream, after the complete structural pass. */
  checkTypedAudioStream?(stream: A): void;
  /** Typed source-window checks of an audio clip against its stream. */
  checkAudioWindow(clip: Exclude<C, VideoClip>, stream: A): void;
}

/** Strict prototype-only boundary; unsupported fields are never silently lost. */
export function assertContent<
  V extends TypedContent<C, A>,
  C extends TypedClip,
  A extends { id: string; kind: 'audio' },
>(value: unknown, schema: ContentSchema<C, A>): asserts value is V {
  const v = fields(value, ['schema', 'sequence', 'sources']);
  requireValue(v.schema === schema.schema, 'Unsupported video schema');
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
  for (const raw of list(v.sources, 100)) checkSource(raw, unique, schema);
  for (const raw of list(q.tracks, 32)) checkTrack(raw, unique);
  const groups = new Map<string, number>();
  for (const raw of list(q.clips, 1000)) checkClip(raw, unique, groups, schema);
  for (const [group, count] of groups) {
    requireValue(count >= 2 && !ids.has(group), 'Invalid link group');
  }
  // Typed traversal is safe only after the complete structural pass above.
  const { sequence, sources } = value as V;
  if (schema.checkTypedAudioStream)
    for (const source of sources)
      for (const stream of source.streams)
        if (stream.kind === 'audio') schema.checkTypedAudioStream(stream as A);
  for (const c of sequence.clips) checkPlacement(c, sequence, sources, schema);
  checkNoTrackOverlap(sequence);
}

function checkSource<A extends { id: string; kind: 'audio' }>(
  raw: unknown,
  unique: (value: unknown) => void,
  schema: ContentSchema<TypedClip, A>,
) {
  const s = fields(raw, ['id', 'asset', 'streams']);
  unique(s.id);
  assertMediaAssetFields(s.asset);
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
      fields(st, [
        'id',
        'kind',
        'sampleRate',
        'sampleCount',
        'presentationOrigin',
        ...schema.audioStreamFields,
      ]);
      schema.checkAudioStream(st);
      integer(st.sampleRate, 1, 384000);
      integer(st.sampleCount, 1);
    }
  }
}
export function assertMediaAssetFields(value: unknown) {
  const a = fields(value, ['assetId', 'sha256', 'byteLength']);
  id(a.assetId);
  requireValue(typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256), 'Invalid SHA-256');
  integer(a.byteLength, 1);
}
function checkTrack(raw: unknown, unique: (value: unknown) => void) {
  const t = fields(raw, ['id', 'kind', 'locked', 'enabled']);
  unique(t.id);
  requireValue(t.kind === 'visual' || t.kind === 'audio', 'Unsupported track');
  requireValue(
    typeof t.locked === 'boolean' && typeof t.enabled === 'boolean',
    'Invalid track flags',
  );
}
function checkClip<A extends { id: string; kind: 'audio' }>(
  raw: unknown,
  unique: (value: unknown) => void,
  groups: Map<string, number>,
  schema: ContentSchema<TypedClip, A>,
) {
  const c = record(raw);
  const keys = ['id', 'kind', 'trackId', 'sourceId', 'streamId', 'start', 'duration'];
  fields(
    c,
    [...keys, ...(c.kind === 'video' ? ['sourceIn', 'sourceOut', 'rate'] : schema.audioClipFields)],
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
    schema.checkAudioClip(c);
  }
}
function checkPlacement<C extends TypedClip, A extends { id: string; kind: 'audio' }>(
  c: C,
  sequence: TypedContent<C, A>['sequence'],
  sources: TypedContent<C, A>['sources'],
  schema: ContentSchema<C, A>,
) {
  const track = sequence.tracks.find((t) => t.id === c.trackId);
  const stream = sources.find((s) => s.id === c.sourceId)?.streams.find((s) => s.id === c.streamId);
  requireValue(
    track && track.kind === (c.kind === 'video' ? 'visual' : 'audio') && stream?.kind === c.kind,
    'Missing or mismatched track/source/stream',
  );
  requireValue(compare(add(c.start, c.duration), sequence.duration) <= 0, 'Clip exceeds sequence');
  if (stream.kind === 'video') checkVideoWindow(c as unknown as VideoClip, stream);
  else schema.checkAudioWindow(c as Exclude<C, VideoClip>, stream as A);
}
function checkVideoWindow(c: VideoClip, stream: VideoStream) {
  const lo = add(stream.presentationOrigin, multiply(time(stream.startPts), stream.timebase));
  const hi = add(stream.presentationOrigin, multiply(time(stream.endPts), stream.timebase));
  requireValue(
    compare(c.sourceIn, lo) >= 0 &&
      compare(c.sourceOut, hi) <= 0 &&
      compare(subtract(c.sourceOut, c.sourceIn), multiply(c.duration, c.rate)) === 0,
    'Invalid video source window',
  );
}
function checkNoTrackOverlap(sequence: { tracks: Track[]; clips: TypedClip[] }) {
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

export function validationResult(
  assert: (value: unknown) => void,
  value: unknown,
): { valid: true } | { valid: false; reason: string } {
  try {
    assert(value);
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'Invalid video' };
  }
}
