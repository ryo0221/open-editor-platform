/** Isolated ownership fixtures, never imported by real M2 or Host consumers. */
import { Ledger } from '../pcm-wasm-r0/kernel';
import { ScheduledAudio } from '../pcm-wasm-v1/scheduled-audio';
import type { PcmLease } from './port';

/** Local cumulative ceiling inside the injected shared realm; close never resets live leases. */
export class FixtureOwner {
  private closed = false;
  bytes = 0;
  peak = 0;
  realmPeak = 0;
  readonly categories = new Map<string, number>();
  constructor(
    readonly realm: Ledger,
    readonly ceiling: number,
  ) {}
  reserve(bytes: number, category = 'pcm') {
    if (this.closed) throw Error('Fixture owner closed');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.ceiling - this.bytes)
      throw Error('Fixture owner admission');
    const releaseRealm = this.realm.reserve(bytes);
    this.bytes += bytes;
    this.peak = Math.max(this.peak, this.bytes);
    this.realmPeak = Math.max(this.realmPeak, this.realm.bytes);
    this.categories.set(category, (this.categories.get(category) ?? 0) + bytes);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.bytes -= bytes;
      this.categories.set(category, this.categories.get(category)! - bytes);
      releaseRealm();
    };
  }
  close() {
    this.closed = true;
  }
}
export function plane(owner: FixtureOwner, frames: number, category: string): PcmLease {
  const release = owner.reserve(frames * 4, category);
  try {
    return { first: 0, rate: 48000, planes: [new Float32Array(frames)], release };
  } catch (error) {
    release();
    throw error;
  }
}
/** Ownership skeleton only: arithmetic stays in the separately frozen oracle. */
export async function mixOwnership(
  owner: FixtureOwner,
  frames: number,
  sources: (() => Promise<PcmLease>)[],
  consume: (source: PcmLease, accumulator: Float64Array) => void,
  finish: (accumulator: Float64Array, output: Float32Array) => void,
  signal: AbortSignal,
): Promise<PcmLease> {
  signal.throwIfAborted();
  const releaseAccumulator = owner.reserve(frames * 8, 'accumulator');
  let output: PcmLease | undefined;
  try {
    const accumulator = new Float64Array(frames);
    for (const source of sources) {
      signal.throwIfAborted();
      const lease = await source();
      try {
        signal.throwIfAborted();
        consume(lease, accumulator);
      } finally {
        lease.release();
      }
    }
    signal.throwIfAborted();
    output = plane(owner, frames, 'returned-mix');
    finish(accumulator, output.planes[0]);
    signal.throwIfAborted();
    const result = output;
    output = undefined;
    return result;
  } finally {
    output?.release();
    releaseAccumulator();
  }
}
/** Copies own their full backing. Alias views do not receive independent release authority. */
function copy(owner: FixtureOwner, input: PcmLease, category: string) {
  const result = plane(owner, input.planes[0].length, category);
  try {
    result.planes[0].set(input.planes[0]);
    return result;
  } catch (error) {
    result.release();
    throw error;
  }
}
export function hashCopy(
  owner: FixtureOwner,
  input: PcmLease,
  digest: (bytes: Float32Array) => Promise<void>,
) {
  const staged = copy(owner, input, 'digest');
  return Promise.resolve()
    .then(() => digest(staged.planes[0]))
    .finally(staged.release);
}
export function abortWait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
type NativeSource = Parameters<ScheduledAudio['own']>[0];
export interface PlaybackPorts {
  createBuffer(frames: number): AudioBuffer;
  copy(buffer: AudioBuffer, pcm: Float32Array): void;
  createSource(): NativeSource;
  connect(source: NativeSource): void;
  start(source: NativeSource): void;
}
/** Native handoff happens before connect/start; failed scheduled setup still needs proven drain. */
export function scheduleFixture(
  input: PcmLease,
  owner: FixtureOwner,
  native: ScheduledAudio,
  ports: PlaybackPorts,
) {
  let release: (() => void) | undefined;
  let source: NativeSource | undefined;
  try {
    release = owner.reserve(input.planes[0].length * 4, 'native-buffer');
    const buffer = ports.createBuffer(input.planes[0].length);
    ports.copy(buffer, input.planes[0]);
    source = ports.createSource();
    source.buffer = buffer;
    native.own(source, release);
    release = undefined;
    ports.connect(source);
    ports.start(source);
  } finally {
    input.release();
    release?.();
  }
}
export interface ExportPorts {
  /** Constructor borrows the supplied backing; clone aliases it. No hidden copy is claimed. */
  sample(data: Float32Array): { close(): void };
  add(sample: { close(): void }): Promise<void>;
  /** Fulfillment must prove ALL worker/encoder/clone readers drained, not just sample.close. */
  consumersDone: Promise<void>;
  digest(data: Float32Array): Promise<void>;
}
export function exportFixture(
  input: PcmLease,
  owner: FixtureOwner,
  ports: ExportPorts,
): Promise<void> {
  // Attach rejection handling immediately; the proof may settle before construction/add.
  const completion = ports.consumersDone.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
  let staged: PcmLease | undefined;
  let hashing: Promise<void> | undefined;
  try {
    staged = copy(owner, input, 'export-backing');
    hashing = hashCopy(owner, input, ports.digest);
  } catch (error) {
    staged?.release();
    throw error;
  } finally {
    input.release();
  }
  const backing = staged;
  const work = (async () => {
    let sample: { close(): void } | undefined;
    let handed = false;
    let proven = false;
    const failures: unknown[] = [];
    try {
      await hashing;
      sample = ports.sample(backing.planes[0]);
      // Even a synchronous add throw may occur after handoff. Require the independent proof.
      handed = true;
      const add = Promise.resolve().then(() => ports.add(sample!));
      const [added, consumed] = await Promise.all([
        add.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        ),
        completion,
      ]);
      proven = consumed.ok;
      if ('error' in added) failures.push(added.error);
      if ('error' in consumed) failures.push(consumed.error);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        sample?.close();
      } catch (error) {
        failures.push(error);
      }
      if (!handed || proven) backing.release(); // Failed/unknown consumer proof conservatively retains.
    }
    if (failures.length) throw new AggregateError(failures, 'Fixture export cleanup');
  })();
  void work.catch(() => {});
  return work;
}
