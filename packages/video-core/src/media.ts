import type { MediaAssetRef } from './model';
import { assertMediaAsset } from './validation';
/** Host promises verified immutable bytes pinned for lease lifetime. Never a URL. */
export interface MediaLease {
  asset: MediaAssetRef;
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  release(): void | Promise<void>;
}
export interface MediaReader {
  open(asset: MediaAssetRef, signal: AbortSignal): Promise<MediaLease>;
}
export interface ProbeBudget {
  maxReadBytes: number;
  maxTotalBytes: number;
  maxReads: number;
}
export interface ProbeInput {
  asset: Readonly<MediaAssetRef>;
  read(offset: number, length: number): Promise<Uint8Array>;
}
/** Probe remains injected and untrusted; it receives no release or URL capability. */
export interface MediaProbe<T> {
  probe(input: ProbeInput, signal: AbortSignal): Promise<unknown>;
  validate(result: unknown): T;
}
export async function probeMedia<T>(
  asset: MediaAssetRef,
  reader: MediaReader,
  probe: MediaProbe<T>,
  budget: ProbeBudget,
  signal: AbortSignal,
): Promise<T> {
  assertMediaAsset(asset);
  const pin = Object.freeze({ ...asset });
  const limits = { ...budget };
  if (
    ![limits.maxReadBytes, limits.maxTotalBytes, limits.maxReads].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new Error('Invalid probe budget');
  signal.throwIfAborted();
  const lease = await reader.open({ ...pin }, signal);
  let active = true;
  let total = 0;
  let reads = 0;
  const pending = new Set<Promise<Uint8Array>>();
  let validated: T;
  try {
    signal.throwIfAborted();
    assertMediaAsset(lease.asset);
    if (
      lease.asset.assetId !== pin.assetId ||
      lease.asset.sha256 !== pin.sha256 ||
      lease.asset.byteLength !== pin.byteLength
    )
      throw new Error('Media lease identity mismatch');
    const input: ProbeInput = {
      asset: pin,
      read(offset, length) {
        const work = (async () => {
          signal.throwIfAborted();
          if (!active) throw new Error('Probe reader expired');
          if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length <= 0 ||
            offset > pin.byteLength - length ||
            length > limits.maxReadBytes ||
            total > limits.maxTotalBytes - length ||
            reads >= limits.maxReads
          )
            throw new Error('Probe read budget/range exceeded');
          total += length;
          reads++;
          const bytes = await lease.read(offset, length, signal);
          signal.throwIfAborted();
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length)
            throw new Error('Short or invalid media read');
          return bytes.slice();
        })();
        pending.add(work);
        // Observe even a probe's unawaited rejection; drain before releasing the lease.
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        return work;
      },
    };
    const result = await probe.probe(input, signal);
    signal.throwIfAborted();
    validated = probe.validate(result);
  } finally {
    active = false;
    await Promise.allSettled([...pending]);
    await lease.release();
  }
  // Validation is provisional until outstanding reads and asynchronous release finish.
  // A cancellation during either await must not become a successful probe result.
  signal.throwIfAborted();
  return validated;
}
