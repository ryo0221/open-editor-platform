/**
 * Business item references (docs/analysis-references-design.md U4). A Graph node attribute or a
 * Data reference field holds business IDs of items in other artifacts. The Host lists candidates,
 * reports each ID's state, opens the target and records which saved version a person saw when
 * choosing it. The Editor stores only IDs; per-citation bases and acceptance stay in the Host.
 */

/** Citing side: which artifact, which element (node or row) and which reference field. */
export interface ItemRefSource {
  artifactId: string;
  /** Native element ID: a Graph node ID or a Data row ID. */
  elementId: string;
  /** The declaration's refs entry: a node attribute name, a Data column ID or `refs.<field>`. */
  field: string;
}
export interface ItemCandidate {
  id: string;
  title: string;
  artifactTitle: string;
  /** Host remarks such as an excluded cause candidate. The Editor shows them and does not judge. */
  note?: string;
}
/**
 * State of one cited ID from this citing element. `ok`: the target matches the basis; `kept`: it
 * differs but was kept on purpose (reason only for readers of the target); `stale`: it differs
 * and nobody decided yet. The status names extend `ReferenceError.status`.
 */
export type ItemRefState =
  | { status: 'ok'; title: string }
  | {
      status:
        | 'missing-source'
        | 'missing-target'
        | 'forbidden'
        | 'offline'
        | 'unresolved'
        | 'duplicate'
        | 'stale';
      reason: string;
    }
  | { status: 'kept'; title: string; reason?: string };
export type ItemRefStatus = ItemRefState['status'];
export type ItemSelectionResult =
  | {
      accepted: true;
      /** Assigned by the Host; not guessable. */
      selectionId: string;
      target: { artifactId: string; versionId: string; revision: number; contentHash: string };
      /** The state when chosen (shown only; the basis is the Host's). */
      state: ItemRefState;
    }
  | { accepted: false; state: ItemRefState };
/** Sent beside a save to the Host's save port. Never written to native JSON or exports. */
export interface ItemSelectionEvidence {
  selectionId: string;
  from: ItemRefSource;
  id: string;
}
export interface ItemReferenceHost {
  /** Candidates this citing field may cite. A display aid, not an authorization promise. */
  candidates(from: ItemRefSource, signal: AbortSignal): Promise<readonly ItemCandidate[]>;
  /** Current state of each ID from this citing field. Read only: records nothing. */
  resolve(
    from: ItemRefSource,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ItemRefState>>;
  /** Opens the target, rechecking access first. The return destination is the citing element. */
  open(
    id: string,
    from: ItemRefSource,
  ): Promise<{ opened: true } | { opened: false; state: ItemRefState }>;
  /** Records the target's saved version for a person's choice and returns the selection ID. */
  select(from: ItemRefSource, id: string, signal: AbortSignal): Promise<ItemSelectionResult>;
  subscribe?(notify: () => void): () => void;
}

const key = (from: ItemRefSource, id: string) =>
  JSON.stringify([from.artifactId, from.elementId, from.field, id]);

/** One cited ID at one citing field, as read from content (for example from `readItems`). */
export interface ItemRefOccurrence {
  from: ItemRefSource;
  id: string;
}

const MARK = 'item-ref';
type Mark = [typeof MARK, 'select', string, string] | [typeof MARK, 'drop', string];
function readMark(m: string): Mark | undefined {
  if (!m.startsWith(`["${MARK}"`)) return undefined;
  try {
    return JSON.parse(m) as Mark;
  } catch {
    return undefined;
  }
}

/**
 * Selection evidence of one editing session (one person, one artifact). A choice made through
 * `select` becomes evidence only through the edit that adds that citation: the Host's session
 * computes `marks` for every edit, and those marks follow Undo and Redo exactly (an
 * `EditorSession` `marks` ancestry). An edit that removes a citation, by any path (the reference
 * field, typing, paste, import or a proposal), ends its choice in that ancestry; Undo of that
 * edit brings the choice back, and Undo of a later choice brings back the earlier one. Typing or
 * pasting an ID never makes a choice. At a save, a citation the saved content newly holds (it was
 * not in the previous save) carries the choice its ancestry ends with. The Host keeps a selection
 * single-use, so removing, saving and adding a citation again needs a new `select`.
 */
export class ItemSelectionLedger {
  private readonly pending = new Map<string, ItemSelectionEvidence>();
  private readonly chosen = new Map<string, ItemSelectionEvidence>();
  /** Holds the choice of an accepted `select` for the next edit that adds this citation. */
  choose(from: ItemRefSource, id: string, result: ItemSelectionResult): void {
    if (!result.accepted) return;
    this.pending.set(key(from, id), { selectionId: result.selectionId, from: { ...from }, id });
  }
  /** Drops a held choice that no edit used (the edit was refused or never made). */
  cancel(from: ItemRefSource, id: string): void {
    this.pending.delete(key(from, id));
  }
  /**
   * The marks of one edit, from the citations before and after it: a removed citation ends its
   * choice; an added one takes the held choice, if any. Call it inside the session's edit.
   */
  marks(before: readonly ItemRefOccurrence[], after: readonly ItemRefOccurrence[]): string[] {
    const was = new Set(before.map((o) => key(o.from, o.id)));
    const now = new Set(after.map((o) => key(o.from, o.id)));
    const out: string[] = [];
    for (const k of was) if (!now.has(k)) out.push(JSON.stringify([MARK, 'drop', k]));
    for (const k of now) {
      if (was.has(k)) continue;
      const e = this.pending.get(k);
      if (!e) continue;
      this.pending.delete(k);
      this.chosen.set(e.selectionId, e);
      out.push(JSON.stringify([MARK, 'select', k, e.selectionId]));
    }
    return out;
  }
  /**
   * Evidence to send with a save of `next`, given the session's marks for that content and what
   * the previous save held. Changes nothing.
   */
  evidenceFor(
    marks: readonly string[],
    saved: readonly ItemRefOccurrence[],
    next: readonly ItemRefOccurrence[],
  ): ItemSelectionEvidence[] {
    const state = new Map<string, string>();
    for (const m of marks) {
      const r = readMark(m);
      if (r?.[1] === 'select') state.set(r[2], r[3]);
      else if (r?.[1] === 'drop') state.delete(r[2]);
    }
    const before = new Set(saved.map((o) => key(o.from, o.id)));
    const out: ItemSelectionEvidence[] = [];
    const seen = new Set<string>();
    for (const o of next) {
      const k = key(o.from, o.id);
      if (before.has(k) || seen.has(k)) continue;
      seen.add(k);
      const e = this.chosen.get(state.get(k) ?? '');
      if (e) out.push({ ...e, from: { ...e.from } });
    }
    return out;
  }
  /** Held choices not yet used by an edit (for tests and diagnostics). */
  get held(): number {
    return this.pending.size;
  }
}

/** Display words for each state (Japanese, the platform default). */
export const itemRefStatusLabel: Record<ItemRefStatus, string> = {
  ok: '確認済み',
  kept: '古いまま',
  stale: '古い',
  'missing-source': '引用元がありません',
  'missing-target': '見つからない',
  forbidden: '権限なし',
  offline: '確かめられない',
  unresolved: '見つからない',
  duplicate: '重複',
};
