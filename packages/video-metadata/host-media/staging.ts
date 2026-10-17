import { BUNDLE_LIMIT, type BundleTarget, type BundleStage } from './bundle';
/** Host-owned bounded Blob staging. Download is a separate user action; no disk durability claim. */
export class StagedBlobTarget implements BundleTarget {
  private readonly completed = new Map<string, Blob>();
  private active = false;
  latest: Blob | undefined;
  async begin(operationId: string): Promise<BundleStage> {
    if (this.active || this.completed.has(operationId))
      throw Error('Staging operation busy/reused');
    // This target admits only one stage. Completed bytes cannot change while it
    // is active, so cumulative quota can be reserved before the commit boundary.
    const retainedBytes = [...this.completed.values()].reduce((n, blob) => n + blob.size, 0);
    this.active = true;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0,
      closed = false;
    const check = () => {
      if (closed) throw Error('Closed stage');
    };
    const close = () => {
      closed = true;
      chunks.length = 0;
      this.active = false;
    };
    return {
      async write(bytes, signal) {
        check();
        signal.throwIfAborted();
        if (
          size + bytes.length > BUNDLE_LIMIT ||
          retainedBytes + size + bytes.length > BUNDLE_LIMIT * 2
        )
          throw Error('Stage/retained quota before commit');
        chunks.push(Uint8Array.from(bytes));
        size += bytes.length;
      },
      async read() {
        check();
        return new Blob(chunks);
      },
      commit: async () => {
        check();
        const result = new Blob(chunks);
        this.completed.set(operationId, result);
        this.latest = result;
        close();
      },
      async abort() {
        if (!closed) close();
      },
    };
  }
  async inspect(operationId: string) {
    return this.completed.get(operationId);
  }
}
