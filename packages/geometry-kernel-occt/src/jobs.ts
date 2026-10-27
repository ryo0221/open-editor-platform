/** Thrown when a cooperative cancel point sees the job was cancelled. */
export class KernelJobCancelled extends Error {}

/**
 * The Worker side's job order: one job at a time in arrival order, and cancels that arrive
 * between them. A cancel for a job that has not started yet makes `take` refuse it; a running
 * job checks `cancelled` at its own cancel points.
 */
export function createKernelJobs() {
  const cancelled = new Set<string>();
  let queue = Promise.resolve();
  return {
    cancel(requestId: string) {
      cancelled.add(requestId);
    },
    cancelled: (requestId: string) => cancelled.has(requestId),
    /** False when the job was cancelled before it started; the cancel is then consumed. */
    take: (requestId: string) => !cancelled.delete(requestId),
    /** Forgets a cancel that arrived while the job ran. */
    finish(requestId: string) {
      cancelled.delete(requestId);
    },
    /** Runs `job` after every earlier job. */
    enqueue(job: () => Promise<void>) {
      return (queue = queue.then(job));
    },
  };
}
