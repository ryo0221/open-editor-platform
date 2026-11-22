import { canonicalJson, newId } from '@editor-platform/artifact-core';
import {
  formatLiveValue,
  prepareLiveReference,
  prepareLiveReferenceUpdate,
  type LiveReference,
} from '@editor-platform/artifact-references';
import type { LiveReferenceConnection } from '@editor-platform/artifact-references/react';
import { documentLiveCitationEntries, isDocument } from '@editor-platform/document/model';
import {
  reviewProposedCommands,
  sameLocalRevision,
  transaction,
  type EditorCommand,
  type ProposalDiffAdapter,
  type ProposalReview,
  type ProposalReviewBase,
  type ProposedCommands,
} from '@editor-platform/editor-core';
import { isDeck } from '@editor-platform/slide/model';
import { validContent, type Content } from '../model';
import { proposalAdapter } from './proposal-runtime';

type Draft = { content: Content; base: ProposalReviewBase; kind: string };
export interface LocalProposal {
  value: ProposedCommands<Content>;
  review: ProposalReview<Content>;
}

export function rejectLocalProposal(
  generation: { current: number },
  state: {
    setProposal(proposal: LocalProposal | null): void;
    setBusy(busy: boolean): void;
    setError(error: string): void;
  },
): void {
  // Invalidate any pending apply before removing the review.
  generation.current++;
  state.setProposal(null);
  state.setBusy(false);
  state.setError('');
}

function citations(content: Content) {
  if (isDocument(content)) return documentLiveCitationEntries(content.blocks);
  if (isDeck(content))
    return content.slides.flatMap(({ objects }) =>
      objects.flatMap(({ id, liveQuote }) => (liveQuote ? [{ id, reference: liveQuote }] : [])),
    );
  return [];
}

function citationChanges(before: Content, after: Content) {
  function byId(content: Content) {
    const entries = citations(content);
    const indexed = new Map(entries.map(({ id, reference }) => [id, reference]));
    if (indexed.size !== entries.length) throw new Error('引用のIDが重複しています。');
    return indexed;
  }
  const previous = byId(before);
  const proposed = byId(after);
  return [...new Set([...previous.keys(), ...proposed.keys()])].flatMap((id) => {
    const old = previous.get(id);
    const next = proposed.get(id);
    return canonicalJson(old) === canonicalJson(next) ? [] : [{ id, old, next }];
  });
}

function citationSummary(reference: LiveReference | undefined) {
  if (!reference) return undefined;
  const { source, snapshot, presentation } = reference;
  const target = source.target.kind === 'value' ? source.target.metricId : source.target.figureId;
  const value = presentation.kind === 'value' ? formatLiveValue(presentation) : presentation.label;
  return `${source.artifactId} · ${snapshot.versionId} · ${target} · ${value}`;
}

function citationAdapter(draft: Draft): ProposalDiffAdapter<Content> | undefined {
  const native = proposalAdapter(draft.content);
  if (draft.kind !== 'document' && draft.kind !== 'slide') return native;
  return {
    domain: draft.kind,
    has: (content, id) =>
      native?.has(content, id) ??
      (isDeck(content) &&
        content.slides.some(
          (page) => page.id === id || page.objects.some((item) => item.id === id),
        )),
    diff(before, after) {
      if (!validContent(draft.kind, after)) throw new Error('引用の形式または資源上限が不正です。');
      const changes = citationChanges(before, after);
      const diff = native?.diff(before, after) ?? {
        changes: [],
        view: [],
        fallback: changes.length
          ? [{ path: 'slides', before, after, reason: 'Slide native content' }]
          : [],
      };
      return {
        ...diff,
        changes: [
          ...diff.changes,
          ...changes.map(({ id, old, next }) => ({
            domain: draft.kind,
            kind: 'field' as const,
            elementId: id,
            property: '引用',
            before: citationSummary(old),
            after: citationSummary(next),
          })),
        ],
      };
    },
  };
}

export function reviewLocalProposal(draft: Draft, value: ProposedCommands<Content>): LocalProposal {
  const review = reviewProposedCommands(draft, value, citationAdapter(draft));
  return { value, review };
}

export async function applyLocalProposal(
  proposal: LocalProposal,
  readEditableDraft: () => Draft,
  connection: LiveReferenceConnection,
  execute: (command: EditorCommand<Content>) => boolean,
): Promise<boolean> {
  const { review, value } = proposal;
  if (review.status !== 'ready') throw new Error(review.message);
  const { base, preview } = review;
  function assertCurrent() {
    const current = readEditableDraft();
    if (
      current.base.artifactId !== base.artifactId ||
      current.base.versionId !== base.versionId ||
      (base.revision &&
        (!current.base.revision || !sameLocalRevision(base.revision, current.base.revision))) ||
      canonicalJson(current.content) !== canonicalJson(preview.baseContent)
    )
      throw new Error('The draft changed. Reject this stale proposal and request a new one.');
  }
  assertCurrent();
  const changes = citationChanges(preview.baseContent, preview.content);
  for (const { old, next } of changes) {
    const { provider, destinationArtifactId } = connection;
    if (destinationArtifactId !== base.artifactId)
      throw new Error('引用先が変わりました。提案を開き直してください。');
    if (!next && old) {
      await provider.checkAccess(old.source);
      continue;
    }
    if (!next) continue;
    if (old && canonicalJson(await connection.latest(old)) !== canonicalJson(next.snapshot))
      throw new Error('新しい版が変わりました。もう一度確認してください。');
    const verified = old
      ? await prepareLiveReferenceUpdate(old, next.snapshot, provider, destinationArtifactId)
      : await prepareLiveReference(
          next.source,
          next.snapshot,
          provider,
          next.presentation.kind === 'value' ? next.presentation.format : undefined,
          destinationArtifactId,
        );
    if (canonicalJson(verified.reference) !== canonicalJson(next))
      throw new Error('引用の表示が変わりました。もう一度確認してください。');
  }
  assertCurrent();
  const command = transaction(value.summary, value.commands, {
    origin: 'proposal',
    transactionId: newId('transaction'),
    proposalId: value.id,
  });
  if (review.domain === 'document' || review.domain === 'slide') {
    const apply = command.apply;
    command.apply = (content) => {
      const after = apply(content);
      if (canonicalJson(after) !== canonicalJson(preview.content))
        throw new Error('The proposed result changed. Request a new preview.');
      return after;
    };
  }
  return execute(command);
}
