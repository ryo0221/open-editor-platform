/** Reference Host coordination over existing owner-local editors, not another history. */
import {
  canonicalJson,
  contentHash,
  newId,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  command,
  EditorInputs,
  sameLocalRevision,
  type EditorCommand,
  type LocalDraftRevision,
} from '@editor-platform/editor-core';
import { ArtifactEditor, type EditorHostAdapter } from '@editor-platform/editor-host';
import {
  isWhiteboard,
  makeWhiteboardNode,
  type WhiteboardContent,
} from '@editor-platform/whiteboard/model';
import type { StructuredData } from '@editor-platform/structured-data/model';
import type { CreativeWorkspaceLinksV2 } from '../workspace/model';
import { TimelineWorkbench } from '../timeline/workbench';
import { openStoryBoard } from './open';
import { readStoryBoard, type BoardReading } from './reading';
import {
  boardItemKey,
  BOARD_LIMITS,
  changeBoardSettings,
  readBoardSettings,
  validateBoardFilter,
  validateBoardSettings,
  type BoardFilter,
  type BoardItem,
  type BoardSettings,
} from './settings';

export interface StoryBoardAccess {
  namespace: string;
  mayRead(id: string): boolean;
  mayEdit(id: string): boolean;
}
type Plan =
  | { kind: 'board' }
  | { kind: 'settings' }
  | { kind: 'preset'; name: string; filter: BoardFilter }
  | { kind: 'card'; event: BoardItem };
type Operation = {
  plan: Plan;
  status: 'running' | 'failed' | 'cancelled';
  phase: 'checking' | 'board' | 'settings';
  abort: AbortController;
  sourceEpoch: number;
  boardRevision: LocalDraftRevision;
  settingsRevision: LocalDraftRevision;
  reading?: BoardReading;
  next?: BoardSettings;
  boardApplied: boolean;
  boardSaved: boolean;
  settingsApplied: boolean;
  writing: boolean;
  settled: boolean;
};
const failure = () =>
  Error(
    '資料・権限・入力または保存状態を確認してください。変更を重複適用せず、再試行か取消を選んでください。',
  );
const capabilities = {
  undo: true,
  nativeJson: true,
  formats: [],
  preview: 'none',
  shared: false,
} as const;

export class StoryBoardController {
  readonly inputs = new EditorInputs();
  private readonly board: ArtifactEditor<WhiteboardContent>;
  private readonly settings: ArtifactEditor<StructuredData>;
  private readonly sourceEditors: readonly ArtifactEditor<StructuredData>[];
  private generation = 0;
  private sourceEpoch = 0;
  private permissionRevision = 0;
  private revision = 0;
  private operation?: Operation;
  private ownBoardSave = false;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly releases: (() => void)[] = [];
  private readonly usedNodes = new Set<string>();
  private readonly stopPending: () => void;
  readonly viewKey: string;
  private constructor(
    readonly storage: StorageAdapter<Artifact<unknown>>,
    readonly settingsId: string,
    readonly access: StoryBoardAccess,
    readonly workbench: TimelineWorkbench,
    opened: Awaited<ReturnType<typeof openStoryBoard>>,
  ) {
    this.viewKey = opened.viewKey;
    this.sourceEditors = (['ledger', 'scene-cards', 'composition', 'world'] as const).flatMap(
      (role) => workbench.ownersOf(role).map((owner) => owner.editor),
    );
    const permitted = (id: string) =>
      !this.closed &&
      access.mayRead(id) &&
      access.mayEdit(id) &&
      (!this.operation || this.valid(this.operation));
    const boardAdapter: EditorHostAdapter<WhiteboardContent> = {
      kind: 'whiteboard',
      validate: isWhiteboard,
      capabilities,
      preflight: async () => {
        if (this.operation) await this.verify(this.operation);
      },
    };
    const settingsAdapter: EditorHostAdapter<StructuredData> = {
      kind: 'data',
      capabilities,
      validate: (value): value is StructuredData => {
        try {
          readBoardSettings(value);
          return true;
        } catch {
          return false;
        }
      },
      preflight: async () => {
        if (this.operation) await this.verify(this.operation);
      },
    };
    this.board = new ArtifactEditor<WhiteboardContent>(
      opened.boardArtifact,
      boardAdapter,
      storage,
      () => permitted(opened.boardArtifact.id),
    );
    this.settings = new ArtifactEditor<StructuredData>(
      opened.settingsArtifact,
      settingsAdapter,
      storage,
      () => permitted(settingsId),
    );
    for (const content of [
      this.board.content,
      ...this.board.artifact.versions.map((v) => v.content),
    ])
      for (const node of content.nodes) this.usedNodes.add(node.id);
    this.releases.push(
      this.board.registerInputBoundary(() => {
        if (!this.ownBoardSave) this.inputs.flush();
      }),
    );
    for (const editor of [this.board, this.settings]) {
      let prior = canonicalJson([editor.revision, editor.artifact.draft.baseVersionId]);
      this.releases.push(
        editor.attach(() => {
          const next = canonicalJson([editor.revision, editor.artifact.draft.baseVersionId]);
          if (next !== prior) {
            prior = next;
            this.generation++;
          }
          this.changed();
        }),
      );
    }
    this.releases.push(
      workbench.subscribe(() => {
        this.sourceEpoch++;
        this.generation++;
        this.changed();
      }),
    );
    this.releases.push(this.inputs.subscribe(() => this.changed()));
    this.stopPending = this.inputs.register({
      label: 'ボードの保存',
      read: () => ({
        dirty: !!this.operation && (!this.operation.settled || this.operation.status === 'failed'),
      }),
      prepare: () => {
        throw failure();
      },
      focus() {},
    });
  }
  static async open(
    storage: StorageAdapter<Artifact<unknown>>,
    settingsId: string,
    links: CreativeWorkspaceLinksV2,
    access: StoryBoardAccess,
  ) {
    const opened = await openStoryBoard(storage, settingsId, { ...access, generation: () => 0 });
    const lifecycle: { controller?: StoryBoardController } = {};
    const workbench = await TimelineWorkbench.open(storage, links, {
      mayRead: access.mayRead,
      mayEdit: (id) =>
        access.mayEdit(id) && !lifecycle.controller?.busy && !lifecycle.controller?.closed,
    });
    if (!opened.current()) throw failure();
    const controller = new StoryBoardController(storage, settingsId, access, workbench, opened);
    lifecycle.controller = controller;
    return controller;
  }
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.revision;
  get epoch() {
    return this.generation;
  }
  get permissionEpoch() {
    return this.permissionRevision;
  }
  get busy() {
    return !!this.operation;
  }
  get operationState() {
    return this.operation
      ? {
          status: this.operation.status,
          kind: this.operation.plan.kind,
          phase: this.operation.phase,
          settled: this.operation.settled,
        }
      : undefined;
  }
  get boardSnapshot() {
    if (!this.access.mayRead(this.board.id)) throw failure();
    return this.board.snapshot;
  }
  get settingsSnapshot() {
    if (!this.access.mayRead(this.settingsId)) throw failure();
    return this.settings.snapshot;
  }
  get boardArtifactId() {
    return this.board.id;
  }
  readonly source = {
    get: async (id: string) => {
      if (this.closed || !this.access.mayRead(id)) return undefined;
      if (id === this.board.id)
        return {
          ...this.board.artifact,
          draft: { ...this.board.artifact.draft, content: this.board.content },
        };
      if (id === this.settingsId) return this.settings.artifact;
      return this.workbench.source.get(id);
    },
  };
  async read() {
    if (this.operation?.status === 'cancelled')
      return { state: 'partial' as const, current: () => false };
    return this.load();
  }
  private async load() {
    const reading = await readStoryBoard(this.source, this.settingsId, this.workbench.links, {
      ...this.access,
      generation: () => this.generation,
    });
    if (reading.state === 'ready')
      for (const ref of reading.adopted) {
        if (!reading.current()) throw failure();
        let stored: Artifact<unknown> | undefined;
        try {
          stored = await this.storage.get(ref.artifactId);
        } catch {
          throw failure();
        }
        const versions = stored?.versions.filter((v) => v.versionId === ref.versionId);
        if (!reading.current()) throw failure();
        if (
          stored?.id !== ref.artifactId ||
          stored.draft.baseVersionId !== ref.versionId ||
          versions?.length !== 1 ||
          versions[0].contentHash !== ref.contentHash ||
          (await contentHash(versions[0].content)) !== ref.contentHash
        )
          return { state: 'partial' as const, current: () => false };
      }
    if (!reading.current()) throw failure();
    return reading;
  }
  invalidate() {
    this.permissionRevision++;
    this.sourceEpoch++;
    this.generation++;
    this.workbench.invalidate();
    this.board.refreshPermission();
    this.settings.refreshPermission();
    this.changed();
  }
  /** Used before mode/source/board changes. Preparation stays synchronous and side-effect free. */
  guard() {
    if (this.closed || this.operation) throw failure();
    this.flushLocalInputs();
  }
  private flushLocalInputs() {
    this.inputs.flush();
    const source = this.workbench.flushInputs();
    if (!source.ok) throw failure();
    for (const role of ['ledger', 'scene-cards', 'composition', 'world'] as const)
      if (this.workbench.ownersOf(role).some((o) => o.editor.snapshot.saving)) throw failure();
  }
  executeBoard(value: EditorCommand<WhiteboardContent>) {
    if (this.operation || this.closed) throw failure();
    const previous = new Set(this.board.content.nodes.map((n) => n.id));
    this.board.execute({
      ...value,
      apply: (content) => {
        const next = value.apply(content);
        if (next.nodes.some((n) => !previous.has(n.id) && this.usedNodes.has(n.id)))
          throw failure();
        return next;
      },
    });
    for (const node of this.board.content.nodes) this.usedNodes.add(node.id);
    return true;
  }
  history(owner: 'board' | 'settings', direction: 'undo' | 'redo') {
    this.guard();
    const editor = owner === 'board' ? this.board : this.settings;
    if (direction === 'undo') editor.undo();
    else editor.redo();
  }
  async saveBoard() {
    return this.start({ kind: 'board' });
  }
  async saveSettings() {
    return this.start({ kind: 'settings' });
  }
  async savePreset(name: string, filter: BoardFilter) {
    if (!name.trim() || name.length > 512) throw failure();
    return this.start({ kind: 'preset', name: name.trim(), filter: validateBoardFilter(filter) });
  }
  async addCard(event: BoardItem) {
    return this.start({ kind: 'card', event: structuredClone(event) });
  }
  private valid(op: Operation) {
    const ids = [
      this.board.id,
      this.settingsId,
      ...(op.reading?.adopted.map((r) => r.artifactId) ?? []),
      ...(op.reading ? [op.reading.opened.settings.map.artifactId] : []),
    ];
    const writes =
      op.plan.kind === 'board'
        ? [this.board.id]
        : op.plan.kind === 'card'
          ? [this.board.id, this.settingsId]
          : [this.settingsId];
    return (
      !this.closed &&
      !op.abort.signal.aborted &&
      op.sourceEpoch === this.sourceEpoch &&
      sameLocalRevision(op.boardRevision, this.board.revision) &&
      sameLocalRevision(op.settingsRevision, this.settings.revision) &&
      ids.every((id) => this.access.mayRead(id)) &&
      writes.every((id) => this.access.mayEdit(id))
    );
  }
  private async verify(op: Operation) {
    if (!this.valid(op)) throw failure();
    const reading = await this.read();
    if (!this.valid(op) || reading.state !== 'ready' || !reading.current()) throw failure();
    const manifest = (value: BoardReading) =>
      canonicalJson([...value.adopted].sort((a, b) => a.artifactId.localeCompare(b.artifactId)));
    if (
      op.reading &&
      (manifest(reading) !== manifest(op.reading) ||
        canonicalJson(reading.opened.settings.map) !==
          canonicalJson(op.reading.opened.settings.map))
    )
      throw failure();
    if (!this.valid(op)) throw failure();
    op.reading ??= reading;
  }
  private async start(plan: Plan) {
    this.guard();
    const op: Operation = {
      plan,
      status: 'running',
      phase: 'checking',
      abort: new AbortController(),
      sourceEpoch: this.sourceEpoch,
      boardRevision: this.board.revision,
      settingsRevision: this.settings.revision,
      boardApplied: false,
      boardSaved: false,
      settingsApplied: false,
      writing: false,
      settled: false,
    };
    this.operation = op;
    this.inputs.changed();
    this.changed();
    return this.run(op);
  }
  private async run(op: Operation): Promise<boolean> {
    try {
      await this.verify(op);
      const reading = op.reading!;
      if (op.plan.kind === 'settings' && !op.next) {
        op.next = readBoardSettings(this.settings.content);
        if (
          op.next.boardArtifactId !== reading.opened.settings.boardArtifactId ||
          op.next.storyId !== reading.opened.settings.storyId ||
          canonicalJson(op.next.map) !== canonicalJson(reading.opened.settings.map)
        )
          throw failure();
        op.settingsApplied = true;
      }
      if ((op.plan.kind === 'preset' || op.plan.kind === 'card') && !op.next) {
        if (
          canonicalJson(readBoardSettings(this.settings.content)) !==
          canonicalJson(reading.opened.settings)
        )
          throw failure();
        const next = structuredClone(reading.opened.settings);
        let frame: ReturnType<typeof makeWhiteboardNode> | undefined;
        if (op.plan.kind === 'preset') {
          if (next.presets.length >= BOARD_LIMITS.presets) throw failure();
          next.presets.push({ id: newId('preset'), name: op.plan.name, filter: op.plan.filter });
        } else {
          if (next.panels.length >= BOARD_LIMITS.panels) throw failure();
          const event = op.plan.event;
          if (!reading.events.some((e) => e.key === boardItemKey(event))) throw failure();
          frame = {
            ...makeWhiteboardNode('shape'),
            shape: 'rectangle' as const,
            text: '連動表示は物語ボードで開いてください',
            bounds: {
              x: 24 + this.board.content.nodes.length * 25,
              y: 750,
              width: 270,
              height: 240,
            },
            color: '#fffdf7',
          };
          next.panels.push({ nodeId: frame.id, kind: 'event-card', event });
        }
        const prepared = validateBoardSettings(next);
        if (frame) {
          const node = frame;
          if (this.usedNodes.has(node.id)) throw failure();
          this.board.execute(
            command('story-board.card-frame', '出来事カードの枠を追加', (content) => ({
              ...content,
              nodes: [...content.nodes, node],
            })),
          );
          this.usedNodes.add(node.id);
          op.boardRevision = this.board.revision;
          op.boardApplied = true;
        }
        op.next = prepared;
      }
      if ((op.plan.kind === 'board' || op.plan.kind === 'card') && !op.boardSaved) {
        op.phase = 'board';
        this.changed();
        if (!this.valid(op)) throw failure();
        op.writing = true;
        this.ownBoardSave = true;
        let pending;
        try {
          pending = this.board.save({ commitVersion: true });
        } finally {
          this.ownBoardSave = false;
        }
        await pending;
        op.boardSaved = true;
      }
      if (op.plan.kind !== 'board') {
        await this.verify(op);
        op.phase = 'settings';
        this.changed();
        if (!op.settingsApplied) {
          this.settings.execute(
            changeBoardSettings(op.next!, readBoardSettings(this.settings.content)),
          );
          op.settingsRevision = this.settings.revision;
          op.settingsApplied = true;
        }
        if (!this.valid(op)) throw failure();
        op.writing = true;
        await this.settings.save({ commitVersion: true });
      }
      if (!this.valid(op)) throw failure();
      this.operation = undefined;
      this.generation++;
      this.inputs.changed();
      this.changed();
      return true;
    } catch {
      op.status = op.abort.signal.aborted ? 'cancelled' : 'failed';
      this.changed();
      return false;
    } finally {
      op.settled = true;
      this.inputs.changed();
      this.changed();
    }
  }
  async retry() {
    const op = this.operation;
    if (!op || op.status !== 'failed' || !op.settled || !this.valid(op)) throw failure();
    op.status = 'running';
    op.settled = false;
    this.inputs.changed();
    this.changed();
    return this.run(op);
  }
  cancel() {
    if (!this.operation) return;
    this.operation.abort.abort();
    this.operation.status = 'cancelled';
    this.generation++;
    this.inputs.changed();
    this.changed();
  }
  /** Explicit post-cancel recheck; late I/O completion alone never activates a binding. */
  async resumeAfterCancel() {
    const op = this.operation;
    if (!op || op.status !== 'cancelled' || !op.settled) throw failure();
    const reading = await this.load();
    if (reading.state !== 'ready' || !reading.current() || this.operation !== op) throw failure();
    this.operation = undefined;
    this.inputs.changed();
    this.changed();
  }
  close() {
    if (!this.closed && this.operation?.status === 'cancelled' && this.operation.settled)
      this.flushLocalInputs();
    else this.guard();
    if (
      this.board.snapshot.dirty ||
      this.settings.snapshot.dirty ||
      this.sourceEditors.some((editor) => editor.snapshot.dirty)
    )
      throw failure();
    this.operation = undefined;
    this.closed = true;
    this.generation++;
    this.stopPending();
    for (const release of this.releases) release();
    this.listeners.clear();
  }
}
