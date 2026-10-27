import type { ArtifactId, ArtifactVersionRef, VersionId } from './index';

/** The exact committed versions a proposal was generated from. Recorded by the Host or
 * Runtime when it builds the proposal; the Editor never discovers references itself. */
export interface ProposalReads {
  /** The Artifact the proposal changes, and the version its draft was based on
   * (null when the draft has no committed version yet). */
  target: { artifactId: ArtifactId; versionId: VersionId | null };
  /** Other Artifacts the proposal was generated from, each at one immutable version. */
  references: ArtifactVersionRef[];
}
/** What the Host currently attests for one Artifact, read under the reviewer's authority.
 * `changed` reports a different version without disclosing which one. */
export type CurrentRead =
  | { status: 'available'; versionId: VersionId | null }
  | { status: 'changed' }
  | { status: 'missing' }
  | { status: 'forbidden' };
export type StaleReadReason =
  | 'version-changed'
  | 'draft-changed'
  | 'missing'
  | 'forbidden'
  | 'unverified';
export interface StaleRead {
  artifactId: ArtifactId;
  role: 'target' | 'reference';
  expectedVersionId: VersionId | null;
  reason: StaleReadReason;
  /** Present only when the Host disclosed the current version. */
  currentVersionId?: VersionId | null;
}
export interface ProposalReadCheck {
  fresh: boolean;
  /** Target first, then references in their recorded order. */
  stale: StaleRead[];
}
export const proposalReadLimits = { references: 64, idLength: 512 } as const;

const readId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= proposalReadLimits.idLength;

export function validProposalReads(value: unknown): value is ProposalReads {
  if (!value || typeof value !== 'object') return false;
  const { target, references } = value as ProposalReads;
  if (
    !target ||
    typeof target !== 'object' ||
    !readId(target.artifactId) ||
    (target.versionId !== null && !readId(target.versionId)) ||
    !Array.isArray(references) ||
    references.length > proposalReadLimits.references
  )
    return false;
  const seen = new Set([target.artifactId]);
  for (const reference of references) {
    if (
      !reference ||
      typeof reference !== 'object' ||
      !readId(reference.artifactId) ||
      !readId(reference.versionId) ||
      seen.has(reference.artifactId)
    )
      return false;
    seen.add(reference.artifactId);
  }
  return true;
}

function staleRead(
  role: StaleRead['role'],
  artifactId: ArtifactId,
  expectedVersionId: VersionId | null,
  current: CurrentRead | undefined,
): StaleRead | undefined {
  const stale = (reason: StaleReadReason): StaleRead => ({
    artifactId,
    role,
    expectedVersionId,
    reason,
  });
  if (!current) return stale('unverified');
  if (current.status === 'available')
    return current.versionId === expectedVersionId
      ? undefined
      : { ...stale('version-changed'), currentVersionId: current.versionId };
  if (current.status === 'changed') return stale('version-changed');
  if (current.status === 'missing' || current.status === 'forbidden') return stale(current.status);
  return stale('unverified');
}

/** Pure freshness check over the whole proposal's read set. `current` is supplied by the
 * Host for each recorded Artifact; an Artifact it does not answer for is `unverified`,
 * never assumed current. The final atomic check and access enforcement stay with the
 * trusted Host or authority at its commit point. */
export function checkProposalReads(
  reads: ProposalReads,
  current: (artifactId: ArtifactId) => CurrentRead | undefined,
): ProposalReadCheck {
  if (!validProposalReads(reads)) throw new TypeError('Invalid proposal read set');
  const target = staleRead(
    'target',
    reads.target.artifactId,
    reads.target.versionId,
    current(reads.target.artifactId),
  );
  const stale = [...(target ? [target] : []), ...checkReadVersions(reads.references, current)];
  return { fresh: !stale.length, stale };
}
/** The reference half of checkProposalReads, for read sets kept in another envelope
 * (for example a collaboration Proposal's `external` list). */
export function checkReadVersions(
  references: readonly ArtifactVersionRef[],
  current: (artifactId: ArtifactId) => CurrentRead | undefined,
): StaleRead[] {
  return references
    .map((r) => staleRead('reference', r.artifactId, r.versionId, current(r.artifactId)))
    .filter((s): s is StaleRead => !!s);
}
