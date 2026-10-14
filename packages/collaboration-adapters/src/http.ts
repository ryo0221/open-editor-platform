import { clone, parseImmutableJson } from '@editor-platform/artifact-core';
import {
  Conflict,
  type Accepted,
  type AdapterStatus,
  type Domain,
  type Identity,
  type Operation,
  type Presence,
  type Principal,
  type Receipt,
  type Snapshot,
  type SyncAdapter,
} from '@editor-platform/collaboration-core';
/** Example Host adapter: bearer binding and HTTP transport remain outside editor models. */
export class HttpSyncAdapter<T> implements SyncAdapter<T> {
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
    return () => {
      this.statuses.delete(fn);
    };
  }
  private listeners = new Set<(event: Accepted<T>) => void>();
  constructor(
    readonly identity: Identity,
    private token: string,
    readonly domain: Domain,
    readonly base = '/collaboration-api',
    /** Own decoded response content as frozen trees before notifying any consumer. */
    private readonly options: { immutableContent?: boolean } = {},
  ) {}
  static async connect<T>(
    actor: 'A' | 'B' | 'C',
    room: string,
    domain: Domain,
    base = '/collaboration-api',
  ) {
    const response = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor, room }),
    });
    if (!response.ok) throw new Error('Cannot open reference session');
    const result = await response.json();
    return new HttpSyncAdapter<T>(result.identity, result.token, domain, base);
  }
  async request<R>(path: string, body?: unknown, immutableJson = false): Promise<R> {
    if (!this.connected) throw new Error('Disconnected: pending edits retained');
    const response = await fetch(
      `${this.base}${path}${path.includes('?') ? '&' : '?'}domain=${this.domain}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const result = immutableJson
      ? (parseImmutableJson(await response.text()) as R & { code?: string; error?: string })
      : await response.json();
    if (!response.ok)
      throw new Conflict(
        result.code ?? 'invalid-operation',
        result.error ?? 'Transport request failed',
      );
    return result;
  }
  async open() {
    const snapshot = await this.request<Snapshot<T>>(
      '/snapshot',
      undefined,
      this.options.immutableContent,
    );
    return this.options.immutableContent ? mutableEnvelope(snapshot) : snapshot;
  }
  submit(op: Operation) {
    return this.request<Receipt>('/submit', op);
  }
  async receipt(id: string) {
    return (
      (await this.request<Receipt | null>(`/receipt?id=${encodeURIComponent(id)}`)) ?? undefined
    );
  }
  async changes(after: number) {
    let update = await this.request<{ snapshot?: Snapshot<T>; events: Accepted<T>[] }>(
      `/changes?after=${after}`,
      undefined,
      this.options.immutableContent,
    );
    if (this.options.immutableContent) {
      const { snapshot, events, ...rest } = update;
      update = {
        ...clone(rest),
        ...(snapshot === undefined ? {} : { snapshot: mutableEnvelope(snapshot) }),
        events: events.map((event) => {
          const { snapshot, ...envelope } = event;
          return { ...clone(envelope), snapshot: mutableEnvelope(snapshot) };
        }),
      };
    }
    for (const event of update.events) this.listeners.forEach((fn) => fn(event));
    return update;
  }
  subscribe(listener: (event: Accepted<T>) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  presence(value: Omit<Presence, keyof Identity | 'expiresAt'> | null) {
    return this.request<Presence[]>('/presence', { value });
  }
  async permissions() {
    const principal = await this.request<Principal>('/permissions');
    this.statuses.forEach((fn) => fn({ type: 'permissions', principal }));
    return principal;
  }
  close() {
    if (this.connected) void this.request('/close', {}).catch(() => {});
    this.online = false;
    this.listeners.clear();
    this.statuses.forEach((fn) => fn({ type: 'connection', state: 'closed' }));
    this.statuses.clear();
  }
}
// Content retains its private JSON certificate; metadata is still caller-owned
// and must be checked again on every delivery, including duplicate receipts.
function mutableEnvelope<T>(snapshot: Snapshot<T>): Snapshot<T> {
  const { content, ...metadata } = snapshot;
  return { ...clone(metadata), content };
}
