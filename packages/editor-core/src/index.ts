import { clone, deepFreeze, newId, type ArtifactVersionRef } from '@editor-platform/artifact-core';
export * from './text';
export * from './validation';
export * from './describe';
export * from './visual-patch';
export * from './arrange';
export * from './inputs';
export type Region =
  | { type: 'text'; start: number; end: number; sourceText?: string }
  | { type: 'cell'; columnId: string; endRowId?: string; endColumnId?: string }
  | { type: 'lines'; start: number; end: number; side?: 'old' | 'new'; revisionId?: string }
  | { type: 'page'; page: number; bounds?: import('./geometry').Bounds; units?: 'pdf-points' }
  | { type: 'canvas'; x: number; y: number; width: number; height: number; units?: 'image-pixels' };
export interface ElementAddress {
  artifactId: string;
  elementId: string;
  /** Scope for element IDs that are unique only within a native page. */
  pageId?: string;
  region?: Region;
}
export interface Selection {
  addresses: ElementAddress[];
}
export interface Comment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}
export interface Annotation {
  id: string;
  anchor: Selection;
  comments: Comment[];
  resolved: boolean;
  createdAt: string;
  /** Optional display color fixed when the annotation is created. */
  color?: string;
}
export function addAnnotation(anchor: Selection, body: string, author: string): Annotation {
  if (!anchor.addresses.length || !body.trim())
    throw new Error('Select an element and enter a comment');
  const createdAt = new Date().toISOString();
  return {
    id: newId('thread'),
    anchor: clone(anchor),
    resolved: false,
    createdAt,
    comments: [{ id: newId('comment'), body: body.trim(), author, createdAt }],
  };
}
export interface EditorCommand<T> {
  type: string;
  label: string;
  /** Local execution metadata, not an authenticated operation envelope. */
  context?: LocalCommandContext;
  /** Stable domain IDs read by a computed command. content ['*'] reads the complete native source. */
  reads?: { geometry?: readonly string[]; content?: readonly string[] };
  /** Opt-in: apply only reads its input and permits freezing its returned tree. */
  readonlyInput?: true;
  apply(content: T): T;
}
export function withCommandReads<T>(
  value: EditorCommand<T>,
  reads: NonNullable<EditorCommand<T>['reads']>,
): EditorCommand<T> {
  return { ...value, reads };
}
export interface LocalDraftRevision {
  kind: 'local-draft';
  sessionId: string;
  sequence: number;
}
export interface LocalCommandContext {
  origin: 'local' | 'proposal' | 'restore';
  transactionId: string;
  /** Consecutive typing only. A selection move or non-typing command ends the group. */
  mergeKey?: string;
  proposalId?: string;
}
export function sameLocalRevision(a: LocalDraftRevision, b: LocalDraftRevision): boolean {
  return a.sessionId === b.sessionId && a.sequence === b.sequence;
}
export function command<T>(
  type: string,
  label: string,
  apply: (content: T) => T,
  context: LocalCommandContext = { origin: 'local', transactionId: newId('transaction') },
): EditorCommand<T> {
  return { type, label, apply, context };
}
/** For pure native commands. Legacy/mutating commands still receive a private copy. */
export function immutableCommand<T>(...args: Parameters<typeof command<T>>): EditorCommand<T> {
  return { ...command(...args), readonlyInput: true };
}
export function transaction<T>(
  label: string,
  commands: EditorCommand<T>[],
  context?: LocalCommandContext,
): EditorCommand<T> {
  return withCommandReads(
    command(
      'transaction',
      label,
      (content) => commands.reduce((next, c) => c.apply(clone(next)), clone(content)),
      context,
    ),
    {
      geometry: commands.flatMap((c) => c.reads?.geometry ?? []),
      content: commands.flatMap((c) => c.reads?.content ?? []),
    },
  );
}
/** Local-only snapshot history. Never ingest remote edits through this session. */
export class EditorSession<T> {
  private past: T[] = [];
  private future: T[] = [];
  private readonly sessionId = newId('session');
  private sequence = 0;
  private mergeKey: string | undefined;
  private validatingHistory = false;
  private value: T;
  constructor(content: T) {
    this.value = clone(content);
  }
  /** Caller-owned snapshot; mutating it never changes this session or its history. */
  get content(): T {
    return clone(this.value);
  }
  get revision(): LocalDraftRevision {
    return { kind: 'local-draft', sessionId: this.sessionId, sequence: this.sequence };
  }
  private assertMutationAvailable() {
    if (this.validatingHistory) throw new Error('HistoryValidationReentrancy');
  }
  /** Validation is synchronous, receives a private copy, and must return undefined.
   * Neither the copy nor a returned value becomes canonical history. */
  private validateHistory(candidate: T, validateCandidate?: (candidate: T) => void) {
    if (!validateCandidate) return;
    this.validatingHistory = true;
    try {
      const result: unknown = validateCandidate(clone(candidate));
      if (result !== undefined) throw new Error('HistoryValidationMustBeSynchronous');
    } finally {
      this.validatingHistory = false;
    }
  }
  breakHistoryGroup() {
    this.assertMutationAvailable();
    this.mergeKey = undefined;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  execute(cmd: EditorCommand<T>) {
    this.assertMutationAvailable();
    return clone(this.executeView(cmd));
  }
  /** Immutable result for rendering; content/execute/undo/redo remain caller-owned copies. */
  executeView(cmd: EditorCommand<T>) {
    this.assertMutationAvailable();
    if (cmd.context && !['local', 'proposal', 'restore'].includes(cmd.context.origin))
      throw new Error(
        'EditorSession only supports local edits; remote edits require a collaboration adapter',
      );
    const next = cmd.apply(cmd.readonlyInput ? deepFreeze(this.value) : clone(this.value));
    // Freeze before updating history, so a failed command cannot partially commit.
    const value = deepFreeze(cmd.readonlyInput ? next : clone(next));
    if (!cmd.context?.mergeKey || cmd.context.mergeKey !== this.mergeKey)
      this.past.push(this.value);
    this.mergeKey = cmd.context?.mergeKey;
    if (this.past.length > 100) this.past.shift();
    this.value = value;
    this.future = [];
    this.sequence++;
    return this.value;
  }
  /** Optional synchronous pre-commit validation; throws leave all history state untouched. */
  undo(validateCandidate?: (candidate: T) => void) {
    this.assertMutationAvailable();
    if (this.canUndo) this.validateHistory(this.past[this.past.length - 1], validateCandidate);
    this.breakHistoryGroup();
    if (this.canUndo) {
      this.future.push(this.value);
      this.value = this.past.pop()!;
      this.sequence++;
    }
    return clone(this.value);
  }
  /** Same validation semantics as undo; omitted callback preserves existing behavior. */
  redo(validateCandidate?: (candidate: T) => void) {
    this.assertMutationAvailable();
    if (this.canRedo) this.validateHistory(this.future[this.future.length - 1], validateCandidate);
    this.breakHistoryGroup();
    if (this.canRedo) {
      this.past.push(this.value);
      this.value = this.future.pop()!;
      this.sequence++;
    }
    return clone(this.value);
  }
}
export interface EditorEvents {
  selection: Selection;
  artifact: { artifactId: string };
  version: ArtifactVersionRef;
  command: { artifactId: string; type: string; label: string };
  annotation: Annotation;
}
export class EditorEventBus {
  private handlers = new Map<keyof EditorEvents, Set<(value: unknown) => void>>();
  on<K extends keyof EditorEvents>(type: K, handler: (value: EditorEvents[K]) => void): () => void {
    const set = this.handlers.get(type) ?? new Set<(value: unknown) => void>();
    this.handlers.set(type, set);
    const wrapped = (value: unknown) => handler(value as EditorEvents[K]);
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }
  emit<K extends keyof EditorEvents>(type: K, payload: EditorEvents[K]) {
    this.handlers.get(type)?.forEach((fn) => fn(payload));
  }
}
export interface ExtensionAction {
  id: string;
  label: string;
  run(selection: Selection): void;
}
export interface EditorExtensions {
  toolbar?: ExtensionAction[];
  contextMenu?: ExtensionAction[];
  externalReference?: (address: ElementAddress) => unknown;
}
export interface ExternalOperationRequest {
  artifact: ArtifactVersionRef;
  liveRevision?: LocalDraftRevision;
  selection?: Selection;
  operation: string;
  input: unknown;
}
export interface ProposedCommands<T> {
  id: string;
  summary: string;
  source?: string;
  baseLocalRevision?: LocalDraftRevision;
  commands: EditorCommand<T>[];
}
export interface EmbeddedPreview {
  type: 'html' | 'trusted-react';
  source: string;
}
export interface PreviewAdapter<T> {
  id: string;
  render(input: EmbeddedPreview): T;
}
export interface ProposalPreview<T> {
  baseContent: T;
  content: T;
  proposal: ProposedCommands<T>;
}
export function previewProposedCommands<T>(
  content: T,
  proposal: ProposedCommands<T>,
): ProposalPreview<T> {
  if (!proposal.commands.length) throw new Error('A proposal must contain commands');
  return {
    baseContent: clone(content),
    content: transaction(proposal.summary, proposal.commands).apply(clone(content)),
    proposal,
  };
}
export function isAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false;
  const a = value as Annotation;
  return (
    typeof a.id === 'string' &&
    typeof a.resolved === 'boolean' &&
    typeof a.createdAt === 'string' &&
    (a.color === undefined ||
      (typeof a.color === 'string' && /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(a.color))) &&
    !!a.anchor &&
    Array.isArray(a.anchor.addresses) &&
    a.anchor.addresses.length > 0 &&
    a.anchor.addresses.every(
      (address) =>
        address && typeof address.artifactId === 'string' && typeof address.elementId === 'string',
    ) &&
    Array.isArray(a.comments) &&
    a.comments.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.body === 'string' &&
        typeof c.author === 'string' &&
        typeof c.createdAt === 'string',
    )
  );
}
export * from './geometry';
export * from './drawing';
