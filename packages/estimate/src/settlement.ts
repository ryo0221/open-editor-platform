import { CalculationError } from '@editor-platform/calculation-core';
/** Observes calculation adoption only; never saves, starts work or accepts a preview. */
export type EstimateSettlementState = {
  [Status in
    | 'idle'
    | 'pending'
    | 'accepted'
    | 'candidate'
    | 'failed'
    | 'cancelled'
    | 'closed']: Readonly<{ sequence: number; status: Status; error?: unknown }>;
}['idle' | 'pending' | 'accepted' | 'candidate' | 'failed' | 'cancelled' | 'closed'];
export type EstimateSettlementResult =
  | Exclude<EstimateSettlementState, { status: 'pending' }>
  | Readonly<{ sequence: number; status: 'timeout' | 'superseded' }>;
export interface EstimateSettlement {
  read(): EstimateSettlementState;
  /** Captures this operation, never follows a replacement. Timeout affects only this waiter. */
  wait(options?: { timeoutMs?: number }): Promise<EstimateSettlementResult>;
  /** Operation currency only, not save permission or a Host revision receipt. */
  isCurrent(result: EstimateSettlementResult): boolean;
}
/** Internal state of one Controller incarnation. No global state or Host revision tracking. */
export class EstimateSettlementTracker {
  private state: EstimateSettlementState = Object.freeze({ sequence: 0, status: 'idle' });
  private listeners = new Set<() => void>();
  readonly handle: EstimateSettlement = Object.freeze({
    read: () => this.state,
    wait: (options?: { timeoutMs?: number }) => this.wait(options?.timeoutMs),
    isCurrent: (result: EstimateSettlementResult) =>
      result === this.state && result.status !== 'closed',
  });
  begin() {
    if (this.state.status === 'closed') throw new CalculationError('closed');
    this.set({ sequence: this.state.sequence + 1, status: 'pending' });
    return this.state.sequence;
  }
  finish(sequence: number, status: 'accepted' | 'candidate' | 'failed', error?: unknown) {
    if (this.state.sequence === sequence && this.state.status === 'pending')
      this.set({ sequence, status, ...(error === undefined ? {} : { error }) });
  }
  /** A preflight refusal is not a replacement for an already running operation. */
  refuse(error: unknown) {
    if (this.state.status !== 'pending' && this.state.status !== 'closed')
      this.set({ sequence: this.state.sequence + 1, status: 'failed', error });
  }
  cancel() {
    if (this.state.status === 'pending' || this.state.status === 'candidate')
      this.set({ sequence: this.state.sequence, status: 'cancelled' });
  }
  close() {
    this.set({ sequence: this.state.sequence, status: 'closed' });
  }
  private set(state: EstimateSettlementState) {
    this.state = Object.freeze(state);
    for (const notify of [...this.listeners]) notify();
  }
  private async wait(timeoutMs?: number): Promise<EstimateSettlementResult> {
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    )
      throw new RangeError('timeoutMs must be between 0 and 2147483647');
    const sequence = this.state.sequence;
    const result =
      this.state.status === 'pending'
        ? await new Promise<EstimateSettlementResult>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (value: EstimateSettlementResult) => {
              clearTimeout(timer);
              this.listeners.delete(changed);
              resolve(value);
            };
            const changed = () => {
              if (this.state.sequence !== sequence) finish({ sequence, status: 'superseded' });
              else if (this.state.status !== 'pending') finish(this.state);
            };
            this.listeners.add(changed);
            if (timeoutMs !== undefined)
              timer = setTimeout(() => finish({ sequence, status: 'timeout' }), timeoutMs);
          })
        : this.state;
    if (this.state.status === 'closed') return this.state;
    if (this.state.sequence !== sequence) return { sequence, status: 'superseded' };
    return result;
  }
}
