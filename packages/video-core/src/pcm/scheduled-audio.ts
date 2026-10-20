/** Native stop/disconnect enqueue control work; neither is an AudioBuffer drain. */
type Source = Pick<AudioBufferSourceNode, 'stop' | 'disconnect' | 'buffer' | 'onended'>;
export class ScheduledAudio {
  private sources = new Map<Source, () => void>();
  private closing?: Promise<void>;
  private failures: unknown[] = [];
  constructor(private context: Pick<AudioContext, 'close'>) {}
  own(source: Source, release: () => void) {
    if (this.closing || this.sources.has(source)) throw Error('Audio owner closed or duplicate');
    this.sources.set(source, release);
    try {
      source.onended = () => this.ended(source);
    } catch (error) {
      this.sources.delete(source);
      throw error;
    }
  }
  private ended(source: Source) {
    const release = this.sources.get(source);
    if (!release) return;
    this.sources.delete(source);
    source.onended = null;
    try {
      source.disconnect();
    } catch (error) {
      this.failures.push(error);
    }
    try {
      source.buffer = null;
    } catch (error) {
      this.failures.push(error);
    }
    release();
  }
  close(): Promise<void> {
    // Publish one drain promise before native callbacks can reenter close.
    this.closing ??= Promise.resolve().then(async () => {
      for (const source of this.sources.keys()) {
        try {
          source.stop();
        } catch {
          /* An unstarted/already ended source still belongs to close. */
        }
        try {
          source.disconnect();
        } catch (error) {
          this.failures.push(error);
        }
      }
      try {
        await this.context.close();
      } catch (error) {
        // The control-thread state can already be closed while rendering still drains.
        // Only this owner's fulfilled close promise or an ended event releases charges.
        throw new AggregateError([...this.failures, error], 'Audio context close failed');
      }
      for (const source of this.sources.keys()) this.ended(source);
      if (this.failures.length)
        throw new AggregateError(this.failures, 'Audio source cleanup failed');
    });
    // Abort initiates close before playTimeline reaches its allSettled drain owner.
    void this.closing.catch(() => {});
    return this.closing;
  }
}
