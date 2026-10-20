/** Storage-owned adapter shared by the exact private per-version PersistenceFactory ports. */
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { WriteRequest } from '@editor-platform/extension-runtime/draft2';
import { BrowserJournal, type Pin } from '../browser/journal';
import { createProfileBrowserVerifier } from '../browser-verifier/adapter';
import { openPortableFile } from '../browser-verifier/external-file';
import { need, type DigestFactory } from '../portable/io';
import type { ArchiveContent, Project, ProjectProfile } from '../portable/project';
import type { TotalCapacity } from './capacity';
import { ProfileJournalVideoStorage, type History } from './storage';
export interface PersistenceOptions<C> {
  digest: DigestFactory;
  /** Explicit opt-in; Host owns this origin-wide policy/ledger, including its lifetime. */
  capacity?: TotalCapacity;
  /** Must allocate a fresh private namespace for each candidate Host, never overwrite an existing one. */
  namespace(): string;
  newArtifactId(): string;
  empty(): C;
  now(): string;
  journalBytes: number;
  scratchBytes: number;
  externalBytes: number;
  authorize(pin: Readonly<Pin>): boolean;
  /** Optional setup lifetime supplied by the owning Host; original stored scope is never a grant. */
  signal?: AbortSignal;
}
class ScopedStorage<C extends ArchiveContent, P> extends ProfileJournalVideoStorage<C, P> {
  readonly lifetime = new AbortController();
  private jobs = new Set<Promise<unknown>>();
  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }
  override retainCapture(snapshot: LocalReadSnapshot<C>) {
    this.lifetime.signal.throwIfAborted();
    return super.retainCapture(snapshot);
  }
  override write(request: WriteRequest<C>, signal: AbortSignal) {
    if (this.lifetime.signal.aborted) return Promise.resolve({ state: 'unknown' as const });
    return this.track(super.write(request, AbortSignal.any([signal, this.lifetime.signal])));
  }
  override reconcile(operationId: string, signal: AbortSignal) {
    if (this.lifetime.signal.aborted) return Promise.resolve({ state: 'unknown' as const });
    return this.track(
      super.reconcile(operationId, AbortSignal.any([signal, this.lifetime.signal])),
    );
  }
  async drain() {
    this.lifetime.abort();
    await Promise.allSettled([...this.jobs]);
  }
}
type External = Awaited<ReturnType<typeof openPortableFile>>;
/** What differs between project versions: the portable profile and its version tag. */
export interface PersistenceSchema<C extends ArchiveContent, P, K extends External['kind']> {
  kind: K;
  profile: ProjectProfile<C, P>;
}
export function createProfilePersistenceFactory<
  C extends ArchiveContent,
  P,
  K extends External['kind'],
>(schema: PersistenceSchema<C, P, K>, options: PersistenceOptions<C>) {
  const { kind } = schema;
  const profile: ProjectProfile<C, P> = schema.profile;
  return async (live: { originals: Map<string, Blob>; plans: Map<string, P> }, file?: Blob) => {
    const setup = options.signal ?? new AbortController().signal;
    setup.throwIfAborted();
    need(live.originals.size === 0 && live.plans.size === 0, 'Fresh live catalog required');
    let external: External | undefined;
    let journal: BrowserJournal | undefined;
    try {
      if (file) {
        external = await openPortableFile(file, options.digest, setup, options.externalBytes);
        need(
          external.kind === kind,
          `Non-${kind} project requires matching Host; no silent migration`,
        );
      }
      const artifactId = external?.project.capture.scope.artifactId ?? options.newArtifactId();
      let content = options.empty();
      const history: History<C, P> = {
        journalHead: 0,
        versions: [],
        selectedVersionId: null,
        originals: new Map(),
        plans: new Map(),
      };
      if (external?.kind === kind) {
        // The version tag selects exactly this schema's project shape.
        const project = external.project as unknown as Project<C, P>;
        history.versions = structuredClone(project.versions);
        history.selectedVersionId = project.selectedVersionId;
        for (const [id, lease] of external.originals) history.originals.set(id, lease.blob());
        for (const p of project.plans) history.plans.set(p.sourceId, structuredClone(p.plan));
        content = structuredClone(
          history.versions.find((v) => v.versionId === history.selectedVersionId)!.content,
        );
      }
      profile.assertContent(content);
      const namespace = options.namespace();
      journal = await BrowserJournal.open(
        namespace,
        options.journalBytes,
        createProfileBrowserVerifier(options.digest, profile).verify,
        options.authorize,
      );
      const state = await journal.snapshot();
      need(state.head === 0 && state.operations.length === 0, 'Fresh target journal required');
      const storage = new ScopedStorage(
        artifactId,
        journal,
        options.digest,
        namespace + '-scratch',
        options.scratchBytes,
        history,
        options.now,
        { getOriginal: (id) => live.originals.get(id), getPlan: (id) => live.plans.get(id) },
        profile,
        {},
        options.capacity,
      );
      setup.throwIfAborted();
      // Stage all closure checks before modifying the candidate Host's live catalog.
      const selected = content.sources.map((source) => {
        const original = history.originals.get(source.asset.sha256),
          plan = history.plans.get(source.id);
        need(original && plan, 'Selected native closure');
        return { source, original, plan: structuredClone(plan) };
      });
      for (const { source, original, plan } of selected) {
        live.originals.set(source.asset.sha256, original);
        live.plans.set(source.id, plan);
      }
      let closed = false;
      let closing: Promise<void> | undefined;
      const leases = new Set<() => void>();
      const ownedJournal = journal;
      return {
        storage,
        content,
        // Evidence belongs to this same live storage; only its Host coordinator settles the claim.
        reconcile: (operationId: string, signal: AbortSignal) =>
          storage.reconcile(operationId, signal),
        async portable(signal: AbortSignal) {
          need(!closed, 'Persistence closed');
          const combined = AbortSignal.any([signal, storage.lifetime.signal]);
          combined.throwIfAborted();
          const current = (await ownedJournal.snapshot()).current;
          need(current, 'Save before portable output');
          const lease = await ownedJournal.lease(current, combined);
          if (closed || combined.aborted) {
            lease.release();
            combined.throwIfAborted();
            throw Error('Persistence closed');
          }
          const release = () => {
            leases.delete(release);
            lease.release();
          };
          leases.add(release);
          return { bytes: lease.file(), release };
        },
        close() {
          if (closing) return closing;
          closed = true;
          closing = (async () => {
            await storage.drain();
            for (const release of leases) release();
            external?.release();
            external = undefined;
            history.originals.clear();
            history.plans.clear();
            // Live/Undo resources belong to the Host, which releases them after its consumers drain.
            ownedJournal.close();
          })();
          return closing;
        },
      };
    } catch (e) {
      journal?.close();
      external?.release();
      throw e;
    }
  };
}
