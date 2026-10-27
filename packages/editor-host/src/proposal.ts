import {
  checkProposalReads,
  newId,
  type ArtifactId,
  type CurrentRead,
  type ProposalReadCheck,
  type ProposalReads,
} from '@editor-platform/artifact-core';
import {
  previewProposedCommands,
  sameLocalRevision,
  transaction,
  type ProposalPreview,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import { EditorHostError, type ArtifactEditor } from './index';

/** The Host's current answer for each referenced Artifact, under the reviewer's access. */
export type HostReferenceReads = (artifactId: ArtifactId) => CurrentRead | undefined;
export interface HostProposalReview<T> {
  check: ProposalReadCheck;
  /** The whole proposed result on a copy of the draft; absent while the proposal is stale. */
  preview?: ProposalPreview<T>;
}

/** Recheck a proposal's target and references. The target comes from this Session (its
 * draft's base version, live revision and permission), never from the Host's answers. */
export function checkHostProposal<T>(
  editor: ArtifactEditor<T>,
  proposal: ProposedCommands<T>,
  references: HostReferenceReads,
): ProposalReadCheck {
  const base = editor.artifact.draft.baseVersionId;
  const reads: ProposalReads = proposal.reads ?? {
    target: { artifactId: editor.id, versionId: base },
    references: [],
  };
  if (reads.target.artifactId !== editor.id)
    throw new EditorHostError('invalid-content', editor.id, 'Proposal targets another artifact');
  const target: CurrentRead = editor.readOnly
    ? { status: 'forbidden' }
    : { status: 'available', versionId: base };
  const check = checkProposalReads(reads, (id) => (id === editor.id ? target : references(id)));
  if (
    proposal.baseLocalRevision &&
    !sameLocalRevision(proposal.baseLocalRevision, editor.revision) &&
    !check.stale.some((s) => s.role === 'target')
  )
    check.stale.unshift({
      artifactId: editor.id,
      role: 'target',
      expectedVersionId: reads.target.versionId,
      reason: 'draft-changed',
    });
  check.fresh = !check.stale.length;
  return check;
}

/** Preview start: recheck freshness, then compute the whole proposal on a draft copy. */
export function previewHostProposal<T>(
  editor: ArtifactEditor<T>,
  proposal: ProposedCommands<T>,
  references: HostReferenceReads,
): HostProposalReview<T> {
  const check = checkHostProposal(editor, proposal, references);
  return check.fresh
    ? { check, preview: previewProposedCommands(editor.content, proposal) }
    : { check };
}

/** Apply boundary: flush pending input, recheck freshness, then apply every command as one
 * undoable transaction. A stale proposal changes nothing and is returned to the Host. */
export function applyHostProposal<T>(
  editor: ArtifactEditor<T>,
  proposal: ProposedCommands<T>,
  references: HostReferenceReads,
): ProposalReadCheck {
  editor.flushInputs();
  const check = checkHostProposal(editor, proposal, references);
  if (!check.fresh) return check;
  editor.execute(
    transaction(proposal.summary, proposal.commands, {
      origin: 'proposal',
      transactionId: newId('transaction'),
      proposalId: proposal.id,
    }),
  );
  return check;
}
