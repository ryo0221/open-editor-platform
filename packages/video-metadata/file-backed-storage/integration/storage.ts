/** Private proposed Video Storage binding. Existing Host files and public APIs remain unchanged. */
import { canonicalJson, contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import type { VideoContent } from '@editor-platform/video-core';
import type { LocalReadSnapshot, SaveCapture } from '@editor-platform/extension-contract/draft2';
import type {
  Storage,
  WriteEvidence,
  WriteRequest,
} from '@editor-platform/extension-runtime/draft2';
import type { ImportSet } from '../../host-media/import';
import { BrowserJournal, type Pin } from '../browser/journal';
import { writeEvidence } from '../browser/evidence';
import { chunksFromReader } from '../browser/ranges';
import { blobReader, createProfileBrowserVerifier } from '../browser-verifier/adapter';
import { createScanner, need, type DigestFactory } from '../portable/io';
import {
  createProfileProject,
  v0Profile,
  type Project,
  type ArchiveContent,
  type ProjectProfile,
} from '../portable/project';
import { createZip } from '../portable/zip64';
import type { MigrationReference } from '../portable/migration-reference';
import { TotalCapacity } from './capacity';
import { ScratchLedger, type ScratchRecord, type ScratchHooks, type ScratchPhase } from './scratch';
export interface History<C extends ArchiveContent = VideoContent, P = ImportSet> {
  /** Head corresponding to these native versions, never sampled later during dispatch. */
  journalHead: number;
  provenance?: MigrationReference;
  versions: ArtifactVersion<C>[];
  selectedVersionId: string | null;
  originals: Map<string, Blob>;
  plans: Map<string, P>;
}
const keyOf = (snapshot: { scope: unknown; revision: unknown }) =>
  canonicalJson([snapshot.scope, snapshot.revision]);
export interface LiveCatalog<P = ImportSet> {
  /** Borrow immutable bytes/plans; the Host retains current/Undo resources independently. */
  getOriginal(hash: string): Blob | undefined;
  getPlan(sourceId: string): P | undefined;
}
type Pending<C extends ArchiveContent, P> =
  | { pin: Pin; project: Project<C, P>; retained: History<C, P> }
  | { pin: Pin; settled: WriteEvidence };
export class ProfileJournalVideoStorage<C extends ArchiveContent, P> implements Storage<C> {
  readonly settlementMs = 30000;
  private captures = new Map<string, History<C, P>>();
  private pending = new Map<string, Pending<C, P>>();
  /** The existing coordinator invokes this only when its scoped capture is still current. */
  markSaved?: (capture: SaveCapture) => void;
  beforeDispatch?: () => Promise<void>;
  /** Private Host display diagnostic; no authority or persisted native content. */
  capacityRefusal?: {
    operationId: string;
    stage: 'journal' | 'total';
    archiveBytes: number;
    additionalBytes: number;
  };
  constructor(
    readonly key: string,
    readonly journal: BrowserJournal,
    private readonly digest: DigestFactory,
    private readonly scratchNamespace: string,
    private readonly scratchBudget: number,
    readonly history: History<C, P>,
    private readonly now: () => string,
    /** Host owns current/Undo lifetime independently of the saved archive catalog. */
    readonly live: LiveCatalog<P>,
    private readonly profile: ProjectProfile<C, P>,
    private readonly scratchHooks: ScratchHooks = {},
    readonly capacity?: TotalCapacity,
  ) {
    need(
      /^[a-z0-9-]{1,64}$/.test(scratchNamespace) &&
        Number.isSafeInteger(scratchBudget) &&
        scratchBudget > 0,
      'Scratch configuration',
    );
  }
  get resourceOwnership() {
    return {
      captures: this.captures.size,
      unresolvedWrites: [...this.pending.values()].filter((p) => !('settled' in p)).length,
      liveOwnedByHost: true,
      savedOriginals: this.history.originals.size,
    };
  }
  forgetSettled(operationId: string) {
    const item = this.pending.get(operationId);
    need(item && 'settled' in item && item.settled.state !== 'unknown', 'Unresolved operation');
    this.pending.delete(operationId);
  }
  get retainedCaptures() {
    return this.captures.size;
  }
  retainCapture(snapshot: LocalReadSnapshot<C>) {
    need(snapshot.scope.artifactId === this.key, 'Capture artifact');
    const id = keyOf(snapshot);
    need(!this.captures.has(id), 'Capture already retained');
    const versions = structuredClone(this.history.versions),
      originals = new Map<string, Blob>(),
      plans = new Map<string, P>();
    for (const content of [snapshot.content, ...versions.map((v) => v.content)])
      for (const source of content.sources) {
        const original =
            this.live.getOriginal(source.asset.sha256) ??
            this.history.originals.get(source.asset.sha256),
          plan = this.live.getPlan(source.id) ?? this.history.plans.get(source.id);
        need(
          original && original.size === source.asset.byteLength && plan,
          'Captured closure missing',
        );
        originals.set(source.asset.sha256, original);
        plans.set(source.id, structuredClone(plan));
      }
    need(
      versions.length === 0
        ? this.history.selectedVersionId === null
        : versions.some((v) => v.versionId === this.history.selectedVersionId),
      'Captured selected root missing',
    );
    need(
      Number.isSafeInteger(this.history.journalHead) && this.history.journalHead >= 0,
      'History head',
    );
    this.captures.set(id, {
      ...(this.history.provenance ? { provenance: structuredClone(this.history.provenance) } : {}),
      journalHead: this.history.journalHead,
      versions,
      selectedVersionId: this.history.selectedVersionId,
      originals,
      plans,
    });
    return () => {
      this.captures.delete(id);
    };
  }
  private async scratch() {
    const directory = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle(this.scratchNamespace, { create: true });
    const ledger = await ScratchLedger.open(
      this.scratchNamespace,
      this.key,
      this.scratchBudget,
      directory,
    );
    return { directory, ledger };
  }
  private async observed(phase: ScratchPhase, record: ScratchRecord) {
    await this.scratchHooks.observe?.(phase, structuredClone(record));
  }
  async inspectScratch() {
    return navigator.locks.request('video-scratch:' + this.scratchNamespace, async () => {
      const { ledger } = await this.scratch();
      try {
        return await ledger.records();
      } finally {
        ledger.close();
      }
    });
  }
  private async scratchEvidence(
    record: ScratchRecord,
    signal: AbortSignal,
    discard: boolean,
  ): Promise<WriteEvidence> {
    signal.throwIfAborted();
    const op = (await this.journal.snapshot()).operations.find(
      (o) => o.pin.operationId === record.operationId,
    );
    const noWrite = (): WriteEvidence => ({
      state: 'no-write',
      operationId: record.operationId,
      capture: structuredClone(record.capture),
      guarantee: 'never-writes',
    });
    if (!op)
      return (await this.journal.fenceCapture(record.operationId, record.capture)) === 'fenced'
        ? noWrite()
        : { state: 'unknown' };
    if (canonicalJson(op.pin.capture) !== canonicalJson(record.capture))
      return { state: 'unknown' };
    if (op.phase === 'aborted') return noWrite();
    if (!record.pin || canonicalJson(op.pin) !== canonicalJson(record.pin))
      return { state: 'unknown' };
    const result =
      op.phase === 'committed'
        ? await this.journal.reconcile(record.operationId, signal)
        : discard
          ? await this.journal.abandon(record.operationId, signal)
          : undefined;
    return result ? writeEvidence(result, record.pin) : { state: 'unknown' };
  }
  private async cleanupScratch(
    ledger: ScratchLedger,
    directory: FileSystemDirectoryHandle,
    record: ScratchRecord,
    signal: AbortSignal,
    authorize: (record: Readonly<ScratchRecord>) => boolean,
    discard: boolean,
  ): Promise<WriteEvidence> {
    signal.throwIfAborted();
    need(authorize(structuredClone(record)) === true, 'Scratch recovery authority');
    const evidence = await this.scratchEvidence(record, signal, discard);
    if (evidence.state === 'unknown') return evidence; // Preserve potentially recoverable completed scratch.
    signal.throwIfAborted();
    need(authorize(structuredClone(record)) === true, 'Scratch recovery authority');
    if (record.phase !== 'done') {
      record = await ledger.update(record.operationId, (r) => {
        r.phase = 'cleaning';
        r.outcome = evidence.state === 'committed' ? 'committed' : 'no-write';
      });
      await this.observed('scratch-cleaning', record);
      signal.throwIfAborted();
      need(authorize(structuredClone(record)) === true, 'Scratch cleanup authority');
      await directory.removeEntry(record.file).catch((e) => {
        if (e.name !== 'NotFoundError') throw e;
      });
      await this.observed('scratch-removed', record);
      signal.throwIfAborted();
      need(authorize(structuredClone(record)) === true, 'Scratch cleanup authority');
      await ledger.update(record.operationId, (r) => {
        r.phase = 'done';
      });
    }
    return evidence;
  }
  private capacityId(operationId: string) {
    return this.journal.namespace + ':' + operationId;
  }
  /** Explicit discard of unpublished preparation, or cleanup of a verified completed write. */
  async recoverScratch(
    operationId: string,
    signal: AbortSignal,
    authorize: (record: Readonly<ScratchRecord>) => boolean,
  ): Promise<WriteEvidence> {
    return navigator.locks.request('video-scratch:' + this.scratchNamespace, async () => {
      let ledger: ScratchLedger | undefined;
      try {
        const opened = await this.scratch();
        ledger = opened.ledger;
        const record = (await ledger.records()).find((r) => r.operationId === operationId);
        need(record, 'Unknown scratch operation');
        const evidence = await this.cleanupScratch(
          ledger,
          opened.directory,
          record,
          signal,
          authorize,
          true,
        );
        if (evidence.state !== 'unknown')
          await this.capacity?.settle(
            this.capacityId(operationId),
            this.scratchNamespace + '/' + record.file,
            evidence.state === 'committed' ? 'committed' : 'no-write',
          );
        await this.acceptEvidence(operationId, evidence);
        return evidence;
      } catch {
        return { state: 'unknown' };
      } finally {
        ledger?.close();
      }
    });
  }
  private async acceptEvidence(operationId: string, evidence: WriteEvidence) {
    const item = this.pending.get(operationId);
    if (!item || evidence.state === 'unknown') return;
    const selected =
      evidence.state === 'committed' && !('settled' in item)
        ? (await this.journal.snapshot()).current
        : undefined;
    // An async verification must not revive a forgotten or replaced receipt owner.
    if (this.pending.get(operationId) !== item) return;
    if (selected === operationId && !('settled' in item)) this.adopt(item.project, item.retained);
    this.pending.set(operationId, { pin: item.pin, settled: evidence });
  }
  async write(request: WriteRequest<C>, signal: AbortSignal): Promise<WriteEvidence> {
    try {
      const retained = this.captures.get(keyOf(request.capture));
      need(
        retained && !this.pending.has(request.operationId) && this.pending.size < 64,
        'Missing/reused capture or receipt budget',
      );
      need(
        (await contentHash(request.content)) === request.capture.contentHash,
        'Captured content hash',
      );
      const version: ArtifactVersion<C> = {
        artifactId: this.key,
        versionId: 'version:' + request.operationId,
        parentVersionId: retained.selectedVersionId,
        schemaVersion: 1,
        content: structuredClone(request.content),
        contentHash: request.capture.contentHash,
        createdAt: this.now(),
        createdBy: null,
        reason: 'Captured private journal save',
      };
      const project: Project<C, P> = {
        ...(retained.provenance ? { provenance: structuredClone(retained.provenance) } : {}),
        operationId: request.operationId,
        capture: structuredClone(request.capture),
        selectedVersionId: version.versionId,
        versions: [...retained.versions, version],
        plans: [...retained.plans].map(([sourceId, plan]) => ({ sourceId, plan })),
        originals: new Map([...retained.originals].map(([id, blob]) => [id, blobReader(blob)])),
      };
      const scan = createScanner(this.digest),
        { prepareProject } = createProfileProject(scan, this.profile),
        { writeZip, archiveSize } = createZip(scan);
      return await navigator.locks.request('video-scratch:' + this.scratchNamespace, async () => {
        let ledger: ScratchLedger | undefined,
          record: ScratchRecord | undefined,
          directory: FileSystemDirectoryHandle | undefined,
          stream: FileSystemWritableFileStream | undefined;
        let evidence: WriteEvidence = { state: 'unknown' };
        let admissionRefused = false;
        this.capacityRefusal = undefined;
        try {
          const opened = await this.scratch();
          ledger = opened.ledger;
          directory = opened.directory;
          for await (const _ of (directory as unknown as { keys(): AsyncIterable<string> }).keys())
            throw Error('Unresolved scratch files');
          record = await ledger.reserve(request.operationId, request.capture, retained.journalHead);
          await this.observed('scratch-intent', record);
          signal.throwIfAborted();
          const entries = await prepareProject(project, signal),
            size = archiveSize(entries);
          need(size <= BigInt(this.scratchBudget), 'Scratch byte budget');
          if (this.capacity) {
            let stage: 'journal' | 'total' = 'journal';
            try {
              await this.journal.preflight(Number(size), retained.journalHead);
              stage = 'total';
              await this.capacity.reserve(
                this.capacityId(request.operationId),
                this.scratchNamespace + '/' + record.file,
                Number(size),
              );
            } catch (error) {
              admissionRefused = true;
              this.capacityRefusal = {
                operationId: request.operationId,
                stage,
                archiveBytes: Number(size),
                additionalBytes: 2 * Number(size),
              };
              throw error;
            }
          }
          signal.throwIfAborted();
          const handle = await directory.getFileHandle(record.file, { create: true });
          stream = await handle.createWritable();
          await writeZip(
            entries,
            {
              write: async (b, abort) => {
                abort.throwIfAborted();
                await stream!.write(Uint8Array.from(b));
                await this.observed('scratch-chunk', record!);
              },
            },
            signal,
          );
          await stream.close();
          stream = undefined;
          await this.observed('scratch-closed', record);
          const file = await handle.getFile(),
            r = blobReader(file),
            hash = await scan(r, signal);
          const pin: Pin = {
            operationId: request.operationId,
            capture: structuredClone(request.capture),
            sha256: hash.sha256,
            bytes: file.size,
          };
          record = await ledger.update(request.operationId, (entry) => {
            entry.pin = pin;
            entry.phase = 'ready';
          });
          this.pending.set(request.operationId, { pin, project, retained });
          await this.observed('scratch-ready', record);
          const result = await this.journal.save(
            pin,
            retained.journalHead,
            chunksFromReader(
              { size: file.size, read: (at, n, s) => r.read(BigInt(at), n, s) },
              signal,
            ),
            signal,
            this.capacity
              ? (path) =>
                  this.capacity!.candidate(
                    this.capacityId(request.operationId),
                    this.scratchNamespace + '/' + record!.file,
                    path,
                  )
              : undefined,
          );
          evidence = writeEvidence(result, pin);
        } catch {
          /* Remain unknown until explicit, identity-correlated recovery/settlement. */
        } finally {
          try {
            if (stream) await stream.abort();
            if (ledger && record && directory) {
              const cleaned = await this.cleanupScratch(
                ledger,
                directory,
                record,
                new AbortController().signal,
                () => true,
                false,
              );
              if (cleaned.state === 'unknown') evidence = { state: 'unknown' };
              if (admissionRefused && cleaned.state === 'no-write') evidence = cleaned;
              if (evidence.state !== 'unknown')
                await this.capacity?.settle(
                  this.capacityId(request.operationId),
                  this.scratchNamespace + '/' + record.file,
                  evidence.state === 'committed' ? 'committed' : 'no-write',
                );
              // Do not promote a lost acknowledgement automatically just because cleanup verified it.
              await this.acceptEvidence(request.operationId, evidence);
            }
          } catch {
            evidence = { state: 'unknown' };
          } finally {
            ledger?.close();
          }
        }
        return evidence;
      });
    } catch {
      return { state: 'unknown' };
    }
  }
  private adopt(project: Project<C, P>, retained: History<C, P>) {
    this.history.journalHead = retained.journalHead + 1;
    if (project.provenance) this.history.provenance = structuredClone(project.provenance);
    else delete this.history.provenance;
    this.history.versions = structuredClone(project.versions);
    this.history.selectedVersionId = project.selectedVersionId;
    this.history.originals = new Map(retained.originals);
    this.history.plans = new Map(retained.plans);
  }
  async reconcile(operationId: string, signal: AbortSignal): Promise<WriteEvidence> {
    return navigator.locks.request('video-scratch:' + this.scratchNamespace, async () => {
      let ledger: ScratchLedger | undefined;
      try {
        const opened = await this.scratch();
        ledger = opened.ledger;
        const record = (await ledger.records()).find((r) => r.operationId === operationId);
        if (!record || record.phase !== 'done') return { state: 'unknown' };
        const evidence = await this.scratchEvidence(record, signal, false);
        if (evidence.state !== 'unknown')
          await this.capacity?.settle(
            this.capacityId(operationId),
            this.scratchNamespace + '/' + record.file,
            evidence.state === 'committed' ? 'committed' : 'no-write',
          );
        await this.acceptEvidence(operationId, evidence);
        return evidence;
      } catch {
        return { state: 'unknown' };
      } finally {
        ledger?.close();
      }
    });
  }
  /** New-process recovery reads a verified version; it never resurrects a dead coordinator job/grant. */
  async restore(operationId: string, signal: AbortSignal) {
    const lease = await this.journal.lease(operationId, signal);
    try {
      const file = lease.file(),
        r = blobReader(file),
        verifier = createProfileBrowserVerifier(this.digest, this.profile);
      const opened = await verifier.open(r, signal, lease.pin);
      const { readZip } = createZip(createScanner(this.digest)),
        entries = await readZip(r, signal);
      const originals = new Map<string, Blob>();
      for (const entry of entries)
        if (entry.name.startsWith('originals/'))
          originals.set(
            entry.name.slice(10, -4),
            lease.slice(Number(entry.dataOffset), Number(entry.size)),
          );
      const operation = (await this.journal.snapshot()).operations.find(
        (op) => op.pin.operationId === operationId,
      );
      need(operation?.phase === 'committed', 'Restored journal ownership');
      return {
        project: opened.project,
        file,
        history: {
          ...(opened.project.provenance
            ? { provenance: structuredClone(opened.project.provenance) }
            : {}),
          journalHead: operation.parent + 1,
          versions: structuredClone(opened.project.versions),
          selectedVersionId: opened.project.selectedVersionId,
          originals,
          plans: new Map(opened.project.plans.map((p) => [p.sourceId, p.plan])),
        } satisfies History<C, P>,
        release: () => lease.release(),
      };
    } catch (e) {
      lease.release();
      throw e;
    }
  }
}

/** Original v0 constructor/API retained, with the same default archive bytes. */
export class JournalVideoStorage extends ProfileJournalVideoStorage<VideoContent, ImportSet> {
  constructor(
    key: string,
    journal: BrowserJournal,
    digest: DigestFactory,
    scratchNamespace: string,
    scratchBudget: number,
    history: History,
    now: () => string,
    live: LiveCatalog,
    scratchHooks: ScratchHooks = {},
    capacity?: TotalCapacity,
  ) {
    super(
      key,
      journal,
      digest,
      scratchNamespace,
      scratchBudget,
      history,
      now,
      live,
      v0Profile,
      scratchHooks,
      capacity,
    );
  }
}
