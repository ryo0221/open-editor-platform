import { canonicalJson, clone, contentHash, deepFreeze } from '@editor-platform/artifact-core';

export interface ReferenceTarget {
  kind: string;
  viewId: string;
  columnIds?: string[];
  rowIds?: string[];
  nodeIds?: string[];
}
export interface ReferenceSource {
  artifactId: string;
  domain: string;
  target: ReferenceTarget;
}
export interface ReferenceDependency {
  id: string;
  contentHash: string;
  content: unknown;
}
/** A Host-attested committed version, never a mutable draft or proposal. */
export interface ReferenceSnapshot {
  artifactId: string;
  domain: string;
  versionId: string;
  revision: number;
  contentHash: string;
  content: unknown;
  dependencies: ReferenceDependency[];
}
export interface EmbeddedReference {
  schemaVersion: 1;
  source: ReferenceSource;
  mode: 'fixed' | 'follow';
  fit: 'contain' | 'cover';
  snapshot: ReferenceSnapshot;
}
export interface ReferenceItem {
  id: string;
  reference?: EmbeddedReference;
  src?: string;
}
export interface ReferenceOption {
  label: string;
  source: ReferenceSource;
}
export interface ReferenceHost {
  list(): Promise<ReferenceOption[]>;
  read(
    source: Pick<ReferenceSource, 'artifactId' | 'domain'>,
    signal: AbortSignal,
  ): Promise<ReferenceSnapshot>;
  subscribe(notify: (artifactId: string) => void): () => void;
  /** Revalidate current authorization even when displaying a retained fixed version. */
  checkAccess?(source: ReferenceSource): void | Promise<void>;
  open?(
    source: ReferenceSource,
    destinationElementId: string,
    destinationPageId?: string,
  ): void | Promise<void>;
}
export interface ReferenceProjection {
  src: string;
  label: string;
}
export interface ReferenceAdapter {
  domain: string;
  validate(snapshot: ReferenceSnapshot): void;
  project(snapshot: ReferenceSnapshot, target: ReferenceTarget): ReferenceProjection;
}
export type ReferenceStatus =
  | 'loading'
  | 'ready'
  | 'missing-source'
  | 'missing-target'
  | 'forbidden'
  | 'offline'
  | 'stale'
  | 'unsupported'
  | 'error';
export class ReferenceError extends Error {
  constructor(
    public readonly status: Exclude<ReferenceStatus, 'loading' | 'ready'>,
    message: string,
  ) {
    super(message);
  }
}
export interface ReferenceState {
  status: ReferenceStatus;
  message?: string;
  snapshot?: ReferenceSnapshot;
  projection?: ReferenceProjection;
}
export const referenceLimits = {
  sourceBytes: 2_097_152,
  closureBytes: 4_194_304,
  references: 64,
  depth: 24,
  entries: 150_000,
} as const;
const nativeId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512;
const id = (v: unknown): v is string =>
  nativeId(v) && !['__proto__', 'prototype', 'constructor'].includes(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function jsonBudget(value: unknown, maxBytes: number): boolean {
  let entries = 0,
    bytes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): boolean {
    if (++entries > referenceLimits.entries || depth > referenceLimits.depth) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') {
      bytes += new TextEncoder().encode(v).length;
      return bytes <= maxBytes;
    }
    if (!v || typeof v !== 'object' || seen.has(v)) return false;
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      return false;
    // JSON arrays must be dense own-index sequences. Descriptor iteration and
    // Array#every both skip holes, including indices supplied by a prototype.
    if (Array.isArray(v)) {
      if (v.length > referenceLimits.entries - entries) return false;
      for (let index = 0; index < v.length; index++) if (!Object.hasOwn(v, index)) return false;
    }
    seen.add(v);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (key === 'length' && Array.isArray(v)) continue;
      // Native JSON keys are data, not artifact/domain/target identifiers.
      bytes += new TextEncoder().encode(key).length + 4;
      if (
        (key === 'reference' && 'value' in d && referenceEnvelope(d.value)) ||
        !d.enumerable ||
        !('value' in d) ||
        // canonicalJson omits optional undefined object fields, but arrays must
        // still contain valid JSON values. Do not evaluate accessors.
        (!Array.isArray(v) && d.value === undefined
          ? ++entries > referenceLimits.entries
          : !visit(d.value, depth + 1))
      )
        return false;
    }
    seen.delete(v);
    return bytes <= maxBytes;
  }
  return visit(value, 0) && new TextEncoder().encode(canonicalJson(value)).length <= maxBytes;
}
export function validReferenceSnapshot(value: unknown): value is ReferenceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as ReferenceSnapshot;
  return (
    jsonBudget(value, referenceLimits.closureBytes) &&
    id(s.artifactId) &&
    id(s.domain) &&
    id(s.versionId) &&
    Number.isSafeInteger(s.revision) &&
    s.revision > 0 &&
    hash(s.contentHash) &&
    jsonBudget(s.content, referenceLimits.sourceBytes) &&
    Array.isArray(s.dependencies) &&
    s.dependencies.length <= 8 &&
    new Set(s.dependencies.map((d) => d?.id)).size === s.dependencies.length &&
    s.dependencies.every(
      (d) =>
        !!d &&
        id(d.id) &&
        hash(d.contentHash) &&
        jsonBudget(d.content, referenceLimits.sourceBytes),
    )
  );
}
export function validReferenceSource(value: unknown): value is ReferenceSource {
  if (!value || typeof value !== 'object' || !jsonBudget(value, 65_536)) return false;
  const s = value as ReferenceSource,
    t = s.target;
  return (
    id(s.artifactId) &&
    id(s.domain) &&
    !!t &&
    id(t.kind) &&
    nativeId(t.viewId) &&
    [t.columnIds, t.rowIds, t.nodeIds].every(
      (ids) =>
        ids === undefined ||
        (Array.isArray(ids) &&
          ids.length <= 1000 &&
          ids.every(nativeId) &&
          new Set(ids).size === ids.length),
    )
  );
}
export function validEmbeddedReference(value: unknown): value is EmbeddedReference {
  if (!value || typeof value !== 'object' || !jsonBudget(value, referenceLimits.closureBytes))
    return false;
  const r = value as EmbeddedReference;
  return (
    r.schemaVersion === 1 &&
    validReferenceSource(r.source) &&
    ['fixed', 'follow'].includes(r.mode) &&
    ['contain', 'cover'].includes(r.fit) &&
    validReferenceSnapshot(r.snapshot) &&
    r.source.artifactId === r.snapshot.artifactId &&
    r.source.domain === r.snapshot.domain
  );
}
// Declared hashes alone cannot identify unverified replacement closure bytes.
export const referenceKey = (r: EmbeddedReference) => canonicalJson([r.source, r.mode, r.snapshot]);
/** Safety/capability detection only; this is not a shared native content model. */
export function containsEmbeddedReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const seen = new Set<object>();
  const walk = (v: object): boolean => {
    if (seen.has(v)) return false;
    seen.add(v);
    return Object.entries(Object.getOwnPropertyDescriptors(v)).some(
      ([key, d]) =>
        'value' in d &&
        ((key === 'reference' && referenceEnvelope(d.value)) ||
          (d.value && typeof d.value === 'object' && walk(d.value))),
    );
  };
  return walk(value);
}
function referenceEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return (
    fields.schemaVersion?.value === 1 &&
    ['fixed', 'follow'].includes(fields.mode?.value) &&
    ['contain', 'cover'].includes(fields.fit?.value) &&
    ['source', 'snapshot'].every(
      (key) => fields[key]?.value && typeof fields[key].value === 'object',
    )
  );
}
export function describeReference(item: ReferenceItem): string {
  const r = item.reference;
  return r
    ? `\nReference: ${r.source.artifactId} / ${r.source.domain} / ${canonicalJson(r.source.target)}\nMode: ${r.mode}; fit: ${r.fit}\nVersion: ${r.snapshot.versionId}; SHA-256: ${r.snapshot.contentHash}`
    : '';
}
export function referenceManifest(items: ReferenceItem[]) {
  const references = items.flatMap((i) => (i.reference ? [i.reference] : []));
  if (!references.length) return undefined;
  return {
    schemaVersion: 1,
    sources: references.map((r) => ({
      source: r.source,
      mode: r.mode,
      fit: r.fit,
      versionId: r.snapshot.versionId,
      revision: r.snapshot.revision,
      contentHash: r.snapshot.contentHash,
      dependencies: r.snapshot.dependencies.map((d) => ({ id: d.id, contentHash: d.contentHash })),
    })),
  };
}
export function referenceExportManifest(items: ReferenceItem[]): string | undefined {
  const manifest = referenceManifest(items);
  return manifest && canonicalJson(manifest);
}
export function validReferenceItems(items: ReferenceItem[]): boolean {
  const references: EmbeddedReference[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return false;
    const descriptor = Object.getOwnPropertyDescriptor(item, 'reference');
    if (!descriptor && 'reference' in item) return false;
    if (descriptor && !('value' in descriptor)) return false;
    if (descriptor?.value !== undefined) references.push(descriptor.value);
  }
  return (
    references.length <= referenceLimits.references &&
    references.every(validEmbeddedReference) &&
    new TextEncoder().encode(canonicalJson(references)).length <= referenceLimits.closureBytes
  );
}
export const referenceLimitMessage =
  '参照情報が不正か上限を超えています（64件・保持情報の合計4 MiBまで）。';
/** Check a complete prospective destination before committing it or its history. */
export function assertReferenceItems(items: ReferenceItem[]): void {
  if (!validReferenceItems(items)) throw new ReferenceError('error', referenceLimitMessage);
}
export function svgReferenceProjection(svg: string, label: string): ReferenceProjection {
  const bytes = new TextEncoder().encode(svg);
  if (bytes.length > referenceLimits.sourceBytes)
    throw new ReferenceError('error', '参照描画が資源上限を超えています。');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { src: `data:image/svg+xml;base64,${btoa(binary)}`, label };
}

/** Runtime resolution is view state; no destination commands or history are executed. */
export class ReferenceResolver {
  private adapters: Map<string, ReferenceAdapter>;
  private states = new Map<string, ReferenceState>();
  private generations = new Map<string, number>();
  private requests = new Map<string, AbortController>();
  private observers = new Map<string, number>();
  private generation = 0;
  private watermarks = new Map<string, ReferenceSnapshot>();
  private revisions = new Map<string, string>();
  private versions = new Map<string, string>();
  private dependencies = new Map<string, string>();
  private listeners = new Set<() => void>();
  constructor(
    public readonly host: ReferenceHost,
    adapters: ReferenceAdapter[],
    public readonly destinationArtifactId?: string,
  ) {
    this.adapters = new Map(adapters.map((a) => [a.domain, a]));
  }
  forDestination(artifactId: string) {
    return new ReferenceResolver(this.host, [...this.adapters.values()], artifactId);
  }
  private adapter(domain: string) {
    const adapter = this.adapters.get(domain);
    if (!adapter) throw new ReferenceError('unsupported', `参照元の種類 ${domain} は未対応です。`);
    return adapter;
  }
  async validate(snapshot: ReferenceSnapshot, source: ReferenceSource): Promise<ReferenceSnapshot> {
    const owned = await this.verify(snapshot, source);
    this.accept(owned, false);
    return owned;
  }
  private async verify(
    snapshot: ReferenceSnapshot,
    source: ReferenceSource,
  ): Promise<ReferenceSnapshot> {
    if (
      !validReferenceSource(source) ||
      !validReferenceSnapshot(snapshot) ||
      snapshot.artifactId !== source.artifactId ||
      snapshot.domain !== source.domain ||
      snapshot.artifactId === this.destinationArtifactId
    )
      throw new ReferenceError('error', '不正な参照、自己参照、再帰参照または資源上限超過です。');
    const owned = deepFreeze(clone(snapshot));
    if ((await contentHash(owned.content)) !== owned.contentHash)
      throw new ReferenceError('error', '参照元contentのhashが一致しません。');
    for (const d of owned.dependencies)
      if ((await contentHash(d.content)) !== d.contentHash)
        throw new ReferenceError('error', '参照依存のhashが一致しません。');
    this.adapter(source.domain).validate(owned);
    this.adapter(source.domain).project(owned, source.target);
    return owned;
  }
  private accept(owned: ReferenceSnapshot, live = true) {
    // Retained/history snapshots share the immutable identity contract with
    // live reads, but may legitimately precede the live rollback watermark.
    const key = canonicalJson([owned.artifactId, owned.domain, owned.revision]);
    const identity = canonicalJson([
      owned.versionId,
      owned.contentHash,
      owned.dependencies.map((d) => [d.id, d.contentHash]),
    ]);
    const previous = this.revisions.get(key);
    if (previous !== undefined && previous !== identity)
      throw new ReferenceError('stale', '同じrevisionに矛盾する保存版があります。');
    const versionKey = canonicalJson([owned.artifactId, owned.domain, owned.versionId]);
    const versionIdentity = canonicalJson([
      owned.revision,
      owned.contentHash,
      owned.dependencies.map((d) => [d.id, d.contentHash]),
    ]);
    const previousVersion = this.versions.get(versionKey);
    if (previousVersion !== undefined && previousVersion !== versionIdentity)
      throw new ReferenceError('stale', '同じversion IDに矛盾する保存版があります。');
    const dependencies = owned.dependencies.map((d) => ({
      key: canonicalJson([owned.domain, d.id]),
      hash: d.contentHash,
    }));
    for (const dependency of dependencies) {
      const previous = this.dependencies.get(dependency.key);
      if (previous !== undefined && previous !== dependency.hash)
        throw new ReferenceError('stale', '同じ依存IDに矛盾する保存版があります。');
    }
    const sourceKey = canonicalJson([owned.artifactId, owned.domain]);
    const old = this.watermarks.get(sourceKey);
    if (
      live &&
      old &&
      (old.revision > owned.revision ||
        (old.versionId === owned.versionId && old.contentHash !== owned.contentHash) ||
        (old.revision === owned.revision && canonicalJson(old) !== canonicalJson(owned)))
    )
      throw new ReferenceError('stale', '古い版または矛盾する版の応答です。再取得してください。');
    // Commit identities only after every acceptance check, without an await
    // between checking and recording. Rejected reads must not poison history.
    this.revisions.set(key, identity);
    this.versions.set(versionKey, versionIdentity);
    for (const dependency of dependencies) this.dependencies.set(dependency.key, dependency.hash);
    if (live) this.watermarks.set(sourceKey, owned);
  }
  project(snapshot: ReferenceSnapshot, target: ReferenceTarget): ReferenceProjection {
    return this.adapter(snapshot.domain).project(snapshot, target);
  }
  get(reference: EmbeddedReference): ReferenceState {
    return this.states.get(referenceKey(reference)) ?? { status: 'loading' };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const l of this.listeners) l();
  }
  async create(
    source: ReferenceSource,
    mode: EmbeddedReference['mode'],
  ): Promise<EmbeddedReference> {
    if (!validReferenceSource(source) || !['fixed', 'follow'].includes(mode))
      throw new ReferenceError('error', '不正な参照設定です。');
    await this.host.checkAccess?.(source);
    const snapshot = await this.verify(
      await this.host.read(source, new AbortController().signal),
      source,
    );
    await this.host.checkAccess?.(source);
    this.accept(snapshot);
    return deepFreeze({ schemaVersion: 1, source: clone(source), mode, fit: 'contain', snapshot });
  }
  async refresh(reference: EmbeddedReference): Promise<ReferenceState> {
    if (!validEmbeddedReference(reference))
      return { status: 'error', message: '参照情報が不正です。' };
    const key = referenceKey(reference),
      generation = ++this.generation;
    this.requests.get(key)?.abort();
    const request = new AbortController();
    this.requests.set(key, request);
    this.generations.set(key, generation);
    // Hide previously authorized pixels immediately on an expiry notification.
    // Keep only the snapshot for a validated, explicitly offline fallback.
    this.states.set(key, { status: 'loading', snapshot: this.get(reference).snapshot });
    this.emit();
    let state: ReferenceState;
    try {
      if (!validEmbeddedReference(reference))
        throw new ReferenceError('error', '参照情報が不正です。');
      await this.host.checkAccess?.(reference.source);
      const retained =
        reference.mode === 'follow'
          ? await this.verify(reference.snapshot, reference.source)
          : undefined;
      const snapshot = await this.verify(
        reference.mode === 'fixed'
          ? reference.snapshot
          : await this.host.read(reference.source, request.signal),
        reference.source,
      );
      await this.host.checkAccess?.(reference.source);
      if (this.generations.get(key) !== generation) return this.get(reference);
      if (reference.mode === 'follow') {
        if (snapshot.revision < reference.snapshot.revision)
          throw new ReferenceError('stale', '保持版より古い応答です。');
      }
      const projection = this.project(snapshot, reference.source.target);
      if (retained) this.accept(retained, false);
      this.accept(snapshot, reference.mode === 'follow');
      state = {
        status: 'ready',
        snapshot,
        projection,
      };
    } catch (error) {
      const failure =
        error instanceof ReferenceError
          ? error
          : new ReferenceError(
              'error',
              error instanceof Error ? error.message : '参照を解決できません。',
            );
      state = { status: failure.status, message: failure.message };
      if (failure.status === 'offline') {
        try {
          const cached = this.get(reference).snapshot ?? reference.snapshot;
          const snapshot = await this.verify(cached, reference.source);
          if (this.generations.get(key) !== generation) return this.get(reference);
          const projection = this.project(snapshot, reference.source.target);
          this.accept(snapshot, false);
          state = {
            ...state,
            snapshot,
            projection,
          };
        } catch {
          /* A broken retained closure is never displayed as an offline cache. */
        }
      }
    }
    if (this.generations.get(key) === generation) {
      this.requests.delete(key);
      this.states.set(key, state);
      this.emit();
    }
    return this.get(reference);
  }
  observe(references: EmbeddedReference[], onChange: () => void): () => void {
    if (references.length > referenceLimits.references)
      throw new ReferenceError('error', '参照は一つのSurfaceにつき64件までです。');
    const stop = this.subscribe(onChange);
    const unique = [...new Map(references.map((r) => [referenceKey(r), r])).values()];
    for (const r of unique) {
      const key = referenceKey(r);
      this.observers.set(key, (this.observers.get(key) ?? 0) + 1);
    }
    const unsubscribe = this.host.subscribe((id) => {
      for (const r of unique) if (r.source.artifactId === id) void this.refresh(r);
    });
    for (const r of unique) void this.refresh(r);
    return () => {
      stop();
      unsubscribe();
      for (const r of unique) {
        const key = referenceKey(r),
          count = (this.observers.get(key) ?? 1) - 1;
        if (count) this.observers.set(key, count);
        else {
          this.observers.delete(key);
          this.requests.get(key)?.abort();
          this.requests.delete(key);
          this.generations.delete(key);
          this.states.delete(key);
        }
      }
    };
  }
  /** One read per source for an entire save/export, including several views. No partial result. */
  async capture<T extends ReferenceItem>(items: T[], live = true): Promise<T[]> {
    const owned = clone(items),
      references = owned.filter((i) => i.reference);
    if (references.length > referenceLimits.references)
      throw new ReferenceError('error', '一度にcaptureできる参照は64件までです。');
    const reads = new Map<string, Promise<ReferenceSnapshot>>();
    for (const item of references) {
      const r = item.reference!;
      if (!validEmbeddedReference(r)) throw new ReferenceError('error', '参照情報が不正です。');
      await this.host.checkAccess?.(r.source);
      const key = canonicalJson([r.source.artifactId, r.source.domain]);
      const following = live && r.mode === 'follow';
      const retained = following ? await this.verify(r.snapshot, r.source) : undefined;
      if (following && !reads.has(key))
        reads.set(key, this.host.read(r.source, new AbortController().signal));
      // Never deduplicate retained closures: each one must be hash-checked and
      // compared even when version IDs and content hashes happen to match.
      const snapshot = await this.verify(following ? await reads.get(key)! : r.snapshot, r.source);
      await this.host.checkAccess?.(r.source);
      if (following) {
        if (snapshot.revision < r.snapshot.revision)
          throw new ReferenceError('stale', '保持版より古い応答です。');
      }
      const projection = this.project(snapshot, r.source.target);
      if (retained) this.accept(retained, false);
      this.accept(snapshot, following);
      item.reference = { ...r, snapshot };
      item.src = projection.src;
    }
    if (
      new TextEncoder().encode(canonicalJson(references.map((i) => i.reference))).length >
      referenceLimits.closureBytes
    )
      throw new ReferenceError('error', '参照閉包が4 MBを超えています。');
    return owned;
  }
}
