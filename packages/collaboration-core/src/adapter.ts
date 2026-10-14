import { Authority } from './authority';
import {
  copy,
  type Accepted,
  type AdapterStatus,
  type Presence,
  type Principal,
  type SyncAdapter,
} from './contracts';
/** Network-free adapter; principal is provided by the embedding Host, never by an operation. */
export function localAdapter<T>(
  authority: Authority<T>,
  principal: Principal,
): SyncAdapter<T> & {
  setPermissions(patch: Pick<Principal, 'writable' | 'scopes' | 'expiresAt'>): void;
} {
  const listeners = new Set<() => void>();
  const statuses = new Set<(status: AdapterStatus) => void>();
  return {
    subscribeStatus: (fn) => {
      statuses.add(fn);
      fn({ type: 'permissions', principal: copy(principal) });
      return () => {
        statuses.delete(fn);
      };
    },
    setPermissions: (patch) => {
      Object.assign(principal, patch);
      statuses.forEach((fn) => fn({ type: 'permissions', principal: copy(principal) }));
    },
    identity: {
      actorId: principal.actorId,
      clientId: principal.clientId,
      sessionId: principal.sessionId,
    },
    open: async () => authority.snapshot(),
    submit: async (op) => authority.commit(principal, op),
    receipt: async (id) => authority.receipt(id),
    changes: async (after) => authority.changes(after),
    subscribe: (listener) => {
      const stop = authority.subscribe(listener);
      listeners.add(stop);
      return () => {
        stop();
        listeners.delete(stop);
      };
    },
    presence: async (value) => authority.presence(principal, value),
    permissions: async () => copy(principal),
    close: () => {
      listeners.forEach((stop) => stop());
      listeners.clear();
      statuses.forEach((fn) => fn({ type: 'connection', state: 'closed' }));
      statuses.clear();
      authority.presence(principal, null);
    },
  };
}
/** Deterministic fault harness. Delivery and acknowledgements can fail independently. */
export class FaultAdapter<T> implements SyncAdapter<T> {
  private online = true;
  private statuses = new Set<(status: AdapterStatus) => void>();
  get connected() {
    return this.online;
  }
  set connected(value: boolean) {
    this.online = value;
    this.statuses.forEach((fn) =>
      fn({ type: 'connection', state: value ? 'online' : 'disconnected' }),
    );
  }
  subscribeStatus(fn: (status: AdapterStatus) => void) {
    this.statuses.add(fn);
    const stop = this.base.subscribeStatus(fn);
    return () => {
      this.statuses.delete(fn);
      stop();
    };
  }
  dropAck = false;
  hold = false;
  duplicate = false;
  queue: Accepted<T>[] = [];
  private listeners = new Set<(event: Accepted<T>) => void>();
  private stop: () => void;
  get identity() {
    return this.base.identity;
  }
  constructor(readonly base: SyncAdapter<T>) {
    this.stop = base.subscribe((event) => {
      if (!this.connected) return;
      if (this.hold) this.queue.push(copy(event));
      else
        this.listeners.forEach((fn) => {
          fn(copy(event));
          if (this.duplicate) fn(copy(event));
        });
    });
  }
  private check() {
    if (!this.connected) throw new Error('Transport disconnected');
  }
  async open() {
    this.check();
    return this.base.open();
  }
  async submit(op: Parameters<SyncAdapter<T>['submit']>[0]) {
    this.check();
    const result = await this.base.submit(op);
    if (this.dropAck) {
      this.dropAck = false;
      throw new Error('Acknowledgement lost');
    }
    return result;
  }
  async receipt(id: string) {
    this.check();
    return this.base.receipt(id);
  }
  async changes(after: number) {
    this.check();
    return this.base.changes(after);
  }
  subscribe(fn: (event: Accepted<T>) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  async presence(value: Omit<Presence, 'actorId' | 'clientId' | 'sessionId' | 'expiresAt'> | null) {
    this.check();
    return this.base.presence(value);
  }
  async permissions() {
    this.check();
    return this.base.permissions();
  }
  flush(reverse = false) {
    const events = this.queue.splice(0);
    if (reverse) events.reverse();
    events.forEach((e) => this.listeners.forEach((fn) => fn(copy(e))));
  }
  close() {
    this.stop();
    this.base.close();
    this.listeners.clear();
  }
}
