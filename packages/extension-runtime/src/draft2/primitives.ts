import { deepFreeze } from '@editor-platform/artifact-core';
import type { DrainReport, Scope } from '@editor-platform/extension-contract/draft2';

export class ReferenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new ReferenceError(code);
}
/** Explicit Host monotonic scheduler. Deadlines are observation, not cancellation. */
export interface Clock {
  now(): number;
  subscribe(listener: () => void): () => void;
}
export function finite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
export function copyData<T>(value: T, maxBytes = 65536): T {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    requireThat(++nodes <= 4096 && depth <= 24, 'DataLimit');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') {
      requireThat(Number.isFinite(item), 'Data');
      return;
    }
    requireThat(typeof item === 'object', 'Data');
    requireThat(!seen.has(item), 'Data');
    seen.add(item);
    requireThat(
      Array.isArray(item) ||
        Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null,
      'Data',
    );
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      requireThat(
        typeof key === 'string' && descriptor.enumerable && 'value' in descriptor,
        'Data',
      );
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  requireThat(new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes, 'DataLimit');
  return structuredClone(value);
}
export const frozen = <T>(value: T): T => deepFreeze(copyData(value));
export function aborted(signal?: AbortSignal): void {
  requireThat(!signal?.aborted, 'Aborted');
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Stops delivery promptly, while continuing to observe the owned underlying work. */
export function delivery<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  check: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      cleanup();
      reject(new ReferenceError('ScopeRevoked'));
    };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    if (signal.aborted) {
      cancel();
    } else signal.addEventListener('abort', cancel, { once: true });
    promise.then(
      (value) => {
        cleanup();
        try {
          check();
          resolve(value);
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
interface Owned {
  state: 'registered' | 'pending' | 'settled' | 'failed';
  dispose?: () => void | Promise<void>;
  reason?: string;
}
export class Ownership {
  private entries = new Map<string, Owned>();
  private listeners = new Set<() => void>();
  private closed = false;
  constructor(
    readonly scope: Scope,
    readonly clock: Clock,
    private readonly limit = 64,
  ) {}
  private change() {
    for (const notify of [...this.listeners]) notify();
  }
  register(id: string, dispose: () => void | Promise<void>): void {
    requireThat(
      !this.closed && id.length > 0 && !this.entries.has(id) && this.entries.size < this.limit,
      'OwnershipAdmission',
    );
    this.entries.set(id, { state: 'registered', dispose });
  }
  hold(id: string): { done(): void; fail(reason: string): void } {
    this.register(id, () => {});
    const entry = this.entries.get(id)!;
    entry.state = 'pending';
    delete entry.dispose;
    return {
      done: () => {
        if (entry.state === 'pending') {
          entry.state = 'settled';
          this.change();
        }
      },
      fail: (reason) => {
        if (entry.state === 'pending') {
          entry.state = 'failed';
          entry.reason = reason;
          this.change();
        }
      },
    };
  }
  revoke(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'registered') continue;
      entry.state = 'pending';
      try {
        Promise.resolve(entry.dispose!()).then(
          () => {
            entry.state = 'settled';
            this.change();
          },
          (error) => {
            entry.state = 'failed';
            entry.reason = String(error);
            this.change();
          },
        );
      } catch (error) {
        entry.state = 'failed';
        entry.reason = String(error);
      }
      delete entry.dispose;
    }
    this.change();
  }
  report(): DrainReport {
    const pending: string[] = [];
    const failed: { resourceId: string; reason: string }[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.state === 'registered' || entry.state === 'pending') pending.push(id);
      if (entry.state === 'failed') failed.push({ resourceId: id, reason: entry.reason! });
    }
    return frozen({
      scope: this.scope,
      state: pending.length || failed.length ? 'incomplete' : 'drained',
      pending,
      failed,
    });
  }
  drain({ deadlineMs }: { deadlineMs: number }): Promise<DrainReport> {
    requireThat(finite(deadlineMs), 'Deadline');
    return new Promise((resolve) => {
      let stop = () => {};
      const inspect = () => {
        const report = this.report();
        if (!report.pending.length || this.clock.now() >= deadlineMs) {
          this.listeners.delete(inspect);
          stop();
          resolve(report);
        }
      };
      this.listeners.add(inspect);
      stop = this.clock.subscribe(inspect);
      inspect();
    });
  }
}
