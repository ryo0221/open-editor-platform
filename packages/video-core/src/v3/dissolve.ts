import { add, compare, multiply, subtract, time, type Time } from '../time';
import type { ClipV3, VideoContentV3, DissolveV3 } from './model';
import { fields, id, rational, requireValue as need } from '../validation-core';
export function dissolveWindow(content: VideoContentV3, edge: DissolveV3) {
  const left = content.sequence.clips.find((c) => c.id === edge.leftClipId);
  const right = content.sequence.clips.find((c) => c.id === edge.rightClipId);
  need(
    left && right && left.kind !== 'audio' && right.kind !== 'audio',
    'Dissolve visual endpoints',
  );
  need(left.trackId === right.trackId && left.id !== right.id, 'Dissolve same-track endpoints');
  const cut = add(left.start, left.duration),
    half = multiply(edge.duration, time(1, 2));
  need(compare(cut, right.start) === 0, 'Dissolve requires adjacent clips');
  need(
    compare(half, left.duration) <= 0 && compare(half, right.duration) <= 0,
    'Dissolve window exceeds clip',
  );
  return { left, right, start: subtract(cut, half), end: add(cut, half), half };
}
function sourceBounds(content: VideoContentV3, clip: Exclude<ClipV3, { kind: 'audio' }>) {
  if (clip.kind === 'video') {
    const source = content.sources.find((s) => s.id === clip.sourceId);
    const stream =
      source && !('kind' in source) && source.streams.find((s) => s.id === clip.streamId);
    need(stream && stream.kind === 'video', 'Dissolve video source');
    return {
      start: add(multiply(time(stream.startPts), stream.timebase), stream.presentationOrigin),
      end: add(multiply(time(stream.endPts), stream.timebase), stream.presentationOrigin),
    };
  }
  if (clip.kind === 'animation') {
    const composition = clip.embed.snapshot.compositions.find(
      (c) => c.id === clip.embed.source.compositionId,
    )!;
    return { start: time(0), end: time(composition.duration, clip.embed.snapshot.ticksPerSecond) };
  }
  // A retained still image/text has no temporal source extent. Its constant visual
  // is available across the edge; this never extends a timed media/Animation source.
  return undefined;
}
export function assertDissolves(content: VideoContentV3, ids: Set<string>) {
  if (Object.hasOwn(content.sequence, 'transitions'))
    need(Array.isArray(content.sequence.transitions), 'Dissolve edges must be an array');
  const edges = content.sequence.transitions ?? [];
  need(Array.isArray(edges) && edges.length <= 1000, 'Dissolve edge limit');
  const windows: { track: string; start: Time; end: Time }[] = [];
  for (const raw of edges) {
    const e = fields(raw, ['id', 'kind', 'leftClipId', 'rightClipId', 'duration']);
    id(e.id);
    id(e.leftClipId);
    id(e.rightClipId);
    rational(e.duration, true);
    need(e.kind === 'cross-dissolve' && !ids.has(e.id as string), 'Dissolve kind/ID');
    ids.add(e.id as string);
    const { left, right, half, start, end } = dissolveWindow(content, raw);
    for (const [clip, before] of [
      [left, false],
      [right, true],
    ] as const) {
      const bounds = sourceBounds(content, clip);
      if (!bounds) continue;
      const handle = multiply(half, clip.rate);
      const endpoint = before ? subtract(clip.sourceIn, handle) : add(clip.sourceOut, handle);
      need(
        compare(endpoint, bounds.start) >= 0 && compare(endpoint, bounds.end) <= 0,
        'Insufficient dissolve source handle',
      );
      if (clip.kind === 'animation')
        need(
          multiply(endpoint, time(clip.embed.snapshot.ticksPerSecond)).timescale === 1,
          'Fractional Animation dissolve handle',
        );
    }
    need(
      !windows.some(
        (w) => w.track === left.trackId && compare(start, w.end) < 0 && compare(w.start, end) < 0,
      ),
      'Overlapping dissolve windows',
    );
    windows.push({ track: left.trackId, start, end });
  }
  if (!edges.length) return;
  // Each enabled source owns one decoder with at most two outstanding frame
  // leases. Check the expanded half-open intervals before content is committed,
  // including later track-enable/move edits and imported portable documents.
  const enabled = new Set(content.sequence.tracks.filter((t) => t.enabled).map((t) => t.id));
  const intervals = new Map<string, { source: string; start: Time; end: Time }>();
  for (const clip of content.sequence.clips)
    if (clip.kind === 'video' && enabled.has(clip.trackId))
      intervals.set(clip.id, {
        source: clip.sourceId,
        start: clip.start,
        end: add(clip.start, clip.duration),
      });
  for (const edge of edges) {
    const window = dissolveWindow(content, edge);
    if (!enabled.has(window.left.trackId)) continue;
    const left = intervals.get(window.left.id),
      right = intervals.get(window.right.id);
    if (left) left.end = window.end;
    if (right) right.start = window.start;
  }
  const events = [...intervals.values()]
    .flatMap((i) => [
      { at: i.start, source: i.source, delta: 1 },
      { at: i.end, source: i.source, delta: -1 },
    ])
    .sort((a, b) => compare(a.at, b.at) || a.delta - b.delta);
  const counts = new Map<string, number>();
  for (const event of events) {
    const count = (counts.get(event.source) ?? 0) + event.delta;
    need(count <= 2, 'Dissolve video source frame admission (maximum two simultaneous frames)');
    counts.set(event.source, count);
  }
}
/** One evaluation plan for still/play/export. Native placements are never expanded. */
export function evaluateVisualV3(content: VideoContentV3, at: Time) {
  const enabled = new Set(content.sequence.tracks.filter((t) => t.enabled).map((t) => t.id));
  const active = new Set(
    content.sequence.clips
      .filter(
        (c) =>
          c.kind !== 'audio' &&
          enabled.has(c.trackId) &&
          compare(at, c.start) >= 0 &&
          compare(at, add(c.start, c.duration)) < 0,
      )
      .map((c) => c.id),
  );
  const edges = (content.sequence.transitions ?? []).flatMap((edge) => {
    const w = dissolveWindow(content, edge);
    if (!enabled.has(w.left.trackId) || compare(at, w.start) < 0 || compare(at, w.end) >= 0)
      return [];
    active.add(w.left.id);
    active.add(w.right.id);
    const offset = subtract(at, w.start),
      progress =
        Number(BigInt(offset.value) * BigInt(edge.duration.timescale)) /
        Number(BigInt(offset.timescale) * BigInt(edge.duration.value));
    return [{ edge, progress }];
  });
  return { active, edges };
}
