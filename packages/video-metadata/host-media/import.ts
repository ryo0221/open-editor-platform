/** Host-private workflow adapter. No new Core schema or package export. */
import {
  add,
  compare,
  isTime,
  subtract,
  time,
  assertVideoContent,
  type Time,
  type VideoContent,
  type Clip,
} from '@editor-platform/video-core';
import { command } from '@editor-platform/editor-core';
import type { LocalReadSnapshot, Scope } from '@editor-platform/extension-contract/draft2';
import { assertImportCapacity } from './capacity';
import type {
  ControlledSurfaceSnapshot,
  PreparedSurfaceCommand,
} from '@editor-platform/extension-contract/controlled-surface';
export interface OriginalStore {
  get(hash: string): Blob | undefined;
  put(hash: string, bytes: Blob): void;
  delete(hash: string): void;
  putPlan(sourceId: string, plan: ImportSet): void;
  getPlan(sourceId: string): ImportSet | undefined;
  deletePlan(sourceId: string): void;
}
export interface SelectedStream {
  id: string;
  kind: 'video' | 'audio';
  destination: string;
  /** Raw media interval and presentation placement are independent exact values. */
  mediaStart: Time;
  mediaEnd: Time;
  presentationStart: Time;
  sampleRate?: number;
}
export interface ImportSet {
  streams: SelectedStream[];
}
export interface ProbePort {
  inspect(original: Blob, signal: AbortSignal): Promise<ImportSet>;
}
export interface ImportBinding {
  read(): LocalReadSnapshot<VideoContent>;
  view(): ControlledSurfaceSnapshot<VideoContent>;
  /** Existing controller's authority/Input/revision guarded submission, not direct session mutation. */
  execute(prepared: PreparedSurfaceCommand<VideoContent>): { state: string };
  check(): void;
}
export const MAX_ORIGINAL_BYTES = 16 * 1024 * 1024; // First bounded Host workflow, not the final user limit.
export async function digest(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
}
function checkTime(t: Time) {
  if (!isTime(t)) throw Error('Invalid import time');
}
export function prepareImportSet(
  content: VideoContent,
  set: ImportSet,
  asset: { assetId: string; sha256: string; byteLength: number },
  id: string,
): VideoContent {
  assertVideoContent(content);
  if (!Array.isArray(set.streams) || set.streams.length < 1 || set.streams.length > 2)
    throw Error('Select one video and optional one audio');
  if (Object.keys(set).join() !== 'streams') throw Error('Import set fields');
  for (const stream of set.streams) {
    if (!stream || typeof stream !== 'object') throw Error('Stream shape');
    const keys = [
      'id',
      'kind',
      'destination',
      'mediaStart',
      'mediaEnd',
      'presentationStart',
      ...(stream.kind === 'audio' ? ['sampleRate'] : []),
    ];
    if (
      Object.keys(stream).sort().join() !== keys.sort().join() ||
      typeof stream.id !== 'string' ||
      typeof stream.destination !== 'string'
    )
      throw Error('Stream fields');
    [stream.mediaStart, stream.mediaEnd, stream.presentationStart].forEach(checkTime);
  }
  const video = set.streams.filter((s) => s.kind === 'video'),
    audio = set.streams.filter((s) => s.kind === 'audio');
  if (
    video.length !== 1 ||
    audio.length > 1 ||
    new Set(set.streams.map((s) => s.id)).size !== set.streams.length
  )
    throw Error('Ambiguous selected streams');
  const native = structuredClone(content),
    source: VideoContent['sources'][number] = { id, asset, streams: [] },
    clips: Clip[] = [];
  const origin = set.streams.reduce(
    (a, s) => (compare(s.presentationStart, a) < 0 ? s.presentationStart : a),
    set.streams[0].presentationStart,
  );
  for (const s of set.streams) {
    [s.mediaStart, s.mediaEnd, s.presentationStart].forEach(checkTime);
    const duration = subtract(s.mediaEnd, s.mediaStart);
    if (compare(duration, time(0)) <= 0) throw Error('Empty selected stream');
    const destination = native.sequence.tracks.find((t) => t.id === s.destination);
    if (
      !destination ||
      destination.locked ||
      destination.kind !== (s.kind === 'video' ? 'visual' : 'audio')
    )
      throw Error('Selected destination unavailable');
    const start = add(content.sequence.duration, subtract(s.presentationStart, origin)),
      base = {
        id: id + ':' + s.id,
        sourceId: id,
        streamId: s.id,
        trackId: s.destination,
        start,
        duration,
        ...(set.streams.length === 2 ? { linkGroupId: id + ':linked' } : {}),
      };
    if (s.kind === 'video') {
      // Raw seconds use a common rational tick; do not round presentation origin to frame ticks.
      const d = BigInt(s.mediaStart.timescale) * BigInt(s.mediaEnd.timescale);
      if (d > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Source clock overflow');
      const scale = Number(d),
        first = s.mediaStart.value * (scale / s.mediaStart.timescale),
        last = s.mediaEnd.value * (scale / s.mediaEnd.timescale);
      source.streams.push({
        id: s.id,
        kind: 'video',
        timebase: time(1, scale),
        startPts: first,
        endPts: last,
        presentationOrigin: subtract(s.presentationStart, s.mediaStart),
      });
      clips.push({
        ...base,
        kind: 'video',
        sourceIn: s.presentationStart,
        sourceOut: add(s.presentationStart, duration),
        rate: time(1),
      });
    } else {
      const rate = s.sampleRate;
      if (!Number.isSafeInteger(rate) || !rate || rate < 1 || rate > 384000)
        throw Error('Invalid audio rate');
      const n = BigInt(duration.value) * BigInt(rate),
        d = BigInt(duration.timescale);
      if (n % d !== 0n || n / d > BigInt(Number.MAX_SAFE_INTEGER))
        throw Error('Fractional source media requires reviewed resampler');
      const count = Number(n / d);
      source.streams.push({
        id: s.id,
        kind: 'audio',
        sampleRate: rate,
        sampleCount: count,
        presentationOrigin: s.presentationStart,
      });
      clips.push({ ...base, kind: 'audio', sampleIn: 0, sampleOut: count });
    }
  }
  native.sources.push(source);
  native.sequence.clips.push(...clips);
  for (const c of clips) {
    const end = add(c.start, c.duration);
    if (compare(end, native.sequence.duration) > 0) native.sequence.duration = end;
  }
  assertVideoContent(native);
  if (new TextEncoder().encode(JSON.stringify(native)).length > 60000)
    throw Error('Native capture capacity');
  return native;
}
/** Opaque object identity is validated by this Host instance, never by a string brand. */
export interface ImportLease {
  release(): void;
}
interface StagedImport {
  original: Blob;
  hash: string;
  id: string;
  set: ImportSet;
  next: VideoContent;
  snapshot: LocalReadSnapshot<VideoContent>;
}
const sameScope = (a: Scope, b: Scope) =>
  a.artifactId === b.artifactId && a.sessionId === b.sessionId && a.generation === b.generation;
const committing = new WeakSet<OriginalStore>();
export class ImportLeasePool {
  private readonly leases = new Map<ImportLease, StagedImport>();
  private reserved = 0;
  private readonly scope: Scope;
  private disposed = false;
  constructor(
    private readonly store: OriginalStore,
    private readonly binding: ImportBinding,
  ) {
    this.scope = structuredClone(binding.read().scope);
  }
  private check(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed || !sameScope(this.scope, this.binding.read().scope))
      throw Error('Import Host scope changed');
    this.binding.check();
  }
  async stage(original: Blob, probe: ProbePort, signal: AbortSignal): Promise<ImportLease> {
    this.check(signal);
    if (
      original.size < 1 ||
      original.size > MAX_ORIGINAL_BYTES ||
      this.reserved + original.size > 2 * MAX_ORIGINAL_BYTES
    )
      throw Error('Original staging budget');
    this.reserved += original.size;
    let transferred = false;
    try {
      const snapshot = structuredClone(this.binding.read());
      const set = structuredClone(await probe.inspect(original, signal));
      this.check(signal);
      const hash = await digest(original);
      this.check(signal);
      const id = 'source:' + crypto.randomUUID();
      const next = prepareImportSet(
        snapshot.content,
        set,
        { assetId: 'sha256:' + hash, sha256: hash, byteLength: original.size },
        id,
      );
      assertImportCapacity(snapshot, next, this.binding.view());
      const lease: ImportLease = Object.freeze({
        release: () => {
          if (this.leases.delete(lease)) this.reserved -= original.size;
        },
      });
      this.leases.set(lease, { original, hash, id, set, next, snapshot });
      transferred = true;
      return lease;
    } finally {
      if (!transferred) this.reserved -= original.size;
    }
  }
  commit(lease: ImportLease, signal: AbortSignal) {
    const staged = this.leases.get(lease);
    if (!staged) throw Error('Foreign or consumed import lease');
    lease.release(); // Single use even on refusal; never replay against a later revision.
    this.check(signal);
    if (committing.has(this.store)) throw Error('Reentrant media commit');
    committing.add(this.store);
    const { original, hash, id, set, next, snapshot } = staged;
    const had = !!this.store.get(hash);
    let committed = false;
    try {
      assertImportCapacity(this.binding.read(), next, this.binding.view());
      this.store.put(hash, original);
      this.store.putPlan(id, set);
      const outcome = this.binding.execute({
        baseRevision: snapshot.revision,
        command: command('video.import.original', 'Import selected video and audio', () => next),
      });
      if (outcome.state !== 'applied') throw Error('Import refused: ' + outcome.state);
      committed = true;
      return { sourceId: id, hash, selected: structuredClone(set) };
    } finally {
      if (!committed) {
        this.store.deletePlan(id);
        if (!had) this.store.delete(hash);
      }
      committing.delete(this.store);
    }
  }
  dispose() {
    this.disposed = true;
    for (const lease of this.leases.keys()) lease.release();
  }
}
export async function importOriginal(
  original: Blob,
  probe: ProbePort,
  store: OriginalStore,
  binding: ImportBinding,
  signal: AbortSignal,
) {
  const pool = new ImportLeasePool(store, binding);
  try {
    return pool.commit(await pool.stage(original, probe, signal), signal);
  } finally {
    pool.dispose();
  }
}
