import { canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  readCreativeWorldExecutionRecord,
  type CreativeWorldExecutionRecord,
  type CreativeWorldRecordStorage,
} from './generation-record';

/** Host observations only: no commands, job scheduling, input bodies or image bytes. */
export class WorldRecordStore {
  private entries = new Map<
    string,
    {
      desired: CreativeWorldExecutionRecord;
      confirmed?: CreativeWorldExecutionRecord;
      error?: string;
    }
  >();
  private readonly epochs = new Map<string, number>();
  private readonly reads = new Map<string, number>();
  private touch(artifactId: string) {
    this.epochs.set(artifactId, (this.epochs.get(artifactId) ?? 0) + 1);
  }
  private writes = new Map<string, Promise<void>>();
  constructor(
    readonly namespace: string,
    private readonly io: CreativeWorldRecordStorage,
    private readonly authorize: (artifactId: string, write: boolean) => void,
    private readonly changed: () => void,
  ) {}
  private checked(raw: unknown, artifactId: string) {
    const record = readCreativeWorldExecutionRecord(raw);
    if (record.namespace !== this.namespace || record.scope.artifactId !== artifactId)
      throw Error('別作品・別Artifactの実行記録です。');
    return record;
  }
  async load(artifactId: string) {
    this.authorize(artifactId, false);
    const epoch = this.epochs.get(artifactId) ?? 0,
      read = (this.reads.get(artifactId) ?? 0) + 1;
    this.reads.set(artifactId, read);
    const raw = await this.io.list(this.namespace, artifactId);
    this.authorize(artifactId, false);
    if (!Array.isArray(raw) || raw.length > 256)
      throw Error('実行記録はArtifactあたり256件までです。');
    if (this.reads.get(artifactId) !== read || (this.epochs.get(artifactId) ?? 0) !== epoch)
      return this.forArtifact(artifactId);
    const records = raw.map((r) => this.checked(r, artifactId));
    if (new Set(records.map((r) => r.operationId)).size !== records.length)
      throw Error('実行記録の操作IDが重複しています。');
    for (const record of records) {
      const current = this.entries.get(record.operationId);
      if (current?.confirmed && record.revision < current.confirmed.revision) continue;
      if (
        current?.confirmed?.revision === record.revision &&
        canonicalJson(current.confirmed) !== canonicalJson(record)
      )
        throw Error('実行記録の同じrevisionに異なる内容があります。');
      if (!current || canonicalJson(current.desired) === canonicalJson(current.confirmed))
        this.entries.set(record.operationId, { desired: clone(record), confirmed: clone(record) });
    }
    for (const entry of this.entries.values())
      if (
        entry.desired.scope.artifactId === artifactId &&
        !records.some((r) => r.operationId === entry.desired.operationId)
      )
        entry.confirmed = undefined;
    return this.forArtifact(artifactId);
  }
  forArtifact(artifactId: string) {
    this.authorize(artifactId, false);
    return [...this.entries.values()]
      .filter((e) => e.desired.scope.artifactId === artifactId)
      .map((e) => clone(e.desired));
  }
  get(operationId: string) {
    const entry = this.entries.get(operationId);
    if (!entry) throw Error('実行記録がありません。');
    this.authorize(entry.desired.scope.artifactId, false);
    return clone(entry.desired);
  }
  state(operationId: string) {
    const entry = this.entries.get(operationId);
    if (!entry) throw Error('実行記録がありません。');
    return {
      dirty: canonicalJson(entry.desired) !== canonicalJson(entry.confirmed),
      error: entry.error,
    };
  }
  get pending() {
    return (
      this.writes.size > 0 ||
      [...this.entries.values()].some(
        (e) => canonicalJson(e.desired) !== canonicalJson(e.confirmed),
      )
    );
  }
  create(record: CreativeWorldExecutionRecord) {
    this.authorize(record.scope.artifactId, true);
    this.checked(record, record.scope.artifactId);
    if (
      this.entries.has(record.operationId) ||
      this.forArtifact(record.scope.artifactId).length >= 256
    )
      throw Error('実行記録の重複または上限です。');
    this.entries.set(record.operationId, { desired: clone(record) });
    this.touch(record.scope.artifactId);
    this.changed();
  }
  update(operationId: string, mutate: (record: CreativeWorldExecutionRecord) => void) {
    const entry = this.entries.get(operationId);
    if (!entry) throw Error('実行記録がありません。');
    const next = clone(entry.desired);
    mutate(next);
    this.checked(next, entry.desired.scope.artifactId);
    if (
      canonicalJson([
        next.operationId,
        next.namespace,
        next.requestId,
        next.scope,
        next.context,
      ]) !==
      canonicalJson([
        entry.desired.operationId,
        entry.desired.namespace,
        entry.desired.requestId,
        entry.desired.scope,
        entry.desired.context,
      ])
    )
      throw Error('実行の対象・固定入力は差し替えられません。');
    entry.desired = next;
    this.touch(next.scope.artifactId);
    this.changed();
  }
  async flush(operationId?: string): Promise<void> {
    if (!operationId) {
      const results = await Promise.allSettled(
        [...this.entries.keys()].map((id) => this.flush(id)),
      );
      const failed = results.find((r) => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return;
    }
    const existing = this.writes.get(operationId);
    if (existing) return existing;
    const pending = this.write(operationId).finally(() => {
      this.writes.delete(operationId);
      this.changed();
    });
    this.writes.set(operationId, pending);
    return pending;
  }
  private async write(operationId: string) {
    const entry = this.entries.get(operationId)!;
    try {
      while (canonicalJson(entry.desired) !== canonicalJson(entry.confirmed)) {
        const expected = entry.confirmed?.revision ?? null;
        const next = clone(entry.desired);
        next.revision = (expected ?? 0) + 1;
        this.checked(next, next.scope.artifactId);
        this.authorize(next.scope.artifactId, true);
        try {
          await this.io.write(clone(next), expected);
        } catch (error) {
          // A lost response can have committed. A matching row acknowledges only
          // this exact write; a different newer row is never overwritten.
          this.authorize(next.scope.artifactId, false);
          const raw = await this.io.list(this.namespace, next.scope.artifactId);
          this.authorize(next.scope.artifactId, false);
          if (!Array.isArray(raw) || raw.length > 256) throw error;
          const saved = raw
            .map((r) => this.checked(r, next.scope.artifactId))
            .find((r) => r.operationId === next.operationId);
          if (!saved || canonicalJson(saved) !== canonicalJson(next)) throw error;
        }
        this.authorize(next.scope.artifactId, true);
        entry.confirmed = clone(next);
        this.touch(next.scope.artifactId);
        // Preserve edits/receipts produced while IO was pending, not the older completion.
        entry.desired.revision = next.revision;
        entry.error = undefined;
        this.changed();
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      this.changed();
      throw error;
    }
  }
}
