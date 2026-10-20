import type { MutableRefObject } from 'react';
import { newId } from '@editor-platform/artifact-core';
import { editorAnchor, type SharedEditorSession } from '@editor-platform/collaboration-adapters';
import { addAnnotation, type Annotation, type Selection } from '@editor-platform/editor-core';
import { anchorDocumentSelection, isDocument } from '@editor-platform/document';
import {
  assertReviewSelection,
  isReview,
  type ReviewVisibleSource,
} from '@editor-platform/review-surfaces';
import type { Content, StoredArtifact } from '../model';

/** A comment delivery whose outcome is not yet confirmed, retained per artifact. */
export interface CommentAttempt {
  key: string;
  annotation?: ReturnType<typeof addAnnotation>;
  session?: SharedEditorSession<Content>;
  operationId?: string;
  threadIds?: string[];
  retryProposal?: { id: string; token: string };
}

export interface CommentDelivery {
  active: StoredArtifact;
  readOnly: boolean;
  sharedSession: SharedEditorSession<Content> | undefined;
  visibleReviewSource: MutableRefObject<
    { artifactId: string; source: ReviewVisibleSource } | undefined
  >;
  // Retain identities across uncertain/failed delivery; retry must not duplicate a thread.
  attempts: MutableRefObject<Map<string, CommentAttempt>>;
  recordsRef: MutableRefObject<StoredArtifact[]>;
  persist(record: StoredArtifact): Promise<boolean>;
  emitAnnotation(annotation: Annotation): void;
  /** Clears the draft only while it still holds the delivered text. */
  clearComment(body: string): void;
  setError(message: string): void;
}

export async function deliverComment(
  context: CommentDelivery,
  targetSelection: Selection,
  body: string,
): Promise<boolean> {
  const { active, sharedSession } = context;
  if (context.readOnly) return false;
  if (isReview(active.draft.content)) {
    try {
      const visible = context.visibleReviewSource.current;
      assertReviewSelection(
        active.draft.content,
        targetSelection.addresses,
        visible?.artifactId === active.id ? visible.source : undefined,
        active.id,
      );
    } catch (error) {
      context.setError(String(error instanceof Error ? error.message : error));
      return false;
    }
  }
  const key = JSON.stringify([targetSelection, body.trim()]);
  if (sharedSession)
    return deliverSharedComment(context, sharedSession, targetSelection, body, key).catch((e) => {
      context.setError(String(e));
      return false;
    });
  return deliverLocalComment(context, targetSelection, body, key);
}

async function deliverSharedComment(
  context: CommentDelivery,
  session: SharedEditorSession<Content>,
  targetSelection: Selection,
  body: string,
  key: string,
) {
  const { active, attempts } = context;
  const previous = attempts.current.get(active.id);
  await session.flush();
  const acknowledge = async (operationId: string) => {
    await session.flush();
    const receipt = session.client.receipts.get(operationId);
    if (!receipt)
      throw new Error('Comment delivery is unconfirmed. Retry to reconcile the same operation.');
    if (receipt.status !== 'accepted') throw new Error(receipt.message);
    attempts.current.delete(active.id);
  };
  if (previous?.operationId) {
    if (previous.session !== session)
      throw new Error('Reconcile the previous comment in its original shared session.');
    const receipt = session.client.receipts.get(previous.operationId);
    if (receipt?.status === 'rejected') await replayRejectedComment(context, session, previous);
    else await acknowledge(previous.operationId);
    if (previous.key !== key)
      throw new Error(
        'Previous comment confirmed. Your changed draft is retained; submit it separately.',
      );
    context.clearComment(body);
    return true;
  }
  if (session.pendingCount) throw new Error('Confirm pending text before anchoring a comment');
  const actions = targetSelection.addresses.flatMap((address) => {
    const id = newId('thread'),
      createdAt = new Date().toISOString();
    const anchor =
      session.codec.domain === 'document'
        ? {
            type: 'text' as const,
            from: session.text('text').state.selection.from,
            to: session.text('text').state.selection.to,
          }
        : editorAnchor(session.codec.domain, session.content, address);
    return [
      { type: 'thread.create', target: id, payload: { anchor, createdAt } },
      {
        type: 'thread.reply',
        target: id,
        payload: { id: newId('comment'), text: body.trim(), createdAt },
      },
    ];
  });
  const operation = session.actions(actions);
  attempts.current.set(active.id, {
    key,
    session,
    operationId: operation.operationId,
    threadIds: actions
      .filter((action) => action.type === 'thread.create')
      .map((action) => action.target),
  });
  await acknowledge(operation.operationId);
  context.clearComment(body);
  return true;
}

/**
 * Retry the retained operation, not newly generated thread IDs. The session's
 * proposal path owns authority checks, history and removal of this one retained
 * entry only after accepted synchronization.
 */
async function replayRejectedComment(
  context: CommentDelivery,
  session: SharedEditorSession<Content>,
  previous: CommentAttempt,
) {
  const { active, attempts } = context;
  const index = session.rejected.findIndex(
    (edit) => edit.operation.operationId === previous.operationId,
  );
  if (index >= 0) {
    if (!previous.retryProposal) {
      const { id, preview } = await session.previewRetained(index);
      previous.retryProposal = { id, token: preview.token };
    }
    const retry = previous.retryProposal;
    try {
      await session.applyProposal(retry.id, retry.token);
    } catch (error) {
      // An explicit rejection permits a fresh preview next time.
      // An uncertain outcome must replay the same idempotent proposal.
      const result = session.lastReceipt;
      if (result?.operationId === `proposal:${retry.id}` && result.status === 'rejected')
        previous.retryProposal = undefined;
      throw error;
    }
  } else if (
    !previous.threadIds?.length ||
    !previous.threadIds.every((id) => session.confirmed.threads.some((t) => t.id === id))
  ) {
    // Explicit discard is different from successful retained replay.
    attempts.current.delete(active.id);
    throw new Error(
      'Previous retained comment was discarded. Your draft is retained; submit it separately.',
    );
  }
  attempts.current.delete(active.id);
}

async function deliverLocalComment(
  context: CommentDelivery,
  targetSelection: Selection,
  body: string,
  key: string,
) {
  const { active, attempts } = context;
  const previous = attempts.current.get(active.id);
  try {
    const annotation = previous?.annotation
      ? {
          ...previous.annotation,
          comments: previous.annotation.comments.map((item, index) =>
            index === 0 ? { ...item, body: body.trim() } : item,
          ),
        }
      : addAnnotation(
          isDocument(active.draft.content)
            ? anchorDocumentSelection(active.draft.content, targetSelection)
            : targetSelection,
          body,
          'local-user',
        );
    const latest = context.recordsRef.current.find((record) => record.id === active.id);
    if (!latest) throw new Error('Comment artifact is no longer available');
    if (
      previous?.annotation &&
      JSON.stringify(JSON.parse(previous.key)[0]) !== JSON.stringify(targetSelection)
    )
      throw new Error('Retry the unsaved comment at its original anchor.');
    attempts.current.set(active.id, { key, annotation });
    const annotations = latest.annotations.some((item) => item.id === annotation.id)
      ? latest.annotations.map((item) => (item.id === annotation.id ? annotation : item))
      : [...latest.annotations, annotation];
    if (!(await context.persist({ ...latest, annotations }))) return false;
    attempts.current.delete(active.id);
    context.emitAnnotation(annotation);
    context.clearComment(body);
    context.setError('');
    return true;
  } catch (e) {
    context.setError((e as Error).message);
    return false;
  }
}
