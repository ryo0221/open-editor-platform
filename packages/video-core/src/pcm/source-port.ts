/** Private consumer seam promoted byte-for-byte in behavior from accepted #234. */
import type { SelectedPcmSession } from './selection';
import type { Mapping, PcmWindow } from './render';
import type { Time } from '@editor-platform/video-core';
export interface SourceRequest {
  sourceId: string;
  mapping: Mapping;
  first: number;
  end: number;
  stream: { sampleRate: number };
  valid: { start: Time; end: Time };
}
export interface PcmLease extends PcmWindow {
  /** Exactly one receiving owner; idempotent, only after last read/copy settles. */
  release(): void;
}
export interface ReservationOwner {
  /** Reserve before allocation; return idempotent release. Must use injected Host ledger. */
  reserve(bytes: number): () => void;
}
export interface SourcePort {
  render(request: SourceRequest, signal: AbortSignal): Promise<PcmLease>;
  /** Stop admission and drain actual source work. Outstanding output leases remain charged. */
  dispose(): Promise<void>;
}
/** Source selection, DecodePort, backend and Host ledger are injected by the fixture. */
export function sourcePort(session: Pick<SelectedPcmSession, 'render' | 'dispose'>): SourcePort {
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<PcmLease>>();
  return {
    render(r, signal) {
      if (closed) return Promise.reject(Error('Source port disposed'));
      const job = (async () => {
        const block = await session.render(
          r.mapping,
          r.first,
          r.end,
          48000,
          r.stream.sampleRate,
          r.valid,
          1,
          signal,
        );
        try {
          signal.throwIfAborted();
          if (closed) throw Error('Source port disposed');
          return { ...block.pcm, release: block.release };
        } catch (error) {
          block.release();
          throw error;
        }
      })();
      pending.add(job);
      void job.then(
        () => pending.delete(job),
        () => pending.delete(job),
      );
      return job;
    },
    dispose() {
      closed = true;
      // Publish before native/decoder abort callbacks can reenter. Include port transfer work.
      closing ??= Promise.resolve().then(async () => {
        const sourceDrain = session.dispose();
        const settled = await Promise.allSettled([sourceDrain, ...pending]);
        if (settled[0].status === 'rejected') throw settled[0].reason;
      });
      return closing;
    },
  };
}
