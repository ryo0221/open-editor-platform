import {
  canonicalJson,
  clone,
  newId,
  commitVersion,
  deserializeArtifact,
  contentHash,
  serializeArtifact,
  updateDraft,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  command,
  EditorSession,
  previewProposedCommands,
  sameLocalRevision,
  transaction,
  type EditorCommand,
  type LocalDraftRevision,
  type ProposalPreview,
  type ProposedCommands,
  type Selection,
} from '@editor-platform/editor-core';
export * from './access';

export type HostErrorCode =
  | 'closed'
  | 'read-only'
  | 'invalid-content'
  | 'invalid-artifact'
  | 'unsupported'
  | 'save-busy'
  | 'save-failed'
  | 'unsaved'
  | 'input-pending'
  | 'version-missing'
  | 'proposal-missing'
  | 'proposal-stale'
  | 'proposal-invalid';
export class EditorHostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    readonly artifactId: string,
    message: string,
  ) {
    super(message);
    this.name = 'EditorHostError';
  }
}
export interface EditorHostCapabilities {
  undo: boolean;
  nativeJson: boolean;
  formats: readonly string[];
  preview: 'none' | 'host-isolated';
  shared: false;
  /** Host-submitted native command proposals with draft preview and review. Absent = false. */
  proposals?: boolean;
}
/** Plain text for external tools. Offsets index `text`; segments carry stable element IDs. */
export interface HostTextSegment {
  /** Stable ID of the text-bearing element (for a list item, its paragraph). */
  id: string;
  /** Top-level native element that contains it. */
  blockId: string;
  start: number;
  end: number;
}
export interface HostText {
  text: string;
  segments: HostTextSegment[];
}
export interface HostTextAccess<T> {
  read(content: T): HostText;
}
export interface EditorHostAdapter<T> {
  kind: string;
  validate(value: unknown): value is T;
  /** Optional async domain verification over draft and every retained immutable version. */
  preflight?(artifact: Artifact<T>): Promise<void>;
  capabilities: EditorHostCapabilities;
  export?(format: string, content: T, signal: AbortSignal): Promise<unknown>;
  /** Optional plain text read; Editors without it reject readText with `unsupported`. */
  text?: HostTextAccess<T>;
}
export interface HostSnapshot<T> {
  artifactId: string;
  kind: string;
  content: T;
  revision: LocalDraftRevision;
  savedRevision?: LocalDraftRevision;
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  selection: Selection;
}
export interface HostSaveResult<T> {
  artifactId: string;
  kind: string;
  revision: LocalDraftRevision;
  artifact: Artifact<T>;
  dirty: boolean;
}
/** Sent only after StorageAdapter.put succeeds; never for a requested or failed save. */
export interface HostSavedEvent {
  artifactId: string;
  kind: string;
  /** Version the persisted draft is based on; the new one when the save committed a version. */
  versionId: string | null;
  committed: boolean;
  /** Draft revision captured when the save started. */
  revision: LocalDraftRevision;
  /** Current Session revision and dirty state when the event is sent. */
  currentRevision: LocalDraftRevision;
  dirty: boolean;
}
export interface HostSavedContent<T> {
  artifactId: string;
  kind: string;
  /** The persisted draft's base version, or the requested immutable version. */
  versionId: string | null;
  source: 'saved-draft' | 'version';
  content: T;
  /** Present for an immutable version. */
  contentHash?: string;
}
export interface HostPendingProposal<T> {
  id: string;
  summary: string;
  source?: string;
  /** Session revision the preview was computed from. */
  baseRevision: LocalDraftRevision;
  preview: ProposalPreview<T>;
  /** True after any later draft change; accepting it is refused. */
  stale: boolean;
}
export interface HostProposalResult {
  artifactId: string;
  proposalId: string;
  outcome: 'accepted' | 'rejected' | 'stale' | 'withdrawn';
  revision: LocalDraftRevision;
  /** Accepted content is an unsaved draft change until the Host saves it. */
  dirty: boolean;
}
/** Envelope validation is separate from a domain's native validator. */
function checkArtifact<T>(
  artifact: Artifact<unknown>,
  adapter: EditorHostAdapter<T>,
): asserts artifact is Artifact<T> {
  const checked = deserializeArtifact(serializeArtifact(artifact));
  if (
    !checked.id ||
    checked.kind !== adapter.kind ||
    !adapter.validate(checked.draft.content) ||
    checked.versions.some((v) => !adapter.validate(v.content))
  )
    throw new EditorHostError(
      'invalid-artifact',
      checked.id,
      'Invalid artifact kind or native content',
    );
  const provenance = checked.provenance;
  const text = (value: unknown): value is string => typeof value === 'string';
  const optionalText = (value: unknown) => value === undefined || text(value);
  if (
    !text(checked.draft.updatedAt) ||
    !provenance ||
    typeof provenance !== 'object' ||
    !['created', 'imported'].includes(provenance.source) ||
    !optionalText(provenance.format) ||
    !optionalText(provenance.importedAt) ||
    (provenance.template !== undefined &&
      (!provenance.template ||
        typeof provenance.template !== 'object' ||
        !text(provenance.template.id) ||
        !Number.isInteger(provenance.template.version) ||
        !text(provenance.template.hash) ||
        !text(provenance.template.requestId) ||
        !text(provenance.template.fingerprint))) ||
    (provenance.officeImport !== undefined &&
      (!provenance.officeImport ||
        typeof provenance.officeImport !== 'object' ||
        !text(provenance.officeImport.requestId) ||
        !text(provenance.officeImport.sourceHash) ||
        !text(provenance.officeImport.fingerprint) ||
        !text(provenance.officeImport.adapterVersion))) ||
    checked.versions.some(
      (v) =>
        !text(v.createdAt) ||
        (v.createdBy !== null && !text(v.createdBy)) ||
        (v.reason !== null && !text(v.reason)),
    )
  )
    throw new EditorHostError('invalid-artifact', checked.id, 'Invalid artifact metadata');
  const ids = checked.versions.map((v) => v.versionId);
  const parents = new Map(checked.versions.map((v) => [v.versionId, v.parentVersionId]));
  if (
    ids.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(ids).size !== ids.length ||
    checked.versions.some(
      (v) =>
        v.parentVersionId !== null &&
        (typeof v.parentVersionId !== 'string' || !parents.has(v.parentVersionId)),
    )
  )
    throw new EditorHostError('invalid-artifact', checked.id, 'Invalid retained version identity');
  if (checked.draft.baseVersionId !== null && !ids.includes(checked.draft.baseVersionId))
    throw new EditorHostError('invalid-artifact', checked.id, 'Draft base version is missing');
  const complete = new Set<string>();
  for (const version of checked.versions) {
    const seen = new Set<string>();
    let current: string | null = version.versionId;
    while (current !== null && !complete.has(current)) {
      if (seen.has(current))
        throw new EditorHostError('invalid-artifact', checked.id, 'Retained version parent cycle');
      seen.add(current);
      current = parents.get(current)!;
    }
    for (const id of seen) complete.add(id);
  }
}
const MAX_NATIVE_BYTES = 16 * 1024 * 1024;
function assertNativeSize(json: string, artifactId: string) {
  if (new TextEncoder().encode(json).length > MAX_NATIVE_BYTES)
    throw new EditorHostError(
      'invalid-artifact',
      artifactId,
      'Native JSON exceeds the 16 MiB boundary',
    );
}
export function serializeHostNativeArtifact<T>(artifact: Artifact<T>) {
  const json = serializeArtifact(artifact);
  assertNativeSize(json, artifact.id);
  return json;
}
export async function loadHostArtifact<T>(
  json: string,
  adapter: EditorHostAdapter<T>,
): Promise<Artifact<T>> {
  assertNativeSize(json, '');
  const artifact = deserializeArtifact(json);
  checkArtifact(artifact, adapter);
  for (const version of artifact.versions)
    if (version.contentHash !== (await contentHash(version.content)))
      throw new EditorHostError('invalid-artifact', artifact.id, 'Retained version hash mismatch');
  await adapter.preflight?.(artifact);
  return clone(artifact);
}

/** Host-owned LOCAL lifecycle. Never feed remote edits into this snapshot Session. */
export class ArtifactEditor<T> {
  private session: EditorSession<T>;
  private persisted: Artifact<T>;
  private savedRevision?: LocalDraftRevision;
  private saving = false;
  private closed = false;
  private listeners = new Set<() => void>();
  private savedListeners = new Set<(event: HostSavedEvent) => void>();
  private proposalListeners = new Set<(result: HostProposalResult) => void>();
  private pending = new Map<
    string,
    {
      proposal: ProposedCommands<T>;
      revision: LocalDraftRevision;
      preview: ProposalPreview<T>;
      reviewed: string;
    }
  >();
  private buffers = new Set<() => void>();
  private selection: Selection = { addresses: [] };
  /** Private camera/panel/selection state; never part of Artifact content or Undo. */
  readonly viewState = new Map<string, unknown>();
  readonly capabilities: EditorHostCapabilities;
  constructor(
    artifact: Artifact<T>,
    private readonly adapter: EditorHostAdapter<T>,
    private readonly storage: Pick<StorageAdapter<Artifact<T>>, 'put'>,
    /** Current trusted Host permission, checked again at each mutation boundary. */
    private readonly mayEdit: () => boolean = () => true,
    private readonly onObserverError: (error: unknown) => void = () => {},
  ) {
    checkArtifact(artifact, adapter);
    this.persisted = clone(artifact);
    this.session = new EditorSession(artifact.draft.content);
    this.capabilities = clone(adapter.capabilities);
  }
  get id() {
    return this.persisted.id;
  }
  get artifact() {
    return clone(this.persisted);
  }
  /** Current draft content, revision and history without building a snapshot (hot paths). */
  get content(): T {
    return this.session.content;
  }
  get revision(): LocalDraftRevision {
    return this.session.revision;
  }
  get readOnly() {
    return !this.mayEdit();
  }
  get canUndo() {
    return this.capabilities.undo && this.session.canUndo;
  }
  get canRedo() {
    return this.capabilities.undo && this.session.canRedo;
  }
  get snapshot(): HostSnapshot<T> {
    const content = this.session.content;
    return {
      artifactId: this.id,
      kind: this.adapter.kind,
      content,
      revision: this.session.revision,
      savedRevision: this.savedRevision,
      dirty: canonicalJson(content) !== canonicalJson(this.persisted.draft.content),
      saving: this.saving,
      readOnly: this.readOnly,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      selection: clone(this.selection),
    };
  }
  private requireOpen() {
    if (this.closed) throw new EditorHostError('closed', this.id, 'This editing Session is closed');
  }
  private requireEdit() {
    this.requireOpen();
    if (!this.mayEdit())
      throw new EditorHostError('read-only', this.id, 'Host permission is read-only');
  }
  private notify() {
    this.emit(this.listeners, undefined);
  }
  private emit<E>(listeners: Set<(event: E) => void>, event: E) {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(clone(event));
      } catch (error) {
        try {
          this.onObserverError(error);
        } catch {
          /* Observer failures cannot corrupt an accepted edit/save. */
        }
      }
    }
  }
  /** Attach/detach releases Surface listeners without closing the retained Session. */
  attach(listener: () => void): () => void {
    this.requireOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Persisted-save notifications. The returned function releases this listener only. */
  onSaved(listener: (event: HostSavedEvent) => void): () => void {
    this.requireOpen();
    this.savedListeners.add(listener);
    return () => {
      this.savedListeners.delete(listener);
    };
  }
  /** Proposal review outcomes (accepted, rejected, stale, withdrawn on close). */
  onProposalResolved(listener: (result: HostProposalResult) => void): () => void {
    this.requireOpen();
    this.proposalListeners.add(listener);
    return () => {
      this.proposalListeners.delete(listener);
    };
  }
  /** Persisted content only: the saved draft, or an immutable retained version by ID. */
  readSaved(versionId?: string): HostSavedContent<T> {
    this.requireOpen();
    const base = { artifactId: this.id, kind: this.adapter.kind };
    if (versionId === undefined)
      return {
        ...base,
        versionId: this.persisted.draft.baseVersionId,
        source: 'saved-draft',
        content: clone(this.persisted.draft.content),
      };
    const version = this.persisted.versions.find((v) => v.versionId === versionId);
    if (!version)
      throw new EditorHostError('version-missing', this.id, 'Unknown saved version: ' + versionId);
    return {
      ...base,
      versionId,
      source: 'version',
      content: clone(version.content),
      contentHash: version.contentHash,
    };
  }
  /** Plain text of the current draft or of persisted content, from the Editor's own reader. */
  readText(from: 'draft' | 'saved' = 'saved', versionId?: string): HostText {
    this.requireOpen();
    if (!this.adapter.text)
      throw new EditorHostError('unsupported', this.id, 'Text access is unsupported');
    const content = from === 'draft' ? this.session.content : this.readSaved(versionId).content;
    return clone(this.adapter.text.read(content));
  }
  private requireProposals() {
    if (!this.capabilities.proposals)
      throw new EditorHostError('unsupported', this.id, 'Proposals are unsupported');
  }
  private review(id: string): HostPendingProposal<T> {
    const entry = this.pending.get(id)!;
    return {
      id,
      summary: entry.proposal.summary,
      source: entry.proposal.source,
      baseRevision: clone(entry.revision),
      // Commands are functions; the frozen owned proposal is shared, contents are copies.
      preview: {
        baseContent: clone(entry.preview.baseContent),
        content: clone(entry.preview.content),
        proposal: entry.proposal,
      },
      stale: !sameLocalRevision(entry.revision, this.session.revision),
    };
  }
  /** Register native commands and compute their preview on a copy of the current draft. */
  propose(proposal: ProposedCommands<T>): HostPendingProposal<T> {
    this.requireEdit();
    this.requireProposals();
    const revision = this.session.revision;
    if (!proposal.id || this.pending.has(proposal.id))
      throw new EditorHostError('proposal-invalid', this.id, 'Proposal ID is missing or in use');
    if (proposal.baseLocalRevision && !sameLocalRevision(proposal.baseLocalRevision, revision))
      throw new EditorHostError(
        'proposal-stale',
        this.id,
        'The draft changed after this proposal was prepared',
      );
    // Own the reviewed commands: later changes to the caller's object cannot reach accept.
    const owned: ProposedCommands<T> = Object.freeze({
      ...proposal,
      baseLocalRevision: proposal.baseLocalRevision && clone(proposal.baseLocalRevision),
      commands: Object.freeze(
        [...proposal.commands].map((c) =>
          Object.freeze({ ...c, context: c.context && Object.freeze({ ...c.context }) }),
        ),
      ) as EditorCommand<T>[],
    });
    let preview: ProposalPreview<T>;
    try {
      preview = previewProposedCommands(this.session.content, owned);
    } catch (error) {
      throw new EditorHostError(
        'proposal-invalid',
        this.id,
        error instanceof Error ? error.message : 'Proposal commands failed',
      );
    }
    if (!this.adapter.validate(preview.content))
      throw new EditorHostError(
        'proposal-invalid',
        this.id,
        'Proposal produced invalid native content',
      );
    this.pending.set(proposal.id, {
      proposal: owned,
      revision,
      preview,
      reviewed: canonicalJson(preview.content),
    });
    this.notify();
    return this.review(proposal.id);
  }
  get proposals(): HostPendingProposal<T>[] {
    return [...this.pending.keys()].map((id) => this.review(id));
  }
  private resolve(id: string, outcome: HostProposalResult['outcome']) {
    this.pending.delete(id);
    const result: HostProposalResult = {
      artifactId: this.id,
      proposalId: id,
      outcome,
      revision: this.session.revision,
      dirty: this.snapshot.dirty,
    };
    this.emit(this.proposalListeners, result);
    this.notify();
    return result;
  }
  private pendingProposal(id: string) {
    const entry = this.pending.get(id);
    if (!entry) throw new EditorHostError('proposal-missing', this.id, 'Unknown proposal: ' + id);
    return entry;
  }
  /** The single accept path for ordinary review UI and headless callers. */
  acceptProposal(id: string): HostProposalResult {
    this.requireEdit();
    const entry = this.pendingProposal(id);
    // Input must be confirmed first; a pending input keeps the proposal for later review.
    this.flushInputs();
    if (!sameLocalRevision(entry.revision, this.session.revision)) {
      this.resolve(id, 'stale');
      throw new EditorHostError(
        'proposal-stale',
        this.id,
        'The draft changed after the preview. Request a new proposal.',
      );
    }
    const applied = transaction(entry.proposal.summary, entry.proposal.commands, {
      origin: 'proposal',
      transactionId: newId('transaction'),
      proposalId: id,
    });
    this.execute({
      ...applied,
      // Commit only the content the person reviewed.
      apply: (content) => {
        const result = applied.apply(content);
        if (canonicalJson(result) !== entry.reviewed)
          throw new EditorHostError(
            'proposal-invalid',
            this.id,
            'The proposal no longer produces the reviewed preview',
          );
        return result;
      },
    });
    return this.resolve(id, 'accepted');
  }
  rejectProposal(id: string): HostProposalResult {
    this.requireOpen();
    this.pendingProposal(id);
    return this.resolve(id, 'rejected');
  }
  registerInputBoundary(flushOrThrow: () => void): () => void {
    this.requireOpen();
    this.buffers.add(flushOrThrow);
    return () => {
      this.buffers.delete(flushOrThrow);
    };
  }
  flushInputs() {
    this.requireOpen();
    for (const flush of this.buffers) flush();
    this.session.breakHistoryGroup();
  }
  /** Split typing history without flushing or blurring active input. */
  breakHistoryGroup() {
    this.requireOpen();
    this.session.breakHistoryGroup();
  }
  refreshPermission() {
    this.requireOpen();
    this.notify();
  }
  select(selection: Selection) {
    this.requireOpen();
    if (selection.addresses.some((a) => a.artifactId !== this.id))
      throw new EditorHostError(
        'invalid-content',
        this.id,
        'Selection belongs to another artifact',
      );
    this.selection = clone(selection);
    this.session.breakHistoryGroup();
    this.notify();
  }
  execute(cmd: EditorCommand<T>): T {
    this.requireEdit();
    const next = this.session.execute({
      ...cmd,
      // Preserve the existing command context but validate before Session commits.
      readonlyInput: undefined,
      apply: (content) => {
        const result = cmd.apply(content);
        if (!this.adapter.validate(result))
          throw new EditorHostError(
            'invalid-content',
            this.id,
            'Command produced invalid native content',
          );
        return result;
      },
    });
    this.notify();
    return next;
  }
  undo(): T {
    this.requireEdit();
    this.flushInputs();
    if (!this.capabilities.undo)
      throw new EditorHostError('unsupported', this.id, 'Undo is unsupported');
    const next = this.session.undo();
    this.notify();
    return next;
  }
  redo(): T {
    this.requireEdit();
    this.flushInputs();
    if (!this.capabilities.undo)
      throw new EditorHostError('unsupported', this.id, 'Redo is unsupported');
    const next = this.session.redo();
    this.notify();
    return next;
  }
  /** Native replacement is one undoable edit; retained versions remain immutable. */
  importContent(content: unknown) {
    this.requireEdit();
    this.flushInputs();
    if (!this.capabilities.nativeJson || !this.adapter.validate(content))
      throw new EditorHostError(
        'invalid-content',
        this.id,
        'Unsupported or invalid native content',
      );
    const imported = clone(content);
    return this.execute(command('host.import', 'Import native content', () => imported));
  }
  async save(
    options: { commitVersion?: boolean; author?: string } = {},
  ): Promise<HostSaveResult<T>> {
    this.requireEdit();
    this.flushInputs();
    if (this.saving) throw new EditorHostError('save-busy', this.id, 'A save is already pending');
    const { content, revision } = this.snapshot;
    let captured = updateDraft(this.persisted, content);
    this.saving = true;
    this.notify();
    try {
      if (options.commitVersion)
        captured = await commitVersion(captured, options.author ?? null, 'Host save');
      serializeHostNativeArtifact(captured);
      await this.adapter.preflight?.(captured);
      this.requireEdit();
      await this.storage.put(clone(captured));
      this.persisted = clone(captured);
      this.savedRevision = revision;
      this.emit(this.savedListeners, {
        artifactId: this.id,
        kind: this.adapter.kind,
        versionId: captured.draft.baseVersionId,
        committed: !!options.commitVersion,
        revision,
        currentRevision: this.session.revision,
        dirty: this.snapshot.dirty,
      });
      return {
        artifactId: this.id,
        kind: this.adapter.kind,
        revision,
        artifact: clone(captured),
        dirty: this.snapshot.dirty,
      };
    } catch (error) {
      if (error instanceof EditorHostError) throw error;
      throw new EditorHostError(
        'save-failed',
        this.id,
        error instanceof Error ? error.message : 'Host storage failed',
      );
    } finally {
      this.saving = false;
      this.notify();
    }
  }
  async export(format: string, signal: AbortSignal = new AbortController().signal) {
    this.requireOpen();
    this.flushInputs();
    if (format === 'native-json' && this.capabilities.nativeJson) {
      const captured = updateDraft(this.persisted, this.session.content);
      const revision = this.session.revision;
      await this.adapter.preflight?.(captured);
      this.requireOpen();
      this.flushInputs();
      if (!sameLocalRevision(revision, this.session.revision))
        throw new EditorHostError('input-pending', this.id, 'Content changed during export');
      return serializeHostNativeArtifact(captured);
    }
    if (!this.capabilities.formats.includes(format) || !this.adapter.export)
      throw new EditorHostError('unsupported', this.id, 'Unsupported export format: ' + format);
    return this.adapter.export(format, this.session.content, signal);
  }
  /** Return keeps history; close/delete/discard explicitly end this Session. */
  close(policy: 'require-saved' | 'discard' = 'require-saved') {
    this.requireOpen();
    this.flushInputs();
    if (this.saving)
      throw new EditorHostError('save-busy', this.id, 'Wait for the pending save before closing');
    if (policy === 'require-saved' && this.snapshot.dirty)
      throw new EditorHostError(
        'unsaved',
        this.id,
        'Save, retain, or explicitly discard the draft',
      );
    for (const id of [...this.pending.keys()]) this.resolve(id, 'withdrawn');
    this.closed = true;
    this.listeners.clear();
    this.savedListeners.clear();
    this.proposalListeners.clear();
    this.buffers.clear();
    this.viewState.clear();
    this.selection = { addresses: [] };
    this.session = new EditorSession(this.persisted.draft.content);
  }
}
export * from './proposal';
