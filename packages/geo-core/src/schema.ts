import { id, record } from './validation';

/** Internal predicates shared by the hand-written payload boundaries. */
export const exactKeys = (v: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k));
/** A committed `{sessionId, sequence}` revision or an explicit local draft revision. */
export const validRevision = (revision: unknown) =>
  record(revision) &&
  (exactKeys(revision, ['sessionId', 'sequence']) ||
    (exactKeys(revision, ['kind', 'sessionId', 'sequence']) && revision.kind === 'local-draft')) &&
  id(revision.sessionId) &&
  Number.isSafeInteger(revision.sequence) &&
  (revision.sequence as number) >= 0;
