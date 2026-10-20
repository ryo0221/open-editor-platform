import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { newId } from '@editor-platform/artifact-core';
import { IconButton } from '@editor-platform/editor-ui';
import type { SharedEditorSession } from '@editor-platform/collaboration-adapters';
import type { Annotation, Selection } from '@editor-platform/editor-core';
import { isReview } from '@editor-platform/review-surfaces';
import { anchorState, type Content, type StoredArtifact } from '../model';

export interface ThreadActionContext {
  active: StoredArtifact;
  sharedSession: SharedEditorSession<Content> | undefined;
  persist(record: StoredArtifact): unknown;
  emitAnnotation(annotation: Annotation): void;
  setError(message: string): void;
}

function replaceThread(context: ThreadActionContext, updated: Annotation) {
  const { active } = context;
  context.persist({
    ...active,
    annotations: active.annotations.map((t) => (t.id === updated.id ? updated : t)),
  });
  context.emitAnnotation(updated);
}

/** Shared sessions submit thread actions to their authority; local drafts persist directly. */
export function toggleThreadResolved(context: ThreadActionContext, thread: Annotation) {
  if (context.sharedSession) {
    try {
      context.sharedSession.actions([
        { type: 'thread.resolve', target: thread.id, payload: { value: !thread.resolved } },
      ]);
    } catch (e) {
      context.setError(String(e));
    }
    return;
  }
  replaceThread(context, { ...thread, resolved: !thread.resolved });
}

/** Returns whether the reply was accepted, so the caller can clear its form. */
export function replyToThread(
  context: ThreadActionContext,
  thread: Annotation,
  body: string,
): boolean {
  if (context.sharedSession) {
    try {
      context.sharedSession.actions([
        {
          type: 'thread.reply',
          target: thread.id,
          payload: { id: newId('comment'), text: body, createdAt: new Date().toISOString() },
        },
      ]);
      return true;
    } catch (e) {
      context.setError(String(e));
      return false;
    }
  }
  replaceThread(context, {
    ...thread,
    comments: [
      ...thread.comments,
      {
        id: newId('comment'),
        body,
        author: 'local-user',
        createdAt: new Date().toISOString(),
      },
    ],
  });
  return true;
}

function SelectionLabel({ active, selection }: { active: StoredArtifact; selection: Selection }) {
  const content = active.draft.content;
  return (
    <p className="selection-label">
      {isReview(content) &&
        selection.addresses.map((address) => {
          const file = content.files.find((file) => file.id === address.elementId);
          return (
            <span key={address.elementId}>
              {file?.name} · {address.region?.type === 'lines' ? address.region.revisionId : ''}{' '}
              ·{' '}
            </span>
          );
        })}
      {selection.addresses.length
        ? `${selection.addresses.length} element selected${selection.addresses[0].region ? ` · ${selection.addresses[0].region.type}` : ''}`
        : 'Select an element to anchor a comment.'}
    </p>
  );
}

function CommentThread({
  thread: a,
  content,
  readOnly,
  onJump,
  onToggleResolved,
  onReply,
}: {
  thread: Annotation;
  content: Content | undefined;
  readOnly: boolean;
  onJump(thread: Annotation): void;
  onToggleResolved(thread: Annotation): void;
  onReply(thread: Annotation, body: string): boolean;
}) {
  const address = a.anchor.addresses[0];
  const state = anchorState(content, address);
  return (
    <article
      className={`comment-thread ${a.resolved ? 'resolved' : ''}`}
      style={a.color ? { borderLeft: `4px solid ${a.color}`, paddingLeft: 8 } : undefined}
    >
      <small>
        {address.region?.type ?? 'element'} · {a.resolved ? 'Resolved' : 'Open'} · {state}
      </small>
      <button disabled={state !== 'Current'} onClick={() => onJump(a)}>
        Jump to annotation
      </button>
      {address.region?.type === 'lines' && (
        <small>
          {address.region.side ?? 'text'} · lines {address.region.start}–{address.region.end}
        </small>
      )}
      {a.comments.map((c) => (
        <div key={c.id}>
          <strong>{c.author}</strong>
          <p>{c.body}</p>
          <time>{new Date(c.createdAt).toLocaleString()}</time>
        </div>
      ))}
      <button disabled={readOnly} onClick={() => onToggleResolved(a)}>
        {a.resolved ? 'Reopen' : 'Resolve'}
      </button>
      <details>
        <summary>Reply</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const body = String(new FormData(form).get('reply') ?? '').trim();
            if (!body || readOnly) return;
            if (onReply(a, body)) form.reset();
          }}
        >
          <input aria-label="Reply text" name="reply" required />
          <button>Post reply</button>
        </form>
      </details>
    </article>
  );
}

export function CommentsInspector({
  active,
  content,
  selection,
  comment,
  readOnly,
  showResolved,
  canAnnotateFromSettings,
  onCommentChange,
  onShowResolvedChange,
  onAddComment,
  onAnnotateFromSettings,
  onClose,
  onJump,
  onToggleResolved,
  onReply,
  children,
}: {
  active: StoredArtifact;
  content: Content | undefined;
  selection: Selection;
  comment: string;
  readOnly: boolean;
  showResolved: boolean;
  canAnnotateFromSettings: boolean;
  onCommentChange(value: string): void;
  onShowResolvedChange(value: boolean): void;
  onAddComment(): void;
  onAnnotateFromSettings(): void;
  onClose(): void;
  onJump(thread: Annotation): void;
  onToggleResolved(thread: Annotation): void;
  onReply(thread: Annotation, body: string): boolean;
  children?: ReactNode;
}) {
  return (
    <aside className="inspector" aria-label="Comments inspector">
      <div className="ep-dialog-heading">
        <h2>Comments & annotations</h2>
        <IconButton icon={X} label="Close comments" onClick={onClose} />
      </div>
      <SelectionLabel active={active} selection={selection} />
      <label>
        Comment
        <textarea
          aria-label="Comment"
          rows={3}
          placeholder="Leave a note on this selection…"
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={readOnly || !selection.addresses.length || !comment.trim()}
        onClick={onAddComment}
      >
        Add comment
      </button>
      {canAnnotateFromSettings && (
        <button
          disabled={readOnly || selection.addresses.length !== 1}
          onClick={onAnnotateFromSettings}
        >
          設定から注釈を作成
        </button>
      )}
      <label className="resolved-toggle">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(e) => onShowResolvedChange(e.target.checked)}
        />{' '}
        Show resolved
      </label>
      {active.annotations
        .filter((a) => showResolved || !a.resolved)
        .map((a) => (
          <CommentThread
            key={a.id}
            thread={a}
            content={content}
            readOnly={readOnly}
            onJump={onJump}
            onToggleResolved={onToggleResolved}
            onReply={onReply}
          />
        ))}
      {children}
    </aside>
  );
}
