import { canonicalJson, clone, deepFreeze } from '@editor-platform/artifact-core';
import {
  previewProposedCommands,
  sameLocalRevision,
  transactionCommands,
  type EditorCommand,
  type LocalDraftRevision,
  type ProposalPreview,
  type ProposedCommands,
} from './index';

/** One observed change, keyed by a stable domain ID. Never an executable operation. */
export interface SemanticChange {
  domain: string;
  kind:
    | 'text'
    | 'field'
    | 'period'
    | 'move'
    | 'resize'
    | 'added'
    | 'removed'
    | 'order'
    | 'property';
  /** Stable element/record/event ID, or '' for an artifact-level setting. */
  elementId: string;
  /** Human-readable element name read from the base (or added) content. */
  elementLabel?: string;
  /** Native property path, for example `text`, a column ID or `bounds`. */
  property: string;
  propertyLabel?: string;
  before?: unknown;
  after?: unknown;
  /** Unit or coordinate system of before/after, for example `board-px` or an IANA zone. */
  units?: string;
  /** Text changes only: the changed range in before and after (UTF-16 offsets). */
  range?: { start: number; beforeEnd: number; afterEnd: number };
  /** Set when the adapter cannot name the unit or coordinate system of this value. */
  unknownUnits?: string;
}
/** A changed native path the adapter shows only as JSON, never as a semantic change. */
export interface FallbackChange {
  path: string;
  before?: unknown;
  after?: unknown;
  reason: string;
}
export interface DomainDiff {
  /** Content changes. */
  changes: SemanticChange[];
  /** Saved display settings (views, layouts) that change no record or element value. */
  view: SemanticChange[];
  fallback: FallbackChange[];
}
/** Per-domain comparison. Lives in the domain package; the platform has no shared node model. */
export interface ProposalDiffAdapter<T> {
  domain: string;
  /** Whether a stable ID the proposal reads still exists in the content. */
  has(content: T, id: string): boolean;
  diff(before: T, after: T): DomainDiff;
}
export interface ProposalReviewBase {
  artifactId: string;
  /** Saved version the current draft is based on. */
  versionId?: string;
  revision?: LocalDraftRevision;
}
export type ProposalRefusal =
  | 'unsupported-domain'
  | 'stale-version'
  | 'stale-draft'
  | 'missing-target'
  | 'command-failed'
  | 'unknown-units'
  | 'no-change';
export type ProposalReview<T> =
  | ({
      status: 'ready';
      base: ProposalReviewBase;
      preview: ProposalPreview<T>;
      domain: string;
      /** Changed stable IDs, in change order, for Surface highlighting. */
      elementIds: string[];
    } & DomainDiff)
  | {
      status: 'refused';
      reason: ProposalRefusal;
      message: string;
      base: ProposalReviewBase;
      domain?: string;
      elementIds: string[];
      /** Whole-content JSON when no adapter exists; never shown as a semantic change. */
      fallback: FallbackChange[];
    };

const messages: Record<ProposalRefusal, string> = {
  'unsupported-domain': 'This editor has no semantic proposal diff. Review the JSON instead.',
  'stale-version': 'The proposal was made for another saved version.',
  'stale-draft': 'The draft changed after the proposal was made.',
  'missing-target': 'The proposal changes items that no longer exist.',
  'command-failed': 'The proposed commands failed on the current draft.',
  'unknown-units': 'The proposal changes a value whose unit or coordinate system is unknown.',
  'no-change': 'The proposal changes nothing in the draft.',
};

const readIds = <T>(c: EditorCommand<T>) =>
  [...new Set([...(c.reads?.geometry ?? []), ...(c.reads?.content ?? [])])].filter(
    (id) => id !== '*',
  );
/** Checks each command's reads against the state it runs on, so create-then-edit is valid. */
function missingReads<T>(
  content: T,
  proposal: ProposedCommands<T>,
  adapter: ProposalDiffAdapter<T>,
) {
  // A transaction's reads include what its own earlier steps create, so check its steps instead.
  const steps = (c: EditorCommand<T>): EditorCommand<T>[] => {
    const children = transactionCommands(c);
    return children ? children.flatMap(steps) : [c];
  };
  let state = clone(content);
  for (const c of proposal.commands.flatMap(steps)) {
    const missing = readIds(c).filter((id) => !adapter.has(state, id));
    if (missing.length) return missing;
    try {
      state = c.apply(clone(state));
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Previews a proposal on a copy and describes it with the domain adapter.
 * Refusals carry a reason; a model's own success summary is never used as a change.
 */
export function reviewProposedCommands<T>(
  current: { content: T; base: ProposalReviewBase },
  proposal: ProposedCommands<T>,
  adapter: ProposalDiffAdapter<T> | undefined,
): ProposalReview<T> {
  const base = current.base;
  const refuse = (
    reason: ProposalRefusal,
    elementIds: string[] = [],
    fallback: FallbackChange[] = [],
  ): ProposalReview<T> =>
    deepFreeze({
      status: 'refused',
      reason,
      message: messages[reason],
      base,
      ...(adapter ? { domain: adapter.domain } : {}),
      elementIds,
      fallback,
    });
  // The target's read version only; references are rechecked by the Host (proposal reads).
  const target = proposal.reads?.target;
  if (
    target &&
    (target.artifactId !== base.artifactId || target.versionId !== (base.versionId ?? null))
  )
    return refuse('stale-version');
  if (
    proposal.baseLocalRevision &&
    base.revision &&
    !sameLocalRevision(proposal.baseLocalRevision, base.revision)
  )
    return refuse('stale-draft');
  if (adapter) {
    const missing = missingReads(current.content, proposal, adapter);
    if (missing.length) return refuse('missing-target', missing);
  }
  let preview: ProposalPreview<T>;
  try {
    preview = previewProposedCommands(current.content, proposal);
  } catch {
    return refuse('command-failed');
  }
  if (!adapter)
    return refuse(
      'unsupported-domain',
      [],
      canonicalJson(preview.baseContent) === canonicalJson(preview.content)
        ? []
        : [
            {
              path: '',
              before: preview.baseContent,
              after: preview.content,
              reason: 'unsupported-domain',
            },
          ],
    );
  const diff = adapter.diff(preview.baseContent, preview.content);
  const unknown = [...diff.changes, ...diff.view].filter((c) => c.unknownUnits);
  if (unknown.length)
    return refuse(
      'unknown-units',
      unknown.map((c) => c.elementId),
      diff.fallback,
    );
  if (!diff.changes.length && !diff.view.length && !diff.fallback.length)
    return refuse('no-change');
  return deepFreeze({
    status: 'ready',
    base,
    preview,
    domain: adapter.domain,
    elementIds: [
      ...new Set([...diff.changes, ...diff.view].map((c) => c.elementId).filter(Boolean)),
    ],
    ...diff,
  });
}

/** Common prefix/suffix comparison of one string; offsets are UTF-16 code units. */
export function textRange(before: string, after: string): SemanticChange['range'] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  // Never split a surrogate pair between the unchanged and changed parts.
  const surrogate = (code: number, low: boolean) => (code & 0xfc00) === (low ? 0xdc00 : 0xd800);
  if (start > 0 && surrogate(before.charCodeAt(start - 1), false)) start--;
  if (tail > 0 && surrogate(before.charCodeAt(before.length - tail), true)) tail--;
  return { start, beforeEnd: before.length - tail, afterEnd: after.length - tail };
}

/** Helpers shared by domain adapters; comparison stays per-domain. */
export const sameValue = (a: unknown, b: unknown) =>
  a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
export function changedKeys(a: object, b: object, skip: readonly string[] = []) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !skip.includes(key))
    .filter(
      (key) => !sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
    .sort();
}
/** Compares the order of IDs present in both lists. */
export function orderChanged(before: readonly string[], after: readonly string[]) {
  const kept = new Set(after);
  const a = before.filter((id) => kept.has(id)),
    present = new Set(before),
    b = after.filter((id) => present.has(id));
  return a.some((id, i) => b[i] !== id);
}
