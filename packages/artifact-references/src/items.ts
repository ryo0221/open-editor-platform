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

/**
 * Selection evidence of one editing session (one person, one screen). A choice made through
 * `select` is kept until the next save. At a save, a citation that the saved content newly holds
 * (it was not in the previous save) carries its choice; every kept choice then ends: used ones are
 * consumed, and choices whose citation is not in the saved content are dropped, so removing a
 * citation, saving and adding it again needs a new `select`. Undo and Redo before the save keep
 * the choice because the citation is the same, and so does removing or replacing it through the
 * reference field and then undoing that. Typing or pasting an ID never makes a choice, and
 * changing a field by hand forgets the choices of that field (its IDs then go without evidence).
 */
export class ItemSelectionLedger {
  private readonly chosen = new Map<string, ItemSelectionEvidence>();
  /** Keeps the choice of an accepted `select`. A refused one keeps nothing. */
  choose(from: ItemRefSource, id: string, result: ItemSelectionResult): void {
    if (!result.accepted) return;
    this.chosen.set(key(from, id), { selectionId: result.selectionId, from: { ...from }, id });
  }
  /** A hand edit of the field: forget choices of these IDs (all IDs when omitted). */
  forget(from: ItemRefSource, ids?: readonly string[]): void {
    for (const [k, e] of this.chosen)
      if (
        e.from.artifactId === from.artifactId &&
        e.from.elementId === from.elementId &&
        e.from.field === from.field &&
        (!ids || ids.includes(e.id))
      )
        this.chosen.delete(k);
  }
  /** Evidence to send with a save of `next`, given what the previous save held. Changes nothing. */
  evidenceFor(
    saved: readonly ItemRefOccurrence[],
    next: readonly ItemRefOccurrence[],
  ): ItemSelectionEvidence[] {
    const before = new Set(saved.map((o) => key(o.from, o.id)));
    const out: ItemSelectionEvidence[] = [];
    const seen = new Set<string>();
    for (const o of next) {
      const k = key(o.from, o.id);
      if (before.has(k) || seen.has(k)) continue;
      seen.add(k);
      const e = this.chosen.get(k);
      if (e) out.push({ ...e, from: { ...e.from } });
    }
    return out;
  }
  /** The choices kept now, to end with `saved` once the save that captured the content succeeds. */
  snapshot(): ReadonlyMap<string, string> {
    return new Map([...this.chosen].map(([k, e]) => [k, e.selectionId]));
  }
  /**
   * After a successful save, the kept choices end (consumed or dropped). With a `snapshot` taken
   * when the save captured its content, only those choices end: one made while the save was in
   * flight stays for the next save.
   */
  saved(snapshot?: ReadonlyMap<string, string>): void {
    if (!snapshot) return void this.chosen.clear();
    for (const [k, selectionId] of snapshot)
      if (this.chosen.get(k)?.selectionId === selectionId) this.chosen.delete(k);
  }
  /** Kept choices (for tests and diagnostics). */
  get size(): number {
    return this.chosen.size;
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
