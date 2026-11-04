/**
 * Story Timeline T2: the editing workbench of one Story. Each owner bound by the Story opens
 * as its own `ArtifactEditor` (its own content, Undo history and input registry), so every
 * confirmed edit is one Undo of one owner (t0-contract §2.7, §4.5). The workbench is the
 * Host's coordination over those editors, never another history.
 *
 * Undo and Redo reach only the active owner: its input registry first, then its native
 * history. The active owner changes only when a semantic edit succeeds or the author picks
 * another one; a refused or cancelled edit, a save or a change of view does not move it
 * (TL18b–f). An empty or read-only active owner is reported as such and never falls through
 * to another owner's history.
 */
import {
  canonicalJson,
  contentHash,
  type Artifact,
  type StorageAdapter,
} from '@editor-platform/artifact-core';
import {
  EditorInputs,
  sameLocalRevision,
  transactionCommands,
  type EditorCommand,
} from '@editor-platform/editor-core';
import { ArtifactEditor } from '@editor-platform/editor-host';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import type { CreativeWorkspaceLinksV2 } from '../workspace/model';
import { insertRows, retargetCitation, timelineOwnerAdapter } from './commands';
import type { TimelineRowInput } from './edit-error';
import { resolveTimelineProjection, type TimelineSource } from './projection';
import { verifyNewReferences, type VerifiedTimelineRows } from './refs';
import { TimelineForms } from './forms';
import { repinRows, repinCommand, type TimelineRepinManifest } from './repin';
import { assertStoryStructure, changedStoryRows } from './story-boundary';
import { assertLocalTimeBounds, effectiveClock } from './time';
import { readTimelineTable, type TimelineRole } from './table';

export interface TimelineWorkbenchOwner {
  id: string;
  role: TimelineRole;
  name: string;
  /** The ledger's world, for ledgers. */
  world?: string;
  editor: ArtifactEditor<StructuredData>;
  inputs: EditorInputs;
  forms: TimelineForms;
}
/** An owner of the Story that is not open for editing, and why (shown, never guessed). */
export interface TimelineClosedOwner {
  id: string;
  role: TimelineRole;
  reason: string;
}
export type TimelineEditResult = { ok: true } | { ok: false; message: string };
export interface TimelineUndoState {
  /** The owner Ctrl+Z and Redo act on; none until a semantic edit or an explicit choice. */
  owner?: { id: string; name: string };
  canUndo: boolean;
  canRedo: boolean;
  /** Set when the active owner cannot be changed now (read-only or unavailable). */
  blocked?: string;
}
export const UNDO_SCOPE_NOTE = 'この資料の履歴を順に戻します。全資料の操作時系列順ではありません。';

const message = (e: unknown) => String(e instanceof Error ? e.message : e);
const checkedCandidate = Symbol('checked timeline candidate');
type CheckedCandidateCommand = EditorCommand<StructuredData> & {
  [checkedCandidate]?: { ownerId: string; candidate: string; assert(): void };
};
const timeState = (d: StructuredData) =>
  canonicalJson(
    d.rows.flatMap((r) => {
      if (r.values['tl1.row'] === 'derive-time') return [{ id: r.id, values: r.values }];
      if (r.values['tl1.row'] !== 'event') return [];
      return [
        {
          id: r.id,
          values: Object.fromEntries(
            Object.entries(r.values).filter(
              ([k]) => k.startsWith('tl1.time.') || k === 'tl1.clock',
            ),
          ),
        },
      ];
    }),
  );
/** Only changed times and their internal dependents need a new calculation receipt. */
function changedTimeNeedsValidation(
  before: StructuredData,
  after: StructuredData,
  defaultClock?: string,
) {
  const signatures = (d: StructuredData) => {
    const parts = new Map<string, unknown[]>();
    for (const r of d.rows) {
      const v = r.values;
      const id =
        v['tl1.row'] === 'event'
          ? r.id
          : v['tl1.row'] === 'derive-time'
            ? String(v['tl1.subject'])
            : undefined;
      if (!id) continue;
      const values = parts.get(id) ?? [];
      values.push(
        v['tl1.row'] === 'event'
          ? Object.fromEntries(
              Object.entries(v).filter(([k]) => k.startsWith('tl1.time.') || k === 'tl1.clock'),
            )
          : r,
      );
      parts.set(id, values);
    }
    return new Map([...parts].map(([id, values]) => [id, canonicalJson(values)]));
  };
  const previous = signatures(before),
    next = signatures(after);
  const affected = new Set(
    [...new Set([...previous.keys(), ...next.keys()])].filter(
      (id) => previous.get(id) !== next.get(id),
    ),
  );
  const relations = new Map(
    after.rows
      .filter((r) => r.values['tl1.row'] === 'derive-time')
      .map((r) => [String(r.values['tl1.subject']), r.values]),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, v] of relations)
      if (!v['tl1.ref.artifact'] && affected.has(String(v['tl1.ref.item'])) && !affected.has(id)) {
        affected.add(id);
        grew = true;
      }
  }
  const clocks = new Map(
    after.rows
      .filter((r) => r.values['tl1.row'] === 'event')
      .map((r) => [
        r.id,
        effectiveClock(
          typeof r.values['tl1.clock'] === 'string' ? r.values['tl1.clock'] : undefined,
          defaultClock,
        ),
      ]),
  );
  const external = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false; // Native table validation rejects internal cycles first.
    seen.add(id);
    const r = relations.get(id);
    if (!r) return false;
    if (r['tl1.ref.artifact']) return true;
    const base = String(r['tl1.ref.item']);
    return clocks.get(id) !== clocks.get(base) || external(base, seen);
  };
  return [...affected].some((id) => external(id));
}

const candidateReceipts = (
  cmd: CheckedCandidateCommand,
): NonNullable<CheckedCandidateCommand[typeof checkedCandidate]>[] => {
  const own = cmd[checkedCandidate];
  return own ? [own] : (transactionCommands(cmd) ?? []).flatMap(candidateReceipts);
};

export class TimelineWorkbench {
  private readonly owners = new Map<string, TimelineWorkbenchOwner>();
  private activeId?: string;
  private readonly listeners = new Set<() => void>();
  private revisionCount = 0;
  private readonly closedOwners: TimelineClosedOwner[] = [];
  private readonly usedIds = new Map<string, Set<string>>();
  private readonly allocated = new Map<string, number>();
  private readonly relationIds = new Map<string, Set<string>>();
  private referenceEpoch = 0;
  private readonly allInputs = new EditorInputs();
  private readonly pending = new Map<string, { invalidate(): void; check(): void }>();
  get closed() {
    return this.closedOwners.filter((o) => this.mayRead(o.id));
  }
  readable(id: string) {
    return this.mayRead(id);
  }
  /** Discard asynchronous UI results after access/source invalidation, including revoke/grant ABA. */
  captureAccess(ownerId: string) {
    const epoch = this.referenceEpoch;
    return () => epoch === this.referenceEpoch && this.mayRead(ownerId);
  }
  /** A notification epoch is supplied by the Host on permission/source invalidation. */
  invalidate() {
    this.referenceEpoch++;
    for (const pending of this.pending.values()) pending.invalidate();
    this.changed();
  }
  nextId(ownerId: string, prefix: string) {
    const o = this.owner(ownerId);
    if (!o) throw Error('この資料を読めません。');
    const ids = this.usedIds.get(ownerId)!;
    const key = ownerId + '#' + prefix;
    const highest = Math.max(
      this.allocated.get(key) ?? 0,
      ...[...ids].map((id) => Number(id.match(new RegExp('^' + prefix + '-(\\d+)$'))?.[1] ?? 0)),
    );
    this.allocated.set(key, highest + 1);
    return `${prefix}-${String(highest + 1).padStart(3, '0')}`;
  }
  /** Relation IDs retain their existing form, including deleted/saved/session-issued IDs. */
  nextRelationId(ownerId: string, base: string) {
    const o = this.owner(ownerId);
    if (!o) throw Error('この資料を読めません。');
    const used = this.relationIds.get(ownerId) ?? new Set<string>();
    for (const id of this.usedIds.get(ownerId)!) used.add(id);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    this.relationIds.set(ownerId, used);
    return id;
  }
  /** One pending request per target; dependency changes stay invalid even after Undo (ABA). */
  watch(ownerId: string, key: string, read: () => unknown) {
    const o = this.owner(ownerId);
    if (!o) throw Error('この資料を読めません。');
    const address = ownerId + '#' + key;
    this.pending.get(address)?.invalidate();
    const expected = canonicalJson(read());
    let valid = true;
    const ticket = {
      check: () => {},
      invalidate: () => {
        valid = false;
      },
    };
    const check = () => {
      try {
        if (!this.mayRead(ownerId) || !this.mayEdit(ownerId) || canonicalJson(read()) !== expected)
          valid = false;
      } catch {
        valid = false;
      }
    };
    ticket.check = check;
    this.pending.set(address, ticket);
    return {
      assert: () => {
        check();
        if (!valid) throw Error('準備した対象が変わりました。再確認してください。');
      },
      cancel: () => {
        valid = false;

        if (this.pending.get(address) === ticket) this.pending.delete(address);
      },
    };
  }

  private constructor(
    private readonly storage: Pick<StorageAdapter<Artifact<unknown>>, 'get' | 'put'>,
    readonly links: CreativeWorkspaceLinksV2,
    private readonly mayRead: (artifactId: string) => boolean,
    private readonly mayEdit: (artifactId: string) => boolean,
  ) {}

  /**
   * Opens every owner of the Story that can be read and whose table reads as valid. An owner
   * that cannot be read, is missing or does not read is listed in `closed` with its reason and
   * offers no edit at all (TL20). Permission is checked before and after the read (§6.4).
   */
  static async open(
    storage: Pick<StorageAdapter<Artifact<unknown>>, 'get' | 'put'>,
    links: CreativeWorkspaceLinksV2,
    permission: { mayRead(id: string): boolean; mayEdit(id: string): boolean },
  ): Promise<TimelineWorkbench> {
    const w = new TimelineWorkbench(storage, links, permission.mayRead, permission.mayEdit);
    const story = links.story;
    const bound: [string, TimelineRole, string?][] = [
      ...story.ledgers.map(
        (l) => [l.artifactId, 'ledger', l.world] as [string, TimelineRole, string],
      ),
      ...story.sceneCards.map((id) => [id, 'scene-cards'] as [string, TimelineRole]),
      [story.composition, 'composition'],
      [story.worldSettings, 'world'],
    ];
    for (const [id, role, world] of bound) {
      if (w.owners.has(id)) continue;
      const closed = (reason: string) => w.closedOwners.push({ id, role, reason });
      if (!permission.mayRead(id)) {
        closed('読めない資料です。');
        continue;
      }
      const a = await storage.get(id);
      if (!permission.mayRead(id)) {
        closed('読めない資料です。');
        continue;
      }
      if (!a || a.id !== id) {
        closed('資料がありません。');
        continue;
      }
      const content = a.draft.content;
      if (!isStructuredData(content) || readTimelineTable(role, content).state === 'invalid') {
        closed('表の形式が契約と合わないため編集できません。');
        continue;
      }
      let editor: ArtifactEditor<StructuredData>;
      try {
        editor = new ArtifactEditor(
          a as Artifact<StructuredData>,
          timelineOwnerAdapter(role),
          storage as Pick<StorageAdapter<Artifact<StructuredData>>, 'put'>,
          () => permission.mayRead(id) && permission.mayEdit(id),
        );
      } catch (e) {
        closed(message(e));
        continue;
      }
      const inputs = new EditorInputs();
      const forms = new TimelineForms(
        () => editor.content,
        () => permission.mayRead(id) && !editor.readOnly,
        (cmd) => {
          const r = w.run(id, () => cmd);
          if (!r.ok) throw Error(r.message);
        },
        () => inputs.changed(),
        (candidate, command) =>
          w.validateCandidate({ id, role, world }, editor.content, candidate, command),
      );
      inputs.register(forms.boundary);
      w.allInputs.register(forms.boundary);
      editor.registerInputBoundary(() => inputs.flush());
      const owner: TimelineWorkbenchOwner = {
        id,
        role,
        name: a.name,
        ...(world ? { world } : {}),
        editor,
        inputs,
        forms,
      };
      const used = new Set([
        ...editor.content.rows.map((r) => r.id),
        ...editor.artifact.versions.flatMap((v) => v.content.rows.map((r) => r.id)),
      ]);
      w.usedIds.set(id, used);
      // Install before UI listeners: invalidate tickets before any listener can reenter/Undo.
      editor.attach(() => {
        for (const row of editor.content.rows) used.add(row.id);
        for (const ticket of w.pending.values()) ticket.check();
      });
      editor.attach(() => w.changed());
      owner.inputs.subscribe(() => w.changed());
      w.owners.set(id, owner);
    }
    return w;
  }

  private changed() {
    this.revisionCount++;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* Observer failure cannot turn a native success into a retry. */
      }
    }
  }
  /** Bumped on every change of an owner's draft, history, inputs or the active owner. */
  get revision() {
    return this.revisionCount;
  }
  /** Opaque Host access generation for read-only diagnostic snapshots. */
  get accessEpoch() {
    return this.referenceEpoch;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  owner(id: string): TimelineWorkbenchOwner | undefined {
    return this.mayRead(id) ? this.owners.get(id) : undefined;
  }
  ownersOf(role: TimelineRole): TimelineWorkbenchOwner[] {
    return [...this.owners.values()].filter((o) => o.role === role && this.mayRead(o.id));
  }
  /** True when the owner is open and may be changed now. */
  editable(id: string) {
    const o = this.owners.get(id);
    return !!o && !o.editor.readOnly;
  }

  /**
   * What the reading sees: the owners' current drafts, as edited here, with their saved
   * versions. Other artifacts (characters, manuscripts) are read from storage as they are.
   */
  readonly source: TimelineSource = {
    get: async (id) => {
      if (!this.mayRead(id)) return undefined;
      const o = this.owner(id);
      if (!o) {
        const a = await this.storage.get(id);
        return this.mayRead(id) ? a : undefined;
      }
      // A successful put can lose its response: native retry retains its own captured save,
      // while exact readers must already see the durable version. Do not replace the
      // editor's draft, adoption base or history to repair that read source.
      const access = this.captureAccess(id);
      const durable = await this.storage.get(id);
      if (!access()) return undefined;
      if (durable && durable.id !== id) throw Error('保存先のArtifact IDが一致しません。');
      const a = o.editor.artifact as Artifact<unknown>;
      const versions = new Map(a.versions.map((v) => [v.versionId, v]));
      for (const v of durable?.versions ?? []) {
        const known = versions.get(v.versionId);
        if (known && canonicalJson(known) !== canonicalJson(v))
          throw Error('保存版のIDが異なる内容で再利用されています。');
        if (!known) {
          if ((await contentHash(v.content)) !== v.contentHash)
            throw Error('保持された保存版のhashが一致しません。');
          versions.set(v.versionId, v);
        }
      }
      if (!access()) return undefined;
      return {
        ...a,
        versions: [...versions.values()],
        draft: { ...a.draft, content: o.editor.content },
      };
    },
  };

  /** Rows of an open owner's current draft (for the edit forms). */
  rows(id: string) {
    return this.owner(id)?.editor.content.rows ?? [];
  }

  private defaultClock(owner: Pick<TimelineWorkbenchOwner, 'world'>) {
    const value = this.rows(this.links.story.worldSettings).find(
      (r) => r.id === owner.world && r.values['tl1.row'] === 'worldline',
    )?.values['tl1.clock'];
    return typeof value === 'string' ? value : undefined;
  }

  /** Shared by pure form preflight and commit-time validation. */
  private validateTimeBounds(
    owner: Pick<TimelineWorkbenchOwner, 'role' | 'world'>,
    candidate: StructuredData,
  ) {
    if (owner.role !== 'ledger') return;
    // Resolve the Host-owned default now, never from a captured form value.
    // rows() rechecks read permission; unreadable settings supply no clock identity.
    const defaultClock = this.defaultClock(owner);
    const table = readTimelineTable('ledger', candidate);
    if (table.state === 'valid')
      assertLocalTimeBounds(
        table.rows,
        typeof defaultClock === 'string' ? defaultClock : undefined,
      );
  }

  /** World IDs are also used by composition experience rows, outside this owner's history. */
  private validateWorldRemoval(ownerId: string, before: StructuredData, candidate: StructuredData) {
    if (ownerId !== this.links.story.worldSettings) return;
    const worlds = new Set(
      candidate.rows.filter((r) => r.values['tl1.row'] === 'worldline').map((r) => r.id),
    );
    const removed = new Set(
      before.rows
        .filter((r) => r.values['tl1.row'] === 'worldline' && !worlds.has(r.id))
        .map((r) => r.id),
    );
    if (!removed.size) return;
    const composition = this.owner(this.links.story.composition);
    // No cached owner/name/count may be exposed when the dependent owner is unavailable.
    if (!composition) throw Error('関連資料を確認できないため、世界線を除去できません。');
    if (
      composition.editor.content.rows.some(
        (r) =>
          r.values['tl1.row'] === 'experience' && removed.has(String(r.values['tl1.ind.origin'])),
      )
    )
      throw Error(
        'この世界線を出身世界にした経験順があります。構成側で明示的に解除してから操作してください。',
      );
  }

  private validateCandidate(
    owner: Pick<TimelineWorkbenchOwner, 'id' | 'role' | 'world'>,
    content: StructuredData,
    candidate: StructuredData,
    native: EditorCommand<StructuredData>,
  ) {
    this.validateTimeBounds(owner, candidate);
    this.validateWorldRemoval(owner.id, content, candidate);
    const time =
      owner.role === 'ledger' &&
      changedTimeNeedsValidation(content, candidate, this.defaultClock(owner));
    const story =
      (owner.role === 'world' || owner.role === 'composition') &&
      changedStoryRows(content, candidate).changed;
    if (!time && !story) return;
    if (story)
      assertStoryStructure(
        owner.id,
        owner.role,
        candidate,
        this.links.story,
        this.owner(this.links.story.worldSettings)?.editor.content,
      );
    const receipt = candidateReceipts(native).find(
      (r) => r.ownerId === owner.id && r.candidate === canonicalJson(candidate),
    );
    if (!receipt) throw Error('この編集は参照・時計の確認が必要です。確定前に検証してください。');
    receipt.assert();
  }

  /**
   * Runs one command on one owner. Success makes that owner the active one; a refusal leaves
   * the content, the history and the active owner as they were (TL18a, TL18f).
   */
  run(ownerId: string, cmd: () => EditorCommand<StructuredData>): TimelineEditResult {
    const o = this.owner(ownerId);
    if (!o) return { ok: false, message: 'この資料は編集用に開いていません。' };
    if (o.editor.readOnly) return { ok: false, message: `${o.name} は編集できません。` };
    try {
      const native = cmd();
      o.editor.execute({
        ...native,
        apply: (content) => {
          const candidate = native.apply(content);
          this.validateCandidate(o, content, candidate, native);
          const current = new Set(content.rows.map((r) => r.id));
          if (
            candidate.rows.some((r) => !current.has(r.id) && this.usedIds.get(ownerId)!.has(r.id))
          )
            throw Error('使用済みの項目IDは再利用できません。新しいIDで作成してください。');
          return candidate;
        },
      });
    } catch (e) {
      return { ok: false, message: message(e) };
    }
    this.activeId = ownerId;
    this.changed();
    return { ok: true };
  }

  /** The author's explicit choice of the owner Ctrl+Z acts on. */
  activate(ownerId: string): TimelineEditResult {
    if (!this.owner(ownerId)) return { ok: false, message: 'この資料は編集用に開いていません。' };
    this.activeId = ownerId;
    this.changed();
    return { ok: true };
  }

  get undoState(): TimelineUndoState {
    const o = this.activeId ? this.owner(this.activeId) : undefined;
    if (!o) return { canUndo: false, canRedo: false };
    const owner = { id: o.id, name: o.name };
    if (o.editor.readOnly)
      return { owner, canUndo: false, canRedo: false, blocked: `${o.name} は編集できません。` };
    const inputs = o.inputs.getSnapshot();
    return {
      owner,
      canUndo:
        inputs.canUndo ||
        (!(inputs.dirty || inputs.composing || inputs.settling) && o.editor.canUndo),
      canRedo:
        inputs.canRedo ||
        (!(inputs.dirty || inputs.composing || inputs.settling) && o.editor.canRedo),
      ...(inputs.dirty || inputs.composing || inputs.settling
        ? { blocked: '未確定の入力を確定または取消してください。' }
        : {}),
    };
  }

  /**
   * Undo or Redo of the active owner only: its private inputs first, then its native history.
   * Nothing to undo there, or an owner that cannot be changed, is refused and reported; it is
   * never passed to another owner (TL18c–e).
   */
  history(direction: 'undo' | 'redo'): TimelineEditResult {
    const o = this.activeId ? this.owner(this.activeId) : undefined;
    const what = direction === 'undo' ? '元に戻す' : 'やり直す';
    if (!o) return { ok: false, message: `${what}対象の資料がありません。` };
    if (o.editor.readOnly)
      return { ok: false, message: `${o.name} は編集できないため${what}ことはできません。` };
    try {
      if (o.inputs.history(direction)) return { ok: true };
      // Input buffers may change before their UI notification/effect is delivered.
      o.inputs.changed();
      const input = o.inputs.getSnapshot();
      if (input.dirty || input.composing || input.settling)
        throw Error('未確定の入力を確定または取消してから履歴を操作してください。');
    } catch (e) {
      return { ok: false, message: message(e) };
    }
    if (!(direction === 'undo' ? o.editor.canUndo : o.editor.canRedo))
      return { ok: false, message: `${o.name} には${what}操作がありません。` };
    const valid = (candidate: StructuredData) => {
      if (readTimelineTable(o.role, candidate).state === 'invalid')
        throw Error('戻した先の表が契約の形と合いません。');
      this.validateWorldRemoval(o.id, o.editor.content, candidate);
      if (
        (o.role === 'world' || o.role === 'composition') &&
        changedStoryRows(o.editor.content, candidate).changed
      )
        assertStoryStructure(
          o.id,
          o.role,
          candidate,
          this.links.story,
          this.owner(this.links.story.worldSettings)?.editor.content,
        );
    };
    try {
      if (direction === 'undo') o.editor.undo(valid);
      else o.editor.redo(valid);
    } catch (e) {
      return { ok: false, message: message(e) };
    }
    return { ok: true };
  }

  /** Owners whose draft differs from what is saved. */
  get unsaved(): TimelineWorkbenchOwner[] {
    return [...this.owners.values()].filter((o) => this.mayRead(o.id) && o.editor.snapshot.dirty);
  }

  /**
   * Saves one owner as a new saved version (so other owners can cite it exactly). Saving does
   * not change the active owner or any history.
   */
  async save(ownerId: string): Promise<TimelineEditResult & { versionId?: string }> {
    const o = this.owner(ownerId);
    if (!o) return { ok: false, message: 'この資料は編集用に開いていません。' };
    const current = this.captureAccess(ownerId);
    const invalidated = () => ({
      ok: false as const,
      message: '保存結果の表示は無効になりました。',
    });
    try {
      o.inputs.flush();
      const r = await o.editor.save({ commitVersion: true });
      this.changed();
      if (!current()) return invalidated();
      return { ok: true, versionId: r.artifact.draft.baseVersionId ?? undefined };
    } catch (e) {
      if (!current()) return invalidated();
      return { ok: false, message: `${o.name} を保存できませんでした（${message(e)}）。` };
    }
  }

  /**
   * Commits every owner's pending inputs before the author leaves the screen (a trip to the
   * source or the manuscript). A commit enters that owner's own history; an input that cannot
   * be committed keeps the author here (TL17).
   */
  flushInputs(): TimelineEditResult {
    try {
      this.allInputs.flush();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: message(e) };
    }
  }

  /**
   * The exact reference to an item of an open owner: its newest saved version, which must hold
   * the item. An item only in the draft has no saved version to cite yet.
   */
  savedRef(ownerId: string, itemId: string) {
    const o = this.owner(ownerId);
    if (!o) return undefined;
    const a = o.editor.artifact;
    const v = a.versions.find((x) => x.versionId === a.draft.baseVersionId);
    if (!v || !v.content.rows.some((r) => r.id === itemId)) return undefined;
    return {
      'tl1.ref.artifact': a.id,
      'tl1.ref.version': v.versionId,
      'tl1.ref.hash': v.contentHash,
      'tl1.ref.item': itemId,
    };
  }

  /** Citation validation is owner input: save/navigation/history must see it while awaiting. */
  private pendingReference(ownerId: string, signal?: AbortSignal) {
    const owner = this.owner(ownerId);
    if (!owner || signal?.aborted) throw Error('参照の確認を開始できません。');
    let pending = true;
    const unregister = owner.forms.register({
      dirty: () => pending,
      focus() {},
      consume() {},
      finalize() {},
      prepare: () => {
        throw Error('参照先を確認しています。完了または取消後に操作してください。');
      },
    });
    const remove = () => {
      if (!pending) return;
      pending = false;
      signal?.removeEventListener('abort', remove);
      unregister();
    };
    signal?.addEventListener('abort', remove, { once: true });
    return remove;
  }
  async addCitation(
    ownerId: string,
    scene: string,
    prepare: () => Promise<VerifiedTimelineRows>,
    signal?: AbortSignal,
  ): Promise<TimelineEditResult> {
    let remove: (() => void) | undefined;
    let ticket: ReturnType<TimelineWorkbench['watch']> | undefined;
    try {
      remove = this.pendingReference(ownerId, signal);
      ticket = this.watch(ownerId, 'add-citation:' + scene, () =>
        this.rows(ownerId).find((r) => r.id === scene),
      );
      const verified = await prepare();
      if (signal?.aborted) throw Error('入力を取り消しました。');
      ticket.assert();
      return this.run(ownerId, () => insertRows('scene-cards', verified, '引用を追加'));
    } catch (e) {
      return { ok: false, message: message(e) };
    } finally {
      ticket?.cancel();
      remove?.();
    }
  }

  async retarget(
    ownerId: string,
    citeId: string,
    prepare: () => Promise<VerifiedTimelineRows>,
    signal?: AbortSignal,
  ): Promise<TimelineEditResult> {
    const read = () => this.rows(ownerId).find((r) => r.id === citeId);
    const expected = structuredClone(read()?.values);
    let ticket: ReturnType<TimelineWorkbench['watch']> | undefined;
    let remove: (() => void) | undefined;
    try {
      remove = this.pendingReference(ownerId, signal);
      ticket = this.watch(ownerId, citeId, read);
      const verified = await prepare();
      if (signal?.aborted) throw Error('入力を取り消しました。');
      ticket.assert();
      const cmd = retargetCitation(verified, expected);
      const guard = ticket;
      return this.run(ownerId, () => ({
        ...cmd,
        apply: (content) => {
          guard.assert();
          return cmd.apply(content);
        },
      }));
    } catch (e) {
      return { ok: false, message: message(e) };
    } finally {
      ticket?.cancel();
      remove?.();
    }
  }

  /** Choose the form's validation path without changing content. Invalid native input is
   * reported by the ordinary form preflight, not as an error during React rendering. */
  needsTimeValidation(ownerId: string, build: () => EditorCommand<StructuredData>) {
    const o = this.owner(ownerId);
    if (!o) return false;
    try {
      const content = o.editor.content;
      return changedTimeNeedsValidation(content, build().apply(content), this.defaultClock(o));
    } catch {
      return false;
    }
  }

  /**
   * Resolve a time-edit candidate without writing it. The existing projection supplies the
   * exact/draft and clock rules; commit stays synchronous in the owner's native history.
   * The caller aborts the lifetime on cancel/consumption. Later preparations for this event
   * supersede earlier ones, and revisions reject change-and-Undo (ABA) during validation.
   */
  async prepareTimeEdit(
    ownerId: string,
    eventId: string,
    build: () => EditorCommand<StructuredData> | Promise<EditorCommand<StructuredData>>,
    signal: AbortSignal,
  ): Promise<EditorCommand<StructuredData>> {
    return this.prepareTimeEdits(ownerId, [eventId], build, signal);
  }

  /** A manifest can repin several derivations in one owner-local native transaction. */
  private async prepareTimeEdits(
    ownerId: string,
    eventIds: readonly string[],
    build: () => EditorCommand<StructuredData> | Promise<EditorCommand<StructuredData>>,
    signal: AbortSignal,
  ): Promise<EditorCommand<StructuredData>> {
    const o = this.owner(ownerId);
    if (!o || o.role !== 'ledger' || o.editor.readOnly) throw Error('時点を編集できません。');
    const remove = this.pendingReference(ownerId, signal);
    const ticket = this.watch(ownerId, 'time:' + JSON.stringify([...eventIds].sort()), () => [
      o.editor.revision,
      this.owner(this.links.story.worldSettings)?.editor.revision ?? null,
    ]);
    const cancel = () => ticket.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const access = new Map<string, () => boolean>();
    const assert = () => {
      if (signal.aborted) throw Error('入力を取り消しました。');
      ticket.assert();
      if ([...access.values()].some((readable) => !readable()))
        throw Error('参照先を読めなくなりました。再確認してください。');
    };
    try {
      const initial = canonicalJson(o.editor.content);
      const cmd = await build();
      assert();
      const candidate = cmd.apply(o.editor.content);
      const otherTimes = (d: StructuredData) =>
        timeState({
          ...d,
          rows: d.rows.filter(
            (r) =>
              !eventIds.includes(r.id) &&
              !(
                r.values['tl1.row'] === 'derive-time' &&
                eventIds.includes(String(r.values['tl1.subject']))
              ),
          ),
        });
      if (otherTimes(candidate) !== otherTimes(o.editor.content))
        throw Error('指定された出来事以外の時点は変更できません。');
      const source: TimelineSource = {
        get: async (id) => {
          if (!access.has(id)) access.set(id, this.captureAccess(id));
          const a = await this.source.get(id);
          return a && id === ownerId ? { ...a, draft: { ...a.draft, content: candidate } } : a;
        },
      };
      const projection = await resolveTimelineProjection(source, this.links, {}, this.mayRead);
      assert();
      const affected = new Set(eventIds);
      for (let grew = true; grew; ) {
        grew = false;
        for (const r of candidate.rows) {
          const v = r.values;
          const subject = String(v['tl1.subject']);
          if (
            v['tl1.row'] === 'derive-time' &&
            !v['tl1.ref.artifact'] &&
            affected.has(String(v['tl1.ref.item'])) &&
            !affected.has(subject)
          ) {
            affected.add(subject);
            grew = true;
          }
        }
      }
      const targets = eventIds.map((id) =>
        projection.events.find((e) => e.owner === ownerId && e.id === id),
      );
      if (targets.some((e) => !e)) throw Error('対象の時点を確認できません。');
      for (const event of projection.events.filter(
        (e) => e.owner === ownerId && affected.has(e.id),
      )) {
        const result = event.calculated;
        if (event.time.kind !== 'derived' || result?.state === 'resolved') continue;
        if (
          targets.length === 1 &&
          targets[0]?.time.kind === 'unset' &&
          result?.state === 'unavailable' &&
          result.reason === 'unset'
        )
          continue;
        throw Error(
          '導出を計算できません。保存版・参照権限・時計換算・日数の範囲を確認してください。',
        );
      }
      const checked: CheckedCandidateCommand = {
        ...cmd,
        [checkedCandidate]: { ownerId, candidate: canonicalJson(candidate), assert },
        apply: (content) => {
          assert();
          if (canonicalJson(content) !== initial)
            throw Error('検証した台帳が変わりました。再確認してください。');
          return cmd.apply(content);
        },
      };
      return checked;
    } catch (e) {
      ticket.cancel();
      signal.removeEventListener('abort', cancel);
      throw e;
    } finally {
      remove();
    }
  }

  /** Prepare one Story-owned structure edit against the binding captured at its start. */
  async prepareStoryEdit(
    ownerId: string,
    key: string,
    build: () => EditorCommand<StructuredData> | Promise<EditorCommand<StructuredData>>,
    signal: AbortSignal,
  ): Promise<EditorCommand<StructuredData>> {
    const story = structuredClone(this.links.story);
    const o = this.owner(ownerId);
    if (!o || o.editor.readOnly || ![story.worldSettings, story.composition].includes(ownerId))
      throw Error('このStoryの保存先を編集できません。');
    const remove = this.pendingReference(ownerId, signal);
    const ticket = this.watch(ownerId, 'story:' + key, () => [
      o.editor.revision,
      this.owner(story.worldSettings)?.editor.revision ?? null,
      this.links.story,
    ]);
    const cancel = () => ticket.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const initial = canonicalJson(o.editor.content);
      const cmd = await build();
      ticket.assert();
      if (signal.aborted) throw Error('入力を取り消しました。');
      const candidate = cmd.apply(o.editor.content);
      assertStoryStructure(
        ownerId,
        o.role,
        candidate,
        story,
        this.owner(story.worldSettings)?.editor.content,
      );
      const changed = changedStoryRows(o.editor.content, candidate);
      const verified = await this.verify(changed.rows);
      const assert = () => {
        if (signal.aborted) throw Error('入力を取り消しました。');
        ticket.assert();
        if (verified.targets.some((id) => !verified.mayRead(id)))
          throw Error('端点を読めなくなりました。');
      };
      assert();
      const checked: CheckedCandidateCommand = {
        ...cmd,
        [checkedCandidate]: { ownerId, candidate: canonicalJson(candidate), assert },
        apply: (content) => {
          assert();
          if (canonicalJson(content) !== initial)
            throw Error('検証した資料が変わりました。再確認してください。');
          return cmd.apply(content);
        },
      };
      return checked;
    } catch (e) {
      ticket.cancel();
      signal.removeEventListener('abort', cancel);
      throw e;
    } finally {
      remove();
    }
  }

  /** Explicit old/new saved references, never automatic adoption of a latest draft/version. */
  async prepareRepin(
    manifest: TimelineRepinManifest,
    signal: AbortSignal,
  ): Promise<EditorCommand<StructuredData>> {
    const captured = structuredClone(manifest);
    const o = this.owner(captured.owner);
    if (!o || o.editor.readOnly) throw Error('この資料を編集できません。');
    const ticket = this.watch(o.id, 'repin', () => [
      o.editor.revision,
      o.editor.artifact.draft.baseVersionId,
      this.links.story,
    ]);
    const assert = () => {
      if (signal.aborted) throw Error('入力を取り消しました。');
      ticket.assert();
      if (
        !sameLocalRevision(captured.baseLocalRevision, o.editor.revision) ||
        captured.baseVersion !== o.editor.artifact.draft.baseVersionId
      )
        throw Error('資料が変わりました。選択を取り消し、再読込して準備してください。');
    };
    const cancel = () => ticket.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const remove = this.pendingReference(o.id, signal);
    try {
      assert();
      const rows = repinRows(o.editor.content, captured);
      const build = async () => {
        const verified = await this.verify(rows);
        assert();
        return repinCommand(o.role, captured, verified);
      };
      let command: EditorCommand<StructuredData>;
      if (o.role === 'ledger') {
        const events = rows
          .filter((r) => r.values['tl1.row'] === 'derive-time')
          .map((r) => String(r.values['tl1.subject']));
        command = await this.prepareTimeEdits(o.id, [...new Set(events)], build, signal);
      } else if (o.role === 'world' || o.role === 'composition') {
        command = await this.prepareStoryEdit(o.id, 'repin', build, signal);
      } else {
        command = await build();
      }
      assert();
      return {
        ...command,
        apply: (content) => {
          assert();
          return command.apply(content);
        },
      };
    } catch (e) {
      ticket.cancel();
      signal.removeEventListener('abort', cancel);
      throw e;
    } finally {
      remove();
    }
  }

  /** Confirms the exact references of new rows against what this workbench reads. */
  verify(rows: TimelineRowInput[]): Promise<VerifiedTimelineRows> {
    const epoch = this.referenceEpoch;
    return verifyNewReferences(
      this.source,
      rows,
      (id) => epoch === this.referenceEpoch && this.mayRead(id),
    );
  }
}
