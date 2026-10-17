import {
  canonicalJson,
  clone,
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
  type EditorCommand,
  type LocalDraftRevision,
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
  | 'input-pending';
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
}
export interface EditorHostAdapter<T> {
  kind: string;
  validate(value: unknown): value is T;
  capabilities: EditorHostCapabilities;
  export?(format: string, content: T, signal: AbortSignal): Promise<unknown>;
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
function boundedNativeJson<T>(artifact: Artifact<T>) {
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
      readOnly: !this.mayEdit(),
      canUndo: this.capabilities.undo && this.session.canUndo,
      canRedo: this.capabilities.undo && this.session.canRedo,
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
    for (const listener of [...this.listeners]) {
      try {
        listener();
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
      boundedNativeJson(captured);
      this.requireEdit();
      await this.storage.put(clone(captured));
      this.persisted = clone(captured);
      this.savedRevision = revision;
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
    if (format === 'native-json' && this.capabilities.nativeJson)
      return boundedNativeJson(updateDraft(this.persisted, this.session.content));
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
    this.closed = true;
    this.listeners.clear();
    this.buffers.clear();
    this.viewState.clear();
    this.selection = { addresses: [] };
    this.session = new EditorSession(this.persisted.draft.content);
  }
}
