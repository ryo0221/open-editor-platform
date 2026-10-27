import { useEffect, useRef, type MutableRefObject } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { Preview } from '@editor-platform/collaboration-core';
import type {
  ProposalReview,
  ProposedCommands,
  SemanticChange,
} from '@editor-platform/editor-core';
import { exportMarkdown, isDocument } from '@editor-platform/document';
import type { SharedPlaygroundConnection } from './types';
import type { Content } from '../model';

export interface SharedPreviewState {
  id: string;
  preview: Preview<Content>;
}

export interface LocalProposal {
  value: ProposedCommands<Content>;
  base: string;
  review: ProposalReview<Content>;
}

/** Proposal controls for a shared session; `request` discards responses superseded by newer clicks. */
export function SharedProposalInspector({
  shared,
  preview: sharedPreview,
  request,
  setPreview,
  setError,
}: {
  shared: SharedPlaygroundConnection;
  preview: SharedPreviewState;
  request: MutableRefObject<number>;
  setPreview(preview: SharedPreviewState | undefined): void;
  setError(message: string): void;
}) {
  const fail = (e: unknown) => setError(String(e));
  const adapter = shared.session.adapter;
  return (
    <aside className="inspector" aria-label="Shared proposal preview">
      <h2>Proposal preview</h2>
      <p>The canvas shows the proposed result. Apply checks its dependencies again.</p>
      <p>{sharedPreview.preview.changedKeys.length} changed resources</p>
      <button
        onClick={() => {
          void (async () => {
            const current = ++request.current;
            const id = await shared.requestProposal();
            const preview = await adapter.previewProposal(id);
            if (current !== request.current) {
              await adapter.cancelProposal(id);
              return;
            }
            await adapter.cancelProposal(sharedPreview.id);
            if (current !== request.current) {
              await adapter.cancelProposal(id);
              return;
            }
            setPreview({ id, preview });
            setError('');
          })().catch(fail);
        }}
      >
        Request revised proposal
      </button>
      <button
        onClick={() => {
          void shared.session
            .applyProposal(sharedPreview.id, sharedPreview.preview.token)
            .then(() => setPreview(undefined))
            .catch(fail);
        }}
      >
        Apply shared proposal
      </button>
      <button
        onClick={() => {
          void adapter
            .previewProposal(sharedPreview.id)
            .then((preview) => setPreview({ ...sharedPreview, preview }))
            .catch(fail);
        }}
      >
        Refresh preview
      </button>
      <button
        onClick={() => {
          request.current++;
          setPreview(undefined);
          void adapter.cancelProposal(sharedPreview.id, true).catch(fail);
        }}
      >
        Reject shared proposal
      </button>
      <button
        onClick={() => {
          request.current++;
          setPreview(undefined);
          void adapter.cancelProposal(sharedPreview.id).catch(fail);
        }}
      >
        Cancel shared proposal
      </button>
    </aside>
  );
}

function draftText(content: Content | undefined) {
  return content && isDocument(content) ? exportMarkdown(content) : canonicalJson(content);
}
const json = (value: unknown) => (value === undefined ? '—' : JSON.stringify(value, null, 1));
function plain(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value !== 'object') return String(value);
  const box = value as Partial<Box>;
  if ([box.x, box.y, box.width, box.height].every((n) => typeof n === 'number'))
    return `x ${box.x}, y ${box.y} · ${box.width} × ${box.height}`;
  const period = value as { start?: unknown; end?: unknown };
  if ('start' in period && 'end' in period) return `${plain(period.start)} – ${plain(period.end)}`;
  return JSON.stringify(value);
}
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Before (dashed) and after outlines of a moved or resized item, scaled to fit. */
function MovePreview({ before, after }: { before: Box; after: Box }) {
  const x = Math.min(before.x, after.x),
    y = Math.min(before.y, after.y),
    w = Math.max(before.x + before.width, after.x + after.width) - x,
    h = Math.max(before.y + before.height, after.y + after.height) - y,
    pad = Math.max(w, h) * 0.08;
  return (
    <svg
      className="proposal-move"
      role="img"
      aria-label={`Move preview: from ${before.x}, ${before.y} to ${after.x}, ${after.y}`}
      viewBox={`${x - pad} ${y - pad} ${w + pad * 2} ${h + pad * 2}`}
    >
      <rect {...before} className="before" vectorEffect="non-scaling-stroke" />
      <rect {...after} className="after" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
function TextChange({ change }: { change: SemanticChange }) {
  const before = String(change.before ?? ''),
    after = String(change.after ?? ''),
    r = change.range!;
  return (
    <span className="proposal-text">
      {before.slice(0, r.start)}
      <del>{before.slice(r.start, r.beforeEnd)}</del>
      <ins>{after.slice(r.start, r.afterEnd)}</ins>
      {before.slice(r.beforeEnd)}
    </span>
  );
}
function ChangeItem({ change }: { change: SemanticChange }) {
  const box = (v: unknown) => v as Box;
  return (
    <li data-element-id={change.elementId} data-kind={change.kind}>
      <strong>{change.elementLabel || change.elementId || 'Artifact'}</strong>{' '}
      <code>{change.elementId}</code> · {change.kind} · {change.propertyLabel ?? change.property}
      {change.units ? ` (${change.units})` : ''}
      <div>
        {change.kind === 'text' && change.range ? (
          <TextChange change={change} />
        ) : (
          <>
            {plain(change.before)} → {plain(change.after)}
          </>
        )}
      </div>
      {(change.kind === 'move' || change.kind === 'resize') && (
        <MovePreview before={box(change.before)} after={box(change.after)} />
      )}
    </li>
  );
}

export function ProposalDialog({
  proposal,
  content,
  onReject,
  onApply,
}: {
  proposal: LocalProposal;
  content: Content | undefined;
  onReject(): void;
  onApply(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [proposal]);
  const { review } = proposal;
  const ready = review.status === 'ready';
  const fallback = review.fallback;
  return (
    <dialog
      ref={dialog}
      onCancel={onReject}
      aria-label="External proposal preview"
      className="proposal-dialog"
      tabIndex={-1}
    >
      <span className="eyebrow">EXTERNAL CHANGE PROPOSAL</span>
      <h2>{proposal.value.summary}</h2>
      <p>{proposal.value.source}</p>
      <p className="muted">
        Preview only. Applying creates one undoable transaction. Based on version{' '}
        {review.base.versionId ?? 'none'}.
      </p>
      {review.status === 'refused' && (
        <p role="alert" data-reason={review.reason}>
          Cannot apply: {review.message}
        </p>
      )}
      {ready && (
        <section aria-label="Proposed changes">
          <h3>Proposed changes</h3>
          {review.changes.length ? (
            <ul className="proposal-changes">
              {review.changes.map((change, i) => (
                <ChangeItem key={i} change={change} />
              ))}
            </ul>
          ) : (
            <p className="muted">No record or element changes.</p>
          )}
        </section>
      )}
      {ready && review.view.length > 0 && (
        <section aria-label="Display settings changes">
          <h3>Display settings only</h3>
          <ul className="proposal-changes">
            {review.view.map((change, i) => (
              <ChangeItem key={i} change={change} />
            ))}
          </ul>
        </section>
      )}
      {fallback.length > 0 && (
        <details aria-label="JSON without a semantic diff">
          <summary>Shown as JSON (no semantic diff)</summary>
          {fallback.map((f, i) => (
            <div className="text-pair" key={i}>
              <pre>
                {f.path || 'content'}: {json(f.before)}
              </pre>
              <pre>{json(f.after)}</pre>
            </div>
          ))}
        </details>
      )}
      {ready && isDocument(content) && (
        <div className="text-pair">
          <section>
            <h3>Current draft</h3>
            <pre>{draftText(content)}</pre>
          </section>
          <section>
            <h3>Proposed draft</h3>
            <pre>{draftText(review.preview.content)}</pre>
          </section>
        </div>
      )}
      <footer>
        <button autoFocus onClick={onReject}>
          Reject proposal
        </button>
        <button className="primary" disabled={!ready} onClick={onApply}>
          Apply proposal
        </button>
      </footer>
    </dialog>
  );
}
