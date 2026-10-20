import { useEffect, useRef, type MutableRefObject } from 'react';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { Preview } from '@editor-platform/collaboration-core';
import type { ProposedCommands } from '@editor-platform/editor-core';
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
  preview: Content;
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
      <p className="muted">Preview only. Applying creates one undoable transaction.</p>
      <div className="text-pair">
        <section>
          <h3>Current draft</h3>
          <pre>{draftText(content)}</pre>
        </section>
        <section>
          <h3>Proposed draft</h3>
          <pre>{draftText(proposal.preview)}</pre>
        </section>
      </div>
      <footer>
        <button autoFocus onClick={onReject}>
          Reject proposal
        </button>
        <button className="primary" onClick={onApply}>
          Apply proposal
        </button>
      </footer>
    </dialog>
  );
}
